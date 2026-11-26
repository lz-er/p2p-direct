#!/usr/bin/env node
/**
 * Local WebSocket Bot Bridge for p2p-direct (`voice.dequ.org`).
 *
 * Connects to any room as an ordinary E2EE WebRTC peer and exposes a dead-simple local
 * JSON + binary PCM WebSocket interface on 127.0.0.1 so bots written in Python, Rust, Go,
 * C#, or Node.js can send custom bot cards with buttons, delete messages, and stream audio
 * in voice channels without reimplementing WebRTC or cryptography.
 *
 * Usage:
 *   node bot/bridge.mjs --room "https://voice.dequ.org/#room=P2P1:..." --name "MyBot" --port 8765
 */

import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { P2PBot } from "./sdk.mjs";

export function parseCliArgs(argv) {
  const args = {
    room: process.env.P2P_ROOM || "",
    passphrase: process.env.P2P_PASSPHRASE || "",
    name: process.env.P2P_BOT_NAME || "P2PBot",
    relay: process.env.P2P_RELAY || "",
    host: process.env.P2P_BRIDGE_HOST || "127.0.0.1",
    port: Number(process.env.P2P_BRIDGE_PORT || 8765),
    peerId: process.env.P2P_PEER_ID || "",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if ((flag === "--room" || flag === "-r") && next) {
      args.room = next;
      i++;
    } else if ((flag === "--passphrase" || flag === "-p") && next) {
      args.passphrase = next;
      i++;
    } else if ((flag === "--name" || flag === "-n") && next) {
      args.name = next;
      i++;
    } else if (flag === "--relay" && next) {
      args.relay = next;
      i++;
    } else if (flag === "--host" && next) {
      args.host = next;
      i++;
    } else if (flag === "--port" && next) {
      args.port = Number(next);
      i++;
    } else if (flag === "--peer-id" && next) {
      args.peerId = next;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    }
  }
  return args;
}

export class P2PBotBridge {
  constructor({ roomLink, passphrase = "", name = "P2PBot", relay = "", peerId = "", host = "127.0.0.1", port = 8765, wasmPath }) {
    this.host = host;
    this.port = port;
    this.bot = new P2PBot({
      roomLink,
      passphrase,
      name,
      relay: relay || undefined,
      peerId: peerId || undefined,
      wasmPath,
    });
    this.wss = null;
    this.clients = new Map(); // ws -> { voiceAudioSubscribed: boolean }
  }

  async start() {
    const ready = await this.bot.connect();
    await new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.host, port: this.port });
      this.wss = wss;
      wss.once("listening", () => {
        const addr = wss.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
      wss.once("error", reject);
      wss.on("connection", (ws) => this._onClient(ws));
    });

    this.bot.on("message", (message) => this._broadcast({ event: "message", message }));
    this.bot.on("messageUpdate", (message) => this._broadcast({ event: "message_update", message }));
    this.bot.on("messageDelete", (ev) => this._broadcast({ event: "message_delete", ...ev }));
    this.bot.on("interaction", (ev) => this._broadcast({ event: "interaction", ...ev }));
    this.bot.on("peerJoin", (ev) => this._broadcast({ event: "peer_join", ...ev }));
    this.bot.on("peerLeave", (ev) => this._broadcast({ event: "peer_leave", ...ev }));
    this.bot.on("voiceState", (ev) => this._broadcast({ event: "voice_state", ...ev }));
    this.bot.on("audioEnd", () => this._broadcast({ event: "audio_end" }));
    this.bot.on("voiceAudio", ({ peerId, rms, pcm }) => {
      for (const [ws, meta] of this.clients.entries()) {
        if (meta.voiceAudioSubscribed && ws.readyState === 1) {
          const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          this._sendJson(ws, {
            event: "voice_audio",
            peerId,
            rms,
            sampleRate: 16000,
            pcmBase64: buf.toString("base64"),
          });
        }
      }
    });

    return {
      ...ready,
      wsUrl: `ws://${this.host}:${this.port}`,
    };
  }

  async stop() {
    for (const ws of this.clients.keys()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    if (this.wss) {
      await new Promise((resolve) => this.wss.close(() => resolve()));
      this.wss = null;
    }
    await this.bot.disconnect();
  }

  _sendJson(ws, obj) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
    }
  }

  _broadcast(obj) {
    const raw = JSON.stringify(obj);
    for (const ws of this.clients.keys()) {
      if (ws.readyState === 1) {
        ws.send(raw);
      }
    }
  }

  _onClient(ws) {
    const meta = { voiceAudioSubscribed: false };
    this.clients.set(ws, meta);

    this._sendJson(ws, {
      event: "ready",
      peerId: this.bot.peerId,
      authorName: this.bot.name,
      room: this.bot.activeRoom?.name || "",
      inVoice: this.bot.inVoice,
      peers: this.bot.getPeers(),
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // Raw 16 kHz mono Int16LE PCM bytes -> stream directly into E2EE voice channel
        this.bot.pushPcmBytes(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return;
      }
      let req;
      try {
        req = JSON.parse(data.toString("utf8"));
      } catch (err) {
        this._sendJson(ws, { event: "reply", ok: false, error: `Invalid JSON: ${err.message}` });
        return;
      }
      this._handleCommand(ws, meta, req);
    });

    ws.on("close", () => {
      this.clients.delete(ws);
    });
  }

  _handleCommand(ws, meta, req) {
    const reqId = req.reqId ?? null;
    const replyOk = (data = {}) => this._sendJson(ws, { event: "reply", reqId, ok: true, data });
    const replyErr = (err) =>
      this._sendJson(ws, { event: "reply", reqId, ok: false, error: err?.message || String(err) });

    try {
      switch (req.cmd) {
        case "send_text": {
          replyOk(this.bot.sendText(req.text));
          break;
        }
        case "send_bot_message": {
          replyOk(this.bot.sendBotMessage(req.card || req.payload));
          break;
        }
        case "update_bot_message": {
          replyOk(this.bot.updateBotMessage(req.targetId, req.card || req.payload));
          break;
        }
        case "edit_message": {
          const editPayload =
            req.payload !== undefined
              ? req.payload
              : req.card !== undefined
                ? req.card
                : typeof req.text === "string"
                  ? { text: req.text }
                  : null;
          replyOk(this.bot.editMessage(req.targetId, editPayload));
          break;
        }
        case "get_raw_log": {
          replyOk({ rawLog: this.bot.getRawLog({ compactMedia: Boolean(req.compactMedia) }) });
          break;
        }
        case "delete_message": {
          replyOk(this.bot.deleteMessage(req.targetId));
          break;
        }
        case "send_raw": {
          replyOk(this.bot.sendRaw(req.type, req.payload, req.id));
          break;
        }
        case "join_voice": {
          replyOk({ voice: this.bot.joinVoice({ muted: Boolean(req.muted) }) });
          break;
        }
        case "leave_voice": {
          replyOk({ voice: this.bot.leaveVoice() });
          break;
        }
        case "set_voice_muted": {
          this.bot.setVoiceMuted(Boolean(req.muted));
          replyOk({ muted: this.bot.voiceMuted });
          break;
        }
        case "set_audio_gain": {
          this.bot.setAudioGain(req.gain);
          replyOk({ gain: this.bot.pacer.gain });
          break;
        }
        case "play_audio_file": {
          this.bot.playAudioFile(req.input, {
            ffmpegPath: req.ffmpegPath || "ffmpeg",
            gain: req.gain ?? 1.0,
          });
          replyOk({ playing: req.input });
          break;
        }
        case "play_tone": {
          this.bot.playTone({
            freqHz: req.freqHz ?? 440,
            durationMs: req.durationMs ?? 1200,
            amplitude: req.amplitude ?? 0.25,
          });
          replyOk({ playing: "tone" });
          break;
        }
        case "pause_audio": {
          this.bot.pauseAudio();
          replyOk({ paused: true });
          break;
        }
        case "resume_audio": {
          this.bot.resumeAudio();
          replyOk({ paused: false });
          break;
        }
        case "stop_audio": {
          this.bot.stopAudio();
          replyOk({ stopped: true });
          break;
        }
        case "subscribe_voice_audio": {
          meta.voiceAudioSubscribed = Boolean(req.enabled);
          replyOk({ subscribed: meta.voiceAudioSubscribed });
          break;
        }
        case "get_status": {
          replyOk({
            status: this.bot.getStatus(),
            messages: this.bot.getMessages(),
          });
          break;
        }
        default: {
          replyErr(`Unknown bridge command '${req.cmd}'`);
        }
      }
    } catch (err) {
      replyErr(err);
    }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help || !args.room) {
    console.log(
      [
        "p2p-direct Local WebSocket Bot Bridge",
        "",
        "Usage:",
        '  node bot/bridge.mjs --room "<room-invite-url>" [--name "MyBot"] [--passphrase "..."] [--port 8765]',
        "",
        "Options:",
        "  --room, -r       Room invite link (#room=P2P1:...) or raw P2P1: code (or env P2P_ROOM)",
        "  --name, -n       Bot display name shown in chat & voice (default: P2PBot)",
        "  --passphrase, -p Optional shared room passphrase (or env P2P_PASSPHRASE)",
        "  --port           Local WebSocket port (default: 8765)",
        "  --host           Bind address (default: 127.0.0.1)",
        "  --relay          Optional custom MQTT WebSocket relay URL",
      ].join("\n")
    );
    process.exit(args.help ? 0 : 1);
  }

  const bridge = new P2PBotBridge({
    roomLink: args.room,
    passphrase: args.passphrase,
    name: args.name,
    relay: args.relay,
    peerId: args.peerId,
    host: args.host,
    port: args.port,
  });

  bridge
    .start()
    .then((info) => {
      console.log(`[bridge] Connected as ${info.authorName} (${info.peerId}) to room "${info.room}"`);
      console.log(`[bridge] Local WebSocket API listening on ${info.wsUrl}`);
    })
    .catch((err) => {
      console.error("[bridge] Failed to start:", err.message);
      process.exit(1);
    });

  const shutdown = async () => {
    console.log("\n[bridge] Shutting down...");
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

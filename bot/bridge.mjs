#!/usr/bin/env node
/**
 * Local WebSocket Bot Bridge for p2p-direct (`voice.dequ.org`).
 *
 * Connects to any room as an ordinary E2EE WebRTC peer (or starts in standby mode waiting
 * for a dynamic `connect_room` command — ideal for Home Assistant Apps / Add-ons watching
 * a room-link helper) and exposes a JSON + binary PCM WebSocket interface on localhost.
 *
 * Usage:
 *   # Connect immediately to a room:
 *   node bot/bridge.mjs --room "https://voice.dequ.org/#room=P2P1:..." --name "Assist" --port 8765
 *
 *   # Start in standby mode (connect/switch rooms dynamically via WebSocket `connect_room`):
 *   node bot/bridge.mjs --name "Assist" --port 8765
 */

import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { P2PBot, VOICE_SAMPLE_RATE } from "./sdk.mjs";

export function parseCliArgs(argv) {
  const args = {
    room: process.env.P2P_ROOM || "",
    passphrase: process.env.P2P_PASSPHRASE || "",
    name: process.env.P2P_BOT_NAME || "P2PBot",
    relay: process.env.P2P_RELAY || "",
    host: process.env.P2P_BRIDGE_HOST || "127.0.0.1",
    port: Number(process.env.P2P_BRIDGE_PORT || 8765),
    peerId: process.env.P2P_PEER_ID || "",
    autoJoinVoice: process.env.P2P_AUTO_JOIN_VOICE === "1",
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
    } else if (flag === "--join-voice") {
      args.autoJoinVoice = true;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    }
  }
  return args;
}

export class P2PBotBridge {
  constructor({
    roomLink = "",
    passphrase = "",
    name = "P2PBot",
    relay = "",
    peerId = "",
    host = "127.0.0.1",
    port = 8765,
    wasmPath,
    autoJoinVoice = false,
  } = {}) {
    this.host = host;
    this.port = port;
    this.defaultName = name || "P2PBot";
    this.defaultRelay = relay || "";
    this.defaultPeerId = peerId || "";
    this.wasmPath = wasmPath;
    this.initialRoomLink = roomLink || "";
    this.initialPassphrase = passphrase || "";
    this.initialAutoJoinVoice = Boolean(autoJoinVoice);

    this.bot = null;
    this.mixer = null;
    this.roomState = "disconnected"; // disconnected | connecting | connected | error
    this.lastError = "";
    this.wss = null;
    this.clients = new Map(); // ws -> { voiceAudioSubscribed, mixedAudioSubscribed, pcmInputRate, pcmInputChannels }
    this._mixerOpts = {
      echoSuppression: true,
      echoTailMs: 350,
      allowedSpeakers: null,
    };
  }

  async start() {
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

    let ready = {
      peerId: this.defaultPeerId || "",
      authorName: this.defaultName,
      room: "",
      roomTopic: "",
      relayUrls: [],
    };
    if (this.initialRoomLink) {
      ready = await this.connectRoom({
        roomLink: this.initialRoomLink,
        passphrase: this.initialPassphrase,
        name: this.defaultName,
        relay: this.defaultRelay,
        peerId: this.defaultPeerId,
        autoJoinVoice: this.initialAutoJoinVoice,
      });
    }

    return {
      ...ready,
      state: this.roomState,
      wsUrl: `ws://${this.host}:${this.port}`,
    };
  }

  async connectRoom({
    roomLink,
    passphrase = "",
    name,
    relay,
    peerId,
    autoJoinVoice = false,
  } = {}) {
    const cleanLink = String(roomLink || "").trim();
    if (!cleanLink) {
      throw new Error("connect_room requires a non-empty roomLink");
    }

    await this.disconnectRoom({ silent: true });

    this.roomState = "connecting";
    this.lastError = "";
    this._broadcastRoomState();

    const bot = new P2PBot({
      roomLink: cleanLink,
      passphrase: String(passphrase || ""),
      name: String(name || this.defaultName || "P2PBot"),
      relay: relay || this.defaultRelay || undefined,
      peerId: peerId || this.defaultPeerId || undefined,
      wasmPath: this.wasmPath,
    });
    this.bot = bot;
    this._bindBotEvents(bot);

    try {
      const ready = await bot.connect();
      this.roomState = "connected";
      if (autoJoinVoice) {
        bot.joinVoice({ muted: false });
      }
      this._syncMixerLifecycle();
      this._broadcastRoomState();
      return ready;
    } catch (err) {
      this.roomState = "error";
      this.lastError = err?.message || String(err);
      try {
        await bot.disconnect();
      } catch {
        // ignore
      }
      if (this.bot === bot) {
        this.bot = null;
      }
      this._broadcastRoomState();
      throw err;
    }
  }

  async disconnectRoom({ silent = false } = {}) {
    if (this.mixer) {
      this.mixer.destroy();
      this.mixer = null;
    }
    if (this.bot) {
      const prev = this.bot;
      this.bot = null;
      try {
        await prev.disconnect();
      } catch {
        // ignore
      }
    }
    this.roomState = "disconnected";
    this.lastError = "";
    if (!silent) {
      this._broadcastRoomState();
    }
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
    await this.disconnectRoom({ silent: true });
  }

  _bindBotEvents(bot) {
    bot.on("message", (message) => this._broadcast({ event: "message", message }));
    bot.on("messageUpdate", (message) => this._broadcast({ event: "message_update", message }));
    bot.on("messageDelete", (ev) => this._broadcast({ event: "message_delete", ...ev }));
    bot.on("interaction", (ev) => this._broadcast({ event: "interaction", ...ev }));
    bot.on("peerJoin", (ev) => this._broadcast({ event: "peer_join", ...ev }));
    bot.on("peerLeave", (ev) => this._broadcast({ event: "peer_leave", ...ev }));
    bot.on("voiceState", (ev) => this._broadcast({ event: "voice_state", ...ev }));
    bot.on("audioStart", () => this._broadcast({ event: "audio_start" }));
    bot.on("audioEnd", () => this._broadcast({ event: "audio_end" }));
    bot.on("voiceAudio", ({ peerId, rms, pcm }) => {
      for (const [ws, meta] of this.clients.entries()) {
        if (meta.voiceAudioSubscribed && ws.readyState === 1) {
          const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          this._sendJson(ws, {
            event: "voice_audio",
            peerId,
            rms,
            sampleRate: VOICE_SAMPLE_RATE,
            pcmBase64: buf.toString("base64"),
          });
        }
      }
    });
  }

  _syncMixerLifecycle() {
    let anySubscribed = false;
    for (const meta of this.clients.values()) {
      if (meta.mixedAudioSubscribed) {
        anySubscribed = true;
        break;
      }
    }
    if (!anySubscribed || !this.bot) {
      if (this.mixer) {
        this.mixer.destroy();
        this.mixer = null;
      }
      return;
    }
    if (!this.mixer) {
      this.mixer = this.bot.createVoiceMixer(this._mixerOpts);
      this.mixer.on("frame", (frame) => {
        for (const [ws, meta] of this.clients.entries()) {
          if (meta.mixedAudioSubscribed && ws.readyState === 1) {
            ws.send(frame.buffer, { binary: true });
          }
        }
      });
      this.mixer.start();
    }
  }

  _roomStatePayload() {
    return {
      event: "room_state",
      state: this.roomState,
      peerId: this.bot?.peerId || this.defaultPeerId || "",
      authorName: this.bot?.name || this.defaultName,
      room: this.bot?.activeRoom?.name || "",
      inVoice: Boolean(this.bot?.inVoice),
      voiceMuted: Boolean(this.bot?.voiceMuted),
      peers: this.bot ? this.bot.getPeers() : [],
      lockedSpeaker: this.mixer?.lockedPeerId || null,
      error: this.lastError || "",
    };
  }

  _broadcastRoomState() {
    this._broadcast(this._roomStatePayload());
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

  _requireBot() {
    if (!this.bot || this.roomState !== "connected") {
      throw new Error("Bridge is in standby mode — send `connect_room` with a roomLink first");
    }
    return this.bot;
  }

  _onClient(ws) {
    const meta = {
      voiceAudioSubscribed: false,
      mixedAudioSubscribed: false,
      pcmInputRate: VOICE_SAMPLE_RATE,
      pcmInputChannels: 1,
    };
    this.clients.set(ws, meta);

    this._sendJson(ws, {
      event: "ready",
      state: this.roomState,
      peerId: this.bot?.peerId || this.defaultPeerId || "",
      authorName: this.bot?.name || this.defaultName,
      room: this.bot?.activeRoom?.name || "",
      inVoice: Boolean(this.bot?.inVoice),
      peers: this.bot ? this.bot.getPeers() : [],
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!this.bot || this.roomState !== "connected") return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.bot.pushPcmBytes(buf, {
          sampleRate: meta.pcmInputRate,
          channels: meta.pcmInputChannels,
        });
        return;
      }
      let req;
      try {
        req = JSON.parse(data.toString("utf8"));
      } catch (err) {
        this._sendJson(ws, { event: "reply", ok: false, error: `Invalid JSON: ${err.message}` });
        return;
      }
      this._handleCommand(ws, meta, req).catch((err) => {
        this._sendJson(ws, {
          event: "reply",
          reqId: req?.reqId ?? null,
          ok: false,
          error: err?.message || String(err),
        });
      });
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      this._syncMixerLifecycle();
    });
  }

  async _handleCommand(ws, meta, req) {
    const reqId = req.reqId ?? null;
    const replyOk = (data = {}) => this._sendJson(ws, { event: "reply", reqId, ok: true, data });
    const replyErr = (err) =>
      this._sendJson(ws, { event: "reply", reqId, ok: false, error: err?.message || String(err) });

    try {
      switch (req.cmd) {
        case "connect_room": {
          const info = await this.connectRoom({
            roomLink: req.roomLink || req.room,
            passphrase: req.passphrase || "",
            name: req.name,
            relay: req.relay,
            peerId: req.peerId,
            autoJoinVoice: Boolean(req.autoJoinVoice),
          });
          replyOk({ ...info, state: this.roomState });
          break;
        }
        case "disconnect_room": {
          await this.disconnectRoom();
          replyOk({ state: this.roomState });
          break;
        }
        case "send_text": {
          replyOk(this._requireBot().sendText(req.text));
          break;
        }
        case "send_bot_message": {
          replyOk(this._requireBot().sendBotMessage(req.card || req.payload));
          break;
        }
        case "update_bot_message": {
          replyOk(this._requireBot().updateBotMessage(req.targetId, req.card || req.payload));
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
          replyOk(this._requireBot().editMessage(req.targetId, editPayload));
          break;
        }
        case "get_raw_log": {
          replyOk({ rawLog: this._requireBot().getRawLog({ compactMedia: Boolean(req.compactMedia) }) });
          break;
        }
        case "delete_message": {
          replyOk(this._requireBot().deleteMessage(req.targetId));
          break;
        }
        case "send_raw": {
          replyOk(this._requireBot().sendRaw(req.type, req.payload, req.id));
          break;
        }
        case "join_voice": {
          replyOk({ voice: this._requireBot().joinVoice({ muted: Boolean(req.muted) }) });
          this._broadcastRoomState();
          break;
        }
        case "leave_voice": {
          replyOk({ voice: this._requireBot().leaveVoice() });
          this._broadcastRoomState();
          break;
        }
        case "set_voice_muted": {
          const bot = this._requireBot();
          bot.setVoiceMuted(Boolean(req.muted));
          replyOk({ muted: bot.voiceMuted });
          this._broadcastRoomState();
          break;
        }
        case "set_audio_gain": {
          const bot = this._requireBot();
          bot.setAudioGain(req.gain);
          replyOk({ gain: bot.pacer.gain });
          break;
        }
        case "set_pcm_input_format": {
          meta.pcmInputRate = Math.max(4000, Number(req.sampleRate) || VOICE_SAMPLE_RATE);
          meta.pcmInputChannels = Math.max(1, Math.min(8, Math.round(Number(req.channels) || 1)));
          replyOk({ sampleRate: meta.pcmInputRate, channels: meta.pcmInputChannels });
          break;
        }
        case "mark_audio_stream_end": {
          this._requireBot().markAudioStreamEnd();
          replyOk({ ended: true });
          break;
        }
        case "play_audio_file": {
          this._requireBot().playAudioFile(req.input, {
            ffmpegPath: req.ffmpegPath || "ffmpeg",
            gain: req.gain ?? 1.0,
          });
          replyOk({ playing: req.input });
          break;
        }
        case "play_tone": {
          this._requireBot().playTone({
            freqHz: req.freqHz ?? 440,
            durationMs: req.durationMs ?? 1200,
            amplitude: req.amplitude ?? 0.25,
          });
          replyOk({ playing: "tone" });
          break;
        }
        case "play_chime": {
          this._requireBot().playChime(req.kind || "awake", {
            amplitude: req.amplitude ?? 0.22,
          });
          replyOk({ playing: req.kind || "awake" });
          break;
        }
        case "pause_audio": {
          this._requireBot().pauseAudio();
          replyOk({ paused: true });
          break;
        }
        case "resume_audio": {
          this._requireBot().resumeAudio();
          replyOk({ paused: false });
          break;
        }
        case "stop_audio": {
          this._requireBot().stopAudio();
          replyOk({ stopped: true });
          break;
        }
        case "subscribe_voice_audio": {
          meta.voiceAudioSubscribed = Boolean(req.enabled);
          replyOk({ subscribed: meta.voiceAudioSubscribed });
          break;
        }
        case "subscribe_mixed_audio": {
          meta.mixedAudioSubscribed = Boolean(req.enabled);
          if (req.echoSuppression !== undefined) {
            this._mixerOpts.echoSuppression = Boolean(req.echoSuppression);
          }
          if (req.echoTailMs !== undefined) {
            this._mixerOpts.echoTailMs = Math.max(0, Number(req.echoTailMs) || 0);
          }
          if (Array.isArray(req.allowedSpeakers)) {
            this._mixerOpts.allowedSpeakers = req.allowedSpeakers;
          }
          if (this.mixer) {
            this.mixer.echoSuppression = this._mixerOpts.echoSuppression;
            this.mixer.echoTailMs = this._mixerOpts.echoTailMs;
            this.mixer.setAllowedSpeakers(this._mixerOpts.allowedSpeakers);
          }
          this._syncMixerLifecycle();
          replyOk({
            subscribed: meta.mixedAudioSubscribed,
            sampleRate: VOICE_SAMPLE_RATE,
            channels: 1,
            frameBytes: 640,
            echoSuppression: this._mixerOpts.echoSuppression,
          });
          break;
        }
        case "lock_speaker": {
          if (!this.mixer) {
            replyOk({ lockedPeerId: null });
            break;
          }
          const lockedPeerId = req.peerId
            ? this.mixer.lockSpeaker(req.peerId)
            : this.mixer.lockToLastActiveSpeaker(req.maxAgeMs ?? 3000);
          replyOk({ lockedPeerId });
          break;
        }
        case "unlock_speaker": {
          if (this.mixer) this.mixer.unlockSpeaker();
          replyOk({ lockedPeerId: null });
          break;
        }
        case "set_allowed_speakers": {
          const list = Array.isArray(req.speakers) ? req.speakers : [];
          this._mixerOpts.allowedSpeakers = list.length > 0 ? list : null;
          if (this.mixer) {
            this.mixer.setAllowedSpeakers(this._mixerOpts.allowedSpeakers);
          }
          replyOk({ allowedSpeakers: this._mixerOpts.allowedSpeakers || [] });
          break;
        }
        case "get_status": {
          replyOk({
            state: this.roomState,
            error: this.lastError || "",
            status: this.bot ? this.bot.getStatus() : null,
            messages: this.bot ? this.bot.getMessages() : [],
            inVoice: Boolean(this.bot?.inVoice),
            lockedSpeaker: this.mixer?.lockedPeerId || null,
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
  if (args.help) {
    console.log(
      [
        "p2p-direct Local WebSocket Bot Bridge",
        "",
        "Usage:",
        '  node bot/bridge.mjs [--room "<room-invite-url>"] [--name "MyBot"] [--passphrase "..."] [--port 8765]',
        "",
        "Options:",
        "  --room, -r       Optional room invite link (#room=P2P1:...); omit for standby mode",
        "  --name, -n       Bot display name shown in chat & voice (default: P2PBot)",
        "  --passphrase, -p Optional shared room passphrase (or env P2P_PASSPHRASE)",
        "  --join-voice     Automatically join the room voice channel after connecting",
        "  --port           Local WebSocket port (default: 8765)",
        "  --host           Bind address (default: 127.0.0.1)",
        "  --relay          Optional custom MQTT WebSocket relay URL",
      ].join("\n")
    );
    process.exit(0);
  }

  const bridge = new P2PBotBridge({
    roomLink: args.room,
    passphrase: args.passphrase,
    name: args.name,
    relay: args.relay,
    peerId: args.peerId,
    host: args.host,
    port: args.port,
    autoJoinVoice: args.autoJoinVoice,
  });

  bridge
    .start()
    .then((info) => {
      if (info.room) {
        console.log(`[bridge] Connected as ${info.authorName} (${info.peerId}) to room "${info.room}"`);
      } else {
        console.log(`[bridge] Started in standby mode as "${info.authorName}" (waiting for connect_room)`);
      }
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

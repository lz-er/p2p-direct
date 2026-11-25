import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection } from "werift";
import { SafeRustWasmMesh } from "../wasm_client.js";
import { MultiRelayRendezvous, resolveRelayUrls } from "../mqtt_relay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_FRAME_SAMPLES = 320; // 20ms @ 16 kHz mono
export const VOICE_FRAME_BYTES = VOICE_FRAME_SAMPLES * 2; // Int16LE

function buildOpenRelayTurnServer() {
  const expiry = Math.floor(Date.now() / 1000) + 12 * 3600;
  const username = `${expiry}:p2pdbot`;
  const credential = crypto
    .createHmac("sha1", "openrelayprojectsecret")
    .update(username)
    .digest("base64");
  return {
    urls: "turn:staticauth.openrelay.metered.ca:443?transport=tcp",
    username,
    credential,
  };
}

export const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  buildOpenRelayTurnServer(),
];

function randomHex(byteLen) {
  return crypto.randomBytes(byteLen).toString("hex");
}

function randomBase64Url(byteLen) {
  return crypto
    .randomBytes(byteLen)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function randomId(prefix) {
  return `${prefix}-${randomHex(4)}`;
}

/**
 * Extracts optional `?relay=` query parameter and `#room=` code from a shareable room link.
 */
export function parseRoomLink(rawInput) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) {
    throw new Error("roomLink is required");
  }
  let relayFromQuery = null;
  let code = trimmed;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      relayFromQuery = parsed.searchParams.get("relay");
      if (parsed.hash) {
        const match = parsed.hash.match(/#room=([^&]+)/i);
        if (match && match[1]) {
          code = decodeURIComponent(match[1]);
        }
      }
    } else if (trimmed.startsWith("#")) {
      const match = trimmed.match(/#room=([^&]+)/i);
      if (match && match[1]) {
        code = decodeURIComponent(match[1]);
      }
    }
  } catch {
    // treat as raw P2P1: code
  }
  return { code, relayFromQuery };
}

/**
 * Real-time drift-compensated 20ms (16 kHz mono Int16LE) voice audio pacer.
 * Accepts arbitrary PCM chunks (e.g., from ffmpeg stdout, WebSocket binary frames, or synth)
 * and feeds exact 320-sample frames into `onFrame(Int16Array)` every 20 ms.
 */
class VoiceAudioPacer {
  constructor({ onFrame, onDrain, gain = 1.0 }) {
    this.onFrame = onFrame;
    this.onDrain = onDrain;
    this.gain = gain;
    this.queue = [];
    this.queuedBytes = 0;
    this.paused = false;
    this.timer = null;
    this.nextTickAt = 0;
    this.ending = false;
    this.activeChild = null;
  }

  pushBytes(chunk) {
    if (!chunk || chunk.length === 0) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.queue.push(buf);
    this.queuedBytes += buf.length;
    this._ensureRunning();
  }

  pushInt16(int16Array) {
    if (!int16Array || int16Array.length === 0) return;
    const buf = Buffer.from(
      int16Array.buffer,
      int16Array.byteOffset,
      int16Array.byteLength
    );
    this.pushBytes(buf);
  }

  markInputEnded() {
    this.ending = true;
    if (this.queuedBytes < VOICE_FRAME_BYTES && !this.paused) {
      this._finish();
    }
  }

  pause() {
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.nextTickAt = Date.now();
    this._ensureRunning();
  }

  stop() {
    this.paused = false;
    this.ending = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.activeChild) {
      try {
        this.activeChild.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.activeChild = null;
    }
    this.queue = [];
    this.queuedBytes = 0;
  }

  _takeBytes(count) {
    const out = Buffer.allocUnsafe(count);
    let offset = 0;
    while (offset < count && this.queue.length > 0) {
      const head = this.queue[0];
      const need = count - offset;
      if (head.length <= need) {
        head.copy(out, offset);
        offset += head.length;
        this.queue.shift();
      } else {
        head.copy(out, offset, 0, need);
        this.queue[0] = head.subarray(need);
        offset += need;
      }
    }
    this.queuedBytes = Math.max(0, this.queuedBytes - offset);
    if (offset < count) {
      out.fill(0, offset);
    }
    return out;
  }

  _ensureRunning() {
    if (this.paused || this.timer) return;
    if (this.queuedBytes < VOICE_FRAME_BYTES && !this.ending) return;
    this.nextTickAt = Date.now();
    this._step();
  }

  _step() {
    this.timer = null;
    if (this.paused) return;

    if (this.queuedBytes >= VOICE_FRAME_BYTES || (this.ending && this.queuedBytes > 0)) {
      const frameBytes = this._takeBytes(VOICE_FRAME_BYTES);
      const samples = new Int16Array(VOICE_FRAME_SAMPLES);
      const g = this.gain;
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        const raw = frameBytes.readInt16LE(i * 2);
        const scaled = g === 1 ? raw : Math.max(-32768, Math.min(32767, Math.round(raw * g)));
        samples[i] = scaled;
      }
      this.onFrame(samples);

      this.nextTickAt += 20;
      const now = Date.now();
      if (this.nextTickAt < now - 100) {
        this.nextTickAt = now;
      }
      const delay = Math.max(1, this.nextTickAt - now);
      this.timer = setTimeout(() => this._step(), delay);
      return;
    }

    if (this.ending) {
      this._finish();
    }
  }

  _finish() {
    this.ending = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.onDrain) {
      this.onDrain();
    }
  }
}

/**
 * Self-hostable P2P Bot client for p2p-direct (`voice.dequ.org`).
 *
 * Connects directly to any room as an ordinary end-to-end encrypted WebRTC peer using the
 * exact same room link (and optional passphrase) as browser users — zero servers, zero roles.
 */
export class P2PBot extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.roomLink) {
      throw new Error("P2PBot requires { roomLink }");
    }
    this.roomLink = options.roomLink;
    this.passphrase = options.passphrase || "";
    this.name = String(options.name || "P2PBot").trim().slice(0, 32) || "P2PBot";
    this.peerId = String(options.peerId || `bot-${randomHex(6)}`);
    this.customRelay = options.relay || null;
    this.isBot = options.isBot !== false;
    this.wasmPath = options.wasmPath || path.resolve(__dirname, "..", "p2p_mesh.wasm");
    this.iceServers = Array.isArray(options.iceServers) ? options.iceServers : DEFAULT_ICE_SERVERS;

    this.wasm = null;
    this.status = null;
    this.activeRoom = null;
    this.roomRendezvous = null;
    this.connected = false;

    this.directPeers = new Map(); // peerId -> { pc, dc, voiceDc, authorName, lastActivityMs, superseded }
    this.voiceChannels = new Map(); // peerId -> RTCDataChannel("p2p-voice")
    this.roomDialing = new Map();
    this.earlyRoomIce = new Map();
    this.relayPeers = new Map();
    this.earlyRelayIce = new Map();
    this.seenRoomSignalIds = new Map();
    this.lastHelloReplyPerPeer = new Map();

    // Tracking diffs for clean events
    this.knownMessages = new Map(); // msgId -> { msg, rev }
    this.knownPeers = new Map(); // peerId -> { authorName, inVoice, voiceMuted, isBot }
    this.inVoice = false;
    this.voiceMuted = false;

    this.keepaliveTimer = null;
    this.keepaliveTicks = 0;

    this.pacer = new VoiceAudioPacer({
      onFrame: (int16) => this.sendVoicePcm(int16),
      onDrain: () => this.emit("audioEnd"),
      gain: 1.0,
    });
  }

  async connect() {
    if (this.connected) return this.getStatus();

    const wasmBytes = await readFile(this.wasmPath);
    this.wasm = await SafeRustWasmMesh.loadFromBytes(wasmBytes);

    const { code, relayFromQuery } = parseRoomLink(this.roomLink);
    const decoded = this.wasm.call({
      cmd: "decode_signal",
      input: code,
      passphrase: this.passphrase || undefined,
    }).signal;

    if (decoded.kind !== "room") {
      throw new Error(`Expected a #room= invite link, got '${decoded.kind}'`);
    }

    const roomName = decoded.room || "mesh-room";
    const x25519Secret = randomBase64Url(32);
    const initReq = {
      cmd: "init",
      peerId: this.peerId,
      authorName: this.name,
      room: roomName,
      autoMeshEnabled: true,
      isBot: this.isBot,
      x25519Secret,
      entropy: randomBase64Url(32),
    };
    if (this.passphrase) {
      initReq.passphrase = this.passphrase;
    } else if (decoded.meshKey) {
      initReq.meshKey = decoded.meshKey;
      initReq.passphraseMode = false;
    } else {
      throw new Error("Room link is passphrase-protected — pass { passphrase } to P2PBot");
    }

    const initRes = this.wasm.call(initReq);
    this.status = initRes.status;

    const relayOverride = this.customRelay || relayFromQuery || decoded.relay || null;
    const encoded = this.wasm.call({
      cmd: "encode_room_invite",
      room: roomName,
      relay: relayOverride || undefined,
      entropy: randomBase64Url(16),
    });
    this.status = encoded.status;
    this.activeRoom = {
      name: encoded.room,
      code: encoded.code,
      topic: encoded.roomTopic,
      relay: relayOverride,
    };

    const relayUrls = resolveRelayUrls(relayOverride);
    this.roomRendezvous = new MultiRelayRendezvous({
      roomTopic: encoded.roomTopic,
      urls: relayUrls,
      onMessage: (sealedPayload) => {
        this._handleSealedRoomSignal(sealedPayload).catch((err) => this.emit("error", err));
      },
      onBrokerReady: (_client, relayStatus) => {
        this.emit("relayStatus", relayStatus);
        this._announceRoomHello(true);
      },
      onStatusChange: (relayStatus) => {
        this.emit("relayStatus", relayStatus);
      },
    });
    this.roomRendezvous.start();

    this.keepaliveTicks = 0;
    this.keepaliveTimer = setInterval(() => this._onKeepaliveTick(), 4000);
    this.connected = true;

    const readyInfo = {
      peerId: this.peerId,
      authorName: this.name,
      room: encoded.room,
      roomTopic: encoded.roomTopic,
      relayUrls,
    };
    this.emit("ready", readyInfo);
    return readyInfo;
  }

  async disconnect() {
    this.connected = false;
    this.stopAudio();
    if (this.inVoice) {
      this.leaveVoice();
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.roomRendezvous) {
      this.roomRendezvous.stop();
      this.roomRendezvous = null;
    }
    for (const [, entry] of this.directPeers) {
      entry.superseded = true;
      try {
        entry.voiceDc?.close();
        entry.dc?.close();
        entry.pc?.close();
      } catch {
        // ignore
      }
    }
    this.directPeers.clear();
    this.voiceChannels.clear();
    for (const [, entry] of this.roomDialing) {
      try {
        entry.pc?.close();
      } catch {
        // ignore
      }
    }
    this.roomDialing.clear();
    for (const [, entry] of this.relayPeers) {
      try {
        entry.pc?.close();
      } catch {
        // ignore
      }
    }
    this.relayPeers.clear();
  }

  /* ================= Chat, Custom Bot Cards & Message Deletion ================= */

  sendText(text) {
    const clean = String(text || "").trim();
    if (!clean) throw new Error("sendText requires non-empty text");
    return this.sendRaw("chat", { text: clean });
  }

  /**
   * Sends a rich custom bot message card with optional title, subtitle, badge, accent color,
   * formatted text, fields, image, footer, and interactive buttons.
   */
  sendBotMessage(card) {
    if (!card || typeof card !== "object") {
      throw new Error("sendBotMessage requires a card object");
    }
    return this.sendRaw("bot", card);
  }

  /**
   * Updates an existing bot message card in place across all peers (CRDT LWW update).
   */
  updateBotMessage(targetId, card) {
    const cleanTarget = String(targetId || "").trim();
    if (!cleanTarget) throw new Error("updateBotMessage requires targetId");
    if (!card || typeof card !== "object") throw new Error("updateBotMessage requires card object");
    return this.sendRaw("bot-update", { targetId: cleanTarget, card });
  }

  /**
   * Deletes any message in the room via an authenticated CRDT tombstone.
   */
  deleteMessage(targetId) {
    this._requireReady();
    const cleanTarget = String(targetId || "").trim();
    if (!cleanTarget) throw new Error("deleteMessage requires targetId");
    const res = this.wasm.call({
      cmd: "delete_message",
      targetId: cleanTarget,
      ts: Date.now(),
      entropy: randomBase64Url(16),
    });
    this.status = res.status;
    this._executeActions(res.actions);
    return { deletedId: res.deletedId, tombstoneId: res.tombstoneId };
  }

  sendRaw(type, payload, customId) {
    this._requireReady();
    const res = this.wasm.call({
      cmd: "publish",
      type: String(type),
      payload,
      ts: Date.now(),
      id: customId || undefined,
      entropy: randomBase64Url(16),
    });
    this.status = res.status;
    this._executeActions(res.actions);
    return { id: res.message.id, message: res.message };
  }

  /* ================= Voice Channel & Audio Streaming ================= */

  joinVoice({ muted = false } = {}) {
    this._requireReady();
    this.inVoice = true;
    this.voiceMuted = Boolean(muted);
    const res = this.wasm.call({
      cmd: "set_voice_state",
      inVoice: true,
      muted: this.voiceMuted,
    });
    this.status = res.status;
    this._executeActions(res.actions);
    return this.status.voice;
  }

  leaveVoice() {
    this.stopAudio();
    if (!this.wasm) return;
    this.inVoice = false;
    this.voiceMuted = false;
    const res = this.wasm.call({
      cmd: "set_voice_state",
      inVoice: false,
      muted: false,
    });
    this.status = res.status;
    this._executeActions(res.actions);
    return this.status.voice;
  }

  setVoiceMuted(muted) {
    this._requireReady();
    this.voiceMuted = Boolean(muted);
    if (!this.inVoice) return;
    const res = this.wasm.call({
      cmd: "set_voice_state",
      inVoice: true,
      muted: this.voiceMuted,
    });
    this.status = res.status;
    this._executeActions(res.actions);
  }

  /**
   * Encodes a 16 kHz mono Int16Array PCM frame (typically 320 samples = 20ms) into E2EE V1
   * IMA-ADPCM voice packets and transmits them over every open `p2p-voice` DataChannel.
   */
  sendVoicePcm(int16Pcm) {
    if (!this.inVoice || this.voiceMuted || !this.wasm) return 0;
    const { packets } = this.wasm.sealVoicePcm(int16Pcm);
    let sent = 0;
    for (const { peerId, data } of packets) {
      const vdc = this.voiceChannels.get(peerId);
      if (vdc && vdc.readyState === "open" && (vdc.bufferedAmount || 0) < 32768) {
        try {
          vdc.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
          sent += 1;
        } catch {
          // drop frame cleanly under congestion
        }
      }
    }
    return sent;
  }

  /**
   * Pushes raw signed 16-bit little-endian 16 kHz mono PCM bytes into the paced voice sender.
   */
  pushPcmBytes(buf) {
    if (!this.inVoice) {
      this.joinVoice({ muted: false });
    }
    this.pacer.pushBytes(buf);
  }

  setAudioGain(gain) {
    const g = Number(gain);
    if (Number.isFinite(g)) {
      this.pacer.gain = Math.max(0, Math.min(2.5, g));
    }
  }

  pauseAudio() {
    this.pacer.pause();
  }

  resumeAudio() {
    this.pacer.resume();
  }

  stopAudio() {
    this.pacer.stop();
  }

  /**
   * Transcodes any local audio file or HTTP audio stream with ffmpeg into 16 kHz mono PCM
   * and streams it live into the E2EE voice channel.
   */
  playAudioFile(inputPathOrUrl, { ffmpegPath = "ffmpeg", gain = 1.0 } = {}) {
    if (!this.inVoice) {
      this.joinVoice({ muted: false });
    }
    this.pacer.stop();
    this.setAudioGain(gain);

    const args = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      String(inputPathOrUrl),
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ar",
      String(VOICE_SAMPLE_RATE),
      "-ac",
      "1",
      "pipe:1",
    ];
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.pacer.activeChild = child;

    child.stdout.on("data", (chunk) => {
      this.pacer.pushBytes(chunk);
    });
    child.stderr.on("data", (errBuf) => {
      const msg = errBuf.toString("utf8").trim();
      if (msg) {
        this.emit("error", new Error(`ffmpeg: ${msg}`));
      }
    });
    child.on("error", (err) => {
      if (this.pacer.activeChild === child) {
        this.pacer.activeChild = null;
      }
      this.emit("error", err);
    });
    child.on("close", () => {
      if (this.pacer.activeChild === child) {
        this.pacer.activeChild = null;
        this.pacer.markInputEnded();
      }
    });
    return child;
  }

  /**
   * Generates a pure-JS sine tone (zero external dependencies) and streams it into voice chat.
   */
  playTone({ freqHz = 440, durationMs = 1200, amplitude = 0.28 } = {}) {
    return this.playMelody([{ freqHz, durationMs }], { amplitude });
  }

  /**
   * Streams a sequence of `{ freqHz, durationMs }` synth notes into voice chat (great for chimes & demos).
   */
  playMelody(notes, { amplitude = 0.25 } = {}) {
    if (!this.inVoice) {
      this.joinVoice({ muted: false });
    }
    this.pacer.stop();
    this.setAudioGain(1.0);

    const chunks = [];
    for (const note of notes) {
      const durMs = Math.max(20, Number(note.durationMs) || 200);
      const totalSamples = Math.round((VOICE_SAMPLE_RATE * durMs) / 1000);
      const freq = Number(note.freqHz) || 0;
      const buf = Buffer.alloc(totalSamples * 2);
      const fadeSamples = Math.min(160, Math.floor(totalSamples / 5));
      for (let i = 0; i < totalSamples; i++) {
        let env = 1;
        if (i < fadeSamples) env = i / fadeSamples;
        else if (i > totalSamples - fadeSamples) env = (totalSamples - i) / fadeSamples;
        const val =
          freq > 0
            ? Math.sin((2 * Math.PI * freq * i) / VOICE_SAMPLE_RATE) * amplitude * env
            : 0;
        const s16 = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
        buf.writeInt16LE(s16, i * 2);
      }
      chunks.push(buf);
    }
    this.pacer.pushBytes(Buffer.concat(chunks));
    this.pacer.markInputEnded();
  }

  getPeers() {
    return (this.status?.peers || []).slice();
  }

  getMessages() {
    return Array.from(this.knownMessages.values()).map((entry) => entry.msg);
  }

  getStatus() {
    return this.status;
  }

  /* ================= Internal WebRTC & Rendezvous Transport ================= */

  _requireReady() {
    if (!this.wasm || !this.status) {
      throw new Error("P2PBot is not connected yet — call await bot.connect() first");
    }
  }

  _sendRoomSignal(msgObj) {
    if (!this.activeRoom || !this.roomRendezvous || !this.wasm) return;
    try {
      const enriched = msgObj.sid ? msgObj : { ...msgObj, sid: randomId("rs") };
      const sealedRes = this.wasm.call({
        cmd: "seal_room_signal",
        payload: JSON.stringify(enriched),
        entropy: randomBase64Url(16),
      });
      this.roomRendezvous.publish(sealedRes.sealed);
    } catch {
      // ignore during teardown
    }
  }

  _announceRoomHello(requestReply) {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    this._sendRoomSignal({
      t: "hello",
      from: this.status.peerId,
      name: this.status.authorName,
      pk: this.status.e2ee.publicKey,
      peers: Array.from(this.directPeers.keys()),
      reply: Boolean(requestReply),
      ts: Date.now(),
    });
  }

  async _handleSealedRoomSignal(sealedPayload) {
    if (!this.activeRoom || !this.wasm || !this.status) return;
    let msg;
    try {
      const opened = this.wasm.call({
        cmd: "open_room_signal",
        sealed: sealedPayload,
      });
      msg = JSON.parse(opened.payload);
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object" || !msg.t || msg.from === this.status.peerId) return;
    if (msg.to && msg.to !== this.status.peerId) return;
    if (msg.sid) {
      if (this.seenRoomSignalIds.has(msg.sid)) return;
      this.seenRoomSignalIds.set(msg.sid, Date.now());
      if (this.seenRoomSignalIds.size > 600) {
        const firstKey = this.seenRoomSignalIds.keys().next().value;
        this.seenRoomSignalIds.delete(firstKey);
      }
    }

    switch (msg.t) {
      case "hello": {
        if (!msg.from || !msg.pk) return;
        const existing = this.directPeers.get(msg.from);
        const remoteConnectedToUs =
          Array.isArray(msg.peers) && msg.peers.includes(this.status.peerId);
        const isHealthy =
          existing && existing.dc && existing.dc.readyState === "open" && remoteConnectedToUs;

        const now = Date.now();
        const lastReply = this.lastHelloReplyPerPeer.get(msg.from) || 0;
        if (
          (msg.reply || (!isHealthy && this.status.peerId > msg.from)) &&
          now - lastReply >= 1400
        ) {
          this.lastHelloReplyPerPeer.set(msg.from, now);
          this._announceRoomHello(false);
        }

        if (
          !isHealthy &&
          !this.roomDialing.has(msg.from) &&
          !this.relayPeers.has(msg.from)
        ) {
          if (this.status.peerId < msg.from) {
            await this._startRoomOffer(msg.from, msg.name || "Peer", msg.pk);
          }
        }
        break;
      }
      case "offer": {
        await this._acceptRoomOffer(msg);
        break;
      }
      case "answer": {
        await this._applyRoomAnswer(msg);
        break;
      }
      case "ice": {
        await this._applyRoomIce(msg.from, msg.cand);
        break;
      }
      case "ice-batch": {
        if (Array.isArray(msg.cands)) {
          for (const cand of msg.cands) {
            await this._applyRoomIce(msg.from, cand);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  _serializeCandidate(cand) {
    if (!cand) return null;
    if (typeof cand.toJSON === "function") {
      return cand.toJSON();
    }
    return {
      candidate: cand.candidate,
      sdpMid: cand.sdpMid,
      sdpMLineIndex: cand.sdpMLineIndex,
    };
  }

  async _safeAddIce(pc, cand) {
    if (!pc || !cand) return;
    if (typeof cand.candidate === "string" && cand.candidate.trim() === "") return;
    try {
      await pc.addIceCandidate(cand);
    } catch {
      // ignore benign late/duplicate ICE errors
    }
  }

  async _flushPendingIce(entry) {
    while (entry.pendingIce.length > 0) {
      const cand = entry.pendingIce.shift();
      await this._safeAddIce(entry.pc, cand);
    }
  }

  async _startRoomOffer(targetPeerId, targetName, targetPubKey) {
    if (this.roomDialing.has(targetPeerId)) return;
    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const voiceDc = pc.createDataChannel("p2p-voice", { ordered: false, maxRetransmits: 0 });
      const early = this.earlyRoomIce.get(targetPeerId) || [];
      this.earlyRoomIce.delete(targetPeerId);

      const entry = {
        pc,
        dc,
        voiceDc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.roomDialing.set(targetPeerId, entry);
      this._attachVoiceDataChannel(targetPeerId, voiceDc);
      this._attachDataChannel(pc, dc, targetPeerId, targetName, targetPubKey, false, null);

      const sendIce = (candJson) => {
        this._sendRoomSignal({
          t: "ice",
          from: this.status.peerId,
          to: targetPeerId,
          cand: candJson,
        });
      };

      pc.onicecandidate = (ev) => {
        const candJson = this._serializeCandidate(ev.candidate);
        if (!candJson || !candJson.candidate) return;
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        sendIce(candJson);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this._sendRoomSignal({
        t: "offer",
        from: this.status.peerId,
        to: targetPeerId,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        sdp: offer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
    } catch {
      this.roomDialing.delete(targetPeerId);
    }
  }

  async _acceptRoomOffer(msg) {
    if (!msg.from || !msg.sdp || !msg.pk) return;
    const prev = this.roomDialing.get(msg.from);
    if (prev) {
      try {
        prev.pc.close();
      } catch {
        // ignore
      }
      this.roomDialing.delete(msg.from);
    }
    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const early = this.earlyRoomIce.get(msg.from) || [];
      this.earlyRoomIce.delete(msg.from);

      const entry = {
        pc,
        dc: null,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.roomDialing.set(msg.from, entry);

      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "p2p-voice") {
          this._attachVoiceDataChannel(msg.from, ev.channel);
          return;
        }
        entry.dc = ev.channel;
        this._attachDataChannel(
          pc,
          ev.channel,
          msg.from,
          msg.name || "Peer",
          msg.pk,
          false,
          null
        );
      };

      const sendIce = (candJson) => {
        this._sendRoomSignal({
          t: "ice",
          from: this.status.peerId,
          to: msg.from,
          cand: candJson,
        });
      };

      pc.onicecandidate = (ev) => {
        const candJson = this._serializeCandidate(ev.candidate);
        if (!candJson || !candJson.candidate) return;
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        sendIce(candJson);
      };

      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      entry.remoteDescSet = true;
      await this._flushPendingIce(entry);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this._sendRoomSignal({
        t: "answer",
        from: this.status.peerId,
        to: msg.from,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        sdp: answer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
    } catch {
      this.roomDialing.delete(msg.from);
    }
  }

  async _applyRoomAnswer(msg) {
    const entry = this.roomDialing.get(msg.from);
    if (!entry || !msg.sdp) return;
    try {
      await entry.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      entry.remoteDescSet = true;
      await this._flushPendingIce(entry);
    } catch {
      // ignore race
    }
  }

  async _applyRoomIce(fromPeerId, candidate) {
    if (!fromPeerId || !candidate) return;
    const entry = this.roomDialing.get(fromPeerId);
    if (!entry) {
      const direct = this.directPeers.get(fromPeerId);
      if (direct && direct.pc) {
        await this._safeAddIce(direct.pc, candidate);
        return;
      }
      const list = this.earlyRoomIce.get(fromPeerId) || [];
      list.push(candidate);
      this.earlyRoomIce.set(fromPeerId, list);
      return;
    }
    if (!entry.remoteDescSet) {
      entry.pendingIce.push(candidate);
      return;
    }
    await this._safeAddIce(entry.pc, candidate);
  }

  /* ================= Auto-Mesh Relayed Signaling ================= */

  async _startRelayedOffer(targetPeerId, targetName, targetPubKey, viaPeerId) {
    if (this.directPeers.has(targetPeerId) || this.relayPeers.has(targetPeerId)) return;
    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const voiceDc = pc.createDataChannel("p2p-voice", { ordered: false, maxRetransmits: 0 });
      const early = this.earlyRelayIce.get(targetPeerId) || [];
      this.earlyRelayIce.delete(targetPeerId);

      const entry = {
        pc,
        dc,
        voiceDc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        viaPeerId,
      };
      this.relayPeers.set(targetPeerId, entry);
      this._attachVoiceDataChannel(targetPeerId, voiceDc);
      this._attachDataChannel(pc, dc, targetPeerId, targetName, targetPubKey, true, viaPeerId);

      const sendIce = (candJson) => {
        try {
          const res = this.wasm.call({
            cmd: "send_relay_signal",
            toPeerId: targetPeerId,
            signalType: "ice",
            candidate: candJson,
            viaPeerId,
          });
          this.status = res.status;
          this._executeActions(res.actions);
        } catch {
          // ignore
        }
      };

      pc.onicecandidate = (ev) => {
        const candJson = this._serializeCandidate(ev.candidate);
        if (!candJson || !candJson.candidate) return;
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        sendIce(candJson);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = this.wasm.call({
        cmd: "send_relay_signal",
        toPeerId: targetPeerId,
        signalType: "offer",
        sdp: offer.sdp,
        viaPeerId,
      });
      this.status = res.status;
      this._executeActions(res.actions);
      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
    } catch {
      this.relayPeers.delete(targetPeerId);
    }
  }

  async _acceptRelayedOffer(fromPeerId, fromName, fromPubKey, viaPeerId, sdp) {
    if (this.directPeers.has(fromPeerId)) return;
    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const early = this.earlyRelayIce.get(fromPeerId) || [];
      this.earlyRelayIce.delete(fromPeerId);

      const entry = {
        pc,
        dc: null,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        viaPeerId,
      };
      this.relayPeers.set(fromPeerId, entry);

      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "p2p-voice") {
          this._attachVoiceDataChannel(fromPeerId, ev.channel);
          return;
        }
        entry.dc = ev.channel;
        this._attachDataChannel(pc, ev.channel, fromPeerId, fromName, fromPubKey, true, viaPeerId);
      };

      const sendIce = (candJson) => {
        try {
          const res = this.wasm.call({
            cmd: "send_relay_signal",
            toPeerId: fromPeerId,
            signalType: "ice",
            candidate: candJson,
            viaPeerId,
          });
          this.status = res.status;
          this._executeActions(res.actions);
        } catch {
          // ignore
        }
      };

      pc.onicecandidate = (ev) => {
        const candJson = this._serializeCandidate(ev.candidate);
        if (!candJson || !candJson.candidate) return;
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        sendIce(candJson);
      };

      await pc.setRemoteDescription({ type: "offer", sdp });
      entry.remoteDescSet = true;
      await this._flushPendingIce(entry);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const res = this.wasm.call({
        cmd: "send_relay_signal",
        toPeerId: fromPeerId,
        signalType: "answer",
        sdp: answer.sdp,
        viaPeerId,
      });
      this.status = res.status;
      this._executeActions(res.actions);
      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
    } catch {
      this.relayPeers.delete(fromPeerId);
    }
  }

  async _applyRelayedAnswer(fromPeerId, sdp) {
    const entry = this.relayPeers.get(fromPeerId);
    if (!entry || !sdp) return;
    try {
      await entry.pc.setRemoteDescription({ type: "answer", sdp });
      entry.remoteDescSet = true;
      await this._flushPendingIce(entry);
    } catch {
      // ignore
    }
  }

  async _applyRelayedIce(fromPeerId, candidate) {
    const entry = this.relayPeers.get(fromPeerId);
    if (!entry) {
      const list = this.earlyRelayIce.get(fromPeerId) || [];
      list.push(candidate);
      this.earlyRelayIce.set(fromPeerId, list);
      return;
    }
    if (!entry.remoteDescSet) {
      entry.pendingIce.push(candidate);
      return;
    }
    await this._safeAddIce(entry.pc, candidate);
  }

  /* ================= DataChannels & WASM Dispatch ================= */

  _attachVoiceDataChannel(peerId, voiceDc) {
    if (!voiceDc) return;
    const prev = this.voiceChannels.get(peerId);
    if (prev && prev !== voiceDc) {
      try {
        prev.onmessage = null;
        prev.onclose = null;
        prev.close();
      } catch {
        // ignore
      }
    }
    this.voiceChannels.set(peerId, voiceDc);
    const direct = this.directPeers.get(peerId);
    if (direct) {
      direct.voiceDc = voiceDc;
    }

    voiceDc.onmessage = (ev) => {
      if (!this.inVoice || !this.wasm) return;
      const data = ev.data;
      let bytes = null;
      if (Buffer.isBuffer(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      }
      if (!bytes || bytes.byteLength === 0) return;
      const decoded = this.wasm.openVoicePacket(peerId, bytes);
      if (decoded && decoded.pcm && decoded.pcm.length > 0) {
        this.emit("voiceAudio", { peerId, rms: decoded.rms, pcm: decoded.pcm });
      }
    };
    voiceDc.onclose = () => {
      if (this.voiceChannels.get(peerId) === voiceDc) {
        this.voiceChannels.delete(peerId);
      }
    };
  }

  _attachDataChannel(pc, dc, peerId, authorName, peerPubKey, viaAutoMesh, introducedBy) {
    const peerEntry = {
      pc,
      dc,
      voiceDc: this.voiceChannels.get(peerId) || null,
      authorName,
      lastActivityMs: Date.now(),
      superseded: false,
    };

    let opened = false;
    let closed = false;

    const handleOpen = () => {
      if (opened || closed || !this.wasm) return;
      opened = true;
      peerEntry.lastActivityMs = Date.now();

      const prev = this.directPeers.get(peerId);
      if (prev && prev !== peerEntry) {
        prev.superseded = true;
        try {
          prev.dc?.close();
          prev.pc?.close();
        } catch {
          // ignore
        }
      }

      this.directPeers.set(peerId, peerEntry);
      this.roomDialing.delete(peerId);
      this.relayPeers.delete(peerId);

      const res = this.wasm.call({
        cmd: "peer_connected",
        peerId,
        authorName,
        peerPubKey,
        viaAutoMesh: Boolean(viaAutoMesh),
        introducedBy: introducedBy || undefined,
      });
      this.status = res.status;
      this._executeActions(res.actions);
      this._reconcilePeers();
    };

    const handleClose = () => {
      if (closed) return;
      closed = true;
      if (peerEntry.superseded) return;
      if (this.directPeers.get(peerId) === peerEntry) {
        this.directPeers.delete(peerId);
      }
      if (this.voiceChannels.get(peerId) === peerEntry.voiceDc) {
        this.voiceChannels.delete(peerId);
      }
      if (this.wasm) {
        try {
          const res = this.wasm.call({ cmd: "peer_disconnected", peerId });
          this.status = res.status;
          this._executeActions(res.actions);
        } catch {
          // ignore
        }
      }
      this._reconcilePeers();
    };

    dc.onmessage = (ev) => {
      if (!this.wasm || closed || peerEntry.superseded) return;
      peerEntry.lastActivityMs = Date.now();
      const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
      try {
        const res = this.wasm.call({
          cmd: "wire_message",
          fromPeer: peerId,
          frame: raw,
          nowMs: Date.now(),
        });
        this.status = res.status;
        this._executeActions(res.actions);
        this._reconcilePeers();
      } catch (err) {
        this.emit("error", err);
      }
    };

    dc.onclose = handleClose;
    dc.onerror = handleClose;
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "closed") {
        handleClose();
      }
    };

    if (dc.readyState === "open") {
      handleOpen();
    } else {
      dc.onopen = handleOpen;
    }
  }

  _executeActions(actions) {
    if (!Array.isArray(actions)) return;
    let logChanged = false;
    const deletedIds = [];

    for (const act of actions) {
      switch (act.action) {
        case "send_wire": {
          const peer = this.directPeers.get(act.peerId);
          if (peer && peer.dc && peer.dc.readyState === "open") {
            try {
              peer.dc.send(act.frame);
            } catch {
              // ignore transient send errors
            }
          }
          break;
        }
        case "log_updated": {
          logChanged = true;
          if (Array.isArray(act.deletedIds)) {
            deletedIds.push(...act.deletedIds);
          }
          break;
        }
        case "bot_action": {
          this.emit("interaction", {
            mode: "action",
            actionUid: act.actionUid,
            from: act.fromPeerId,
            fromName: act.fromName,
            messageId: act.messageId,
            actionId: act.actionId,
            label: act.label,
            value: act.value,
            ts: act.ts,
          });
          break;
        }
        case "auto_mesh_create_offer": {
          this._startRelayedOffer(
            act.targetPeerId,
            act.targetName,
            act.targetPubKey,
            act.viaPeerId
          );
          break;
        }
        case "auto_mesh_accept_offer": {
          this._acceptRelayedOffer(
            act.fromPeerId,
            act.fromName,
            act.fromPubKey,
            act.viaPeerId,
            act.sdp
          );
          break;
        }
        case "auto_mesh_apply_answer": {
          this._applyRelayedAnswer(act.fromPeerId, act.sdp);
          break;
        }
        case "auto_mesh_add_ice": {
          this._applyRelayedIce(act.fromPeerId, act.candidate);
          break;
        }
        default:
          break;
      }
    }

    if (logChanged) {
      this._reconcileLog(deletedIds);
    }
  }

  _reconcileLog(explicitDeletedIds = []) {
    if (!this.wasm) return;
    const state = this.wasm.call({ cmd: "get_state" });
    this.status = state.status;
    const messages = state.log || [];
    const liveIds = new Set(messages.map((m) => m.id));

    for (const delId of explicitDeletedIds) {
      if (this.knownMessages.has(delId)) {
        this.knownMessages.delete(delId);
        this.emit("messageDelete", { targetId: delId });
      }
    }
    for (const oldId of Array.from(this.knownMessages.keys())) {
      if (!liveIds.has(oldId)) {
        this.knownMessages.delete(oldId);
        this.emit("messageDelete", { targetId: oldId });
      }
    }

    for (const m of messages) {
      const rev = m.updatedLamport || 0;
      const prev = this.knownMessages.get(m.id);
      if (!prev) {
        this.knownMessages.set(m.id, { msg: m, rev });
        if (m.author !== this.peerId) {
          this.emit("message", m);
          // Also fire `interaction` for quick-reply buttons targeting this bot
          if (
            m.type === "chat" &&
            m.payload &&
            m.payload.replyTo &&
            (!m.payload.replyTo.botPeerId || m.payload.replyTo.botPeerId === this.peerId)
          ) {
            this.emit("interaction", {
              mode: "reply",
              from: m.author,
              fromName: m.authorName,
              messageId: m.payload.replyTo.messageId || "",
              actionId: m.payload.replyTo.actionId || "",
              label: m.payload.replyTo.label || m.payload.text || "",
              value: m.payload.replyTo.value ?? null,
              text: m.payload.text || "",
              replyMessageId: m.id,
              ts: m.ts,
            });
          }
        }
      } else if (prev.rev !== rev) {
        this.knownMessages.set(m.id, { msg: m, rev });
        if (m.author !== this.peerId) {
          this.emit("messageUpdate", m);
        }
      }
    }
  }

  _reconcilePeers() {
    if (!this.status) return;
    const currentMap = new Map((this.status.peers || []).map((p) => [p.peerId, p]));

    for (const [pid, prev] of this.knownPeers.entries()) {
      if (!currentMap.has(pid)) {
        this.knownPeers.delete(pid);
        if (prev.inVoice) {
          this.emit("voiceState", {
            peerId: pid,
            authorName: prev.authorName,
            inVoice: false,
            muted: false,
            isBot: prev.isBot,
          });
        }
        this.emit("peerLeave", { peerId: pid, authorName: prev.authorName, isBot: prev.isBot });
      }
    }

    for (const [pid, p] of currentMap.entries()) {
      const prev = this.knownPeers.get(pid);
      const next = {
        authorName: p.authorName,
        inVoice: Boolean(p.inVoice),
        voiceMuted: Boolean(p.voiceMuted),
        isBot: Boolean(p.isBot),
      };
      this.knownPeers.set(pid, next);
      if (!prev) {
        this.emit("peerJoin", { peerId: pid, ...next });
        if (next.inVoice) {
          this.emit("voiceState", { peerId: pid, ...next });
        }
      } else if (prev.inVoice !== next.inVoice || prev.voiceMuted !== next.voiceMuted) {
        this.emit("voiceState", { peerId: pid, ...next });
      }
    }
  }

  _onKeepaliveTick() {
    if (!this.wasm || !this.connected) return;
    this.keepaliveTicks += 1;
    const now = Date.now();

    try {
      const pingRes = this.wasm.call({ cmd: "keepalive_ping", nowMs: now });
      this.status = pingRes.status;
      this._executeActions(pingRes.actions);

      const tickRes = this.wasm.call({
        cmd: "tick",
        nowMs: now,
        runSync: this.keepaliveTicks % 3 === 0,
      });
      this.status = tickRes.status;
      this._executeActions(tickRes.actions);
    } catch {
      // ignore transient tick errors
    }

    // Expire stale room dials > 15s
    for (const [pid, entry] of this.roomDialing.entries()) {
      if (now - entry.startedAt > 15_000) {
        try {
          entry.pc?.close();
        } catch {
          // ignore
        }
        this.roomDialing.delete(pid);
      }
    }

    // Periodic encrypted presence hello over MQTT rendezvous
    const helloEvery = this.directPeers.size === 0 ? 2 : 6;
    if (this.keepaliveTicks % helloEvery === 0) {
      this._announceRoomHello(this.directPeers.size === 0);
    }
  }
}

export default P2PBot;

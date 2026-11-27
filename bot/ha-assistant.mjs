#!/usr/bin/env node
/**
 * Home Assistant Voice Assistant Bot for p2p-direct (`voice.dequ.org`).
 *
 * Bridges any end-to-end encrypted p2p-direct voice room to Home Assistant:
 *   - Wyoming Voice Satellite server (port 10700): native wake-word detection, button-triggered
 *     STT listening, LLM / Assist Q&A, smart-home entity control, TTS playback, announcements,
 *     and first-class Home Assistant voice timers.
 *   - Home Assistant Helper Watcher: paste any `voice.dequ.org/#room=...` link into an HA
 *     `input_text` helper (default `input_text.p2p_voice_room_link`) and the bot joins
 *     automatically; clear it to disconnect.
 *   - Tiny Flat Metro Control Panel Web UI (port 8787, Ingress-compatible): paste room links,
 *     trigger Listen Now, toggle Wake Word / Mute, view live timers & transcripts.
 *
 * Works both standalone (Proxmox / Docker / Node 22+) and inside a Home Assistant App (Add-on)
 * using `SUPERVISOR_TOKEN` automatically.
 */

import http from "node:http";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { P2PBot, VOICE_SAMPLE_RATE } from "./sdk.mjs";
import { WyomingSatelliteServer } from "./wyoming.mjs";

export function parseHaCliArgs(argv) {
  const env = process.env;
  const isSupervisor = Boolean(env.SUPERVISOR_TOKEN && !env.HA_URL);
  const args = {
    room: env.P2P_ROOM || "",
    passphrase: env.P2P_PASSPHRASE || "",
    name: env.P2P_BOT_NAME || "Home Assistant",
    relay: env.P2P_RELAY || "",
    wyomingHost: env.WYOMING_HOST || "0.0.0.0",
    wyomingPort: Number(env.WYOMING_PORT || 10700),
    wyomingName: env.WYOMING_NAME || "p2p-direct-voice",
    wyomingArea: env.WYOMING_AREA || "Voice Room",
    uiHost: env.UI_HOST || "0.0.0.0",
    uiPort: Number(env.UI_PORT || 8787),
    haUrl: env.HA_URL || (isSupervisor ? "http://supervisor/core" : ""),
    haToken: env.HA_TOKEN || env.SUPERVISOR_TOKEN || "",
    roomHelper: env.HA_ROOM_HELPER || "input_text.p2p_voice_room_link",
    passphraseHelper: env.HA_PASSPHRASE_HELPER || "input_text.p2p_voice_room_passphrase",
    wakeWordEnabled: env.WAKE_WORD_ENABLED !== "0",
    allowedSpeakers: env.ALLOWED_SPEAKERS
      ? env.ALLOWED_SPEAKERS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const next = argv[i + 1];
    if ((f === "--room" || f === "-r") && next) { args.room = next; i++; }
    else if ((f === "--passphrase" || f === "-p") && next) { args.passphrase = next; i++; }
    else if ((f === "--name" || f === "-n") && next) { args.name = next; i++; }
    else if (f === "--relay" && next) { args.relay = next; i++; }
    else if (f === "--wyoming-host" && next) { args.wyomingHost = next; i++; }
    else if (f === "--wyoming-port" && next) { args.wyomingPort = Number(next); i++; }
    else if (f === "--wyoming-name" && next) { args.wyomingName = next; i++; }
    else if (f === "--area" && next) { args.wyomingArea = next; i++; }
    else if (f === "--ui-host" && next) { args.uiHost = next; i++; }
    else if (f === "--ui-port" && next) { args.uiPort = Number(next); i++; }
    else if (f === "--ha-url" && next) { args.haUrl = next; i++; }
    else if (f === "--ha-token" && next) { args.haToken = next; i++; }
    else if (f === "--room-helper" && next) { args.roomHelper = next; i++; }
    else if (f === "--passphrase-helper" && next) { args.passphraseHelper = next; i++; }
    else if (f === "--no-wake-word") { args.wakeWordEnabled = false; }
    else if (f === "--allowed-speakers" && next) {
      args.allowedSpeakers = next.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (f === "--help" || f === "-h") {
      args.help = true;
    }
  }
  return args;
}

/**
 * Lightweight Home Assistant WebSocket API client for watching room-link helpers
 * and running text conversation queries (`conversation/process`).
 */
export class HomeAssistantWsClient extends EventEmitter {
  constructor({ haUrl = "", haToken = "", roomHelper = "", passphraseHelper = "" } = {}) {
    super();
    this.haUrl = String(haUrl || "").replace(/\/+$/, "");
    this.haToken = String(haToken || "").trim();
    this.roomHelper = String(roomHelper || "").trim();
    this.passphraseHelper = String(passphraseHelper || "").trim();

    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.nextId = 1;
    this.pending = new Map();
    this.reconnectTimer = null;
    this.stopped = false;
    this.helperRoomLink = "";
    this.helperPassphrase = "";
    this.lastError = "";
  }

  isConfigured() {
    return Boolean(this.haUrl && this.haToken);
  }

  _buildWsUrl() {
    if (/^wss?:\/\//i.test(this.haUrl)) {
      return this.haUrl.endsWith("/api/websocket") || this.haUrl.endsWith("/websocket")
        ? this.haUrl
        : `${this.haUrl}/api/websocket`;
    }
    const base = this.haUrl.replace(/^http/i, "ws");
    if (base.endsWith("/core")) {
      // HA Supervisor internal core proxy uses ws://supervisor/core/websocket
      return `${base}/websocket`;
    }
    return `${base}/api/websocket`;
  }

  start() {
    if (!this.isConfigured()) return false;
    this.stopped = false;
    this._connect();
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    for (const { reject } of this.pending.values()) {
      reject(new Error("Home Assistant client stopped"));
    }
    this.pending.clear();
  }

  _connect() {
    if (this.stopped || !this.isConfigured()) return;
    const wsUrl = this._buildWsUrl();
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.lastError = "";
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      this._handleMessage(msg);
    });

    ws.on("error", (err) => {
      this.lastError = err?.message || String(err);
      this.emit("status", this.getStatus());
    });

    ws.on("close", () => {
      this.connected = false;
      this.authenticated = false;
      this.ws = null;
      this.emit("status", this.getStatus());
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this._connect();
        }, 5000);
      }
    });
  }

  _handleMessage(msg) {
    if (msg.type === "auth_required") {
      this.ws?.send(JSON.stringify({ type: "auth", access_token: this.haToken }));
      return;
    }
    if (msg.type === "auth_invalid") {
      this.lastError = msg.message || "Home Assistant auth_invalid";
      this.authenticated = false;
      this.emit("status", this.getStatus());
      return;
    }
    if (msg.type === "auth_ok") {
      this.authenticated = true;
      this.lastError = "";
      this.emit("status", this.getStatus());
      this._bootstrapHelpers().catch((err) => {
        this.lastError = err?.message || String(err);
        this.emit("status", this.getStatus());
      });
      return;
    }
    if (msg.type === "result" && msg.id != null) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        if (msg.success) waiter.resolve(msg.result);
        else waiter.reject(new Error(msg.error?.message || "HA WS call failed"));
      }
      return;
    }
    if (msg.type === "event" && msg.event?.event_type === "state_changed") {
      const d = msg.event.data || {};
      const entityId = d.entity_id;
      const newVal = String(d.new_state?.state ?? "").trim();
      const cleaned = /^(unknown|unavailable|none|off)$/i.test(newVal) ? "" : newVal;
      if (entityId === this.roomHelper) {
        if (cleaned !== this.helperRoomLink) {
          this.helperRoomLink = cleaned;
          this.emit("roomHelperChanged", {
            roomLink: this.helperRoomLink,
            passphrase: this.helperPassphrase,
          });
        }
      } else if (this.passphraseHelper && entityId === this.passphraseHelper) {
        if (cleaned !== this.helperPassphrase) {
          this.helperPassphrase = cleaned;
          if (this.helperRoomLink) {
            this.emit("roomHelperChanged", {
              roomLink: this.helperRoomLink,
              passphrase: this.helperPassphrase,
            });
          }
        }
      }
    }
  }

  call(type, extra = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.authenticated || this.ws.readyState !== 1) {
        reject(new Error("Home Assistant WebSocket not connected"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type, ...extra }));
    });
  }

  async _bootstrapHelpers() {
    if (!this.roomHelper && !this.passphraseHelper) return;
    await this.call("subscribe_events", { event_type: "state_changed" });
    const states = await this.call("get_states");
    if (Array.isArray(states)) {
      for (const st of states) {
        const val = String(st.state ?? "").trim();
        const cleaned = /^(unknown|unavailable|none|off)$/i.test(val) ? "" : val;
        if (st.entity_id === this.roomHelper) {
          this.helperRoomLink = cleaned;
        } else if (this.passphraseHelper && st.entity_id === this.passphraseHelper) {
          this.helperPassphrase = cleaned;
        }
      }
      if (this.helperRoomLink) {
        this.emit("roomHelperChanged", {
          roomLink: this.helperRoomLink,
          passphrase: this.helperPassphrase,
        });
      }
    }
  }

  async askConversation(text, { conversationId = null } = {}) {
    const payload = { text: String(text || "").trim() };
    if (conversationId) payload.conversation_id = conversationId;
    const res = await this.call("conversation/process", payload);
    const speech =
      res?.response?.speech?.plain?.speech ||
      res?.response?.speech?.ssml?.speech ||
      "";
    return {
      text: String(speech || "").trim(),
      conversationId: res?.conversation_id || conversationId || null,
      responseType: res?.response?.response_type || "",
    };
  }

  async setRoomHelperValue(roomLink) {
    if (!this.authenticated || !this.roomHelper) return false;
    await this.call("call_service", {
      domain: "input_text",
      service: "set_value",
      service_data: {
        entity_id: this.roomHelper,
        value: String(roomLink || "").slice(0, 255),
      },
    });
    return true;
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      connected: this.connected,
      authenticated: this.authenticated,
      roomHelper: this.roomHelper,
      passphraseHelper: this.passphraseHelper,
      helperRoomLink: this.helperRoomLink,
      error: this.lastError,
    };
  }
}

/**
 * Orchestrates P2PBot + VoiceRoomMixer + WyomingSatelliteServer + HomeAssistantWsClient
 * + Tiny Flat Metro Control Panel UI.
 */
export class HomeAssistantVoiceAssistant extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      name: options.name || "Home Assistant",
      relay: options.relay || "",
      wyomingHost: options.wyomingHost || "0.0.0.0",
      wyomingPort: Number(options.wyomingPort ?? 10700),
      wyomingName: options.wyomingName || "p2p-direct-voice",
      wyomingArea: options.wyomingArea || "Voice Room",
      uiHost: options.uiHost || "0.0.0.0",
      uiPort: Number(options.uiPort ?? 8787),
      haUrl: options.haUrl || "",
      haToken: options.haToken || "",
      roomHelper: options.roomHelper || "input_text.p2p_voice_room_link",
      passphraseHelper: options.passphraseHelper || "input_text.p2p_voice_room_passphrase",
      wakeWordEnabled: options.wakeWordEnabled !== false,
      allowedSpeakers: Array.isArray(options.allowedSpeakers) ? options.allowedSpeakers : [],
      wasmPath: options.wasmPath,
    };

    this.bot = null;
    this.mixer = null;
    this.currentRoomLink = "";
    this.currentPassphrase = "";
    this.roomState = "disconnected"; // disconnected | connecting | connected | error
    this.roomError = "";
    this.controlMsgId = null;

    this.wakeWordEnabled = this.options.wakeWordEnabled;
    this.muted = false;
    this.activeTimers = new Map(); // id -> { id, name, totalSeconds, endsAtMs, paused, remainingSec, commandText }
    this.recentLog = []; // [{ ts, kind, speaker, text }]
    this.lastTranscript = "";
    this.lastReply = "";
    this.lastSpeaker = "";
    this.conversationId = null;
    this._awaitingAudioDoneForWyoming = false;

    this.wyoming = new WyomingSatelliteServer({
      host: this.options.wyomingHost,
      port: this.options.wyomingPort,
      name: this.options.wyomingName,
      area: this.options.wyomingArea,
      wakeWordEnabled: this.wakeWordEnabled,
    });
    this._wireWyomingEvents();

    this.haClient = new HomeAssistantWsClient({
      haUrl: this.options.haUrl,
      haToken: this.options.haToken,
      roomHelper: this.options.roomHelper,
      passphraseHelper: this.options.passphraseHelper,
    });
    this.haClient.on("roomHelperChanged", ({ roomLink, passphrase }) => {
      if (roomLink) {
        if (roomLink !== this.currentRoomLink || passphrase !== this.currentPassphrase) {
          this.connectRoom(roomLink, passphrase).catch((err) => {
            this._pushLog("error", "HA Helper", err.message);
          });
        }
      } else if (this.currentRoomLink) {
        this.disconnectRoom().catch(() => {});
      }
    });

    this.uiServer = null;
  }

  async start({ initialRoom = "", initialPassphrase = "" } = {}) {
    const wyInfo = await this.wyoming.start();
    const uiInfo = await this._startUiServer();
    if (this.haClient.isConfigured()) {
      this.haClient.start();
    }
    if (initialRoom) {
      await this.connectRoom(initialRoom, initialPassphrase);
    }
    return { wyoming: wyInfo, ui: uiInfo };
  }

  async stop() {
    this.haClient.stop();
    await this.disconnectRoom();
    await this.wyoming.stop();
    if (this.uiServer) {
      const srv = this.uiServer;
      this.uiServer = null;
      await new Promise((resolve) => srv.close(() => resolve()));
    }
  }

  async connectRoom(roomLink, passphrase = "") {
    const cleanLink = String(roomLink || "").trim();
    if (!cleanLink) throw new Error("Room link is required");
    await this.disconnectRoom();

    this.roomState = "connecting";
    this.roomError = "";
    this.currentRoomLink = cleanLink;
    this.currentPassphrase = String(passphrase || "");

    const bot = new P2PBot({
      roomLink: cleanLink,
      passphrase: this.currentPassphrase,
      name: this.options.name,
      relay: this.options.relay || undefined,
      wasmPath: this.options.wasmPath,
    });
    this.bot = bot;

    bot.on("message", (msg) => this._onRoomMessage(msg));
    bot.on("interaction", (ev) => this._onRoomInteraction(ev));
    bot.on("peerJoin", () => this.syncChatCard(false));
    bot.on("peerLeave", () => this.syncChatCard(false));
    bot.on("voiceState", () => this.syncChatCard(false));
    bot.on("audioEnd", () => {
      if (this._awaitingAudioDoneForWyoming) {
        this._awaitingAudioDoneForWyoming = false;
        this.wyoming.notifyAudioPlayed();
      }
      this.syncChatCard(false);
    });

    try {
      const ready = await bot.connect();
      this.roomState = "connected";
      bot.joinVoice({ muted: this.muted });

      this.mixer = bot.createVoiceMixer({
        echoSuppression: true,
        echoTailMs: 350,
        allowedSpeakers: this.options.allowedSpeakers,
      });
      this.mixer.on("frame", (frame) => {
        if (!this.muted && this.wyoming.streamingToHa) {
          this.wyoming.sendAudioChunk(frame.buffer);
        }
      });
      this.mixer.start();

      this._pushLog("system", "Room", `Connected to "${ready.room}"`);
      this.syncChatCard(true);
      return ready;
    } catch (err) {
      this.roomState = "error";
      this.roomError = err?.message || String(err);
      try {
        await bot.disconnect();
      } catch {
        // ignore
      }
      if (this.bot === bot) this.bot = null;
      this._pushLog("error", "Room", this.roomError);
      throw err;
    }
  }

  async disconnectRoom() {
    this._awaitingAudioDoneForWyoming = false;
    this.controlMsgId = null;
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
    this.currentRoomLink = "";
    this.currentPassphrase = "";
    this.roomState = "disconnected";
    this.roomError = "";
  }

  triggerListenNow({ speakerPeerId = null, speakerName = "" } = {}) {
    if (!this.wyoming.isReady()) {
      return { ok: false, error: "Home Assistant Wyoming Satellite is not connected yet" };
    }
    if (this.muted) {
      this.setMuted(false);
    }
    if (this.mixer) {
      if (speakerPeerId) this.mixer.lockSpeaker(speakerPeerId);
      else this.mixer.unlockSpeaker();
    }
    if (speakerName) this.lastSpeaker = speakerName;
    if (this.bot) {
      this.bot.playChime("awake");
    }
    const started = this.wyoming.triggerListenNow({ wakeWordName: "button" });
    this._pushLog("action", speakerName || "Button", "Listening now...");
    this.syncChatCard(true);
    return { ok: started };
  }

  setWakeWordEnabled(enabled) {
    this.wakeWordEnabled = Boolean(enabled);
    this.wyoming.setWakeWordEnabled(this.wakeWordEnabled);
    this.syncChatCard(false);
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.bot && this.bot.inVoice) {
      this.bot.setVoiceMuted(this.muted);
    }
    this.syncChatCard(false);
  }

  stopAudio() {
    if (this.bot) {
      this.bot.stopAudio();
    }
    if (this._awaitingAudioDoneForWyoming) {
      this._awaitingAudioDoneForWyoming = false;
      this.wyoming.notifyAudioPlayed();
    }
    this.syncChatCard(false);
  }

  async askText(question, { speakerName = "User" } = {}) {
    const clean = String(question || "").trim();
    if (!clean) throw new Error("Question is empty");
    this.lastSpeaker = speakerName;
    this.lastTranscript = clean;
    this._pushLog("user", speakerName, clean);
    this.syncChatCard(true);

    if (!this.haClient.authenticated) {
      this.lastReply = "Home Assistant WebSocket API is not configured — use voice or set HA_URL/HA_TOKEN.";
      this.syncChatCard(true);
      return { text: this.lastReply };
    }
    const res = await this.haClient.askConversation(clean, {
      conversationId: this.conversationId,
    });
    this.conversationId = res.conversationId;
    this.lastReply = res.text || "Done.";
    this._pushLog("assistant", "Home Assistant", this.lastReply);
    this.syncChatCard(true);
    return res;
  }

  _wireWyomingEvents() {
    this.wyoming.on("haConnected", () => {
      this._pushLog("system", "Wyoming", "Home Assistant connected");
      this.syncChatCard(false);
    });
    this.wyoming.on("haDisconnected", () => {
      this._pushLog("system", "Wyoming", "Home Assistant disconnected");
      this.syncChatCard(false);
    });
    this.wyoming.on("stateChange", () => {
      this.syncChatCard(false);
    });
    this.wyoming.on("wakeDetected", ({ name }) => {
      if (this.mixer) {
        this.mixer.lockToLastActiveSpeaker(2500);
        this.lastSpeaker = this.mixer.lastActivePeerName || this.lastSpeaker;
      }
      if (this.bot && !this.muted) {
        this.bot.playChime("awake");
      }
      this._pushLog("wake", this.lastSpeaker || "Voice", `Wake word detected (${name})`);
      this.syncChatCard(true);
    });
    this.wyoming.on("continueConversation", () => {
      if (this.bot && !this.muted) {
        this.bot.playChime("awake");
      }
      this.syncChatCard(false);
    });
    this.wyoming.on("transcript", ({ text }) => {
      if (this.mixer) this.mixer.unlockSpeaker();
      this.lastTranscript = text;
      if (text) {
        this._pushLog("user", this.lastSpeaker || "Voice", text);
      }
      this.syncChatCard(true);
    });
    this.wyoming.on("handled", ({ text }) => {
      if (text) {
        this.lastReply = text;
        this._pushLog("assistant", "Home Assistant", text);
      }
      this.syncChatCard(true);
    });
    this.wyoming.on("ttsStart", () => {
      if (this.mixer) this.mixer.unlockSpeaker();
      if (this.bot) {
        this.bot.stopAudio();
      }
      this._awaitingAudioDoneForWyoming = true;
    });
    this.wyoming.on("ttsAudio", ({ buffer, rate, channels }) => {
      if (this.bot && !this.muted && buffer && buffer.length > 0) {
        this.bot.pushPcmBytes(buffer, { sampleRate: rate || VOICE_SAMPLE_RATE, channels: channels || 1 });
      }
    });
    this.wyoming.on("ttsStop", () => {
      if (this.bot && this.bot.isPlayingAudio()) {
        this.bot.markAudioStreamEnd();
      } else if (this._awaitingAudioDoneForWyoming) {
        this._awaitingAudioDoneForWyoming = false;
        this.wyoming.notifyAudioPlayed();
      }
    });
    this.wyoming.on("timerStarted", (t) => {
      const endsAtMs = Date.now() + t.totalSeconds * 1000;
      this.activeTimers.set(t.id, {
        id: t.id,
        name: t.name || t.commandText || "Timer",
        totalSeconds: t.totalSeconds,
        endsAtMs,
        paused: false,
        remainingSec: t.totalSeconds,
        commandText: t.commandText || "",
      });
      this._pushLog("timer", "Timer", `Started "${t.name || "Timer"}" (${t.totalSeconds}s)`);
      this.syncChatCard(true);
    });
    this.wyoming.on("timerUpdated", (t) => {
      const prev = this.activeTimers.get(t.id);
      if (!prev) return;
      prev.paused = !t.isActive;
      prev.remainingSec = t.totalSeconds;
      if (t.isActive) {
        prev.endsAtMs = Date.now() + t.totalSeconds * 1000;
      }
      this.syncChatCard(true);
    });
    this.wyoming.on("timerCancelled", ({ id }) => {
      const prev = this.activeTimers.get(id);
      this.activeTimers.delete(id);
      if (prev) {
        this._pushLog("timer", "Timer", `Cancelled "${prev.name}"`);
      }
      this.syncChatCard(false);
    });
    this.wyoming.on("timerFinished", ({ id }) => {
      const prev = this.activeTimers.get(id);
      this.activeTimers.delete(id);
      const label = prev?.name || "Timer";
      this._pushLog("timer", "Timer", `Finished "${label}"`);
      if (this.bot && !this.muted) {
        this.bot.playChime("timer", { amplitude: 0.3 });
      }
      this.lastReply = `Timer finished: ${label}`;
      this.syncChatCard(true);
    });
    this.wyoming.on("pipelineError", ({ code, text }) => {
      if (this.mixer) this.mixer.unlockSpeaker();
      if (code !== "stt-no-text-recognized") {
        this._pushLog("error", "Assist", `${code}: ${text || "Pipeline error"}`);
        if (this.bot && !this.muted) {
          this.bot.playChime("error");
        }
      }
      this.syncChatCard(false);
    });
  }

  _onRoomMessage(msg) {
    if (msg.type !== "chat" || typeof msg.payload?.text !== "string") return;
    const raw = msg.payload.text.trim();
    const lower = raw.toLowerCase();
    if (lower === "!ha" || lower === "!assist") {
      this.controlMsgId = null;
      this.syncChatCard(true);
    } else if (lower === "!listen" || lower === "!ask") {
      this.triggerListenNow({ speakerPeerId: msg.author, speakerName: msg.authorName });
    } else if (lower.startsWith("!ha ") || lower.startsWith("!assist ")) {
      const q = raw.replace(/^!(ha|assist)\s+/i, "").trim();
      if (q) {
        this.askText(q, { speakerName: msg.authorName }).catch((err) => {
          this._pushLog("error", "Assist", err.message);
        });
      }
    }
  }

  _onRoomInteraction(ev) {
    if (ev.mode !== "action") return;
    const id = String(ev.actionId || "");
    if (id === "ha:listen") {
      this.triggerListenNow({ speakerPeerId: ev.from, speakerName: ev.fromName });
    } else if (id === "ha:toggle_wake") {
      this.setWakeWordEnabled(!this.wakeWordEnabled);
    } else if (id === "ha:toggle_mute") {
      this.setMuted(!this.muted);
    } else if (id === "ha:stop_audio") {
      this.stopAudio();
    } else if (id === "ha:ask_input") {
      const q = String(ev.value || "").trim();
      if (q) {
        this.askText(q, { speakerName: ev.fromName }).catch((err) => {
          this._pushLog("error", "Assist", err.message);
        });
      }
    } else if (id.startsWith("ha:timer:dismiss:")) {
      const tid = id.slice("ha:timer:dismiss:".length);
      this.activeTimers.delete(tid);
      this.syncChatCard(false);
    } else if (id === "ha:refresh") {
      this.syncChatCard(true);
    } else if (id === "ha:disconnect") {
      this.disconnectRoom().catch(() => {});
    }
  }

  buildChatCard() {
    const wyConnected = this.wyoming.isReady();
    const mode = this.wyoming.pipelineMode;
    let badge = "WAITING HA";
    let color = "ochre";
    if (!wyConnected) {
      badge = "WAITING HA";
      color = "ochre";
    } else if (this.muted) {
      badge = "MUTED";
      color = "coral";
    } else if (mode === "asr") {
      badge = "LISTENING";
      color = "mint";
    } else if (mode === "processing") {
      badge = "THINKING";
      color = "cyan";
    } else if (mode === "speaking") {
      badge = "SPEAKING";
      color = "cobalt";
    } else if (mode === "wake") {
      badge = "WAKE READY";
      color = "cobalt";
    } else {
      badge = "BUTTON READY";
      color = "ink";
    }

    const voicePeers = this.bot
      ? this.bot.getPeers().filter((p) => p.inVoice).length
      : 0;

    const blocks = [
      {
        type: "stats",
        items: [
          { label: "Satellite", value: wyConnected ? "Online" : "Offline", accent: wyConnected ? "mint" : "coral" },
          { label: "Wake Word", value: this.wakeWordEnabled ? "Active" : "Off", accent: this.wakeWordEnabled ? "cobalt" : "ink" },
          { label: "Timers", value: String(this.activeTimers.size), accent: this.activeTimers.size > 0 ? "ochre" : "ink" },
          { label: "In Voice", value: String(voicePeers), accent: "cyan" },
        ],
      },
    ];

    for (const timer of this.activeTimers.values()) {
      blocks.push({
        type: "timer",
        label: timer.name,
        icon: "timer",
        totalSec: timer.totalSeconds,
        endsAtMs: timer.endsAtMs,
        paused: timer.paused,
        remainingSec: timer.remainingSec,
        color: timer.paused ? "ochre" : "cobalt",
        actionId: `ha:timer:dismiss:${timer.id}`,
      });
    }

    if (this.lastTranscript || this.lastReply) {
      const lines = [];
      if (this.lastTranscript) {
        lines.push(`**${this.lastSpeaker || "Voice"}:** ${this.lastTranscript}`);
      }
      if (this.lastReply) {
        lines.push(`**Assist:** ${this.lastReply}`);
      }
      blocks.push({
        type: "callout",
        tone: "info",
        icon: "mic",
        title: "Last Exchange",
        text: lines.join("\n"),
      });
    }

    if (this.haClient.authenticated) {
      blocks.push({
        type: "input",
        id: "ha:ask_input",
        actionId: "ha:ask_input",
        placeholder: "Ask Home Assistant (entities, timers, questions)...",
        submitLabel: "Ask",
      });
    }

    return {
      subtitle: "HOME ASSISTANT VOICE",
      title: this.options.name,
      icon: "home",
      badge,
      color,
      blocks,
      buttons: [
        {
          kind: "grid",
          buttons: [
            { id: "ha:listen", label: "Listen Now", icon: "mic", style: "primary", disabled: !wyConnected },
            {
              id: "ha:toggle_wake",
              label: this.wakeWordEnabled ? "Wake: On" : "Wake: Off",
              icon: "bolt",
              style: this.wakeWordEnabled ? "success" : "secondary",
            },
            {
              id: "ha:toggle_mute",
              label: this.muted ? "Unmute" : "Mute",
              icon: this.muted ? "mic-off" : "volume",
              style: this.muted ? "warning" : "secondary",
            },
            { id: "ha:stop_audio", label: "Stop Audio", icon: "close", style: "secondary" },
          ],
        },
        {
          kind: "footer",
          buttons: [
            { id: "ha:refresh", label: "Refresh", icon: "refresh", style: "secondary" },
            { id: "ha:disconnect", label: "Disconnect", icon: "trash", style: "danger" },
          ],
        },
      ],
      footer: `Wyoming :${this.wyoming.port} · Say wake word or click Listen Now`,
    };
  }

  syncChatCard(createIfMissing = false) {
    if (!this.bot || this.roomState !== "connected") return;
    const card = this.buildChatCard();
    try {
      if (this.controlMsgId) {
        this.bot.updateBotMessage(this.controlMsgId, card);
      } else if (createIfMissing) {
        const sent = this.bot.sendBotMessage(card);
        this.controlMsgId = sent.id;
      }
    } catch {
      // ignore transient edit errors during disconnect
    }
  }

  getApiState() {
    const now = Date.now();
    const timers = Array.from(this.activeTimers.values()).map((t) => ({
      ...t,
      remainingSec: t.paused ? t.remainingSec : Math.max(0, Math.ceil((t.endsAtMs - now) / 1000)),
    }));
    return {
      roomState: this.roomState,
      roomError: this.roomError,
      roomName: this.bot?.activeRoom?.name || "",
      inVoice: Boolean(this.bot?.inVoice),
      muted: this.muted,
      wakeWordEnabled: this.wakeWordEnabled,
      peers: this.bot ? this.bot.getPeers() : [],
      wyoming: {
        host: this.wyoming.host,
        port: this.wyoming.port,
        name: this.wyoming.name,
        area: this.wyoming.area,
        connected: this.wyoming.isConnected(),
        ready: this.wyoming.isReady(),
        mode: this.wyoming.pipelineMode,
      },
      homeAssistant: this.haClient.getStatus(),
      timers,
      lastTranscript: this.lastTranscript,
      lastReply: this.lastReply,
      recentLog: this.recentLog.slice(-16),
    };
  }

  _pushLog(kind, speaker, text) {
    this.recentLog.push({
      ts: new Date().toISOString(),
      kind,
      speaker,
      text: String(text || ""),
    });
    if (this.recentLog.length > 40) {
      this.recentLog.shift();
    }
  }

  _startUiServer() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handleHttpRequest(req, res).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
        });
      });
      this.uiServer = server;
      server.once("error", reject);
      server.listen(this.options.uiPort, this.options.uiHost, () => {
        const addr = server.address();
        const port = addr && typeof addr === "object" ? addr.port : this.options.uiPort;
        resolve({ host: this.options.uiHost, port });
      });
    });
  }

  async _readJsonBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  }

  async _handleHttpRequest(req, res) {
    const urlPath = (req.url || "/").split("?")[0];
    const sendJson = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "GET" && (urlPath === "/" || urlPath === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderControlPanelHtml());
      return;
    }
    if (req.method === "GET" && urlPath.endsWith("/api/status")) {
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/connect")) {
      const body = await this._readJsonBody(req);
      const ready = await this.connectRoom(body.roomLink, body.passphrase || "");
      if (body.syncHelper && this.haClient.authenticated) {
        await this.haClient.setRoomHelperValue(body.roomLink).catch(() => {});
      }
      sendJson(200, { ok: true, ready, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/disconnect")) {
      await this.disconnectRoom();
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/listen")) {
      const out = this.triggerListenNow({ speakerName: "Control Panel" });
      sendJson(out.ok ? 200 : 409, { ...out, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/wake")) {
      const body = await this._readJsonBody(req);
      this.setWakeWordEnabled(Boolean(body.enabled));
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/mute")) {
      const body = await this._readJsonBody(req);
      this.setMuted(Boolean(body.muted));
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/stop-audio")) {
      this.stopAudio();
      sendJson(200, { ok: true, state: this.getApiState() });
      return;
    }
    if (req.method === "POST" && urlPath.endsWith("/api/ask")) {
      const body = await this._readJsonBody(req);
      const reply = await this.askText(body.text, { speakerName: "Control Panel" });
      sendJson(200, { ok: true, reply, state: this.getApiState() });
      return;
    }

    sendJson(404, { ok: false, error: "Not found" });
  }
}

function renderControlPanelHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>p2p-direct · Home Assistant Voice Control Panel</title>
<style>
  :root {
    --bg: #f6f5f0; --panel: #ffffff; --ink: #111111; --muted: #575757;
    --rule: #111111; --cobalt: #0057ff; --mint: #00a86b; --ochre: #e5a100; --coral: #e53935;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111214; --panel: #191b1f; --ink: #f4f4f0; --muted: #a0a4ad; --rule: #f4f4f0;
    }
  }
  * { box-sizing: border-box; border-radius: 0 !important; box-shadow: none !important; }
  body { margin: 0; padding: 18px; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; display: grid; gap: 14px; }
  .card { background: var(--panel); border: 2px solid var(--rule); border-left: 6px solid var(--cobalt); padding: 14px; display: grid; gap: 12px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 17px; letter-spacing: 0.04em; text-transform: uppercase; }
  .sub { font: 700 11px/1 monospace; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .badge { font: 700 11px/1 monospace; padding: 5px 8px; border: 2px solid var(--rule); text-transform: uppercase; }
  .badge.ok { background: var(--mint); color: #fff; }
  .badge.warn { background: var(--ochre); color: #111; }
  .badge.err { background: var(--coral); color: #fff; }
  .grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .stat { border: 1.5px solid var(--rule); padding: 8px; }
  .stat b { display: block; font: 700 10px/1 monospace; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
  .stat span { font: 700 13px/1.2 monospace; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
  .btns { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  input { width: 100%; padding: 9px 10px; border: 2px solid var(--rule); background: var(--bg); color: var(--ink); font: 13px monospace; }
  button { padding: 9px 12px; border: 2px solid var(--rule); background: var(--panel); color: var(--ink); font: 700 12px/1 monospace; text-transform: uppercase; cursor: pointer; }
  button.primary { background: var(--cobalt); color: #fff; }
  button.success { background: var(--mint); color: #fff; }
  button.danger { background: var(--coral); color: #fff; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .log { border: 1.5px solid var(--rule); padding: 8px; max-height: 200px; overflow: auto; font: 12px/1.5 monospace; background: var(--bg); }
  .timer { border: 1.5px solid var(--rule); padding: 8px; display: flex; justify-content: space-between; font: 700 12px monospace; }
  @media (max-width: 600px) { .grid4, .btns { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="head">
      <div>
        <div class="sub">p2p-direct · Home Assistant Voice Satellite</div>
        <h1>Room Voice Bridge</h1>
      </div>
      <div id="status-badge" class="badge warn">STANDBY</div>
    </div>
    <div class="grid4">
      <div class="stat"><b>Room</b><span id="st-room">—</span></div>
      <div class="stat"><b>Wyoming</b><span id="st-wy">—</span></div>
      <div class="stat"><b>Pipeline</b><span id="st-mode">idle</span></div>
      <div class="stat"><b>HA Helper</b><span id="st-ha">—</span></div>
    </div>
    <input id="room-link" placeholder="Paste https://voice.dequ.org/#room=P2P1:... link" />
    <div class="row">
      <input id="room-pass" type="password" placeholder="Optional room passphrase" />
      <div style="display:flex;gap:8px;">
        <button id="btn-connect" class="primary">Connect</button>
        <button id="btn-disconnect" class="danger">Leave</button>
      </div>
    </div>
    <div class="btns">
      <button id="btn-listen" class="success">Listen Now</button>
      <button id="btn-wake">Wake: On</button>
      <button id="btn-mute">Mute</button>
      <button id="btn-stop">Stop Audio</button>
    </div>
    <div class="row">
      <input id="ask-input" placeholder="Ask Home Assistant (text fallback)..." />
      <button id="btn-ask" class="primary">Ask</button>
    </div>
    <div id="timers"></div>
    <div id="log" class="log">Waiting for status...</div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let curState = null;

async function api(path, body) {
  const res = await fetch("./api/" + path, body !== undefined
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { method: "GET" });
  return res.json();
}

function render(s) {
  curState = s;
  const badge = $("status-badge");
  badge.textContent = (s.roomState || "standby").toUpperCase();
  badge.className = "badge " + (s.roomState === "connected" ? "ok" : s.roomState === "error" ? "err" : "warn");
  $("st-room").textContent = s.roomName || "Standby";
  $("st-wy").textContent = s.wyoming.ready ? "Online :" + s.wyoming.port : "Waiting :" + s.wyoming.port;
  $("st-mode").textContent = s.wyoming.mode || "idle";
  $("st-ha").textContent = s.homeAssistant.authenticated ? "Synced" : s.homeAssistant.configured ? "Connecting" : "Manual";
  $("btn-listen").disabled = !s.wyoming.ready;
  $("btn-wake").textContent = s.wakeWordEnabled ? "Wake: On" : "Wake: Off";
  $("btn-mute").textContent = s.muted ? "Unmute" : "Mute";
  $("timers").innerHTML = (s.timers || []).map((t) =>
    '<div class="timer"><span>' + t.name + '</span><span>' + t.remainingSec + 's' + (t.paused ? ' PAUSED' : '') + '</span></div>'
  ).join("");
  $("log").innerHTML = (s.recentLog || []).slice().reverse().map((e) =>
    '<div>[' + e.ts.slice(11, 19) + '] <b>' + e.speaker + '</b>: ' + e.text.replace(/</g, "&lt;") + '</div>'
  ).join("") || "No events yet.";
}

async function poll() {
  try {
    const out = await api("status");
    if (out.ok) render(out.state);
  } catch {}
}

$("btn-connect").onclick = async () => {
  const roomLink = $("room-link").value.trim();
  if (!roomLink) return;
  const out = await api("connect", { roomLink, passphrase: $("room-pass").value, syncHelper: true });
  if (out.state) render(out.state);
};
$("btn-disconnect").onclick = async () => {
  const out = await api("disconnect", {});
  if (out.state) render(out.state);
};
$("btn-listen").onclick = async () => {
  const out = await api("listen", {});
  if (out.state) render(out.state);
};
$("btn-wake").onclick = async () => {
  const out = await api("wake", { enabled: !(curState && curState.wakeWordEnabled) });
  if (out.state) render(out.state);
};
$("btn-mute").onclick = async () => {
  const out = await api("mute", { muted: !(curState && curState.muted) });
  if (out.state) render(out.state);
};
$("btn-stop").onclick = async () => {
  const out = await api("stop-audio", {});
  if (out.state) render(out.state);
};
$("btn-ask").onclick = async () => {
  const text = $("ask-input").value.trim();
  if (!text) return;
  $("ask-input").value = "";
  const out = await api("ask", { text });
  if (out.state) render(out.state);
};
poll();
setInterval(poll, 1500);
</script>
</body>
</html>`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = parseHaCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "p2p-direct Home Assistant Voice Assistant Bot (Wyoming Satellite + Helper Watcher + Control Panel)",
        "",
        "Usage:",
        '  node bot/ha-assistant.mjs [--room "<room-url>"] [--ha-url "http://homeassistant.local:8123"] [--ha-token "..."]',
        "",
        "Options / Env:",
        "  --room, -r           Optional initial room link (P2P_ROOM); omit to control via HA helper or Control Panel",
        "  --passphrase, -p     Optional room passphrase (P2P_PASSPHRASE)",
        "  --name, -n           Display name in room (P2P_BOT_NAME, default: Home Assistant)",
        "  --wyoming-port       Wyoming Satellite TCP port (WYOMING_PORT, default: 10700)",
        "  --area               HA Area name reported by satellite (WYOMING_AREA, default: Voice Room)",
        "  --ui-port            Tiny Control Panel HTTP port (UI_PORT, default: 8787)",
        "  --ha-url             Home Assistant base URL (HA_URL, auto-detected inside HA Apps)",
        "  --ha-token           Long-Lived Access Token (HA_TOKEN or auto SUPERVISOR_TOKEN)",
        "  --room-helper        HA input_text entity to watch (HA_ROOM_HELPER, default: input_text.p2p_voice_room_link)",
        "  --passphrase-helper  Optional HA input_text for room passphrase (HA_PASSPHRASE_HELPER)",
        "  --no-wake-word       Disable always-on wake-word streaming (button activation only)",
        "  --allowed-speakers   Comma-separated allowlist of speaker names/peerIds (ALLOWED_SPEAKERS)",
      ].join("\n")
    );
    process.exit(0);
  }

  const assistant = new HomeAssistantVoiceAssistant(args);
  assistant
    .start({ initialRoom: args.room, initialPassphrase: args.passphrase })
    .then(({ wyoming, ui }) => {
      console.log(`[ha-assistant] Wyoming Satellite listening on ${wyoming.host}:${wyoming.port}`);
      console.log(`[ha-assistant] Tiny Control Panel UI at http://${ui.host}:${ui.port}/`);
      if (args.haUrl) {
        console.log(`[ha-assistant] Watching HA helper "${args.roomHelper}" on ${args.haUrl}`);
      }
      if (args.room) {
        console.log(`[ha-assistant] Joined initial room`);
      } else {
        console.log(`[ha-assistant] Standby — paste a room link in the HA helper or Control Panel to connect`);
      }
    })
    .catch((err) => {
      console.error("[ha-assistant] Startup failed:", err.message);
      process.exit(1);
    });

  const shutdown = async () => {
    console.log("\n[ha-assistant] Shutting down...");
    await assistant.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

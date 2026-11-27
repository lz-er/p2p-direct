/**
 * Pure Node.js Wyoming Voice Satellite Server & Wire Protocol Codec (zero external dependencies).
 *
 * Implements the Open Home Foundation Wyoming satellite TCP protocol so Home Assistant
 * connects directly via `Settings -> Devices & Services -> Add Integration -> Wyoming Protocol`:
 * - Hands-free wake word detection (`start_stage: "wake"`) via HA's configured wake-word engine
 * - Instant button-triggered listening (`start_stage: "asr"`) skipping the wake word
 * - Full Assist Pipeline (Whisper/Cloud STT -> LLM/Assist Conversation Agent -> Piper/Cloud TTS)
 * - Native Home Assistant Voice Timers (`timer-started`, `timer-updated`, `timer-cancelled`, `timer-finished`)
 * - Push announcements (`assist_satellite.announce`) & multi-turn `continue_conversation` follow-ups
 * - Auto-recovery re-arm if HA aborts a run on `stt-no-text-recognized`
 */

import net from "node:net";
import { EventEmitter } from "node:events";

export const WYOMING_PROTOCOL_VERSION = "1.5.2";

const BENIGN_SOCKET_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

/**
 * Encodes a single Wyoming protocol event into a Buffer:
 *   `<JSON header line>\n[<additional data JSON>][<binary payload>]`
 */
export function encodeWyomingEvent(type, data = {}, payload = null) {
  const payloadBuf = payload
    ? Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(payload)
    : null;
  const header = {
    type: String(type),
    version: WYOMING_PROTOCOL_VERSION,
  };
  if (data && typeof data === "object" && Object.keys(data).length > 0) {
    header.data = data;
  }
  if (payloadBuf && payloadBuf.length > 0) {
    header.payload_length = payloadBuf.length;
  }
  const headerBuf = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  return payloadBuf && payloadBuf.length > 0
    ? Buffer.concat([headerBuf, payloadBuf])
    : headerBuf;
}

/**
 * Streaming stateful parser for Wyoming protocol frames over TCP.
 */
export class WyomingFrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.state = "header"; // header | body
    this.pendingHeader = null;
    this.dataLength = 0;
    this.payloadLength = 0;
  }

  /**
   * Feeds arbitrary incoming TCP bytes and returns an array of decoded `{ type, data, payload }` events.
   */
  push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length === 0) return [];
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, incoming]) : incoming;

    const events = [];
    while (true) {
      if (this.state === "header") {
        const nlIdx = this.buf.indexOf(0x0a); // '\n'
        if (nlIdx === -1) break;
        const line = this.buf.subarray(0, nlIdx).toString("utf8").trim();
        this.buf = this.buf.subarray(nlIdx + 1);
        if (!line) continue;

        let header;
        try {
          header = JSON.parse(line);
        } catch (err) {
          throw new Error(`Invalid Wyoming JSON header: ${err.message}`);
        }
        this.pendingHeader = header;
        this.dataLength = Math.max(0, Number(header.data_length) || 0);
        this.payloadLength = Math.max(0, Number(header.payload_length) || 0);
        this.state = "body";
      }

      if (this.state === "body") {
        const need = this.dataLength + this.payloadLength;
        if (this.buf.length < need) break;

        let mergedData =
          this.pendingHeader?.data && typeof this.pendingHeader.data === "object"
            ? { ...this.pendingHeader.data }
            : {};

        let offset = 0;
        if (this.dataLength > 0) {
          const extraStr = this.buf.subarray(0, this.dataLength).toString("utf8");
          offset += this.dataLength;
          try {
            const extra = JSON.parse(extraStr);
            if (extra && typeof extra === "object") {
              mergedData = { ...mergedData, ...extra };
            }
          } catch (err) {
            throw new Error(`Invalid Wyoming data section: ${err.message}`);
          }
        }

        const payload =
          this.payloadLength > 0
            ? Buffer.from(this.buf.subarray(offset, offset + this.payloadLength))
            : null;
        this.buf = this.buf.subarray(need);

        events.push({
          type: String(this.pendingHeader?.type || ""),
          version: this.pendingHeader?.version || WYOMING_PROTOCOL_VERSION,
          data: mergedData,
          payload,
        });

        this.pendingHeader = null;
        this.dataLength = 0;
        this.payloadLength = 0;
        this.state = "header";
      }
    }
    return events;
  }
}

/**
 * Wyoming Voice Satellite TCP Server.
 *
 * Home Assistant's built-in Wyoming integration connects to this server as a full Assist Satellite
 * entity (`assist_satellite.<name>`), enabling wake words, STT, LLM/entity intents, TTS,
 * `assist_satellite.announce`, and native HA voice timers.
 */
export class WyomingSatelliteServer extends EventEmitter {
  constructor({
    host = "0.0.0.0",
    port = 10700,
    name = "p2p-direct-voice",
    area = "Voice Room",
    description = "End-to-end encrypted p2p-direct voice room satellite",
    wakeWordEnabled = true,
    sampleRate = 16000,
    ttsSampleRate = 24000,
    rearmDelayMs = 450,
    audioStartDelayMs = 60,
    interruptDelayMs = 150,
    processingTimeoutMs = 45000,
  } = {}) {
    super();
    this.host = host;
    this.port = Number(port) || 10700;
    this.name = String(name || "p2p-direct-voice").trim();
    this.area = String(area || "Voice Room").trim();
    this.description = String(description || "p2p-direct voice satellite");
    this.wakeWordEnabled = Boolean(wakeWordEnabled);
    this.sampleRate = Number(sampleRate) || 16000;
    this.ttsSampleRate = Number(ttsSampleRate) || 24000;
    this.rearmDelayMs = Math.max(100, Number(rearmDelayMs) || 450);
    const parsedAudioDelay = Number(audioStartDelayMs);
    this.audioStartDelayMs = Number.isFinite(parsedAudioDelay) ? Math.max(0, parsedAudioDelay) : 60;
    const parsedInterruptDelay = Number(interruptDelayMs);
    this.interruptDelayMs = Number.isFinite(parsedInterruptDelay) ? Math.max(0, parsedInterruptDelay) : 150;
    const parsedProcessingTimeout = Number(processingTimeoutMs);
    this.processingTimeoutMs = Number.isFinite(parsedProcessingTimeout) ? Math.max(0, parsedProcessingTimeout) : 45000;

    this.server = null;
    this.activeSocket = null;
    this.satelliteRunning = false;
    this.streamingToHa = false;
    this.pipelineMode = "idle"; // idle | wake | asr | processing | speaking
    this.receivingTts = false;
    this.ttsFormat = { rate: this.ttsSampleRate, width: 2, channels: 1 };
    this._rearmTimer = null;
    this._audioStartTimer = null;
    this._pipelineStartTimer = null;
    this._pendingPipelineStart = null;
    this._processingTimer = null;
    this._audioTimestamp = 0;
  }

  getInfoPayload() {
    return {
      asr: [],
      tts: [],
      handle: [],
      intent: [],
      wake: [],
      satellite: {
        name: this.name,
        attribution: {
          name: "p2p-direct",
          url: "https://voice.dequ.org/",
        },
        installed: true,
        description: this.description,
        version: "1.0.0",
        area: this.area,
        snd_format: {
          rate: this.ttsSampleRate,
          width: 2,
          channels: 1,
        },
        has_vad: false,
        active_wake_words: [],
        max_active_wake_words: 0,
        supports_trigger: true,
      },
    };
  }

  async start() {
    if (this.server) return { host: this.host, port: this.port };
    await new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._handleSocket(socket));
      this.server = server;
      const onStartupError = (err) => {
        if (this.server === server) this.server = null;
        reject(err);
      };
      server.once("error", onStartupError);
      server.listen(this.port, this.host, () => {
        server.off("error", onStartupError);
        server.on("error", (err) => this._emitSafeError(err));
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
    });
    return { host: this.host, port: this.port };
  }

  async stop() {
    this._clearAllTimers();
    if (this.activeSocket) {
      try {
        this.activeSocket.destroy();
      } catch {
        // ignore
      }
      this.activeSocket = null;
    }
    this.satelliteRunning = false;
    this.streamingToHa = false;
    this.pipelineMode = "idle";
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise((resolve) => srv.close(() => resolve()));
    }
  }

  isConnected() {
    return Boolean(this.activeSocket && !this.activeSocket.destroyed);
  }

  isReady() {
    return this.isConnected() && this.satelliteRunning;
  }

  setWakeWordEnabled(enabled) {
    this.wakeWordEnabled = Boolean(enabled);
    if (!this.isReady()) return;
    if (this.wakeWordEnabled) {
      if (this.pipelineMode === "idle") {
        this.startWakeListening();
      }
    } else if (this.pipelineMode === "wake") {
      this._clearPipelineStartTimer();
      this.stopAudioStream();
      this._setPipelineMode("idle");
    }
  }

  _startPipeline({ startStage, wakeWordName = undefined, mode }) {
    if (!this.isReady()) return false;
    const wasStreaming = this.streamingToHa;
    this._clearAllTimers();
    if (wasStreaming) {
      this.stopAudioStream();
    }

    const targetSocket = this.activeSocket;
    const payload = {
      start_stage: startStage,
      end_stage: "tts",
      restart_on_end: false,
    };
    if (wakeWordName) {
      payload.wake_word_name = wakeWordName;
    }

    const pending = {
      targetSocket,
      sendFn: () => {
        if (this._pendingPipelineStart && this._pendingPipelineStart !== pending) return;
        this._pendingPipelineStart = null;
        this._pipelineStartTimer = null;
        if (!this.isReady() || this.activeSocket !== targetSocket) return;
        this._sendEvent("run-pipeline", payload);
        this._scheduleAudioStart(targetSocket);
      },
    };

    this._setPipelineMode(mode);

    if (wasStreaming && this.interruptDelayMs > 0) {
      this._pendingPipelineStart = pending;
      this._pipelineStartTimer = setTimeout(() => {
        this._pipelineStartTimer = null;
        pending.sendFn();
      }, this.interruptDelayMs);
    } else {
      pending.sendFn();
    }
    return true;
  }

  /**
   * Arms HA's Assist Pipeline in wake-word detection mode (`start_stage: "wake"`).
   */
  startWakeListening() {
    return this._startPipeline({ startStage: "wake", mode: "wake" });
  }

  /**
   * Immediately triggers STT listening without a wake word (`start_stage: "asr"`) —
   * ideal for button activation in chat or the control panel.
   */
  triggerListenNow({ wakeWordName = "button" } = {}) {
    if (!this.isReady()) return false;
    this._startPipeline({
      startStage: "asr",
      wakeWordName: wakeWordName || undefined,
      mode: "asr",
    });
    this.emit("listenTriggered", { source: wakeWordName || "button" });
    return true;
  }

  /**
   * Feeds a 16 kHz mono Int16LE PCM chunk into the active Wyoming pipeline when streaming.
   */
  sendAudioChunk(pcmBuffer) {
    if (!this.streamingToHa || !this.isConnected() || !pcmBuffer || pcmBuffer.length === 0) {
      return false;
    }
    const buf = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    const ts = this._audioTimestamp;
    this._audioTimestamp += Math.round((buf.length / (this.sampleRate * 2)) * 1000);
    return this._sendEvent(
      "audio-chunk",
      {
        rate: this.sampleRate,
        width: 2,
        channels: 1,
        timestamp: ts,
      },
      buf
    );
  }

  stopAudioStream() {
    this._clearAudioStartTimer();
    if (!this.streamingToHa) return;
    this.streamingToHa = false;
    if (this.isConnected()) {
      this._sendEvent("audio-stop", { timestamp: this._audioTimestamp });
    }
  }

  /**
   * Must be called once TTS or announcement audio has finished playing in the room so Home
   * Assistant completes announcements and triggers follow-up listening (`continue_conversation`).
   */
  notifyAudioPlayed() {
    if (!this.isConnected()) return;
    this._sendEvent("played", {});
    if (this.pipelineMode === "speaking") {
      this._setPipelineMode("idle");
    }
    if (this.satelliteRunning && this.wakeWordEnabled) {
      this._scheduleWakeRearm();
    }
  }

  _startAudioStream() {
    this._audioTimestamp = 0;
    this.streamingToHa = true;
    this._sendEvent("audio-start", {
      rate: this.sampleRate,
      width: 2,
      channels: 1,
      timestamp: 0,
    });
  }

  _scheduleAudioStart(expectedSocket = this.activeSocket) {
    this._clearAudioStartTimer();
    if (this.audioStartDelayMs <= 0) {
      this._startAudioStream();
      return;
    }
    this._audioStartTimer = setTimeout(() => {
      this._audioStartTimer = null;
      if (!this.isReady() || this.activeSocket !== expectedSocket) return;
      if (this.pipelineMode !== "wake" && this.pipelineMode !== "asr") return;
      this._startAudioStream();
    }, this.audioStartDelayMs);
  }

  _setPipelineMode(mode) {
    if (this.pipelineMode === mode) return;
    this.pipelineMode = mode;
    this.emit("stateChange", {
      connected: this.isConnected(),
      satelliteRunning: this.satelliteRunning,
      mode: this.pipelineMode,
      wakeWordEnabled: this.wakeWordEnabled,
    });
  }

  _clearRearmTimer() {
    if (this._rearmTimer) {
      clearTimeout(this._rearmTimer);
      this._rearmTimer = null;
    }
  }

  _clearAudioStartTimer() {
    if (this._audioStartTimer) {
      clearTimeout(this._audioStartTimer);
      this._audioStartTimer = null;
    }
  }

  _clearPipelineStartTimer() {
    if (this._pipelineStartTimer) {
      clearTimeout(this._pipelineStartTimer);
      this._pipelineStartTimer = null;
    }
    this._pendingPipelineStart = null;
  }

  _clearProcessingTimer() {
    if (this._processingTimer) {
      clearTimeout(this._processingTimer);
      this._processingTimer = null;
    }
  }

  _scheduleProcessingTimeout() {
    this._clearProcessingTimer();
    if (this.processingTimeoutMs <= 0) return;
    this._processingTimer = setTimeout(() => {
      this._processingTimer = null;
      if (this.pipelineMode === "processing") {
        this._setPipelineMode("idle");
        if (this.satelliteRunning && this.wakeWordEnabled) {
          this._scheduleWakeRearm();
        }
      }
    }, this.processingTimeoutMs);
    this._processingTimer.unref?.();
  }

  _clearAllTimers() {
    this._clearRearmTimer();
    this._clearPipelineStartTimer();
    this._clearAudioStartTimer();
    this._clearProcessingTimer();
  }

  _emitSafeError(err) {
    const code = err?.code || "";
    if (BENIGN_SOCKET_ERROR_CODES.has(code)) {
      if (this.listenerCount("error") > 0) {
        this.emit("error", err);
      }
      return;
    }
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    } else {
      console.warn("[wyoming] Socket error:", err?.message || String(err));
    }
  }

  _scheduleWakeRearm() {
    this._clearRearmTimer();
    if (!this.wakeWordEnabled || !this.satelliteRunning) return;
    this._rearmTimer = setTimeout(() => {
      this._rearmTimer = null;
      if (this.wakeWordEnabled && this.isReady() && this.pipelineMode === "idle") {
        this.startWakeListening();
      }
    }, this.rearmDelayMs);
  }

  _sendEvent(type, data = {}, payload = null, socket = this.activeSocket) {
    if (!socket || socket.destroyed) return false;
    try {
      socket.write(encodeWyomingEvent(type, data, payload));
      return true;
    } catch {
      return false;
    }
  }

  _handleSocket(socket) {
    const decoder = new WyomingFrameDecoder();
    socket.setNoDelay(true);

    socket.on("data", (chunk) => {
      let events;
      try {
        events = decoder.push(chunk);
      } catch (err) {
        this._emitSafeError(err);
        socket.destroy();
        return;
      }
      for (const ev of events) {
        this._handleIncomingEvent(socket, ev);
      }
    });

    socket.on("close", () => {
      if (this.activeSocket === socket) {
        this.activeSocket = null;
        this.satelliteRunning = false;
        this.streamingToHa = false;
        this._clearAllTimers();
        this._setPipelineMode("idle");
        this.emit("haDisconnected");
      }
    });

    socket.on("error", (err) => {
      this._emitSafeError(err);
    });
  }

  _handleIncomingEvent(socket, ev) {
    const { type, data, payload } = ev;

    switch (type) {
      case "describe": {
        this._sendEvent("info", this.getInfoPayload(), null, socket);
        break;
      }

      case "ping": {
        this._sendEvent("pong", { text: data?.text || "" }, null, socket);
        break;
      }

      case "run-satellite": {
        this._clearAllTimers();
        this.streamingToHa = false;
        if (this.activeSocket && this.activeSocket !== socket) {
          try {
            this.activeSocket.destroy();
          } catch {
            // ignore
          }
        }
        this.activeSocket = socket;
        this.satelliteRunning = true;
        this.emit("haConnected", { remoteAddress: socket.remoteAddress || "" });
        this._setPipelineMode("idle");
        if (this.wakeWordEnabled) {
          this.startWakeListening();
        }
        break;
      }

      case "pause-satellite": {
        if (this.activeSocket === socket) {
          this.satelliteRunning = false;
          this._clearAllTimers();
          this.stopAudioStream();
          this._setPipelineMode("idle");
          this.emit("satellitePaused");
        }
        break;
      }

      case "run-pipeline": {
        // HA can push a server-initiated pipeline (e.g., continue_conversation with start_stage="asr",
        // or announce_text with start_stage="tts")
        if (this.activeSocket !== socket) {
          this.activeSocket = socket;
          this.satelliteRunning = true;
        }
        const startStage = String(data?.start_stage || "").toLowerCase();
        if (startStage === "asr") {
          this._clearPipelineStartTimer();
          this._setPipelineMode("asr");
          this._scheduleAudioStart(socket);
          this.emit("continueConversation", data);
        } else if (startStage === "wake") {
          if (this.wakeWordEnabled) {
            this._clearPipelineStartTimer();
            this._setPipelineMode("wake");
            this._scheduleAudioStart(socket);
          }
        }
        break;
      }

      case "detect": {
        this._clearProcessingTimer();
        if (this.pipelineMode === "wake" && this._audioStartTimer) {
          this._clearAudioStartTimer();
          this._startAudioStream();
        }
        this.emit("wakeListening", data || {});
        break;
      }

      case "detection": {
        this._clearProcessingTimer();
        this._setPipelineMode("asr");
        this.emit("wakeDetected", {
          name: data?.name || "wake_word",
          timestamp: data?.timestamp ?? null,
        });
        break;
      }

      case "transcribe": {
        this._clearProcessingTimer();
        this._setPipelineMode("asr");
        if (this._audioStartTimer) {
          this._clearAudioStartTimer();
          this._startAudioStream();
        }
        this.emit("sttStart", data || {});
        break;
      }

      case "voice-started": {
        this.emit("voiceStarted", data || {});
        break;
      }

      case "voice-stopped": {
        this.emit("voiceStopped", data || {});
        break;
      }

      case "transcript": {
        this.stopAudioStream();
        this._setPipelineMode("processing");
        this._scheduleProcessingTimeout();
        this.emit("transcript", { text: String(data?.text || "").trim() });
        break;
      }

      case "handled": {
        this.emit("handled", {
          text: String(data?.text || "").trim(),
          continueConversation: Boolean(data?.continue_conversation),
        });
        break;
      }

      case "not-handled": {
        this.emit("notHandled", { text: String(data?.text || "").trim() });
        break;
      }

      case "synthesize": {
        this._clearProcessingTimer();
        this.emit("synthesize", data || {});
        break;
      }

      case "audio-start": {
        this._clearProcessingTimer();
        this._clearPipelineStartTimer();
        this.stopAudioStream();
        this.receivingTts = true;
        this.ttsFormat = {
          rate: Number(data?.rate) || this.ttsSampleRate || 16000,
          width: Number(data?.width) || 2,
          channels: Number(data?.channels) || 1,
        };
        this._setPipelineMode("speaking");
        this.emit("ttsStart", { ...this.ttsFormat });
        break;
      }

      case "audio-chunk": {
        if (payload && payload.length > 0) {
          const fmt = {
            rate: Number(data?.rate) || this.ttsFormat.rate || this.ttsSampleRate || 16000,
            width: Number(data?.width) || this.ttsFormat.width || 2,
            channels: Number(data?.channels) || this.ttsFormat.channels || 1,
          };
          this.emit("ttsAudio", { buffer: payload, ...fmt });
        }
        break;
      }

      case "audio-stop": {
        this.receivingTts = false;
        this.emit("ttsStop");
        break;
      }

      case "timer-started": {
        this.emit("timerStarted", {
          id: String(data?.id || ""),
          name: String(data?.name || "").trim(),
          totalSeconds: Math.max(1, Number(data?.total_seconds) || 0),
          startHours: Number(data?.start_hours) || 0,
          startMinutes: Number(data?.start_minutes) || 0,
          startSeconds: Number(data?.start_seconds) || 0,
          commandText: data?.command?.text ? String(data.command.text) : "",
        });
        break;
      }

      case "timer-updated": {
        this.emit("timerUpdated", {
          id: String(data?.id || ""),
          isActive: Boolean(data?.is_active),
          totalSeconds: Math.max(0, Number(data?.total_seconds) || 0),
        });
        break;
      }

      case "timer-cancelled": {
        this.emit("timerCancelled", { id: String(data?.id || "") });
        break;
      }

      case "timer-finished": {
        this.emit("timerFinished", { id: String(data?.id || "") });
        break;
      }

      case "error": {
        if (this._pendingPipelineStart || this._pipelineStartTimer) {
          // Stale error (e.g. wake-word-timeout) from stopping the prior stream with audio-stop.
          // Cancel the long fallback timer and fire our pending run-pipeline right after HA's RUN_END tick.
          const pending = this._pendingPipelineStart;
          if (this._pipelineStartTimer) {
            clearTimeout(this._pipelineStartTimer);
            this._pipelineStartTimer = null;
          }
          if (pending) {
            const accelDelayMs = Math.min(30, this.interruptDelayMs);
            if (accelDelayMs <= 0) {
              pending.sendFn();
            } else {
              this._pipelineStartTimer = setTimeout(() => {
                this._pipelineStartTimer = null;
                pending.sendFn();
              }, accelDelayMs);
            }
          }
          break;
        }
        this._clearProcessingTimer();
        const code = String(data?.code || "error");
        const text = String(data?.text || "");
        this.stopAudioStream();
        this._setPipelineMode("idle");
        this.emit("pipelineError", { code, text });
        // Auto-recover from HA Core Wyoming stt-no-text-recognized stall
        if (this.satelliteRunning && this.wakeWordEnabled) {
          this._scheduleWakeRearm();
        }
        break;
      }

      default:
        this.emit("unknownEvent", ev);
        break;
    }
  }
}

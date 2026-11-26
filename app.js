import { SafeRustWasmMesh } from "./wasm_client.js";
import {
  MultiRelayRendezvous,
  RELAY_DATA_CHUNK_SIZE,
  computePeerTag,
  decodeRelayDataChunk,
  decodeRelayVoiceBundle,
  encodeRelayDataChunks,
  encodeRelayVoiceBundle,
  encodeSingleRelayDataChunk,
  resolveRelayUrls,
} from "./mqtt_relay.js";
import {
  DEFAULT_AUDIO_SETTINGS,
  LAST_ROOM_KEY,
  SAVED_ROOMS_KEY,
  clearLastJoinedRoom,
  createEphemeralProfile,
  loadLastJoinedRoom,
  loadSavedRooms,
  loadSessionAudioSettings,
  purgeLegacyClientStorage,
  randomBase64Url,
  removeSavedRoom,
  renameSavedRoom,
  saveLastJoinedRoom,
  saveSessionAudioSettings,
  saveSessionAuthorName,
  upsertSavedRoom,
} from "./storage.js";
import {
  WatchTogetherPlayer,
  formatClockTime,
  frameIndexForGifTime,
  parseWatchMediaUrl,
  projectMediaPositionMs,
} from "./watch_together.js";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const BASE_STUN_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

const ICE_CONFIG = {
  iceServers: BASE_STUN_SERVERS.slice(),
  iceCandidatePoolSize: 2,
};

function buildIceConfig() {
  if (typeof window !== "undefined" && Array.isArray(window.__P2P_ICE_SERVERS__)) {
    return {
      iceServers: window.__P2P_ICE_SERVERS__,
      iceCandidatePoolSize: 2,
    };
  }
  return {
    iceServers: BASE_STUN_SERVERS.slice(),
    iceCandidatePoolSize: 2,
  };
}

function classifyIceCandidateType(candStr) {
  if (!candStr || typeof candStr !== "string") return "other";
  const m = candStr.match(/\btyp\s+(host|srflx|prflx|relay)\b/i);
  const typ = m ? m[1].toLowerCase() : "other";
  if (typ === "host") {
    const parts = candStr.trim().split(/\s+/);
    const addr = parts[4] || "";
    if (addr.endsWith(".local")) return "host(mdns)";
    if (addr.includes(":")) return "host(ipv6)";
    if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return "host(ipv4)";
  }
  return typ;
}

const BROADCAST_CHANNEL_NAME = "p2p-direct-signal-v1";
const KEEPALIVE_INTERVAL_MS = 4000;
const DISCONNECT_GRACE_MS = 6000;

// Direct-first WebRTC timeouts & zero-TURN E2EE WSS Relay fallback tuning
const DIRECT_FALLBACK_TIMEOUT_MS = 5500;
const ANSWER_FALLBACK_TIMEOUT_MS = 6500;
const DIRECT_HARD_TIMEOUT_MS = 14000;
const RELAY_INACTIVITY_TIMEOUT_MS = 22000;
const DIRECT_UPGRADE_INTERVAL_MS = 45000;
const DIRECT_UPGRADE_MAX_ATTEMPTS = 2;
const VOICE_RELAY_BATCH_MS = 80;
const VOICE_RELAY_MAX_FRAMES = 4;

const VOICE_SAMPLE_RATE = 16000;
const VOICE_FRAME_SAMPLES = 320; // 20ms @ 16kHz legacy ADPCM V1 (bots & fallback browsers)
const VOICE_HD_SAMPLE_RATE = 48000;
const VOICE_HD_FRAME_SAMPLES = 960; // 20ms @ 48kHz fullband Opus V2
const VOICE_V2_CODEC_OPUS48 = 1;
const VOICE_V2_HEADER_BYTES = 8; // [codecId:u8, sampleRateKhz:u8, rms:u16le, tsSamples:u32le]
const VOICE_OPUS_BITRATE_DIRECT = 96000; // 96 kbps VBR fullband 48kHz mono (~240B/frame)
const VOICE_OPUS_BITRATE_RAW = 128000;   // 128 kbps VBR studio/music preset on Direct P2P
const VOICE_OPUS_BITRATE_RELAY = 48000;  // 48 kbps VBR fullband 48kHz mono (~120B/frame; crisp voice, light relay load)

const AUDIO_PRESETS = Object.freeze({
  voice: {
    preset: "voice",
    micGain: 100,
    noiseGate: 2,
    highPassHz: 80,
    presenceDb: 2,
    compressor: true,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  broadcast: {
    preset: "broadcast",
    micGain: 125,
    noiseGate: 3,
    highPassHz: 120,
    presenceDb: 4,
    compressor: true,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  },
  raw: {
    preset: "raw",
    micGain: 100,
    noiseGate: 0,
    highPassHz: 0,
    presenceDb: 0,
    compressor: false,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
});

const VOICE_WORKLETS_CODE = `
class P2PVoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = ${VOICE_HD_SAMPLE_RATE};
    this.frameSize = ${VOICE_HD_FRAME_SAMPLES};
    this.isDirect = Math.abs(sampleRate - this.targetRate) < 1;
    this.step = sampleRate / this.targetRate;
    this.ringCap = 8192;
    this.ringMask = 8191;
    this.ring = new Float32Array(this.ringCap);
    this.writeIdx = 0;
    this.readPos = 0;
    this.frame = new Float32Array(this.frameSize);
    this.frameIdx = 0;
    this.needPreLpf = sampleRate > this.targetRate + 100;
    this.lpfAlpha = this.needPreLpf
      ? Math.min(1, (2 * Math.PI * 20000) / (sampleRate + 2 * Math.PI * 20000))
      : 1;
    this.lpfState = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }
    const ch = input[0];
    const len = ch.length;

    if (this.isDirect) {
      let srcOff = 0;
      while (srcOff < len) {
        const space = this.frameSize - this.frameIdx;
        const take = len - srcOff < space ? len - srcOff : space;
        this.frame.set(srcOff === 0 && take === len ? ch : ch.subarray(srcOff, srcOff + take), this.frameIdx);
        this.frameIdx += take;
        srcOff += take;
        if (this.frameIdx >= this.frameSize) {
          const out = this.frame;
          this.frame = new Float32Array(this.frameSize);
          this.frameIdx = 0;
          this.port.postMessage(out, [out.buffer]);
        }
      }
      return true;
    }

    const ring = this.ring;
    const mask = this.ringMask;
    let w = this.writeIdx;
    if (this.needPreLpf) {
      const a = this.lpfAlpha;
      let y = this.lpfState;
      for (let i = 0; i < len; i++) {
        y += a * (ch[i] - y);
        ring[w & mask] = y;
        w++;
      }
      this.lpfState = y;
    } else {
      for (let i = 0; i < len; i++) {
        ring[w & mask] = ch[i];
        w++;
      }
    }
    this.writeIdx = w;

    if (this.writeIdx - this.readPos > this.ringCap - 256) {
      this.readPos = this.writeIdx - this.frameSize * 2;
    }

    while (this.readPos + 2 < this.writeIdx) {
      const idx = Math.floor(this.readPos);
      const t = this.readPos - idx;
      const y0 = ring[(idx - 1) & mask];
      const y1 = ring[idx & mask];
      const y2 = ring[(idx + 1) & mask];
      const y3 = ring[(idx + 2) & mask];
      const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
      const a1 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
      const a2 = -0.5 * y0 + 0.5 * y2;
      const sample = ((a0 * t + a1) * t + a2) * t + y1;
      this.frame[this.frameIdx++] = sample > 1 ? 1 : sample < -1 ? -1 : sample;
      this.readPos += this.step;
      if (this.frameIdx >= this.frameSize) {
        const out = new Float32Array(this.frame);
        this.port.postMessage(out, [out.buffer]);
        this.frameIdx = 0;
      }
    }

    if (this.readPos > 1048576) {
      const shift = Math.floor(this.readPos / this.ringCap) * this.ringCap;
      this.readPos -= shift;
      this.writeIdx -= shift;
    }
    return true;
  }
}

class P2PVoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 65536;
    this.mask = 65535;
    this.ring = new Float32Array(this.cap);
    this.writeIdx = 0;
    this.readPos = 0;
    this.playing = false;
    this.targetMs = 20;
    this.startMs = 26;
    this.maxMs = 150;
    this.targetSamples = Math.round((this.targetMs * sampleRate) / 1000);
    this.startSamples = Math.round((this.startMs * sampleRate) / 1000);
    this.maxSamples = Math.round((this.maxMs * sampleRate) / 1000);
    this.jitterMs = 0;
    this.smoothTrough = -1;
    this.waitSamples = 0;
    this.lastBurstFrame = -1;
    this.curBurstMs = 0;
    this.prevBurstMs = 20;
    this.fadeInTotal = Math.max(64, Math.round(sampleRate * 0.004));
    this.fadeInPos = this.fadeInTotal;
    this.plcCount = 0;
    this.plcMax = Math.max(128, Math.round(sampleRate * 0.012));
    this.lastOut = 0;
    this.xfadeLen = 64;
    this.xfadeBuf = new Float32Array(this.xfadeLen);
    this.xfadePos = this.xfadeLen;
    this.rsRate = 0;
    this.rsPrev0 = 0;
    this.rsPrev1 = 0;
    this.rsPrev2 = 0;
    this.rsPhase = 0;
    this.curRate = 1.0;
    this.underruns = 0;
    this.overruns = 0;
    this.statsBlocks = 0;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "config") {
        if (typeof msg.targetMs === "number" && msg.targetMs > 0) {
          this.targetMs = msg.targetMs;
          this.targetSamples = Math.round((this.targetMs * sampleRate) / 1000);
        }
        if (typeof msg.startMs === "number" && msg.startMs > 0) {
          this.startMs = msg.startMs;
          this.startSamples = Math.round((this.startMs * sampleRate) / 1000);
        } else if (typeof msg.targetMs === "number" && msg.targetMs > 0) {
          this.startMs = Math.max(this.targetMs, this.startMs);
          this.startSamples = Math.round((this.startMs * sampleRate) / 1000);
        }
        if (typeof msg.maxMs === "number" && msg.maxMs > 0) {
          this.maxMs = msg.maxMs;
          this.maxSamples = Math.round((this.maxMs * sampleRate) / 1000);
        }
        this.smoothTrough = -1;
        return;
      }
      if (msg.type === "reset") {
        this.writeIdx = 0;
        this.readPos = 0;
        this.playing = false;
        this.jitterMs = 0;
        this.smoothTrough = -1;
        this.waitSamples = 0;
        this.lastBurstFrame = -1;
        this.curBurstMs = 0;
        this.prevBurstMs = 20;
        this.plcCount = 0;
        this.lastOut = 0;
        this.xfadePos = this.xfadeLen;
        this.rsRate = 0;
        this.rsPhase = 0;
        this.curRate = 1.0;
        this.underruns = 0;
        this.overruns = 0;
        this.statsBlocks = 0;
        return;
      }
      if (msg.type === "pcm" && msg.samples && msg.samples.length > 0) {
        this.pushPcm(msg.samples, msg.rate || sampleRate);
      }
    };
  }

  effectiveTargetTrough() {
    const dynamicMs = this.targetMs + Math.min(this.jitterMs * 1.1, this.maxMs * 0.35);
    const dynSamples = Math.round((dynamicMs * sampleRate) / 1000);
    return Math.min(Math.round(this.maxSamples * 0.55), Math.max(this.targetSamples, dynSamples));
  }

  effectiveStartSamples() {
    const effTrough = this.effectiveTargetTrough();
    return Math.min(Math.round(this.maxSamples * 0.65), Math.max(this.startSamples, effTrough));
  }

  maybePostStats(avail, effTrough) {
    this.statsBlocks++;
    if (this.statsBlocks < 100) return;
    this.statsBlocks = 0;
    const clampedAvail = avail > 0 ? avail : 0;
    const availMs = (clampedAvail * 1000) / sampleRate;
    const effTargetMs = (effTrough * 1000) / sampleRate;
    const troughMs = this.smoothTrough >= 0 ? (this.smoothTrough * 1000) / sampleRate : availMs;
    const driftPpm = Math.round((this.curRate - 1.0) * 1000000);
    this.port.postMessage({
      type: "stats",
      cacheMs: Math.round(availMs * 10) / 10,
      targetMs: Math.round(effTargetMs),
      baseTargetMs: this.targetMs,
      maxMs: this.maxMs,
      troughMs: Math.round(troughMs * 10) / 10,
      jitterMs: Math.round(this.jitterMs * 10) / 10,
      driftPpm,
      underruns: this.underruns,
      overruns: this.overruns,
      playing: this.playing,
      burstMs: Math.round(this.curBurstMs || this.prevBurstMs || 20),
      sampleRate,
    });
  }

  pushPcm(samples, inRate) {
    const n = samples.length;
    const frameMs = (n * 1000) / inRate;
    const preAvail = Math.max(0, this.writeIdx - this.readPos);

    if (this.lastBurstFrame < 0) {
      this.lastBurstFrame = currentFrame;
      this.curBurstMs = frameMs;
      this.prevBurstMs = frameMs;
    } else {
      const elapsedMs = ((currentFrame - this.lastBurstFrame) * 1000) / sampleRate;
      if (elapsedMs <= 8) {
        // Subsequent frame belonging to the same decoded relay VB bundle
        this.curBurstMs += frameMs;
      } else if (elapsedMs > 500) {
        this.jitterMs = 0;
        this.smoothTrough = -1;
        this.prevBurstMs = frameMs;
        this.curBurstMs = frameMs;
        this.lastBurstFrame = currentFrame;
      } else {
        // Start of a new incoming burst: sample the sawtooth trough BEFORE refilling
        if (this.playing) {
          this.smoothTrough =
            this.smoothTrough < 0 ? preAvail : this.smoothTrough * 0.8 + preAvail * 0.2;
        }
        const expectedMs = this.curBurstMs > 0 ? this.curBurstMs : this.prevBurstMs;
        const diff = Math.abs(elapsedMs - expectedMs);
        this.jitterMs = this.jitterMs * 0.88 + Math.min(diff, 120) * 0.12;
        this.prevBurstMs = expectedMs;
        this.curBurstMs = frameMs;
        this.lastBurstFrame = currentFrame;
      }
    }

    const ring = this.ring;
    const mask = this.mask;
    let w = this.writeIdx;

    if (Math.abs(inRate - sampleRate) < 1) {
      for (let i = 0; i < n; i++) {
        ring[w & mask] = samples[i];
        w++;
      }
    } else {
      if (this.rsRate !== inRate) {
        this.rsRate = inRate;
        this.rsPrev0 = samples[0];
        this.rsPrev1 = samples[0];
        this.rsPrev2 = samples[0];
        this.rsPhase = 0;
      }
      const step = inRate / sampleRate;
      const p0 = this.rsPrev0;
      const p1 = this.rsPrev1;
      const p2 = this.rsPrev2;
      const lastS = samples[n - 1];
      let pos = this.rsPhase - 2;
      const limit = Math.max(0, n - 2);
      while (pos < limit) {
        const idx = Math.floor(pos);
        const t = pos - idx;
        const i0 = idx - 1;
        const i1 = idx;
        const i2 = idx + 1;
        const i3 = idx + 2;
        const y0 = i0 >= 0 ? (i0 < n ? samples[i0] : lastS) : i0 === -1 ? p2 : i0 === -2 ? p1 : p0;
        const y1 = i1 >= 0 ? (i1 < n ? samples[i1] : lastS) : i1 === -1 ? p2 : i1 === -2 ? p1 : p0;
        const y2 = i2 >= 0 ? (i2 < n ? samples[i2] : lastS) : i2 === -1 ? p2 : i2 === -2 ? p1 : p0;
        const y3 = i3 >= 0 ? (i3 < n ? samples[i3] : lastS) : i3 === -1 ? p2 : i3 === -2 ? p1 : p0;
        const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
        const a1 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
        const a2 = -0.5 * y0 + 0.5 * y2;
        const s = ((a0 * t + a1) * t + a2) * t + y1;
        ring[w & mask] = s > 1 ? 1 : s < -1 ? -1 : s;
        w++;
        pos += step;
      }
      this.rsPhase = (pos + 2) - n;
      if (n >= 3) {
        this.rsPrev0 = samples[n - 3];
        this.rsPrev1 = samples[n - 2];
        this.rsPrev2 = samples[n - 1];
      } else {
        for (let i = 0; i < n; i++) {
          this.rsPrev0 = this.rsPrev1;
          this.rsPrev1 = this.rsPrev2;
          this.rsPrev2 = samples[i];
        }
      }
    }
    this.writeIdx = w;

    const avail = this.writeIdx - this.readPos;
    const effTrough = this.effectiveTargetTrough();
    const burstSamples = Math.round((Math.max(this.curBurstMs, this.prevBurstMs, 20) * sampleRate) / 1000);
    const hardCap = Math.min(
      this.cap - 1024,
      Math.max(this.maxSamples, effTrough + burstSamples + Math.round(sampleRate * 0.05))
    );
    if (avail > hardCap) {
      this.overruns++;
      if (this.playing) {
        const base = Math.floor(this.readPos);
        for (let i = 0; i < this.xfadeLen; i++) {
          this.xfadeBuf[i] = ring[(base + i) & mask];
        }
        this.xfadePos = 0;
      }
      this.readPos = this.writeIdx - (effTrough + burstSamples);
      this.smoothTrough = effTrough;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out || out.length === 0) {
      return true;
    }
    const len = out.length;
    const ring = this.ring;
    const mask = this.mask;
    const effTrough = this.effectiveTargetTrough();
    const effStart = this.effectiveStartSamples();
    let avail = this.writeIdx - this.readPos;

    if (!this.playing) {
      if (avail <= 0) {
        this.waitSamples = 0;
        out.fill(0);
        this.maybePostStats(0, effTrough);
        return true;
      }
      this.waitSamples += len;
      const maxWait = Math.max(effStart + Math.round(sampleRate * 0.03), Math.round(sampleRate * 0.04));
      if (avail < effStart && this.waitSamples < maxWait) {
        out.fill(0);
        this.maybePostStats(avail, effTrough);
        return true;
      }
      this.playing = true;
      this.waitSamples = 0;
      this.smoothTrough = -1;
      this.fadeInPos = 0;
      this.plcCount = 0;
      this.curRate = 1.0;
    }

    // Drive clock-drift compensation ONLY from the sawtooth trough (never the bundle peak!)
    let desiredRate = 1.0;
    if (this.smoothTrough >= 0) {
      const err = this.smoothTrough - effTrough;
      const deadband = Math.max(Math.round(sampleRate * 0.015), Math.round(effTrough * 0.35));
      if (err > deadband) {
        const over = err - deadband;
        const maxBoost = this.smoothTrough > this.maxSamples * 0.65 ? 0.01 : 0.004;
        desiredRate = 1.0 + Math.min(maxBoost, over / (sampleRate * 2.5));
      } else if (err < -deadband) {
        const under = -err - deadband;
        desiredRate = 1.0 - Math.min(0.004, under / (sampleRate * 2.5));
      }
    }
    this.curRate = this.curRate * 0.94 + desiredRate * 0.06;
    const step = this.curRate;

    for (let i = 0; i < len; i++) {
      avail = this.writeIdx - this.readPos;
      let sample = 0;
      if (avail >= 2) {
        this.plcCount = 0;
        const idx = Math.floor(this.readPos);
        const frac = this.readPos - idx;
        if (frac < 1e-6) {
          sample = ring[idx & mask];
        } else {
          const s0 = ring[idx & mask];
          const s1 = ring[(idx + 1) & mask];
          sample = s0 + (s1 - s0) * frac;
        }
        this.readPos += step;
        this.lastOut = sample;
      } else if (avail >= 1) {
        this.plcCount = 0;
        sample = ring[Math.floor(this.readPos) & mask];
        this.readPos = this.writeIdx;
        this.lastOut = sample;
      } else {
        this.plcCount++;
        if (this.plcCount === 1) {
          this.underruns++;
        }
        if (this.plcCount <= this.plcMax) {
          const t = this.plcCount / this.plcMax;
          const env = 0.5 * (1 + Math.cos(Math.PI * t));
          sample = this.lastOut * env;
        } else {
          sample = 0;
          this.lastOut = 0;
          this.playing = false;
          this.waitSamples = 0;
          this.smoothTrough = -1;
        }
      }

      if (this.xfadePos < this.xfadeLen) {
        const w = this.xfadePos / this.xfadeLen;
        sample = this.xfadeBuf[this.xfadePos] * (1 - w) + sample * w;
        this.xfadePos++;
      }

      if (this.fadeInPos < this.fadeInTotal) {
        const w = 0.5 * (1 - Math.cos((Math.PI * this.fadeInPos) / this.fadeInTotal));
        sample *= w;
        this.fadeInPos++;
      }

      out[i] = sample;
    }

    if (this.readPos > 1048576) {
      const shift = Math.floor(this.readPos / this.cap) * this.cap;
      this.readPos -= shift;
      this.writeIdx -= shift;
    }
    this.maybePostStats(this.writeIdx - this.readPos, effTrough);
    return true;
  }
}

registerProcessor("p2p-voice-capture", P2PVoiceCaptureProcessor);
registerProcessor("p2p-voice-playback", P2PVoicePlaybackProcessor);
`;

const STRUCTURED_PRESETS = {
  event: {
    type: "event",
    payload: { action: "checkpoint", version: 1, ok: true },
  },
  task: {
    type: "task",
    payload: { id: "task-1", title: "Verify encrypted sync", status: "open", priority: 2 },
  },
  metric: {
    type: "metric",
    payload: { name: "mesh_latency_ms", value: 14.2, unit: "ms", tags: ["p2p", "encrypted", "realtime"] },
  },
  state: {
    type: "state",
    payload: { key: "config.mode", value: "encrypted", updatedBy: "peer" },
  },
};

// 12 curated WCAG-checked Flat Metro peer hues in canonical index order (0..11).
// Indices >= 12 dynamically generate unique golden-angle HSL fills via .tile-custom CSS vars.
const PEER_COLOR_THEMES = [
  "tile-mint",
  "tile-cobalt",
  "tile-coral",
  "tile-ochre",
  "tile-cyan",
  "tile-magenta",
  "tile-violet",
  "tile-tangerine",
  "tile-lime",
  "tile-teal",
  "tile-indigo",
  "tile-crimson",
];
const ALL_PEER_TILE_CLASSES = [...PEER_COLOR_THEMES, "tile-custom", "is-dark-ink"];

const VOICE_EQ_WEIGHTS = [0.32, 0.54, 0.76, 0.92, 1.0, 1.0, 0.92, 0.76, 0.54, 0.32];
const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const SAFE_VIDEO_DATA_URL_RE = /^data:video\/(mp4|webm|ogg|quicktime);base64,[A-Za-z0-9+/=]+$/;
const SAFE_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/;
const SAFE_VIDEO_DATA_URL_PREFIX_RE = /^data:video\/(mp4|webm|ogg|quicktime);base64,/;
const SAFE_HTTP_URL_RE = /^https?:\/\/[^\s<>"']+$/i;
const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
const MAX_MEDIA_PER_MESSAGE = 3;
const MAX_STATIC_IMAGE_CHARS = 54000;
const MAX_GIF_RAW_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_RAW_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 10 * 1024 * 1024;
const BULK_FRAME_THRESHOLD = 16384; // Frames > 16 KB (GIFs, images, videos, big sync batches) use low-prio p2p-bulk
const DC_CHUNK_THRESHOLD = 16384;
const DC_CHUNK_SIZE = 16384; // Small 16 KB chunks so SCTP/relay immediately preempts for 20ms voice packets
const DC_CHUNK_MAX_PARTS = 2048;
const BULK_DIRECT_MAX_BUFFERED_VOICE = 24576; // 24 KB SCTP ceiling while voice is active (prevents bufferbloat)
const BULK_DIRECT_MAX_BUFFERED_IDLE = 196608; // 192 KB SCTP ceiling when voice is idle
const BULK_DIRECT_TICK_VOICE_MS = 25; // 1 × 16 KB chunk / 25ms (~640 KB/s) while voice is active
const BULK_DIRECT_TICK_IDLE_MS = 8; // up to 4 × 16 KB chunks / 8ms when idle
const RELAY_BULK_CHUNK_SIZE_VOICE = 12288; // 12 KB relay bulk chunks during active voice
const RELAY_BULK_TICK_VOICE_MS = 55; // 1 × 12 KB chunk / 55ms during active voice (yields to voice bundles)
const RELAY_BULK_TICK_IDLE_MS = 20; // up to 3 chunks / 20ms when voice is idle

const SPEAK_STAR_SVG =
  '<svg class="speak-star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,1 14.8,8.2 22,5 16.8,12 22,19 14.8,15.8 12,23 9.2,15.8 2,19 7.2,12 2,5 9.2,8.2"/></svg>';
const MIC_ON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const MIC_OFF_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const HEAD_ON_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19v-5h-3v7h1a2 2 0 0 0 2-2zM3 19a2 2 0 0 0 2 2h1v-7H3z"/></svg>';
const HEAD_OFF_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M3 18v-6a9 9 0 0 1 14.5-7.1"/><path d="M21 12v6"/><path d="M21 19v-5h-3v4"/><path d="M3 19a2 2 0 0 0 2 2h1v-7H3z"/></svg>';
const EXIT_VOICE_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="square" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const LINK_ARROW_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" aria-hidden="true"><path d="M18 13v6H5V6h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
const TRASH_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><line x1="10" y1="11" x2="10" y2="16"/><line x1="14" y1="11" x2="14" y2="16"/></svg>';
const PENCIL_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';

function messageEditRev(m) {
  if (!m || !m.updatedLamport) return "0";
  const lastId =
    Array.isArray(m.edits) && m.edits.length > 0 ? m.edits[m.edits.length - 1].id : "";
  return `${m.updatedLamport}:${m.editCount || 1}:${lastId}`;
}

function isSafeImageDataUrl(src) {
  if (typeof src !== "string") return false;
  if (src.length <= 65536) return SAFE_IMAGE_DATA_URL_RE.test(src);
  return SAFE_IMAGE_DATA_URL_PREFIX_RE.test(src) && src.indexOf('"') < 0 && src.indexOf("<") < 0;
}

function isSafeVideoDataUrl(src) {
  if (typeof src !== "string") return false;
  if (src.length <= 65536) return SAFE_VIDEO_DATA_URL_RE.test(src);
  return SAFE_VIDEO_DATA_URL_PREFIX_RE.test(src) && src.indexOf('"') < 0 && src.indexOf("<") < 0;
}

function isSafeImageSrc(src) {
  if (typeof src !== "string") return false;
  return isSafeImageDataUrl(src) || /^https:\/\/[^\s<>"']+$/i.test(src);
}

function formatBotRichText(raw) {
  const { html } = extractAndLinkify(String(raw || ""));
  return html
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function computeFloat32RmsI16Scale(float32Pcm) {
  if (!float32Pcm || float32Pcm.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < float32Pcm.length; i++) {
    const s = float32Pcm[i];
    sumSq += s * s;
  }
  return Math.min(32767, Math.round(Math.sqrt(sumSq / float32Pcm.length) * 32768));
}

function extractFloat32FromAudioData(audioData) {
  const n = audioData.numberOfFrames;
  const ch = audioData.numberOfChannels || 1;
  const fmt = audioData.format || "f32-planar";
  if (fmt === "f32-planar" || (fmt === "f32" && ch === 1)) {
    const out = new Float32Array(n);
    audioData.copyTo(out, { planeIndex: 0 });
    return out;
  }
  if (fmt === "f32") {
    const interleaved = new Float32Array(n * ch);
    audioData.copyTo(interleaved, { planeIndex: 0 });
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = interleaved[i * ch];
    return out;
  }
  if (fmt === "s16-planar" || (fmt === "s16" && ch === 1)) {
    const tmp = new Int16Array(n);
    audioData.copyTo(tmp, { planeIndex: 0 });
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = tmp[i] / 32768;
    return out;
  }
  if (fmt === "s16") {
    const tmp = new Int16Array(n * ch);
    audioData.copyTo(tmp, { planeIndex: 0 });
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = tmp[i * ch] / 32768;
    return out;
  }
  if (fmt === "s32-planar" || fmt === "s32") {
    const stride = fmt === "s32" ? ch : 1;
    const tmp = new Int32Array(n * stride);
    audioData.copyTo(tmp, { planeIndex: 0 });
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = tmp[i * stride] / 2147483648;
    return out;
  }
  if (fmt === "u8-planar" || fmt === "u8") {
    const stride = fmt === "u8" ? ch : 1;
    const tmp = new Uint8Array(n * stride);
    audioData.copyTo(tmp, { planeIndex: 0 });
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (tmp[i * stride] - 128) / 128;
    return out;
  }
  const fallback = new Float32Array(n);
  audioData.copyTo(fallback, { planeIndex: 0, format: "f32-planar" });
  return fallback;
}

function randomId(prefix) {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function avatarInitials(name) {
  const parts = String(name || "P")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  const single = parts[0] || "P";
  return single.slice(0, 2).toUpperCase();
}

function fallbackPeerColorIndex(seed) {
  const str = String(seed || "peer");
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % PEER_COLOR_THEMES.length;
}

function _hslRelativeLuminance(hDeg, sPct, lPct) {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, sPct / 100));
  const l = Math.max(0, Math.min(1, lPct / 100));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const r = lin(hue2rgb(h + 1 / 3));
  const g = lin(hue2rgb(h));
  const b = lin(hue2rgb(h - 1 / 3));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function colorSpecForIndex(rawIdx) {
  const idx = Number.isInteger(rawIdx) && rawIdx >= 0 ? rawIdx : 0;
  if (idx < PEER_COLOR_THEMES.length) {
    return {
      idx,
      className: PEER_COLOR_THEMES[idx],
      extraClass: "",
      styleAttr: "",
      bg: null,
      bgMuted: null,
      fg: null,
    };
  }
  // Golden-angle stepping guarantees unlimited distinct hues with zero collisions for 13+ peers
  const overflow = idx - PEER_COLOR_THEMES.length;
  const hue = Math.round(((overflow * 137.50776405003785) + 27) % 360);
  const sat = overflow % 2 === 0 ? 84 : 74;
  const light = overflow % 3 === 0 ? 52 : overflow % 3 === 1 ? 42 : 60;
  const bg = `hsl(${hue}, ${sat}%, ${light}%)`;
  const bgMuted = `hsl(${hue}, ${Math.max(26, sat - 44)}%, ${Math.max(28, light - 10)}%)`;
  const lum = _hslRelativeLuminance(hue, sat, light);
  const isDarkInk = lum > 0.36;
  const fg = isDarkInk ? "#0e0f12" : "#ffffff";
  return {
    idx,
    className: "tile-custom",
    extraClass: isDarkInk ? " is-dark-ink" : "",
    styleAttr: `--tile-bg:${bg};--tile-bg-muted:${bgMuted};--tile-fg:${fg}`,
    bg,
    bgMuted,
    fg,
  };
}

function applyPeerColorToElement(el, spec) {
  if (!el || !spec) return;
  for (const cls of ALL_PEER_TILE_CLASSES) {
    el.classList.remove(cls);
  }
  el.classList.add(spec.className);
  if (spec.extraClass) {
    for (const extra of spec.extraClass.trim().split(/\s+/)) {
      if (extra) el.classList.add(extra);
    }
  }
  if (spec.bg) {
    el.style.setProperty("--tile-bg", spec.bg);
    el.style.setProperty("--tile-bg-muted", spec.bgMuted);
    el.style.setProperty("--tile-fg", spec.fg);
  } else {
    el.style.removeProperty("--tile-bg");
    el.style.removeProperty("--tile-bg-muted");
    el.style.removeProperty("--tile-fg");
  }
}

function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function extractAndLinkify(text) {
  const raw = String(text || "");
  const links = [];
  const seenHref = new Set();
  let html = "";
  let lastIndex = 0;

  URL_REGEX.lastIndex = 0;
  let match;
  while ((match = URL_REGEX.exec(raw)) !== null) {
    const start = match.index;
    let candidate = match[0];
    let trailing = "";

    // Trim trailing sentence punctuation or unmatched closing brackets
    while (candidate.length > 0) {
      const last = candidate[candidate.length - 1];
      if (".!?,;:".includes(last)) {
        trailing = last + trailing;
        candidate = candidate.slice(0, -1);
      } else if (last === ")" && (candidate.match(/\(/g) || []).length < (candidate.match(/\)/g) || []).length) {
        trailing = last + trailing;
        candidate = candidate.slice(0, -1);
      } else if (last === "]" && (candidate.match(/\[/g) || []).length < (candidate.match(/\]/g) || []).length) {
        trailing = last + trailing;
        candidate = candidate.slice(0, -1);
      } else {
        break;
      }
    }

    html += escapeHtml(raw.slice(lastIndex, start));
    let parsed = null;
    try {
      const u = new URL(candidate);
      if (u.protocol === "http:" || u.protocol === "https:") {
        parsed = u;
      }
    } catch {
      parsed = null;
    }

    if (parsed) {
      const safeHref = escapeHtml(parsed.href);
      html += `<a class="chat-link" href="${safeHref}" target="_blank" rel="noopener noreferrer">${escapeHtml(candidate)}</a>`;
      if (!seenHref.has(parsed.href)) {
        seenHref.add(parsed.href);
        const pathLabel =
          (parsed.pathname === "/" ? "" : parsed.pathname) + (parsed.search || "") + (parsed.hash || "");
        links.push({
          href: parsed.href,
          host: parsed.hostname.replace(/^www\./, ""),
          path: pathLabel || parsed.pathname || "/",
        });
      }
    } else {
      html += escapeHtml(candidate);
    }

    html += escapeHtml(trailing);
    lastIndex = start + match[0].length;
  }

  html += escapeHtml(raw.slice(lastIndex));
  return { html, links };
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode pasted image"));
    };
    img.src = url;
  });
}

async function compressImageFile(file, maxChars = 54000) {
  const img = await loadImageFromFile(file);
  const origW = img.naturalWidth || img.width || 1;
  const origH = img.naturalHeight || img.height || 1;

  const attempts = [
    { maxDim: 880, quality: 0.8 },
    { maxDim: 760, quality: 0.68 },
    { maxDim: 620, quality: 0.56 },
    { maxDim: 480, quality: 0.46 },
    { maxDim: 360, quality: 0.38 },
  ];

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }

  let best = null;
  for (const { maxDim, quality } of attempts) {
    const scale = Math.min(1, maxDim / Math.max(origW, origH));
    const w = Math.max(1, Math.round(origW * scale));
    const h = Math.max(1, Math.round(origH * scale));
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    let dataUrl = canvas.toDataURL("image/webp", quality);
    if (!dataUrl.startsWith("data:image/webp")) {
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    best = {
      id: randomId("img"),
      kind: "image",
      animated: false,
      mime: dataUrl.startsWith("data:image/webp") ? "image/webp" : "image/jpeg",
      dataUrl,
      width: w,
      height: h,
      name: file.name || "pasted-image.webp",
      bytes: Math.round((dataUrl.length * 3) / 4),
    };
    if (dataUrl.length <= maxChars) {
      return best;
    }
  }
  return best;
}

const EXT_TO_MEDIA_MIME = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  ogg: "video/ogg",
  mov: "video/quicktime",
});

const SUPPORTED_MEDIA_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
]);

function inferMediaMime(file) {
  if (!file) return null;
  const rawType = String(file.type || "").split(";")[0].trim().toLowerCase();
  if (rawType === "image/jpg") return "image/jpeg";
  if (SUPPORTED_MEDIA_MIMES.has(rawType)) return rawType;
  const name = String(file.name || "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot >= 0) {
    const ext = name.slice(dot + 1);
    if (EXT_TO_MEDIA_MIME[ext]) return EXT_TO_MEDIA_MIME[ext];
  }
  return null;
}

function isAnimatedWebpBytes(bytes) {
  if (!bytes || bytes.length < 24) return false;
  // RIFF....WEBP containing VP8X animation flag or ANIM chunk in header
  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return false;
  }
  for (let i = 12; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x41 && bytes[i + 1] === 0x4e && bytes[i + 2] === 0x49 && bytes[i + 3] === 0x4d) {
      return true;
    }
  }
  return false;
}

function fileToDataUrl(file, forcedMime) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      let res = typeof reader.result === "string" ? reader.result : "";
      const comma = res.indexOf(",");
      if (comma < 0) {
        reject(new Error("Failed to read file bytes"));
        return;
      }
      if (forcedMime) {
        const b64 = res.slice(comma + 1);
        res = `data:${forcedMime};base64,${b64}`;
      }
      resolve(res);
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const mimeMatch = /^data:([^;,]+);base64$/i.exec(header);
  if (!mimeMatch) return null;
  try {
    const b64 = dataUrl.slice(comma + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeMatch[1] });
  } catch {
    return null;
  }
}

async function dataUrlToBlobAsync(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const mimeMatch = /^data:([^;,]+);base64$/i.exec(header);
  if (!mimeMatch) return null;
  try {
    if (typeof fetch === "function") {
      const resp = await fetch(dataUrl);
      const rawBlob = await resp.blob();
      if (rawBlob && rawBlob.size > 0) {
        return rawBlob.type === mimeMatch[1]
          ? rawBlob
          : new Blob([rawBlob], { type: mimeMatch[1] });
      }
    }
  } catch {
    // fall back to synchronous decode
  }
  return dataUrlToBlob(dataUrl);
}

function probeVideoMetadata(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    let done = false;
    const finish = (meta) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // ignore
      }
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    const timer = setTimeout(() => finish({ width: 0, height: 0, duration: 0 }), 3000);
    video.onloadedmetadata = () => {
      const dur = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 10) / 10 : 0;
      finish({
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: dur,
      });
    };
    video.onerror = () => finish({ width: 0, height: 0, duration: 0 });
    video.src = url;
  });
}

function formatMediaDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

async function prepareMediaFile(file, mime, remainingBytes) {
  if (mime.startsWith("video/")) {
    if (file.size > MAX_VIDEO_RAW_BYTES) {
      throw new Error(
        `Video is ${formatByteSize(file.size)} (max ${formatByteSize(MAX_VIDEO_RAW_BYTES)})`
      );
    }
    if (file.size > remainingBytes) {
      throw new Error("Exceeds 10 MB per-message attachment limit — send staged media first");
    }
    const [dataUrl, meta] = await Promise.all([
      fileToDataUrl(file, mime),
      probeVideoMetadata(file),
    ]);
    if (!isSafeVideoDataUrl(dataUrl)) {
      throw new Error("Unsupported video encoding");
    }
    return {
      id: randomId("vid"),
      kind: "video",
      animated: true,
      mime,
      dataUrl,
      previewUrl: URL.createObjectURL(file),
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
      name: file.name || `clip.${mime.split("/")[1] || "mp4"}`,
      bytes: file.size || Math.round((dataUrl.length * 3) / 4),
    };
  }

  let preserveAnimated = mime === "image/gif";
  if (!preserveAnimated && mime === "image/webp" && typeof file.slice === "function") {
    try {
      const head = new Uint8Array(await file.slice(0, 128).arrayBuffer());
      preserveAnimated = isAnimatedWebpBytes(head);
    } catch {
      preserveAnimated = false;
    }
  }

  if (preserveAnimated) {
    if (file.size > MAX_GIF_RAW_BYTES) {
      throw new Error(
        `Animated GIF/WebP is ${formatByteSize(file.size)} (max ${formatByteSize(MAX_GIF_RAW_BYTES)})`
      );
    }
    if (file.size > remainingBytes) {
      throw new Error("Exceeds 10 MB per-message attachment limit — send staged media first");
    }
    const dataUrl = await fileToDataUrl(file, mime);
    if (!isSafeImageDataUrl(dataUrl)) {
      throw new Error("Unsupported animated image encoding");
    }
    let width = 0;
    let height = 0;
    try {
      const img = await loadImageFromFile(file);
      width = img.naturalWidth || img.width || 0;
      height = img.naturalHeight || img.height || 0;
    } catch {
      // keep dimensions 0 if probe fails
    }
    return {
      id: randomId("gif"),
      kind: "gif",
      animated: true,
      mime,
      dataUrl,
      width,
      height,
      name: file.name || "animated.gif",
      bytes: file.size || Math.round((dataUrl.length * 3) / 4),
    };
  }

  const charBudget = Math.min(MAX_STATIC_IMAGE_CHARS, Math.floor((remainingBytes * 4) / 3));
  const compressed = await compressImageFile(file, Math.max(12000, charBudget));
  if (!isSafeImageDataUrl(compressed.dataUrl)) {
    throw new Error("Unsupported image encoding");
  }
  return compressed;
}

function formatTime(tsMs) {
  try {
    const d = new Date(tsMs);
    return d.toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(tsMs);
  }
}

function basePageUrl() {
  return `${window.location.origin}${window.location.pathname}${window.location.search}`;
}

function shareableBaseUrl() {
  try {
    const u = new URL(window.location.href);
    u.hash = "";
    u.searchParams.delete("profile");
    return u.toString();
  } catch {
    return basePageUrl();
  }
}

function rmsToLevel(rms) {
  if (!rms || rms <= 0) return 0;
  const norm = Math.min(1, rms / 5500);
  return Math.min(1, Math.pow(norm, 0.48));
}

function waitForIceGathering(pc, maxWaitMs = 1400) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let candidateTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (candidateTimer) clearTimeout(candidateTimer);
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCand);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === "complete") {
        finish();
      }
    };
    const onCand = (ev) => {
      if (!ev.candidate) {
        finish();
      } else if (!candidateTimer) {
        candidateTimer = setTimeout(finish, 600);
      }
    };
    const hardTimer = setTimeout(finish, maxWaitMs);
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCand);
  });
}

class P2PDirectApp {
  constructor() {
    this.wasm = null;
    this.profile = null;
    this.status = null;
    this.logMessages = [];
    this.logRenderState = {
      mode: "", // "empty" | "raw" | "chat"
      key: "",
    };
    this.advancedMode = false;
    this.rawJsonMode = false;
    this.editingMessageId = null;
    this.expandedEditHistory = new Set();
    this.composerMode = "chat";
    this.pendingImages = [];
    this.mediaBlobRegistry = new Map(); // msgId -> Set<blobUrl>
    this.lightboxState = null; // { kind, blob, dataUrl, tempUrl, syncTargetId, gifBinding, videoBinding }
    this.dcChunkSeq = 0;

    // Room-wide E2EE Synchronized Media (Videos, GIFs) & Watch Together (YouTube/Spotify/SoundCloud)
    // Volume and mute are STRICTLY local-only and never included in mediaSync state.
    this.mediaSync = {
      states: new Map(), // targetId -> MediaSyncState
      videoBindings: new Map(), // "vid:<msgId>:<idx>" -> binding obj
      gifBindings: new Map(), // "gif:<msgId>:<idx>" -> binding obj
      gifRafId: null,
      boundGifTick: () => this._tickSyncedGifs(),
      driftTimer: null,
      watchPlayer: null,
      watchPanelOpenManual: false,
      watchMinimized: false,
      watchScrubbing: false,
      watchUiTimer: null,
      watchTitleOverride: "",
      watchDurationMs: 0,
      watchPlaylistCount: 0,
      watchPlaylistItems: [],
      watchTracksOpen: false,
      watchSpotifyTrackDetached: false,
      lightboxVideoApplying: false,
      lightboxVideoSuppressUntil: 0,
    };
    this.telemetry = [];
    this.toastTimer = null;

    // Collapsible & pinnable Advanced rail sections (default: ALL collapsed, NONE pinned)
    this.advPanels = {
      open: new Set(),
      pinned: new Set(),
    };

    // Interactive real-time network topology graph & live packet animation engine
    this.topo = {
      selectedId: null,
      positions: new Map(), // nodeId -> { x, y }
      customPositions: new Map(), // user-dragged nodeId -> { x, y }
      draggingId: null,
      dragStartClient: null,
      dragMoved: false,
      particles: [], // { fromId, toId, kind: "voice"|"data", t, durationMs, color }
      lastParticleAt: new Map(), // `${peerId}:${dir}:${kind}` -> ms
      linkStats: new Map(), // peerId -> { txTotal, rxTotal, txBytes, rxBytes, txWin, rxWin, txBytesWin, rxBytesWin, txPps, rxPps, kbps, winStartMs, lastPacketAt }
      peerTech: new Map(), // peerId -> { shortLabel, detailLabel, protocol, localType, remoteType, statsRttMs, brokerHost }
      rafId: null,
      lastFrameMs: 0,
      lastInspectorTickMs: 0,
      statsTimer: null,
      svgInitialized: false,
      particlePool: [],
      boundTick: (ts) => this._topologyTick(ts),
    };

    // Step-by-step Connect Wizard state
    this.wizard = {
      mode: "idle", // "idle" | "host" | "join"
      step: 1, // 1 | 2 | 3
      hostCopied: false,
      joinCopied: false,
      peerName: "",
      offerMeta: "",
      answerMeta: "",
      offerHint: "",
      answerHint: "",
    };

    // Out-of-band manual signaling state
    this.pendingOffers = new Map();
    this.pendingAnswers = new Map();
    this.latestOffer = null;
    this.latestAnswer = null;

    // Live WebRTC transport maps (3-tier QoS: high voice > medium chat/control > very-low bulk media)
    this.directPeers = new Map();
    this.voiceChannels = new Map(); // peerId -> RTCDataChannel("p2p-voice") [high priority]
    this.bulkChannels = new Map(); // peerId -> RTCDataChannel("p2p-bulk") [very-low priority]
    this.lastVoiceTrafficAtMs = 0;
    this.relayPeers = new Map();
    this.earlyRelayIce = new Map();

    // Same-browser BroadcastChannel 1-click local discovery & tab handoff
    this.bc = null;
    this.discoveredLocalMeshes = new Map();
    this.localDialing = new Map();
    this.earlyLocalIce = new Map();

    // Long-lived reusable room link & encrypted MQTT rendezvous state
    this.activeRoom = null; // { name, code, url, topic, relay, encrypted }
    this.savedRooms = [];
    this.lastJoinedRoom = null;
    this.editingSavedRoomTopic = null;
    this.savedRoomsFilter = "";
    this.savedRoomsCollapsed = false;
    this.advSavedRoomsFilter = "";
    this.mobileAdvTab = "chat";
    this.voiceStatsCompact = false;
    this.collapsedVoiceStatsCards = new Set();
    this.roomRendezvous = null;
    this.roomRelayStatus = { state: "stopped", connectedCount: 0, totalCount: 0 };
    this.roomDialing = new Map();
    this.earlyRoomIce = new Map();
    this.seenRoomSignalIds = new Map();
    this.lastHelloReplyPerPeer = new Map();
    this.pendingRoomCode = null;

    // Zero-TURN E2EE Relay Fallback & automatic Direct P2P upgrade state
    this.roomMyTag = null; // { topic, peerId, bytes, hex }
    this.roomKnownPeers = new Map(); // peerId -> { name, pk, relays, tagBytes, tagHex, lastSeenMs }
    this.roomTagToPeerId = new Map(); // tagHex -> peerId
    this.relayPendingOpens = new Map(); // peerId -> { startedAt, retryTimer }
    this.earlyRelayDataFrames = new Map(); // fromHex -> [{ frame, ts }]
    this.relayChunkAssemblies = new Map(); // key -> { total, parts, received, ts }
    this.seenRelayChunkKeys = new Map(); // key -> ts
    this.relayVoiceReorder = new Map(); // fromHex -> { expectedSeq, pending, seen, flushTimer }
    this.directUpgradeState = new Map(); // peerId -> { lastAttemptAt, attempts }
    this.relayDataMsgSeq = 1;

    // Background-resilient Web Worker keepalive
    this.keepaliveWorker = null;
    this.keepaliveFallbackTimer = null;
    this.keepaliveTickCount = 0;

    // Personal audio settings (session-only; zero permanent storage)
    this.audioSettings = loadSessionAudioSettings();

    // Negotiated voice codec capability per peer ("opus48" | "adpcm16")
    this.peerVoiceCodec = new Map();

    // Canonical duplicate-free peer color registry synced across all peers via Safe Rust WASM
    this.peerColors = new Map(); // peerId -> colorIdx (u32)

    // Tracks explicit local changes for live same-browser multi-tab sync
    this._userCustomizedName = false;
    this._userCustomizedTheme = false;
    this._userCustomizedAudio = false;

    // Real-time multi-peer voice channel state
    this.voice = {
      inVoice: false,
      muted: false,
      deafened: false,
      listenOnly: false,
      opusSupported: false,
      opusUseRichConfig: false,
      opusEncoder: null,
      opusEncoderBitrate: 0,
      opusTxSampleCounter: 0,
      opusPendingMeta: [],
      opusTxBuf: new Uint8Array(2048),
      workletsLoaded: false,
      workletsLoadingPromise: null,
      audioCtx: null,
      micStream: null,
      micSource: null,
      highPassFilter: null,
      presenceFilter: null,
      compressorNode: null,
      micGainNode: null,
      monitorGain: null,
      monitorActive: false,
      captureNode: null,
      silentGain: null,
      masterGain: null,
      masterLimiter: null,
      gateClosed: false,
      settingsOpen: false,
      preCallMonitor: null, // { ctx, stream, source, highPass, presence, compressor, micGain, monitorGain, analyser, timer }
      audioDevices: [],
      peerMixers: new Map(), // peerId -> { gainNode, playbackNode, opusDecoder, codec, isRelayed, volume, muted, nextPlayTime, rms, smoothLevel, lastAudioAt, packetsReceived, decodedFrames }
      joinOrder: [], // ordered participant keys (peerId or "self") so cards never jump when joining
      localRms: 0,
      rawMicRms: 0,
      peakMicRms: 0,
      localSmoothLevel: 0,
      localSpeakingAt: 0,
      txWindow: [],
      txKbps: 0,
      txPps: 0,
      txDropped: 0,
      meterTimer: null,
      meterTicks: 0,
      lastRosterKey: "",
      renderedKeys: new Set(),
      cardCache: new Map(),
      lastCounterSig: "",
    };

    this.iceConfig = ICE_CONFIG;
    this.el = {};
  }

  createPeerConnection() {
    return new RTCPeerConnection(this.iceConfig || ICE_CONFIG);
  }

  _createDataChannelSafe(pc, label, opts) {
    try {
      return pc.createDataChannel(label, opts);
    } catch {
      const { priority: _ignored, ...fallbackOpts } = opts || {};
      return pc.createDataChannel(label, fallbackOpts);
    }
  }

  /**
   * Creates 3 QoS-separated WebRTC DataChannels over the peer connection:
   * - `p2p-voice`: unordered, 0 retransmits, HIGH SCTP priority (realtime Opus/ADPCM audio)
   * - `p2p-mesh`: ordered, MEDIUM SCTP priority (small chat messages, sync, presence, keepalive)
   * - `p2p-bulk`: ordered, VERY-LOW SCTP priority (GIFs, images, videos, large data > 16 KB)
   */
  createPeerDataChannels(pc) {
    const dc = this._createDataChannelSafe(pc, "p2p-mesh", {
      ordered: true,
      priority: "medium",
    });
    const voiceDc = this._createDataChannelSafe(pc, "p2p-voice", {
      ordered: false,
      maxRetransmits: 0,
      priority: "high",
    });
    const bulkDc = this._createDataChannelSafe(pc, "p2p-bulk", {
      ordered: true,
      priority: "very-low",
    });
    return { dc, voiceDc, bulkDc };
  }

  noteVoiceTraffic() {
    this.lastVoiceTrafficAtMs = Date.now();
  }

  isVoiceChannelBusy() {
    if (this.voice.inVoice) return true;
    if (Date.now() - this.lastVoiceTrafficAtMs < 1500) return true;
    return Boolean((this.status?.peers || []).some((p) => p.inVoice));
  }

  bindElements() {
    const ids = [
      "author-name-input",
      "key-fp-display",
      "peer-id-display",
      "lamport-display",
      "mesh-status-chip",
      "mesh-status-dot",
      "peer-count-display",
      "voice-header-chip",
      "voice-header-count",
      "log-count-display",
      "btn-pwa-install",
      "btn-advanced-toggle",
      "btn-theme-toggle",
      "icon-moon",
      "icon-sun",
      "room-lobby",
      "lobby-create-form",
      "lobby-room-name-input",
      "btn-lobby-create-room",
      "lobby-join-form",
      "lobby-room-link-input",
      "btn-lobby-join-room",
      "lobby-passphrase-box",
      "lobby-passphrase-form",
      "lobby-passphrase-input",
      "btn-lobby-unlock-room",
      "lobby-notice",
      "simple-room-bar",
      "simple-room-name",
      "simple-room-status-wrap",
      "simple-room-badge",
      "btn-simple-copy-link",
      "btn-simple-leave-room",
      "connect-panel-title",
      "btn-wizard-reset",
      "connect-panel-meta",
      "local-mesh-banner",
      "local-mesh-fp",
      "local-mesh-desc",
      "btn-join-local-mesh",
      "room-link-card",
      "room-link-setup",
      "room-name-input",
      "btn-create-room-link",
      "room-link-active",
      "room-active-name",
      "room-relay-badge",
      "room-active-hint",
      "room-link-output",
      "btn-room-copy-url",
      "btn-room-share",
      "btn-room-new",
      "btn-room-leave",
      "wizard-role-picker",
      "btn-wizard-start-host",
      "btn-wizard-start-join",
      "wizard-host-flow",
      "wizard-host-step-1",
      "host-step-1-badge",
      "host-offer-meta",
      "host-step-1-body",
      "host-step-1-hint",
      "btn-host-copy-url",
      "btn-host-copy-code",
      "btn-host-share",
      "host-offer-code",
      "wizard-host-step-2",
      "host-step-2-badge",
      "host-step-2-body",
      "host-answer-input",
      "btn-host-paste-answer",
      "btn-host-apply-answer",
      "wizard-host-step-3",
      "host-step-3-badge",
      "host-step-3-title",
      "host-step-3-body",
      "host-step-3-detail",
      "btn-host-invite-another",
      "btn-host-done",
      "wizard-join-flow",
      "wizard-join-step-1",
      "join-step-1-badge",
      "join-step-1-title",
      "join-step-1-body",
      "join-offer-input",
      "btn-join-paste-offer",
      "btn-join-create-reply",
      "wizard-join-step-2",
      "join-step-2-badge",
      "join-answer-meta",
      "join-step-2-body",
      "join-step-2-hint",
      "btn-join-copy-url",
      "btn-join-copy-code",
      "btn-join-share",
      "join-answer-code",
      "wizard-join-step-3",
      "join-step-3-badge",
      "join-step-3-title",
      "join-step-3-body",
      "join-step-3-detail",
      "btn-join-done",
      "connect-notice",
      "e2ee-key-details",
      "e2ee-mode-label",
      "e2ee-passphrase-input",
      "btn-apply-passphrase",
      "btn-clear-passphrase",
      "e2ee-bar-hint",
      "voice-panel",
      "voice-status-badge",
      "btn-voice-settings",
      "voice-settings-drawer",
      "audio-custom-badge",
      "btn-audio-monitor",
      "btn-audio-reset",
      "btn-audio-close",
      "audio-input-select",
      "audio-output-field",
      "audio-output-select",
      "audio-monitor-hint",
      "audio-mic-meter-status",
      "audio-mic-gain",
      "audio-mic-gain-val",
      "audio-mic-meter-fill",
      "audio-gate-zone",
      "audio-gate-marker",
      "audio-output-gain",
      "audio-output-gain-val",
      "audio-noise-gate",
      "audio-noise-gate-val",
      "audio-highpass",
      "audio-highpass-val",
      "audio-presence",
      "audio-presence-val",
      "audio-compressor",
      "audio-ec",
      "audio-ns",
      "audio-agc",
      "voice-join-card",
      "btn-voice-join",
      "btn-voice-listen",
      "voice-participant-list",
      "voice-footer",
      "voice-codec-meta",
      "voice-join-hint",
      "voice-packet-stats",
      "voice-notice",
      "network-panel-meta",
      "topology-summary",
      "btn-topo-reset",
      "btn-sync-now",
      "topology-svg",
      "topology-inspector",
      "profile-slot-label",
      "auto-mesh-toggle",
      "auto-mesh-badge",
      "peer-list",
      "bot-cli-command",
      "btn-copy-bot-cmd",
      "stat-e2ee",
      "stat-batches",
      "stat-voice",
      "telemetry-log",
      "btn-turn-test",
      "turn-test-status",
      "chat-panel",
      "chat-drop-overlay",
      "chat-composer-dropzone",
      "chat-image-tray",
      "chat-image-input",
      "btn-attach-image",
      "btn-toggle-raw",
      "btn-export-encrypted",
      "btn-export-log",
      "btn-clear-local-log",
      "log-search-input",
      "log-type-filter",
      "log-feed",
      "mode-btn-chat",
      "mode-btn-json",
      "next-lamport-preview",
      "chat-composer-form",
      "chat-text-input",
      "json-composer-form",
      "json-type-input",
      "json-payload-input",
      "composer-error",
      "image-lightbox",
      "btn-lightbox-close",
      "lightbox-gif-wrap",
      "lightbox-img",
      "lightbox-gif-canvas",
      "lightbox-video",
      "lightbox-toolbar",
      "btn-lightbox-replay",
      "btn-lightbox-loop",
      "lightbox-meta",
      "btn-open-watch-panel",
      "watch-panel",
      "watch-provider-badge",
      "watch-panel-title",
      "watch-sync-meta",
      "watch-open-external",
      "btn-watch-minimize",
      "btn-watch-close",
      "watch-body",
      "watch-stage-wrap",
      "watch-embed-stage",
      "btn-watch-autoplay-unmute",
      "watch-playlist-bar",
      "watch-playlist-status",
      "btn-watch-spotify-playlist",
      "btn-watch-tracks-toggle",
      "watch-playlist-tracks",
      "watch-transport",
      "btn-watch-prev",
      "btn-watch-play",
      "btn-watch-back10",
      "btn-watch-fwd10",
      "btn-watch-replay",
      "btn-watch-next",
      "btn-watch-loop",
      "watch-speed-select",
      "watch-time-cur",
      "watch-scrubber",
      "watch-time-dur",
      "watch-local-vol-row",
      "btn-watch-local-mute",
      "watch-local-volume",
      "watch-local-vol-val",
      "watch-queue-section",
      "watch-url-form",
      "watch-url-input",
      "btn-watch-load-now",
      "btn-watch-queue-add",
      "watch-queue-head",
      "watch-queue-count",
      "watch-queue-list",
      "lobby-saved-section",
      "lobby-saved-count",
      "btn-lobby-saved-toggle",
      "lobby-last-room-wrap",
      "lobby-saved-filter-wrap",
      "lobby-saved-filter",
      "lobby-saved-filter-meta",
      "btn-lobby-saved-filter-clear",
      "lobby-saved-rooms-grid",
      "mobile-adv-nav",
      "mobile-tab-rooms-badge",
      "mobile-tab-peers-badge",
      "btn-voice-stats-toggle",
      "btn-simple-save-room",
      "simple-save-room-icon",
      "simple-save-room-label",
      "btn-room-save",
      "adv-saved-rooms-card",
      "adv-saved-rooms-count",
      "adv-saved-filter-wrap",
      "adv-saved-filter",
      "adv-saved-rooms-list",
      "toast",
    ];
    for (const id of ids) {
      this.el[id] = document.getElementById(id);
    }
  }

  bindEvents() {
    // Simple vs Advanced mode toggle, PWA install & Lobby / Simple Room Bar controls
    this.el["btn-advanced-toggle"].addEventListener("click", () => this.toggleAdvancedMode());
    if (this.el["btn-pwa-install"]) {
      this.el["btn-pwa-install"].addEventListener("click", () => this.promptPwaInstall());
    }
    if (this.el["btn-turn-test"]) {
      this.el["btn-turn-test"].addEventListener("click", () => this.runIceSelfTest());
    }
    this.el["lobby-create-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.createRoomFromLobby();
    });
    this.el["lobby-join-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.joinRoomFromLobby();
    });
    this.el["lobby-passphrase-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.unlockRoomFromLobby();
    });
    if (this.el["btn-lobby-saved-toggle"]) {
      this.el["btn-lobby-saved-toggle"].addEventListener("click", () => {
        this.savedRoomsCollapsed = !this.savedRoomsCollapsed;
        this.renderSavedRooms();
      });
    }
    if (this.el["lobby-saved-filter"]) {
      this.el["lobby-saved-filter"].addEventListener("input", (ev) => {
        this.savedRoomsFilter = String(ev.target.value || "");
        this.renderSavedRooms();
      });
    }
    if (this.el["btn-lobby-saved-filter-clear"]) {
      this.el["btn-lobby-saved-filter-clear"].addEventListener("click", () => {
        this.savedRoomsFilter = "";
        if (this.el["lobby-saved-filter"]) {
          this.el["lobby-saved-filter"].value = "";
          this.el["lobby-saved-filter"].focus();
        }
        this.renderSavedRooms();
      });
    }
    if (this.el["adv-saved-filter"]) {
      this.el["adv-saved-filter"].addEventListener("input", (ev) => {
        this.advSavedRoomsFilter = String(ev.target.value || "");
        this.renderSavedRooms();
      });
    }
    for (const tabBtn of document.querySelectorAll("[data-mobile-tab-btn]")) {
      tabBtn.addEventListener("click", () => {
        const tab = tabBtn.getAttribute("data-mobile-tab-btn");
        if (tab) this.setMobileAdvTab(tab);
      });
    }
    if (this.el["btn-voice-stats-toggle"]) {
      this.el["btn-voice-stats-toggle"].addEventListener("click", () => this.toggleVoiceStatsCompact());
    }
    if (this.el["voice-participant-list"]) {
      this.el["voice-participant-list"].addEventListener("click", (ev) => {
        const head = ev.target?.closest?.(".vas-head");
        if (!head) return;
        const plate = head.closest("[data-voice-adv-stats]");
        const key = plate?.getAttribute("data-voice-adv-stats");
        if (key) this.toggleVoiceCardStatsCollapsed(key);
      });
    }
    if (this.el["btn-simple-save-room"]) {
      this.el["btn-simple-save-room"].addEventListener("click", () => this.toggleSaveActiveRoom());
    }
    this.el["btn-simple-copy-link"].addEventListener("click", () => {
      if (!this.activeRoom) return;
      this.copyText(
        this.activeRoom.url,
        "Copied room link — anyone who opens it joins automatically"
      );
    });
    this.el["btn-simple-leave-room"].addEventListener("click", () => this.leaveLongLivedRoom());

    // Passphrase controls
    this.el["btn-apply-passphrase"].addEventListener("click", () => this.applyPassphrase());
    this.el["btn-clear-passphrase"].addEventListener("click", () => this.clearPassphrase());
    this.el["e2ee-passphrase-input"].addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.applyPassphrase();
      }
    });

    // Long-lived reusable room link controls
    this.el["btn-create-room-link"].addEventListener("click", () =>
      this.createLongLivedRoom({ freshKey: false })
    );
    this.el["room-name-input"].addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.createLongLivedRoom({ freshKey: false });
      }
    });
    this.el["room-link-output"].addEventListener("click", () => {
      this.el["room-link-output"].select();
    });
    this.el["btn-room-copy-url"].addEventListener("click", () => {
      if (!this.activeRoom) return;
      this.copyText(
        this.activeRoom.url,
        "Copied room link — anyone who opens it joins automatically"
      );
    });
    if (this.el["btn-room-save"]) {
      this.el["btn-room-save"].addEventListener("click", () => this.toggleSaveActiveRoom());
    }
    this.el["btn-room-share"].addEventListener("click", async () => {
      if (!this.activeRoom || typeof navigator.share !== "function") return;
      try {
        await navigator.share({
          title: `Join ${this.activeRoom.name || "my room"} on p2p-direct`,
          url: this.activeRoom.url,
        });
      } catch {
        // user canceled share sheet
      }
    });
    this.el["btn-room-new"].addEventListener("click", () =>
      this.createLongLivedRoom({ freshKey: true })
    );
    this.el["btn-room-leave"].addEventListener("click", () => this.leaveLongLivedRoom());

    // Cross-tab live sync for locally saved rooms & last joined room
    window.addEventListener("storage", (ev) => {
      if (ev.key === SAVED_ROOMS_KEY || ev.key === LAST_ROOM_KEY || ev.key === null) {
        this.savedRooms = loadSavedRooms();
        this.lastJoinedRoom = loadLastJoinedRoom();
        this.renderSavedRooms();
      }
    });

    // Quick local tab discovery banner
    this.el["btn-join-local-mesh"].addEventListener("click", () => this.joinDiscoveredLocalMesh());

    // Step-by-Step Connect Wizard controls
    this.el["btn-wizard-start-host"].addEventListener("click", () => this.createManualInvite(false));
    this.el["btn-wizard-start-join"].addEventListener("click", () => {
      this.openJoinWizard();
      this.el["join-offer-input"].focus();
    });
    this.el["btn-wizard-reset"].addEventListener("click", () => this.resetWizard());

    // Host Wizard actions
    this.el["btn-host-copy-url"].addEventListener("click", () => {
      if (!this.latestOffer) return;
      this.copyText(this.latestOffer.url, "Copied #offer= invite link — now paste your peer's reply in Step 2");
      this.markHostInviteShared();
    });
    this.el["btn-host-copy-code"].addEventListener("click", () => {
      if (!this.latestOffer) return;
      this.copyText(this.latestOffer.code, "Copied P2P1: invite code — now paste your peer's reply in Step 2");
      this.markHostInviteShared();
    });
    this.el["btn-host-share"].addEventListener("click", async () => {
      if (!this.latestOffer || typeof navigator.share !== "function") return;
      try {
        await navigator.share({
          title: "Join my p2p-direct room",
          url: this.latestOffer.url,
        });
        this.markHostInviteShared();
      } catch {
        // user canceled share sheet
      }
    });
    this.el["btn-host-paste-answer"].addEventListener("click", () =>
      this.pasteIntoField("host-answer-input", (val) => this.handleHostAnswerSubmit(val))
    );
    this.el["btn-host-apply-answer"].addEventListener("click", () =>
      this.handleHostAnswerSubmit(this.el["host-answer-input"].value)
    );
    this.el["host-answer-input"].addEventListener("paste", () => {
      setTimeout(() => {
        const val = this.el["host-answer-input"].value.trim();
        if (
          val.includes("P2P1:") ||
          val.includes("#answer=") ||
          val.includes("#offer=") ||
          val.includes("#room=") ||
          val.includes("#join=")
        ) {
          this.handleHostAnswerSubmit(val);
        }
      }, 0);
    });
    this.el["btn-host-invite-another"].addEventListener("click", () => this.createManualInvite(false));
    this.el["btn-host-done"].addEventListener("click", () => this.resetWizard());

    // Joiner Wizard actions
    this.el["btn-join-paste-offer"].addEventListener("click", () =>
      this.pasteIntoField("join-offer-input", (val) => this.handleJoinOfferSubmit(val))
    );
    this.el["btn-join-create-reply"].addEventListener("click", () =>
      this.handleJoinOfferSubmit(this.el["join-offer-input"].value)
    );
    this.el["join-offer-input"].addEventListener("paste", () => {
      setTimeout(() => {
        const val = this.el["join-offer-input"].value.trim();
        if (
          val.includes("P2P1:") ||
          val.includes("#offer=") ||
          val.includes("#answer=") ||
          val.includes("#room=") ||
          val.includes("#join=")
        ) {
          this.handleJoinOfferSubmit(val);
        }
      }, 0);
    });
    this.el["btn-join-copy-url"].addEventListener("click", () => {
      if (!this.latestAnswer) return;
      this.copyText(this.latestAnswer.url, "Copied #answer= reply link — send it back to connect");
      this.markJoinReplyShared();
    });
    this.el["btn-join-copy-code"].addEventListener("click", () => {
      if (!this.latestAnswer) return;
      this.copyText(this.latestAnswer.code, "Copied P2P1: reply code — send it back to connect");
      this.markJoinReplyShared();
    });
    this.el["btn-join-share"].addEventListener("click", async () => {
      if (!this.latestAnswer || typeof navigator.share !== "function") return;
      try {
        await navigator.share({
          title: "p2p-direct reply link",
          url: this.latestAnswer.url,
        });
        this.markJoinReplyShared();
      } catch {
        // user canceled share sheet
      }
    });
    this.el["btn-join-done"].addEventListener("click", () => this.resetWizard());

    // Real-time Multi-Peer Voice Channel controls (mute/deafen/leave bind dynamically inside your voice tile)
    this.el["btn-voice-join"].addEventListener("click", () => this.joinVoiceChat({ listenOnly: false }));
    this.el["btn-voice-listen"].addEventListener("click", () => this.joinVoiceChat({ listenOnly: true }));

    // Personal Audio Settings (loudness, noise gate, EQ filters, compressor, hardware constraints, mic test)
    if (this.el["btn-voice-settings"]) {
      this.el["btn-voice-settings"].addEventListener("click", () => this.toggleAudioSettingsDrawer());
    }
    if (this.el["btn-audio-close"]) {
      this.el["btn-audio-close"].addEventListener("click", () => this.toggleAudioSettingsDrawer(false));
    }
    for (const btn of document.querySelectorAll("[data-audio-preset]")) {
      btn.addEventListener("click", () => this.applyAudioPreset(btn.dataset.audioPreset));
    }
    if (this.el["btn-audio-monitor"]) {
      this.el["btn-audio-monitor"].addEventListener("click", () => this.toggleMicMonitor());
    }
    if (this.el["btn-audio-reset"]) {
      this.el["btn-audio-reset"].addEventListener("click", () => this.resetAudioSettings());
    }
    if (this.el["audio-input-select"]) {
      this.el["audio-input-select"].addEventListener("change", () =>
        this.updateAudioSetting("deviceId", this.el["audio-input-select"].value, {
          reconnectMic: true,
          keepPreset: true,
        })
      );
    }
    if (this.el["audio-output-select"]) {
      this.el["audio-output-select"].addEventListener("change", () =>
        this.updateAudioSetting("outputDeviceId", this.el["audio-output-select"].value, {
          applyOutputDevice: true,
          keepPreset: true,
        })
      );
    }
    const bindSliderDblClickReset = (elId, key, defaultVal, toastLabel, opts = {}) => {
      const input = this.el[elId];
      if (!input) return;
      input.addEventListener("dblclick", () => {
        if (this.audioSettings[key] === defaultVal) return;
        this.updateAudioSetting(key, defaultVal, opts);
        this.showToast(toastLabel);
      });
    };
    if (this.el["audio-mic-gain"]) {
      this.el["audio-mic-gain"].addEventListener("input", () =>
        this.updateAudioSetting("micGain", Number(this.el["audio-mic-gain"].value))
      );
      bindSliderDblClickReset("audio-mic-gain", "micGain", 100, "My Mic Volume reset to 100%");
    }
    if (this.el["audio-output-gain"]) {
      this.el["audio-output-gain"].addEventListener("input", () =>
        this.updateAudioSetting("outputGain", Number(this.el["audio-output-gain"].value), {
          keepPreset: true,
        })
      );
      bindSliderDblClickReset("audio-output-gain", "outputGain", 100, "Call Volume reset to 100%", {
        keepPreset: true,
      });
    }
    if (this.el["audio-noise-gate"]) {
      this.el["audio-noise-gate"].addEventListener("input", () =>
        this.updateAudioSetting("noiseGate", Number(this.el["audio-noise-gate"].value))
      );
      bindSliderDblClickReset("audio-noise-gate", "noiseGate", 2, "Voice Cutoff reset to 2%");
    }
    if (this.el["audio-highpass"]) {
      this.el["audio-highpass"].addEventListener("change", () =>
        this.updateAudioSetting("highPassHz", Number(this.el["audio-highpass"].value))
      );
    }
    if (this.el["audio-presence"]) {
      this.el["audio-presence"].addEventListener("input", () =>
        this.updateAudioSetting("presenceDb", Number(this.el["audio-presence"].value))
      );
      bindSliderDblClickReset("audio-presence", "presenceDb", 0, "Voice Clarity reset to 0 dB");
    }
    if (this.el["audio-compressor"]) {
      this.el["audio-compressor"].addEventListener("change", () =>
        this.updateAudioSetting("compressor", this.el["audio-compressor"].checked, {
          rewireGraph: true,
        })
      );
    }
    if (this.el["audio-ec"]) {
      this.el["audio-ec"].addEventListener("change", () =>
        this.updateAudioSetting("echoCancellation", this.el["audio-ec"].checked, {
          applyTrackConstraints: true,
        })
      );
    }
    if (this.el["audio-ns"]) {
      this.el["audio-ns"].addEventListener("change", () =>
        this.updateAudioSetting("noiseSuppression", this.el["audio-ns"].checked, {
          applyTrackConstraints: true,
        })
      );
    }
    if (this.el["audio-agc"]) {
      this.el["audio-agc"].addEventListener("change", () =>
        this.updateAudioSetting("autoGainControl", this.el["audio-agc"].checked, {
          applyTrackConstraints: true,
        })
      );
    }
    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        if (this.voice.settingsOpen) {
          this.refreshAudioInputDevices();
        }
      });
    }

    // Self-hosted Bot quick CLI copy button (generic Bridge only)
    if (this.el["btn-copy-bot-cmd"]) {
      this.el["btn-copy-bot-cmd"].addEventListener("click", () => {
        this.copyText(this.buildBotCliCommand(), "Copied bot bridge command");
      });
    }

    // Collapsible & pinnable Advanced rail section headers
    for (const btn of document.querySelectorAll("[data-toggle-panel]")) {
      btn.addEventListener("click", () => {
        this.toggleAdvPanel(btn.dataset.togglePanel);
      });
    }
    for (const btn of document.querySelectorAll("[data-pin-panel]")) {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.toggleAdvPanelPin(btn.dataset.pinPanel);
      });
    }

    // Interactive topology graph layout reset & pointer/click interactions
    if (this.el["btn-topo-reset"]) {
      this.el["btn-topo-reset"].addEventListener("click", () => {
        this.topo.customPositions.clear();
        this.el["btn-topo-reset"].classList.add("hidden");
        this.renderTopology();
      });
    }
    this.setupTopologyInteractions();

    // Identity & Mesh controls
    this.el["author-name-input"].addEventListener("input", () => {
      const typed = this.el["author-name-input"].value.trim();
      if (typed) {
        saveSessionAuthorName(typed);
      }
    });

    this.el["author-name-input"].addEventListener("change", () => {
      const next = this.el["author-name-input"].value.trim();
      if (!next) {
        this.el["author-name-input"].value = this.status.authorName;
        return;
      }
      this._userCustomizedName = true;
      saveSessionAuthorName(next);
      const res = this.wasm.call({ cmd: "set_profile", authorName: next });
      this.status = res.status;
      this.profile.authorName = next;
      this.executeActions(res.actions);
      this.renderHeader();
      this.renderVoicePanel(true);
      this.renderTopology();
      this.broadcastMeshBeacon(false);
      this.broadcastTabState({ authorName: next });
      this.announceRoomHello(false);
      this.showToast(`Updated display name to ${next}`);
    });

    this.el["auto-mesh-toggle"].addEventListener("change", () => {
      const enabled = this.el["auto-mesh-toggle"].checked;
      const res = this.wasm.call({ cmd: "set_profile", autoMeshEnabled: enabled });
      this.status = res.status;
      this.profile.autoMeshEnabled = enabled;
      this.el["auto-mesh-badge"].textContent = enabled ? "ON" : "OFF";
      this.addTelemetry("config", `Relayed auto-mesh ${enabled ? "enabled" : "disabled"}`);
    });

    this.el["btn-sync-now"].addEventListener("click", () => {
      const res = this.wasm.call({ cmd: "request_sync", nowMs: Date.now() });
      this.status = res.status;
      this.executeActions(res.actions);
      this.broadcastMeshBeacon(true);
      if (this.activeRoom && this.roomRendezvous) {
        this.announceRoomHello(true);
      }
      this.addTelemetry(
        "sync_inv",
        `Triggered full E2EE sync (log + colors + media) across ${this.directPeers.size} peer(s)`
      );
      this.renderAll();
    });

    // Replicated log composer & toolbar
    this.el["mode-btn-chat"].addEventListener("click", () => this.switchComposerMode("chat"));
    this.el["mode-btn-json"].addEventListener("click", () => this.switchComposerMode("json"));

    for (const btn of document.querySelectorAll(".preset-chip")) {
      btn.addEventListener("click", () => {
        const preset = STRUCTURED_PRESETS[btn.dataset.preset];
        if (preset) {
          this.el["json-type-input"].value = preset.type;
          this.el["json-payload-input"].value = JSON.stringify(preset.payload, null, 2);
          this.el["composer-error"].classList.add("hidden");
        }
      });
    }

    // Theme toggle
    this.el["btn-theme-toggle"].addEventListener("click", () => this.toggleTheme());

    // Media attach (images, animated GIFs, videos), paste, and drag-and-drop into chat
    this.el["btn-attach-image"].addEventListener("click", () => {
      this.el["chat-image-input"].click();
    });
    this.el["chat-image-input"].addEventListener("change", async (ev) => {
      const files = Array.from(ev.target.files || []);
      this.el["chat-image-input"].value = "";
      if (files.length > 0) {
        await this.addPendingImageFiles(files);
      }
    });

    const handleMediaPaste = async (ev) => {
      const cd = ev.clipboardData;
      if (!cd) return;
      const mediaFiles = [];
      if (cd.items) {
        for (const item of cd.items) {
          if (item.kind === "file") {
            const f = item.getAsFile();
            if (f && inferMediaMime(f)) mediaFiles.push(f);
          }
        }
      }
      if (mediaFiles.length === 0 && cd.files) {
        for (const f of cd.files) {
          if (inferMediaMime(f)) {
            mediaFiles.push(f);
          }
        }
      }
      if (mediaFiles.length > 0) {
        ev.preventDefault();
        if (this.composerMode !== "chat") {
          this.switchComposerMode("chat");
        }
        await this.addPendingImageFiles(mediaFiles);
      }
    };

    this.el["chat-text-input"].addEventListener("paste", handleMediaPaste);
    document.addEventListener("paste", (ev) => {
      if (ev.defaultPrevented || ev.target === this.el["chat-text-input"]) return;
      const active = document.activeElement;
      if (active === this.el["chat-text-input"]) return;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      handleMediaPaste(ev);
    });

    const chatPanel = this.el["chat-panel"];
    const dropzone = this.el["chat-composer-dropzone"];
    const dropOverlay = this.el["chat-drop-overlay"];
    let dragDepth = 0;

    const isFileDrag = (dt) => {
      if (!dt) return false;
      const types = dt.types ? Array.from(dt.types) : [];
      return types.includes("Files") || (dt.files && dt.files.length > 0);
    };
    const isChatVisible = () =>
      Boolean(this.activeRoom || this.advancedMode) &&
      chatPanel &&
      !chatPanel.closest(".hidden");

    const setDropHighlight = (active) => {
      dropzone.classList.toggle("drag-over", active);
      if (dropOverlay) {
        dropOverlay.classList.toggle("hidden", !active);
      }
    };

    const handleDroppedDataTransfer = async (dt) => {
      const rawFiles = Array.from(dt?.files || []);
      if (rawFiles.length > 0) {
        if (this.composerMode !== "chat") {
          this.switchComposerMode("chat");
        }
        await this.addPendingImageFiles(rawFiles);
        return true;
      }
      const droppedUri = (dt?.getData("text/uri-list") || dt?.getData("text/plain") || "").trim();
      const firstLine = droppedUri.split(/\r?\n/).find((l) => l && !l.startsWith("#")) || "";
      if (SAFE_HTTP_URL_RE.test(firstLine)) {
        if (this.composerMode !== "chat") {
          this.switchComposerMode("chat");
        }
        const cur = this.el["chat-text-input"].value;
        this.el["chat-text-input"].value = cur ? `${cur} ${firstLine}` : firstLine;
        this.el["chat-text-input"].focus();
        return true;
      }
      return false;
    };

    // Full-window drag/drop guard while in a room so dropping a GIF/video anywhere never navigates away
    window.addEventListener("dragenter", (ev) => {
      if (!isChatVisible() || !isFileDrag(ev.dataTransfer)) return;
      ev.preventDefault();
      dragDepth += 1;
      setDropHighlight(true);
    });
    window.addEventListener("dragover", (ev) => {
      if (!isChatVisible() || !isFileDrag(ev.dataTransfer)) return;
      ev.preventDefault();
      if (ev.dataTransfer) {
        ev.dataTransfer.dropEffect = "copy";
      }
      setDropHighlight(true);
    });
    window.addEventListener("dragleave", () => {
      if (dragDepth > 0) {
        dragDepth -= 1;
      }
      if (dragDepth === 0) {
        setDropHighlight(false);
      }
    });
    window.addEventListener("drop", async (ev) => {
      dragDepth = 0;
      setDropHighlight(false);
      if (ev.defaultPrevented || !isChatVisible()) return;
      if (isFileDrag(ev.dataTransfer)) {
        ev.preventDefault();
        await handleDroppedDataTransfer(ev.dataTransfer);
      }
    });
    window.addEventListener("blur", () => {
      dragDepth = 0;
      setDropHighlight(false);
    });

    // Also allow dropping directly onto #chat-panel even when synthesized in automated tests
    chatPanel.addEventListener("dragover", (ev) => {
      if (isFileDrag(ev.dataTransfer)) {
        ev.preventDefault();
        setDropHighlight(true);
      }
    });
    chatPanel.addEventListener("dragleave", (ev) => {
      if (!chatPanel.contains(ev.relatedTarget)) {
        dragDepth = 0;
        setDropHighlight(false);
      }
    });
    chatPanel.addEventListener("drop", async (ev) => {
      dragDepth = 0;
      setDropHighlight(false);
      if (ev.defaultPrevented) return;
      if (isFileDrag(ev.dataTransfer) || (ev.dataTransfer?.types && Array.from(ev.dataTransfer.types).includes("text/uri-list"))) {
        ev.preventDefault();
        await handleDroppedDataTransfer(ev.dataTransfer);
      }
    });

    // Media lightbox controls (Images, GIFs & Videos — synced across room except volume)
    this.el["btn-lightbox-close"].addEventListener("click", () => this.closeLightbox());
    if (this.el["btn-lightbox-replay"]) {
      this.el["btn-lightbox-replay"].addEventListener("click", () => this.replayLightbox());
    }
    if (this.el["btn-lightbox-loop"]) {
      this.el["btn-lightbox-loop"].addEventListener("click", () => this.toggleLightboxLoop());
    }
    if (this.el["lightbox-video"]) {
      const lbVid = this.el["lightbox-video"];
      const broadcastLightboxVideo = (forcePlaying = null) => {
        const st = this.lightboxState;
        if (
          !st ||
          st.kind !== "video" ||
          !st.syncTargetId ||
          this.mediaSync.lightboxVideoApplying ||
          performance.now() < this.mediaSync.lightboxVideoSuppressUntil
        ) {
          return;
        }
        const curMs = Math.max(0, Math.round((lbVid.currentTime || 0) * 1000));
        const playing = forcePlaying !== null ? forcePlaying : !lbVid.paused && !lbVid.ended;
        const rateMilli = Math.round((lbVid.playbackRate || 1) * 1000);
        const existing = this.mediaSync.states.get(st.syncTargetId);
        this.publishMediaSync({
          targetId: st.syncTargetId,
          kind: "video",
          active: true,
          playing,
          positionMs: curMs,
          rateMilli,
          loop: Boolean(lbVid.loop),
          epoch: existing ? existing.epoch || 0 : 0,
        });
      };
      lbVid.addEventListener("play", () => broadcastLightboxVideo(true));
      lbVid.addEventListener("pause", () => {
        if (lbVid.ended || (lbVid.duration > 0 && Math.abs(lbVid.currentTime - lbVid.duration) < 0.15)) {
          return;
        }
        broadcastLightboxVideo(false);
      });
      lbVid.addEventListener("seeked", () => {
        const st = this.lightboxState;
        if (!st || !st.syncTargetId) return;
        const existing = this.mediaSync.states.get(st.syncTargetId);
        const expectedSec = existing ? projectMediaPositionMs(existing, Date.now()) / 1000 : 0;
        if (Math.abs((lbVid.currentTime || 0) - expectedSec) > 0.3) {
          broadcastLightboxVideo(null);
        }
      });
      lbVid.addEventListener("ratechange", () => broadcastLightboxVideo(null));
    }

    // Watch Together (YouTube / Spotify / SoundCloud) UI bindings
    if (this.el["btn-open-watch-panel"]) {
      this.el["btn-open-watch-panel"].addEventListener("click", () => this.toggleWatchPanelDrawer());
    }
    if (this.el["btn-watch-minimize"]) {
      this.el["btn-watch-minimize"].addEventListener("click", () => this.toggleWatchMinimize());
    }
    if (this.el["btn-watch-close"]) {
      this.el["btn-watch-close"].addEventListener("click", () => this.stopWatchTogetherForRoom());
    }
    if (this.el["btn-watch-prev"]) {
      this.el["btn-watch-prev"].addEventListener("click", () => this.playPrevWatchTrack());
    }
    if (this.el["btn-watch-play"]) {
      this.el["btn-watch-play"].addEventListener("click", () => this.toggleWatchPlay());
    }
    if (this.el["btn-watch-back10"]) {
      this.el["btn-watch-back10"].addEventListener("click", () => this.seekWatchBy(-10000));
    }
    if (this.el["btn-watch-fwd10"]) {
      this.el["btn-watch-fwd10"].addEventListener("click", () => this.seekWatchBy(10000));
    }
    if (this.el["btn-watch-replay"]) {
      this.el["btn-watch-replay"].addEventListener("click", () => this.replayWatch());
    }
    if (this.el["btn-watch-next"]) {
      this.el["btn-watch-next"].addEventListener("click", () => this.playNextWatchTrackOrQueue());
    }
    if (this.el["btn-watch-tracks-toggle"]) {
      this.el["btn-watch-tracks-toggle"].addEventListener("click", () => this.toggleWatchPlaylistTracks());
    }
    if (this.el["btn-watch-spotify-playlist"]) {
      this.el["btn-watch-spotify-playlist"].addEventListener("click", () => this.showWatchSpotifyPlaylist());
    }
    if (this.el["btn-watch-loop"]) {
      this.el["btn-watch-loop"].addEventListener("click", () => this.toggleWatchLoop());
    }
    if (this.el["watch-speed-select"]) {
      this.el["watch-speed-select"].addEventListener("change", () => {
        this.setWatchSpeed(Number(this.el["watch-speed-select"].value) || 1000);
      });
    }
    if (this.el["watch-scrubber"]) {
      const scrubber = this.el["watch-scrubber"];
      scrubber.addEventListener("pointerdown", () => {
        this.mediaSync.watchScrubbing = true;
      });
      scrubber.addEventListener("input", () => {
        this.mediaSync.watchScrubbing = true;
        const dur = this.mediaSync.watchDurationMs || 0;
        const targetMs = dur > 0 ? Math.round((Number(scrubber.value) / 1000) * dur) : Number(scrubber.value) * 1000;
        if (this.el["watch-time-cur"]) {
          this.el["watch-time-cur"].textContent = formatClockTime(targetMs);
        }
      });
      scrubber.addEventListener("change", () => {
        this.mediaSync.watchScrubbing = false;
        const dur = this.mediaSync.watchDurationMs || 0;
        const targetMs = dur > 0 ? Math.round((Number(scrubber.value) / 1000) * dur) : Number(scrubber.value) * 1000;
        this.seekWatchTo(targetMs);
      });
    }
    if (this.el["watch-local-volume"]) {
      this.el["watch-local-volume"].addEventListener("input", () => {
        const vol = Number(this.el["watch-local-volume"].value) || 0;
        this.setWatchLocalVolume(vol);
      });
    }
    if (this.el["btn-watch-local-mute"]) {
      this.el["btn-watch-local-mute"].addEventListener("click", () => this.toggleWatchLocalMute());
    }
    if (this.el["btn-watch-autoplay-unmute"]) {
      this.el["btn-watch-autoplay-unmute"].addEventListener("click", () => {
        this.setWatchLocalMuted(false);
      });
    }
    if (this.el["watch-url-form"]) {
      this.el["watch-url-form"].addEventListener("submit", (ev) => {
        ev.preventDefault();
        const url = this.el["watch-url-input"]?.value.trim() || "";
        if (!url) return;
        if (this.startWatchTogetherFromUrl(url, "")) {
          this.el["watch-url-input"].value = "";
        }
      });
    }
    if (this.el["btn-watch-queue-add"]) {
      this.el["btn-watch-queue-add"].addEventListener("click", () => {
        const url = this.el["watch-url-input"]?.value.trim() || "";
        if (!url) return;
        if (this.enqueueWatchUrl(url)) {
          this.el["watch-url-input"].value = "";
        }
      });
    }
    this.el["image-lightbox"].addEventListener("click", (ev) => {
      if (ev.target === this.el["image-lightbox"]) {
        this.closeLightbox();
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (this.el["image-lightbox"].classList.contains("hidden")) return;
      if (ev.key === "Escape") {
        this.closeLightbox();
      } else if ((ev.key === "r" || ev.key === "R") && (this.lightboxState?.kind === "gif" || this.lightboxState?.kind === "video")) {
        ev.preventDefault();
        this.replayLightbox();
      } else if (ev.key === " " && this.lightboxState?.kind === "video") {
        ev.preventDefault();
        const vid = this.el["lightbox-video"];
        if (vid.paused) {
          const p = vid.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } else {
          vid.pause();
        }
      }
    });

    this.el["chat-composer-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = this.el["chat-text-input"].value.trim();
      const images = [];
      const videos = [];
      for (const item of this.pendingImages) {
        if (item.kind === "video") {
          videos.push({
            dataUrl: item.dataUrl,
            width: item.width,
            height: item.height,
            duration: item.duration || 0,
            name: item.name,
            mime: item.mime,
            bytes: item.bytes,
          });
        } else {
          images.push({
            dataUrl: item.dataUrl,
            width: item.width,
            height: item.height,
            name: item.name,
            animated: Boolean(item.animated || item.kind === "gif"),
            bytes: item.bytes,
          });
        }
        this._revokePendingPreviewUrl(item);
      }
      if (!text && images.length === 0 && videos.length === 0) return;
      const payload = { text };
      if (images.length > 0) payload.images = images;
      if (videos.length > 0) payload.videos = videos;
      this.publishMessage("chat", payload);
      this.el["chat-text-input"].value = "";
      this.pendingImages = [];
      this.renderImageTray();
      this.el["composer-error"].classList.add("hidden");
    });

    this.el["json-composer-form"].addEventListener("submit", (ev) => {
      ev.preventDefault();
      const msgType = this.el["json-type-input"].value.trim();
      const rawPayload = this.el["json-payload-input"].value.trim();
      if (!msgType) {
        this.showComposerError("Message type must not be empty.");
        return;
      }
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(rawPayload);
      } catch (err) {
        this.showComposerError(`Invalid JSON payload: ${err.message}`);
        return;
      }
      this.el["composer-error"].classList.add("hidden");
      this.publishMessage(msgType, parsedPayload);
    });

    this.el["btn-toggle-raw"].addEventListener("click", () => {
      this.rawJsonMode = !this.rawJsonMode;
      this.el["btn-toggle-raw"].textContent = this.rawJsonMode ? "Chat View" : "Raw JSON";
      this.el["btn-toggle-raw"].classList.toggle("is-active", this.rawJsonMode);
      this.renderTypeFilterOptions();
      this.renderLog();
    });

    this.el["btn-export-encrypted"].addEventListener("click", () => this.exportEncryptedBackup());
    this.el["btn-export-log"].addEventListener("click", () => this.exportDecryptedLog());
    this.el["btn-clear-local-log"].addEventListener("click", () => this.wipeLocalLog());

    this.el["log-search-input"].addEventListener("input", () => this.renderLog());
    this.el["log-type-filter"].addEventListener("change", () => this.renderLog());

    window.addEventListener("hashchange", () => this.handleUrlHashFragment());

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.wasm) {
        this.onForegroundResume();
      }
    });

    const teardownAll = () => {
      if (this.voice.inVoice) {
        this.leaveVoiceChat(/* silent = */ true);
      }
      if (this.roomRendezvous) {
        try {
          this.notifyRelayPeersClosing();
          this.roomRendezvous.stop();
        } catch {
          // ignore
        }
      }
      for (const entry of this.roomDialing.values()) {
        try {
          entry.pc.close();
        } catch {
          // ignore
        }
      }
      if (this.keepaliveWorker) {
        try {
          this.keepaliveWorker.terminate();
        } catch {
          // ignore
        }
      }
      for (const vdc of this.voiceChannels.values()) {
        try {
          vdc.close();
        } catch {
          // ignore
        }
      }
      for (const p of this.directPeers.values()) {
        try {
          p.dc.close();
          p.pc.close();
        } catch {
          // ignore
        }
      }
      if (this.topo.rafId) {
        cancelAnimationFrame(this.topo.rafId);
        this.topo.rafId = null;
      }
      if (this.topo.statsTimer) {
        clearInterval(this.topo.statsTimer);
        this.topo.statsTimer = null;
      }
      if (this.bc) {
        try {
          this.bc.close();
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener("pagehide", teardownAll);
    window.addEventListener("beforeunload", teardownAll);
  }

  async init() {
    this.bindElements();
    this.initTheme();
    this.initAdvPanels();
    this.initAdvancedMode();
    this.bindEvents();
    this.initPwa();

    // Purge legacy profile/message storage while preserving local room bookmarks (never auto-joined)
    purgeLegacyClientStorage();
    this.savedRooms = loadSavedRooms();
    this.lastJoinedRoom = loadLastJoinedRoom();
    this.el["profile-slot-label"].textContent = "in-memory session";
    this.profile = createEphemeralProfile();

    this.wasm = await SafeRustWasmMesh.loadFromUrl("./p2p_mesh.wasm");
    this.iceConfig = buildIceConfig();
    await this.probeVoiceOpusSupport();
    this.updateVoiceCodecMeta();
    this.addTelemetry(
      "engine",
      `In-memory encrypted session ready (Direct P2P STUN + E2EE Relay fallback · ${this.voice.opusSupported ? "48 kHz Opus HD" : "16 kHz ADPCM fallback"})`
    );

    const initRes = this.wasm.call({
      cmd: "init",
      peerId: this.profile.peerId,
      authorName: this.profile.authorName,
      room: this.profile.room || "mesh-main",
      autoMeshEnabled: this.profile.autoMeshEnabled !== false,
      x25519Secret: this.profile.x25519Secret,
      meshKey: this.profile.meshKey,
      passphraseMode: Boolean(this.profile.passphraseMode),
      entropy: randomBase64Url(32),
    });
    this.status = initRes.status;
    this.logMessages = [];

    this.el["author-name-input"].value = this.status.authorName;
    this.el["auto-mesh-toggle"].checked = this.status.autoMeshEnabled;
    this.el["auto-mesh-badge"].textContent = this.status.autoMeshEnabled ? "ON" : "OFF";
    this.syncAudioSettingsUI();

    this.setupBroadcastChannel();
    this.startKeepaliveWorker();

    // Handle any #room=, #offer=, or #answer= fragment before first render to avoid lobby flash
    await this.handleUrlHashFragment();
    this.renderAll();

    // Discover any other live tabs open in this browser and sync live tab preferences
    this.broadcastMeshBeacon(true);
    this.postBroadcast({
      type: "tab-state-hello",
      fromPeerId: this.status.peerId,
    });

    window.__p2pDirect = this;
  }

  async runIceSelfTest() {
    const hint = this.el["turn-test-status"];
    const btn = this.el["btn-turn-test"];
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = "Testing Direct STUN ICE + E2EE Relay paths (2s)…";
    const found = new Set();
    let pc = null;
    try {
      pc = this.createPeerConnection();
      pc.createDataChannel("ice-test");
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        pc.onicecandidate = (ev) => {
          if (!ev.candidate) {
            finish();
            return;
          }
          found.add(classifyIceCandidateType(ev.candidate.candidate));
        };
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") finish();
        };
        pc.createOffer()
          .then((o) => pc.setLocalDescription(o))
          .catch(() => finish());
        const timer = setTimeout(finish, 2000);
      });
    } finally {
      if (pc) {
        try {
          pc.close();
        } catch {
          // ignore
        }
      }
      if (btn) btn.disabled = false;
    }

    const list = Array.from(found);
    const relayInfo = this.roomRendezvous
      ? `${this.roomRelayStatus.connectedCount}/${this.roomRelayStatus.totalCount} WSS relays ready`
      : "WSS relays connect when joining a room";
    const summary = `Path Test: ICE [${list.join(", ") || "none"}] · ${relayInfo} · zero TURN needed`;
    if (hint) hint.textContent = summary;
    this.addTelemetry("room", summary);
    this.showToast("Connection path check complete");
  }

  /* ================= PWA Installation & Static Shell Service Worker ================= */

  initPwa() {
    const standaloneQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(display-mode: standalone)")
        : null;
    const isStandalone = Boolean(
      (standaloneQuery && standaloneQuery.matches) || window.navigator.standalone === true
    );
    const ua = navigator.userAgent || "";
    const isIos =
      /(iphone|ipad|ipod)/i.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    this.pwa = {
      deferredPrompt: null,
      isStandalone,
      isIos,
    };

    document.documentElement.setAttribute("data-pwa", isStandalone ? "standalone" : "browser");

    if (standaloneQuery && typeof standaloneQuery.addEventListener === "function") {
      standaloneQuery.addEventListener("change", (ev) => {
        this.pwa.isStandalone = Boolean(ev.matches);
        document.documentElement.setAttribute(
          "data-pwa",
          this.pwa.isStandalone ? "standalone" : "browser"
        );
        this.updatePwaInstallButton();
      });
    }

    window.addEventListener("beforeinstallprompt", (ev) => {
      ev.preventDefault();
      this.pwa.deferredPrompt = ev;
      this.updatePwaInstallButton();
    });

    window.addEventListener("appinstalled", () => {
      this.pwa.deferredPrompt = null;
      this.pwa.isStandalone = true;
      document.documentElement.setAttribute("data-pwa", "standalone");
      this.updatePwaInstallButton();
      this.showToast("App installed");
    });

    this.updatePwaInstallButton();

    // Register static app-shell Service Worker on secure origins (caches only public static shell)
    const canRegisterSw =
      "serviceWorker" in navigator &&
      (window.isSecureContext ||
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1");
    if (canRegisterSw) {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
        // Ignore registration errors in restricted/private browsing contexts
      });
    }
  }

  updatePwaInstallButton() {
    const btn = this.el["btn-pwa-install"];
    if (!btn || !this.pwa) return;
    const canShow = !this.pwa.isStandalone && (Boolean(this.pwa.deferredPrompt) || this.pwa.isIos);
    btn.classList.toggle("hidden", !canShow);
  }

  async promptPwaInstall() {
    if (!this.pwa || this.pwa.isStandalone) return;
    if (this.pwa.deferredPrompt) {
      const promptEv = this.pwa.deferredPrompt;
      this.pwa.deferredPrompt = null;
      try {
        await promptEv.prompt();
        const choice = await promptEv.userChoice;
        if (choice && choice.outcome === "accepted") {
          this.showToast("Installing app…");
        }
      } catch {
        // user dismissed or prompt unavailable
      } finally {
        this.updatePwaInstallButton();
      }
      return;
    }
    if (this.pwa.isIos) {
      this.showToast("Tap Share → Add to Home Screen to install");
    }
  }

  /* ================= Simple vs Advanced Mode, Collapsible & Pinnable Rail Panels ================= */

  initAdvPanels() {
    const valid = new Set(["connect", "network", "bot", "diagnostics"]);
    this.advPanels.open.clear();
    this.advPanels.pinned.clear();
    try {
      const savedOpen = JSON.parse(sessionStorage.getItem("p2p-direct-panel-open") || "[]");
      if (Array.isArray(savedOpen)) {
        for (const k of savedOpen) {
          if (valid.has(k)) this.advPanels.open.add(k);
        }
      }
      const savedPins = JSON.parse(sessionStorage.getItem("p2p-direct-panel-pins") || "[]");
      if (Array.isArray(savedPins)) {
        for (const k of savedPins) {
          if (valid.has(k)) this.advPanels.pinned.add(k);
        }
      }
    } catch {
      // default: ALL collapsed, NONE pinned
    }
    this.syncAdvPanelsDom();
  }

  _persistAdvPanels() {
    try {
      sessionStorage.setItem("p2p-direct-panel-open", JSON.stringify(Array.from(this.advPanels.open)));
      sessionStorage.setItem("p2p-direct-panel-pins", JSON.stringify(Array.from(this.advPanels.pinned)));
    } catch {
      // ignore storage restrictions
    }
  }

  syncAdvPanelsDom() {
    const panelTitles = {
      connect: "Connect Peer",
      network: "Peers & Network",
      bot: "Self-Host a Bot",
      diagnostics: "Activity & Stats",
    };
    for (const key of Object.keys(panelTitles)) {
      const sec = document.getElementById(`adv-panel-${key}`);
      if (!sec) continue;
      const isOpen = this.advPanels.open.has(key);
      const isPinned = this.advPanels.pinned.has(key);
      sec.setAttribute("data-collapsed", isOpen ? "false" : "true");
      sec.setAttribute("data-pinned", isPinned ? "true" : "false");
      const toggleBtn = sec.querySelector(`[data-toggle-panel="${key}"]`);
      if (toggleBtn) {
        toggleBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      }
      const pinBtn = sec.querySelector(`[data-pin-panel="${key}"]`);
      if (pinBtn) {
        pinBtn.setAttribute("aria-pressed", isPinned ? "true" : "false");
        pinBtn.title = isPinned
          ? `Unpin ${panelTitles[key]} (hide when Advanced is off)`
          : `Pin ${panelTitles[key]} so it stays visible even when Advanced is off`;
      }
    }
    document.documentElement.setAttribute(
      "data-has-pinned",
      this.advPanels.pinned.size > 0 ? "true" : "false"
    );
    this._syncTopologyTimers();
  }

  setAdvPanelOpen(key, isOpen, persist = true) {
    if (!key) return;
    if (isOpen) {
      this.advPanels.open.add(key);
    } else {
      this.advPanels.open.delete(key);
    }
    if (persist) this._persistAdvPanels();
    this.syncAdvPanelsDom();
    if (key === "network" && isOpen && this.status) {
      this.pollPeerTransportStats();
      this.renderTopology();
      this.renderTopologyInspector();
    }
  }

  toggleAdvPanel(key) {
    this.setAdvPanelOpen(key, !this.advPanels.open.has(key), true);
  }

  setAdvPanelPinned(key, isPinned, persist = true) {
    if (!key) return;
    const names = {
      connect: "Connect Peer",
      network: "Peers & Network",
      bot: "Self-Host a Bot",
      diagnostics: "Activity & Stats",
    };
    if (isPinned) {
      this.advPanels.pinned.add(key);
    } else {
      this.advPanels.pinned.delete(key);
    }
    if (persist) this._persistAdvPanels();
    this.syncAdvPanelsDom();
    if (this.status) {
      this.syncLayoutAttributes();
      if (key === "network" && isPinned && this.advPanels.open.has("network")) {
        this.pollPeerTransportStats();
        this.renderTopology();
      }
    }
    if (persist && names[key]) {
      this.showToast(
        isPinned
          ? `Pinned ${names[key]} — stays visible outside Advanced`
          : `Unpinned ${names[key]}`
      );
    }
  }

  toggleAdvPanelPin(key) {
    this.setAdvPanelPinned(key, !this.advPanels.pinned.has(key), true);
  }

  isTopologyVisible() {
    if (!this.advPanels.open.has("network")) return false;
    if (this.advancedMode) return true;
    const inRoom = Boolean(this.activeRoom || this.directPeers.size > 0);
    return inRoom && this.advPanels.pinned.has("network");
  }

  _syncTopologyTimers() {
    const visible = this.isTopologyVisible();
    const needStatsPoll = visible || (this.advancedMode && this.directPeers.size > 0);
    if (needStatsPoll) {
      if (!this.topo.statsTimer) {
        this.topo.statsTimer = setInterval(() => {
          const stillNeed = this.isTopologyVisible() || (this.advancedMode && this.directPeers.size > 0);
          if (!stillNeed) {
            this._syncTopologyTimers();
            return;
          }
          this.pollPeerTransportStats();
        }, 2400);
      }
    } else if (this.topo.statsTimer) {
      clearInterval(this.topo.statsTimer);
      this.topo.statsTimer = null;
    }

    if (visible) {
      if (this.topo.particles.length > 0 && !this.topo.rafId) {
        this.topo.lastFrameMs = performance.now();
        this.topo.rafId = requestAnimationFrame(this.topo.boundTick);
      }
    } else if (this.topo.rafId) {
      cancelAnimationFrame(this.topo.rafId);
      this.topo.rafId = null;
    }
  }

  initAdvancedMode() {
    const initial = document.documentElement.getAttribute("data-advanced") === "true";
    this.setAdvancedMode(initial, /* persist = */ false);
  }

  setAdvancedMode(enabled, persist = true) {
    this.advancedMode = Boolean(enabled);
    document.documentElement.setAttribute("data-advanced", this.advancedMode ? "true" : "false");

    const btn = this.el["btn-advanced-toggle"];
    if (btn) {
      btn.classList.toggle("is-active", this.advancedMode);
      btn.setAttribute("aria-pressed", String(this.advancedMode));
      btn.title = this.advancedMode
        ? "Return to simple room view"
        : "Show advanced networking, manual connect, and JSON tools";
    }

    if (persist) {
      try {
        sessionStorage.setItem("p2p-direct-advanced", this.advancedMode ? "true" : "false");
      } catch {
        // ignore storage restrictions
      }
    }

    if (!this.advancedMode) {
      if (this.rawJsonMode) {
        this.rawJsonMode = false;
        if (this.el["btn-toggle-raw"]) {
          this.el["btn-toggle-raw"].textContent = "Raw JSON";
          this.el["btn-toggle-raw"].classList.remove("is-active");
        }
      }
      if (this.composerMode !== "chat") {
        this.switchComposerMode("chat");
      }
      if (this.el["log-search-input"]) this.el["log-search-input"].value = "";
      if (this.el["log-type-filter"]) this.el["log-type-filter"].value = "";
    }

    if (this.advancedMode) {
      const inRoom = Boolean(this.activeRoom || this.directPeers.size > 0);
      if (!inRoom && typeof window !== "undefined" && window.innerWidth <= 1020) {
        this.setMobileAdvTab("connect", { autoOpen: true, scrollTop: false });
      }
    }

    this._syncTopologyTimers();

    if (this.status) {
      this.renderAll();
      if (this.advancedMode) {
        this.updateVoiceAdvancedStats();
        if (this.directPeers.size > 0) {
          this.pollPeerTransportStats();
        }
      }
    } else {
      this.syncLayoutAttributes();
    }
  }

  toggleAdvancedMode() {
    this.setAdvancedMode(!this.advancedMode, true);
  }

  syncLayoutAttributes() {
    const inRoom = Boolean(this.activeRoom || this.directPeers.size > 0);
    document.documentElement.setAttribute("data-in-room", inRoom ? "true" : "false");
    document.documentElement.setAttribute(
      "data-has-pinned",
      this.advPanels.pinned.size > 0 ? "true" : "false"
    );
    this.syncMobileAdvNav();
    this._syncTopologyTimers();
  }

  setMobileAdvTab(tab, { autoOpen = true, scrollTop = true } = {}) {
    const valid = tab === "connect" || tab === "network" ? tab : "chat";
    this.mobileAdvTab = valid;
    document.documentElement.setAttribute("data-mobile-tab", valid);

    for (const btn of document.querySelectorAll("[data-mobile-tab-btn]")) {
      const isActive = btn.getAttribute("data-mobile-tab-btn") === valid;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    }

    if (autoOpen) {
      if (valid === "connect") {
        this.setAdvPanelOpen("connect", true, false);
      } else if (valid === "network") {
        const netTargets = this.advancedMode
          ? ["network"]
          : ["network", "bot", "diagnostics"].filter((k) => this.advPanels.pinned.has(k));
        for (const key of netTargets) {
          this.setAdvPanelOpen(key, true, false);
        }
        if (this.status && this.advPanels.open.has("network")) {
          this.pollPeerTransportStats();
          this.renderTopology();
          this.renderTopologyInspector();
        }
      }
    }

    if (scrollTop && typeof window !== "undefined" && window.innerWidth <= 1020) {
      window.scrollTo(0, 0);
    }
  }

  syncMobileAdvNav() {
    const roomsBadge = this.el["mobile-tab-rooms-badge"];
    if (roomsBadge) {
      const savedCount = Array.isArray(this.savedRooms) ? this.savedRooms.length : 0;
      roomsBadge.textContent = String(savedCount);
      roomsBadge.classList.toggle("hidden", savedCount === 0);
    }
    const peersBadge = this.el["mobile-tab-peers-badge"];
    if (peersBadge) {
      const peerCount = Array.isArray(this.status?.peers) ? this.status.peers.length : 0;
      peersBadge.textContent = String(peerCount);
      peersBadge.classList.toggle("hidden", peerCount === 0);
    }

    const nav = this.el["mobile-adv-nav"];
    if (!nav) return;
    const connectBtn = nav.querySelector('[data-mobile-tab-btn="connect"]');
    const networkBtn = nav.querySelector('[data-mobile-tab-btn="network"]');
    const showConnect = this.advancedMode || this.advPanels.pinned.has("connect");
    const showNetwork =
      this.advancedMode ||
      this.advPanels.pinned.has("network") ||
      this.advPanels.pinned.has("bot") ||
      this.advPanels.pinned.has("diagnostics");
    if (connectBtn) connectBtn.classList.toggle("hidden", !showConnect);
    if (networkBtn) networkBtn.classList.toggle("hidden", !showNetwork);

    if (
      (this.mobileAdvTab === "connect" && !showConnect) ||
      (this.mobileAdvTab === "network" && !showNetwork)
    ) {
      this.setMobileAdvTab("chat", { autoOpen: false, scrollTop: false });
    } else {
      document.documentElement.setAttribute("data-mobile-tab", this.mobileAdvTab || "chat");
    }
  }

  _syncVoiceStatsCollapseUi() {
    const toggleBtn = this.el["btn-voice-stats-toggle"];
    const cardCount = this.voice?.cardCache ? this.voice.cardCache.size : 0;
    if (toggleBtn) {
      toggleBtn.classList.toggle("hidden", !this.advancedMode || cardCount === 0);
      toggleBtn.classList.toggle("is-compact", this.voiceStatsCompact);
      toggleBtn.setAttribute("aria-pressed", String(this.voiceStatsCompact));
      toggleBtn.textContent = this.voiceStatsCompact ? "Stats ▾" : "Stats ▴";
    }
    if (this.voice?.cardCache) {
      for (const [rowKey, entry] of this.voice.cardCache.entries()) {
        if (!entry?.advStatsEl) continue;
        const collapsed = this.voiceStatsCompact
          ? !this.collapsedVoiceStatsCards.has(`expand:${rowKey}`)
          : this.collapsedVoiceStatsCards.has(rowKey);
        entry.advStatsEl.setAttribute("data-vas-collapsed", collapsed ? "true" : "false");
      }
    }
  }

  toggleVoiceStatsCompact() {
    this.voiceStatsCompact = !this.voiceStatsCompact;
    this.collapsedVoiceStatsCards.clear();
    this._syncVoiceStatsCollapseUi();
  }

  toggleVoiceCardStatsCollapsed(rowKey) {
    if (!rowKey) return;
    if (this.voiceStatsCompact) {
      const expKey = `expand:${rowKey}`;
      if (this.collapsedVoiceStatsCards.has(expKey)) {
        this.collapsedVoiceStatsCards.delete(expKey);
      } else {
        this.collapsedVoiceStatsCards.add(expKey);
      }
    } else if (this.collapsedVoiceStatsCards.has(rowKey)) {
      this.collapsedVoiceStatsCards.delete(rowKey);
    } else {
      this.collapsedVoiceStatsCards.add(rowKey);
    }
    this._syncVoiceStatsCollapseUi();
  }

  createRoomFromLobby() {
    const typedName = (this.el["lobby-room-name-input"]?.value || "").trim();
    this.createLongLivedRoom({ freshKey: false, roomNameOverride: typedName });
  }

  async joinRoomFromLobby() {
    const raw = (this.el["lobby-room-link-input"]?.value || "").trim();
    if (!raw) {
      this.showNotice("lobby-notice", "warn", "Paste a room invite link first.");
      return;
    }
    this.el["lobby-notice"]?.classList.add("hidden");
    this.el["lobby-passphrase-box"]?.classList.add("hidden");

    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: raw,
        passphrase: passInput || undefined,
      });
      if (decoded.signal.kind === "offer") {
        this.el["lobby-room-link-input"].value = "";
        this.setAdvancedMode(true);
        this.setAdvPanelOpen("connect", true);
        await this.handleJoinOfferSubmit(raw);
        return;
      }
      if (decoded.signal.kind === "answer") {
        this.el["lobby-room-link-input"].value = "";
        this.setAdvancedMode(true);
        this.setAdvPanelOpen("connect", true);
        await this.handleHostAnswerSubmit(raw);
        return;
      }
    } catch {
      // Fall through to joinLongLivedRoomLink so passphrase prompt / clean error notice displays
    }

    await this.joinLongLivedRoomLink(raw);
  }

  async unlockRoomFromLobby() {
    const pass = this.el["lobby-passphrase-input"]?.value || "";
    if (!pass) {
      this.showNotice("lobby-notice", "warn", "Enter the shared room passphrase.");
      return;
    }
    this.el["e2ee-passphrase-input"].value = pass;
    this.el["lobby-passphrase-input"].value = "";
    await this.applyPassphrase();
  }

  /* ================= Theme & Chat Media Helpers ================= */

  initTheme() {
    const current =
      document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    this.applyTheme(current, /* persist = */ false, /* broadcast = */ false);
  }

  applyTheme(theme, persist = true, broadcast = false) {
    const isDark = theme === "dark";
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", isDark ? "dark" : "light");
    void root.offsetHeight;
    root.classList.remove("theme-switching");
    if (this.el["icon-moon"] && this.el["icon-sun"]) {
      this.el["icon-moon"].classList.toggle("hidden", isDark);
      this.el["icon-sun"].classList.toggle("hidden", !isDark);
    }
    if (this.el["btn-theme-toggle"]) {
      const label = isDark ? "Switch to light mode" : "Switch to dark mode";
      this.el["btn-theme-toggle"].title = label;
      this.el["btn-theme-toggle"].setAttribute("aria-label", label);
    }
    if (persist) {
      try {
        sessionStorage.setItem("p2p-direct-theme", isDark ? "dark" : "light");
      } catch {
        // ignore storage restrictions
      }
    }
    if (broadcast) {
      this._userCustomizedTheme = true;
      this.broadcastTabState({ theme: isDark ? "dark" : "light" });
    }
    if (this.status) {
      this.renderTopology();
    }
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    this.applyTheme(current === "dark" ? "light" : "dark", true, true);
  }

  async addPendingImageFiles(files) {
    this.el["composer-error"].classList.add("hidden");
    const list = Array.from(files || []);
    let addedAny = false;
    let skippedUnsupported = 0;

    for (const file of list) {
      const mime = inferMediaMime(file);
      if (!mime) {
        skippedUnsupported += 1;
        continue;
      }
      if (this.pendingImages.length >= MAX_MEDIA_PER_MESSAGE) {
        this.showComposerError(`Up to ${MAX_MEDIA_PER_MESSAGE} attachments per message.`);
        break;
      }
      const usedBytes = this.pendingImages.reduce((sum, item) => sum + (item.bytes || 0), 0);
      const remainingBytes = MAX_TOTAL_MEDIA_BYTES - usedBytes;
      if (remainingBytes < 16_384) {
        this.showComposerError("Attachment size budget (10 MB) reached for this message — send it first.");
        break;
      }
      try {
        const prepared = await prepareMediaFile(file, mime, remainingBytes);
        this.pendingImages.push(prepared);
        addedAny = true;
      } catch (err) {
        this.showComposerError(`Could not attach ${file.name || "file"}: ${err.message}`);
      }
    }

    if (!addedAny && skippedUnsupported > 0) {
      this.showComposerError(
        "Unsupported file type — drop PNG, JPG, WebP, animated GIF (≤4 MB), or MP4/WebM/MOV/OGG video (≤8 MB)."
      );
    }

    this.renderImageTray();
    this.el["chat-text-input"].focus();
  }

  _revokePendingPreviewUrl(item) {
    if (item && item.previewUrl && item.previewUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(item.previewUrl);
      } catch {
        // ignore
      }
      item.previewUrl = null;
    }
  }

  removePendingImage(id) {
    const target = this.pendingImages.find((img) => img.id === id);
    if (target) this._revokePendingPreviewUrl(target);
    this.pendingImages = this.pendingImages.filter((img) => img.id !== id);
    this.renderImageTray();
  }

  renderImageTray() {
    const tray = this.el["chat-image-tray"];
    if (!tray) return;
    if (this.pendingImages.length === 0) {
      tray.innerHTML = "";
      tray.classList.add("hidden");
      return;
    }
    tray.classList.remove("hidden");
    tray.innerHTML = this.pendingImages
      .map((item) => {
        const isVideo = item.kind === "video";
        const isGif = item.kind === "gif" || Boolean(item.animated);
        const previewSrc = item.previewUrl || item.dataUrl;
        const thumbHtml = isVideo
          ? `<video src="${previewSrc}" muted playsinline preload="metadata"></video><span class="staged-media-tag is-video">VID</span>`
          : `<img src="${previewSrc}" alt="${escapeHtml(item.name)}" />${isGif ? '<span class="staged-media-tag">GIF</span>' : ""}`;
        const durPart =
          isVideo && typeof item.duration === "number" && item.duration > 0
            ? `${formatMediaDuration(item.duration)} · `
            : "";
        const dimsPart = item.width && item.height ? `${item.width}×${item.height} · ` : "";
        return `
          <div class="staged-image-chip" data-staged-img="${escapeHtml(item.id)}" data-media-kind="${escapeHtml(item.kind || "image")}">
            <div class="staged-media-thumb-wrap">${thumbHtml}</div>
            <div class="staged-image-meta">
              <span class="staged-image-name">${escapeHtml(item.name)}</span>
              <span>${durPart}${dimsPart}${formatByteSize(item.bytes)}</span>
            </div>
            <button type="button" class="staged-image-remove" data-remove-img="${escapeHtml(item.id)}" aria-label="Remove attachment">×</button>
          </div>
        `;
      })
      .join("");
    for (const btn of tray.querySelectorAll("[data-remove-img]")) {
      btn.addEventListener("click", () => this.removePendingImage(btn.dataset.removeImg));
    }
  }

  openLightbox(targetOrSrc, altFallback = "") {
    let cfg;
    if (typeof targetOrSrc === "string") {
      if (!isSafeImageSrc(targetOrSrc)) return;
      const isGif = targetOrSrc.startsWith("data:image/gif;");
      cfg = {
        kind: isGif ? "gif" : "image",
        src: targetOrSrc,
        blob: isGif ? dataUrlToBlob(targetOrSrc) : null,
        dataUrl: targetOrSrc,
        alt: altFallback || "Shared image",
        meta: altFallback || "",
        loop: false,
      };
    } else if (targetOrSrc && typeof targetOrSrc === "object") {
      cfg = targetOrSrc;
    } else {
      return;
    }

    this._cleanupLightboxTempUrl();
    const imgEl = this.el["lightbox-img"];
    const gifCanvasEl = this.el["lightbox-gif-canvas"];
    const gifWrapEl = this.el["lightbox-gif-wrap"];
    const videoEl = this.el["lightbox-video"];
    const toolbar = this.el["lightbox-toolbar"];
    const loopBtn = this.el["btn-lightbox-loop"];
    const metaEl = this.el["lightbox-meta"];

    if (gifCanvasEl) gifCanvasEl.classList.add("hidden");

    if (cfg.kind === "video") {
      let videoSrc = cfg.src || "";
      let ownsUrl = false;
      if (cfg.blob) {
        videoSrc = URL.createObjectURL(cfg.blob);
        ownsUrl = true;
      } else if (!SAFE_VIDEO_DATA_URL_RE.test(videoSrc) && !videoSrc.startsWith("blob:")) {
        return;
      }
      if (gifWrapEl) gifWrapEl.classList.add("hidden");
      imgEl.classList.add("hidden");
      imgEl.removeAttribute("src");
      videoEl.classList.remove("hidden");

      const syncId = cfg.syncTargetId || "";
      const synced = syncId ? this.mediaSync.states.get(syncId) : null;
      const inlineBinding = syncId ? this.mediaSync.videoBindings.get(syncId) : null;

      this.mediaSync.lightboxVideoApplying = true;
      this.mediaSync.lightboxVideoSuppressUntil = performance.now() + 650;
      // Preserve user's strictly-local volume/mute from inline video
      if (inlineBinding && inlineBinding.videoEl) {
        try {
          videoEl.volume = inlineBinding.videoEl.volume;
          videoEl.muted = inlineBinding.videoEl.muted;
        } catch {
          // ignore
        }
      }
      videoEl.loop = synced ? Boolean(synced.loop) : Boolean(cfg.loop);
      videoEl.playbackRate = synced ? (Number(synced.rateMilli) || 1000) / 1000 : 1;
      videoEl.src = videoSrc;
      const targetSec = synced ? projectMediaPositionMs(synced, Date.now()) / 1000 : 0;
      const applyInitialSeekAndPlay = () => {
        this.mediaSync.lightboxVideoApplying = true;
        this.mediaSync.lightboxVideoSuppressUntil = performance.now() + 500;
        try {
          if (videoEl.duration && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
            videoEl.currentTime = videoEl.loop
              ? targetSec % videoEl.duration
              : Math.min(targetSec, Math.max(0, videoEl.duration - 0.05));
          } else {
            videoEl.currentTime = targetSec;
          }
        } catch {
          // ignore
        }
        const shouldPlay = synced ? Boolean(synced.playing) : true;
        if (shouldPlay) {
          const p = videoEl.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
        this.mediaSync.lightboxVideoApplying = false;
      };
      if (videoEl.readyState >= 1) {
        applyInitialSeekAndPlay();
      } else {
        videoEl.addEventListener("loadedmetadata", applyInitialSeekAndPlay, { once: true });
      }
      this.mediaSync.lightboxVideoApplying = false;

      if (toolbar) toolbar.classList.remove("hidden");
      if (loopBtn) {
        loopBtn.classList.remove("hidden");
        loopBtn.textContent = videoEl.loop ? "Loop: On" : "Loop: Off";
        loopBtn.classList.toggle("is-active", videoEl.loop);
      }
      if (metaEl) metaEl.textContent = cfg.meta || cfg.alt || "Video";
      this.lightboxState = {
        kind: "video",
        blob: cfg.blob || null,
        dataUrl: cfg.dataUrl || "",
        tempUrl: ownsUrl ? videoSrc : null,
        syncTargetId: syncId,
      };
    } else if (cfg.kind === "gif") {
      let gifSrc = cfg.src || "";
      let ownsUrl = false;
      if (cfg.blob) {
        gifSrc = URL.createObjectURL(cfg.blob);
        ownsUrl = true;
      } else if (!isSafeImageSrc(gifSrc) && !gifSrc.startsWith("blob:")) {
        return;
      }
      this.mediaSync.lightboxVideoApplying = true;
      videoEl.pause();
      this.mediaSync.lightboxVideoApplying = false;
      videoEl.classList.add("hidden");
      videoEl.removeAttribute("src");
      if (gifWrapEl) gifWrapEl.classList.remove("hidden");
      imgEl.classList.remove("hidden");
      imgEl.src = gifSrc;
      imgEl.alt = cfg.alt || "Animated GIF";
      if (toolbar) toolbar.classList.remove("hidden");
      if (loopBtn) loopBtn.classList.add("hidden");
      if (metaEl) metaEl.textContent = cfg.meta || cfg.alt || "Animated GIF";
      this.lightboxState = {
        kind: "gif",
        blob: cfg.blob || null,
        dataUrl: cfg.dataUrl || gifSrc,
        tempUrl: ownsUrl ? gifSrc : null,
        syncTargetId: cfg.syncTargetId || "",
      };
      const gifBind = cfg.syncTargetId ? this.mediaSync.gifBindings.get(cfg.syncTargetId) : null;
      if (gifBind && gifBind.decoder && gifBind.timings) {
        this._ensureGifSyncLoop();
        const st = this.mediaSync.states.get(cfg.syncTargetId);
        if (st && !st.playing) {
          const idx = frameIndexForGifTime(gifBind.timings, st.positionMs || 0);
          this._renderGifFrameToCanvas(gifBind, idx, gifCanvasEl);
          if (gifCanvasEl) gifCanvasEl.classList.remove("hidden");
        }
      }
    } else {
      if (!isSafeImageSrc(cfg.src || "")) return;
      this.mediaSync.lightboxVideoApplying = true;
      videoEl.pause();
      this.mediaSync.lightboxVideoApplying = false;
      videoEl.classList.add("hidden");
      videoEl.removeAttribute("src");
      if (gifWrapEl) gifWrapEl.classList.remove("hidden");
      imgEl.classList.remove("hidden");
      imgEl.src = cfg.src;
      imgEl.alt = cfg.alt || "Shared image";
      if (toolbar) toolbar.classList.add("hidden");
      if (loopBtn) loopBtn.classList.add("hidden");
      if (metaEl) metaEl.textContent = "";
      this.lightboxState = {
        kind: "image",
        blob: null,
        dataUrl: cfg.src,
        tempUrl: null,
        syncTargetId: "",
      };
    }

    this.el["image-lightbox"].classList.remove("hidden");
  }

  replayLightbox() {
    const st = this.lightboxState;
    if (!st) return;
    const replayBtn = this.el["btn-lightbox-replay"];
    if (st.kind === "video") {
      const videoEl = this.el["lightbox-video"];
      this.mediaSync.lightboxVideoSuppressUntil = performance.now() + 550;
      try {
        videoEl.currentTime = 0;
      } catch {
        // ignore
      }
      const p = videoEl.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
      videoEl.dataset.replayCount = String((Number(videoEl.dataset.replayCount) || 0) + 1);
      if (st.syncTargetId) {
        const prev = this.mediaSync.states.get(st.syncTargetId);
        this.publishMediaSync({
          targetId: st.syncTargetId,
          kind: "video",
          active: true,
          playing: true,
          positionMs: 0,
          rateMilli: Math.round((videoEl.playbackRate || 1) * 1000),
          loop: Boolean(videoEl.loop),
          epoch: (prev?.epoch || 0) + 1,
        });
      }
    } else if (st.kind === "gif") {
      const imgEl = this.el["lightbox-img"];
      if (st.blob) {
        const nextUrl = URL.createObjectURL(st.blob);
        this._cleanupLightboxTempUrl();
        st.tempUrl = nextUrl;
        imgEl.src = nextUrl;
      } else if (st.dataUrl) {
        imgEl.src = "";
        requestAnimationFrame(() => {
          imgEl.src = st.dataUrl;
        });
      }
      imgEl.dataset.replayCount = String((Number(imgEl.dataset.replayCount) || 0) + 1);
      if (st.syncTargetId) {
        const prev = this.mediaSync.states.get(st.syncTargetId);
        this.publishMediaSync({
          targetId: st.syncTargetId,
          kind: "gif",
          active: true,
          playing: true,
          positionMs: 0,
          rateMilli: 1000,
          loop: true,
          epoch: (prev?.epoch || 0) + 1,
        });
      }
    }
    if (replayBtn) {
      replayBtn.classList.add("is-active");
      setTimeout(() => replayBtn.classList.remove("is-active"), 300);
    }
  }

  toggleLightboxLoop() {
    if (!this.lightboxState || this.lightboxState.kind !== "video") return;
    const videoEl = this.el["lightbox-video"];
    const loopBtn = this.el["btn-lightbox-loop"];
    videoEl.loop = !videoEl.loop;
    if (loopBtn) {
      loopBtn.textContent = videoEl.loop ? "Loop: On" : "Loop: Off";
      loopBtn.classList.toggle("is-active", videoEl.loop);
    }
    if (this.lightboxState.syncTargetId) {
      const prev = this.mediaSync.states.get(this.lightboxState.syncTargetId);
      this.publishMediaSync({
        targetId: this.lightboxState.syncTargetId,
        kind: "video",
        active: true,
        playing: !videoEl.paused && !videoEl.ended,
        positionMs: Math.max(0, Math.round((videoEl.currentTime || 0) * 1000)),
        rateMilli: Math.round((videoEl.playbackRate || 1) * 1000),
        loop: Boolean(videoEl.loop),
        epoch: prev?.epoch || 0,
      });
    }
  }

  _cleanupLightboxTempUrl() {
    if (this.lightboxState?.tempUrl && this.lightboxState.tempUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(this.lightboxState.tempUrl);
      } catch {
        // ignore
      }
      this.lightboxState.tempUrl = null;
    }
  }

  closeLightbox() {
    const prevSyncVideoId =
      this.lightboxState?.kind === "video" ? this.lightboxState.syncTargetId : "";
    const prevLbVol = this.el["lightbox-video"]?.volume;
    const prevLbMuted = this.el["lightbox-video"]?.muted;

    this.el["image-lightbox"].classList.add("hidden");
    this.el["lightbox-img"].removeAttribute("src");
    if (this.el["lightbox-gif-canvas"]) {
      this.el["lightbox-gif-canvas"].classList.add("hidden");
    }
    if (this.el["lightbox-gif-wrap"]) {
      this.el["lightbox-gif-wrap"].classList.remove("hidden");
    }
    if (this.el["lightbox-video"]) {
      this.mediaSync.lightboxVideoApplying = true;
      this.mediaSync.lightboxVideoSuppressUntil = performance.now() + 400;
      try {
        this.el["lightbox-video"].pause();
      } catch {
        // ignore
      }
      this.el["lightbox-video"].removeAttribute("src");
      this.el["lightbox-video"].load();
      this.el["lightbox-video"].classList.add("hidden");
      this.mediaSync.lightboxVideoApplying = false;
    }
    if (this.el["lightbox-toolbar"]) {
      this.el["lightbox-toolbar"].classList.add("hidden");
    }
    this._cleanupLightboxTempUrl();
    this.lightboxState = null;

    // Hand playback smoothly back to the inline video card with preserved local volume
    if (prevSyncVideoId) {
      const bind = this.mediaSync.videoBindings.get(prevSyncVideoId);
      const st = this.mediaSync.states.get(prevSyncVideoId);
      if (bind && bind.videoEl) {
        if (typeof prevLbVol === "number") {
          try {
            bind.videoEl.volume = prevLbVol;
            bind.videoEl.muted = Boolean(prevLbMuted);
          } catch {
            // ignore
          }
        }
        if (st) {
          this._applyVideoSyncState(bind, st);
        }
      }
    }
  }

  /* ================= E2EE Synchronized Media (Videos, GIFs) & Watch Together ================= */

  /**
   * Publishes a synchronized media state update to all peers in the room via Safe Rust WASM.
   * Volume and mute are never transmitted.
   */
  publishMediaSync(partialState) {
    if (!this.wasm || !partialState || !partialState.targetId) return null;
    const nowMs = Date.now();
    const prev = this.mediaSync.states.get(partialState.targetId);
    const merged = {
      targetId: partialState.targetId,
      kind: partialState.kind || prev?.kind || "video",
      rev: prev?.rev || 0,
      active: partialState.active !== undefined ? Boolean(partialState.active) : true,
      playing: partialState.playing !== undefined ? Boolean(partialState.playing) : Boolean(prev?.playing),
      positionMs:
        partialState.positionMs !== undefined
          ? Math.max(0, Math.round(partialState.positionMs))
          : prev
            ? projectMediaPositionMs(prev, nowMs)
            : 0,
      rateMilli:
        partialState.rateMilli !== undefined
          ? Math.max(250, Math.min(4000, Math.round(partialState.rateMilli)))
          : prev?.rateMilli || 1000,
      loop: partialState.loop !== undefined ? Boolean(partialState.loop) : Boolean(prev?.loop),
      epoch: partialState.epoch !== undefined ? Number(partialState.epoch) : prev?.epoch || 0,
      url: partialState.url !== undefined ? partialState.url : prev?.url || "",
      provider: partialState.provider !== undefined ? partialState.provider : prev?.provider || "",
      mediaId: partialState.mediaId !== undefined ? partialState.mediaId : prev?.mediaId || "",
      title: partialState.title !== undefined ? partialState.title : prev?.title || "",
      sourceMsgId:
        partialState.sourceMsgId !== undefined ? partialState.sourceMsgId : prev?.sourceMsgId || "",
      playlistId:
        partialState.playlistId !== undefined ? partialState.playlistId : prev?.playlistId || "",
      playlistIndex:
        partialState.playlistIndex !== undefined
          ? Math.max(0, Math.min(10000, Math.floor(Number(partialState.playlistIndex) || 0)))
          : Number(prev?.playlistIndex) || 0,
      trackUri: partialState.trackUri !== undefined ? partialState.trackUri : prev?.trackUri || "",
      queue: Array.isArray(partialState.queue) ? partialState.queue : prev?.queue || [],
    };
    try {
      const res = this.wasm.mediaSyncUpdate(merged, nowMs);
      if (res && res.status) {
        this.status = res.status;
      }
      if (res && Array.isArray(res.actions)) {
        this.executeActions(res.actions);
      }
      return res?.state || null;
    } catch (err) {
      this.addTelemetry("error", `Media sync update failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Handles a synchronized media state arriving from local mutation or a remote E2EE peer.
   */
  handleIncomingMediaSync(state) {
    if (!state || !state.targetId) return;
    const prev = this.mediaSync.states.get(state.targetId);
    const normalized = {
      ...state,
      anchorMs: Date.now(),
    };
    this.mediaSync.states.set(state.targetId, normalized);

    if (state.targetId === "watch" || state.kind === "watch") {
      this._applyWatchTogetherState(normalized, prev);
      this._ensureMediaDriftTimer();
      return;
    }

    if (state.kind === "video" || state.targetId.startsWith("vid:")) {
      const bind = this.mediaSync.videoBindings.get(state.targetId);
      if (bind) {
        this._applyVideoSyncState(bind, normalized, prev);
      }
      const isLocalLightboxEcho =
        normalized.actor === this.status?.peerId &&
        this.mediaSync.lightboxVideoSuppressUntil > performance.now();
      if (
        !isLocalLightboxEcho &&
        this.lightboxState &&
        this.lightboxState.kind === "video" &&
        this.lightboxState.syncTargetId === state.targetId
      ) {
        this._applyLightboxVideoSyncState(normalized, prev);
      }
      this._ensureMediaDriftTimer();
      return;
    }

    if (state.kind === "gif" || state.targetId.startsWith("gif:")) {
      const bind = this.mediaSync.gifBindings.get(state.targetId);
      if (bind) {
        this._applyGifSyncState(bind, normalized, prev);
      }
      if (
        normalized.actor !== this.status?.peerId &&
        this.lightboxState &&
        this.lightboxState.kind === "gif" &&
        this.lightboxState.syncTargetId === state.targetId &&
        normalized.epoch > 0 &&
        (!prev || normalized.epoch > (prev.epoch || 0))
      ) {
        const imgEl = this.el["lightbox-img"];
        if (imgEl && this.lightboxState.blob) {
          const nextUrl = URL.createObjectURL(this.lightboxState.blob);
          this._cleanupLightboxTempUrl();
          this.lightboxState.tempUrl = nextUrl;
          imgEl.src = nextUrl;
          imgEl.dataset.replayCount = String((Number(imgEl.dataset.replayCount) || 0) + 1);
        }
      }
    }
  }

  _resetAllMediaSyncState() {
    if (this.mediaSync.gifRafId) {
      cancelAnimationFrame(this.mediaSync.gifRafId);
      this.mediaSync.gifRafId = null;
    }
    if (this.mediaSync.driftTimer) {
      clearInterval(this.mediaSync.driftTimer);
      this.mediaSync.driftTimer = null;
    }
    if (this.mediaSync.watchUiTimer) {
      clearInterval(this.mediaSync.watchUiTimer);
      this.mediaSync.watchUiTimer = null;
    }
    for (const bind of this.mediaSync.gifBindings.values()) {
      this._disposeGifBinding(bind);
    }
    this.mediaSync.gifBindings.clear();
    this.mediaSync.videoBindings.clear();
    this.mediaSync.states.clear();
    this.mediaSync.watchPanelOpenManual = false;
    this.mediaSync.watchMinimized = false;
    this.mediaSync.watchTitleOverride = "";
    this.mediaSync.watchDurationMs = 0;
    if (this.mediaSync.watchPlayer) {
      this.mediaSync.watchPlayer.destroy();
    }
    this._syncWatchTogetherUi(null);
  }

  _disposeGifBinding(bind) {
    if (!bind) return;
    bind.pendingRender = null;
    if (bind.decoder) {
      try {
        bind.decoder.close();
      } catch {
        // ignore
      }
      bind.decoder = null;
    }
    bind.timings = null;
  }

  _cleanupMediaBindingsForMsg(msgId) {
    if (!msgId) return;
    const msgStillExists = this.logMessages.some((item) => item.id === msgId);
    const vidPrefix = `vid:${msgId}:`;
    const gifPrefix = `gif:${msgId}:`;
    for (const [k, bind] of Array.from(this.mediaSync.gifBindings.entries())) {
      if (k.startsWith(gifPrefix)) {
        this._disposeGifBinding(bind);
        this.mediaSync.gifBindings.delete(k);
        if (!msgStillExists) {
          this.mediaSync.states.delete(k);
        }
      }
    }
    for (const k of Array.from(this.mediaSync.videoBindings.keys())) {
      if (k.startsWith(vidPrefix)) {
        this.mediaSync.videoBindings.delete(k);
        if (!msgStillExists) {
          this.mediaSync.states.delete(k);
        }
      }
    }
  }

  /* ---- Frame-Accurate Rust + ImageDecoder GIF Synchronization ---- */

  async _initGifSyncEngine(bind, blob) {
    if (!bind || !blob || !this.wasm) return;
    try {
      // Yield a macrotask when voice is active so large GIF decoding never competes with 20ms audio frames
      if (this.voice?.joined) {
        await new Promise((r) => setTimeout(r, 40));
      }
      const buf = await blob.arrayBuffer();
      if (!bind.imgEl || !bind.imgEl.isConnected) return;
      const bytes = new Uint8Array(buf);
      const timings = this.wasm.parseGifTimings(bytes);
      if (!timings || timings.frameCount <= 1 || timings.totalDurationMs <= 0) {
        return;
      }
      bind.timings = timings;

      if (typeof ImageDecoder === "function") {
        if (this.voice?.joined) {
          await new Promise((r) => setTimeout(r, 16));
        }
        let supported = true;
        if (typeof ImageDecoder.isTypeSupported === "function") {
          supported = await ImageDecoder.isTypeSupported("image/gif").catch(() => false);
        }
        if (supported && bind.imgEl.isConnected) {
          // Zero-copy: bytes is already our exclusive copy from blob.arrayBuffer()
          const decoder = new ImageDecoder({
            data: bytes,
            type: "image/gif",
          });
          await decoder.tracks.ready;
          if (!bind.imgEl.isConnected) {
            decoder.close();
            return;
          }
          bind.decoder = decoder;
          const st = this.mediaSync.states.get(bind.syncTargetId);
          if (st) {
            this._applyGifSyncState(bind, st, null);
          } else {
            // Deterministic local anchor until a synced peer broadcasts state
            this.mediaSync.states.set(bind.syncTargetId, {
              targetId: bind.syncTargetId,
              kind: "gif",
              rev: 0,
              actor: "",
              actorName: "",
              active: true,
              playing: true,
              positionMs: 0,
              rateMilli: 1000,
              loop: true,
              epoch: 0,
              anchorMs: Date.now(),
            });
            if (bind.syncCanvasEl) bind.syncCanvasEl.classList.remove("hidden");
          }
          this._ensureGifSyncLoop();
        }
      }
    } catch {
      // Fallback gracefully to native <img> + freeze canvas sync
    }
  }

  _ensureGifSyncLoop() {
    if (this.mediaSync.gifRafId || this.mediaSync.gifBindings.size === 0) return;
    this.mediaSync.gifRafId = requestAnimationFrame(this.mediaSync.boundGifTick);
  }

  _renderGifFrameToCanvas(bind, frameIdx, targetCanvas, mirrorCanvas = null) {
    if (!bind || !bind.decoder || !targetCanvas) return;
    if (bind.decoding) {
      bind.pendingRender = { frameIdx, targetCanvas, mirrorCanvas };
      return;
    }
    bind.decoding = true;
    const clampedIdx = Math.max(0, Math.min((bind.timings?.frameCount || 1) - 1, frameIdx));
    bind.decoder
      .decode({ frameIndex: clampedIdx })
      .then((res) => {
        const frame = res?.image;
        if (!frame) return;
        try {
          const w = frame.displayWidth || frame.codedWidth || bind.timings?.width || 0;
          const h = frame.displayHeight || frame.codedHeight || bind.timings?.height || 0;
          if (w > 0 && h > 0) {
            if (targetCanvas.width !== w || targetCanvas.height !== h) {
              targetCanvas.width = w;
              targetCanvas.height = h;
            }
            const ctx = targetCanvas.getContext("2d");
            if (ctx) {
              ctx.clearRect(0, 0, w, h);
              ctx.drawImage(frame, 0, 0, w, h);
            }
            targetCanvas.dataset.gifFrame = String(clampedIdx);
            if (bind.imgEl) {
              bind.imgEl.dataset.gifFrame = String(clampedIdx);
            }
            if (mirrorCanvas) {
              if (mirrorCanvas.width !== w || mirrorCanvas.height !== h) {
                mirrorCanvas.width = w;
                mirrorCanvas.height = h;
              }
              const mCtx = mirrorCanvas.getContext("2d");
              if (mCtx) {
                mCtx.clearRect(0, 0, w, h);
                mCtx.drawImage(frame, 0, 0, w, h);
              }
              mirrorCanvas.dataset.gifFrame = String(clampedIdx);
            }
          }
          bind.lastRenderedFrame = clampedIdx;
        } finally {
          frame.close();
        }
      })
      .catch(() => {
        // ignore transient decode race
      })
      .finally(() => {
        bind.decoding = false;
        const next = bind.pendingRender;
        bind.pendingRender = null;
        if (next && bind.decoder) {
          this._renderGifFrameToCanvas(bind, next.frameIdx, next.targetCanvas, next.mirrorCanvas);
        }
      });
  }

  _tickSyncedGifs() {
    this.mediaSync.gifRafId = null;
    if (this.mediaSync.gifBindings.size === 0) return;

    const nowMs = Date.now();
    let anyActive = false;
    const lbOpenGifId =
      this.lightboxState?.kind === "gif" ? this.lightboxState.syncTargetId : "";
    const lbCanvas = lbOpenGifId ? this.el["lightbox-gif-canvas"] : null;

    for (const [id, bind] of this.mediaSync.gifBindings.entries()) {
      if (!bind.imgEl || !bind.imgEl.isConnected) {
        this._disposeGifBinding(bind);
        this.mediaSync.gifBindings.delete(id);
        continue;
      }
      if (!bind.decoder || !bind.timings) continue;
      const st = this.mediaSync.states.get(id);
      if (!st || !st.playing) continue;
      anyActive = true;

      const posMs = projectMediaPositionMs(st, nowMs);
      const frameIdx = frameIndexForGifTime(bind.timings, posMs);
      const isInLightbox = lbOpenGifId === id && lbCanvas;
      if (isInLightbox && lbCanvas.classList.contains("hidden")) {
        lbCanvas.classList.remove("hidden");
      }
      if (frameIdx !== bind.lastRenderedFrame && !bind.decoding) {
        if (bind.syncCanvasEl && bind.syncCanvasEl.classList.contains("hidden")) {
          bind.syncCanvasEl.classList.remove("hidden");
        }
        this._renderGifFrameToCanvas(
          bind,
          frameIdx,
          bind.syncCanvasEl || bind.canvasEl,
          isInLightbox ? lbCanvas : null
        );
      }
    }

    if (anyActive) {
      this.mediaSync.gifRafId = requestAnimationFrame(this.mediaSync.boundGifTick);
    }
  }

  _applyGifSyncState(bind, state, prev) {
    if (!bind || !bind.imgEl) return;
    const isEpochReplay = Boolean(
      state.epoch > 0 &&
        state.epoch > (bind.lastAppliedEpoch || 0) &&
        (!prev || state.epoch > (prev.epoch || 0)) &&
        (prev || (state.playing && (state.positionMs || 0) < 500))
    );
    const wasPaused = bind.isPaused;
    bind.lastAppliedEpoch = Math.max(bind.lastAppliedEpoch || 0, state.epoch || 0);

    if (bind.syncPillEl) {
      const who =
        state.actorName && state.actor && state.actor !== this.status?.peerId
          ? `Synced · ${state.actorName}`
          : "Synced";
      bind.syncPillEl.textContent = state.playing ? who : `${who} (Paused)`;
    }

    if (!state.playing) {
      // Exact synchronized Pause!
      bind.isPaused = true;
      if (bind.pauseBtn) {
        bind.pauseBtn.textContent = "Play";
        bind.pauseBtn.classList.add("is-active");
      }
      if (bind.syncCanvasEl) {
        bind.syncCanvasEl.classList.add("hidden");
      }
      if (bind.canvasEl) {
        if (bind.decoder && bind.timings) {
          const pausedFrame = frameIndexForGifTime(bind.timings, state.positionMs || 0);
          const lbCanvas =
            this.lightboxState?.kind === "gif" && this.lightboxState.syncTargetId === bind.syncTargetId
              ? this.el["lightbox-gif-canvas"]
              : null;
          bind.lastRenderedFrame = -1;
          this._renderGifFrameToCanvas(bind, pausedFrame, bind.canvasEl, lbCanvas);
          bind.canvasEl.classList.remove("hidden");
          if (lbCanvas) lbCanvas.classList.remove("hidden");
        } else {
          const w = bind.imgEl.naturalWidth || bind.imgEl.width || 0;
          const h = bind.imgEl.naturalHeight || bind.imgEl.height || 0;
          if (w > 0 && h > 0) {
            bind.canvasEl.width = w;
            bind.canvasEl.height = h;
            const ctx2d = bind.canvasEl.getContext("2d");
            if (ctx2d) {
              ctx2d.clearRect(0, 0, w, h);
              ctx2d.drawImage(bind.imgEl, 0, 0, w, h);
            }
          }
          bind.canvasEl.classList.remove("hidden");
        }
      }
      return;
    }

    // Playing (either resumed from pause, replayed from frame 0, or initial sync)
    bind.isPaused = false;
    if (bind.canvasEl) bind.canvasEl.classList.add("hidden");
    if (bind.pauseBtn) {
      bind.pauseBtn.textContent = "Pause";
      bind.pauseBtn.classList.remove("is-active");
    }

    if (isEpochReplay || wasPaused) {
      // Refresh native <img> Blob URL too for fallback browsers & replay count parity
      if (isEpochReplay && bind.g.blob) {
        const prevUrl = bind.g.currentUrl;
        const nextUrl = URL.createObjectURL(bind.g.blob);
        bind.g.currentUrl = nextUrl;
        this._swapMessageMediaUrl(bind.msgId, prevUrl, nextUrl);
        bind.imgEl.src = nextUrl;
      } else if (isEpochReplay && bind.g.dataUrl) {
        bind.imgEl.src = "";
        requestAnimationFrame(() => {
          if (bind.imgEl.isConnected) bind.imgEl.src = bind.g.dataUrl;
        });
      }
      bind.imgEl.dataset.replayCount = String((Number(bind.imgEl.dataset.replayCount) || 0) + 1);
      if (isEpochReplay && bind.replayBtn) {
        bind.replayBtn.classList.add("is-replayed");
        setTimeout(() => bind.replayBtn?.classList.remove("is-replayed"), 320);
      }
    }

    if (bind.decoder && bind.timings) {
      if (bind.syncCanvasEl) bind.syncCanvasEl.classList.remove("hidden");
      bind.lastRenderedFrame = -1;
      const curFrame = frameIndexForGifTime(bind.timings, projectMediaPositionMs(state, Date.now()));
      const lbCanvas =
        this.lightboxState?.kind === "gif" && this.lightboxState.syncTargetId === bind.syncTargetId
          ? this.el["lightbox-gif-canvas"]
          : null;
      this._renderGifFrameToCanvas(bind, curFrame, bind.syncCanvasEl || bind.canvasEl, lbCanvas);
      this._ensureGifSyncLoop();
    }
  }

  /* ---- Bidirectional E2EE Chat Video Synchronization (Local-Only Volume) ---- */

  _applyVideoSyncState(bind, state, prev = null) {
    if (!bind || !bind.videoEl) return;
    const videoEl = bind.videoEl;

    // If this video is currently open in Lightbox, let Lightbox drive playback instead of playing twice
    const openInLightbox =
      this.lightboxState?.kind === "video" && this.lightboxState.syncTargetId === bind.syncTargetId;

    const isReplay = Boolean(
      state.epoch > 0 &&
        state.epoch > (bind.lastAppliedEpoch || 0) &&
        (!prev || state.epoch > (prev.epoch || 0)) &&
        (prev || (state.playing && (state.positionMs || 0) < 500))
    );
    bind.lastAppliedEpoch = Math.max(bind.lastAppliedEpoch || 0, state.epoch || 0);

    // Always sync Loop button & indicator (even while in Lightbox)
    videoEl.loop = Boolean(state.loop);
    if (bind.loopBtn) {
      bind.loopBtn.textContent = videoEl.loop ? "Loop: On" : "Loop: Off";
      bind.loopBtn.classList.toggle("is-active", videoEl.loop);
    }
    if (bind.syncPillEl) {
      const who =
        state.actorName && state.actor && state.actor !== this.status?.peerId
          ? `Synced · ${state.actorName}`
          : "Synced";
      bind.syncPillEl.textContent = state.playing ? who : `${who} (Paused)`;
    }
    if (videoEl.loop && bind.endedOverlay) {
      bind.endedOverlay.classList.add("hidden");
    }

    if (openInLightbox) return;

    if (isReplay) {
      if (bind.endedOverlay) bind.endedOverlay.classList.add("hidden");
      videoEl.dataset.replayCount = String((Number(videoEl.dataset.replayCount) || 0) + 1);
      for (const rb of bind.replayBtns || []) {
        if (rb.classList.contains("media-ctrl-btn")) {
          rb.classList.add("is-replayed");
          setTimeout(() => rb.classList.remove("is-replayed"), 320);
        }
      }
    }

    const applyToElement = () => {
      let didMutate = false;
      bind.applyingRemote = true;
      const baseRate = (Number(state.rateMilli) || 1000) / 1000;
      if (Math.abs((videoEl.playbackRate || 1) - baseRate) > 0.02) {
        try {
          videoEl.playbackRate = baseRate;
          didMutate = true;
        } catch {
          // ignore
        }
      }

      let targetSec = projectMediaPositionMs(state, Date.now()) / 1000;
      const dur = videoEl.duration;
      if (dur && Number.isFinite(dur) && dur > 0) {
        if (videoEl.loop) {
          targetSec = targetSec % dur;
        } else {
          targetSec = Math.min(targetSec, Math.max(0, dur - 0.04));
        }
      }

      if (isReplay || Math.abs((videoEl.currentTime || 0) - targetSec) > 0.25) {
        try {
          videoEl.currentTime = isReplay && targetSec < 0.12 ? 0 : targetSec;
          didMutate = true;
        } catch {
          // ignore if not seekable yet
        }
      }

      if (state.playing) {
        if (bind.endedOverlay) bind.endedOverlay.classList.add("hidden");
        if (videoEl.paused || isReplay) {
          didMutate = true;
          const p = videoEl.play();
          if (p && typeof p.catch === "function") {
            p.catch((err) => {
              // Browser autoplay policy blocked unmuted play -> retry locally muted WITHOUT affecting peers!
              if (err && err.name === "NotAllowedError" && !videoEl.muted) {
                videoEl.muted = true;
                if (bind.unmuteOverlay) {
                  bind.unmuteOverlay.classList.remove("hidden");
                }
                const p2 = videoEl.play();
                if (p2 && typeof p2.catch === "function") p2.catch(() => {});
              }
            });
          }
        }
      } else if (!videoEl.paused) {
        try {
          videoEl.pause();
          didMutate = true;
        } catch {
          // ignore
        }
      }
      if (didMutate) {
        bind.suppressUntil = performance.now() + 380;
      }
      bind.applyingRemote = false;
    };

    if (videoEl.readyState >= 1) {
      applyToElement();
    } else {
      videoEl.addEventListener("loadedmetadata", applyToElement, { once: true });
    }
  }

  _applyLightboxVideoSyncState(state, prev = null) {
    const videoEl = this.el["lightbox-video"];
    const loopBtn = this.el["btn-lightbox-loop"];
    if (!videoEl || videoEl.classList.contains("hidden")) return;

    this.mediaSync.lightboxVideoApplying = true;
    this.mediaSync.lightboxVideoSuppressUntil = performance.now() + 450;
    videoEl.loop = Boolean(state.loop);
    if (loopBtn) {
      loopBtn.textContent = videoEl.loop ? "Loop: On" : "Loop: Off";
      loopBtn.classList.toggle("is-active", videoEl.loop);
    }
    const baseRate = (Number(state.rateMilli) || 1000) / 1000;
    if (Math.abs((videoEl.playbackRate || 1) - baseRate) > 0.02) {
      try {
        videoEl.playbackRate = baseRate;
      } catch {
        // ignore
      }
    }
    const isReplay = Boolean(prev && state.epoch > (prev.epoch || 0));
    let targetSec = projectMediaPositionMs(state, Date.now()) / 1000;
    if (videoEl.duration && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      targetSec = videoEl.loop
        ? targetSec % videoEl.duration
        : Math.min(targetSec, Math.max(0, videoEl.duration - 0.04));
    }
    if (isReplay || Math.abs((videoEl.currentTime || 0) - targetSec) > 0.28) {
      try {
        videoEl.currentTime = isReplay ? 0 : targetSec;
      } catch {
        // ignore
      }
    }
    if (state.playing) {
      if (videoEl.paused || isReplay) {
        const p = videoEl.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    } else if (!videoEl.paused) {
      try {
        videoEl.pause();
      } catch {
        // ignore
      }
    }
    this.mediaSync.lightboxVideoApplying = false;
  }

  _ensureMediaDriftTimer() {
    if (this.mediaSync.driftTimer) return;
    this.mediaSync.driftTimer = setInterval(() => this._runMediaDriftCorrection(), 1200);
  }

  _runMediaDriftCorrection() {
    const nowMs = Date.now();
    let anyPlaying = false;

    for (const [id, bind] of this.mediaSync.videoBindings.entries()) {
      if (!bind.videoEl || !bind.videoEl.isConnected) {
        this.mediaSync.videoBindings.delete(id);
        continue;
      }
      const st = this.mediaSync.states.get(id);
      if (!st || !st.active || !st.playing) continue;
      anyPlaying = true;
      if (this.lightboxState?.kind === "video" && this.lightboxState.syncTargetId === id) {
        continue;
      }
      const vid = bind.videoEl;
      if (vid.paused || vid.ended || vid.readyState < 2 || performance.now() < bind.suppressUntil) {
        continue;
      }
      const baseRate = (Number(st.rateMilli) || 1000) / 1000;
      let expectedSec = projectMediaPositionMs(st, nowMs) / 1000;
      if (vid.duration && Number.isFinite(vid.duration) && vid.duration > 0) {
        if (vid.loop) {
          expectedSec = expectedSec % vid.duration;
        } else if (expectedSec >= vid.duration) {
          continue;
        }
      }
      const drift = expectedSec - (vid.currentTime || 0);
      if (Math.abs(drift) > 0.75) {
        bind.applyingRemote = true;
        bind.suppressUntil = performance.now() + 450;
        try {
          vid.playbackRate = baseRate;
          vid.currentTime = expectedSec;
        } catch {
          // ignore
        }
        bind.applyingRemote = false;
      } else if (Math.abs(drift) > 0.18) {
        // Gentle ±5% speed catch-up avoids audible seek glitches
        bind.applyingRemote = true;
        try {
          vid.playbackRate = baseRate * (drift > 0 ? 1.05 : 0.95);
        } catch {
          // ignore
        }
        bind.applyingRemote = false;
      } else if (Math.abs((vid.playbackRate || 1) - baseRate) > 0.01) {
        bind.applyingRemote = true;
        try {
          vid.playbackRate = baseRate;
        } catch {
          // ignore
        }
        bind.applyingRemote = false;
      }
    }

    const watchSt = this.mediaSync.states.get("watch");
    if (watchSt && watchSt.active && watchSt.playing) {
      anyPlaying = true;
      if (this.mediaSync.watchPlayer) {
        this.mediaSync.watchPlayer.correctDrift(watchSt, nowMs);
      }
    }

    if (!anyPlaying && this.mediaSync.driftTimer) {
      clearInterval(this.mediaSync.driftTimer);
      this.mediaSync.driftTimer = null;
    }
  }

  /* ---- Synced Watch Together (YouTube / YouTube Music / Spotify / SoundCloud + Playlists) ---- */

  _watchProviderLabel(provider) {
    if (provider === "ytmusic") return "YT MUSIC";
    if (provider === "youtube") return "YOUTUBE";
    if (provider === "spotify") return "SPOTIFY";
    if (provider === "soundcloud") return "SOUNDCLOUD";
    return String(provider || "WATCH").toUpperCase();
  }

  _isWatchPlaylistState(state) {
    return Boolean(
      state &&
        state.active &&
        (state.playlistId || this.mediaSync.watchPlaylistCount > 1)
    );
  }

  _ensureWatchPlayer() {
    if (this.mediaSync.watchPlayer) return this.mediaSync.watchPlayer;
    const mountEl = this.el["watch-embed-stage"];
    this.mediaSync.watchPlayer = new WatchTogetherPlayer(mountEl, {
      onUserAction: (ev) => {
        const cur = this.mediaSync.states.get("watch");
        if (!cur || !cur.active) return;
        if (ev.ended) {
          if (cur.loop) {
            if (cur.playlistId && (cur.playlistIndex || 0) > 0 && cur.provider !== "spotify") {
              this.selectWatchPlaylistTrack(0);
            } else {
              this.replayWatch();
            }
          } else if (Array.isArray(cur.queue) && cur.queue.length > 0) {
            // Actor advances immediately; other peers act as backup after 900ms if actor disconnected
            const isActor = cur.actor === this.status?.peerId;
            const prevRev = cur.rev;
            const delay = isActor ? 50 : 900;
            setTimeout(() => {
              const live = this.mediaSync.states.get("watch");
              if (live && live.active && live.rev === prevRev && live.queue.length > 0) {
                this.playNextWatchQueueItem();
              }
            }, delay);
          } else if (cur.playing) {
            this.publishMediaSync({
              targetId: "watch",
              kind: "watch",
              playing: false,
              positionMs: ev.positionMs || this.mediaSync.watchDurationMs || cur.positionMs,
              playlistIndex: ev.playlistIndex !== undefined ? ev.playlistIndex : cur.playlistIndex || 0,
              trackUri: ev.trackUri !== undefined ? ev.trackUri : cur.trackUri || "",
            });
          }
          return;
        }
        const update = {
          targetId: "watch",
          kind: "watch",
          active: true,
          playing: Boolean(ev.playing),
          positionMs: Math.max(0, Math.round(ev.positionMs || 0)),
          rateMilli: ev.rateMilli || cur.rateMilli || 1000,
        };
        if (ev.playlistIndex !== undefined) {
          update.playlistIndex = ev.playlistIndex;
        }
        if (ev.trackUri !== undefined) {
          update.trackUri = ev.trackUri;
        }
        this.publishMediaSync(update);
      },
      onTelemetry: (meta) => {
        if (meta.durationMs > 0) {
          this.mediaSync.watchDurationMs = meta.durationMs;
        }
        if (meta.title) {
          this.mediaSync.watchTitleOverride = meta.title;
          if (this.el["watch-panel-title"]) {
            this.el["watch-panel-title"].textContent = meta.title;
          }
        }
        let playlistMetaChanged = false;
        if (typeof meta.playlistCount === "number" && meta.playlistCount !== this.mediaSync.watchPlaylistCount) {
          this.mediaSync.watchPlaylistCount = meta.playlistCount;
          playlistMetaChanged = true;
        }
        if (Array.isArray(meta.playlistItems) && meta.playlistItems.length > 0) {
          this.mediaSync.watchPlaylistItems = meta.playlistItems;
          playlistMetaChanged = true;
        }
        if (
          typeof meta.spotifyTrackDetached === "boolean" &&
          meta.spotifyTrackDetached !== this.mediaSync.watchSpotifyTrackDetached
        ) {
          this.mediaSync.watchSpotifyTrackDetached = meta.spotifyTrackDetached;
          playlistMetaChanged = true;
        }
        if (playlistMetaChanged) {
          const cur = this.mediaSync.states.get("watch");
          if (cur && cur.active) {
            this._syncWatchTogetherUi(cur);
          }
        }
        this._updateWatchTimeUi();
      },
      onAutoplayMuted: (isMuted) => {
        if (this.el["btn-watch-autoplay-unmute"]) {
          this.el["btn-watch-autoplay-unmute"].classList.toggle("hidden", !isMuted);
        }
        this._updateWatchLocalVolUi();
      },
    });
    return this.mediaSync.watchPlayer;
  }

  toggleWatchPanelDrawer() {
    const cur = this.mediaSync.states.get("watch");
    if (cur && cur.active) {
      this.toggleWatchMinimize();
      return;
    }
    this.mediaSync.watchPanelOpenManual = !this.mediaSync.watchPanelOpenManual;
    this._syncWatchTogetherUi(cur || null);
    if (this.mediaSync.watchPanelOpenManual && this.el["watch-url-input"]) {
      this.el["watch-url-input"].focus();
    }
  }

  toggleWatchMinimize() {
    this.mediaSync.watchMinimized = !this.mediaSync.watchMinimized;
    const panel = this.el["watch-panel"];
    const btn = this.el["btn-watch-minimize"];
    if (panel) panel.classList.toggle("is-minimized", this.mediaSync.watchMinimized);
    if (btn) {
      btn.textContent = this.mediaSync.watchMinimized ? "Expand" : "Minimize";
      btn.setAttribute("aria-expanded", String(!this.mediaSync.watchMinimized));
    }
  }

  startWatchTogetherFromUrl(rawUrl, sourceMsgId = "") {
    const parsed = parseWatchMediaUrl(rawUrl);
    if (!parsed) {
      this.showToast("Paste a valid YouTube, YouTube Music, Spotify, or SoundCloud link or playlist");
      return false;
    }
    const prev = this.mediaSync.states.get("watch");
    this.mediaSync.watchMinimized = false;
    this.mediaSync.watchPanelOpenManual = true;
    this.mediaSync.watchTitleOverride = "";
    this.mediaSync.watchDurationMs = 0;
    this.mediaSync.watchPlaylistCount = 0;
    this.mediaSync.watchPlaylistItems = [];
    this.mediaSync.watchTracksOpen = false;
    this.mediaSync.watchSpotifyTrackDetached = false;

    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      playing: true,
      positionMs: parsed.startMs || 0,
      rateMilli: 1000,
      loop: Boolean(prev?.loop),
      epoch: (prev?.epoch || 0) + 1,
      url: parsed.url,
      provider: parsed.provider,
      mediaId: parsed.mediaId,
      title: parsed.title,
      sourceMsgId: sourceMsgId || "",
      playlistId: parsed.playlistId || "",
      playlistIndex: parsed.playlistIndex || 0,
      trackUri: parsed.trackUri || "",
      queue: Array.isArray(prev?.queue) ? prev.queue : [],
    });
    const kindWord = parsed.isPlaylist ? " playlist" : "";
    this.showToast(`Started synced ${parsed.providerLabel}${kindWord} for room`);
    return true;
  }

  enqueueWatchUrl(rawUrl) {
    const parsed = parseWatchMediaUrl(rawUrl);
    if (!parsed) {
      this.showToast("Paste a valid YouTube, YouTube Music, Spotify, or SoundCloud link or playlist");
      return false;
    }
    const prev = this.mediaSync.states.get("watch");
    if (!prev || !prev.active || !prev.mediaId) {
      return this.startWatchTogetherFromUrl(rawUrl, "");
    }
    const nextQueue = Array.isArray(prev.queue) ? prev.queue.slice(0, 63) : [];
    nextQueue.push({
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      url: parsed.url,
      provider: parsed.provider,
      mediaId: parsed.mediaId,
      title: parsed.title,
      addedBy: this.status?.authorName || "Peer",
      startMs: parsed.startMs || 0,
      playlistId: parsed.playlistId || "",
      playlistIndex: parsed.playlistIndex || 0,
    });
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      queue: nextQueue,
    });
    const noun = parsed.isPlaylist ? "playlist" : "track";
    this.showToast(`Queued ${parsed.providerLabel} ${noun} (#${nextQueue.length})`);
    return true;
  }

  toggleWatchPlay() {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !cur.active) return;
    const nowPos = projectMediaPositionMs(cur, Date.now());
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      playing: !cur.playing,
      positionMs: nowPos,
    });
  }

  seekWatchBy(deltaMs) {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !cur.active) return;
    const nowPos = projectMediaPositionMs(cur, Date.now());
    const dur = this.mediaSync.watchDurationMs || 0;
    let nextPos = Math.max(0, nowPos + deltaMs);
    if (dur > 0) nextPos = Math.min(nextPos, dur);
    this.seekWatchTo(nextPos);
  }

  seekWatchTo(posMs) {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !cur.active) return;
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      playing: cur.playing,
      positionMs: Math.max(0, Math.round(posMs)),
    });
  }

  replayWatch() {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !cur.active) return;
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      playing: true,
      positionMs: 0,
      epoch: (cur.epoch || 0) + 1,
    });
  }

  toggleWatchLoop() {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !cur.active) return;
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      loop: !cur.loop,
    });
  }

  setWatchSpeed(rateMilli) {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !cur.active) return;
    const clamped = Math.max(250, Math.min(4000, Math.round(rateMilli || 1000)));
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      positionMs: projectMediaPositionMs(cur, Date.now()),
      rateMilli: clamped,
    });
  }

  selectWatchPlaylistTrack(idx) {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !cur.active || !this._isWatchPlaylistState(cur)) return;
    const count = this.mediaSync.watchPlaylistCount || 0;
    let targetIdx = Math.max(0, Math.floor(Number(idx) || 0));
    if (count > 0) {
      targetIdx = Math.min(count - 1, targetIdx);
    }
    const item = this.mediaSync.watchPlaylistItems[targetIdx];
    this.mediaSync.watchDurationMs = item?.durationMs > 0 ? item.durationMs : 0;
    if (item?.title) {
      this.mediaSync.watchTitleOverride = item.artist ? `${item.artist} — ${item.title}` : item.title;
    }
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      playing: true,
      positionMs: 0,
      playlistIndex: targetIdx,
      trackUri: item?.id && cur.provider !== "soundcloud" ? item.id : "",
      epoch: (cur.epoch || 0) + 1,
    });
  }

  playPrevWatchTrack() {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !cur.active || !this._isWatchPlaylistState(cur) || cur.provider === "spotify") return;
    const curIdx = Math.max(0, Number(cur.playlistIndex) || 0);
    const count = this.mediaSync.watchPlaylistCount || 0;
    if (curIdx > 0) {
      this.selectWatchPlaylistTrack(curIdx - 1);
    } else if (cur.loop && count > 1) {
      this.selectWatchPlaylistTrack(count - 1);
    } else {
      this.replayWatch();
    }
  }

  playNextWatchTrackOrQueue() {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !cur.active) return;
    const isIndexablePlaylist = this._isWatchPlaylistState(cur) && cur.provider !== "spotify";
    if (isIndexablePlaylist) {
      const curIdx = Math.max(0, Number(cur.playlistIndex) || 0);
      const count = this.mediaSync.watchPlaylistCount || 0;
      if (count === 0 || curIdx + 1 < count) {
        this.selectWatchPlaylistTrack(curIdx + 1);
        return;
      }
      if (Array.isArray(cur.queue) && cur.queue.length > 0) {
        this.playWatchQueueItemAt(0);
        return;
      }
      if (cur.loop && count > 0) {
        this.selectWatchPlaylistTrack(0);
      }
      return;
    }
    this.playNextWatchQueueItem();
  }

  toggleWatchPlaylistTracks() {
    this.mediaSync.watchTracksOpen = !this.mediaSync.watchTracksOpen;
    const cur = this.mediaSync.states.get("watch");
    this._renderWatchPlaylistBar(cur || null);
  }

  showWatchSpotifyPlaylist() {
    if (this.mediaSync.watchPlayer) {
      this.mediaSync.watchPlayer.showSpotifyPlaylistView();
    }
  }

  playNextWatchQueueItem() {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !Array.isArray(cur.queue) || cur.queue.length === 0) return;
    this.playWatchQueueItemAt(0);
  }

  playWatchQueueItemAt(idx) {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !Array.isArray(cur.queue) || idx < 0 || idx >= cur.queue.length) return;
    const item = cur.queue[idx];
    const remaining = cur.queue.slice(0, idx).concat(cur.queue.slice(idx + 1));
    this.mediaSync.watchTitleOverride = "";
    this.mediaSync.watchDurationMs = 0;
    this.mediaSync.watchPlaylistCount = 0;
    this.mediaSync.watchPlaylistItems = [];
    this.mediaSync.watchTracksOpen = false;
    this.mediaSync.watchSpotifyTrackDetached = false;
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      playing: true,
      positionMs: item.startMs || 0,
      rateMilli: 1000,
      epoch: (cur.epoch || 0) + 1,
      url: item.url,
      provider: item.provider,
      mediaId: item.mediaId,
      title: item.title,
      sourceMsgId: "",
      playlistId: item.playlistId || "",
      playlistIndex: item.playlistIndex || 0,
      trackUri: "",
      queue: remaining,
    });
  }

  removeWatchQueueItemAt(idx) {
    const cur = this.mediaSync.states.get("watch");
    if (!cur || !Array.isArray(cur.queue) || idx < 0 || idx >= cur.queue.length) return;
    const remaining = cur.queue.slice(0, idx).concat(cur.queue.slice(idx + 1));
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: cur.active,
      queue: remaining,
    });
  }

  stopWatchTogetherForRoom() {
    const cur = this.mediaSync.states.get("watch");
    this.mediaSync.watchPanelOpenManual = false;
    this.mediaSync.watchMinimized = false;
    this.mediaSync.watchPlaylistCount = 0;
    this.mediaSync.watchPlaylistItems = [];
    this.mediaSync.watchTracksOpen = false;
    this.mediaSync.watchSpotifyTrackDetached = false;
    if (cur && cur.active) {
      this.publishMediaSync({
        targetId: "watch",
        kind: "watch",
        active: false,
        playing: false,
        positionMs: 0,
        url: "",
        provider: "",
        mediaId: "",
        title: "",
        playlistId: "",
        playlistIndex: 0,
        trackUri: "",
        queue: [],
      });
    } else {
      this._syncWatchTogetherUi(null);
    }
  }

  setWatchLocalVolume(vol0To100) {
    const player = this._ensureWatchPlayer();
    player.setLocalVolume(vol0To100);
    this._updateWatchLocalVolUi();
  }

  setWatchLocalMuted(muted) {
    const player = this._ensureWatchPlayer();
    player.setLocalMuted(muted);
    this._updateWatchLocalVolUi();
  }

  toggleWatchLocalMute() {
    const player = this._ensureWatchPlayer();
    player.setLocalMuted(!player.localMuted);
    this._updateWatchLocalVolUi();
  }

  _updateWatchLocalVolUi() {
    const player = this.mediaSync.watchPlayer;
    if (!player) return;
    if (this.el["watch-local-volume"]) {
      this.el["watch-local-volume"].value = String(player.localVolume);
    }
    if (this.el["btn-watch-local-mute"]) {
      this.el["btn-watch-local-mute"].textContent = player.localMuted ? "Muted" : "Vol";
      this.el["btn-watch-local-mute"].classList.toggle("is-active", player.localMuted);
    }
    if (this.el["watch-local-vol-val"]) {
      this.el["watch-local-vol-val"].textContent = player.localMuted
        ? "Muted · Local"
        : `${player.localVolume}% · Local`;
    }
  }

  _applyWatchTogetherState(state, prev) {
    if (!state || !state.active || !state.provider || !state.mediaId) {
      if (prev && prev.active) {
        this.mediaSync.watchPanelOpenManual = false;
        this.mediaSync.watchMinimized = false;
      }
      if (this.mediaSync.watchPlayer) {
        this.mediaSync.watchPlayer.destroy();
      }
      this.mediaSync.watchDurationMs = 0;
      this.mediaSync.watchTitleOverride = "";
      this.mediaSync.watchPlaylistCount = 0;
      this.mediaSync.watchPlaylistItems = [];
      this.mediaSync.watchTracksOpen = false;
      this.mediaSync.watchSpotifyTrackDetached = false;
      if (this.mediaSync.watchUiTimer) {
        clearInterval(this.mediaSync.watchUiTimer);
        this.mediaSync.watchUiTimer = null;
      }
      this._syncWatchTogetherUi(state);
      return;
    }

    const mediaChanged =
      !prev ||
      prev.mediaId !== state.mediaId ||
      prev.provider !== state.provider ||
      (prev.playlistId || "") !== (state.playlistId || "");
    if (mediaChanged) {
      this.mediaSync.watchTitleOverride = "";
      this.mediaSync.watchDurationMs = 0;
      this.mediaSync.watchPlaylistCount = 0;
      this.mediaSync.watchPlaylistItems = [];
      this.mediaSync.watchTracksOpen = false;
      this.mediaSync.watchSpotifyTrackDetached = false;
      this.mediaSync.watchMinimized = false;
      if (this.el["btn-watch-autoplay-unmute"]) {
        this.el["btn-watch-autoplay-unmute"].classList.add("hidden");
      }
    }

    this._syncWatchTogetherUi(state);
    const player = this._ensureWatchPlayer();
    player.applyState(state, Date.now());

    if (!this.mediaSync.watchUiTimer) {
      this.mediaSync.watchUiTimer = setInterval(() => this._updateWatchTimeUi(), 400);
    }
  }

  _syncWatchTogetherUi(state) {
    const panel = this.el["watch-panel"];
    const triggerBtn = this.el["btn-open-watch-panel"];
    if (!panel) return;

    const isActive = Boolean(state && state.active && state.provider && state.mediaId);
    const shouldShow = isActive || this.mediaSync.watchPanelOpenManual;
    panel.classList.toggle("hidden", !shouldShow);
    if (triggerBtn) {
      triggerBtn.classList.toggle("is-active", isActive);
      triggerBtn.textContent = isActive ? "● Watch Together" : "▶ Watch Together";
    }
    if (!shouldShow) return;

    panel.classList.remove(
      "provider-youtube",
      "provider-ytmusic",
      "provider-spotify",
      "provider-soundcloud",
      "is-playlist",
      "is-spotify-collection",
      "is-soundcloud-playlist"
    );
    panel.classList.toggle("is-minimized", this.mediaSync.watchMinimized);
    if (this.el["btn-watch-minimize"]) {
      this.el["btn-watch-minimize"].textContent = this.mediaSync.watchMinimized ? "Expand" : "Minimize";
      this.el["btn-watch-minimize"].setAttribute("aria-expanded", String(!this.mediaSync.watchMinimized));
    }

    if (!isActive) {
      if (this.el["watch-provider-badge"]) this.el["watch-provider-badge"].textContent = "WATCH";
      if (this.el["watch-panel-title"]) this.el["watch-panel-title"].textContent = "Watch Together";
      if (this.el["watch-sync-meta"]) {
        this.el["watch-sync-meta"].textContent =
          "Paste a YouTube, YouTube Music, Spotify, or SoundCloud link or playlist to sync with everyone";
      }
      if (this.el["watch-stage-wrap"]) this.el["watch-stage-wrap"].classList.add("hidden");
      if (this.el["watch-playlist-bar"]) this.el["watch-playlist-bar"].classList.add("hidden");
      if (this.el["watch-transport"]) this.el["watch-transport"].classList.add("hidden");
      if (this.el["watch-open-external"]) this.el["watch-open-external"].classList.add("hidden");
      if (this.el["btn-watch-close"]) this.el["btn-watch-close"].textContent = "Close";
      this._renderWatchQueue([]);
      return;
    }

    const isPlaylist = this._isWatchPlaylistState(state);
    panel.classList.add(`provider-${state.provider}`);
    if (isPlaylist) {
      panel.classList.add("is-playlist");
    }
    if (state.provider === "spotify") {
      const p = parseWatchMediaUrl(state.url);
      if (
        isPlaylist ||
        (p && (p.entityType === "playlist" || p.entityType === "album" || p.entityType === "show"))
      ) {
        panel.classList.add("is-spotify-collection");
      }
    }
    if (state.provider === "soundcloud" && isPlaylist) {
      panel.classList.add("is-soundcloud-playlist");
    }

    if (this.el["watch-provider-badge"]) {
      const baseBadge = this._watchProviderLabel(state.provider);
      this.el["watch-provider-badge"].textContent = isPlaylist ? `${baseBadge} · PLAYLIST` : baseBadge;
    }
    if (this.el["watch-panel-title"]) {
      this.el["watch-panel-title"].textContent =
        this.mediaSync.watchTitleOverride || state.title || state.url;
    }
    if (this.el["watch-sync-meta"]) {
      const who = state.actorName || "Room";
      const statusText = state.playing ? "Playing" : "Paused";
      const hint =
        state.provider === "spotify"
          ? isPlaylist
            ? " · Pick any track inside embed to sync room"
            : " · Full track if logged into Spotify"
          : " · Volume is local-only";
      this.el["watch-sync-meta"].textContent = `SYNCED · ${statusText} · Last control: ${who}${hint}`;
    }
    if (this.el["watch-open-external"]) {
      this.el["watch-open-external"].href = state.url;
      this.el["watch-open-external"].classList.remove("hidden");
    }
    if (this.el["btn-watch-close"]) this.el["btn-watch-close"].textContent = "Stop";
    if (this.el["watch-stage-wrap"]) this.el["watch-stage-wrap"].classList.remove("hidden");
    if (this.el["watch-transport"]) this.el["watch-transport"].classList.remove("hidden");

    if (this.el["btn-watch-play"]) {
      this.el["btn-watch-play"].textContent = state.playing ? "❚❚ Pause" : "▶ Play";
    }
    if (this.el["btn-watch-loop"]) {
      this.el["btn-watch-loop"].textContent = state.loop ? "Loop: On" : "Loop: Off";
      this.el["btn-watch-loop"].classList.toggle("is-active", Boolean(state.loop));
    }
    if (this.el["watch-speed-select"]) {
      const showSpeed = state.provider === "youtube" || state.provider === "ytmusic";
      this.el["watch-speed-select"].classList.toggle("hidden", !showSpeed);
      if (showSpeed) {
        this.el["watch-speed-select"].value = String(state.rateMilli || 1000);
      }
    }
    // Spotify Embed API does not expose external setVolume — keep local slider for YouTube, YT Music & SoundCloud
    if (this.el["watch-local-vol-row"]) {
      this.el["watch-local-vol-row"].classList.toggle("hidden", state.provider === "spotify");
    }
    this._updateWatchLocalVolUi();

    const queue = Array.isArray(state.queue) ? state.queue : [];
    const indexablePlaylist = isPlaylist && state.provider !== "spotify";
    if (this.el["btn-watch-prev"]) {
      this.el["btn-watch-prev"].classList.toggle("hidden", !indexablePlaylist);
    }
    if (this.el["btn-watch-next"]) {
      this.el["btn-watch-next"].classList.toggle("hidden", !indexablePlaylist && queue.length === 0);
    }

    this._renderWatchPlaylistBar(state);
    this._renderWatchQueue(queue);
    this._updateWatchTimeUi();
  }

  _renderWatchPlaylistBar(state) {
    const bar = this.el["watch-playlist-bar"];
    const statusEl = this.el["watch-playlist-status"];
    const tracksBtn = this.el["btn-watch-tracks-toggle"];
    const spotifyBtn = this.el["btn-watch-spotify-playlist"];
    const listEl = this.el["watch-playlist-tracks"];
    if (!bar) return;

    const isPlaylist = this._isWatchPlaylistState(state);
    bar.classList.toggle("hidden", !isPlaylist);
    if (!isPlaylist) {
      if (listEl) {
        listEl.classList.add("hidden");
        listEl.innerHTML = "";
      }
      return;
    }

    const curIdx = Math.max(0, Number(state.playlistIndex) || 0);
    const items = Array.isArray(this.mediaSync.watchPlaylistItems) ? this.mediaSync.watchPlaylistItems : [];
    const count = this.mediaSync.watchPlaylistCount || items.length;

    if (statusEl) {
      if (state.provider === "spotify") {
        const trackCode =
          state.trackUri && state.trackUri !== state.playlistId
            ? state.trackUri.split(":").pop().slice(0, 10)
            : "";
        statusEl.textContent = trackCode
          ? `SPOTIFY PLAYLIST · SYNCED TRACK (${trackCode})`
          : "SPOTIFY PLAYLIST · PICK ANY TRACK TO SYNC ROOM";
      } else {
        const trackCounter = count > 0 ? `TRACK ${curIdx + 1} / ${count}` : `TRACK #${curIdx + 1}`;
        const curItem = items[curIdx];
        const curLabel = curItem
          ? curItem.artist
            ? `${curItem.artist} — ${curItem.title}`
            : curItem.title
          : "";
        statusEl.textContent = curLabel ? `${trackCounter} · ${curLabel}` : `PLAYLIST · ${trackCounter}`;
      }
    }

    if (spotifyBtn) {
      const showBack =
        state.provider === "spotify" &&
        Boolean(state.playlistId) &&
        Boolean(this.mediaSync.watchSpotifyTrackDetached);
      spotifyBtn.classList.toggle("hidden", !showBack);
    }

    if (tracksBtn) {
      const hasTracks = items.length > 0 && state.provider !== "spotify";
      tracksBtn.classList.toggle("hidden", !hasTracks);
      if (hasTracks) {
        tracksBtn.textContent = this.mediaSync.watchTracksOpen
          ? `Tracks (${items.length}) ▴`
          : `Tracks (${items.length}) ▾`;
        tracksBtn.setAttribute("aria-expanded", String(this.mediaSync.watchTracksOpen));
        tracksBtn.classList.toggle("is-active", this.mediaSync.watchTracksOpen);
      }
    }

    if (listEl) {
      const showList = this.mediaSync.watchTracksOpen && items.length > 0 && state.provider !== "spotify";
      listEl.classList.toggle("hidden", !showList);
      if (!showList) {
        listEl.innerHTML = "";
        return;
      }
      listEl.innerHTML = items
        .map((it) => {
          const isCurrent = it.index === curIdx;
          const label = it.artist ? `${it.artist} — ${it.title}` : it.title;
          const dur = it.durationMs > 0 ? formatClockTime(it.durationMs) : "";
          return `
            <li class="watch-playlist-track-item${isCurrent ? " is-current" : ""}">
              <button type="button" class="watch-playlist-track-btn" data-watch-pl-idx="${it.index}">
                <span class="watch-pl-num">${isCurrent ? "▶" : it.index + 1}</span>
                <span class="watch-pl-title">${escapeHtml(label)}</span>
                ${dur ? `<span class="watch-pl-dur">${escapeHtml(dur)}</span>` : ""}
              </button>
            </li>
          `;
        })
        .join("");

      for (const btn of listEl.querySelectorAll("[data-watch-pl-idx]")) {
        btn.addEventListener("click", () =>
          this.selectWatchPlaylistTrack(Number(btn.dataset.watchPlIdx))
        );
      }
    }
  }

  _updateWatchTimeUi() {
    const st = this.mediaSync.states.get("watch");
    if (!st || !st.active) return;
    const posMs = projectMediaPositionMs(st, Date.now());
    const durMs = this.mediaSync.watchDurationMs || 0;
    const clampedPos = durMs > 0 ? Math.min(posMs, durMs) : posMs;
    if (!this.mediaSync.watchScrubbing) {
      if (this.el["watch-time-cur"]) {
        this.el["watch-time-cur"].textContent = formatClockTime(clampedPos);
      }
      if (this.el["watch-scrubber"]) {
        if (durMs > 0) {
          this.el["watch-scrubber"].max = "1000";
          this.el["watch-scrubber"].value = String(Math.round((clampedPos / durMs) * 1000));
        } else {
          const maxSec = Math.max(300, Math.ceil(clampedPos / 1000) + 60);
          this.el["watch-scrubber"].max = String(maxSec);
          this.el["watch-scrubber"].value = String(Math.floor(clampedPos / 1000));
        }
      }
    }
    if (this.el["watch-time-dur"]) {
      this.el["watch-time-dur"].textContent = durMs > 0 ? formatClockTime(durMs) : "--:--";
    }
  }

  _renderWatchQueue(queue) {
    const head = this.el["watch-queue-head"];
    const countEl = this.el["watch-queue-count"];
    const listEl = this.el["watch-queue-list"];
    if (!head || !listEl) return;

    if (!Array.isArray(queue) || queue.length === 0) {
      head.classList.add("hidden");
      listEl.classList.add("hidden");
      listEl.innerHTML = "";
      return;
    }

    head.classList.remove("hidden");
    listEl.classList.remove("hidden");
    if (countEl) {
      countEl.textContent = `Up Next (${queue.length})`;
    }
    listEl.innerHTML = queue
      .map(
        (item, idx) => `
        <li class="watch-queue-item provider-${escapeHtml(item.provider)}">
          <div class="watch-queue-item-main">
            <span class="chat-media-provider-tag">${escapeHtml(this._watchProviderLabel(item.provider))}</span>
            ${item.playlistId ? '<span class="watch-queue-pl-pill">PLAYLIST</span>' : ""}
            <span class="watch-queue-item-title">${escapeHtml(item.title || item.url)}</span>
            ${item.addedBy ? `<span class="watch-queue-item-by">by ${escapeHtml(item.addedBy)}</span>` : ""}
          </div>
          <div class="watch-queue-item-actions">
            <button type="button" class="media-ctrl-btn" data-watch-q-play="${idx}" title="Play now for everyone">▶</button>
            <button type="button" class="media-ctrl-btn" data-watch-q-del="${idx}" title="Remove from queue">×</button>
          </div>
        </li>
      `
      )
      .join("");

    for (const btn of listEl.querySelectorAll("[data-watch-q-play]")) {
      btn.addEventListener("click", () => this.playWatchQueueItemAt(Number(btn.dataset.watchQPlay)));
    }
    for (const btn of listEl.querySelectorAll("[data-watch-q-del]")) {
      btn.addEventListener("click", () => this.removeWatchQueueItemAt(Number(btn.dataset.watchQDel)));
    }
  }

  /* ================= Step-by-Step Connect Wizard Helpers ================= */

  resetWizard() {
    this.wizard = {
      mode: "idle",
      step: 1,
      hostCopied: false,
      joinCopied: false,
      peerName: "",
      offerMeta: "",
      answerMeta: "",
      offerHint: "",
      answerHint: "",
    };
    this.el["host-answer-input"].value = "";
    this.el["join-offer-input"].value = "";
    this.el["connect-notice"].classList.add("hidden");
    this.renderWizard();
    this.renderConnectBanners();
  }

  openJoinWizard() {
    this.wizard = {
      mode: "join",
      step: 1,
      hostCopied: false,
      joinCopied: false,
      peerName: "",
      offerMeta: "",
      answerMeta: "",
      offerHint: "",
      answerHint: "",
    };
    this.el["connect-notice"].classList.add("hidden");
    this.renderWizard();
    this.renderConnectBanners();
  }

  markHostInviteShared() {
    if (this.wizard.mode !== "host") return;
    this.wizard.hostCopied = true;
    if (this.wizard.step < 2) {
      this.wizard.step = 2;
    }
    this.renderWizard();
    this.el["host-answer-input"].focus();
  }

  markJoinReplyShared() {
    if (this.wizard.mode !== "join") return;
    this.wizard.joinCopied = true;
    if (this.wizard.step < 3) {
      this.wizard.step = 3;
    }
    this.renderWizard();
  }

  async pasteIntoField(fieldId, callback) {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        this.showNotice("connect-notice", "warn", "Clipboard is empty.");
        return;
      }
      this.el[fieldId].value = text.trim();
      await callback(text.trim());
    } catch {
      this.showNotice(
        "connect-notice",
        "warn",
        "Browser blocked clipboard read — paste into the box with Ctrl+V / Cmd+V."
      );
      this.el[fieldId].focus();
    }
  }

  renderWizard() {
    const w = this.wizard;
    const isIdle = w.mode === "idle";
    const isHost = w.mode === "host";
    const isJoin = w.mode === "join";

    this.el["room-link-card"].classList.toggle("hidden", !isIdle);
    this.el["wizard-role-picker"].classList.toggle("hidden", !isIdle);
    this.el["wizard-host-flow"].classList.toggle("hidden", !isHost);
    this.el["wizard-join-flow"].classList.toggle("hidden", !isJoin);
    this.el["btn-wizard-reset"].classList.toggle("hidden", isIdle);
    this.el["connect-panel-meta"].classList.toggle("hidden", !isIdle);

    if (isIdle) {
      this.el["connect-panel-title"].textContent = "Connect Peer";
      return;
    }

    const setStepVisual = (stepEl, badgeEl, num, state) => {
      stepEl.classList.remove("active", "done", "upcoming");
      stepEl.classList.add(state);
      badgeEl.textContent = state === "done" ? "✓" : String(num);
    };

    if (isHost) {
      this.el["connect-panel-title"].textContent = "Invite a Peer";
      const s1State = w.step > 1 || w.hostCopied ? "done" : "active";
      const s2State = w.step === 3 ? "done" : w.step === 2 || w.hostCopied ? "active" : "upcoming";
      const s3State = w.step === 3 ? "done" : "upcoming";

      setStepVisual(this.el["wizard-host-step-1"], this.el["host-step-1-badge"], 1, s1State);
      setStepVisual(this.el["wizard-host-step-2"], this.el["host-step-2-badge"], 2, s2State);
      setStepVisual(this.el["wizard-host-step-3"], this.el["host-step-3-badge"], 3, s3State);

      this.el["host-offer-meta"].textContent = w.offerMeta || "";
      if (w.offerHint) {
        this.el["host-step-1-hint"].textContent = w.offerHint;
      }
      this.el["btn-host-share"].classList.toggle("hidden", typeof navigator.share !== "function");

      // At Step 3 (connected), collapse steps 1 & 2 and reveal Step 3 celebration/actions
      const connected = w.step === 3;
      this.el["host-step-1-body"].classList.toggle("hidden", connected);
      this.el["host-step-2-body"].classList.toggle("hidden", connected);
      this.el["host-step-3-body"].classList.toggle("hidden", !connected);
      this.el["host-step-3-title"].textContent = connected
        ? `Connected to ${w.peerName || "Peer"} (E2EE)`
        : "Connected (E2EE)";
      this.el["host-step-3-detail"].textContent = connected
        ? `Direct encrypted channel open with ${w.peerName || "your peer"}. Any additional peers you invite will auto-mesh directly with each other.`
        : "";
      return;
    }

    if (isJoin) {
      this.el["connect-panel-title"].textContent = "Join with Invite";
      const connected = w.step === 3 && Boolean(w.peerName) && this.directPeers.size > 0 && !this.latestAnswer;
      const s1State = w.step > 1 ? "done" : "active";
      const s2State = connected ? "done" : w.step === 2 ? "active" : w.step === 3 ? "done" : "upcoming";
      const s3State = connected ? "done" : w.step === 3 ? "active" : "upcoming";

      setStepVisual(this.el["wizard-join-step-1"], this.el["join-step-1-badge"], 1, s1State);
      setStepVisual(this.el["wizard-join-step-2"], this.el["join-step-2-badge"], 2, s2State);
      setStepVisual(this.el["wizard-join-step-3"], this.el["join-step-3-badge"], 3, s3State);

      this.el["join-step-1-title"].textContent =
        w.step > 1 && w.peerName
          ? `Invite loaded from ${w.peerName}`
          : "Paste the invite you received";
      this.el["join-step-1-body"].classList.toggle("hidden", w.step > 1);

      this.el["join-answer-meta"].textContent = w.answerMeta || "";
      if (w.answerHint) {
        this.el["join-step-2-hint"].textContent = w.answerHint;
      }
      this.el["btn-join-share"].classList.toggle("hidden", typeof navigator.share !== "function");
      this.el["join-step-2-body"].classList.toggle("hidden", w.step === 1 || connected);

      if (connected) {
        this.el["join-step-3-title"].textContent = `Connected to ${w.peerName}`;
        this.el["join-step-3-detail"].textContent =
          `Direct encrypted connection is live with ${w.peerName}. Messages sync automatically and you can join Voice Chat anytime.`;
        this.el["join-step-3-body"].classList.remove("hidden");
      } else if (w.step === 3) {
        this.el["join-step-3-title"].textContent = `Waiting for ${w.peerName || "host"} to apply your reply…`;
        this.el["join-step-3-detail"].textContent = "";
        this.el["join-step-3-body"].classList.add("hidden");
      } else {
        this.el["join-step-3-title"].textContent = "Waiting for peer to connect";
        this.el["join-step-3-body"].classList.add("hidden");
      }
    }
  }

  /* ================= Background-Resilient Web Worker Keepalive ================= */

  startKeepaliveWorker() {
    const onTick = () => {
      if (!this.wasm) return;
      this.keepaliveTickCount += 1;
      const now = Date.now();

      if (this.directPeers.size > 0) {
        try {
          const pingRes = this.wasm.call({ cmd: "keepalive_ping", nowMs: now });
          this.status = pingRes.status;
          this.executeActions(pingRes.actions);
        } catch {
          // ignore
        }
        this.checkRelayPeersHealth(now);
      }

      // Periodically advertise encrypted room presence so future joiners discover us even in background tabs
      if (this.activeRoom && this.roomRendezvous && this.keepaliveTickCount % 2 === 0) {
        this.announceRoomHello(this.directPeers.size === 0);
      }

      if (this.keepaliveTickCount % 4 === 0) {
        try {
          const tickRes = this.wasm.call({
            cmd: "tick",
            nowMs: now,
            runSync: this.directPeers.size > 0,
          });
          this.status = tickRes.status;
          this.executeActions(tickRes.actions);
          this.cleanupStaleLocalDialing(now);
          this.tryBackgroundDirectUpgrades(now);
          this.renderStats();
          if (this.advancedMode) {
            this.updateVoiceAdvancedStats();
          }
        } catch {
          // ignore
        }
      }
    };

    try {
      const workerCode = `setInterval(() => postMessage("tick"), ${KEEPALIVE_INTERVAL_MS});`;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      worker.onmessage = onTick;
      worker.onerror = () => {
        try {
          worker.terminate();
        } catch {
          // ignore
        }
        this.keepaliveWorker = null;
        if (!this.keepaliveFallbackTimer) {
          this.keepaliveFallbackTimer = setInterval(onTick, KEEPALIVE_INTERVAL_MS);
        }
      };
      this.keepaliveWorker = worker;
      URL.revokeObjectURL(url);
      this.addTelemetry("keepalive", "Started background Web Worker keepalive (4s interval)");
    } catch {
      this.keepaliveFallbackTimer = setInterval(onTick, KEEPALIVE_INTERVAL_MS);
    }
  }

  onForegroundResume() {
    const now = Date.now();
    if (this.directPeers.size > 0) {
      try {
        const pingRes = this.wasm.call({ cmd: "keepalive_ping", nowMs: now });
        this.status = pingRes.status;
        this.executeActions(pingRes.actions);
        const syncRes = this.wasm.call({ cmd: "request_sync", nowMs: now });
        this.status = syncRes.status;
        this.executeActions(syncRes.actions);
        this.renderAll();
      } catch {
        // ignore
      }
    } else {
      this.broadcastMeshBeacon(true);
    }
    if (this.activeRoom && this.roomRendezvous) {
      this.announceRoomHello(true);
    }
    if (this.voice.inVoice && this.voice.audioCtx && this.voice.audioCtx.state === "suspended") {
      this.voice.audioCtx.resume().catch(() => {});
    }
  }

  cleanupStaleLocalDialing(now) {
    for (const [pid, entry] of this.localDialing.entries()) {
      if (now - entry.startedAt > 15_000) {
        try {
          entry.pc.close();
        } catch {
          // ignore
        }
        this.localDialing.delete(pid);
      }
    }
    for (const [pid, entry] of this.roomDialing.entries()) {
      if (now - entry.startedAt > DIRECT_HARD_TIMEOUT_MS + 4000) {
        this._cleanupRoomDialingEntry(pid, entry, null);
      }
    }
    for (const [sid, ts] of this.seenRoomSignalIds.entries()) {
      if (now - ts > 60_000) {
        this.seenRoomSignalIds.delete(sid);
      }
    }
    for (const [key, asm] of this.relayChunkAssemblies.entries()) {
      if (now - asm.ts > 60_000) {
        this.relayChunkAssemblies.delete(key);
      }
    }
    for (const [key, ts] of this.seenRelayChunkKeys.entries()) {
      if (now - ts > 60_000) {
        this.seenRelayChunkKeys.delete(key);
      }
    }
    for (const [fromHex, list] of this.earlyRelayDataFrames.entries()) {
      const kept = list.filter((item) => now - item.ts < 15_000);
      if (kept.length === 0) {
        this.earlyRelayDataFrames.delete(fromHex);
      } else {
        this.earlyRelayDataFrames.set(fromHex, kept);
      }
    }
  }

  /* ================= Same-Browser BroadcastChannel Rejoin & Handoff ================= */

  setupBroadcastChannel() {
    if (typeof BroadcastChannel === "undefined") return;
    try {
      this.bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      this.bc.onmessage = (ev) => {
        if (!ev.data || !this.status) return;
        this.handleBroadcastMessage(ev.data);
      };
    } catch {
      this.bc = null;
    }
  }

  postBroadcast(msg) {
    if (!this.bc) return;
    try {
      this.bc.postMessage(msg);
    } catch {
      // ignore closed channel
    }
  }

  broadcastTabState(patch, toPeerId = undefined) {
    if (!this.bc || !this.status || !patch) return;
    this.postBroadcast({
      type: "tab-state-sync",
      fromPeerId: this.status.peerId,
      toPeerId,
      patch,
    });
  }

  applyIncomingTabState(patch) {
    if (!patch || typeof patch !== "object" || !this.status) return;

    if (patch.theme === "dark" || patch.theme === "light") {
      const currentTheme =
        document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      if (currentTheme !== patch.theme) {
        this._userCustomizedTheme = true;
        this.applyTheme(patch.theme, /* persist = */ true, /* broadcast = */ false);
      }
    }

    if (typeof patch.authorName === "string") {
      const next = patch.authorName.trim().slice(0, 32);
      if (next && next !== this.status.authorName) {
        this._userCustomizedName = true;
        if (this.el["author-name-input"]) {
          this.el["author-name-input"].value = next;
        }
        saveSessionAuthorName(next);
        try {
          const res = this.wasm.call({ cmd: "set_profile", authorName: next });
          this.status = res.status;
          this.profile.authorName = next;
          this.executeActions(res.actions);
          this.renderHeader();
          this.renderVoicePanel(true);
          this.renderTopology();
          this.announceRoomHello(false);
        } catch {
          // ignore if engine not ready
        }
      }
    }

    if (patch.audioSettings && typeof patch.audioSettings === "object") {
      const merged = saveSessionAudioSettings({
        ...this.audioSettings,
        ...patch.audioSettings,
      });
      if (JSON.stringify(merged) !== JSON.stringify(this.audioSettings)) {
        this.audioSettings = merged;
        this._userCustomizedAudio = true;
        this.syncAudioSettingsUI();
        this.applyLiveAudioDspParams(true);
        this.applyMicTrackConstraints();
        this.updateVoiceCodecMeta();
      }
    }

    if (patch.savedRoomsChanged) {
      this.savedRooms = loadSavedRooms();
      this.lastJoinedRoom = loadLastJoinedRoom();
      if (this.activeRoom) {
        const match = this.savedRooms.find((r) => r.topic === this.activeRoom.topic);
        if (match && match.name && match.name !== this.activeRoom.name) {
          this.activeRoom.name = match.name;
          this.profile.room = match.name;
        }
      }
      this.renderRoomCard();
      this.renderSavedRooms();
    }
  }

  broadcastMeshBeacon(requestReply) {
    if (!this.bc || !this.status) return;
    this.postBroadcast({
      type: "mesh-beacon",
      peerId: this.status.peerId,
      authorName: this.status.authorName,
      pubKey: this.status.e2ee.publicKey,
      keyFingerprint: this.status.e2ee.keyFingerprint,
      passphraseMode: Boolean(this.status.e2ee.passphraseMode),
      connectedPeers: Array.from(this.directPeers.keys()),
      peerCount: this.directPeers.size,
      logCount: this.logMessages.length,
      vcodec: this.getLocalVoiceCodec(),
      requestReply: Boolean(requestReply),
    });
  }

  async handleBroadcastMessage(msg) {
    if (!this.status || msg.peerId === this.status.peerId || msg.fromPeerId === this.status.peerId) {
      return;
    }
    if (msg.toPeerId && msg.toPeerId !== this.status.peerId) {
      return;
    }

    switch (msg.type) {
      case "tab-state-hello": {
        const replyPatch = {};
        if (this._userCustomizedTheme) {
          replyPatch.theme =
            document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
        }
        if (this._userCustomizedName && this.status.authorName) {
          replyPatch.authorName = this.status.authorName;
        }
        if (this._userCustomizedAudio && this.audioSettings) {
          replyPatch.audioSettings = this.audioSettings;
        }
        if (Object.keys(replyPatch).length > 0) {
          this.broadcastTabState(replyPatch, msg.fromPeerId);
        }
        break;
      }

      case "tab-state-sync": {
        this.applyIncomingTabState(msg.patch);
        break;
      }

      case "mesh-beacon": {
        if (msg.peerId && msg.vcodec) {
          this.recordPeerVoiceCodec(msg.peerId, msg.vcodec);
        }
        const myFp = this.status.e2ee.keyFingerprint;
        if (msg.requestReply) {
          this.broadcastMeshBeacon(false);
        }
        if (msg.keyFingerprint === myFp) {
          this.discoveredLocalMeshes.delete(msg.peerId);
          const existing = this.directPeers.get(msg.peerId);
          const remoteConnectedToUs =
            Array.isArray(msg.connectedPeers) && msg.connectedPeers.includes(this.status.peerId);
          const isHealthy =
            existing && existing.dc && existing.dc.readyState === "open" && remoteConnectedToUs;
          if (!isHealthy && !this.localDialing.has(msg.peerId) && !this.roomDialing.has(msg.peerId)) {
            if (this.status.peerId < msg.peerId) {
              this.startLocalAutoRejoinOffer(msg.peerId, msg.authorName, msg.pubKey);
            }
          }
        } else if (!msg.passphraseMode && !this.activeRoom && this.directPeers.size === 0 && this.logMessages.length === 0) {
          this.discoveredLocalMeshes.set(msg.peerId, msg);
          this.renderConnectBanners();
        }
        break;
      }

      case "local-offer": {
        if (msg.keyFingerprint !== this.status.e2ee.keyFingerprint) return;
        await this.acceptLocalAutoRejoinOffer(msg);
        break;
      }

      case "local-answer": {
        if (msg.keyFingerprint !== this.status.e2ee.keyFingerprint) return;
        await this.applyLocalAutoRejoinAnswer(msg);
        break;
      }

      case "local-ice": {
        if (msg.keyFingerprint !== this.status.e2ee.keyFingerprint) return;
        await this.applyLocalAutoRejoinIce(msg.fromPeerId, msg.candidate);
        break;
      }

      case "local-join-request": {
        if (this.status.e2ee.passphraseMode) return;
        await this.handleLocalJoinRequest(msg.fromPeerId);
        break;
      }

      case "local-join-offer": {
        await this.handleLocalJoinOffer(msg.fromPeerId, msg.code);
        break;
      }

      case "deliver-answer": {
        const hasPending =
          (msg.inviteId && this.pendingOffers.has(msg.inviteId)) ||
          (!msg.inviteId && this.pendingOffers.size === 1);
        if (hasPending) {
          const ok = await this.completeManualOffer(msg.code);
          if (ok) {
            this.postBroadcast({
              type: "answer-accepted",
              inviteId: msg.inviteId || "",
              fromPeerId: this.status.peerId,
              peerName: this.status.authorName,
              toPeerId: msg.fromPeerId || undefined,
            });
          }
        }
        break;
      }

      case "answer-accepted": {
        this.showNotice(
          "connect-notice",
          "success",
          `Reply delivered to ${msg.peerName || "your main mesh tab"}! Direct E2EE connection is opening — you can switch back or close this tab.`
        );
        this.showToast("Reply delivered automatically to your main tab");
        break;
      }

      default:
        break;
    }
  }

  async startLocalAutoRejoinOffer(targetPeerId, targetName, targetPubKey) {
    if (this.localDialing.has(targetPeerId)) return;
    try {
      const pc = this.createPeerConnection();
      const { dc, voiceDc, bulkDc } = this.createPeerDataChannels(pc);
      const early = this.earlyLocalIce.get(targetPeerId) || [];
      this.earlyLocalIce.delete(targetPeerId);
      const entry = {
        pc,
        dc,
        voiceDc,
        bulkDc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.localDialing.set(targetPeerId, entry);
      this.attachVoiceDataChannel(targetPeerId, voiceDc);
      this.attachBulkDataChannel(targetPeerId, bulkDc);
      this.attachDataChannel(pc, dc, targetPeerId, targetName, targetPubKey, false, null, true);

      const sendIce = (candJson) => {
        this.postBroadcast({
          type: "local-ice",
          fromPeerId: this.status.peerId,
          toPeerId: targetPeerId,
          keyFingerprint: this.status.e2ee.keyFingerprint,
          candidate: candJson,
        });
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const candJson = ev.candidate.toJSON();
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        sendIce(candJson);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.postBroadcast({
        type: "local-offer",
        fromPeerId: this.status.peerId,
        fromName: this.status.authorName,
        fromPubKey: this.status.e2ee.publicKey,
        toPeerId: targetPeerId,
        keyFingerprint: this.status.e2ee.keyFingerprint,
        sdp: offer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
      this.addTelemetry("rejoin", `Auto-rejoining ${targetName} (${targetPeerId}) over E2EE WebRTC`);
    } catch {
      this.localDialing.delete(targetPeerId);
    }
  }

  async acceptLocalAutoRejoinOffer(msg) {
    const prev = this.localDialing.get(msg.fromPeerId);
    if (prev) {
      try {
        prev.pc.close();
      } catch {
        // ignore
      }
      this.localDialing.delete(msg.fromPeerId);
    }
    try {
      const pc = this.createPeerConnection();
      const early = this.earlyLocalIce.get(msg.fromPeerId) || [];
      this.earlyLocalIce.delete(msg.fromPeerId);
      const entry = {
        pc,
        dc: null,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.localDialing.set(msg.fromPeerId, entry);

      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "p2p-voice") {
          this.attachVoiceDataChannel(msg.fromPeerId, ev.channel);
          return;
        }
        if (ev.channel.label === "p2p-bulk") {
          this.attachBulkDataChannel(msg.fromPeerId, ev.channel);
          return;
        }
        entry.dc = ev.channel;
        this.attachDataChannel(
          pc,
          ev.channel,
          msg.fromPeerId,
          msg.fromName,
          msg.fromPubKey,
          false,
          null,
          true
        );
      };

      const sendIce = (candJson) => {
        this.postBroadcast({
          type: "local-ice",
          fromPeerId: this.status.peerId,
          toPeerId: msg.fromPeerId,
          keyFingerprint: this.status.e2ee.keyFingerprint,
          candidate: candJson,
        });
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const candJson = ev.candidate.toJSON();
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        sendIce(candJson);
      };

      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      entry.remoteDescSet = true;
      await this.flushPendingIce(entry);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.postBroadcast({
        type: "local-answer",
        fromPeerId: this.status.peerId,
        fromName: this.status.authorName,
        fromPubKey: this.status.e2ee.publicKey,
        toPeerId: msg.fromPeerId,
        keyFingerprint: this.status.e2ee.keyFingerprint,
        sdp: answer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }
    } catch {
      this.localDialing.delete(msg.fromPeerId);
    }
  }

  async applyLocalAutoRejoinAnswer(msg) {
    const entry = this.localDialing.get(msg.fromPeerId);
    if (!entry) return;
    try {
      if (entry.pc.signalingState === "have-local-offer") {
        await entry.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        entry.remoteDescSet = true;
        await this.flushPendingIce(entry);
      }
    } catch {
      // ignore
    }
  }

  async applyLocalAutoRejoinIce(fromPeerId, candidate) {
    const entry = this.localDialing.get(fromPeerId);
    if (!entry) {
      const direct = this.directPeers.get(fromPeerId);
      if (direct && direct.pc) {
        try {
          await direct.pc.addIceCandidate(candidate);
        } catch {
          // ignore
        }
        return;
      }
      const list = this.earlyLocalIce.get(fromPeerId) || [];
      list.push(candidate);
      this.earlyLocalIce.set(fromPeerId, list);
      return;
    }
    if (!entry.remoteDescSet) {
      entry.pendingIce.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // ignore
    }
  }

  joinDiscoveredLocalMesh() {
    const target = this.discoveredLocalMeshes.values().next().value;
    if (!target) return;
    this.el["btn-join-local-mesh"].disabled = true;
    this.showNotice(
      "connect-notice",
      "info",
      `Connecting directly (E2EE) to ${target.authorName}…`
    );
    this.postBroadcast({
      type: "local-join-request",
      fromPeerId: this.status.peerId,
      fromName: this.status.authorName,
      toPeerId: target.peerId,
    });
    setTimeout(() => {
      this.el["btn-join-local-mesh"].disabled = false;
    }, 3000);
  }

  async handleLocalJoinRequest(requesterPeerId) {
    try {
      const inviteId = randomId("inv");
      const pc = this.createPeerConnection();
      const { dc, voiceDc, bulkDc } = this.createPeerDataChannels(pc);
      this.pendingOffers.set(inviteId, { inviteId, pc, dc, voiceDc, bulkDc, code: "", url: "" });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, 1000);

      const encoded = this.wasm.call({
        cmd: "encode_signal",
        kind: "offer",
        inviteId,
        sdp: pc.localDescription.sdp,
        baseUrl: basePageUrl(),
        entropy: randomBase64Url(16),
      });
      this.postBroadcast({
        type: "local-join-offer",
        fromPeerId: this.status.peerId,
        toPeerId: requesterPeerId,
        code: encoded.code,
      });
    } catch {
      // ignore
    }
  }

  async handleLocalJoinOffer(fromPeerId, code) {
    const answerResult = await this.acceptManualOffer(code, /* silentUi = */ true);
    if (answerResult) {
      this.discoveredLocalMeshes.clear();
      this.postBroadcast({
        type: "deliver-answer",
        inviteId: answerResult.inviteId,
        code: answerResult.code,
        fromPeerId: this.status.peerId,
        toPeerId: fromPeerId,
      });
    }
  }

  /* ================= Passphrase & E2EE Key Controls ================= */

  async applyPassphrase() {
    const pass = this.el["e2ee-passphrase-input"].value;
    if (!pass) {
      this.showToast("Enter a passphrase first, or click Auto for an automatic 256-bit key.");
      return;
    }
    try {
      const res = this.wasm.call({
        cmd: "set_passphrase",
        passphrase: pass,
        entropy: randomBase64Url(32),
      });
      this.status = res.status;
      this.profile.meshKey = res.meshKey;
      this.profile.passphraseMode = true;
      this.discoveredLocalMeshes.clear();

      if (this.pendingRoomCode) {
        const pendingCode = this.pendingRoomCode;
        this.pendingRoomCode = null;
        await this.joinLongLivedRoomLink(pendingCode);
        return;
      }

      if (this.activeRoom) {
        this.activateCurrentMeshAsRoom({
          roomName: this.activeRoom.name,
          relay: this.activeRoom.relay,
          updateHash: true,
          silent: true,
        });
      }

      this.renderAll();
      this.broadcastMeshBeacon(true);
      this.addTelemetry(
        "e2ee",
        `Derived 256-bit key via PBKDF2-HMAC-SHA256 (${this.status.e2ee.keyFingerprint}); P2P1 codes are passphrase-encrypted`
      );
      this.showToast(`Passphrase encryption active · FP ${this.status.e2ee.keyFingerprint}`);
    } catch (err) {
      this.addTelemetry("error", `Passphrase error: ${err.message}`);
    }
  }

  clearPassphrase() {
    const freshKey = randomBase64Url(32);
    const res = this.wasm.call({
      cmd: "set_passphrase",
      passphrase: "",
      meshKey: freshKey,
      entropy: randomBase64Url(32),
    });
    this.el["e2ee-passphrase-input"].value = "";
    this.status = res.status;
    this.profile.meshKey = res.meshKey;
    this.profile.passphraseMode = false;
    if (this.activeRoom) {
      this.activateCurrentMeshAsRoom({
        roomName: this.activeRoom.name,
        relay: this.activeRoom.relay,
        updateHash: true,
        silent: true,
      });
    }
    this.renderAll();
    this.broadcastMeshBeacon(true);
    this.addTelemetry(
      "e2ee",
      `Switched to automatic 256-bit mesh key (${this.status.e2ee.keyFingerprint})`
    );
    this.showToast(`Auto 256-bit key active · FP ${this.status.e2ee.keyFingerprint}`);
  }

  switchComposerMode(mode) {
    const isChat = mode === "chat";
    this.composerMode = isChat ? "chat" : "json";
    this.el["mode-btn-chat"].classList.toggle("active", isChat);
    this.el["mode-btn-chat"].setAttribute("aria-selected", String(isChat));
    this.el["mode-btn-json"].classList.toggle("active", !isChat);
    this.el["mode-btn-json"].setAttribute("aria-selected", String(!isChat));
    this.el["chat-composer-form"].classList.toggle("hidden", !isChat);
    this.el["json-composer-form"].classList.toggle("hidden", isChat);
    this.el["chat-image-tray"].classList.toggle("hidden", !isChat || this.pendingImages.length === 0);
    this.el["composer-error"].classList.add("hidden");
    this.el["next-lamport-preview"].textContent = isChat
      ? "Paste images or links"
      : `next lamport: ${(this.status?.lamport || 0) + 1}`;
  }

  showNotice(id, kind, text) {
    const box = this.el[id];
    box.className = `inline-notice ${kind}`;
    box.textContent = text;
    box.classList.remove("hidden");
  }

  showComposerError(text) {
    this.el["composer-error"].textContent = text;
    this.el["composer-error"].classList.remove("hidden");
  }

  showToast(text) {
    const el = this.el["toast"];
    el.textContent = text;
    el.classList.add("visible");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove("visible"), 2800);
  }

  async copyText(text, toastMsg) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast(toastMsg);
    } catch {
      const tmp = document.createElement("textarea");
      tmp.value = text;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand("copy");
      tmp.remove();
      this.showToast(toastMsg);
    }
  }

  addTelemetry(event, detail) {
    this.telemetry.unshift({ ts: formatTime(Date.now()), event, detail });
    if (this.telemetry.length > 80) {
      this.telemetry.length = 80;
    }
    this.renderTelemetry();
  }

  _insertLocalMessageOrdered(msgObj) {
    if (!msgObj || !msgObj.id || !Array.isArray(this.logMessages)) return false;
    if (this.logMessages.some((m) => m.id === msgObj.id)) return false;
    const lp = Number(msgObj.lamport) || 0;
    const ts = Number(msgObj.ts) || 0;
    const id = String(msgObj.id);
    // Insert in canonical (lamport, ts, id) order matching Rust ReplicatedLog
    let pos = this.logMessages.length;
    while (pos > 0) {
      const prev = this.logMessages[pos - 1];
      const plp = Number(prev.lamport) || 0;
      const pts = Number(prev.ts) || 0;
      const pid = String(prev.id || "");
      const cmp =
        plp !== lp ? plp - lp : pts !== ts ? pts - ts : pid < id ? -1 : pid > id ? 1 : 0;
      if (cmp <= 0) break;
      pos -= 1;
    }
    this.logMessages.splice(pos, 0, msgObj);
    return true;
  }

  async _publishBulkOffThread(msgType, payload) {
    let prep;
    try {
      const prepRes = this.wasm.call({
        cmd: "prepare_bulk_publish",
        type: msgType,
        ts: Date.now(),
        entropy: randomBase64Url(16),
      });
      prep = prepRes.prep;
    } catch (err) {
      // Fallback to synchronous publish if prep fails
      this._publishSyncFallback(msgType, payload);
      return;
    }

    const meta = {
      id: prep.id,
      type: prep.type,
      lamport: prep.lamport,
      ts: prep.ts,
      author: prep.author,
      authorName: prep.authorName,
    };
    const fullMessage = { ...meta, payload };

    // Capture live peer object references at prep time so reconnected peers never receive stale keys
    const targetPeerRefs = new Map();
    for (const t of prep.targets || []) {
      const peer = this.directPeers.get(t.peerId);
      if (peer) targetPeerRefs.set(t.peerId, peer);
    }

    // Show local message immediately (off-thread blob decode keeps render < 3 ms)
    this._insertLocalMessageOrdered(fullMessage);
    setTimeout(() => this.renderMessageUpdate(), 0);

    try {
      const sealed = await this.wasm.sealBulkAsync(
        {
          meta,
          logKey: prep.logKey,
          logNonce: prep.logNonce,
          gossipTtl: prep.gossipTtl,
          targets: prep.targets || [],
        },
        fullMessage
      );

      let sentCount = 0;
      const readyWireFrames = [];
      for (const wf of sealed.wireFrames) {
        const expectedPeer = targetPeerRefs.get(wf.peerId);
        const livePeer = this.directPeers.get(wf.peerId);
        if (livePeer && livePeer === expectedPeer && livePeer.dc?.readyState === "open") {
          readyWireFrames.push({ peer: livePeer, frame: wf.frame });
          sentCount += 1;
        }
      }

      const commitRes = this.wasm.commitBulkPublish(
        {
          meta,
          sealedNonce: prep.logNonce,
          sentPeerCount: sentCount,
        },
        sealed.sealedCt
      );
      this.status = commitRes.status;
      this.executeActions(commitRes.actions, { skipLogRefresh: true });
      for (const item of readyWireFrames) {
        this._sendWireFrameToPeer(item.peer, item.frame);
      }
      this._announceInitialGifSync(meta.id, payload);
      this.renderStats();
    } catch (err) {
      this.addTelemetry("error", `Off-thread bulk seal fallback: ${err.message}`);
      this.renderStats();
    }
  }

  _announceInitialGifSync(msgId, payload) {
    if (!msgId || !payload || !Array.isArray(payload.images)) return;
    let gifIdx = 0;
    for (const img of payload.images) {
      if (img && typeof img.dataUrl === "string" && (img.animated || img.dataUrl.startsWith("data:image/gif;"))) {
        this.publishMediaSync({
          targetId: `gif:${msgId}:${gifIdx}`,
          kind: "gif",
          active: true,
          playing: true,
          positionMs: 0,
          rateMilli: 1000,
          loop: true,
          epoch: 0,
          sourceMsgId: msgId,
        });
        gifIdx++;
      }
    }
  }

  _publishSyncFallback(msgType, payload) {
    try {
      const res = this.wasm.call({
        cmd: "publish",
        type: msgType,
        payload,
        ts: Date.now(),
        entropy: randomBase64Url(16),
        omitMessagePayload: true,
      });
      this.status = res.status;
      const msgObj = res.messageMeta ? { ...res.messageMeta, payload } : res.message;
      const inserted = msgObj ? this._insertLocalMessageOrdered(msgObj) : false;
      this.executeActions(res.actions, { skipLogRefresh: inserted });
      if (msgObj && msgObj.id) {
        this._announceInitialGifSync(msgObj.id, payload);
      }
      this.renderMessageUpdate();
    } catch (err) {
      this.showComposerError(err.message);
    }
  }

  publishMessage(msgType, payload) {
    const hasBulkMedia =
      msgType !== "msg-delete" &&
      msgType !== "msg-edit" &&
      msgType !== "bot-update" &&
      payload &&
      typeof payload === "object" &&
      ((Array.isArray(payload.images) && payload.images.length > 0) ||
        (Array.isArray(payload.videos) && payload.videos.length > 0));
    if (hasBulkMedia && this.wasm && this.wasm.hasBulkWorker()) {
      this._publishBulkOffThread(msgType, payload);
      return;
    }
    this._publishSyncFallback(msgType, payload);
  }

  refreshLogFromWasm() {
    const existing = Array.isArray(this.logMessages) ? this.logMessages : [];
    const byId = new Map();
    const knownVersions = {};
    const knownRevs = {};
    for (const m of existing) {
      if (m && m.id) {
        byId.set(m.id, m);
        knownVersions[m.id] = Number(m.updatedLamport) || 0;
        knownRevs[m.id] = messageEditRev(m);
      }
    }
    const res = this.wasm.call({ cmd: "get_log_delta", knownVersions, knownRevs });
    this.status = res.status;
    const delta = res.delta;
    if (!delta || !Array.isArray(delta.order)) {
      const state = this.wasm.call({ cmd: "get_state" });
      this.status = state.status;
      this.logMessages = state.log;
      return;
    }
    if (Array.isArray(delta.changed)) {
      for (const msg of delta.changed) {
        if (msg && msg.id) {
          byId.set(msg.id, msg);
        }
      }
    }
    const nextLog = [];
    for (const id of delta.order) {
      const item = byId.get(id);
      if (item) nextLog.push(item);
    }
    this.logMessages = nextLog;
  }

  wipeLocalLog() {
    const res = this.wasm.call({ cmd: "clear_log" });
    this.status = res.status;
    this.logMessages = res.log;
    this.addTelemetry(
      "storage",
      "Cleared local in-memory messages; click Sync Now to backfill from online peers"
    );
    this.renderAll();
    this.showToast("Cleared local view (online peers still hold active messages)");
  }

  exportEncryptedBackup() {
    const exp = this.wasm.call({ cmd: "export_snapshot" });
    const blob = new Blob([JSON.stringify(exp.snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `p2p-direct-e2ee-backup-${this.status.peerId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast(`Exported ${exp.snapshot.records.length} encrypted record(s)`);
  }

  exportDecryptedLog() {
    const exp = this.wasm.call({ cmd: "export_decrypted" });
    const blob = new Blob([JSON.stringify(exp.snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `p2p-direct-log-${this.status.peerId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast(`Exported ${this.logMessages.length} decrypted log entries`);
  }

  /* ================= Long-Lived Reusable Room Links & Encrypted Rendezvous ================= */

  _disconnectAllPeersForRoomSwitch() {
    if (this.voice.inVoice) {
      this.leaveVoiceChat(/* silent = */ true);
    }
    this.voice.joinOrder = [];
    this.voice.lastRosterKey = "";
    this.voice.renderedKeys.clear();

    for (const entry of this.roomDialing.values()) {
      try {
        entry.pc.close();
      } catch {
        // ignore
      }
    }
    this.roomDialing.clear();
    this.earlyRoomIce.clear();
    this.seenRoomSignalIds.clear();
    this.lastHelloReplyPerPeer.clear();

    for (const entry of this.localDialing.values()) {
      try {
        entry.pc.close();
      } catch {
        // ignore
      }
    }
    this.localDialing.clear();
    this.earlyLocalIce.clear();

    for (const entry of this.relayPeers.values()) {
      try {
        entry.pc.close();
      } catch {
        // ignore
      }
    }
    this.relayPeers.clear();
    this.earlyRelayIce.clear();

    for (const p of this.pendingOffers.values()) {
      try {
        p.dc.close();
        if (p.voiceDc) p.voiceDc.close();
        p.pc.close();
      } catch {
        // ignore
      }
    }
    this.pendingOffers.clear();
    this.latestOffer = null;

    for (const a of this.pendingAnswers.values()) {
      try {
        a.pc.close();
      } catch {
        // ignore
      }
    }
    this.pendingAnswers.clear();
    this.latestAnswer = null;

    const oldPeerIds = Array.from(this.directPeers.keys());
    for (const pid of oldPeerIds) {
      const entry = this.directPeers.get(pid);
      if (entry) {
        entry.superseded = true;
        try {
          entry.dc.onclose = null;
          entry.dc.onerror = null;
          entry.pc.onconnectionstatechange = null;
          entry.pc.oniceconnectionstatechange = null;
          entry.dc.close();
          if (entry.voiceDc) entry.voiceDc.close();
          entry.pc.close();
        } catch {
          // ignore
        }
      }
      this.directPeers.delete(pid);
    }
    for (const vdc of this.voiceChannels.values()) {
      try {
        vdc.close();
      } catch {
        // ignore
      }
    }
    this.voiceChannels.clear();

    for (const p of (this.status?.peers || []).slice()) {
      try {
        const res = this.wasm.call({ cmd: "peer_disconnected", peerId: p.peerId });
        this.status = res.status;
      } catch {
        // ignore
      }
    }
  }

  switchToMeshKey(newMeshKey, passphraseMode, roomName) {
    const cleanRoom = (roomName || "").trim() || "Shared Room";
    const sameKey =
      newMeshKey === this.profile.meshKey &&
      Boolean(passphraseMode) === Boolean(this.status.e2ee?.passphraseMode);

    if (sameKey) {
      if (cleanRoom && cleanRoom !== this.status.room) {
        const prof = this.wasm.call({ cmd: "set_profile", room: cleanRoom });
        this.status = prof.status;
        this.profile.room = cleanRoom;
      }
      return false;
    }

    this._disconnectAllPeersForRoomSwitch();
    this.discoveredLocalMeshes.clear();

    // Clear in-memory log before adopting the new room key; live peers in the target room backfill automatically
    this.wasm.call({ cmd: "clear_log" });
    const keyRes = this.wasm.call({
      cmd: "set_mesh_key",
      meshKey: newMeshKey,
      passphraseMode: Boolean(passphraseMode),
      entropy: randomBase64Url(32),
    });
    this.status = keyRes.status;

    const profRes = this.wasm.call({ cmd: "set_profile", room: cleanRoom });
    this.status = profRes.status;
    this.profile.meshKey = newMeshKey;
    this.profile.passphraseMode = Boolean(passphraseMode);
    this.profile.room = cleanRoom;
    this.refreshLogFromWasm();
    return true;
  }

  createLongLivedRoom({ freshKey = false, roomNameOverride = null } = {}) {
    const typedName =
      roomNameOverride !== null
        ? String(roomNameOverride).trim()
        : (this.el["room-name-input"]?.value || "").trim();
    const params = new URLSearchParams(window.location.search);
    const queryRelay = (params.get("relay") || "").trim() || null;

    let roomName = typedName;
    if (freshKey) {
      const freshMeshKey = randomBase64Url(32);
      if (!roomName) {
        roomName = `Room ${freshMeshKey.slice(0, 4).toUpperCase()}`;
      }
      this.switchToMeshKey(freshMeshKey, false, roomName);
    } else if (!roomName) {
      roomName =
        this.status.room && this.status.room !== "mesh-main" && this.status.room !== "default"
          ? this.status.room
          : "Shared Room";
    }

    if (this.el["room-name-input"]) {
      this.el["room-name-input"].value = "";
    }
    if (this.el["lobby-room-name-input"]) {
      this.el["lobby-room-name-input"].value = "";
    }
    this.el["connect-notice"].classList.add("hidden");
    this.el["lobby-notice"]?.classList.add("hidden");
    this.el["lobby-passphrase-box"]?.classList.add("hidden");
    this.activateCurrentMeshAsRoom({
      roomName,
      relay: queryRelay,
      updateHash: true,
      silent: false,
      joined: false,
    });
    this.broadcastMeshBeacon(true);
  }

  async joinLongLivedRoomLink(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) return false;
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
      const sig = decoded.signal;
      if (sig.kind !== "room") {
        throw new Error(`Expected a room invite link, got '${sig.kind}'`);
      }

      let targetMeshKey = this.profile.meshKey;
      let targetPassMode = Boolean(this.status.e2ee?.passphraseMode);
      if (!sig.encrypted && sig.meshKey) {
        targetMeshKey = sig.meshKey;
        targetPassMode = false;
      } else if (sig.encrypted) {
        if (passInput && !targetPassMode) {
          const passRes = this.wasm.call({
            cmd: "set_passphrase",
            passphrase: passInput,
            entropy: randomBase64Url(32),
          });
          targetMeshKey = passRes.meshKey;
          targetPassMode = true;
        }
      }

      this.pendingRoomCode = null;
      const roomName =
        sig.room && sig.room !== "default" && sig.room !== "mesh-main"
          ? sig.room
          : "Shared Room";
      this.switchToMeshKey(targetMeshKey, targetPassMode, roomName);

      const params = new URLSearchParams(window.location.search);
      const effectiveRelay = (params.get("relay") || "").trim() || sig.relay || null;

      this.el["connect-notice"].classList.add("hidden");
      this.el["lobby-notice"]?.classList.add("hidden");
      this.el["lobby-passphrase-box"]?.classList.add("hidden");
      if (this.el["lobby-room-link-input"]) {
        this.el["lobby-room-link-input"].value = "";
      }
      this.activateCurrentMeshAsRoom({
        roomName,
        relay: effectiveRelay,
        updateHash: true,
        silent: false,
        joined: true,
      });
      this.broadcastMeshBeacon(true);
      return true;
    } catch (err) {
      const msg = err?.message || "Invalid room link";
      if (msg.toLowerCase().includes("passphrase")) {
        this.pendingRoomCode = trimmed;
        this.el["e2ee-key-details"].open = true;
        if (this.advancedMode) {
          this.el["e2ee-passphrase-input"].focus();
        } else if (this.el["lobby-passphrase-box"]) {
          this.el["lobby-passphrase-box"].classList.remove("hidden");
          this.el["lobby-passphrase-input"]?.focus();
        }
      }
      this.showNotice("connect-notice", "error", msg);
      if (this.el["lobby-notice"]) {
        this.showNotice("lobby-notice", "error", msg);
      }
      this.syncLayoutAttributes();
      return false;
    }
  }

  activateCurrentMeshAsRoom({
    roomName,
    relay = null,
    updateHash = true,
    silent = false,
    joined = false,
  } = {}) {
    const cleanName = (roomName || this.status.room || "Shared Room").trim() || "Shared Room";
    const encoded = this.wasm.call({
      cmd: "encode_room_invite",
      room: cleanName,
      relay: relay || undefined,
      baseUrl: shareableBaseUrl(),
      entropy: randomBase64Url(16),
    });
    this.status = encoded.status;
    if (!joined) {
      try {
        const colorRes = this.wasm.call({ cmd: "commit_peer_color" });
        this.status = colorRes.status;
        this.executeActions(colorRes.actions);
      } catch {
        // ignore
      }
    }
    const savedMatch = this.savedRooms.find((r) => r.topic === encoded.roomTopic);
    const displayName = (savedMatch && savedMatch.name) || encoded.room;
    this.activeRoom = {
      name: displayName,
      code: encoded.code,
      url: encoded.url,
      topic: encoded.roomTopic,
      relay: relay || null,
      encrypted: Boolean(encoded.encrypted),
    };
    this.profile.room = displayName;
    this._recordLastJoinedRoom(this.activeRoom);

    if (updateHash) {
      try {
        history.replaceState(null, "", `${basePageUrl()}#room=${encoded.code}`);
      } catch {
        // ignore restricted history API
      }
    }

    this.startRoomRendezvous(encoded.roomTopic, relay);
    this.broadcastMeshBeacon(true);
    if (this.mobileAdvTab === "connect" && typeof window !== "undefined" && window.innerWidth <= 1020) {
      this.setMobileAdvTab("chat", { autoOpen: false, scrollTop: false });
    }
    this.renderAll();

    this.addTelemetry(
      "room",
      `${joined ? "Joined" : "Created"} long-lived room "${displayName}" (topic ${encoded.roomTopic.slice(0, 10)}…)`
    );
    if (!silent) {
      this.showToast(
        joined
          ? `Joined "${displayName}" — connecting to peers automatically`
          : `Room link ready for "${displayName}"`
      );
    }
  }

  leaveLongLivedRoom({ silent = false } = {}) {
    this.stopPreCallMicMonitor();
    this.closeLightbox();
    for (const item of this.pendingImages) {
      this._revokePendingPreviewUrl(item);
    }
    this.pendingImages = [];
    this.renderImageTray();
    this.notifyRelayPeersClosing();
    if (this.roomRendezvous) {
      this.roomRendezvous.stop();
      this.roomRendezvous = null;
    }
    this._resetRoomRelayState();
    this.activeRoom = null;
    this.pendingRoomCode = null;
    this.roomRelayStatus = { state: "stopped", connectedCount: 0, totalCount: 0 };
    this.el["lobby-notice"]?.classList.add("hidden");
    this.el["lobby-passphrase-box"]?.classList.add("hidden");
    // Disconnect from the room and wipe in-memory messages so leaving leaves zero trace
    this.switchToMeshKey(randomBase64Url(32), false, "mesh-main");
    try {
      history.replaceState(null, "", basePageUrl());
    } catch {
      // ignore
    }
    this.renderAll();
    this.addTelemetry("room", "Left room and cleared in-memory session");
    if (!silent) {
      this.showToast("Left room — local messages cleared");
    }
  }

  /* ================= Locally Saved Rooms & Last Joined Room ================= */

  _formatRelativeRoomTime(tsMs) {
    if (!tsMs || !Number.isFinite(tsMs)) return "";
    const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (diffSec < 45) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    try {
      return new Date(tsMs).toLocaleDateString();
    } catch {
      return "";
    }
  }

  _savedRoomAccentClass(topic) {
    let hash = 0;
    const s = String(topic || "");
    for (let i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    }
    return `accent-${hash % 5}`;
  }

  _recordLastJoinedRoom(room) {
    if (!room || !room.code || !room.topic) return;
    const now = Date.now();
    const saved = saveLastJoinedRoom({
      topic: room.topic,
      name: room.name || "Shared Room",
      code: room.code,
      url: room.url || `${shareableBaseUrl()}#room=${room.code}`,
      relay: room.relay || null,
      encrypted: Boolean(room.encrypted),
      lastJoinedAt: now,
    });
    if (saved) {
      this.lastJoinedRoom = saved;
      this.savedRooms = loadSavedRooms();
      this.broadcastTabState({ savedRoomsChanged: true });
    }
  }

  isRoomTopicSaved(topic) {
    if (!topic) return false;
    return this.savedRooms.some((r) => r.topic === topic);
  }

  toggleSaveActiveRoom() {
    if (!this.activeRoom) return;
    const { topic, name } = this.activeRoom;
    if (this.isRoomTopicSaved(topic)) {
      this.savedRooms = removeSavedRoom(topic);
      if (this.editingSavedRoomTopic === topic) {
        this.editingSavedRoomTopic = null;
      }
      this.renderSavedRooms();
      this.broadcastTabState({ savedRoomsChanged: true });
      this.showToast(`Removed "${name || "Shared Room"}" from saved rooms`);
    } else {
      this.saveRoomBookmark(this.activeRoom);
    }
  }

  saveRoomBookmark(entry) {
    if (!entry || !entry.code || !entry.topic) return;
    const now = Date.now();
    this.savedRooms = upsertSavedRoom({
      topic: entry.topic,
      name: entry.name || "Shared Room",
      code: entry.code,
      url: entry.url || `${shareableBaseUrl()}#room=${entry.code}`,
      relay: entry.relay || null,
      encrypted: Boolean(entry.encrypted),
      savedAt: now,
      lastJoinedAt: entry.lastJoinedAt || now,
    });
    this.renderSavedRooms();
    this.broadcastTabState({ savedRoomsChanged: true });
    this.showToast(`Saved "${entry.name || "Shared Room"}" locally`);
  }

  removeSavedRoomByTopic(topic) {
    if (!topic) return;
    const prev = this.savedRooms.find((r) => r.topic === topic);
    this.savedRooms = removeSavedRoom(topic);
    if (this.editingSavedRoomTopic === topic) {
      this.editingSavedRoomTopic = null;
    }
    this.renderSavedRooms();
    this.broadcastTabState({ savedRoomsChanged: true });
    if (prev) {
      this.showToast(`Removed "${prev.name}" from saved rooms`);
    }
  }

  renameSavedRoomByTopic(topic, newName) {
    if (!topic) return;
    const trimmed = String(newName || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!trimmed) {
      this.editingSavedRoomTopic = null;
      this.renderSavedRooms();
      return;
    }
    this.savedRooms = renameSavedRoom(topic, trimmed);
    this.lastJoinedRoom = loadLastJoinedRoom();
    if (this.activeRoom && this.activeRoom.topic === topic) {
      this.activeRoom.name = trimmed;
      this.profile.room = trimmed;
    }
    this.editingSavedRoomTopic = null;
    this.renderRoomCard();
    this.broadcastTabState({ savedRoomsChanged: true });
    this.showToast(`Renamed room to "${trimmed}"`);
  }

  dismissLastJoinedRoom() {
    clearLastJoinedRoom();
    this.lastJoinedRoom = null;
    this.renderSavedRooms();
    this.broadcastTabState({ savedRoomsChanged: true });
    this.showToast("Cleared last joined room");
  }

  async joinSavedRoom(entry) {
    if (!entry || (!entry.code && !entry.url)) return false;
    if (this.activeRoom && this.activeRoom.topic === entry.topic) {
      this.showToast(`Already in "${this.activeRoom.name || "Shared Room"}"`);
      return true;
    }
    if (this.activeRoom) {
      this.leaveLongLivedRoom({ silent: true });
    }
    return await this.joinLongLivedRoomLink(entry.code || entry.url);
  }

  renderSavedRooms() {
    const activeTopic = this.activeRoom?.topic || "";
    const activeIsSaved = Boolean(activeTopic && this.isRoomTopicSaved(activeTopic));

    // 1. Update Simple Room Bar Save button
    const simpleSaveBtn = this.el["btn-simple-save-room"];
    if (simpleSaveBtn) {
      simpleSaveBtn.classList.toggle("hidden", !this.activeRoom);
      simpleSaveBtn.classList.toggle("is-saved", activeIsSaved);
      simpleSaveBtn.setAttribute("aria-pressed", String(activeIsSaved));
      simpleSaveBtn.title = activeIsSaved
        ? "Saved locally — click to remove from saved rooms"
        : "Save this room locally so you can rejoin it anytime";
      if (this.el["simple-save-room-icon"]) {
        this.el["simple-save-room-icon"].textContent = activeIsSaved ? "★" : "☆";
      }
      if (this.el["simple-save-room-label"]) {
        this.el["simple-save-room-label"].innerHTML = activeIsSaved
          ? 'Saved'
          : 'Save<span class="mobile-hide"> Room</span>';
      }
    }

    // 2. Update Advanced Rail Save Room button
    const advSaveBtn = this.el["btn-room-save"];
    if (advSaveBtn) {
      advSaveBtn.classList.toggle("is-saved", activeIsSaved);
      advSaveBtn.setAttribute("aria-pressed", String(activeIsSaved));
      advSaveBtn.textContent = activeIsSaved ? "★ Saved" : "☆ Save Room";
    }

    // Memoize DOM rebuild so inline rename input never loses focus on unrelated status refreshes
    const renderKey = JSON.stringify({
      activeTopic,
      editing: this.editingSavedRoomTopic,
      last: this.lastJoinedRoom,
      saved: this.savedRooms,
      filter: this.savedRoomsFilter,
      advFilter: this.advSavedRoomsFilter,
      collapsed: this.savedRoomsCollapsed,
    });
    if (this._lastSavedRoomsRenderKey === renderKey) {
      return;
    }
    this._lastSavedRoomsRenderKey = renderKey;

    const saved = this.savedRooms || [];
    const last = this.lastJoinedRoom || null;

    if (saved.length < 4) {
      if (this.savedRoomsFilter) {
        this.savedRoomsFilter = "";
        if (this.el["lobby-saved-filter"]) this.el["lobby-saved-filter"].value = "";
      }
      if (this.advSavedRoomsFilter) {
        this.advSavedRoomsFilter = "";
        if (this.el["adv-saved-filter"]) this.el["adv-saved-filter"].value = "";
      }
    }

    const filterQuery = (this.savedRoomsFilter || "").trim().toLowerCase();
    const filteredSaved = filterQuery
      ? saved.filter(
          (r) =>
            String(r.name || "").toLowerCase().includes(filterQuery) ||
            String(r.topic || "").toLowerCase().includes(filterQuery)
        )
      : saved;

    // 3. Render Lobby Saved Rooms & Last Joined Dock
    const lobbySection = this.el["lobby-saved-section"];
    const lastWrap = this.el["lobby-last-room-wrap"];
    const gridEl = this.el["lobby-saved-rooms-grid"];
    const countEl = this.el["lobby-saved-count"];
    const toggleBtn = this.el["btn-lobby-saved-toggle"];
    const filterWrap = this.el["lobby-saved-filter-wrap"];
    const filterMeta = this.el["lobby-saved-filter-meta"];
    const filterClearBtn = this.el["btn-lobby-saved-filter-clear"];

    if (lobbySection && lastWrap && gridEl) {
      const hasAnything = Boolean(last || saved.length > 0);
      lobbySection.classList.toggle("hidden", !hasAnything);
      lobbySection.classList.toggle("is-many-rooms", saved.length >= 4);

      if (hasAnything) {
        if (countEl) {
          const summaryParts = [];
          if (last) summaryParts.push("Last Joined");
          if (saved.length > 0) {
            summaryParts.push(`${saved.length} Saved`);
          }
          countEl.textContent = summaryParts.join(" · ");
        }

        if (toggleBtn) {
          const showToggle = saved.length >= 1;
          toggleBtn.classList.toggle("hidden", !showToggle);
          toggleBtn.setAttribute("aria-expanded", String(!this.savedRoomsCollapsed));
          toggleBtn.textContent = this.savedRoomsCollapsed
            ? `Saved (${saved.length}) ▾`
            : "Hide Saved ▴";
        }

        // Sleek Last Joined Quick-Resume Strip (never auto-joins; 1-click manual Rejoin)
        if (last) {
          lastWrap.classList.remove("hidden");
          const lastSaved = this.isRoomTopicSaved(last.topic);
          const relTime = this._formatRelativeRoomTime(last.lastJoinedAt);
          const lockTag = last.encrypted
            ? '<span class="lobby-room-tag is-lock">Passphrase</span>'
            : "";
          const savedTag = lastSaved
            ? '<span class="lobby-room-tag is-saved-badge" title="Also in your Saved Rooms">★</span>'
            : "";
          const saveBtnHtml = lastSaved
            ? ""
            : '<button type="button" class="lobby-room-sub-btn" id="btn-lobby-save-last-room" title="Save this room to your saved rooms list">☆ Save</button>';

          lastWrap.innerHTML = `
            <div class="lobby-last-room-card" data-last-room-topic="${escapeHtml(last.topic)}">
              <div class="lobby-room-main">
                <div class="lobby-room-top">
                  <span class="lobby-room-tag">Last Joined</span>
                  ${savedTag}
                  ${lockTag}
                  <span class="lobby-room-meta">${relTime ? `${escapeHtml(relTime)} · ` : ""}#${escapeHtml(last.topic.slice(0, 6))}</span>
                </div>
                <span class="lobby-room-name" title="${escapeHtml(last.name)}">${escapeHtml(last.name)}</span>
              </div>
              <div class="lobby-room-actions">
                <button type="button" class="lobby-room-join-btn" id="btn-lobby-rejoin-last">▶ Rejoin</button>
                ${saveBtnHtml}
                <button type="button" class="lobby-room-sub-btn is-danger" id="btn-lobby-dismiss-last" title="Forget last joined room" aria-label="Forget last joined room">×</button>
              </div>
            </div>
          `;
          const rejoinBtn = lastWrap.querySelector("#btn-lobby-rejoin-last");
          if (rejoinBtn) {
            rejoinBtn.addEventListener("click", () => this.joinSavedRoom(last));
          }
          const saveLastBtn = lastWrap.querySelector("#btn-lobby-save-last-room");
          if (saveLastBtn) {
            saveLastBtn.addEventListener("click", () => this.saveRoomBookmark(last));
          }
          const dismissBtn = lastWrap.querySelector("#btn-lobby-dismiss-last");
          if (dismissBtn) {
            dismissBtn.addEventListener("click", () => this.dismissLastJoinedRoom());
          }
        } else {
          lastWrap.classList.add("hidden");
          lastWrap.innerHTML = "";
        }

        // Filter bar (auto-shown when 4+ saved rooms exist and section isn't collapsed)
        if (filterWrap) {
          const showFilter = saved.length >= 4 && !this.savedRoomsCollapsed;
          filterWrap.classList.toggle("hidden", !showFilter);
          if (filterMeta) {
            filterMeta.textContent = filterQuery
              ? `${filteredSaved.length} / ${saved.length}`
              : `${saved.length} rooms`;
          }
          if (filterClearBtn) {
            filterClearBtn.classList.toggle("hidden", !filterQuery);
          }
        }

        // Saved Rooms compact grid/list
        if (saved.length > 0 && !this.savedRoomsCollapsed) {
          gridEl.classList.remove("hidden");
          if (filteredSaved.length === 0) {
            gridEl.innerHTML = `
              <div class="saved-rooms-empty-filter">
                <span>No saved rooms match "${escapeHtml(this.savedRoomsFilter.trim())}"</span>
                <button type="button" class="lobby-room-sub-btn" data-saved-clear-filter>Clear Filter</button>
              </div>
            `;
            const clr = gridEl.querySelector("[data-saved-clear-filter]");
            if (clr) {
              clr.addEventListener("click", () => {
                this.savedRoomsFilter = "";
                if (this.el["lobby-saved-filter"]) this.el["lobby-saved-filter"].value = "";
                this.renderSavedRooms();
              });
            }
          } else {
            gridEl.innerHTML = filteredSaved
              .map((room) => {
                const idx = saved.indexOf(room);
                const isEditing = this.editingSavedRoomTopic === room.topic;
                const isLast = Boolean(last && last.topic === room.topic);
                const accentCls = this._savedRoomAccentClass(room.topic);
                const relTime = this._formatRelativeRoomTime(room.lastJoinedAt || room.savedAt);
                const lockTag = room.encrypted
                  ? '<span class="lobby-room-tag is-lock">Passphrase</span>'
                  : "";
                const lastTag = isLast
                  ? '<span class="lobby-room-tag is-last-pill">Recent</span>'
                  : "";
                const titleBlock = isEditing
                  ? `
                    <form class="saved-room-rename-form" data-rename-form="${idx}">
                      <input
                        type="text"
                        class="saved-room-rename-input"
                        data-rename-input="${idx}"
                        maxlength="40"
                        value="${escapeHtml(room.name)}"
                        aria-label="Room name"
                      />
                      <button type="submit" class="lobby-room-sub-btn" title="Save name">✓</button>
                      <button type="button" class="lobby-room-sub-btn" data-rename-cancel="${idx}" title="Cancel rename">✕</button>
                    </form>
                  `
                  : `<div class="saved-room-name-line">
                      <span class="saved-room-star" aria-hidden="true">★</span>
                      <span class="lobby-room-name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span>
                      ${lastTag}
                      ${lockTag}
                    </div>`;

                return `
                  <article class="saved-room-card ${accentCls}${isLast ? " is-last-joined" : ""}" data-saved-room-topic="${escapeHtml(room.topic)}">
                    <div class="lobby-room-main">
                      ${titleBlock}
                      <span class="lobby-room-meta">${relTime ? `${escapeHtml(relTime)} · ` : ""}#${escapeHtml(room.topic.slice(0, 8))}</span>
                    </div>
                    <div class="lobby-room-actions">
                      <button type="button" class="lobby-room-join-btn" data-saved-join="${idx}">▶ Join</button>
                      <button type="button" class="lobby-room-sub-btn" data-saved-copy="${idx}" title="Copy room invite link">Copy</button>
                      <button type="button" class="lobby-room-sub-btn" data-saved-rename="${idx}" title="Rename saved room" aria-label="Rename saved room">✎</button>
                      <button type="button" class="lobby-room-sub-btn is-danger" data-saved-remove="${idx}" title="Remove from saved rooms" aria-label="Remove saved room">×</button>
                    </div>
                  </article>
                `;
              })
              .join("");

            for (const btn of gridEl.querySelectorAll("[data-saved-join]")) {
              const room = saved[Number(btn.dataset.savedJoin)];
              if (room) btn.addEventListener("click", () => this.joinSavedRoom(room));
            }
            for (const btn of gridEl.querySelectorAll("[data-saved-copy]")) {
              const room = saved[Number(btn.dataset.savedCopy)];
              if (room) {
                btn.addEventListener("click", () => {
                  const copyUrl = room.url || `${shareableBaseUrl()}#room=${room.code}`;
                  this.copyText(copyUrl, `Copied link for "${room.name}"`);
                });
              }
            }
            for (const btn of gridEl.querySelectorAll("[data-saved-rename]")) {
              const room = saved[Number(btn.dataset.savedRename)];
              if (room) {
                btn.addEventListener("click", () => {
                  this.editingSavedRoomTopic =
                    this.editingSavedRoomTopic === room.topic ? null : room.topic;
                  this.renderSavedRooms();
                });
              }
            }
            for (const btn of gridEl.querySelectorAll("[data-saved-remove]")) {
              const room = saved[Number(btn.dataset.savedRemove)];
              if (room) btn.addEventListener("click", () => this.removeSavedRoomByTopic(room.topic));
            }
            for (const form of gridEl.querySelectorAll("[data-rename-form]")) {
              const idx = Number(form.dataset.renameForm);
              const room = saved[idx];
              const input = form.querySelector(`[data-rename-input="${idx}"]`);
              const cancelBtn = form.querySelector(`[data-rename-cancel="${idx}"]`);
              if (input) {
                input.focus();
                input.select();
                input.addEventListener("keydown", (ev) => {
                  if (ev.key === "Escape") {
                    ev.preventDefault();
                    this.editingSavedRoomTopic = null;
                    this.renderSavedRooms();
                  }
                });
              }
              if (cancelBtn) {
                cancelBtn.addEventListener("click", () => {
                  this.editingSavedRoomTopic = null;
                  this.renderSavedRooms();
                });
              }
              if (room && input) {
                form.addEventListener("submit", (ev) => {
                  ev.preventDefault();
                  this.renameSavedRoomByTopic(room.topic, input.value);
                });
              }
            }
          }
        } else {
          gridEl.classList.add("hidden");
          gridEl.innerHTML = "";
        }
      } else {
        if (toggleBtn) toggleBtn.classList.add("hidden");
        if (filterWrap) filterWrap.classList.add("hidden");
        lastWrap.classList.add("hidden");
        lastWrap.innerHTML = "";
        gridEl.classList.add("hidden");
        gridEl.innerHTML = "";
      }
    }

    // 4. Render Compact Saved Rooms Switcher in Advanced Connect Peer Rail
    const advCard = this.el["adv-saved-rooms-card"];
    const advList = this.el["adv-saved-rooms-list"];
    const advCount = this.el["adv-saved-rooms-count"];
    const advFilterWrap = this.el["adv-saved-filter-wrap"];
    if (advCard && advList) {
      advCard.classList.toggle("hidden", saved.length === 0);
      if (advFilterWrap) {
        advFilterWrap.classList.toggle("hidden", saved.length < 4);
      }
      const advQ = (this.advSavedRoomsFilter || "").trim().toLowerCase();
      const advFiltered = advQ
        ? saved.filter(
            (r) =>
              String(r.name || "").toLowerCase().includes(advQ) ||
              String(r.topic || "").toLowerCase().includes(advQ)
          )
        : saved;

      if (advCount) {
        advCount.textContent = advQ ? `${advFiltered.length} / ${saved.length}` : String(saved.length);
      }
      if (saved.length > 0) {
        if (advFiltered.length === 0) {
          advList.innerHTML = `<div class="adv-saved-empty">No rooms match "${escapeHtml(this.advSavedRoomsFilter.trim())}"</div>`;
        } else {
          advList.innerHTML = advFiltered
            .map((room) => {
              const idx = saved.indexOf(room);
              const isCurrent = Boolean(activeTopic && activeTopic === room.topic);
              const isLast = Boolean(last && last.topic === room.topic);
              const subParts = [
                isCurrent ? "Active" : this._formatRelativeRoomTime(room.lastJoinedAt || room.savedAt),
                isLast && !isCurrent ? "Recent" : "",
                room.encrypted ? "Passphrase" : "",
              ].filter(Boolean);
              return `
                <div class="adv-saved-room-row${isCurrent ? " is-current" : ""}" data-adv-saved-topic="${escapeHtml(room.topic)}">
                  <div class="adv-saved-room-info">
                    <span class="adv-saved-room-name" title="${escapeHtml(room.name)}">${escapeHtml(room.name)}</span>
                    <span class="adv-saved-room-sub">${escapeHtml(subParts.join(" · "))}</span>
                  </div>
                  <div class="adv-saved-room-actions">
                    ${
                      isCurrent
                        ? '<span class="badge auto">Here</span>'
                        : `<button type="button" class="btn btn-sm btn-primary" data-adv-saved-join="${idx}">Join</button>`
                    }
                    <button type="button" class="btn btn-sm" data-adv-saved-remove="${idx}" title="Remove saved room" aria-label="Remove saved room">×</button>
                  </div>
                </div>
              `;
            })
            .join("");

          for (const btn of advList.querySelectorAll("[data-adv-saved-join]")) {
            const room = saved[Number(btn.dataset.advSavedJoin)];
            if (room) btn.addEventListener("click", () => this.joinSavedRoom(room));
          }
          for (const btn of advList.querySelectorAll("[data-adv-saved-remove]")) {
            const room = saved[Number(btn.dataset.advSavedRemove)];
            if (room) btn.addEventListener("click", () => this.removeSavedRoomByTopic(room.topic));
          }
        }
      } else {
        advList.innerHTML = "";
      }
    }

    this.syncMobileAdvNav();
  }

  _resetRoomRelayState() {
    for (const entry of this.roomDialing.values()) {
      if (entry.trickleTimer) clearTimeout(entry.trickleTimer);
      if (entry.fallbackTimer) clearTimeout(entry.fallbackTimer);
      if (entry.hardTimer) clearTimeout(entry.hardTimer);
      try {
        entry.pc.close();
      } catch {
        // ignore
      }
    }
    this.roomDialing.clear();
    this.earlyRoomIce.clear();
    for (const pending of this.relayPendingOpens.values()) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
    }
    this.relayPendingOpens.clear();
    this.roomMyTag = null;
    this.roomKnownPeers.clear();
    this.roomTagToPeerId.clear();
    this.earlyRelayDataFrames.clear();
    this.relayChunkAssemblies.clear();
    this.seenRelayChunkKeys.clear();
    this._clearRelayVoiceReorder();
    this.directUpgradeState.clear();
    this._resetAllMediaSyncState();
  }

  async _ensureRoomMyTag() {
    if (!this.activeRoom || !this.status) return null;
    const topic = this.activeRoom.topic;
    const peerId = this.status.peerId;
    if (this.roomMyTag && this.roomMyTag.topic === topic && this.roomMyTag.peerId === peerId) {
      return this.roomMyTag;
    }
    const shaFn = this.wasm ? (b) => this.wasm.sha256(b) : null;
    const tag = await computePeerTag(topic, peerId, shaFn);
    this.roomMyTag = { topic, peerId, bytes: tag.bytes, hex: tag.hex };
    return this.roomMyTag;
  }

  async _registerKnownRoomPeer(peerId, name, pk, relays = null) {
    if (!this.activeRoom || !peerId || peerId === this.status?.peerId) return null;
    let info = this.roomKnownPeers.get(peerId);
    if (!info) {
      const shaFn = this.wasm ? (b) => this.wasm.sha256(b) : null;
      const tag = await computePeerTag(this.activeRoom.topic, peerId, shaFn);
      info = {
        peerId,
        name: name || "Peer",
        pk: pk || "",
        relays: Array.isArray(relays) ? relays.slice() : [],
        tagBytes: tag.bytes,
        tagHex: tag.hex,
        lastSeenMs: Date.now(),
      };
      this.roomKnownPeers.set(peerId, info);
      this.roomTagToPeerId.set(tag.hex, peerId);
    } else {
      if (name) info.name = name;
      if (pk) info.pk = pk;
      if (Array.isArray(relays) && relays.length > 0) {
        info.relays = relays.slice();
      }
      info.lastSeenMs = Date.now();
    }
    return info;
  }

  notifyRelayPeersClosing() {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    for (const [pid, peer] of this.directPeers.entries()) {
      if (peer.transport === "relay") {
        this.sendRoomSignal({
          t: "relay-close",
          from: this.status.peerId,
          to: pid,
        });
      }
    }
  }

  checkRelayPeersHealth(now) {
    for (const [pid, peer] of Array.from(this.directPeers.entries())) {
      if (peer.transport !== "relay" || peer.superseded) continue;
      if (now - (peer.lastActivityMs || 0) > RELAY_INACTIVITY_TIMEOUT_MS) {
        this.addTelemetry("room", `E2EE Relay peer ${peer.authorName} timed out — removing`);
        try {
          peer.dc.close(true);
        } catch {
          // ignore
        }
      }
    }
  }

  tryBackgroundDirectUpgrades(now, forceNow = false) {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    for (const [pid, peer] of this.directPeers.entries()) {
      if (peer.transport !== "relay" || peer.superseded) continue;
      if (this.localDialing.has(pid)) continue;
      const existingDial = this.roomDialing.get(pid);
      if (existingDial) {
        if (forceNow && (!existingDial.isUpgradeProbe || now - existingDial.startedAt > 2500)) {
          this._cleanupRoomDialingEntry(pid, existingDial, null);
        } else {
          continue;
        }
      }
      // Only lower peerId initiates periodic direct-upgrade probes to avoid glare
      // (forceNow e.g. on mic permission unmasking can initiate from either side)
      if (!forceNow && this.status.peerId > pid) continue;

      const state = this.directUpgradeState.get(pid) || {
        connectedAt: 0,
        lastAttemptAt: 0,
        attempts: 0,
      };
      if (!forceNow) {
        if (state.attempts >= DIRECT_UPGRADE_MAX_ATTEMPTS) continue;
        const lastMarker = Math.max(state.connectedAt || 0, state.lastAttemptAt || 0);
        if (now - lastMarker < DIRECT_UPGRADE_INTERVAL_MS) continue;
      } else if (state.lastAttemptAt && now - state.lastAttemptAt < 2500) {
        continue;
      }

      const known = this.roomKnownPeers.get(pid);
      const pk = known?.pk || peer.peerPubKey;
      if (!pk) continue;
      state.lastAttemptAt = now;
      if (!forceNow) state.attempts += 1;
      this.directUpgradeState.set(pid, state);
      this.startRoomOffer(pid, peer.authorName || known?.name || "Peer", pk, /* isUpgradeProbe = */ true);
    }
  }

  startRoomRendezvous(roomTopic, customRelay) {
    const urls = resolveRelayUrls(customRelay);
    if (
      this.roomRendezvous &&
      this.roomRendezvous.roomTopic === roomTopic &&
      JSON.stringify(this.roomRendezvous.urls) === JSON.stringify(urls)
    ) {
      this._ensureRoomMyTag();
      this.announceRoomHello(true);
      return;
    }
    if (this.roomRendezvous) {
      this.notifyRelayPeersClosing();
      this.roomRendezvous.stop();
      this.roomRendezvous = null;
    }
    this._resetRoomRelayState();

    this.roomRendezvous = new MultiRelayRendezvous({
      roomTopic,
      urls,
      onMessage: (sealedPayload) => {
        this.handleSealedRoomSignal(sealedPayload);
      },
      onBinaryMessage: (bytes, brokerUrl) => {
        this.handleIncomingRelayBinary(bytes, brokerUrl);
      },
      onBrokerReady: (client, status) => {
        this.roomRelayStatus = status;
        this.renderRoomCard();
        try {
          const host = new URL(client.url).host;
          this.addTelemetry(
            "room",
            `Relay ready (${status.connectedCount}/${status.totalCount}): ${host}`
          );
        } catch {
          // ignore invalid URL formatting
        }
        this._ensureRoomMyTag();
        this.announceRoomHello(true);
      },
      onStatusChange: (status) => {
        this.roomRelayStatus = status;
        this.renderRoomCard();
      },
    });
    this._ensureRoomMyTag();
    this.roomRendezvous.start();
  }

  sendRoomSignal(msgObj) {
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
      // ignore serialization/seal errors during teardown
    }
  }

  announceRoomHello(requestReply) {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    const status = this.roomRendezvous.getStatus();
    this.sendRoomSignal({
      t: "hello",
      from: this.status.peerId,
      name: this.status.authorName,
      pk: this.status.e2ee.publicKey,
      peers: Array.from(this.directPeers.keys()),
      relays: status.connectedUrls || [],
      vcodec: this.getLocalVoiceCodec(),
      reply: Boolean(requestReply),
      ts: Date.now(),
    });
  }

  async handleSealedRoomSignal(sealedPayload) {
    if (!this.activeRoom || !this.wasm || !this.status) return;
    let msg;
    try {
      const opened = this.wasm.call({
        cmd: "open_room_signal",
        sealed: sealedPayload,
      });
      msg = JSON.parse(opened.payload);
    } catch {
      // Ignore undecryptable or tampered packets from unrelated peers
      return;
    }

    if (!msg || typeof msg !== "object" || !msg.t || msg.from === this.status.peerId) {
      return;
    }
    if (msg.to && msg.to !== this.status.peerId) {
      return;
    }
    if (msg.sid) {
      if (this.seenRoomSignalIds.has(msg.sid)) {
        return;
      }
      this.seenRoomSignalIds.set(msg.sid, Date.now());
    }

    switch (msg.t) {
      case "hello": {
        if (!msg.from || !msg.pk) return;
        this.recordPeerVoiceCodec(msg.from, msg.vcodec === "opus48" ? "opus48" : "adpcm16");
        await this._ensureRoomMyTag();
        await this._registerKnownRoomPeer(msg.from, msg.name, msg.pk, msg.relays);

        const existing = this.directPeers.get(msg.from);
        const remoteConnectedToUs =
          Array.isArray(msg.peers) && msg.peers.includes(this.status.peerId);
        const isHealthy =
          existing && existing.dc && existing.dc.readyState === "open" && remoteConnectedToUs;

        const now = Date.now();
        const lastReply = this.lastHelloReplyPerPeer.get(msg.from) || 0;
        if ((msg.reply || (!isHealthy && this.status.peerId > msg.from)) && now - lastReply >= 1400) {
          this.lastHelloReplyPerPeer.set(msg.from, now);
          this.announceRoomHello(false);
        }

        if (
          !isHealthy &&
          !this.roomDialing.has(msg.from) &&
          !this.localDialing.has(msg.from) &&
          !this.relayPeers.has(msg.from)
        ) {
          if (this.status.peerId < msg.from) {
            this.startRoomOffer(msg.from, msg.name || "Peer", msg.pk, false);
          }
        }
        break;
      }

      case "offer": {
        await this._ensureRoomMyTag();
        if (msg.from && msg.pk) {
          this.recordPeerVoiceCodec(msg.from, msg.vcodec === "opus48" ? "opus48" : "adpcm16");
          await this._registerKnownRoomPeer(msg.from, msg.name, msg.pk, msg.relays);
        }
        await this.acceptRoomOffer(msg);
        break;
      }

      case "answer": {
        if (msg.from) {
          this.recordPeerVoiceCodec(msg.from, msg.vcodec === "opus48" ? "opus48" : "adpcm16");
        }
        await this.applyRoomAnswer(msg);
        break;
      }

      case "ice": {
        await this.applyRoomIce(msg.from, msg.cand);
        break;
      }

      case "ice-batch": {
        if (Array.isArray(msg.cands)) {
          for (const cand of msg.cands) {
            await this.applyRoomIce(msg.from, cand);
          }
        }
        break;
      }

      case "relay-open": {
        if (!msg.from || !msg.pk) return;
        this.recordPeerVoiceCodec(msg.from, msg.vcodec === "opus48" ? "opus48" : "adpcm16");
        await this._ensureRoomMyTag();
        await this._registerKnownRoomPeer(msg.from, msg.name, msg.pk, msg.relays);
        const existing = this.directPeers.get(msg.from);
        if (existing && existing.transport === "direct" && existing.dc?.readyState === "open") {
          return;
        }
        const status = this.roomRendezvous?.getStatus();
        this.sendRoomSignal({
          t: "relay-ack",
          from: this.status.peerId,
          to: msg.from,
          name: this.status.authorName,
          pk: this.status.e2ee.publicKey,
          relays: status?.connectedUrls || [],
          vcodec: this.getLocalVoiceCodec(),
        });
        await this.openRelayVirtualPeer(msg.from, msg.name || "Peer", msg.pk);
        break;
      }

      case "relay-ack": {
        if (!msg.from || !msg.pk) return;
        this.recordPeerVoiceCodec(msg.from, msg.vcodec === "opus48" ? "opus48" : "adpcm16");
        await this._ensureRoomMyTag();
        await this._registerKnownRoomPeer(msg.from, msg.name, msg.pk, msg.relays);
        const pending = this.relayPendingOpens.get(msg.from);
        if (pending) {
          if (pending.retryTimer) clearTimeout(pending.retryTimer);
          this.relayPendingOpens.delete(msg.from);
        }
        const existing = this.directPeers.get(msg.from);
        if (existing && existing.transport === "direct" && existing.dc?.readyState === "open") {
          return;
        }
        await this.openRelayVirtualPeer(msg.from, msg.name || "Peer", msg.pk);
        break;
      }

      case "relay-close": {
        const existing = this.directPeers.get(msg.from);
        if (existing && existing.transport === "relay") {
          try {
            existing.dc.close(true);
          } catch {
            // ignore
          }
        }
        break;
      }

      default:
        break;
    }
  }

  async requestRelayFallback(targetPeerId, targetName, targetPubKey, reasonLabel = "direct ICE blocked") {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    const existing = this.directPeers.get(targetPeerId);
    if (existing && existing.dc && existing.dc.readyState === "open") {
      return;
    }
    if (this.relayPendingOpens.has(targetPeerId)) {
      return;
    }

    await this._ensureRoomMyTag();
    const known = await this._registerKnownRoomPeer(targetPeerId, targetName, targetPubKey);
    const name = targetName || known?.name || "Peer";
    const pk = targetPubKey || known?.pk || "";
    if (!pk) return;

    this.addTelemetry(
      "room",
      `Direct P2P to ${name} did not connect (${reasonLabel}) — switching to E2EE Relay fallback`
    );

    const sendOpen = () => {
      const cur = this.directPeers.get(targetPeerId);
      if (cur && cur.dc && cur.dc.readyState === "open") {
        const p = this.relayPendingOpens.get(targetPeerId);
        if (p?.retryTimer) clearTimeout(p.retryTimer);
        this.relayPendingOpens.delete(targetPeerId);
        return;
      }
      const status = this.roomRendezvous?.getStatus();
      this.sendRoomSignal({
        t: "relay-open",
        from: this.status.peerId,
        to: targetPeerId,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        relays: status?.connectedUrls || [],
        vcodec: this.getLocalVoiceCodec(),
      });
    };

    const pending = {
      startedAt: Date.now(),
      retryTimer: setTimeout(() => {
        if (this.relayPendingOpens.get(targetPeerId) !== pending) return;
        sendOpen();
        pending.retryTimer = setTimeout(() => {
          if (this.relayPendingOpens.get(targetPeerId) === pending) {
            this.relayPendingOpens.delete(targetPeerId);
          }
        }, 3500);
      }, 2000),
    };
    this.relayPendingOpens.set(targetPeerId, pending);
    sendOpen();
  }

  async openRelayVirtualPeer(peerId, peerName, peerPubKey) {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    const existing = this.directPeers.get(peerId);
    if (existing && existing.dc && existing.dc.readyState === "open") {
      // Never downgrade an already-open direct WebRTC channel, and avoid duplicate relay opens
      return;
    }

    const myTag = await this._ensureRoomMyTag();
    const peerInfo = await this._registerKnownRoomPeer(peerId, peerName, peerPubKey);
    if (!myTag || !peerInfo) return;

    const app = this;

    const virtualPc = {
      connectionState: "connected",
      iceConnectionState: "connected",
      onconnectionstatechange: null,
      oniceconnectionstatechange: null,
      close() {
        this.connectionState = "closed";
        this.iceConnectionState = "closed";
      },
    };

    let lastVoiceFlushMs = 0;

    // Medium-priority control & small chat relay queue (never waits behind large GIF/video bulk frames)
    const ctrlQueue = [];
    let ctrlPumpTimer = null;
    const pumpCtrlQueue = () => {
      if (ctrlPumpTimer) {
        clearTimeout(ctrlPumpTimer);
        ctrlPumpTimer = null;
      }
      if (virtualDc.readyState !== "open" || !app.roomRendezvous || !app.activeRoom) {
        ctrlQueue.length = 0;
        return;
      }
      const preferredUrls = peerInfo.relays && peerInfo.relays.length > 0 ? peerInfo.relays : null;
      const voiceBusy = app.isVoiceChannelBusy();
      let sentThisTick = 0;
      while (ctrlQueue.length > 0 && sentThisTick < 4) {
        const nextPkt = ctrlQueue[0];
        const sent = app.roomRendezvous.publishBinary(nextPkt, {
          preferredUrls,
          maxBrokers: voiceBusy ? 1 : 2,
          queueIfOffline: true,
          priority: "normal",
        });
        if (sent === 0 && ctrlQueue.length > 1) {
          ctrlPumpTimer = setTimeout(pumpCtrlQueue, 25);
          return;
        }
        ctrlQueue.shift();
        sentThisTick += 1;
      }
      if (ctrlQueue.length > 0) {
        ctrlPumpTimer = setTimeout(pumpCtrlQueue, 15);
      }
    };

    const virtualDc = {
      label: "p2p-mesh",
      transport: "relay",
      priority: "medium",
      readyState: "open",
      bufferedAmount: 0,
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null,
      send(frameStr) {
        if (this.readyState !== "open" || !app.roomRendezvous || !app.activeRoom) return;
        const msgId = (app.relayDataMsgSeq = (app.relayDataMsgSeq + 1) >>> 0) || 1;
        const chunks = encodeRelayDataChunks(
          myTag.bytes,
          peerInfo.tagBytes,
          msgId,
          String(frameStr),
          RELAY_DATA_CHUNK_SIZE
        );
        const voiceBusy = app.isVoiceChannelBusy();
        if (chunks.length <= 2 && ctrlQueue.length === 0) {
          const preferredUrls = peerInfo.relays && peerInfo.relays.length > 0 ? peerInfo.relays : null;
          for (const chunkPkt of chunks) {
            app.roomRendezvous.publishBinary(chunkPkt, {
              preferredUrls,
              maxBrokers: voiceBusy ? 1 : 2,
              queueIfOffline: true,
              priority: "normal",
            });
          }
          return;
        }
        for (const chunkPkt of chunks) {
          ctrlQueue.push(chunkPkt);
        }
        pumpCtrlQueue();
      },
      close(silentRemote = false) {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        ctrlQueue.length = 0;
        if (ctrlPumpTimer) {
          clearTimeout(ctrlPumpTimer);
          ctrlPumpTimer = null;
        }
        const entry = app.directPeers.get(peerId);
        const superseded = Boolean(entry && entry.dc === this && entry.superseded);
        if (!silentRemote && !superseded && app.activeRoom && app.roomRendezvous && app.status) {
          app.sendRoomSignal({
            t: "relay-close",
            from: app.status.peerId,
            to: peerId,
          });
        }
        if (typeof this.onclose === "function") {
          const cb = this.onclose;
          this.onclose = null;
          cb();
        }
      },
    };

    // Low-priority bulk relay queue for GIFs, images, videos & large frames (> 16 KB)
    // Yields to voice bundles, lazily slices 12-14 KB DF chunks on demand, and steers onto a secondary broker
    const bulkDfQueue = [];
    let bulkPumpTimer = null;
    let bulkQueuedBytes = 0;
    const pumpBulkDfQueue = () => {
      if (bulkPumpTimer) {
        clearTimeout(bulkPumpTimer);
        bulkPumpTimer = null;
      }
      if (virtualBulkDc.readyState !== "open" || !app.roomRendezvous || !app.activeRoom) {
        bulkDfQueue.length = 0;
        bulkQueuedBytes = 0;
        virtualBulkDc.bufferedAmount = 0;
        return;
      }
      const voiceBusy = app.isVoiceChannelBusy();
      // Always yield if a high-priority voice bundle was flushed within the last 15ms
      if (voiceBusy && Date.now() - lastVoiceFlushMs < 15) {
        bulkPumpTimer = setTimeout(pumpBulkDfQueue, 20);
        return;
      }
      const preferredUrls = peerInfo.relays && peerInfo.relays.length > 0 ? peerInfo.relays : null;
      const maxPerTick = voiceBusy ? 1 : 3;
      const tickMs = voiceBusy ? RELAY_BULK_TICK_VOICE_MS : RELAY_BULK_TICK_IDLE_MS;
      let sentThisTick = 0;
      while (bulkDfQueue.length > 0 && sentThisTick < maxPerTick) {
        const head = bulkDfQueue[0];
        // Reuse cached packet if previous tick backed off on socket water-mark
        const nextPkt =
          head.cachedPkt ||
          encodeSingleRelayDataChunk(
            myTag.bytes,
            peerInfo.tagBytes,
            head.msgId,
            head.payloadBytes,
            head.idx,
            head.total,
            head.chunkSize
          );
        const sent = app.roomRendezvous.publishBinary(nextPkt, {
          preferredUrls,
          maxBrokers: 1,
          queueIfOffline: false,
          priority: "low",
          avoidPrimaryVoiceBroker: voiceBusy,
        });
        if (sent === 0) {
          head.cachedPkt = nextPkt;
          // Secondary relay socket briefly above 8 KB cap — retry next tick without dropping chunks
          bulkPumpTimer = setTimeout(pumpBulkDfQueue, voiceBusy ? 45 : 30);
          return;
        }
        head.cachedPkt = null;
        head.idx += 1;
        if (head.idx >= head.total) {
          bulkDfQueue.shift();
        }
        bulkQueuedBytes = Math.max(0, bulkQueuedBytes - nextPkt.byteLength);
        virtualBulkDc.bufferedAmount = bulkQueuedBytes;
        app.recordTopologyPacket(peerId, "tx", "bulk", nextPkt.byteLength);
        sentThisTick += 1;
      }
      if (bulkDfQueue.length > 0) {
        bulkPumpTimer = setTimeout(pumpBulkDfQueue, tickMs);
      }
    };

    const virtualBulkDc = {
      label: "p2p-bulk",
      transport: "relay",
      priority: "very-low",
      readyState: "open",
      bufferedAmount: 0,
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null,
      send(frameStr) {
        if (this.readyState !== "open" || !app.roomRendezvous || !app.activeRoom) return;
        const msgId = (app.relayDataMsgSeq = (app.relayDataMsgSeq + 1) >>> 0) || 1;
        const chunkSize = app.isVoiceChannelBusy()
          ? RELAY_BULK_CHUNK_SIZE_VOICE
          : RELAY_DATA_CHUNK_SIZE;
        const payloadBytes = TEXT_ENCODER.encode(String(frameStr));
        const total = Math.max(1, Math.ceil(payloadBytes.length / chunkSize));
        bulkDfQueue.push({
          msgId,
          payloadBytes,
          chunkSize,
          idx: 0,
          total,
          cachedPkt: null,
        });
        bulkQueuedBytes += payloadBytes.length + total * 26;
        this.bufferedAmount = bulkQueuedBytes;
        pumpBulkDfQueue();
      },
      close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        bulkDfQueue.length = 0;
        bulkQueuedBytes = 0;
        this.bufferedAmount = 0;
        if (bulkPumpTimer) {
          clearTimeout(bulkPumpTimer);
          bulkPumpTimer = null;
        }
        if (typeof this.onclose === "function") {
          const cb = this.onclose;
          this.onclose = null;
          cb();
        }
      },
    };

    const voiceQueue = [];
    let voiceQueuedBytes = 0;
    let voiceFlushTimer = null;
    let peerVoiceBundleSeq = 0;
    const flushVoiceQueue = () => {
      if (voiceFlushTimer) {
        clearTimeout(voiceFlushTimer);
        voiceFlushTimer = null;
      }
      if (voiceQueue.length === 0 || !app.roomRendezvous || !app.activeRoom) {
        voiceQueue.length = 0;
        voiceQueuedBytes = 0;
        virtualVoiceDc.bufferedAmount = 0;
        return;
      }
      const batch = voiceQueue.splice(0, VOICE_RELAY_MAX_FRAMES);
      for (const pkt of batch) {
        voiceQueuedBytes = Math.max(0, voiceQueuedBytes - pkt.byteLength);
      }
      virtualVoiceDc.bufferedAmount = voiceQueuedBytes;
      peerVoiceBundleSeq = ((peerVoiceBundleSeq + 1) >>> 0) || 1;
      const bundle = encodeRelayVoiceBundle(myTag.bytes, peerInfo.tagBytes, peerVoiceBundleSeq, batch);
      const preferredUrls = peerInfo.relays && peerInfo.relays.length > 0 ? peerInfo.relays : null;
      lastVoiceFlushMs = Date.now();
      app.noteVoiceTraffic();
      app.roomRendezvous.publishBinary(bundle, {
        preferredUrls,
        maxBrokers: 1,
        queueIfOffline: false,
        stripe: true,
        priority: "high",
      });
      if (voiceQueue.length > 0) {
        voiceFlushTimer = setTimeout(flushVoiceQueue, VOICE_RELAY_BATCH_MS + 15);
      }
    };

    const virtualVoiceDc = {
      label: "p2p-voice",
      transport: "relay",
      priority: "high",
      binaryType: "arraybuffer",
      readyState: "open",
      bufferedAmount: 0,
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null,
      send(packetBytes) {
        if (this.readyState !== "open" || !packetBytes) return;
        const copy =
          packetBytes instanceof Uint8Array
            ? packetBytes.slice()
            : new Uint8Array(packetBytes).slice();
        voiceQueue.push(copy);
        voiceQueuedBytes += copy.byteLength;
        this.bufferedAmount = voiceQueuedBytes;
        if (voiceQueue.length >= VOICE_RELAY_MAX_FRAMES) {
          flushVoiceQueue();
        } else if (!voiceFlushTimer) {
          voiceFlushTimer = setTimeout(flushVoiceQueue, VOICE_RELAY_BATCH_MS + 15);
        }
      },
      close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        voiceQueue.length = 0;
        voiceQueuedBytes = 0;
        this.bufferedAmount = 0;
        if (voiceFlushTimer) {
          clearTimeout(voiceFlushTimer);
          voiceFlushTimer = null;
        }
        if (typeof this.onclose === "function") {
          const cb = this.onclose;
          this.onclose = null;
          cb();
        }
      },
    };

    this.attachVoiceDataChannel(peerId, virtualVoiceDc);
    this.attachBulkDataChannel(peerId, virtualBulkDc);
    this.attachDataChannel(
      virtualPc,
      virtualDc,
      peerId,
      peerInfo.name || peerName || "Peer",
      peerInfo.pk || peerPubKey,
      false,
      null,
      false
    );

    const earlyFrames = this.earlyRelayDataFrames.get(peerInfo.tagHex);
    if (earlyFrames && earlyFrames.length > 0) {
      this.earlyRelayDataFrames.delete(peerInfo.tagHex);
      for (const item of earlyFrames) {
        if (virtualDc.readyState === "open" && typeof virtualDc.onmessage === "function") {
          virtualDc.onmessage({ data: item.frame });
        }
      }
    }

    this.directUpgradeState.set(peerId, { connectedAt: Date.now(), lastAttemptAt: 0, attempts: 0 });
    this.addTelemetry(
      "room",
      `Connected to ${peerInfo.name} via E2EE Relay fallback (zero TURN; will auto-upgrade if Direct P2P opens)`
    );
  }

  _clearRelayVoiceReorder() {
    for (const st of this.relayVoiceReorder.values()) {
      if (st.flushTimer) {
        clearTimeout(st.flushTimer);
        st.flushTimer = null;
      }
      st.pending.clear();
    }
    this.relayVoiceReorder.clear();
  }

  _clearRelayVoiceReorderForPeer(peerId) {
    const known = this.roomKnownPeers.get(peerId);
    if (!known?.tagHex) return;
    const st = this.relayVoiceReorder.get(known.tagHex);
    if (st) {
      if (st.flushTimer) {
        clearTimeout(st.flushTimer);
        st.flushTimer = null;
      }
      st.pending.clear();
      this.relayVoiceReorder.delete(known.tagHex);
    }
  }

  _enqueueOrderedRelayVoiceBundle(fromHex, senderPeerId, seq, frames) {
    let st = this.relayVoiceReorder.get(fromHex);
    if (!st) {
      st = {
        expectedSeq: null,
        pending: new Map(),
        seen: new Set(),
        flushTimer: null,
        reorderedCount: 0,
        skippedCount: 0,
        lateDropCount: 0,
      };
      this.relayVoiceReorder.set(fromHex, st);
    }

    if (st.seen.has(seq)) return;
    st.seen.add(seq);
    if (st.seen.size > 64) {
      const oldest = st.seen.values().next().value;
      if (oldest !== undefined) {
        st.seen.delete(oldest);
      }
    }

    const nextSeq = (s) => ((s + 1) >>> 0) || 1;
    const deliver = (bundleFrames) => {
      for (const frameBytes of bundleFrames) {
        this.handleIncomingVoicePacket(senderPeerId, frameBytes);
      }
    };
    const drain = () => {
      while (st.expectedSeq !== null && st.pending.has(st.expectedSeq)) {
        const item = st.pending.get(st.expectedSeq);
        st.pending.delete(st.expectedSeq);
        st.expectedSeq = nextSeq(st.expectedSeq);
        deliver(item.frames);
      }
      if (st.pending.size === 0 && st.flushTimer) {
        clearTimeout(st.flushTimer);
        st.flushTimer = null;
      }
    };
    const flushLowestPending = () => {
      if (st.flushTimer) {
        clearTimeout(st.flushTimer);
        st.flushTimer = null;
      }
      if (this.relayVoiceReorder.get(fromHex) !== st || !this.voice.inVoice) {
        st.pending.clear();
        return;
      }
      if (st.pending.size === 0) return;
      let lowest = null;
      for (const k of st.pending.keys()) {
        if (lowest === null || ((k - lowest) | 0) < 0) {
          lowest = k;
        }
      }
      if (lowest !== null) {
        if (st.expectedSeq !== null) {
          const gap = (lowest - st.expectedSeq) | 0;
          if (gap > 0) {
            st.skippedCount += gap;
          }
        }
        st.expectedSeq = lowest;
        drain();
        if (st.pending.size > 0) {
          st.flushTimer = setTimeout(flushLowestPending, 60);
        }
      }
    };

    if (st.expectedSeq === null || Math.abs((seq - st.expectedSeq) | 0) > 16) {
      if (st.flushTimer) {
        clearTimeout(st.flushTimer);
        st.flushTimer = null;
      }
      st.pending.clear();
      st.expectedSeq = nextSeq(seq);
      deliver(frames);
      return;
    }

    const diff = (seq - st.expectedSeq) | 0;
    if (diff === 0) {
      st.expectedSeq = nextSeq(seq);
      deliver(frames);
      drain();
      return;
    }
    if (diff < 0) {
      // Stale late bundle already skipped after timeout; drop cleanly to avoid out-of-order glitches
      st.lateDropCount += 1;
      return;
    }

    st.reorderedCount += 1;
    st.pending.set(seq, {
      frames: frames.map((f) => f.slice()),
      receivedAt: Date.now(),
    });
    if (st.pending.size >= 6) {
      flushLowestPending();
    } else if (!st.flushTimer) {
      st.flushTimer = setTimeout(flushLowestPending, 60);
    }
  }

  handleIncomingRelayBinary(bytes, brokerUrl) {
    if (!this.activeRoom || !this.roomMyTag || !bytes || bytes.length < 2) return;
    const myTagBytes = this.roomMyTag.bytes;

    if (bytes[0] === 0x44 && bytes[1] === 0x46) {
      // "DF" E2EE Data Frame / Chunk (filters non-matching & echo packets in 8 byte compares before hex alloc)
      const decoded = decodeRelayDataChunk(bytes, myTagBytes, myTagBytes);
      if (!decoded) return;

      const dedupeKey = `${decoded.fromHex}:${decoded.msgId}:${decoded.idx}`;
      if (this.seenRelayChunkKeys.has(dedupeKey)) return;
      this.seenRelayChunkKeys.set(dedupeKey, Date.now());

      const senderPeerId = this.roomTagToPeerId.get(decoded.fromHex);
      if (senderPeerId && brokerUrl) {
        const known = this.roomKnownPeers.get(senderPeerId);
        if (known && !known.relays.includes(brokerUrl)) {
          known.relays.unshift(brokerUrl);
        }
      }

      let fullFrameStr = null;
      if (decoded.total === 1) {
        fullFrameStr = TEXT_DECODER.decode(decoded.chunkBytes);
      } else {
        const asmKey = `${decoded.fromHex}:${decoded.msgId}`;
        let asm = this.relayChunkAssemblies.get(asmKey);
        if (!asm) {
          asm = {
            total: decoded.total,
            parts: new Array(decoded.total),
            received: 0,
            ts: Date.now(),
          };
          this.relayChunkAssemblies.set(asmKey, asm);
        }
        if (!asm.parts[decoded.idx]) {
          asm.parts[decoded.idx] = decoded.chunkBytes.slice();
          asm.received += 1;
          asm.ts = Date.now();
        }
        if (asm.received === asm.total) {
          this.relayChunkAssemblies.delete(asmKey);
          let totalBytes = 0;
          for (const part of asm.parts) {
            totalBytes += part.length;
          }
          const merged = new Uint8Array(totalBytes);
          let offset = 0;
          for (const part of asm.parts) {
            merged.set(part, offset);
            offset += part.length;
          }
          fullFrameStr = TEXT_DECODER.decode(merged);
        }
      }

      if (fullFrameStr === null) return;

      if (!senderPeerId) {
        const early = this.earlyRelayDataFrames.get(decoded.fromHex) || [];
        if (early.length < 12) {
          early.push({ frame: fullFrameStr, ts: Date.now() });
          this.earlyRelayDataFrames.set(decoded.fromHex, early);
        }
        return;
      }

      const peerEntry = this.directPeers.get(senderPeerId);
      if (!peerEntry) {
        const early = this.earlyRelayDataFrames.get(decoded.fromHex) || [];
        if (early.length < 12) {
          early.push({ frame: fullFrameStr, ts: Date.now() });
          this.earlyRelayDataFrames.set(decoded.fromHex, early);
        }
        return;
      }

      // Accept even during the brief relay->direct handoff window so zero frames drop
      if (peerEntry.transport === "relay" && typeof peerEntry.dc?.onmessage === "function") {
        peerEntry.dc.onmessage({ data: fullFrameStr });
      } else {
        peerEntry.lastActivityMs = Date.now();
        this._deliverWireFrameSmart(peerEntry, senderPeerId, fullFrameStr, true);
      }
      return;
    }

    if (bytes[0] === 0x56 && bytes[1] === 0x42) {
      // "VB" E2EE Voice Bundle (striped across multiple low-RTT brokers; reordered & deduped per peer)
      if (!this.voice.inVoice) return;
      const bundle = decodeRelayVoiceBundle(bytes, myTagBytes, myTagBytes);
      if (!bundle) return;

      const senderPeerId = this.roomTagToPeerId.get(bundle.fromHex);
      if (!senderPeerId) return;
      const peerEntry = this.directPeers.get(senderPeerId);
      if (!peerEntry) return;

      if (brokerUrl) {
        const known = this.roomKnownPeers.get(senderPeerId);
        if (known && !known.relays.includes(brokerUrl)) {
          known.relays.push(brokerUrl);
        }
      }

      this._enqueueOrderedRelayVoiceBundle(bundle.fromHex, senderPeerId, bundle.seq, bundle.frames);
    }
  }

  _waitForInitialIce(pc, entry, maxWaitMs = 900) {
    if (pc.iceGatheringState === "complete") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let graceTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (graceTimer) clearTimeout(graceTimer);
        pc.removeEventListener("icegatheringstatechange", onState);
        entry.onInitialCandidate = null;
        resolve();
      };
      const onState = () => {
        if (pc.iceGatheringState === "complete") {
          finish();
        }
      };
      entry.onInitialCandidate = () => {
        // Ship SDP promptly once we have srflx or direct IPv4/IPv6 host candidates
        if (
          entry.gatheredTypes.has("srflx") ||
          entry.gatheredTypes.has("host(ipv4)") ||
          entry.gatheredTypes.has("host(ipv6)")
        ) {
          if (!graceTimer) graceTimer = setTimeout(finish, 220);
        }
      };
      pc.addEventListener("icegatheringstatechange", onState);
      const hardTimer = setTimeout(finish, maxWaitMs);
    });
  }

  _createBatchedIceSender(targetPeerId, entry) {
    const flush = () => {
      if (entry.trickleTimer) {
        clearTimeout(entry.trickleTimer);
        entry.trickleTimer = null;
      }
      if (!entry.trickleBuffer || entry.trickleBuffer.length === 0) return;
      const batch = entry.trickleBuffer.splice(0, entry.trickleBuffer.length);
      this.sendRoomSignal({
        t: "ice-batch",
        from: this.status.peerId,
        to: targetPeerId,
        cands: batch,
      });
    };
    entry.flushTrickle = flush;
    return (candJson) => {
      if (!candJson) {
        flush();
        return;
      }
      entry.trickleBuffer.push(candJson);
      if (entry.trickleBuffer.length >= 6) {
        flush();
      } else if (!entry.trickleTimer) {
        entry.trickleTimer = setTimeout(flush, 180);
      }
    };
  }

  _cleanupRoomDialingEntry(peerId, entry, reason) {
    if (entry.trickleTimer) {
      clearTimeout(entry.trickleTimer);
      entry.trickleTimer = null;
    }
    if (entry.fallbackTimer) {
      clearTimeout(entry.fallbackTimer);
      entry.fallbackTimer = null;
    }
    if (entry.hardTimer) {
      clearTimeout(entry.hardTimer);
      entry.hardTimer = null;
    }
    if (this.roomDialing.get(peerId) === entry) {
      this.roomDialing.delete(peerId);
    }
    try {
      entry.pc.close();
    } catch {
      // ignore
    }
    if (reason && !entry.isUpgradeProbe) {
      const types = Array.from(entry.gatheredTypes || []).join(",") || "none";
      this.addTelemetry("room", `Direct WebRTC ${reason} for ${peerId} (ICE: ${types})`);
    }
  }

  async startRoomOffer(targetPeerId, targetName, targetPubKey, isUpgradeProbe = false) {
    if (this.roomDialing.has(targetPeerId) || this.localDialing.has(targetPeerId)) return;
    let entry = null;
    try {
      const pc = this.createPeerConnection();
      const { dc, voiceDc, bulkDc } = this.createPeerDataChannels(pc);
      const early = this.earlyRoomIce.get(targetPeerId) || [];
      this.earlyRoomIce.delete(targetPeerId);

      entry = {
        pc,
        dc,
        voiceDc,
        bulkDc,
        targetName,
        targetPubKey,
        isUpgradeProbe: Boolean(isUpgradeProbe),
        remoteDescSet: false,
        sdpSent: false,
        gatheredTypes: new Set(),
        trickleBuffer: [],
        trickleTimer: null,
        fallbackTimer: null,
        hardTimer: null,
        flushTrickle: null,
        onInitialCandidate: null,
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.roomDialing.set(targetPeerId, entry);
      this.attachVoiceDataChannel(targetPeerId, voiceDc);
      this.attachBulkDataChannel(targetPeerId, bulkDc);
      this.attachDataChannel(pc, dc, targetPeerId, targetName, targetPubKey, false, null, true);

      const enqueueTrickle = this._createBatchedIceSender(targetPeerId, entry);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          if (entry.sdpSent) enqueueTrickle(null);
          return;
        }
        const candJson = ev.candidate.toJSON();
        entry.gatheredTypes.add(classifyIceCandidateType(candJson.candidate));
        if (!entry.sdpSent) {
          if (entry.onInitialCandidate) entry.onInitialCandidate();
          return;
        }
        enqueueTrickle(candJson);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitForInitialIce(pc, entry, 900);

      if (this.roomDialing.get(targetPeerId) !== entry) return;
      const fullSdp = pc.localDescription?.sdp || offer.sdp;
      const status = this.roomRendezvous?.getStatus();

      this.sendRoomSignal({
        t: "offer",
        from: this.status.peerId,
        to: targetPeerId,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        relays: status?.connectedUrls || [],
        vcodec: this.getLocalVoiceCodec(),
        sdp: fullSdp,
      });

      entry.sdpSent = true;
      const gatheredList = Array.from(entry.gatheredTypes).join(",") || "none";
      if (!entry.isUpgradeProbe) {
        this.addTelemetry(
          "room",
          `Dialing ${targetName} (${targetPeerId}) — direct ICE [${gatheredList}]`
        );
        // If direct P2P doesn't open quickly (e.g. mobile CGNAT / isolated WiFi),
        // activate zero-TURN E2EE Relay fallback while keeping direct ICE checking in background
        entry.fallbackTimer = setTimeout(() => {
          if (this.roomDialing.get(targetPeerId) !== entry) return;
          const cur = this.directPeers.get(targetPeerId);
          if (cur && cur.transport === "direct" && cur.dc?.readyState === "open") return;
          this.requestRelayFallback(targetPeerId, targetName, targetPubKey, "direct ICE timeout");
        }, DIRECT_FALLBACK_TIMEOUT_MS);
      }

      entry.hardTimer = setTimeout(() => {
        if (this.roomDialing.get(targetPeerId) !== entry) return;
        this._cleanupRoomDialingEntry(targetPeerId, entry, null);
      }, DIRECT_HARD_TIMEOUT_MS);
    } catch (err) {
      if (entry) {
        this._cleanupRoomDialingEntry(targetPeerId, entry, err?.message || "offer failed");
        if (!entry.isUpgradeProbe) {
          this.requestRelayFallback(targetPeerId, targetName, targetPubKey, "offer error");
        }
      } else {
        this.roomDialing.delete(targetPeerId);
      }
    }
  }

  async acceptRoomOffer(msg) {
    if (!msg.from || !msg.sdp || !msg.pk) return;
    const prev = this.roomDialing.get(msg.from);
    if (prev) {
      this._cleanupRoomDialingEntry(msg.from, prev, null);
    }
    const existingRelay =
      this.directPeers.get(msg.from)?.transport === "relay" &&
      this.directPeers.get(msg.from)?.dc?.readyState === "open";
    let entry = null;
    try {
      const pc = this.createPeerConnection();
      const early = this.earlyRoomIce.get(msg.from) || [];
      this.earlyRoomIce.delete(msg.from);

      entry = {
        pc,
        dc: null,
        targetName: msg.name || "Peer",
        targetPubKey: msg.pk,
        isUpgradeProbe: Boolean(existingRelay),
        remoteDescSet: false,
        sdpSent: false,
        gatheredTypes: new Set(),
        trickleBuffer: [],
        trickleTimer: null,
        fallbackTimer: null,
        hardTimer: null,
        flushTrickle: null,
        onInitialCandidate: null,
        pendingIce: early,
        startedAt: Date.now(),
      };
      this.roomDialing.set(msg.from, entry);

      // Monitor pre-datachannel ICE failure immediately on the answerer side too
      const monitorAnswerIce = () => {
        if (this.roomDialing.get(msg.from) !== entry) return;
        const ics = pc.iceConnectionState;
        const cs = pc.connectionState;
        if (ics === "failed" || cs === "failed" || cs === "closed") {
          this._cleanupRoomDialingEntry(msg.from, entry, `answer ICE ${ics}/${cs}`);
          if (!entry.isUpgradeProbe) {
            this.requestRelayFallback(msg.from, msg.name || "Peer", msg.pk, `answer ICE ${ics}`);
          }
        }
      };
      pc.oniceconnectionstatechange = monitorAnswerIce;
      pc.onconnectionstatechange = monitorAnswerIce;

      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "p2p-voice") {
          this.attachVoiceDataChannel(msg.from, ev.channel);
          return;
        }
        if (ev.channel.label === "p2p-bulk") {
          this.attachBulkDataChannel(msg.from, ev.channel);
          return;
        }
        entry.dc = ev.channel;
        this.attachDataChannel(
          pc,
          ev.channel,
          msg.from,
          msg.name || "Peer",
          msg.pk,
          false,
          null,
          true
        );
      };

      const enqueueTrickle = this._createBatchedIceSender(msg.from, entry);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          if (entry.sdpSent) enqueueTrickle(null);
          return;
        }
        const candJson = ev.candidate.toJSON();
        entry.gatheredTypes.add(classifyIceCandidateType(candJson.candidate));
        if (!entry.sdpSent) {
          if (entry.onInitialCandidate) entry.onInitialCandidate();
          return;
        }
        enqueueTrickle(candJson);
      };

      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      entry.remoteDescSet = true;
      await this.flushPendingIce(entry);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this._waitForInitialIce(pc, entry, 900);

      if (this.roomDialing.get(msg.from) !== entry) return;
      const fullSdp = pc.localDescription?.sdp || answer.sdp;
      const status = this.roomRendezvous?.getStatus();

      this.sendRoomSignal({
        t: "answer",
        from: this.status.peerId,
        to: msg.from,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        relays: status?.connectedUrls || [],
        vcodec: this.getLocalVoiceCodec(),
        sdp: fullSdp,
      });

      entry.sdpSent = true;
      const gatheredList = Array.from(entry.gatheredTypes).join(",") || "none";
      if (!entry.isUpgradeProbe) {
        this.addTelemetry(
          "room",
          `Answered ${msg.name || msg.from} — direct ICE [${gatheredList}]`
        );
        entry.fallbackTimer = setTimeout(() => {
          if (this.roomDialing.get(msg.from) !== entry) return;
          const cur = this.directPeers.get(msg.from);
          if (cur && cur.dc?.readyState === "open") return;
          this.requestRelayFallback(msg.from, msg.name || "Peer", msg.pk, "answer ICE timeout");
        }, ANSWER_FALLBACK_TIMEOUT_MS);
      }

      entry.hardTimer = setTimeout(() => {
        if (this.roomDialing.get(msg.from) !== entry) return;
        this._cleanupRoomDialingEntry(msg.from, entry, null);
      }, DIRECT_HARD_TIMEOUT_MS);
    } catch (err) {
      if (entry) {
        this._cleanupRoomDialingEntry(msg.from, entry, err?.message || "answer failed");
        if (!entry.isUpgradeProbe) {
          this.requestRelayFallback(msg.from, msg.name || "Peer", msg.pk, "answer error");
        }
      } else {
        this.roomDialing.delete(msg.from);
      }
    }
  }

  async applyRoomAnswer(msg) {
    const entry = this.roomDialing.get(msg.from);
    if (!entry || !msg.sdp) return;
    if (msg.from && msg.relays) {
      await this._registerKnownRoomPeer(msg.from, msg.name, msg.pk, msg.relays);
    }
    try {
      if (entry.pc.signalingState === "have-local-offer") {
        await entry.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        entry.remoteDescSet = true;
        await this.flushPendingIce(entry);
      }
    } catch (err) {
      this.addTelemetry("error", `Room answer apply failed for ${msg.from}: ${err?.message || err}`);
    }
  }

  async applyRoomIce(fromPeerId, candidate) {
    if (!fromPeerId || !candidate) return;
    const entry = this.roomDialing.get(fromPeerId);
    if (!entry) {
      const direct = this.directPeers.get(fromPeerId);
      if (direct && direct.pc && typeof direct.pc.addIceCandidate === "function") {
        try {
          await direct.pc.addIceCandidate(candidate);
        } catch {
          // ignore late ICE
        }
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
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // ignore benign ICE errors
    }
  }

  /* ================= URL Fragments & Guided Signal Handling ================= */

  async handleUrlHashFragment() {
    const hash = window.location.hash;
    if (!hash || hash.length < 4) return;
    try {
      const frag = this.wasm.call({ cmd: "extract_fragment", hash });
      if (!frag.found) return;

      if (frag.kind === "room") {
        await this.joinLongLivedRoomLink(frag.code);
        return;
      }

      try {
        history.replaceState(null, "", basePageUrl());
      } catch {
        // ignore restricted history API
      }

      if (frag.kind === "offer") {
        if (!this.advancedMode) {
          this.setAdvancedMode(true);
        }
        this.setAdvPanelOpen("connect", true);
        this.openJoinWizard();
        await this.acceptManualOffer(frag.code);
      } else if (frag.kind === "answer") {
        if (!this.advancedMode) {
          this.setAdvancedMode(true);
        }
        this.setAdvPanelOpen("connect", true);
        await this.handleIncomingAnswerUrlOrCode(frag.code, /* fromHash = */ true);
      }
    } catch (err) {
      this.addTelemetry("error", `Fragment parse failed: ${err.message}`);
    }
  }

  async handleHostAnswerSubmit(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice("connect-notice", "warn", "Paste your peer's #answer= reply link or P2P1: reply code first.");
      return;
    }
    let decoded;
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
    } catch (err) {
      this.handleDecodeFailure(err, trimmed);
      return;
    }

    if (decoded.signal.kind === "room") {
      this.resetWizard();
      await this.joinLongLivedRoomLink(trimmed);
      return;
    }

    if (decoded.signal.kind === "offer") {
      this.showNotice(
        "connect-notice",
        "warn",
        "That looks like an Invite (#offer=), not a Reply. Switching to 'Join with Invite' to accept it…"
      );
      this.openJoinWizard();
      await this.acceptManualOffer(trimmed);
      return;
    }
    await this.completeManualOffer(trimmed);
  }

  async handleJoinOfferSubmit(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice("connect-notice", "warn", "Paste a room link, #offer= link, or P2P1: code first.");
      return;
    }
    let decoded;
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
    } catch (err) {
      this.handleDecodeFailure(err, trimmed);
      return;
    }

    if (decoded.signal.kind === "room") {
      this.resetWizard();
      await this.joinLongLivedRoomLink(trimmed);
      return;
    }

    if (decoded.signal.kind === "answer") {
      await this.handleIncomingAnswerUrlOrCode(trimmed, false);
      return;
    }
    await this.acceptManualOffer(trimmed);
  }

  async handleIncomingAnswerUrlOrCode(trimmed, fromHash) {
    let sig;
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
      sig = decoded.signal;
    } catch (err) {
      this.handleDecodeFailure(err);
      return;
    }

    const hasLocalPending =
      (sig.inviteId && this.pendingOffers.has(sig.inviteId)) ||
      this.pendingOffers.size === 1 ||
      (this.latestOffer && this.pendingOffers.has(this.latestOffer.inviteId));

    if (hasLocalPending) {
      this.wizard.mode = "host";
      this.wizard.hostCopied = true;
      this.wizard.step = 2;
      this.renderWizard();
      await this.completeManualOffer(trimmed);
    } else if (this.bc) {
      this.postBroadcast({
        type: "deliver-answer",
        inviteId: sig.inviteId || "",
        code: trimmed,
        fromPeerId: this.status.peerId,
      });
      this.showNotice(
        "connect-notice",
        "info",
        fromHash
          ? "Forwarding reply link to your original inviter tab…"
          : "That's a Reply (#answer=) for another tab — forwarded it to open tabs in this browser."
      );
    } else {
      this.showNotice(
        "connect-notice",
        "warn",
        "That's a Reply (#answer=). Paste it into Step 2 of the tab that created the invite."
      );
    }
  }

  handleDecodeFailure(err, rawInput = "") {
    const msg = err?.message || "Invalid P2P1 signal code";
    if (msg.toLowerCase().includes("passphrase")) {
      if (rawInput && (rawInput.includes("#room=") || rawInput.includes("#join="))) {
        this.pendingRoomCode = rawInput;
      }
      this.el["e2ee-key-details"].open = true;
      this.el["e2ee-passphrase-input"].focus();
    }
    this.showNotice("connect-notice", "error", msg);
  }

  /* ================= Manual Out-of-Band E2EE P2P1 Handshake ================= */

  async createManualInvite(isRejoin = false) {
    this.el["btn-wizard-start-host"].disabled = true;
    this.latestOffer = null;
    this.wizard = {
      mode: "host",
      step: 1,
      hostCopied: false,
      joinCopied: false,
      peerName: "",
      offerMeta: "preparing…",
      answerMeta: "",
      offerHint: "Preparing direct invite link…",
      answerHint: "",
    };
    this.el["host-offer-code"].value = "";
    this.el["host-answer-input"].value = "";
    this.el["connect-notice"].classList.add("hidden");
    this.renderWizard();
    this.renderConnectBanners();

    try {
      const inviteId = randomId("inv");
      const pc = this.createPeerConnection();
      const { dc, voiceDc, bulkDc } = this.createPeerDataChannels(pc);
      const pending = { inviteId, pc, dc, voiceDc, bulkDc, code: "", url: "" };
      this.pendingOffers.set(inviteId, pending);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, 1400);

      const encoded = this.wasm.call({
        cmd: "encode_signal",
        kind: "offer",
        inviteId,
        sdp: pc.localDescription.sdp,
        baseUrl: basePageUrl(),
        entropy: randomBase64Url(16),
      });

      pending.code = encoded.code;
      pending.url = encoded.url;
      this.latestOffer = pending;

      this.wizard.offerMeta = `${encoded.rawBytes}B → ${encoded.codeChars} chars${encoded.encrypted ? " · AEAD" : ""}`;
      this.wizard.offerHint = encoded.encrypted
        ? "Passphrase-encrypted invite ready. Copy and send it to your peer."
        : isRejoin
          ? `Send this rejoin invite to any surviving peer in your mesh (FP ${this.status.e2ee.keyFingerprint}).`
          : `Copy and send this invite link to your peer (FP ${this.status.e2ee.keyFingerprint}).`;
      this.el["host-offer-code"].value = encoded.code;
      this.renderWizard();
      this.addTelemetry(
        "signal",
        `Generated ${isRejoin ? "rejoin " : ""}${encoded.encrypted ? "passphrase-encrypted " : ""}P2P1 offer ${inviteId} (${encoded.codeChars} chars)`
      );
    } catch (err) {
      this.showNotice("connect-notice", "error", `Failed to create invite: ${err.message}`);
    } finally {
      this.el["btn-wizard-start-host"].disabled = false;
    }
  }

  async acceptManualOffer(rawInput, silentUi = false) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      if (!silentUi) {
        this.showNotice("connect-notice", "warn", "Paste a P2P1: invite code or #offer= link first.");
      }
      return null;
    }
    this.el["btn-join-create-reply"].disabled = true;
    this.latestAnswer = null;
    if (!silentUi) {
      this.showNotice("connect-notice", "info", "Decoding invite and preparing reply link…");
    }
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
      const sig = decoded.signal;
      if (sig.kind !== "offer") {
        throw new Error(`Expected an offer code, got '${sig.kind}'`);
      }
      if (sig.peerId === this.status.peerId) {
        throw new Error("Cannot connect a node to itself (open a second tab or device).");
      }

      if (sig.meshKey && !sig.encrypted && sig.meshKey !== this.profile.meshKey) {
        const keyRes = this.wasm.call({
          cmd: "set_mesh_key",
          meshKey: sig.meshKey,
          passphraseMode: false,
          entropy: randomBase64Url(16),
        });
        this.status = keyRes.status;
        this.profile.meshKey = sig.meshKey;
        this.profile.passphraseMode = false;
        this.renderHeader();
        this.addTelemetry(
          "e2ee",
          `Adopted inviter E2EE mesh key (FP ${this.status.e2ee.keyFingerprint})`
        );
      } else if (sig.encrypted && passInput && !this.status.e2ee.passphraseMode) {
        const passRes = this.wasm.call({
          cmd: "set_passphrase",
          passphrase: passInput,
          entropy: randomBase64Url(16),
        });
        this.status = passRes.status;
        this.profile.meshKey = passRes.meshKey;
        this.profile.passphraseMode = true;
        this.renderHeader();
      }

      const pc = this.createPeerConnection();
      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "p2p-voice") {
          this.attachVoiceDataChannel(sig.peerId, ev.channel);
          return;
        }
        if (ev.channel.label === "p2p-bulk") {
          this.attachBulkDataChannel(sig.peerId, ev.channel);
          return;
        }
        this.attachDataChannel(
          pc,
          ev.channel,
          sig.peerId,
          sig.authorName,
          sig.pubKey,
          false,
          null,
          true
        );
      };

      await pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc, 1400);

      const encoded = this.wasm.call({
        cmd: "encode_signal",
        kind: "answer",
        inviteId: sig.inviteId || "",
        sdp: pc.localDescription.sdp,
        baseUrl: basePageUrl(),
        entropy: randomBase64Url(16),
      });

      const result = {
        code: encoded.code,
        url: encoded.url,
        peerId: sig.peerId,
        peerName: sig.authorName,
        inviteId: sig.inviteId || "",
      };
      this.pendingAnswers.set(sig.peerId, { pc, ...result });
      this.latestAnswer = result;

      if (!silentUi) {
        this.wizard.mode = "join";
        this.wizard.step = 2;
        this.wizard.joinCopied = false;
        this.wizard.peerName = sig.authorName || sig.peerId;
        this.wizard.answerMeta = `${encoded.rawBytes}B → ${encoded.codeChars} chars${encoded.encrypted ? " · AEAD" : ""}`;
        this.wizard.answerHint = `Copy and send this reply link back to ${sig.authorName}. As soon as they paste or click it, you'll connect automatically.`;
        this.el["join-answer-code"].value = encoded.code;
        this.el["join-offer-input"].value = "";
        this.el["connect-notice"].classList.add("hidden");
        this.renderWizard();
        this.renderConnectBanners();
      }
      this.addTelemetry("signal", `Created E2EE P2P1 reply for ${sig.authorName} (${sig.peerId})`);
      return result;
    } catch (err) {
      if (!silentUi) {
        this.handleDecodeFailure(err);
      }
      return null;
    } finally {
      this.el["btn-join-create-reply"].disabled = false;
    }
  }

  async completeManualOffer(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) {
      this.showNotice("connect-notice", "warn", "Paste the peer's P2P1: reply code or #answer= link first.");
      return false;
    }
    this.el["btn-host-apply-answer"].disabled = true;
    try {
      const passInput = this.el["e2ee-passphrase-input"].value;
      const decoded = this.wasm.call({
        cmd: "decode_signal",
        input: trimmed,
        passphrase: passInput || undefined,
      });
      const sig = decoded.signal;
      if (sig.kind !== "answer") {
        throw new Error(`Expected an answer code, got '${sig.kind}'`);
      }

      let pending = sig.inviteId ? this.pendingOffers.get(sig.inviteId) : null;
      if (!pending && this.pendingOffers.size === 1) {
        pending = this.pendingOffers.values().next().value;
      }
      if (!pending && this.latestOffer && this.pendingOffers.has(this.latestOffer.inviteId)) {
        pending = this.latestOffer;
      }
      if (!pending) {
        throw new Error("No matching pending invite found. Click 'Invite a Peer' first.");
      }

      this.pendingOffers.delete(pending.inviteId);
      if (this.latestOffer && this.latestOffer.inviteId === pending.inviteId) {
        this.latestOffer = null;
      }

      if (pending.voiceDc) {
        this.attachVoiceDataChannel(sig.peerId, pending.voiceDc);
      }
      if (pending.bulkDc) {
        this.attachBulkDataChannel(sig.peerId, pending.bulkDc);
      }
      this.attachDataChannel(
        pending.pc,
        pending.dc,
        sig.peerId,
        sig.authorName,
        sig.pubKey,
        false,
        null,
        true
      );
      await pending.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });

      this.el["host-answer-input"].value = "";
      this.showNotice(
        "connect-notice",
        "info",
        `Connecting directly to ${sig.authorName}…`
      );
      this.addTelemetry("signal", `Applied P2P1 answer from ${sig.authorName} (${sig.peerId})`);
      return true;
    } catch (err) {
      this.handleDecodeFailure(err);
      return false;
    } finally {
      this.el["btn-host-apply-answer"].disabled = false;
    }
  }

  /* ================= Personal Audio Settings & DSP Pipeline ================= */

  toggleAudioSettingsDrawer(forceOpen) {
    const next = typeof forceOpen === "boolean" ? forceOpen : !this.voice.settingsOpen;
    this.voice.settingsOpen = next;
    if (this.el["voice-settings-drawer"]) {
      this.el["voice-settings-drawer"].classList.toggle("hidden", !next);
    }
    if (this.el["btn-voice-settings"]) {
      this.el["btn-voice-settings"].setAttribute("aria-expanded", next ? "true" : "false");
    }
    if (next) {
      this.syncAudioSettingsUI();
      if (!this.voice.inVoice && !this.voice.preCallMonitor) {
        this.updateAudioMeterUi(0, false, "Idle");
      }
      this.refreshAudioInputDevices();
    } else if (!this.voice.inVoice && this.voice.monitorActive) {
      this.stopPreCallMicMonitor();
    }
  }

  detectMatchingAudioPreset(settings) {
    for (const [name, p] of Object.entries(AUDIO_PRESETS)) {
      if (
        settings.micGain === p.micGain &&
        settings.noiseGate === p.noiseGate &&
        settings.highPassHz === p.highPassHz &&
        settings.presenceDb === p.presenceDb &&
        Boolean(settings.compressor) === Boolean(p.compressor) &&
        Boolean(settings.echoCancellation) === Boolean(p.echoCancellation) &&
        Boolean(settings.noiseSuppression) === Boolean(p.noiseSuppression) &&
        Boolean(settings.autoGainControl) === Boolean(p.autoGainControl)
      ) {
        return name;
      }
    }
    return "custom";
  }

  syncAudioSettingsUI() {
    const s = this.audioSettings;
    if (this.el["audio-mic-gain"]) {
      this.el["audio-mic-gain"].value = String(s.micGain);
    }
    if (this.el["audio-mic-gain-val"]) {
      this.el["audio-mic-gain-val"].textContent = `${s.micGain}%`;
    }
    if (this.el["audio-output-gain"]) {
      this.el["audio-output-gain"].value = String(s.outputGain);
    }
    if (this.el["audio-output-gain-val"]) {
      this.el["audio-output-gain-val"].textContent = `${s.outputGain}%`;
    }
    if (this.el["audio-noise-gate"]) {
      this.el["audio-noise-gate"].value = String(s.noiseGate);
    }
    if (this.el["audio-noise-gate-val"]) {
      this.el["audio-noise-gate-val"].textContent = s.noiseGate === 0 ? "Off" : `${s.noiseGate}%`;
    }
    // Exact 1:1 alignment with Rust VoiceCaptureDsp48k gate threshold and updateAudioMeterUi (0..4900 RMS)
    const markerPct = Math.min(100, Math.round((s.noiseGate / 35) * 100));
    if (this.el["audio-gate-marker"]) {
      this.el["audio-gate-marker"].style.left = `${markerPct}%`;
      this.el["audio-gate-marker"].classList.toggle("hidden", s.noiseGate === 0);
    }
    if (this.el["audio-gate-zone"]) {
      this.el["audio-gate-zone"].style.width = `${markerPct}%`;
      this.el["audio-gate-zone"].classList.toggle("hidden", s.noiseGate === 0);
    }
    if (this.el["audio-highpass"]) {
      this.el["audio-highpass"].value = String(s.highPassHz);
    }
    if (this.el["audio-highpass-val"]) {
      this.el["audio-highpass-val"].textContent = s.highPassHz === 0 ? "Off" : `${s.highPassHz} Hz`;
    }
    if (this.el["audio-presence"]) {
      this.el["audio-presence"].value = String(s.presenceDb);
    }
    if (this.el["audio-presence-val"]) {
      const sign = s.presenceDb > 0 ? "+" : "";
      this.el["audio-presence-val"].textContent = `${sign}${s.presenceDb} dB`;
    }
    if (this.el["audio-compressor"]) {
      this.el["audio-compressor"].checked = Boolean(s.compressor);
    }
    if (this.el["audio-ec"]) {
      this.el["audio-ec"].checked = Boolean(s.echoCancellation);
    }
    if (this.el["audio-ns"]) {
      this.el["audio-ns"].checked = Boolean(s.noiseSuppression);
    }
    if (this.el["audio-agc"]) {
      this.el["audio-agc"].checked = Boolean(s.autoGainControl);
    }
    for (const btn of document.querySelectorAll("[data-audio-preset]")) {
      btn.classList.toggle("active", btn.dataset.audioPreset === s.preset);
    }
    if (this.el["audio-custom-badge"]) {
      this.el["audio-custom-badge"].classList.toggle("hidden", s.preset !== "custom");
    }
    if (this.el["audio-monitor-hint"]) {
      this.el["audio-monitor-hint"].classList.toggle("hidden", !this.voice.monitorActive);
    }
    if (this.el["btn-audio-monitor"]) {
      this.el["btn-audio-monitor"].classList.toggle("is-active", this.voice.monitorActive);
      this.el["btn-audio-monitor"].setAttribute(
        "aria-pressed",
        this.voice.monitorActive ? "true" : "false"
      );
      this.el["btn-audio-monitor"].textContent = this.voice.monitorActive ? "Stop Mic Test" : "Test Mic";
    }
    if (this.el["audio-output-select"]) {
      const targetOut = s.outputDeviceId || "";
      const hasOpt = Array.from(this.el["audio-output-select"].options).some(
        (opt) => opt.value === targetOut
      );
      this.el["audio-output-select"].value = hasOpt ? targetOut : "";
    }
    if (this.advancedMode && this.voice.inVoice) {
      this.updateVoiceAdvancedStats();
    }
  }

  async refreshAudioInputDevices() {
    const select = this.el["audio-input-select"];
    if (!select) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput");
      this.voice.audioDevices = mics;
      const current = this.audioSettings.deviceId || "";
      const opts = ['<option value="">Default Microphone</option>'];
      mics.forEach((d, idx) => {
        if (!d.deviceId || d.deviceId === "default") return;
        const label = d.label && d.label.trim() ? d.label.trim() : `Microphone ${idx + 1}`;
        opts.push(`<option value="${escapeHtml(d.deviceId)}">${escapeHtml(label)}</option>`);
      });
      select.innerHTML = opts.join("");
      if (current && mics.some((d) => d.deviceId === current)) {
        select.value = current;
      } else {
        select.value = "";
      }

      // Optional Speaker / Headphones selector (shown when browser supports AudioContext.setSinkId)
      const outSelect = this.el["audio-output-select"];
      const outField = this.el["audio-output-field"];
      const supportsSinkId =
        typeof AudioContext !== "undefined" && typeof AudioContext.prototype.setSinkId === "function";
      if (outSelect && outField) {
        const outputs = supportsSinkId
          ? devices.filter((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default")
          : [];
        if (outputs.length > 0) {
          const currentOut = this.audioSettings.outputDeviceId || "";
          const outOpts = ['<option value="">Default Output</option>'];
          outputs.forEach((d, idx) => {
            const label = d.label && d.label.trim() ? d.label.trim() : `Speaker / Output ${idx + 1}`;
            outOpts.push(`<option value="${escapeHtml(d.deviceId)}">${escapeHtml(label)}</option>`);
          });
          outSelect.innerHTML = outOpts.join("");
          outSelect.value =
            currentOut && outputs.some((d) => d.deviceId === currentOut) ? currentOut : "";
          outField.classList.remove("hidden");
        } else {
          outField.classList.add("hidden");
        }
      }
    } catch {
      // ignore permission/device enumeration errors
    }
  }

  async applyOutputAudioDevice(targetCtx = null, announce = false) {
    const sinkId = this.audioSettings.outputDeviceId || "";
    const contexts = targetCtx
      ? [targetCtx]
      : [this.voice.audioCtx, this.voice.preCallMonitor?.ctx].filter(Boolean);
    let applied = false;
    for (const ctx of contexts) {
      if (typeof ctx.setSinkId === "function") {
        try {
          await ctx.setSinkId(sinkId);
          applied = true;
        } catch {
          // ignore disconnected or unsupported sinkId
        }
      }
    }
    if (announce && (applied || contexts.length === 0)) {
      this.showToast(sinkId ? "Switched speaker / headphones output" : "Using default audio output");
    }
  }

  applyAudioPreset(presetName) {
    const preset = AUDIO_PRESETS[presetName];
    if (!preset) return;
    this._userCustomizedAudio = true;
    this.audioSettings = saveSessionAudioSettings({
      ...this.audioSettings,
      ...preset,
    });
    this.syncAudioSettingsUI();
    this.applyLiveAudioDspParams(true);
    this.applyMicTrackConstraints();
    this.updateVoiceCodecMeta();
    this.broadcastTabState({ audioSettings: this.audioSettings });
    this.showToast(
      `Audio profile: ${presetName === "raw" ? "Raw / Music" : presetName[0].toUpperCase() + presetName.slice(1)}`
    );
  }

  resetAudioSettings() {
    this._userCustomizedAudio = true;
    this.audioSettings = saveSessionAudioSettings({
      ...DEFAULT_AUDIO_SETTINGS,
      deviceId: this.audioSettings.deviceId || "",
      outputDeviceId: this.audioSettings.outputDeviceId || "",
    });
    this.syncAudioSettingsUI();
    this.applyLiveAudioDspParams(true);
    this.applyMicTrackConstraints();
    this.updateVoiceCodecMeta();
    this.broadcastTabState({ audioSettings: this.audioSettings });
    this.showToast("Audio settings reset to defaults");
  }

  updateAudioSetting(
    key,
    value,
    {
      reconnectMic = false,
      applyOutputDevice = false,
      rewireGraph = false,
      applyTrackConstraints = false,
      keepPreset = false,
    } = {}
  ) {
    const prevPreset = this.audioSettings.preset;
    const next = {
      ...this.audioSettings,
      [key]: value,
    };
    if (!keepPreset) {
      next.preset = this.detectMatchingAudioPreset(next);
    }
    this._userCustomizedAudio = true;
    this.audioSettings = saveSessionAudioSettings(next);
    this.syncAudioSettingsUI();
    this.applyLiveAudioDspParams(rewireGraph);
    this.broadcastTabState({ audioSettings: this.audioSettings });
    if (prevPreset !== this.audioSettings.preset && (prevPreset === "raw" || this.audioSettings.preset === "raw")) {
      this.updateVoiceCodecMeta();
    }
    if (applyTrackConstraints) {
      this.applyMicTrackConstraints();
    }
    if (reconnectMic) {
      this.switchActiveMicrophone();
    }
    if (applyOutputDevice) {
      this.applyOutputAudioDevice(null, true);
    }
  }

  buildMicConstraints() {
    const s = this.audioSettings;
    const audio = {
      echoCancellation: Boolean(s.echoCancellation),
      noiseSuppression: Boolean(s.noiseSuppression),
      autoGainControl: Boolean(s.autoGainControl),
      channelCount: { ideal: 1 },
      sampleRate: { ideal: VOICE_HD_SAMPLE_RATE },
    };
    if (s.deviceId) {
      audio.deviceId = { ideal: s.deviceId };
    }
    return { audio, video: false };
  }

  async applyMicTrackConstraints() {
    const streams = [this.voice.micStream, this.voice.preCallMonitor?.stream].filter(Boolean);
    const s = this.audioSettings;
    for (const stream of streams) {
      for (const track of stream.getAudioTracks()) {
        if (typeof track.applyConstraints === "function") {
          try {
            await track.applyConstraints({
              echoCancellation: Boolean(s.echoCancellation),
              noiseSuppression: Boolean(s.noiseSuppression),
              autoGainControl: Boolean(s.autoGainControl),
            });
          } catch {
            // some browsers ignore live constraint updates cleanly
          }
        }
      }
    }
  }

  async switchActiveMicrophone() {
    if (this.voice.inVoice && !this.voice.listenOnly && this.voice.audioCtx) {
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia(this.buildMicConstraints());
        for (const track of nextStream.getAudioTracks()) {
          track.enabled = !this.voice.muted;
        }
        const prevStream = this.voice.micStream;
        this.teardownMicCaptureGraph();
        this.voice.micStream = nextStream;
        await this.startMicCaptureGraph(this.voice.audioCtx, nextStream);
        if (prevStream) {
          for (const t of prevStream.getTracks()) {
            try {
              t.stop();
            } catch {
              // ignore
            }
          }
        }
        this.refreshAudioInputDevices();
        this.showToast("Switched microphone input");
      } catch (err) {
        this.showToast(`Could not switch microphone: ${err.message}`);
      }
    } else if (this.voice.preCallMonitor) {
      this.stopPreCallMicMonitor();
      await this.startPreCallMicMonitor();
    }
  }

  createMicDspNodes(ctx, source) {
    const highPass = ctx.createBiquadFilter();
    highPass.type = "highpass";
    highPass.Q.value = 0.707;

    const s = this.audioSettings;
    if (s.highPassHz > 0) {
      highPass.type = "highpass";
      highPass.frequency.value = s.highPassHz;
    } else {
      highPass.type = "allpass";
      highPass.frequency.value = 20;
    }

    const presence = ctx.createBiquadFilter();
    presence.type = "peaking";
    presence.frequency.value = 2800;
    presence.Q.value = 1.1;
    presence.gain.value = s.presenceDb;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.12;

    const micGain = ctx.createGain();
    micGain.gain.value = s.micGain / 100;
    const monitorGain = ctx.createGain();
    monitorGain.gain.value = 0;

    return { source, highPass, presence, compressor, micGain, monitorGain };
  }

  wireDspChain(nodes, destinationNode, ctxDestination, enableMonitor) {
    const s = this.audioSettings;
    const { source, highPass, presence, compressor, micGain, monitorGain } = nodes;
    for (const n of [source, highPass, presence, compressor, micGain, monitorGain]) {
      try {
        n.disconnect();
      } catch {
        // ignore
      }
    }

    if (s.highPassHz > 0) {
      highPass.type = "highpass";
      highPass.frequency.value = s.highPassHz;
    } else {
      highPass.type = "allpass";
      highPass.frequency.value = 20;
    }

    presence.gain.value = s.presenceDb;
    micGain.gain.value = s.micGain / 100;
    monitorGain.gain.value = enableMonitor ? 0.7 : 0;

    source.connect(highPass);
    highPass.connect(presence);
    if (s.compressor) {
      presence.connect(compressor);
      compressor.connect(micGain);
    } else {
      presence.connect(micGain);
    }

    if (destinationNode) {
      micGain.connect(destinationNode);
    }
    if (ctxDestination) {
      micGain.connect(monitorGain);
      monitorGain.connect(ctxDestination);
    }
  }

  applyLiveAudioDspParams(rewire = false) {
    const s = this.audioSettings;
    if (this.voice.masterGain) {
      this.voice.masterGain.gain.value = this.voice.deafened ? 0 : s.outputGain / 100;
    }

    if (this.voice.micSource && this.voice.micGainNode && this.voice.audioCtx) {
      const nodes = {
        source: this.voice.micSource,
        highPass: this.voice.highPassFilter,
        presence: this.voice.presenceFilter,
        compressor: this.voice.compressorNode,
        micGain: this.voice.micGainNode,
        monitorGain: this.voice.monitorGain,
      };
      if (rewire) {
        this.wireDspChain(
          nodes,
          this.voice.captureNode,
          this.voice.audioCtx.destination,
          this.voice.monitorActive
        );
      } else {
        if (s.highPassHz > 0) {
          nodes.highPass.type = "highpass";
          nodes.highPass.frequency.value = s.highPassHz;
        } else {
          nodes.highPass.type = "allpass";
          nodes.highPass.frequency.value = 20;
        }
        nodes.presence.gain.value = s.presenceDb;
        nodes.micGain.gain.value = s.micGain / 100;
        nodes.monitorGain.gain.value = this.voice.monitorActive ? 0.7 : 0;
      }
    }

    const mon = this.voice.preCallMonitor;
    if (mon) {
      if (rewire) {
        this.wireDspChain(mon, mon.analyser, mon.ctx.destination, true);
      } else {
        if (s.highPassHz > 0) {
          mon.highPass.type = "highpass";
          mon.highPass.frequency.value = s.highPassHz;
        } else {
          mon.highPass.type = "allpass";
          mon.highPass.frequency.value = 20;
        }
        mon.presence.gain.value = s.presenceDb;
        mon.micGain.gain.value = s.micGain / 100;
        mon.monitorGain.gain.value = 0.7;
      }
    }
  }

  async toggleMicMonitor() {
    if (this.voice.inVoice) {
      if (this.voice.listenOnly || !this.voice.monitorGain) {
        this.showToast("Microphone test is unavailable in Listen-Only mode");
        return;
      }
      this.voice.monitorActive = !this.voice.monitorActive;
      this.voice.monitorGain.gain.value = this.voice.monitorActive ? 0.7 : 0;
      this.syncAudioSettingsUI();
      return;
    }

    if (this.voice.preCallMonitor) {
      this.stopPreCallMicMonitor();
    } else {
      await this.startPreCallMicMonitor();
    }
  }

  async startPreCallMicMonitor() {
    if (this.voice.preCallMonitor) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      this.showToast("Microphone capture is unavailable in this browser context");
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error("Web Audio API unsupported");
      const stream = await navigator.mediaDevices.getUserMedia(this.buildMicConstraints());
      const ctx = new AudioCtx();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      await this.applyOutputAudioDevice(ctx, false);
      const source = ctx.createMediaStreamSource(stream);
      const nodes = this.createMicDspNodes(ctx, source);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      this.wireDspChain(nodes, analyser, ctx.destination, true);

      const sampleBuf = new Float32Array(analyser.fftSize);
      const timer = setInterval(() => {
        if (!this.voice.preCallMonitor) return;
        analyser.getFloatTimeDomainData(sampleBuf);
        let sumSq = 0;
        for (let i = 0; i < sampleBuf.length; i++) {
          sumSq += sampleBuf[i] * sampleBuf[i];
        }
        const rmsInt16 = Math.round(Math.sqrt(sumSq / sampleBuf.length) * 32767);
        const gateThreshold = (this.audioSettings.noiseGate / 100) * 14000;
        const gated = this.audioSettings.noiseGate > 0 && rmsInt16 < gateThreshold;
        this.updateAudioMeterUi(rmsInt16, gated, "Testing");
      }, 65);

      this.voice.preCallMonitor = { ...nodes, ctx, stream, analyser, timer };
      this.voice.monitorActive = true;
      this.syncAudioSettingsUI();
      this.refreshAudioInputDevices();
    } catch (err) {
      this.stopPreCallMicMonitor();
      this.showToast(`Mic test error: ${err.message}`);
    }
  }

  stopPreCallMicMonitor() {
    const mon = this.voice.preCallMonitor;
    this.voice.preCallMonitor = null;
    if (!this.voice.inVoice) {
      this.voice.monitorActive = false;
    }
    if (mon) {
      if (mon.timer) clearInterval(mon.timer);
      for (const n of [
        mon.source,
        mon.highPass,
        mon.presence,
        mon.compressor,
        mon.micGain,
        mon.monitorGain,
        mon.analyser,
      ]) {
        try {
          n?.disconnect();
        } catch {
          // ignore
        }
      }
      if (mon.stream) {
        for (const t of mon.stream.getTracks()) {
          try {
            t.stop();
          } catch {
            // ignore
          }
        }
      }
      try {
        mon.ctx?.close();
      } catch {
        // ignore
      }
    }
    this.updateAudioMeterUi(0, false, "Idle");
    this.syncAudioSettingsUI();
  }

  updateAudioMeterUi(rmsInt16, gated, activeLabel = "Live") {
    const fill = this.el["audio-mic-meter-fill"];
    const status = this.el["audio-mic-meter-status"];
    if (!fill && !status) return;
    // Exact 1:1 alignment with Rust VoiceCaptureDsp48k gate open_threshold:
    // noiseGate max 35% -> 0.35 * 14000 = 4900 RMS Int16 -> 100% bar width.
    const pct = Math.min(100, Math.round((rmsInt16 / 4900) * 100));
    const isHot = !gated && pct > 85;
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.classList.toggle("is-gated", Boolean(gated));
      fill.classList.toggle("is-hot", isHot);
    }
    if (status) {
      if (!this.voice.inVoice && !this.voice.preCallMonitor) {
        status.textContent = "Idle — click Test Mic";
        status.className = "audio-meter-status";
      } else if (this.voice.inVoice && (this.voice.muted || this.voice.listenOnly)) {
        status.textContent = this.voice.listenOnly ? "Listen-Only" : "Muted";
        status.className = "audio-meter-status";
      } else if (gated) {
        status.textContent = "Blocked (too quiet)";
        status.className = "audio-meter-status is-gated";
      } else if (isHot) {
        status.textContent = "Too loud!";
        status.className = "audio-meter-status is-hot";
      } else {
        status.textContent = activeLabel === "Testing" ? "Hearing you" : "Transmitting";
        status.className = "audio-meter-status is-live";
      }
    }
  }

  /* ================= Real-Time Multi-Peer E2EE Voice Chat ================= */

  attachVoiceDataChannel(peerId, voiceDc) {
    if (!voiceDc) return;
    voiceDc.binaryType = "arraybuffer";
    const prev = this.voiceChannels.get(peerId);
    // During a background Direct P2P upgrade probe, keep the active open voice channel alive
    // until the new WebRTC voice channel actually opens so voice never drops mid-call.
    if (prev && prev !== voiceDc && prev.readyState === "open" && voiceDc.readyState !== "open") {
      voiceDc.onopen = () => {
        if (voiceDc.readyState === "open") {
          this.attachVoiceDataChannel(peerId, voiceDc);
        }
      };
      return;
    }
    if (prev && prev !== voiceDc) {
      // Never downgrade an open direct WebRTC voice channel to a virtual relay voice channel
      if (voiceDc.transport === "relay" && prev.transport !== "relay" && prev.readyState === "open") {
        try {
          voiceDc.close();
        } catch {
          // ignore
        }
        return;
      }
      try {
        prev.onmessage = null;
        prev.onclose = null;
        prev.onerror = null;
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
      this.handleIncomingVoicePacket(peerId, ev.data);
    };
    voiceDc.onclose = () => {
      if (this.voiceChannels.get(peerId) === voiceDc) {
        this.voiceChannels.delete(peerId);
      }
    };
    voiceDc.onerror = () => {
      // Unordered channel errors are non-fatal; close handler cleans up if needed
    };
  }

  async probeVoiceOpusSupport() {
    this.voice.opusSupported = false;
    this.voice.opusUseRichConfig = false;
    if (
      typeof AudioEncoder !== "function" ||
      typeof AudioDecoder !== "function" ||
      typeof AudioData !== "function" ||
      typeof EncodedAudioChunk !== "function" ||
      typeof AudioEncoder.isConfigSupported !== "function" ||
      typeof AudioDecoder.isConfigSupported !== "function"
    ) {
      return false;
    }
    try {
      const decSupport = await AudioDecoder.isConfigSupported({
        codec: "opus",
        sampleRate: VOICE_HD_SAMPLE_RATE,
        numberOfChannels: 1,
      });
      if (!decSupport || !decSupport.supported) {
        return false;
      }
      const richCfg = {
        codec: "opus",
        sampleRate: VOICE_HD_SAMPLE_RATE,
        numberOfChannels: 1,
        bitrate: VOICE_OPUS_BITRATE_DIRECT,
        bitrateMode: "variable",
        opus: {
          frameDuration: 20000,
          application: "audio",
          complexity: 8,
          useinbandfec: true,
        },
      };
      try {
        const richSupport = await AudioEncoder.isConfigSupported(richCfg);
        if (richSupport && richSupport.supported) {
          this.voice.opusSupported = true;
          this.voice.opusUseRichConfig = true;
          return true;
        }
      } catch {
        // Older WebCodecs implementations may reject nested opus options; fall through to basic config
      }
      const basicSupport = await AudioEncoder.isConfigSupported({
        codec: "opus",
        sampleRate: VOICE_HD_SAMPLE_RATE,
        numberOfChannels: 1,
        bitrate: VOICE_OPUS_BITRATE_DIRECT,
      });
      if (basicSupport && basicSupport.supported) {
        this.voice.opusSupported = true;
        this.voice.opusUseRichConfig = false;
        return true;
      }
    } catch {
      this.voice.opusSupported = false;
    }
    return false;
  }

  getLocalVoiceCodec() {
    return this.voice.opusSupported ? "opus48" : "adpcm16";
  }

  recordPeerVoiceCodec(peerId, codec) {
    if (!peerId) return;
    const normalized = codec === "opus48" ? "opus48" : "adpcm16";
    this.peerVoiceCodec.set(peerId, normalized);
  }

  getPeerVoiceCodec(peerId) {
    const known = this.peerVoiceCodec.get(peerId);
    if (known) return known;
    const peerInfo = this.status?.peers?.find((p) => p.peerId === peerId);
    if (peerInfo?.isBot) return "adpcm16";
    return this.voice.opusSupported ? "opus48" : "adpcm16";
  }

  computeDesiredOpusBitrate() {
    const voicePeers = (this.status?.peers || []).filter((p) => p.inVoice);
    let anyOpusOnRelay = false;
    for (const p of voicePeers) {
      if (this.getPeerVoiceCodec(p.peerId) !== "opus48") continue;
      const direct = this.directPeers.get(p.peerId);
      if (direct && direct.transport === "relay") {
        anyOpusOnRelay = true;
        break;
      }
    }
    if (anyOpusOnRelay) return VOICE_OPUS_BITRATE_RELAY;
    if (this.audioSettings.preset === "raw") return VOICE_OPUS_BITRATE_RAW;
    return VOICE_OPUS_BITRATE_DIRECT;
  }

  updateVoiceCodecMeta() {
    const el = this.el["voice-codec-meta"];
    if (!el) return;
    if (!this.voice.opusSupported) {
      el.textContent = "End-to-end encrypted · 16 kHz ADPCM (fallback)";
      return;
    }
    const bitrate = this.voice.opusEncoderBitrate || this.computeDesiredOpusBitrate();
    const kbps = Math.round(bitrate / 1000);
    const suffix = bitrate === VOICE_OPUS_BITRATE_RELAY ? " (Relay)" : "";
    el.textContent = `End-to-end encrypted · 48 kHz Opus · ${kbps} kbps${suffix}`;
  }

  ensureVoiceAudioContext() {
    if (!this.voice.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        throw new Error("Web Audio API is not supported in this browser.");
      }
      let ctx;
      try {
        ctx = new AudioCtx({
          latencyHint: "interactive",
          sampleRate: VOICE_HD_SAMPLE_RATE,
        });
      } catch {
        try {
          ctx = new AudioCtx({ latencyHint: "interactive" });
        } catch {
          ctx = new AudioCtx();
        }
      }
      const masterGain = ctx.createGain();
      masterGain.gain.value = this.voice.deafened ? 0 : this.audioSettings.outputGain / 100;

      // Transparent brickwall safety limiter prevents multi-speaker digital clipping
      let masterLimiter = null;
      if (typeof ctx.createDynamicsCompressor === "function") {
        masterLimiter = ctx.createDynamicsCompressor();
        masterLimiter.threshold.value = -2.0;
        masterLimiter.knee.value = 6.0;
        masterLimiter.ratio.value = 12.0;
        masterLimiter.attack.value = 0.002;
        masterLimiter.release.value = 0.06;
        masterGain.connect(masterLimiter);
        masterLimiter.connect(ctx.destination);
      } else {
        masterGain.connect(ctx.destination);
      }

      this.voice.audioCtx = ctx;
      this.voice.masterGain = masterGain;
      this.voice.masterLimiter = masterLimiter;
      this.voice.workletsLoaded = false;
      this.voice.workletsLoadingPromise = null;
      if (this.audioSettings.outputDeviceId) {
        this.applyOutputAudioDevice(ctx, false);
      }
    }
    if (this.voice.audioCtx.state === "suspended") {
      this.voice.audioCtx.resume().catch(() => {});
    }
    return this.voice.audioCtx;
  }

  async ensureVoiceWorkletsLoaded(ctx) {
    if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode !== "function") {
      return false;
    }
    if (this.voice.workletsLoaded && this.voice.audioCtx === ctx) {
      return true;
    }
    if (this.voice.workletsLoadingPromise) {
      return this.voice.workletsLoadingPromise;
    }
    this.voice.workletsLoadingPromise = (async () => {
      try {
        const blob = new Blob([VOICE_WORKLETS_CODE], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        if (this.voice.audioCtx === ctx) {
          this.voice.workletsLoaded = true;
          return true;
        }
        return false;
      } catch {
        return false;
      } finally {
        this.voice.workletsLoadingPromise = null;
      }
    })();
    return this.voice.workletsLoadingPromise;
  }

  _recordRateSample(win, bytes, now = performance.now()) {
    win.push([now, bytes]);
    const cutoff = now - 1000;
    while (win.length > 0 && win[0][0] < cutoff) {
      win.shift();
    }
    if (win.length > 160) {
      win.splice(0, win.length - 160);
    }
  }

  _computeRateWindow(win, now = performance.now()) {
    if (!win || win.length === 0) return { kbps: 0, pps: 0 };
    const cutoff = now - 1000;
    while (win.length > 0 && win[0][0] < cutoff) {
      win.shift();
    }
    if (win.length === 0) return { kbps: 0, pps: 0 };
    let bytes = 0;
    for (let i = 0; i < win.length; i++) {
      bytes += win[i][1];
    }
    return {
      kbps: Math.round(((bytes * 8) / 1000) * 10) / 10,
      pps: win.length,
    };
  }

  _attachPlaybackWorklet(ctx, mixer, isRelayed) {
    if (mixer.playbackNode || !this.voice.workletsLoaded || typeof AudioWorkletNode !== "function") {
      return Boolean(mixer.playbackNode);
    }
    try {
      const node = new AudioWorkletNode(ctx, "p2p-voice-playback", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (ev) => {
        const msg = ev.data;
        if (msg && msg.type === "stats") {
          mixer.workletStats = msg;
        }
      };
      node.connect(mixer.gainNode);
      node.port.postMessage({
        type: "config",
        targetMs: isRelayed ? 60 : 20,
        startMs: isRelayed ? 100 : 26,
        maxMs: isRelayed ? 420 : 150,
      });
      mixer.playbackNode = node;
      mixer.isRelayed = Boolean(isRelayed);
      return true;
    } catch {
      return false;
    }
  }

  ensurePeerVoiceMixer(peerId) {
    let mixer = this.voice.peerMixers.get(peerId);
    if (!mixer) {
      const ctx = this.ensureVoiceAudioContext();
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(this.voice.masterGain);
      const direct = this.directPeers.get(peerId);
      const isRelayed = direct?.transport === "relay";
      mixer = {
        gainNode,
        playbackNode: null,
        opusDecoder: null,
        codec: this.getPeerVoiceCodec(peerId),
        isRelayed: Boolean(isRelayed),
        volume: 1.0,
        muted: false,
        nextPlayTime: 0,
        rms: 0,
        peakRms: 0,
        smoothLevel: 0,
        lastAudioAt: 0,
        packetsReceived: 0,
        decodedFrames: 0,
        workletStats: null,
        rxWindow: [],
        lastPktBytes: 0,
        lastTsSamples: null,
        lastTsAt: 0,
        lostFrames: 0,
        decodeErrors: 0,
      };
      this._attachPlaybackWorklet(ctx, mixer, isRelayed);
      this.voice.peerMixers.set(peerId, mixer);
    }
    return mixer;
  }

  disposePeerVoiceMixer(peerId) {
    const mixer = this.voice.peerMixers.get(peerId);
    if (!mixer) return;
    if (mixer.opusDecoder) {
      try {
        if (mixer.opusDecoder.state !== "closed") {
          mixer.opusDecoder.close();
        }
      } catch {
        // ignore
      }
      mixer.opusDecoder = null;
    }
    if (mixer.playbackNode) {
      try {
        mixer.playbackNode.port.postMessage({ type: "reset" });
        mixer.playbackNode.disconnect();
      } catch {
        // ignore
      }
      mixer.playbackNode = null;
    }
    try {
      mixer.gainNode.disconnect();
    } catch {
      // ignore
    }
    this.voice.peerMixers.delete(peerId);
  }

  _buildOpusEncoderConfig(bitrate) {
    if (this.voice.opusUseRichConfig) {
      return {
        codec: "opus",
        sampleRate: VOICE_HD_SAMPLE_RATE,
        numberOfChannels: 1,
        bitrate,
        bitrateMode: "variable",
        opus: {
          frameDuration: 20000,
          application: "audio",
          complexity: 8,
          useinbandfec: true,
        },
      };
    }
    return {
      codec: "opus",
      sampleRate: VOICE_HD_SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate,
    };
  }

  ensureLocalOpusEncoder() {
    if (!this.voice.opusSupported) return null;
    const desiredBitrate = this.computeDesiredOpusBitrate();
    let enc = this.voice.opusEncoder;

    if (enc && enc.state === "configured") {
      if (this.voice.opusEncoderBitrate !== desiredBitrate) {
        try {
          enc.configure(this._buildOpusEncoderConfig(desiredBitrate));
          this.voice.opusEncoderBitrate = desiredBitrate;
          this.updateVoiceCodecMeta();
        } catch {
          // keep current bitrate if live reconfigure unsupported
        }
      }
      return enc;
    }

    if (enc) {
      try {
        if (enc.state !== "closed") enc.close();
      } catch {
        // ignore
      }
      this.voice.opusEncoder = null;
    }

    try {
      this.voice.opusPendingMeta = [];
      enc = new AudioEncoder({
        output: (chunk) => {
          this._onEncodedOpusChunk(chunk);
        },
        error: () => {
          this.voice.opusEncoder = null;
          this.voice.opusEncoderBitrate = 0;
          this.voice.opusPendingMeta = [];
        },
      });
      enc.configure(this._buildOpusEncoderConfig(desiredBitrate));
      this.voice.opusEncoder = enc;
      this.voice.opusEncoderBitrate = desiredBitrate;
      this.updateVoiceCodecMeta();
      return enc;
    } catch {
      this.voice.opusEncoder = null;
      this.voice.opusEncoderBitrate = 0;
      return null;
    }
  }

  _onEncodedOpusChunk(chunk) {
    if (!this.voice.inVoice || this.voice.muted || !this.wasm || !chunk || chunk.byteLength === 0) {
      return;
    }
    let meta = null;
    const queue = this.voice.opusPendingMeta;
    if (queue.length > 0) {
      const idx = queue.findIndex((m) => m.tsUs === chunk.timestamp);
      if (idx >= 0) {
        meta = queue.splice(0, idx + 1)[idx];
      } else {
        meta = queue.shift();
      }
    }
    const rms = meta ? meta.rms : this.voice.localRms;
    const tsSamples = meta ? meta.tsSamples : 0;

    const totalLen = VOICE_V2_HEADER_BYTES + chunk.byteLength;
    let buf = this.voice.opusTxBuf;
    if (!buf || buf.length < totalLen) {
      buf = new Uint8Array(Math.max(2048, totalLen));
      this.voice.opusTxBuf = buf;
    }
    const clampedRms = Math.min(65535, rms) | 0;
    const tsU32 = tsSamples >>> 0;
    buf[0] = VOICE_V2_CODEC_OPUS48;
    buf[1] = 48;
    buf[2] = clampedRms & 0xff;
    buf[3] = (clampedRms >>> 8) & 0xff;
    buf[4] = tsU32 & 0xff;
    buf[5] = (tsU32 >>> 8) & 0xff;
    buf[6] = (tsU32 >>> 16) & 0xff;
    buf[7] = (tsU32 >>> 24) & 0xff;
    try {
      chunk.copyTo(buf.subarray(VOICE_V2_HEADER_BYTES, totalLen));
    } catch {
      return;
    }

    const packets = this.wasm.sealVoiceRaw(buf.subarray(0, totalLen));
    const nowPerf = performance.now();
    for (const { peerId, data } of packets) {
      if (this.getPeerVoiceCodec(peerId) !== "opus48") continue;
      const vdc = this.voiceChannels.get(peerId);
      if (vdc && vdc.readyState === "open" && vdc.bufferedAmount < 16384) {
        try {
          vdc.send(data);
          this._recordRateSample(this.voice.txWindow, data.byteLength, nowPerf);
          this.recordTopologyPacket(peerId, "tx", "voice", data.byteLength);
        } catch {
          this.voice.txDropped += 1;
        }
      } else if (vdc && vdc.readyState === "open") {
        this.voice.txDropped += 1;
      }
    }
  }

  ensurePeerOpusDecoder(peerId, mixer) {
    if (!this.voice.opusSupported) return null;
    if (mixer.opusDecoder && mixer.opusDecoder.state === "configured") {
      return mixer.opusDecoder;
    }
    if (mixer.opusDecoder) {
      try {
        if (mixer.opusDecoder.state !== "closed") mixer.opusDecoder.close();
      } catch {
        // ignore
      }
      mixer.opusDecoder = null;
    }
    try {
      const dec = new AudioDecoder({
        output: (audioData) => {
          try {
            if (!this.voice.inVoice || !this.voice.audioCtx) return;
            const liveMixer = this.voice.peerMixers.get(peerId);
            if (!liveMixer || this.voice.deafened || liveMixer.muted) return;
            const float32 = extractFloat32FromAudioData(audioData);
            const rate = audioData.sampleRate || VOICE_HD_SAMPLE_RATE;
            liveMixer.decodedFrames += 1;
            // V2 header already supplies exact Rust-computed RMS; only scan PCM on main thread as fallback
            if (liveMixer.rms === 0) {
              const decRms = computeFloat32RmsI16Scale(float32);
              if (decRms > 0) {
                liveMixer.rms = decRms;
              }
            }
            const direct = this.directPeers.get(peerId);
            const isRelayed = direct?.transport === "relay";
            this._pushDecodedPcmToMixer(liveMixer, float32, rate, isRelayed);
          } catch {
            // ignore frame extraction error
          } finally {
            try {
              audioData.close();
            } catch {
              // ignore
            }
          }
        },
        error: () => {
          const liveMixer = this.voice.peerMixers.get(peerId);
          if (liveMixer) {
            liveMixer.decodeErrors = (liveMixer.decodeErrors || 0) + 1;
            if (liveMixer.opusDecoder === dec) {
              liveMixer.opusDecoder = null;
            }
          }
        },
      });
      dec.configure({
        codec: "opus",
        sampleRate: VOICE_HD_SAMPLE_RATE,
        numberOfChannels: 1,
      });
      mixer.opusDecoder = dec;
      return dec;
    } catch {
      mixer.opusDecoder = null;
      return null;
    }
  }

  _pushDecodedPcmToMixer(mixer, float32, sampleRate, isRelayed) {
    const ctx = this.voice.audioCtx;
    if (!ctx || !float32 || float32.length === 0) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    if (!mixer.playbackNode && this.voice.workletsLoaded) {
      this._attachPlaybackWorklet(ctx, mixer, isRelayed);
    }
    if (mixer.playbackNode) {
      if (mixer.isRelayed !== Boolean(isRelayed)) {
        mixer.isRelayed = Boolean(isRelayed);
        mixer.playbackNode.port.postMessage({
          type: "config",
          targetMs: isRelayed ? 60 : 20,
          startMs: isRelayed ? 100 : 26,
          maxMs: isRelayed ? 420 : 150,
        });
      }
      mixer.playbackNode.port.postMessage(
        { type: "pcm", samples: float32, rate: sampleRate },
        [float32.buffer]
      );
      return;
    }

    // Fallback when AudioWorklet is unavailable: soft-edged AudioBufferSourceNode
    const len = float32.length;
    const edge = Math.min(32, Math.floor(len / 8));
    const buf = ctx.createBuffer(1, len, sampleRate);
    const ch = buf.getChannelData(0);
    ch.set(float32);
    for (let i = 0; i < edge; i++) {
      const w = i / edge;
      ch[i] *= w;
      ch[len - 1 - i] *= w;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(mixer.gainNode);
    const now = ctx.currentTime;
    const targetBufferSec = isRelayed ? 0.11 : 0.032;
    const maxDriftSec = isRelayed ? 0.42 : 0.16;
    if (mixer.nextPlayTime < now + 0.004 || mixer.nextPlayTime > now + maxDriftSec) {
      mixer.nextPlayTime = now + targetBufferSec;
    }
    src.start(mixer.nextPlayTime);
    mixer.nextPlayTime += buf.duration;
  }

  async joinVoiceChat({ listenOnly = false } = {}) {
    if (this.voice.inVoice) return;
    this.stopPreCallMicMonitor();
    this.el["btn-voice-join"].disabled = true;
    this.el["btn-voice-listen"].disabled = true;
    this.el["voice-notice"].classList.add("hidden");

    try {
      const ctx = this.ensureVoiceAudioContext();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      // Register both capture & playback AudioWorkletProcessors once per AudioContext
      // (ensures Listen-Only mode also gets the smooth off-main-thread playback jitter buffer)
      await this.ensureVoiceWorkletsLoaded(ctx);

      let micStream = null;
      let effectiveListenOnly = listenOnly;

      if (!listenOnly) {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
          throw new Error("Microphone capture is unavailable in this browser context. Try Listen Only.");
        }
        micStream = await navigator.mediaDevices.getUserMedia(this.buildMicConstraints());
      }

      this.voice.micStream = micStream;
      this.voice.listenOnly = effectiveListenOnly;
      this.voice.muted = effectiveListenOnly;
      this.voice.deafened = false;
      this.voice.inVoice = true;
      this.voice.monitorActive = false;
      this.voice.localRms = 0;
      this.voice.rawMicRms = 0;
      this.voice.peakMicRms = 0;
      this.voice.localSmoothLevel = 0;
      this.voice.localSpeakingAt = 0;
      this.voice.txWindow = [];
      this.voice.txKbps = 0;
      this.voice.txPps = 0;
      this.voice.txDropped = 0;
      this.voice.gateClosed = false;
      this.voice.opusTxSampleCounter = 0;
      this.voice.opusPendingMeta = [];
      this.voice.meterTicks = 0;

      if (this.voice.masterGain) {
        this.voice.masterGain.gain.value = this.audioSettings.outputGain / 100;
      }

      if (micStream) {
        await this.startMicCaptureGraph(ctx, micStream);
        this.refreshAudioInputDevices();
        // Granting mic permission unmasks real LAN host(ipv4) ICE candidates on same-WiFi networks
        if (this.activeRoom && this.roomRendezvous) {
          if (this.directPeers.size === 0 && this.roomDialing.size === 0) {
            this.announceRoomHello(true);
          } else {
            this.tryBackgroundDirectUpgrades(Date.now(), true);
          }
        }
      }

      const res = this.wasm.call({
        cmd: "set_voice_state",
        inVoice: true,
        muted: this.voice.muted,
      });
      this.status = res.status;
      this.executeActions(res.actions);

      if (!this.voice.meterTimer) {
        this.voice.meterTimer = setInterval(() => this.updateVoiceMeters(), 70);
      }

      this.updateVoiceCodecMeta();
      this.syncAudioSettingsUI();
      this.renderAll();
      this.showToast(
        effectiveListenOnly
          ? "Joined voice channel (listen-only)"
          : this.voice.opusSupported
            ? "Joined voice channel (48 kHz Opus HD)"
            : "Joined voice channel"
      );
    } catch (err) {
      this.cleanupVoiceAudioResources();
      this.voice.inVoice = false;
      this.showNotice(
        "voice-notice",
        "warn",
        `Could not start microphone: ${err.message}. You can still click "Listen Only" to hear peers.`
      );
      this.addTelemetry("error", `Voice join error: ${err.message}`);
    } finally {
      this.el["btn-voice-join"].disabled = false;
      this.el["btn-voice-listen"].disabled = false;
    }
  }

  teardownMicCaptureGraph() {
    if (this.voice.captureNode) {
      try {
        if (this.voice.captureNode.port) {
          this.voice.captureNode.port.onmessage = null;
        }
        this.voice.captureNode.disconnect();
      } catch {
        // ignore
      }
      this.voice.captureNode = null;
    }
    for (const key of [
      "micSource",
      "highPassFilter",
      "presenceFilter",
      "compressorNode",
      "micGainNode",
      "monitorGain",
      "silentGain",
    ]) {
      if (this.voice[key]) {
        try {
          this.voice[key].disconnect();
        } catch {
          // ignore
        }
        this.voice[key] = null;
      }
    }
  }

  async startMicCaptureGraph(ctx, micStream) {
    const source = ctx.createMediaStreamSource(micStream);
    const dspNodes = this.createMicDspNodes(ctx, source);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    silentGain.connect(ctx.destination);

    this.voice.micSource = dspNodes.source;
    this.voice.highPassFilter = dspNodes.highPass;
    this.voice.presenceFilter = dspNodes.presence;
    this.voice.compressorNode = dspNodes.compressor;
    this.voice.micGainNode = dspNodes.micGain;
    this.voice.monitorGain = dspNodes.monitorGain;
    this.voice.silentGain = silentGain;

    // Prefer modern off-main-thread AudioWorkletProcessor; fall back to ScriptProcessorNode cleanly
    let workletOk = false;
    const loaded = await this.ensureVoiceWorkletsLoaded(ctx);
    if (loaded && typeof AudioWorkletNode === "function") {
      try {
        const workletNode = new AudioWorkletNode(ctx, "p2p-voice-capture");
        workletNode.port.onmessage = (ev) => {
          if (ev.data instanceof Float32Array) {
            this.onCapturedFloat32Frame(ev.data);
          } else if (ev.data && ev.data.buffer) {
            this.onCapturedFloat32Frame(new Float32Array(ev.data.buffer));
          }
        };
        this.wireDspChain(dspNodes, workletNode, ctx.destination, this.voice.monitorActive);
        workletNode.connect(silentGain);
        this.voice.captureNode = workletNode;
        workletOk = true;
      } catch {
        workletOk = false;
      }
    }

    if (!workletOk && typeof ctx.createScriptProcessor === "function") {
      const proc = ctx.createScriptProcessor(1024, 1, 1);
      const step = ctx.sampleRate / VOICE_HD_SAMPLE_RATE;
      const ringCap = 8192;
      const ringMask = ringCap - 1;
      const ring = new Float32Array(ringCap);
      let writeIdx = 0;
      let readPos = 0;
      const frame = new Float32Array(VOICE_HD_FRAME_SAMPLES);
      let frameIdx = 0;

      proc.onaudioprocess = (ev) => {
        if (!this.voice.inVoice) return;
        const ch = ev.inputBuffer.getChannelData(0);
        for (let i = 0; i < ch.length; i++) {
          ring[writeIdx & ringMask] = ch[i];
          writeIdx++;
        }
        while (readPos + 1 < writeIdx) {
          const idx = Math.floor(readPos);
          const frac = readPos - idx;
          const s0 = ring[idx & ringMask];
          const s1 = ring[(idx + 1) & ringMask];
          frame[frameIdx++] = s0 + (s1 - s0) * frac;
          readPos += step;
          if (frameIdx >= VOICE_HD_FRAME_SAMPLES) {
            this.onCapturedFloat32Frame(frame.slice());
            frameIdx = 0;
          }
        }
        if (readPos > 1048576) {
          const shift = Math.floor(readPos / ringCap) * ringCap;
          readPos -= shift;
          writeIdx -= shift;
        }
      };
      this.wireDspChain(dspNodes, proc, ctx.destination, this.voice.monitorActive);
      proc.connect(silentGain);
      this.voice.captureNode = proc;
    }
  }

  onCapturedFloat32Frame(float32Pcm) {
    if (!this.voice.inVoice || !this.wasm || !float32Pcm || float32Pcm.length === 0) return;

    // Partition active voice peers into HD 48 kHz Opus (V2) vs legacy/bot 16 kHz ADPCM (V1)
    const remoteVoicePeers = (this.status?.peers || []).filter((p) => p.inVoice);
    let needOpusV2 = false;
    let needAdpcmV1 = false;
    for (const p of remoteVoicePeers) {
      if (this.voice.opusSupported && this.getPeerVoiceCodec(p.peerId) === "opus48") {
        needOpusV2 = true;
      } else {
        needAdpcmV1 = true;
      }
    }

    let opusEnc = null;
    if (needOpusV2) {
      opusEnc = this.ensureLocalOpusEncoder();
      if (!opusEnc || opusEnc.state !== "configured") {
        needOpusV2 = false;
        needAdpcmV1 = remoteVoicePeers.length > 0;
      }
    }

    // Execute full 48 kHz capture DSP in compiled safe Rust WASM:
    // DC blocker -> RMS meter -> smooth hysteresis noise gate (5ms fade-in / 280ms hold /
    // 20ms cosine fade-out) -> soft-knee peak safety limiter -> optional 15-tap FIR + V1 ADPCM E2EE
    const dsp = this.wasm.processCapture48k(float32Pcm, {
      gatePct: this.audioSettings.noiseGate,
      needV1: needAdpcmV1,
      returnProcessed48k: needOpusV2,
    });

    this.voice.rawMicRms = dsp.rawRms || 0;
    this.voice.peakMicRms = Math.max(
      this.voice.rawMicRms,
      Math.round((this.voice.peakMicRms || 0) * 0.88)
    );
    this.voice.gateClosed = dsp.gated;
    if (this.voice.settingsOpen) {
      this.updateAudioMeterUi(dsp.rawRms, dsp.gated, "Live");
    }

    if (dsp.gated || this.voice.muted) {
      this.voice.localRms = 0;
      return;
    }

    const activeRms = dsp.activeRms;
    this.voice.localRms = activeRms;
    if (activeRms > 220) {
      this.voice.localSpeakingAt = Date.now();
    }

    if (remoteVoicePeers.length === 0) {
      return;
    }

    let v1Packets = dsp.v1Packets || [];
    let sendV1ToOpusFallback = !needOpusV2;

    // Fast path 1: Studio 48 kHz Opus V2 via native browser WebCodecs + Rust ChaCha20-Poly1305 AEAD
    if (needOpusV2 && opusEnc && dsp.processed48k && dsp.processed48k.length > 0) {
      if (opusEnc.encodeQueueSize <= 4) {
        const processed = dsp.processed48k;
        const tsSamples = this.voice.opusTxSampleCounter >>> 0;
        const tsUs = Math.round((this.voice.opusTxSampleCounter * 1_000_000) / VOICE_HD_SAMPLE_RATE);
        this.voice.opusTxSampleCounter += processed.length;
        if (this.voice.opusPendingMeta.length >= 12) {
          this.voice.opusPendingMeta.shift();
        }
        this.voice.opusPendingMeta.push({ tsUs, tsSamples, rms: activeRms });
        let audioData = null;
        try {
          audioData = new AudioData({
            format: "f32-planar",
            sampleRate: VOICE_HD_SAMPLE_RATE,
            numberOfFrames: processed.length,
            numberOfChannels: 1,
            timestamp: tsUs,
            data: processed,
          });
          opusEnc.encode(audioData);
        } catch {
          sendV1ToOpusFallback = true;
          if (v1Packets.length === 0) {
            const fallbackDsp = this.wasm.processCapture48k(processed, {
              gatePct: 0,
              needV1: true,
              returnProcessed48k: false,
            });
            v1Packets = fallbackDsp.v1Packets || [];
          }
        } finally {
          if (audioData) {
            try {
              audioData.close();
            } catch {
              // ignore
            }
          }
        }
      } else {
        this.voice.txDropped += 1;
      }
    }

    // Fast path 2: Anti-aliased 16 kHz V1 ADPCM (downsampled & E2EE sealed in Rust) for bots/legacy peers
    if (v1Packets.length > 0) {
      const nowPerf = performance.now();
      for (const { peerId, data } of v1Packets) {
        if (!sendV1ToOpusFallback && this.getPeerVoiceCodec(peerId) === "opus48") continue;
        const vdc = this.voiceChannels.get(peerId);
        if (vdc && vdc.readyState === "open" && vdc.bufferedAmount < 16384) {
          try {
            vdc.send(data);
            this._recordRateSample(this.voice.txWindow, data.byteLength, nowPerf);
            this.recordTopologyPacket(peerId, "tx", "voice", data.byteLength);
          } catch {
            this.voice.txDropped += 1;
          }
        } else if (vdc && vdc.readyState === "open") {
          this.voice.txDropped += 1;
        }
      }
    }
  }

  handleIncomingVoicePacket(peerId, rawData) {
    const direct = this.directPeers.get(peerId);
    if (direct) {
      direct.lastActivityMs = Date.now();
    }
    if (!this.voice.inVoice || !this.wasm) return;

    const processBytes = (pktBytes) => {
      if (!this.voice.inVoice || !this.wasm || !pktBytes || pktBytes.byteLength < 4) return;
      const isRelayed = direct?.transport === "relay";

      // V2 High-Definition 48 kHz Opus E2EE packet ("V2")
      if (pktBytes[0] === 0x56 && pktBytes[1] === 0x32) {
        this.recordPeerVoiceCodec(peerId, "opus48");
        const plain = this.wasm.openVoiceRaw(peerId, pktBytes);
        if (!plain || plain.byteLength <= VOICE_V2_HEADER_BYTES) return;
        if (plain[0] !== VOICE_V2_CODEC_OPUS48) return;

        const dv = new DataView(plain.buffer, plain.byteOffset, VOICE_V2_HEADER_BYTES);
        const sampleRate = (plain[1] || 48) * 1000;
        const headerRms = dv.getUint16(2, true);
        const tsSamples = dv.getUint32(4, true);
        const opusData = plain.subarray(VOICE_V2_HEADER_BYTES);

        const mixer = this.ensurePeerVoiceMixer(peerId);
        const nowPerf = performance.now();
        const frameSamples = Math.max(160, Math.round(sampleRate * 0.02));
        if (mixer.lastTsSamples !== null && nowPerf - mixer.lastTsAt < 260) {
          const delta = (tsSamples - mixer.lastTsSamples) | 0;
          if (delta > frameSamples * 1.5 && delta < frameSamples * 25) {
            mixer.lostFrames += Math.max(0, Math.round(delta / frameSamples) - 1);
          } else if (delta < 0 && delta > -frameSamples * 25) {
            mixer.lostFrames = Math.max(0, mixer.lostFrames - 1);
          }
        }
        if (
          mixer.lastTsSamples === null ||
          ((tsSamples - mixer.lastTsSamples) | 0) > 0 ||
          nowPerf - mixer.lastTsAt >= 260
        ) {
          mixer.lastTsSamples = tsSamples;
        }
        mixer.lastTsAt = nowPerf;
        mixer.codec = "opus48";
        mixer.rms = headerRms;
        mixer.peakRms = Math.max(headerRms, Math.round((mixer.peakRms || 0) * 0.88));
        mixer.packetsReceived += 1;
        mixer.lastPktBytes = pktBytes.byteLength;
        mixer.lastAudioAt = Date.now();
        this._recordRateSample(mixer.rxWindow, pktBytes.byteLength, nowPerf);
        this.recordTopologyPacket(peerId, "rx", "voice", pktBytes.byteLength);

        if (this.voice.deafened || mixer.muted || !this.voice.audioCtx) {
          return;
        }
        const dec = this.ensurePeerOpusDecoder(peerId, mixer);
        if (!dec || dec.state !== "configured" || dec.decodeQueueSize > 6) {
          if (dec && dec.decodeQueueSize > 6) {
            mixer.decodeErrors += 1;
          }
          return;
        }
        try {
          dec.decode(
            new EncodedAudioChunk({
              type: "key",
              timestamp: Math.round((tsSamples * 1_000_000) / sampleRate),
              data: opusData,
            })
          );
        } catch {
          mixer.decodeErrors += 1;
          // Reset decoder cleanly if a damaged stream frame occurred
          if (mixer.opusDecoder === dec) {
            try {
              if (dec.state !== "closed") dec.close();
            } catch {
              // ignore
            }
            mixer.opusDecoder = null;
          }
        }
        return;
      }

      // V1 Legacy / Node.js Bot 16 kHz IMA-ADPCM E2EE packet ("V1")
      const decoded = this.wasm.openVoicePacket(peerId, pktBytes);
      if (!decoded || !decoded.pcm || decoded.pcm.length === 0) return;

      if (!this.peerVoiceCodec.has(peerId)) {
        this.recordPeerVoiceCodec(peerId, "adpcm16");
      }

      const mixer = this.ensurePeerVoiceMixer(peerId);
      const nowPerf = performance.now();
      mixer.codec = "adpcm16";
      mixer.rms = decoded.rms;
      mixer.peakRms = Math.max(decoded.rms || 0, Math.round((mixer.peakRms || 0) * 0.88));
      mixer.packetsReceived += 1;
      mixer.decodedFrames += 1;
      mixer.lastPktBytes = pktBytes.byteLength;
      mixer.lastAudioAt = Date.now();
      this._recordRateSample(mixer.rxWindow, pktBytes.byteLength, nowPerf);
      this.recordTopologyPacket(peerId, "rx", "voice", pktBytes.byteLength);

      if (this.voice.deafened || mixer.muted || !this.voice.audioCtx) {
        return;
      }

      const float32 = new Float32Array(decoded.pcm.length);
      for (let i = 0; i < decoded.pcm.length; i++) {
        float32[i] = decoded.pcm[i] / 32768;
      }
      this._pushDecodedPcmToMixer(mixer, float32, VOICE_SAMPLE_RATE, isRelayed);
    };

    if (rawData instanceof ArrayBuffer) {
      processBytes(new Uint8Array(rawData));
    } else if (ArrayBuffer.isView(rawData)) {
      processBytes(new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength));
    } else if (typeof Blob !== "undefined" && rawData instanceof Blob) {
      rawData.arrayBuffer().then((ab) => processBytes(new Uint8Array(ab))).catch(() => {});
    }
  }

  toggleVoiceMute() {
    if (!this.voice.inVoice) return;
    if (this.voice.listenOnly) {
      this.showToast("Joined in Listen-Only mode — leave and click Join Voice to enable microphone");
      return;
    }
    this.voice.muted = !this.voice.muted;
    if (this.voice.micStream) {
      for (const track of this.voice.micStream.getAudioTracks()) {
        track.enabled = !this.voice.muted;
      }
    }
    if (this.voice.muted) {
      this.voice.localRms = 0;
      this.voice.localSmoothLevel = 0;
    }
    const res = this.wasm.call({
      cmd: "set_voice_state",
      inVoice: true,
      muted: this.voice.muted,
    });
    this.status = res.status;
    this.executeActions(res.actions);
    this.renderVoicePanel(true);
    this.renderHeader();
    this.updateVoiceMeters();
  }

  toggleVoiceDeafen() {
    if (!this.voice.inVoice) return;
    this.voice.deafened = !this.voice.deafened;
    if (this.voice.masterGain) {
      this.voice.masterGain.gain.value = this.voice.deafened ? 0 : this.audioSettings.outputGain / 100;
    }
    if (this.voice.deafened) {
      for (const mixer of this.voice.peerMixers.values()) {
        if (mixer.playbackNode) {
          try {
            mixer.playbackNode.port.postMessage({ type: "reset" });
          } catch {
            // ignore
          }
        }
      }
    }
    this.renderVoicePanel(true);
    this.updateVoiceMeters();
  }

  setPeerVoiceVolume(peerId, vol) {
    const mixer = this.voice.peerMixers.get(peerId) || (this.voice.inVoice ? this.ensurePeerVoiceMixer(peerId) : null);
    if (!mixer) return;
    mixer.volume = Math.max(0, Math.min(1.5, Number(vol) || 0));
    mixer.gainNode.gain.value = mixer.muted ? 0 : mixer.volume;
  }

  togglePeerVoiceMute(peerId) {
    const mixer = this.voice.peerMixers.get(peerId) || (this.voice.inVoice ? this.ensurePeerVoiceMixer(peerId) : null);
    if (!mixer) return;
    mixer.muted = !mixer.muted;
    mixer.gainNode.gain.value = mixer.muted ? 0 : mixer.volume;
    if (mixer.muted && mixer.playbackNode) {
      try {
        mixer.playbackNode.port.postMessage({ type: "reset" });
      } catch {
        // ignore
      }
    }
    this.renderVoicePanel(true);
    this.updateVoiceMeters();
  }

  cleanupVoiceAudioResources() {
    this._clearRelayVoiceReorder();
    if (this.voice.meterTimer) {
      clearInterval(this.voice.meterTimer);
      this.voice.meterTimer = null;
    }
    this.teardownMicCaptureGraph();
    if (this.voice.opusEncoder) {
      try {
        if (this.voice.opusEncoder.state !== "closed") {
          this.voice.opusEncoder.close();
        }
      } catch {
        // ignore
      }
      this.voice.opusEncoder = null;
      this.voice.opusEncoderBitrate = 0;
    }
    this.voice.opusPendingMeta = [];
    this.voice.monitorActive = false;
    if (this.voice.micStream) {
      for (const track of this.voice.micStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.voice.micStream = null;
    }
    for (const pid of Array.from(this.voice.peerMixers.keys())) {
      this.disposePeerVoiceMixer(pid);
    }
    this.voice.peerMixers.clear();
    if (this.voice.masterLimiter) {
      try {
        this.voice.masterLimiter.disconnect();
      } catch {
        // ignore
      }
      this.voice.masterLimiter = null;
    }
    if (this.voice.masterGain) {
      try {
        this.voice.masterGain.disconnect();
      } catch {
        // ignore
      }
      this.voice.masterGain = null;
    }
    if (this.voice.audioCtx) {
      try {
        this.voice.audioCtx.close();
      } catch {
        // ignore
      }
      this.voice.audioCtx = null;
    }
    this.voice.workletsLoaded = false;
    this.voice.workletsLoadingPromise = null;
    this.updateVoiceCodecMeta();
    this.updateAudioMeterUi(0, false, "Idle");
    this.syncAudioSettingsUI();
  }

  leaveVoiceChat(silent = false) {
    if (!this.voice.inVoice) return;
    this.cleanupVoiceAudioResources();
    this.voice.inVoice = false;
    this.voice.muted = false;
    this.voice.deafened = false;
    this.voice.listenOnly = false;
    this.voice.localRms = 0;
    this.voice.rawMicRms = 0;
    this.voice.peakMicRms = 0;
    this.voice.localSmoothLevel = 0;
    this.voice.txWindow = [];
    this.voice.txKbps = 0;
    this.voice.txPps = 0;
    this.voice.txDropped = 0;
    this.voice.gateClosed = false;
    this.voice.joinOrder = this.voice.joinOrder.filter((id) => id !== "self");
    this.voice.renderedKeys.delete("self");
    this.voice.lastRosterKey = "";

    if (this.wasm) {
      try {
        const res = this.wasm.call({
          cmd: "set_voice_state",
          inVoice: false,
          muted: false,
        });
        this.status = res.status;
        this.executeActions(res.actions);
      } catch {
        // ignore during teardown
      }
    }
    if (!silent) {
      this.el["voice-notice"].classList.add("hidden");
      this.renderAll();
      this.showToast("Left voice channel");
    }
  }

  _applySpeakerVisualizer(rowKey, level, defaultStateLabel, tickPhase) {
    let entry = this.voice.cardCache.get(rowKey);
    if (!entry || !entry.card.isConnected) {
      const list = this.el["voice-participant-list"];
      const selector = rowKey === "self" ? "self" : CSS.escape(rowKey);
      const card = list.querySelector(`[data-voice-row="${selector}"]`);
      if (!card) return;
      const bars = Array.from(card.querySelectorAll(".voice-eq-bar"));
      entry = {
        card,
        stateEl: card.querySelector("[data-voice-state]"),
        advStatsEl: card.querySelector("[data-voice-adv-stats]"),
        lastAdvHtml: "",
        bars,
        lastSpeaking: null,
        lastLevelStr: "",
        lastStateText: "",
        lastBarH: new Int16Array(bars.length),
      };
      this.voice.cardCache.set(rowKey, entry);
    }

    const speaking = level > 0.09;
    const levelStr = level <= 0.001 ? "0" : level.toFixed(3);
    if (entry.lastLevelStr !== levelStr) {
      entry.lastLevelStr = levelStr;
      entry.card.style.setProperty("--voice-level", levelStr);
    }
    if (entry.lastSpeaking !== speaking) {
      entry.lastSpeaking = speaking;
      entry.card.classList.toggle("is-speaking", speaking);
    }

    const nextStateText = speaking ? "Speaking" : defaultStateLabel;
    if (entry.stateEl && entry.lastStateText !== nextStateText) {
      entry.lastStateText = nextStateText;
      entry.stateEl.textContent = nextStateText;
    }

    const bars = entry.bars;
    const lastH = entry.lastBarH;
    const silent = level <= 0.04;
    for (let i = 0; i < bars.length; i++) {
      let h;
      if (silent) {
        h = 4;
      } else {
        const w = VOICE_EQ_WEIGHTS[i] || 0.5;
        const wobble = 0.72 + 0.28 * Math.sin(tickPhase * 0.9 + i * 1.15);
        h = Math.max(4, Math.min(30, Math.round(4 + level * 26 * w * wobble)));
      }
      if (lastH[i] !== h) {
        lastH[i] = h;
        bars[i].style.height = `${h}px`;
      }
    }
  }

  updateVoiceMeters() {
    if (!this.voice.inVoice || !this.wasm) return;
    const now = Date.now();
    this.voice.meterTicks = (this.voice.meterTicks + 1) % 100000;
    const phase = this.voice.meterTicks;

    // Local speaker smoothing (fast attack, smooth release)
    const selfSilenced = this.voice.muted || this.voice.listenOnly;
    const localFresh = !selfSilenced && now - this.voice.localSpeakingAt < 320;
    const localTarget = localFresh ? rmsToLevel(this.voice.localRms) : 0;
    this.voice.localSmoothLevel = selfSilenced
      ? 0
      : localTarget > this.voice.localSmoothLevel
        ? this.voice.localSmoothLevel * 0.4 + localTarget * 0.6
        : this.voice.localSmoothLevel * 0.72 + localTarget * 0.28;
    if (this.voice.localSmoothLevel < 0.015) this.voice.localSmoothLevel = 0;

    const selfDefault = this.voice.listenOnly
      ? "Listen-Only"
      : this.voice.muted
        ? "Muted"
        : "Live";
    this._applySpeakerVisualizer("self", this.voice.localSmoothLevel, selfDefault, phase);

    // Remote speaker smoothing & live visualizer update
    const peers = this.status?.peers;
    if (peers) {
      for (let i = 0; i < peers.length; i++) {
        const p = peers[i];
        if (!p.inVoice) continue;
        const mixer = this.voice.peerMixers.get(p.peerId);
        const localMuted = Boolean(mixer && mixer.muted);
        const peerSilenced = this.voice.deafened || localMuted || Boolean(p.voiceMuted);
        const fresh = !peerSilenced && mixer && now - mixer.lastAudioAt < 340;
        const target = fresh ? rmsToLevel(mixer.rms) : 0;
        if (mixer) {
          mixer.smoothLevel = peerSilenced
            ? 0
            : target > (mixer.smoothLevel || 0)
              ? (mixer.smoothLevel || 0) * 0.4 + target * 0.6
              : (mixer.smoothLevel || 0) * 0.72 + target * 0.28;
          if (mixer.smoothLevel < 0.015) mixer.smoothLevel = 0;
        }
        const level = peerSilenced ? 0 : mixer ? mixer.smoothLevel : 0;
        const defaultState = this.voice.deafened
          ? "Deafened"
          : p.voiceMuted || localMuted
            ? "Muted"
            : "Live";
        this._applySpeakerVisualizer(p.peerId, level, defaultState, phase + p.peerId.charCodeAt(2));
      }
    }

    // Refresh packet counters every ~4th visualizer frame (~280ms) via zero-JSON binary OP_GET_COUNTERS (~1.7 us)
    if (this.voice.meterTicks % 4 === 0) {
      try {
        const cnt = this.wasm.getCounters();
        if (cnt && this.status?.stats) {
          const s = this.status.stats;
          s.voicePacketsSent = cnt.voicePacketsSent;
          s.voicePacketsReceived = cnt.voicePacketsReceived;
          s.framesSent = cnt.framesSent;
          s.framesReceived = cnt.framesReceived;
          s.e2eeFramesEncrypted = cnt.e2eeFramesEncrypted;
          s.e2eeFramesDecrypted = cnt.e2eeFramesDecrypted;
          s.e2eeAuthFailures = cnt.e2eeAuthFailures;
          s.gossipForwards = cnt.gossipForwards;
          s.gossipDuplicatesDropped = cnt.gossipDuplicatesDropped;
          const sig = `${cnt.voicePacketsSent}:${cnt.voicePacketsReceived}:${cnt.e2eeFramesEncrypted}:${cnt.e2eeFramesDecrypted}`;
          if (sig !== this.voice.lastCounterSig) {
            this.voice.lastCounterSig = sig;
            this.renderStats();
            this.el["voice-packet-stats"].textContent =
              `TX ${cnt.voicePacketsSent} / RX ${cnt.voicePacketsReceived}`;
          }
        }
      } catch {
        // ignore
      }

      if (this.advancedMode) {
        if (this.voice.meterTicks % 16 === 0) {
          try {
            const st = this.wasm.call({ cmd: "get_status" });
            if (st && st.status) {
              this.status = st.status;
            }
          } catch {
            // ignore
          }
        }
        this.updateVoiceAdvancedStats();
      }
    }
  }

  /* ================= Direct E2EE DataChannel & Relayed Auto-Mesh ================= */

  attachBulkDataChannel(peerId, bulkDc) {
    if (!bulkDc) return;
    const prev = this.bulkChannels.get(peerId);
    // Keep existing open bulk channel alive during background Direct P2P upgrade probes
    if (prev && prev !== bulkDc && prev.readyState === "open" && bulkDc.readyState !== "open") {
      bulkDc.onopen = () => {
        if (bulkDc.readyState === "open") {
          this.attachBulkDataChannel(peerId, bulkDc);
        }
      };
      return;
    }
    if (prev && prev !== bulkDc) {
      // Never downgrade an open Direct WebRTC bulk channel to a virtual E2EE relay bulk channel
      if (bulkDc.transport === "relay" && prev.transport !== "relay" && prev.readyState === "open") {
        try {
          bulkDc.close();
        } catch {
          // ignore
        }
        return;
      }
      try {
        prev.onmessage = null;
        prev.onopen = null;
        prev.onclose = null;
        prev.onerror = null;
        prev.onbufferedamountlow = null;
        prev.close();
      } catch {
        // ignore
      }
    }
    this.bulkChannels.set(peerId, bulkDc);
    const direct = this.directPeers.get(peerId);
    if (direct && (bulkDc.transport === "relay") === (direct.transport === "relay")) {
      direct.bulkDc = bulkDc;
    }

    if (bulkDc.transport !== "relay" && typeof bulkDc === "object") {
      try {
        bulkDc.bufferedAmountLowThreshold = this.isVoiceChannelBusy() ? 8192 : 65536;
        bulkDc.onbufferedamountlow = () => {
          const live = this.directPeers.get(peerId);
          if (live && live.bulkDc === bulkDc) {
            this._pumpBulkDirectSendQueue(live);
          }
        };
      } catch {
        // ignore if unsupported
      }
    }

    bulkDc.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const live = this.directPeers.get(peerId);
      if (!live || live.superseded) return;
      this._handleIncomingDataPayload(live, ev.data, "bulk");
    };

    const onBulkReady = () => {
      const live = this.directPeers.get(peerId);
      if (live && (bulkDc.transport === "relay") === (live.transport === "relay")) {
        live.bulkDc = bulkDc;
        if (live.bulkSendQueue && live.bulkSendQueue.length > 0) {
          this._pumpBulkDirectSendQueue(live);
        }
      }
    };
    if (bulkDc.readyState === "open") {
      onBulkReady();
    } else {
      bulkDc.onopen = onBulkReady;
    }

    bulkDc.onclose = () => {
      if (this.bulkChannels.get(peerId) === bulkDc) {
        this.bulkChannels.delete(peerId);
      }
      const live = this.directPeers.get(peerId);
      if (live && live.bulkDc === bulkDc) {
        live.bulkDc = null;
      }
    };
    bulkDc.onerror = () => {
      // Non-fatal: primary p2p-mesh channel remains healthy as fallback
    };
  }

  _handleIncomingDataPayload(peerEntry, rawStr, kind = "data") {
    if (!peerEntry || peerEntry.superseded || typeof rawStr !== "string") return;
    peerEntry.lastActivityMs = Date.now();
    this.recordTopologyPacket(peerEntry.peerId, "rx", kind, rawStr.length);

    if (rawStr.startsWith('{"kind":"dc_chunk"')) {
      try {
        const ch = JSON.parse(rawStr);
        if (
          ch &&
          ch.kind === "dc_chunk" &&
          typeof ch.id === "number" &&
          typeof ch.i === "number" &&
          typeof ch.n === "number" &&
          typeof ch.d === "string" &&
          ch.n > 0 &&
          ch.n <= DC_CHUNK_MAX_PARTS &&
          ch.i >= 0 &&
          ch.i < ch.n
        ) {
          const asmMap =
            kind === "bulk" ? peerEntry.bulkChunkAssemblies : peerEntry.dcChunkAssemblies;
          let asm = asmMap.get(ch.id);
          if (!asm) {
            if (asmMap.size >= 16) {
              const oldestKey = asmMap.keys().next().value;
              if (oldestKey !== undefined) asmMap.delete(oldestKey);
            }
            asm = { n: ch.n, parts: new Array(ch.n), received: 0 };
            asmMap.set(ch.id, asm);
          }
          if (asm.parts[ch.i] === undefined) {
            asm.parts[ch.i] = ch.d;
            asm.received += 1;
          }
          if (asm.received === asm.n) {
            asmMap.delete(ch.id);
            if (typeof peerEntry.deliverWireFrame === "function") {
              peerEntry.deliverWireFrame(asm.parts.join(""));
            }
          }
          return;
        }
      } catch {
        return;
      }
    }

    if (typeof peerEntry.deliverWireFrame === "function") {
      peerEntry.deliverWireFrame(rawStr);
    }
  }

  attachDataChannel(
    pc,
    dc,
    peerId,
    authorName,
    peerPubKey,
    viaAutoMesh,
    introducedBy,
    replaceExisting = false
  ) {
    let closed = false;
    let disconnectTimer = null;

    const clearDisconnectTimer = () => {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    };

    const transport = dc && dc.transport === "relay" ? "relay" : "direct";
    const curVoice = this.voiceChannels.get(peerId);
    const matchedVoice =
      curVoice && (curVoice.transport === "relay") === (transport === "relay") ? curVoice : null;
    const curBulk = this.bulkChannels.get(peerId);
    const matchedBulk =
      curBulk && (curBulk.transport === "relay") === (transport === "relay") ? curBulk : null;

    const peerEntry = {
      peerId,
      authorName: authorName || "Peer",
      peerPubKey,
      pc,
      dc,
      transport,
      voiceDc: matchedVoice,
      bulkDc: matchedBulk,
      viaAutoMesh,
      introducedBy,
      lastActivityMs: Date.now(),
      superseded: false,
      dcSendQueue: [],
      dcSendTimer: null,
      dcChunkAssemblies: new Map(),
      bulkSendQueue: [],
      bulkSendTimer: null,
      bulkChunkAssemblies: new Map(),
      deliverWireFrame: null,
    };

    const clearPeerSendQueue = () => {
      if (peerEntry.dcSendTimer) {
        clearTimeout(peerEntry.dcSendTimer);
        peerEntry.dcSendTimer = null;
      }
      if (peerEntry.bulkSendTimer) {
        clearTimeout(peerEntry.bulkSendTimer);
        peerEntry.bulkSendTimer = null;
      }
      peerEntry.dcSendQueue.length = 0;
      peerEntry.dcChunkAssemblies.clear();
      peerEntry.bulkSendQueue.length = 0;
      peerEntry.bulkChunkAssemblies.clear();
    };

    if (transport === "direct" && dc && typeof dc === "object") {
      try {
        dc.bufferedAmountLowThreshold = 32768;
        dc.onbufferedamountlow = () => {
          this._pumpDirectSendQueue(peerEntry);
          if (!peerEntry.bulkDc || peerEntry.bulkDc.readyState !== "open") {
            this._pumpBulkDirectSendQueue(peerEntry);
          }
        };
      } catch {
        // ignore if unsupported
      }
    }

    const handleOpen = () => {
      if (closed || peerEntry.superseded) return;
      const existing = this.directPeers.get(peerId);
      let upgradingFromRelay = false;

      if (existing && existing.dc !== dc) {
        // Never downgrade an already-open Direct WebRTC peer to a virtual E2EE relay channel
        if (transport === "relay" && existing.transport === "direct" && existing.dc?.readyState === "open") {
          try {
            dc.close(true);
            pc.close();
          } catch {
            // ignore
          }
          return;
        }
        upgradingFromRelay =
          existing.transport === "relay" &&
          transport === "direct" &&
          existing.dc &&
          existing.dc.readyState === "open";

        if (!replaceExisting && !upgradingFromRelay && existing.dc && existing.dc.readyState === "open") {
          const recentlyActive = Date.now() - (existing.lastActivityMs || 0) < 12_000;
          if (recentlyActive) {
            try {
              dc.close();
              pc.close();
            } catch {
              // ignore
            }
            return;
          }
        }
        existing.superseded = true;
        if (existing.dcSendTimer) {
          clearTimeout(existing.dcSendTimer);
          existing.dcSendTimer = null;
        }
        if (existing.bulkSendTimer) {
          clearTimeout(existing.bulkSendTimer);
          existing.bulkSendTimer = null;
        }
        if (existing.dcSendQueue) existing.dcSendQueue.length = 0;
        if (existing.dcChunkAssemblies) existing.dcChunkAssemblies.clear();
        if (existing.bulkSendQueue) existing.bulkSendQueue.length = 0;
        if (existing.bulkChunkAssemblies) existing.bulkChunkAssemblies.clear();
        try {
          existing.dc.onclose = null;
          existing.dc.onerror = null;
          existing.pc.onconnectionstatechange = null;
          existing.pc.oniceconnectionstatechange = null;
          if (existing.bulkDc) {
            existing.bulkDc.onclose = null;
            existing.bulkDc.onerror = null;
            existing.bulkDc.close();
          }
          if (existing.transport === "relay") {
            existing.dc.close(true);
          } else {
            existing.dc.close();
          }
          existing.pc.close();
        } catch {
          // ignore
        }
      }

      peerEntry.lastActivityMs = Date.now();
      const latestVoice = this.voiceChannels.get(peerId);
      if (latestVoice && (latestVoice.transport === "relay") === (transport === "relay")) {
        peerEntry.voiceDc = latestVoice;
      }
      const latestBulk = this.bulkChannels.get(peerId);
      if (latestBulk && (latestBulk.transport === "relay") === (transport === "relay")) {
        peerEntry.bulkDc = latestBulk;
      }

      const pendingOpen = this.relayPendingOpens.get(peerId);
      if (pendingOpen) {
        if (pendingOpen.retryTimer) clearTimeout(pendingOpen.retryTimer);
        this.relayPendingOpens.delete(peerId);
      }

      if (transport === "direct") {
        this.relayPeers.delete(peerId);
        this.earlyRelayIce.delete(peerId);
        this.localDialing.delete(peerId);
        this.earlyLocalIce.delete(peerId);
        const dialingEntry = this.roomDialing.get(peerId);
        if (dialingEntry) {
          if (dialingEntry.trickleTimer) clearTimeout(dialingEntry.trickleTimer);
          if (dialingEntry.fallbackTimer) clearTimeout(dialingEntry.fallbackTimer);
          if (dialingEntry.hardTimer) clearTimeout(dialingEntry.hardTimer);
          if (dialingEntry.voiceDc && dialingEntry.voiceDc.readyState === "open") {
            this.attachVoiceDataChannel(peerId, dialingEntry.voiceDc);
            peerEntry.voiceDc = dialingEntry.voiceDc;
          }
          if (dialingEntry.bulkDc && dialingEntry.bulkDc.readyState === "open") {
            this.attachBulkDataChannel(peerId, dialingEntry.bulkDc);
            peerEntry.bulkDc = dialingEntry.bulkDc;
          }
          this.roomDialing.delete(peerId);
        }
        this.earlyRoomIce.delete(peerId);
        this.directUpgradeState.delete(peerId);
      }

      this.pendingAnswers.delete(peerId);
      if (this.latestAnswer && this.latestAnswer.peerId === peerId) {
        this.latestAnswer = null;
      }
      this.discoveredLocalMeshes.delete(peerId);
      this.directPeers.set(peerId, peerEntry);

      if (typeof pc.getStats === "function") {
        pc.getStats()
          .then((stats) => {
            let pair = null;
            stats.forEach((r) => {
              if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded")) {
                pair = r;
              }
            });
            if (pair) {
              const local = stats.get(pair.localCandidateId);
              const remote = stats.get(pair.remoteCandidateId);
              if (local || remote) {
                const lt = local?.candidateType || "?";
                const rt = remote?.candidateType || "?";
                const proto = local?.protocol || "";
                this._storeDirectPeerTech(peerId, local, remote, pair);
                const prefix = upgradingFromRelay
                  ? `Upgraded ${peerEntry.authorName} from E2EE Relay → Direct P2P`
                  : `WebRTC path to ${peerEntry.authorName}`;
                this.addTelemetry(
                  "room",
                  `${prefix}: ${lt} ↔ ${rt}${proto ? ` (${proto})` : ""}`
                );
                this.renderPeers();
                this.renderTopology();
              }
            }
          })
          .catch(() => {});
      }

      if (upgradingFromRelay) {
        // Keep existing WASM X25519 + ChaCha20-Poly1305 session and monotonic counters alive
        // for a zero-drop seamless upgrade from E2EE Relay to Direct WebRTC P2P.
        this.renderPeers();
        this.renderTopology();
        this.renderStats();
        this.showToast(`Upgraded ${peerEntry.authorName} to Direct P2P`);
        return;
      }

      const res = this.wasm.call({
        cmd: "peer_connected",
        peerId,
        authorName: peerEntry.authorName,
        peerPubKey,
        viaAutoMesh,
        introducedBy,
      });
      this.status = res.status;
      this.executeActions(res.actions);

      if (!viaAutoMesh) {
        if (this.wizard.mode === "host" || this.wizard.mode === "join") {
          this.wizard.step = 3;
          this.wizard.peerName = peerEntry.authorName;
        }
        this.el["connect-notice"].classList.add("hidden");
      }
      this.renderAll();
      this.showToast(
        transport === "relay"
          ? `Connected to ${peerEntry.authorName} (E2EE Relay)`
          : viaAutoMesh
            ? `Connected directly with ${peerEntry.authorName}`
            : `Connected to ${peerEntry.authorName}`
      );
    };

    const handleClose = () => {
      if (closed) return;
      closed = true;
      clearDisconnectTimer();
      clearPeerSendQueue();
      const current = this.directPeers.get(peerId);
      const isOwningPeer = Boolean(current && current.dc === dc);
      try {
        dc.close();
        if (
          peerEntry.voiceDc &&
          (isOwningPeer || (peerEntry.voiceDc.transport === "relay") === (transport === "relay"))
        ) {
          peerEntry.voiceDc.close();
        }
        if (
          peerEntry.bulkDc &&
          (isOwningPeer || (peerEntry.bulkDc.transport === "relay") === (transport === "relay"))
        ) {
          peerEntry.bulkDc.close();
        }
        pc.close();
      } catch {
        // ignore
      }
      if (peerEntry.superseded) {
        return;
      }
      if (isOwningPeer) {
        this.directPeers.delete(peerId);
        if (this.voiceChannels.get(peerId) === peerEntry.voiceDc) {
          this.voiceChannels.delete(peerId);
        }
        if (this.bulkChannels.get(peerId) === peerEntry.bulkDc) {
          this.bulkChannels.delete(peerId);
        }
        this.disposePeerVoiceMixer(peerId);
        this._clearRelayVoiceReorderForPeer(peerId);
        this._cleanupPeerTopologyState(peerId);
        const res = this.wasm.call({ cmd: "peer_disconnected", peerId });
        this.status = res.status;
        this.executeActions(res.actions);
        this.renderAll();
      }
      const rel = this.relayPeers.get(peerId);
      if (rel && rel.pc === pc) {
        this.relayPeers.delete(peerId);
      }
      const loc = this.localDialing.get(peerId);
      if (loc && loc.pc === pc) {
        this.localDialing.delete(peerId);
      }
      const rm = this.roomDialing.get(peerId);
      if (rm && rm.pc === pc) {
        this._cleanupRoomDialingEntry(peerId, rm, "offer ICE failed");
        if (!rm.isUpgradeProbe && !this.directPeers.has(peerId)) {
          this.requestRelayFallback(peerId, authorName, peerPubKey, "offer ICE failed");
        }
      }
    };

    const evaluateConnectionState = () => {
      if (closed || peerEntry.superseded) return;
      const cs = pc.connectionState;
      const ics = pc.iceConnectionState;
      if (cs === "failed" || cs === "closed" || ics === "failed" || ics === "closed") {
        handleClose();
      } else if (cs === "disconnected" || ics === "disconnected") {
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            if (closed || peerEntry.superseded) return;
            const healthyState =
              pc.connectionState === "connected" ||
              pc.iceConnectionState === "connected" ||
              pc.iceConnectionState === "completed";
            const recentEncryptedTraffic =
              Date.now() - peerEntry.lastActivityMs < DISCONNECT_GRACE_MS - 500;
            if (healthyState || recentEncryptedTraffic) {
              if (!healthyState) {
                evaluateConnectionState();
              }
              return;
            }
            handleClose();
          }, DISCONNECT_GRACE_MS);
        }
      } else if (cs === "connected" || ics === "connected" || ics === "completed") {
        clearDisconnectTimer();
      }
    };

    const deliverWireFrame = (frameStr) => {
      this._deliverWireFrameSmart(peerEntry, peerId, frameStr, false);
    };
    peerEntry.deliverWireFrame = deliverWireFrame;

    dc.onmessage = (ev) => {
      if (typeof ev.data !== "string" || peerEntry.superseded) return;
      this._handleIncomingDataPayload(peerEntry, ev.data, "data");
    };

    dc.onclose = handleClose;
    dc.onerror = () => handleClose();
    pc.onconnectionstatechange = evaluateConnectionState;
    pc.oniceconnectionstatechange = evaluateConnectionState;

    if (dc.readyState === "open") {
      handleOpen();
    } else {
      dc.onopen = handleOpen;
    }
  }

  disconnectPeer(peerId) {
    const entry = this.directPeers.get(peerId);
    if (!entry) return;
    entry.superseded = true;
    if (entry.dcSendTimer) {
      clearTimeout(entry.dcSendTimer);
      entry.dcSendTimer = null;
    }
    if (entry.bulkSendTimer) {
      clearTimeout(entry.bulkSendTimer);
      entry.bulkSendTimer = null;
    }
    if (entry.dcSendQueue) entry.dcSendQueue.length = 0;
    if (entry.dcChunkAssemblies) entry.dcChunkAssemblies.clear();
    if (entry.bulkSendQueue) entry.bulkSendQueue.length = 0;
    if (entry.bulkChunkAssemblies) entry.bulkChunkAssemblies.clear();
    this.directPeers.delete(peerId);
    const vdc = this.voiceChannels.get(peerId);
    if (vdc) {
      this.voiceChannels.delete(peerId);
      try {
        vdc.close();
      } catch {
        // ignore
      }
    }
    const bdc = this.bulkChannels.get(peerId);
    if (bdc) {
      this.bulkChannels.delete(peerId);
      try {
        bdc.close();
      } catch {
        // ignore
      }
    }
    this.disposePeerVoiceMixer(peerId);
    this._clearRelayVoiceReorderForPeer(peerId);
    this._cleanupPeerTopologyState(peerId);
    try {
      entry.dc.close();
      entry.pc.close();
    } catch {
      // ignore
    }
    const res = this.wasm.call({ cmd: "peer_disconnected", peerId });
    this.status = res.status;
    this.executeActions(res.actions);
    this.renderAll();
    this.showToast(`Disconnected from ${entry.authorName || peerId}`);
  }

  _pumpDirectSendQueue(peer) {
    if (!peer || peer.superseded || !peer.dc || peer.dc.readyState !== "open") {
      if (peer?.dcSendTimer) {
        clearTimeout(peer.dcSendTimer);
        peer.dcSendTimer = null;
      }
      if (peer?.dcSendQueue) peer.dcSendQueue.length = 0;
      return;
    }
    if (peer.dcSendTimer) {
      clearTimeout(peer.dcSendTimer);
      peer.dcSendTimer = null;
    }
    const maxBuf = this.isVoiceChannelBusy() ? 65536 : 262144;
    while (peer.dcSendQueue.length > 0) {
      if ((peer.dc.bufferedAmount || 0) >= maxBuf) {
        peer.dcSendTimer = setTimeout(() => this._pumpDirectSendQueue(peer), 15);
        return;
      }
      const pkt = peer.dcSendQueue.shift();
      try {
        peer.dc.send(pkt);
        this.recordTopologyPacket(peer.peerId, "tx", "data", pkt.length);
      } catch (err) {
        this.addTelemetry("error", `Send failed to ${peer.peerId}: ${err.message}`);
        peer.dcSendQueue.length = 0;
        return;
      }
    }
  }

  /**
   * Voice-First Traffic Shaper for the low-priority `p2p-bulk` DataChannel (GIFs, videos, large frames).
   * - While voice is active: caps SCTP buffer to 24 KB, sends at most 1 × 16 KB chunk every 25 ms,
   *   and yields immediately whenever `p2p-voice` has queued bytes or `p2p-mesh` has pending control traffic.
   * - When voice is idle: opens up to 192 KB / 4 chunks per 8 ms for fast full-speed delivery.
   */
  _pumpBulkDirectSendQueue(peer) {
    if (!peer || peer.superseded) {
      if (peer?.bulkSendTimer) {
        clearTimeout(peer.bulkSendTimer);
        peer.bulkSendTimer = null;
      }
      if (peer?.bulkSendQueue) peer.bulkSendQueue.length = 0;
      return;
    }
    if (peer.bulkSendTimer) {
      clearTimeout(peer.bulkSendTimer);
      peer.bulkSendTimer = null;
    }
    const q = peer.bulkSendQueue;
    if (!q || q.length === 0) return;

    const useBulkDc = Boolean(peer.bulkDc && peer.bulkDc.readyState === "open");
    const ch = useBulkDc ? peer.bulkDc : peer.dc;
    if (!ch || ch.readyState !== "open") {
      q.length = 0;
      return;
    }

    const voiceBusy = this.isVoiceChannelBusy();
    const maxBuf = voiceBusy ? BULK_DIRECT_MAX_BUFFERED_VOICE : BULK_DIRECT_MAX_BUFFERED_IDLE;
    const maxPerTick = voiceBusy ? 1 : 4;
    const tickMs = voiceBusy ? BULK_DIRECT_TICK_VOICE_MS : BULK_DIRECT_TICK_IDLE_MS;

    try {
      ch.bufferedAmountLowThreshold = voiceBusy ? 8192 : 65536;
    } catch {
      // ignore if unsupported
    }

    // Strict voice-first preemption: yield immediately if high-prio voice or medium-prio chat has queued bytes
    if (voiceBusy) {
      const voiceBacklog = peer.voiceDc && (peer.voiceDc.bufferedAmount || 0) > 0;
      const ctrlBacklog = peer.dc && peer.dc !== ch && (peer.dc.bufferedAmount || 0) > 8192;
      if (voiceBacklog || ctrlBacklog) {
        peer.bulkSendTimer = setTimeout(() => this._pumpBulkDirectSendQueue(peer), 20);
        return;
      }
    }

    let sentThisTick = 0;
    while (q.length > 0 && sentThisTick < maxPerTick) {
      if ((ch.bufferedAmount || 0) >= maxBuf) {
        peer.bulkSendTimer = setTimeout(() => this._pumpBulkDirectSendQueue(peer), voiceBusy ? 25 : 12);
        return;
      }
      const head = q[0];
      let pkt;
      if (typeof head === "string") {
        pkt = q.shift();
      } else {
        // Lazy on-demand 16 KB chunk slicing (zero upfront multi-MB burst allocation;
        // interior e2ee ciphertext chunks are pure base64url ASCII so skip JSON.stringify escaping)
        const start = head.i * DC_CHUNK_SIZE;
        const end = Math.min(head.frameStr.length, start + DC_CHUNK_SIZE);
        const d = head.frameStr.slice(start, end);
        if (head.pureB64Start > 0 && start >= head.pureB64Start && end <= head.pureB64End) {
          pkt = `{"kind":"dc_chunk","id":${head.id},"i":${head.i},"n":${head.total},"d":"${d}"}`;
        } else {
          pkt = JSON.stringify({ kind: "dc_chunk", id: head.id, i: head.i, n: head.total, d });
        }
        head.i += 1;
        if (head.i >= head.total) {
          q.shift();
        }
      }
      try {
        ch.send(pkt);
        this.recordTopologyPacket(peer.peerId, "tx", useBulkDc ? "bulk" : "data", pkt.length);
        sentThisTick += 1;
      } catch (err) {
        this.addTelemetry("error", `Bulk send failed to ${peer.peerId}: ${err.message}`);
        q.length = 0;
        return;
      }
    }

    if (q.length > 0) {
      peer.bulkSendTimer = setTimeout(() => this._pumpBulkDirectSendQueue(peer), tickMs);
    }
  }

  _deliverWireFrameSync(peerEntry, peerId, frameStr, silentOnError = false) {
    try {
      const res = this.wasm.wireMessage(peerId, frameStr, Date.now());
      this.status = res.status;
      const liveInfo = this.status.peers.find((p) => p.peerId === peerId);
      if (liveInfo && liveInfo.authorName && liveInfo.authorName !== peerEntry.authorName) {
        peerEntry.authorName = liveInfo.authorName;
      }
      this.executeActions(res.actions);
      const onlyMsgUpdate =
        Array.isArray(res.actions) &&
        res.actions.some((a) => a.action === "log_updated") &&
        res.actions.every(
          (a) => a.action === "log_updated" || a.action === "send_wire" || a.action === "telemetry"
        );
      if (onlyMsgUpdate) {
        this.renderMessageUpdate();
      } else {
        this.renderAll();
      }
    } catch (err) {
      if (!silentOnError) {
        this.addTelemetry("error", `E2EE wire rejection from ${peerId}: ${err.message}`);
        this.renderStats();
      }
    }
  }

  async _deliverWireFrameBulkOffThread(peerEntry, peerId, frameStr, silentOnError = false) {
    const seqMatch = /"s"\s*:\s*(\d+)/.exec(frameStr.slice(0, 128));
    if (!seqMatch) {
      this._deliverWireFrameSync(peerEntry, peerId, frameStr, silentOnError);
      return;
    }
    const seq = Number(seqMatch[1]);
    let rxPrep;
    try {
      rxPrep = this.wasm.call({
        cmd: "prepare_bulk_rx",
        fromPeer: peerId,
        seq,
      });
    } catch (err) {
      if (!silentOnError) {
        this.addTelemetry("error", `E2EE wire rejection from ${peerId}: ${err.message}`);
        this.renderStats();
      }
      return;
    }

    try {
      const opened = await this.wasm.openBulkAsync(
        {
          fromPeer: peerId,
          selfPeerId: rxPrep.selfPeerId,
          rxKey: rxPrep.rxKey,
          logKey: rxPrep.logKey,
        },
        frameStr
      );

      if (opened.kind !== "msg") {
        // SyncBatch / msg-delete / bot-update / control frames fall back cleanly to MeshNode
        this._deliverWireFrameSync(peerEntry, peerId, frameStr, silentOnError);
        return;
      }

      const mr = opened.metaResp;
      const commitRes = this.wasm.commitBulkRx(
        {
          fromPeer: peerId,
          seq: mr.seq,
          ttl: mr.ttl,
          path: mr.path,
          meta: mr.meta,
          sealedNonce: mr.sealedNonce,
        },
        opened.sealedCt
      );
      this.status = commitRes.status;

      if (commitRes.inserted) {
        const msgObj = JSON.parse(opened.msgJsonStr);
        this._insertLocalMessageOrdered(msgObj);
        setTimeout(() => this.renderMessageUpdate(), 0);
      } else {
        this.renderStats();
      }

      // Multi-hop 3+ peer gossip forwarding also seals off the main thread!
      if (Array.isArray(commitRes.forwardTargets) && commitRes.forwardTargets.length > 0) {
        const fwdPeerRefs = new Map();
        for (const t of commitRes.forwardTargets) {
          const p = this.directPeers.get(t.peerId);
          if (p) fwdPeerRefs.set(t.peerId, p);
        }
        const fwdFrames = await this.wasm.sealForwardAsync(
          {
            selfPeerId: rxPrep.selfPeerId,
            origin: mr.origin,
            ttl: commitRes.nextTtl,
            path: commitRes.nextPath,
            recordMeta: {
              id: mr.meta.id,
              lamport: mr.meta.lamport,
              ts: mr.meta.ts,
              nonce: mr.sealedNonce,
            },
            targets: commitRes.forwardTargets,
          },
          opened.sealedCt
        );
        for (const wf of fwdFrames) {
          const expected = fwdPeerRefs.get(wf.peerId);
          const live = this.directPeers.get(wf.peerId);
          if (live && live === expected && live.dc?.readyState === "open") {
            this._sendWireFrameToPeer(live, wf.frame);
          }
        }
      }
    } catch (err) {
      if (!silentOnError) {
        this.addTelemetry("error", `E2EE wire rejection from ${peerId}: ${err.message}`);
        this.renderStats();
      }
    }
  }

  _deliverWireFrameSmart(peerEntry, peerId, frameStr, silentOnError = false) {
    if (
      frameStr &&
      frameStr.length > BULK_FRAME_THRESHOLD &&
      this.wasm &&
      this.wasm.hasBulkWorker()
    ) {
      this._deliverWireFrameBulkOffThread(peerEntry, peerId, frameStr, silentOnError);
      return;
    }
    this._deliverWireFrameSync(peerEntry, peerId, frameStr, silentOnError);
  }

  _sendWireFrameToPeer(peer, frameStr) {
    if (!peer || !peer.dc || peer.dc.readyState !== "open") return;
    const isBulk = frameStr.length > BULK_FRAME_THRESHOLD;

    if (peer.transport === "relay") {
      try {
        if (isBulk && peer.bulkDc && peer.bulkDc.readyState === "open") {
          peer.bulkDc.send(frameStr);
        } else {
          peer.dc.send(frameStr);
          this.recordTopologyPacket(peer.peerId, "tx", "data", frameStr.length);
        }
      } catch (err) {
        this.addTelemetry("error", `Send failed to ${peer.peerId}: ${err.message}`);
      }
      return;
    }

    // Large frames (GIFs, images, videos, big sync batches > 16 KB) ALWAYS go over the low-prio bulk queue
    if (isBulk) {
      const bq = peer.bulkSendQueue || (peer.bulkSendQueue = []);
      const id = (this.dcChunkSeq = (this.dcChunkSeq + 1) >>> 0) || 1;
      const total = Math.ceil(frameStr.length / DC_CHUNK_SIZE);
      let pureB64Start = 0;
      let pureB64End = 0;
      if (frameStr.startsWith('{"kind":"e2ee",') && frameStr.endsWith('"}')) {
        const cPos = frameStr.indexOf(',"c":"', 20);
        if (cPos > 0 && cPos < 160) {
          pureB64Start = cPos + 6;
          pureB64End = frameStr.length - 2;
        }
      }
      bq.push({ id, frameStr, i: 0, total, pureB64Start, pureB64End });
      this._pumpBulkDirectSendQueue(peer);
      return;
    }

    // Small chat / presence / sync / keepalive frames go straight on medium-prio p2p-mesh (never blocked by GIFs)
    const q = peer.dcSendQueue || (peer.dcSendQueue = []);
    const fastBufLimit = this.isVoiceChannelBusy() ? 32768 : 131072;
    if (q.length === 0 && (peer.dc.bufferedAmount || 0) < fastBufLimit) {
      try {
        peer.dc.send(frameStr);
        this.recordTopologyPacket(peer.peerId, "tx", "data", frameStr.length);
      } catch (err) {
        this.addTelemetry("error", `Send failed to ${peer.peerId}: ${err.message}`);
      }
      return;
    }

    q.push(frameStr);
    this._pumpDirectSendQueue(peer);
  }

  executeActions(actions, opts = {}) {
    if (!Array.isArray(actions)) return;
    let logChanged = false;

    for (const act of actions) {
      switch (act.action) {
        case "send_wire": {
          const peer = this.directPeers.get(act.peerId);
          if (peer && peer.dc && peer.dc.readyState === "open") {
            this._sendWireFrameToPeer(peer, act.frame);
          }
          break;
        }
        case "log_updated": {
          logChanged = true;
          break;
        }
        case "auto_mesh_create_offer": {
          this.startRelayedOffer(act.targetPeerId, act.targetName, act.targetPubKey, act.viaPeerId);
          break;
        }
        case "auto_mesh_accept_offer": {
          this.acceptRelayedOffer(
            act.fromPeerId,
            act.fromName,
            act.fromPubKey,
            act.viaPeerId,
            act.sdp
          );
          break;
        }
        case "auto_mesh_apply_answer": {
          this.applyRelayedAnswer(act.fromPeerId, act.sdp);
          break;
        }
        case "auto_mesh_add_ice": {
          this.applyRelayedIce(act.fromPeerId, act.candidate);
          break;
        }
        case "bot_action": {
          this.addTelemetry(
            "bot_action",
            `${act.fromName || act.fromPeerId} clicked "${act.label || act.actionId}"`
          );
          break;
        }
        case "media_sync": {
          if (act.state) {
            this.handleIncomingMediaSync(act.state);
          }
          break;
        }
        case "peer_colors": {
          if (act.colors && typeof act.colors === "object") {
            if (this._syncPeerColorsFromMap(act.colors)) {
              this._refreshPeerColorDom();
            }
          }
          break;
        }
        case "telemetry": {
          this.addTelemetry(act.event, act.detail);
          break;
        }
        default:
          break;
      }
    }

    if (logChanged && !opts.skipLogRefresh) {
      this.refreshLogFromWasm();
    }
  }

  _sendLocalIce(targetPeerId, viaPeerId, candidateJson) {
    try {
      const res = this.wasm.call({
        cmd: "send_relay_signal",
        toPeerId: targetPeerId,
        signalType: "ice",
        candidate: candidateJson,
        viaPeerId,
      });
      this.status = res.status;
      this.executeActions(res.actions);
    } catch {
      // ignore if relay closed
    }
  }

  async startRelayedOffer(targetPeerId, targetName, targetPubKey, viaPeerId) {
    if (
      this.directPeers.has(targetPeerId) ||
      this.relayPeers.has(targetPeerId) ||
      this.roomDialing.has(targetPeerId) ||
      this.localDialing.has(targetPeerId)
    ) {
      return;
    }
    try {
      const pc = this.createPeerConnection();
      const { dc, voiceDc, bulkDc } = this.createPeerDataChannels(pc);
      const early = this.earlyRelayIce.get(targetPeerId) || [];
      this.earlyRelayIce.delete(targetPeerId);
      const entry = {
        peerId: targetPeerId,
        authorName: targetName || "Peer",
        peerPubKey: targetPubKey,
        viaPeerId,
        pc,
        dc,
        voiceDc,
        bulkDc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
      };
      this.relayPeers.set(targetPeerId, entry);
      this.attachVoiceDataChannel(targetPeerId, voiceDc);
      this.attachBulkDataChannel(targetPeerId, bulkDc);
      this.attachDataChannel(pc, dc, targetPeerId, targetName, targetPubKey, true, viaPeerId, false);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const candJson = ev.candidate.toJSON();
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        this._sendLocalIce(targetPeerId, viaPeerId, candJson);
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
      this.executeActions(res.actions);

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        this._sendLocalIce(targetPeerId, viaPeerId, entry.localIceQueue.shift());
      }
      this.renderAll();
    } catch (err) {
      this.relayPeers.delete(targetPeerId);
      this.addTelemetry("error", `Auto-mesh offer to ${targetPeerId} failed: ${err.message}`);
    }
  }

  async acceptRelayedOffer(fromPeerId, fromName, fromPubKey, viaPeerId, sdp) {
    if (this.directPeers.has(fromPeerId)) return;
    const prev = this.relayPeers.get(fromPeerId);
    if (prev) {
      try {
        prev.pc.close();
      } catch {
        // ignore
      }
      this.relayPeers.delete(fromPeerId);
    }

    try {
      const pc = this.createPeerConnection();
      const early = this.earlyRelayIce.get(fromPeerId) || [];
      this.earlyRelayIce.delete(fromPeerId);
      const entry = {
        peerId: fromPeerId,
        authorName: fromName || "Peer",
        peerPubKey: fromPubKey,
        viaPeerId,
        pc,
        dc: null,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
      };
      this.relayPeers.set(fromPeerId, entry);

      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "p2p-voice") {
          this.attachVoiceDataChannel(fromPeerId, ev.channel);
          return;
        }
        if (ev.channel.label === "p2p-bulk") {
          this.attachBulkDataChannel(fromPeerId, ev.channel);
          return;
        }
        entry.dc = ev.channel;
        this.attachDataChannel(
          pc,
          ev.channel,
          fromPeerId,
          fromName,
          fromPubKey,
          true,
          viaPeerId,
          false
        );
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const candJson = ev.candidate.toJSON();
        if (!entry.sdpSent) {
          entry.localIceQueue.push(candJson);
          return;
        }
        this._sendLocalIce(fromPeerId, viaPeerId, candJson);
      };

      await pc.setRemoteDescription({ type: "offer", sdp });
      entry.remoteDescSet = true;
      await this.flushPendingIce(entry);

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
      this.executeActions(res.actions);

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        this._sendLocalIce(fromPeerId, viaPeerId, entry.localIceQueue.shift());
      }
      this.renderAll();
    } catch (err) {
      this.relayPeers.delete(fromPeerId);
      this.addTelemetry("error", `Auto-mesh answer for ${fromPeerId} failed: ${err.message}`);
    }
  }

  async applyRelayedAnswer(fromPeerId, sdp) {
    const entry = this.relayPeers.get(fromPeerId);
    if (!entry) return;
    try {
      if (entry.pc.signalingState === "have-local-offer") {
        await entry.pc.setRemoteDescription({ type: "answer", sdp });
        entry.remoteDescSet = true;
        await this.flushPendingIce(entry);
      }
    } catch (err) {
      this.addTelemetry("error", `Auto-mesh apply answer from ${fromPeerId} failed: ${err.message}`);
    }
  }

  async applyRelayedIce(fromPeerId, candidate) {
    const entry = this.relayPeers.get(fromPeerId);
    if (!entry) {
      const direct = this.directPeers.get(fromPeerId);
      if (direct && direct.pc) {
        try {
          await direct.pc.addIceCandidate(candidate);
        } catch {
          // ignore late ICE
        }
        return;
      }
      const list = this.earlyRelayIce.get(fromPeerId) || [];
      list.push(candidate);
      this.earlyRelayIce.set(fromPeerId, list);
      return;
    }
    if (!entry.remoteDescSet) {
      entry.pendingIce.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // ignore benign ICE error
    }
  }

  async flushPendingIce(entry) {
    while (entry.pendingIce.length > 0) {
      const cand = entry.pendingIce.shift();
      try {
        await entry.pc.addIceCandidate(cand);
      } catch {
        // ignore
      }
    }
  }

  /* ================= Synced Peer Color Registry ================= */

  _syncPeerColorsFromMap(colorsObj) {
    if (!colorsObj || typeof colorsObj !== "object") return false;
    const entries = Object.entries(colorsObj);
    let changed = entries.length !== this.peerColors.size;
    if (!changed) {
      for (const [pid, idx] of entries) {
        if (this.peerColors.get(pid) !== idx) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return false;
    this.peerColors.clear();
    for (const [pid, idx] of entries) {
      if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0) {
        this.peerColors.set(pid, idx);
      }
    }
    return true;
  }

  _syncPeerColorsFromStatus() {
    if (!this.status || !this.status.peerColors) return false;
    return this._syncPeerColorsFromMap(this.status.peerColors);
  }

  getPeerColorIndex(peerId) {
    if (peerId && this.peerColors.has(peerId)) {
      return this.peerColors.get(peerId);
    }
    if (
      peerId &&
      this.status &&
      this.status.peerColors &&
      typeof this.status.peerColors[peerId] === "number"
    ) {
      return this.status.peerColors[peerId];
    }
    return fallbackPeerColorIndex(peerId);
  }

  getPeerColorSpec(peerId) {
    return colorSpecForIndex(this.getPeerColorIndex(peerId));
  }

  _refreshPeerColorDom() {
    if (!this.status) return;
    // 1. Update top-bar NAME tag to match self's synced room color (default Mint in Lobby)
    const nameTag = document.querySelector(".name-hero-tag");
    if (nameTag) {
      const inSession = Boolean(this.activeRoom || (this.status.peers && this.status.peers.length > 0));
      const selfSpec = inSession
        ? this.getPeerColorSpec(this.status.peerId)
        : colorSpecForIndex(0);
      applyPeerColorToElement(nameTag, selfSpec);
    }

    // 2. Update all existing chat message stripes & editor swatches in place (never rebuilds video/GIF DOM nodes)
    const logFeed = this.el["log-feed"];
    if (logFeed) {
      for (const stripe of logFeed.querySelectorAll(".msg-stripe[data-msg-author]")) {
        const authorId = stripe.getAttribute("data-msg-author");
        if (authorId) {
          applyPeerColorToElement(stripe, this.getPeerColorSpec(authorId));
        }
      }
      for (const sw of logFeed.querySelectorAll(".msg-editor-swatch[data-peer-color-id]")) {
        const pid = sw.getAttribute("data-peer-color-id");
        if (pid) {
          applyPeerColorToElement(sw, this.getPeerColorSpec(pid));
        }
      }
    }

    // 3. Update active voice tiles in place without losing slider focus or interrupting audio
    const voiceList = this.el["voice-participant-list"];
    if (voiceList) {
      for (const card of voiceList.querySelectorAll(".voice-card[data-voice-row]")) {
        const rowKey = card.getAttribute("data-voice-row");
        if (!rowKey) continue;
        const pid = rowKey === "self" ? this.status.peerId : rowKey;
        applyPeerColorToElement(card, this.getPeerColorSpec(pid));
      }
    }

    // 4. Update Advanced Peer List color swatches in place
    const peerList = this.el["peer-list"];
    if (peerList) {
      for (const swatch of peerList.querySelectorAll(".peer-color-swatch[data-peer-color-id]")) {
        const pid = swatch.getAttribute("data-peer-color-id");
        if (pid) {
          applyPeerColorToElement(swatch, this.getPeerColorSpec(pid));
        }
      }
    }
  }

  /* ================= Rendering ================= */

  renderAll() {
    const colorsChanged = this._syncPeerColorsFromStatus();
    this.syncLayoutAttributes();
    this.renderHeader();
    this.renderRoomCard();
    this.renderWizard();
    this.renderConnectBanners();
    this.renderVoicePanel();
    this.renderPeers();
    this.renderTopology();
    this.renderStats();
    this.renderTypeFilterOptions();
    this.renderLog();
    if (colorsChanged) {
      this._refreshPeerColorDom();
    }
  }

  /**
   * Fast-path render for chat/GIF/video messages: skips full SVG topology / voice / wizard
   * rebuilds so incoming/outgoing media paints in ~1-3 ms without perturbing live audio.
   */
  renderMessageUpdate() {
    const colorsChanged = this._syncPeerColorsFromStatus();
    this.renderStats();
    this.renderTypeFilterOptions();
    this.renderLog();
    if (colorsChanged) {
      this._refreshPeerColorDom();
    }
  }

  buildBotCliCommand() {
    const roomUrl = this.activeRoom?.url || "<paste-room-link>";
    const passFlag = this.activeRoom?.encrypted ? ' --passphrase "<room-passphrase>"' : "";
    return `node bot/bridge.mjs --room "${roomUrl}" --name "MyBot" --port 8765${passFlag}`;
  }

  renderRoomCard() {
    const isActive = Boolean(this.activeRoom);
    const peerCount = this.status?.peers?.length || 0;
    const relayState = this.roomRelayStatus?.state || "connecting";
    const relayCount = this.roomRelayStatus?.connectedCount || 0;

    if (this.el["bot-cli-command"]) {
      this.el["bot-cli-command"].value = this.buildBotCliCommand();
    }

    let badgeText = "Connecting…";
    let badgeClass = "badge pending";
    let statusTitle = "Connecting to room…";
    let isLive = false;
    if (peerCount > 0) {
      badgeText = `Live · ${peerCount} ${peerCount === 1 ? "peer" : "peers"}`;
      badgeClass = "badge auto";
      statusTitle = `Room online — ${peerCount} ${peerCount === 1 ? "peer" : "peers"} connected`;
      isLive = true;
    } else if (isActive && relayState === "live" && relayCount > 0) {
      badgeText = "Ready";
      badgeClass = "badge auto";
      statusTitle = "Room ready — waiting for peers";
      isLive = true;
    }

    // Update Simple Mode architectural room ribbon
    if (this.el["simple-room-bar"]) {
      const displayName = isActive
        ? this.activeRoom.name || "Shared Room"
        : this.status?.room && this.status.room !== "mesh-main" && this.status.room !== "default"
          ? this.status.room
          : "Direct Room";
      this.el["simple-room-name"].textContent = displayName;
      this.el["simple-room-badge"].textContent = badgeText;
      this.el["simple-room-badge"].className = badgeClass;
      if (this.el["simple-room-status-wrap"]) {
        this.el["simple-room-status-wrap"].classList.toggle("is-live", isLive);
        this.el["simple-room-status-wrap"].title = statusTitle;
        this.el["simple-room-status-wrap"].setAttribute("aria-label", statusTitle);
      }
      this.el["btn-simple-copy-link"].classList.toggle("hidden", !isActive);
    }

    this.renderSavedRooms();

    if (!this.el["room-link-card"]) return;
    this.el["room-link-card"].classList.toggle("is-active", isActive);
    this.el["room-link-setup"].classList.toggle("hidden", isActive);
    this.el["room-link-active"].classList.toggle("hidden", !isActive);

    if (!isActive) return;

    this.el["room-active-name"].textContent = this.activeRoom.name || "Shared Room";
    this.el["room-link-output"].value = this.activeRoom.url;
    this.el["btn-room-share"].classList.toggle("hidden", typeof navigator.share !== "function");

    const badge = this.el["room-relay-badge"];
    badge.textContent = badgeText;
    badge.className = badgeClass;

    if (peerCount > 0) {
      this.el["room-active-hint"].textContent =
        "Share this link anytime — new people who open it join this room automatically.";
    } else if (this.activeRoom.encrypted) {
      this.el["room-active-hint"].textContent =
        "Passphrase-protected room ready. Share this link and your passphrase — anyone who opens it joins automatically.";
    } else {
      this.el["room-active-hint"].textContent =
        "You're the first one here. Share this link — everyone who opens it will join you automatically.";
    }
  }

  renderHeader() {
    if (!this.status) return;
    this._syncPeerColorsFromStatus();
    const nameTag = document.querySelector(".name-hero-tag");
    if (nameTag) {
      const inSession = Boolean(this.activeRoom || (this.status.peers && this.status.peers.length > 0));
      applyPeerColorToElement(
        nameTag,
        inSession ? this.getPeerColorSpec(this.status.peerId) : colorSpecForIndex(0)
      );
    }
    this.el["peer-id-display"].textContent = this.status.peerId;
    this.el["lamport-display"].textContent = String(this.status.lamport);
    this.el["peer-count-display"].textContent = String(this.status.peers.length);
    this.el["log-count-display"].textContent = String(this.status.logCount);
    this.el["next-lamport-preview"].textContent =
      this.composerMode === "chat"
        ? "URLs & images supported"
        : `next lamport: ${this.status.lamport + 1}`;

    if (this.status.e2ee) {
      const shortFp = this.status.e2ee.keyFingerprint.slice(0, 9);
      this.el["key-fp-display"].textContent = shortFp;
      this.el["key-fp-display"].parentElement.title =
        `End-to-End Encrypted Room Key · Fingerprint: ${this.status.e2ee.keyFingerprint}`;
      this.el["e2ee-mode-label"].textContent = this.status.e2ee.passphraseMode
        ? `Passphrase · ${shortFp}`
        : `Auto · ${shortFp}`;
    }

    const isOnline = this.status.peers.length > 0;
    this.el["mesh-status-chip"].classList.toggle("live", isOnline);
    this.el["mesh-status-dot"].classList.toggle("online", isOnline);

    const remoteInVoice = (this.status.peers || []).filter((p) => p.inVoice).length;
    const totalInVoice = remoteInVoice + (this.voice.inVoice ? 1 : 0);
    this.el["voice-header-chip"].classList.toggle("hidden", totalInVoice === 0);
    this.el["voice-header-chip"].classList.toggle("live", this.voice.inVoice);
    this.el["voice-header-count"].textContent = String(totalInVoice);
  }

  renderConnectBanners() {
    if (!this.status) return;

    const localTarget =
      !this.activeRoom && this.directPeers.size === 0 && this.logMessages.length === 0
        ? this.discoveredLocalMeshes.values().next().value
        : null;
    if (localTarget) {
      this.el["local-mesh-banner"].classList.remove("hidden");
      this.el["local-mesh-fp"].textContent = `Key ${localTarget.keyFingerprint.slice(0, 9)}`;
      this.el["local-mesh-desc"].textContent =
        `${localTarget.authorName} is open in another tab (${localTarget.logCount} messages). Connect directly in 1 click.`;
      this.el["btn-join-local-mesh"].textContent = `Join ${localTarget.authorName}`;
    } else {
      this.el["local-mesh-banner"].classList.add("hidden");
    }
  }

  renderVoicePanel(forceRebuild = false) {
    if (!this.status) return;
    const peersInVoice = (this.status.peers || []).filter((p) => p.inVoice);
    const peerMap = new Map(peersInVoice.map((p) => [p.peerId, p]));
    const totalInVoice = peersInVoice.length + (this.voice.inVoice ? 1 : 0);

    // Maintain stable participant order so existing cards stay put and joining adds you cleanly
    const activeKeys = new Set(peerMap.keys());
    if (this.voice.inVoice) {
      activeKeys.add("self");
    }
    const ordered = this.voice.joinOrder.filter((k) => activeKeys.has(k));
    const sortedRemoteIds = Array.from(peerMap.keys()).sort();
    for (const pid of sortedRemoteIds) {
      if (!ordered.includes(pid)) {
        ordered.push(pid);
      }
    }
    if (this.voice.inVoice && !ordered.includes("self")) {
      ordered.push("self");
    }
    this.voice.joinOrder = ordered;

    this.el["voice-panel"].classList.toggle("has-participants", totalInVoice > 0);
    this.el["voice-panel"].classList.toggle("is-live", this.voice.inVoice);

    const badge = this.el["voice-status-badge"];
    if (totalInVoice === 0) {
      badge.textContent = "Empty";
      badge.className = "badge";
    } else if (this.voice.inVoice) {
      badge.textContent = `${totalInVoice} in call`;
      badge.className = "badge auto";
    } else {
      badge.textContent = `${totalInVoice} in channel`;
      badge.className = "badge auto";
    }

    this.el["voice-join-card"].classList.toggle("hidden", this.voice.inVoice);
    this.el["voice-participant-list"].classList.toggle("hidden", totalInVoice === 0);

    if (this.voice.inVoice) {
      if (this.el["voice-join-hint"]) {
        this.el["voice-join-hint"].classList.add("hidden");
      }
      if (this.status.stats) {
        this.el["voice-packet-stats"].textContent =
          `TX ${this.status.stats.voicePacketsSent} / RX ${this.status.stats.voicePacketsReceived}`;
      }
    } else if (totalInVoice > 0) {
      if (this.el["voice-join-hint"]) {
        this.el["voice-join-hint"].classList.remove("hidden");
      }
      this.el["voice-packet-stats"].textContent = "";
    } else {
      if (this.el["voice-join-hint"]) {
        this.el["voice-join-hint"].classList.add("hidden");
      }
      this.el["voice-packet-stats"].textContent = "";
    }

    if (totalInVoice === 0) {
      this.voice.lastRosterKey = "";
      this.voice.renderedKeys.clear();
      this.voice.cardCache.clear();
      this.el["voice-participant-list"].innerHTML = "";
      return;
    }

    const selfColorSpec = this.getPeerColorSpec(this.status.peerId);
    const rosterKey = JSON.stringify({
      inVoice: this.voice.inVoice,
      order: ordered,
      selfId: this.status.peerId,
      selfName: this.status.authorName,
      selfColor: selfColorSpec.idx,
      muted: this.voice.muted,
      listenOnly: this.voice.listenOnly,
      deafened: this.voice.deafened,
      peers: ordered
        .filter((k) => k !== "self")
        .map((id) => {
          const p = peerMap.get(id);
          const mx = this.voice.peerMixers.get(id);
          return [
            id,
            p ? p.authorName : "",
            p ? p.voiceMuted : false,
            mx ? mx.muted : false,
            Boolean(p && p.isBot),
            this.getPeerColorIndex(id),
          ];
        }),
    });

    if (!forceRebuild && rosterKey === this.voice.lastRosterKey) {
      if (this.advancedMode) {
        this.updateVoiceAdvancedStats();
      }
      return;
    }
    this.voice.lastRosterKey = rosterKey;

    const prevRendered = this.voice.renderedKeys;
    const eqBarsHtml = Array.from(
      { length: VOICE_EQ_WEIGHTS.length },
      () => '<span class="voice-eq-bar"></span>'
    ).join("");

    const items = [];
    for (const key of ordered) {
      const enteringClass = prevRendered.has(key) ? "" : " is-entering";

      if (key === "self") {
        const selfTheme = `${selfColorSpec.className}${selfColorSpec.extraClass}`;
        const selfStyle = selfColorSpec.styleAttr ? ` style="${selfColorSpec.styleAttr}"` : "";
        const selfInitials = escapeHtml(avatarInitials(this.status.authorName));
        const selfMuted = this.voice.muted || this.voice.listenOnly;
        const selfStateText = this.voice.listenOnly
          ? "Listen-Only"
          : this.voice.muted
            ? "Muted"
            : "Live";
        const muteLabel = this.voice.listenOnly
          ? "Listen-only mode"
          : this.voice.muted
            ? "Unmute microphone"
            : "Mute microphone";
        const deafenLabel = this.voice.deafened ? "Undeafen audio" : "Deafen audio";

        items.push(`
          <li class="voice-card is-self ${selfTheme}${selfMuted ? " is-color-muted" : ""}${enteringClass}" data-voice-row="self"${selfStyle}>
            <div class="voice-tile-top">
              <span class="tile-mono">${selfInitials}</span>
              <span class="tile-status-tag">${SPEAK_STAR_SVG}<span data-voice-state="self">${selfStateText}</span></span>
            </div>
            <div class="tile-lower">
              <div class="voice-tile-mid">
                <span class="voice-card-name">${escapeHtml(this.status.authorName)}</span>
                <span class="voice-you-pill">You</span>
              </div>
              <div class="tile-control-slot">
                <div class="self-card-controls">
                  <div class="self-audio-group">
                    <button
                      type="button"
                      id="btn-voice-mute"
                      class="self-ctrl-icon${selfMuted ? " is-toggled" : ""}"
                      aria-pressed="${selfMuted ? "true" : "false"}"
                      aria-label="${muteLabel}"
                      title="${muteLabel}"
                    >${selfMuted ? MIC_OFF_SVG : MIC_ON_SVG}</button>
                    <button
                      type="button"
                      id="btn-voice-deafen"
                      class="self-ctrl-icon${this.voice.deafened ? " is-toggled" : ""}"
                      aria-pressed="${this.voice.deafened ? "true" : "false"}"
                      aria-label="${deafenLabel}"
                      title="${deafenLabel}"
                    >${this.voice.deafened ? HEAD_OFF_SVG : HEAD_ON_SVG}</button>
                  </div>
                  <button
                    type="button"
                    id="btn-voice-leave"
                    class="self-ctrl-leave"
                    title="Leave voice channel (stays in room)"
                  >${EXIT_VOICE_SVG}<span>Leave Voice</span></button>
                </div>
              </div>
              <div class="voice-eq" aria-hidden="true">${eqBarsHtml}</div>
              <div class="voice-adv-stats advanced-only" data-voice-adv-stats="self"></div>
            </div>
          </li>
        `);
        continue;
      }

      const p = peerMap.get(key);
      if (!p) continue;
      const peerColorSpec = this.getPeerColorSpec(p.peerId);
      const peerTheme = `${peerColorSpec.className}${peerColorSpec.extraClass}`;
      const peerStyle = peerColorSpec.styleAttr ? ` style="${peerColorSpec.styleAttr}"` : "";
      const initials = escapeHtml(avatarInitials(p.authorName));
      const botPill = p.isBot ? '<span class="voice-bot-pill">BOT</span>' : "";

      if (this.voice.inVoice) {
        const mixer = this.voice.peerMixers.get(p.peerId);
        const localMuted = Boolean(mixer && mixer.muted);
        const volPct = mixer ? Math.round(mixer.volume * 100) : 100;
        const peerColorMuted = this.voice.deafened || localMuted || Boolean(p.voiceMuted);
        const peerStateText = this.voice.deafened
          ? "Deafened"
          : p.voiceMuted || localMuted
            ? "Muted"
            : "Live";

        items.push(`
          <li class="voice-card ${peerTheme}${peerColorMuted ? " is-color-muted" : ""}${enteringClass}" data-voice-row="${escapeHtml(p.peerId)}"${peerStyle}>
            <div class="voice-tile-top">
              <span class="tile-mono">${initials}</span>
              <span class="tile-status-tag">${SPEAK_STAR_SVG}<span data-voice-state="${escapeHtml(p.peerId)}">${peerStateText}</span></span>
            </div>
            <div class="tile-lower">
              <div class="voice-tile-mid">
                <span class="voice-card-name">${escapeHtml(p.authorName)}</span>
                ${botPill}
              </div>
              <div class="tile-control-slot">
                <div class="voice-peer-mixer">
                  <button
                    type="button"
                    class="tile-mute-btn${localMuted ? " is-muted" : ""}"
                    data-peer-voice-mute="${escapeHtml(p.peerId)}"
                  >${localMuted ? "Unmute" : "Mute"}</button>
                  <input
                    type="range"
                    class="voice-volume-slider"
                    min="0"
                    max="150"
                    value="${volPct}"
                    data-peer-voice-vol="${escapeHtml(p.peerId)}"
                    aria-label="Volume for ${escapeHtml(p.authorName)}"
                  />
                </div>
              </div>
              <div class="voice-eq" aria-hidden="true">${eqBarsHtml}</div>
              <div class="voice-adv-stats advanced-only" data-voice-adv-stats="${escapeHtml(p.peerId)}"></div>
            </div>
          </li>
        `);
      } else {
        const previewStateText = p.voiceMuted ? "Muted" : "In Voice";
        items.push(`
          <li class="voice-card is-channel-preview ${peerTheme}${p.voiceMuted ? " is-color-muted" : ""}${enteringClass}" data-voice-row="${escapeHtml(p.peerId)}"${peerStyle}>
            <div class="voice-tile-top">
              <span class="tile-mono">${initials}</span>
              <span class="tile-status-tag">${SPEAK_STAR_SVG}<span data-voice-state="${escapeHtml(p.peerId)}">${previewStateText}</span></span>
            </div>
            <div class="tile-lower">
              <div class="voice-tile-mid">
                <span class="voice-card-name">${escapeHtml(p.authorName)}</span>
                ${botPill}
              </div>
              <div class="tile-control-slot">
                <span class="tile-prejoin-hint">Active in voice channel</span>
              </div>
              <div class="voice-eq${p.voiceMuted ? "" : " is-preview"}" aria-hidden="true">${eqBarsHtml}</div>
              <div class="voice-adv-stats advanced-only" data-voice-adv-stats="${escapeHtml(p.peerId)}"></div>
            </div>
          </li>
        `);
      }
    }

    this.voice.renderedKeys = new Set(ordered);
    const listEl = this.el["voice-participant-list"];
    listEl.innerHTML = items.join("");
    this.voice.cardCache.clear();
    for (const card of listEl.querySelectorAll("[data-voice-row]")) {
      const rowKey = card.getAttribute("data-voice-row");
      if (!rowKey) continue;
      const bars = Array.from(card.querySelectorAll(".voice-eq-bar"));
      this.voice.cardCache.set(rowKey, {
        card,
        stateEl: card.querySelector("[data-voice-state]"),
        advStatsEl: card.querySelector("[data-voice-adv-stats]"),
        lastAdvHtml: "",
        bars,
        lastSpeaking: false,
        lastLevelStr: "",
        lastStateText: "",
        lastBarH: new Int16Array(bars.length),
      });
    }

    if (this.voice.inVoice) {
      const selfMuteBtn = listEl.querySelector("#btn-voice-mute");
      if (selfMuteBtn) {
        selfMuteBtn.addEventListener("click", () => this.toggleVoiceMute());
      }
      const selfDeafBtn = listEl.querySelector("#btn-voice-deafen");
      if (selfDeafBtn) {
        selfDeafBtn.addEventListener("click", () => this.toggleVoiceDeafen());
      }
      const selfLeaveBtn = listEl.querySelector("#btn-voice-leave");
      if (selfLeaveBtn) {
        selfLeaveBtn.addEventListener("click", () => this.leaveVoiceChat());
      }
      for (const btn of listEl.querySelectorAll("[data-peer-voice-mute]")) {
        btn.addEventListener("click", () => this.togglePeerVoiceMute(btn.dataset.peerVoiceMute));
      }
      for (const slider of listEl.querySelectorAll("[data-peer-voice-vol]")) {
        slider.addEventListener("input", () => {
          this.setPeerVoiceVolume(slider.dataset.peerVoiceVol, Number(slider.value) / 100);
          if (this.advancedMode) {
            this.updateVoiceAdvancedStats();
          }
        });
      }
    }

    this._syncVoiceStatsCollapseUi();
    if (this.advancedMode) {
      this.updateVoiceAdvancedStats();
    }
  }

  _rmsToDbfs(rms) {
    if (!rms || rms <= 0) return null;
    const clamped = Math.min(32768, Math.max(1, rms));
    return Math.max(-60, Math.round(20 * Math.log10(clamped / 32768)));
  }

  _formatBytesCompact(bytes) {
    const b = Math.max(0, Number(bytes) || 0);
    if (b < 1024) return `${Math.round(b)}B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)}K`;
    return `${(b / 1048576).toFixed(1)}M`;
  }

  _buildSelfVoiceAdvStatsHtml(nowPerf) {
    const s = this.audioSettings;
    const ctx = this.voice.audioCtx;
    const presetLabel = String(s.preset || "voice").toUpperCase();
    const targetBitrate = this.voice.opusEncoderBitrate || this.computeDesiredOpusBitrate();
    const targetKbps = Math.round(targetBitrate / 1000);
    const codecLabel = this.voice.opusSupported ? `OPUS 48K · ${targetKbps}K` : "ADPCM 16K";

    let stateLabel = "OPEN";
    let stateTone = "is-ok";
    if (this.voice.listenOnly) {
      stateLabel = "LISTEN";
      stateTone = "is-muted";
    } else if (this.voice.muted) {
      stateLabel = "MUTED";
      stateTone = "is-bad";
    } else if (this.voice.gateClosed) {
      stateLabel = "GATED";
      stateTone = "is-warn";
    }

    const rawRms =
      this.voice.muted || this.voice.listenOnly
        ? 0
        : Math.round(this.voice.peakMicRms || this.voice.rawMicRms || this.voice.localRms || 0);
    const dbfs = this._rmsToDbfs(rawRms);
    const dbfsStr = dbfs === null ? "-∞" : `${dbfs}`;
    const barPct = dbfs === null ? 0 : Math.max(0, Math.min(100, Math.round(((dbfs + 60) / 60) * 100)));
    const gatePct = Number(s.noiseGate) || 0;
    const gateTickPct =
      gatePct > 0
        ? Math.max(
            2,
            Math.min(
              98,
              Math.round(
                ((Math.max(-60, 20 * Math.log10(((gatePct / 100) * 14000) / 32768)) + 60) / 60) * 100
              )
            )
          )
        : 0;
    const barTone =
      this.voice.muted || this.voice.listenOnly || this.voice.gateClosed
        ? "is-muted"
        : dbfs !== null && dbfs >= -3
          ? "is-bad"
          : "is-ok";

    const baseLatMs =
      ctx && typeof ctx.baseLatency === "number" && Number.isFinite(ctx.baseLatency)
        ? Math.round(ctx.baseLatency * 1000 * 10) / 10
        : null;
    const outLatMs =
      ctx && typeof ctx.outputLatency === "number" && Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0
        ? Math.round(ctx.outputLatency * 1000 * 10) / 10
        : null;
    const hwLatStr = `${baseLatMs !== null ? `${baseLatMs}ms` : "—"} · out ${outLatMs !== null ? `${outLatMs}ms` : "—"}`;

    const sampleRateKhz = ctx?.sampleRate ? (ctx.sampleRate / 1000).toFixed(1).replace(/\.0$/, "") : "48";
    const ctxState = ctx?.state || "idle";
    const txRate = this._computeRateWindow(this.voice.txWindow, nowPerf);
    this.voice.txKbps = txRate.kbps;
    this.voice.txPps = txRate.pps;

    const encQ = this.voice.opusEncoder ? Number(this.voice.opusEncoder.encodeQueueSize) || 0 : 0;
    const encTone = encQ > 1 || this.voice.txDropped > 0 ? "is-warn" : "";
    const stats = this.status?.stats || {};
    const txSentTotal = stats.voicePacketsSent || 0;
    const rxRecvTotal = stats.voicePacketsReceived || 0;
    const authFailures = stats.e2eeAuthFailures || 0;

    let maxVoiceBuf = 0;
    for (const vdc of this.voiceChannels.values()) {
      if (vdc && vdc.readyState === "open") {
        maxVoiceBuf = Math.max(maxVoiceBuf, Number(vdc.bufferedAmount) || 0);
      }
    }
    let maxBulkBuf = 0;
    for (const bdc of this.bulkChannels.values()) {
      if (bdc && bdc.readyState === "open") {
        maxBulkBuf = Math.max(maxBulkBuf, Number(bdc.bufferedAmount) || 0);
      }
    }
    const bufTone = maxVoiceBuf >= 8192 ? "is-warn" : "";

    const hpfStr = s.highPassHz > 0 ? `${s.highPassHz}Hz` : "OFF";
    const eqSign = s.presenceDb > 0 ? "+" : "";
    const cmpStr = s.compressor ? "CMP+LIM" : "LIM";
    const codecDetail = this.voice.opusSupported
      ? `${targetKbps}k · ${this.voice.opusUseRichConfig ? "VBR+FEC" : "VBR"}`
      : "64k · ADPCM";

    let trackSummary = "LISTEN-ONLY";
    if (!this.voice.listenOnly) {
      const micTrack = this.voice.micStream?.getAudioTracks?.()[0];
      const ts = micTrack && typeof micTrack.getSettings === "function" ? micTrack.getSettings() : null;
      const aec = ts && typeof ts.echoCancellation === "boolean" ? ts.echoCancellation : s.echoCancellation;
      const ns = ts && typeof ts.noiseSuppression === "boolean" ? ts.noiseSuppression : s.noiseSuppression;
      const agc = ts && typeof ts.autoGainControl === "boolean" ? ts.autoGainControl : s.autoGainControl;
      const flags = [aec ? "AEC" : null, ns ? "NS" : null, agc ? "AGC" : null].filter(Boolean);
      const chTag = ts?.channelCount ? `${ts.channelCount}ch` : "1ch";
      trackSummary = `${flags.length > 0 ? flags.join("/") : "RAW"} · ${chTag}`;
    }

    const activeVoicePeers = (this.status?.peers || []).filter((p) => p.inVoice).length;
    const totalMeshPeers = (this.status?.peers || []).length;
    const keyFp = String(this.status?.e2ee?.keyFingerprint || "—").slice(0, 12);

    return `
      <div class="vas-head" title="Tap to collapse or expand detailed telemetry">
        <span class="vas-pill is-accent">${escapeHtml(presetLabel)}</span>
        <span class="vas-pill">${escapeHtml(codecLabel)}</span>
        <span class="vas-pill vas-pill-right ${stateTone}">${escapeHtml(stateLabel)}</span>
        <span class="vas-chevron" aria-hidden="true">▴</span>
      </div>
      <div class="vas-bar-wrap">
        <div class="vas-bar-meta">
          <span>MIC <strong>${escapeHtml(dbfsStr)} dBFS</strong></span>
          <span>GATE ${gatePct}% · ${escapeHtml(stateLabel)}</span>
        </div>
        <div class="vas-bar-track">
          <div class="vas-bar-fill ${barTone}" style="width:${barPct}%"></div>
          ${gateTickPct > 0 ? `<span class="vas-bar-tgt" style="left:${gateTickPct}%" title="Noise gate threshold (${gatePct}%)"></span>` : ""}
        </div>
      </div>
      <div class="vas-grid">
        <div class="vas-cell"><span class="vas-k">HW LAT</span><span class="vas-v">${escapeHtml(hwLatStr)}</span></div>
        <div class="vas-cell"><span class="vas-k">AUDIO</span><span class="vas-v">${escapeHtml(`${sampleRateKhz}kHz · 20ms · ${ctxState}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">TX RATE</span><span class="vas-v">${escapeHtml(`${txRate.kbps.toFixed(1)}k · ${txRate.pps}/s`)}</span></div>
        <div class="vas-cell"><span class="vas-k">TARGET</span><span class="vas-v">${escapeHtml(codecDetail)}</span></div>
        <div class="vas-cell"><span class="vas-k">ENC Q</span><span class="vas-v ${encTone}">${escapeHtml(`q${encQ} · drop ${this.voice.txDropped}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">TX / RX</span><span class="vas-v">${escapeHtml(`${txSentTotal} / ${rxRecvTotal}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">TX BUF</span><span class="vas-v ${bufTone}">${escapeHtml(`v:${this._formatBytesCompact(maxVoiceBuf)} · b:${this._formatBytesCompact(maxBulkBuf)}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">SIGNAL</span><span class="vas-v">${escapeHtml(`${dbfsStr}dB · rms ${rawRms}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">GAIN</span><span class="vas-v">${escapeHtml(`mic ${s.micGain}% · out ${s.outputGain}%`)}</span></div>
        <div class="vas-cell"><span class="vas-k">DSP</span><span class="vas-v">${escapeHtml(`HPF ${hpfStr} · EQ${eqSign}${s.presenceDb} · ${cmpStr}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">PEERS</span><span class="vas-v">${escapeHtml(`${activeVoicePeers} voice · ${totalMeshPeers} mesh`)}</span></div>
        <div class="vas-cell"><span class="vas-k">CIPHER</span><span class="vas-v">${escapeHtml(`X25519 · AEAD${authFailures > 0 ? ` · err ${authFailures}` : ""}`)}</span></div>
      </div>
      <div class="vas-foot">
        <span>TRACK ${escapeHtml(trackSummary)}</span>
        <span>KEY ${escapeHtml(keyFp)}</span>
      </div>
    `;
  }

  _buildPeerVoiceAdvStatsHtml(peer, mixer, isPreview, nowPerf) {
    const tech = this._getPeerTechInfo(peer.peerId);
    const isRelayed = tech.transport === "relay";
    const codec = mixer?.codec || this.getPeerVoiceCodec(peer.peerId);
    const codecLabel = codec === "opus48" ? "OPUS 48K" : "ADPCM 16K";
    const transportTone = isRelayed ? "is-warn" : "is-ok";

    const vdc = this.voiceChannels.get(peer.peerId);
    const bdc = this.bulkChannels.get(peer.peerId);
    const vBuf = vdc && vdc.readyState === "open" ? Number(vdc.bufferedAmount) || 0 : 0;
    const bBuf = bdc && bdc.readyState === "open" ? Number(bdc.bufferedAmount) || 0 : 0;
    const vBufStr = this._formatBytesCompact(vBuf);
    const bBufStr = this._formatBytesCompact(bBuf);

    const rustRtt = typeof peer.rttMs === "number" ? peer.rttMs : null;
    const iceRtt = typeof tech.statsRttMs === "number" ? tech.statsRttMs : null;
    const effRtt = rustRtt !== null ? rustRtt : iceRtt;
    const minRtt = typeof peer.minRttMs === "number" ? peer.minRttMs : iceRtt;
    const rttMain =
      rustRtt !== null ? `${rustRtt}ms` : iceRtt !== null ? `${iceRtt}ms ICE` : "—";
    const rttStr = `${rttMain} · min ${minRtt !== null ? `${minRtt}ms` : "—"}`;
    const rttTone = effRtt === null ? "is-muted" : effRtt > 180 ? "is-bad" : effRtt > 80 ? "is-warn" : "is-ok";

    const clockOffset = typeof peer.clockOffsetMs === "number" ? peer.clockOffsetMs : null;
    const clockStr =
      clockOffset !== null ? `${clockOffset >= 0 ? "+" : ""}${clockOffset}ms` : "syncing…";

    const txSeq = Number(peer.voiceTxSeq) || 0;
    const rxSeq = Number(peer.voiceRxSeq) || 0;
    const rxOoo = Number(peer.voiceRxOutOfOrder) || 0;
    const rxRej = Number(peer.voiceRxRejected) || 0;
    const safetyCode = peer.safetyCode || "—";

    const pathFoot = isRelayed
      ? `${tech.brokerHost || "WSS"} · tx ${vBufStr}`
      : `${tech.localType}↔${tech.remoteType}${tech.availOutKbps ? ` · ${tech.availOutKbps}k bw` : ""}`;

    if (isPreview) {
      const link = this.topo.linkStats.get(peer.peerId);
      if (link) this._rollLinkWindow(link, nowPerf);
      const linkKbps = link ? link.kbps.toFixed(1) : "0.0";
      const linkPps = link ? (link.txPps || 0) + (link.rxPps || 0) : 0;
      return `
        <div class="vas-head" title="Tap to collapse or expand detailed telemetry">
          <span class="vas-pill ${transportTone}">${escapeHtml(tech.shortLabel)}</span>
          <span class="vas-pill">${escapeHtml(codecLabel)}</span>
          <span class="vas-pill vas-pill-right is-muted">PRE-JOIN</span>
          <span class="vas-chevron" aria-hidden="true">▴</span>
        </div>
        <div class="vas-grid">
          <div class="vas-cell"><span class="vas-k">RTT</span><span class="vas-v ${rttTone}">${escapeHtml(rttStr)}</span></div>
          <div class="vas-cell"><span class="vas-k">CLOCK Δ</span><span class="vas-v">${escapeHtml(clockStr)}</span></div>
          <div class="vas-cell"><span class="vas-k">LINK</span><span class="vas-v">${escapeHtml(`${linkKbps}k · ${linkPps}/s`)}</span></div>
          <div class="vas-cell"><span class="vas-k">QUEUE</span><span class="vas-v">${escapeHtml(`v:${vBufStr} · b:${bBufStr}`)}</span></div>
          <div class="vas-cell"><span class="vas-k">AEAD SEQ</span><span class="vas-v">${escapeHtml(`#${txSeq} / #${rxSeq}`)}</span></div>
          <div class="vas-cell"><span class="vas-k">ROUTE</span><span class="vas-v">${escapeHtml(`${peer.viaAutoMesh ? "AUTO-MESH" : "DIRECT"} · ${peer.knownCount || 0} log`)}</span></div>
        </div>
        <div class="vas-foot">
          <span>${escapeHtml(pathFoot)}</span>
          <span>SAFE ${escapeHtml(safetyCode)}</span>
        </div>
      `;
    }

    const ws = mixer?.workletStats || null;
    const cacheMs = ws ? Number(ws.cacheMs) || 0 : 0;
    const targetMs = ws ? Number(ws.targetMs) || (isRelayed ? 60 : 20) : isRelayed ? 60 : 20;
    const maxMs = ws ? Number(ws.maxMs) || (isRelayed ? 420 : 150) : isRelayed ? 420 : 150;
    const troughMs = ws ? Number(ws.troughMs) || 0 : 0;
    const jitterMs = ws ? Number(ws.jitterMs) || 0 : 0;
    const driftPpm = ws ? Number(ws.driftPpm) || 0 : 0;
    const underruns = ws ? Number(ws.underruns) || 0 : 0;
    const overruns = ws ? Number(ws.overruns) || 0 : 0;
    const burstMs = ws ? Number(ws.burstMs) || 20 : isRelayed ? 60 : 20;
    const isPlaying = Boolean(ws && ws.playing);

    let stateLabel = "IDLE";
    let stateTone = "is-muted";
    if (this.voice.deafened) {
      stateLabel = "DEAF";
      stateTone = "is-muted";
    } else if (mixer?.muted || peer.voiceMuted) {
      stateLabel = "MUTED";
      stateTone = "is-muted";
    } else if (isPlaying) {
      stateLabel = "PLAY";
      stateTone = "is-ok";
    } else if (cacheMs > 0) {
      stateLabel = "BUF";
      stateTone = "is-warn";
    }

    const barPct = Math.max(0, Math.min(100, Math.round((cacheMs / Math.max(1, maxMs)) * 100)));
    const tgtPct = Math.max(4, Math.min(96, Math.round((targetMs / Math.max(1, maxMs)) * 100)));
    const cacheBarTone =
      barPct > 85
        ? "is-bad"
        : barPct > 65 || jitterMs > 25
          ? "is-warn"
          : isPlaying || cacheMs > 0
            ? "is-ok"
            : "is-muted";

    const ctx = this.voice.audioCtx;
    const hwOutMs =
      ctx && typeof ctx.outputLatency === "number" && Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0
        ? Math.round(ctx.outputLatency * 1000)
        : ctx && typeof ctx.baseLatency === "number" && Number.isFinite(ctx.baseLatency)
          ? Math.round(ctx.baseLatency * 1000)
          : 10;
    const estE2e =
      effRtt !== null
        ? Math.round(effRtt / 2 + (cacheMs > 0 ? cacheMs : targetMs) + hwOutMs + 20)
        : null;
    const e2eTone =
      estE2e === null ? "is-muted" : estE2e > 220 ? "is-bad" : estE2e > 120 ? "is-warn" : "is-ok";

    const rxRate = mixer ? this._computeRateWindow(mixer.rxWindow, nowPerf) : { kbps: 0, pps: 0 };
    const lastBytes = mixer?.lastPktBytes || 0;
    const rxRateStr = `${rxRate.kbps.toFixed(1)}k · ${rxRate.pps}/s${lastBytes ? ` · ${lastBytes}B` : ""}`;

    const pktsRx = mixer?.packetsReceived || 0;
    const decFrames = mixer?.decodedFrames || 0;
    const decQ = mixer?.opusDecoder ? Number(mixer.opusDecoder.decodeQueueSize) || 0 : 0;
    const decErr = mixer?.decodeErrors || 0;
    const lostFrames = mixer?.lostFrames || 0;
    const lossTotal = pktsRx + lostFrames;
    const lossPct = lossTotal > 0 ? (lostFrames / lossTotal) * 100 : 0;
    const lossTone =
      lossPct >= 5 || rxRej > 0 ? "is-bad" : lostFrames > 0 || rxOoo > 0 ? "is-warn" : "is-ok";

    const undOvrTone = underruns > 0 || overruns > 0 ? "is-warn" : "is-ok";
    const jitterTone = jitterMs > 25 ? "is-bad" : jitterMs > 12 ? "is-warn" : "";

    const freshAudio = mixer && Date.now() - mixer.lastAudioAt < 450 && !peer.voiceMuted && !mixer.muted;
    const peerRms = freshAudio ? Math.round(mixer.peakRms || mixer.rms || 0) : 0;
    const peerDbfs = this._rmsToDbfs(peerRms);
    const peerDbfsStr = peerDbfs === null ? "-∞" : `${peerDbfs}`;

    const known = this.roomKnownPeers.get(peer.peerId);
    const reord = known?.tagHex ? this.relayVoiceReorder.get(known.tagHex) : null;
    const queueLabel = isRelayed && reord ? "REORDER" : "QUEUE";
    const queueVal =
      isRelayed && reord
        ? `q${reord.pending.size} · ooo ${reord.reorderedCount} · skp ${reord.skippedCount}`
        : `v:${vBufStr} · b:${bBufStr}`;

    const volStr = mixer?.muted ? "MUTE" : `${mixer ? Math.round(mixer.volume * 100) : 100}%`;
    const aeadMixVal = `#${txSeq}/#${rxSeq} · ${volStr}${rxRej > 0 ? ` · rej ${rxRej}` : ""}`;

    return `
      <div class="vas-head" title="Tap to collapse or expand detailed telemetry">
        <span class="vas-pill ${transportTone}">${escapeHtml(tech.shortLabel)}</span>
        <span class="vas-pill">${escapeHtml(codecLabel)}</span>
        <span class="vas-pill vas-pill-right ${stateTone}">${escapeHtml(stateLabel)}</span>
        <span class="vas-chevron" aria-hidden="true">▴</span>
      </div>
      <div class="vas-bar-wrap">
        <div class="vas-bar-meta">
          <span>CACHE <strong>${cacheMs.toFixed(0)}ms</strong></span>
          <span>TGT ${targetMs}ms · MAX ${maxMs}ms</span>
        </div>
        <div class="vas-bar-track">
          <div class="vas-bar-fill ${cacheBarTone}" style="width:${barPct}%"></div>
          <span class="vas-bar-tgt" style="left:${tgtPct}%" title="Adaptive target trough (${targetMs}ms)"></span>
        </div>
      </div>
      <div class="vas-grid">
        <div class="vas-cell"><span class="vas-k">RTT</span><span class="vas-v ${rttTone}">${escapeHtml(rttStr)}</span></div>
        <div class="vas-cell"><span class="vas-k">EST E2E</span><span class="vas-v ${e2eTone}">${escapeHtml(estE2e !== null ? `~${estE2e}ms` : "—")}</span></div>
        <div class="vas-cell"><span class="vas-k">JITTER</span><span class="vas-v ${jitterTone}">${escapeHtml(`${jitterMs.toFixed(1)}ms · tr ${troughMs.toFixed(0)}ms`)}</span></div>
        <div class="vas-cell"><span class="vas-k">DRIFT</span><span class="vas-v">${escapeHtml(`${driftPpm >= 0 ? "+" : ""}${driftPpm}ppm · ${burstMs}ms`)}</span></div>
        <div class="vas-cell"><span class="vas-k">RX RATE</span><span class="vas-v">${escapeHtml(rxRateStr)}</span></div>
        <div class="vas-cell"><span class="vas-k">LOSS / OOO</span><span class="vas-v ${lossTone}">${escapeHtml(`${lossPct.toFixed(1)}% (${lostFrames}) · ooo ${rxOoo}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">UND / OVR</span><span class="vas-v ${undOvrTone}">${escapeHtml(`${underruns} / ${overruns}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">PKT / DEC</span><span class="vas-v">${escapeHtml(`${pktsRx} / ${decFrames} · q${decQ}${decErr > 0 ? ` · e${decErr}` : ""}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">SIGNAL</span><span class="vas-v">${escapeHtml(`${peerDbfsStr}dB · rms ${peerRms}`)}</span></div>
        <div class="vas-cell"><span class="vas-k">CLOCK Δ</span><span class="vas-v">${escapeHtml(clockStr)}</span></div>
        <div class="vas-cell"><span class="vas-k">${queueLabel}</span><span class="vas-v">${escapeHtml(queueVal)}</span></div>
        <div class="vas-cell"><span class="vas-k">AEAD / MIX</span><span class="vas-v">${escapeHtml(aeadMixVal)}</span></div>
      </div>
      <div class="vas-foot">
        <span>${escapeHtml(pathFoot)}</span>
        <span>SAFE ${escapeHtml(safetyCode)}</span>
      </div>
    `;
  }

  updateVoiceAdvancedStats() {
    this._syncVoiceStatsCollapseUi();
    if (!this.advancedMode || !this.status) return;
    const nowPerf = performance.now();
    const peerMap = new Map((this.status.peers || []).map((p) => [p.peerId, p]));

    for (const [rowKey, entry] of this.voice.cardCache.entries()) {
      if (!entry || !entry.advStatsEl || !entry.card?.isConnected) continue;
      let html = "";
      if (rowKey === "self") {
        if (!this.voice.inVoice) continue;
        html = this._buildSelfVoiceAdvStatsHtml(nowPerf);
      } else {
        const peer = peerMap.get(rowKey);
        if (!peer) continue;
        const mixer = this.voice.peerMixers.get(rowKey) || null;
        html = this._buildPeerVoiceAdvStatsHtml(peer, mixer, !this.voice.inVoice, nowPerf);
      }
      if (html !== entry.lastAdvHtml) {
        entry.lastAdvHtml = html;
        entry.advStatsEl.innerHTML = html;
      }
    }
  }

  renderStats() {
    if (!this.status?.stats) return;
    const s = this.status.stats;
    this.el["stat-e2ee"].textContent = `${s.e2eeFramesEncrypted} / ${s.e2eeFramesDecrypted}`;
    this.el["stat-batches"].textContent = `${s.syncBatchesSent} / ${s.syncBatchesReceived}`;
    this.el["stat-voice"].textContent = `${s.voicePacketsSent} / ${s.voicePacketsReceived}`;
  }

  _storeDirectPeerTech(peerId, local, remote, pair) {
    if (!peerId) return;
    const lt = local?.candidateType || "";
    const rt = remote?.candidateType || "";
    const proto = (local?.protocol || remote?.protocol || "udp").toUpperCase();
    let shortLabel = `P2P ${proto}`;
    let detailLabel = `WebRTC DataChannel · ${proto}`;
    if (lt === "host" && rt === "host") {
      shortLabel = `LAN ${proto}`;
      detailLabel = `WebRTC DataChannel · ${proto} (LAN host ↔ host)`;
    } else if (lt === "srflx" || rt === "srflx") {
      shortLabel = `STUN ${proto}`;
      detailLabel = `WebRTC DataChannel · ${proto} (STUN ${lt || "?"} ↔ ${rt || "?"})`;
    } else if (lt === "prflx" || rt === "prflx") {
      shortLabel = `P2P ${proto}`;
      detailLabel = `WebRTC DataChannel · ${proto} (Hole-punch ${lt || "?"} ↔ ${rt || "?"})`;
    } else if (lt || rt) {
      detailLabel = `WebRTC DataChannel · ${proto} (${lt || "?"} ↔ ${rt || "?"})`;
    }
    const statsRttMs =
      typeof pair?.currentRoundTripTime === "number" && Number.isFinite(pair.currentRoundTripTime)
        ? Math.max(1, Math.round(pair.currentRoundTripTime * 1000))
        : null;
    const availOutKbps =
      typeof pair?.availableOutgoingBitrate === "number" && Number.isFinite(pair.availableOutgoingBitrate)
        ? Math.round(pair.availableOutgoingBitrate / 1000)
        : null;
    this.topo.peerTech.set(peerId, {
      transport: "direct",
      shortLabel,
      detailLabel,
      protocol: proto,
      localType: lt || "?",
      remoteType: rt || "?",
      statsRttMs,
      availOutKbps,
      iceBytesSent: typeof pair?.bytesSent === "number" ? pair.bytesSent : null,
      iceBytesRecv: typeof pair?.bytesReceived === "number" ? pair.bytesReceived : null,
      brokerHost: "",
    });
  }

  _getPeerTechInfo(peerId) {
    const liveConn = this.directPeers.get(peerId);
    if (liveConn?.transport === "relay") {
      let brokerHost = "WSS Multi-Relay";
      const known = this.roomKnownPeers.get(peerId);
      const relayStatus = this.roomRendezvous?.getStatus?.();
      const connectedUrls = relayStatus?.connectedUrls || [];
      const sharedUrls =
        known?.relays?.length > 0
          ? connectedUrls.filter((u) => known.relays.includes(u))
          : connectedUrls;
      const activePool = sharedUrls.length > 0 ? sharedUrls : connectedUrls;
      const rtts = relayStatus?.brokerRtts || {};
      const sortedPool = activePool
        .slice()
        .sort((a, b) => (rtts[a] ?? 150) - (rtts[b] ?? 150));
      const relayUrl = sortedPool[0] || known?.relays?.[0] || "";
      if (relayUrl) {
        try {
          brokerHost = new URL(relayUrl).host;
        } catch {
          brokerHost = relayUrl;
        }
      }
      const bestRtt = relayUrl && typeof rtts[relayUrl] === "number" ? rtts[relayUrl] : null;
      const stripeTag = sortedPool.length > 1 ? `${Math.min(3, sortedPool.length)}x striped` : "DF/VB";
      return {
        transport: "relay",
        shortLabel: sortedPool.length > 1 ? `WSS ${Math.min(3, sortedPool.length)}x RELAY` : "WSS RELAY",
        detailLabel: `E2EE WSS Multi-Relay (${stripeTag} · Zero TURN · ${brokerHost})`,
        protocol: "WSS/TLS",
        localType: "wss",
        remoteType: "wss",
        statsRttMs: bestRtt,
        availOutKbps: null,
        brokerHost,
      };
    }
    const cached = this.topo.peerTech.get(peerId);
    if (cached && cached.transport === "direct") {
      return cached;
    }
    return {
      transport: "direct",
      shortLabel: "WEBRTC P2P",
      detailLabel: "WebRTC DataChannel · Direct ICE (Zero TURN)",
      protocol: "UDP",
      localType: "?",
      remoteType: "?",
      statsRttMs: null,
      availOutKbps: null,
      brokerHost: "",
    };
  }

  _cleanupPeerTopologyState(peerId) {
    this.topo.linkStats.delete(peerId);
    this.topo.peerTech.delete(peerId);
    this.topo.customPositions.delete(peerId);
    this.topo.positions.delete(peerId);
    if (this.topo.selectedId === peerId) {
      this.topo.selectedId = null;
    }
    if (this.topo.customPositions.size === 0 && this.el["btn-topo-reset"]) {
      this.el["btn-topo-reset"].classList.add("hidden");
    }
  }

  async pollPeerTransportStats() {
    if (!this.status) return;
    let changed = false;
    const jobs = [];
    for (const [peerId, entry] of this.directPeers.entries()) {
      if (entry.transport !== "direct" || !entry.pc || typeof entry.pc.getStats !== "function") {
        continue;
      }
      jobs.push(
        entry.pc
          .getStats()
          .then((stats) => {
            let chosen = null;
            const cands = new Map();
            let transportSelectedId = null;
            stats.forEach((r) => {
              if (r.type === "transport" && r.selectedCandidatePairId) {
                transportSelectedId = r.selectedCandidatePairId;
              } else if (r.type === "local-candidate" || r.type === "remote-candidate") {
                cands.set(r.id, r);
              }
            });
            stats.forEach((r) => {
              if (r.type !== "candidate-pair") return;
              if (transportSelectedId && r.id === transportSelectedId) {
                chosen = r;
              } else if (!chosen && (r.selected || (r.nominated && r.state === "succeeded"))) {
                chosen = r;
              }
            });
            if (chosen) {
              const local = cands.get(chosen.localCandidateId);
              const remote = cands.get(chosen.remoteCandidateId);
              const prev = this.topo.peerTech.get(peerId);
              this._storeDirectPeerTech(peerId, local, remote, chosen);
              const next = this.topo.peerTech.get(peerId);
              if (
                !prev ||
                prev.shortLabel !== next.shortLabel ||
                prev.statsRttMs !== next.statsRttMs ||
                prev.availOutKbps !== next.availOutKbps
              ) {
                changed = true;
              }
            }
          })
          .catch(() => {})
      );
    }
    if (jobs.length > 0) {
      await Promise.all(jobs);
    }
    if (changed && this.isTopologyVisible()) {
      this.renderPeers();
      this.renderTopology();
      this.renderTopologyInspector();
    }
    if (this.advancedMode) {
      this.updateVoiceAdvancedStats();
    }
  }

  _rollLinkWindow(st, now) {
    const elapsed = now - st.winStartMs;
    if (elapsed >= 1000) {
      const sec = Math.max(1, elapsed / 1000);
      st.txPps = Math.round(st.txWin / sec);
      st.rxPps = Math.round(st.rxWin / sec);
      st.kbps = Number((((st.txBytesWin + st.rxBytesWin) * 8) / (sec * 1000)).toFixed(1));
      st.txWin = 0;
      st.rxWin = 0;
      st.txBytesWin = 0;
      st.rxBytesWin = 0;
      st.winStartMs = now;
    }
  }

  recordTopologyPacket(peerId, dir, kind, bytes = 0) {
    if (kind === "voice") {
      this.noteVoiceTraffic();
    }
    if (!peerId || !this.status) return;
    const now = performance.now();
    let st = this.topo.linkStats.get(peerId);
    if (!st) {
      st = {
        txTotal: 0,
        rxTotal: 0,
        txBytes: 0,
        rxBytes: 0,
        txWin: 0,
        rxWin: 0,
        txBytesWin: 0,
        rxBytesWin: 0,
        txPps: 0,
        rxPps: 0,
        kbps: 0,
        winStartMs: now,
        lastPacketAt: now,
      };
      this.topo.linkStats.set(peerId, st);
    }
    this._rollLinkWindow(st, now);
    const sz = Math.max(0, Number(bytes) || 0);
    if (dir === "tx") {
      st.txTotal += 1;
      st.txWin += 1;
      st.txBytes += sz;
      st.txBytesWin += sz;
    } else {
      st.rxTotal += 1;
      st.rxWin += 1;
      st.rxBytes += sz;
      st.rxBytesWin += sz;
    }
    st.lastPacketAt = now;

    if (!this.isTopologyVisible()) return;

    // Coalesce rapid packet bursts cleanly so voice streams render as crisp rhythmic pulses
    const minIntervalMs = kind === "voice" ? 115 : kind === "bulk" ? 95 : 55;
    const throttleKey = `${peerId}:${dir}:${kind}`;
    const lastSpawn = this.topo.lastParticleAt.get(throttleKey) || 0;
    if (now - lastSpawn < minIntervalMs) return;
    this.topo.lastParticleAt.set(throttleKey, now);

    const selfId = this.status.peerId;
    if (!this.topo.positions.has(selfId) || !this.topo.positions.has(peerId)) return;

    const liveConn = this.directPeers.get(peerId);
    const isRelayed = liveConn?.transport === "relay";
    if (this.topo.particles.length >= 48) {
      this.topo.particles.shift();
    }
    this.topo.particles.push({
      fromId: dir === "tx" ? selfId : peerId,
      toId: dir === "tx" ? peerId : selfId,
      kind,
      t: 0,
      durationMs: isRelayed ? 620 : kind === "bulk" ? 460 : 390,
      color: kind === "voice" ? "var(--acid)" : kind === "bulk" ? "var(--ochre)" : "var(--coral)",
    });

    if (!this.topo.rafId) {
      this.topo.lastFrameMs = now;
      this.topo.rafId = requestAnimationFrame(this.topo.boundTick);
    }
  }

  _ensureTopologySvgLayers(svg) {
    if (this.topo.svgInitialized && svg.querySelector("#topo-particles")) {
      return;
    }
    svg.innerHTML = `
      <defs>
        <pattern id="topo-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--rule-soft)" stroke-width="1" />
        </pattern>
      </defs>
      <rect id="topo-bg-hit" width="360" height="220" fill="url(#topo-grid)" />
      <g id="topo-edge-lines"></g>
      <g id="topo-particles"></g>
      <g id="topo-edge-pills"></g>
      <g id="topo-nodes"></g>
    `;
    const ns = "http://www.w3.org/2000/svg";
    const particleLayer = svg.querySelector("#topo-particles");
    this.topo.particlePool = [];
    for (let i = 0; i < 48; i++) {
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("visibility", "hidden");
      rect.setAttribute("stroke", "#0e0f12");
      rect.setAttribute("stroke-width", "1.2");
      rect.style.pointerEvents = "none";
      rect._vis = false;
      rect._sz = 0;
      rect._fill = "";
      particleLayer.appendChild(rect);
      this.topo.particlePool.push(rect);
    }
    this.topo.svgInitialized = true;
  }

  _topologyTick(ts) {
    this.topo.rafId = null;
    if (!this.isTopologyVisible()) {
      for (const rect of this.topo.particlePool) {
        if (rect._vis) {
          rect._vis = false;
          rect.setAttribute("visibility", "hidden");
        }
      }
      return;
    }
    const dt = Math.min(80, Math.max(0, ts - (this.topo.lastFrameMs || ts)));
    this.topo.lastFrameMs = ts;

    // Compact live particles in-place (zero per-frame array allocation at 60 fps)
    const particles = this.topo.particles;
    let aliveCount = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.t += dt / p.durationMs;
      if (p.t < 1) {
        if (aliveCount !== i) {
          particles[aliveCount] = p;
        }
        aliveCount++;
      }
    }
    particles.length = aliveCount;

    const pool = this.topo.particlePool;
    for (let i = 0; i < pool.length; i++) {
      const rect = pool[i];
      if (i >= aliveCount) {
        if (rect._vis) {
          rect._vis = false;
          rect.setAttribute("visibility", "hidden");
        }
        continue;
      }
      const p = particles[i];
      const a = this.topo.positions.get(p.fromId);
      const b = this.topo.positions.get(p.toId);
      if (!a || !b) {
        if (rect._vis) {
          rect._vis = false;
          rect.setAttribute("visibility", "hidden");
        }
        continue;
      }
      const x = a.x + (b.x - a.x) * p.t;
      const y = a.y + (b.y - a.y) * p.t;
      const sz = p.kind === "voice" ? 6 : 7;
      if (rect._sz !== sz) {
        rect._sz = sz;
        const half = (-sz / 2).toFixed(1);
        const szStr = String(sz);
        rect.setAttribute("x", half);
        rect.setAttribute("y", half);
        rect.setAttribute("width", szStr);
        rect.setAttribute("height", szStr);
      }
      if (rect._fill !== p.color) {
        rect._fill = p.color;
        rect.setAttribute("fill", p.color);
      }
      rect.setAttribute(
        "transform",
        p.kind === "voice"
          ? `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(45)`
          : `translate(${x.toFixed(1)},${y.toFixed(1)})`
      );
      if (!rect._vis) {
        rect._vis = true;
        rect.setAttribute("visibility", "visible");
      }
    }

    // Refresh live packet rate inside inspector at ~3 Hz while traffic is active
    if (this.topo.selectedId && ts - this.topo.lastInspectorTickMs >= 350) {
      this.topo.lastInspectorTickMs = ts;
      this.renderTopologyInspector();
    }

    if (aliveCount > 0) {
      this.topo.rafId = requestAnimationFrame(this.topo.boundTick);
    }
  }

  _clientToSvgPoint(svg, clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 180, y: 110 };
    const x = ((clientX - rect.left) / rect.width) * 360;
    const y = ((clientY - rect.top) / rect.height) * 220;
    return {
      x: Math.max(26, Math.min(334, x)),
      y: Math.max(24, Math.min(194, y)),
    };
  }

  setupTopologyInteractions() {
    const svg = this.el["topology-svg"];
    if (!svg) return;

    svg.addEventListener("pointerdown", (ev) => {
      const nodeEl = ev.target.closest?.("[data-topo-node]");
      if (nodeEl) {
        const nodeId = nodeEl.getAttribute("data-topo-node");
        this.topo.draggingId = nodeId;
        this.topo.dragStartClient = { x: ev.clientX, y: ev.clientY };
        this.topo.dragMoved = false;
        svg.classList.add("is-dragging");
        try {
          svg.setPointerCapture(ev.pointerId);
        } catch {
          // ignore
        }
        ev.preventDefault();
        return;
      }

      const edgeEl = ev.target.closest?.("[data-topo-edge]");
      if (edgeEl) {
        const edgePeerId = edgeEl.getAttribute("data-topo-edge");
        this.selectTopologyTarget(edgePeerId);
        return;
      }

      if (ev.target === svg || ev.target.id === "topo-bg-hit") {
        this.selectTopologyTarget(null);
      }
    });

    svg.addEventListener("pointermove", (ev) => {
      if (!this.topo.draggingId) return;
      const start = this.topo.dragStartClient;
      if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >= 4) {
        this.topo.dragMoved = true;
      }
      if (!this.topo.dragMoved) return;
      const pt = this._clientToSvgPoint(svg, ev.clientX, ev.clientY);
      this.topo.customPositions.set(this.topo.draggingId, pt);
      if (this.el["btn-topo-reset"]) {
        this.el["btn-topo-reset"].classList.remove("hidden");
      }
      this.renderTopology();
    });

    const endDrag = (ev) => {
      if (!this.topo.draggingId) return;
      const nodeId = this.topo.draggingId;
      const wasMoved = this.topo.dragMoved;
      this.topo.draggingId = null;
      this.topo.dragStartClient = null;
      this.topo.dragMoved = false;
      svg.classList.remove("is-dragging");
      try {
        svg.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      if (!wasMoved) {
        this.selectTopologyTarget(this.topo.selectedId === nodeId ? null : nodeId);
      }
    };

    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);
  }

  selectTopologyTarget(nodeId) {
    this.topo.selectedId = nodeId || null;
    this.renderTopology();
    this.renderPeers();
    this.renderTopologyInspector();
  }

  renderPeers() {
    if (!this.status) return;
    const list = this.el["peer-list"];
    const direct = this.status.peers || [];
    const pending = this.status.pendingAutoMesh || [];

    // Update collapsed-header live peer summary badge
    if (this.el["network-panel-meta"]) {
      let directCount = 0;
      let relayCount = 0;
      for (const p of direct) {
        if (this.directPeers.get(p.peerId)?.transport === "relay") relayCount++;
        else directCount++;
      }
      if (direct.length === 0) {
        this.el["network-panel-meta"].textContent =
          pending.length > 0 ? `${pending.length} connecting` : "0 peers";
      } else {
        const segs = [];
        if (directCount > 0) segs.push(`${directCount} direct`);
        if (relayCount > 0) segs.push(`${relayCount} relay`);
        this.el["network-panel-meta"].textContent = segs.join(" · ");
      }
    }

    if (direct.length === 0 && pending.length === 0) {
      list.innerHTML =
        '<li class="empty-state">No peers connected yet. Use Connect Peer above to invite or join someone.</li>';
      return;
    }

    const parts = [];
    for (const p of direct) {
      const botBadge = p.isBot ? '<span class="bot-tag">BOT</span>' : "";
      const liveConn = this.directPeers.get(p.peerId);
      const isRelayed = liveConn?.transport === "relay";
      const tech = this._getPeerTechInfo(p.peerId);
      const transportCls = isRelayed ? "transport-relay" : "transport-direct";
      const selectedCls = this.topo.selectedId === p.peerId ? " is-selected" : "";
      const peerColorSpec = this.getPeerColorSpec(p.peerId);
      const swatchStyle = peerColorSpec.styleAttr ? ` style="${peerColorSpec.styleAttr}"` : "";
      const colorSwatch = `<span class="peer-color-swatch ${peerColorSpec.className}" data-peer-color-id="${escapeHtml(p.peerId)}"${swatchStyle} aria-hidden="true"></span>`;
      const originBadge = isRelayed
        ? `<span class="badge relay" title="${escapeHtml(tech.detailLabel)}">e2ee relay</span>`
        : `<span class="badge direct" title="${escapeHtml(tech.detailLabel)}">${escapeHtml(tech.shortLabel.toLowerCase())}</span>`;
      const voiceBadge = p.inVoice
        ? `<span class="badge voice-tag">${p.voiceMuted ? "voice · muted" : this.getPeerVoiceCodec(p.peerId) === "opus48" ? "opus 48k" : "adpcm 16k"}</span>`
        : "";
      const effRtt = typeof p.rttMs === "number" ? p.rttMs : tech.statsRttMs;
      const rttLabel = typeof effRtt === "number" ? ` · ${effRtt}ms` : "";
      parts.push(`
        <li class="peer-item ${transportCls}${selectedCls}" data-peer-id="${escapeHtml(p.peerId)}">
          <div class="peer-main">
            <div class="peer-name">${colorSwatch}${escapeHtml(p.authorName)} ${botBadge} ${originBadge} ${voiceBadge}</div>
            <div class="peer-id">${escapeHtml(p.peerId)} · code ${escapeHtml(p.safetyCode || "—")}${rttLabel}</div>
          </div>
          <button type="button" class="btn btn-sm btn-danger" data-disconnect="${escapeHtml(p.peerId)}">Drop</button>
        </li>
      `);
    }

    for (const pend of pending) {
      parts.push(`
        <li class="peer-item is-pending">
          <div class="peer-main">
            <div class="peer-name">${escapeHtml(pend.authorName)} <span class="badge pending">connecting via ${escapeHtml(pend.viaPeerId)}</span></div>
            <div class="peer-id">${escapeHtml(pend.peerId)}</div>
          </div>
        </li>
      `);
    }

    list.innerHTML = parts.join("");
    for (const row of list.querySelectorAll(".peer-item[data-peer-id]")) {
      row.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-disconnect]")) return;
        const pid = row.dataset.peerId;
        this.selectTopologyTarget(this.topo.selectedId === pid ? null : pid);
      });
    }
    for (const btn of list.querySelectorAll("[data-disconnect]")) {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.disconnectPeer(btn.dataset.disconnect);
      });
    }
  }

  renderTopology() {
    if (!this.status) return;
    const svg = this.el["topology-svg"];
    if (!svg) return;
    this._ensureTopologySvgLayers(svg);

    const connected = this.status.peers || [];
    const pendingAuto = this.status.pendingAutoMesh || [];

    const nodes = [
      {
        id: this.status.peerId,
        label: `${this.status.authorName} (you)`,
        kind: "self",
        transport: "self",
        inVoice: this.voice.inVoice,
        speaking: Date.now() - this.voice.localSpeakingAt < 650,
        isBot: false,
      },
    ];
    const nodeMap = new Map();
    nodeMap.set(this.status.peerId, nodes[0]);

    let directCount = 0;
    let relayCount = 0;
    let pendingCount = 0;

    for (const p of connected) {
      const liveConn = this.directPeers.get(p.peerId);
      const isRelayed = liveConn?.transport === "relay";
      if (isRelayed) relayCount++;
      else directCount++;
      const mixer = this.voice.peerMixers.get(p.peerId);
      const n = {
        id: p.peerId,
        label: p.isBot ? `[BOT] ${p.authorName}` : p.authorName,
        kind: isRelayed ? "relay" : "direct",
        transport: isRelayed ? "relay" : "direct",
        inVoice: Boolean(p.inVoice),
        speaking: Boolean(mixer && Date.now() - mixer.lastAudioAt < 650 && mixer.rms > 180),
        isBot: Boolean(p.isBot),
        rttMs: typeof p.rttMs === "number" ? p.rttMs : this._getPeerTechInfo(p.peerId).statsRttMs,
      };
      nodes.push(n);
      nodeMap.set(p.peerId, n);
    }

    for (const p of pendingAuto) {
      if (!nodeMap.has(p.peerId)) {
        pendingCount++;
        const n = {
          id: p.peerId,
          label: p.authorName,
          kind: "pending",
          transport: "pending",
          inVoice: false,
          speaking: false,
          isBot: false,
        };
        nodes.push(n);
        nodeMap.set(p.peerId, n);
      }
    }

    // Also show actively dialing room peers (ICE handshake in progress) in Amber
    for (const [pid, dial] of this.roomDialing.entries()) {
      if (!nodeMap.has(pid) && !dial.isUpgradeProbe) {
        pendingCount++;
        const n = {
          id: pid,
          label: dial.targetName || pid,
          kind: "pending",
          transport: "pending",
          inVoice: false,
          speaking: false,
          isBot: false,
        };
        nodes.push(n);
        nodeMap.set(pid, n);
      }
    }

    // Update live topology toolbar summary
    if (this.el["topology-summary"]) {
      const summaryParts = [];
      if (directCount > 0) summaryParts.push(`${directCount} Direct P2P`);
      if (relayCount > 0) summaryParts.push(`${relayCount} E2EE Relay`);
      if (pendingCount > 0) summaryParts.push(`${pendingCount} Connecting`);
      if (this.voice.inVoice) {
        summaryParts.push(this.voice.opusSupported ? "Opus 48k" : "ADPCM 16k");
      }
      this.el["topology-summary"].textContent =
        summaryParts.length > 0 ? summaryParts.join(" · ") : "Standalone · Waiting for peers";
    }

    // Position nodes (centered YOU at top/center, peers evenly distributed, honoring dragged coordinates)
    const cx = 180;
    const cy = 110;
    const rx = 122;
    const ry = 68;
    if (nodes.length === 1) {
      const custom = this.topo.customPositions.get(nodes[0].id);
      nodes[0].x = custom ? custom.x : cx;
      nodes[0].y = custom ? custom.y : cy;
    } else if (nodes.length === 2) {
      const defaults = [
        { x: 90, y: cy },
        { x: 270, y: cy },
      ];
      for (let i = 0; i < 2; i++) {
        const custom = this.topo.customPositions.get(nodes[i].id);
        nodes[i].x = custom ? custom.x : defaults[i].x;
        nodes[i].y = custom ? custom.y : defaults[i].y;
      }
    } else {
      for (let i = 0; i < nodes.length; i++) {
        const custom = this.topo.customPositions.get(nodes[i].id);
        if (custom) {
          nodes[i].x = custom.x;
          nodes[i].y = custom.y;
        } else {
          const angle = -Math.PI / 2 + (2 * Math.PI * i) / nodes.length;
          nodes[i].x = cx + rx * Math.cos(angle);
          nodes[i].y = cy + ry * Math.sin(angle);
        }
      }
    }

    // Persist live coordinates so the 60fps packet animation tracks nodes smoothly
    const liveIds = new Set();
    for (const n of nodes) {
      liveIds.add(n.id);
      this.topo.positions.set(n.id, { x: n.x, y: n.y });
    }
    for (const id of Array.from(this.topo.positions.keys())) {
      if (!liveIds.has(id)) this.topo.positions.delete(id);
    }

    const edgeSet = new Set();
    const edgeLineParts = [];
    const edgePillParts = [];
    const addEdge = (aId, bId, style, peerIdForSelect = null, pillText = "") => {
      const a = nodeMap.get(aId);
      const b = nodeMap.get(bId);
      if (!a || !b || aId === bId) return;
      const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);

      const isSelected = Boolean(peerIdForSelect && this.topo.selectedId === peerIdForSelect);
      let stroke = "var(--mint)";
      let width = isSelected ? "3.4" : "2.6";
      let dash = "";
      let opacity = "1";
      let pillStroke = "var(--mint)";

      if (style === "relay") {
        stroke = "var(--cyan)";
        dash = ' stroke-dasharray="6 4"';
        pillStroke = "var(--cyan)";
      } else if (style === "pending") {
        stroke = "var(--ochre)";
        width = "2.2";
        dash = ' stroke-dasharray="3 4"';
        pillStroke = "var(--ochre)";
      } else if (style === "remote") {
        stroke = "var(--ink-muted)";
        width = "1.4";
        dash = ' stroke-dasharray="3 3"';
        opacity = "0.5";
      }

      const x1 = a.x.toFixed(1);
      const y1 = a.y.toFixed(1);
      const x2 = b.x.toFixed(1);
      const y2 = b.y.toFixed(1);
      const hitAttr = peerIdForSelect
        ? ` class="topo-edge-hit" data-topo-edge="${escapeHtml(peerIdForSelect)}"`
        : "";

      edgeLineParts.push(`
        <g${hitAttr}>
          ${peerIdForSelect ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="14" />` : ""}
          <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${width}"${dash} />
        </g>
      `);

      if (pillText && style !== "remote") {
        const pw = Math.max(46, pillText.length * 5.3 + 10);
        const ph = 14;
        const mx = Math.max(pw / 2 + 4, Math.min(356 - pw / 2, (a.x + b.x) / 2));
        const my = Math.max(ph / 2 + 4, Math.min(216 - ph / 2, (a.y + b.y) / 2));
        edgePillParts.push(`
          <g${hitAttr}>
            <rect x="${(mx - pw / 2).toFixed(1)}" y="${(my - ph / 2).toFixed(1)}" width="${pw.toFixed(1)}" height="${ph}" fill="var(--bg-surface)" stroke="${isSelected ? "var(--cobalt)" : pillStroke}" stroke-width="${isSelected ? "2" : "1.4"}" />
            <text x="${mx.toFixed(1)}" y="${(my + 3.2).toFixed(1)}" text-anchor="middle" font-family="var(--font-mono)" font-size="8" font-weight="700" letter-spacing="0.04em" fill="var(--ink-primary)">${escapeHtml(pillText)}</text>
          </g>
        `);
      }
    };

    for (const p of connected) {
      const tech = this._getPeerTechInfo(p.peerId);
      const rtt = typeof p.rttMs === "number" ? p.rttMs : tech.statsRttMs;
      const rttPart = typeof rtt === "number" ? ` · ${rtt}ms` : "";
      const pill = `${tech.shortLabel}${rttPart}`;
      addEdge(this.status.peerId, p.peerId, tech.transport, p.peerId, pill);
      for (const rp of p.remotePeers || []) {
        if (nodeMap.has(rp.peerId)) {
          addEdge(p.peerId, rp.peerId, "remote", null, "");
        }
      }
    }
    for (const pend of pendingAuto) {
      addEdge(this.status.peerId, pend.peerId, "pending", pend.peerId, "DIALING…");
      addEdge(pend.viaPeerId, pend.peerId, "remote", null, "");
    }
    for (const [pid, dial] of this.roomDialing.entries()) {
      if (!this.directPeers.has(pid) && !dial.isUpgradeProbe) {
        addEdge(this.status.peerId, pid, "pending", pid, "ICE STUN…");
      }
    }

    const nodeParts = nodes.map((n) => {
      const fill =
        n.kind === "self"
          ? "var(--ink-primary)"
          : n.kind === "relay"
            ? "var(--cyan)"
            : n.kind === "pending"
              ? "var(--ochre)"
              : "var(--mint)";
      const size = n.kind === "self" ? 18 : n.kind === "pending" ? 14 : 16;
      const half = size / 2;
      const shortLabel = (n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label).toUpperCase();
      const labelY = n.y > cy ? n.y + 23 : n.y - 15;
      const isSelected = this.topo.selectedId === n.id;

      const voiceStroke =
        n.kind === "relay"
          ? "var(--cyan)"
          : n.kind === "self"
            ? "var(--ink-primary)"
            : "var(--mint)";
      const voiceFrameSize = size + 8;
      const voiceFrameHalf = voiceFrameSize / 2;
      const voiceFrame = n.inVoice
        ? `<rect x="${(n.x - voiceFrameHalf).toFixed(1)}" y="${(n.y - voiceFrameHalf).toFixed(1)}" width="${voiceFrameSize}" height="${voiceFrameSize}" fill="none" stroke="${voiceStroke}" stroke-width="${n.speaking ? "2.6" : "1.8"}" />`
        : "";

      const selSize = size + 14;
      const selHalf = selSize / 2;
      const selFrame = isSelected
        ? `<rect x="${(n.x - selHalf).toFixed(1)}" y="${(n.y - selHalf).toFixed(1)}" width="${selSize}" height="${selSize}" fill="none" stroke="var(--cobalt)" stroke-width="2" stroke-dasharray="4 2" />`
        : "";

      return `
        <g class="topo-node-group" data-topo-node="${escapeHtml(n.id)}">
          ${selFrame}
          ${voiceFrame}
          <rect x="${(n.x - half).toFixed(1)}" y="${(n.y - half).toFixed(1)}" width="${size}" height="${size}" fill="${fill}" stroke="var(--bg-surface)" stroke-width="2" />
          <text x="${n.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-family="var(--font-mono)" font-size="9" font-weight="700" letter-spacing="0.06em" fill="var(--ink-primary)">${escapeHtml(shortLabel)}</text>
        </g>
      `;
    });

    const edgeLinesLayer = svg.querySelector("#topo-edge-lines");
    const edgePillsLayer = svg.querySelector("#topo-edge-pills");
    const nodesLayer = svg.querySelector("#topo-nodes");
    if (edgeLinesLayer) edgeLinesLayer.innerHTML = edgeLineParts.join("");
    if (edgePillsLayer) edgePillsLayer.innerHTML = edgePillParts.join("");
    if (nodesLayer) nodesLayer.innerHTML = nodeParts.join("");

    this.renderTopologyInspector();
  }

  renderTopologyInspector() {
    const box = this.el["topology-inspector"];
    if (!box || !this.status) return;

    const selId = this.topo.selectedId;
    if (!selId) {
      box.innerHTML =
        '<div class="topo-insp-empty">Click any peer or link to inspect protocol, cipher &amp; live packets · Drag nodes to arrange</div>';
      return;
    }

    // Local self node selected
    if (selId === this.status.peerId) {
      const relayStatus = this.roomRendezvous?.getStatus?.();
      const relayInfo = relayStatus
        ? `${relayStatus.connectedCount}/${relayStatus.totalCount} WSS brokers online`
        : "No room relay active";
      const localCodec = this.voice.opusSupported
        ? `48 kHz Opus (${Math.round((this.voice.opusEncoderBitrate || this.computeDesiredOpusBitrate()) / 1000)} kbps)`
        : "16 kHz ADPCM (fallback)";
      box.innerHTML = `
        <div class="topo-insp-head">
          <div class="topo-insp-title">
            <span>${escapeHtml(this.status.authorName)}</span>
            <span class="badge">YOU</span>
          </div>
          <button type="button" class="btn-link" data-topo-close>✕</button>
        </div>
        <div class="topo-insp-grid">
          <div class="topo-insp-cell">
            <span class="topo-insp-k">Peer ID</span>
            <span class="topo-insp-v">${escapeHtml(this.status.peerId)}</span>
          </div>
          <div class="topo-insp-cell">
            <span class="topo-insp-k">Key Fingerprint</span>
            <span class="topo-insp-v">${escapeHtml(this.status.e2ee?.keyFingerprint || "—")}</span>
          </div>
          <div class="topo-insp-cell">
            <span class="topo-insp-k">Voice Engine</span>
            <span class="topo-insp-v">${escapeHtml(localCodec)}</span>
          </div>
          <div class="topo-insp-cell">
            <span class="topo-insp-k">Signaling Relays</span>
            <span class="topo-insp-v">${escapeHtml(relayInfo)}</span>
          </div>
        </div>
      `;
      box.querySelector("[data-topo-close]")?.addEventListener("click", () => this.selectTopologyTarget(null));
      return;
    }

    const peer = (this.status.peers || []).find((p) => p.peerId === selId);
    if (!peer) {
      // Pending / dialing peer
      const dial = this.roomDialing.get(selId);
      const pend = (this.status.pendingAutoMesh || []).find((p) => p.peerId === selId);
      const label = dial?.targetName || pend?.authorName || selId;
      const gathered = dial ? Array.from(dial.gatheredTypes || []).join(", ") || "gathering…" : "relayed offer";
      box.innerHTML = `
        <div class="topo-insp-head">
          <div class="topo-insp-title">
            <span>${escapeHtml(label)}</span>
            <span class="badge pending">CONNECTING</span>
          </div>
          <button type="button" class="btn-link" data-topo-close>✕</button>
        </div>
        <div class="topo-insp-grid">
          <div class="topo-insp-cell span-2">
            <span class="topo-insp-k">Handshake Progress</span>
            <span class="topo-insp-v">WebRTC ICE STUN (${escapeHtml(gathered)}) · auto-fallback to E2EE WSS Relay if blocked</span>
          </div>
        </div>
      `;
      box.querySelector("[data-topo-close]")?.addEventListener("click", () => this.selectTopologyTarget(null));
      return;
    }

    const tech = this._getPeerTechInfo(selId);
    const isRelayed = tech.transport === "relay";
    const st = this.topo.linkStats.get(selId);
    const now = performance.now();
    if (st) this._rollLinkWindow(st, now);

    const effRtt = typeof peer.rttMs === "number" ? peer.rttMs : tech.statsRttMs;
    const rttText = typeof effRtt === "number" ? `${effRtt} ms` : "measuring…";
    const peerCodec = this.getPeerVoiceCodec(selId);
    const voiceText = peer.inVoice
      ? peerCodec === "opus48"
        ? isRelayed
          ? `48 kHz Opus · ${Math.round(VOICE_OPUS_BITRATE_RELAY / 1000)} kbps (V2)`
          : `48 kHz Opus · ${Math.round((this.audioSettings.preset === "raw" ? VOICE_OPUS_BITRATE_RAW : VOICE_OPUS_BITRATE_DIRECT) / 1000)} kbps (V2)`
        : "16 kHz IMA-ADPCM (V1)"
      : "Not in voice";
    const flowText = st
      ? `TX ${st.txPps}/s · RX ${st.rxPps}/s (${st.kbps} kbps)`
      : "Idle (0 pkt/s)";
    const totalText = st ? `TX ${st.txTotal} · RX ${st.rxTotal} pkts` : "0 / 0 pkts";

    const livePeerEntry = this.directPeers.get(selId);
    const hasBulkLane = Boolean(livePeerEntry?.bulkDc && livePeerEntry.bulkDc.readyState === "open");
    const qosSummary = hasBulkLane
      ? "Voice [High] · Chat [Med] · Bulk GIF/Media [Low]"
      : "Voice [High] · Data [Med]";

    box.innerHTML = `
      <div class="topo-insp-head">
        <div class="topo-insp-title">
          <span>${escapeHtml(peer.authorName)}</span>
          ${peer.isBot ? '<span class="bot-tag">BOT</span>' : ""}
          <span class="badge ${isRelayed ? "relay" : "direct"}">${escapeHtml(tech.shortLabel)}</span>
        </div>
        <button type="button" class="btn-link" data-topo-close>✕</button>
      </div>
      <div class="topo-insp-grid">
        <div class="topo-insp-cell span-2">
          <span class="topo-insp-k">Transport &amp; Technology</span>
          <span class="topo-insp-v">${escapeHtml(tech.detailLabel)} · ${escapeHtml(qosSummary)}</span>
        </div>
        <div class="topo-insp-cell">
          <span class="topo-insp-k">Encryption</span>
          <span class="topo-insp-v">X25519 + ChaCha20-Poly1305</span>
        </div>
        <div class="topo-insp-cell">
          <span class="topo-insp-k">Latency / Safety Code</span>
          <span class="topo-insp-v">${escapeHtml(rttText)} · ${escapeHtml(peer.safetyCode || "—")}</span>
        </div>
        <div class="topo-insp-cell">
          <span class="topo-insp-k">Voice Stream</span>
          <span class="topo-insp-v">${escapeHtml(voiceText)}</span>
        </div>
        <div class="topo-insp-cell">
          <span class="topo-insp-k">Live Flow (${escapeHtml(totalText)})</span>
          <span class="topo-insp-v">${escapeHtml(flowText)}</span>
        </div>
      </div>
      <div class="topo-insp-actions">
        ${isRelayed ? '<button type="button" class="btn btn-sm btn-primary" data-topo-upgrade>Try Direct P2P</button>' : ""}
        <button type="button" class="btn btn-sm" data-topo-sync>Sync</button>
        <button type="button" class="btn btn-sm btn-danger" data-topo-drop>Drop</button>
      </div>
    `;

    box.querySelector("[data-topo-close]")?.addEventListener("click", () => this.selectTopologyTarget(null));
    box.querySelector("[data-topo-upgrade]")?.addEventListener("click", () => {
      this.tryBackgroundDirectUpgrades(Date.now(), true);
      this.showToast(`Probing Direct WebRTC P2P upgrade to ${peer.authorName}…`);
    });
    box.querySelector("[data-topo-sync]")?.addEventListener("click", () => {
      this.el["btn-sync-now"]?.click();
    });
    box.querySelector("[data-topo-drop]")?.addEventListener("click", () => {
      this.disconnectPeer(selId);
    });
  }

  renderTelemetry() {
    const box = this.el["telemetry-log"];
    if (this.telemetry.length === 0) return;
    box.innerHTML = this.telemetry
      .map((item) => {
        let cls = "telemetry-entry";
        if (
          item.event.startsWith("auto_mesh") ||
          item.event === "peer_connected" ||
          item.event === "e2ee" ||
          item.event === "rejoin" ||
          item.event === "room" ||
          item.event.includes("voice")
        ) {
          cls += " event-auto";
        } else if (item.event.startsWith("sync") || item.event === "hello" || item.event === "keepalive") {
          cls += " event-sync";
        } else if (item.event === "error") {
          cls += " event-err";
        }
        return `<div class="${cls}">[${escapeHtml(item.ts)}] <strong>${escapeHtml(item.event)}</strong> ${escapeHtml(item.detail)}</div>`;
      })
      .join("");
  }

  renderTypeFilterOptions() {
    const select = this.el["log-type-filter"];
    const current = select.value;
    const typeSet = new Set(this.logMessages.map((m) => m.type));
    if (this.advancedMode && this.rawJsonMode && this.wasm) {
      try {
        const rawRes = this.wasm.call({ cmd: "get_raw_log", compactMedia: true });
        for (const rm of rawRes.rawLog || []) {
          if (rm && rm.type) typeSet.add(rm.type);
        }
      } catch {
        // ignore
      }
    }
    const types = Array.from(typeSet).sort();
    const opts = ['<option value="">All types</option>'];
    for (const t of types) {
      opts.push(`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`);
    }
    select.innerHTML = opts.join("");
    if (types.includes(current)) {
      select.value = current;
    }
  }

  isPeerBot(peerId) {
    if (!peerId) return false;
    if (!this.knownBotPeerIds) {
      this.knownBotPeerIds = new Set();
    }
    const peers = this.status?.peers || [];
    for (const p of peers) {
      if (p.isBot) {
        this.knownBotPeerIds.add(p.peerId);
      }
    }
    return this.knownBotPeerIds.has(peerId);
  }

  startEditMessage(msgId) {
    if (!msgId) return;
    this.editingMessageId = msgId;
    this.renderLog();
    const input = this.el["log-feed"]?.querySelector(
      `.log-entry[data-msg-id="${CSS.escape(msgId)}"] .msg-edit-input`
    );
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  cancelEditMessage() {
    if (!this.editingMessageId) return;
    this.editingMessageId = null;
    this.renderLog();
  }

  submitEditMessage(msgId, newPayload) {
    if (!msgId || !this.wasm) return;
    try {
      const res = this.wasm.call({
        cmd: "edit_message",
        targetId: msgId,
        payload: newPayload,
        ts: Date.now(),
        entropy: randomBase64Url(16),
      });
      this.editingMessageId = null;
      this.status = res.status;
      this.executeActions(res.actions);
      this.renderAll();
      this.showToast("Message edited for room");
    } catch (err) {
      this.addTelemetry("error", `Edit failed: ${err.message}`);
      this.showToast(`Could not edit message: ${err.message}`);
    }
  }

  toggleEditHistory(msgId) {
    if (!msgId) return;
    if (this.expandedEditHistory.has(msgId)) {
      this.expandedEditHistory.delete(msgId);
    } else {
      this.expandedEditHistory.add(msgId);
    }
    this.renderLog();
  }

  _formatPayloadPreview(msgType, payload) {
    if (!payload || typeof payload !== "object") {
      return String(payload ?? "");
    }
    if (msgType === "chat") {
      const text = typeof payload.text === "string" ? payload.text : "";
      const imgCount = Array.isArray(payload.images) ? payload.images.length : 0;
      const vidCount = Array.isArray(payload.videos) ? payload.videos.length : 0;
      if (text) return text;
      const parts = [];
      if (imgCount > 0) parts.push(`${imgCount} image${imgCount === 1 ? "" : "s"}`);
      if (vidCount > 0) parts.push(`${vidCount} video${vidCount === 1 ? "" : "s"}`);
      return parts.length > 0 ? `[${parts.join(", ")}]` : "(empty)";
    }
    return JSON.stringify(payload);
  }

  _buildEditStepDiffHtml(msgType, prevPayload, nextPayload) {
    if (msgType === "chat") {
      const oldText = this._formatPayloadPreview("chat", prevPayload);
      const newText = this._formatPayloadPreview("chat", nextPayload);
      return `
        <div class="edit-diff-old">− ${escapeHtml(oldText)}</div>
        <div class="edit-diff-new">+ ${escapeHtml(newText)}</div>
      `;
    }
    if (
      prevPayload &&
      nextPayload &&
      typeof prevPayload === "object" &&
      typeof nextPayload === "object" &&
      !Array.isArray(prevPayload) &&
      !Array.isArray(nextPayload)
    ) {
      const keys = Array.from(new Set([...Object.keys(prevPayload), ...Object.keys(nextPayload)]));
      const lines = [];
      for (const k of keys) {
        const a = JSON.stringify(prevPayload[k]);
        const b = JSON.stringify(nextPayload[k]);
        if (a !== b) {
          if (a !== undefined) {
            lines.push(`<div class="edit-diff-old">− ${escapeHtml(k)}: ${escapeHtml(a)}</div>`);
          }
          if (b !== undefined) {
            lines.push(`<div class="edit-diff-new">+ ${escapeHtml(k)}: ${escapeHtml(b)}</div>`);
          }
        }
      }
      if (lines.length > 0) {
        return lines.join("");
      }
    }
    return `
      <div class="edit-diff-old">− ${escapeHtml(this._formatPayloadPreview(msgType, prevPayload))}</div>
      <div class="edit-diff-new">+ ${escapeHtml(this._formatPayloadPreview(msgType, nextPayload))}</div>
    `;
  }

  _renderEditHistoryHtml(m) {
    const edits = Array.isArray(m.edits) ? m.edits : [];
    if (edits.length === 0) return "";
    const origPayload = m.originalPayload !== undefined ? m.originalPayload : m.payload;
    const origSpec = this.getPeerColorSpec(m.author);
    const origStyle = origSpec.styleAttr ? ` style="${origSpec.styleAttr}"` : "";
    const rows = [
      `
        <div class="edit-hist-row">
          <div class="edit-hist-meta">
            <span class="msg-editor-swatch ${origSpec.className}" data-peer-color-id="${escapeHtml(m.author)}"${origStyle} aria-hidden="true"></span>
            <span class="edit-hist-who">${escapeHtml(m.authorName)}</span>
            <span class="edit-hist-kind">Original</span>
            <span class="edit-hist-time">${escapeHtml(formatTime(m.ts))}</span>
          </div>
          <div class="edit-hist-diff">
            <div class="edit-diff-orig">${escapeHtml(this._formatPayloadPreview(m.type, origPayload))}</div>
          </div>
        </div>
      `,
    ];

    let prev = origPayload;
    for (let i = 0; i < edits.length; i++) {
      const ed = edits[i];
      const edSpec = this.getPeerColorSpec(ed.author);
      const edStyle = edSpec.styleAttr ? ` style="${edSpec.styleAttr}"` : "";
      rows.push(`
        <div class="edit-hist-row" data-edit-step="${i + 1}">
          <div class="edit-hist-meta">
            <span class="msg-editor-swatch ${edSpec.className}" data-peer-color-id="${escapeHtml(ed.author)}"${edStyle} aria-hidden="true"></span>
            <span class="edit-hist-who">${escapeHtml(ed.authorName)}</span>
            <span class="edit-hist-kind">Edit #${i + 1}</span>
            <span class="edit-hist-time">${escapeHtml(formatTime(ed.ts))}</span>
          </div>
          <div class="edit-hist-diff">
            ${this._buildEditStepDiffHtml(m.type, prev, ed.payload)}
          </div>
        </div>
      `);
      prev = ed.payload;
    }

    return `
      <div class="msg-edit-history" data-edit-history="${escapeHtml(m.id)}">
        <div class="msg-edit-history-title">Edit History (${edits.length} ${edits.length === 1 ? "edit" : "edits"})</div>
        ${rows.join("")}
      </div>
    `;
  }

  deleteLogMessage(msgId) {
    if (!msgId || !this.wasm) return;
    if (this.editingMessageId === msgId) {
      this.editingMessageId = null;
    }
    this.expandedEditHistory.delete(msgId);
    try {
      const res = this.wasm.call({
        cmd: "delete_message",
        targetId: msgId,
        ts: Date.now(),
        entropy: randomBase64Url(16),
      });
      this.status = res.status;
      this.executeActions(res.actions);
      this.renderAll();
      this.showToast("Message deleted for room");
    } catch (err) {
      this.addTelemetry("error", `Delete failed: ${err.message}`);
      this.showToast(`Could not delete message: ${err.message}`);
    }
  }

  handleBotButtonClick(msg, btnObj, btnEl) {
    if (!msg || !btnObj || btnObj.disabled || !this.wasm) return;

    if (typeof btnObj.url === "string" && SAFE_HTTP_URL_RE.test(btnObj.url.trim())) {
      window.open(btnObj.url.trim(), "_blank", "noopener,noreferrer");
      return;
    }

    const actionId = String(btnObj.id || btnObj.actionId || btnObj.label || "action");
    const label = String(btnObj.label || actionId);
    const value = btnObj.value !== undefined ? btnObj.value : null;
    const mode = btnObj.mode === "reply" ? "reply" : "action";

    if (mode === "reply") {
      const replyText =
        typeof btnObj.replyText === "string" && btnObj.replyText.trim()
          ? btnObj.replyText.trim()
          : label;
      try {
        const res = this.wasm.call({
          cmd: "publish",
          type: "chat",
          payload: {
            text: replyText,
            replyTo: {
              messageId: msg.id,
              botPeerId: msg.author,
              botName: msg.authorName,
              actionId,
              label,
              value,
            },
          },
          ts: Date.now(),
          entropy: randomBase64Url(16),
        });
        this.status = res.status;
        this.executeActions(res.actions);
        this.renderAll();
      } catch (err) {
        this.addTelemetry("error", `Bot reply error: ${err.message}`);
      }
      return;
    }

    // Discord-style silent E2EE interaction callback routed to the bot peer
    try {
      const targetBot = msg.author || "*";
      const res = this.wasm.call({
        cmd: "send_bot_action",
        toPeerId: targetBot,
        messageId: msg.id,
        actionId,
        label,
        value,
        ts: Date.now(),
      });
      this.status = res.status;
      this.executeActions(res.actions);

      if (btnEl) {
        const origHtml = btnEl.innerHTML;
        btnEl.classList.add("is-sent");
        btnEl.textContent = `${label} ✓`;
        setTimeout(() => {
          if (btnEl.isConnected) {
            btnEl.classList.remove("is-sent");
            btnEl.innerHTML = origHtml;
          }
        }, 700);
      }
    } catch (err) {
      this.addTelemetry("error", `Bot action failed: ${err.message}`);
      this.showToast(`Bot action failed: ${err.message}`);
    }
  }

  _registerMessageMediaUrl(msgId, url) {
    if (!msgId || !url) return;
    let entry = this.mediaBlobRegistry.get(msgId);
    if (!entry) {
      entry = new Set();
      this.mediaBlobRegistry.set(msgId, entry);
    }
    entry.add(url);
  }

  _swapMessageMediaUrl(msgId, oldUrl, newUrl) {
    const entry = this.mediaBlobRegistry.get(msgId);
    if (entry && oldUrl) {
      entry.delete(oldUrl);
    }
    if (oldUrl && oldUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(oldUrl);
      } catch {
        // ignore
      }
    }
    this._registerMessageMediaUrl(msgId, newUrl);
  }

  _revokeMessageMediaUrls(msgId) {
    this._cleanupMediaBindingsForMsg(msgId);
    const entry = this.mediaBlobRegistry.get(msgId);
    if (!entry) return;
    for (const url of entry) {
      if (url && url.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
    }
    this.mediaBlobRegistry.delete(msgId);
  }

  _revokeAllMediaUrls() {
    for (const msgId of Array.from(this.mediaBlobRegistry.keys())) {
      this._revokeMessageMediaUrls(msgId);
    }
  }

  renderChatPayload(payload, msgId = "") {
    const parts = [];
    const gifBindings = [];
    const videoBindings = [];
    if (payload.replyTo && typeof payload.replyTo === "object") {
      const targetName = escapeHtml(payload.replyTo.botName || "Bot");
      const viaLabel = escapeHtml(payload.replyTo.label || payload.replyTo.actionId || "Button");
      parts.push(
        `<div class="chat-reply-banner"><span>↳ Answer to <strong>${targetName}</strong> · ${viaLabel}</span></div>`
      );
    }

    const text = typeof payload.text === "string" ? payload.text : "";
    if (text) {
      const { html, links } = extractAndLinkify(text);
      parts.push(`<div class="log-text-body">${html}</div>`);
      if (links.length > 0) {
        const cards = links
          .map((lnk) => {
            const watch = parseWatchMediaUrl(lnk.href);
            if (watch) {
              return `
                <div class="chat-media-link-card provider-${escapeHtml(watch.provider)}" data-watch-provider="${escapeHtml(watch.provider)}">
                  <div class="chat-media-link-info">
                    <div class="chat-media-link-top">
                      <span class="chat-media-provider-tag">${escapeHtml(watch.providerLabel)}</span>
                      <span class="chat-media-link-sub">${escapeHtml(watch.subtitle)}</span>
                    </div>
                    <span class="chat-media-link-title" title="${escapeHtml(watch.url)}">${escapeHtml(watch.title)}</span>
                  </div>
                  <div class="chat-media-link-actions">
                    <button type="button" class="chat-watch-cta" data-watch-play="${escapeHtml(watch.url)}">▶ ${escapeHtml(watch.ctaLabel)}</button>
                    <button type="button" class="media-ctrl-btn" data-watch-queue="${escapeHtml(watch.url)}" title="Add to Watch Together queue">+ Queue</button>
                    <a class="chat-media-link-ext" href="${escapeHtml(watch.url)}" target="_blank" rel="noopener noreferrer" title="Open link in new tab">↗</a>
                  </div>
                </div>
              `;
            }
            return `
              <a class="chat-link-card" href="${escapeHtml(lnk.href)}" target="_blank" rel="noopener noreferrer">
                ${LINK_ARROW_SVG}
                <span class="chat-link-host">${escapeHtml(lnk.host)}</span>
                <span class="chat-link-path">${escapeHtml(lnk.path)}</span>
              </a>
            `;
          })
          .join("");
        parts.push(`<div class="chat-link-cards">${cards}</div>`);
      }
    }

    const mediaCards = [];

    if (Array.isArray(payload.images) && payload.images.length > 0) {
      const validImages = payload.images.filter(
        (img) => img && typeof img.dataUrl === "string" && isSafeImageDataUrl(img.dataUrl)
      );
      for (const img of validImages) {
        const alt = escapeHtml(img.name || "Shared image");
        const isAnimated = Boolean(img.animated || img.dataUrl.startsWith("data:image/gif;"));
        if (isAnimated) {
          const idx = gifBindings.length;
          const asyncDecode = img.dataUrl.length > 65536;
          const blob = asyncDecode ? null : dataUrlToBlob(img.dataUrl);
          const srcUrl = asyncDecode ? "" : blob ? URL.createObjectURL(blob) : img.dataUrl;
          if (blob && msgId) {
            this._registerMessageMediaUrl(msgId, srcUrl);
          }
          const dims = img.width && img.height ? `${img.width}×${img.height}` : "";
          const approxBytes = img.bytes || Math.round((img.dataUrl.length * 3) / 4);
          const metaParts = [dims, approxBytes ? formatByteSize(approxBytes) : ""].filter(Boolean);
          const metaLabel = metaParts.join(" · ");
          gifBindings.push({
            idx,
            blob,
            asyncDecode,
            dataUrl: img.dataUrl,
            currentUrl: srcUrl,
            alt: img.name || "Animated GIF",
            metaLabel,
          });
          const srcAttr = srcUrl ? ` src="${srcUrl}"` : "";
          mediaCards.push(`
            <div class="chat-media-card is-gif" data-gif-card="${idx}">
              <div class="chat-media-stage">
                <span class="chat-media-badge">GIF</span>
                <button type="button" class="chat-image-btn" data-gif-expand="${idx}" aria-label="View full size GIF">
                  <img class="chat-image-thumb" data-gif-img="${idx}"${srcAttr} alt="${alt}" loading="lazy" />
                </button>
                <canvas class="gif-sync-canvas hidden" data-gif-sync-canvas="${idx}" aria-hidden="true"></canvas>
                <canvas class="gif-freeze-canvas hidden" data-gif-canvas="${idx}" aria-hidden="true"></canvas>
              </div>
              <div class="chat-media-bar">
                <button type="button" class="media-ctrl-btn" data-gif-replay="${idx}" title="Replay GIF from frame 1 (synced)">↺ Replay</button>
                <button type="button" class="media-ctrl-btn" data-gif-pause="${idx}" title="Pause or resume GIF (synced)">Pause</button>
                <button type="button" class="media-ctrl-btn" data-gif-expand="${idx}" title="Open full size">⤢</button>
                <span class="chat-media-sync-pill" data-gif-sync-pill="${idx}" title="Frame-synchronized across all peers">Synced</span>
                <span class="chat-media-meta">${escapeHtml(metaLabel)}</span>
              </div>
            </div>
          `);
        } else {
          mediaCards.push(`
            <button type="button" class="chat-image-btn" data-lightbox-src="${img.dataUrl}" data-lightbox-alt="${alt}">
              <img class="chat-image-thumb" src="${img.dataUrl}" alt="${alt}" loading="lazy" />
            </button>
          `);
        }
      }
    }

    if (Array.isArray(payload.videos) && payload.videos.length > 0) {
      const validVideos = payload.videos.filter(
        (vid) => vid && typeof vid.dataUrl === "string" && isSafeVideoDataUrl(vid.dataUrl)
      );
      for (const vid of validVideos) {
        const idx = videoBindings.length;
        const asyncDecode = vid.dataUrl.length > 65536;
        const blob = asyncDecode ? null : dataUrlToBlob(vid.dataUrl);
        const srcUrl = asyncDecode ? "" : blob ? URL.createObjectURL(blob) : vid.dataUrl;
        if (blob && msgId) {
          this._registerMessageMediaUrl(msgId, srcUrl);
        }
        const durStr =
          typeof vid.duration === "number" && Number.isFinite(vid.duration) && vid.duration > 0
            ? formatMediaDuration(vid.duration)
            : "";
        const dims = vid.width && vid.height ? `${vid.width}×${vid.height}` : "";
        const approxBytes = vid.bytes || Math.round((vid.dataUrl.length * 3) / 4);
        const metaParts = [durStr, dims, approxBytes ? formatByteSize(approxBytes) : ""].filter(Boolean);
        const metaLabel = metaParts.join(" · ");
        videoBindings.push({
          idx,
          blob,
          asyncDecode,
          dataUrl: vid.dataUrl,
          srcUrl,
          alt: vid.name || "Shared video",
          metaLabel,
        });
        const vidSrcAttr = srcUrl ? ` src="${srcUrl}"` : "";
        mediaCards.push(`
          <div class="chat-media-card is-video" data-video-card="${idx}">
            <div class="chat-media-stage">
              <span class="chat-media-badge">VIDEO</span>
              <video
                class="chat-video-player"
                data-video-el="${idx}"${vidSrcAttr}
                controls
                playsinline
                preload="metadata"
              ></video>
              <button type="button" class="video-unmute-overlay hidden" data-video-unmute="${idx}">Muted by browser · Tap to unmute (local only)</button>
              <div class="video-ended-overlay hidden" data-video-ended="${idx}">
                <button type="button" class="video-replay-overlay-btn" data-video-replay="${idx}">↺ Replay Video</button>
              </div>
            </div>
            <div class="chat-media-bar">
              <button type="button" class="media-ctrl-btn" data-video-replay="${idx}" title="Replay video from 0:00 (synced)">↺ Replay</button>
              <button type="button" class="media-ctrl-btn" data-video-loop="${idx}" title="Toggle loop playback (synced)">Loop: Off</button>
              <button type="button" class="media-ctrl-btn" data-video-expand="${idx}" title="Open full size">⤢</button>
              <span class="chat-media-sync-pill" data-video-sync-pill="${idx}" title="Playback synced across peers (volume stays local)">Synced</span>
              <span class="chat-media-meta">${escapeHtml(metaLabel)}</span>
            </div>
          </div>
        `);
      }
    }

    if (mediaCards.length > 0) {
      parts.push(`<div class="chat-image-grid">${mediaCards.join("")}</div>`);
    }

    return {
      html: parts.join(""),
      gifBindings,
      videoBindings,
    };
  }

  normalizeBotButtonRows(rawButtons) {
    if (!Array.isArray(rawButtons) || rawButtons.length === 0) return [];
    const rows = Array.isArray(rawButtons[0]) ? rawButtons : [rawButtons];
    const cleanRows = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const cleanBtns = row.filter((b) => b && typeof b === "object" && (b.label || b.id));
      if (cleanBtns.length > 0) {
        cleanRows.push(cleanBtns);
      }
    }
    return cleanRows;
  }

  renderBotCardPayload(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const allowedColors = new Set(["cobalt", "mint", "ochre", "coral", "cyan", "ink"]);
    const accent = allowedColors.has(p.color) ? p.color : "cobalt";
    const parts = [];

    if (p.title || p.subtitle || p.badge) {
      const subHtml = p.subtitle
        ? `<span class="bot-card-subtitle">${escapeHtml(p.subtitle)}</span>`
        : "";
      const titleHtml = p.title
        ? `<h3 class="bot-card-title">${escapeHtml(p.title)}</h3>`
        : "";
      const badgeHtml = p.badge
        ? `<span class="bot-card-badge">${escapeHtml(p.badge)}</span>`
        : "";
      parts.push(`
        <div class="bot-card-head">
          <div class="bot-card-titles">${subHtml}${titleHtml}</div>
          ${badgeHtml}
        </div>
      `);
    }

    if (typeof p.text === "string" && p.text.trim()) {
      parts.push(`<div class="bot-card-text">${formatBotRichText(p.text)}</div>`);
    }

    if (Array.isArray(p.fields) && p.fields.length > 0) {
      const fieldHtml = p.fields
        .filter((f) => f && typeof f === "object" && (f.label || f.value !== undefined))
        .map((f) => {
          const fullCls = f.inline === false ? " is-full" : "";
          return `
            <div class="bot-field${fullCls}">
              <span class="bot-field-label">${escapeHtml(f.label || "")}</span>
              <span class="bot-field-value">${formatBotRichText(f.value ?? "")}</span>
            </div>
          `;
        })
        .join("");
      if (fieldHtml) {
        parts.push(`<div class="bot-card-fields">${fieldHtml}</div>`);
      }
    }

    const imgSrc =
      typeof p.image === "string"
        ? p.image
        : p.image && typeof p.image === "object"
          ? p.image.dataUrl || p.image.url || ""
          : "";
    if (isSafeImageSrc(imgSrc)) {
      const alt = escapeHtml((p.image && p.image.alt) || p.title || "Bot attachment");
      parts.push(`
        <button type="button" class="bot-card-image-btn" data-lightbox-src="${escapeHtml(imgSrc)}" data-lightbox-alt="${alt}">
          <img src="${escapeHtml(imgSrc)}" alt="${alt}" loading="lazy" />
        </button>
      `);
    }

    const buttonRows = this.normalizeBotButtonRows(p.buttons);
    const flatButtons = [];
    if (buttonRows.length > 0) {
      const allowedStyles = new Set(["primary", "success", "warning", "danger", "secondary"]);
      const rowsHtml = buttonRows
        .map((row) => {
          const btnsHtml = row
            .map((btn) => {
              const idx = flatButtons.length;
              flatButtons.push(btn);
              const style = allowedStyles.has(btn.style) ? btn.style : "secondary";
              const label = escapeHtml(btn.label || btn.id || "Action");
              const isLink = typeof btn.url === "string" && SAFE_HTTP_URL_RE.test(btn.url.trim());
              const suffix = isLink ? ` ${LINK_ARROW_SVG}` : "";
              const disabledAttr = btn.disabled ? " disabled" : "";
              return `<button type="button" class="bot-btn bot-btn-${style}" data-bot-btn-idx="${idx}" data-bot-action-id="${escapeHtml(btn.id || btn.actionId || "")}"${disabledAttr}>${label}${suffix}</button>`;
            })
            .join("");
          return `<div class="bot-btn-row">${btnsHtml}</div>`;
        })
        .join("");
      parts.push(`<div class="bot-card-actions">${rowsHtml}</div>`);
    }

    if (typeof p.footer === "string" && p.footer.trim()) {
      parts.push(`<div class="bot-card-footer">${escapeHtml(p.footer)}</div>`);
    }

    return {
      html: `<div class="bot-card bot-accent-${accent}">${parts.join("")}</div>`,
      buttons: flatButtons,
    };
  }

  buildLogEntryElement(m, isSelf, isNew) {
    const stripeColor = this.getPeerColorSpec(m.author);
    const stripeStyle = stripeColor.styleAttr ? ` style="${stripeColor.styleAttr}"` : "";
    const isBotMsg = m.type === "bot" && m.payload && typeof m.payload === "object";
    const isChat =
      m.type === "chat" &&
      m.payload &&
      (typeof m.payload.text === "string" ||
        Array.isArray(m.payload.images) ||
        Array.isArray(m.payload.videos));
    const isEditing = this.editingMessageId === m.id;
    const isHistOpen = Boolean(m.updatedLamport && this.expandedEditHistory.has(m.id));

    let bodyHtml;
    let botButtons = [];
    let gifBindings = [];
    let videoBindings = [];
    if (isBotMsg) {
      const rendered = this.renderBotCardPayload(m.payload);
      bodyHtml = rendered.html;
      botButtons = rendered.buttons;
    } else if (isChat) {
      const rendered = this.renderChatPayload(m.payload, m.id);
      bodyHtml = rendered.html;
      gifBindings = rendered.gifBindings;
      videoBindings = rendered.videoBindings;
    } else {
      bodyHtml = `<pre class="log-json-pre">${escapeHtml(JSON.stringify(m.payload, null, 2))}</pre>`;
    }

    let editFormHtml = "";
    if (isEditing) {
      const hasMedia =
        isChat &&
        m.payload &&
        ((Array.isArray(m.payload.images) && m.payload.images.length > 0) ||
          (Array.isArray(m.payload.videos) && m.payload.videos.length > 0));
      const initialValue = isChat
        ? String(m.payload?.text ?? "")
        : JSON.stringify(m.payload ?? {}, null, 2);
      const hintText = isChat
        ? hasMedia
          ? "Enter to save · Esc to cancel · Attached media is preserved"
          : "Enter to save · Shift+Enter for newline · Esc to cancel"
        : "Ctrl/Cmd+Enter to save JSON · Esc to cancel";
      editFormHtml = `
        <form class="msg-edit-form" data-edit-form="${escapeHtml(m.id)}">
          <textarea
            class="msg-edit-input${isChat ? "" : " is-json"}"
            aria-label="Edit message content"
          >${escapeHtml(initialValue)}</textarea>
          <div class="msg-edit-error hidden" data-edit-error></div>
          <div class="msg-edit-bar">
            <span class="msg-edit-hint">${escapeHtml(hintText)}</span>
            <div class="msg-edit-actions">
              <button type="button" class="btn btn-sm" data-edit-cancel>Cancel</button>
              <button type="submit" class="btn btn-sm btn-primary" data-edit-save>Save Edit</button>
            </div>
          </div>
        </form>
      `;
    }

    const showBotTag = isBotMsg || this.isPeerBot(m.author);
    const botTagHtml = showBotTag ? '<span class="bot-tag">BOT</span>' : "";
    const typeTag =
      isChat || isBotMsg ? "" : `<span class="log-type-tag">${escapeHtml(m.type)}</span>`;

    let updatedTag = "";
    if (m.updatedLamport) {
      const editorId = m.editedBy || m.author;
      const editorName = m.editedByName || m.authorName || "Peer";
      const editorSpec = this.getPeerColorSpec(editorId);
      const editorStyle = editorSpec.styleAttr ? ` style="${editorSpec.styleAttr}"` : "";
      const editCount = Number(m.editCount) || (Array.isArray(m.edits) ? m.edits.length : 1);
      const countLabel = editCount > 1 ? ` · ${editCount} edits` : "";
      updatedTag = `
        <button
          type="button"
          class="bot-updated-tag msg-edited-pill${isHistOpen ? " is-open" : ""}"
          data-toggle-edit-history="${escapeHtml(m.id)}"
          aria-expanded="${isHistOpen ? "true" : "false"}"
          title="Edited by ${escapeHtml(editorName)} — click to view edit history"
        >
          <span class="msg-editor-swatch ${editorSpec.className}" data-peer-color-id="${escapeHtml(editorId)}"${editorStyle} aria-hidden="true"></span>
          <span>edited by ${escapeHtml(editorName)}${escapeHtml(countLabel)}</span>
          <span class="msg-edited-chevron" aria-hidden="true">${isHistOpen ? "▴" : "▾"}</span>
        </button>
      `;
    }

    const historyHtml = isHistOpen ? this._renderEditHistoryHtml(m) : "";
    const effectiveRev = `${messageEditRev(m)}:${isEditing ? "edit" : "view"}:${isHistOpen ? "h1" : "h0"}`;

    const article = document.createElement("article");
    article.className = `log-entry${isSelf ? " is-self" : ""}${isBotMsg ? " is-bot-entry" : ""}${isEditing ? " is-editing" : ""}${isNew ? " is-new" : ""}`;
    article.dataset.msgId = m.id;
    article.dataset.rev = effectiveRev;
    article.innerHTML = `
      <div class="msg-stripe ${stripeColor.className}" data-msg-author="${escapeHtml(m.author)}"${stripeStyle} aria-hidden="true"></div>
      <div class="log-entry-main">
        <div class="log-entry-head">
          <div class="log-author-group">
            <span class="log-author">${escapeHtml(m.authorName)}</span>
            ${botTagHtml}
            ${typeTag}
            ${updatedTag}
          </div>
          <div class="log-head-right">
            <span class="log-order-tuple" title="Order (lamport ${m.lamport}) · ${escapeHtml(m.id)}">
              ${escapeHtml(formatTime(m.ts))}
            </span>
            <button
              type="button"
              class="msg-edit-btn"
              data-edit-msg="${escapeHtml(m.id)}"
              title="Edit message (appends a new edit event visible in raw log)"
              aria-label="Edit message"
            >${PENCIL_SVG}</button>
            <button
              type="button"
              class="msg-delete-btn"
              data-delete-msg="${escapeHtml(m.id)}"
              title="Delete message for everyone in room"
              aria-label="Delete message"
            >${TRASH_SVG}</button>
          </div>
        </div>
        ${isEditing ? editFormHtml : bodyHtml}
        ${historyHtml}
      </div>
    `;

    const histBtn = article.querySelector("[data-toggle-edit-history]");
    if (histBtn) {
      histBtn.addEventListener("click", () => this.toggleEditHistory(m.id));
    }

    const editBtn = article.querySelector("[data-edit-msg]");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        if (this.editingMessageId === m.id) {
          this.cancelEditMessage();
        } else {
          this.startEditMessage(m.id);
        }
      });
    }

    if (isEditing) {
      const formEl = article.querySelector("[data-edit-form]");
      const inputEl = formEl?.querySelector(".msg-edit-input");
      const errEl = formEl?.querySelector("[data-edit-error]");
      const cancelBtn = formEl?.querySelector("[data-edit-cancel]");
      const showEditError = (msgText) => {
        if (!errEl) return;
        errEl.textContent = msgText;
        errEl.classList.remove("hidden");
      };
      const commitInlineEdit = () => {
        if (!inputEl) return;
        const rawVal = inputEl.value;
        if (isChat) {
          const trimmed = rawVal.trim();
          const hasMedia =
            m.payload &&
            ((Array.isArray(m.payload.images) && m.payload.images.length > 0) ||
              (Array.isArray(m.payload.videos) && m.payload.videos.length > 0));
          if (!trimmed && !hasMedia) {
            showEditError("Message text cannot be empty (use delete instead).");
            return;
          }
          if (trimmed === String(m.payload?.text ?? "").trim()) {
            this.cancelEditMessage();
            return;
          }
          this.submitEditMessage(m.id, { text: trimmed });
        } else {
          let parsed;
          try {
            parsed = JSON.parse(rawVal);
          } catch (err) {
            showEditError(`Invalid JSON: ${err.message}`);
            return;
          }
          if (parsed === null || typeof parsed !== "object") {
            showEditError("Edited payload must be a valid JSON object or array.");
            return;
          }
          this.submitEditMessage(m.id, parsed);
        }
      };

      if (cancelBtn) {
        cancelBtn.addEventListener("click", () => this.cancelEditMessage());
      }
      if (inputEl) {
        inputEl.addEventListener("keydown", (ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            this.cancelEditMessage();
          } else if (ev.key === "Enter" && ((isChat && !ev.shiftKey) || (!isChat && (ev.ctrlKey || ev.metaKey)))) {
            ev.preventDefault();
            commitInlineEdit();
          }
        });
      }
      if (formEl) {
        formEl.addEventListener("submit", (ev) => {
          ev.preventDefault();
          commitInlineEdit();
        });
      }
    }

    const delBtn = article.querySelector("[data-delete-msg]");
    if (delBtn) {
      delBtn.addEventListener("click", () => this.deleteLogMessage(m.id));
    }

    for (const btn of article.querySelectorAll("[data-lightbox-src]")) {
      btn.addEventListener("click", () =>
        this.openLightbox(btn.dataset.lightboxSrc, btn.dataset.lightboxAlt)
      );
    }

    for (const btn of article.querySelectorAll("[data-watch-play]")) {
      btn.addEventListener("click", () => {
        if (btn.dataset.watchPlay) {
          this.startWatchTogetherFromUrl(btn.dataset.watchPlay, m.id);
        }
      });
    }

    for (const btn of article.querySelectorAll("[data-watch-queue]")) {
      btn.addEventListener("click", () => {
        if (btn.dataset.watchQueue) {
          this.enqueueWatchUrl(btn.dataset.watchQueue);
        }
      });
    }

    // Interactive animated GIF controls (Frame-accurate E2EE sync, 1-click Replay, Pause/Play, Lightbox)
    for (const g of gifBindings) {
      const syncTargetId = m.id ? `gif:${m.id}:${g.idx}` : "";
      const imgEl = article.querySelector(`[data-gif-img="${g.idx}"]`);
      const syncCanvasEl = article.querySelector(`[data-gif-sync-canvas="${g.idx}"]`);
      const canvasEl = article.querySelector(`[data-gif-canvas="${g.idx}"]`);
      const replayBtn = article.querySelector(`[data-gif-replay="${g.idx}"]`);
      const pauseBtn = article.querySelector(`[data-gif-pause="${g.idx}"]`);
      const syncPillEl = article.querySelector(`[data-gif-sync-pill="${g.idx}"]`);

      const bind = {
        syncTargetId,
        msgId: m.id,
        g,
        imgEl,
        syncCanvasEl,
        canvasEl,
        replayBtn,
        pauseBtn,
        syncPillEl,
        timings: null,
        decoder: null,
        decoding: false,
        pendingRender: null,
        lastRenderedFrame: -1,
        lastAppliedEpoch: 0,
        isPaused: false,
      };

      if (syncTargetId) {
        const existingBind = this.mediaSync.gifBindings.get(syncTargetId);
        if (existingBind) {
          this._disposeGifBinding(existingBind);
        }
        this.mediaSync.gifBindings.set(syncTargetId, bind);
      }

      if (g.asyncDecode && !g.blob && imgEl) {
        dataUrlToBlobAsync(g.dataUrl).then((blob) => {
          if (!this.logMessages.some((item) => item.id === m.id)) return;
          if (blob) {
            const url = URL.createObjectURL(blob);
            g.blob = blob;
            g.currentUrl = url;
            this._registerMessageMediaUrl(m.id, url);
            imgEl.src = url;
            if (syncTargetId) {
              this._initGifSyncEngine(bind, blob);
            }
          } else {
            g.currentUrl = g.dataUrl;
            imgEl.src = g.dataUrl;
          }
        });
      } else if (g.blob && syncTargetId) {
        this._initGifSyncEngine(bind, g.blob);
      }

      if (syncTargetId && this.mediaSync.states.has(syncTargetId)) {
        this._applyGifSyncState(bind, this.mediaSync.states.get(syncTargetId), null);
      }

      const replayGif = () => {
        if (!imgEl) return;
        if (syncTargetId && this.wasm) {
          const prev = this.mediaSync.states.get(syncTargetId);
          this.publishMediaSync({
            targetId: syncTargetId,
            kind: "gif",
            active: true,
            playing: true,
            positionMs: 0,
            rateMilli: 1000,
            loop: true,
            epoch: (prev?.epoch || 0) + 1,
            sourceMsgId: m.id,
          });
          return;
        }
        bind.isPaused = false;
        if (canvasEl) canvasEl.classList.add("hidden");
        if (pauseBtn) {
          pauseBtn.textContent = "Pause";
          pauseBtn.classList.remove("is-active");
        }
        if (g.blob) {
          const prevUrl = g.currentUrl;
          const nextUrl = URL.createObjectURL(g.blob);
          g.currentUrl = nextUrl;
          this._swapMessageMediaUrl(m.id, prevUrl, nextUrl);
          imgEl.src = nextUrl;
        } else {
          imgEl.src = "";
          requestAnimationFrame(() => {
            imgEl.src = g.dataUrl;
          });
        }
        imgEl.dataset.replayCount = String((Number(imgEl.dataset.replayCount) || 0) + 1);
        if (replayBtn) {
          replayBtn.classList.add("is-replayed");
          setTimeout(() => replayBtn.classList.remove("is-replayed"), 320);
        }
      };

      if (replayBtn) {
        replayBtn.addEventListener("click", replayGif);
      }

      if (pauseBtn && imgEl && canvasEl) {
        pauseBtn.addEventListener("click", () => {
          if (!bind.isPaused) {
            if (syncTargetId && this.wasm) {
              const cur = this.mediaSync.states.get(syncTargetId);
              let posMs = cur ? projectMediaPositionMs(cur, Date.now()) : 0;
              if (bind.timings && bind.timings.totalDurationMs > 0) {
                posMs = posMs % bind.timings.totalDurationMs;
              }
              this.publishMediaSync({
                targetId: syncTargetId,
                kind: "gif",
                active: true,
                playing: false,
                positionMs: posMs,
                rateMilli: 1000,
                loop: true,
                epoch: cur?.epoch || 0,
                sourceMsgId: m.id,
              });
              return;
            }
            const w = imgEl.naturalWidth || imgEl.width || 0;
            const h = imgEl.naturalHeight || imgEl.height || 0;
            if (w > 0 && h > 0) {
              canvasEl.width = w;
              canvasEl.height = h;
              const ctx2d = canvasEl.getContext("2d");
              if (ctx2d) {
                ctx2d.clearRect(0, 0, w, h);
                ctx2d.drawImage(imgEl, 0, 0, w, h);
                canvasEl.classList.remove("hidden");
              }
            }
            bind.isPaused = true;
            pauseBtn.textContent = "Play";
            pauseBtn.classList.add("is-active");
          } else {
            if (syncTargetId && this.wasm) {
              const cur = this.mediaSync.states.get(syncTargetId);
              this.publishMediaSync({
                targetId: syncTargetId,
                kind: "gif",
                active: true,
                playing: true,
                positionMs: cur?.positionMs || 0,
                rateMilli: 1000,
                loop: true,
                epoch: cur?.epoch || 0,
                sourceMsgId: m.id,
              });
              return;
            }
            replayGif();
          }
        });
      }

      for (const expBtn of article.querySelectorAll(`[data-gif-expand="${g.idx}"]`)) {
        expBtn.addEventListener("click", () => {
          this.openLightbox({
            kind: "gif",
            src: g.currentUrl || g.dataUrl,
            blob: g.blob,
            dataUrl: g.dataUrl,
            alt: g.alt,
            meta: g.metaLabel ? `${g.alt} · ${g.metaLabel}` : g.alt,
            syncTargetId,
          });
        });
      }
    }

    // Interactive Video controls (Bidirectional E2EE sync excluding volume/mute, Replay, Loop, Lightbox)
    for (const v of videoBindings) {
      const syncTargetId = m.id ? `vid:${m.id}:${v.idx}` : "";
      const videoEl = article.querySelector(`[data-video-el="${v.idx}"]`);
      const endedOverlay = article.querySelector(`[data-video-ended="${v.idx}"]`);
      const unmuteOverlay = article.querySelector(`[data-video-unmute="${v.idx}"]`);
      const loopBtn = article.querySelector(`[data-video-loop="${v.idx}"]`);
      const replayBtns = article.querySelectorAll(`[data-video-replay="${v.idx}"]`);
      const expandBtn = article.querySelector(`[data-video-expand="${v.idx}"]`);
      const syncPillEl = article.querySelector(`[data-video-sync-pill="${v.idx}"]`);

      const bind = {
        syncTargetId,
        msgId: m.id,
        videoEl,
        endedOverlay,
        unmuteOverlay,
        loopBtn,
        replayBtns: Array.from(replayBtns),
        syncPillEl,
        applyingRemote: false,
        suppressUntil: 0,
        lastAppliedEpoch: 0,
      };

      if (syncTargetId) {
        this.mediaSync.videoBindings.set(syncTargetId, bind);
      }

      const publishLocalVideoState = (overrides = {}) => {
        if (!syncTargetId || !this.wasm || !videoEl) return;
        const prev = this.mediaSync.states.get(syncTargetId);
        this.publishMediaSync({
          targetId: syncTargetId,
          kind: "video",
          active: true,
          playing: !videoEl.paused && !videoEl.ended,
          positionMs: Math.max(0, Math.round((videoEl.currentTime || 0) * 1000)),
          rateMilli: Math.round((videoEl.playbackRate || 1) * 1000),
          loop: Boolean(videoEl.loop),
          epoch: prev?.epoch || 0,
          sourceMsgId: m.id,
          ...overrides,
        });
      };

      if (v.asyncDecode && !v.blob && videoEl) {
        dataUrlToBlobAsync(v.dataUrl).then((blob) => {
          if (!this.logMessages.some((item) => item.id === m.id)) return;
          if (blob) {
            const url = URL.createObjectURL(blob);
            v.blob = blob;
            v.srcUrl = url;
            this._registerMessageMediaUrl(m.id, url);
            videoEl.src = url;
          } else {
            v.srcUrl = v.dataUrl;
            videoEl.src = v.dataUrl;
          }
          if (syncTargetId && this.mediaSync.states.has(syncTargetId)) {
            this._applyVideoSyncState(bind, this.mediaSync.states.get(syncTargetId), null);
          }
        });
      } else if (syncTargetId && this.mediaSync.states.has(syncTargetId)) {
        this._applyVideoSyncState(bind, this.mediaSync.states.get(syncTargetId), null);
      }

      const replayVideo = () => {
        if (!videoEl) return;
        if (syncTargetId && this.wasm) {
          const prev = this.mediaSync.states.get(syncTargetId);
          publishLocalVideoState({
            playing: true,
            positionMs: 0,
            epoch: (prev?.epoch || 0) + 1,
          });
          return;
        }
        if (endedOverlay) endedOverlay.classList.add("hidden");
        try {
          videoEl.currentTime = 0;
        } catch {
          // ignore if metadata not yet loaded
        }
        const playPromise = videoEl.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {});
        }
        videoEl.dataset.replayCount = String((Number(videoEl.dataset.replayCount) || 0) + 1);
        for (const rb of replayBtns) {
          if (rb.classList.contains("media-ctrl-btn")) {
            rb.classList.add("is-replayed");
            setTimeout(() => rb.classList.remove("is-replayed"), 320);
          }
        }
      };

      if (videoEl) {
        videoEl.addEventListener("ended", () => {
          if (!videoEl.loop && endedOverlay) {
            endedOverlay.classList.remove("hidden");
          }
        });
        videoEl.addEventListener("play", () => {
          if (endedOverlay) endedOverlay.classList.add("hidden");
          if (bind.applyingRemote || performance.now() < bind.suppressUntil) return;
          publishLocalVideoState({ playing: true });
        });
        videoEl.addEventListener("pause", () => {
          if (bind.applyingRemote || performance.now() < bind.suppressUntil) return;
          if (videoEl.ended) return;
          publishLocalVideoState({ playing: false });
        });
        videoEl.addEventListener("seeking", () => {
          if (endedOverlay) endedOverlay.classList.add("hidden");
        });
        videoEl.addEventListener("seeked", () => {
          if (bind.applyingRemote || performance.now() < bind.suppressUntil) return;
          const st = this.mediaSync.states.get(syncTargetId);
          const expectedSec = st ? projectMediaPositionMs(st, Date.now()) / 1000 : -1;
          if (!st || Math.abs((videoEl.currentTime || 0) - expectedSec) > 0.3) {
            publishLocalVideoState();
          }
        });
        videoEl.addEventListener("ratechange", () => {
          if (bind.applyingRemote || performance.now() < bind.suppressUntil) return;
          const st = this.mediaSync.states.get(syncTargetId);
          const expectedRate = st ? (st.rateMilli || 1000) / 1000 : 1;
          if (Math.abs((videoEl.playbackRate || 1) - expectedRate) > 0.08) {
            publishLocalVideoState();
          }
        });
      }

      if (unmuteOverlay && videoEl) {
        unmuteOverlay.addEventListener("click", () => {
          // Local-only unmute — never broadcast volume or mute state
          videoEl.muted = false;
          unmuteOverlay.classList.add("hidden");
        });
      }

      for (const rb of replayBtns) {
        rb.addEventListener("click", replayVideo);
      }

      if (loopBtn && videoEl) {
        loopBtn.addEventListener("click", () => {
          const nextLoop = !videoEl.loop;
          if (syncTargetId && this.wasm) {
            publishLocalVideoState({ loop: nextLoop });
            return;
          }
          videoEl.loop = nextLoop;
          loopBtn.textContent = videoEl.loop ? "Loop: On" : "Loop: Off";
          loopBtn.classList.toggle("is-active", videoEl.loop);
          if (videoEl.loop && endedOverlay) {
            endedOverlay.classList.add("hidden");
          }
        });
      }

      if (expandBtn && videoEl) {
        expandBtn.addEventListener("click", () => {
          bind.applyingRemote = true;
          bind.suppressUntil = performance.now() + 450;
          try {
            videoEl.pause();
          } catch {
            // ignore
          }
          bind.applyingRemote = false;
          this.openLightbox({
            kind: "video",
            src: v.srcUrl || v.dataUrl,
            blob: v.blob,
            dataUrl: v.dataUrl,
            alt: v.alt,
            meta: v.metaLabel ? `${v.alt} · ${v.metaLabel}` : v.alt,
            loop: Boolean(videoEl.loop),
            syncTargetId,
          });
        });
      }
    }

    for (const btnEl of article.querySelectorAll("[data-bot-btn-idx]")) {
      const idx = Number(btnEl.dataset.botBtnIdx);
      const btnObj = botButtons[idx];
      if (btnObj) {
        btnEl.addEventListener("click", () => this.handleBotButtonClick(m, btnObj, btnEl));
      }
    }

    return article;
  }

  renderLog() {
    const feed = this.el["log-feed"];
    const query = this.advancedMode ? this.el["log-search-input"].value.trim().toLowerCase() : "";
    const typeFilter = this.advancedMode ? this.el["log-type-filter"].value : "";

    // Raw JSON mode renders the COMPLETE immutable append-only event log (originals + msg-edit + msg-delete)
    if (this.advancedMode && this.rawJsonMode) {
      let rawEvents = [];
      if (this.wasm) {
        try {
          const rawRes = this.wasm.call({ cmd: "get_raw_log", compactMedia: true });
          rawEvents = Array.isArray(rawRes.rawLog) ? rawRes.rawLog : [];
        } catch {
          rawEvents = this.logMessages;
        }
      }
      const rawKey = `raw:${this.status?.rawLogCount || rawEvents.length}:${this.status?.lamport || 0}:${typeFilter}:${query}:${rawEvents.map((m) => m.id).join(",")}`;
      if (this.logRenderState.mode === "raw" && this.logRenderState.key === rawKey) {
        return;
      }
      this._revokeAllMediaUrls();

      const deletedTargets = new Set();
      let editEventsCount = 0;
      let deleteEventsCount = 0;
      let rootEventsCount = 0;
      for (const ev of rawEvents) {
        if (ev.type === "msg-delete") {
          deleteEventsCount++;
          if (ev.payload && typeof ev.payload.targetId === "string") {
            deletedTargets.add(ev.payload.targetId);
          }
        } else if (ev.type === "msg-edit" || ev.type === "bot-update") {
          editEventsCount++;
        } else {
          rootEventsCount++;
        }
      }

      const rawFiltered = rawEvents.filter((m) => {
        if (typeFilter && m.type !== typeFilter) return false;
        if (!query) return true;
        return JSON.stringify(m).toLowerCase().includes(query);
      });

      if (rawFiltered.length === 0) {
        const emptyText =
          rawEvents.length === 0
            ? "No raw events recorded yet."
            : "No raw events match your current filter.";
        feed.innerHTML = `<div class="empty-state">${emptyText}</div>`;
        this.logRenderState = { mode: "raw", key: rawKey };
        return;
      }

      const linesHtml = rawFiltered
        .map((m) => {
          let cls = "raw-event-line";
          if (m.type === "msg-edit" || m.type === "bot-update") {
            cls += " is-edit";
          } else if (m.type === "msg-delete") {
            cls += " is-delete";
          } else if (deletedTargets.has(m.id)) {
            cls += " is-deleted-target";
          }
          return `<span class="${cls}" data-raw-type="${escapeHtml(m.type)}" data-raw-id="${escapeHtml(m.id)}">${escapeHtml(JSON.stringify(m))}</span>`;
        })
        .join("\n");

      feed.innerHTML = `
        <div class="raw-jsonl-shell">
          <div class="raw-jsonl-banner">
            <span>Raw Append-Only Event Log · ${rawEvents.length} ${rawEvents.length === 1 ? "event" : "events"}</span>
            <span class="raw-jsonl-counts">
              <span class="raw-pill">${rootEventsCount} orig</span>
              <span class="raw-pill is-edit">${editEventsCount} ${editEventsCount === 1 ? "edit" : "edits"}</span>
              <span class="raw-pill is-delete">${deleteEventsCount} ${deleteEventsCount === 1 ? "delete" : "deletes"}</span>
            </span>
          </div>
          <pre class="raw-jsonl-view">${linesHtml}</pre>
        </div>
      `;
      this.logRenderState = { mode: "raw", key: rawKey };
      return;
    }

    const filtered = this.logMessages.filter((m) => {
      if (typeFilter && m.type !== typeFilter) return false;
      if (!query) return true;
      // Avoid scanning huge base64 image/GIF/video strings when searching text
      const hasMedia =
        m.type === "chat" &&
        m.payload &&
        (Array.isArray(m.payload.images) || Array.isArray(m.payload.videos));
      const searchable = {
        id: m.id,
        type: m.type,
        author: m.author,
        authorName: m.authorName,
        editedBy: m.editedBy || "",
        editedByName: m.editedByName || "",
        payload: hasMedia
          ? {
              text: m.payload.text || "",
              imageNames: Array.isArray(m.payload.images)
                ? m.payload.images.map((i) => i?.name || "image")
                : [],
              videoNames: Array.isArray(m.payload.videos)
                ? m.payload.videos.map((v) => v?.name || "video")
                : [],
            }
          : m.payload,
      };
      return JSON.stringify(searchable).toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      if (this.logMessages.length === 0) {
        this._revokeAllMediaUrls();
        if (this.logRenderState.mode === "empty" && this.logRenderState.key === "empty:none") {
          return;
        }
        feed.innerHTML = "";
        this.logRenderState = { mode: "empty", key: "empty:none" };
        return;
      }
      const emptyText = "No messages match your current filter.";
      const emptyKey = `empty:${emptyText}`;
      if (this.logRenderState.mode === "empty" && this.logRenderState.key === emptyKey) {
        return;
      }
      this._revokeAllMediaUrls();
      feed.innerHTML = `<div class="empty-state">${emptyText}</div>`;
      this.logRenderState = { mode: "empty", key: emptyKey };
      return;
    }

    const myId = this.status?.peerId || "";
    const msgDomRev = (m) => {
      const isEditing = this.editingMessageId === m.id;
      const isHistOpen = Boolean(m.updatedLamport && this.expandedEditHistory.has(m.id));
      return `${messageEditRev(m)}:${isEditing ? "edit" : "view"}:${isHistOpen ? "h1" : "h0"}`;
    };
    const chatKey = `chat:${myId}:${filtered.map((m) => `${m.id}|${msgDomRev(m)}`).join(",")}`;
    if (this.logRenderState.mode === "chat" && this.logRenderState.key === chatKey) {
      return;
    }

    const prevMode = this.logRenderState.mode;
    const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 64;

    if (prevMode !== "chat") {
      this._revokeAllMediaUrls();
      feed.innerHTML = "";
    }

    const existingNodes = new Map();
    for (const child of Array.from(feed.children)) {
      const msgId = child.dataset?.msgId;
      if (msgId) {
        existingNodes.set(msgId, child);
      } else {
        child.remove();
      }
    }

    const wantedIds = new Set(filtered.map((m) => m.id));
    for (const [id, node] of existingNodes.entries()) {
      if (!wantedIds.has(id)) {
        node.remove();
        existingNodes.delete(id);
        this._revokeMessageMediaUrls(id);
      }
    }

    let addedSelfMessage = false;
    const animateNew = prevMode === "chat" || prevMode === "empty";
    for (let i = 0; i < filtered.length; i++) {
      const m = filtered[i];
      const isSelf = m.author === myId;
      const rev = msgDomRev(m);
      let node = existingNodes.get(m.id);
      if (!node) {
        node = this.buildLogEntryElement(m, isSelf, animateNew);
        if (isSelf) addedSelfMessage = true;
      } else if (node.dataset.rev !== rev) {
        // Live edit, history toggle, or bot card update: replace ONLY this message node in place
        this._revokeMessageMediaUrls(m.id);
        const updatedNode = this.buildLogEntryElement(m, isSelf, false);
        feed.replaceChild(updatedNode, node);
        node = updatedNode;
      }
      const refNode = feed.children[i] || null;
      if (refNode !== node) {
        feed.insertBefore(node, refNode);
      }
    }

    this.logRenderState = { mode: "chat", key: chatKey };

    if (prevMode !== "chat" || wasNearBottom || addedSelfMessage) {
      feed.scrollTop = feed.scrollHeight;
    }
  }
}

const app = new P2PDirectApp();
app.init().catch((err) => {
  const box = document.getElementById("telemetry-log");
  if (box) {
    box.innerHTML = `<div class="telemetry-entry event-err">Initialization error: ${escapeHtml(err.message)}</div>`;
  }
  console.error(err);
});

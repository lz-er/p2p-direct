import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection } from "werift";
import { SafeRustWasmMesh } from "../wasm_client.js";
import {
  MultiRelayRendezvous,
  RELAY_DATA_CHUNK_SIZE,
  computePeerTag,
  decodeRelayDataChunk,
  decodeRelayVoiceBundle,
  encodeRelayVoiceBundle,
  encodeSingleRelayDataChunk,
  resolveRelayUrls,
} from "../mqtt_relay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_FRAME_SAMPLES = 320; // 20ms @ 16 kHz mono
export const VOICE_FRAME_BYTES = VOICE_FRAME_SAMPLES * 2; // Int16LE

export const VOICE_HD_OUT_SAMPLE_RATE = 24000;
export const VOICE_HD_OUT_FRAME_SAMPLES = 480; // 20ms @ 24 kHz mono
export const VOICE_HD_OUT_FRAME_BYTES = VOICE_HD_OUT_FRAME_SAMPLES * 2; // 960 bytes Int16LE
export const VOICE_V2_CODEC_PCM16 = 2;
export const VOICE_V2_HEADER_BYTES = 8; // [codecId:u8, sampleRateKhz:u8, rms:u16le, tsSamples:u32le]

export const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

const DIRECT_FALLBACK_TIMEOUT_MS = 5500;
const ANSWER_FALLBACK_TIMEOUT_MS = 6500;
const DIRECT_HARD_TIMEOUT_MS = 14000;
const RELAY_INACTIVITY_TIMEOUT_MS = 22000;
const VOICE_RELAY_BATCH_MS = 80;
const VOICE_RELAY_MAX_FRAMES = 4;

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

function buildHammingLowpass5(srcRate, dstRate) {
  const fc = Math.max(0.05, Math.min(0.48, 0.45 * (dstRate / srcRate)));
  const taps = new Float64Array(5);
  let sum = 0;
  for (let n = 0; n < 5; n++) {
    const k = n - 2;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / 4);
    taps[n] = sinc * win;
    sum += taps[n];
  }
  for (let n = 0; n < 5; n++) {
    taps[n] /= sum;
  }
  return taps;
}

function catmullRom(y0, y1, y2, y3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * y1 +
      (-y0 + y2) * t +
      (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
      (-y0 + 3 * y1 - 3 * y2 + y3) * t3)
  );
}

/**
 * Stateful streaming 16-bit PCM resampler using 5-tap Hamming-windowed anti-aliasing low-pass
 * pre-filtering (when downsampling) and 4-point Catmull-Rom cubic interpolation carrying
 * boundary history + fractional phase seamlessly across consecutive chunks.
 */
export class StreamingPcmResampler {
  constructor({ targetRate = VOICE_HD_OUT_SAMPLE_RATE } = {}) {
    this.targetRate = Math.max(4000, Number(targetRate) || VOICE_HD_OUT_SAMPLE_RATE);
    this.reset();
  }

  reset() {
    this._srcRate = 0;
    this._channels = 0;
    this._taps = null;
    this._aaHasHistory = false;
    this._aaHist0 = 0;
    this._aaHist1 = 0;
    this._aaHist2 = 0;
    this._aaHist3 = 0;
    this._aaInitBuf = [];
    this._hasHistory = false;
    this._prev0 = 0;
    this._prev1 = 0;
    this._prev2 = 0;
    this._phase = 1.0;
    this._cubicInitBuf = [];
    this._framePrevRaw2 = 0;
    this._framePrevRaw1 = 0;
    this._framePrevFilt = 0;
    this._frameHasHistory = false;
  }

  _downmixToMonoFloat(buf, ch) {
    const totalFrames = Math.floor(buf.length / (2 * ch));
    const mono = new Float32Array(totalFrames);
    if (ch === 1) {
      for (let i = 0; i < totalFrames; i++) {
        mono[i] = buf.readInt16LE(i * 2);
      }
    } else {
      for (let i = 0; i < totalFrames; i++) {
        let acc = 0;
        const base = i * ch * 2;
        for (let c = 0; c < ch; c++) {
          acc += buf.readInt16LE(base + c * 2);
        }
        mono[i] = acc / ch;
      }
    }
    return mono;
  }

  _applyStreamingAntiAlias(mono) {
    const n = mono.length;
    if (n === 0 || !this._taps) return mono;
    const t0 = this._taps[0];
    const t1 = this._taps[1];
    const t2 = this._taps[2];
    const t3 = this._taps[3];
    const t4 = this._taps[4];

    let raw;
    if (!this._aaHasHistory) {
      const combinedLen = this._aaInitBuf.length + n;
      if (combinedLen < 3) {
        for (let i = 0; i < n; i++) this._aaInitBuf.push(mono[i]);
        return new Float32Array(0);
      }
      const first = this._aaInitBuf.length > 0 ? this._aaInitBuf[0] : mono[0];
      raw = new Float32Array(2 + combinedLen);
      raw[0] = first;
      raw[1] = first;
      let off = 2;
      for (let i = 0; i < this._aaInitBuf.length; i++) raw[off++] = this._aaInitBuf[i];
      this._aaInitBuf.length = 0;
      raw.set(mono, off);
      this._aaHasHistory = true;
    } else {
      raw = new Float32Array(4 + n);
      raw[0] = this._aaHist0;
      raw[1] = this._aaHist1;
      raw[2] = this._aaHist2;
      raw[3] = this._aaHist3;
      raw.set(mono, 4);
    }

    const rLen = raw.length;
    const outLen = Math.max(0, rLen - 4);
    const filtered = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const c = i + 2;
      filtered[i] =
        t0 * raw[c - 2] +
        t1 * raw[c - 1] +
        t2 * raw[c] +
        t3 * raw[c + 1] +
        t4 * raw[c + 2];
    }
    this._aaHist0 = raw[rLen - 4];
    this._aaHist1 = raw[rLen - 3];
    this._aaHist2 = raw[rLen - 2];
    this._aaHist3 = raw[rLen - 1];
    return filtered;
  }

  push(pcmBuffer, { sampleRate = VOICE_SAMPLE_RATE, channels = 1 } = {}) {
    if (!pcmBuffer || pcmBuffer.length === 0) return Buffer.alloc(0);
    const buf = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    const srcRate = Math.max(4000, Number(sampleRate) || VOICE_SAMPLE_RATE);
    const ch = Math.max(1, Math.min(8, Math.round(Number(channels) || 1)));
    const dstRate = this.targetRate;

    if (buf.length < 2 * ch) return Buffer.alloc(0);

    // Auto-reset history when sampleRate or channels changes on a new stream
    if (this._srcRate !== srcRate || this._channels !== ch) {
      this.reset();
      this._srcRate = srcRate;
      this._channels = ch;
      this._taps = srcRate > dstRate ? buildHammingLowpass5(srcRate, dstRate) : null;
    }

    // Fast-path direct copy when sampleRate already matches targetRate and mono
    if (srcRate === dstRate && ch === 1) {
      const evenLen = buf.length & ~1;
      return evenLen === 0 ? Buffer.alloc(0) : Buffer.from(buf.subarray(0, evenLen));
    }

    const mono = this._downmixToMonoFloat(buf, ch);
    if (mono.length === 0) return Buffer.alloc(0);

    if (srcRate === dstRate) {
      const out = Buffer.allocUnsafe(mono.length * 2);
      for (let i = 0; i < mono.length; i++) {
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mono[i]))), i * 2);
      }
      return out;
    }

    const src = srcRate > dstRate ? this._applyStreamingAntiAlias(mono) : mono;
    if (src.length === 0) return Buffer.alloc(0);

    let v;
    if (!this._hasHistory) {
      const combinedLen = this._cubicInitBuf.length + src.length;
      if (combinedLen < 2) {
        for (let i = 0; i < src.length; i++) this._cubicInitBuf.push(src[i]);
        return Buffer.alloc(0);
      }
      const first = this._cubicInitBuf.length > 0 ? this._cubicInitBuf[0] : src[0];
      v = new Float32Array(1 + combinedLen);
      v[0] = first;
      let off = 1;
      for (let i = 0; i < this._cubicInitBuf.length; i++) v[off++] = this._cubicInitBuf[i];
      this._cubicInitBuf.length = 0;
      v.set(src, off);
      this._phase = 1.0;
      this._hasHistory = true;
    } else {
      v = new Float32Array(3 + src.length);
      v[0] = this._prev0;
      v[1] = this._prev1;
      v[2] = this._prev2;
      v.set(src, 3);
    }

    const step = srcRate / dstRate;
    const limit = v.length - 2;
    const estOut = this._phase < limit ? Math.ceil((limit - this._phase) / step) + 2 : 0;
    const outSamples = new Int16Array(estOut);
    let outCount = 0;
    let pos = this._phase;

    while (pos < limit) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const sample = catmullRom(v[idx - 1], v[idx], v[idx + 1], v[idx + 2], frac);
      outSamples[outCount++] = Math.max(-32768, Math.min(32767, Math.round(sample)));
      pos += step;
    }

    this._prev0 = v[v.length - 3];
    this._prev1 = v[v.length - 2];
    this._prev2 = v[v.length - 1];
    this._phase = pos - (v.length - 3);

    if (outCount === 0) return Buffer.alloc(0);
    const outBuf = Buffer.allocUnsafe(outCount * 2);
    for (let i = 0; i < outCount; i++) {
      outBuf.writeInt16LE(outSamples[i], i * 2);
    }
    return outBuf;
  }

  /**
   * Frame-aligned cubic resampler (e.g., 480 samples @ 24 kHz -> exact 320 samples @ 16 kHz)
   * carrying left-edge history across consecutive 20 ms ticks for legacy V1 fallback without drift.
   */
  resampleFrameInt16(int16Input, { sampleRate = VOICE_HD_OUT_SAMPLE_RATE } = {}) {
    if (!int16Input || int16Input.length === 0) return new Int16Array(0);
    const srcRate = Math.max(4000, Number(sampleRate) || VOICE_HD_OUT_SAMPLE_RATE);
    const dstRate = this.targetRate;
    const n = int16Input.length;
    if (srcRate === dstRate) {
      return new Int16Array(int16Input);
    }
    if (this._srcRate !== srcRate || this._channels !== 1) {
      this.reset();
      this._srcRate = srcRate;
      this._channels = 1;
      this._taps = srcRate > dstRate ? buildHammingLowpass5(srcRate, dstRate) : null;
    }

    const prevRaw2 = this._frameHasHistory ? this._framePrevRaw2 : int16Input[0];
    const prevRaw1 = this._frameHasHistory ? this._framePrevRaw1 : int16Input[0];
    let src;
    if (srcRate > dstRate && this._taps) {
      const t0 = this._taps[0];
      const t1 = this._taps[1];
      const t2 = this._taps[2];
      const t3 = this._taps[3];
      const t4 = this._taps[4];
      src = new Float32Array(n);
      const getRaw = (idx) => {
        if (idx === -2) return prevRaw2;
        if (idx === -1) return prevRaw1;
        if (idx >= n) return int16Input[n - 1];
        return int16Input[idx];
      };
      for (let i = 0; i < n; i++) {
        src[i] =
          t0 * getRaw(i - 2) +
          t1 * getRaw(i - 1) +
          t2 * getRaw(i) +
          t3 * getRaw(i + 1) +
          t4 * getRaw(i + 2);
      }
    } else {
      src = new Float32Array(n);
      for (let i = 0; i < n; i++) src[i] = int16Input[i];
    }

    const prevFilt = this._frameHasHistory ? this._framePrevFilt : src[0];
    const ratio = srcRate / dstRate;
    const outSamples = Math.max(1, Math.round(n / ratio));
    const out = new Int16Array(outSamples);
    const getSrc = (idx) => {
      if (idx < 0) return prevFilt;
      if (idx >= n) return src[n - 1];
      return src[idx];
    };
    for (let i = 0; i < outSamples; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const sample = catmullRom(
        getSrc(idx - 1),
        getSrc(idx),
        getSrc(idx + 1),
        getSrc(idx + 2),
        frac
      );
      out[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
    }

    this._framePrevRaw2 = n >= 2 ? int16Input[n - 2] : int16Input[0];
    this._framePrevRaw1 = int16Input[n - 1];
    this._framePrevFilt = src[n - 1];
    this._frameHasHistory = true;
    return out;
  }
}

/**
 * Converts arbitrary signed 16-bit little-endian PCM (any sample rate & channel count)
 * into mono Int16LE PCM using 5-tap Hamming anti-aliasing (when downsampling) +
 * 4-point Catmull-Rom cubic interpolation without spawning ffmpeg.
 */
export function resamplePcm16(pcmBuffer, { sampleRate = VOICE_SAMPLE_RATE, channels = 1, targetRate = VOICE_SAMPLE_RATE } = {}) {
  const buf = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
  const srcRate = Math.max(4000, Number(sampleRate) || VOICE_SAMPLE_RATE);
  const ch = Math.max(1, Math.min(8, Math.round(Number(channels) || 1)));
  const dstRate = Math.max(4000, Number(targetRate) || VOICE_SAMPLE_RATE);
  if (buf.length < 2 * ch) return Buffer.alloc(0);
  if (srcRate === dstRate && ch === 1) {
    return (buf.length & 1) === 0 ? buf : buf.subarray(0, buf.length - 1);
  }

  const totalFrames = Math.floor(buf.length / (2 * ch));
  if (totalFrames === 0) return Buffer.alloc(0);

  // Downmix to mono Float32
  const mono = new Float32Array(totalFrames);
  if (ch === 1) {
    for (let i = 0; i < totalFrames; i++) {
      mono[i] = buf.readInt16LE(i * 2);
    }
  } else {
    for (let i = 0; i < totalFrames; i++) {
      let acc = 0;
      const base = i * ch * 2;
      for (let c = 0; c < ch; c++) {
        acc += buf.readInt16LE(base + c * 2);
      }
      mono[i] = acc / ch;
    }
  }

  if (srcRate === dstRate) {
    const out = Buffer.allocUnsafe(totalFrames * 2);
    for (let i = 0; i < totalFrames; i++) {
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mono[i]))), i * 2);
    }
    return out;
  }

  let src = mono;
  if (srcRate > dstRate) {
    const taps = buildHammingLowpass5(srcRate, dstRate);
    const t0 = taps[0];
    const t1 = taps[1];
    const t2 = taps[2];
    const t3 = taps[3];
    const t4 = taps[4];
    const lastIdx = totalFrames - 1;
    const filtered = new Float32Array(totalFrames);
    for (let i = 0; i < totalFrames; i++) {
      const m2 = i >= 2 ? mono[i - 2] : mono[0];
      const m1 = i >= 1 ? mono[i - 1] : mono[0];
      const p1 = i + 1 <= lastIdx ? mono[i + 1] : mono[lastIdx];
      const p2 = i + 2 <= lastIdx ? mono[i + 2] : mono[lastIdx];
      filtered[i] = t0 * m2 + t1 * m1 + t2 * mono[i] + t3 * p1 + t4 * p2;
    }
    src = filtered;
  }

  const ratio = srcRate / dstRate;
  const outSamples = Math.max(1, Math.round(totalFrames / ratio));
  const out = Buffer.allocUnsafe(outSamples * 2);
  const lastIdx = totalFrames - 1;
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const y0 = src[idx > 0 ? Math.min(idx - 1, lastIdx) : 0];
    const y1 = src[Math.min(idx, lastIdx)];
    const y2 = src[Math.min(idx + 1, lastIdx)];
    const y3 = src[Math.min(idx + 2, lastIdx)];
    const sample = catmullRom(y0, y1, y2, y3, frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2);
  }
  return out;
}

/**
 * Real-time drift-compensated 20ms mono Int16LE voice audio pacer (defaults to 24 kHz HD PCM).
 * Accepts arbitrary PCM chunks (e.g., from ffmpeg stdout, Wyoming TTS, or synth), applies a
 * gentle 3 ms cosine utterance fade-in + soft-knee peak limiting when gain !== 1, and feeds
 * exact 20 ms Int16Array frames into `onFrame(Int16Array)` every 20 ms.
 */
class VoiceAudioPacer {
  constructor({ onFrame, onStart, onDrain, gain = 1.0, sampleRate = VOICE_HD_OUT_SAMPLE_RATE }) {
    this.onFrame = onFrame;
    this.onStart = onStart;
    this.onDrain = onDrain;
    this.gain = gain;
    this.sampleRate = Math.max(4000, Number(sampleRate) || VOICE_HD_OUT_SAMPLE_RATE);
    this.frameSamples = Math.max(1, Math.round(this.sampleRate * 0.02));
    this.frameBytes = this.frameSamples * 2;
    this.fadeInTotalSamples = Math.max(1, Math.round(this.sampleRate * 0.003)); // 3 ms (72 samples @ 24 kHz)
    this._fadeInPos = this.fadeInTotalSamples;
    this.queue = [];
    this.queuedBytes = 0;
    this.paused = false;
    this.active = false;
    this.timer = null;
    this.nextTickAt = 0;
    this.ending = false;
    this.activeChild = null;
  }

  isActive() {
    return Boolean(this.active || (!this.paused && (this.queuedBytes >= this.frameBytes || this.timer || this.activeChild)));
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
    if (this.queuedBytes < this.frameBytes && !this.paused) {
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
    const wasActive = this.active;
    this.paused = false;
    this.ending = false;
    this.active = false;
    this._fadeInPos = this.fadeInTotalSamples;
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
    if (wasActive && this.onDrain) {
      this.onDrain();
    }
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
    if (this.queuedBytes < this.frameBytes && !this.ending) return;
    if (!this.active) {
      this.active = true;
      this._fadeInPos = 0;
      if (this.onStart) this.onStart();
    }
    this.nextTickAt = Date.now();
    this._step();
  }

  _step() {
    this.timer = null;
    if (this.paused) return;

    if (this.queuedBytes >= this.frameBytes || (this.ending && this.queuedBytes > 0)) {
      const frameBytes = this._takeBytes(this.frameBytes);
      const samples = new Int16Array(this.frameSamples);
      const g = this.gain;
      const fadeTotal = this.fadeInTotalSamples;
      const knee = 0.92 * 32767;
      const ceiling = 0.995 * 32767;
      const headroom = ceiling - knee;
      for (let i = 0; i < this.frameSamples; i++) {
        let val = frameBytes.readInt16LE(i * 2);
        if (g !== 1) {
          val *= g;
          const abs = Math.abs(val);
          if (abs > knee) {
            const excess = abs - knee;
            const limited = knee + headroom * Math.tanh(excess / headroom);
            val = val < 0 ? -limited : limited;
          }
        }
        if (this._fadeInPos < fadeTotal) {
          const env = 0.5 * (1 - Math.cos((Math.PI * this._fadeInPos) / fadeTotal));
          val *= env;
          this._fadeInPos += 1;
        }
        samples[i] = Math.max(-32768, Math.min(32767, Math.round(val)));
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
    } else if (this.active) {
      this.active = false;
      this._fadeInPos = this.fadeInTotalSamples;
      if (this.onDrain) this.onDrain();
    }
  }

  _finish() {
    this.ending = false;
    this.active = false;
    this._fadeInPos = this.fadeInTotalSamples;
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
 * Continuous 20ms (16 kHz mono Int16LE) room voice mixer tailored for voice assistants
 * (Home Assistant Wyoming Satellite, openWakeWord, Whisper STT).
 *
 * Solves three P2P multi-speaker voice-room challenges out of the box:
 * 1. Silence-gap filling: browser peers stop sending packets when their noise gate closes;
 *    this mixer maintains a steady 50 Hz 16 kHz PCM clock with zero-PCM silence frames so
 *    wake-word and STT VAD detectors stay synced and detect end-of-speech cleanly.
 * 2. Speaker locking: tracks per-peer audio so once a wake word or button triggers a turn,
 *    STT can lock onto the single active speaker without crosstalk from other room peers.
 * 3. Echo/TTS suppression: automatically mutes/zeroes inbound audio while the bot is speaking
 *    (plus a configurable echo tail) so peers' speakers never re-trigger wake words.
 */
export class VoiceRoomMixer extends EventEmitter {
  constructor({
    bot = null,
    echoSuppression = true,
    echoTailMs = 350,
    maxBufferedFramesPerPeer = 12,
    jitterBufferFrames = 0,
    allowedSpeakers = null,
    speechRmsThreshold = 140,
  } = {}) {
    super();
    this.bot = bot;
    this.echoSuppression = Boolean(echoSuppression);
    this.echoTailMs = Math.max(0, Number(echoTailMs) || 0);
    this.jitterBufferFrames = Math.max(0, Math.floor(Number(jitterBufferFrames) || 0));
    this.maxBufferedFramesPerPeer = Math.max(
      Math.max(2, this.jitterBufferFrames + 2),
      Number(maxBufferedFramesPerPeer) || 12
    );
    this.speechRmsThreshold = Math.max(0, Number(speechRmsThreshold) || 140);

    this.peerBuffers = new Map(); // peerId -> { queue: Int16Array[], lastRms, lastVoiceAtMs, primed, underrunFrames, lastFrame }
    this.lockedPeerId = null;
    this.allowedSpeakers = null; // Set<string> lowercase peerId or authorName, or null = allow all
    if (Array.isArray(allowedSpeakers) && allowedSpeakers.length > 0) {
      this.setAllowedSpeakers(allowedSpeakers);
    }

    this.lastActivePeerId = null;
    this.lastActivePeerName = "";
    this.lastActiveAtMs = 0;
    this.botSpeaking = false;
    this.botSpokeUntilMs = 0;
    this.underrunCount = 0;
    this.running = false;
    this.timer = null;
    this.nextTickAt = 0;

    this._onVoiceAudio = (ev) => this.pushPeerAudio(ev.peerId, ev.pcm, ev.rms);
    this._onAudioStart = () => {
      this.botSpeaking = true;
    };
    this._onAudioEnd = () => {
      this.botSpeaking = false;
      this.botSpokeUntilMs = Date.now() + this.echoTailMs;
    };

    if (this.bot) {
      this.bot.on("voiceAudio", this._onVoiceAudio);
      this.bot.on("audioStart", this._onAudioStart);
      this.bot.on("audioEnd", this._onAudioEnd);
    }
  }

  setAllowedSpeakers(list) {
    if (!Array.isArray(list) || list.length === 0) {
      this.allowedSpeakers = null;
      return;
    }
    const clean = list
      .map((s) => String(s || "").trim().toLowerCase())
      .filter(Boolean);
    this.allowedSpeakers = clean.length > 0 ? new Set(clean) : null;
  }

  isPeerAllowed(peerId) {
    if (!this.allowedSpeakers) return true;
    const pid = String(peerId || "").toLowerCase();
    if (this.allowedSpeakers.has(pid)) return true;
    const peerName = this.getPeerName(peerId).toLowerCase();
    return Boolean(peerName && this.allowedSpeakers.has(peerName));
  }

  getPeerName(peerId) {
    if (!peerId) return "";
    if (this.bot && typeof this.bot.getPeers === "function") {
      const peer = this.bot.getPeers().find((p) => p.peerId === peerId);
      if (peer?.authorName) return peer.authorName;
    }
    return String(peerId);
  }

  lockSpeaker(peerId) {
    this.lockedPeerId = peerId ? String(peerId) : null;
    return this.lockedPeerId;
  }

  lockToLastActiveSpeaker(maxAgeMs = 3000) {
    if (this.lastActivePeerId && Date.now() - this.lastActiveAtMs <= maxAgeMs) {
      this.lockedPeerId = this.lastActivePeerId;
    }
    return this.lockedPeerId;
  }

  unlockSpeaker() {
    this.lockedPeerId = null;
  }

  setExternalSpeaking(isSpeaking) {
    if (isSpeaking) {
      this.botSpeaking = true;
    } else {
      this.botSpeaking = false;
      this.botSpokeUntilMs = Date.now() + this.echoTailMs;
    }
  }

  getBufferedFrames() {
    let total = 0;
    for (const st of this.peerBuffers.values()) {
      total += st.queue.length;
    }
    return total;
  }

  pushPeerAudio(peerId, pcm, rms = 0, nowMs = Date.now()) {
    if (!peerId || !pcm || pcm.length === 0) return;
    if (!this.isPeerAllowed(peerId)) return;
    const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    let st = this.peerBuffers.get(peerId);
    if (!st) {
      st = {
        queue: [],
        lastRms: 0,
        lastVoiceAtMs: -1,
        primed: false,
        underrunFrames: 0,
        lastFrame: null,
      };
      this.peerBuffers.set(peerId, st);
    }

    // Slice arbitrary-sized packets into exact 320-sample (20ms) frames
    for (let off = 0; off < samples.length; off += VOICE_FRAME_SAMPLES) {
      const slice = samples.subarray(off, Math.min(samples.length, off + VOICE_FRAME_SAMPLES));
      let frame;
      if (slice.length === VOICE_FRAME_SAMPLES) {
        frame = new Int16Array(slice);
      } else {
        frame = new Int16Array(VOICE_FRAME_SAMPLES);
        frame.set(slice);
      }
      st.queue.push(frame);
      if (st.queue.length > this.maxBufferedFramesPerPeer) {
        st.queue.shift();
      }
    }

    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    st.lastRms = Number(rms) || 0;
    st.lastVoiceAtMs = now;
    if (st.lastRms >= this.speechRmsThreshold) {
      this.lastActivePeerId = peerId;
      this.lastActivePeerName = this.getPeerName(peerId);
      this.lastActiveAtMs = now;
    }
  }

  /**
   * Produces a single 20ms mixed 16 kHz mono Int16LE frame immediately (also useful for deterministic unit tests).
   */
  produceFrame(nowMs = Date.now()) {
    const suppressed =
      this.echoSuppression &&
      (this.botSpeaking || (this.bot && this.bot.isPlayingAudio()) || nowMs < this.botSpokeUntilMs);

    const mixed = new Int16Array(VOICE_FRAME_SAMPLES);
    const activePeerIds = [];
    let dominantPeerId = null;
    let dominantRms = -1;

    if (suppressed) {
      // Drain buffered frames while suppressed so stale echo audio isn't played back after TTS ends
      for (const st of this.peerBuffers.values()) {
        if (st.queue.length > 0) st.queue.shift();
        st.primed = false;
        st.underrunFrames = 0;
        st.lastFrame = null;
      }
    } else {
      const accum = new Int32Array(VOICE_FRAME_SAMPLES);
      for (const [peerId, st] of this.peerBuffers.entries()) {
        if (this.lockedPeerId && peerId !== this.lockedPeerId) {
          if (st.queue.length > 0) st.queue.shift(); // keep non-locked peer buffers fresh without mixing
          st.primed = false;
          st.underrunFrames = 0;
          st.lastFrame = null;
          continue;
        }

        if (this.jitterBufferFrames > 0) {
          if (!st.primed) {
            if (st.queue.length === 0) continue;
            const flushDue =
              st.lastVoiceAtMs >= 0 && nowMs - st.lastVoiceAtMs >= this.jitterBufferFrames * 20;
            if (st.queue.length < this.jitterBufferFrames && !flushDue) {
              continue;
            }
            st.primed = true;
            st.underrunFrames = 0;
          }

          if (st.queue.length === 0) {
            st.underrunFrames += 1;
            this.underrunCount += 1;
            if (st.underrunFrames === 1 && st.lastFrame) {
              let hasEnergy = false;
              for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
                if (st.lastFrame[i] !== 0) {
                  hasEnergy = true;
                  break;
                }
              }
              if (hasEnergy) {
                activePeerIds.push(peerId);
                if (st.lastRms > dominantRms) {
                  dominantRms = st.lastRms;
                  dominantPeerId = peerId;
                }
                for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
                  accum[i] += Math.round(st.lastFrame[i] * 0.35);
                }
              }
            }
            if (st.underrunFrames >= 3) {
              st.primed = false;
              st.underrunFrames = 0;
              st.lastFrame = null;
            }
            continue;
          }

          const frame = st.queue.shift();
          st.underrunFrames = 0;
          st.lastFrame = frame;
          activePeerIds.push(peerId);
          if (st.lastRms > dominantRms) {
            dominantRms = st.lastRms;
            dominantPeerId = peerId;
          }
          for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
            accum[i] += frame[i];
          }
        } else {
          if (st.queue.length === 0) continue;
          const frame = st.queue.shift();
          activePeerIds.push(peerId);
          if (st.lastRms > dominantRms) {
            dominantRms = st.lastRms;
            dominantPeerId = peerId;
          }
          for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
            accum[i] += frame[i];
          }
        }
      }
      if (activePeerIds.length > 0) {
        for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
          mixed[i] = Math.max(-32768, Math.min(32767, accum[i]));
        }
      }
    }

    let sumSq = 0;
    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      sumSq += mixed[i] * mixed[i];
    }
    const rms = Math.round(Math.sqrt(sumSq / VOICE_FRAME_SAMPLES));
    const buffer = Buffer.from(mixed.buffer, mixed.byteOffset, mixed.byteLength);

    return {
      pcm: mixed,
      buffer,
      sampleRate: VOICE_SAMPLE_RATE,
      channels: 1,
      activePeerIds,
      dominantPeerId,
      dominantPeerName: dominantPeerId ? this.getPeerName(dominantPeerId) : "",
      lockedPeerId: this.lockedPeerId,
      rms,
      isSilence: activePeerIds.length === 0 || suppressed,
      suppressed,
      underrunCount: this.underrunCount,
      bufferedFrames: this.getBufferedFrames(),
      ts: nowMs,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.nextTickAt = Date.now();
    this._tick();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.peerBuffers.clear();
  }

  destroy() {
    this.stop();
    if (this.bot) {
      this.bot.off("voiceAudio", this._onVoiceAudio);
      this.bot.off("audioStart", this._onAudioStart);
      this.bot.off("audioEnd", this._onAudioEnd);
      this.bot = null;
    }
  }

  _tick() {
    this.timer = null;
    if (!this.running) return;
    const now = Date.now();
    const frameObj = this.produceFrame(now);
    this.emit("frame", frameObj);

    this.nextTickAt += 20;
    if (this.nextTickAt < now - 100) {
      this.nextTickAt = now;
    }
    const delay = Math.max(1, this.nextTickAt - Date.now());
    this.timer = setTimeout(() => this._tick(), delay);
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
    this.customIceServers = Array.isArray(options.iceServers) ? options.iceServers : null;
    this.iceServers = this.customIceServers || DEFAULT_ICE_SERVERS.slice();

    this.wasm = null;
    this.status = null;
    this.activeRoom = null;
    this.roomRendezvous = null;
    this.connected = false;

    this.directPeers = new Map(); // peerId -> { pc, dc, voiceDc, bulkDc, transport, authorName, lastActivityMs, superseded }
    this.voiceChannels = new Map(); // peerId -> RTCDataChannel("p2p-voice")
    this.bulkChannels = new Map(); // peerId -> RTCDataChannel("p2p-bulk")
    this.roomDialing = new Map();
    this.earlyRoomIce = new Map();
    this.relayPeers = new Map();
    this.earlyRelayIce = new Map();
    this.seenRoomSignalIds = new Map();
    this.lastHelloReplyPerPeer = new Map();

    // Zero-TURN E2EE Relay Fallback state
    this.roomMyTag = null;
    this.roomKnownPeers = new Map();
    this.roomTagToPeerId = new Map();
    this.relayPendingOpens = new Map();
    this.earlyRelayDataFrames = new Map();
    this.relayChunkAssemblies = new Map();
    this.seenRelayChunkKeys = new Map();
    this.seenVoiceBundleSeq = new Map();
    this.relayDataMsgSeq = 1;
    this.relayVoiceBundleSeq = 1;

    // Tracking diffs for clean events
    this.knownMessages = new Map(); // msgId -> { msg, rev }
    this.knownPeers = new Map(); // peerId -> { authorName, inVoice, voiceMuted, isBot }
    this.peerVoiceCaps = new Map(); // peerId -> { v2pcm: boolean, vcodec: string }
    this.inVoice = false;
    this.voiceMuted = false;

    this.keepaliveTimer = null;
    this.keepaliveTicks = 0;

    this._txResampler = new StreamingPcmResampler({ targetRate: VOICE_HD_OUT_SAMPLE_RATE });
    this._v1FallbackResampler = new StreamingPcmResampler({ targetRate: VOICE_SAMPLE_RATE });
    this._voiceV2TxSamples = 0;
    this._voiceV2TxBuf = new Uint8Array(VOICE_V2_HEADER_BYTES + VOICE_HD_OUT_FRAME_BYTES);

    this.pacer = new VoiceAudioPacer({
      sampleRate: VOICE_HD_OUT_SAMPLE_RATE,
      onFrame: (int16) => this.sendVoicePcm24k(int16),
      onStart: () => this.emit("audioStart"),
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

    await this._ensureRoomMyTag();
    const relayUrls = resolveRelayUrls(relayOverride);
    this.roomRendezvous = new MultiRelayRendezvous({
      roomTopic: encoded.roomTopic,
      urls: relayUrls,
      onMessage: (sealedPayload) => {
        this._handleSealedRoomSignal(sealedPayload).catch((err) => this.emit("error", err));
      },
      onBinaryMessage: (bytes, brokerUrl) => {
        this._handleIncomingRelayBinary(bytes, brokerUrl);
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
      for (const [pid, peer] of this.directPeers.entries()) {
        if (peer.transport === "relay") {
          this._sendRoomSignal({ t: "relay-close", from: this.peerId, to: pid });
        }
      }
      this.roomRendezvous.stop();
      this.roomRendezvous = null;
    }
    for (const pending of this.relayPendingOpens.values()) {
      if (pending.retryTimer) clearTimeout(pending.retryTimer);
    }
    this.relayPendingOpens.clear();
    for (const [, entry] of this.directPeers) {
      entry.superseded = true;
      try {
        entry.voiceDc?.close();
        entry.dc?.close(true);
        entry.pc?.close();
      } catch {
        // ignore
      }
    }
    this.directPeers.clear();
    this.voiceChannels.clear();
    this.peerVoiceCaps.clear();
    for (const [, entry] of this.roomDialing) {
      if (entry.fallbackTimer) clearTimeout(entry.fallbackTimer);
      if (entry.hardTimer) clearTimeout(entry.hardTimer);
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
   * Edits any message (bot card, chat text, or structured JSON) by appending a new
   * E2EE `msg-edit` event message targeting `targetId` — identical to human message edits.
   */
  editMessage(targetId, payload) {
    this._requireReady();
    const cleanTarget = String(targetId || "").trim();
    if (!cleanTarget) throw new Error("editMessage requires targetId");
    if (payload === undefined || payload === null) {
      throw new Error("editMessage requires a non-null payload");
    }
    const res = this.wasm.call({
      cmd: "edit_message",
      targetId: cleanTarget,
      payload,
      ts: Date.now(),
      entropy: randomBase64Url(16),
    });
    this.status = res.status;
    this._executeActions(res.actions);
    return { id: res.editMessageId, targetId: res.targetId, message: res.message };
  }

  /**
   * Edits a chat message's text in place by appending a unified `msg-edit` event.
   */
  editText(targetId, text) {
    const clean = String(text ?? "").trim();
    if (!clean) throw new Error("editText requires non-empty text");
    return this.editMessage(targetId, { text: clean });
  }

  /**
   * Updates an existing bot message card across all peers using the unified `msg-edit` event.
   */
  updateBotMessage(targetId, card) {
    if (!card || typeof card !== "object") throw new Error("updateBotMessage requires card object");
    return this.editMessage(targetId, card);
  }

  /**
   * Returns the complete immutable raw append-only event log (original messages,
   * `msg-edit` events, and `msg-delete` events in canonical order).
   */
  getRawLog({ compactMedia = false } = {}) {
    this._requireReady();
    const res = this.wasm.call({
      cmd: "get_raw_log",
      compactMedia: Boolean(compactMedia),
    });
    this.status = res.status;
    return res.rawLog || [];
  }

  /**
   * Deletes any message in the room by appending an authenticated `msg-delete` event.
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
   * Records a remote peer's negotiated voice capabilities (e.g., `{ v2pcm: true, vcodec: "opus48" }`).
   */
  setPeerVoiceCaps(peerId, caps = {}) {
    const pid = String(peerId || "").trim();
    if (!pid) return;
    const prev = this.peerVoiceCaps.get(pid) || { v2pcm: false, vcodec: "adpcm16" };
    const v2pcm = caps && typeof caps.v2pcm === "boolean" ? caps.v2pcm : prev.v2pcm;
    const vcodec =
      caps && typeof caps.vcodec === "string" && caps.vcodec.trim()
        ? caps.vcodec.trim()
        : prev.vcodec;
    this.peerVoiceCaps.set(pid, { v2pcm, vcodec });
  }

  _recordPeerVoiceCapsFromSignal(msg) {
    if (!msg || !msg.from) return;
    const prev = this.peerVoiceCaps.get(msg.from);
    const v2pcm = typeof msg.v2pcm === "boolean" ? msg.v2pcm : Boolean(prev?.v2pcm);
    const vcodec =
      typeof msg.vcodec === "string" && msg.vcodec.trim()
        ? msg.vcodec.trim()
        : prev?.vcodec || "adpcm16";
    this.peerVoiceCaps.set(msg.from, { v2pcm, vcodec });
  }

  /**
   * Encodes a 24 kHz mono Int16Array PCM frame (480 samples = 20 ms) into E2EE V2 lossless
   * 16-bit PCM packets (`VOICE_V2_CODEC_PCM16 = 2`) for `v39+` peers advertising `v2pcm: true`,
   * with automatic 16 kHz V1 IMA-ADPCM fallback strictly for legacy (`v38`) peers.
   */
  sendVoicePcm24k(int16Pcm24k) {
    if (!this.inVoice || this.voiceMuted || !this.wasm) return 0;
    if (!int16Pcm24k || int16Pcm24k.length === 0) return 0;
    const samples =
      int16Pcm24k instanceof Int16Array
        ? int16Pcm24k
        : new Int16Array(
            int16Pcm24k.buffer,
            int16Pcm24k.byteOffset,
            Math.floor(int16Pcm24k.byteLength / 2)
          );
    if (samples.length === 0) return 0;

    const statusPeers = Array.isArray(this.status?.peers) ? this.status.peers : null;
    let statusPeerMap = null;
    if (statusPeers && statusPeers.length > 0) {
      statusPeerMap = new Map();
      for (const p of statusPeers) {
        if (p && p.peerId) statusPeerMap.set(p.peerId, p);
      }
    }

    let hasV2PcmPeers = false;
    let hasLegacyPeers = false;
    for (const [pid, vdc] of this.voiceChannels.entries()) {
      if (!vdc || vdc.readyState !== "open") continue;
      const sp = statusPeerMap ? statusPeerMap.get(pid) : null;
      if (sp && !sp.inVoice) continue;
      if (this.peerVoiceCaps.get(pid)?.v2pcm === true) {
        hasV2PcmPeers = true;
      } else {
        hasLegacyPeers = true;
      }
    }

    if (!hasV2PcmPeers && !hasLegacyPeers) return 0;

    let sent = 0;

    if (hasV2PcmPeers) {
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        sumSq += s * s;
      }
      const rms = Math.min(65535, Math.round(Math.sqrt(sumSq / samples.length))) | 0;
      const payloadBytes = samples.length * 2;
      const totalLen = VOICE_V2_HEADER_BYTES + payloadBytes;
      if (!this._voiceV2TxBuf || this._voiceV2TxBuf.length < totalLen) {
        this._voiceV2TxBuf = new Uint8Array(totalLen);
      }
      const buf = this._voiceV2TxBuf;
      const tsU32 = this._voiceV2TxSamples >>> 0;
      buf[0] = VOICE_V2_CODEC_PCM16;
      buf[1] = Math.round(VOICE_HD_OUT_SAMPLE_RATE / 1000) & 0xff;
      buf[2] = rms & 0xff;
      buf[3] = (rms >>> 8) & 0xff;
      buf[4] = tsU32 & 0xff;
      buf[5] = (tsU32 >>> 8) & 0xff;
      buf[6] = (tsU32 >>> 16) & 0xff;
      buf[7] = (tsU32 >>> 24) & 0xff;

      const dv = new DataView(buf.buffer, buf.byteOffset + VOICE_V2_HEADER_BYTES, payloadBytes);
      for (let i = 0; i < samples.length; i++) {
        dv.setInt16(i * 2, samples[i], true);
      }

      this._voiceV2TxSamples = (this._voiceV2TxSamples + samples.length) >>> 0;
      const packets = this.wasm.sealVoiceRaw(buf.subarray(0, totalLen));
      for (const { peerId, data } of packets) {
        if (this.peerVoiceCaps.get(peerId)?.v2pcm !== true) continue;
        const vdc = this.voiceChannels.get(peerId);
        if (vdc && vdc.readyState === "open" && (vdc.bufferedAmount || 0) < 65536) {
          try {
            vdc.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
            sent += 1;
          } catch {
            // drop frame cleanly under congestion
          }
        }
      }
    }

    if (hasLegacyPeers) {
      const pcm16k = this._v1FallbackResampler.resampleFrameInt16(samples, {
        sampleRate: VOICE_HD_OUT_SAMPLE_RATE,
      });
      if (pcm16k.length > 0) {
        const { packets } = this.wasm.sealVoicePcm(pcm16k);
        for (const { peerId, data } of packets) {
          if (this.peerVoiceCaps.get(peerId)?.v2pcm === true) continue;
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
      }
    }

    return sent;
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
   * Pushes signed 16-bit little-endian PCM bytes into the paced 24 kHz voice sender.
   * Seamlessly downmixes and streaming-cubic-resamples any input rate (16/22.05/24/48 kHz)
   * into lossless 24 kHz mono PCM with zero chunk-boundary clicks.
   */
  pushPcmBytes(buf, { sampleRate = VOICE_SAMPLE_RATE, channels = 1 } = {}) {
    if (!buf || buf.length === 0) return;
    if (!this.inVoice) {
      this.joinVoice({ muted: false });
    }
    const pcm24k = this._txResampler.push(buf, { sampleRate, channels });
    if (pcm24k.length > 0) {
      this.pacer.pushBytes(pcm24k);
    }
  }

  /**
   * Signals the end of a streamed PCM utterance so `audioEnd` fires cleanly once the final
   * buffered frame has been transmitted.
   */
  markAudioStreamEnd() {
    this._txResampler.reset();
    this._v1FallbackResampler.reset();
    this.pacer.markInputEnded();
  }

  isPlayingAudio() {
    return this.pacer.isActive();
  }

  /**
   * Creates a VoiceRoomMixer attached to this bot for continuous 16 kHz wake-word / STT capture
   * with automatic silence-gap filling, speaker locking, and TTS echo suppression.
   */
  createVoiceMixer(options = {}) {
    return new VoiceRoomMixer({ ...options, bot: this });
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
    this._txResampler.reset();
    this._v1FallbackResampler.reset();
    this.pacer.stop();
  }

  /**
   * Transcodes any local audio file or HTTP audio stream with ffmpeg into 24 kHz mono PCM
   * and streams it live into the E2EE voice channel.
   */
  playAudioFile(inputPathOrUrl, { ffmpegPath = "ffmpeg", gain = 1.0 } = {}) {
    if (!this.inVoice) {
      this.joinVoice({ muted: false });
    }
    this.stopAudio();
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
      String(VOICE_HD_OUT_SAMPLE_RATE),
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
   * Plays a crisp built-in assistant chime ("awake" | "done" | "timer" | "error") with zero audio files.
   */
  playChime(kind = "awake", { amplitude = 0.22 } = {}) {
    const presets = {
      awake: [
        { freqHz: 587.33, durationMs: 85 },
        { freqHz: 880.0, durationMs: 120 },
      ],
      done: [
        { freqHz: 783.99, durationMs: 75 },
        { freqHz: 523.25, durationMs: 110 },
      ],
      timer: [
        { freqHz: 880.0, durationMs: 120 },
        { freqHz: 0, durationMs: 60 },
        { freqHz: 880.0, durationMs: 120 },
        { freqHz: 0, durationMs: 60 },
        { freqHz: 1174.66, durationMs: 240 },
      ],
      error: [
        { freqHz: 330.0, durationMs: 120 },
        { freqHz: 246.94, durationMs: 180 },
      ],
    };
    const notes = presets[String(kind || "").toLowerCase()] || presets.awake;
    return this.playMelody(notes, { amplitude });
  }

  /**
   * Streams a sequence of `{ freqHz, durationMs }` synth notes into voice chat (great for chimes & demos).
   */
  playMelody(notes, { amplitude = 0.25 } = {}) {
    if (!this.inVoice) {
      this.joinVoice({ muted: false });
    }
    this.stopAudio();
    this.setAudioGain(1.0);

    const chunks = [];
    const sr = VOICE_HD_OUT_SAMPLE_RATE;
    for (const note of notes) {
      const durMs = Math.max(20, Number(note.durationMs) || 200);
      const totalSamples = Math.round((sr * durMs) / 1000);
      const freq = Number(note.freqHz) || 0;
      const buf = Buffer.alloc(totalSamples * 2);
      const fadeSamples = Math.min(Math.round(sr * 0.01), Math.floor(totalSamples / 4));
      for (let i = 0; i < totalSamples; i++) {
        let env = 1;
        if (fadeSamples > 0) {
          if (i < fadeSamples) {
            env = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
          } else if (i >= totalSamples - fadeSamples) {
            const tailIdx = totalSamples - 1 - i;
            env = 0.5 * (1 - Math.cos((Math.PI * tailIdx) / fadeSamples));
          }
        }
        const val =
          freq > 0
            ? Math.sin((2 * Math.PI * freq * i) / sr) * amplitude * env
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

  async _ensureRoomMyTag() {
    if (!this.activeRoom || !this.status) return null;
    const topic = this.activeRoom.topic;
    const peerId = this.status.peerId;
    if (this.roomMyTag && this.roomMyTag.topic === topic && this.roomMyTag.peerId === peerId) {
      return this.roomMyTag;
    }
    const shaFallback = this.wasm ? (b) => this.wasm.sha256(b) : null;
    const tag = await computePeerTag(topic, peerId, shaFallback);
    this.roomMyTag = { topic, peerId, bytes: tag.bytes, hex: tag.hex };
    return this.roomMyTag;
  }

  async _registerKnownRoomPeer(peerId, name, pk, relays = null) {
    if (!this.activeRoom || !peerId || peerId === this.status?.peerId) return null;
    let info = this.roomKnownPeers.get(peerId);
    if (!info) {
      const shaFallback = this.wasm ? (b) => this.wasm.sha256(b) : null;
      const tag = await computePeerTag(this.activeRoom.topic, peerId, shaFallback);
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

  _announceRoomHello(requestReply) {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    const status = this.roomRendezvous.getStatus();
    this._sendRoomSignal({
      t: "hello",
      from: this.status.peerId,
      name: this.status.authorName,
      pk: this.status.e2ee.publicKey,
      peers: Array.from(this.directPeers.keys()),
      relays: status.connectedUrls || [],
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
        this._recordPeerVoiceCapsFromSignal(msg);
        await this._ensureRoomMyTag();
        await this._registerKnownRoomPeer(msg.from, msg.name, msg.pk, msg.relays);
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
        this._recordPeerVoiceCapsFromSignal(msg);
        await this._ensureRoomMyTag();
        if (msg.from && msg.pk) {
          await this._registerKnownRoomPeer(msg.from, msg.name, msg.pk, msg.relays);
        }
        await this._acceptRoomOffer(msg);
        break;
      }
      case "answer": {
        this._recordPeerVoiceCapsFromSignal(msg);
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
      case "relay-open": {
        if (!msg.from || !msg.pk) return;
        this._recordPeerVoiceCapsFromSignal(msg);
        await this._ensureRoomMyTag();
        await this._registerKnownRoomPeer(msg.from, msg.name, msg.pk, msg.relays);
        const existing = this.directPeers.get(msg.from);
        if (existing && existing.transport === "direct" && existing.dc?.readyState === "open") {
          return;
        }
        const status = this.roomRendezvous?.getStatus();
        this._sendRoomSignal({
          t: "relay-ack",
          from: this.status.peerId,
          to: msg.from,
          name: this.status.authorName,
          pk: this.status.e2ee.publicKey,
          relays: status?.connectedUrls || [],
        });
        await this._openRelayVirtualPeer(msg.from, msg.name || "Peer", msg.pk);
        break;
      }
      case "relay-ack": {
        if (!msg.from || !msg.pk) return;
        this._recordPeerVoiceCapsFromSignal(msg);
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
        await this._openRelayVirtualPeer(msg.from, msg.name || "Peer", msg.pk);
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

  async _requestRelayFallback(targetPeerId, targetName, targetPubKey) {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    const existing = this.directPeers.get(targetPeerId);
    if (existing && existing.dc && existing.dc.readyState === "open") return;
    if (this.relayPendingOpens.has(targetPeerId)) return;

    await this._ensureRoomMyTag();
    const known = await this._registerKnownRoomPeer(targetPeerId, targetName, targetPubKey);
    const pk = targetPubKey || known?.pk || "";
    if (!pk) return;

    const sendOpen = () => {
      const cur = this.directPeers.get(targetPeerId);
      if (cur && cur.dc && cur.dc.readyState === "open") {
        const p = this.relayPendingOpens.get(targetPeerId);
        if (p?.retryTimer) clearTimeout(p.retryTimer);
        this.relayPendingOpens.delete(targetPeerId);
        return;
      }
      const status = this.roomRendezvous?.getStatus();
      this._sendRoomSignal({
        t: "relay-open",
        from: this.status.peerId,
        to: targetPeerId,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        relays: status?.connectedUrls || [],
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

  async _openRelayVirtualPeer(peerId, peerName, peerPubKey) {
    if (!this.activeRoom || !this.roomRendezvous || !this.status) return;
    const existing = this.directPeers.get(peerId);
    if (existing && existing.dc && existing.dc.readyState === "open") return;

    const myTag = await this._ensureRoomMyTag();
    const peerInfo = await this._registerKnownRoomPeer(peerId, peerName, peerPubKey);
    if (!myTag || !peerInfo) return;

    const bot = this;
    const virtualPc = {
      connectionState: "connected",
      iceConnectionState: "connected",
      onconnectionstatechange: null,
      close() {
        this.connectionState = "closed";
        this.iceConnectionState = "closed";
      },
    };

    const virtualDc = {
      label: "p2p-mesh",
      transport: "relay",
      readyState: "open",
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null,
      send(frameStr) {
        if (this.readyState !== "open" || !bot.roomRendezvous || !bot.activeRoom) return;
        const msgId = (bot.relayDataMsgSeq = (bot.relayDataMsgSeq + 1) >>> 0) || 1;
        const payloadBytes = Buffer.from(String(frameStr), "utf8");
        const total = Math.max(1, Math.ceil(payloadBytes.length / RELAY_DATA_CHUNK_SIZE));
        const preferredUrls = peerInfo.relays && peerInfo.relays.length > 0 ? peerInfo.relays : null;
        for (let idx = 0; idx < total; idx++) {
          const chunkPkt = encodeSingleRelayDataChunk(
            myTag.bytes,
            peerInfo.tagBytes,
            msgId,
            idx,
            total,
            payloadBytes,
            RELAY_DATA_CHUNK_SIZE
          );
          bot.roomRendezvous.publishBinary(chunkPkt, {
            preferredUrls,
            maxBrokers: 2,
            queueIfOffline: true,
          });
        }
      },
      close(silentRemote = false) {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        const entry = bot.directPeers.get(peerId);
        const superseded = Boolean(entry && entry.dc === this && entry.superseded);
        if (!silentRemote && !superseded && bot.activeRoom && bot.roomRendezvous && bot.status) {
          bot._sendRoomSignal({ t: "relay-close", from: bot.status.peerId, to: peerId });
        }
        if (typeof this.onclose === "function") {
          const cb = this.onclose;
          this.onclose = null;
          cb();
        }
      },
    };

    const voiceQueue = [];
    let voiceFlushTimer = null;
    const flushVoiceQueue = () => {
      if (voiceFlushTimer) {
        clearTimeout(voiceFlushTimer);
        voiceFlushTimer = null;
      }
      if (voiceQueue.length === 0 || !bot.roomRendezvous || !bot.activeRoom) {
        voiceQueue.length = 0;
        return;
      }
      const batch = voiceQueue.splice(0, VOICE_RELAY_MAX_FRAMES);
      const seq = (bot.relayVoiceBundleSeq = (bot.relayVoiceBundleSeq + 1) >>> 0) || 1;
      const bundle = encodeRelayVoiceBundle(myTag.bytes, peerInfo.tagBytes, seq, batch);
      const preferredUrls = peerInfo.relays && peerInfo.relays.length > 0 ? peerInfo.relays : null;
      bot.roomRendezvous.publishBinary(bundle, {
        preferredUrls,
        maxBrokers: 1,
        queueIfOffline: false,
      });
      if (voiceQueue.length > 0) {
        voiceFlushTimer = setTimeout(flushVoiceQueue, VOICE_RELAY_BATCH_MS);
      }
    };

    const virtualVoiceDc = {
      label: "p2p-voice",
      transport: "relay",
      readyState: "open",
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
        if (voiceQueue.length >= VOICE_RELAY_MAX_FRAMES) {
          flushVoiceQueue();
        } else if (!voiceFlushTimer) {
          voiceFlushTimer = setTimeout(flushVoiceQueue, VOICE_RELAY_BATCH_MS);
        }
      },
      close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        voiceQueue.length = 0;
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

    this._attachVoiceDataChannel(peerId, virtualVoiceDc);
    this._attachDataChannel(
      virtualPc,
      virtualDc,
      peerId,
      peerInfo.name || peerName || "Peer",
      peerInfo.pk || peerPubKey,
      false,
      null
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
  }

  _handleIncomingRelayBinary(bytes, brokerUrl) {
    if (!this.activeRoom || !this.roomMyTag || !bytes || bytes.length < 2) return;
    const myTagBytes = this.roomMyTag.bytes;

    if (bytes[0] === 0x44 && bytes[1] === 0x46) {
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
        fullFrameStr = Buffer.from(
          decoded.chunkBytes.buffer,
          decoded.chunkBytes.byteOffset,
          decoded.chunkBytes.byteLength
        ).toString("utf8");
      } else {
        const asmKey = `${decoded.fromHex}:${decoded.msgId}`;
        let asm = this.relayChunkAssemblies.get(asmKey);
        if (!asm) {
          asm = { total: decoded.total, parts: new Array(decoded.total), received: 0, ts: Date.now() };
          this.relayChunkAssemblies.set(asmKey, asm);
        }
        if (!asm.parts[decoded.idx]) {
          asm.parts[decoded.idx] = decoded.chunkBytes.slice();
          asm.received += 1;
          asm.ts = Date.now();
        }
        if (asm.received === asm.total) {
          this.relayChunkAssemblies.delete(asmKey);
          fullFrameStr = Buffer.concat(asm.parts.map((p) => Buffer.from(p))).toString("utf8");
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

      if (peerEntry.transport === "relay" && typeof peerEntry.dc?.onmessage === "function") {
        peerEntry.dc.onmessage({ data: fullFrameStr });
      } else if (this.wasm) {
        peerEntry.lastActivityMs = Date.now();
        try {
          const res = this.wasm.wireMessage(senderPeerId, fullFrameStr, Date.now());
          this.status = res.status;
          this._executeActions(res.actions);
          this._reconcilePeers();
        } catch {
          // ignore duplicate during handoff
        }
      }
      return;
    }

    if (bytes[0] === 0x56 && bytes[1] === 0x42) {
      const bundle = decodeRelayVoiceBundle(bytes, myTagBytes, myTagBytes);
      if (!bundle) return;
      if (this.seenVoiceBundleSeq.get(bundle.fromHex) === bundle.seq) return;
      this.seenVoiceBundleSeq.set(bundle.fromHex, bundle.seq);

      const senderPeerId = this.roomTagToPeerId.get(bundle.fromHex);
      if (!senderPeerId || !this.inVoice || !this.wasm) return;
      const peerEntry = this.directPeers.get(senderPeerId);
      if (!peerEntry) return;
      peerEntry.lastActivityMs = Date.now();
      for (const frameBytes of bundle.frames) {
        const decoded = this.wasm.openVoicePacket(senderPeerId, frameBytes);
        if (decoded && decoded.pcm && decoded.pcm.length > 0) {
          this.emit("voiceAudio", { peerId: senderPeerId, rms: decoded.rms, pcm: decoded.pcm });
        }
      }
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
    if (!pc || !cand || typeof pc.addIceCandidate !== "function") return;
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

  _cleanupRoomDialingEntry(peerId, entry) {
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
      entry.pc?.close();
    } catch {
      // ignore
    }
  }

  async _startRoomOffer(targetPeerId, targetName, targetPubKey) {
    if (this.roomDialing.has(targetPeerId)) return;
    let entry = null;
    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const dc = pc.createDataChannel("p2p-mesh", { ordered: true });
      const voiceDc = pc.createDataChannel("p2p-voice", { ordered: false, maxRetransmits: 0 });
      const bulkDc = pc.createDataChannel("p2p-bulk", { ordered: true });
      const early = this.earlyRoomIce.get(targetPeerId) || [];
      this.earlyRoomIce.delete(targetPeerId);

      entry = {
        pc,
        dc,
        voiceDc,
        bulkDc,
        targetName,
        targetPubKey,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        fallbackTimer: null,
        hardTimer: null,
        startedAt: Date.now(),
      };
      this.roomDialing.set(targetPeerId, entry);
      this._attachVoiceDataChannel(targetPeerId, voiceDc);
      this._attachBulkDataChannel(targetPeerId, bulkDc);
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
      const status = this.roomRendezvous?.getStatus();

      this._sendRoomSignal({
        t: "offer",
        from: this.status.peerId,
        to: targetPeerId,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        relays: status?.connectedUrls || [],
        sdp: offer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }

      entry.fallbackTimer = setTimeout(() => {
        if (this.roomDialing.get(targetPeerId) !== entry) return;
        const cur = this.directPeers.get(targetPeerId);
        if (cur && cur.transport === "direct" && cur.dc?.readyState === "open") return;
        this._requestRelayFallback(targetPeerId, targetName, targetPubKey);
      }, DIRECT_FALLBACK_TIMEOUT_MS);

      entry.hardTimer = setTimeout(() => {
        if (this.roomDialing.get(targetPeerId) !== entry) return;
        this._cleanupRoomDialingEntry(targetPeerId, entry);
      }, DIRECT_HARD_TIMEOUT_MS);
    } catch {
      if (entry) {
        this._cleanupRoomDialingEntry(targetPeerId, entry);
      } else {
        this.roomDialing.delete(targetPeerId);
      }
      this._requestRelayFallback(targetPeerId, targetName, targetPubKey);
    }
  }

  async _acceptRoomOffer(msg) {
    if (!msg.from || !msg.sdp || !msg.pk) return;
    const prev = this.roomDialing.get(msg.from);
    if (prev) {
      this._cleanupRoomDialingEntry(msg.from, prev);
    }
    let entry = null;
    try {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const early = this.earlyRoomIce.get(msg.from) || [];
      this.earlyRoomIce.delete(msg.from);

      entry = {
        pc,
        dc: null,
        targetName: msg.name || "Peer",
        targetPubKey: msg.pk,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        fallbackTimer: null,
        hardTimer: null,
        startedAt: Date.now(),
      };
      this.roomDialing.set(msg.from, entry);

      pc.onconnectionstatechange = () => {
        if (this.roomDialing.get(msg.from) !== entry) return;
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          this._cleanupRoomDialingEntry(msg.from, entry);
          this._requestRelayFallback(msg.from, msg.name || "Peer", msg.pk);
        }
      };

      pc.ondatachannel = (ev) => {
        if (ev.channel.label === "p2p-voice") {
          this._attachVoiceDataChannel(msg.from, ev.channel);
          return;
        }
        if (ev.channel.label === "p2p-bulk") {
          this._attachBulkDataChannel(msg.from, ev.channel);
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
      const status = this.roomRendezvous?.getStatus();

      this._sendRoomSignal({
        t: "answer",
        from: this.status.peerId,
        to: msg.from,
        name: this.status.authorName,
        pk: this.status.e2ee.publicKey,
        relays: status?.connectedUrls || [],
        sdp: answer.sdp,
      });

      entry.sdpSent = true;
      while (entry.localIceQueue.length > 0) {
        sendIce(entry.localIceQueue.shift());
      }

      entry.fallbackTimer = setTimeout(() => {
        if (this.roomDialing.get(msg.from) !== entry) return;
        const cur = this.directPeers.get(msg.from);
        if (cur && cur.dc?.readyState === "open") return;
        this._requestRelayFallback(msg.from, msg.name || "Peer", msg.pk);
      }, ANSWER_FALLBACK_TIMEOUT_MS);

      entry.hardTimer = setTimeout(() => {
        if (this.roomDialing.get(msg.from) !== entry) return;
        this._cleanupRoomDialingEntry(msg.from, entry);
      }, DIRECT_HARD_TIMEOUT_MS);
    } catch {
      if (entry) {
        this._cleanupRoomDialingEntry(msg.from, entry);
      } else {
        this.roomDialing.delete(msg.from);
      }
      this._requestRelayFallback(msg.from, msg.name || "Peer", msg.pk);
    }
  }

  async _applyRoomAnswer(msg) {
    if (msg?.from) {
      this._recordPeerVoiceCapsFromSignal(msg);
    }
    const entry = this.roomDialing.get(msg.from);
    if (!entry || !msg.sdp) return;
    if (msg.from && msg.relays) {
      await this._registerKnownRoomPeer(msg.from, msg.name, msg.pk, msg.relays);
    }
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
      if (direct && direct.pc && typeof direct.pc.addIceCandidate === "function") {
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
      const bulkDc = pc.createDataChannel("p2p-bulk", { ordered: true });
      const early = this.earlyRelayIce.get(targetPeerId) || [];
      this.earlyRelayIce.delete(targetPeerId);

      const entry = {
        pc,
        dc,
        voiceDc,
        bulkDc,
        remoteDescSet: false,
        sdpSent: false,
        localIceQueue: [],
        pendingIce: early,
        viaPeerId,
      };
      this.relayPeers.set(targetPeerId, entry);
      this._attachVoiceDataChannel(targetPeerId, voiceDc);
      this._attachBulkDataChannel(targetPeerId, bulkDc);
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
        if (ev.channel.label === "p2p-bulk") {
          this._attachBulkDataChannel(fromPeerId, ev.channel);
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
    if (prev && prev !== voiceDc && prev.readyState === "open" && voiceDc.readyState !== "open") {
      voiceDc.onopen = () => {
        if (voiceDc.readyState === "open") {
          this._attachVoiceDataChannel(peerId, voiceDc);
        }
      };
      return;
    }
    if (prev && prev !== voiceDc) {
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

  _attachBulkDataChannel(peerId, bulkDc) {
    if (!bulkDc) return;
    const prev = this.bulkChannels.get(peerId);
    if (prev && prev !== bulkDc && prev.readyState === "open" && bulkDc.readyState !== "open") {
      bulkDc.onopen = () => {
        if (bulkDc.readyState === "open") {
          this._attachBulkDataChannel(peerId, bulkDc);
        }
      };
      return;
    }
    if (prev && prev !== bulkDc) {
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
        prev.onclose = null;
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

    const bulkAssemblies = new Map();
    bulkDc.onmessage = (ev) => {
      const live = this.directPeers.get(peerId);
      if (!live || live.superseded || !this.wasm) return;
      live.lastActivityMs = Date.now();
      const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
      if (typeof live.handleIncomingRaw === "function") {
        live.handleIncomingRaw(raw, bulkAssemblies);
      }
    };
    bulkDc.onclose = () => {
      bulkAssemblies.clear();
      if (this.bulkChannels.get(peerId) === bulkDc) {
        this.bulkChannels.delete(peerId);
      }
      const live = this.directPeers.get(peerId);
      if (live && live.bulkDc === bulkDc) {
        live.bulkDc = null;
      }
    };
  }

  _attachDataChannel(pc, dc, peerId, authorName, peerPubKey, viaAutoMesh, introducedBy) {
    const transport = dc && dc.transport === "relay" ? "relay" : "direct";
    const curVoice = this.voiceChannels.get(peerId);
    const matchedVoice =
      curVoice && (curVoice.transport === "relay") === (transport === "relay") ? curVoice : null;
    const curBulk = this.bulkChannels.get(peerId);
    const matchedBulk =
      curBulk && (curBulk.transport === "relay") === (transport === "relay") ? curBulk : null;

    const peerEntry = {
      pc,
      dc,
      transport,
      voiceDc: matchedVoice,
      bulkDc: matchedBulk,
      authorName,
      lastActivityMs: Date.now(),
      superseded: false,
      handleIncomingRaw: null,
    };

    let opened = false;
    let closed = false;

    const handleOpen = () => {
      if (opened || closed || !this.wasm) return;
      opened = true;
      peerEntry.lastActivityMs = Date.now();

      const prev = this.directPeers.get(peerId);
      let upgradingFromRelay = false;
      if (prev && prev !== peerEntry) {
        if (transport === "relay" && prev.transport === "direct" && prev.dc?.readyState === "open") {
          try {
            dc.close(true);
            pc.close();
          } catch {
            // ignore
          }
          return;
        }
        upgradingFromRelay =
          prev.transport === "relay" &&
          transport === "direct" &&
          prev.dc &&
          prev.dc.readyState === "open";
        prev.superseded = true;
        try {
          if (prev.bulkDc) prev.bulkDc.close();
          if (prev.transport === "relay") {
            prev.dc?.close(true);
          } else {
            prev.dc?.close();
          }
          prev.pc?.close();
        } catch {
          // ignore
        }
      }

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
        const dialing = this.roomDialing.get(peerId);
        if (dialing) {
          if (dialing.fallbackTimer) clearTimeout(dialing.fallbackTimer);
          if (dialing.hardTimer) clearTimeout(dialing.hardTimer);
          if (dialing.voiceDc && dialing.voiceDc.readyState === "open") {
            this._attachVoiceDataChannel(peerId, dialing.voiceDc);
            peerEntry.voiceDc = dialing.voiceDc;
          }
          if (dialing.bulkDc && dialing.bulkDc.readyState === "open") {
            this._attachBulkDataChannel(peerId, dialing.bulkDc);
            peerEntry.bulkDc = dialing.bulkDc;
          }
          this.roomDialing.delete(peerId);
        }
        this.relayPeers.delete(peerId);
      }

      this.directPeers.set(peerId, peerEntry);

      if (upgradingFromRelay) {
        return;
      }

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
      const isOwning = this.directPeers.get(peerId) === peerEntry;
      if (isOwning) {
        this.directPeers.delete(peerId);
        this.peerVoiceCaps.delete(peerId);
      }
      if (this.voiceChannels.get(peerId) === peerEntry.voiceDc) {
        this.voiceChannels.delete(peerId);
      }
      if (this.bulkChannels.get(peerId) === peerEntry.bulkDc) {
        this.bulkChannels.delete(peerId);
      }
      if (isOwning && this.wasm) {
        try {
          const res = this.wasm.call({ cmd: "peer_disconnected", peerId });
          this.status = res.status;
          this._executeActions(res.actions);
        } catch {
          // ignore
        }
        this._reconcilePeers();
      }
      const rm = this.roomDialing.get(peerId);
      if (rm && rm.pc === pc) {
        this._cleanupRoomDialingEntry(peerId, rm);
        if (!this.directPeers.has(peerId)) {
          this._requestRelayFallback(peerId, authorName, peerPubKey);
        }
      }
    };

    const dcChunkAssemblies = new Map();
    const deliverWireFrame = (frameStr) => {
      try {
        const res = this.wasm.wireMessage(peerId, frameStr, Date.now());
        this.status = res.status;
        this._executeActions(res.actions);
        this._reconcilePeers();
      } catch (err) {
        this.emit("error", err);
      }
    };

    const handleIncomingRaw = (raw, asmMap) => {
      if (raw.startsWith('{"kind":"dc_chunk"')) {
        try {
          const ch = JSON.parse(raw);
          if (
            ch &&
            ch.kind === "dc_chunk" &&
            typeof ch.id === "number" &&
            typeof ch.i === "number" &&
            typeof ch.n === "number" &&
            typeof ch.d === "string" &&
            ch.n > 0 &&
            ch.n <= 2048 &&
            ch.i >= 0 &&
            ch.i < ch.n
          ) {
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
              deliverWireFrame(asm.parts.join(""));
            }
            return;
          }
        } catch {
          return;
        }
      }
      deliverWireFrame(raw);
    };
    peerEntry.handleIncomingRaw = handleIncomingRaw;

    dc.onmessage = (ev) => {
      if (!this.wasm || closed || peerEntry.superseded) return;
      peerEntry.lastActivityMs = Date.now();
      const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
      handleIncomingRaw(raw, dcChunkAssemblies);
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
      const lastEditId =
        Array.isArray(m.edits) && m.edits.length > 0 ? m.edits[m.edits.length - 1].id : "";
      const rev = m.updatedLamport
        ? `${m.updatedLamport}:${m.editCount || 1}:${lastEditId}`
        : "0";
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
        if ((m.editedBy || m.author) !== this.peerId) {
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

    // Expire stale room dials > DIRECT_HARD_TIMEOUT_MS + 4s
    for (const [pid, entry] of this.roomDialing.entries()) {
      if (now - entry.startedAt > DIRECT_HARD_TIMEOUT_MS + 4000) {
        this._cleanupRoomDialingEntry(pid, entry);
      }
    }

    // Expire inactive E2EE relay peers
    for (const [, peer] of Array.from(this.directPeers.entries())) {
      if (peer.transport !== "relay" || peer.superseded) continue;
      if (now - (peer.lastActivityMs || 0) > RELAY_INACTIVITY_TIMEOUT_MS) {
        try {
          peer.dc.close(true);
        } catch {
          // ignore
        }
      }
    }

    for (const [key, asm] of this.relayChunkAssemblies.entries()) {
      if (now - asm.ts > 30_000) {
        this.relayChunkAssemblies.delete(key);
      }
    }
    for (const [key, ts] of this.seenRelayChunkKeys.entries()) {
      if (now - ts > 60_000) {
        this.seenRelayChunkKeys.delete(key);
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

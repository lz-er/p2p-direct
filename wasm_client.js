const MAGIC_0 = 0x50325031;
const MAGIC_1 = 0x5741534d;
const MAGIC_2 = 0x4d455348;
const MAGIC_3 = 0x56303031;

const OP_HANDSHAKE = 0;
const OP_CALL = 1;
const OP_STREAM_APPEND = 2;
const OP_STREAM_EXEC = 3;
const OP_READ_OUT_CHUNK = 4;
const OP_VOICE_ENCODE_SEAL = 5;
const OP_VOICE_OPEN_DECODE = 6;
const OP_VOICE_SEAL_RAW = 7;
const OP_VOICE_OPEN_RAW = 8;
const OP_VOICE_PROCESS_CAPTURE_48K = 9;
const OP_WIRE_MESSAGE = 10;
const OP_STREAM_EXEC_WIRE = 11;
const OP_WORKER_SEAL_BULK = 12;
const OP_STREAM_EXEC_WORKER_SEAL = 13;
const OP_WORKER_OPEN_BULK = 14;
const OP_STREAM_EXEC_WORKER_OPEN = 15;
const OP_COMMIT_BULK_PUBLISH = 16;
const OP_STREAM_EXEC_COMMIT_PUBLISH = 17;
const OP_COMMIT_BULK_RX = 18;
const OP_STREAM_EXEC_COMMIT_RX = 19;
const OP_WORKER_SEAL_FORWARD = 20;
const OP_STREAM_EXEC_WORKER_SEAL_FORWARD = 21;
const OP_GET_COUNTERS = 22;
const OP_SHA256 = 23;

const STATUS_OK = 1;
const EXPECTED_BUF_CAP = 262144;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Off-main-thread Web Worker running the same compiled Safe Rust p2p_mesh.wasm module
// for multi-MB GIF/video ChaCha20-Poly1305 sealing & opening so 20ms voice packets never stall.
const BULK_CRYPTO_WORKER_SCRIPT = `
const MAGIC_0 = 0x50325031;
const MAGIC_1 = 0x5741534d;
const MAGIC_2 = 0x4d455348;
const MAGIC_3 = 0x56303031;
const STATUS_OK = 1;
const EXPECTED_BUF_CAP = 262144;
const OP_STREAM_APPEND = 2;
const OP_READ_OUT_CHUNK = 4;
const OP_WORKER_SEAL_BULK = 12;
const OP_STREAM_EXEC_WORKER_SEAL = 13;
const OP_WORKER_OPEN_BULK = 14;
const OP_STREAM_EXEC_WORKER_OPEN = 15;
const OP_WORKER_SEAL_FORWARD = 20;
const OP_STREAM_EXEC_WORKER_SEAL_FORWARD = 21;

const te = new TextEncoder();
const td = new TextDecoder();

let inst = null;
let mem = null;
let mainFn = null;
let hdrOff = 0;
let inPtr = 0;
let outPtr = 0;
let bufCap = EXPECTED_BUF_CAP;
let cachedBuf = null;
let cachedHdr = null;
let cachedIn = null;
let cachedOut = null;

function ensureViews() {
  const buf = mem.buffer;
  if (buf !== cachedBuf) {
    cachedBuf = buf;
    cachedHdr = new Uint32Array(buf, hdrOff, 12);
    cachedIn = new Uint8Array(buf, inPtr, bufCap);
    cachedOut = new Uint8Array(buf, outPtr, bufCap);
  }
}

function invoke(op, argLen) {
  ensureViews();
  cachedHdr[4] = op;
  cachedHdr[5] = argLen;
  cachedHdr[8] = 0;
  mainFn();
  ensureViews();
  return cachedHdr;
}

function execFramed(directOp, streamOp, headerObj, tailBytes) {
  const hdrBytes = te.encode(JSON.stringify(headerObj));
  const prefixLen = 4 + hdrBytes.length;
  const totalLen = prefixLen + tailBytes.length;
  const prefix = new Uint8Array(prefixLen);
  prefix[0] = hdrBytes.length & 0xff;
  prefix[1] = (hdrBytes.length >>> 8) & 0xff;
  prefix[2] = (hdrBytes.length >>> 16) & 0xff;
  prefix[3] = (hdrBytes.length >>> 24) & 0xff;
  prefix.set(hdrBytes, 4);

  let h;
  if (totalLen <= bufCap) {
    ensureViews();
    cachedIn.set(prefix, 0);
    cachedIn.set(tailBytes, prefixLen);
    h = invoke(directOp, totalLen);
  } else {
    ensureViews();
    cachedIn.set(prefix, 0);
    h = invoke(OP_STREAM_APPEND, prefixLen);
    if (h[8] !== STATUS_OK) throw new Error("worker stream append failed");
    let offset = 0;
    while (offset < tailBytes.length) {
      const end = Math.min(offset + bufCap, tailBytes.length);
      const slice = tailBytes.subarray(offset, end);
      ensureViews();
      cachedIn.set(slice, 0);
      h = invoke(OP_STREAM_APPEND, slice.length);
      if (h[8] !== STATUS_OK) throw new Error("worker stream append failed");
      offset = end;
    }
    h = invoke(streamOp, 0);
  }

  const totalOut = h[6];
  const firstChunk = h[7];
  if (totalOut <= firstChunk) {
    return cachedOut.slice(0, totalOut);
  }
  const outBytes = new Uint8Array(totalOut);
  outBytes.set(cachedOut.subarray(0, firstChunk), 0);
  let pos = firstChunk;
  while (pos < totalOut) {
    h = invoke(OP_READ_OUT_CHUNK, pos);
    const got = h[7];
    if (!got) break;
    const rem = Math.min(got, totalOut - pos);
    outBytes.set(cachedOut.subarray(0, rem), pos);
    pos += rem;
  }
  return outBytes;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === "init") {
    try {
      const instance = await WebAssembly.instantiate(msg.module, {});
      instance.exports.main();
      const u32 = new Uint32Array(instance.exports.memory.buffer);
      let idx = -1;
      for (let i = 0; i <= u32.length - 12; i++) {
        if (
          u32[i] === MAGIC_0 &&
          u32[i + 1] === MAGIC_1 &&
          u32[i + 2] === MAGIC_2 &&
          u32[i + 3] === MAGIC_3 &&
          u32[i + 8] === STATUS_OK &&
          u32[i + 11] === EXPECTED_BUF_CAP
        ) {
          idx = i;
          break;
        }
      }
      if (idx < 0) throw new Error("worker bridge header not found");
      inst = instance;
      mem = instance.exports.memory;
      mainFn = instance.exports.main;
      hdrOff = idx * 4;
      inPtr = u32[idx + 9];
      outPtr = u32[idx + 10];
      bufCap = u32[idx + 11];
      cachedBuf = null;
      ensureViews();
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "init_error", error: err.message || String(err) });
    }
    return;
  }

  const jobId = msg.jobId;
  try {
    if (!inst) throw new Error("worker wasm not ready");
    if (msg.type === "seal_bulk") {
      const msgJsonBytes = te.encode(JSON.stringify(msg.fullMessage));
      const out = execFramed(OP_WORKER_SEAL_BULK, OP_STREAM_EXEC_WORKER_SEAL, msg.header, msgJsonBytes);
      const jlen = (out[0] | (out[1] << 8) | (out[2] << 16) | (out[3] << 24)) >>> 0;
      const parsed = JSON.parse(td.decode(out.subarray(4, 4 + jlen)));
      if (!parsed.ok) throw new Error(parsed.error || "worker_seal_bulk failed");
      const sealedCt = out.slice(4 + jlen);
      self.postMessage(
        { jobId, ok: true, wireFrames: parsed.wireFrames, sealedCt },
        [sealedCt.buffer]
      );
      return;
    }

    if (msg.type === "open_bulk") {
      const frameBytes = te.encode(msg.frameStr);
      const out = execFramed(OP_WORKER_OPEN_BULK, OP_STREAM_EXEC_WORKER_OPEN, msg.header, frameBytes);
      const mlen = (out[0] | (out[1] << 8) | (out[2] << 16) | (out[3] << 24)) >>> 0;
      const metaResp = JSON.parse(td.decode(out.subarray(4, 4 + mlen)));
      if (!metaResp.ok) throw new Error(metaResp.error || "worker_open_bulk failed");
      if (metaResp.kind !== "msg") {
        self.postMessage({ jobId, ok: true, kind: "fallback" });
        return;
      }
      const jlenOff = 4 + mlen;
      const jlen =
        (out[jlenOff] |
          (out[jlenOff + 1] << 8) |
          (out[jlenOff + 2] << 16) |
          (out[jlenOff + 3] << 24)) >>> 0;
      const msgJsonStr = td.decode(out.subarray(jlenOff + 4, jlenOff + 4 + jlen));
      const sealedCt = out.slice(jlenOff + 4 + jlen);
      self.postMessage(
        { jobId, ok: true, kind: "msg", metaResp, msgJsonStr, sealedCt },
        [sealedCt.buffer]
      );
      return;
    }

    if (msg.type === "seal_forward") {
      const sealedCt = new Uint8Array(msg.sealedCt);
      const out = execFramed(
        OP_WORKER_SEAL_FORWARD,
        OP_STREAM_EXEC_WORKER_SEAL_FORWARD,
        msg.header,
        sealedCt
      );
      const parsed = JSON.parse(td.decode(out));
      if (!parsed.ok) throw new Error(parsed.error || "worker_seal_forward failed");
      self.postMessage({ jobId, ok: true, wireFrames: parsed.wireFrames });
      return;
    }

    throw new Error("unknown worker job type: " + msg.type);
  } catch (err) {
    self.postMessage({ jobId, ok: false, error: err.message || String(err) });
  }
};
`;

export class SafeRustWasmMesh {
  constructor(instance, headerByteOffset, inPtr, outPtr, bufCap, wasmModule = null) {
    this.instance = instance;
    this.wasmModule = wasmModule;
    this.memory = instance.exports.memory;
    this.mainFn = instance.exports.main;
    this.headerByteOffset = headerByteOffset;
    this.inPtr = inPtr;
    this.outPtr = outPtr;
    this.bufCap = bufCap;
    this._cachedMemBuf = null;
    this._hdrU32 = null;
    this._inU8 = null;
    this._outU8 = null;
    this._outDv = null;
    this._peerIdBytesCache = new Map();
    this._rxPeerIdCache = [];
    this._bulkWorker = null;
    this._bulkWorkerReady = null;
    this._bulkWorkerFailed = false;
    this._bulkJobSeq = 0;
    this._bulkJobs = new Map();
    this._ensureViews();
  }

  static async loadFromUrl(url = "./p2p_mesh.wasm") {
    let result;
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        const resp = await fetch(url, { cache: "no-cache" });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} fetching ${url}`);
        }
        const clone = resp.clone();
        try {
          result = await WebAssembly.instantiateStreaming(resp, {});
        } catch {
          const bytes = await clone.arrayBuffer();
          result = await WebAssembly.instantiate(bytes, {});
        }
      } catch (err) {
        throw new Error(`Failed to load WebAssembly module (${url}): ${err.message}`);
      }
    } else {
      const resp = await fetch(url, { cache: "no-cache" });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${url}`);
      }
      const bytes = await resp.arrayBuffer();
      result = await WebAssembly.instantiate(bytes, {});
    }
    const mesh = SafeRustWasmMesh.fromInstance(result.instance, result.module);
    mesh._prewarmBulkWorker();
    return mesh;
  }

  static async loadFromBytes(bytes) {
    const result = await WebAssembly.instantiate(bytes, {});
    return SafeRustWasmMesh.fromInstance(result.instance, result.module);
  }

  static fromInstance(instance, wasmModule = null) {
    if (!instance?.exports?.main || !instance?.exports?.memory) {
      throw new Error("Invalid p2p_mesh.wasm: missing main/memory exports");
    }
    instance.exports.main();
    const u32 = new Uint32Array(instance.exports.memory.buffer);
    let headerIdx = -1;
    for (let i = 0; i <= u32.length - 12; i++) {
      if (
        u32[i] === MAGIC_0 &&
        u32[i + 1] === MAGIC_1 &&
        u32[i + 2] === MAGIC_2 &&
        u32[i + 3] === MAGIC_3 &&
        u32[i + 8] === STATUS_OK &&
        u32[i + 11] === EXPECTED_BUF_CAP
      ) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) {
      throw new Error("Could not locate WASM shared-memory bridge header");
    }
    const inPtr = u32[headerIdx + 9];
    const outPtr = u32[headerIdx + 10];
    const bufCap = u32[headerIdx + 11];
    return new SafeRustWasmMesh(instance, headerIdx * 4, inPtr, outPtr, bufCap, wasmModule);
  }

  _ensureViews() {
    const buf = this.memory.buffer;
    if (buf !== this._cachedMemBuf) {
      this._cachedMemBuf = buf;
      this._hdrU32 = new Uint32Array(buf, this.headerByteOffset, 12);
      this._inU8 = new Uint8Array(buf, this.inPtr, this.bufCap);
      this._outU8 = new Uint8Array(buf, this.outPtr, this.bufCap);
      this._outDv = new DataView(buf, this.outPtr, this.bufCap);
    }
  }

  _encodePeerIdCached(peerId) {
    let cached = this._peerIdBytesCache.get(peerId);
    if (cached) return cached;
    cached = textEncoder.encode(peerId);
    if (this._peerIdBytesCache.size >= 64) {
      this._peerIdBytesCache.clear();
    }
    this._peerIdBytesCache.set(peerId, cached);
    return cached;
  }

  _decodePeerIdCached(outBytes, offset, len) {
    const cache = this._rxPeerIdCache;
    for (let c = 0; c < cache.length; c++) {
      const entry = cache[c];
      const eb = entry.bytes;
      if (eb.length !== len) continue;
      let match = true;
      for (let j = 0; j < len; j++) {
        if (eb[j] !== outBytes[offset + j]) {
          match = false;
          break;
        }
      }
      if (match) return entry.str;
    }
    const copy = outBytes.slice(offset, offset + len);
    const str = textDecoder.decode(copy);
    if (cache.length >= 32) cache.shift();
    cache.push({ bytes: copy, str });
    return str;
  }

  _invoke(op, argLen) {
    this._ensureViews();
    this._hdrU32[4] = op;
    this._hdrU32[5] = argLen;
    this._hdrU32[8] = 0;
    this.mainFn();
    this._ensureViews();
    return this._hdrU32;
  }

  call(requestObj) {
    const payloadStr = JSON.stringify(requestObj);
    const bytes = textEncoder.encode(payloadStr);
    let hdr;

    if (bytes.length <= this.bufCap) {
      this._ensureViews();
      this._inU8.set(bytes, 0);
      hdr = this._invoke(OP_CALL, bytes.length);
    } else {
      let offset = 0;
      while (offset < bytes.length) {
        const end = Math.min(offset + this.bufCap, bytes.length);
        const slice = bytes.subarray(offset, end);
        this._ensureViews();
        this._inU8.set(slice, 0);
        hdr = this._invoke(OP_STREAM_APPEND, slice.length);
        if (hdr[8] !== STATUS_OK) {
          throw new Error("WASM bridge stream append failed");
        }
        offset = end;
      }
      hdr = this._invoke(OP_STREAM_EXEC, 0);
    }

    return this._readJsonResponse(hdr);
  }

  _readJsonResponse(hdr) {
    const totalOutLen = hdr[6];
    const firstChunkLen = hdr[7];
    let respText;

    if (totalOutLen <= firstChunkLen) {
      // Zero-copy decode directly from WASM shared output window
      respText = textDecoder.decode(this._outU8.subarray(0, totalOutLen));
    } else {
      const outBytes = new Uint8Array(totalOutLen);
      outBytes.set(this._outU8.subarray(0, firstChunkLen), 0);
      let readOffset = firstChunkLen;
      while (readOffset < totalOutLen) {
        hdr = this._invoke(OP_READ_OUT_CHUNK, readOffset);
        const got = hdr[7];
        if (got === 0) {
          break;
        }
        const remaining = Math.min(got, totalOutLen - readOffset);
        outBytes.set(this._outU8.subarray(0, remaining), readOffset);
        readOffset += remaining;
      }
      respText = textDecoder.decode(outBytes);
    }

    const parsed = JSON.parse(respText);
    if (!parsed.ok) {
      throw new Error(parsed.error || "Unknown WASM RPC error");
    }
    return parsed;
  }

  /**
   * Pure zero-JSON binary fast-path for reading live packet/E2EE/log counters in < 1 us.
   */
  getCounters() {
    const hdr = this._invoke(OP_GET_COUNTERS, 0);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen < 88) {
      return null;
    }
    const dv = this._outDv;
    const readU64 = (off) => dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 0x100000000;
    return {
      voicePacketsSent: readU64(0),
      voicePacketsReceived: readU64(8),
      framesSent: readU64(16),
      framesReceived: readU64(24),
      e2eeFramesEncrypted: readU64(32),
      e2eeFramesDecrypted: readU64(40),
      e2eeAuthFailures: readU64(48),
      gossipForwards: readU64(56),
      gossipDuplicatesDropped: readU64(64),
      logCount: readU64(72),
      lamport: readU64(80),
    };
  }

  /**
   * Computes FIPS 180-4 SHA-256 directly in safe Rust WASM (works identically even on non-HTTPS LAN).
   */
  sha256(inputBytesOrStr) {
    const bytes =
      inputBytesOrStr instanceof Uint8Array
        ? inputBytesOrStr
        : textEncoder.encode(String(inputBytesOrStr || ""));
    if (bytes.length > this.bufCap) {
      throw new Error("sha256 input exceeds bridge buffer capacity");
    }
    this._ensureViews();
    this._inU8.set(bytes, 0);
    const hdr = this._invoke(OP_SHA256, bytes.length);
    if (hdr[8] !== STATUS_OK || hdr[7] !== 32) {
      throw new Error("WASM sha256 failed");
    }
    return this._outU8.slice(0, 32);
  }

  /**
   * Binary fast-path for `wire_message`: streams raw UTF-8 frame bytes directly into WASM
   * without outer JSON.stringify escaping or double JSON parsing (eliminates stalls on large GIFs/videos).
   */
  wireMessage(fromPeer, frameStr, nowMs = Date.now()) {
    const pidStr = String(fromPeer || "");
    const pidBytes = this._encodePeerIdCached(pidStr);
    if (pidBytes.length > 65535) {
      return this.call({ cmd: "wire_message", fromPeer, frame: frameStr, nowMs });
    }
    const frameBytes = textEncoder.encode(String(frameStr || ""));
    const headerLen = 2 + pidBytes.length + 8;
    const totalLen = headerLen + frameBytes.length;

    const tsVal = Math.max(0, Math.floor(Number(nowMs) || 0));
    const tsLo = tsVal >>> 0;
    const tsHi = Math.floor(tsVal / 0x100000000) >>> 0;

    let hdr;
    if (totalLen <= this.bufCap) {
      this._ensureViews();
      const inBuf = this._inU8;
      inBuf[0] = pidBytes.length & 0xff;
      inBuf[1] = (pidBytes.length >> 8) & 0xff;
      inBuf.set(pidBytes, 2);
      const tOff = 2 + pidBytes.length;
      inBuf[tOff] = tsLo & 0xff;
      inBuf[tOff + 1] = (tsLo >>> 8) & 0xff;
      inBuf[tOff + 2] = (tsLo >>> 16) & 0xff;
      inBuf[tOff + 3] = (tsLo >>> 24) & 0xff;
      inBuf[tOff + 4] = tsHi & 0xff;
      inBuf[tOff + 5] = (tsHi >>> 8) & 0xff;
      inBuf[tOff + 6] = (tsHi >>> 16) & 0xff;
      inBuf[tOff + 7] = (tsHi >>> 24) & 0xff;
      inBuf.set(frameBytes, headerLen);
      hdr = this._invoke(OP_WIRE_MESSAGE, totalLen);
    } else {
      this._ensureViews();
      const inBuf = this._inU8;
      inBuf[0] = pidBytes.length & 0xff;
      inBuf[1] = (pidBytes.length >> 8) & 0xff;
      inBuf.set(pidBytes, 2);
      const tOff = 2 + pidBytes.length;
      inBuf[tOff] = tsLo & 0xff;
      inBuf[tOff + 1] = (tsLo >>> 8) & 0xff;
      inBuf[tOff + 2] = (tsLo >>> 16) & 0xff;
      inBuf[tOff + 3] = (tsLo >>> 24) & 0xff;
      inBuf[tOff + 4] = tsHi & 0xff;
      inBuf[tOff + 5] = (tsHi >>> 8) & 0xff;
      inBuf[tOff + 6] = (tsHi >>> 16) & 0xff;
      inBuf[tOff + 7] = (tsHi >>> 24) & 0xff;
      hdr = this._invoke(OP_STREAM_APPEND, headerLen);
      if (hdr[8] !== STATUS_OK) {
        throw new Error("WASM bridge wire header stream append failed");
      }
      let offset = 0;
      while (offset < frameBytes.length) {
        const end = Math.min(offset + this.bufCap, frameBytes.length);
        const slice = frameBytes.subarray(offset, end);
        this._ensureViews();
        this._inU8.set(slice, 0);
        hdr = this._invoke(OP_STREAM_APPEND, slice.length);
        if (hdr[8] !== STATUS_OK) {
          throw new Error("WASM bridge wire frame stream append failed");
        }
        offset = end;
      }
      hdr = this._invoke(OP_STREAM_EXEC_WIRE, 0);
    }
    return this._readJsonResponse(hdr);
  }

  /**
   * Pure binary fast-path: encodes 16 kHz mono Int16Array PCM with IMA ADPCM and seals
   * per-peer V1 ChaCha20-Poly1305 packets for every peer currently in voice chat.
   */
  sealVoicePcm(int16Array) {
    if (!int16Array || int16Array.length === 0) {
      return { rms: 0, packets: [] };
    }
    const rawView = new Uint8Array(
      int16Array.buffer,
      int16Array.byteOffset,
      int16Array.byteLength
    );
    const byteLen = Math.min(rawView.byteLength, this.bufCap);
    this._ensureViews();
    this._inU8.set(byteLen === rawView.byteLength ? rawView : rawView.subarray(0, byteLen), 0);

    const hdr = this._invoke(OP_VOICE_ENCODE_SEAL, byteLen);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen < 4) {
      return { rms: 0, packets: [] };
    }

    const outBytes = this._outU8;
    const rms = outBytes[0] | (outBytes[1] << 8);
    const peerCount = outBytes[2] | (outBytes[3] << 8);
    const packets = [];
    let offset = 4;

    for (let i = 0; i < peerCount; i++) {
      if (offset + 2 > outLen) break;
      const pidLen = outBytes[offset] | (outBytes[offset + 1] << 8);
      offset += 2;
      if (offset + pidLen + 2 > outLen) break;
      const peerId = this._decodePeerIdCached(outBytes, offset, pidLen);
      offset += pidLen;
      const pktLen = outBytes[offset] | (outBytes[offset + 1] << 8);
      offset += 2;
      if (offset + pktLen > outLen) break;
      const data = outBytes.slice(offset, offset + pktLen);
      offset += pktLen;
      packets.push({ peerId, data });
    }
    return { rms, packets };
  }

  /**
   * Pure binary fast-path: authenticates, anti-replay checks, decrypts, and IMA-ADPCM-decodes
   * an incoming V1 binary voice packet from `peerId`.
   */
  openVoicePacket(peerId, packetUint8) {
    if (!peerId || !packetUint8 || packetUint8.byteLength === 0) {
      return null;
    }
    const pidBytes = this._encodePeerIdCached(peerId);
    const totalIn = 2 + pidBytes.length + packetUint8.byteLength;
    if (totalIn > this.bufCap || pidBytes.length > 65535) {
      return null;
    }
    this._ensureViews();
    const inBuf = this._inU8;
    inBuf[0] = pidBytes.length & 0xff;
    inBuf[1] = (pidBytes.length >> 8) & 0xff;
    inBuf.set(pidBytes, 2);
    inBuf.set(packetUint8, 2 + pidBytes.length);

    const hdr = this._invoke(OP_VOICE_OPEN_DECODE, totalIn);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen < 4) {
      return null;
    }

    const outBytes = this._outU8;
    const rms = outBytes[0] | (outBytes[1] << 8);
    const sampleCount = outBytes[2] | (outBytes[3] << 8);
    const byteCount = sampleCount * 2;
    if (sampleCount === 0 || 4 + byteCount > outLen) {
      return { rms, pcm: new Int16Array(0) };
    }
    const pcmBytes = outBytes.slice(4, 4 + byteCount);
    return { rms, pcm: new Int16Array(pcmBytes.buffer) };
  }

  /**
   * Pure binary fast-path: seals an opaque high-definition codec payload (e.g. 48 kHz Opus)
   * into per-peer V2 ChaCha20-Poly1305 packets for every peer currently in voice chat.
   */
  sealVoiceRaw(rawPayloadUint8) {
    if (!rawPayloadUint8 || rawPayloadUint8.byteLength === 0) {
      return [];
    }
    const byteLen = Math.min(rawPayloadUint8.byteLength, this.bufCap);
    this._ensureViews();
    this._inU8.set(
      byteLen === rawPayloadUint8.byteLength ? rawPayloadUint8 : rawPayloadUint8.subarray(0, byteLen),
      0
    );

    const hdr = this._invoke(OP_VOICE_SEAL_RAW, byteLen);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen < 2) {
      return [];
    }

    const outBytes = this._outU8;
    const peerCount = outBytes[0] | (outBytes[1] << 8);
    const packets = [];
    let offset = 2;

    for (let i = 0; i < peerCount; i++) {
      if (offset + 2 > outLen) break;
      const pidLen = outBytes[offset] | (outBytes[offset + 1] << 8);
      offset += 2;
      if (offset + pidLen + 2 > outLen) break;
      const peerId = this._decodePeerIdCached(outBytes, offset, pidLen);
      offset += pidLen;
      const pktLen = outBytes[offset] | (outBytes[offset + 1] << 8);
      offset += 2;
      if (offset + pktLen > outLen) break;
      const data = outBytes.slice(offset, offset + pktLen);
      offset += pktLen;
      packets.push({ peerId, data });
    }
    return packets;
  }

  /**
   * Pure binary fast-path: authenticates, anti-replay checks, and decrypts an incoming V2
   * binary voice packet from `peerId`, returning the raw codec payload Uint8Array or null.
   */
  openVoiceRaw(peerId, packetUint8) {
    if (!peerId || !packetUint8 || packetUint8.byteLength === 0) {
      return null;
    }
    const pidBytes = this._encodePeerIdCached(peerId);
    const totalIn = 2 + pidBytes.length + packetUint8.byteLength;
    if (totalIn > this.bufCap || pidBytes.length > 65535) {
      return null;
    }
    this._ensureViews();
    const inBuf = this._inU8;
    inBuf[0] = pidBytes.length & 0xff;
    inBuf[1] = (pidBytes.length >> 8) & 0xff;
    inBuf.set(pidBytes, 2);
    inBuf.set(packetUint8, 2 + pidBytes.length);

    const hdr = this._invoke(OP_VOICE_OPEN_RAW, totalIn);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen === 0) {
      return null;
    }
    return this._outU8.slice(0, outLen);
  }

  /**
   * Pure binary fast-path: executes the entire 48 kHz microphone capture DSP chain inside
   * safe Rust WASM (DC blocker, RMS meter, hysteresis envelope noise gate with cosine
   * fade-in/out, soft-knee peak safety limiter, and optional 15-tap anti-aliasing FIR +
   * V1 ADPCM E2EE sealing for legacy/bot peers).
   */
  processCapture48k(float32Frame, { gatePct = 0, needV1 = false, returnProcessed48k = true } = {}) {
    if (!float32Frame || float32Frame.length === 0) {
      return { rawRms: 0, activeRms: 0, gated: true, isFadeOutTail: false, processed48k: null, v1Packets: [] };
    }
    const rawView = new Uint8Array(
      float32Frame.buffer,
      float32Frame.byteOffset,
      float32Frame.byteLength
    );
    const maxSampleBytes = Math.max(0, this.bufCap - 4);
    const sampleByteLen = Math.min(rawView.byteLength, maxSampleBytes) & ~3;
    const totalIn = 4 + sampleByteLen;
    this._ensureViews();
    const inBuf = this._inU8;
    inBuf[0] = Math.max(0, Math.min(100, Math.round(gatePct)));
    inBuf[1] = (needV1 ? 1 : 0) | (returnProcessed48k ? 2 : 0);
    inBuf[2] = 0;
    inBuf[3] = 0;
    inBuf.set(sampleByteLen === rawView.byteLength ? rawView : rawView.subarray(0, sampleByteLen), 4);

    const hdr = this._invoke(OP_VOICE_PROCESS_CAPTURE_48K, totalIn);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen < 12) {
      return { rawRms: 0, activeRms: 0, gated: true, isFadeOutTail: false, processed48k: null, v1Packets: [] };
    }

    const outBytes = this._outU8;
    const rawRms = outBytes[0] | (outBytes[1] << 8);
    const activeRms = outBytes[2] | (outBytes[3] << 8);
    const outFlags = outBytes[4];
    const gated = (outFlags & 1) !== 0;
    const isFadeOutTail = (outFlags & 2) !== 0;
    const sampleCount = outBytes[6] | (outBytes[7] << 8);
    const v1PeerCount = outBytes[8] | (outBytes[9] << 8);

    let offset = 12;
    let processed48k = null;
    const processedBytesLen = sampleCount * 4;
    if (sampleCount > 0 && offset + processedBytesLen <= outLen) {
      const copyBytes = outBytes.slice(offset, offset + processedBytesLen);
      processed48k = new Float32Array(copyBytes.buffer);
      offset += processedBytesLen;
    }

    const v1Packets = [];
    for (let i = 0; i < v1PeerCount; i++) {
      if (offset + 2 > outLen) break;
      const pidLen = outBytes[offset] | (outBytes[offset + 1] << 8);
      offset += 2;
      if (offset + pidLen + 2 > outLen) break;
      const peerId = this._decodePeerIdCached(outBytes, offset, pidLen);
      offset += pidLen;
      const pktLen = outBytes[offset] | (outBytes[offset + 1] << 8);
      offset += 2;
      if (offset + pktLen > outLen) break;
      const data = outBytes.slice(offset, offset + pktLen);
      offset += pktLen;
      v1Packets.push({ peerId, data });
    }

    return { rawRms, activeRms, gated, isFadeOutTail, processed48k, v1Packets };
  }

  hasBulkWorker() {
    return (
      !this._bulkWorkerFailed &&
      Boolean(this.wasmModule) &&
      typeof Worker === "function" &&
      typeof Blob === "function" &&
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function"
    );
  }

  _prewarmBulkWorker() {
    if (!this.hasBulkWorker() || this._bulkWorkerReady) return;
    this._ensureBulkWorker().catch(() => {
      this._bulkWorkerFailed = true;
    });
  }

  _ensureBulkWorker() {
    if (this._bulkWorkerReady) return this._bulkWorkerReady;
    if (!this.hasBulkWorker()) {
      return Promise.reject(new Error("Bulk crypto worker unavailable"));
    }
    this._bulkWorkerReady = new Promise((resolve, reject) => {
      try {
        const blob = new Blob([BULK_CRYPTO_WORKER_SCRIPT], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);
        URL.revokeObjectURL(url);
        this._bulkWorker = worker;

        let settled = false;
        worker.onmessage = (ev) => {
          const msg = ev.data;
          if (!msg) return;
          if (msg.type === "ready") {
            if (!settled) {
              settled = true;
              resolve(worker);
            }
            return;
          }
          if (msg.type === "init_error") {
            this._bulkWorkerFailed = true;
            if (!settled) {
              settled = true;
              reject(new Error(msg.error || "Bulk crypto worker init failed"));
            }
            return;
          }
          const job = this._bulkJobs.get(msg.jobId);
          if (job) {
            this._bulkJobs.delete(msg.jobId);
            if (msg.ok) {
              job.resolve(msg);
            } else {
              job.reject(new Error(msg.error || "Bulk crypto worker job failed"));
            }
          }
        };
        worker.onerror = (err) => {
          this._bulkWorkerFailed = true;
          const e = new Error(err?.message || "Bulk crypto worker runtime error");
          if (!settled) {
            settled = true;
            reject(e);
          }
          for (const [, job] of this._bulkJobs.entries()) {
            job.reject(e);
          }
          this._bulkJobs.clear();
        };
        worker.postMessage({ type: "init", module: this.wasmModule });
      } catch (err) {
        this._bulkWorkerFailed = true;
        reject(err);
      }
    });
    return this._bulkWorkerReady;
  }

  async _runBulkWorkerJob(payload, transferables = []) {
    const worker = await this._ensureBulkWorker();
    const jobId = (this._bulkJobSeq = (this._bulkJobSeq + 1) >>> 0) || 1;
    return new Promise((resolve, reject) => {
      this._bulkJobs.set(jobId, { resolve, reject });
      try {
        worker.postMessage({ ...payload, jobId }, transferables);
      } catch (err) {
        this._bulkJobs.delete(jobId);
        reject(err);
      }
    });
  }

  /**
   * Runs multi-MB GIF/video ChaCha20-Poly1305 sealing on a dedicated Web Worker thread
   * so real-time 48 kHz voice on the main thread experiences zero stalls.
   */
  async sealBulkAsync(headerObj, fullMessage) {
    const res = await this._runBulkWorkerJob({
      type: "seal_bulk",
      header: headerObj,
      fullMessage,
    });
    return {
      wireFrames: res.wireFrames || [],
      sealedCt: res.sealedCt instanceof Uint8Array ? res.sealedCt : new Uint8Array(res.sealedCt),
    };
  }

  /**
   * Runs multi-MB encrypted wire frame ChaCha20-Poly1305 opening on a dedicated Web Worker thread.
   */
  async openBulkAsync(headerObj, frameStr) {
    const res = await this._runBulkWorkerJob({
      type: "open_bulk",
      header: headerObj,
      frameStr,
    });
    if (res.kind !== "msg") {
      return { kind: "fallback" };
    }
    return {
      kind: "msg",
      metaResp: res.metaResp,
      msgJsonStr: res.msgJsonStr,
      sealedCt: res.sealedCt instanceof Uint8Array ? res.sealedCt : new Uint8Array(res.sealedCt),
    };
  }

  /**
   * Seals multi-hop bulk gossip forwards off the main thread for 3+ peer rooms.
   */
  async sealForwardAsync(headerObj, sealedCtBytes) {
    const copy = new Uint8Array(sealedCtBytes);
    const res = await this._runBulkWorkerJob(
      {
        type: "seal_forward",
        header: headerObj,
        sealedCt: copy,
      },
      [copy.buffer]
    );
    return res.wireFrames || [];
  }

  _execFramedJson(directOp, streamOp, headerObj, tailUint8) {
    const hdrBytes = textEncoder.encode(JSON.stringify(headerObj));
    const tail = tailUint8 instanceof Uint8Array ? tailUint8 : new Uint8Array(tailUint8 || 0);
    const prefixLen = 4 + hdrBytes.length;
    const totalLen = prefixLen + tail.length;

    let hdr;
    if (totalLen <= this.bufCap) {
      this._ensureViews();
      const inBuf = this._inU8;
      inBuf[0] = hdrBytes.length & 0xff;
      inBuf[1] = (hdrBytes.length >>> 8) & 0xff;
      inBuf[2] = (hdrBytes.length >>> 16) & 0xff;
      inBuf[3] = (hdrBytes.length >>> 24) & 0xff;
      inBuf.set(hdrBytes, 4);
      inBuf.set(tail, prefixLen);
      hdr = this._invoke(directOp, totalLen);
    } else {
      this._ensureViews();
      const inBuf = this._inU8;
      inBuf[0] = hdrBytes.length & 0xff;
      inBuf[1] = (hdrBytes.length >>> 8) & 0xff;
      inBuf[2] = (hdrBytes.length >>> 16) & 0xff;
      inBuf[3] = (hdrBytes.length >>> 24) & 0xff;
      inBuf.set(hdrBytes, 4);
      hdr = this._invoke(OP_STREAM_APPEND, prefixLen);
      if (hdr[8] !== STATUS_OK) {
        throw new Error("WASM bridge framed header append failed");
      }
      let offset = 0;
      while (offset < tail.length) {
        const end = Math.min(offset + this.bufCap, tail.length);
        const slice = tail.subarray(offset, end);
        this._ensureViews();
        this._inU8.set(slice, 0);
        hdr = this._invoke(OP_STREAM_APPEND, slice.length);
        if (hdr[8] !== STATUS_OK) {
          throw new Error("WASM bridge framed tail append failed");
        }
        offset = end;
      }
      hdr = this._invoke(streamOp, 0);
    }
    return this._readJsonResponse(hdr);
  }

  /**
   * Commits a worker-sealed bulk publish record into MeshNode (< 1 ms, zero crypto/JSON payload copy).
   */
  commitBulkPublish(headerObj, sealedCtBytes) {
    return this._execFramedJson(
      OP_COMMIT_BULK_PUBLISH,
      OP_STREAM_EXEC_COMMIT_PUBLISH,
      headerObj,
      sealedCtBytes
    );
  }

  /**
   * Commits a worker-opened bulk RX record into MeshNode (< 1 ms, zero crypto/JSON payload copy).
   */
  commitBulkRx(headerObj, sealedCtBytes) {
    return this._execFramedJson(
      OP_COMMIT_BULK_RX,
      OP_STREAM_EXEC_COMMIT_RX,
      headerObj,
      sealedCtBytes
    );
  }

  rehandshake() {
    this._invoke(OP_HANDSHAKE, 0);
  }
}

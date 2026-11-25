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

const STATUS_OK = 1;
const EXPECTED_BUF_CAP = 262144;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class SafeRustWasmMesh {
  constructor(instance, headerByteOffset, inPtr, outPtr, bufCap) {
    this.instance = instance;
    this.memory = instance.exports.memory;
    this.mainFn = instance.exports.main;
    this.headerByteOffset = headerByteOffset;
    this.inPtr = inPtr;
    this.outPtr = outPtr;
    this.bufCap = bufCap;
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
    return SafeRustWasmMesh.fromInstance(result.instance);
  }

  static async loadFromBytes(bytes) {
    const result = await WebAssembly.instantiate(bytes, {});
    return SafeRustWasmMesh.fromInstance(result.instance);
  }

  static fromInstance(instance) {
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
    return new SafeRustWasmMesh(instance, headerIdx * 4, inPtr, outPtr, bufCap);
  }

  _headerView() {
    return new Uint32Array(this.memory.buffer, this.headerByteOffset, 12);
  }

  _invoke(op, argLen) {
    const hdr = this._headerView();
    hdr[4] = op;
    hdr[5] = argLen;
    hdr[8] = 0;
    this.mainFn();
    return this._headerView();
  }

  call(requestObj) {
    const payloadStr = JSON.stringify(requestObj);
    const bytes = textEncoder.encode(payloadStr);
    let hdr;

    if (bytes.length <= this.bufCap) {
      new Uint8Array(this.memory.buffer, this.inPtr, bytes.length).set(bytes);
      hdr = this._invoke(OP_CALL, bytes.length);
    } else {
      let offset = 0;
      while (offset < bytes.length) {
        const end = Math.min(offset + this.bufCap, bytes.length);
        const slice = bytes.subarray(offset, end);
        new Uint8Array(this.memory.buffer, this.inPtr, slice.length).set(slice);
        hdr = this._invoke(OP_STREAM_APPEND, slice.length);
        if (hdr[8] !== STATUS_OK) {
          throw new Error("WASM bridge stream append failed");
        }
        offset = end;
      }
      hdr = this._invoke(OP_STREAM_EXEC, 0);
    }

    const totalOutLen = hdr[6];
    const firstChunkLen = hdr[7];
    let outBytes;

    if (totalOutLen <= firstChunkLen) {
      outBytes = new Uint8Array(this.memory.buffer, this.outPtr, totalOutLen).slice();
    } else {
      outBytes = new Uint8Array(totalOutLen);
      outBytes.set(new Uint8Array(this.memory.buffer, this.outPtr, firstChunkLen), 0);
      let readOffset = firstChunkLen;
      while (readOffset < totalOutLen) {
        hdr = this._invoke(OP_READ_OUT_CHUNK, readOffset);
        const got = hdr[7];
        if (got === 0) {
          break;
        }
        const remaining = Math.min(got, totalOutLen - readOffset);
        outBytes.set(new Uint8Array(this.memory.buffer, this.outPtr, remaining), readOffset);
        readOffset += remaining;
      }
    }

    const respText = textDecoder.decode(outBytes);
    const parsed = JSON.parse(respText);
    if (!parsed.ok) {
      throw new Error(parsed.error || "Unknown WASM RPC error");
    }
    return parsed;
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
    new Uint8Array(this.memory.buffer, this.inPtr, byteLen).set(rawView.subarray(0, byteLen));

    const hdr = this._invoke(OP_VOICE_ENCODE_SEAL, byteLen);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen < 4) {
      return { rms: 0, packets: [] };
    }

    const dv = new DataView(this.memory.buffer, this.outPtr, outLen);
    const outBytes = new Uint8Array(this.memory.buffer, this.outPtr, outLen);
    const rms = dv.getUint16(0, true);
    const peerCount = dv.getUint16(2, true);
    const packets = [];
    let offset = 4;

    for (let i = 0; i < peerCount; i++) {
      if (offset + 2 > outLen) break;
      const pidLen = dv.getUint16(offset, true);
      offset += 2;
      if (offset + pidLen + 2 > outLen) break;
      const peerId = textDecoder.decode(outBytes.subarray(offset, offset + pidLen));
      offset += pidLen;
      const pktLen = dv.getUint16(offset, true);
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
    const pidBytes = textEncoder.encode(peerId);
    const totalIn = 2 + pidBytes.length + packetUint8.byteLength;
    if (totalIn > this.bufCap || pidBytes.length > 65535) {
      return null;
    }
    const inBuf = new Uint8Array(this.memory.buffer, this.inPtr, totalIn);
    inBuf[0] = pidBytes.length & 0xff;
    inBuf[1] = (pidBytes.length >> 8) & 0xff;
    inBuf.set(pidBytes, 2);
    inBuf.set(packetUint8, 2 + pidBytes.length);

    const hdr = this._invoke(OP_VOICE_OPEN_DECODE, totalIn);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen < 4) {
      return null;
    }

    const dv = new DataView(this.memory.buffer, this.outPtr, outLen);
    const rms = dv.getUint16(0, true);
    const sampleCount = dv.getUint16(2, true);
    const byteCount = sampleCount * 2;
    if (sampleCount === 0 || 4 + byteCount > outLen) {
      return { rms, pcm: new Int16Array(0) };
    }
    const pcmBytes = new Uint8Array(this.memory.buffer, this.outPtr + 4, byteCount).slice();
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
    new Uint8Array(this.memory.buffer, this.inPtr, byteLen).set(
      rawPayloadUint8.subarray(0, byteLen)
    );

    const hdr = this._invoke(OP_VOICE_SEAL_RAW, byteLen);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen < 2) {
      return [];
    }

    const dv = new DataView(this.memory.buffer, this.outPtr, outLen);
    const outBytes = new Uint8Array(this.memory.buffer, this.outPtr, outLen);
    const peerCount = dv.getUint16(0, true);
    const packets = [];
    let offset = 2;

    for (let i = 0; i < peerCount; i++) {
      if (offset + 2 > outLen) break;
      const pidLen = dv.getUint16(offset, true);
      offset += 2;
      if (offset + pidLen + 2 > outLen) break;
      const peerId = textDecoder.decode(outBytes.subarray(offset, offset + pidLen));
      offset += pidLen;
      const pktLen = dv.getUint16(offset, true);
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
    const pidBytes = textEncoder.encode(peerId);
    const totalIn = 2 + pidBytes.length + packetUint8.byteLength;
    if (totalIn > this.bufCap || pidBytes.length > 65535) {
      return null;
    }
    const inBuf = new Uint8Array(this.memory.buffer, this.inPtr, totalIn);
    inBuf[0] = pidBytes.length & 0xff;
    inBuf[1] = (pidBytes.length >> 8) & 0xff;
    inBuf.set(pidBytes, 2);
    inBuf.set(packetUint8, 2 + pidBytes.length);

    const hdr = this._invoke(OP_VOICE_OPEN_RAW, totalIn);
    const outLen = hdr[7];
    if (hdr[8] !== STATUS_OK || outLen === 0) {
      return null;
    }
    return new Uint8Array(this.memory.buffer, this.outPtr, outLen).slice();
  }

  rehandshake() {
    this._invoke(OP_HANDSHAKE, 0);
  }
}

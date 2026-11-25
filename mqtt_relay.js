/**
 * Zero-dependency MQTT 3.1.1 over WebSocket client for serverless E2EE room rendezvous.
 *
 * Only opaque HKDF-derived 32-hex topics (`p2pdirect/v1/<topic>`) and
 * ChaCha20-Poly1305 AEAD-sealed `R1:` signaling payloads ever touch these stateless relays.
 * All chat messages, images, replicated logs, and voice audio flow strictly peer-to-peer
 * over direct WebRTC DataChannels.
 */

export const DEFAULT_MQTT_RELAYS = [
  "wss://mqtt.eclipseprojects.io:443/mqtt",
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
  "wss://test.mosquitto.org:8081",
];

const TOPIC_PREFIX = "p2pdirect/v1/";
const KEEPALIVE_SECONDS = 30;
const PING_INTERVAL_MS = 15_000;
const MAX_OUTBOUND_QUEUE = 32;
const MAX_SEEN_CACHE = 600;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function nowPerf() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function randomClientId() {
  const bytes = new Uint8Array(7);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `p2pd${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function isValidRelayUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "wss:" || parsed.protocol === "ws:";
  } catch {
    return false;
  }
}

export function resolveRelayUrls(customRelay) {
  const list = [];
  const addUrl = (raw) => {
    if (!raw || typeof raw !== "string") return;
    const cleaned = raw.trim();
    if (isValidRelayUrl(cleaned) && !list.includes(cleaned)) {
      list.push(cleaned);
    }
  };
  const addCsv = (raw) => {
    if (!raw || typeof raw !== "string") return;
    for (const part of raw.split(",")) {
      addUrl(part);
    }
  };

  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    addCsv(params.get("relay"));
    if (list.length === 0 && Array.isArray(window.__P2P_MQTT_BROKERS__)) {
      for (const item of window.__P2P_MQTT_BROKERS__) {
        addUrl(typeof item === "string" ? item : item?.url);
      }
    }
  }
  addCsv(customRelay);

  if (list.length > 0) {
    return list;
  }
  return DEFAULT_MQTT_RELAYS.slice();
}

function encodeRemainingLength(len) {
  const out = [];
  let x = len;
  do {
    let digit = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) {
      digit |= 0x80;
    }
    out.push(digit);
  } while (x > 0);
  return out;
}

function encodeMqttString(str) {
  const bytes = textEncoder.encode(str);
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

function buildPacket(headerByte, bodyChunks) {
  let bodyLen = 0;
  for (const chunk of bodyChunks) {
    bodyLen += chunk.length;
  }
  const remLen = encodeRemainingLength(bodyLen);
  const packet = new Uint8Array(1 + remLen.length + bodyLen);
  packet[0] = headerByte;
  for (let i = 0; i < remLen.length; i++) {
    packet[1 + i] = remLen[i];
  }
  let offset = 1 + remLen.length;
  for (const chunk of bodyChunks) {
    packet.set(chunk, offset);
    offset += chunk.length;
  }
  return packet;
}

function buildConnectPacket(clientId) {
  // Variable header: Protocol Name ("MQTT"), Level (4), Flags (CleanSession=0x02), KeepAlive (30s)
  const varHeader = new Uint8Array([
    0x00,
    0x04,
    0x4d,
    0x51,
    0x54,
    0x54,
    0x04,
    0x02,
    (KEEPALIVE_SECONDS >> 8) & 0xff,
    KEEPALIVE_SECONDS & 0xff,
  ]);
  const payload = encodeMqttString(clientId);
  return buildPacket(0x10, [varHeader, payload]);
}

function buildSubscribePacket(packetId, topic) {
  const varHeader = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  const topicBytes = encodeMqttString(topic);
  const qos = new Uint8Array([0x00]);
  return buildPacket(0x82, [varHeader, topicBytes, qos]);
}

function buildPublishPacket(topic, payload) {
  const topicBytes = encodeMqttString(topic);
  let payloadBytes;
  if (payload instanceof Uint8Array) {
    payloadBytes = payload;
  } else if (ArrayBuffer.isView(payload)) {
    payloadBytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  } else {
    payloadBytes = textEncoder.encode(String(payload));
  }
  return buildPacket(0x30, [topicBytes, payloadBytes]);
}

function isBinaryFallbackFrame(bytes) {
  if (!bytes || bytes.length < 2) return false;
  // "DF" (0x44 0x46) = E2EE fallback data frame/chunk, "VB" (0x56 0x42) = E2EE fallback voice bundle
  return (
    (bytes[0] === 0x44 && bytes[1] === 0x46) ||
    (bytes[0] === 0x56 && bytes[1] === 0x42)
  );
}

const PINGREQ_PACKET = new Uint8Array([0xc0, 0x00]);
const DISCONNECT_PACKET = new Uint8Array([0xe0, 0x00]);

class MqttWsClient {
  constructor({ url, topic, onMessage, onBinaryMessage, onReady, onStateChange }) {
    this.url = url;
    this.topic = topic;
    this.onMessage = onMessage;
    this.onBinaryMessage = onBinaryMessage || null;
    this.onReady = onReady;
    this.onStateChange = onStateChange;

    this.ws = null;
    this.stopped = false;
    this.ready = false;
    this.rxBuf = new Uint8Array(0);
    this.outboundQueue = [];
    this.pingTimer = null;
    this.earlyPingTimer = null;
    this.reconnectTimer = null;
    this.connectTimeoutTimer = null;
    this.backoffMs = 1500;
    this.packetId = 1;
    this.rttMs = null;
    this.subSentAt = 0;
    this.pingSentAt = 0;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this.ready = false;
    this.rttMs = null;
    this.subSentAt = 0;
    this.pingSentAt = 0;
    this._clearTimers();
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try {
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(DISCONNECT_PACKET);
        }
        sock.close();
      } catch {
        // ignore close errors
      }
    }
    this.rxBuf = new Uint8Array(0);
    this.outboundQueue = [];
  }

  publish(payloadText) {
    if (this.stopped) return false;
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(buildPublishPacket(this.topic, payloadText));
        return true;
      } catch {
        return false;
      }
    }
    this.outboundQueue.push(payloadText);
    if (this.outboundQueue.length > MAX_OUTBOUND_QUEUE) {
      this.outboundQueue.shift();
    }
    return false;
  }

  publishBinary(payloadBytes, queueIfOffline = false) {
    if (this.stopped || !payloadBytes) return false;
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) {
      if ((this.ws.bufferedAmount || 0) > 131072) {
        return false;
      }
      try {
        this.ws.send(buildPublishPacket(this.topic, payloadBytes));
        return true;
      } catch {
        return false;
      }
    }
    if (queueIfOffline) {
      this.outboundQueue.push(payloadBytes);
      if (this.outboundQueue.length > MAX_OUTBOUND_QUEUE) {
        this.outboundQueue.shift();
      }
    }
    return false;
  }

  _clearTimers() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.earlyPingTimer) {
      clearTimeout(this.earlyPingTimer);
      this.earlyPingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  _sendPing() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.pingSentAt = nowPerf();
        this.ws.send(PINGREQ_PACKET);
      } catch {
        this.pingSentAt = 0;
      }
    }
  }

  _connect() {
    if (this.stopped) return;
    this._clearTimers();
    this.ready = false;
    this.rttMs = null;
    this.subSentAt = 0;
    this.pingSentAt = 0;
    this.rxBuf = new Uint8Array(0);

    let ws;
    try {
      ws = new WebSocket(this.url, "mqtt");
      ws.binaryType = "arraybuffer";
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    this.connectTimeoutTimer = setTimeout(() => {
      if (this.ws === ws && !this.ready) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }, 8000);

    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) return;
      try {
        ws.send(buildConnectPacket(randomClientId()));
      } catch {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };

    ws.onmessage = (ev) => {
      if (this.stopped || this.ws !== ws) return;
      if (ev.data instanceof ArrayBuffer) {
        this._appendBytes(new Uint8Array(ev.data));
      } else if (ArrayBuffer.isView(ev.data)) {
        this._appendBytes(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength));
      } else if (typeof Blob !== "undefined" && ev.data instanceof Blob) {
        ev.data
          .arrayBuffer()
          .then((ab) => {
            if (!this.stopped && this.ws === ws) {
              this._appendBytes(new Uint8Array(ab));
            }
          })
          .catch(() => {});
      }
    };

    ws.onerror = () => {
      // Close event handles cleanup & reconnect
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasReady = this.ready;
      this.ready = false;
      this.rttMs = null;
      this.subSentAt = 0;
      this.pingSentAt = 0;
      this._clearTimers();
      if (wasReady && this.onStateChange) {
        this.onStateChange();
      }
      if (!this.stopped) {
        this._scheduleReconnect();
      }
    };
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs + Math.floor(Math.random() * 500);
    this.backoffMs = Math.min(20_000, Math.round(this.backoffMs * 1.7));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _appendBytes(chunk) {
    if (chunk.length === 0) return;
    if (this.rxBuf.length === 0) {
      this.rxBuf = chunk;
    } else {
      const merged = new Uint8Array(this.rxBuf.length + chunk.length);
      merged.set(this.rxBuf, 0);
      merged.set(chunk, this.rxBuf.length);
      this.rxBuf = merged;
    }
    this._drainPackets();
  }

  _drainPackets() {
    let offset = 0;
    while (offset + 2 <= this.rxBuf.length) {
      const header = this.rxBuf[offset];
      let multiplier = 1;
      let remLen = 0;
      let pos = offset + 1;
      let lenComplete = false;

      for (let i = 0; i < 4; i++) {
        if (pos >= this.rxBuf.length) {
          break;
        }
        const byte = this.rxBuf[pos++];
        remLen += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0) {
          lenComplete = true;
          break;
        }
        multiplier *= 128;
      }

      if (!lenComplete) {
        break;
      }
      const packetEnd = pos + remLen;
      if (packetEnd > this.rxBuf.length) {
        break;
      }

      this._handlePacket(header, this.rxBuf.subarray(pos, packetEnd));
      offset = packetEnd;
    }

    if (offset > 0) {
      this.rxBuf = offset >= this.rxBuf.length ? new Uint8Array(0) : this.rxBuf.slice(offset);
    }
  }

  _handlePacket(header, body) {
    const packetType = (header >> 4) & 0x0f;

    if (packetType === 2) {
      // CONNACK
      if (body.length >= 2 && body[1] === 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.connectTimeoutTimer) {
          clearTimeout(this.connectTimeoutTimer);
          this.connectTimeoutTimer = null;
        }
        const pid = this.packetId;
        this.packetId = (this.packetId % 65534) + 1;
        try {
          this.subSentAt = nowPerf();
          this.ws.send(buildSubscribePacket(pid, this.topic));
        } catch {
          this.subSentAt = 0;
        }
        this.pingTimer = setInterval(() => this._sendPing(), PING_INTERVAL_MS);
      } else if (this.ws) {
        try {
          this.ws.close();
        } catch {
          // ignore
        }
      }
      return;
    }

    if (packetType === 9) {
      // SUBACK
      if (this.subSentAt > 0) {
        this.rttMs = Math.max(1, Math.round(nowPerf() - this.subSentAt));
        this.subSentAt = 0;
      }
      this.ready = true;
      this.backoffMs = 1500;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        while (this.outboundQueue.length > 0) {
          const msg = this.outboundQueue.shift();
          try {
            this.ws.send(buildPublishPacket(this.topic, msg));
          } catch {
            break;
          }
        }
      }
      if (!this.earlyPingTimer) {
        this.earlyPingTimer = setTimeout(() => {
          this.earlyPingTimer = null;
          if (!this.stopped && this.ready) {
            this._sendPing();
          }
        }, 3000);
      }
      if (this.onStateChange) {
        this.onStateChange();
      }
      if (this.onReady) {
        this.onReady(this);
      }
      return;
    }

    if (packetType === 13) {
      // PINGRESP
      if (this.pingSentAt > 0) {
        const sample = Math.max(1, Math.round(nowPerf() - this.pingSentAt));
        this.pingSentAt = 0;
        this.rttMs = this.rttMs === null ? sample : Math.round(this.rttMs * 0.65 + sample * 0.35);
      }
      return;
    }

    if (packetType === 3) {
      // PUBLISH
      if (body.length < 2) return;
      const topicLen = (body[0] << 8) | body[1];
      let pos = 2 + topicLen;
      if (pos > body.length) return;
      const msgTopic = textDecoder.decode(body.subarray(2, pos));
      const qos = (header >> 1) & 0x03;
      if (qos > 0) {
        pos += 2;
      }
      if (pos > body.length || msgTopic !== this.topic) return;
      const payloadBytes = body.subarray(pos);
      if (payloadBytes.length === 0) return;
      if (isBinaryFallbackFrame(payloadBytes)) {
        if (this.onBinaryMessage) {
          this.onBinaryMessage(payloadBytes.slice(), this.url);
        }
        return;
      }
      const payloadText = textDecoder.decode(payloadBytes);
      if (payloadText && this.onMessage) {
        this.onMessage(payloadText);
      }
    }
  }
}

export class MultiRelayRendezvous {
  constructor({ roomTopic, urls, onMessage, onBinaryMessage, onBrokerReady, onStatusChange }) {
    this.roomTopic = roomTopic;
    this.fullTopic = `${TOPIC_PREFIX}${roomTopic}`;
    this.urls = Array.isArray(urls) && urls.length > 0 ? urls : DEFAULT_MQTT_RELAYS.slice();
    this.onMessage = onMessage;
    this.onBinaryMessage = onBinaryMessage || null;
    this.onBrokerReady = onBrokerReady;
    this.onStatusChange = onStatusChange;

    this.clients = [];
    this.seenPayloads = new Set();
    this.voiceStripeIdx = 0;
    this.stopped = false;
  }

  start() {
    this.stop();
    this.stopped = false;
    this.clients = this.urls.map(
      (url) =>
        new MqttWsClient({
          url,
          topic: this.fullTopic,
          onMessage: (payload) => this._handleIncoming(payload),
          onBinaryMessage: (bytes, brokerUrl) => this._handleIncomingBinary(bytes, brokerUrl),
          onReady: (client) => {
            if (!this.stopped && this.onBrokerReady) {
              this.onBrokerReady(client, this.getStatus());
            }
          },
          onStateChange: () => {
            if (!this.stopped && this.onStatusChange) {
              this.onStatusChange(this.getStatus());
            }
          },
        })
    );
    for (const c of this.clients) {
      c.start();
    }
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }

  stop() {
    this.stopped = true;
    for (const c of this.clients) {
      c.stop();
    }
    this.clients = [];
    this.seenPayloads.clear();
    this.voiceStripeIdx = 0;
  }

  publish(sealedPayload) {
    if (this.stopped || !sealedPayload) return 0;
    this._rememberPayload(sealedPayload);
    let sent = 0;
    for (const c of this.clients) {
      if (c.publish(sealedPayload)) {
        sent += 1;
      }
    }
    return sent;
  }

  /**
   * Publishes raw E2EE binary fallback payloads ("DF" data frames / "VB" voice bundles),
   * preferring low-RTT, uncongested brokers shared by both local and remote peers.
   * When `stripe` is true (realtime voice), round-robins across the fastest shared brokers
   * so no single public MQTT sandbox hits its per-second publish token bucket.
   */
  publishBinary(
    payloadBytes,
    { preferredUrls = null, maxBrokers = 1, queueIfOffline = false, stripe = false } = {}
  ) {
    if (this.stopped || !payloadBytes || payloadBytes.length === 0) return 0;
    const ready = this.clients.filter(
      (c) => c.ready && c.ws && c.ws.readyState === WebSocket.OPEN && (c.ws.bufferedAmount || 0) <= 131072
    );

    if (ready.length === 0) {
      if (queueIfOffline && this.clients.length > 0) {
        this.clients[0].publishBinary(payloadBytes, true);
      }
      return 0;
    }

    const uncongested = ready.filter((c) => (c.ws.bufferedAmount || 0) <= 16384);
    const pool = uncongested.length > 0 ? uncongested : ready;

    let ordered = pool;
    if (Array.isArray(preferredUrls) && preferredUrls.length > 0) {
      const prefSet = new Set(preferredUrls);
      const sharedFresh = pool.filter((c) => prefSet.has(c.url));
      if (sharedFresh.length > 0) {
        ordered = sharedFresh;
      } else {
        const sharedAny = ready.filter((c) => prefSet.has(c.url));
        if (sharedAny.length > 0) {
          ordered = sharedAny;
        }
      }
    }

    ordered = ordered.slice().sort((a, b) => (a.rttMs ?? 150) - (b.rttMs ?? 150));

    if (stripe && ordered.length > 1) {
      const bestRtt = ordered[0].rttMs ?? 150;
      const fastPool = ordered
        .filter((c) => (c.rttMs ?? 150) <= bestRtt + 100)
        .slice(0, 3);
      const stripePool = fastPool.length > 0 ? fastPool : [ordered[0]];
      const startIdx = this.voiceStripeIdx % stripePool.length;
      this.voiceStripeIdx = (this.voiceStripeIdx + 1) >>> 0;
      for (let k = 0; k < stripePool.length; k++) {
        if (stripePool[(startIdx + k) % stripePool.length].publishBinary(payloadBytes, false)) {
          return 1;
        }
      }
      for (const c of ordered) {
        if (c.publishBinary(payloadBytes, false)) {
          return 1;
        }
      }
      return 0;
    }

    const limit = Math.max(1, Math.min(ordered.length, maxBrokers));
    let sent = 0;
    for (let i = 0; i < ordered.length && sent < limit; i++) {
      if (ordered[i].publishBinary(payloadBytes, false)) {
        sent += 1;
      }
    }
    return sent;
  }

  getStatus() {
    const totalCount = this.clients.length;
    const readyClients = this.clients.filter((c) => c.ready);
    const connectedCount = readyClients.length;
    const state = this.stopped
      ? "stopped"
      : connectedCount > 0
        ? "live"
        : totalCount > 0
          ? "connecting"
          : "offline";
    const brokerRtts = {};
    for (const c of readyClients) {
      brokerRtts[c.url] = c.rttMs;
    }
    return {
      state,
      connectedCount,
      totalCount,
      connectedUrls: readyClients.map((c) => c.url),
      brokerRtts,
      topic: this.roomTopic,
    };
  }

  _rememberPayload(payload) {
    this.seenPayloads.add(payload);
    if (this.seenPayloads.size > MAX_SEEN_CACHE) {
      let drop = 200;
      for (const item of this.seenPayloads) {
        this.seenPayloads.delete(item);
        drop -= 1;
        if (drop <= 0) break;
      }
    }
  }

  _handleIncoming(payload) {
    if (this.stopped || !payload) return;
    if (this.seenPayloads.has(payload)) {
      return;
    }
    this._rememberPayload(payload);
    if (this.onMessage) {
      this.onMessage(payload);
    }
  }

  _handleIncomingBinary(bytes, brokerUrl) {
    if (this.stopped || !bytes || bytes.length === 0) return;
    if (this.onBinaryMessage) {
      this.onBinaryMessage(bytes, brokerUrl);
    }
  }
}

export const RELAY_DATA_CHUNK_SIZE = 14000;

export function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Computes a deterministic, opaque 8-byte room-scoped peer routing tag so raw peer IDs
 * never appear in plaintext on MQTT brokers when E2EE fallback transport is active.
 */
export async function computePeerTag(roomTopic, peerId) {
  const input = textEncoder.encode(`${roomTopic}\0${peerId}`);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto?.subtle?.digest) {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", input);
    const bytes = new Uint8Array(hash, 0, 8).slice();
    return { bytes, hex: bytesToHex(bytes) };
  }
  // Fallback 64-bit FNV-1a pair if SubtleCrypto is unavailable (e.g. non-secure LAN HTTP)
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 ^= input[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= input[i] ^ ((i * 31) & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const bytes = new Uint8Array(8);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, h1 >>> 0, false);
  dv.setUint32(4, h2 >>> 0, false);
  return { bytes, hex: bytesToHex(bytes) };
}

/**
 * Encodes an already-E2EE `E1:` mesh frame string into one or more compact binary "DF"
 * packets (`<= chunkSize` bytes payload each) safe for any public MQTT broker limit.
 */
export function encodeRelayDataChunks(
  fromTagBytes,
  toTagBytes,
  msgId,
  frameStr,
  chunkSize = RELAY_DATA_CHUNK_SIZE
) {
  const payload = textEncoder.encode(frameStr);
  const total = Math.max(1, Math.ceil(payload.length / chunkSize));
  const packets = [];
  for (let idx = 0; idx < total; idx++) {
    const start = idx * chunkSize;
    const slice = payload.subarray(start, Math.min(payload.length, start + chunkSize));
    const pkt = new Uint8Array(26 + slice.length);
    pkt[0] = 0x44; // 'D'
    pkt[1] = 0x46; // 'F'
    pkt.set(fromTagBytes, 2);
    pkt.set(toTagBytes, 10);
    const dv = new DataView(pkt.buffer);
    dv.setUint32(18, msgId >>> 0, false);
    dv.setUint16(22, idx, false);
    dv.setUint16(24, total, false);
    pkt.set(slice, 26);
    packets.push(pkt);
  }
  return packets;
}

export function decodeRelayDataChunk(bytes) {
  if (!bytes || bytes.length < 26 || bytes[0] !== 0x44 || bytes[1] !== 0x46) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fromHex = bytesToHex(bytes.subarray(2, 10));
  const toHex = bytesToHex(bytes.subarray(10, 18));
  const msgId = dv.getUint32(18, false);
  const idx = dv.getUint16(22, false);
  const total = dv.getUint16(24, false);
  if (total === 0 || idx >= total || total > 512) return null;
  return {
    fromHex,
    toHex,
    msgId,
    idx,
    total,
    chunkBytes: bytes.subarray(26),
  };
}

/**
 * Bundles 1..16 already-E2EE `V1` binary voice packets (~20ms each) into a single
 * compact "VB" MQTT payload so fallback voice uses ~10-12 tiny packets/sec only while speaking.
 */
export function encodeRelayVoiceBundle(fromTagBytes, toTagBytes, seq, frames) {
  const count = Math.min(frames.length, 16);
  let totalLen = 23;
  for (let i = 0; i < count; i++) {
    totalLen += 2 + frames[i].byteLength;
  }
  const pkt = new Uint8Array(totalLen);
  pkt[0] = 0x56; // 'V'
  pkt[1] = 0x42; // 'B'
  pkt.set(fromTagBytes, 2);
  pkt.set(toTagBytes, 10);
  const dv = new DataView(pkt.buffer);
  dv.setUint32(18, seq >>> 0, false);
  pkt[22] = count;
  let offset = 23;
  for (let i = 0; i < count; i++) {
    const f = frames[i];
    dv.setUint16(offset, f.byteLength, false);
    offset += 2;
    pkt.set(f, offset);
    offset += f.byteLength;
  }
  return pkt;
}

export function decodeRelayVoiceBundle(bytes) {
  if (!bytes || bytes.length < 23 || bytes[0] !== 0x56 || bytes[1] !== 0x42) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fromHex = bytesToHex(bytes.subarray(2, 10));
  const toHex = bytesToHex(bytes.subarray(10, 18));
  const seq = dv.getUint32(18, false);
  const count = bytes[22];
  if (count === 0 || count > 16) return null;
  const frames = [];
  let offset = 23;
  for (let i = 0; i < count; i++) {
    if (offset + 2 > bytes.length) return null;
    const len = dv.getUint16(offset, false);
    offset += 2;
    if (len === 0 || offset + len > bytes.length) return null;
    frames.push(bytes.subarray(offset, offset + len));
    offset += len;
  }
  return { fromHex, toHex, seq, frames };
}

/**
 * Zero-dependency MQTT 3.1.1 over WebSocket client for serverless E2EE room rendezvous.
 *
 * Only opaque HKDF-derived 32-hex topics (`p2pdirect/v1/<topic>`) and
 * ChaCha20-Poly1305 AEAD-sealed `R1:` signaling payloads ever touch these stateless relays.
 * All chat messages, images, replicated logs, and voice audio flow strictly peer-to-peer
 * over direct WebRTC DataChannels.
 */

export const DEFAULT_MQTT_RELAYS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
  "wss://test.mosquitto.org:8081/mqtt",
];

const TOPIC_PREFIX = "p2pdirect/v1/";
const KEEPALIVE_SECONDS = 30;
const PING_INTERVAL_MS = 20_000;
const MAX_OUTBOUND_QUEUE = 8;
const MAX_SEEN_CACHE = 600;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
  const addCsv = (raw) => {
    if (!raw || typeof raw !== "string") return;
    for (const part of raw.split(",")) {
      const cleaned = part.trim();
      if (isValidRelayUrl(cleaned) && !list.includes(cleaned)) {
        list.push(cleaned);
      }
    }
  };

  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    addCsv(params.get("relay"));
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

function buildPublishPacket(topic, payloadText) {
  const topicBytes = encodeMqttString(topic);
  const payloadBytes = textEncoder.encode(payloadText);
  return buildPacket(0x30, [topicBytes, payloadBytes]);
}

const PINGREQ_PACKET = new Uint8Array([0xc0, 0x00]);
const DISCONNECT_PACKET = new Uint8Array([0xe0, 0x00]);

class MqttWsClient {
  constructor({ url, topic, onMessage, onReady, onStateChange }) {
    this.url = url;
    this.topic = topic;
    this.onMessage = onMessage;
    this.onReady = onReady;
    this.onStateChange = onStateChange;

    this.ws = null;
    this.stopped = false;
    this.ready = false;
    this.rxBuf = new Uint8Array(0);
    this.outboundQueue = [];
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.connectTimeoutTimer = null;
    this.backoffMs = 1500;
    this.packetId = 1;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this.ready = false;
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

  _clearTimers() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
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

  _connect() {
    if (this.stopped) return;
    this._clearTimers();
    this.ready = false;
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
          this.ws.send(buildSubscribePacket(pid, this.topic));
        } catch {
          // ignore
        }
        this.pingTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(PINGREQ_PACKET);
            } catch {
              // ignore
            }
          }
        }, PING_INTERVAL_MS);
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
      if (this.onStateChange) {
        this.onStateChange();
      }
      if (this.onReady) {
        this.onReady(this);
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
      const payloadText = textDecoder.decode(body.subarray(pos));
      if (payloadText && this.onMessage) {
        this.onMessage(payloadText);
      }
    }
  }
}

export class MultiRelayRendezvous {
  constructor({ roomTopic, urls, onMessage, onBrokerReady, onStatusChange }) {
    this.roomTopic = roomTopic;
    this.fullTopic = `${TOPIC_PREFIX}${roomTopic}`;
    this.urls = Array.isArray(urls) && urls.length > 0 ? urls : DEFAULT_MQTT_RELAYS.slice();
    this.onMessage = onMessage;
    this.onBrokerReady = onBrokerReady;
    this.onStatusChange = onStatusChange;

    this.clients = [];
    this.seenPayloads = new Set();
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

  getStatus() {
    const totalCount = this.clients.length;
    const connectedCount = this.clients.filter((c) => c.ready).length;
    const state = this.stopped
      ? "stopped"
      : connectedCount > 0
        ? "live"
        : totalCount > 0
          ? "connecting"
          : "offline";
    return {
      state,
      connectedCount,
      totalCount,
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
}

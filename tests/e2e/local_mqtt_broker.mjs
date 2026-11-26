/**
 * Zero-dependency loopback MQTT 3.1.1 over WebSocket (RFC 6455) broker for E2E tests.
 *
 * Matches `mqtt_relay.js` frame format, `Sec-WebSocket-Protocol: mqtt` subprotocol,
 * binary/UTF-8 QoS 0 PUBLISH fanout, wildcard (`+` / `#`) topic matching,
 * PINGREQ/PINGRESP keepalive, SUBSCRIBE/SUBACK, UNSUBSCRIBE/UNSUBACK, and DISCONNECT.
 */
import http from "node:http";
import { createHash } from "node:crypto";

const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Standard MQTT 3.1.1 topic filter matching supporting `+` and `#` wildcards.
 */
export function mqttTopicMatches(filter, topic) {
  if (typeof filter !== "string" || typeof topic !== "string") return false;
  if (!filter || !topic) return false;
  // MQTT 3.1.1 §4.7.2: topics beginning with '$' must not match leading '+' or '#'
  if (topic.startsWith("$") && (filter.startsWith("+") || filter.startsWith("#"))) {
    return false;
  }
  if (filter === topic) return true;
  const fLevels = filter.split("/");
  const tLevels = topic.split("/");

  for (let i = 0; i < fLevels.length; i++) {
    const fl = fLevels[i];
    if (fl === "#") {
      // '#' must be the final level and matches zero or more remaining levels
      return i === fLevels.length - 1;
    }
    if (i >= tLevels.length) {
      return false;
    }
    if (fl !== "+" && fl !== tLevels[i]) {
      return false;
    }
  }
  // Handle "a/b/#" matching "a/b" (parent level) per MQTT 3.1.1 §4.7.1.2
  if (fLevels.length === tLevels.length + 1 && fLevels[fLevels.length - 1] === "#") {
    return true;
  }
  return fLevels.length === tLevels.length;
}

function encodeRemainingLength(len) {
  const out = [];
  let x = len;
  do {
    let digit = x & 0x7f;
    x >>>= 7;
    if (x > 0) digit |= 0x80;
    out.push(digit);
  } while (x > 0);
  return out;
}

function encodeMqttPacket(headerByte, bodyChunks) {
  let bodyLen = 0;
  for (const c of bodyChunks) bodyLen += c.length;
  const rem = encodeRemainingLength(bodyLen);
  const pkt = Buffer.allocUnsafe(1 + rem.length + bodyLen);
  pkt[0] = headerByte;
  for (let i = 0; i < rem.length; i++) pkt[1 + i] = rem[i];
  let off = 1 + rem.length;
  for (const c of bodyChunks) {
    Buffer.from(c.buffer, c.byteOffset, c.byteLength).copy(pkt, off);
    off += c.length;
  }
  return pkt;
}

function buildPublishPacket(topic, payloadBytes) {
  const topicBytes = textEncoder.encode(topic);
  const topicHdr = Buffer.allocUnsafe(2 + topicBytes.length);
  topicHdr[0] = (topicBytes.length >> 8) & 0xff;
  topicHdr[1] = topicBytes.length & 0xff;
  topicHdr.set(topicBytes, 2);
  return encodeMqttPacket(0x30, [topicHdr, payloadBytes]);
}

function buildWsFrame(opcode, payload = Buffer.alloc(0)) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = buf.length;
  let hdr;
  if (len < 126) {
    hdr = Buffer.allocUnsafe(2);
    hdr[0] = 0x80 | (opcode & 0x0f);
    hdr[1] = len;
  } else if (len < 65536) {
    hdr = Buffer.allocUnsafe(4);
    hdr[0] = 0x80 | (opcode & 0x0f);
    hdr[1] = 126;
    hdr.writeUInt16BE(len, 2);
  } else {
    hdr = Buffer.allocUnsafe(10);
    hdr[0] = 0x80 | (opcode & 0x0f);
    hdr[1] = 127;
    hdr.writeBigUInt64BE(BigInt(len), 2);
  }
  return len > 0 ? Buffer.concat([hdr, buf]) : hdr;
}

const CONNACK_OK = Buffer.from([0x20, 0x02, 0x00, 0x00]);
const PINGRESP_PKT = Buffer.from([0xd0, 0x00]);

/**
 * Starts a zero-dependency loopback MQTT-over-WebSocket broker bound to `127.0.0.1:0`.
 */
export async function startLocalMqttBroker({ host = "127.0.0.1", port = 0, path = "/mqtt" } = {}) {
  const clients = new Set();
  const stats = {
    connectionsTotal: 0,
    connectPackets: 0,
    subscribePackets: 0,
    unsubscribePackets: 0,
    publishPackets: 0,
    deliveredPackets: 0,
    pingPackets: 0,
    disconnectPackets: 0,
    topicsSeen: new Set(),
  };

  function sendWsBinary(client, bytes) {
    if (client.closed || client.socket.destroyed || !client.socket.writable) return;
    try {
      client.socket.write(buildWsFrame(0x02, bytes));
    } catch {
      // ignore broken pipe on disconnect
    }
  }

  function closeClient(client, sendCloseFrame = false) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    if (sendCloseFrame && !client.socket.destroyed && client.socket.writable) {
      try {
        client.socket.write(buildWsFrame(0x08, Buffer.alloc(0)));
      } catch {
        // ignore
      }
    }
    try {
      client.socket.end();
      client.socket.destroy();
    } catch {
      // ignore
    }
  }

  function handleMqttPacket(client, header, body) {
    const packetType = (header >> 4) & 0x0f;

    if (packetType === 1) {
      // CONNECT
      stats.connectPackets += 1;
      let pos = 0;
      if (body.length >= 2) {
        const protoLen = (body[0] << 8) | body[1];
        pos = 2 + protoLen + 4; // protocol name + level + flags + keepAlive(2)
        if (pos + 2 <= body.length) {
          const cidLen = (body[pos] << 8) | body[pos + 1];
          if (pos + 2 + cidLen <= body.length) {
            client.clientId = textDecoder.decode(body.subarray(pos + 2, pos + 2 + cidLen));
          }
        }
      }
      client.connected = true;
      sendWsBinary(client, CONNACK_OK);
      return;
    }

    if (packetType === 8) {
      // SUBSCRIBE
      stats.subscribePackets += 1;
      if (body.length < 2) return;
      const pidHi = body[0];
      const pidLo = body[1];
      let pos = 2;
      const grants = [];
      while (pos + 2 <= body.length) {
        const tLen = (body[pos] << 8) | body[pos + 1];
        pos += 2;
        if (pos + tLen + 1 > body.length) break;
        const filter = textDecoder.decode(body.subarray(pos, pos + tLen));
        pos += tLen;
        pos += 1; // requested QoS (granted QoS 0)
        client.subscriptions.add(filter);
        stats.topicsSeen.add(filter);
        grants.push(0x00);
      }
      const suback = encodeMqttPacket(0x90, [
        Buffer.from([pidHi, pidLo]),
        Buffer.from(grants),
      ]);
      sendWsBinary(client, suback);
      return;
    }

    if (packetType === 10) {
      // UNSUBSCRIBE
      stats.unsubscribePackets += 1;
      if (body.length < 2) return;
      const pidHi = body[0];
      const pidLo = body[1];
      let pos = 2;
      while (pos + 2 <= body.length) {
        const tLen = (body[pos] << 8) | body[pos + 1];
        pos += 2;
        if (pos + tLen > body.length) break;
        const filter = textDecoder.decode(body.subarray(pos, pos + tLen));
        pos += tLen;
        client.subscriptions.delete(filter);
      }
      sendWsBinary(client, Buffer.from([0xb0, 0x02, pidHi, pidLo]));
      return;
    }

    if (packetType === 3) {
      // PUBLISH
      stats.publishPackets += 1;
      if (body.length < 2) return;
      const tLen = (body[0] << 8) | body[1];
      let pos = 2 + tLen;
      if (pos > body.length) return;
      const topic = textDecoder.decode(body.subarray(2, pos));
      const qos = (header >> 1) & 0x03;
      let pidHi = 0;
      let pidLo = 0;
      if (qos > 0) {
        if (pos + 2 > body.length) return;
        pidHi = body[pos];
        pidLo = body[pos + 1];
        pos += 2;
        if (qos === 1) {
          sendWsBinary(client, Buffer.from([0x40, 0x02, pidHi, pidLo]));
        }
      }
      const payload = body.subarray(pos);
      stats.topicsSeen.add(topic);

      const outPacket = buildPublishPacket(topic, payload);
      for (const peer of clients) {
        if (peer.closed || !peer.connected) continue;
        let matched = false;
        for (const filter of peer.subscriptions) {
          if (mqttTopicMatches(filter, topic)) {
            matched = true;
            break;
          }
        }
        if (matched) {
          stats.deliveredPackets += 1;
          sendWsBinary(peer, outPacket);
        }
      }
      return;
    }

    if (packetType === 12) {
      // PINGREQ
      stats.pingPackets += 1;
      sendWsBinary(client, PINGRESP_PKT);
      return;
    }

    if (packetType === 14) {
      // DISCONNECT
      stats.disconnectPackets += 1;
      closeClient(client, true);
    }
  }

  function drainMqttBuffer(client) {
    const buf = client.mqttBuf;
    let offset = 0;
    const len = buf.length;
    while (offset + 2 <= len) {
      const header = buf[offset];
      let multiplier = 1;
      let remLen = 0;
      let pos = offset + 1;
      let complete = false;
      for (let i = 0; i < 4; i++) {
        if (pos >= len) break;
        const b = buf[pos++];
        remLen += (b & 0x7f) * multiplier;
        if ((b & 0x80) === 0) {
          complete = true;
          break;
        }
        multiplier *= 128;
      }
      if (!complete) break;
      const pktEnd = pos + remLen;
      if (pktEnd > len) break;
      handleMqttPacket(client, header, buf.subarray(pos, pktEnd));
      offset = pktEnd;
      if (client.closed) break;
    }
    client.mqttBuf = offset >= len ? Buffer.alloc(0) : buf.subarray(offset);
  }

  function drainWsFrames(client) {
    let buf = client.wsBuf;
    let offset = 0;

    while (offset + 2 <= buf.length) {
      const b0 = buf[offset];
      const b1 = buf[offset + 1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let pos = offset + 2;

      if (payloadLen === 126) {
        if (pos + 2 > buf.length) break;
        payloadLen = buf.readUInt16BE(pos);
        pos += 2;
      } else if (payloadLen === 127) {
        if (pos + 8 > buf.length) break;
        const bigLen = buf.readBigUInt64BE(pos);
        if (bigLen > BigInt(32 * 1024 * 1024)) {
          closeClient(client, true);
          return;
        }
        payloadLen = Number(bigLen);
        pos += 8;
      }

      let maskKey = null;
      if (masked) {
        if (pos + 4 > buf.length) break;
        maskKey = buf.subarray(pos, pos + 4);
        pos += 4;
      }

      if (pos + payloadLen > buf.length) break;

      const raw = Buffer.allocUnsafe(payloadLen);
      buf.copy(raw, 0, pos, pos + payloadLen);
      if (maskKey) {
        for (let i = 0; i < payloadLen; i++) {
          raw[i] ^= maskKey[i & 3];
        }
      }
      offset = pos + payloadLen;

      if (opcode === 0x08) {
        // Close
        closeClient(client, true);
        return;
      }
      if (opcode === 0x09) {
        // Ping -> Pong
        if (!client.closed && !client.socket.destroyed && client.socket.writable) {
          client.socket.write(buildWsFrame(0x0a, raw));
        }
        continue;
      }
      if (opcode === 0x0a) {
        // Pong
        continue;
      }

      // Data frame (0x01 text, 0x02 binary, 0x00 continuation)
      if (opcode === 0x01 || opcode === 0x02) {
        client.fragChunks = [raw];
      } else if (opcode === 0x00) {
        client.fragChunks.push(raw);
      }

      if (fin && client.fragChunks.length > 0) {
        const assembled =
          client.fragChunks.length === 1
            ? client.fragChunks[0]
            : Buffer.concat(client.fragChunks);
        client.fragChunks = [];
        client.mqttBuf =
          client.mqttBuf.length === 0
            ? assembled
            : Buffer.concat([client.mqttBuf, assembled]);
        drainMqttBuffer(client);
        if (client.closed) return;
      }
    }

    client.wsBuf = offset >= buf.length ? Buffer.alloc(0) : buf.subarray(offset);
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("local-mqtt-broker ok\n");
  });

  server.on("upgrade", (req, socket, head) => {
    const upgradeHdr = String(req.headers.upgrade || "").toLowerCase();
    const wsKey = req.headers["sec-websocket-key"];
    if (upgradeHdr !== "websocket" || !wsKey) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = createHash("sha1")
      .update(`${wsKey}${WS_MAGIC_GUID}`)
      .digest("base64");

    const reqProtos = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const selectedProto = reqProtos.includes("mqtt")
      ? "mqtt"
      : reqProtos.includes("mqttv3.1")
        ? "mqttv3.1"
        : null;

    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (selectedProto) {
      lines.push(`Sec-WebSocket-Protocol: ${selectedProto}`);
    }
    lines.push("", "");
    socket.write(lines.join("\r\n"));
    socket.setNoDelay(true);

    const client = {
      socket,
      clientId: "",
      connected: false,
      closed: false,
      subscriptions: new Set(),
      wsBuf: head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0),
      fragChunks: [],
      mqttBuf: Buffer.alloc(0),
    };
    clients.add(client);
    stats.connectionsTotal += 1;

    socket.on("data", (chunk) => {
      if (client.closed) return;
      client.wsBuf =
        client.wsBuf.length === 0 ? Buffer.from(chunk) : Buffer.concat([client.wsBuf, chunk]);
      drainWsFrames(client);
    });
    socket.on("error", () => closeClient(client, false));
    socket.on("close", () => closeClient(client, false));

    if (client.wsBuf.length > 0) {
      drainWsFrames(client);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `ws://${host}:${actualPort}${normalizedPath}`;

  return {
    host,
    port: actualPort,
    url,
    wsUrl: url,
    stats,
    clients,
    async close() {
      for (const c of Array.from(clients)) {
        closeClient(c, true);
      }
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

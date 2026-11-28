/**
 * Zero-Server Intra-Room E2EE Peer-Hopping Transport Helpers.
 *
 * Transport Priority Hierarchy (strictly enforced — Direct P2P is ALWAYS preferred):
 *   1. "direct"   (rank 3) — Direct WebRTC P2P DataChannels (always tried first & upgraded to)
 *   2. "peer-hop" (rank 2) — Single-hop forwarding through a mutually direct room peer (0 servers)
 *   3. "relay"    (rank 1) — User-configured Bring-Your-Own-Relay (0 3rd-party relays)
 *
 * End-to-End Encryption Guarantee:
 *   All chat, bulk media, and voice packets forwarded via Peer-Hop are ALREADY sealed with
 *   pairwise X25519 + ChaCha20-Poly1305 keys between the two endpoints inside `p2p_mesh.wasm`.
 *   The mediating peer only forwards opaque envelopes and cannot decrypt any content or audio.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const PEER_HOP_VOICE_MAGIC_0 = 0x50; // 'P'
export const PEER_HOP_VOICE_MAGIC_1 = 0x48; // 'H'
export const PEER_HOP_VOICE_VERSION = 0x01;
export const PEER_HOP_DATA_CHUNK_SIZE = 11_000; // safely below WebRTC 16 KB SCTP limit after JSON wrapping

export const HOP_CTRL_PREFIX = '{"kind":"hop_ctrl"';
export const HOP_DATA_PREFIX = '{"kind":"hop_data"';

const TRANSPORT_RANKS = Object.freeze({
  direct: 3,
  "peer-hop": 2,
  relay: 1,
});

export function normalizeTransportKind(transport) {
  if (transport === "direct" || transport === "peer-hop" || transport === "relay") {
    return transport;
  }
  return "direct";
}

export function transportRank(transport) {
  return TRANSPORT_RANKS[transport] || 0;
}

/**
 * Returns true if `incomingTransport` is allowed to replace `existingTransport`.
 * Never downgrades Direct P2P to Peer-Hop or Relay, and never downgrades Peer-Hop to Relay.
 */
export function canReplaceTransport(existingTransport, incomingTransport) {
  return transportRank(incomingTransport) >= transportRank(existingTransport);
}

/**
 * Returns true if `incomingTransport` is strictly higher priority than `existingTransport`
 * (e.g. `peer-hop` -> `direct`, `relay` -> `peer-hop`, or `relay` -> `direct`).
 */
export function isTransportUpgrade(existingTransport, incomingTransport) {
  return transportRank(incomingTransport) > transportRank(existingTransport);
}

/**
 * Computes exponential backoff delay (ms) for background Direct P2P upgrade probes while on
 * `peer-hop` or `relay`, so Direct P2P is continuously retried (e.g. when a phone VPN turns off).
 */
export function computeDirectUpgradeDelayMs(attempts, transport = "peer-hop") {
  const n = Math.max(0, Number(attempts) || 0);
  if (transport === "peer-hop") {
    // Aggressive early retries (12s, 24s, 45s, 90s, then steady 120s) so Direct P2P wins ASAP
    const schedule = [12_000, 24_000, 45_000, 90_000, 120_000];
    return schedule[Math.min(n, schedule.length - 1)];
  }
  const schedule = [20_000, 40_000, 60_000, 120_000];
  return schedule[Math.min(n, schedule.length - 1)];
}

/**
 * Encodes a binary `"PH"` v1 Peer-Hop Voice packet for the 50 Hz `p2p-voice` DataChannel:
 *   [0x50, 0x48, 0x01, ttl, srcLen, dstLen, ...srcUtf8, ...dstUtf8, ...opaqueE2eeVoiceBytes]
 */
export function encodePeerHopVoicePacket({ srcPeerId, dstPeerId, payload, ttl = 1 }) {
  const srcBytes = textEncoder.encode(String(srcPeerId || ""));
  const dstBytes = textEncoder.encode(String(dstPeerId || ""));
  if (
    srcBytes.length === 0 ||
    srcBytes.length > 96 ||
    dstBytes.length === 0 ||
    dstBytes.length > 96 ||
    !payload ||
    payload.byteLength === 0
  ) {
    return null;
  }
  const payloadBytes =
    payload instanceof Uint8Array
      ? payload
      : new Uint8Array(payload.buffer || payload, payload.byteOffset || 0, payload.byteLength);
  const out = new Uint8Array(6 + srcBytes.length + dstBytes.length + payloadBytes.byteLength);
  out[0] = PEER_HOP_VOICE_MAGIC_0;
  out[1] = PEER_HOP_VOICE_MAGIC_1;
  out[2] = PEER_HOP_VOICE_VERSION;
  out[3] = Math.max(0, Math.min(4, Number(ttl) | 0));
  out[4] = srcBytes.length;
  out[5] = dstBytes.length;
  out.set(srcBytes, 6);
  out.set(dstBytes, 6 + srcBytes.length);
  out.set(payloadBytes, 6 + srcBytes.length + dstBytes.length);
  return out;
}

export function isPeerHopVoicePacket(bytes) {
  return Boolean(
    bytes &&
      bytes.byteLength >= 8 &&
      bytes[0] === PEER_HOP_VOICE_MAGIC_0 &&
      bytes[1] === PEER_HOP_VOICE_MAGIC_1 &&
      bytes[2] === PEER_HOP_VOICE_VERSION
  );
}

/**
 * Decodes a binary `"PH"` v1 Peer-Hop Voice packet with zero-copy payload subarray.
 */
export function decodePeerHopVoicePacket(bytes) {
  if (!isPeerHopVoicePacket(bytes)) return null;
  const ttl = bytes[3];
  const srcLen = bytes[4];
  const dstLen = bytes[5];
  const headerLen = 6 + srcLen + dstLen;
  if (srcLen === 0 || dstLen === 0 || srcLen > 96 || dstLen > 96 || bytes.byteLength <= headerLen) {
    return null;
  }
  const srcPeerId = textDecoder.decode(bytes.subarray(6, 6 + srcLen));
  const dstPeerId = textDecoder.decode(bytes.subarray(6 + srcLen, headerLen));
  const payload = bytes.subarray(headerLen);
  return { ttl, srcPeerId, dstPeerId, payload };
}

/**
 * Returns a forwarded copy of a `"PH"` voice packet with TTL decremented by 1 (prevents loops).
 */
export function decrementPeerHopVoiceTtl(bytes) {
  if (!isPeerHopVoicePacket(bytes) || bytes[3] === 0) return null;
  const copy = bytes.slice();
  copy[3] = bytes[3] - 1;
  return copy;
}

export function encodeHopCtrl(fields) {
  return JSON.stringify({ kind: "hop_ctrl", ...fields });
}

export function encodeHopData({ ch = "data", from, to, d }) {
  return JSON.stringify({ kind: "hop_data", ch, from, to, d });
}

/**
 * Fast prefix-checked parser for `hop_ctrl` and `hop_data` JSON envelopes on DataChannels.
 * Avoids `JSON.parse` overhead on normal E2EE frames.
 */
export function tryParseHopFrame(rawStr) {
  if (typeof rawStr !== "string") return null;
  if (!rawStr.startsWith(HOP_CTRL_PREFIX) && !rawStr.startsWith(HOP_DATA_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawStr);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.kind !== "hop_ctrl" && parsed.kind !== "hop_data") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Deterministically selects ordered candidate 1-hop Direct WebRTC mediators connecting
 * `selfPeerId` and `targetPeerId`.
 *
 * Guarantees both sides converge on the same mediator when mutual direct neighbors exist:
 *   1. Only considers peers with an open `"direct"` connection to us (never hops over hops/relays).
 *   2. Verifies the candidate also has a direct connection to `targetPeerId` (via advertised
 *      neighbor lists or WASM `indirectPeers`).
 *   3. Sorts deterministically: bots/always-on peers first (e.g., Proxmox HA bot), then
 *      lexicographical `peerId` so both endpoints pick the identical mediator.
 */
export function selectPeerHopMediators({
  selfPeerId,
  targetPeerId,
  directPeers,
  peerNeighbors = null,
  indirectPeers = null,
  botPeerIds = null,
  excludeMediators = null,
}) {
  if (!selfPeerId || !targetPeerId || selfPeerId === targetPeerId || !directPeers) {
    return [];
  }

  const indirectVia = new Set();
  if (Array.isArray(indirectPeers)) {
    for (const r of indirectPeers) {
      if (r && r.peerId === targetPeerId && r.viaPeerId) {
        indirectVia.add(r.viaPeerId);
      }
    }
  }

  const targetKnownDirect = peerNeighbors?.get?.(targetPeerId) || null;
  const candidates = [];

  for (const [mid, entry] of directPeers.entries()) {
    if (!mid || mid === selfPeerId || mid === targetPeerId) continue;
    if (excludeMediators && excludeMediators.has(mid)) continue;
    if (!entry || entry.superseded) continue;
    if (entry.transport !== "direct") continue;
    if (!entry.dc || entry.dc.readyState !== "open") continue;

    const mediatorNeighbors = peerNeighbors?.get?.(mid) || null;
    const knowsTarget =
      Boolean(mediatorNeighbors && mediatorNeighbors.has(targetPeerId)) ||
      Boolean(targetKnownDirect && targetKnownDirect.has(mid)) ||
      indirectVia.has(mid);
    if (!knowsTarget) continue;

    const isBot = Boolean(entry.isBot || (botPeerIds && botPeerIds.has(mid)));
    candidates.push({ peerId: mid, isBot });
  }

  candidates.sort((a, b) => {
    if (a.isBot !== b.isBot) return a.isBot ? -1 : 1;
    return a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0;
  });

  return candidates.map((c) => c.peerId);
}

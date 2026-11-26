/**
 * Deterministic multi-peer simulated network powered by the real compiled Safe Rust
 * `p2p_mesh.wasm` module (`SafeRustWasmMesh`), scheduled on `VirtualClock`.
 *
 * Features:
 * - One-time compiled WASM module caching (`SafeRustWasmMesh.loadFromBytes` + `fromInstance`)
 * - Deterministic per-peer X25519 keys and shared mesh key
 * - Directed per-link latency, jitter, packet drop, duplication, and reordering
 * - Full-mesh & multi-hop topologies, partitions/healing, connect/disconnect, late joiners
 * - Real keepalive Ping/Pong RTT measurement & RTT/2 media compensation in `src/mesh.rs`
 * - Built-in E2EE Wire Auditor asserting zero plaintext URLs/titles/volume/mute leakage
 */

import { readFile } from "node:fs/promises";
import { SafeRustWasmMesh } from "../../wasm_client.js";
import { createPrng } from "./prng.mjs";

const WASM_URL = new URL("../../p2p_mesh.wasm", import.meta.url);

let cachedWasmModulePromise = null;

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Loads and compiles `p2p_mesh.wasm` once (via `SafeRustWasmMesh.loadFromBytes`),
 * caching the `WebAssembly.Module` across all peers and test runs.
 */
export async function loadCompiledWasmModule() {
  if (!cachedWasmModulePromise) {
    cachedWasmModulePromise = (async () => {
      const bytes = await readFile(WASM_URL);
      const firstMesh = await SafeRustWasmMesh.loadFromBytes(bytes);
      if (!firstMesh.wasmModule) {
        throw new Error("SafeRustWasmMesh.loadFromBytes did not expose compiled wasmModule");
      }
      return firstMesh.wasmModule;
    })();
  }
  return cachedWasmModulePromise;
}

/**
 * Instantiates a fresh isolated `SafeRustWasmMesh` instance from the cached module.
 */
export async function createWasmMeshInstance() {
  const mod = await loadCompiledWasmModule();
  const instance = await WebAssembly.instantiate(mod, {});
  return SafeRustWasmMesh.fromInstance(instance, mod);
}

const ALLOWED_E2EE_ENVELOPE_KEYS = new Set(["kind", "v", "s", "n", "c"]);

const DEFAULT_FORBIDDEN_SUBSTRINGS = [
  "https://",
  "http://",
  "youtube.com",
  "youtu.be",
  "spotify.com",
  "soundcloud.com",
  "twitch.tv",
  "\"media_sync\"",
  "\"positionMs\"",
  "\"localVolume\"",
  "\"localMuted\"",
  "\"volume\"",
  "\"muted\"",
  "\"mediaId\"",
  "\"playlistId\"",
  "\"trackUri\"",
];

export class E2EEWireAuditor {
  constructor({ throwOnViolation = true, forbiddenSubstrings = [] } = {}) {
    this.throwOnViolation = Boolean(throwOnViolation);
    this.forbiddenSubstrings = new Set([
      ...DEFAULT_FORBIDDEN_SUBSTRINGS,
      ...forbiddenSubstrings.filter((s) => typeof s === "string" && s.length >= 4),
    ]);
    this.auditedCount = 0;
    this.auditedBytes = 0;
    this.violations = [];
  }

  addForbiddenSubstrings(items = []) {
    for (const s of items) {
      if (typeof s === "string" && s.trim().length >= 4) {
        this.forbiddenSubstrings.add(s.trim());
      }
    }
  }

  _recordViolation(code, message, meta) {
    const v = { code, message, ...meta };
    this.violations.push(v);
    if (this.throwOnViolation) {
      throw new Error(`E2EEWireAuditor violation [${code}]: ${message}`);
    }
    return false;
  }

  /**
   * Audits a single wire frame string before/during transport.
   * Every wire frame MUST be a valid E2EE envelope (`kind === "e2ee"`) with zero plaintext leaks.
   */
  audit(frameStr, meta = {}) {
    this.auditedCount += 1;
    if (typeof frameStr !== "string" || frameStr.length === 0) {
      return this._recordViolation("empty-frame", "Wire frame must be a non-empty string", meta);
    }
    this.auditedBytes += frameStr.length;

    let parsed;
    try {
      parsed = JSON.parse(frameStr);
    } catch {
      return this._recordViolation("invalid-json", "Wire frame is not valid JSON", meta);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return this._recordViolation("not-object", "Wire frame JSON is not an object", meta);
    }
    if (parsed.kind !== "e2ee") {
      return this._recordViolation(
        "non-e2ee-frame",
        `Wire frame kind must be "e2ee", got ${JSON.stringify(parsed.kind)}`,
        meta
      );
    }
    for (const key of Object.keys(parsed)) {
      if (!ALLOWED_E2EE_ENVELOPE_KEYS.has(key)) {
        return this._recordViolation(
          "unexpected-envelope-key",
          `Unexpected outer wire envelope key "${key}"`,
          meta
        );
      }
    }
    if (
      typeof parsed.v !== "number" ||
      parsed.v !== 1 ||
      typeof parsed.s !== "number" ||
      parsed.s < 1 ||
      typeof parsed.n !== "string" ||
      parsed.n.length < 12 ||
      typeof parsed.c !== "string" ||
      parsed.c.length < 16
    ) {
      return this._recordViolation("malformed-envelope", "Malformed E2EE envelope fields", meta);
    }

    // Check raw wire frame for any plaintext leakage (URLs, titles, volume/mute keys, etc.)
    const lower = frameStr.toLowerCase();
    for (const forbidden of this.forbiddenSubstrings) {
      if (lower.includes(forbidden.toLowerCase())) {
        return this._recordViolation(
          "plaintext-leak",
          `Wire frame leaked forbidden plaintext substring ${JSON.stringify(forbidden)}`,
          meta
        );
      }
    }

    return true;
  }

  reset() {
    this.auditedCount = 0;
    this.auditedBytes = 0;
    this.violations.length = 0;
  }
}

const DEFAULT_LINK_CONFIG = Object.freeze({
  latencyMs: 25,
  jitterMs: 5,
  dropProb: 0,
  dupProb: 0,
  reorderProb: 0,
});

function edgeKey(a, b) {
  return a < b ? `${a}<->${b}` : `${b}<->${a}`;
}

function dirKey(a, b) {
  return `${a}->${b}`;
}

export class SimulatedNetwork {
  /**
   * @param {{
   *   clock: import("./virtual_clock.mjs").VirtualClock,
   *   prng?: ReturnType<typeof createPrng>,
   *   room?: string,
   *   meshKeyBytes?: Uint8Array,
   *   autoMeshEnabled?: boolean,
   *   keepaliveIntervalMs?: number,
   *   auditWire?: boolean,
   *   throwOnAuditViolation?: boolean,
   *   forbiddenSubstrings?: string[],
   *   onWireFrame?: Function,
   *   onMediaSync?: Function,
   *   onAction?: Function,
   *   timeline?: { record: Function } | null,
   * }} options
   */
  constructor(options = {}) {
    if (!options.clock) {
      throw new Error("SimulatedNetwork requires a VirtualClock instance (`clock`)");
    }
    this.clock = options.clock;
    this.prng = options.prng || createPrng(options.seed ?? 1);
    this.room = String(options.room || "sim-room");
    this.defaultAutoMeshEnabled = Boolean(options.autoMeshEnabled);
    this.onWireFrame = typeof options.onWireFrame === "function" ? options.onWireFrame : null;
    this.onMediaSync = typeof options.onMediaSync === "function" ? options.onMediaSync : null;
    this.onAction = typeof options.onAction === "function" ? options.onAction : null;
    this.timeline = options.timeline || null;

    const rawMeshKey =
      options.meshKeyBytes instanceof Uint8Array && options.meshKeyBytes.length === 32
        ? options.meshKeyBytes
        : this.prng.bytes(32);
    this.meshKeyBytes = rawMeshKey;
    this.meshKeyB64 = toBase64Url(rawMeshKey);

    this.auditor =
      options.auditWire === false
        ? null
        : new E2EEWireAuditor({
            throwOnViolation: options.throwOnAuditViolation !== false,
            forbiddenSubstrings: options.forbiddenSubstrings || [],
          });

    this.peers = new Map();
    this._connections = new Set(); // undirected edgeKey(a, b)
    this._linkEpochs = new Map(); // undirected edgeKey(a, b) -> integer epoch
    this._links = new Map(); // directed dirKey(a, b) -> link config
    this._partitions = []; // Array<{ groupA: Set<string>, groupB: Set<string> }>
    this._wireEvents = [];
    this._mediaSyncEvents = [];
    this._keepaliveTimerId = null;
    this._pendingDeliveryTimers = new Set();
    this._destroyed = false;

    if (Number(options.keepaliveIntervalMs) > 0) {
      this.startKeepaliveLoop(Number(options.keepaliveIntervalMs));
    }
  }

  /**
   * Adds a new real-WASM peer node to the simulated network.
   */
  async addPeer(peerId, opts = {}) {
    const id = String(peerId || "").trim();
    if (!id) throw new Error("peerId must be a non-empty string");
    if (this.peers.has(id)) {
      throw new Error(`Peer "${id}" already exists in SimulatedNetwork`);
    }

    const wasm = await createWasmMeshInstance();
    const peerRng = this.prng.fork(`peer:${id}`);
    const secretBytes =
      opts.x25519SecretBytes instanceof Uint8Array && opts.x25519SecretBytes.length === 32
        ? opts.x25519SecretBytes
        : peerRng.bytes(32);
    const entropyBytes = peerRng.bytes(32);

    const authorName = String(opts.authorName || id);
    const initRes = wasm.call({
      cmd: "init",
      peerId: id,
      authorName,
      room: this.room,
      x25519Secret: toBase64Url(secretBytes),
      meshKey: this.meshKeyB64,
      entropy: toBase64Url(entropyBytes),
      autoMeshEnabled:
        opts.autoMeshEnabled !== undefined
          ? Boolean(opts.autoMeshEnabled)
          : this.defaultAutoMeshEnabled,
      maxDirectPeers: opts.maxDirectPeers || 16,
    });

    const pubKey = initRes.status.e2ee.publicKey;
    const peerClock = this.clock.forPeer(id, {
      wallSkewMs: opts.wallSkewMs ?? 0,
      clockDriftPpm: opts.clockDriftPpm ?? 0,
      sleepWindows: opts.sleepWindows ?? [],
    });

    const stats = {
      wireFramesSent: 0,
      wireFramesReceived: 0,
      wireBytesSent: 0,
      wireBytesReceived: 0,
      framesDropped: 0,
      framesDuplicated: 0,
      framesReordered: 0,
      replayRejections: 0,
      authErrors: 0,
      mediaSyncPublished: 0,
      mediaSyncReceived: 0,
      keepalivePingsSent: 0,
    };

    const peer = {
      peerId: id,
      authorName,
      pubKey,
      wasm,
      clock: peerClock,
      stats,
      lastMediaStates: new Map(),
      onMediaSync: typeof opts.onMediaSync === "function" ? opts.onMediaSync : null,
      onAction: typeof opts.onAction === "function" ? opts.onAction : null,
      onWireError: typeof opts.onWireError === "function" ? opts.onWireError : null,
      publishMediaSync: (state, nowMs = peerClock.wallNow()) =>
        this.publishMediaSync(id, state, nowMs),
      getMediaSync: (targetId = "watch") => this.getMediaSyncState(id, targetId),
      getAllMediaSync: () => this.getAllMediaSyncStates(id),
      getStatus: () => wasm.call({ cmd: "get_status" }).status,
      sendKeepalivePing: () => this.sendKeepalivePings(id),
      executeActions: (actions, meta) => this.executeActions(id, actions, meta),
    };

    this.peers.set(id, peer);
    return peer;
  }

  getPeer(peerId) {
    return this.peers.get(String(peerId)) || null;
  }

  peerIds() {
    return Array.from(this.peers.keys());
  }

  removePeer(peerId) {
    const id = String(peerId);
    if (!this.peers.has(id)) return false;
    for (const otherId of this.peers.keys()) {
      if (otherId !== id && this.isConnected(id, otherId)) {
        this.disconnect(id, otherId);
      }
    }
    this.peers.delete(id);
    return true;
  }

  /**
   * Configures directed link characteristics from `a` to `b` (or both directions if `bidirectional: true`).
   */
  setLink(a, b, config = {}) {
    const from = String(a);
    const to = String(b);
    const merged = {
      latencyMs: Math.max(0, Number(config.latencyMs ?? DEFAULT_LINK_CONFIG.latencyMs)),
      jitterMs: Math.max(0, Number(config.jitterMs ?? DEFAULT_LINK_CONFIG.jitterMs)),
      dropProb: Math.max(0, Math.min(1, Number(config.dropProb ?? DEFAULT_LINK_CONFIG.dropProb))),
      dupProb: Math.max(0, Math.min(1, Number(config.dupProb ?? DEFAULT_LINK_CONFIG.dupProb))),
      reorderProb: Math.max(
        0,
        Math.min(1, Number(config.reorderProb ?? DEFAULT_LINK_CONFIG.reorderProb))
      ),
    };
    this._links.set(dirKey(from, to), merged);
    if (config.bidirectional) {
      this._links.set(dirKey(to, from), { ...merged });
    }
    return merged;
  }

  getLink(a, b) {
    return this._links.get(dirKey(String(a), String(b))) || DEFAULT_LINK_CONFIG;
  }

  isConnected(a, b) {
    return this._connections.has(edgeKey(String(a), String(b)));
  }

  /**
   * Opens a bidirectional WebRTC-equivalent E2EE channel between `a` and `b`,
   * invoking real WASM `peer_connected` on both sides and scheduling `Hello` / sync frames.
   */
  connect(a, b, linkOpts = null) {
    const idA = String(a);
    const idB = String(b);
    if (idA === idB) return false;
    const peerA = this.peers.get(idA);
    const peerB = this.peers.get(idB);
    if (!peerA || !peerB) {
      throw new Error(`Cannot connect unknown peer(s): ${idA}, ${idB}`);
    }
    if (linkOpts) {
      this.setLink(idA, idB, { ...linkOpts, bidirectional: true });
    }
    const ek = edgeKey(idA, idB);
    if (this._connections.has(ek)) return false;
    this._connections.add(ek);
    this._linkEpochs.set(ek, (this._linkEpochs.get(ek) || 0) + 1);

    const resA = peerA.wasm.call({
      cmd: "peer_connected",
      peerId: idB,
      authorName: peerB.authorName,
      peerPubKey: peerB.pubKey,
      viaAutoMesh: false,
    });
    const resB = peerB.wasm.call({
      cmd: "peer_connected",
      peerId: idA,
      authorName: peerA.authorName,
      peerPubKey: peerA.pubKey,
      viaAutoMesh: false,
    });

    this.executeActions(idA, resA.actions, { source: "peer_connected" });
    this.executeActions(idB, resB.actions, { source: "peer_connected" });
    this.timeline?.record({
      tBase: this.clock.nowBaseMs,
      peerId: idA,
      kind: "net:connect",
      detail: `${idA} <-> ${idB}`,
    });
    return true;
  }

  /**
   * Connects all currently registered peers into a full mesh.
   */
  connectFullMesh(linkOpts = null) {
    const ids = this.peerIds();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        this.connect(ids[i], ids[j], linkOpts);
      }
    }
  }

  /**
   * Connects peers along a linear multi-hop chain `[p0, p1, p2, ...]`.
   */
  connectChain(peerIds, linkOpts = null) {
    for (let i = 0; i < peerIds.length - 1; i++) {
      this.connect(peerIds[i], peerIds[i + 1], linkOpts);
    }
  }

  /**
   * Connects peers in a star topology around `hubId`.
   */
  connectStar(hubId, spokeIds, linkOpts = null) {
    for (const spoke of spokeIds) {
      if (spoke !== hubId) {
        this.connect(hubId, spoke, linkOpts);
      }
    }
  }

  /**
   * Tears down the channel between `a` and `b` on both WASM nodes.
   */
  disconnect(a, b) {
    const idA = String(a);
    const idB = String(b);
    const ek = edgeKey(idA, idB);
    if (!this._connections.has(ek)) return false;
    this._connections.delete(ek);
    this._linkEpochs.set(ek, (this._linkEpochs.get(ek) || 0) + 1);

    const peerA = this.peers.get(idA);
    const peerB = this.peers.get(idB);
    if (peerA) {
      const resA = peerA.wasm.call({ cmd: "peer_disconnected", peerId: idB });
      this.executeActions(idA, resA.actions, { source: "peer_disconnected" });
    }
    if (peerB) {
      const resB = peerB.wasm.call({ cmd: "peer_disconnected", peerId: idA });
      this.executeActions(idB, resB.actions, { source: "peer_disconnected" });
    }
    this.timeline?.record({
      tBase: this.clock.nowBaseMs,
      peerId: idA,
      kind: "net:disconnect",
      detail: `${idA} X ${idB}`,
    });
    return true;
  }

  /**
   * Drops all wire frames crossing between `groupA` and `groupB` (bidirectional)
   * until `healAll()` is called.
   */
  partition(groupA, groupB) {
    const setA = new Set(Array.from(groupA, String));
    const setB = new Set(Array.from(groupB, String));
    this._partitions.push({ groupA: setA, groupB: setB });
    this.timeline?.record({
      tBase: this.clock.nowBaseMs,
      peerId: "net",
      kind: "net:partition",
      detail: `[${[...setA].join(",")}] | [${[...setB].join(",")}]`,
    });
  }

  isPartitioned(a, b) {
    const idA = String(a);
    const idB = String(b);
    for (const p of this._partitions) {
      if ((p.groupA.has(idA) && p.groupB.has(idB)) || (p.groupA.has(idB) && p.groupB.has(idA))) {
        return true;
      }
    }
    return false;
  }

  healAll() {
    this._partitions.length = 0;
    this.timeline?.record({
      tBase: this.clock.nowBaseMs,
      peerId: "net",
      kind: "net:heal",
      detail: "all partitions healed",
    });
  }

  /**
   * Triggers real WASM `keepalive_ping` on one peer or all peers, exercising real Ping/Pong
   * RTT measurement & `RTT/2` one-way media sync compensation in `src/mesh.rs`.
   */
  sendKeepalivePings(peerId = null) {
    const targets = peerId ? [this.peers.get(String(peerId))].filter(Boolean) : [...this.peers.values()];
    for (const peer of targets) {
      const res = peer.wasm.call({ cmd: "keepalive_ping", nowMs: peer.clock.wallNow() });
      peer.stats.keepalivePingsSent += 1;
      this.executeActions(peer.peerId, res.actions, { source: "keepalive_ping", isKeepalive: true });
    }
  }

  startKeepaliveLoop(intervalMs = 5000) {
    this.stopKeepaliveLoop();
    const step = Math.max(250, Number(intervalMs) || 5000);
    this._keepaliveTimerId = this.clock.setInterval(() => {
      if (this._destroyed) return;
      this.sendKeepalivePings();
    }, step);
  }

  stopKeepaliveLoop() {
    if (this._keepaliveTimerId !== null) {
      this.clock.clearInterval(this._keepaliveTimerId);
      this._keepaliveTimerId = null;
    }
  }

  /**
   * Publishes a synchronized media state from `peerId` through its real WASM `mediaSyncUpdate`
   * and routes all generated E2EE wire frames across the simulated network.
   */
  publishMediaSync(peerId, state, nowMs = undefined) {
    const peer = this.peers.get(String(peerId));
    if (!peer) throw new Error(`Unknown peer "${peerId}"`);
    const wall = nowMs !== undefined ? nowMs : peer.clock.wallNow();

    if (this.auditor) {
      const forbidden = [];
      if (state?.url) forbidden.push(String(state.url));
      if (state?.title && String(state.title).length >= 6) forbidden.push(String(state.title));
      if (forbidden.length > 0) this.auditor.addForbiddenSubstrings(forbidden);
    }

    const res = peer.wasm.mediaSyncUpdate(state, wall);
    peer.stats.mediaSyncPublished += 1;
    if (res.state?.targetId) {
      peer.lastMediaStates.set(res.state.targetId, res.state);
    }
    this._mediaSyncEvents.push({
      tBase: this.clock.nowBaseMs,
      peerId: peer.peerId,
      direction: "publish",
      state: res.state,
    });
    this.executeActions(peer.peerId, res.actions, {
      source: "media_sync_update",
      isLocalOrigin: true,
      isMediaSync: true,
    });
    return res;
  }

  getMediaSyncState(peerId, targetId = "watch") {
    const peer = this.peers.get(String(peerId));
    if (!peer) return null;
    const res = peer.wasm.getMediaSync(peer.clock.wallNow());
    const list = res.states || [];
    return list.find((s) => s.targetId === targetId) || null;
  }

  getAllMediaSyncStates(peerId) {
    const peer = this.peers.get(String(peerId));
    if (!peer) return [];
    return peer.wasm.getMediaSync(peer.clock.wallNow()).states || [];
  }

  getPeerRttMs(peerId, remotePeerId) {
    const peer = this.peers.get(String(peerId));
    if (!peer) return null;
    const status = peer.wasm.call({ cmd: "get_status" }).status;
    const entry = (status.peers || []).find((p) => p.peerId === String(remotePeerId));
    return entry ? entry.rttMs : null;
  }

  /**
   * Executes WASM `MeshAction` arrays returned by `peer_connected`, `wireMessage`,
   * `mediaSyncUpdate`, `keepalive_ping`, etc.
   */
  executeActions(fromPeerId, actions, meta = {}) {
    if (!Array.isArray(actions) || actions.length === 0) return;
    const peer = this.peers.get(String(fromPeerId));
    if (!peer) return;

    for (const act of actions) {
      if (!act) continue;
      if (act.action === "send_wire") {
        this._sendWire(peer, String(act.peerId), String(act.frame), meta);
      } else if (act.action === "media_sync" && act.state) {
        peer.lastMediaStates.set(act.state.targetId, act.state);
        if (!meta.isLocalOrigin) {
          peer.stats.mediaSyncReceived += 1;
          this._mediaSyncEvents.push({
            tBase: this.clock.nowBaseMs,
            peerId: peer.peerId,
            direction: "receive",
            fromPeerId: meta.fromPeerId || null,
            state: act.state,
          });
        }
        peer.onMediaSync?.(act.state, {
          isLocalOrigin: Boolean(meta.isLocalOrigin),
          fromPeerId: meta.fromPeerId || null,
          peer,
        });
        this.onMediaSync?.(peer.peerId, act.state, {
          isLocalOrigin: Boolean(meta.isLocalOrigin),
          fromPeerId: meta.fromPeerId || null,
        });
      }
      peer.onAction?.(act, meta);
      this.onAction?.(peer.peerId, act, meta);
    }
  }

  _sendWire(fromPeer, toPeerId, frameStr, meta = {}) {
    const tBase = this.clock.nowBaseMs;
    if (this.auditor) {
      this.auditor.audit(frameStr, {
        fromPeerId: fromPeer.peerId,
        toPeerId,
        tBase,
        source: meta.source || "unknown",
      });
    }

    fromPeer.stats.wireFramesSent += 1;
    fromPeer.stats.wireBytesSent += frameStr.length;

    const wireRecord = {
      tBase,
      fromPeerId: fromPeer.peerId,
      toPeerId,
      bytes: frameStr.length,
      frame: frameStr,
      source: meta.source || "unknown",
      isKeepalive: Boolean(meta.isKeepalive),
      isMediaSync: Boolean(meta.isMediaSync),
      dropped: false,
      duplicated: false,
      reordered: false,
    };
    this._wireEvents.push(wireRecord);
    this.onWireFrame?.(wireRecord);

    if (!this.isConnected(fromPeer.peerId, toPeerId) || this.isPartitioned(fromPeer.peerId, toPeerId)) {
      wireRecord.dropped = true;
      fromPeer.stats.framesDropped += 1;
      return;
    }

    const link = this.getLink(fromPeer.peerId, toPeerId);
    if (link.dropProb > 0 && this.prng.chance(link.dropProb)) {
      wireRecord.dropped = true;
      fromPeer.stats.framesDropped += 1;
      return;
    }

    let delayMs = this.prng.jitter(link.latencyMs, link.jitterMs);
    if (link.latencyMs > 0 && delayMs < 1) delayMs = 1;

    if (link.reorderProb > 0 && this.prng.chance(link.reorderProb)) {
      const extraDelay = this.prng.int(15, Math.max(35, Math.round(link.latencyMs * 2 + 20)));
      delayMs += extraDelay;
      wireRecord.reordered = true;
      fromPeer.stats.framesReordered += 1;
    }

    const connEpoch = this._linkEpochs.get(edgeKey(fromPeer.peerId, toPeerId)) || 0;
    const incomingIsKeepalive = Boolean(meta.isKeepalive);

    const scheduleDelivery = (deliverDelayMs, isDuplicate) => {
      const timerId = this.clock.schedule(deliverDelayMs, () => {
        this._pendingDeliveryTimers.delete(timerId);
        if (this._destroyed) return;
        this._deliverWire(fromPeer.peerId, toPeerId, frameStr, {
          isDuplicate,
          connEpoch,
          incomingIsKeepalive,
        });
      });
      this._pendingDeliveryTimers.add(timerId);
    };

    scheduleDelivery(delayMs, false);

    if (link.dupProb > 0 && this.prng.chance(link.dupProb)) {
      wireRecord.duplicated = true;
      fromPeer.stats.framesDuplicated += 1;
      scheduleDelivery(delayMs + this.prng.int(1, 25), true);
    }
  }

  _deliverWire(fromPeerId, toPeerId, frameStr, { isDuplicate = false, connEpoch = 0, incomingIsKeepalive = false } = {}) {
    const ek = edgeKey(fromPeerId, toPeerId);
    if (!this._connections.has(ek) || (this._linkEpochs.get(ek) || 0) !== connEpoch) {
      return;
    }
    if (this.isPartitioned(fromPeerId, toPeerId)) {
      return;
    }
    const toPeer = this.peers.get(toPeerId);
    if (!toPeer) return;

    toPeer.stats.wireFramesReceived += 1;
    toPeer.stats.wireBytesReceived += frameStr.length;

    let res;
    try {
      res = toPeer.wasm.wireMessage(fromPeerId, frameStr, toPeer.clock.wallNow());
    } catch (err) {
      const msg = String(err?.message || err);
      if (/replayed|out-of-window/i.test(msg)) {
        toPeer.stats.replayRejections += 1;
      } else {
        toPeer.stats.authErrors += 1;
      }
      toPeer.onWireError?.(err, { fromPeerId, isDuplicate });
      return;
    }

    const actions = res.actions || [];
    const hasMediaSync = actions.some((a) => a.action === "media_sync");

    this.executeActions(toPeerId, actions, {
      source: "wire_message",
      fromPeerId,
      isLocalOrigin: false,
      isMediaSync: hasMediaSync,
      isKeepalive: incomingIsKeepalive,
    });
  }

  getWireEvents({ sinceBaseMs = 0, untilBaseMs = Infinity, excludeKeepalive = false } = {}) {
    return this._wireEvents.filter(
      (ev) =>
        ev.tBase >= sinceBaseMs &&
        ev.tBase <= untilBaseMs &&
        (!excludeKeepalive || !ev.isKeepalive)
    );
  }

  getMediaSyncEvents({ sinceBaseMs = 0, untilBaseMs = Infinity, direction = null } = {}) {
    return this._mediaSyncEvents.filter(
      (ev) =>
        ev.tBase >= sinceBaseMs &&
        ev.tBase <= untilBaseMs &&
        (!direction || ev.direction === direction)
    );
  }

  getWireCounters() {
    const byPeer = {};
    let totalSent = 0;
    let totalReceived = 0;
    let totalDropped = 0;
    let totalMediaSyncPublished = 0;
    for (const [id, peer] of this.peers.entries()) {
      byPeer[id] = { ...peer.stats };
      totalSent += peer.stats.wireFramesSent;
      totalReceived += peer.stats.wireFramesReceived;
      totalDropped += peer.stats.framesDropped;
      totalMediaSyncPublished += peer.stats.mediaSyncPublished;
    }
    return {
      totalSent,
      totalReceived,
      totalDropped,
      totalMediaSyncPublished,
      auditedCount: this.auditor ? this.auditor.auditedCount : 0,
      auditViolations: this.auditor ? this.auditor.violations.length : 0,
      byPeer,
    };
  }

  destroy() {
    this._destroyed = true;
    this.stopKeepaliveLoop();
    for (const timerId of this._pendingDeliveryTimers) {
      this.clock.cancel(timerId);
    }
    this._pendingDeliveryTimers.clear();
  }
}

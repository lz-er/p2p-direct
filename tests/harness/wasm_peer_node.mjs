/**
 * Real-WASM Watch Together peer wrapper (`WasmPeerNode`) and multi-peer room orchestrator (`SimRoom`).
 *
 * Combines:
 * - Real compiled Safe Rust `p2p_mesh.wasm` via `SimulatedNetwork`
 * - Real `MediaSyncController` (`media_sync_controller.js`)
 * - Real `WatchTogetherPlayer` (`watch_together.js`) with per-peer `VirtualClock.forPeer(...)`
 *   scheduler, async `FakeProviderAdapter`s (`sdkLoaders` + `env`), and `onDebugEvent` wired into
 *   `TimelineLog` (plus optional `WatchTraceRecorder`).
 */

import { MediaSyncController, WatchTraceRecorder } from "../../media_sync_controller.js";
import { projectMediaPositionMs } from "../../watch_together.js";
import { createPrng } from "./prng.mjs";
import { VirtualClock } from "./virtual_clock.mjs";
import { SimulatedNetwork } from "./sim_network.mjs";
import { createFakeSdkLoaders, createMockDocument } from "./fake_providers/base_adapter.mjs";
import { FakeYouTubeAdapter } from "./fake_providers/youtube_adapter.mjs";
import { FakeSoundCloudAdapter } from "./fake_providers/soundcloud_adapter.mjs";
import { FakeSpotifyAdapter } from "./fake_providers/spotify_adapter.mjs";
import { FakeTwitchAdapter } from "./fake_providers/twitch_adapter.mjs";
import {
  TimelineLog,
  checkBoundedConvergence,
  checkFaultIsolation,
  checkLocalOnlyPrivacy,
  checkTimerHygiene,
  checkUserIntentPreservation,
  checkZeroOscillationAndWireCap,
} from "./invariants.mjs";

function compactData(data) {
  if (data === null || data === undefined) return "";
  try {
    const s = JSON.stringify(data);
    return s.length > 160 ? `${s.slice(0, 157)}...` : s;
  } catch {
    return "";
  }
}

export class WasmPeerNode {
  /**
   * Use `WasmPeerNode.create(options)` (async) to instantiate with a real WASM node.
   */
  constructor({
    net,
    clock,
    prng,
    peer,
    timeline = null,
    adaptersConfig = {},
    syncConfig = undefined,
    peerStaggerMs = undefined,
    recordDebugToTimeline = true,
    enableTraceRecorder = false,
    onDebugEvent = null,
    onEmittedEvent = null,
    onToast = null,
    onTelemetry = null,
  }) {
    this.net = net;
    this.rootClock = clock;
    this.prng = prng;
    this.peer = peer;
    this.peerId = peer.peerId;
    this.authorName = peer.authorName;
    this.clock = peer.clock; // VirtualClock.forPeer(...) scheduler
    this.timeline = timeline;
    this.recordDebugToTimeline = Boolean(recordDebugToTimeline);
    this._externalOnDebugEvent = typeof onDebugEvent === "function" ? onDebugEvent : null;
    this._onEmittedEvent = typeof onEmittedEvent === "function" ? onEmittedEvent : null;

    this.document = createMockDocument({ theme: "dark" });
    this.mountEl = this.document.createElement("div");
    this.mountEl.id = `watch-stage-${this.peerId}`;

    const ytCfg = adaptersConfig.youtube || adaptersConfig.ytmusic || {};
    const scCfg = adaptersConfig.soundcloud || {};
    const spCfg = adaptersConfig.spotify || {};
    const twCfg = adaptersConfig.twitch || {};

    this.adapters = {
      youtube: new FakeYouTubeAdapter({
        clock: this.rootClock,
        prng: this.prng.fork(`yt:${this.peerId}`),
        peerId: this.peerId,
        document: this.document,
        mountEl: this.mountEl,
        timeline: this.recordDebugToTimeline ? this.timeline : null,
        config: ytCfg,
      }),
      soundcloud: new FakeSoundCloudAdapter({
        clock: this.rootClock,
        prng: this.prng.fork(`sc:${this.peerId}`),
        peerId: this.peerId,
        document: this.document,
        mountEl: this.mountEl,
        timeline: this.recordDebugToTimeline ? this.timeline : null,
        config: scCfg,
      }),
      spotify: new FakeSpotifyAdapter({
        clock: this.rootClock,
        prng: this.prng.fork(`sp:${this.peerId}`),
        peerId: this.peerId,
        document: this.document,
        mountEl: this.mountEl,
        timeline: this.recordDebugToTimeline ? this.timeline : null,
        config: spCfg,
      }),
      twitch: new FakeTwitchAdapter({
        clock: this.rootClock,
        prng: this.prng.fork(`tw:${this.peerId}`),
        peerId: this.peerId,
        document: this.document,
        mountEl: this.mountEl,
        timeline: this.recordDebugToTimeline ? this.timeline : null,
        config: twCfg,
      }),
    };

    this.sdkLoaders = createFakeSdkLoaders(this.adapters);
    this.env = {
      ...this.adapters.spotify.createEnv(),
      document: this.document,
      createElement: (tag) => this.document.createElement(tag),
      origin: "https://sim.local",
      hostname: "sim.local",
      isDark: true,
    };

    this.traceRecorder = enableTraceRecorder
      ? new WatchTraceRecorder({
          maxEntries: 2000,
          enabled: true,
          scheduler: this.clock,
        })
      : null;

    this.emittedEvents = [];
    this.toasts = [];
    this.telemetry = [];
    this.destroyed = false;
    this._reloading = false;
    this._ownTimers = new Set();
    this._staleCallbackEvents = [];
    this._lastStatus = null;

    const handleDebugEvent = (ev) => {
      if (this.destroyed) {
        this._staleCallbackEvents.push({
          tBase: this.rootClock.nowBaseMs,
          peerId: this.peerId,
          kind: `stale:${ev?.src}:${ev?.ev}`,
          detail: compactData(ev?.data),
        });
        return;
      }
      if (ev && ev.dir === "out" && (ev.ev === "onUserAction" || ev.ev === "onNegotiateState")) {
        this._recordEmittedEvent(ev.ev, ev.data);
      }
      if (this.traceRecorder && this.traceRecorder.isEnabled()) {
        this.traceRecorder.record(ev);
      }
      if (this.timeline && this.recordDebugToTimeline) {
        this.timeline.record({
          tBase: this.rootClock.nowBaseMs,
          peerId: this.peerId,
          kind: `${ev.src}:${ev.dir}:${ev.ev}`,
          detail: compactData(ev.data),
        });
      }
      if (this._externalOnDebugEvent) {
        this._externalOnDebugEvent(ev, this);
      }
    };

    const needsDebugSink = Boolean(
      (this.timeline && this.recordDebugToTimeline) ||
        this.traceRecorder ||
        this._externalOnDebugEvent
    );

    // Transparent WASM facade so MediaSyncController's mediaSyncUpdate flows through
    // SimulatedNetwork.publishMediaSync (enforcing E2EEWireAuditor + stats + mediaSyncEvents).
    const wasmFacade = {
      mediaSyncUpdate: (merged, nowMs) => {
        const source = this.controller?.watchApplySource || "local-ui";
        const payload = {
          source,
          active: merged.active,
          playing: merged.playing,
          positionMs: merged.positionMs,
          rateMilli: merged.rateMilli,
          provider: merged.provider,
          mediaId: merged.mediaId,
          playlistIndex: merged.playlistIndex,
        };
        if (!needsDebugSink) {
          if (source === "local-embed") {
            this._recordEmittedEvent("onUserAction", payload);
          } else if (source === "negotiated") {
            this._recordEmittedEvent("onNegotiateState", payload);
          }
        }
        this._recordEmittedEvent("mediaSyncUpdate", payload);
        return this.net.publishMediaSync(this.peerId, merged, nowMs);
      },
      getMediaSync: (nowMs) => this.peer.wasm.getMediaSync(nowMs),
      call: (req) => this.peer.wasm.call(req),
    };

    const playerOptions = {
      sdkLoaders: this.sdkLoaders,
      env: this.env,
      ...(syncConfig ? { syncConfig } : {}),
      ...(peerStaggerMs !== undefined ? { peerStaggerMs } : {}),
    };

    this.controller = new MediaSyncController({
      wasm: wasmFacade,
      mountEl: this.mountEl,
      scheduler: this.clock,
      random: () => this.prng.next(),
      getPeerId: () => this.peerId,
      getAuthorName: () => this.authorName,
      // net.publishMediaSync already executes all returned actions (send_wire + local media_sync)
      executeActions: null,
      onStatus: (status) => {
        this._lastStatus = status;
      },
      onToast: (msg) => {
        this.toasts.push({ tBase: this.rootClock.nowBaseMs, message: msg });
        if (typeof onToast === "function") onToast(msg, this);
      },
      onTelemetry: (level, detail) => {
        this.telemetry.push({ tBase: this.rootClock.nowBaseMs, level, detail });
        if (typeof onTelemetry === "function") onTelemetry(level, detail, this);
      },
      onDebugEvent: needsDebugSink ? handleDebugEvent : null,
      playerOptions,
    });

    this.peer.onMediaSync = (state) => {
      if (this.destroyed) {
        this._staleCallbackEvents.push({
          tBase: this.rootClock.nowBaseMs,
          peerId: this.peerId,
          kind: "stale:onMediaSync",
          detail: `rev=${state?.rev}`,
        });
        return;
      }
      this.controller.handleIncomingMediaSync(state);
    };
  }

  static async create({
    net,
    clock,
    prng = null,
    peerId,
    authorName = undefined,
    wallSkewMs = 0,
    clockDriftPpm = 0,
    sleepWindows = [],
    autoMeshEnabled = undefined,
    maxDirectPeers = undefined,
    timeline = null,
    adaptersConfig = {},
    syncConfig = undefined,
    peerStaggerMs = undefined,
    recordDebugToTimeline = true,
    enableTraceRecorder = false,
    onDebugEvent = null,
    onEmittedEvent = null,
    onToast = null,
    onTelemetry = null,
  }) {
    if (!net || !clock) {
      throw new Error("WasmPeerNode.create requires `net` and `clock`");
    }
    const peer = await net.addPeer(peerId, {
      authorName: authorName || peerId,
      wallSkewMs,
      clockDriftPpm,
      sleepWindows,
      autoMeshEnabled,
      maxDirectPeers,
    });
    const nodePrng = prng || net.prng.fork(`node:${peer.peerId}`);
    return new WasmPeerNode({
      net,
      clock,
      prng: nodePrng,
      peer,
      timeline: timeline ?? net.timeline ?? null,
      adaptersConfig,
      syncConfig,
      peerStaggerMs,
      recordDebugToTimeline,
      enableTraceRecorder,
      onDebugEvent,
      onEmittedEvent,
      onToast,
      onTelemetry,
    });
  }

  _recordEmittedEvent(kind, data) {
    const rec = {
      tBase: this.rootClock.nowBaseMs,
      peerId: this.peerId,
      kind,
      data,
    };
    this.emittedEvents.push(rec);
    if (this._onEmittedEvent) {
      this._onEmittedEvent(rec);
    }
  }

  _scheduleOwnTimer(delayMs, fn) {
    let id = null;
    id = this.rootClock.schedule(
      Math.max(0, Number(delayMs) || 0),
      () => {
        this._ownTimers.delete(id);
        if (this.destroyed) return;
        fn();
      },
      { peerId: `${this.peerId}:node`, kind: "node-helper" }
    );
    this._ownTimers.add(id);
    return id;
  }

  /* ==================== Provider & Adapter Accessors ==================== */

  activeProvider() {
    return this.controller.getWatchState()?.provider || this.controller.watchPlayer?.provider || "";
  }

  getAdapter(provider = this.activeProvider()) {
    if (provider === "youtube" || provider === "ytmusic") return this.adapters.youtube;
    if (provider === "soundcloud") return this.adapters.soundcloud;
    if (provider === "spotify") return this.adapters.spotify;
    if (provider === "twitch") return this.adapters.twitch;
    return null;
  }

  activeAdapter() {
    return this.getAdapter(this.activeProvider());
  }

  allAdapters() {
    return [
      this.adapters.youtube,
      this.adapters.soundcloud,
      this.adapters.spotify,
      this.adapters.twitch,
    ];
  }

  getPlayer() {
    return this.controller.watchPlayer;
  }

  getWasmState(targetId = "watch") {
    return this.net.getMediaSyncState(this.peerId, targetId);
  }

  getControllerState(targetId = "watch") {
    return this.controller.getState(targetId);
  }

  /* ==================== High-Level UI / Controller Actions ==================== */

  startUrl(url, sourceMsgId = "") {
    return this.controller.startWatchTogetherFromUrl(url, sourceMsgId);
  }

  enqueue(url) {
    return this.controller.enqueueWatchUrl(url);
  }

  togglePlay() {
    return this.controller.toggleWatchPlay();
  }

  play() {
    const st = this.controller.getWatchState();
    if (st && st.active && !st.playing) {
      this.controller.toggleWatchPlay();
    }
  }

  pause() {
    const st = this.controller.getWatchState();
    if (st && st.active && st.playing) {
      this.controller.toggleWatchPlay();
    }
  }

  seekBy(deltaMs) {
    return this.controller.seekWatchBy(deltaMs);
  }

  seekTo(posMs) {
    return this.controller.seekWatchTo(posMs);
  }

  setPlaybackRate(rateMilli) {
    return this.controller.setWatchPlaybackRate(rateMilli);
  }

  replay() {
    return this.controller.replayWatch();
  }

  toggleLoop() {
    return this.controller.toggleWatchLoop();
  }

  selectPlaylistTrack(idx) {
    return this.controller.selectWatchPlaylistTrack(idx);
  }

  playNext() {
    return this.controller.playNextWatchTrackOrQueue();
  }

  playPrev() {
    return this.controller.playPrevWatchTrack();
  }

  playQueueItemAt(idx) {
    return this.controller.playWatchQueueItemAt(idx);
  }

  removeQueueItem(idx) {
    return this.controller.removeWatchQueueItem(idx);
  }

  stop() {
    return this.controller.stopWatchTogetherForRoom();
  }

  /* ==================== High-Level Embed Adapter Actions ==================== */

  embedPlay(opts) {
    return this.activeAdapter()?.userPlay(opts);
  }

  embedPause() {
    return this.activeAdapter()?.userPause();
  }

  embedClickSeek(targetMs, opts) {
    return this.activeAdapter()?.userClickSeek(targetMs, opts);
  }

  embedBufferedSeek(targetMs) {
    return this.activeAdapter()?.userBufferedSeek(targetMs);
  }

  embedPausedSeek(targetMs) {
    return this.activeAdapter()?.userPausedSeek(targetMs);
  }

  embedDragScrub(targetMs, opts) {
    return this.activeAdapter()?.userDragScrub(targetMs, opts);
  }

  embedRapidToggle(count = 2, intervalMs = 80) {
    return this.activeAdapter()?.userRapidToggle(count, intervalMs);
  }

  embedSelectPlaylistTrack(indexOrUri, opts) {
    return this.activeAdapter()?.userSelectPlaylistTrack(indexOrUri, opts);
  }

  /* ==================== Local-Only Actions (Zero Wire Traffic) ==================== */

  setLocalVolume(vol0To100) {
    return this.controller.setWatchLocalVolume(vol0To100);
  }

  setLocalMuted(muted) {
    return this.controller.setWatchLocalMuted(muted);
  }

  toggleLocalMute() {
    return this.controller.toggleWatchLocalMute();
  }

  showSpotifyPlaylist() {
    return this.controller.showWatchSpotifyPlaylist();
  }

  async reloadPlayerSession(opts = { reason: "manual" }) {
    this._reloading = true;
    try {
      return await this.controller.reloadWatchPlayerSession(opts);
    } finally {
      this._reloading = false;
    }
  }

  /* ==================== Tab Sleep / Wake ==================== */

  addSleepWindow(startMs, endMs) {
    this.clock.addSleepWindow(startMs, endMs);
  }

  setSleepWindows(windows) {
    this.clock.setSleepWindows(windows);
  }

  isSleeping() {
    return this.clock.isSleeping();
  }

  /**
   * Puts this peer's tab to sleep for `durationMs` starting at current VirtualClock time.
   * When `freezePlayhead` is true (default, simulating OS suspend / backgrounded media freeze),
   * the active adapter's playhead stalls during the sleep window and resumes cleanly right before
   * the deferred wake timer fires, exercising `WatchSyncNegotiator`'s `tab-wake-resync` path.
   */
  sleepFor(durationMs, { freezePlayhead = true } = {}) {
    const dur = Math.max(10, Math.round(Number(durationMs) || 3000));
    const startMs = this.rootClock.nowBaseMs;
    const endMs = startMs + dur;
    this.clock.addSleepWindow(startMs, endMs);
    this.timeline?.record({
      tBase: startMs,
      peerId: this.peerId,
      kind: "peer:sleep",
      detail: `${startMs}..${endMs}ms (freeze=${freezePlayhead})`,
    });

    if (freezePlayhead) {
      const adapter = this.activeAdapter();
      if (adapter && !adapter.destroyed) {
        adapter._syncPhysics();
        adapter.stalled = true;
        this._scheduleOwnTimer(Math.max(1, dur - 1), () => {
          if (!adapter.destroyed) {
            adapter._syncPhysics();
            adapter.stalled = false;
            adapter._physicsLastBaseMs = adapter._nowBaseMs();
          }
          this.timeline?.record({
            tBase: this.rootClock.nowBaseMs,
            peerId: this.peerId,
            kind: "peer:wake",
            detail: `woke after ${dur}ms`,
          });
        });
      }
    }
    return { startMs, endMs };
  }

  /* ==================== Fault Injection ==================== */

  injectRebuffer(durationMs = 1500, provider = undefined) {
    const adapter = provider ? this.getAdapter(provider) : this.activeAdapter();
    adapter?.injectRebuffer(durationMs);
  }

  injectError(codeOrMessage = 150, provider = undefined) {
    const adapter = provider ? this.getAdapter(provider) : this.activeAdapter();
    adapter?.injectError(codeOrMessage);
  }

  recoverFromError(nextState = undefined, provider = undefined) {
    const adapter = provider ? this.getAdapter(provider) : this.activeAdapter();
    if (adapter && typeof adapter.recoverFromError === "function") {
      adapter.recoverFromError(nextState);
    }
  }

  injectSnip(opts = {}, provider = undefined) {
    const adapter = provider ? this.getAdapter(provider) : this.activeAdapter();
    adapter?.injectSnip(opts);
  }

  injectBlock(trackIndex = null) {
    this.adapters.soundcloud.injectBlock(trackIndex);
  }

  injectAutoplayBlock(blocked = true, provider = undefined) {
    if (provider) {
      this.getAdapter(provider)?.injectAutoplayBlock(blocked);
      return;
    }
    for (const adapter of this.allAdapters()) {
      adapter.injectAutoplayBlock(blocked);
    }
  }

  injectDrmFailure() {
    this.adapters.spotify.injectDrmFailure();
  }

  setDrmSupported(supported) {
    this.adapters.spotify.setDrmSupported(supported);
  }

  injectOffline() {
    this.adapters.twitch.injectOffline();
  }

  injectOnline() {
    this.adapters.twitch.injectOnline();
  }

  setAdapterConfig(provider, patch = {}) {
    const adapter = this.getAdapter(provider);
    if (adapter && patch && typeof patch === "object") {
      Object.assign(adapter.config, patch);
    }
  }

  /* ==================== Inspection, Snapshots & Hygiene ==================== */

  getCommandLog(opts = {}) {
    const out = [];
    for (const adapter of this.allAdapters()) {
      for (const c of adapter.getCommandLog(opts)) {
        out.push({ provider: adapter.provider, ...c });
      }
    }
    out.sort((a, b) => a.tBase - b.tBase);
    return out;
  }

  isPreviewOutOfRange(wasmState = this.getWasmState("watch"), snap = this.activeAdapter()?.snapshot()) {
    if (!snap || !wasmState || !wasmState.active) return false;
    const previewLimitMs =
      snap.previewDurationMs > 0
        ? snap.previewDurationMs
        : snap.isPreview && snap.durationMs > 0
          ? snap.durationMs
          : 0;
    if (!snap.isPreview || previewLimitMs <= 0) return false;
    const expectedMs = projectMediaPositionMs(wasmState, this.clock.wallNow());
    return (
      expectedMs > previewLimitMs ||
      (!snap.playing && snap.positionMs >= previewLimitMs - 600)
    );
  }

  isHealthy(wasmState = this.getWasmState("watch"), snap = this.activeAdapter()?.snapshot()) {
    if (this.destroyed || this._reloading || this.isSleeping()) return false;
    if (!snap) return false;
    if (snap.errored || snap.blocked || snap.offline) return false;
    if (snap.autoplayBlocked && (!wasmState || wasmState.playing)) return false;
    if (this.isPreviewOutOfRange(wasmState, snap)) return false;
    return true;
  }

  sampleView() {
    const wasmState = this.getWasmState("watch");
    const adapter = this.activeAdapter();
    const snap = adapter ? adapter.snapshot() : null;
    const previewOutOfRange = this.isPreviewOutOfRange(wasmState, snap);
    const autoplayBlocked = Boolean(snap?.autoplayBlocked && (!wasmState || wasmState.playing));
    const sleeping = this.isSleeping();
    const healthy = Boolean(
      !this.destroyed &&
        !this._reloading &&
        !sleeping &&
        snap &&
        !snap.errored &&
        !snap.blocked &&
        !snap.offline &&
        !autoplayBlocked &&
        !previewOutOfRange
    );
    return {
      tBase: this.rootClock.nowBaseMs,
      peerId: this.peerId,
      provider: snap?.provider || wasmState?.provider || "",
      playing: snap ? snap.playing : false,
      positionMs: snap && snap.hasPosition !== false ? snap.positionMs : undefined,
      buffering: Boolean(snap?.buffering || snap?.stalled),
      unstarted: Boolean(snap?.unstarted),
      ended: Boolean(snap?.ended),
      errored: Boolean(snap?.errored),
      blocked: Boolean(snap?.blocked || snap?.offline),
      autoplayBlocked,
      reloading: this._reloading,
      sleeping,
      isPreviewOutOfRange: previewOutOfRange,
      healthy,
    };
  }

  convergenceView({ partitioned = false, disconnected = false } = {}) {
    const wasmState = this.getWasmState("watch");
    const adapter = this.activeAdapter();
    const snap = adapter ? adapter.snapshot() : null;
    const previewOutOfRange = this.isPreviewOutOfRange(wasmState, snap);
    const autoplayBlocked = Boolean(snap?.autoplayBlocked && (!wasmState || wasmState.playing));
    const sleeping = this.isSleeping();
    return {
      peerId: this.peerId,
      provider: snap?.provider || wasmState?.provider || "",
      wasmState,
      playerSnapshot: snap,
      wallNowMs: this.clock.wallNow(),
      partitioned: Boolean(partitioned),
      disconnected: Boolean(disconnected),
      errored: Boolean(snap?.errored),
      blocked: Boolean(snap?.blocked || snap?.offline),
      autoplayBlocked,
      reloading: this._reloading,
      sleeping,
      isPreviewOutOfRange: previewOutOfRange,
      healthy:
        !partitioned &&
        !disconnected &&
        this.isHealthy(wasmState, snap),
    };
  }

  exportWatchTrace(appVersion = "v25") {
    if (!this.traceRecorder) return null;
    const watchSt = this.controller.getWatchState();
    const watchState = watchSt
      ? {
          active: Boolean(watchSt.active),
          playing: Boolean(watchSt.playing),
          provider: watchSt.provider || "",
          mediaId: watchSt.mediaId || "",
          playlistId: watchSt.playlistId || "",
          playlistIndex: Number(watchSt.playlistIndex) || 0,
          trackUri: watchSt.trackUri || "",
          positionMs: Number(watchSt.positionMs) || 0,
          projectedPosMs: watchSt.active ? projectMediaPositionMs(watchSt, this.clock.wallNow()) : 0,
          rateMilli: Number(watchSt.rateMilli) || 1000,
          loop: Boolean(watchSt.loop),
          rev: Number(watchSt.rev) || 0,
          epoch: Number(watchSt.epoch) || 0,
          actor: watchSt.actor || "",
          actorName: watchSt.actorName || "",
          queueLength: Array.isArray(watchSt.queue) ? watchSt.queue.length : 0,
        }
      : null;
    return this.traceRecorder.exportTrace({
      appVersion,
      peerId: this.peerId,
      watchState,
      watchNotice: this.controller.getWatchNotice(),
    });
  }

  peerTimerCount() {
    return this.clock.activeTimerCount();
  }

  adapterTimerCount() {
    let total = 0;
    for (const adapter of this.allAdapters()) {
      total += adapter.activeTimerCount();
    }
    return total;
  }

  activeTimerCount() {
    return this.peerTimerCount() + this._ownTimers.size + this.adapterTimerCount();
  }

  destroy() {
    this.destroyed = true;
    for (const id of [...this._ownTimers]) {
      this.rootClock.cancel(id);
    }
    this._ownTimers.clear();
    this.controller.destroy();
    for (const adapter of this.allAdapters()) {
      adapter.destroy();
    }
  }
}

export async function createWasmPeerNode(options) {
  return WasmPeerNode.create(options);
}

/**
 * Convenience multi-peer simulation room wrapping `VirtualClock`, `SimulatedNetwork`,
 * `TimelineLog`, `WasmPeerNode`s, and Layer 2 invariant evaluation.
 */
export class SimRoom {
  constructor({
    seed = 1,
    startWallMs = 1_700_000_000_000,
    room = "sim-room",
    autoMeshEnabled = false,
    keepaliveIntervalMs = 0,
    timelineMaxEntries = 5000,
    recordDebugToTimeline = true,
  } = {}) {
    this.seed = seed;
    this.prng = createPrng(seed);
    this.clock = new VirtualClock({ startWallMs });
    this.timeline = new TimelineLog({ maxEntries: timelineMaxEntries });
    this.recordDebugToTimeline = Boolean(recordDebugToTimeline);
    this.net = new SimulatedNetwork({
      clock: this.clock,
      prng: this.prng.fork("net"),
      room,
      autoMeshEnabled,
      keepaliveIntervalMs,
      timeline: this.recordDebugToTimeline ? this.timeline : null,
    });
    this.nodes = new Map();
    this.emittedEvents = [];
    this.userIntents = [];
    this.stateSamples = [];
    this.faultyPeers = [];
    this.localOnlyWindows = [];
    this._partitionedPeerIds = new Set();
  }

  async addPeer(peerId, opts = {}) {
    const node = await WasmPeerNode.create({
      net: this.net,
      clock: this.clock,
      prng: this.prng.fork(`node:${peerId}`),
      peerId,
      timeline: this.timeline,
      recordDebugToTimeline: this.recordDebugToTimeline,
      onEmittedEvent: (ev) => this.emittedEvents.push(ev),
      ...opts,
    });
    this.nodes.set(node.peerId, node);
    return node;
  }

  getPeer(peerId) {
    return this.nodes.get(String(peerId)) || null;
  }

  peers() {
    return [...this.nodes.values()];
  }

  peerIds() {
    return [...this.nodes.keys()];
  }

  connect(a, b, linkOpts = null) {
    return this.net.connect(a, b, linkOpts);
  }

  disconnect(a, b) {
    return this.net.disconnect(a, b);
  }

  connectFullMesh(linkOpts = null) {
    return this.net.connectFullMesh(linkOpts);
  }

  connectChain(ids, linkOpts = null) {
    return this.net.connectChain(ids, linkOpts);
  }

  setLink(a, b, config = {}) {
    return this.net.setLink(a, b, config);
  }

  partition(groupA, groupB) {
    for (const id of groupB) this._partitionedPeerIds.add(String(id));
    return this.net.partition(groupA, groupB);
  }

  healAll() {
    this._partitionedPeerIds.clear();
    return this.net.healAll();
  }

  sendKeepalivePings(peerId = null) {
    return this.net.sendKeepalivePings(peerId);
  }

  sampleAll() {
    for (const node of this.nodes.values()) {
      const sample = node.sampleView();
      if (this._partitionedPeerIds.has(node.peerId)) {
        sample.healthy = false;
      }
      this.stateSamples.push(sample);
    }
  }

  async advanceAndSample(totalMs, stepMs = 350) {
    const target = this.clock.nowBaseMs + Math.max(0, Number(totalMs) || 0);
    const step = Math.max(25, Number(stepMs) || 350);
    while (this.clock.nowBaseMs < target) {
      const next = Math.min(target, this.clock.nowBaseMs + step);
      await this.clock.advanceTo(next);
      this.sampleAll();
    }
  }

  recordIntent(peerId, intent = {}) {
    const entry = {
      tBase: this.clock.nowBaseMs,
      peerId: String(peerId),
      ...intent,
    };
    this.userIntents.push(entry);
    return entry;
  }

  recordFaultWindow(peerId, faultKind, startMs = this.clock.nowBaseMs, endMs = Infinity) {
    const win = { peerId: String(peerId), faultKind, startMs, endMs };
    this.faultyPeers.push(win);
    return win;
  }

  async runLocalOnly(peerId, action, fn, padMs = 50) {
    const startMs = this.clock.nowBaseMs;
    const startWireIndex = this.net.getWireEvents().length;
    const res = await fn();
    const endMs = Math.max(startMs + padMs, this.clock.nowBaseMs + padMs);
    const endWireIndex = padMs === 0 ? this.net.getWireEvents().length : null;
    this.localOnlyWindows.push({
      peerId: String(peerId),
      action,
      startMs,
      endMs,
      startWireIndex,
      ...(endWireIndex !== null ? { endWireIndex } : {}),
    });
    return res;
  }

  evaluatePreTeardownInvariants({
    steadyStartMs = 0,
    steadyEndMs = this.clock.nowBaseMs,
    healthyPeerIds = null,
    requireActive = true,
    maxYankMs = 1500,
    convergenceBudgetMs = 4500,
    convergenceToleranceMs = 2200,
    spotifyConvergenceToleranceMs = 3000,
    yankGraceAfterActionMs = 1,
    maxMediaSyncWireUpdates = 0,
    maxAdapterCmdsPerPeer = 2,
    checkIntent = true,
  } = {}) {
    const inv1 = checkIntent
      ? checkUserIntentPreservation({
          actions: this.userIntents,
          samples: this.stateSamples,
          healthyPeerIds,
          maxYankMs,
          convergenceBudgetMs,
          convergenceToleranceMs,
          spotifyConvergenceToleranceMs,
          yankGraceAfterActionMs,
        })
      : { ok: true, invariant: "UserIntentPreservation", violations: [], summary: "UserIntentPreservation: SKIP" };

    const inv2 = checkBoundedConvergence({
      peers: this.peers().map((node) =>
        node.convergenceView({
          partitioned: this._partitionedPeerIds.has(node.peerId),
        })
      ),
      toleranceMs: convergenceToleranceMs,
      spotifyToleranceMs: spotifyConvergenceToleranceMs,
      requireActive,
    });

    const adapterCmdsByPeer = {};
    for (const node of this.peers()) {
      adapterCmdsByPeer[node.peerId] = node.getCommandLog({
        sinceBaseMs: steadyStartMs,
        untilBaseMs: steadyEndMs,
      });
    }

    const inv3 = checkZeroOscillationAndWireCap({
      mediaSyncWireEvents: this.net.getMediaSyncEvents({
        sinceBaseMs: steadyStartMs,
        untilBaseMs: steadyEndMs,
      }),
      adapterCmdsByPeer,
      maxMediaSyncWireUpdates,
      maxAdapterCmdsPerPeer,
    });

    const inv4 = checkFaultIsolation({
      faultyPeers: this.faultyPeers,
      events: this.emittedEvents,
    });

    const inv5 = checkLocalOnlyPrivacy({
      localOnlyWindows: this.localOnlyWindows,
      wireEvents: this.net.getWireEvents(),
      wireAuditor: this.net.auditor,
    });

    return [inv1, inv2, inv3, inv4, inv5];
  }

  destroyAndCheckTimerHygiene() {
    const allAdapters = [];
    const staleEvents = [];
    for (const node of this.nodes.values()) {
      allAdapters.push(...node.allAdapters());
      node.destroy();
      staleEvents.push(...node._staleCallbackEvents);
    }
    this.net.destroy();

    return checkTimerHygiene({
      clock: this.clock,
      peerIds: this.peerIds(),
      adapters: allAdapters,
      staleCallbackEvents: staleEvents,
      checkGlobalClock: true,
    });
  }

  destroy() {
    for (const node of this.nodes.values()) {
      node.destroy();
    }
    this.net.destroy();
  }
}

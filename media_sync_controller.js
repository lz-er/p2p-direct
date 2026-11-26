/**
 * DOM-optional Watch Together & MediaSync coordination controller + opt-in WatchTraceRecorder.
 *
 * Designed so both `P2PDirectApp` (browser) and deterministic Node.js simulation harnesses
 * can wire real `SafeRustWasmMesh` + `MediaSyncController` + `WatchTogetherPlayer` with an
 * injected virtual clock (`scheduler`) and deterministic RNG (`random`), zero global timer leaks,
 * and zero overhead when debug tracing is disabled.
 */

import {
  WatchTogetherPlayer,
  createDefaultScheduler,
  parseWatchMediaUrl,
  projectMediaPositionMs,
  sanitizeWatchDebugValue,
} from "./watch_together.js";

export const WATCH_TRACE_DEFAULT_MAX_ENTRIES = 2000;

/**
 * Lightweight opt-in sanitized ring buffer for Watch Together player & sync diagnostics.
 * Zero allocations / zero overhead when disabled (`getSink()` returns `null`).
 */
export class WatchTraceRecorder {
  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries=2000]
   * @param {boolean} [options.enabled=false]
   * @param {{perfNow?: () => number, wallNow?: () => number}} [options.scheduler]
   * @param {() => void} [options.onChange]
   */
  constructor(options = {}) {
    this.maxEntries = Math.max(
      1,
      Math.floor(Number(options.maxEntries) || WATCH_TRACE_DEFAULT_MAX_ENTRIES)
    );
    this._scheduler = createDefaultScheduler(options.scheduler);
    this._onChange = typeof options.onChange === "function" ? options.onChange : null;
    this._enabled = Boolean(options.enabled);
    this._buf = new Array(this.maxEntries);
    this._head = 0;
    this._size = 0;
    this._dropped = 0;
    this._seq = 0;
    this._boundRecord = (entry) => this.record(entry);
  }

  isEnabled() {
    return this._enabled;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this._enabled) return this._enabled;
    this._enabled = next;
    if (this._onChange) this._onChange();
    return this._enabled;
  }

  start() {
    return this.setEnabled(true);
  }

  stop() {
    return this.setEnabled(false);
  }

  clear() {
    this._buf = new Array(this.maxEntries);
    this._head = 0;
    this._size = 0;
    this._dropped = 0;
    this._seq = 0;
    if (this._onChange) this._onChange();
  }

  count() {
    return this._size;
  }

  dropped() {
    return this._dropped;
  }

  /**
   * Returns the bound event sink when enabled, or `null` when disabled so emitters can skip
   * instrumentation with a single falsy check and zero allocation.
   */
  getSink() {
    return this._enabled ? this._boundRecord : null;
  }

  record(entry) {
    if (!this._enabled || !entry || typeof entry !== "object") return;
    const sanitized = {
      seq: ++this._seq,
      tPerf:
        typeof entry.tPerf === "number" && Number.isFinite(entry.tPerf)
          ? Math.round(entry.tPerf)
          : Math.round(this._scheduler.perfNow()),
      tWall:
        typeof entry.tWall === "number" && Number.isFinite(entry.tWall)
          ? Math.round(entry.tWall)
          : Math.round(this._scheduler.wallNow()),
      src: typeof entry.src === "string" ? entry.src.slice(0, 32) : "watch",
      dir:
        entry.dir === "in" || entry.dir === "out" || entry.dir === "internal"
          ? entry.dir
          : "internal",
      ev: typeof entry.ev === "string" ? entry.ev.slice(0, 64) : "event",
      data:
        entry.data !== undefined && entry.data !== null
          ? sanitizeWatchDebugValue(entry.data)
          : null,
      getters:
        entry.getters !== undefined && entry.getters !== null
          ? sanitizeWatchDebugValue(entry.getters)
          : null,
    };
    const writeIdx = (this._head + this._size) % this.maxEntries;
    if (this._size < this.maxEntries) {
      this._buf[writeIdx] = sanitized;
      this._size += 1;
    } else {
      this._buf[this._head] = sanitized;
      this._head = (this._head + 1) % this.maxEntries;
      this._dropped += 1;
    }
    if (this._onChange) this._onChange();
  }

  getEntries() {
    const out = new Array(this._size);
    for (let i = 0; i < this._size; i++) {
      out[i] = this._buf[(this._head + i) % this.maxEntries];
    }
    return out;
  }

  exportTrace(meta = {}) {
    const wallNow = Math.round(this._scheduler.wallNow());
    const entries = this.getEntries();
    return {
      schema: "p2p-direct-watch-trace-v1",
      exportedAtMs: wallNow,
      exportedAtIso: new Date(wallNow).toISOString(),
      appVersion: typeof meta.appVersion === "string" ? meta.appVersion : "",
      peerId: typeof meta.peerId === "string" ? meta.peerId : "",
      maxEntries: this.maxEntries,
      dropped: this._dropped,
      count: entries.length,
      watchState: meta.watchState ? sanitizeWatchDebugValue(meta.watchState) : null,
      watchNotice: meta.watchNotice ? sanitizeWatchDebugValue(meta.watchNotice) : null,
      entries,
    };
  }
}

export function getWatchProviderLabel(provider) {
  if (provider === "ytmusic") return "YT MUSIC";
  if (provider === "youtube") return "YOUTUBE";
  if (provider === "spotify") return "SPOTIFY";
  if (provider === "soundcloud") return "SOUNDCLOUD";
  if (provider === "twitch") return "TWITCH";
  return String(provider || "WATCH").toUpperCase();
}

export function getWatchProviderFriendlyName(provider) {
  if (provider === "ytmusic") return "YouTube Music";
  if (provider === "youtube") return "YouTube";
  if (provider === "spotify") return "Spotify";
  if (provider === "soundcloud") return "SoundCloud";
  if (provider === "twitch") return "Twitch";
  return "Provider";
}

export function getTwitchEntityKind(state) {
  if (!state || state.provider !== "twitch") return "";
  const id = String(state.mediaId || "");
  if (id.startsWith("channel:")) return "channel";
  if (id.startsWith("clip:")) return "clip";
  if (id.startsWith("collection:")) return "collection";
  if (id.startsWith("video:")) return "video";
  return "";
}

/**
 * DOM-optional Watch Together & MediaSync coordination controller.
 *
 * All time reads and timers flow exclusively through `scheduler`, and all randomness flows
 * through `random`, ensuring deterministic simulation and 0 leaked timers after `resetAll()`/`destroy()`.
 */
export class MediaSyncController {
  /**
   * @param {object} [deps]
   * @param {object|null} [deps.wasm] - SafeRustWasmMesh instance (or supply `getWasm` / `setWasm`)
   * @param {() => object|null} [deps.getWasm]
   * @param {HTMLElement|null} [deps.mountEl] - Embed container element (DOM-optional)
   * @param {() => HTMLElement|null} [deps.getMountEl]
   * @param {{perfNow: () => number, wallNow: () => number, setTimeout: (fn: Function, ms: number) => any, clearTimeout: (id: any) => void, setInterval: (fn: Function, ms: number) => any, clearInterval: (id: any) => void}} [deps.scheduler]
   * @param {() => number} [deps.random]
   * @param {() => string} [deps.getPeerId]
   * @param {() => string} [deps.getAuthorName]
   * @param {(actions: Array, status?: object) => void} [deps.executeActions]
   * @param {(status: object) => void} [deps.onStatus]
   * @param {(state: object|null, meta?: object) => void} [deps.onUiSync]
   * @param {(message: string) => void} [deps.onToast]
   * @param {(event: string, detail: string) => void} [deps.onTelemetry]
   * @param {((ev: object) => void) | null} [deps.onDebugEvent]
   * @param {object} [deps.playerOptions] - Extra options forwarded to WatchTogetherPlayer (`sdkLoaders`, `env`, `syncConfig`, `peerStaggerMs`, etc.)
   * @param {object} [deps.sdkLoaders] - Convenience alias merged into `playerOptions.sdkLoaders`
   * @param {object} [deps.env] - Convenience alias merged into `playerOptions.env`
   * @param {() => void} [deps.onWatchTimeTick]
   * @param {(muted: boolean) => void} [deps.onAutoplayMuted]
   * @param {(player: WatchTogetherPlayer) => void} [deps.onLocalVolumeChange]
   * @param {(title: string) => void} [deps.onTitleOverride]
   * @param {(state: object, prev: object|null) => void} [deps.onWatchMediaChanged]
   * @param {(state: object, prev: object|null) => void} [deps.onIncomingVideo]
   * @param {(state: object, prev: object|null) => void} [deps.onIncomingGif]
   * @param {(nowMs: number) => boolean} [deps.onDriftVideoTick]
   */
  constructor(deps = {}) {
    this._wasm = deps.wasm || null;
    this._getWasm = typeof deps.getWasm === "function" ? deps.getWasm : () => this._wasm;
    this._mountEl = deps.mountEl || null;
    this._getMountEl =
      typeof deps.getMountEl === "function" ? deps.getMountEl : () => this._mountEl;
    this._scheduler = createDefaultScheduler(deps.scheduler);
    this._random = typeof deps.random === "function" ? deps.random : () => Math.random();
    this._getPeerId = typeof deps.getPeerId === "function" ? deps.getPeerId : () => "";
    this._getAuthorName =
      typeof deps.getAuthorName === "function" ? deps.getAuthorName : () => "Peer";
    this._executeActions =
      typeof deps.executeActions === "function" ? deps.executeActions : null;
    this._onStatus = typeof deps.onStatus === "function" ? deps.onStatus : () => {};
    this._onUiSync = typeof deps.onUiSync === "function" ? deps.onUiSync : () => {};
    this._onToast = typeof deps.onToast === "function" ? deps.onToast : () => {};
    this._onTelemetry = typeof deps.onTelemetry === "function" ? deps.onTelemetry : () => {};
    this._onDebugEvent = typeof deps.onDebugEvent === "function" ? deps.onDebugEvent : null;
    this._playerOptions = {
      ...(deps.playerOptions && typeof deps.playerOptions === "object" ? deps.playerOptions : {}),
      ...(deps.sdkLoaders && !deps.playerOptions?.sdkLoaders ? { sdkLoaders: deps.sdkLoaders } : {}),
      ...(deps.env && !deps.playerOptions?.env ? { env: deps.env } : {}),
    };

    // Optional browser-UI extension callbacks (no-ops in headless Node tests)
    this._onWatchTimeTick =
      typeof deps.onWatchTimeTick === "function" ? deps.onWatchTimeTick : () => {};
    this._onAutoplayMuted =
      typeof deps.onAutoplayMuted === "function" ? deps.onAutoplayMuted : () => {};
    this._onLocalVolumeChange =
      typeof deps.onLocalVolumeChange === "function" ? deps.onLocalVolumeChange : () => {};
    this._onTitleOverride =
      typeof deps.onTitleOverride === "function" ? deps.onTitleOverride : () => {};
    this._onWatchMediaChanged =
      typeof deps.onWatchMediaChanged === "function" ? deps.onWatchMediaChanged : () => {};
    this._onIncomingVideo =
      typeof deps.onIncomingVideo === "function" ? deps.onIncomingVideo : () => {};
    this._onIncomingGif =
      typeof deps.onIncomingGif === "function" ? deps.onIncomingGif : () => {};
    this._onDriftVideoTick =
      typeof deps.onDriftVideoTick === "function" ? deps.onDriftVideoTick : null;

    this.states = new Map(); // targetId -> MediaSyncState
    this.driftTimer = null;
    this.queueAdvanceTimer = null;
    this.watchPlayer = null;
    this.watchMinimized = false;
    this.watchScrubbing = false;
    this.watchTitleOverride = "";
    this.watchDurationMs = 0;
    this.watchPlaylistCount = 0;
    this.watchPlaylistItems = [];
    this.watchTracksOpen = false;
    this.watchSpotifyTrackDetached = false;
    this.watchSpotifySession = null;
    this.watchSpotifySessionDismissed = false;
    this.watchSpotifyPendingRefresh = false;
    this.watchProviderNotice = null;
    this.watchProviderNoticeDismissed = false;
    this.watchProviderPendingRefresh = false;
    this.watchProviderPendingRefreshKey = "";
    this.watchTwitchOffline = false;
    this.watchApplySource = "remote";
    this.autoplayMuted = false;

    this._incomingSeq = 0;
  }

  setWasm(wasm) {
    this._wasm = wasm || null;
  }

  setMountEl(mountEl) {
    this._mountEl = mountEl || null;
  }

  setDebugEventSink(fn) {
    this._onDebugEvent = typeof fn === "function" ? fn : null;
    if (this.watchPlayer) {
      this.watchPlayer.setDebugEventSink(this._onDebugEvent);
    }
  }

  _emitDebug(src, dir, ev, data = null, getters = null) {
    const sink = this._onDebugEvent;
    if (!sink) return;
    try {
      sink({
        tPerf: Math.round(this._scheduler.perfNow()),
        tWall: Math.round(this._scheduler.wallNow()),
        src,
        dir,
        ev,
        data: data !== null && data !== undefined ? sanitizeWatchDebugValue(data) : null,
        getters: getters !== null && getters !== undefined ? sanitizeWatchDebugValue(getters) : null,
      });
    } catch {
      // never let debug sink interfere with sync
    }
  }

  getState(targetId = "watch") {
    return this.states.get(targetId) || null;
  }

  getWatchState() {
    return this.states.get("watch") || null;
  }

  getWatchNotice() {
    const cur = this.states.get("watch");
    if (!cur || !cur.active || !cur.provider) return null;
    if (cur.provider === "spotify") {
      if (!this.watchSpotifySession) return null;
      return {
        provider: "spotify",
        mode: this.watchSpotifySession.mode,
        isPreview: Boolean(this.watchSpotifySession.isPreview),
        browser: this.watchSpotifySession.browser || "",
        dismissed: Boolean(
          this.watchSpotifySessionDismissed || this.watchProviderNoticeDismissed
        ),
        errorMessage: this.watchSpotifySession.errorMessage || "",
      };
    }
    if (!this.watchProviderNotice) return null;
    return {
      provider: this.watchProviderNotice.provider || cur.provider,
      kind: this.watchProviderNotice.kind || "",
      code: this.watchProviderNotice.code ?? "",
      severity: this.watchProviderNotice.severity || "",
      tag: this.watchProviderNotice.tag || "",
      blocksSync: Boolean(this.watchProviderNotice.blocksSync),
      isPreview: Boolean(this.watchProviderNotice.isPreview),
      dismissed: Boolean(this.watchProviderNoticeDismissed),
    };
  }

  getTwitchEntityKind(state) {
    return getTwitchEntityKind(state);
  }

  isWatchPlaylistState(state) {
    return Boolean(
      state && state.active && (state.playlistId || this.watchPlaylistCount > 1)
    );
  }

  isIndexableWatchPlaylist(state) {
    return (
      this.isWatchPlaylistState(state) &&
      state.provider !== "spotify" &&
      state.provider !== "twitch"
    );
  }

  clearWatchProviderNoticeState() {
    this.watchSpotifySession = null;
    this.watchSpotifySessionDismissed = false;
    this.watchSpotifyPendingRefresh = false;
    this.watchProviderNotice = null;
    this.watchProviderNoticeDismissed = false;
    this.watchProviderPendingRefresh = false;
    this.watchProviderPendingRefreshKey = "";
  }

  _clearQueueAdvanceTimer() {
    if (this.queueAdvanceTimer !== null) {
      this._scheduler.clearTimeout(this.queueAdvanceTimer);
      this.queueAdvanceTimer = null;
    }
  }

  _clearDriftTimer() {
    if (this.driftTimer !== null) {
      this._scheduler.clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
  }

  /**
   * Publishes a synchronized media state update to all peers in the room via Safe Rust WASM.
   * Volume and mute are never transmitted.
   */
  publishMediaSync(partialState, opts = {}) {
    const wasm = this._getWasm();
    if (!wasm || !partialState || !partialState.targetId) return null;
    const nowMs = this._scheduler.wallNow();
    const prev = this.states.get(partialState.targetId);
    const merged = {
      targetId: partialState.targetId,
      kind: partialState.kind || prev?.kind || "video",
      rev: prev?.rev || 0,
      active: partialState.active !== undefined ? Boolean(partialState.active) : true,
      playing:
        partialState.playing !== undefined
          ? Boolean(partialState.playing)
          : Boolean(prev?.playing),
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
        partialState.sourceMsgId !== undefined
          ? partialState.sourceMsgId
          : prev?.sourceMsgId || "",
      playlistId:
        partialState.playlistId !== undefined ? partialState.playlistId : prev?.playlistId || "",
      playlistIndex:
        partialState.playlistIndex !== undefined
          ? Math.max(0, Math.min(10000, Math.floor(Number(partialState.playlistIndex) || 0)))
          : Number(prev?.playlistIndex) || 0,
      trackUri: partialState.trackUri !== undefined ? partialState.trackUri : prev?.trackUri || "",
      queue: Array.isArray(partialState.queue) ? partialState.queue : prev?.queue || [],
    };
    const isWatchTarget = merged.targetId === "watch" || merged.kind === "watch";
    const source = opts?.source || "local-ui";
    const prevWatchSource = this.watchApplySource;
    if (isWatchTarget) {
      this.watchApplySource = source;
      if (this._onDebugEvent) {
        this._emitDebug("controller", "out", "publishMediaSync", {
          source,
          active: merged.active,
          playing: merged.playing,
          positionMs: merged.positionMs,
          rateMilli: merged.rateMilli,
          epoch: merged.epoch,
          provider: merged.provider,
          mediaId: merged.mediaId,
          playlistIndex: merged.playlistIndex,
          trackUri: merged.trackUri,
          queueLen: merged.queue.length,
        });
      }
    }
    try {
      const prevIncomingSeq = this._incomingSeq;
      const res = wasm.mediaSyncUpdate(merged, nowMs);
      if (res && res.status) {
        this._onStatus(res.status);
      }
      if (res && Array.isArray(res.actions)) {
        if (this._executeActions) {
          this._executeActions(res.actions, res.status);
        }
        if (this._incomingSeq === prevIncomingSeq) {
          for (const act of res.actions) {
            if (act && act.action === "media_sync" && act.state) {
              this.handleIncomingMediaSync(act.state);
            }
          }
        }
      }
      return res?.state || null;
    } catch (err) {
      this._onTelemetry("error", `Media sync update failed: ${err.message}`);
      return null;
    } finally {
      if (isWatchTarget) {
        this.watchApplySource = prevWatchSource;
      }
    }
  }

  /**
   * Handles a synchronized media state arriving from local mutation or a remote E2EE peer.
   */
  handleIncomingMediaSync(state) {
    if (!state || !state.targetId) return;
    this._incomingSeq += 1;
    const prev = this.states.get(state.targetId) || null;
    const normalized = {
      ...state,
      anchorMs: this._scheduler.wallNow(),
    };
    this.states.set(state.targetId, normalized);

    if (state.targetId === "watch" || state.kind === "watch") {
      if (this._onDebugEvent) {
        this._emitDebug("controller", "in", "handleIncomingMediaSync", {
          source: this.watchApplySource || "remote",
          rev: Number(normalized.rev) || 0,
          actor: normalized.actor || "",
          active: Boolean(normalized.active),
          playing: Boolean(normalized.playing),
          positionMs: Number(normalized.positionMs) || 0,
          rateMilli: Number(normalized.rateMilli) || 1000,
          epoch: Number(normalized.epoch) || 0,
          provider: normalized.provider || "",
          mediaId: normalized.mediaId || "",
          playlistIndex: Number(normalized.playlistIndex) || 0,
          trackUri: normalized.trackUri || "",
        });
      }
      this.applyWatchTogetherState(normalized, prev);
      if (normalized.active && normalized.playing) {
        this.ensureMediaDriftTimer();
      }
      return;
    }

    if (state.kind === "video" || state.targetId.startsWith("vid:")) {
      this._onIncomingVideo(normalized, prev);
      this.ensureMediaDriftTimer();
      return;
    }

    if (state.kind === "gif" || state.targetId.startsWith("gif:")) {
      this._onIncomingGif(normalized, prev);
    }
  }

  ensureMediaDriftTimer() {
    if (this.driftTimer !== null) return;
    this.driftTimer = this._scheduler.setInterval(() => this.runMediaDriftCorrection(), 1200);
  }

  runMediaDriftCorrection() {
    const nowMs = this._scheduler.wallNow();
    let anyPlaying = false;

    if (this._onDriftVideoTick) {
      if (this._onDriftVideoTick(nowMs)) {
        anyPlaying = true;
      }
    }

    const watchSt = this.states.get("watch");
    if (watchSt && watchSt.active && watchSt.playing) {
      anyPlaying = true;
      if (this.watchPlayer) {
        this.watchPlayer.correctDrift(watchSt, nowMs);
      }
    }

    if (!anyPlaying && this.driftTimer !== null) {
      this._clearDriftTimer();
    }
  }

  ensureWatchPlayer() {
    if (this.watchPlayer) return this.watchPlayer;
    const mountEl = this._getMountEl();
    this.watchPlayer = new WatchTogetherPlayer(mountEl, {
      ...this._playerOptions,
      scheduler: this._scheduler,
      getLocalPeerId: () => this._getPeerId(),
      onDebugEvent: this._onDebugEvent,
      onUserAction: (ev) => {
        const cur = this.states.get("watch");
        if (!cur || !cur.active) return;
        if (ev.ended) {
          if (cur.loop) {
            if (cur.playlistId && (cur.playlistIndex || 0) > 0 && this.isIndexableWatchPlaylist(cur)) {
              this.selectWatchPlaylistTrack(0);
            } else {
              this.replayWatch();
            }
          } else if (Array.isArray(cur.queue) && cur.queue.length > 0) {
            // Actor advances immediately; other peers act as backup after 900ms if actor disconnected
            const isActor = cur.actor === this._getPeerId();
            const prevRev = cur.rev;
            const delay = isActor ? 50 : 900;
            this._clearQueueAdvanceTimer();
            this.queueAdvanceTimer = this._scheduler.setTimeout(() => {
              this.queueAdvanceTimer = null;
              const live = this.states.get("watch");
              if (
                live &&
                live.active &&
                live.rev === prevRev &&
                Array.isArray(live.queue) &&
                live.queue.length > 0
              ) {
                if (this._onDebugEvent) {
                  this._emitDebug("controller", "internal", "queueAutoAdvance", {
                    prevRev,
                    delay,
                    isActor,
                  });
                }
                this.playNextWatchQueueItem();
              }
            }, delay);
          } else if (cur.playing) {
            this.publishMediaSync(
              {
                targetId: "watch",
                kind: "watch",
                playing: false,
                positionMs: ev.positionMs || this.watchDurationMs || cur.positionMs,
                playlistIndex:
                  ev.playlistIndex !== undefined ? ev.playlistIndex : cur.playlistIndex || 0,
                trackUri: ev.trackUri !== undefined ? ev.trackUri : cur.trackUri || "",
              },
              { source: "local-embed" }
            );
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
        this.publishMediaSync(update, { source: "local-embed" });
      },
      onNegotiateState: (ev) => {
        const cur = this.states.get("watch");
        if (!cur || !cur.active) return;
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
        this._onTelemetry(
          "info",
          `Watch Together negotiated shared state (${ev.reason || "divergence"})`
        );
        this.publishMediaSync(update, { source: "negotiated" });
      },
      onTelemetry: (meta) => {
        if (meta.durationMs > 0) {
          this.watchDurationMs = meta.durationMs;
        }
        if (meta.title) {
          this.watchTitleOverride = meta.title;
          this._onTitleOverride(meta.title);
        }
        let uiMetaChanged = false;
        if (
          typeof meta.playlistCount === "number" &&
          meta.playlistCount !== this.watchPlaylistCount
        ) {
          this.watchPlaylistCount = meta.playlistCount;
          uiMetaChanged = true;
        }
        if (Array.isArray(meta.playlistItems) && meta.playlistItems.length > 0) {
          this.watchPlaylistItems = meta.playlistItems;
          uiMetaChanged = true;
        }
        if (
          typeof meta.spotifyTrackDetached === "boolean" &&
          meta.spotifyTrackDetached !== this.watchSpotifyTrackDetached
        ) {
          this.watchSpotifyTrackDetached = meta.spotifyTrackDetached;
          uiMetaChanged = true;
        }
        if (meta.spotifySession && typeof meta.spotifySession === "object") {
          const prevSess = this.watchSpotifySession;
          const nextSess = meta.spotifySession;
          if (
            !prevSess ||
            prevSess.mode !== nextSess.mode ||
            prevSess.browser !== nextSess.browser ||
            prevSess.errorMessage !== nextSess.errorMessage
          ) {
            this.watchSpotifySession = nextSess;
            if (nextSess.mode === "full") {
              this.watchSpotifyPendingRefresh = false;
              this.watchProviderPendingRefresh = false;
              this.watchProviderPendingRefreshKey = "";
            }
            uiMetaChanged = true;
          }
        }
        if ("providerNotice" in meta) {
          const prevNotice = this.watchProviderNotice;
          const nextNotice =
            meta.providerNotice && typeof meta.providerNotice === "object"
              ? meta.providerNotice
              : null;
          const noticeChanged =
            Boolean(prevNotice) !== Boolean(nextNotice) ||
            (prevNotice &&
              nextNotice &&
              (prevNotice.provider !== nextNotice.provider ||
                prevNotice.code !== nextNotice.code ||
                prevNotice.kind !== nextNotice.kind ||
                prevNotice.message !== nextNotice.message));
          if (noticeChanged) {
            this.watchProviderNotice = nextNotice;
            if (nextNotice) {
              this.watchProviderNoticeDismissed = false;
            } else {
              this.watchProviderPendingRefresh = false;
              this.watchProviderPendingRefreshKey = "";
            }
            uiMetaChanged = true;
          }
        }
        if (
          typeof meta.twitchOffline === "boolean" &&
          meta.twitchOffline !== this.watchTwitchOffline
        ) {
          this.watchTwitchOffline = meta.twitchOffline;
          uiMetaChanged = true;
        }
        if (uiMetaChanged) {
          const cur = this.states.get("watch");
          if (cur && cur.active) {
            this._onUiSync(cur, { metaChanged: true });
          }
        }
        this._onWatchTimeTick();
      },
      onAutoplayMuted: (isMuted) => {
        this.autoplayMuted = Boolean(isMuted);
        this._onAutoplayMuted(this.autoplayMuted);
        this._onLocalVolumeChange(this.watchPlayer);
      },
    });
    return this.watchPlayer;
  }

  applyWatchTogetherState(state, prev = null) {
    if (!state || !state.active || !state.provider || !state.mediaId) {
      this._clearQueueAdvanceTimer();
      if (prev && prev.active) {
        this.watchMinimized = false;
      }
      if (this.watchPlayer) {
        this.watchPlayer.destroy();
      }
      this.watchDurationMs = 0;
      this.watchTitleOverride = "";
      this.watchPlaylistCount = 0;
      this.watchPlaylistItems = [];
      this.watchTracksOpen = false;
      this.watchSpotifyTrackDetached = false;
      this.clearWatchProviderNoticeState();
      this.watchTwitchOffline = false;
      this.autoplayMuted = false;
      // Clear drift timer immediately when no chat videos are playing
      if (this.driftTimer !== null && (!this._onDriftVideoTick || !this._onDriftVideoTick(this._scheduler.wallNow()))) {
        this._clearDriftTimer();
      }
      this._onUiSync(state || null, { active: false });
      return;
    }

    const mediaChanged =
      !prev ||
      prev.mediaId !== state.mediaId ||
      prev.provider !== state.provider ||
      (prev.playlistId || "") !== (state.playlistId || "");
    const playlistTrackChanged =
      !mediaChanged &&
      Boolean(prev) &&
      ((prev.playlistIndex || 0) !== (state.playlistIndex || 0) ||
        (prev.trackUri || "") !== (state.trackUri || ""));
    if (mediaChanged) {
      this._clearQueueAdvanceTimer();
      this.watchTitleOverride = "";
      this.watchDurationMs = 0;
      this.watchPlaylistCount = 0;
      this.watchPlaylistItems = [];
      this.watchTracksOpen = false;
      this.watchSpotifyTrackDetached = false;
      this.clearWatchProviderNoticeState();
      this.watchTwitchOffline = false;
      this.watchMinimized = false;
      this.autoplayMuted = false;
      this._onWatchMediaChanged(state, prev);
    } else if (playlistTrackChanged) {
      this.watchProviderNotice = null;
      this.watchProviderNoticeDismissed = false;
      this.watchProviderPendingRefresh = false;
      this.watchProviderPendingRefreshKey = "";
    }

    this._onUiSync(state, { active: true, mediaChanged, playlistTrackChanged });
    const player = this.ensureWatchPlayer();
    player.applyState(state, this._scheduler.wallNow(), {
      source: this.watchApplySource || "remote",
    });
  }

  startWatchTogetherFromUrl(rawUrl, sourceMsgId = "") {
    const parsed = parseWatchMediaUrl(rawUrl);
    if (!parsed) {
      this._onToast(
        "Share a valid YouTube, YouTube Music, Spotify, SoundCloud, or Twitch link in chat"
      );
      return false;
    }
    this._clearQueueAdvanceTimer();
    const prev = this.states.get("watch");
    this.watchMinimized = false;
    this.watchTitleOverride = "";
    this.watchDurationMs = 0;
    this.watchPlaylistCount = 0;
    this.watchPlaylistItems = [];
    this.watchTracksOpen = false;
    this.watchSpotifyTrackDetached = false;
    this.clearWatchProviderNoticeState();
    this.watchTwitchOffline = false;

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
    const kindWord =
      parsed.entityType === "channel"
        ? " live stream"
        : parsed.entityType === "clip"
          ? " clip"
          : parsed.entityType === "collection"
            ? " collection"
            : parsed.isPlaylist
              ? " playlist"
              : "";
    this._onToast(`Started synced ${parsed.providerLabel}${kindWord} for room`);
    return true;
  }

  enqueueWatchUrl(rawUrl) {
    const parsed = parseWatchMediaUrl(rawUrl);
    if (!parsed) {
      this._onToast(
        "Share a valid YouTube, YouTube Music, Spotify, SoundCloud, or Twitch link in chat"
      );
      return false;
    }
    const prev = this.states.get("watch");
    if (!prev || !prev.active || !prev.mediaId) {
      return this.startWatchTogetherFromUrl(rawUrl, "");
    }
    const nextQueue = Array.isArray(prev.queue) ? prev.queue.slice(0, 63) : [];
    const randSuffix = Math.floor(Math.max(0, Math.min(0.999999999, this._random())) * 1679616)
      .toString(36)
      .padStart(4, "0");
    nextQueue.push({
      id: `q-${Math.round(this._scheduler.wallNow())}-${randSuffix}`,
      url: parsed.url,
      provider: parsed.provider,
      mediaId: parsed.mediaId,
      title: parsed.title,
      addedBy: this._getAuthorName() || "Peer",
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
    const noun =
      parsed.entityType === "channel"
        ? "stream"
        : parsed.entityType === "clip"
          ? "clip"
          : parsed.entityType === "collection"
            ? "collection"
            : parsed.isPlaylist
              ? "playlist"
              : "track";
    this._onToast(`Queued ${parsed.providerLabel} ${noun} (#${nextQueue.length})`);
    return true;
  }

  toggleWatchPlay() {
    const cur = this.states.get("watch");
    if (!cur || !cur.active) return;
    const tk = getTwitchEntityKind(cur);
    if (tk === "clip") return;
    const nowPos = tk === "channel" ? 0 : projectMediaPositionMs(cur, this._scheduler.wallNow());
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      playing: !cur.playing,
      positionMs: nowPos,
    });
  }

  seekWatchBy(deltaMs) {
    const cur = this.states.get("watch");
    if (!cur || !cur.active) return;
    const tk = getTwitchEntityKind(cur);
    if (tk === "channel" || tk === "clip") return;
    const nowPos = projectMediaPositionMs(cur, this._scheduler.wallNow());
    const dur = this.watchDurationMs || 0;
    let nextPos = Math.max(0, nowPos + deltaMs);
    if (dur > 0) nextPos = Math.min(nextPos, dur);
    this.seekWatchTo(nextPos);
  }

  seekWatchTo(posMs) {
    const cur = this.states.get("watch");
    if (!cur || !cur.active) return;
    const tk = getTwitchEntityKind(cur);
    if (tk === "channel" || tk === "clip") return;
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      playing: cur.playing,
      positionMs: Math.max(0, Math.round(posMs)),
    });
  }

  replayWatch() {
    const cur = this.states.get("watch");
    if (!cur || !cur.active) return;
    if (getTwitchEntityKind(cur) === "channel") return;
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
    const cur = this.states.get("watch");
    if (!cur || !cur.active) return;
    const tk = getTwitchEntityKind(cur);
    if (tk === "channel" || tk === "clip") return;
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      loop: !cur.loop,
    });
  }

  setWatchPlaybackRate(rateMilli) {
    const cur = this.states.get("watch");
    if (!cur || !cur.active) return;
    const clamped = Math.max(250, Math.min(4000, Math.round(rateMilli || 1000)));
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: true,
      positionMs: projectMediaPositionMs(cur, this._scheduler.wallNow()),
      rateMilli: clamped,
    });
  }

  setWatchSpeed(rateMilli) {
    return this.setWatchPlaybackRate(rateMilli);
  }

  selectWatchPlaylistTrack(idx) {
    const cur = this.states.get("watch");
    if (!cur || !cur.active || !this.isIndexableWatchPlaylist(cur)) return;
    const count = this.watchPlaylistCount || 0;
    let targetIdx = Math.max(0, Math.floor(Number(idx) || 0));
    if (count > 0) {
      targetIdx = Math.min(count - 1, targetIdx);
    }
    const item = this.watchPlaylistItems[targetIdx];
    this.watchDurationMs = item?.durationMs > 0 ? item.durationMs : 0;
    if (item?.title) {
      this.watchTitleOverride = item.artist ? `${item.artist} — ${item.title}` : item.title;
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
    const cur = this.states.get("watch");
    if (!cur || !cur.active || !this.isIndexableWatchPlaylist(cur)) return;
    const curIdx = Math.max(0, Number(cur.playlistIndex) || 0);
    const count = this.watchPlaylistCount || 0;
    if (curIdx > 0) {
      this.selectWatchPlaylistTrack(curIdx - 1);
    } else if (cur.loop && count > 1) {
      this.selectWatchPlaylistTrack(count - 1);
    } else {
      this.replayWatch();
    }
  }

  playNextWatchTrackOrQueue() {
    const cur = this.states.get("watch");
    if (!cur || !cur.active) return;
    if (this.isIndexableWatchPlaylist(cur)) {
      const curIdx = Math.max(0, Number(cur.playlistIndex) || 0);
      const count = this.watchPlaylistCount || 0;
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

  playNextWatchQueueItem() {
    const cur = this.states.get("watch");
    if (!cur || !Array.isArray(cur.queue) || cur.queue.length === 0) return;
    this.playWatchQueueItemAt(0);
  }

  playWatchQueueItemAt(idx) {
    const cur = this.states.get("watch");
    if (!cur || !Array.isArray(cur.queue) || idx < 0 || idx >= cur.queue.length) return;
    this._clearQueueAdvanceTimer();
    const item = cur.queue[idx];
    const remaining = cur.queue.slice(0, idx).concat(cur.queue.slice(idx + 1));
    const parsedItem = parseWatchMediaUrl(item.url);
    this.watchTitleOverride = "";
    this.watchDurationMs = 0;
    this.watchPlaylistCount = 0;
    this.watchPlaylistItems = [];
    this.watchTracksOpen = false;
    this.watchSpotifyTrackDetached = false;
    this.clearWatchProviderNoticeState();
    this.watchTwitchOffline = false;
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
      trackUri: parsedItem?.trackUri || "",
      queue: remaining,
    });
  }

  removeWatchQueueItem(idx) {
    const cur = this.states.get("watch");
    if (!cur || !Array.isArray(cur.queue) || idx < 0 || idx >= cur.queue.length) return;
    const remaining = cur.queue.slice(0, idx).concat(cur.queue.slice(idx + 1));
    this.publishMediaSync({
      targetId: "watch",
      kind: "watch",
      active: cur.active,
      queue: remaining,
    });
  }

  removeWatchQueueItemAt(idx) {
    return this.removeWatchQueueItem(idx);
  }

  showWatchSpotifyPlaylist() {
    if (this.watchPlayer) {
      return this.watchPlayer.showSpotifyPlaylistView();
    }
    return false;
  }

  async reloadWatchPlayerSession({ reason = "manual" } = {}) {
    const cur = this.states.get("watch");
    if (!cur || !cur.active || !cur.provider || !this.watchPlayer) {
      return false;
    }
    if (this._onDebugEvent) {
      this._emitDebug("controller", "internal", "reloadWatchPlayerSession", {
        provider: cur.provider,
        reason,
      });
    }
    this.clearWatchProviderNoticeState();
    this._onUiSync(cur, { reloading: true });
    const ok = await this.watchPlayer.reloadPlayerSession();
    if (ok) {
      const provName = getWatchProviderFriendlyName(cur.provider);
      this._onToast(
        reason === "focus"
          ? `Reloaded ${provName} embed to pick up your browser session`
          : cur.provider === "spotify"
            ? "Reloaded Spotify session locally"
            : `Reloaded ${provName} player locally`
      );
    }
    return ok;
  }

  async reloadWatchSpotifySession({ reason = "manual" } = {}) {
    const cur = this.states.get("watch");
    if (!cur || !cur.active || cur.provider !== "spotify") {
      return false;
    }
    return this.reloadWatchPlayerSession({ reason });
  }

  markWatchProviderPendingRefresh() {
    const cur = this.states.get("watch");
    if (!cur || !cur.active || !cur.provider) return false;
    const canAutoReload =
      cur.provider === "spotify"
        ? Boolean(this.watchSpotifySession?.isPreview)
        : Boolean(this.watchProviderNotice?.autoReloadOnReturn);
    if (!canAutoReload) return false;
    this.watchProviderPendingRefresh = true;
    this.watchProviderPendingRefreshKey = `${cur.provider}:${cur.mediaId}:${cur.playlistId || ""}`;
    this.watchSpotifyPendingRefresh = cur.provider === "spotify";
    return true;
  }

  dismissWatchProviderNoticeBar() {
    this.watchProviderNoticeDismissed = true;
    this.watchSpotifySessionDismissed = true;
    const cur = this.states.get("watch");
    this._onUiSync(cur || null, { noticeDismissed: true });
  }

  maybeReloadWatchSessionOnFocus() {
    if (!this.watchProviderPendingRefresh && !this.watchSpotifyPendingRefresh) {
      return false;
    }
    const expectedKey = this.watchProviderPendingRefreshKey || "";
    this.watchProviderPendingRefresh = false;
    this.watchProviderPendingRefreshKey = "";
    this.watchSpotifyPendingRefresh = false;
    const cur = this.states.get("watch");
    if (!cur || !cur.active || !cur.provider) return false;
    const curKey = `${cur.provider}:${cur.mediaId}:${cur.playlistId || ""}`;
    if (expectedKey && curKey !== expectedKey) return false;
    if (cur.provider === "spotify") {
      if (this.watchSpotifySession?.mode === "full") return false;
      if (!this.watchSpotifySession?.isPreview) return false;
    } else {
      const notice = this.watchProviderNotice;
      if (!notice || !notice.autoReloadOnReturn) return false;
    }
    this.reloadWatchPlayerSession({ reason: "focus" });
    return true;
  }

  stopWatchTogetherForRoom() {
    this._clearQueueAdvanceTimer();
    const cur = this.states.get("watch");
    this.watchMinimized = false;
    this.watchPlaylistCount = 0;
    this.watchPlaylistItems = [];
    this.watchTracksOpen = false;
    this.watchSpotifyTrackDetached = false;
    this.clearWatchProviderNoticeState();
    this.watchTwitchOffline = false;
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
      this._onUiSync(null, { active: false });
    }
  }

  setWatchLocalVolume(vol0To100) {
    const player = this.ensureWatchPlayer();
    player.setLocalVolume(vol0To100);
    this._onLocalVolumeChange(player);
  }

  setWatchLocalMuted(muted) {
    const player = this.ensureWatchPlayer();
    player.setLocalMuted(muted);
    this._onLocalVolumeChange(player);
  }

  toggleWatchLocalMute() {
    const player = this.ensureWatchPlayer();
    player.setLocalMuted(!player.localMuted);
    this._onLocalVolumeChange(player);
  }

  resetAll() {
    this._clearQueueAdvanceTimer();
    this._clearDriftTimer();
    this.states.clear();
    this.watchMinimized = false;
    this.watchScrubbing = false;
    this.watchTitleOverride = "";
    this.watchDurationMs = 0;
    this.watchPlaylistCount = 0;
    this.watchPlaylistItems = [];
    this.watchTracksOpen = false;
    this.watchSpotifyTrackDetached = false;
    this.clearWatchProviderNoticeState();
    this.watchTwitchOffline = false;
    this.watchApplySource = "remote";
    this.autoplayMuted = false;
    if (this.watchPlayer) {
      this.watchPlayer.destroy();
    }
    this._onUiSync(null, { reset: true });
  }

  destroy() {
    this.resetAll();
    this.watchPlayer = null;
  }
}

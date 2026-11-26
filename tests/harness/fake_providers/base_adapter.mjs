/**
 * Base fake provider adapter & minimal mock DOM primitives for deterministic
 * VirtualClock-driven simulation of YouTube, SoundCloud, Spotify, and Twitch embeds.
 *
 * CRITICAL invariant: ALL incoming SDK commands execute asynchronously on VirtualClock
 * with configurable latency, drop probability, buffering, keyframe snapping, and
 * continuous playhead physics (`pos += dt * rate * localDrift`).
 */

import { createPrng } from "../prng.mjs";

export function createMockElement(tag = "div", idRegistry = null) {
  const attrs = new Map();
  const children = [];
  let idVal = "";

  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    src: "",
    textContent: "",
    children,
    parentElement: null,
    credentialless: true,
    dataset: {},
    _innerHTML: "",
    get id() {
      return idVal;
    },
    set id(v) {
      const next = String(v ?? "");
      if (idRegistry && idVal) idRegistry.delete(idVal);
      idVal = next;
      if (idRegistry && idVal) idRegistry.set(idVal, el);
    },
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(v) {
      this._innerHTML = String(v ?? "");
      if (this._innerHTML === "") {
        for (const c of children) c.parentElement = null;
        children.length = 0;
      }
    },
    appendChild(child) {
      if (!child) return child;
      child.parentElement = el;
      children.push(child);
      return child;
    },
    replaceChild(next, prev) {
      const idx = children.indexOf(prev);
      if (idx >= 0) {
        children[idx] = next;
        if (next) next.parentElement = el;
        if (prev) prev.parentElement = null;
      }
      return prev;
    },
    setAttribute(k, v) {
      const key = String(k).toLowerCase();
      attrs.set(key, String(v));
      if (key === "id") {
        el.id = String(v);
      }
    },
    getAttribute(k) {
      const key = String(k).toLowerCase();
      return attrs.has(key) ? attrs.get(key) : null;
    },
    removeAttribute(k) {
      attrs.delete(String(k).toLowerCase());
    },
    querySelector(sel) {
      const targetTag = String(sel || "").trim().toUpperCase();
      for (const c of children) {
        if (c.tagName === targetTag) return c;
        const nested = c.querySelector?.(sel);
        if (nested) return nested;
      }
      return null;
    },
  };
  return el;
}

export function createMockDocument({ theme = "dark" } = {}) {
  const idRegistry = new Map();
  const doc = {
    documentElement: {
      getAttribute(attr) {
        return attr === "data-theme" ? theme : null;
      },
    },
    head: createMockElement("head", idRegistry),
    createElement(tag) {
      return createMockElement(tag, idRegistry);
    },
    getElementById(id) {
      return idRegistry.get(String(id)) || null;
    },
    _idRegistry: idRegistry,
  };
  return doc;
}

/**
 * Builds the `sdkLoaders` map matching `WatchTogetherPlayer` `options.sdkLoaders`:
 * `{ youtube, spotify, soundcloud, twitch }`.
 */
export function createFakeSdkLoaders(adapters = {}) {
  const loaders = {};
  for (const key of ["youtube", "spotify", "soundcloud", "twitch"]) {
    const adapter = adapters[key];
    if (adapter && typeof adapter.sdkLoader === "function") {
      loaders[key] = adapter.sdkLoader();
    }
  }
  return loaders;
}

export class BaseFakeProviderAdapter {
  /**
   * @param {{
   *   provider: string,
   *   clock: import("../virtual_clock.mjs").VirtualClock | object,
   *   prng?: ReturnType<typeof createPrng>,
   *   peerId?: string,
   *   config?: object,
   *   document?: object,
   *   mountEl?: object,
   *   timeline?: { record: Function } | null,
   * }} options
   */
  constructor(options = {}) {
    if (!options.clock) {
      throw new Error("FakeProviderAdapter requires `clock`");
    }
    this.provider = String(options.provider || "unknown");
    this.clock = options.clock;
    this.prng = options.prng || createPrng(options.seed ?? 1);
    this.peerId = String(options.peerId || "peer");
    this.timeline = options.timeline || null;
    this.document = options.document || createMockDocument();
    this.mountEl = options.mountEl || this.document.createElement("div");

    const cfg = options.config || {};
    this.config = {
      cmdLatencyMs: Math.max(0, Number(cfg.cmdLatencyMs ?? 40)),
      cmdLatencyJitterMs: Math.max(0, Number(cfg.cmdLatencyJitterMs ?? 10)),
      dropCommandProb: Math.max(0, Math.min(1, Number(cfg.dropCommandProb ?? 0))),
      bufferMs: Math.max(0, Number(cfg.bufferMs ?? 180)),
      keyframeSnapMs: Math.max(0, Number(cfg.keyframeSnapMs ?? 0)),
      localDriftPpm: Number(cfg.localDriftPpm ?? 0) || 0,
      readyDelayMs: Math.max(0, Number(cfg.readyDelayMs ?? 25)),
      durationMs: Math.max(0, Number(cfg.durationMs ?? 240_000)),
      autoplayBlocked: Boolean(cfg.autoplayBlocked),
      ...cfg,
    };

    this.ready = false;
    this.playing = false;
    this.buffering = false;
    this.unstarted = true;
    this.ended = false;
    this.stalled = false;
    this.errored = false;
    this.blocked = false;
    this.autoplayBlocked = Boolean(this.config.autoplayBlocked);
    this.hasUserGesture = false;
    this.muted = false;
    this.volume = 80;
    this.positionMs = 0;
    this.durationMs = this.config.durationMs;
    this.rate = 1;
    this.isPreview = false;
    this.previewDurationMs = 0;
    this.playlistIndex = 0;
    this.trackUri = "";
    this.destroyed = false;

    this._timers = new Set();
    this._intervals = new Set();
    this._physicsLastBaseMs = this._nowBaseMs();
    this._commandLog = [];
    this._localCallLog = [];
  }

  _nowBaseMs() {
    if (typeof this.clock.nowBaseMs === "number") return this.clock.nowBaseMs;
    if (typeof this.clock.perfNow === "function") return this.clock.perfNow();
    return 0;
  }

  _wallNowMs() {
    if (typeof this.clock.wallNow === "function") return this.clock.wallNow();
    return this._nowBaseMs();
  }

  _scheduleTimer(delayMs, fn) {
    const delay = Math.max(0, Number(delayMs) || 0);
    let id;
    const wrapped = () => {
      this._timers.delete(id);
      if (this.destroyed) return;
      this._syncPhysics();
      fn();
    };
    if (typeof this.clock.schedule === "function") {
      id = this.clock.schedule(delay, wrapped, {
        peerId: `${this.peerId}:adapter:${this.provider}`,
        kind: "adapter-timeout",
      });
    } else {
      id = this.clock.setTimeout(wrapped, delay);
    }
    this._timers.add(id);
    return id;
  }

  _clearTimer(id) {
    if (id === null || id === undefined) return;
    this._timers.delete(id);
    if (typeof this.clock.cancel === "function") {
      this.clock.cancel(id);
    } else if (typeof this.clock.clearTimeout === "function") {
      this.clock.clearTimeout(id);
    }
  }

  _scheduleInterval(intervalMs, fn) {
    const step = Math.max(10, Number(intervalMs) || 250);
    let active = true;
    const handle = {
      timerId: null,
      cancel: () => {
        active = false;
        if (handle.timerId !== null) {
          this._clearTimer(handle.timerId);
          handle.timerId = null;
        }
        this._intervals.delete(handle);
      },
    };
    const arm = () => {
      if (!active || this.destroyed) return;
      handle.timerId = this._scheduleTimer(step, () => {
        if (!active || this.destroyed) return;
        fn();
        arm();
      });
    };
    this._intervals.add(handle);
    arm();
    return handle;
  }

  _clearAllAdapterTimers() {
    for (const h of [...this._intervals]) {
      h.cancel();
    }
    this._intervals.clear();
    for (const id of [...this._timers]) {
      this._clearTimer(id);
    }
    this._timers.clear();
  }

  activeTimerCount() {
    return this._timers.size;
  }

  _effectiveDurationMs() {
    if (this.isPreview && this.previewDurationMs > 0) {
      return this.previewDurationMs;
    }
    return this.durationMs;
  }

  _clampPosition(posMs) {
    const clean = Math.max(0, Number(posMs) || 0);
    const maxDur = this._effectiveDurationMs();
    if (maxDur > 0) {
      return Math.min(maxDur, clean);
    }
    return clean;
  }

  _applyKeyframeSnap(targetMs) {
    const snap = Math.max(0, Number(this.config.keyframeSnapMs) || 0);
    let pos = Math.max(0, Number(targetMs) || 0);
    if (snap > 0) {
      pos = Math.round(pos / snap) * snap;
    }
    return this._clampPosition(pos);
  }

  _isAdvancingPlayhead() {
    return (
      !this.destroyed &&
      this.ready &&
      this.playing &&
      !this.buffering &&
      !this.stalled &&
      !this.ended &&
      !this.blocked &&
      !this.errored
    );
  }

  _onPlayheadReachedEnd() {
    // Subclasses override to emit provider-specific ENDED / FINISH / PAUSE events
    this.playing = false;
    this.ended = true;
  }

  _syncPhysics() {
    const nowBase = this._nowBaseMs();
    const dt = Math.max(0, nowBase - this._physicsLastBaseMs);
    this._physicsLastBaseMs = nowBase;
    if (dt <= 0 || !this._isAdvancingPlayhead()) return;

    const driftFactor = 1 + (Number(this.config.localDriftPpm) || 0) / 1_000_000;
    const nextPos = this.positionMs + dt * this.rate * driftFactor;
    const maxDur = this._effectiveDurationMs();
    if (maxDur > 0 && nextPos >= maxDur) {
      this.positionMs = maxDur;
      this._onPlayheadReachedEnd();
    } else {
      this.positionMs = Math.max(0, nextPos);
    }
  }

  /**
   * Explicitly advances playhead physics by `dtMs` (for direct physics tests without
   * waiting for timers, while keeping `_physicsLastBaseMs` consistent with clock time).
   */
  advancePhysics(dtMs) {
    const dt = Math.max(0, Number(dtMs) || 0);
    this._syncPhysics();
    if (dt <= 0 || !this._isAdvancingPlayhead()) {
      return this.positionMs;
    }
    const driftFactor = 1 + (Number(this.config.localDriftPpm) || 0) / 1_000_000;
    const nextPos = this.positionMs + dt * this.rate * driftFactor;
    const maxDur = this._effectiveDurationMs();
    if (maxDur > 0 && nextPos >= maxDur) {
      this.positionMs = maxDur;
      this._onPlayheadReachedEnd();
    } else {
      this.positionMs = Math.max(0, nextPos);
    }
    return this.positionMs;
  }

  /**
   * Schedules an incoming SDK command asynchronously on VirtualClock with configurable
   * command latency, jitter, and command-drop probability.
   */
  _scheduleSdkCommand(name, args, executor, { extraDelayMs = 0, ignoreDrop = false } = {}) {
    this._syncPhysics();
    const tBase = this._nowBaseMs();
    const dropped = !ignoreDrop && this.config.dropCommandProb > 0 && this.prng.chance(this.config.dropCommandProb);
    const entry = {
      tBase,
      cmd: name,
      args: Array.isArray(args) ? args.slice() : [],
      dropped,
    };
    this._commandLog.push(entry);
    this.timeline?.record({
      tBase,
      peerId: this.peerId,
      kind: `sdk:${this.provider}:${name}`,
      detail: `${JSON.stringify(entry.args)}${dropped ? " [DROPPED]" : ""}`,
    });
    if (dropped) {
      return null;
    }
    const baseDelay = this.prng.jitter(this.config.cmdLatencyMs, this.config.cmdLatencyJitterMs);
    const delayMs = Math.max(0, baseDelay + Math.max(0, Number(extraDelayMs) || 0));
    return this._scheduleTimer(delayMs, () => {
      if (this.destroyed) return;
      executor();
    });
  }

  _recordLocalCall(name, args = []) {
    this._localCallLog.push({
      tBase: this._nowBaseMs(),
      cmd: name,
      args: Array.isArray(args) ? args.slice() : [],
    });
  }

  getCommandLog({ sinceBaseMs = 0, untilBaseMs = Infinity } = {}) {
    return this._commandLog.filter((c) => c.tBase >= sinceBaseMs && c.tBase <= untilBaseMs);
  }

  getLocalCallLog({ sinceBaseMs = 0, untilBaseMs = Infinity } = {}) {
    return this._localCallLog.filter((c) => c.tBase >= sinceBaseMs && c.tBase <= untilBaseMs);
  }

  resetCommandLog() {
    this._commandLog.length = 0;
    this._localCallLog.length = 0;
  }

  sdkLoader() {
    const sdk = this.createSdk();
    return () => Promise.resolve(sdk);
  }

  createSdk() {
    throw new Error(`${this.constructor.name} must implement createSdk()`);
  }

  /* ---- Uniform user-interaction & fault-injection surface (specialized by subclasses) ---- */

  userClickSeek(targetMs) {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.positionMs = this._applyKeyframeSnap(targetMs);
    this.ended = false;
  }

  userBufferedSeek(targetMs) {
    this.userClickSeek(targetMs);
  }

  userPausedSeek(targetMs) {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.playing = false;
    this.positionMs = this._applyKeyframeSnap(targetMs);
    this.ended = false;
  }

  userDragScrub(targetMs) {
    this.userClickSeek(targetMs);
  }

  userPlay() {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.playing = true;
    this.unstarted = false;
    this.ended = false;
  }

  userPause() {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.playing = false;
  }

  userRapidToggle(count = 2, intervalMs = 80) {
    this._syncPhysics();
    const total = Math.max(1, Math.trunc(Number(count) || 2));
    const step = Math.max(1, Number(intervalMs) || 80);
    let nextPlaying = !this.playing;
    for (let i = 0; i < total; i++) {
      const desired = nextPlaying;
      nextPlaying = !nextPlaying;
      const run = () => {
        if (desired) this.userPlay();
        else this.userPause();
      };
      if (i === 0) run();
      else this._scheduleTimer(i * step, run);
    }
  }

  userSelectPlaylistTrack(indexOrUri) {
    this._syncPhysics();
    this.hasUserGesture = true;
    if (typeof indexOrUri === "number") {
      this.playlistIndex = Math.max(0, Math.trunc(indexOrUri));
    } else {
      this.trackUri = String(indexOrUri || "");
    }
    this.positionMs = 0;
    this.ended = false;
  }

  injectRebuffer(durationMs = 1500) {
    this._syncPhysics();
    this.buffering = true;
    this._scheduleTimer(Math.max(1, Number(durationMs) || 1500), () => {
      this.buffering = false;
    });
  }

  injectError(codeOrMessage = "error") {
    this._syncPhysics();
    this.errored = true;
    this.blocked = true;
    this.playing = false;
    this._lastError = codeOrMessage;
  }

  injectSnip({ previewDurationMs = 30000 } = {}) {
    this._syncPhysics();
    this.isPreview = true;
    this.previewDurationMs = Math.max(1000, Number(previewDurationMs) || 30000);
  }

  injectAutoplayBlock(blocked = true) {
    this.autoplayBlocked = Boolean(blocked);
  }

  snapshot() {
    this._syncPhysics();
    return {
      provider: this.provider,
      peerId: this.peerId,
      ready: this.ready,
      playing: this.playing,
      hasPlayState: true,
      positionMs: Math.round(this.positionMs),
      hasPosition: true,
      durationMs: Math.round(this._effectiveDurationMs()),
      rateMilli: Math.round(this.rate * 1000),
      buffering: this.buffering,
      unstarted: this.unstarted,
      ended: this.ended,
      stalled: this.stalled,
      errored: this.errored,
      blocked: this.blocked,
      autoplayBlocked: this.autoplayBlocked && !this.hasUserGesture && !this.muted,
      isPreview: this.isPreview,
      previewDurationMs: this.previewDurationMs,
      playlistIndex: this.playlistIndex,
      trackUri: this.trackUri,
      muted: this.muted,
      volume: this.volume,
      wallNowMs: this._wallNowMs(),
      baseNowMs: this._nowBaseMs(),
      commandCount: this._commandLog.length,
    };
  }

  destroy() {
    this.destroyed = true;
    this._clearAllAdapterTimers();
    this.ready = false;
    this.playing = false;
  }
}

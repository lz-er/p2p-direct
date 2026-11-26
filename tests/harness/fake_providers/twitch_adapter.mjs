/**
 * Realistic async Twitch Embed API adapter (`Twitch.Player`).
 *
 * Models real Twitch embed quirks:
 * - VOD, Live channel, Collection, and Clip modes
 * - Silent seeks (position changes with NO `SEEK` event) vs explicit `SEEK` events
 * - `PLAYBACK_BLOCKED` autoplay block -> muted retry recovery
 * - Live channel `ONLINE` / `OFFLINE` transitions
 * - `setCollection(colId, videoId)` switch lag
 * - Async command execution (`play`, `pause`, `seek`, `setCollection`) and continuous playhead physics
 */

import { BaseFakeProviderAdapter } from "./base_adapter.mjs";

export const TWITCH_EVENTS = Object.freeze({
  READY: "ready",
  PLAY: "play",
  PLAYING: "playing",
  PAUSE: "pause",
  SEEK: "seek",
  ENDED: "ended",
  PLAYBACK_BLOCKED: "playbackBlocked",
  ONLINE: "online",
  OFFLINE: "offline",
});

function parseTwitchTimeMs(raw) {
  if (!raw) return 0;
  const m = String(raw).trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
}

export class FakeTwitchAdapter extends BaseFakeProviderAdapter {
  constructor(options = {}) {
    super({
      ...options,
      provider: "twitch",
      config: {
        durationMs: 600_000,
        collectionSwitchLagMs: 180,
        silentCmdSeek: false,
        ...(options.config || {}),
      },
    });

    this.twitchKind = "video"; // "video" | "channel" | "collection" | "clip"
    this.channel = "";
    this.collectionId = "";
    this.videoId = String(this.config.videoId || "12345678");
    this.offline = false;
    this._handlers = new Map();
    this._endCheckTimer = null;
    this._switchSeq = 0;
    this._instanceSeq = 0;
    this.instances = [];
    this.currentPlayer = null;
  }

  _isSeekable() {
    return this.twitchKind === "video" || this.twitchKind === "collection";
  }

  _isAdvancingPlayhead() {
    return (
      !this.destroyed &&
      this.ready &&
      this._isSeekable() &&
      this.playing &&
      !this.buffering &&
      !this.stalled &&
      !this.ended &&
      !this.blocked &&
      !this.errored &&
      !this.offline
    );
  }

  _emit(ev, payload) {
    if (this.destroyed) return;
    const list = this._handlers.get(ev);
    if (!list) return;
    for (const fn of list.slice()) {
      fn(payload);
    }
  }

  _clearEndTimer() {
    if (this._endCheckTimer !== null) {
      this._clearTimer(this._endCheckTimer);
      this._endCheckTimer = null;
    }
  }

  _armEndTimer() {
    this._clearEndTimer();
    if (!this._isAdvancingPlayhead() || this.durationMs <= 0) return;
    const remMs = Math.max(1, this.durationMs - this.positionMs);
    const driftFactor = 1 + (Number(this.config.localDriftPpm) || 0) / 1_000_000;
    const waitMs = Math.ceil(remMs / Math.max(0.1, driftFactor)) + 5;
    this._endCheckTimer = this._scheduleTimer(waitMs, () => {
      this._endCheckTimer = null;
      this._syncPhysics();
      this._armEndTimer();
    });
  }

  _onPlayheadReachedEnd() {
    this.positionMs = this.durationMs;
    this.playing = false;
    this.ended = true;
    this._clearEndTimer();
    this._emit(TWITCH_EVENTS.ENDED, {});
  }

  createSdk() {
    const adapter = this;

    function MockTwitchPlayer(holderOrId, opts = {}) {
      adapter._clearAllAdapterTimers();
      adapter.destroyed = false;
      adapter.ready = false;
      adapter.errored = false;
      adapter.blocked = false;
      adapter.ended = false;
      adapter.offline = false;
      adapter.hasUserGesture = false;
      adapter._handlers = new Map();
      adapter._physicsLastBaseMs = adapter._nowBaseMs();

      const holder =
        typeof holderOrId === "string" ? adapter.document.getElementById(holderOrId) : holderOrId;
      const iframe = adapter.document.createElement("iframe");
      iframe.setAttribute("allowfullscreen", "true");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("credentialless", "");
      holder?.appendChild?.(iframe);

      if (opts.collection) {
        adapter.twitchKind = "collection";
        adapter.collectionId = String(opts.collection);
        adapter.videoId = String(opts.video || adapter.videoId || "12345678");
        adapter.trackUri = adapter.videoId;
        adapter.positionMs = parseTwitchTimeMs(opts.time);
      } else if (opts.video) {
        adapter.twitchKind = "video";
        adapter.videoId = String(opts.video);
        adapter.trackUri = "";
        adapter.positionMs = parseTwitchTimeMs(opts.time);
      } else {
        adapter.twitchKind = "channel";
        adapter.channel = String(opts.channel || "simchannel");
        adapter.positionMs = 0;
        adapter.trackUri = "";
      }

      adapter.muted = Boolean(opts.muted);
      adapter.playing = Boolean(opts.autoplay) && (!adapter.autoplayBlocked || adapter.muted);
      adapter.unstarted = !adapter.playing;

      const instanceToken = ++adapter._instanceSeq;
      const isAlive = () => !adapter.destroyed && instanceToken === adapter._instanceSeq;

      const player = {
        holderId: typeof holderOrId === "string" ? holderOrId : holder?.id || "",
        iframe,
        opts,
        addEventListener(ev, fn) {
          if (!adapter._handlers.has(ev)) adapter._handlers.set(ev, []);
          adapter._handlers.get(ev).push(fn);
        },
        removeEventListener(ev, fn) {
          const list = adapter._handlers.get(ev);
          if (!list) return;
          const idx = list.indexOf(fn);
          if (idx >= 0) list.splice(idx, 1);
        },
        isPaused() {
          adapter._syncPhysics();
          return !adapter.playing;
        },
        getCurrentTime() {
          adapter._syncPhysics();
          return adapter._isSeekable() ? adapter.positionMs / 1000 : 0;
        },
        getDuration() {
          return adapter._isSeekable() ? adapter.durationMs / 1000 : 0;
        },
        getVideo() {
          return adapter.videoId;
        },
        getChannel() {
          return adapter.channel;
        },
        setVolume(v) {
          adapter._recordLocalCall("setVolume", [v]);
          adapter.volume = Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 100)));
        },
        setMuted(m) {
          adapter._recordLocalCall("setMuted", [Boolean(m)]);
          adapter.muted = Boolean(m);
        },
        play() {
          adapter._scheduleSdkCommand("play", [], () => {
            if (!isAlive() || adapter.errored || adapter.offline) return;
            if (adapter.autoplayBlocked && !adapter.hasUserGesture && !adapter.muted) {
              adapter.playing = false;
              adapter._emit(TWITCH_EVENTS.PLAYBACK_BLOCKED, {});
              return;
            }
            adapter.playing = true;
            adapter.unstarted = false;
            adapter.ended = false;
            adapter._physicsLastBaseMs = adapter._nowBaseMs();
            adapter._armEndTimer();
            adapter._emit(TWITCH_EVENTS.PLAY, {});
            adapter._emit(TWITCH_EVENTS.PLAYING, {});
          });
        },
        pause() {
          adapter._scheduleSdkCommand("pause", [], () => {
            if (!isAlive()) return;
            adapter._syncPhysics();
            adapter.playing = false;
            adapter._clearEndTimer();
            adapter._emit(TWITCH_EVENTS.PAUSE, {});
          });
        },
        seek(sec) {
          adapter._scheduleSdkCommand("seek", [sec], () => {
            if (!isAlive() || !adapter._isSeekable() || adapter.errored) return;
            const targetMs = adapter._applyKeyframeSnap((Number(sec) || 0) * 1000);
            adapter.positionMs = targetMs;
            adapter.ended = false;
            adapter._armEndTimer();
            if (!adapter.config.silentCmdSeek) {
              adapter._emit(TWITCH_EVENTS.SEEK, { position: targetMs / 1000 });
            }
          });
        },
        setCollection(colId, vidId) {
          const lagMs = Math.max(0, Number(adapter.config.collectionSwitchLagMs) || 180);
          const seq = ++adapter._switchSeq;
          adapter._scheduleSdkCommand(
            "setCollection",
            [colId, vidId],
            () => {
              if (!isAlive() || seq !== adapter._switchSeq) return;
              adapter.collectionId = String(colId || adapter.collectionId);
              if (vidId) {
                adapter.videoId = String(vidId);
                adapter.trackUri = adapter.videoId;
              }
              adapter.positionMs = 0;
              adapter.ended = false;
              adapter.playing = true;
              adapter.unstarted = false;
              adapter._physicsLastBaseMs = adapter._nowBaseMs();
              adapter._armEndTimer();
              adapter._emit(TWITCH_EVENTS.PLAYING, {});
            },
            { extraDelayMs: lagMs }
          );
        },
      };

      adapter.currentPlayer = player;
      adapter.instances.push(player);

      adapter._scheduleTimer(adapter.config.readyDelayMs, () => {
        if (!isAlive() || adapter.currentPlayer !== player) return;
        adapter.ready = true;
        adapter._physicsLastBaseMs = adapter._nowBaseMs();
        adapter._armEndTimer();
        adapter._emit(TWITCH_EVENTS.READY, {});
      });

      return player;
    }

    const Player = Object.assign(MockTwitchPlayer, TWITCH_EVENTS);
    return { Player };
  }

  /* ==================== User Interactions & Fault Injectors ==================== */

  userClickSeek(targetMs) {
    this._syncPhysics();
    if (!this._isSeekable()) return;
    this.hasUserGesture = true;
    const target = this._applyKeyframeSnap(targetMs);
    this.positionMs = target;
    this.ended = false;
    this._armEndTimer();
    this._emit(TWITCH_EVENTS.SEEK, { position: target / 1000 });
  }

  /**
   * Silent buffered VOD seek: jumps playhead without emitting `SEEK` event.
   */
  userBufferedSeek(targetMs) {
    this._syncPhysics();
    if (!this._isSeekable()) return;
    this.hasUserGesture = true;
    this.positionMs = this._applyKeyframeSnap(targetMs);
    this.ended = false;
    this.playing = true;
    this.unstarted = false;
    this._armEndTimer();
  }

  /**
   * Silent paused VOD seek: jumps playhead while paused without emitting `SEEK` event.
   */
  userPausedSeek(targetMs) {
    this._syncPhysics();
    if (!this._isSeekable()) return;
    this.hasUserGesture = true;
    this.playing = false;
    this.positionMs = this._applyKeyframeSnap(targetMs);
    this.ended = false;
    this._clearEndTimer();
  }

  userDragScrub(targetMs, { dragMs = 250 } = {}) {
    this._syncPhysics();
    if (!this._isSeekable()) return;
    this.hasUserGesture = true;
    const target = this._applyKeyframeSnap(targetMs);
    this.playing = false;
    this._clearEndTimer();
    this._emit(TWITCH_EVENTS.PAUSE, {});
    this._scheduleTimer(Math.max(10, Number(dragMs) || 250), () => {
      if (this.destroyed) return;
      this.positionMs = target;
      this.ended = false;
      this._emit(TWITCH_EVENTS.SEEK, { position: target / 1000 });
      this.playing = true;
      this._physicsLastBaseMs = this._nowBaseMs();
      this._armEndTimer();
      this._emit(TWITCH_EVENTS.PLAYING, {});
    });
  }

  userPlay() {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.playing = true;
    this.unstarted = false;
    this.ended = false;
    this._physicsLastBaseMs = this._nowBaseMs();
    this._armEndTimer();
    this._emit(TWITCH_EVENTS.PLAY, {});
    this._emit(TWITCH_EVENTS.PLAYING, {});
  }

  userPause() {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.playing = false;
    this._clearEndTimer();
    this._emit(TWITCH_EVENTS.PAUSE, {});
  }

  userSelectPlaylistTrack(videoId) {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.videoId = String(videoId || this.videoId);
    this.trackUri = this.videoId;
    this.positionMs = 0;
    this.ended = false;
    this.playing = true;
    this.unstarted = false;
    this._physicsLastBaseMs = this._nowBaseMs();
    this._armEndTimer();
    this._emit(TWITCH_EVENTS.PLAYING, {});
  }

  injectOffline() {
    this._syncPhysics();
    this.offline = true;
    this.playing = false;
    this._clearEndTimer();
    this._emit(TWITCH_EVENTS.OFFLINE, {});
  }

  injectOnline() {
    this._syncPhysics();
    this.offline = false;
    this._emit(TWITCH_EVENTS.ONLINE, {});
  }

  injectRebuffer(durationMs = 1500) {
    this._syncPhysics();
    this.buffering = true;
    this._scheduleTimer(Math.max(10, Number(durationMs) || 1500), () => {
      this.buffering = false;
      this._physicsLastBaseMs = this._nowBaseMs();
      this._armEndTimer();
    });
  }

  snapshot() {
    const base = super.snapshot();
    // Detect iframe-only Twitch Clip mount
    const clipIframe = this.mountEl?.querySelector?.("iframe");
    const isClip = Boolean(
      this.twitchKind === "clip" ||
        (clipIframe && String(clipIframe.src || "").includes("clips.twitch.tv/embed"))
    );
    return {
      ...base,
      twitchKind: isClip ? "clip" : this.twitchKind,
      hasPosition: !isClip && this._isSeekable(),
      channel: this.channel,
      collectionId: this.collectionId,
      videoId: this.videoId,
      offline: this.offline,
    };
  }
}

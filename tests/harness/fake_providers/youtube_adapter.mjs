/**
 * Realistic async YouTube / YouTube Music IFrame Player adapter (`YT.Player`).
 *
 * Models real YouTube quirks:
 * - Pre-`BUFFERING` `getCurrentTime()` jump before `onStateChange(3)` fires
 * - Silent buffered seeks (`1 -> 1`) and paused seeks (`2 -> 2`) with NO `onStateChange`
 * - Scrubber drag (`2 -> 3 -> 1`)
 * - Async / slow / dropped `seekTo` commands
 * - Autoplay block (stays unstarted/paused until `mute()` + `playVideo()` or user gesture)
 * - `onError` (`100/101/150/152/153/2/5`) + recovery on `CUED` / `PLAYING` / track switch
 */

import { BaseFakeProviderAdapter } from "./base_adapter.mjs";

export const YT_STATE = Object.freeze({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
});

export class FakeYouTubeAdapter extends BaseFakeProviderAdapter {
  constructor(options = {}) {
    super({
      ...options,
      provider: options.provider === "ytmusic" ? "ytmusic" : "youtube",
    });
    this.ytState = YT_STATE.UNSTARTED;
    this.errorCode = 0;
    this.playlistIds = Array.isArray(this.config.playlistIds)
      ? this.config.playlistIds.slice()
      : ["vidA1111111", "vidB2222222", "vidC3333333"];
    this.videoId = String(this.config.videoId || "dQw4w9WgXcQ");
    this.isPlaylist = false;
    this.loop = false;
    this.instances = [];
    this.currentPlayer = null;
    this._currentEvents = null;
    this._currentIframe = null;
    this._seekSeq = 0;
    this._endCheckTimer = null;
  }

  _isAdvancingPlayhead() {
    return (
      !this.destroyed &&
      this.ready &&
      this.ytState === YT_STATE.PLAYING &&
      !this.buffering &&
      !this.stalled &&
      !this.ended &&
      !this.blocked &&
      !this.errored
    );
  }

  _setYtState(code, { emit = true } = {}) {
    this._syncPhysics();
    this.ytState = code;
    this.playing = code === YT_STATE.PLAYING;
    this.buffering = code === YT_STATE.BUFFERING;
    this.unstarted = code === YT_STATE.UNSTARTED || code === YT_STATE.CUED;
    this.ended = code === YT_STATE.ENDED;
    if (code === YT_STATE.PLAYING || code === YT_STATE.CUED) {
      this.errored = false;
      this.blocked = false;
      this.errorCode = 0;
    }
    this._armEndTimer();
    if (emit && this._currentEvents?.onStateChange && !this.destroyed) {
      this._currentEvents.onStateChange({ data: code });
    }
  }

  _onPlayheadReachedEnd() {
    this.ytState = YT_STATE.ENDED;
    this.playing = false;
    this.buffering = false;
    this.ended = true;
    this._clearEndTimer();
    if (this._currentEvents?.onStateChange && !this.destroyed) {
      this._currentEvents.onStateChange({ data: YT_STATE.ENDED });
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
    const waitMs = Math.ceil(remMs / Math.max(0.1, this.rate * driftFactor)) + 5;
    this._endCheckTimer = this._scheduleTimer(waitMs, () => {
      this._endCheckTimer = null;
      this._syncPhysics();
      this._armEndTimer();
    });
  }

  _activeVideoId() {
    if (this.isPlaylist && this.playlistIds.length > 0) {
      return this.playlistIds[this.playlistIndex] || this.playlistIds[0];
    }
    return this.videoId;
  }

  createSdk() {
    const adapter = this;

    function MockYTPlayer(holder, opts = {}) {
      // Tear down any previous mounted instance timers on reload
      adapter._clearAllAdapterTimers();
      adapter.destroyed = false;
      adapter.ready = false;
      adapter.errored = false;
      adapter.blocked = false;
      adapter.errorCode = 0;
      adapter.hasUserGesture = false;
      adapter.rate = 1;
      adapter.ytState = YT_STATE.CUED;
      adapter.playing = false;
      adapter.buffering = false;
      adapter.unstarted = true;
      adapter.ended = false;
      adapter._physicsLastBaseMs = adapter._nowBaseMs();

      const iframe = adapter.document.createElement("iframe");
      iframe.setAttribute("allowfullscreen", "1");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("credentialless", "");
      holder?.parentElement?.replaceChild?.(iframe, holder);

      adapter.isPlaylist = Boolean(opts.playerVars?.list);
      if (opts.videoId) adapter.videoId = String(opts.videoId);
      if (adapter.isPlaylist) {
        adapter.playlistIndex = Math.max(0, Number(opts.playerVars?.index) || 0);
        adapter.trackUri = adapter._activeVideoId();
      } else {
        adapter.playlistIndex = 0;
        adapter.trackUri = adapter.videoId;
      }
      adapter.positionMs = Math.max(0, (Number(opts.playerVars?.start) || 0) * 1000);
      adapter._currentEvents = opts.events || {};
      adapter._currentIframe = iframe;

      let instanceDestroyed = false;

      const player = {
        holder,
        iframe,
        opts,
        getIframe() {
          return iframe;
        },
        getPlayerState() {
          adapter._syncPhysics();
          return adapter.ytState;
        },
        getCurrentTime() {
          adapter._syncPhysics();
          return adapter.positionMs / 1000;
        },
        getDuration() {
          return adapter.durationMs / 1000;
        },
        getPlaybackRate() {
          return adapter.rate;
        },
        getPlaylist() {
          return adapter.isPlaylist ? adapter.playlistIds.slice() : null;
        },
        getPlaylistIndex() {
          return adapter.isPlaylist ? adapter.playlistIndex : -1;
        },
        getVideoData() {
          const vid = adapter._activeVideoId();
          return { video_id: vid, title: `YT Video ${vid}`, author: "SimChannel" };
        },
        setVolume(v) {
          adapter._recordLocalCall("setVolume", [v]);
          adapter.volume = Math.max(0, Math.min(100, Number(v) || 0));
        },
        mute() {
          adapter._recordLocalCall("mute", []);
          adapter.muted = true;
        },
        unMute() {
          adapter._recordLocalCall("unMute", []);
          adapter.muted = false;
        },
        setLoop(v) {
          adapter._recordLocalCall("setLoop", [Boolean(v)]);
          adapter.loop = Boolean(v);
        },
        playVideo() {
          adapter._scheduleSdkCommand("playVideo", [], () => {
            if (instanceDestroyed || adapter.errored) return;
            if (adapter.autoplayBlocked && !adapter.hasUserGesture && !adapter.muted) {
              // Autoplay blocked: stay paused/unstarted, do NOT emit PLAYING(1)
              return;
            }
            adapter._setYtState(YT_STATE.PLAYING, { emit: true });
          });
        },
        pauseVideo() {
          // Cancel any earlier in-flight seekTo auto-resume without aborting a subsequent seekTo
          adapter._seekSeq += 1;
          adapter._scheduleSdkCommand("pauseVideo", [], () => {
            if (instanceDestroyed || adapter.errored) return;
            adapter._setYtState(YT_STATE.PAUSED, { emit: true });
          });
        },
        seekTo(sec, allowSeekAhead = true) {
          const extra = Math.max(0, Number(adapter.config.slowSeekExtraMs) || 0);
          const seq = ++adapter._seekSeq;
          adapter._scheduleSdkCommand(
            "seekTo",
            [sec, allowSeekAhead],
            () => {
              if (instanceDestroyed || adapter.errored || seq !== adapter._seekSeq) return;
              const targetMs = adapter._applyKeyframeSnap((Number(sec) || 0) * 1000);
              const wasPlaying = adapter.ytState === YT_STATE.PLAYING;
              const wasBuffering = adapter.ytState === YT_STATE.BUFFERING;
              adapter.positionMs = targetMs;
              adapter.ended = false;
              const bufMs = Math.max(0, Number(adapter.config.bufferMs) || 0);
              if (bufMs > 0 && (wasPlaying || wasBuffering)) {
                adapter._setYtState(YT_STATE.BUFFERING, { emit: true });
                adapter._scheduleTimer(bufMs, () => {
                  if (
                    instanceDestroyed ||
                    seq !== adapter._seekSeq ||
                    adapter.errored ||
                    adapter.ytState !== YT_STATE.BUFFERING
                  ) {
                    return;
                  }
                  adapter._setYtState(YT_STATE.PLAYING, { emit: true });
                });
              } else {
                adapter._armEndTimer();
              }
            },
            { extraDelayMs: extra }
          );
        },
        setPlaybackRate(r) {
          adapter._scheduleSdkCommand("setPlaybackRate", [r], () => {
            if (instanceDestroyed || adapter.errored) return;
            adapter._syncPhysics();
            adapter.rate = Math.max(0.25, Math.min(4, Number(r) || 1));
            adapter._armEndTimer();
            adapter._currentEvents?.onPlaybackRateChange?.({ data: adapter.rate });
          });
        },
        playVideoAt(idx) {
          adapter._scheduleSdkCommand("playVideoAt", [idx], () => {
            if (instanceDestroyed) return;
            const cleanIdx = Math.max(0, Math.min(adapter.playlistIds.length - 1, Math.trunc(Number(idx) || 0)));
            const seq = ++adapter._seekSeq;
            adapter.playlistIndex = cleanIdx;
            adapter.trackUri = adapter._activeVideoId();
            adapter.positionMs = 0;
            adapter.errored = false;
            adapter.blocked = false;
            adapter.errorCode = 0;
            adapter._setYtState(YT_STATE.BUFFERING, { emit: true });
            const bufMs = Math.max(20, Number(adapter.config.bufferMs) || 120);
            adapter._scheduleTimer(bufMs, () => {
              if (instanceDestroyed || seq !== adapter._seekSeq || adapter.errored) return;
              if (adapter.autoplayBlocked && !adapter.hasUserGesture && !adapter.muted) {
                adapter._setYtState(YT_STATE.CUED, { emit: true });
                return;
              }
              adapter._setYtState(YT_STATE.PLAYING, { emit: true });
            });
          });
        },
        cuePlaylist(spec = {}) {
          adapter._scheduleSdkCommand("cuePlaylist", [spec], () => {
            if (instanceDestroyed) return;
            const cleanIdx = Math.max(
              0,
              Math.min(adapter.playlistIds.length - 1, Math.trunc(Number(spec.index) || 0))
            );
            adapter.playlistIndex = cleanIdx;
            adapter.trackUri = adapter._activeVideoId();
            adapter.positionMs = Math.max(0, Math.round((Number(spec.startSeconds) || 0) * 1000));
            adapter.errored = false;
            adapter.blocked = false;
            adapter.errorCode = 0;
            adapter._setYtState(YT_STATE.CUED, { emit: true });
          });
        },
        destroy() {
          instanceDestroyed = true;
          adapter._recordLocalCall("destroy", []);
          if (adapter.currentPlayer === player) {
            adapter._clearAllAdapterTimers();
            adapter.ready = false;
            adapter.playing = false;
            adapter.destroyed = true;
          }
        },
      };

      adapter.currentPlayer = player;
      adapter.instances.push(player);

      adapter._scheduleTimer(adapter.config.readyDelayMs, () => {
        if (instanceDestroyed || adapter.currentPlayer !== player) return;
        adapter.ready = true;
        adapter._physicsLastBaseMs = adapter._nowBaseMs();
        adapter._currentEvents?.onReady?.({ target: player });
      });

      return player;
    }

    return {
      Player: MockYTPlayer,
      PlayerState: YT_STATE,
    };
  }

  /* ==================== Realistic User Interactions & Fault Injectors ==================== */

  /**
   * Simulates a YouTube click-seek on the progress bar:
   * With `preBufferJump: true` (real YouTube behavior!), `getCurrentTime()` jumps to `targetMs`
   * BEFORE `onStateChange(BUFFERING=3)` fires, buffers for `bufferMs`, then resumes.
   */
  userClickSeek(targetMs, { preBufferJump = true, bufferMs = undefined } = {}) {
    this._syncPhysics();
    this.hasUserGesture = true;
    const wasPlaying = this.ytState === YT_STATE.PLAYING || this.ytState === YT_STATE.BUFFERING;
    const target = this._applyKeyframeSnap(targetMs);
    const seq = ++this._seekSeq;
    const buf = bufferMs !== undefined ? Math.max(0, Number(bufferMs)) : this.config.bufferMs;

    if (preBufferJump) {
      this.positionMs = target;
      this.ended = false;
    }

    if (buf > 0) {
      this._setYtState(YT_STATE.BUFFERING, { emit: true });
      this._scheduleTimer(buf, () => {
        if (this.destroyed || seq !== this._seekSeq || this.errored) return;
        this.positionMs = target;
        this.ended = false;
        this._setYtState(wasPlaying ? YT_STATE.PLAYING : YT_STATE.PAUSED, { emit: true });
      });
    } else {
      this.positionMs = target;
      this.ended = false;
      this._setYtState(wasPlaying ? YT_STATE.PLAYING : YT_STATE.PAUSED, { emit: true });
    }
  }

  /**
   * Silent buffered-region seek (`1 -> 1`): updates `getCurrentTime()` with ZERO `onStateChange`.
   */
  userBufferedSeek(targetMs) {
    this._syncPhysics();
    this._seekSeq += 1;
    this.hasUserGesture = true;
    this.positionMs = this._applyKeyframeSnap(targetMs);
    this.ended = false;
    if (this.ytState !== YT_STATE.PLAYING) {
      this.ytState = YT_STATE.PLAYING;
      this.playing = true;
      this.unstarted = false;
    }
    this._armEndTimer();
  }

  /**
   * Silent paused seek (`2 -> 2`): updates `getCurrentTime()` while paused with ZERO `onStateChange`.
   */
  userPausedSeek(targetMs) {
    this._syncPhysics();
    this._seekSeq += 1;
    this.hasUserGesture = true;
    this.positionMs = this._applyKeyframeSnap(targetMs);
    this.ended = false;
    this.ytState = YT_STATE.PAUSED;
    this.playing = false;
    this.unstarted = false;
    this._clearEndTimer();
  }

  /**
   * Realistic YouTube scrubber drag (`PAUSED(2) -> BUFFERING(3) -> PLAYING(1)`).
   */
  userDragScrub(targetMs, { dragMs = 300, bufferMs = undefined } = {}) {
    this._syncPhysics();
    this.hasUserGesture = true;
    const seq = ++this._seekSeq;
    const target = this._applyKeyframeSnap(targetMs);
    const drag = Math.max(10, Number(dragMs) || 300);
    const buf = bufferMs !== undefined ? Math.max(0, Number(bufferMs)) : this.config.bufferMs;

    this._setYtState(YT_STATE.PAUSED, { emit: true });
    this._scheduleTimer(drag, () => {
      if (this.destroyed || seq !== this._seekSeq || this.errored) return;
      this.positionMs = target;
      this.ended = false;
      if (buf > 0) {
        this._setYtState(YT_STATE.BUFFERING, { emit: true });
        this._scheduleTimer(buf, () => {
          if (this.destroyed || seq !== this._seekSeq || this.errored) return;
          this._setYtState(YT_STATE.PLAYING, { emit: true });
        });
      } else {
        this._setYtState(YT_STATE.PLAYING, { emit: true });
      }
    });
  }

  userPlay() {
    this._syncPhysics();
    this._seekSeq += 1;
    this.hasUserGesture = true;
    this.ended = false;
    this._setYtState(YT_STATE.PLAYING, { emit: true });
  }

  userPause() {
    this._syncPhysics();
    this._seekSeq += 1;
    this.hasUserGesture = true;
    this._setYtState(YT_STATE.PAUSED, { emit: true });
  }

  userSelectPlaylistTrack(index) {
    this._syncPhysics();
    this.hasUserGesture = true;
    const cleanIdx = Math.max(0, Math.min(this.playlistIds.length - 1, Math.trunc(Number(index) || 0)));
    const seq = ++this._seekSeq;
    this.playlistIndex = cleanIdx;
    this.trackUri = this._activeVideoId();
    this.positionMs = 0;
    this.errored = false;
    this.blocked = false;
    this.errorCode = 0;
    this._setYtState(YT_STATE.BUFFERING, { emit: true });
    const buf = Math.max(20, this.config.bufferMs);
    this._scheduleTimer(buf, () => {
      if (this.destroyed || seq !== this._seekSeq || this.errored) return;
      this._setYtState(YT_STATE.PLAYING, { emit: true });
    });
  }

  /**
   * Simulates a true network rebuffer stall (`3 -> 1` at the exact same spot).
   */
  injectRebuffer(durationMs = 2000) {
    this._syncPhysics();
    const frozenPos = this.positionMs;
    const seq = ++this._seekSeq;
    this._setYtState(YT_STATE.BUFFERING, { emit: true });
    this._scheduleTimer(Math.max(10, Number(durationMs) || 2000), () => {
      if (this.destroyed || seq !== this._seekSeq || this.errored) return;
      this.positionMs = frozenPos;
      this._setYtState(YT_STATE.PLAYING, { emit: true });
    });
  }

  /**
   * Fires `onError` with any real YouTube error code (`100/101/150/152/153/2/5`).
   */
  injectError(code = 150) {
    this._syncPhysics();
    const numCode = Number(code);
    this.errorCode = Number.isFinite(numCode) ? numCode : 150;
    this.errored = true;
    this.blocked = true;
    this.playing = false;
    this.buffering = false;
    this.ytState = YT_STATE.UNSTARTED;
    this._clearEndTimer();
    this._currentEvents?.onError?.({ data: this.errorCode });
  }

  /**
   * Recovers from an injected YouTube error (e.g., transitioning to CUED(5) or PLAYING(1)).
   */
  recoverFromError(nextState = YT_STATE.CUED) {
    this._syncPhysics();
    this.errorCode = 0;
    this.errored = false;
    this.blocked = false;
    this._setYtState(nextState, { emit: true });
  }

  snapshot() {
    const base = super.snapshot();
    return {
      ...base,
      ytState: this.ytState,
      errorCode: this.errorCode,
      videoId: this._activeVideoId(),
      isPlaylist: this.isPlaylist,
      playlistCount: this.isPlaylist ? this.playlistIds.length : 0,
    };
  }
}

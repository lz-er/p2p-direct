/**
 * Realistic async SoundCloud Widget API adapter (`SC.Widget`).
 *
 * Models real SoundCloud quirks:
 * - Async `postMessage` callback queue with configurable delay, jitter, and out-of-order
 *   resolution for `getPosition` / `isPaused` / `getCurrentSoundIndex` / `getCurrentSound`
 * - `SNIP` 30s Go+/geo preview cap (both with `full_duration` and omitted `full_duration`) + `PAUSE`/`FINISH`
 * - `BLOCK` / `playable: false` and `ERROR` widget events
 * - Unhydrated `{ id }` stubs in `getSounds()` for playlists
 * - Async command execution (`play`, `pause`, `seekTo`, `skip`) and `PLAY_PROGRESS` ticks
 */

import { BaseFakeProviderAdapter } from "./base_adapter.mjs";

export const SC_EVENTS = Object.freeze({
  READY: "ready",
  PLAY: "play",
  PAUSE: "pause",
  SEEK: "seek",
  FINISH: "finish",
  PLAY_PROGRESS: "playProgress",
  ERROR: "error",
});

function cloneSound(s) {
  if (!s) return null;
  return {
    ...s,
    ...(s.user ? { user: { ...s.user } } : {}),
  };
}

export class FakeSoundCloudAdapter extends BaseFakeProviderAdapter {
  constructor(options = {}) {
    super({
      ...options,
      provider: "soundcloud",
      config: {
        postMessageDelayMs: 20,
        postMessageJitterMs: 10,
        outOfOrderProb: 0,
        progressIntervalMs: 250,
        unhydratedStubs: false,
        omitSoundIdOnPlay: false,
        capturePostMessageAtCallTime: true,
        ...(options.config || {}),
      },
    });

    this.sounds = Array.isArray(this.config.sounds) && this.config.sounds.length > 0
      ? this.config.sounds.map(cloneSound)
      : [
          {
            id: 1001,
            title: "Full Track One",
            user: { username: "SimArtist" },
            duration: this.durationMs || 180_000,
            full_duration: this.durationMs || 180_000,
            policy: "ALLOW",
            playable: true,
          },
        ];

    this.soundIndex = 0;
    this.playlistIndex = 0;
    this._syncActiveTrackMeta();
    this._handlers = new Map();
    this._progressHandle = null;
    this._stallTimer = null;
    this._instanceSeq = 0;
    this.instances = [];
    this.currentWidget = null;
    this.postMessageQueueCount = 0;
  }

  _activeSound() {
    return this.sounds[this.soundIndex] || this.sounds[0] || null;
  }

  _syncActiveTrackMeta() {
    const s = this._activeSound();
    if (!s) return;
    const dur = Math.max(0, Number(s.duration) || 0);
    const fullDur = Math.max(0, Number(s.full_duration) || 0);
    const policy = String(s.policy || "ALLOW").toUpperCase();
    this.durationMs = dur > 0 ? dur : this.config.durationMs;
    this.isPreview = policy === "SNIP" || (fullDur > 45000 && dur > 0 && dur <= 35000 && dur < fullDur * 0.75);
    this.previewDurationMs = this.isPreview ? (dur > 0 ? dur : 30000) : 0;
    this.blocked = policy === "BLOCK" || s.playable === false || this.errored;
  }

  _emit(ev, payload) {
    if (this.destroyed) return;
    const list = this._handlers.get(ev);
    if (!list) return;
    for (const fn of list.slice()) {
      fn(payload);
    }
  }

  _enqueuePostMessage(cb, valueFactory) {
    if (typeof cb !== "function" || this.destroyed) return;
    this._syncPhysics();
    const captured = this.config.capturePostMessageAtCallTime ? valueFactory() : undefined;
    let delayMs = this.prng.jitter(this.config.postMessageDelayMs, this.config.postMessageJitterMs);
    if (this.config.outOfOrderProb > 0 && this.prng.chance(this.config.outOfOrderProb)) {
      delayMs += this.prng.int(30, 95);
    }
    this.postMessageQueueCount += 1;
    this._scheduleTimer(delayMs, () => {
      this.postMessageQueueCount = Math.max(0, this.postMessageQueueCount - 1);
      if (this.destroyed) return;
      const val = this.config.capturePostMessageAtCallTime ? captured : valueFactory();
      cb(val);
    });
  }

  _startProgressLoop() {
    this._stopProgressLoop();
    if (!this.playing || this.destroyed) return;
    const step = Math.max(50, Number(this.config.progressIntervalMs) || 250);
    this._progressHandle = this._scheduleInterval(step, () => {
      if (!this.playing || this.destroyed) {
        this._stopProgressLoop();
        return;
      }
      this._syncPhysics();
      if (!this.playing) return;
      this._emit(SC_EVENTS.PLAY_PROGRESS, {
        currentPosition: Math.round(this.positionMs),
        relativePosition:
          this._effectiveDurationMs() > 0 ? this.positionMs / this._effectiveDurationMs() : 0,
        soundId: this._activeSound()?.id,
      });
    });
  }

  _stopProgressLoop() {
    if (this._progressHandle) {
      this._progressHandle.cancel();
      this._progressHandle = null;
    }
  }

  _onPlayheadReachedEnd() {
    const capMs = this._effectiveDurationMs();
    this.positionMs = capMs;
    this.playing = false;
    this._stopProgressLoop();

    if (this.isPreview) {
      // Real SoundCloud SNIP 30s preview cap emits PAUSE + FINISH at preview limit
      this.ended = false;
      this._emit(SC_EVENTS.PAUSE, {
        currentPosition: Math.round(capMs),
        soundId: this._activeSound()?.id,
      });
      this._emit(SC_EVENTS.FINISH, {
        currentPosition: Math.round(capMs),
        soundId: this._activeSound()?.id,
      });
      return;
    }

    if (this.sounds.length > 1 && this.soundIndex < this.sounds.length - 1) {
      this.soundIndex += 1;
      this.playlistIndex = this.soundIndex;
      this.positionMs = 0;
      this._syncActiveTrackMeta();
      this._emit(SC_EVENTS.FINISH, { currentPosition: Math.round(capMs) });
      if (!this.blocked) {
        this.playing = true;
        this._startProgressLoop();
      }
      return;
    }

    this.ended = true;
    this._emit(SC_EVENTS.FINISH, { currentPosition: Math.round(capMs) });
  }

  createSdk() {
    const adapter = this;

    function MockSCWidget(iframe) {
      adapter._clearAllAdapterTimers();
      adapter.destroyed = false;
      adapter.ready = false;
      adapter.playing = false;
      adapter.unstarted = true;
      adapter.ended = false;
      adapter.stalled = false;
      adapter.errored = false;
      adapter.hasUserGesture = false;
      adapter.positionMs = 0;
      adapter._handlers = new Map();
      adapter._physicsLastBaseMs = adapter._nowBaseMs();

      // Parse start_track from iframe src if present
      const srcStr = String(iframe?.src || "");
      const m = srcStr.match(/[?&]start_track=(\d+)/);
      if (m) {
        const idx = Math.max(0, Math.min(adapter.sounds.length - 1, Number(m[1]) || 0));
        adapter.soundIndex = idx;
        adapter.playlistIndex = idx;
      }
      adapter._syncActiveTrackMeta();

      const instanceToken = ++adapter._instanceSeq;
      const isAlive = () => !adapter.destroyed && instanceToken === adapter._instanceSeq;

      const widget = {
        iframe,
        bind(ev, fn) {
          if (!adapter._handlers.has(ev)) adapter._handlers.set(ev, []);
          adapter._handlers.get(ev).push(fn);
        },
        unbind(ev) {
          adapter._handlers.delete(ev);
        },
        play() {
          adapter._scheduleSdkCommand("play", [], () => {
            if (!isAlive() || adapter.blocked || adapter.errored) return;
            if (adapter.autoplayBlocked && !adapter.hasUserGesture) {
              return;
            }
            if (adapter.isPreview && adapter.positionMs >= adapter._effectiveDurationMs()) {
              adapter._onPlayheadReachedEnd();
              return;
            }
            adapter.playing = true;
            adapter.unstarted = false;
            adapter.ended = false;
            adapter._physicsLastBaseMs = adapter._nowBaseMs();
            adapter._startProgressLoop();
            const payload = { currentPosition: Math.round(adapter.positionMs) };
            if (!adapter.config.omitSoundIdOnPlay && adapter._activeSound()?.id !== undefined) {
              payload.soundId = adapter._activeSound().id;
            }
            adapter._emit(SC_EVENTS.PLAY, payload);
          });
        },
        pause() {
          adapter._scheduleSdkCommand("pause", [], () => {
            if (!isAlive()) return;
            adapter._syncPhysics();
            adapter.playing = false;
            adapter._stopProgressLoop();
            adapter._emit(SC_EVENTS.PAUSE, {
              currentPosition: Math.round(adapter.positionMs),
              soundId: adapter._activeSound()?.id,
            });
          });
        },
        seekTo(ms) {
          adapter._scheduleSdkCommand("seekTo", [ms], () => {
            if (!isAlive() || adapter.blocked || adapter.errored) return;
            const target = adapter._applyKeyframeSnap(ms);
            adapter.positionMs = target;
            adapter.ended = false;
            adapter._emit(SC_EVENTS.SEEK, { currentPosition: Math.round(target) });
            if (adapter.isPreview && target >= adapter._effectiveDurationMs() && adapter.playing) {
              adapter._onPlayheadReachedEnd();
            }
          });
        },
        skip(idx) {
          adapter._scheduleSdkCommand("skip", [idx], () => {
            if (!isAlive()) return;
            const cleanIdx = Math.max(0, Math.min(adapter.sounds.length - 1, Math.trunc(Number(idx) || 0)));
            adapter.soundIndex = cleanIdx;
            adapter.playlistIndex = cleanIdx;
            adapter.positionMs = 0;
            adapter.errored = false;
            adapter.ended = false;
            adapter._syncActiveTrackMeta();
          });
        },
        setVolume(v) {
          adapter._recordLocalCall("setVolume", [v]);
          adapter.volume = Math.max(0, Math.min(100, Number(v) || 0));
        },
        isPaused(cb) {
          adapter._enqueuePostMessage(cb, () => !adapter.playing);
        },
        getPosition(cb) {
          adapter._enqueuePostMessage(cb, () => Math.round(adapter.positionMs));
        },
        getDuration(cb) {
          adapter._enqueuePostMessage(cb, () => Math.round(adapter._effectiveDurationMs()));
        },
        getCurrentSound(cb) {
          adapter._enqueuePostMessage(cb, () => cloneSound(adapter._activeSound()));
        },
        getCurrentSoundIndex(cb) {
          adapter._enqueuePostMessage(cb, () => adapter.soundIndex);
        },
        getSounds(cb) {
          adapter._enqueuePostMessage(cb, () =>
            adapter.sounds.map((s, idx) => {
              // Model unhydrated `{ id }` stubs for non-active playlist tracks
              if (adapter.config.unhydratedStubs && idx !== adapter.soundIndex) {
                return { id: s.id };
              }
              return cloneSound(s);
            })
          );
        },
      };

      adapter.currentWidget = widget;
      adapter.instances.push(widget);

      adapter._scheduleTimer(adapter.config.readyDelayMs, () => {
        if (!isAlive() || adapter.currentWidget !== widget) return;
        adapter.ready = true;
        adapter._physicsLastBaseMs = adapter._nowBaseMs();
        adapter._emit(SC_EVENTS.READY, {});
      });

      return widget;
    }

    const Widget = Object.assign(MockSCWidget, { Events: SC_EVENTS });
    return { Widget };
  }

  /* ==================== User Interactions & Fault Injectors ==================== */

  userClickSeek(targetMs) {
    this._syncPhysics();
    this.hasUserGesture = true;
    const target = this._applyKeyframeSnap(targetMs);
    this.positionMs = target;
    this.ended = false;
    this._emit(SC_EVENTS.SEEK, { currentPosition: Math.round(target) });
  }

  userBufferedSeek(targetMs) {
    this.userClickSeek(targetMs);
  }

  userPausedSeek(targetMs) {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.playing = false;
    this._stopProgressLoop();
    const target = this._applyKeyframeSnap(targetMs);
    this.positionMs = target;
    this.ended = false;
    this._emit(SC_EVENTS.SEEK, { currentPosition: Math.round(target) });
  }

  userDragScrub(targetMs) {
    this.userClickSeek(targetMs);
  }

  userPlay({ omitSoundId = undefined } = {}) {
    this._syncPhysics();
    this.hasUserGesture = true;
    if (this.blocked && !this.errored) return;
    if (this.errored) {
      this.errored = false;
      this._syncActiveTrackMeta();
    }
    this.playing = true;
    this.unstarted = false;
    this.ended = false;
    this._physicsLastBaseMs = this._nowBaseMs();
    this._startProgressLoop();
    const shouldOmit = omitSoundId !== undefined ? Boolean(omitSoundId) : Boolean(this.config.omitSoundIdOnPlay);
    const payload = { currentPosition: Math.round(this.positionMs) };
    if (!shouldOmit && this._activeSound()?.id !== undefined) {
      payload.soundId = this._activeSound().id;
    }
    this._emit(SC_EVENTS.PLAY, payload);
  }

  userPause() {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.playing = false;
    this._stopProgressLoop();
    this._emit(SC_EVENTS.PAUSE, {
      currentPosition: Math.round(this.positionMs),
      soundId: this._activeSound()?.id,
    });
  }

  userSelectPlaylistTrack(index, { omitSoundId = undefined } = {}) {
    this._syncPhysics();
    this.hasUserGesture = true;
    const cleanIdx = Math.max(0, Math.min(this.sounds.length - 1, Math.trunc(Number(index) || 0)));
    this.soundIndex = cleanIdx;
    this.playlistIndex = cleanIdx;
    this.positionMs = 0;
    this.errored = false;
    this.ended = false;
    this._syncActiveTrackMeta();
    this.playing = !this.blocked;
    this.unstarted = false;
    if (this.playing) this._startProgressLoop();
    const shouldOmit = omitSoundId !== undefined ? Boolean(omitSoundId) : Boolean(this.config.omitSoundIdOnPlay);
    const payload = { currentPosition: 0 };
    if (!shouldOmit && this._activeSound()?.id !== undefined) {
      payload.soundId = this._activeSound().id;
    }
    this._emit(SC_EVENTS.PLAY, payload);
  }

  injectRebuffer(durationMs = 1500) {
    this._syncPhysics();
    this.stalled = true;
    if (this._stallTimer !== null) this._clearTimer(this._stallTimer);
    this._stallTimer = this._scheduleTimer(Math.max(10, Number(durationMs) || 1500), () => {
      this._stallTimer = null;
      this.stalled = false;
      this._physicsLastBaseMs = this._nowBaseMs();
    });
  }

  /**
   * Configures a SoundCloud 30s Go+/geo `SNIP` preview (supports both explicit `full_duration`
   * and omitted `full_duration`!).
   */
  injectSnip({
    previewDurationMs = 30000,
    fullDurationMs = 210000,
    omitFullDuration = false,
    monetizationModel = "SUB_HIGH_TIER",
    trackIndex = null,
  } = {}) {
    this._syncPhysics();
    const idx = trackIndex !== null ? Math.max(0, Math.min(this.sounds.length - 1, trackIndex)) : this.soundIndex;
    const target = this.sounds[idx];
    if (target) {
      target.policy = "SNIP";
      target.duration = Math.max(1000, Number(previewDurationMs) || 30000);
      if (omitFullDuration) {
        delete target.full_duration;
      } else {
        target.full_duration = Math.max(target.duration, Number(fullDurationMs) || 210000);
      }
      target.monetization_model = monetizationModel;
      target.playable = true;
    }
    this._syncActiveTrackMeta();
    if (this.positionMs >= this._effectiveDurationMs() && this.playing) {
      this._onPlayheadReachedEnd();
    }
  }

  injectBlock(trackIndex = null) {
    this._syncPhysics();
    const idx = trackIndex !== null ? Math.max(0, Math.min(this.sounds.length - 1, trackIndex)) : this.soundIndex;
    const target = this.sounds[idx];
    if (target) {
      target.policy = "BLOCK";
      target.playable = false;
    }
    this._syncActiveTrackMeta();
    if (idx === this.soundIndex) {
      this.playing = false;
      this._stopProgressLoop();
    }
  }

  injectError(message = "stream_unavailable") {
    this._syncPhysics();
    if (String(message).toUpperCase() === "BLOCK") {
      this.injectBlock();
      return;
    }
    this.errored = true;
    this.blocked = true;
    this.playing = false;
    this._stopProgressLoop();
    this._emit(SC_EVENTS.ERROR, { message: String(message || "error") });
  }

  snapshot() {
    const base = super.snapshot();
    const active = this._activeSound();
    return {
      ...base,
      soundIndex: this.soundIndex,
      playlistCount: this.sounds.length,
      policy: active?.policy || "ALLOW",
      fullDurationMs: Number(active?.full_duration) || 0,
      postMessageQueueCount: this.postMessageQueueCount,
    };
  }
}

/**
 * Realistic async Spotify IFrame API adapter (`IFrameAPI.createController`).
 *
 * Models real Spotify Harmony embed quirks:
 * - `createController` + `loadUri` sequencing
 * - Periodic `playback_update` cadence (and `playback_started` on playlist track switches)
 * - 30s preview (~29.7s) vs full-track (> 32s) duration classification
 * - EME DRM probe failure & force re-probe on `reloadPlayerSession()`
 * - Delayed Harmony `isPaused: true` boot hydration update
 * - Detached playlist track loading (`loadUri("spotify:track:...")` vs playlist URI)
 * - `resume()` vs `play()` (restarts at 0s) and 1-second integer `seek(sec)` granularity
 */

import { BaseFakeProviderAdapter } from "./base_adapter.mjs";

export class FakeSpotifyAdapter extends BaseFakeProviderAdapter {
  constructor(options = {}) {
    super({
      ...options,
      provider: "spotify",
      config: {
        createControllerDelayMs: 10,
        readyDelayMs: 30,
        updateCadenceMs: 500,
        delayedBootPausedMs: 120,
        previewMode: false,
        previewDurationMs: 29713,
        durationMs: 213_573,
        drmSupported: true,
        browserUserAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        isBrave: false,
        isSecureContext: true,
        ...(options.config || {}),
      },
    });

    this.drmSupported = Boolean(this.config.drmSupported);
    this.drmProbeCount = 0;
    this.lastDrmProbeForce = false;
    this.currentUri = "";
    this.playlistUri = "";
    this.isDetached = false;
    this.hasContext = false;
    this.isPreview = Boolean(this.config.previewMode);
    this.previewDurationMs = this.isPreview ? this.config.previewDurationMs : 0;
    this._listeners = new Map();
    this._cadenceHandle = null;
    this.instances = [];
    this.currentController = null;
  }

  _emit(ev, data) {
    if (this.destroyed) return;
    const list = this._listeners.get(ev);
    if (!list) return;
    for (const fn of list.slice()) {
      fn({ data });
    }
  }

  _emitPlaybackUpdate({ isBuffering = false } = {}) {
    this._syncPhysics();
    this._emit("playback_update", {
      isPaused: !this.playing,
      isBuffering: Boolean(isBuffering || this.buffering),
      position: Math.round(this.positionMs),
      duration: Math.round(this._effectiveDurationMs()),
      playingURI: this.currentUri,
    });
  }

  _startCadenceLoop() {
    this._stopCadenceLoop();
    if (!this.playing || this.destroyed) return;
    const step = Math.max(50, Number(this.config.updateCadenceMs) || 500);
    this._cadenceHandle = this._scheduleInterval(step, () => {
      if (!this.playing || this.destroyed) {
        this._stopCadenceLoop();
        return;
      }
      this._emitPlaybackUpdate();
    });
  }

  _stopCadenceLoop() {
    if (this._cadenceHandle) {
      this._cadenceHandle.cancel();
      this._cadenceHandle = null;
    }
  }

  _onPlayheadReachedEnd() {
    this.positionMs = this._effectiveDurationMs();
    this.playing = false;
    this.ended = !this.isPreview;
    this._stopCadenceLoop();
    this._emitPlaybackUpdate();
  }

  /**
   * Produces a per-peer environment override object compatible with `WatchTogetherPlayer`
   * `options.env` (`detectSpotifyBrowserConstraints`, `probeSpotifyDrmSupport`, `document`).
   */
  createEnv() {
    const adapter = this;
    return {
      document: this.document,
      createElement: (tag) => this.document.createElement(tag),
      isSecureContext: this.config.isSecureContext,
      userAgent: this.config.browserUserAgent,
      isBrave: this.config.isBrave,
      probeSpotifyDrmSupport: async ({ force = false } = {}) => {
        adapter.drmProbeCount += 1;
        adapter.lastDrmProbeForce = Boolean(force);
        return Boolean(adapter.drmSupported && adapter.config.isSecureContext);
      },
      detectSpotifyBrowserConstraints: () => ({
        browser: adapter.config.isBrave ? "brave" : "chrome",
        isMobile: /Mobile|Android|iPhone|iPad/i.test(adapter.config.browserUserAgent),
        isSafari:
          /Safari\//i.test(adapter.config.browserUserAgent) &&
          !/Chrome\/|Chromium\//i.test(adapter.config.browserUserAgent),
        isSecureContext: Boolean(adapter.config.isSecureContext),
        drmSupported: Boolean(adapter.drmSupported),
      }),
    };
  }

  setDrmSupported(supported) {
    this.drmSupported = Boolean(supported);
  }

  injectDrmFailure() {
    this.drmSupported = false;
    this.injectError("eme_drm_unavailable");
  }

  createSdk() {
    const adapter = this;

    return {
      createController(holder, opts = {}, cb) {
        adapter._clearAllAdapterTimers();
        adapter.destroyed = false;
        adapter.ready = false;
        adapter.playing = false;
        adapter.buffering = false;
        adapter.unstarted = true;
        adapter.ended = false;
        adapter.errored = false;
        adapter.blocked = false;
        adapter.hasContext = false;
        adapter.hasUserGesture = false;
        adapter._listeners = new Map();
        adapter._physicsLastBaseMs = adapter._nowBaseMs();

        const iframe = adapter.document.createElement("iframe");
        iframe.setAttribute("allowfullscreen", "");
        iframe.setAttribute("loading", "lazy");
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.setAttribute("credentialless", "");
        holder?.parentElement?.replaceChild?.(iframe, holder);

        let ctrlDestroyed = false;
        let readyFired = false;

        const ctrl = {
          iframeElement: iframe,
          opts,
          addListener(ev, fn) {
            if (!adapter._listeners.has(ev)) adapter._listeners.set(ev, []);
            adapter._listeners.get(ev).push(fn);
          },
          removeListener(ev) {
            adapter._listeners.delete(ev);
          },
          loadUri(uri, preferVideo = false, startSec = 0) {
            adapter._scheduleSdkCommand("loadUri", [uri, preferVideo, startSec], () => {
              if (ctrlDestroyed) return;
              const uriStr = String(uri || "");
              adapter.currentUri = uriStr;
              if (uriStr.startsWith("spotify:playlist:") || uriStr.startsWith("spotify:album:")) {
                adapter.playlistUri = uriStr;
                adapter.isDetached = false;
              } else if (adapter.playlistUri && uriStr !== adapter.playlistUri) {
                adapter.isDetached = true;
              }
              adapter.trackUri = uriStr;
              adapter.positionMs = adapter._clampPosition((Number(startSec) || 0) * 1000);
              adapter.playing = false;
              adapter.ended = false;
              adapter.hasContext = false;
              adapter._stopCadenceLoop();

              if (!readyFired) {
                readyFired = true;
                adapter._scheduleTimer(adapter.config.readyDelayMs, () => {
                  if (ctrlDestroyed) return;
                  adapter.ready = true;
                  adapter._emit("ready", {});
                  // Delayed Harmony `isPaused: true` hydration update after boot/reload
                  const bootDelay = Math.max(0, Number(adapter.config.delayedBootPausedMs) || 0);
                  if (bootDelay > 0) {
                    adapter._scheduleTimer(bootDelay, () => {
                      if (ctrlDestroyed) return;
                      if (!adapter.playing) {
                        adapter._emitPlaybackUpdate();
                      }
                    });
                  }
                });
              } else {
                adapter._emitPlaybackUpdate();
              }
            });
          },
          loadEntity(uri, preferVideo = false, startSec = 0) {
            this.loadUri(uri, preferVideo, startSec);
          },
          resume() {
            adapter._scheduleSdkCommand("resume", [], () => {
              if (ctrlDestroyed || adapter.errored) return;
              if (adapter.autoplayBlocked && !adapter.hasUserGesture) {
                // Autoplay blocked: stay paused and emit delayed paused update
                adapter._emitPlaybackUpdate();
                return;
              }
              adapter.hasContext = true;
              adapter.playing = true;
              adapter.unstarted = false;
              adapter.ended = false;
              adapter._physicsLastBaseMs = adapter._nowBaseMs();
              adapter._startCadenceLoop();
              adapter._emitPlaybackUpdate();
            });
          },
          play() {
            // Real Spotify quirk: `play()` restarts from 0:00!
            adapter._scheduleSdkCommand("play", [], () => {
              if (ctrlDestroyed || adapter.errored) return;
              if (adapter.autoplayBlocked && !adapter.hasUserGesture) {
                adapter._emitPlaybackUpdate();
                return;
              }
              adapter.hasContext = true;
              adapter.positionMs = 0;
              adapter.playing = true;
              adapter.unstarted = false;
              adapter.ended = false;
              adapter._physicsLastBaseMs = adapter._nowBaseMs();
              adapter._startCadenceLoop();
              adapter._emitPlaybackUpdate();
            });
          },
          pause() {
            adapter._scheduleSdkCommand("pause", [], () => {
              if (ctrlDestroyed) return;
              adapter._syncPhysics();
              adapter.playing = false;
              adapter._stopCadenceLoop();
              adapter._emitPlaybackUpdate();
            });
          },
          seek(sec) {
            adapter._scheduleSdkCommand("seek", [sec], () => {
              if (ctrlDestroyed || adapter.errored) return;
              // Spotify IFrame API seeks at integer second granularity
              const secInt = Math.max(0, Math.floor(Number(sec) || 0));
              adapter.positionMs = adapter._applyKeyframeSnap(secInt * 1000);
              adapter.hasContext = true;
              adapter.ended = false;
              adapter._emitPlaybackUpdate();
            });
          },
          destroy() {
            ctrlDestroyed = true;
            adapter._recordLocalCall("destroy", []);
            if (adapter.currentController === ctrl) {
              adapter._clearAllAdapterTimers();
              adapter.ready = false;
              adapter.playing = false;
              adapter.destroyed = true;
            }
          },
        };

        adapter.currentController = ctrl;
        adapter.instances.push(ctrl);

        adapter._scheduleTimer(adapter.config.createControllerDelayMs, () => {
          if (ctrlDestroyed) return;
          cb?.(ctrl);
        });
      },
    };
  }

  /* ==================== User Interactions & Fault Injectors ==================== */

  userClickSeek(targetMs) {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.hasContext = true;
    this.positionMs = this._applyKeyframeSnap(targetMs);
    this.ended = false;
    this._emitPlaybackUpdate();
  }

  userBufferedSeek(targetMs) {
    this.userClickSeek(targetMs);
  }

  userPausedSeek(targetMs) {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.hasContext = true;
    this.playing = false;
    this._stopCadenceLoop();
    this.positionMs = this._applyKeyframeSnap(targetMs);
    this.ended = false;
    this._emitPlaybackUpdate();
  }

  userDragScrub(targetMs) {
    this.userClickSeek(targetMs);
  }

  userPlay() {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.hasContext = true;
    this.errored = false;
    this.blocked = false;
    this.playing = true;
    this.unstarted = false;
    this.ended = false;
    this._physicsLastBaseMs = this._nowBaseMs();
    this._startCadenceLoop();
    this._emitPlaybackUpdate();
  }

  userPause() {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.playing = false;
    this._stopCadenceLoop();
    this._emitPlaybackUpdate();
  }

  userSelectPlaylistTrack(trackUri) {
    this._syncPhysics();
    this.hasUserGesture = true;
    this.hasContext = true;
    const uri = String(trackUri || "");
    this.currentUri = uri;
    this.trackUri = uri;
    this.isDetached = Boolean(this.playlistUri && uri !== this.playlistUri);
    this.positionMs = 0;
    this.errored = false;
    this.blocked = false;
    this.playing = true;
    this.unstarted = false;
    this.ended = false;
    this._physicsLastBaseMs = this._nowBaseMs();
    this._startCadenceLoop();
    this._emit("playback_started", { playingURI: uri });
    this._emitPlaybackUpdate();
  }

  injectRebuffer(durationMs = 1800) {
    this._syncPhysics();
    this.buffering = true;
    this._emitPlaybackUpdate({ isBuffering: true });
    this._scheduleTimer(Math.max(10, Number(durationMs) || 1800), () => {
      this.buffering = false;
      this._physicsLastBaseMs = this._nowBaseMs();
      this._emitPlaybackUpdate({ isBuffering: false });
    });
  }

  injectSnip({ previewDurationMs = 29713 } = {}) {
    this._syncPhysics();
    this.isPreview = true;
    this.previewDurationMs = Math.max(1000, Number(previewDurationMs) || 29713);
    if (this.positionMs >= this.previewDurationMs && this.playing) {
      this._onPlayheadReachedEnd();
    } else if (this.ready) {
      this._emitPlaybackUpdate();
    }
  }

  injectError(message = "playback_error") {
    this._syncPhysics();
    this.errored = true;
    this.blocked = true;
    this.playing = false;
    this._stopCadenceLoop();
    this._emit("error", { message: String(message || "playback_error") });
  }

  snapshot() {
    const base = super.snapshot();
    return {
      ...base,
      currentUri: this.currentUri,
      playlistUri: this.playlistUri,
      isDetached: this.isDetached,
      drmSupported: this.drmSupported,
      drmProbeCount: this.drmProbeCount,
    };
  }
}

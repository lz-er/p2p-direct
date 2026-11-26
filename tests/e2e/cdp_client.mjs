/**
 * Zero-dependency Chrome DevTools Protocol (CDP) client using Node 24's built-in `WebSocket`.
 *
 * Features:
 * - Auto-detects Chrome/Chromium (`CHROME_BIN`, `google-chrome`, `google-chrome-stable`,
 *   `chromium`, `chromium-browser`, NixOS & Linux standard paths).
 * - Spawns isolated headless Chromium with temp user-data-dir cleaned up unconditionally.
 * - Isolated BrowserContexts (`Target.createBrowserContext`), flattened CDP sessions,
 *   `Page.addScriptToEvaluateOnNewDocument`, `Emulation.setDeviceMetricsOverride`,
 *   console & uncaught `pageerror` collection.
 * - Deterministic `Fetch.enable` interception for YouTube, Spotify, SoundCloud, and Twitch
 *   embed APIs & iframe documents so E2E tests never touch the public internet.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

const CHROME_FALLBACK_PATHS = [
  "/etc/profiles/per-user/lzer/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findChromeBinary() {
  if (process.env.CHROME_BIN && isExecutable(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  for (const name of CHROME_CANDIDATES) {
    const res = spawnSync("which", [name], { encoding: "utf8" });
    if (res.status === 0) {
      const found = res.stdout.trim().split("\n")[0]?.trim();
      if (found && isExecutable(found)) {
        return found;
      }
    }
  }
  for (const absPath of CHROME_FALLBACK_PATHS) {
    if (isExecutable(absPath)) {
      return absPath;
    }
  }
  throw new Error(
    "Could not locate Chrome/Chromium binary. Set CHROME_BIN or install google-chrome / chromium."
  );
}

/* ==================== Deterministic Local Embed Stub Scripts ==================== */

const STUB_YOUTUBE_API_JS = `(() => {
  if (window.YT && typeof window.YT.Player === "function") {
    if (typeof window.onYouTubeIframeAPIReady === "function") window.onYouTubeIframeAPIReady();
    return;
  }
  window.__STUB_YT_PLAYERS__ = window.__STUB_YT_PLAYERS__ || [];
  function StubYTPlayer(holder, opts) {
    const el = typeof holder === "string" ? document.getElementById(holder) : holder;
    const iframe = document.createElement("iframe");
    iframe.className = "watch-embed-iframe stub-yt-iframe";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    iframe.srcdoc = "<!doctype html><html><body style='margin:0;background:#101218;color:#d8f53c;font:12px monospace;display:flex;align-items:center;justify-content:center;height:100vh'>YOUTUBE STUB</body></html>";
    if (el) {
      el.innerHTML = "";
      el.appendChild(iframe);
    }
    const startSec = Math.max(0, Number(opts?.playerVars?.start) || 0);
    const playlist = opts?.playerVars?.list ? ["stubVidA", "stubVidB", "stubVidC"] : null;
    const player = {
      opts,
      iframe,
      state: 2, // PAUSED
      baseTimeSec: startSec,
      basePerfMs: performance.now(),
      durationSec: 240,
      rate: 1,
      muted: false,
      volume: 80,
      playlist,
      playlistIndex: Math.max(0, Number(opts?.playerVars?.index) || 0),
      calls: [],
      destroyed: false,
      getIframe() {
        return this.iframe;
      },
      getPlayerState() {
        return this.state;
      },
      getCurrentTime() {
        if (this.state === 1) {
          const dt = Math.max(0, (performance.now() - this.basePerfMs) / 1000);
          return Math.min(this.durationSec, this.baseTimeSec + dt * this.rate);
        }
        return this.baseTimeSec;
      },
      getDuration() {
        return this.durationSec;
      },
      getPlaybackRate() {
        return this.rate;
      },
      setPlaybackRate(r) {
        this.baseTimeSec = this.getCurrentTime();
        this.basePerfMs = performance.now();
        this.rate = Number(r) || 1;
        this.calls.push(["setPlaybackRate", this.rate]);
        setTimeout(() => {
          if (!this.destroyed) opts?.events?.onPlaybackRateChange?.({ data: this.rate });
        }, 10);
      },
      getPlaylist() {
        return this.playlist;
      },
      getPlaylistIndex() {
        return this.playlistIndex;
      },
      getVideoData() {
        const vid = this.playlist ? this.playlist[this.playlistIndex] : opts?.videoId || "stubVid";
        return { video_id: vid, title: "Stub YouTube Video (" + vid + ")", author: "StubChannel" };
      },
      playVideo() {
        this.baseTimeSec = this.getCurrentTime();
        this.basePerfMs = performance.now();
        this.state = 1;
        this.calls.push(["playVideo", this.baseTimeSec]);
        setTimeout(() => {
          if (!this.destroyed) opts?.events?.onStateChange?.({ data: 1 });
        }, 12);
      },
      pauseVideo() {
        this.baseTimeSec = this.getCurrentTime();
        this.basePerfMs = performance.now();
        this.state = 2;
        this.calls.push(["pauseVideo", this.baseTimeSec]);
        setTimeout(() => {
          if (!this.destroyed) opts?.events?.onStateChange?.({ data: 2 });
        }, 12);
      },
      seekTo(sec, allowSeekAhead) {
        const clamped = Math.max(0, Math.min(this.durationSec, Number(sec) || 0));
        this.baseTimeSec = clamped;
        this.basePerfMs = performance.now();
        this.calls.push(["seekTo", clamped, Boolean(allowSeekAhead)]);
      },
      playVideoAt(idx) {
        this.playlistIndex = Math.max(0, Number(idx) || 0);
        this.baseTimeSec = 0;
        this.basePerfMs = performance.now();
        this.state = 1;
        this.calls.push(["playVideoAt", this.playlistIndex]);
        setTimeout(() => {
          if (!this.destroyed) opts?.events?.onStateChange?.({ data: 1 });
        }, 12);
      },
      setLoop(v) {
        this.calls.push(["setLoop", Boolean(v)]);
      },
      setVolume(v) {
        this.volume = Number(v) || 0;
      },
      mute() {
        this.muted = true;
        this.calls.push(["mute"]);
      },
      unMute() {
        this.muted = false;
        this.calls.push(["unMute"]);
      },
      isMuted() {
        return this.muted;
      },
      destroy() {
        this.destroyed = true;
        this.calls.push(["destroy"]);
        try { this.iframe.remove(); } catch {}
      },
      triggerError(code) {
        opts?.events?.onError?.({ data: code });
      },
    };
    window.__STUB_YT_PLAYERS__.push(player);
    setTimeout(() => {
      if (!player.destroyed) {
        opts?.events?.onReady?.({ target: player });
        if (window.__STUB_YT_ERROR_CODE__) {
          opts?.events?.onError?.({ data: window.__STUB_YT_ERROR_CODE__ });
        }
      }
    }, 15);
    return player;
  }
  window.YT = {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: StubYTPlayer,
  };
  if (typeof window.onYouTubeIframeAPIReady === "function") {
    window.onYouTubeIframeAPIReady();
  }
})();`;

const STUB_SPOTIFY_API_JS = `(() => {
  window.__STUB_SPOTIFY_CTRLS__ = window.__STUB_SPOTIFY_CTRLS__ || [];
  const IFrameAPI = {
    createController(holder, opts, cb) {
      const iframe = document.createElement("iframe");
      iframe.className = "watch-embed-iframe stub-spotify-iframe";
      iframe.style.width = "100%";
      iframe.style.height = typeof opts?.height === "number" ? opts.height + "px" : (opts?.height || "152px");
      iframe.style.border = "0";
      iframe.srcdoc = "<!doctype html><html><body style='margin:0;background:#121212;color:#1db954;font:12px monospace;display:flex;align-items:center;justify-content:center;height:100vh'>SPOTIFY STUB</body></html>";
      if (holder) {
        holder.innerHTML = "";
        holder.appendChild(iframe);
      }
      const listeners = new Map();
      const emit = (ev, data) => {
        for (const fn of (listeners.get(ev) || []).slice()) {
          try { fn({ data }); } catch {}
        }
      };
      const isPreview = Boolean(window.__STUB_SPOTIFY_PREVIEW__);
      const ctrl = {
        iframeElement: iframe,
        opts,
        uri: opts?.uri || "",
        paused: true,
        basePosMs: 0,
        basePerfMs: performance.now(),
        durationMs: isPreview ? 30000 : 210000,
        calls: [],
        destroyed: false,
        _curPosMs() {
          if (!this.paused) {
            const dt = Math.max(0, performance.now() - this.basePerfMs);
            return Math.min(this.durationMs, Math.round(this.basePosMs + dt));
          }
          return Math.round(this.basePosMs);
        },
        _emitUpdate() {
          if (this.destroyed) return;
          emit("playback_update", {
            position: this._curPosMs(),
            duration: this.durationMs,
            isPaused: this.paused,
            isBuffering: false,
            playingURI: this.uri,
          });
        },
        addListener(ev, fn) {
          if (!listeners.has(ev)) listeners.set(ev, []);
          listeners.get(ev).push(fn);
        },
        removeListener(ev, fn) {
          const arr = listeners.get(ev);
          if (!arr) return;
          const idx = arr.indexOf(fn);
          if (idx >= 0) arr.splice(idx, 1);
        },
        loadUri(uri, preferVideo, startSec) {
          this.uri = String(uri || "");
          this.basePosMs = Math.max(0, Number(startSec) || 0) * 1000;
          this.basePerfMs = performance.now();
          this.durationMs = window.__STUB_SPOTIFY_PREVIEW__ ? 30000 : 210000;
          this.calls.push(["loadUri", this.uri, Boolean(preferVideo), Number(startSec) || 0]);
          setTimeout(() => this._emitUpdate(), 15);
        },
        play() {
          this.basePosMs = 0;
          this.basePerfMs = performance.now();
          this.paused = false;
          this.calls.push(["play"]);
          setTimeout(() => this._emitUpdate(), 15);
        },
        resume() {
          this.basePosMs = this._curPosMs();
          this.basePerfMs = performance.now();
          this.paused = false;
          this.calls.push(["resume"]);
          setTimeout(() => this._emitUpdate(), 15);
        },
        pause() {
          this.basePosMs = this._curPosMs();
          this.basePerfMs = performance.now();
          this.paused = true;
          this.calls.push(["pause"]);
          setTimeout(() => this._emitUpdate(), 15);
        },
        seek(sec) {
          this.basePosMs = Math.max(0, Math.min(this.durationMs, Math.round((Number(sec) || 0) * 1000)));
          this.basePerfMs = performance.now();
          this.calls.push(["seek", Number(sec) || 0]);
          setTimeout(() => this._emitUpdate(), 15);
        },
        destroy() {
          this.destroyed = true;
          this.calls.push(["destroy"]);
          try { this.iframeElement.remove(); } catch {}
        },
      };
      window.__STUB_SPOTIFY_CTRLS__.push(ctrl);
      if (typeof cb === "function") cb(ctrl);
      setTimeout(() => {
        if (!ctrl.destroyed) {
          emit("ready", {});
          ctrl._emitUpdate();
        }
      }, 20);
    },
  };
  window.__spotifyIframeApi = IFrameAPI;
  if (typeof window.onSpotifyIframeApiReady === "function") {
    window.onSpotifyIframeApiReady(IFrameAPI);
  }
})();`;

const STUB_SOUNDCLOUD_API_JS = `(() => {
  window.__STUB_SC_WIDGETS__ = window.__STUB_SC_WIDGETS__ || [];
  const Events = {
    READY: "ready",
    PLAY: "play",
    PAUSE: "pause",
    PLAY_PROGRESS: "playProgress",
    SEEK: "seek",
    FINISH: "finish",
    ERROR: "error",
  };
  function createWidget(iframe) {
    const handlers = new Map();
    const cfg = window.__STUB_SC_CONFIG__ || {};
    const isSnip = cfg.policy === "SNIP";
    const durMs = Number(cfg.duration) || (isSnip ? 30000 : 180000);
    const fullDurMs = Number(cfg.full_duration) || 180000;
    const defaultSound = {
      id: 1001,
      title: cfg.title || (isSnip ? "Stub Go+ Preview Track" : "Stub SoundCloud Track"),
      duration: durMs,
      full_duration: fullDurMs,
      policy: cfg.policy || "ALLOW",
      monetization_model: isSnip ? "SUB_HIGH_TIER" : "NOT_APPLICABLE",
      user: { username: "StubArtist" },
    };
    const emit = (ev, payload) => {
      for (const fn of (handlers.get(ev) || []).slice()) {
        try { fn(payload); } catch {}
      }
    };
    const widget = {
      iframe,
      paused: true,
      basePosMs: 0,
      basePerfMs: performance.now(),
      durationMs: durMs,
      volume: 80,
      soundIndex: 0,
      sounds: Array.isArray(cfg.sounds) && cfg.sounds.length > 0 ? cfg.sounds : [defaultSound],
      calls: [],
      _curPosMs() {
        if (!this.paused) {
          const dt = Math.max(0, performance.now() - this.basePerfMs);
          return Math.min(this.durationMs, Math.round(this.basePosMs + dt));
        }
        return Math.round(this.basePosMs);
      },
      bind(ev, fn) {
        if (!handlers.has(ev)) handlers.set(ev, []);
        handlers.get(ev).push(fn);
        if (ev === Events.READY) {
          setTimeout(() => emit(Events.READY, {}), 20);
        }
      },
      unbind(ev) {
        handlers.delete(ev);
      },
      play() {
        this.basePosMs = this._curPosMs();
        this.basePerfMs = performance.now();
        this.paused = false;
        this.calls.push(["play", this.basePosMs]);
        setTimeout(() => emit(Events.PLAY, { currentPosition: this._curPosMs(), soundId: this.sounds[this.soundIndex]?.id }), 12);
      },
      pause() {
        this.basePosMs = this._curPosMs();
        this.basePerfMs = performance.now();
        this.paused = true;
        this.calls.push(["pause", this.basePosMs]);
        setTimeout(() => emit(Events.PAUSE, { currentPosition: this._curPosMs(), soundId: this.sounds[this.soundIndex]?.id }), 12);
      },
      seekTo(ms) {
        const clamped = Math.max(0, Math.min(this.durationMs, Math.round(Number(ms) || 0)));
        this.basePosMs = clamped;
        this.basePerfMs = performance.now();
        this.calls.push(["seekTo", clamped]);
        setTimeout(() => emit(Events.SEEK, { currentPosition: clamped, soundId: this.sounds[this.soundIndex]?.id }), 12);
      },
      skip(idx) {
        this.soundIndex = Math.max(0, Math.min(this.sounds.length - 1, Number(idx) || 0));
        this.basePosMs = 0;
        this.basePerfMs = performance.now();
        this.calls.push(["skip", this.soundIndex]);
      },
      setVolume(v) {
        this.volume = Number(v) || 0;
      },
      getPosition(cb) {
        const val = this._curPosMs();
        setTimeout(() => cb?.(val), 5);
      },
      getDuration(cb) {
        const val = this.durationMs;
        setTimeout(() => cb?.(val), 5);
      },
      isPaused(cb) {
        const val = this.paused;
        setTimeout(() => cb?.(val), 5);
      },
      getCurrentSound(cb) {
        const s = this.sounds[this.soundIndex] || defaultSound;
        setTimeout(() => cb?.(s), 5);
      },
      getCurrentSoundIndex(cb) {
        const idx = this.soundIndex;
        setTimeout(() => cb?.(idx), 5);
      },
      getSounds(cb) {
        const list = this.sounds.slice();
        setTimeout(() => cb?.(list), 5);
      },
    };
    window.__STUB_SC_WIDGETS__.push(widget);
    return widget;
  }
  const WidgetFn = Object.assign(createWidget, { Events });
  window.SC = { Widget: WidgetFn };
})();`;

const STUB_TWITCH_API_JS = `(() => {
  window.__STUB_TWITCH_PLAYERS__ = window.__STUB_TWITCH_PLAYERS__ || [];
  function StubTwitchPlayer(holderId, opts) {
    const holder = typeof holderId === "string" ? document.getElementById(holderId) : holderId;
    const iframe = document.createElement("iframe");
    iframe.className = "watch-embed-iframe stub-twitch-iframe";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    iframe.srcdoc = "<!doctype html><html><body style='margin:0;background:#0e0e10;color:#9146ff;font:12px monospace;display:flex;align-items:center;justify-content:center;height:100vh'>TWITCH STUB</body></html>";
    if (holder) {
      holder.innerHTML = "";
      holder.appendChild(iframe);
    }
    const handlers = new Map();
    const emit = (ev, payload) => {
      for (const fn of (handlers.get(ev) || []).slice()) {
        try { fn(payload); } catch {}
      }
    };
    const player = {
      holderId,
      opts,
      iframe,
      paused: !opts?.autoplay,
      baseTimeSec: 0,
      basePerfMs: performance.now(),
      durationSec: 600,
      videoId: opts?.video || "12345678",
      volume: 0.8,
      muted: Boolean(opts?.muted),
      calls: [],
      addEventListener(ev, fn) {
        if (!handlers.has(ev)) handlers.set(ev, []);
        handlers.get(ev).push(fn);
      },
      isPaused() {
        return this.paused;
      },
      getCurrentTime() {
        if (!this.paused) {
          const dt = Math.max(0, (performance.now() - this.basePerfMs) / 1000);
          return Math.min(this.durationSec, this.baseTimeSec + dt);
        }
        return this.baseTimeSec;
      },
      getDuration() {
        return this.durationSec;
      },
      getVideo() {
        return this.videoId;
      },
      play() {
        this.baseTimeSec = this.getCurrentTime();
        this.basePerfMs = performance.now();
        this.paused = false;
        this.calls.push(["play"]);
        setTimeout(() => emit("playing", {}), 12);
      },
      pause() {
        this.baseTimeSec = this.getCurrentTime();
        this.basePerfMs = performance.now();
        this.paused = true;
        this.calls.push(["pause"]);
        setTimeout(() => emit("pause", {}), 12);
      },
      seek(sec) {
        this.baseTimeSec = Math.max(0, Math.min(this.durationSec, Number(sec) || 0));
        this.basePerfMs = performance.now();
        this.calls.push(["seek", this.baseTimeSec]);
        setTimeout(() => emit("seek", { position: this.baseTimeSec }), 12);
      },
      setCollection(col, vid) {
        this.videoId = vid;
        this.calls.push(["setCollection", col, vid]);
      },
      setVolume(v) {
        this.volume = Number(v) || 0;
      },
      setMuted(m) {
        this.muted = Boolean(m);
      },
      getMuted() {
        return this.muted;
      },
    };
    window.__STUB_TWITCH_PLAYERS__.push(player);
    setTimeout(() => emit("ready", {}), 15);
    return player;
  }
  StubTwitchPlayer.READY = "ready";
  StubTwitchPlayer.PLAY = "play";
  StubTwitchPlayer.PLAYING = "playing";
  StubTwitchPlayer.PAUSE = "pause";
  StubTwitchPlayer.SEEK = "seek";
  StubTwitchPlayer.ENDED = "ended";
  StubTwitchPlayer.PLAYBACK_BLOCKED = "playbackBlocked";
  StubTwitchPlayer.ONLINE = "online";
  StubTwitchPlayer.OFFLINE = "offline";
  window.Twitch = { Player: StubTwitchPlayer };
})();`;

const STUB_IFRAME_HTML =
  "<!doctype html><html><body style='margin:0;background:#111;color:#aaa;font:12px monospace'>EMBED STUB</body></html>";

const EMBED_FETCH_PATTERNS = [
  { urlPattern: "https://www.youtube.com/*" },
  { urlPattern: "https://youtube.com/*" },
  { urlPattern: "https://open.spotify.com/*" },
  { urlPattern: "https://w.soundcloud.com/*" },
  { urlPattern: "https://soundcloud.com/*" },
  { urlPattern: "https://player.twitch.tv/*" },
  { urlPattern: "https://clips.twitch.tv/*" },
  { urlPattern: "https://www.twitch.tv/*" },
];

function resolveEmbedStubResponse(urlStr) {
  if (/^https?:\/\/(www\.)?youtube\.com\/iframe_api\b/i.test(urlStr)) {
    return {
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body: STUB_YOUTUBE_API_JS,
    };
  }
  if (/^https?:\/\/open\.spotify\.com\/embed\/iframe-api\/v1\b/i.test(urlStr)) {
    return {
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body: STUB_SPOTIFY_API_JS,
    };
  }
  if (/^https?:\/\/w\.soundcloud\.com\/player\/api\.js\b/i.test(urlStr)) {
    return {
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body: STUB_SOUNDCLOUD_API_JS,
    };
  }
  if (/^https?:\/\/player\.twitch\.tv\/js\/embed\/v1\.js\b/i.test(urlStr)) {
    return {
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body: STUB_TWITCH_API_JS,
    };
  }
  if (/oembed/i.test(urlStr)) {
    return {
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ title: "Stub Media" }),
    };
  }
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: STUB_IFRAME_HTML,
  };
}

/* ==================== CDP Connection & Page Wrapper ==================== */

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionListeners = new Map(); // sessionId (or "") -> Map<method, Set<fn>>
    this.closed = false;
  }

  async connect(timeoutMs = 15000) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error(`CDP WebSocket connect timed out (${this.wsUrl})`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (ev) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${ev?.message || "connection failed"}`));
      });
      ws.addEventListener("message", (ev) => {
        this._handleMessage(ev.data);
      });
      ws.addEventListener("close", () => {
        this.closed = true;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
      });
    });
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(
          new Error(`CDP ${entry.method} failed (${msg.error.code}): ${msg.error.message}`)
        );
      } else {
        entry.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method) {
      const sid = msg.sessionId || "";
      const byMethod = this.sessionListeners.get(sid);
      if (!byMethod) return;
      const handlers = byMethod.get(msg.method);
      if (!handlers) return;
      for (const fn of Array.from(handlers)) {
        try {
          fn(msg.params || {});
        } catch {
          // isolate listener errors
        }
      }
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 20000) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP connection is not open (calling ${method})`));
    }
    const id = this.nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(sessionId, method, handler) {
    const sid = sessionId || "";
    let byMethod = this.sessionListeners.get(sid);
    if (!byMethod) {
      byMethod = new Map();
      this.sessionListeners.set(sid, byMethod);
    }
    let set = byMethod.get(method);
    if (!set) {
      set = new Set();
      byMethod.set(method, set);
    }
    set.add(handler);
  }

  off(sessionId, method, handler) {
    const sid = sessionId || "";
    const byMethod = this.sessionListeners.get(sid);
    const set = byMethod?.get(method);
    if (set) set.delete(handler);
  }

  clearSessionListeners(sessionId) {
    this.sessionListeners.delete(sessionId || "");
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

export class CdpPage {
  constructor(browser, { targetId, sessionId, browserContextId }) {
    this.browser = browser;
    this.conn = browser.conn;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.browserContextId = browserContextId;
    this.consoleMessages = [];
    this.pageErrors = [];
    this.interceptedRequests = [];
    this.closed = false;

    this.on("Runtime.consoleAPICalled", (ev) => {
      const text = (ev.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(" ");
      this.consoleMessages.push({ type: ev.type, text, timestamp: ev.timestamp });
    });

    this.on("Runtime.exceptionThrown", (ev) => {
      const ex = ev.exceptionDetails || {};
      const msg =
        ex.exception?.description ||
        ex.exception?.value ||
        ex.text ||
        "Uncaught page exception";
      this.pageErrors.push({
        message: String(msg),
        url: ex.url || "",
        lineNumber: ex.lineNumber ?? null,
        columnNumber: ex.columnNumber ?? null,
      });
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    return this.conn.send(method, params, this.sessionId, timeoutMs);
  }

  on(method, handler) {
    this.conn.on(this.sessionId, method, handler);
  }

  off(method, handler) {
    this.conn.off(this.sessionId, method, handler);
  }

  async addInitScript(source) {
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async setViewport({ width, height, deviceScaleFactor = 1, mobile = false }) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
  }

  async enableEmbedStubs(customResolver = null) {
    await this.send("Fetch.enable", { patterns: EMBED_FETCH_PATTERNS });
    this.on("Fetch.requestPaused", async (ev) => {
      const url = ev.request?.url || "";
      this.interceptedRequests.push(url);
      try {
        const stub =
          (typeof customResolver === "function" ? customResolver(url, ev) : null) ||
          resolveEmbedStubResponse(url);
        if (stub === "continue") {
          await this.send("Fetch.continueRequest", { requestId: ev.requestId });
          return;
        }
        const bodyB64 = Buffer.from(stub.body || "", "utf8").toString("base64");
        await this.send("Fetch.fulfillRequest", {
          requestId: ev.requestId,
          responseCode: stub.status || 200,
          responseHeaders: [
            { name: "Content-Type", value: stub.contentType || "text/plain; charset=utf-8" },
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Cache-Control", value: "no-store" },
          ],
          body: bodyB64,
        });
      } catch {
        // Request may have been cancelled on navigation/teardown
      }
    });
  }

  waitForLoadEvent(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("Page.loadEventFired", onLoad);
        reject(new Error(`Timed out waiting for Page.loadEventFired after ${timeoutMs}ms`));
      }, timeoutMs);
      const onLoad = () => {
        clearTimeout(timer);
        this.off("Page.loadEventFired", onLoad);
        resolve();
      };
      this.on("Page.loadEventFired", onLoad);
    });
  }

  async goto(url, { timeoutMs = 15000 } = {}) {
    const loadPromise = this.waitForLoadEvent(timeoutMs);
    const nav = await this.send("Page.navigate", { url }, timeoutMs);
    if (nav.errorText) {
      throw new Error(`Navigation to ${url} failed: ${nav.errorText}`);
    }
    await loadPromise;
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      const msg =
        ex.exception?.description ||
        ex.exception?.value ||
        ex.text ||
        "Runtime.evaluate exception";
      throw new Error(`Page evaluate error: ${msg}`);
    }
    return res.result?.value;
  }

  async waitFor(expression, { timeoutMs = 15000, intervalMs = 50, label = "condition" } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const val = await this.evaluate(expression);
        if (val) return val;
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const errSummary =
      this.pageErrors.length > 0
        ? ` | pageErrors=${JSON.stringify(this.pageErrors)}`
        : "";
    const evalErr = lastError ? ` | lastEvalError=${lastError.message}` : "";
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${evalErr}${errSummary}`);
  }

  async click(selector) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "missing" };
      el.click();
      return { ok: true };
    })()`);
    if (!ok?.ok) {
      throw new Error(`click(${selector}) failed: ${ok?.reason || "unknown"}`);
    }
  }

  async fill(selector, value) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: "missing" };
      el.focus();
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    })()`);
    if (!ok?.ok) {
      throw new Error(`fill(${selector}) failed: ${ok?.reason || "unknown"}`);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.conn.clearSessionListeners(this.sessionId);
    try {
      await this.conn.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      // ignore on shutdown
    }
    if (this.browserContextId) {
      try {
        await this.conn.send("Target.disposeBrowserContext", {
          browserContextId: this.browserContextId,
        });
      } catch {
        // ignore on shutdown
      }
    }
    this.browser.pages.delete(this);
  }
}

export async function launchChrome({
  chromeBin = findChromeBinary(),
  extraArgs = [],
  startupTimeoutMs = 15000,
} = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "p2p-direct-cdp-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    `--user-data-dir=${userDataDir}`,
    ...extraArgs,
    "about:blank",
  ];

  const proc = spawn(chromeBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let closed = false;
  const cleanupDir = () => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup race
    }
  };
  const onProcessExit = () => {
    try {
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    cleanupDir();
  };
  process.once("exit", onProcessExit);

  let stderrBuf = "";
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Chrome failed to expose DevTools endpoint within ${startupTimeoutMs}ms. stderr:\n${stderrBuf}`
        )
      );
    }, startupTimeoutMs);

    const onData = (chunk) => {
      stderrBuf += chunk.toString("utf8");
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        proc.stderr.off("data", onData);
        proc.off("exit", onExit);
        resolve(match[1]);
      }
    };
    const onExit = (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(`Chrome exited prematurely (code=${code}, signal=${signal}). stderr:\n${stderrBuf}`)
      );
    };
    proc.stderr.on("data", onData);
    proc.once("exit", onExit);
  }).catch((err) => {
    onProcessExit();
    process.off("exit", onProcessExit);
    throw err;
  });

  const conn = new CdpConnection(wsUrl);
  try {
    await conn.connect(startupTimeoutMs);
  } catch (err) {
    onProcessExit();
    process.off("exit", onProcessExit);
    throw err;
  }

  const pages = new Set();
  const browser = {
    chromeBin,
    wsUrl,
    userDataDir,
    proc,
    conn,
    pages,

    async newPage({
      isolated = true,
      viewport = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      initScripts = [],
      stubEmbeds = true,
      embedResolver = null,
    } = {}) {
      let browserContextId = undefined;
      if (isolated) {
        const ctx = await conn.send("Target.createBrowserContext", { disposeOnDetach: true });
        browserContextId = ctx.browserContextId;
      }
      const createParams = { url: "about:blank" };
      if (browserContextId) createParams.browserContextId = browserContextId;
      const { targetId } = await conn.send("Target.createTarget", createParams);
      const { sessionId } = await conn.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });

      const page = new CdpPage(browser, { targetId, sessionId, browserContextId });
      pages.add(page);

      await page.send("Page.enable");
      await page.send("Runtime.enable");
      if (viewport) {
        await page.setViewport(viewport);
      }
      for (const script of initScripts) {
        await page.addInitScript(script);
      }
      if (stubEmbeds) {
        await page.enableEmbedStubs(embedResolver);
      }
      return page;
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const page of Array.from(pages)) {
        await page.close();
      }
      try {
        await conn.send("Browser.close", {}, undefined, 3000);
      } catch {
        // ignore if already shutting down
      }
      conn.close();

      if (proc.exitCode === null && !proc.killed) {
        await new Promise((resolve) => {
          const killTimer = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // ignore
            }
            resolve();
          }, 3000);
          proc.once("exit", () => {
            clearTimeout(killTimer);
            resolve();
          });
          try {
            proc.kill("SIGTERM");
          } catch {
            clearTimeout(killTimer);
            resolve();
          }
        });
      }
      process.off("exit", onProcessExit);
      cleanupDir();
    },
  };

  return browser;
}

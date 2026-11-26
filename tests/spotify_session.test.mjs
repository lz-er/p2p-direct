import test from "node:test";
import assert from "node:assert/strict";
import {
  SPOTIFY_EMBED_ALLOW,
  WatchTogetherPlayer,
  classifySpotifyPlaybackMode,
  configureSpotifyIframeForSession,
  detectSpotifyBrowserConstraints,
  formatSpotifySessionGuidance,
  parseWatchMediaUrl,
  probeSpotifyDrmSupport,
} from "../watch_together.js";

function createFakeElement(tag = "div") {
  const attrs = new Map();
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    className: "",
    innerHTML: "",
    children,
    parentElement: null,
    credentialless: true,
    setAttribute(k, v) {
      attrs.set(String(k).toLowerCase(), String(v));
    },
    getAttribute(k) {
      const key = String(k).toLowerCase();
      return attrs.has(key) ? attrs.get(key) : null;
    },
    removeAttribute(k) {
      attrs.delete(String(k).toLowerCase());
    },
    appendChild(child) {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    replaceChild(next, prev) {
      const idx = children.indexOf(prev);
      if (idx >= 0) {
        children[idx] = next;
        next.parentElement = el;
        prev.parentElement = null;
      }
      return prev;
    },
    querySelector(sel) {
      if (sel === "iframe") {
        return children.find((c) => c.tagName === "IFRAME") || null;
      }
      return null;
    },
  };
  return el;
}

test("configureSpotifyIframeForSession sets session/DRM permissions and strips restrictions", () => {
  const iframe = createFakeElement("iframe");
  iframe.setAttribute("allowfullscreen", "");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("credentialless", "");
  iframe.setAttribute("loading", "lazy");

  configureSpotifyIframeForSession(iframe);

  assert.equal(iframe.getAttribute("allow"), SPOTIFY_EMBED_ALLOW);
  assert.ok(iframe.getAttribute("allow").includes("encrypted-media"));
  assert.ok(iframe.getAttribute("allow").includes("storage-access"));
  assert.ok(iframe.getAttribute("allow").includes("autoplay"));
  assert.equal(iframe.getAttribute("loading"), "eager");
  assert.equal(iframe.getAttribute("referrerpolicy"), "strict-origin-when-cross-origin");
  assert.equal(iframe.getAttribute("allowfullscreen"), null);
  assert.equal(iframe.getAttribute("sandbox"), null);
  assert.equal(iframe.getAttribute("credentialless"), null);
  assert.equal(iframe.credentialless, false);
});

test("detectSpotifyBrowserConstraints accurately identifies browsers and environment constraints", () => {
  const chrome = detectSpotifyBrowserConstraints({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    isBrave: false,
    isSecureContext: true,
    drmSupported: true,
  });
  assert.deepEqual(chrome, {
    browser: "chrome",
    isMobile: false,
    isSafari: false,
    isSecureContext: true,
    drmSupported: true,
  });

  const brave = detectSpotifyBrowserConstraints({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    isBrave: true,
    isSecureContext: true,
  });
  assert.equal(brave.browser, "brave");

  const firefox = detectSpotifyBrowserConstraints({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0",
    isBrave: false,
    isSecureContext: true,
  });
  assert.equal(firefox.browser, "firefox");
  assert.equal(firefox.isSafari, false);

  const safari = detectSpotifyBrowserConstraints({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    isBrave: false,
    isSecureContext: true,
  });
  assert.equal(safari.browser, "safari");
  assert.equal(safari.isSafari, true);
  assert.equal(safari.isMobile, false);

  const mobile = detectSpotifyBrowserConstraints({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    isBrave: false,
    isSecureContext: true,
  });
  assert.equal(mobile.isMobile, true);
});

test("classifySpotifyPlaybackMode distinguishes logged-in full tracks from 30s previews & blockers", () => {
  const desktopChrome = {
    browser: "chrome",
    isMobile: false,
    isSafari: false,
    isSecureContext: true,
    drmSupported: true,
  };

  assert.equal(
    classifySpotifyPlaybackMode({ durationMs: 0, entityType: "track", env: desktopChrome }).mode,
    "checking"
  );
  assert.equal(
    classifySpotifyPlaybackMode({ durationMs: 29713, entityType: "track", env: desktopChrome }).mode,
    "preview-session"
  );
  assert.equal(
    classifySpotifyPlaybackMode({ durationMs: 213573, entityType: "track", env: desktopChrome }).mode,
    "full"
  );
  // Confirmed full track > 32s overrides heuristic environment flags
  assert.equal(
    classifySpotifyPlaybackMode({
      durationMs: 185000,
      entityType: "track",
      env: { ...desktopChrome, drmSupported: false },
    }).mode,
    "full"
  );
  // Podcast/episode 30s clip is not falsely flagged as music preview-session
  assert.equal(
    classifySpotifyPlaybackMode({ durationMs: 29713, entityType: "episode", env: desktopChrome })
      .mode,
    "checking"
  );
  assert.equal(
    classifySpotifyPlaybackMode({
      durationMs: 0,
      entityType: "track",
      env: { ...desktopChrome, isSecureContext: false },
    }).mode,
    "preview-insecure"
  );
  assert.equal(
    classifySpotifyPlaybackMode({
      durationMs: 0,
      entityType: "track",
      env: { ...desktopChrome, drmSupported: false },
    }).mode,
    "preview-no-drm"
  );
  assert.equal(
    classifySpotifyPlaybackMode({
      durationMs: 0,
      entityType: "track",
      env: { ...desktopChrome, browser: "safari", isSafari: true },
    }).mode,
    "preview-safari"
  );
  assert.equal(
    classifySpotifyPlaybackMode({
      durationMs: 0,
      entityType: "track",
      env: desktopChrome,
      hasError: true,
      errorMessage: "eme_failed",
    }).mode,
    "error"
  );
});

test("formatSpotifySessionGuidance provides browser-specific actionable hints", () => {
  assert.match(
    formatSpotifySessionGuidance({ mode: "preview-session", isPreview: true, browser: "firefox" }),
    /Firefox/i
  );
  assert.match(
    formatSpotifySessionGuidance({ mode: "preview-session", isPreview: true, browser: "brave" }),
    /Brave/i
  );
  assert.match(
    formatSpotifySessionGuidance({ mode: "preview-session", isPreview: true, browser: "chrome" }),
    /open\.spotify\.com/i
  );
  assert.match(
    formatSpotifySessionGuidance({ mode: "preview-no-drm", isPreview: true, browser: "chrome" }),
    /DRM/i
  );
  assert.equal(formatSpotifySessionGuidance({ mode: "full", isPreview: false, browser: "chrome" }), "");
});

test("WatchTogetherPlayer mounts Spotify without double-load, resumes cleanly, detects session mode, and reloads locally", async () => {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevNavigator = globalThis.navigator;

  const createdControllers = [];

  globalThis.document = {
    documentElement: { getAttribute: () => "dark" },
    createElement: (tag) => createFakeElement(tag),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      requestMediaKeySystemAccess: async () => ({}),
    },
  });
  globalThis.window = {
    isSecureContext: true,
    __spotifyIframeApi: {
      createController(holder, opts, cb) {
        const iframe = createFakeElement("iframe");
        iframe.setAttribute("allowfullscreen", "");
        iframe.setAttribute("loading", "lazy");
        holder.parentElement?.replaceChild(iframe, holder);

        const listeners = new Map();
        const calls = [];
        const ctrl = {
          iframeElement: iframe,
          opts,
          calls,
          addListener(ev, fn) {
            if (!listeners.has(ev)) listeners.set(ev, []);
            listeners.get(ev).push(fn);
          },
          emit(ev, data) {
            for (const fn of listeners.get(ev) || []) {
              fn({ data });
            }
          },
          loadUri(uri, preferVideo, startSec) {
            calls.push(["loadUri", uri, preferVideo, startSec, iframe.getAttribute("allow")]);
          },
          resume() {
            calls.push(["resume"]);
          },
          play() {
            calls.push(["play"]);
          },
          pause() {
            calls.push(["pause"]);
          },
          seek(sec) {
            calls.push(["seek", sec]);
          },
          destroy() {
            calls.push(["destroy"]);
          },
        };
        createdControllers.push(ctrl);
        cb(ctrl);
      },
    },
  };

  try {
    const mountEl = createFakeElement("div");
    const telemetries = [];
    const userActions = [];
    const player = new WatchTogetherPlayer(mountEl, {
      onTelemetry: (m) => telemetries.push(m),
      onUserAction: (e) => userActions.push(e),
    });

    const parsed = parseWatchMediaUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
    assert.ok(parsed);
    const now = Date.now();
    const state = {
      active: true,
      playing: true,
      positionMs: 42000,
      anchorMs: now,
      rateMilli: 1000,
      provider: "spotify",
      mediaId: parsed.mediaId,
      url: parsed.url,
      playlistId: "",
      trackUri: "",
    };

    await player.applyState(state, now);
    assert.equal(createdControllers.length, 1);

    const ctrl1 = createdControllers[0];
    // `uri` must be omitted from options so Spotify's v1 createController doesn't double-navigate
    assert.equal(ctrl1.opts.uri, undefined);
    // Exactly one loadUri call, AFTER configureSpotifyIframeForSession updated `allow`
    const loadCalls = ctrl1.calls.filter((c) => c[0] === "loadUri");
    assert.equal(loadCalls.length, 1);
    assert.equal(loadCalls[0][1], "spotify:track:4cOdK2wGLETKBW3PvgPWqT");
    assert.equal(loadCalls[0][3], 42);
    assert.equal(loadCalls[0][4], SPOTIFY_EMBED_ALLOW);

    // Ready triggers resume() ONLY (never resume() + play() which would restart from 0:00)
    ctrl1.emit("ready", {});
    assert.deepEqual(
      ctrl1.calls.filter((c) => c[0] === "resume" || c[0] === "play"),
      [["resume"]]
    );

    // 30s preview update classifies as preview-session
    ctrl1.emit("playback_update", {
      isPaused: false,
      position: 1000,
      duration: 29713,
      playingURI: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
    });
    assert.equal(telemetries.at(-1).spotifySession.mode, "preview-session");

    // Local reload remounts iframe without emitting any user action to peers
    const actionsBeforeReload = userActions.length;
    const reloaded = await player.reloadSpotifySession();
    assert.equal(reloaded, true);
    assert.equal(createdControllers.length, 2);
    assert.ok(ctrl1.calls.some((c) => c[0] === "destroy"));
    assert.equal(userActions.length, actionsBeforeReload);

    // After reload, full-track duration confirms logged-in Spotify session
    const ctrl2 = createdControllers[1];
    ctrl2.emit("ready", {});
    ctrl2.emit("playback_update", {
      isPaused: false,
      position: 45000,
      duration: 213573,
      playingURI: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
    });
    assert.equal(telemetries.at(-1).spotifySession.mode, "full");

    player.destroy();
    assert.ok(ctrl2.calls.some((c) => c[0] === "destroy"));
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    if (prevNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: prevNavigator });
    }
  }
});

test("mid-track reloadSpotifySession emits zero spurious onUserAction after suppress (autoplay-blocked & delayed playing) while preserving genuine user actions", async () => {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevNavigator = globalThis.navigator;

  const createdControllers = [];
  globalThis.document = {
    documentElement: { getAttribute: () => "dark" },
    createElement: (tag) => createFakeElement(tag),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      requestMediaKeySystemAccess: async () => ({}),
    },
  });
  globalThis.window = {
    isSecureContext: true,
    __spotifyIframeApi: {
      createController(holder, opts, cb) {
        const iframe = createFakeElement("iframe");
        holder.parentElement?.replaceChild(iframe, holder);
        const listeners = new Map();
        const ctrl = {
          iframeElement: iframe,
          addListener(ev, fn) {
            if (!listeners.has(ev)) listeners.set(ev, []);
            listeners.get(ev).push(fn);
          },
          emit(ev, data) {
            for (const fn of listeners.get(ev) || []) {
              fn({ data });
            }
          },
          loadUri() {},
          resume() {},
          play() {},
          pause() {},
          seek() {},
          destroy() {},
        };
        createdControllers.push(ctrl);
        cb(ctrl);
      },
    },
  };

  try {
    const mountEl = createFakeElement("div");
    const userActions = [];
    const player = new WatchTogetherPlayer(mountEl, {
      onTelemetry: () => {},
      onUserAction: (e) => userActions.push(e),
    });

    const parsed = parseWatchMediaUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
    const now = Date.now();
    const playingState = {
      active: true,
      playing: true,
      positionMs: 42000,
      anchorMs: now,
      rateMilli: 1000,
      provider: "spotify",
      mediaId: parsed.mediaId,
      url: parsed.url,
      playlistId: "",
      trackUri: "",
    };

    await player.applyState(playingState, now);
    createdControllers[0].emit("ready", {});

    // Scenario A: Mid-track local reload where autoplay is blocked & iframe boots AFTER suppress expires
    await player.reloadSpotifySession();
    const ctrlBlocked = createdControllers.at(-1);
    ctrlBlocked.emit("ready", {});
    // Force suppress window expired to simulate slow iframe/Widevine initialization
    player.suppressUntilMs = 0;

    ctrlBlocked.emit("playback_update", {
      isPaused: true,
      isBuffering: false,
      position: 42000,
      duration: 213573,
      playingURI: parsed.mediaId,
    });
    assert.equal(userActions.length, 0, "autoplay-blocked post-reload update must not pause the room");

    // User clicks play locally to join the already-playing room -> matches pendingState, no redundant broadcast
    ctrlBlocked.emit("playback_update", {
      isPaused: false,
      isBuffering: false,
      position: 42300,
      duration: 213573,
      playingURI: parsed.mediaId,
    });
    assert.equal(userActions.length, 0);

    // Now user genuinely pauses -> MUST broadcast to room
    ctrlBlocked.emit("playback_update", {
      isPaused: true,
      isBuffering: false,
      position: 43000,
      duration: 213573,
      playingURI: parsed.mediaId,
    });
    assert.equal(userActions.length, 1);
    assert.equal(userActions[0].playing, false);
    assert.equal(userActions[0].positionMs, 43000);

    // Scenario B: Mid-track local reload with delayed Harmony boot (paused@0 then playing@42100 after suppress)
    const now2 = Date.now();
    player.pendingState = { ...playingState, anchorMs: now2 };
    await player.reloadSpotifySession();
    const ctrlDelayed = createdControllers.at(-1);
    ctrlDelayed.emit("ready", {});
    player.suppressUntilMs = 0;

    ctrlDelayed.emit("playback_update", {
      isPaused: true,
      isBuffering: true,
      position: 0,
      duration: 213573,
      playingURI: parsed.mediaId,
    });
    ctrlDelayed.emit("playback_update", {
      isPaused: false,
      isBuffering: false,
      position: 42100,
      duration: 213573,
      playingURI: parsed.mediaId,
    });
    assert.equal(userActions.length, 1, "delayed Harmony start must not emit spurious user action");

    // Genuine user seek to 95s -> MUST broadcast to room
    ctrlDelayed.emit("playback_update", {
      isPaused: false,
      isBuffering: false,
      position: 95000,
      duration: 213573,
      playingURI: parsed.mediaId,
    });
    assert.equal(userActions.length, 2);
    assert.equal(userActions[1].playing, true);
    assert.equal(userActions[1].positionMs, 95000);

    player.destroy();
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    if (prevNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: prevNavigator });
    }
  }
});

test("probeSpotifyDrmSupport does not permanently cache false and re-probes on force / reload", async () => {
  const prevWindow = globalThis.window;
  const prevNavigator = globalThis.navigator;

  let allowDrm = false;
  let probeCalls = 0;
  globalThis.window = { isSecureContext: true };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      requestMediaKeySystemAccess: async () => {
        probeCalls += 1;
        if (!allowDrm) throw new Error("DRM disabled");
        return {};
      },
    },
  });

  try {
    const first = await probeSpotifyDrmSupport({ force: true });
    assert.equal(first, false);
    assert.ok(probeCalls > 0);

    // User enables DRM in browser settings -> next probe (even without force) must re-check!
    allowDrm = true;
    const callsBeforeRetry = probeCalls;
    const second = await probeSpotifyDrmSupport();
    assert.equal(second, true);
    assert.ok(probeCalls > callsBeforeRetry);

    // Once true, force: true still re-probes when requested (e.g. reloadSpotifySession)
    allowDrm = false;
    const third = await probeSpotifyDrmSupport({ force: true });
    assert.equal(third, false);

    // End-to-end check: WatchTogetherPlayer.reloadSpotifySession() re-probes DRM and clears preview-no-drm
    const prevDocument = globalThis.document;
    globalThis.document = {
      documentElement: { getAttribute: () => "dark" },
      createElement: (tag) => createFakeElement(tag),
    };
    globalThis.window = {
      isSecureContext: true,
      __spotifyIframeApi: {
        createController(holder, _opts, cb) {
          const iframe = createFakeElement("iframe");
          holder.parentElement?.replaceChild(iframe, holder);
          cb({
            iframeElement: iframe,
            addListener() {},
            loadUri() {},
            destroy() {},
          });
        },
      },
    };
    try {
      const mountEl = createFakeElement("div");
      const telemetries = [];
      const player = new WatchTogetherPlayer(mountEl, {
        onTelemetry: (m) => telemetries.push(m),
      });
      const parsed = parseWatchMediaUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
      await player.applyState({
        active: true,
        playing: false,
        positionMs: 0,
        rateMilli: 1000,
        provider: "spotify",
        mediaId: parsed.mediaId,
        url: parsed.url,
        playlistId: "",
        trackUri: "",
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(telemetries.at(-1).spotifySession.mode, "preview-no-drm");

      // User enables DRM and clicks Reload Session
      allowDrm = true;
      await player.reloadSpotifySession();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(telemetries.at(-1).spotifySession.mode, "checking");
      player.destroy();
    } finally {
      globalThis.document = prevDocument;
    }
  } finally {
    globalThis.window = prevWindow;
    if (prevNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: prevNavigator });
    }
  }
});

test("first Play on idle/paused mount and playlist track pick after showSpotifyPlaylistView propagate immediately", async () => {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevNavigator = globalThis.navigator;

  const createdControllers = [];
  globalThis.document = {
    documentElement: { getAttribute: () => "dark" },
    createElement: (tag) => createFakeElement(tag),
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      requestMediaKeySystemAccess: async () => ({}),
    },
  });
  globalThis.window = {
    isSecureContext: true,
    __spotifyIframeApi: {
      createController(holder, _opts, cb) {
        const iframe = createFakeElement("iframe");
        holder.parentElement?.replaceChild(iframe, holder);
        const listeners = new Map();
        const ctrl = {
          iframeElement: iframe,
          addListener(ev, fn) {
            if (!listeners.has(ev)) listeners.set(ev, []);
            listeners.get(ev).push(fn);
          },
          emit(ev, data) {
            for (const fn of listeners.get(ev) || []) {
              fn({ data });
            }
          },
          loadUri() {},
          resume() {},
          play() {},
          pause() {},
          seek() {},
          destroy() {},
        };
        createdControllers.push(ctrl);
        cb(ctrl);
      },
    },
  };

  try {
    const mountEl = createFakeElement("div");
    const userActions = [];
    const player = new WatchTogetherPlayer(mountEl, {
      onTelemetry: () => {},
      onUserAction: (e) => userActions.push(e),
    });

    // (a) Paused single-track mount emits no initial playback_update; user's first Play MUST sync
    const trackParsed = parseWatchMediaUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
    await player.applyState({
      active: true,
      playing: false,
      positionMs: 0,
      anchorMs: Date.now(),
      rateMilli: 1000,
      provider: "spotify",
      mediaId: trackParsed.mediaId,
      url: trackParsed.url,
      playlistId: "",
      trackUri: "",
    });
    const trackCtrl = createdControllers.at(-1);
    trackCtrl.emit("ready", {});
    player.suppressUntilMs = 0;

    trackCtrl.emit("playback_update", {
      isPaused: false,
      isBuffering: false,
      position: 500,
      duration: 213573,
      playingURI: trackParsed.mediaId,
    });
    assert.equal(userActions.length, 1, "first Play on paused mount must propagate immediately");
    assert.equal(userActions[0].playing, true);
    assert.equal(userActions[0].positionMs, 500);

    // (b) Playlist with detached track A -> user clicks Show Playlist -> picks new track B
    const plParsed = parseWatchMediaUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
    await player.applyState({
      active: true,
      playing: true,
      positionMs: 15000,
      anchorMs: Date.now(),
      rateMilli: 1000,
      provider: "spotify",
      mediaId: plParsed.mediaId,
      url: plParsed.url,
      playlistId: plParsed.playlistId,
      trackUri: "spotify:track:1111111111111111111111",
    });
    const plCtrl = createdControllers.at(-1);
    plCtrl.emit("ready", {});
    player.suppressUntilMs = 0;

    assert.equal(player.showSpotifyPlaylistView(), true);
    plCtrl.emit("ready", {});
    player.suppressUntilMs = 0;

    // User picks new track B in the playlist tracklist (no prior playback_update)
    plCtrl.emit("playback_started", {
      playingURI: "spotify:track:2222222222222222222222",
    });
    assert.equal(userActions.length, 2, "playlist track pick after showSpotifyPlaylistView must propagate");
    assert.equal(userActions[1].playing, true);
    assert.equal(userActions[1].trackUri, "spotify:track:2222222222222222222222");

    player.destroy();
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    if (prevNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: prevNavigator });
    }
  }
});

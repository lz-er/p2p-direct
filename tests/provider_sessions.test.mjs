import test from "node:test";
import assert from "node:assert/strict";
import {
  SOUNDCLOUD_EMBED_ALLOW,
  SPOTIFY_EMBED_ALLOW,
  TWITCH_EMBED_ALLOW,
  YOUTUBE_EMBED_ALLOW,
  WatchSyncNegotiator,
  WatchTogetherPlayer,
  classifySoundCloudSound,
  classifyYouTubePlayerError,
  configureEmbedIframeForSession,
  getEmbedAllowPolicy,
  projectMediaPositionMs,
  sanitizeWatchExternalUrl,
} from "../watch_together.js";

/* ==================== Minimal DOM & Multi-Provider Embed Mocks ==================== */

function createMockElement(tag = "div") {
  const attrs = new Map();
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    className: "",
    id: "",
    src: "",
    children,
    parentElement: null,
    credentialless: true,
    dataset: {},
    _innerHTML: "",
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(v) {
      this._innerHTML = String(v);
      if (v === "") {
        for (const c of children) c.parentElement = null;
        children.length = 0;
      }
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
    querySelector(sel) {
      if (sel === "iframe") {
        for (const c of children) {
          if (c.tagName === "IFRAME") return c;
          const nested = c.querySelector?.("iframe");
          if (nested) return nested;
        }
      }
      return null;
    },
  };
  return el;
}

function setupMultiProviderMocks() {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevNavigator = globalThis.navigator;

  const created = {
    ytPlayers: [],
    scWidgets: [],
    twitchPlayers: [],
    spotifyCtrls: [],
  };

  globalThis.document = {
    documentElement: { getAttribute: () => "dark" },
    head: createMockElement("head"),
    createElement: (tag) => createMockElement(tag),
  };

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      requestMediaKeySystemAccess: async () => ({}),
    },
  });

  const YT = {
    Player: function MockYTPlayer(holder, opts) {
      const iframe = createMockElement("iframe");
      iframe.setAttribute("allowfullscreen", "1");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("credentialless", "");
      holder.parentElement?.replaceChild(iframe, holder);

      const player = {
        holder,
        iframe,
        opts,
        state: 2,
        currentTimeSec: Number(opts.playerVars?.start) || 0,
        durationSec: 240,
        rate: 1,
        muted: false,
        volume: 80,
        playlist: opts.playerVars?.list ? ["vidA1111111", "vidB2222222", "vidC3333333"] : null,
        playlistIndex: opts.playerVars?.index || 0,
        calls: [],
        getIframe() {
          return iframe;
        },
        getPlayerState() {
          return this.state;
        },
        getCurrentTime() {
          return this.currentTimeSec;
        },
        getDuration() {
          return this.durationSec;
        },
        getPlaybackRate() {
          return this.rate;
        },
        setPlaybackRate(r) {
          this.calls.push(["setPlaybackRate", r]);
          this.rate = r;
        },
        getPlaylist() {
          return this.playlist;
        },
        getPlaylistIndex() {
          return this.playlistIndex;
        },
        getVideoData() {
          const vid = this.playlist ? this.playlist[this.playlistIndex] : opts.videoId || "dQw4w9WgXcQ";
          return { video_id: vid, title: `Title ${vid}`, author: "Channel" };
        },
        playVideo() {
          this.calls.push(["playVideo"]);
          this.state = 1;
        },
        pauseVideo() {
          this.calls.push(["pauseVideo"]);
          this.state = 2;
        },
        seekTo(sec, allow) {
          this.calls.push(["seekTo", sec, allow]);
          this.currentTimeSec = sec;
        },
        playVideoAt(idx) {
          this.calls.push(["playVideoAt", idx]);
          this.playlistIndex = idx;
          this.state = 1;
        },
        setLoop(v) {
          this.calls.push(["setLoop", v]);
        },
        setVolume(v) {
          this.volume = v;
        },
        mute() {
          this.calls.push(["mute"]);
          this.muted = true;
        },
        unMute() {
          this.muted = false;
        },
        destroy() {
          this.calls.push(["destroy"]);
        },
        triggerReady() {
          opts.events?.onReady?.();
        },
        triggerState(code) {
          this.state = code;
          opts.events?.onStateChange?.({ data: code });
        },
        triggerError(code) {
          opts.events?.onError?.({ data: code });
        },
      };
      created.ytPlayers.push(player);
      return player;
    },
  };

  const SC = {
    Widget: Object.assign(
      function MockSCWidget(iframe) {
        const handlers = new Map();
        const widget = {
          iframe,
          paused: true,
          positionMs: 0,
          durationMs: 180000,
          soundIndex: 0,
          sounds: [
            {
              id: 1001,
              title: "Full Track",
              user: { username: "Artist" },
              duration: 180000,
              full_duration: 180000,
              policy: "ALLOW",
              playable: true,
            },
          ],
          calls: [],
          bind(ev, fn) {
            if (!handlers.has(ev)) handlers.set(ev, []);
            handlers.get(ev).push(fn);
          },
          emit(ev, payload) {
            for (const fn of handlers.get(ev) || []) fn(payload);
          },
          play() {
            this.calls.push(["play"]);
            this.paused = false;
          },
          pause() {
            this.calls.push(["pause"]);
            this.paused = true;
          },
          seekTo(ms) {
            this.calls.push(["seekTo", ms]);
            this.positionMs = ms;
          },
          skip(idx) {
            this.calls.push(["skip", idx]);
            this.soundIndex = idx;
          },
          setVolume(v) {
            this.calls.push(["setVolume", v]);
          },
          isPaused(cb) {
            cb(this.paused);
          },
          getPosition(cb) {
            cb(this.positionMs);
          },
          getDuration(cb) {
            cb(this.durationMs);
          },
          getCurrentSound(cb) {
            cb(this.sounds[this.soundIndex] || this.sounds[0]);
          },
          getCurrentSoundIndex(cb) {
            cb(this.soundIndex);
          },
          getSounds(cb) {
            cb(this.sounds);
          },
        };
        created.scWidgets.push(widget);
        return widget;
      },
      {
        Events: {
          READY: "ready",
          PLAY: "play",
          PAUSE: "pause",
          SEEK: "seek",
          FINISH: "finish",
          PLAY_PROGRESS: "playProgress",
          ERROR: "error",
        },
      }
    ),
  };

  const holdersById = new Map();
  const origCreateElement = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreateElement(tag);
    let _id = "";
    Object.defineProperty(el, "id", {
      get() {
        return _id;
      },
      set(v) {
        _id = String(v);
        if (_id) holdersById.set(_id, el);
      },
    });
    return el;
  };

  const Twitch = {
    Player: Object.assign(
      function MockTwitchPlayer(holderId, opts) {
        const iframe = createMockElement("iframe");
        iframe.setAttribute("allowfullscreen", "true");
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.setAttribute("credentialless", "");
        const holder = holdersById.get(holderId);
        holder?.appendChild(iframe);

        const handlers = new Map();
        const player = {
          holderId,
          iframe,
          opts,
          paused: !opts.autoplay,
          currentTimeSec: 0,
          durationSec: 600,
          videoId: opts.video || "12345678",
          calls: [],
          addEventListener(ev, fn) {
            if (!handlers.has(ev)) handlers.set(ev, []);
            handlers.get(ev).push(fn);
          },
          emit(ev, payload) {
            for (const fn of handlers.get(ev) || []) fn(payload);
          },
          isPaused() {
            return this.paused;
          },
          getCurrentTime() {
            return this.currentTimeSec;
          },
          getDuration() {
            return this.durationSec;
          },
          getVideo() {
            return this.videoId;
          },
          play() {
            this.calls.push(["play"]);
            this.paused = false;
          },
          pause() {
            this.calls.push(["pause"]);
            this.paused = true;
          },
          seek(sec) {
            this.calls.push(["seek", sec]);
            this.currentTimeSec = sec;
          },
          setCollection(col, vid) {
            this.calls.push(["setCollection", col, vid]);
            this.videoId = vid;
          },
          setVolume() {},
          setMuted() {},
        };
        created.twitchPlayers.push(player);
        return player;
      },
      {
        READY: "ready",
        PLAY: "play",
        PLAYING: "playing",
        PAUSE: "pause",
        SEEK: "seek",
        ENDED: "ended",
        PLAYBACK_BLOCKED: "playbackBlocked",
        ONLINE: "online",
        OFFLINE: "offline",
      }
    ),
  };

  const SpotifyIFrameAPI = {
    createController(holder, opts, cb) {
      const iframe = createMockElement("iframe");
      iframe.setAttribute("allowfullscreen", "");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("credentialless", "");
      holder.parentElement?.replaceChild(iframe, holder);
      const handlers = new Map();
      const ctrl = {
        iframeElement: iframe,
        opts,
        calls: [],
        addListener(ev, fn) {
          if (!handlers.has(ev)) handlers.set(ev, []);
          handlers.get(ev).push(fn);
        },
        emit(ev, data) {
          for (const fn of handlers.get(ev) || []) fn({ data });
        },
        loadUri(uri, preferVideo, startSec) {
          this.calls.push(["loadUri", uri, preferVideo, startSec]);
        },
        resume() {
          this.calls.push(["resume"]);
        },
        play() {
          this.calls.push(["play"]);
        },
        pause() {
          this.calls.push(["pause"]);
        },
        seek(sec) {
          this.calls.push(["seek", sec]);
        },
        destroy() {
          this.calls.push(["destroy"]);
        },
      };
      created.spotifyCtrls.push(ctrl);
      cb(ctrl);
    },
  };

  globalThis.window = {
    isSecureContext: true,
    location: { origin: "https://example.test", hostname: "example.test" },
    YT,
    SC,
    Twitch,
    __spotifyIframeApi: SpotifyIFrameAPI,
  };

  return {
    created,
    restore() {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      if (prevNavigator === undefined) {
        delete globalThis.navigator;
      } else {
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: prevNavigator });
      }
    },
  };
}

function assertCleanSessionIframe(iframe, expectedAllow, label) {
  assert.ok(iframe, `${label}: iframe must exist`);
  assert.equal(iframe.getAttribute("allow"), expectedAllow, `${label}: allow policy`);
  assert.ok(iframe.getAttribute("allow").includes("storage-access"), `${label}: storage-access`);
  assert.ok(iframe.getAttribute("allow").includes("autoplay"), `${label}: autoplay`);
  assert.equal(
    iframe.getAttribute("referrerpolicy"),
    "strict-origin-when-cross-origin",
    `${label}: referrerpolicy`
  );
  assert.equal(iframe.getAttribute("loading"), "eager", `${label}: loading`);
  assert.equal(iframe.getAttribute("sandbox"), null, `${label}: no sandbox`);
  assert.equal(iframe.getAttribute("credentialless"), null, `${label}: no credentialless attr`);
  assert.equal(iframe.getAttribute("allowfullscreen"), null, `${label}: no legacy allowfullscreen`);
  assert.equal(iframe.credentialless, false, `${label}: credentialless prop false`);
}

/* ==================== 1. YouTube Host & Cross-Provider Iframe Hygiene ==================== */

test("YouTube/YT Music use www.youtube.com host and all 4 providers configure clean session iframes", async (t) => {
  const env = setupMultiProviderMocks();
  t.after(() => env.restore());

  // Direct helper test across providers
  for (const [provider, expectedAllow] of [
    ["youtube", YOUTUBE_EMBED_ALLOW],
    ["ytmusic", YOUTUBE_EMBED_ALLOW],
    ["soundcloud", SOUNDCLOUD_EMBED_ALLOW],
    ["twitch", TWITCH_EMBED_ALLOW],
    ["spotify", SPOTIFY_EMBED_ALLOW],
  ]) {
    assert.equal(getEmbedAllowPolicy(provider), expectedAllow);
    const el = createMockElement("iframe");
    el.setAttribute("sandbox", "allow-scripts");
    el.setAttribute("credentialless", "");
    el.setAttribute("allowfullscreen", "true");
    configureEmbedIframeForSession(el, provider);
    assertCleanSessionIframe(el, expectedAllow, `helper:${provider}`);
  }

  const mountEl = createMockElement("div");
  const player = new WatchTogetherPlayer(mountEl, {});
  t.after(() => player.destroy());
  const now = Date.now();

  // YouTube
  await player.applyState(
    {
      active: true,
      playing: false,
      positionMs: 0,
      anchorMs: now,
      rateMilli: 1000,
      provider: "youtube",
      mediaId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    },
    now
  );
  const yt = env.created.ytPlayers[0];
  assert.equal(yt.opts.host, "https://www.youtube.com", "YouTube must use www.youtube.com host");
  assertCleanSessionIframe(yt.iframe, YOUTUBE_EMBED_ALLOW, "youtube");

  // YouTube Music
  await player.applyState(
    {
      active: true,
      playing: false,
      positionMs: 0,
      anchorMs: now,
      rateMilli: 1000,
      provider: "ytmusic",
      mediaId: "9bZkp7q19f0",
      url: "https://music.youtube.com/watch?v=9bZkp7q19f0",
    },
    now
  );
  const ytm = env.created.ytPlayers[1];
  assert.equal(ytm.opts.host, "https://www.youtube.com", "YT Music must use www.youtube.com host");
  assertCleanSessionIframe(ytm.iframe, YOUTUBE_EMBED_ALLOW, "ytmusic");

  // SoundCloud
  await player.applyState(
    {
      active: true,
      playing: false,
      positionMs: 0,
      anchorMs: now,
      rateMilli: 1000,
      provider: "soundcloud",
      mediaId: "https://soundcloud.com/artist/track",
      url: "https://soundcloud.com/artist/track",
    },
    now
  );
  assertCleanSessionIframe(env.created.scWidgets[0].iframe, SOUNDCLOUD_EMBED_ALLOW, "soundcloud");

  // Twitch Interactive Player (VOD)
  await player.applyState(
    {
      active: true,
      playing: false,
      positionMs: 0,
      anchorMs: now,
      rateMilli: 1000,
      provider: "twitch",
      mediaId: "video:12345678",
      url: "https://www.twitch.tv/videos/12345678",
    },
    now
  );
  assertCleanSessionIframe(env.created.twitchPlayers[0].iframe, TWITCH_EMBED_ALLOW, "twitch-vod");

  // Twitch Clip iframe
  await player.applyState(
    {
      active: true,
      playing: false,
      positionMs: 0,
      anchorMs: now,
      rateMilli: 1000,
      provider: "twitch",
      mediaId: "clip:AwesomeClipSlug123",
      url: "https://clips.twitch.tv/AwesomeClipSlug123",
    },
    now
  );
  assertCleanSessionIframe(player.twitchIframe, TWITCH_EMBED_ALLOW, "twitch-clip");

  // Spotify
  await player.applyState(
    {
      active: true,
      playing: false,
      positionMs: 0,
      anchorMs: now,
      rateMilli: 1000,
      provider: "spotify",
      mediaId: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
      url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    },
    now
  );
  assertCleanSessionIframe(env.created.spotifyCtrls[0].iframeElement, SPOTIFY_EMBED_ALLOW, "spotify");
});

/* ==================== 2. YouTube onError Detection, Recovery & Sync Guard ==================== */

test("classifyYouTubePlayerError maps codes 100/101/150/152/153/2/5 accurately for YouTube & YT Music", () => {
  const e153 = classifyYouTubePlayerError(153, { provider: "youtube" });
  assert.equal(e153.code, 153);
  assert.equal(e153.blocksSync, true);
  assert.equal(e153.canReload, true);
  assert.match(e153.message, /Referer|blocker/i);

  const e101 = classifyYouTubePlayerError(101, { provider: "youtube" });
  assert.equal(e101.code, 101);
  assert.equal(e101.kind, "restricted");
  assert.match(e101.message, /embed|age|members|VPN/i);

  const e150Ytm = classifyYouTubePlayerError(150, { provider: "ytmusic" });
  assert.equal(e150Ytm.provider, "ytmusic");
  assert.equal(e150Ytm.code, 150);
  assert.match(e150Ytm.tag, /YT MUSIC/);
  assert.match(e150Ytm.message, /YouTube Music|Premium/i);

  const e100 = classifyYouTubePlayerError(100);
  assert.equal(e100.code, 100);
  assert.match(e100.message, /unavailable|private/i);

  const e152 = classifyYouTubePlayerError(152);
  assert.equal(e152.code, 152);
  assert.match(e152.message, /sign in|cookies|validation/i);

  const e2 = classifyYouTubePlayerError(2);
  assert.equal(e2.code, 2);
  assert.match(e2.message, /Invalid|playback/i);

  const e5 = classifyYouTubePlayerError(5);
  assert.equal(e5.code, 5);
  assert.match(e5.message, /HTML5/i);
});

test("YouTube onError surfaces notice, blocks spurious negotiation/drift/actions, and clears on CUED / PLAYING / track change / reload", async (t) => {
  const env = setupMultiProviderMocks();
  t.after(() => env.restore());

  let perf = 1000;
  let wall = 1_700_000_000_000;
  const telemetries = [];
  const userActions = [];
  const negotiated = [];

  const mountEl = createMockElement("div");
  const player = new WatchTogetherPlayer(mountEl, {
    localPeerId: "bob",
    peerStaggerMs: 0,
    perfNow: () => perf,
    wallNow: () => wall,
    onTelemetry: (m) => telemetries.push(m),
    onUserAction: (e) => userActions.push(e),
    onNegotiateState: (e) => negotiated.push(e),
  });
  t.after(() => player.destroy());

  const ytState = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 30000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    provider: "youtube",
    mediaId: "dQw4w9WgXcQ",
    anchorMs: wall,
  };

  await player.applyState(ytState, wall, { source: "remote" });
  const yt = env.created.ytPlayers[0];
  yt.currentTimeSec = 30;
  yt.triggerReady();
  yt.triggerState(1);
  // Converge initially
  for (let i = 0; i < 4; i++) {
    perf += 333;
    wall += 333;
    yt.currentTimeSec += 0.333;
    player._pollPlayerStateOnce();
  }

  // Trigger Error 150 (embed restricted / bot check) -> YouTube drops to PAUSED at 0s
  yt.triggerError(150);
  const notice150 = telemetries.at(-1).providerNotice;
  assert.equal(notice150?.code, 150);
  assert.equal(notice150?.blocksSync, true);

  yt.currentTimeSec = 0;
  yt.triggerState(2); // PAUSED after error -> must NOT pause room
  yt.triggerState(0); // ENDED after error -> must NOT end room

  yt.calls.length = 0;
  player.correctDrift(ytState, wall);
  assert.equal(yt.calls.length, 0, "correctDrift must not seek an errored YouTube player");

  // 30 consecutive 3 Hz polls (10s) while errored & paused at 0s -> ZERO negotiations!
  for (let i = 0; i < 30; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(userActions.length, 0, "Errored YouTube player must emit zero onUserAction");
  assert.equal(negotiated.length, 0, "Errored YouTube player must emit zero onNegotiateState");

  // Recovery 1: CUED (5) clears notice cleanly
  yt.triggerState(5);
  assert.equal(telemetries.at(-1).providerNotice, null, "CUED (5) must clear error notice");

  // Error 153 -> Recovery 2: PLAYING (1) clears notice cleanly
  yt.triggerError(153);
  assert.equal(telemetries.at(-1).providerNotice?.code, 153);
  yt.currentTimeSec = projectMediaPositionMs(ytState, wall) / 1000;
  yt.triggerState(1);
  assert.equal(telemetries.at(-1).providerNotice, null, "PLAYING (1) must clear error notice");

  // Error 152, 2, and 5 all emit structured notices and block negotiation
  for (const errCode of [152, 2, 5]) {
    yt.triggerError(errCode);
    assert.equal(telemetries.at(-1).providerNotice?.code, errCode);
    assert.equal(telemetries.at(-1).providerNotice?.blocksSync, true);
    yt.triggerState(2);
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
    assert.equal(userActions.length, 0);
    assert.equal(negotiated.length, 0);
  }

  // Error 100 -> Recovery 3: reloadPlayerSession() clears notice cleanly
  yt.triggerError(100);
  assert.equal(telemetries.at(-1).providerNotice?.code, 100);
  await player.reloadPlayerSession();
  assert.equal(
    telemetries.at(-1).providerNotice,
    null,
    "reloadPlayerSession() must clear YouTube error notice"
  );
  const ytReloaded = env.created.ytPlayers[1];
  ytReloaded.triggerReady();
  assert.equal(telemetries.at(-1).providerNotice, null);

  // Error 101 in playlist -> Recovery 4: track change clears notice cleanly
  const ytPlState = {
    targetId: "watch",
    kind: "watch",
    rev: 10,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 0,
    rateMilli: 1000,
    epoch: 2,
    url: "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
    provider: "youtube",
    mediaId: "ytpl:PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
    playlistId: "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
    playlistIndex: 0,
    trackUri: "vidA1111111",
    anchorMs: wall,
  };
  await player.applyState(ytPlState, wall, { source: "remote" });
  const ytPl = env.created.ytPlayers[2];
  ytPl.triggerReady();
  ytPl.triggerError(101);
  assert.equal(telemetries.at(-1).providerNotice?.code, 101);

  // Switch to track 1 via remote playlist state
  await player.applyState({ ...ytPlState, rev: 11, playlistIndex: 1, trackUri: "vidB2222222" }, wall, {
    source: "remote",
  });
  assert.equal(
    telemetries.at(-1).providerNotice,
    null,
    "Playlist track change must clear YouTube error notice"
  );
});

/* ==================== 3. SoundCloud SNIP / BLOCK / ERROR + Negotiator Guard ==================== */

test("classifySoundCloudSound detects SNIP (honest Go+ copy), BLOCK, playable:false, ERROR, and ignores genuine short tracks", () => {
  const snipGoPlus = classifySoundCloudSound({
    policy: "SNIP",
    duration: 30000,
    full_duration: 215000,
    playable: true,
    monetization_model: "SUB_HIGH_TIER",
  });
  assert.equal(snipGoPlus.code, "SNIP");
  assert.equal(snipGoPlus.isPreview, true);
  assert.equal(snipGoPlus.blocksSync, false);
  assert.equal(snipGoPlus.canReload, false);
  assert.equal(snipGoPlus.autoReloadOnReturn, false);
  assert.equal(snipGoPlus.previewDurationMs, 30000);
  assert.equal(snipGoPlus.fullDurationMs, 215000);
  assert.match(snipGoPlus.message, /30s preview/i);
  assert.match(snipGoPlus.message, /embeds don't support Go\+ login/i);
  assert.doesNotMatch(snipGoPlus.message, /allow.*cookie|sign in.*reload/i);

  // Duration heuristic SNIP even without explicit policy field
  const snipHeuristic = classifySoundCloudSound({
    duration: 30000,
    full_duration: 185000,
    playable: true,
  });
  assert.equal(snipHeuristic.code, "SNIP");
  assert.equal(snipHeuristic.isPreview, true);

  // Genuine short 24s track must NOT be flagged as SNIP
  const genuineShort = classifySoundCloudSound({
    policy: "ALLOW",
    duration: 24000,
    full_duration: 24000,
    playable: true,
  });
  assert.equal(genuineShort, null);

  const blockedPolicy = classifySoundCloudSound({ policy: "BLOCK", duration: 0, playable: true });
  assert.equal(blockedPolicy.code, "BLOCK");
  assert.equal(blockedPolicy.blocksSync, true);
  assert.equal(blockedPolicy.canReload, true);

  const unplayable = classifySoundCloudSound({ policy: "ALLOW", duration: 180000, playable: false });
  assert.equal(unplayable.code, "BLOCK");
  assert.equal(unplayable.blocksSync, true);

  const errNotice = classifySoundCloudSound(null, { hasError: true, errorMessage: "stream_failed" });
  assert.equal(errNotice.code, "ERROR");
  assert.equal(errNotice.blocksSync, true);
  assert.equal(errNotice.canReload, true);
  assert.match(errNotice.message, /stream_failed/);
});

test("SoundCloud SNIP peer past 30s and BLOCK/ERROR peer never disrupt room via 3 Hz WatchSyncNegotiator or FINISH/PAUSE", async (t) => {
  const env = setupMultiProviderMocks();
  t.after(() => env.restore());

  // Direct WatchSyncNegotiator unit verification for SoundCloud SNIP & player-blocked
  const neg = new WatchSyncNegotiator({ localPeerId: "bob", peerStaggerMs: 0 });
  const sharedAt45s = {
    active: true,
    playing: true,
    positionMs: 45000,
    anchorMs: 100000,
    rateMilli: 1000,
    rev: 5,
  };
  neg.onSharedStateApplied(sharedAt45s, 1000, { source: "local-embed" });
  const snipDecision = neg.evaluate(
    {
      provider: "soundcloud",
      ready: true,
      isPreview: true,
      previewDurationMs: 30000,
      playing: false,
      hasPlayState: true,
      positionMs: 30000,
      hasPosition: true,
      durationMs: 30000,
      observedAt: 5000,
      wallNowMs: 100000,
    },
    sharedAt45s
  );
  assert.equal(snipDecision.action, "none");
  assert.equal(snipDecision.reason, "preview-out-of-range");

  const blockedDecision = neg.evaluate(
    {
      provider: "youtube",
      ready: true,
      blocked: true,
      errored: true,
      playing: false,
      hasPlayState: true,
      positionMs: 0,
      hasPosition: true,
      durationMs: 240000,
      observedAt: 5333,
      wallNowMs: 100333,
    },
    sharedAt45s
  );
  assert.equal(blockedDecision.action, "none");
  assert.equal(blockedDecision.reason, "player-blocked");

  // End-to-end WatchTogetherPlayer SoundCloud SNIP + BLOCK + ERROR test
  let perf = 1000;
  let wall = 1_700_000_000_000;
  const telemetries = [];
  const userActions = [];
  const negotiated = [];

  const mountEl = createMockElement("div");
  const player = new WatchTogetherPlayer(mountEl, {
    localPeerId: "bob",
    peerStaggerMs: 0,
    perfNow: () => perf,
    wallNow: () => wall,
    onTelemetry: (m) => telemetries.push(m),
    onUserAction: (e) => userActions.push(e),
    onNegotiateState: (e) => negotiated.push(e),
  });
  t.after(() => player.destroy());

  const scState = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 28000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://soundcloud.com/artist/go-plus-track",
    provider: "soundcloud",
    mediaId: "https://soundcloud.com/artist/go-plus-track",
    anchorMs: wall,
  };
  await player.applyState(scState, wall, { source: "remote" });
  const sc = env.created.scWidgets[0];
  sc.durationMs = 30000;
  sc.sounds = [
    {
      id: 777,
      title: "Go+ Single",
      user: { username: "Artist" },
      duration: 30000,
      full_duration: 210000,
      policy: "SNIP",
      playable: true,
      monetization_model: "SUB_HIGH_TIER",
    },
  ];
  sc.paused = false;
  sc.positionMs = 28000;
  sc.emit("ready");
  sc.emit("play", { currentPosition: 28000 });
  assert.equal(telemetries.at(-1).providerNotice?.code, "SNIP");

  // Advance 3 seconds: room moves to 31s; SNIP widget caps out at 30s and fires PAUSE + FINISH
  perf += 3000;
  wall += 3000;
  sc.paused = true;
  sc.positionMs = 30000;
  sc.emit("pause", { currentPosition: 30000 });
  sc.emit("finish");

  // 30 consecutive 3 Hz polls while room moves from 31s -> 41s and SNIP peer stays paused at 30s
  sc.calls.length = 0;
  for (let i = 0; i < 30; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  player.correctDrift(scState, wall);
  assert.equal(userActions.length, 0, "SNIP 30s cap PAUSE/FINISH must not pause/end room");
  assert.equal(negotiated.length, 0, "SNIP peer past 30s must not trigger negotiation");
  assert.equal(sc.calls.length, 0, "correctDrift must not seek SNIP peer past 30s");

  // SoundCloud ERROR event surfaces notice and blocks negotiation
  sc.emit("error", { message: "blocked_by_client" });
  assert.equal(telemetries.at(-1).providerNotice?.code, "ERROR");
  for (let i = 0; i < 10; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(negotiated.length, 0, "Errored SoundCloud widget must emit zero negotiations");

  // SoundCloud BLOCK / playable:false surfaces unavailable notice and blocks negotiation
  await player.applyState(
    {
      ...scState,
      rev: 8,
      epoch: 10,
      url: "https://soundcloud.com/artist/geo-blocked-track",
      mediaId: "https://soundcloud.com/artist/geo-blocked-track",
      anchorMs: wall,
    },
    wall,
    { source: "remote" }
  );
  const scBlocked = env.created.scWidgets[1];
  scBlocked.sounds = [
    {
      id: 888,
      title: "Blocked Track",
      user: { username: "Artist" },
      duration: 0,
      full_duration: 200000,
      policy: "BLOCK",
      playable: false,
    },
  ];
  scBlocked.paused = true;
  scBlocked.emit("ready");
  assert.equal(telemetries.at(-1).providerNotice?.code, "BLOCK");
  assert.equal(telemetries.at(-1).providerNotice?.blocksSync, true);
  assert.equal(telemetries.at(-1).providerNotice?.canReload, true);
  for (let i = 0; i < 10; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(negotiated.length, 0, "Blocked SoundCloud track must emit zero negotiations");

  // SoundCloud playlist: switching from SNIP track 0 -> full track 1 clears notice
  const scPlState = {
    ...scState,
    rev: 10,
    epoch: 2,
    positionMs: 0,
    url: "https://soundcloud.com/artist/sets/mixed-set",
    mediaId: "https://soundcloud.com/artist/sets/mixed-set",
    playlistId: "https://soundcloud.com/artist/sets/mixed-set",
    playlistIndex: 0,
    anchorMs: wall,
  };
  await player.applyState(scPlState, wall, { source: "remote" });
  const scPl = env.created.scWidgets[2];
  scPl.sounds = [
    {
      id: 1,
      title: "Snipped",
      user: { username: "A" },
      duration: 30000,
      full_duration: 200000,
      policy: "SNIP",
      playable: true,
    },
    {
      id: 2,
      title: "Full Free Track",
      user: { username: "A" },
      duration: 180000,
      full_duration: 180000,
      policy: "ALLOW",
      playable: true,
    },
  ];
  scPl.emit("ready");
  assert.equal(telemetries.at(-1).providerNotice?.code, "SNIP");

  await player.applyState({ ...scPlState, rev: 11, playlistIndex: 1, anchorMs: wall }, wall, {
    source: "remote",
  });
  assert.equal(
    telemetries.at(-1).providerNotice,
    null,
    "Switching from SNIP track to full track in SoundCloud playlist must clear notice"
  );

  // Regression 1: FINISH on policy: "SNIP" WITHOUT full_duration (fullDurationMs: 0) must still be guarded
  await player.applyState(
    {
      ...scState,
      rev: 12,
      epoch: 12,
      url: "https://soundcloud.com/artist/snip-no-full-duration",
      mediaId: "https://soundcloud.com/artist/snip-no-full-duration",
      playlistId: "",
      playlistIndex: 0,
      anchorMs: wall,
    },
    wall,
    { source: "remote" }
  );
  const scSnipNoFull = env.created.scWidgets.at(-1);
  scSnipNoFull.durationMs = 30000;
  scSnipNoFull.sounds = [
    {
      id: 901,
      title: "Snip No Full Duration",
      user: { username: "Artist" },
      duration: 30000,
      policy: "SNIP",
      playable: true,
    },
  ];
  scSnipNoFull.paused = false;
  scSnipNoFull.positionMs = 29000;
  scSnipNoFull.emit("ready");
  assert.equal(telemetries.at(-1).providerNotice?.code, "SNIP");
  assert.equal(telemetries.at(-1).providerNotice?.fullDurationMs, 0);
  const actionsBeforeFinish = userActions.length;
  scSnipNoFull.paused = true;
  scSnipNoFull.positionMs = 30000;
  scSnipNoFull.emit("finish");
  assert.equal(
    userActions.length,
    actionsBeforeFinish,
    "SNIP without full_duration must NOT emit ended/skip on FINISH"
  );

  // Regression 2: 3 Hz poll playlist track switch emits providerNotice transition & clears stale _scHasError
  const scPollPlState = {
    ...scState,
    rev: 20,
    epoch: 13,
    playing: true,
    positionMs: 5000,
    url: "https://soundcloud.com/artist/sets/poll-switch-set",
    mediaId: "https://soundcloud.com/artist/sets/poll-switch-set",
    playlistId: "https://soundcloud.com/artist/sets/poll-switch-set",
    playlistIndex: 0,
    anchorMs: wall,
  };
  await player.applyState(scPollPlState, wall, { source: "remote" });
  const scPollPl = env.created.scWidgets.at(-1);
  scPollPl.sounds = [
    { id: 301, title: "Full 1", user: { username: "A" }, duration: 180000, full_duration: 180000, policy: "ALLOW" },
    { id: 302, title: "Snip 2", user: { username: "A" }, duration: 30000, full_duration: 200000, policy: "SNIP" },
    { id: 303 }, // SoundCloud getSounds() stub without metadata!
  ];
  scPollPl.paused = false;
  scPollPl.positionMs = 5000;
  scPollPl.emit("ready");

  // Trigger ERROR on track 0, then widget silently moves to track 1 (SNIP) observed via 3 Hz poll
  scPollPl.emit("error", { message: "transient_err" });
  assert.equal(telemetries.at(-1).providerNotice?.code, "ERROR");
  assert.equal(player._scHasError, true);

  scPollPl.soundIndex = 1;
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  assert.equal(player._scHasError, false, "3 Hz poll track switch must clear stale _scHasError");
  assert.equal(
    telemetries.at(-1).providerNotice?.code,
    "SNIP",
    "3 Hz poll track switch must emit updated providerNotice (SNIP)"
  );

  // Now move to track 0 (ALLOW) via 3 Hz poll -> must emit providerNotice: null cleanly
  scPollPl.soundIndex = 0;
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  assert.equal(
    telemetries.at(-1).providerNotice,
    null,
    "3 Hz poll switch from SNIP to ALLOW must emit providerNotice: null"
  );

  // Regression 3: Same-track PLAY resume on a playlist track whose getSounds() entry is a stub `{ id }`
  // must NOT wipe an already-hydrated SNIP notice or flicker providerNotice: null!
  const hydratedStubSound = {
    id: 303,
    title: "Hydrated Stub SNIP",
    user: { username: "A" },
    duration: 30000,
    full_duration: 210000,
    policy: "SNIP",
    playable: true,
  };
  scPollPl.getCurrentSound = (cb) => cb(hydratedStubSound);
  scPollPl.soundIndex = 2;
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  assert.equal(player.providerNotice?.code, "SNIP");
  assert.equal(telemetries.at(-1).providerNotice?.code, "SNIP");

  const telStart = telemetries.length;
  // Simulate same-track resume (idx stays 2, where _scPlaylistSounds[2] is stub `{ id: 303 }`)
  scPollPl.paused = false;
  scPollPl.emit("play", { currentPosition: 8000, soundId: 303 });
  const resumeNoticeEmissions = telemetries.slice(telStart).filter((m) => "providerNotice" in m);
  assert.equal(
    resumeNoticeEmissions.some((m) => m.providerNotice === null),
    false,
    "Same-track resume with getSounds() stub must NOT flicker/wipe hydrated SNIP notice to null"
  );
  assert.equal(player.providerNotice?.code, "SNIP");
});

/* ==================== 4. Generalized Local reloadPlayerSession() Across All Providers ==================== */

test("Generalized reloadPlayerSession() works locally across YT, YT Music, SoundCloud, Twitch (VOD/Live/Clip), and Spotify with zero room disruption even when autoplay-blocked", async (t) => {
  const env = setupMultiProviderMocks();
  t.after(() => env.restore());

  let perf = 1000;
  let wall = 1_700_000_000_000;
  const userActions = [];
  const negotiated = [];
  const mountEl = createMockElement("div");

  const player = new WatchTogetherPlayer(mountEl, {
    localPeerId: "bob",
    peerStaggerMs: 0,
    perfNow: () => perf,
    wallNow: () => wall,
    onUserAction: (e) => userActions.push(e),
    onNegotiateState: (e) => negotiated.push(e),
  });
  t.after(() => player.destroy());

  // --- A. YouTube mid-track autoplay-blocked reload ---
  const ytState = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 42000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    provider: "youtube",
    mediaId: "dQw4w9WgXcQ",
    anchorMs: wall,
  };
  await player.applyState(ytState, wall, { source: "remote" });
  const yt1 = env.created.ytPlayers[0];
  yt1.triggerReady();
  yt1.triggerState(1);
  // reloadSpotifySession() returns false when provider is YouTube
  assert.equal(await player.reloadSpotifySession(), false);

  assert.equal(await player.reloadPlayerSession(), true);
  assert.ok(yt1.calls.some(([fn]) => fn === "destroy"), "Old YT player must be destroyed on reload");
  const yt2 = env.created.ytPlayers[1];
  // Simulate autoplay block on reloaded YouTube player
  yt2.playVideo = function blockedPlay() {
    this.calls.push(["playVideo"]);
    this.state = 2;
  };
  yt2.state = 2;
  yt2.currentTimeSec = 42;
  yt2.triggerReady();
  // Fire delayed PAUSED event AFTER expectedCommand expires
  perf += 2000;
  wall += 2000;
  yt2.triggerState(2);
  // 30 consecutive 3 Hz polls while autoplay stays blocked -> ZERO broadcasts!
  for (let i = 0; i < 30; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(userActions.length, 0, "Autoplay-blocked YT reload must emit zero onUserAction");
  assert.equal(negotiated.length, 0, "Autoplay-blocked YT reload must emit zero onNegotiateState");

  // User clicks Play locally 12s later -> locally aligns without rewinding room, then genuine Pause DOES sync!
  yt2.calls.length = 0;
  yt2.triggerState(1);
  assert.equal(userActions.length, 0, "Catch-up Play after autoplay block must not rewind room");
  assert.ok(yt2.calls.some(([fn]) => fn === "seekTo"), "Catch-up Play must seek locally to room position");
  perf += 1200;
  wall += 1200;
  yt2.triggerState(2);
  assert.equal(userActions.length, 1, "Genuine user Pause after catch-up must broadcast");
  assert.equal(userActions[0].playing, false);
  userActions.length = 0;

  // --- A2. YouTube Music mid-track autoplay-blocked reload ---
  await player.applyState(
    {
      ...ytState,
      rev: 3,
      epoch: 11,
      provider: "ytmusic",
      mediaId: "9bZkp7q19f0",
      url: "https://music.youtube.com/watch?v=9bZkp7q19f0",
      anchorMs: wall,
    },
    wall,
    { source: "remote" }
  );
  env.created.ytPlayers.at(-1).triggerReady();
  assert.equal(await player.reloadPlayerSession(), true);
  const ytmReloaded = env.created.ytPlayers.at(-1);
  assert.equal(ytmReloaded.opts.host, "https://www.youtube.com");
  ytmReloaded.playVideo = function blockedYtmPlay() {
    this.calls.push(["playVideo"]);
    this.state = 2;
  };
  ytmReloaded.state = 2;
  ytmReloaded.triggerReady();
  perf += 2000;
  wall += 2000;
  ytmReloaded.triggerState(2);
  for (let i = 0; i < 12; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(userActions.length, 0, "Autoplay-blocked YT Music reload must emit zero onUserAction");
  assert.equal(negotiated.length, 0, "Autoplay-blocked YT Music reload must emit zero onNegotiateState");

  // --- B. SoundCloud mid-track autoplay-blocked reload ---
  const scState = {
    targetId: "watch",
    kind: "watch",
    rev: 5,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 42000,
    rateMilli: 1000,
    epoch: 2,
    url: "https://soundcloud.com/artist/track",
    provider: "soundcloud",
    mediaId: "https://soundcloud.com/artist/track",
    anchorMs: wall,
  };
  await player.applyState(scState, wall, { source: "remote" });
  env.created.scWidgets[0].emit("ready");
  env.created.scWidgets[0].emit("play", { currentPosition: 42000 });

  assert.equal(await player.reloadPlayerSession(), true);
  assert.equal(env.created.scWidgets.length, 2);
  const sc2 = env.created.scWidgets[1];
  sc2.play = function blockedScPlay() {
    this.calls.push(["play"]);
    this.paused = true;
  };
  sc2.paused = true;
  sc2.positionMs = 42000;
  sc2.emit("ready");
  perf += 2000;
  wall += 2000;
  sc2.emit("pause", { currentPosition: 42000 });
  for (let i = 0; i < 30; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(userActions.length, 0, "Autoplay-blocked SoundCloud reload must emit zero onUserAction");
  assert.equal(negotiated.length, 0, "Autoplay-blocked SoundCloud reload must emit zero onNegotiateState");

  // --- C. Twitch VOD mid-track autoplay-blocked reload ---
  const twVodState = {
    targetId: "watch",
    kind: "watch",
    rev: 8,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 55000,
    rateMilli: 1000,
    epoch: 3,
    url: "https://www.twitch.tv/videos/12345678",
    provider: "twitch",
    mediaId: "video:12345678",
    anchorMs: wall,
  };
  await player.applyState(twVodState, wall, { source: "remote" });
  env.created.twitchPlayers[0].emit("ready");

  assert.equal(await player.reloadPlayerSession(), true);
  assert.equal(env.created.twitchPlayers.length, 2);
  const tw2 = env.created.twitchPlayers[1];
  tw2.play = function blockedTwPlay() {
    this.calls.push(["play"]);
    this.paused = true;
  };
  tw2.paused = true;
  tw2.currentTimeSec = 55;
  tw2.emit("ready");
  perf += 2000;
  wall += 2000;
  tw2.emit("pause");
  for (let i = 0; i < 30; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(userActions.length, 0, "Autoplay-blocked Twitch reload must emit zero onUserAction");
  assert.equal(negotiated.length, 0, "Autoplay-blocked Twitch reload must emit zero onNegotiateState");

  // --- D. Twitch Live, Collection & Clip reloads ---
  await player.applyState(
    {
      targetId: "watch",
      kind: "watch",
      rev: 9,
      actor: "alice",
      active: true,
      playing: true,
      positionMs: 0,
      rateMilli: 1000,
      epoch: 4,
      url: "https://www.twitch.tv/shroud",
      provider: "twitch",
      mediaId: "channel:shroud",
      anchorMs: wall,
    },
    wall,
    { source: "remote" }
  );
  const twLiveCountBefore = env.created.twitchPlayers.length;
  assert.equal(await player.reloadPlayerSession(), true);
  assert.equal(env.created.twitchPlayers.length, twLiveCountBefore + 1);
  const twLive2 = env.created.twitchPlayers.at(-1);
  twLive2.play = function blockedLivePlay() {
    this.calls.push(["play"]);
    this.paused = true;
  };
  twLive2.paused = true;
  twLive2.emit("ready");
  perf += 2000;
  wall += 2000;
  twLive2.emit("pause");
  for (let i = 0; i < 12; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(userActions.length, 0, "Autoplay-blocked Twitch Live reload must emit zero onUserAction");
  assert.equal(negotiated.length, 0, "Autoplay-blocked Twitch Live reload must emit zero onNegotiateState");

  await player.applyState(
    {
      targetId: "watch",
      kind: "watch",
      rev: 10,
      actor: "alice",
      active: true,
      playing: true,
      positionMs: 12000,
      rateMilli: 1000,
      epoch: 4,
      url: "https://www.twitch.tv/collections/colABC123",
      provider: "twitch",
      mediaId: "collection:colABC123",
      playlistId: "collection:colABC123",
      trackUri: "12345678",
      anchorMs: wall,
    },
    wall,
    { source: "remote" }
  );
  const twColCountBefore = env.created.twitchPlayers.length;
  assert.equal(await player.reloadPlayerSession(), true);
  assert.equal(env.created.twitchPlayers.length, twColCountBefore + 1);
  assert.equal(userActions.length, 0);
  assert.equal(negotiated.length, 0);

  await player.applyState(
    {
      targetId: "watch",
      kind: "watch",
      rev: 11,
      actor: "alice",
      active: true,
      playing: true,
      positionMs: 0,
      rateMilli: 1000,
      epoch: 4,
      url: "https://clips.twitch.tv/FunClipSlug",
      provider: "twitch",
      mediaId: "clip:FunClipSlug",
      anchorMs: wall,
    },
    wall,
    { source: "remote" }
  );
  const clipIframe1 = player.twitchIframe;
  assert.equal(await player.reloadPlayerSession(), true);
  assert.notEqual(player.twitchIframe, clipIframe1, "Twitch clip reload must remount fresh iframe");
  assert.equal(userActions.length, 0);
  assert.equal(negotiated.length, 0);

  // --- E. Spotify generalized reloadPlayerSession() & reloadSpotifySession() alias ---
  await player.applyState(
    {
      targetId: "watch",
      kind: "watch",
      rev: 12,
      actor: "alice",
      active: true,
      playing: true,
      positionMs: 42000,
      rateMilli: 1000,
      epoch: 5,
      url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
      provider: "spotify",
      mediaId: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
      anchorMs: wall,
    },
    wall,
    { source: "remote" }
  );
  assert.equal(env.created.spotifyCtrls.length, 1);
  assert.equal(await player.reloadPlayerSession(), true);
  assert.equal(env.created.spotifyCtrls.length, 2);
  assert.equal(await player.reloadSpotifySession(), true);
  assert.equal(env.created.spotifyCtrls.length, 3);
  assert.equal(userActions.length, 0);
  assert.equal(negotiated.length, 0);
});

/* ==================== 5. External URL Sanitization ==================== */

test("sanitizeWatchExternalUrl canonicalizes valid URLs and rejects unsafe/mismatched URLs", () => {
  assert.equal(
    sanitizeWatchExternalUrl("https://youtu.be/dQw4w9WgXcQ?t=42", "youtube"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"
  );
  assert.equal(
    sanitizeWatchExternalUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ytmusic"),
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ"
  );
  assert.equal(
    sanitizeWatchExternalUrl("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf", "youtube", {
      trackUri: "dQw4w9WgXcQ",
      playlistId: "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
    }),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
  );
  assert.equal(
    sanitizeWatchExternalUrl("https://soundcloud.com/artist/track?si=abc123", "soundcloud"),
    "https://soundcloud.com/artist/track"
  );
  assert.equal(
    sanitizeWatchExternalUrl("https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=xyz", "spotify"),
    "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"
  );

  // Unsafe / XSS / cross-provider spoofing rejected to safe https:// provider origin
  assert.equal(sanitizeWatchExternalUrl("javascript:alert(1)", "youtube"), "https://www.youtube.com/");
  assert.equal(sanitizeWatchExternalUrl("javascript:alert(1)", "ytmusic"), "https://music.youtube.com/");
  assert.equal(sanitizeWatchExternalUrl("data:text/html,<script>", "soundcloud"), "https://soundcloud.com/");
  assert.equal(sanitizeWatchExternalUrl("https://evil.example/phish", "spotify"), "https://open.spotify.com/");
  assert.equal(sanitizeWatchExternalUrl("https://evil.example/phish", "twitch"), "https://www.twitch.tv/");
  assert.equal(
    sanitizeWatchExternalUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", "youtube"),
    "https://www.youtube.com/"
  );
  assert.equal(
    sanitizeWatchExternalUrl("javascript:alert(1)", "youtube", {
      trackUri: "javascript:bad",
      playlistId: "bad",
    }),
    "https://www.youtube.com/"
  );
});

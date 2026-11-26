import test from "node:test";
import assert from "node:assert/strict";
import {
  WatchTogetherPlayer,
  WatchSyncNegotiator,
  WATCH_SYNC_DEFAULTS,
  projectMediaPositionMs,
} from "../watch_together.js";

/* ==================== Minimal DOM & Provider Embed Mocks ==================== */

function createMockElement(tag = "div") {
  const attrs = new Map();
  return {
    tagName: tag.toUpperCase(),
    className: "",
    id: "",
    src: "",
    children: [],
    _innerHTML: "",
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(v) {
      this._innerHTML = String(v);
      if (v === "") this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k);
    },
    dataset: {},
  };
}

function setupMockDomAndApis() {
  const listeners = {
    scWidgets: [],
    ytPlayers: [],
    twitchPlayers: [],
    spotifyCtrls: [],
  };

  globalThis.document = {
    documentElement: {
      getAttribute: () => "dark",
    },
    head: createMockElement("head"),
    createElement: (tag) => createMockElement(tag),
  };

  // Mock SoundCloud Widget API
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
          sounds: [{ id: 1001, title: "Track 1", user: { username: "Artist" }, duration: 180000 }],
          asyncDelay: false,
          pendingCallbacks: [],
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
            const val = this.paused;
            if (this.asyncDelay) {
              this.pendingCallbacks.push(() => cb(val));
            } else {
              cb(val);
            }
          },
          getPosition(cb) {
            const val = this.positionMs;
            if (this.asyncDelay) {
              this.pendingCallbacks.push(() => cb(val));
            } else {
              cb(val);
            }
          },
          getDuration(cb) {
            cb(this.durationMs);
          },
          getCurrentSound(cb) {
            cb(this.sounds[this.soundIndex] || this.sounds[0]);
          },
          getCurrentSoundIndex(cb) {
            const val = this.soundIndex;
            if (this.asyncDelay) {
              this.pendingCallbacks.push(() => cb(val));
            } else {
              cb(val);
            }
          },
          getSounds(cb) {
            cb(this.sounds);
          },
          flushCallbacks() {
            const q = this.pendingCallbacks.splice(0);
            for (const fn of q) fn();
          },
        };
        listeners.scWidgets.push(widget);
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
        },
      }
    ),
  };

  // Mock YouTube IFrame API
  const YT = {
    Player: function MockYTPlayer(holder, opts) {
      const player = {
        holder,
        opts,
        state: 2, // PAUSED
        currentTimeSec: 0,
        durationSec: 240,
        rate: 1,
        muted: false,
        volume: 80,
        playlist: opts.playerVars?.list ? ["vidA", "vidB", "vidC"] : null,
        playlistIndex: opts.playerVars?.index || 0,
        calls: [],
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
          const vid = this.playlist ? this.playlist[this.playlistIndex] : opts.videoId || "vidA";
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
        triggerRate(r) {
          this.rate = r;
          opts.events?.onPlaybackRateChange?.({ data: r });
        },
      };
      listeners.ytPlayers.push(player);
      return player;
    },
  };

  // Mock Twitch Embed API
  const Twitch = {
    Player: Object.assign(
      function MockTwitchPlayer(holderId, opts) {
        const handlers = new Map();
        const player = {
          holderId,
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
        listeners.twitchPlayers.push(player);
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

  // Mock Spotify IFrame API
  const SpotifyIFrameAPI = {
    createController(holder, opts, cb) {
      const handlers = new Map();
      const ctrl = {
        holder,
        opts,
        calls: [],
        addListener(ev, fn) {
          if (!handlers.has(ev)) handlers.set(ev, []);
          handlers.get(ev).push(fn);
        },
        emit(ev, payload) {
          for (const fn of handlers.get(ev) || []) fn(payload);
        },
        play() {
          this.calls.push(["play"]);
        },
        resume() {
          this.calls.push(["resume"]);
        },
        pause() {
          this.calls.push(["pause"]);
        },
        seek(sec) {
          this.calls.push(["seek", sec]);
        },
        loadUri(uri) {
          this.calls.push(["loadUri", uri]);
        },
        destroy() {
          this.calls.push(["destroy"]);
        },
      };
      listeners.spotifyCtrls.push(ctrl);
      cb(ctrl);
    },
  };

  globalThis.window = {
    location: { origin: "https://example.test", hostname: "example.test" },
    SC,
    YT,
    Twitch,
    __spotifyIframeApi: SpotifyIFrameAPI,
  };

  return listeners;
}

/* ==================== Simulated Multi-Peer Mesh (mirrors src/mesh.rs LWW) ==================== */

class SimulatedMediaMesh {
  constructor(peers) {
    // peers: Array<{ id, clockOffsetMs, rttMs, player, state }>
    this.peers = new Map();
    this.inFlight = [];
    for (const p of peers) {
      this.peers.set(p.id, { ...p, state: null });
    }
  }

  publish(actorId, partial, baseNowMs, source = "local-embed") {
    const actor = this.peers.get(actorId);
    const localNow = baseNowMs + actor.clockOffsetMs;
    const prev = actor.state;
    const nextRev = (prev?.rev || 0) + 1;
    const next = {
      targetId: "watch",
      kind: "watch",
      rev: nextRev,
      actor: actorId,
      actorName: actorId,
      active: true,
      playing: partial.playing !== undefined ? Boolean(partial.playing) : Boolean(prev?.playing),
      positionMs:
        partial.positionMs !== undefined
          ? Math.max(0, Math.round(partial.positionMs))
          : prev
            ? projectMediaPositionMs(prev, localNow)
            : 0,
      rateMilli: partial.rateMilli || prev?.rateMilli || 1000,
      loop: partial.loop !== undefined ? Boolean(partial.loop) : Boolean(prev?.loop),
      epoch: partial.epoch !== undefined ? partial.epoch : prev?.epoch || 1,
      url: partial.url ?? prev?.url ?? "",
      provider: partial.provider ?? prev?.provider ?? "",
      mediaId: partial.mediaId ?? prev?.mediaId ?? "",
      playlistId: partial.playlistId ?? prev?.playlistId ?? "",
      playlistIndex: partial.playlistIndex ?? prev?.playlistIndex ?? 0,
      trackUri: partial.trackUri ?? prev?.trackUri ?? "",
      anchorMs: localNow,
    };
    actor.state = next;
    // Mirrors src/mesh.rs: synchronous self-echo back to publisher
    actor.player.applyState(next, localNow, { source });

    // Queue wire delivery to all other peers with RTT/2 transit + clock-skew-free projection
    for (const [pid, peer] of this.peers.entries()) {
      if (pid === actorId) continue;
      const oneWayMs = Math.round((actor.rttMs + peer.rttMs) / 4);
      const wirePosMs = projectMediaPositionMs(next, localNow);
      this.inFlight.push({
        deliverAtBaseMs: baseNowMs + oneWayMs,
        targetId: pid,
        oneWayMs,
        wireState: { ...next, positionMs: wirePosMs },
      });
    }
    return next;
  }

  deliverUpTo(baseNowMs) {
    const ready = [];
    const remaining = [];
    for (const pkt of this.inFlight) {
      if (pkt.deliverAtBaseMs <= baseNowMs) ready.push(pkt);
      else remaining.push(pkt);
    }
    this.inFlight = remaining;
    ready.sort((a, b) => a.deliverAtBaseMs - b.deliverAtBaseMs);

    for (const pkt of ready) {
      const peer = this.peers.get(pkt.targetId);
      const localNow = baseNowMs + peer.clockOffsetMs;
      const incoming = {
        ...pkt.wireState,
        positionMs:
          pkt.wireState.active && pkt.wireState.playing
            ? pkt.wireState.positionMs +
              Math.round((pkt.oneWayMs * (pkt.wireState.rateMilli || 1000)) / 1000)
            : pkt.wireState.positionMs,
        anchorMs: localNow,
      };
      const existing = peer.state;
      // Mirrors MediaSyncState::is_strictly_newer_than: (rev, actor) > (existing.rev, existing.actor)
      if (
        existing &&
        (incoming.rev < existing.rev ||
          (incoming.rev === existing.rev && incoming.actor <= existing.actor))
      ) {
        continue;
      }
      peer.state = incoming;
      peer.player.applyState(incoming, localNow, { source: "remote" });
    }
  }
}

/* ==================== TESTS ==================== */

test("SoundCloud fast-click Pause -> Resume (<100ms) syncs reliably without self-echo suppression", async (t) => {
  const mocks = setupMockDomAndApis();
  let perf = 1000;
  let wall = 1_700_000_000_000;
  const published = [];

  const mountEl = createMockElement("div");
  let currentState = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 12000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://soundcloud.com/artist/track",
    provider: "soundcloud",
    mediaId: "https://soundcloud.com/artist/track",
    anchorMs: wall,
  };

  const player = new WatchTogetherPlayer(mountEl, {
    perfNow: () => perf,
    wallNow: () => wall,
    onUserAction: (ev) => {
      published.push({ ...ev, t: perf });
      currentState = {
        ...currentState,
        rev: currentState.rev + 1,
        playing: ev.playing,
        positionMs: ev.positionMs,
        anchorMs: wall,
      };
      // Synchronous self-echo just like app.js publishMediaSync -> wasm -> handleIncomingMediaSync
      player.applyState(currentState, wall, { source: "local-embed" });
    },
  });
  t.after(() => player.destroy());

  await player.applyState(currentState, wall, { source: "remote" });
  const sc = mocks.scWidgets[0];
  sc.emit("ready");
  // Simulate initial play settling
  sc.paused = false;
  sc.positionMs = 12000;
  sc.emit("play", { currentPosition: 12000 });
  perf += 2000;
  wall += 2000;
  sc.calls.length = 0;

  // Rapid user interaction: Pause at t=3000ms, Resume 80ms later at t=3080ms, Pause 70ms later, Resume 60ms later!
  sc.paused = true;
  sc.positionMs = 14000;
  sc.emit("pause", { currentPosition: 14000 });

  perf += 80;
  wall += 80;
  sc.paused = false;
  sc.positionMs = 14050;
  sc.emit("play", { currentPosition: 14050 });

  perf += 70;
  wall += 70;
  sc.paused = true;
  sc.positionMs = 14120;
  sc.emit("pause", { currentPosition: 14120 });

  perf += 60;
  wall += 60;
  sc.paused = false;
  sc.positionMs = 14130;
  sc.emit("play", { currentPosition: 14130 });

  assert.equal(published.length, 4, "Every rapid Pause/Resume click must propagate");
  assert.deepEqual(
    published.map((e) => e.playing),
    [false, true, false, true]
  );
  assert.equal(
    sc.calls.length,
    0,
    "Self-echo must NOT call redundant scWidget.play()/pause() back into the widget"
  );

  // Also test falsy-zero positionMs (restarting track at 0ms)
  perf += 50;
  wall += 50;
  sc.positionMs = 0;
  sc.emit("play", { currentPosition: 0 });
  assert.equal(published[4].positionMs, 0, "currentPosition: 0 must not fall back to stale position");
});

test("SoundCloud playlist rapid PLAY -> PAUSE cancels stale async getCurrentSoundIndex callback", async (t) => {
  const mocks = setupMockDomAndApis();
  let perf = 1000;
  let wall = 1_700_000_000_000;
  const published = [];

  const mountEl = createMockElement("div");
  let currentState = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: false,
    positionMs: 5000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://soundcloud.com/artist/sets/my-set",
    provider: "soundcloud",
    mediaId: "https://soundcloud.com/artist/sets/my-set",
    playlistId: "https://soundcloud.com/artist/sets/my-set",
    playlistIndex: 0,
    anchorMs: wall,
  };

  const player = new WatchTogetherPlayer(mountEl, {
    perfNow: () => perf,
    wallNow: () => wall,
    onUserAction: (ev) => {
      published.push(ev);
      currentState = {
        ...currentState,
        rev: currentState.rev + 1,
        playing: ev.playing,
        positionMs: ev.positionMs,
        playlistIndex: ev.playlistIndex ?? currentState.playlistIndex,
        anchorMs: wall,
      };
      player.applyState(currentState, wall, { source: "local-embed" });
    },
  });
  t.after(() => player.destroy());

  await player.applyState(currentState, wall, { source: "remote" });
  const sc = mocks.scWidgets[0];
  sc.sounds = [
    { id: 101, title: "One", user: { username: "A" }, duration: 120000 },
    { id: 102, title: "Two", user: { username: "A" }, duration: 130000 },
  ];
  sc.emit("ready");
  perf += 3000;
  wall += 3000;

  // 1. Synchronous soundId match resolves in 0ms even when asyncDelay is on!
  sc.asyncDelay = true;
  sc.soundIndex = 1;
  sc.paused = false;
  sc.emit("play", { currentPosition: 0, soundId: 102 });
  assert.equal(published.length, 1);
  assert.equal(published[0].playing, true);
  assert.equal(published[0].playlistIndex, 1);

  // 2. Without soundId, PLAY queues async getCurrentSoundIndex; user clicks PAUSE before it returns!
  perf += 40;
  wall += 40;
  sc.paused = false;
  sc.emit("play", { currentPosition: 100 }); // awaits getCurrentSoundIndex
  perf += 30;
  wall += 30;
  sc.paused = true;
  sc.emit("pause", { currentPosition: 120 }); // fires synchronously, supersedes pending PLAY

  // Now the stale getCurrentSoundIndex callback arrives late!
  sc.flushCallbacks();

  assert.equal(published.length, 2, "Stale PLAY callback must be discarded after faster PAUSE");
  assert.equal(published[1].playing, false);
});

test("YouTube fast-click Pause -> Resume (<100ms), remote-pause -> fast local resume, and rebuffer vs scrub", async (t) => {
  const mocks = setupMockDomAndApis();
  let perf = 1000;
  let wall = 1_700_000_000_000;
  const published = [];

  const mountEl = createMockElement("div");
  let currentState = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 20000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    provider: "youtube",
    mediaId: "dQw4w9WgXcQ",
    anchorMs: wall,
  };

  const player = new WatchTogetherPlayer(mountEl, {
    perfNow: () => perf,
    wallNow: () => wall,
    onUserAction: (ev) => {
      published.push({ ...ev, t: perf });
      currentState = {
        ...currentState,
        rev: currentState.rev + 1,
        playing: ev.playing,
        positionMs: ev.positionMs,
        anchorMs: wall,
      };
      player.applyState(currentState, wall, { source: "local-embed" });
    },
  });
  t.after(() => player.destroy());

  await player.applyState(currentState, wall, { source: "remote" });
  const yt = mocks.ytPlayers[0];
  yt.currentTimeSec = 20;
  yt.triggerReady();
  yt.triggerState(1); // expected initial play echo
  perf += 2500;
  wall += 2500;
  yt.currentTimeSec = 22.5;

  // 1. Fast local Pause -> Resume (70ms apart)
  yt.triggerState(2);
  perf += 70;
  wall += 70;
  yt.triggerState(1);
  assert.deepEqual(
    published.map((e) => e.playing),
    [false, true],
    "Fast YouTube Pause -> Resume must both sync"
  );

  // 2. Remote peer pauses -> echo suppressed -> local user clicks Resume 120ms later -> syncs!
  perf += 500;
  wall += 500;
  const remotePause = {
    ...currentState,
    rev: currentState.rev + 1,
    actor: "bob",
    playing: false,
    positionMs: 23000,
    anchorMs: wall,
  };
  currentState = remotePause;
  await player.applyState(remotePause, wall, { source: "remote" });

  // Programmatic pause echo arrives at +30ms -> MUST be suppressed
  perf += 30;
  wall += 30;
  yt.triggerState(2);
  assert.equal(published.length, 2, "Programmatic remote-pause echo must be suppressed");

  // User clicks Resume inside YouTube only 120ms later (well inside old 950ms window!)
  perf += 120;
  wall += 120;
  yt.triggerState(1);
  assert.equal(published.length, 3, "User fast Resume after remote pause must NOT be swallowed");
  assert.equal(published[2].playing, true);

  // 3. Network rebuffer (3 -> 1 at same position after 2s stall) must NOT rewind room; seeks locally instead
  perf += 2000;
  wall += 2000;
  yt.currentTimeSec = 25;
  yt.triggerState(3); // buffering at 25s
  perf += 2100;
  wall += 2100;
  yt.calls.length = 0;
  yt.currentTimeSec = 25.1; // resumed right where it stalled (2.0s behind room's 27.1s)
  yt.triggerState(1);
  assert.equal(published.length, 3, "Network rebuffer must NOT publish a rewind to peers");
  assert.ok(
    yt.calls.some(([fn]) => fn === "seekTo"),
    "Network rebuffer behind by >1.2s should locally catch up"
  );

  // 4. Genuine user scrub (3 -> 1 at a NEW position +30s away) MUST publish immediately
  perf += 1500;
  wall += 1500;
  yt.currentTimeSec = 28;
  yt.triggerState(3);
  perf += 100;
  wall += 100;
  yt.currentTimeSec = 60;
  yt.triggerState(1);
  assert.equal(published.length, 4, "Scrubber jump during buffering MUST propagate");
  assert.equal(published[3].positionMs, 60000);
});

test("3 Hz polling catches dropped SoundCloud Resume & YouTube/Twitch/Spotify drastic divergence", async (t) => {
  const mocks = setupMockDomAndApis();
  let perf = 1000;
  let wall = 1_700_000_000_000;
  const negotiated = [];

  const mountEl = createMockElement("div");
  let scState = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: false,
    positionMs: 10000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://soundcloud.com/artist/track",
    provider: "soundcloud",
    mediaId: "https://soundcloud.com/artist/track",
    anchorMs: wall,
  };

  const player = new WatchTogetherPlayer(mountEl, {
    perfNow: () => perf,
    wallNow: () => wall,
    peerStaggerMs: 0,
    onNegotiateState: (ev) => {
      negotiated.push(ev);
      scState = {
        ...scState,
        rev: scState.rev + 1,
        playing: ev.playing,
        positionMs: ev.positionMs,
        anchorMs: wall,
      };
      player.applyState(scState, wall, { source: "negotiated" });
    },
  });
  t.after(() => player.destroy());

  await player.applyState(scState, wall, { source: "remote" });
  const sc = mocks.scWidgets[0];
  sc.paused = true;
  sc.positionMs = 10000;
  sc.emit("ready");

  // Converge on initial paused state
  perf += 3000;
  wall += 3000;
  player._pollPlayerStateOnce();
  assert.equal(negotiated.length, 0);

  // SoundCloud starts playing internally WITHOUT firing a PLAY event!
  sc.paused = false;
  sc.positionMs = 10333;
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce(); // Poll 1: confirming
  assert.equal(negotiated.length, 0, "First divergent poll should confirm before negotiating");

  sc.positionMs = 10666;
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce(); // Poll 2: confirmed -> negotiate!
  assert.equal(negotiated.length, 1, "Second 3 Hz poll must negotiate missed SoundCloud resume");
  assert.equal(negotiated[0].playing, true);
  assert.equal(negotiated[0].positionMs, 10666);
  assert.match(negotiated[0].reason, /play-state/);

  // Advance 2.0s normally past negotiation cooldown (with regular 3 Hz polls)
  for (let i = 0; i < 6; i++) {
    perf += 333;
    wall += 333;
    sc.positionMs += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(negotiated.length, 1);

  // Drastic position jump (+25s) while playing without SEEK event: correctDrift must NOT yank it back!
  sc.positionMs = 38000; // expected is ~12664ms -> 25s drastic divergence!
  sc.calls.length = 0;
  player.correctDrift(scState, wall);
  assert.equal(
    sc.calls.length,
    0,
    "correctDrift must defer >=3s drastic divergence to negotiator instead of yanking player back"
  );

  // Two 3 Hz polls confirm drastic position divergence and negotiate the new position
  perf += 333;
  wall += 333;
  sc.positionMs = 38333;
  player._pollPlayerStateOnce();
  perf += 333;
  wall += 333;
  sc.positionMs = 38666;
  player._pollPlayerStateOnce();
  assert.equal(negotiated.length, 2, "Drastic position drift must negotiate a new shared state");
  assert.equal(negotiated[1].positionMs, 38666);
  assert.match(negotiated[1].reason, /position-drift/);

  // Mild drift (+1.8s) while playing IS corrected locally without negotiation
  for (let i = 0; i < 6; i++) {
    perf += 333;
    wall += 333;
    sc.positionMs += 333;
    player._pollPlayerStateOnce();
  }
  sc.positionMs -= 1850; // 1.85s mild lag (>1500ms, <3000ms)
  sc.calls.length = 0;
  player.correctDrift(scState, wall);
  assert.ok(
    sc.calls.some(([fn]) => fn === "seekTo"),
    "Mild drift (1.5s..3.0s) should locally catch up via correctDrift"
  );
  assert.equal(negotiated.length, 2);

  // SoundCloud async poll staleness guard: if user clicks PAUSE while async poll is in flight, stale poll is discarded
  sc.asyncDelay = true;
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce(); // starts async isPaused/getPosition while paused=false
  sc.paused = true;
  sc.emit("pause", { currentPosition: 40500 }); // user clicks pause before poll resolves!
  sc.flushCallbacks(); // stale poll resolves with paused=false -> MUST be discarded!
  assert.equal(player.lastKnownPlaying, false, "Stale SoundCloud async poll must not overwrite newer PAUSE");
  sc.asyncDelay = false;

  // Twitch live channel polling catches dropped pause
  let twState = {
    targetId: "watch",
    kind: "watch",
    rev: 10,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 0,
    rateMilli: 1000,
    epoch: 2,
    url: "https://www.twitch.tv/shroud",
    provider: "twitch",
    mediaId: "channel:shroud",
    anchorMs: wall,
  };
  await player.applyState(twState, wall, { source: "remote" });
  const tw = mocks.twitchPlayers[0];
  tw.paused = false;
  tw.emit("ready");
  for (let i = 0; i < 8; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  tw.paused = true; // dropped PAUSE event
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  assert.equal(negotiated.length, 3, "Twitch live channel polling catches dropped pause");
  assert.equal(negotiated[2].playing, false);

  // Spotify polling catches dropped play/pause when durationMs > 0
  let spState = {
    targetId: "watch",
    kind: "watch",
    rev: 20,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 5000,
    rateMilli: 1000,
    epoch: 3,
    url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    provider: "spotify",
    mediaId: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
    anchorMs: wall,
  };
  await player.applyState(spState, wall, { source: "remote" });
  const sp = mocks.spotifyCtrls[0];
  sp.emit("ready");
  // Initial playback_update converges
  sp.emit("playback_update", { data: { position: 5000, duration: 210000, isPaused: false } });
  for (let i = 0; i < 8; i++) {
    perf += 333;
    wall += 333;
    player.lastKnownPosMs += 333;
    player._pollPlayerStateOnce();
  }
  // Simulate state change that happened during suppression so playback_update updated lastKnownPlaying
  player.lastKnownPlaying = false;
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  assert.equal(negotiated.length, 4, "Spotify polling catches diverged play/pause state");
  assert.equal(negotiated[3].playing, false);
});

test("Multi-peer simultaneous drastic divergence converges deterministically without oscillation across skewed clocks", async (t) => {
  const mocks = setupMockDomAndApis();
  let baseWall = 1_700_000_000_000;
  let perf = 1000;
  let totalNegotiations = 0;

  // 3 peers with massive clock skew (-10h, 0h, +20h) and realistic RTTs
  const specs = [
    { id: "alice", clockOffsetMs: -36_000_000, rttMs: 60 },
    { id: "bob", clockOffsetMs: 0, rttMs: 80 },
    { id: "carol", clockOffsetMs: 72_000_000, rttMs: 120 },
  ];

  let mesh;
  const players = {};
  for (const s of specs) {
    const el = createMockElement("div");
    players[s.id] = new WatchTogetherPlayer(el, {
      localPeerId: s.id,
      peerStaggerMs: 0, // force worst-case simultaneous lockstep polling!
      perfNow: () => perf,
      wallNow: () => baseWall + s.clockOffsetMs,
      onUserAction: (ev) => {
        mesh.publish(s.id, ev, baseWall, "local-embed");
      },
      onNegotiateState: (ev) => {
        totalNegotiations += 1;
        mesh.publish(s.id, ev, baseWall, "negotiated");
      },
    });
  }
  t.after(() => {
    for (const id of ["alice", "bob", "carol"]) players[id].destroy();
  });

  mesh = new SimulatedMediaMesh(specs.map((s) => ({ ...s, player: players[s.id] })));

  // Alice starts a YouTube video at 30s playing
  mesh.publish(
    "alice",
    {
      playing: true,
      positionMs: 30000,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
      mediaId: "dQw4w9WgXcQ",
      epoch: 1,
    },
    baseWall,
    "local-ui"
  );

  // Deliver initial mount to all peers and flush async _mountYouTube microtasks
  baseWall += 200;
  perf += 200;
  mesh.deliverUpTo(baseWall);
  await Promise.resolve();
  await Promise.resolve();

  const ytByPeer = {
    alice: mocks.ytPlayers[0],
    bob: mocks.ytPlayers[1],
    carol: mocks.ytPlayers[2],
  };
  for (const id of ["alice", "bob", "carol"]) {
    ytByPeer[id].currentTimeSec = 30.2;
    ytByPeer[id].state = 1;
    ytByPeer[id].triggerReady();
  }

  // Advance 3s in sync so all 3 peers converge cleanly
  for (let i = 0; i < 9; i++) {
    perf += 333;
    baseWall += 333;
    for (const id of ["alice", "bob", "carol"]) {
      ytByPeer[id].currentTimeSec += 0.333;
      players[id]._pollPlayerStateOnce();
    }
    mesh.deliverUpTo(baseWall);
  }
  assert.equal(totalNegotiations, 0, "Zero negotiations while all 3 peers are in sync despite 30h clock skew");

  // WORST CASE: Alice and Bob BOTH silently diverge at the exact same tick to conflicting states!
  // Alice jumps to 90s paused; Bob jumps to 10s playing; Carol stays at 33s playing.
  ytByPeer.alice.state = 2;
  ytByPeer.alice.currentTimeSec = 90;
  ytByPeer.bob.state = 1;
  ytByPeer.bob.currentTimeSec = 10;

  // Run 30 ticks (10 full seconds of 3 Hz polling + network delivery + player progression)
  for (let i = 0; i < 30; i++) {
    perf += 333;
    baseWall += 333;
    for (const id of ["alice", "bob", "carol"]) {
      if (ytByPeer[id].state === 1) ytByPeer[id].currentTimeSec += 0.333;
    }
    mesh.deliverUpTo(baseWall);
    for (const id of ["alice", "bob", "carol"]) {
      players[id]._pollPlayerStateOnce();
    }
  }

  // Verify ALL 3 peers converged to the exact same shared state (rev, actor, playing, and position within RTT)
  const stA = mesh.peers.get("alice").state;
  const stB = mesh.peers.get("bob").state;
  const stC = mesh.peers.get("carol").state;

  assert.equal(stA.rev, stB.rev);
  assert.equal(stB.rev, stC.rev);
  assert.equal(stA.actor, "bob", "LWW tie-break (rev, 'bob') > (rev, 'alice') must pick Bob cleanly");
  assert.equal(stA.actor, stB.actor);
  assert.equal(stB.actor, stC.actor);
  assert.equal(stA.playing, true);
  assert.equal(ytByPeer.alice.state, 1, "Alice's player must converge to Bob's winning playing state");
  assert.equal(ytByPeer.bob.state, 1);
  assert.equal(ytByPeer.carol.state, 1);

  const posA = ytByPeer.alice.currentTimeSec * 1000;
  const posB = ytByPeer.bob.currentTimeSec * 1000;
  const posC = ytByPeer.carol.currentTimeSec * 1000;
  assert.ok(Math.abs(posA - posB) < 600, `Alice (${posA}) and Bob (${posB}) must converge in position`);
  assert.ok(Math.abs(posC - posB) < 600, `Carol (${posC}) and Bob (${posB}) must converge in position`);
  assert.ok(
    totalNegotiations <= 2,
    `Expected <=2 proposals (1 concurrent tie-break) with zero oscillation, got ${totalNegotiations}`
  );
});

test("WatchSyncNegotiator guards: autoplay-blocked joiner, tab sleep wake-up, buffering, rate-limit, and timer cleanup", async (t) => {
  const neg = new WatchSyncNegotiator({ localPeerId: "bob", peerStaggerMs: 0 });
  const sharedPlaying = {
    rev: 5,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 45000,
    rateMilli: 1000,
    anchorMs: 100000,
  };

  // 1. Initial mount where browser blocks autoplay -> retry once, then guard (NEVER pause the room!)
  neg.onSharedStateApplied(sharedPlaying, 1000, {
    source: "remote",
    didMutate: true,
    isInitial: true,
    preApplySnapshot: { playing: false, positionMs: 0 },
  });

  // During initial grace (2400ms): none
  let d = neg.evaluate(
    {
      provider: "soundcloud",
      ready: true,
      playing: false,
      hasPlayState: true,
      positionMs: 0,
      hasPosition: true,
      observedAt: 2000,
      wallNowMs: 101000,
    },
    sharedPlaying,
    { hasEverPlayedLocally: false }
  );
  assert.equal(d.action, "none");
  assert.equal(d.reason, "in-grace-window");

  // After grace: 2 polls -> 1 bounded local resync retry
  neg.evaluate(
    {
      provider: "soundcloud",
      ready: true,
      playing: false,
      hasPlayState: true,
      positionMs: 0,
      hasPosition: true,
      observedAt: 3600,
      wallNowMs: 102600,
    },
    sharedPlaying,
    { hasEverPlayedLocally: false }
  );
  d = neg.evaluate(
    {
      provider: "soundcloud",
      ready: true,
      playing: false,
      hasPlayState: true,
      positionMs: 0,
      hasPosition: true,
      observedAt: 3933,
      wallNowMs: 102933,
    },
    sharedPlaying,
    { hasEverPlayedLocally: false }
  );
  assert.equal(d.action, "resync-local");
  assert.equal(d.reason, "unconverged-retry");

  // Still autoplay-blocked after retry grace (1600ms) -> autoplay-blocked-guard, NOT negotiate!
  neg.evaluate(
    {
      provider: "soundcloud",
      ready: true,
      playing: false,
      hasPlayState: true,
      positionMs: 0,
      hasPosition: true,
      observedAt: 5800,
      wallNowMs: 104800,
    },
    sharedPlaying,
    { hasEverPlayedLocally: false }
  );
  d = neg.evaluate(
    {
      provider: "soundcloud",
      ready: true,
      playing: false,
      hasPlayState: true,
      positionMs: 0,
      hasPosition: true,
      observedAt: 6133,
      wallNowMs: 105133,
    },
    sharedPlaying,
    { hasEverPlayedLocally: false }
  );
  assert.equal(d.action, "none");
  assert.equal(d.reason, "autoplay-blocked-guard");

  // 2. Tab sleep / background throttle wake-up (>2.5s poll gap) -> resync-local instead of dragging room back!
  const neg2 = new WatchSyncNegotiator({ localPeerId: "bob", peerStaggerMs: 0 });
  neg2.onSharedStateApplied(sharedPlaying, 1000, { source: "local-embed", didMutate: false });
  neg2.evaluate(
    {
      provider: "youtube",
      ready: true,
      playing: true,
      hasPlayState: true,
      positionMs: 45333,
      hasPosition: true,
      observedAt: 1333,
      wallNowMs: 100333,
    },
    sharedPlaying
  );
  // Tab slept for 15 seconds while player froze at 45.3s (room is now at 60.3s)
  d = neg2.evaluate(
    {
      provider: "youtube",
      ready: true,
      playing: true,
      hasPlayState: true,
      positionMs: 45333,
      hasPosition: true,
      observedAt: 16333,
      wallNowMs: 115333,
    },
    sharedPlaying
  );
  assert.equal(d.action, "resync-local");
  assert.equal(d.reason, "tab-wake-resync");

  // 3. Buffering resets streak and never negotiates
  const neg3 = new WatchSyncNegotiator({ localPeerId: "bob", peerStaggerMs: 0 });
  neg3.onSharedStateApplied(sharedPlaying, 1000, { source: "local-embed", didMutate: false });
  d = neg3.evaluate(
    {
      provider: "youtube",
      ready: true,
      buffering: true,
      playing: false,
      hasPlayState: false,
      positionMs: 10000,
      hasPosition: false,
      observedAt: 1500,
      wallNowMs: 100500,
    },
    sharedPlaying
  );
  assert.equal(d.action, "none");
  assert.equal(d.reason, "buffering");

  // 3b. Logged-out 30s Spotify preview peer never overrides full-track room past preview duration
  d = neg3.evaluate(
    {
      provider: "spotify",
      ready: true,
      buffering: false,
      playing: false,
      hasPlayState: true,
      positionMs: 12000,
      hasPosition: true,
      durationMs: 29700,
      observedAt: 1833,
      wallNowMs: 100833, // room expected is 45833ms > 29700ms preview!
    },
    sharedPlaying
  );
  assert.equal(d.action, "none");
  assert.equal(d.reason, "preview-out-of-range");

  // 4. destroy() clears pollTimer and all pending sync timers cleanly
  const mocks = setupMockDomAndApis();
  const el = createMockElement("div");
  const p = new WatchTogetherPlayer(el, { localPeerId: "alice" });
  t.after(() => p.destroy());
  await p.applyState(
    {
      targetId: "watch",
      kind: "watch",
      rev: 1,
      active: true,
      playing: true,
      positionMs: 0,
      rateMilli: 1000,
      epoch: 1,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
      mediaId: "dQw4w9WgXcQ",
      anchorMs: Date.now(),
    },
    Date.now(),
    { source: "remote" }
  );
  mocks.ytPlayers[0].state = 2; // stays paused so autoplay timer is scheduled
  mocks.ytPlayers[0].triggerReady();
  assert.ok(p.pollTimer !== null, "Poll timer should be running");
  assert.ok(p._syncTimers.size > 0, "Autoplay timer should be tracked");

  // Fast user PAUSE inside YouTube must cancel pending autoplay-muted retry timer!
  mocks.ytPlayers[0].triggerState(2); // expected or ignored during initial; simulate play then fast pause
  mocks.ytPlayers[0].triggerState(1);
  assert.equal(p._autoplayTimerId, null, "PLAYING state must cancel pending autoplay-muted timer");

  p.destroy();
  assert.equal(p.pollTimer, null, "destroy() must clear pollTimer");
  assert.equal(p._syncTimers.size, 0, "destroy() must clear all pending sync timers");

  // 5. Rate-limit cap prevents wire storm if a pathological embed oscillates repeatedly
  const negRate = new WatchSyncNegotiator({ localPeerId: "alice", peerStaggerMs: 0 });
  let tPerf = 1000;
  let tWall = 200_000;
  let st = {
    rev: 1,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 10000,
    rateMilli: 1000,
    anchorMs: tWall,
  };
  negRate.onSharedStateApplied(st, tPerf, { source: "local-embed", didMutate: false });
  let emittedCount = 0;
  let sawRateLimit = false;
  for (let round = 0; round < 6; round++) {
    tPerf += 2100;
    tWall += 2100;
    // Keep poll gap below TAB_WAKE_POLL_GAP_MS
    const snap = {
      provider: "soundcloud",
      ready: true,
      playing: !st.playing,
      hasPlayState: true,
      positionMs: 10000,
      hasPosition: true,
      observedAt: tPerf,
      wallNowMs: tWall,
    };
    negRate.evaluate(snap, st);
    tPerf += 333;
    tWall += 333;
    const res = negRate.evaluate({ ...snap, observedAt: tPerf, wallNowMs: tWall }, st);
    if (res.action === "negotiate") {
      emittedCount += 1;
      st = { ...st, rev: st.rev + 1, playing: res.proposal.playing, anchorMs: tWall };
      negRate.onSharedStateApplied(st, tPerf, { source: "negotiated", didMutate: false });
    } else if (res.reason === "rate-limited") {
      sawRateLimit = true;
    }
  }
  assert.equal(
    emittedCount,
    WATCH_SYNC_DEFAULTS.MAX_AUTO_NEGOTIATIONS_IN_WINDOW,
    "Auto-negotiation must cap at MAX_AUTO_NEGOTIATIONS_IN_WINDOW within sliding window"
  );
  assert.ok(sawRateLimit, "Exceeding window cap must report rate-limited");
});

test("SoundCloud remote pause -> fast local resume (<150ms) and YouTube playlist track-mismatch negotiation", async (t) => {
  const mocks = setupMockDomAndApis();
  let perf = 1000;
  let wall = 1_700_000_000_000;
  const userActions = [];
  const negotiated = [];

  const mountEl = createMockElement("div");
  let scState = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 25000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://soundcloud.com/artist/track",
    provider: "soundcloud",
    mediaId: "https://soundcloud.com/artist/track",
    anchorMs: wall,
  };

  const player = new WatchTogetherPlayer(mountEl, {
    perfNow: () => perf,
    wallNow: () => wall,
    peerStaggerMs: 0,
    onUserAction: (ev) => {
      userActions.push(ev);
      scState = {
        ...scState,
        rev: scState.rev + 1,
        playing: ev.playing,
        positionMs: ev.positionMs,
        playlistIndex: ev.playlistIndex ?? scState.playlistIndex,
        anchorMs: wall,
      };
      player.applyState(scState, wall, { source: "local-embed" });
    },
    onNegotiateState: (ev) => {
      negotiated.push(ev);
      scState = {
        ...scState,
        rev: scState.rev + 1,
        playing: ev.playing,
        positionMs: ev.positionMs,
        playlistIndex: ev.playlistIndex ?? scState.playlistIndex,
        trackUri: ev.trackUri ?? scState.trackUri,
        anchorMs: wall,
      };
      player.applyState(scState, wall, { source: "negotiated" });
    },
  });
  t.after(() => player.destroy());

  await player.applyState(scState, wall, { source: "remote" });
  const sc = mocks.scWidgets[0];
  sc.paused = false;
  sc.positionMs = 25000;
  sc.emit("ready");
  sc.emit("play", { currentPosition: 25000 });
  perf += 2500;
  wall += 2500;
  sc.positionMs = 27500;

  // Bob sends remote Pause -> SoundCloud pauses -> echoes PAUSE at +30ms (suppressed) -> Alice resumes at +130ms (MUST SYNC!)
  const remotePause = {
    ...scState,
    rev: scState.rev + 1,
    actor: "bob",
    playing: false,
    positionMs: 27500,
    anchorMs: wall,
  };
  scState = remotePause;
  await player.applyState(remotePause, wall, { source: "remote" });

  perf += 30;
  wall += 30;
  sc.emit("pause", { currentPosition: 27500 });
  assert.equal(userActions.length, 0, "Remote pause echo on SoundCloud must be suppressed");

  perf += 100;
  wall += 100;
  sc.paused = false;
  sc.emit("play", { currentPosition: 27520 });
  assert.equal(userActions.length, 1, "Fast SoundCloud resume 130ms after remote pause must sync");
  assert.equal(userActions[0].playing, true);

  // Switch to YouTube playlist and verify silent playlist index mismatch is negotiated via 3 Hz polling
  scState = {
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
    trackUri: "vidA",
    anchorMs: wall,
  };
  await player.applyState(scState, wall, { source: "remote" });
  const yt = mocks.ytPlayers[0];
  yt.state = 1;
  yt.currentTimeSec = 0;
  yt.triggerReady();
  for (let i = 0; i < 8; i++) {
    perf += 333;
    wall += 333;
    yt.currentTimeSec += 0.333;
    player._pollPlayerStateOnce();
  }
  assert.equal(negotiated.length, 0);

  // Player silently switches to playlist index 2 ("vidC") without onStateChange firing!
  yt.playlistIndex = 2;
  yt.currentTimeSec = 0.5;
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  perf += 333;
  wall += 333;
  yt.currentTimeSec = 0.833;
  player._pollPlayerStateOnce();
  assert.equal(negotiated.length, 1, "3 Hz polling must negotiate silent playlist track mismatch");
  assert.equal(negotiated[0].playlistIndex, 2);
  assert.equal(negotiated[0].trackUri, "vidC");
  assert.match(negotiated[0].reason, /track-mismatch/);
});

test("Autoplay-blocked late joiner at 45s (end-to-end WatchTogetherPlayer) seeks initially and NEVER pauses the room", async (t) => {
  const mocks = setupMockDomAndApis();
  let perf = 1000;
  let wall = 1_700_000_000_000;
  const negotiated = [];
  const userActions = [];

  const mountEl = createMockElement("div");
  const roomState = {
    targetId: "watch",
    kind: "watch",
    rev: 7,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 45000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://soundcloud.com/artist/track",
    provider: "soundcloud",
    mediaId: "https://soundcloud.com/artist/track",
    anchorMs: wall,
  };

  const player = new WatchTogetherPlayer(mountEl, {
    localPeerId: "bob",
    peerStaggerMs: 0,
    perfNow: () => perf,
    wallNow: () => wall,
    onUserAction: (ev) => userActions.push(ev),
    onNegotiateState: (ev) => negotiated.push(ev),
  });
  t.after(() => player.destroy());

  await player.applyState(roomState, wall, { source: "remote" });
  const sc = mocks.scWidgets[0];
  // Simulate browser blocking autoplay: SoundCloud widget stays paused at 0ms even when play() is called!
  sc.play = function blockedPlay() {
    this.calls.push(["play"]);
    this.paused = true;
  };
  sc.paused = true;
  sc.positionMs = 0;
  sc.emit("ready");

  // 1. Initial mount MUST issue seekTo(45000) despite _mountProvider seeding synthetic lastKnownPosMs=45000
  assert.ok(
    sc.calls.some(([fn, arg]) => fn === "seekTo" && Math.abs(arg - 45000) < 500),
    "SoundCloud initial mount for late joiner at 45s must call seekTo(45000)"
  );

  // Even if the widget stays stuck paused at 0ms (autoplay blocked), 30 consecutive 3 Hz polls (10 seconds)
  // must NEVER negotiate a room-pausing or room-rewinding state!
  sc.positionMs = 0;
  for (let i = 0; i < 30; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(negotiated.length, 0, "Autoplay-blocked late joiner must NEVER negotiate pause/rewind to room");
  assert.equal(userActions.length, 0);
});

test("Fast remote Pause -> Resume before async PAUSE arrives does NOT revert Resume (SoundCloud, YouTube, Twitch)", async (t) => {
  const mocks = setupMockDomAndApis();
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
    onUserAction: (ev) => userActions.push(ev),
    onNegotiateState: (ev) => negotiated.push(ev),
  });
  t.after(() => player.destroy());

  // --- 1. SoundCloud async postMessage race ---
  const scBase = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 20000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://soundcloud.com/artist/track",
    provider: "soundcloud",
    mediaId: "https://soundcloud.com/artist/track",
    anchorMs: wall,
  };
  await player.applyState(scBase, wall, { source: "remote" });
  const sc = mocks.scWidgets[0];
  // Model realistic async iframe FIFO queue: play()/pause() take effect asynchronously!
  const scCmdQueue = [];
  sc.play = function asyncPlay() {
    this.calls.push(["play"]);
    scCmdQueue.push(() => {
      this.paused = false;
      this.emit("play", { currentPosition: this.positionMs });
    });
  };
  sc.pause = function asyncPause() {
    this.calls.push(["pause"]);
    scCmdQueue.push(() => {
      this.paused = true;
      this.emit("pause", { currentPosition: this.positionMs });
    });
  };
  sc.paused = false;
  sc.positionMs = 20000;
  sc.emit("ready");
  while (scCmdQueue.length) scCmdQueue.shift()();
  for (let i = 0; i < 6; i++) {
    perf += 333;
    wall += 333;
    sc.positionMs += 333;
    player._pollPlayerStateOnce();
  }
  sc.calls.length = 0;

  // Remote Pause (rev=2) arrives -> queues async pause(); lastKnownPlaying is STILL true!
  await player.applyState({ ...scBase, rev: 2, playing: false, positionMs: sc.positionMs, anchorMs: wall }, wall, {
    source: "remote",
  });
  assert.deepEqual(sc.calls, [["pause"]]);

  // 40ms later, BEFORE rev=2's async PAUSE fires, Remote Resume (rev=3) arrives!
  perf += 40;
  wall += 40;
  await player.applyState({ ...scBase, rev: 3, playing: true, positionMs: sc.positionMs, anchorMs: wall }, wall, {
    source: "remote",
  });
  assert.deepEqual(
    sc.calls,
    [["pause"], ["play"]],
    "SoundCloud must issue play() even though lastKnownPlaying is still true while rev=2 pause is in flight"
  );

  // 20ms later, rev=2's delayed PAUSE executes, followed 15ms later by rev=3's PLAY
  perf += 20;
  wall += 20;
  scCmdQueue.shift()(); // delayed PAUSE from rev=2
  perf += 15;
  wall += 15;
  scCmdQueue.shift()(); // PLAY from rev=3

  // Poll for 4 seconds: Bob must stay playing and emit ZERO reverting actions/negotiations!
  for (let i = 0; i < 12; i++) {
    perf += 333;
    wall += 333;
    if (!sc.paused) sc.positionMs += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(sc.paused, false, "SoundCloud must end up playing after rapid remote Pause -> Resume");
  assert.equal(userActions.length, 0, "Delayed remote PAUSE must not re-broadcast user action");
  assert.equal(negotiated.length, 0, "3 Hz polling must not revert rapid remote Resume");

  // --- 2. SoundCloud remote PAUSE cancels pre-remote in-flight local PLAY getCurrentSoundIndex callback ---
  const scPlState = {
    targetId: "watch",
    kind: "watch",
    rev: 10,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 5000,
    rateMilli: 1000,
    epoch: 2,
    url: "https://soundcloud.com/artist/sets/race-set",
    provider: "soundcloud",
    mediaId: "https://soundcloud.com/artist/sets/race-set",
    playlistId: "https://soundcloud.com/artist/sets/race-set",
    playlistIndex: 0,
    anchorMs: wall,
  };
  await player.applyState(scPlState, wall, { source: "remote" });
  const scPl = mocks.scWidgets[1];
  scPl.sounds = [
    { id: 201, title: "A", user: { username: "U" }, duration: 100000 },
    { id: 202, title: "B", user: { username: "U" }, duration: 100000 },
  ];
  scPl.emit("ready");
  perf += 3000;
  wall += 3000;
  scPl.asyncDelay = true;
  scPl.paused = false;
  scPl.emit("play", { currentPosition: 6000 }); // queues async getCurrentSoundIndex
  // Remote PAUSE arrives BEFORE getCurrentSoundIndex returns!
  await player.applyState({ ...scPlState, rev: 11, playing: false, positionMs: 6000, anchorMs: wall }, wall, {
    source: "remote",
  });
  scPl.flushCallbacks(); // late pre-remote PLAY callback MUST be discarded!
  assert.equal(userActions.length, 0, "Remote apply must cancel stale pre-remote SoundCloud getCurrentSoundIndex callback");

  // --- 3. YouTube async Pause -> Resume race ---
  const ytBase = {
    targetId: "watch",
    kind: "watch",
    rev: 20,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 15000,
    rateMilli: 1000,
    epoch: 3,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    provider: "youtube",
    mediaId: "dQw4w9WgXcQ",
    anchorMs: wall,
  };
  await player.applyState(ytBase, wall, { source: "remote" });
  const yt = mocks.ytPlayers[0];
  const ytQueue = [];
  yt.playVideo = function asyncYtPlay() {
    this.calls.push(["playVideo"]);
    ytQueue.push(() => this.triggerState(1));
  };
  yt.pauseVideo = function asyncYtPause() {
    this.calls.push(["pauseVideo"]);
    ytQueue.push(() => this.triggerState(2));
  };
  yt.state = 1;
  yt.currentTimeSec = 15;
  yt.triggerReady();
  while (ytQueue.length) ytQueue.shift()();
  for (let i = 0; i < 6; i++) {
    perf += 333;
    wall += 333;
    yt.currentTimeSec += 0.333;
    player._pollPlayerStateOnce();
  }
  yt.calls.length = 0;

  await player.applyState({ ...ytBase, rev: 21, playing: false, positionMs: Math.round(yt.currentTimeSec * 1000), anchorMs: wall }, wall, {
    source: "remote",
  });
  perf += 40;
  wall += 40;
  await player.applyState({ ...ytBase, rev: 22, playing: true, positionMs: Math.round(yt.currentTimeSec * 1000), anchorMs: wall }, wall, {
    source: "remote",
  });
  assert.deepEqual(yt.calls, [["pauseVideo"], ["playVideo"]]);
  perf += 20;
  wall += 20;
  ytQueue.shift()(); // delayed PAUSED (2)
  perf += 15;
  wall += 15;
  ytQueue.shift()(); // PLAYING (1)
  for (let i = 0; i < 10; i++) {
    perf += 333;
    wall += 333;
    if (yt.state === 1) yt.currentTimeSec += 0.333;
    player._pollPlayerStateOnce();
  }
  assert.equal(yt.state, 1, "YouTube must stay playing after rapid remote Pause -> Resume");
  assert.equal(userActions.length, 0);
  assert.equal(negotiated.length, 0);

  // --- 4. Twitch async Pause -> Resume race ---
  const twBase = {
    targetId: "watch",
    kind: "watch",
    rev: 30,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 12000,
    rateMilli: 1000,
    epoch: 4,
    url: "https://www.twitch.tv/videos/12345678",
    provider: "twitch",
    mediaId: "video:12345678",
    anchorMs: wall,
  };
  await player.applyState(twBase, wall, { source: "remote" });
  const tw = mocks.twitchPlayers[0];
  const twQueue = [];
  tw.play = function asyncTwPlay() {
    this.calls.push(["play"]);
    twQueue.push(() => {
      this.paused = false;
      this.emit("play");
    });
  };
  tw.pause = function asyncTwPause() {
    this.calls.push(["pause"]);
    twQueue.push(() => {
      this.paused = true;
      this.emit("pause");
    });
  };
  tw.paused = false;
  tw.currentTimeSec = 12;
  tw.emit("ready");
  while (twQueue.length) twQueue.shift()();
  for (let i = 0; i < 6; i++) {
    perf += 333;
    wall += 333;
    tw.currentTimeSec += 0.333;
    player._pollPlayerStateOnce();
  }
  tw.calls.length = 0;

  await player.applyState({ ...twBase, rev: 31, playing: false, positionMs: Math.round(tw.currentTimeSec * 1000), anchorMs: wall }, wall, {
    source: "remote",
  });
  perf += 40;
  wall += 40;
  await player.applyState({ ...twBase, rev: 32, playing: true, positionMs: Math.round(tw.currentTimeSec * 1000), anchorMs: wall }, wall, {
    source: "remote",
  });
  assert.deepEqual(tw.calls, [["pause"], ["play"]]);
  perf += 20;
  wall += 20;
  twQueue.shift()(); // delayed PAUSE
  perf += 15;
  wall += 15;
  twQueue.shift()(); // PLAY
  for (let i = 0; i < 10; i++) {
    perf += 333;
    wall += 333;
    if (!tw.paused) tw.currentTimeSec += 0.333;
    player._pollPlayerStateOnce();
  }
  assert.equal(tw.paused, false, "Twitch must stay playing after rapid remote Pause -> Resume");
  assert.equal(userActions.length, 0);
  assert.equal(negotiated.length, 0);
});

test("Spotify showSpotifyPlaylistView() does NOT trigger 3 Hz pause negotiation while browsing", async (t) => {
  const mocks = setupMockDomAndApis();
  let perf = 1000;
  let wall = 1_700_000_000_000;
  const negotiated = [];

  const mountEl = createMockElement("div");
  const spPlaylistState = {
    targetId: "watch",
    kind: "watch",
    rev: 1,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 12000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    provider: "spotify",
    mediaId: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
    playlistId: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
    trackUri: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
    anchorMs: wall,
  };

  const player = new WatchTogetherPlayer(mountEl, {
    localPeerId: "bob",
    peerStaggerMs: 0,
    perfNow: () => perf,
    wallNow: () => wall,
    onNegotiateState: (ev) => negotiated.push(ev),
  });
  t.after(() => player.destroy());

  await player.applyState(spPlaylistState, wall, { source: "remote" });
  const sp = mocks.spotifyCtrls[0];
  sp.emit("ready");
  sp.emit("playback_update", {
    data: {
      position: 12000,
      duration: 210000,
      isPaused: false,
      playingURI: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
    },
  });
  for (let i = 0; i < 8; i++) {
    perf += 333;
    wall += 333;
    player.lastKnownPosMs += 333;
    player._pollPlayerStateOnce();
  }

  // User clicks "Show Playlist" locally -> embed loads playlist view in paused state at 0ms
  assert.equal(player.showSpotifyPlaylistView(), true);
  sp.emit("playback_update", {
    data: {
      position: 0,
      duration: 210000,
      isPaused: true,
      playingURI: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
    },
  });

  // Poll for 6 seconds while user browses the playlist — MUST NOT pause the room!
  for (let i = 0; i < 18; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(
    negotiated.length,
    0,
    "Browsing Spotify playlist via showSpotifyPlaylistView() must NEVER negotiate a pause for the room"
  );
});

test("Autoplay-blocked mid-track reloadSpotifySession() with 3 Hz polling emits zero onUserAction and zero onNegotiateState", async (t) => {
  const mocks = setupMockDomAndApis();
  let perf = 1000;
  let wall = 1_700_000_000_000;
  const userActions = [];
  const negotiated = [];

  const mountEl = createMockElement("div");
  const roomState = {
    targetId: "watch",
    kind: "watch",
    rev: 5,
    actor: "alice",
    active: true,
    playing: true,
    positionMs: 42000,
    rateMilli: 1000,
    epoch: 1,
    url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    provider: "spotify",
    mediaId: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
    anchorMs: wall,
  };

  const player = new WatchTogetherPlayer(mountEl, {
    localPeerId: "bob",
    peerStaggerMs: 0,
    perfNow: () => perf,
    wallNow: () => wall,
    onUserAction: (ev) => userActions.push(ev),
    onNegotiateState: (ev) => negotiated.push(ev),
  });
  t.after(() => player.destroy());

  // 1. Initial Spotify track playing & converged at 42s
  await player.applyState(roomState, wall, { source: "remote" });
  const sp1 = mocks.spotifyCtrls[0];
  sp1.emit("ready");
  sp1.emit("playback_update", {
    data: {
      position: 42000,
      duration: 213573,
      isPaused: false,
      isBuffering: false,
      playingURI: roomState.mediaId,
    },
  });
  for (let i = 0; i < 8; i++) {
    perf += 333;
    wall += 333;
    player.lastKnownPosMs += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(userActions.length, 0);
  assert.equal(negotiated.length, 0);

  // 2. User triggers local reloadSpotifySession() mid-track while room is playing; browser blocks autoplay!
  await player.reloadSpotifySession();
  const sp2 = mocks.spotifyCtrls[1];
  sp2.emit("ready");

  // During the 2500ms suppress window: iframe reports paused@0 then paused@44664
  perf += 200;
  wall += 200;
  sp2.emit("playback_update", {
    data: {
      position: 0,
      duration: 213573,
      isPaused: true,
      isBuffering: false,
      playingURI: roomState.mediaId,
    },
  });
  // After suppress window expires: iframe settles paused@44864 (still autoplay-blocked!)
  perf += 2500;
  wall += 2500;
  sp2.emit("playback_update", {
    data: {
      position: 44864,
      duration: 213573,
      isPaused: true,
      isBuffering: false,
      playingURI: roomState.mediaId,
    },
  });

  // Run 30 consecutive 3 Hz polls (10 full seconds) while autoplay stays blocked -> ZERO broadcasts!
  for (let i = 0; i < 30; i++) {
    perf += 333;
    wall += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(
    userActions.length,
    0,
    "Autoplay-blocked mid-track reloadSpotifySession() must emit zero onUserAction"
  );
  assert.equal(
    negotiated.length,
    0,
    "Autoplay-blocked mid-track reloadSpotifySession() must emit zero onNegotiateState during 3 Hz polling"
  );

  // 3. User manually clicks Play inside the reloaded Spotify embed -> joins room cleanly, then a silent pause IS caught by 3 Hz polling
  const livePos = projectMediaPositionMs(roomState, wall);
  sp2.emit("playback_update", {
    data: {
      position: livePos,
      duration: 213573,
      isPaused: false,
      isBuffering: false,
      playingURI: roomState.mediaId,
    },
  });
  for (let i = 0; i < 3; i++) {
    perf += 333;
    wall += 333;
    player.lastKnownPosMs += 333;
    player._pollPlayerStateOnce();
  }
  assert.equal(userActions.length, 0, "Catching up to already-playing room emits no redundant action");
  assert.equal(negotiated.length, 0);

  // Now simulate a dropped pause after converging -> 3 Hz polling MUST negotiate pause
  player.lastKnownPlaying = false;
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  perf += 333;
  wall += 333;
  player._pollPlayerStateOnce();
  assert.equal(negotiated.length, 1, "After converging post-reload, genuine diverged pause must negotiate");
  assert.equal(negotiated[0].playing, false);
});

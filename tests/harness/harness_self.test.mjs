/**
 * Fast end-to-end self-test suite for Layer 1 & Layer 2 deterministic harness primitives:
 * - Xoshiro128** PRNG
 * - Discrete-event VirtualClock (ordering, microtask draining, skew/drift, tab-sleep deferral)
 * - Real-WASM (`p2p_mesh.wasm`) SimulatedNetwork (full-mesh, multi-hop, RTT/2, drop/dup/reorder,
 *   partition/heal, late joiner Hello media snapshot, E2EE Wire Auditor)
 * - Realistic async FakeProviderAdapters (YouTube, SoundCloud, Spotify, Twitch)
 * - Universal 6 invariant checkers, TimelineLog, and Zeller's `ddmin` shrinker
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  WatchSyncNegotiator,
  WatchTogetherPlayer,
  projectMediaPositionMs,
} from "../../watch_together.js";

import { createPrng } from "./prng.mjs";
import { VirtualClock } from "./virtual_clock.mjs";
import { E2EEWireAuditor, SimulatedNetwork } from "./sim_network.mjs";
import { createFakeSdkLoaders, createMockDocument } from "./fake_providers/base_adapter.mjs";
import { FakeYouTubeAdapter, YT_STATE } from "./fake_providers/youtube_adapter.mjs";
import { FakeSoundCloudAdapter, SC_EVENTS } from "./fake_providers/soundcloud_adapter.mjs";
import { FakeSpotifyAdapter } from "./fake_providers/spotify_adapter.mjs";
import { FakeTwitchAdapter, TWITCH_EVENTS } from "./fake_providers/twitch_adapter.mjs";
import {
  TimelineLog,
  assertAllInvariants,
  checkBoundedConvergence,
  checkFaultIsolation,
  checkLocalOnlyPrivacy,
  checkTimerHygiene,
  checkUserIntentPreservation,
  checkZeroOscillationAndWireCap,
  ddmin,
  formatReproDump,
} from "./invariants.mjs";

/* ==================== 1. PRNG ==================== */

test("prng: deterministic Xoshiro128** across numeric & hex seeds and all helpers", () => {
  const a1 = createPrng(42);
  const a2 = createPrng(42);
  const h1 = createPrng("0xdeadbeef");
  const h2 = createPrng("DEADBEEF");
  const b1 = createPrng(43);

  const seqA1 = Array.from({ length: 16 }, () => a1.next());
  const seqA2 = Array.from({ length: 16 }, () => a2.next());
  const seqB1 = Array.from({ length: 16 }, () => b1.next());
  assert.deepEqual(seqA1, seqA2);
  assert.notDeepEqual(seqA1, seqB1);
  assert.deepEqual(
    Array.from({ length: 8 }, () => h1.nextUint32()),
    Array.from({ length: 8 }, () => h2.nextUint32())
  );

  for (let i = 0; i < 200; i++) {
    const v = a1.next();
    assert.ok(v >= 0 && v < 1);
    const k = a1.int(-5, 7);
    assert.ok(Number.isInteger(k) && k >= -5 && k <= 7);
    const f = a1.float(1.5, 4.5);
    assert.ok(f >= 1.5 && f < 4.5);
    const j = a1.jitter(100, 30);
    assert.ok(j >= 70 && j <= 130);
  }

  assert.equal(a1.chance(0), false);
  assert.equal(a1.chance(1), true);

  const src = [1, 2, 3, 4, 5, 6];
  const shuf = a1.shuffle(src);
  assert.deepEqual(src, [1, 2, 3, 4, 5, 6], "shuffle must not mutate input array");
  assert.deepEqual(shuf.slice().sort((x, y) => x - y), src);
  assert.ok(src.includes(a1.pick(src)));

  const counts = { heavy: 0, light: 0 };
  for (let i = 0; i < 500; i++) {
    const picked = a1.weighted([
      { value: "heavy", weight: 9 },
      { value: "light", weight: 1 },
    ]);
    counts[picked] += 1;
  }
  assert.ok(counts.heavy > counts.light * 3);

  const bytes1 = createPrng("0xcafe").bytes(32);
  const bytes2 = createPrng("0xcafe").bytes(32);
  assert.equal(bytes1.length, 32);
  assert.deepEqual(bytes1, bytes2);

  const fork1 = createPrng(99).fork("peer-a");
  const fork2 = createPrng(99).fork("peer-b");
  assert.notEqual(fork1.nextUint32(), fork2.nextUint32());
});

/* ==================== 2. VirtualClock ==================== */

test("virtual_clock: strict (fireAtBaseMs, seq) ordering, microtask draining, skew/drift, and tab-sleep deferral", async () => {
  const clock = new VirtualClock({ startWallMs: 1_700_000_000_000 });
  const order = [];

  clock.setTimeout(() => {
    order.push("t10-a");
    Promise.resolve().then(() => order.push("t10-a-micro"));
  }, 10);
  clock.setTimeout(() => order.push("t10-b"), 10);
  clock.setTimeout(() => order.push("t5"), 5);

  await clock.advanceBy(20);
  assert.deepEqual(order, ["t5", "t10-a", "t10-a-micro", "t10-b"]);

  // Per-peer skew + ppm drift + tab-sleep throttling triggering WatchSyncNegotiator tab-wake-resync!
  const peerA = clock.forPeer("alice", {
    wallSkewMs: 30_000,
    clockDriftPpm: 1000, // +0.1% faster
    sleepWindows: [{ startMs: 1000, endMs: 5000 }],
  });

  assert.equal(peerA.wallNow() - clock.wallNow(), 30_000);
  const neg = new WatchSyncNegotiator({ localPeerId: "alice" });
  const shared = {
    active: true,
    playing: true,
    rev: 1,
    positionMs: 10_000,
    rateMilli: 1000,
    anchorMs: peerA.wallNow(),
  };

  const pollTimes = [];
  const decisions = [];
  const pollId = peerA.setInterval(() => {
    const nowPerf = peerA.perfNow();
    pollTimes.push(Math.round(nowPerf));
    // Simulate frozen local position during sleep so wake-up diverges drastically
    const posMs = clock.nowBaseMs >= 5000 ? 10_000 : projectMediaPositionMs(shared, peerA.wallNow());
    const dec = neg.evaluate(
      {
        provider: "youtube",
        ready: true,
        playing: true,
        hasPlayState: true,
        positionMs: posMs,
        hasPosition: true,
        durationMs: 240_000,
        rateMilli: 1000,
        hasRate: true,
        observedAt: nowPerf,
        wallNowMs: peerA.wallNow(),
      },
      shared
    );
    decisions.push(dec);
  }, 333);

  await clock.advanceTo(900);
  assert.equal(peerA.isSleeping(), false);
  const pollsBeforeSleep = pollTimes.length;
  assert.ok(pollsBeforeSleep >= 2);

  await clock.advanceTo(3000);
  assert.equal(peerA.isSleeping(), true);
  assert.equal(pollTimes.length, pollsBeforeSleep, "Zero peer timers may fire during sleep window");

  await clock.advanceTo(5100);
  assert.equal(peerA.isSleeping(), false);
  // Single wake tick at t=5000 (not a storm of 12 missed ticks!)
  assert.equal(pollTimes.length, pollsBeforeSleep + 1);
  const wakeGap = pollTimes[pollTimes.length - 1] - pollTimes[pollTimes.length - 2];
  assert.ok(wakeGap > 2500, `Expected wake pollGap > 2500ms, got ${wakeGap}ms`);
  assert.equal(decisions[decisions.length - 1].action, "resync-local");
  assert.equal(decisions[decisions.length - 1].reason, "tab-wake-resync");

  peerA.clearInterval(pollId);
  assert.equal(peerA.activeTimerCount(), 0);
  assert.equal(clock.activeTimerCount(), 0);
});

/* ==================== 3. SimulatedNetwork (Real p2p_mesh.wasm) ==================== */

test("sim_network: real p2p_mesh.wasm full-mesh, multi-hop gossip, RTT/2 compensation, partition/heal, late joiner, and E2EE audit", async () => {
  const clock = new VirtualClock();
  const prng = createPrng("0x1234abcd");
  const timeline = new TimelineLog();
  const net = new SimulatedNetwork({ clock, prng, timeline, autoMeshEnabled: false });

  // Multi-hop chain A -- B -- C with skewed wall clocks!
  await net.addPeer("alice", { authorName: "Alice", wallSkewMs: 45_000 });
  await net.addPeer("bob", { authorName: "Bob", wallSkewMs: -30_000 });
  await net.addPeer("carol", { authorName: "Carol", wallSkewMs: 12_000 });

  net.setLink("alice", "bob", { latencyMs: 60, jitterMs: 0 });
  net.setLink("bob", "alice", { latencyMs: 80, jitterMs: 0 });
  net.setLink("bob", "carol", { latencyMs: 50, jitterMs: 0, bidirectional: true });

  net.connectChain(["alice", "bob", "carol"]);
  await clock.runUntilIdle(2000);

  // Exercise real keepalive Ping/Pong so src/mesh.rs records exact RTT (60 + 80 = 140ms)
  net.sendKeepalivePings();
  await clock.runUntilIdle(2000);

  assert.equal(net.getPeerRttMs("alice", "bob"), 140);
  assert.equal(net.getPeerRttMs("bob", "alice"), 140);
  assert.equal(net.getPeerRttMs("bob", "carol"), 100);

  // Alice publishes playing Watch Together state -> gossips A -> B -> C with RTT/2 compensation!
  const watchUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  net.publishMediaSync("alice", {
    targetId: "watch",
    kind: "watch",
    active: true,
    playing: true,
    positionMs: 10_000,
    rateMilli: 1000,
    url: watchUrl,
    provider: "youtube",
    mediaId: "dQw4w9WgXcQ",
    title: "Secret Room Video Title",
  });
  await clock.runUntilIdle(2000);

  const stA = net.getMediaSyncState("alice", "watch");
  const stB = net.getMediaSyncState("bob", "watch");
  const stC = net.getMediaSyncState("carol", "watch");
  assert.ok(stA && stB && stC, "All 3 peers across multi-hop chain must receive MediaSync");
  assert.equal(stB.rev, stA.rev);
  assert.equal(stC.rev, stA.rev);
  assert.equal(stC.actor, "alice");
  assert.equal(stC.mediaId, "dQw4w9WgXcQ");
  // Projected positions across 75-second wall clock skew must agree closely thanks to RTT/2!
  assert.ok(
    Math.abs(stA.positionMs - stB.positionMs) <= 40,
    `Expected RTT/2-compensated A/B position diff <= 40ms, got ${Math.abs(stA.positionMs - stB.positionMs)}ms`
  );
  assert.ok(
    Math.abs(stA.positionMs - stC.positionMs) <= 60,
    `Expected RTT/2-compensated A/C position diff <= 60ms, got ${Math.abs(stA.positionMs - stC.positionMs)}ms`
  );

  // Partition Carol away, Alice updates rev -> Bob gets it, Carol misses it; heal + new update converges all!
  net.partition(["alice", "bob"], ["carol"]);
  net.publishMediaSync("alice", {
    ...stA,
    positionMs: 42_000,
    playing: false,
  });
  await clock.runUntilIdle(1000);
  assert.equal(net.getMediaSyncState("bob", "watch").positionMs, 42_000);
  assert.equal(net.getMediaSyncState("carol", "watch").rev, stA.rev, "Partitioned Carol stays on old rev");

  net.healAll();
  net.publishMediaSync("bob", {
    ...net.getMediaSyncState("bob", "watch"),
    playing: true,
    positionMs: 45_000,
  });
  await clock.runUntilIdle(1000);
  assert.equal(net.getMediaSyncState("carol", "watch").rev, net.getMediaSyncState("bob", "watch").rev);
  assert.equal(net.getMediaSyncState("carol", "watch").playing, true);

  // Late joiner Dave connects to Bob -> receives active Watch Together state via real E2EE Hello snapshot!
  await clock.advanceBy(2000);
  await net.addPeer("dave", { authorName: "Dave", wallSkewMs: -10_000 });
  net.connect("bob", "dave", { latencyMs: 30, jitterMs: 0 });
  await clock.runUntilIdle(1000);

  const stD = net.getMediaSyncState("dave", "watch");
  const stBNow = net.getMediaSyncState("bob", "watch");
  assert.ok(stD, "Late joiner Dave must receive Hello media snapshot");
  assert.equal(stD.rev, stBNow.rev);
  assert.equal(stD.mediaId, "dQw4w9WgXcQ");
  assert.ok(
    Math.abs(stD.positionMs - stBNow.positionMs) <= 100,
    `Late joiner Dave position (${stD.positionMs}) must align with Bob (${stBNow.positionMs})`
  );

  // Test duplicate & reorder resilience (anti-replay rejects duplicates without throwing!)
  net.setLink("alice", "bob", { latencyMs: 20, jitterMs: 5, dupProb: 1, reorderProb: 0.5 });
  net.publishMediaSync("alice", {
    ...net.getMediaSyncState("alice", "watch"),
    positionMs: 60_000,
  });
  await clock.runUntilIdle(1000);
  assert.ok(net.getPeer("bob").stats.replayRejections >= 1, "Anti-replay must gracefully reject duplicates");
  assert.equal(net.getMediaSyncState("bob", "watch").rev, net.getMediaSyncState("alice", "watch").rev);

  // Disconnect & reconnect Alice <-> Bob cleanly (dropping in-flight stale frames from old session)
  net.setLink("alice", "bob", { latencyMs: 40, jitterMs: 0, dupProb: 0, reorderProb: 0, bidirectional: true });
  net.disconnect("alice", "bob");
  assert.equal(net.isConnected("alice", "bob"), false);
  net.connect("alice", "bob");
  await clock.runUntilIdle(1000);
  assert.equal(net.isConnected("alice", "bob"), true);
  net.publishMediaSync("alice", {
    ...net.getMediaSyncState("alice", "watch"),
    positionMs: 75_000,
  });
  await clock.runUntilIdle(1000);
  assert.equal(net.getMediaSyncState("bob", "watch").rev, net.getMediaSyncState("alice", "watch").rev);

  // Wire auditor verified every real WASM wire frame with zero violations
  const counters = net.getWireCounters();
  assert.ok(counters.auditedCount >= 10);
  assert.equal(counters.auditViolations, 0);

  net.destroy();
  assert.equal(clock.activeTimerCount(), 0);
});

test("sim_network: E2EEWireAuditor rejects plaintext URLs, volume/mute keys, and non-e2ee frames", () => {
  const auditor = new E2EEWireAuditor({ throwOnViolation: false });
  assert.equal(
    auditor.audit(JSON.stringify({ kind: "media_sync", url: "https://youtube.com/watch?v=dQw4w9WgXcQ" })),
    false
  );
  assert.equal(
    auditor.audit(JSON.stringify({ kind: "e2ee", v: 1, s: 1, n: "aaaaaaaaaaaa", c: "https://youtube.com/watch?v=abc" })),
    false
  );
  assert.equal(
    auditor.audit(JSON.stringify({ kind: "e2ee", v: 1, s: 1, n: "aaaaaaaaaaaa", c: "aaaaaaaaaaaaaaaa", volume: 50 })),
    false
  );
  assert.equal(auditor.violations.length, 3);
  assert.equal(
    auditor.audit(JSON.stringify({ kind: "e2ee", v: 1, s: 1, n: "abcdefghijkl", c: "0123456789abcdef0123456789" })),
    true
  );
});

/* ==================== 4. FakeProviderAdapters ==================== */

test("fake_providers: YouTube async commands, pre-BUFFERING jump, silent seeks, drag-scrub, autoplay block, error/recovery, physics", async () => {
  const clock = new VirtualClock();
  const prng = createPrng(77);
  const yt = new FakeYouTubeAdapter({
    clock,
    prng,
    peerId: "p1",
    config: {
      cmdLatencyMs: 50,
      cmdLatencyJitterMs: 0,
      bufferMs: 120,
      keyframeSnapMs: 500,
      localDriftPpm: 0,
      autoplayBlocked: true,
    },
  });

  const loaders = createFakeSdkLoaders({ youtube: yt });
  const YT = await loaders.youtube();
  const events = [];
  const holder = yt.document.createElement("div");
  yt.mountEl.appendChild(holder);
  const player = new YT.Player(holder, {
    videoId: "dQw4w9WgXcQ",
    playerVars: { start: 0 },
    events: {
      onReady: () => events.push({ ev: "ready" }),
      onStateChange: (e) => events.push({ ev: "state", code: e.data, pos: Math.round(player.getCurrentTime() * 1000) }),
      onError: (e) => events.push({ ev: "error", code: e.data }),
    },
  });

  await clock.advanceBy(40);
  assert.equal(events[0].ev, "ready");

  // Autoplay blocked: unmuted playVideo() stays unstarted/cued
  player.playVideo();
  assert.equal(player.getPlayerState(), YT_STATE.CUED, "SDK command MUST be async");
  await clock.advanceBy(80);
  assert.equal(player.getPlayerState(), YT_STATE.CUED, "Autoplay block prevents unmuted playVideo");

  // Muted retry succeeds asynchronously
  player.mute();
  player.playVideo();
  assert.equal(player.getPlayerState(), YT_STATE.CUED);
  await clock.advanceBy(60);
  assert.equal(player.getPlayerState(), YT_STATE.PLAYING);

  // Continuous playhead physics
  await clock.advanceBy(2000);
  assert.ok(Math.abs(player.getCurrentTime() * 1000 - 2000) <= 20);

  // Pre-BUFFERING click-seek jump: getCurrentTime() jumps to target BEFORE onStateChange(3)!
  events.length = 0;
  yt.userClickSeek(30_240, { preBufferJump: true, bufferMs: 100 });
  assert.equal(events[0].code, YT_STATE.BUFFERING);
  assert.equal(events[0].pos, 30_000, "Keyframe snapped to 30000ms BEFORE BUFFERING event fired");
  await clock.advanceBy(120);
  assert.equal(events[1].code, YT_STATE.PLAYING);

  // Silent buffered seek (1 -> 1): zero onStateChange
  events.length = 0;
  yt.userBufferedSeek(50_000);
  assert.equal(events.length, 0);
  assert.equal(Math.round(player.getCurrentTime() * 1000), 50_000);

  // Drag scrub (2 -> 3 -> 1)
  events.length = 0;
  yt.userDragScrub(80_000, { dragMs: 200, bufferMs: 100 });
  assert.equal(events[0].code, YT_STATE.PAUSED);
  await clock.advanceBy(200);
  assert.equal(events[1].code, YT_STATE.BUFFERING);
  await clock.advanceBy(100);
  assert.equal(events[2].code, YT_STATE.PLAYING);
  assert.equal(Math.round(player.getCurrentTime() * 1000), 80_000);

  // Explicit physics advance with local clock drift ppm (+10,000 ppm = +1%)
  yt.config.localDriftPpm = 10_000;
  yt.advancePhysics(1000);
  assert.equal(Math.round(player.getCurrentTime() * 1000), 81_010);
  yt.config.localDriftPpm = 0;

  // Network rebuffer freezes playhead in place (3 -> 1 at same spot)
  events.length = 0;
  yt.injectRebuffer(500);
  assert.equal(events[0].code, YT_STATE.BUFFERING);
  await clock.advanceBy(500);
  assert.equal(events[1].code, YT_STATE.PLAYING);
  assert.equal(Math.round(player.getCurrentTime() * 1000), 81_010);

  // Rapid user toggle (Pause -> Play)
  events.length = 0;
  yt.userRapidToggle(2, 60);
  await clock.advanceBy(80);
  assert.deepEqual(
    events.map((e) => e.code),
    [YT_STATE.PAUSED, YT_STATE.PLAYING]
  );

  // Silent paused seek (2 -> 2)
  yt.userPause();
  events.length = 0;
  yt.userPausedSeek(95_000);
  assert.equal(events.length, 0);
  assert.equal(player.getPlayerState(), YT_STATE.PAUSED);
  assert.equal(Math.round(player.getCurrentTime() * 1000), 95_000);

  // Error 150 + recovery
  yt.injectError(150);
  assert.equal(events[0].ev, "error");
  assert.equal(events[0].code, 150);
  yt.recoverFromError(YT_STATE.CUED);
  assert.equal(yt.snapshot().errored, false);

  // Dropped command probability
  yt.config.dropCommandProb = 1;
  player.seekTo(120, true);
  await clock.advanceBy(200);
  assert.equal(Math.round(player.getCurrentTime() * 1000), 95_000, "Dropped seekTo must not execute");
  assert.equal(yt.getCommandLog().at(-1).dropped, true);

  yt.destroy();
  assert.equal(yt.activeTimerCount(), 0);
  assert.equal(clock.activeTimerCount(), 0);
});

test("fake_providers: SoundCloud async postMessage out-of-order queue, SNIP 30s cap (with & without full_duration), unhydrated stubs", async () => {
  const clock = new VirtualClock();
  const prng = createPrng(88);
  const sc = new FakeSoundCloudAdapter({
    clock,
    prng,
    peerId: "p-sc",
    config: {
      postMessageDelayMs: 15,
      postMessageJitterMs: 5,
      outOfOrderProb: 0.7,
      unhydratedStubs: true,
      sounds: [
        { id: 101, title: "Track 1", user: { username: "Art" }, duration: 180_000, full_duration: 180_000, policy: "ALLOW", playable: true },
        { id: 102, title: "Track 2", user: { username: "Art" }, duration: 200_000, full_duration: 200_000, policy: "ALLOW", playable: true },
      ],
    },
  });

  const SC = await sc.sdkLoader()();
  const iframe = sc.document.createElement("iframe");
  iframe.src = "https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb&start_track=0";
  const widget = SC.Widget(iframe);
  const evs = [];
  widget.bind(SC_EVENTS.READY, () => evs.push("ready"));
  widget.bind(SC_EVENTS.PAUSE, (p) => evs.push({ ev: "pause", pos: p.currentPosition }));
  widget.bind(SC_EVENTS.FINISH, () => evs.push("finish"));
  widget.bind(SC_EVENTS.ERROR, () => evs.push("error"));

  await clock.advanceBy(40);
  assert.equal(evs[0], "ready");

  // Unhydrated `{ id }` stubs for non-active playlist tracks
  let gotSounds = null;
  widget.getSounds((list) => {
    gotSounds = list;
  });
  assert.equal(gotSounds, null, "getSounds MUST resolve asynchronously via postMessage queue");
  await clock.advanceBy(150);
  assert.equal(gotSounds.length, 2);
  assert.equal(gotSounds[0].title, "Track 1");
  assert.deepEqual(gotSounds[1], { id: 102 });

  // Inject SNIP with omitted full_duration -> hitting 30s cap emits PAUSE + FINISH
  sc.injectSnip({ previewDurationMs: 30_000, omitFullDuration: true });
  assert.equal(sc.snapshot().fullDurationMs, 0);
  assert.equal(sc.snapshot().isPreview, true);
  sc.userPlay();
  sc.userClickSeek(29_500);
  evs.length = 0;
  await clock.advanceBy(1000);
  assert.ok(evs.some((e) => typeof e === "object" && e.ev === "pause" && e.pos === 30_000));
  assert.ok(evs.includes("finish"));

  sc.injectError("geo_error");
  assert.ok(evs.includes("error"));

  sc.destroy();
  assert.equal(sc.activeTimerCount(), 0);
  assert.equal(clock.activeTimerCount(), 0);
});

test("fake_providers: Spotify createController + loadUri, delayed boot, 30s preview, DRM fail/re-probe, detached playlist track", async () => {
  const clock = new VirtualClock();
  const sp = new FakeSpotifyAdapter({
    clock,
    prng: createPrng(99),
    peerId: "p-sp",
    config: {
      cmdLatencyMs: 20,
      cmdLatencyJitterMs: 0,
      delayedBootPausedMs: 150,
      updateCadenceMs: 400,
      previewMode: true,
      drmSupported: false,
    },
  });

  const env = sp.createEnv();
  assert.equal(await env.probeSpotifyDrmSupport({ force: false }), false);
  sp.setDrmSupported(true);
  assert.equal(await env.probeSpotifyDrmSupport({ force: true }), true);
  assert.equal(sp.drmProbeCount, 2);
  assert.equal(sp.lastDrmProbeForce, true);

  const IFrameAPI = await sp.sdkLoader()();
  const holder = sp.document.createElement("div");
  sp.mountEl.appendChild(holder);
  const events = [];
  let ctrl = null;
  IFrameAPI.createController(holder, { width: "100%", height: 352 }, (c) => {
    ctrl = c;
    c.addListener("ready", () => events.push({ ev: "ready" }));
    c.addListener("playback_started", (e) => events.push({ ev: "started", uri: e.data.playingURI }));
    c.addListener("playback_update", (e) => events.push({ ev: "update", ...e.data }));
    c.loadUri("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", false, 0);
  });

  await clock.advanceBy(300);
  assert.ok(ctrl);
  assert.equal(events[0].ev, "ready");
  // Delayed Harmony isPaused: true boot hydration event fired
  assert.ok(events.some((e) => e.ev === "update" && e.isPaused === true && e.duration === 29713));

  // Detached track pick inside playlist
  sp.userSelectPlaylistTrack("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
  assert.equal(sp.snapshot().isDetached, true);
  assert.ok(events.some((e) => e.ev === "started" && e.uri === "spotify:track:4cOdK2wGLETKBW3PvgPWqT"));

  // Cadence ticks advance playhead
  await clock.advanceBy(900);
  const updates = events.filter((e) => e.ev === "update" && !e.isPaused);
  assert.ok(updates.length >= 2);
  assert.ok(updates.at(-1).position >= 800);

  sp.destroy();
  assert.equal(sp.activeTimerCount(), 0);
  assert.equal(clock.activeTimerCount(), 0);
});

test("fake_providers: Twitch VOD/Live/Collection, silent seeks, PLAYBACK_BLOCKED, ONLINE/OFFLINE, setCollection lag", async () => {
  const clock = new VirtualClock();
  const tw = new FakeTwitchAdapter({
    clock,
    prng: createPrng(101),
    peerId: "p-tw",
    config: {
      cmdLatencyMs: 25,
      cmdLatencyJitterMs: 0,
      collectionSwitchLagMs: 180,
      autoplayBlocked: true,
    },
  });

  const Twitch = await tw.sdkLoader()();
  const holder = tw.document.createElement("div");
  holder.id = "tw-host-1";
  tw.mountEl.appendChild(holder);

  const events = [];
  const player = new Twitch.Player("tw-host-1", {
    collection: "col123456",
    video: "11111111",
    autoplay: false,
    muted: false,
  });
  for (const name of Object.values(TWITCH_EVENTS)) {
    player.addEventListener(name, (p) => events.push({ ev: name, payload: p }));
  }

  await clock.advanceBy(40);
  assert.equal(events[0].ev, TWITCH_EVENTS.READY);

  // Autoplay blocked -> emits PLAYBACK_BLOCKED -> muted retry succeeds
  player.play();
  await clock.advanceBy(40);
  assert.ok(events.some((e) => e.ev === TWITCH_EVENTS.PLAYBACK_BLOCKED));
  assert.equal(player.isPaused(), true);

  player.setMuted(true);
  player.play();
  await clock.advanceBy(40);
  assert.equal(player.isPaused(), false);

  // Silent buffered seek (no SEEK event!)
  events.length = 0;
  tw.userBufferedSeek(45_000);
  assert.equal(events.length, 0);
  assert.equal(Math.round(player.getCurrentTime() * 1000), 45_000);

  // setCollection lag: videoId stays old until cmdLatency + collectionSwitchLagMs elapses
  player.setCollection("col123456", "22222222");
  await clock.advanceBy(100);
  assert.equal(player.getVideo(), "11111111", "setCollection must exhibit switch lag");
  await clock.advanceBy(150);
  assert.equal(player.getVideo(), "22222222");

  // ONLINE / OFFLINE
  tw.injectOffline();
  assert.ok(events.some((e) => e.ev === TWITCH_EVENTS.OFFLINE));
  tw.injectOnline();
  assert.ok(events.some((e) => e.ev === TWITCH_EVENTS.ONLINE));

  tw.destroy();
  assert.equal(tw.activeTimerCount(), 0);
  assert.equal(clock.activeTimerCount(), 0);
});

/* ==================== 5. End-to-End Real-WASM + SimulatedNetwork + WatchTogetherPlayer + All 6 Invariants ==================== */

test("e2e self-test: 3 peers (2 healthy + 1 errored) with real p2p_mesh.wasm, SimulatedNetwork, async FakeYouTubeAdapters, and all 6 invariants", async () => {
  const clock = new VirtualClock();
  const prng = createPrng("0x5eed2026");
  const timeline = new TimelineLog();
  const net = new SimulatedNetwork({ clock, prng, timeline });

  const peerSpecs = [
    { id: "alice", wallSkewMs: 0 },
    { id: "bob", wallSkewMs: 15_000 },
    { id: "carol", wallSkewMs: -25_000 },
  ];

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevSetTimeout = globalThis.setTimeout;
  const prevClearTimeout = globalThis.clearTimeout;
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;

  const nodes = new Map();
  const userIntents = [];
  const stateSamples = [];
  const emittedEvents = [];
  const localOnlyWindows = [];

  try {
    // Route timers through VirtualClock (demonstrating zero real timer usage!)
    // Until Wave 1 Track 1 (`seams-core`) lands `options.scheduler`, bind globals temporarily per peer during mount.
    let activePeerClock = clock;
    globalThis.setTimeout = (fn, ms) => activePeerClock.setTimeout(fn, ms);
    globalThis.clearTimeout = (id) => activePeerClock.clearTimeout(id);
    globalThis.setInterval = (fn, ms) => activePeerClock.setInterval(fn, ms);
    globalThis.clearInterval = (id) => activePeerClock.clearInterval(id);

    for (const spec of peerSpecs) {
      const peer = await net.addPeer(spec.id, {
        authorName: spec.id,
        wallSkewMs: spec.wallSkewMs,
      });
      const doc = createMockDocument();
      const adapter = new FakeYouTubeAdapter({
        clock,
        prng: prng.fork(`yt:${spec.id}`),
        peerId: spec.id,
        document: doc,
        timeline,
        config: { cmdLatencyMs: 35, cmdLatencyJitterMs: 5, bufferMs: 120 },
      });
      const ytSdk = adapter.createSdk();

      const player = new WatchTogetherPlayer(adapter.mountEl, {
        localPeerId: spec.id,
        perfNow: () => peer.clock.perfNow(),
        wallNow: () => peer.clock.wallNow(),
        onUserAction: (ev) => {
          emittedEvents.push({ tBase: clock.nowBaseMs, peerId: spec.id, kind: "onUserAction", ev });
          const cur = net.getMediaSyncState(spec.id, "watch");
          if (!cur) return;
          activePeerClock = peer.clock;
          globalThis.document = doc;
          globalThis.window = { location: { origin: "https://sim.local" }, YT: ytSdk };
          net.publishMediaSync(spec.id, {
            ...cur,
            playing: Boolean(ev.playing),
            positionMs: Math.max(0, Math.round(ev.positionMs || 0)),
            rateMilli: ev.rateMilli || cur.rateMilli || 1000,
          });
        },
        onNegotiateState: (ev) => {
          emittedEvents.push({ tBase: clock.nowBaseMs, peerId: spec.id, kind: "onNegotiateState", ev });
          const cur = net.getMediaSyncState(spec.id, "watch");
          if (!cur) return;
          net.publishMediaSync(spec.id, {
            ...cur,
            playing: Boolean(ev.playing),
            positionMs: Math.max(0, Math.round(ev.positionMs || 0)),
            rateMilli: ev.rateMilli || cur.rateMilli || 1000,
          });
        },
      });

      peer.onMediaSync = (state, meta) => {
        activePeerClock = peer.clock;
        globalThis.document = doc;
        globalThis.window = { location: { origin: "https://sim.local" }, YT: ytSdk };
        player.applyState(state, peer.clock.wallNow(), {
          source: meta.isLocalOrigin ? "local-embed" : "remote",
        });
      };

      nodes.set(spec.id, { peer, doc, adapter, ytSdk, player });
    }

    net.connectFullMesh({ latencyMs: 35, jitterMs: 5 });
    await clock.runUntilIdle(1000);
    net.sendKeepalivePings();
    await clock.runUntilIdle(1000);

    // Start Watch Together from Alice
    const startWall = nodes.get("alice").peer.clock.wallNow();
    net.publishMediaSync("alice", {
      targetId: "watch",
      kind: "watch",
      active: true,
      playing: true,
      positionMs: 5_000,
      rateMilli: 1000,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
      mediaId: "dQw4w9WgXcQ",
      title: "Self Test Video",
    }, startWall);

    await clock.advanceBy(1500);

    // Inject YouTube Error 150 on Carol -> Carol must be isolated from disrupting Alice & Bob!
    const carolFaultStart = clock.nowBaseMs;
    nodes.get("carol").adapter.injectError(150);

    // Sample periodically while Alice performs a realistic pre-BUFFERING click-seek to 60s
    const recordSamples = () => {
      for (const [id, n] of nodes.entries()) {
        const snap = n.adapter.snapshot();
        stateSamples.push({
          tBase: clock.nowBaseMs,
          peerId: id,
          playing: snap.playing,
          positionMs: snap.positionMs,
          buffering: snap.buffering,
          unstarted: snap.unstarted,
          ended: snap.ended,
          errored: snap.errored,
          blocked: snap.blocked,
          provider: "youtube",
        });
      }
    };

    const seekAtBase = clock.nowBaseMs;
    userIntents.push({
      tBase: seekAtBase,
      peerId: "alice",
      playing: true,
      positionMs: 60_000,
      rateMilli: 1000,
    });
    activePeerClock = nodes.get("alice").peer.clock;
    nodes.get("alice").adapter.userClickSeek(60_000, { preBufferJump: true, bufferMs: 120 });

    for (let step = 0; step < 12; step++) {
      await clock.advanceBy(350);
      recordSamples();
    }

    // Steady-state quiescence window (3 seconds) + local-only volume/mute changes on Alice
    const steadyStart = clock.nowBaseMs;
    const volStart = clock.nowBaseMs;
    nodes.get("alice").player.setLocalVolume(25);
    nodes.get("alice").player.setLocalMuted(true);
    nodes.get("alice").player.setLocalMuted(false);
    localOnlyWindows.push({ peerId: "alice", action: "volume", startMs: volStart, endMs: volStart + 50 });

    await clock.advanceBy(3000);
    recordSamples();
    const steadyEnd = clock.nowBaseMs;

    // Evaluate Invariants 1..5 BEFORE teardown
    const inv1 = checkUserIntentPreservation({
      actions: userIntents,
      samples: stateSamples,
      healthyPeerIds: ["alice", "bob"],
      maxYankMs: 1500,
      convergenceBudgetMs: 3000,
    });
    const inv2 = checkBoundedConvergence({
      peers: ["alice", "bob", "carol"].map((id) => {
        const n = nodes.get(id);
        const snap = n.adapter.snapshot();
        return {
          peerId: id,
          provider: "youtube",
          wasmState: net.getMediaSyncState(id, "watch"),
          playerSnapshot: snap,
          wallNowMs: n.peer.clock.wallNow(),
          errored: snap.errored,
          blocked: snap.blocked,
        };
      }),
      requireActive: true,
    });
    const inv3 = checkZeroOscillationAndWireCap({
      mediaSyncWireEvents: net.getMediaSyncEvents({ sinceBaseMs: steadyStart, untilBaseMs: steadyEnd }),
      adapterCmdsByPeer: {
        alice: nodes.get("alice").adapter.getCommandLog({ sinceBaseMs: steadyStart, untilBaseMs: steadyEnd }),
        bob: nodes.get("bob").adapter.getCommandLog({ sinceBaseMs: steadyStart, untilBaseMs: steadyEnd }),
      },
      maxMediaSyncWireUpdates: 0,
      maxAdapterCmdsPerPeer: 2,
    });
    const inv4 = checkFaultIsolation({
      faultyPeers: [{ peerId: "carol", faultKind: "errored", startMs: carolFaultStart, endMs: steadyEnd }],
      events: emittedEvents,
    });
    const inv5 = checkLocalOnlyPrivacy({
      localOnlyWindows,
      wireEvents: net.getWireEvents(),
      wireAuditor: net.auditor,
    });

    // Teardown every player, adapter, and network -> verify Invariant 6 (Timer Hygiene)!
    for (const n of nodes.values()) {
      n.player.destroy();
      n.adapter.destroy();
    }
    net.destroy();

    const inv6 = checkTimerHygiene({
      clock,
      peerIds: ["alice", "bob", "carol"],
      adapters: [...nodes.values()].map((n) => n.adapter),
    });

    assertAllInvariants([inv1, inv2, inv3, inv4, inv5, inv6], timeline);
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.setTimeout = prevSetTimeout;
    globalThis.clearTimeout = prevClearTimeout;
    globalThis.setInterval = prevSetInterval;
    globalThis.clearInterval = prevClearInterval;
  }
});

/* ==================== 6. Invariant Negative Tests + ddmin Shrinker ==================== */

test("invariants: all 6 checkers accurately flag violations", () => {
  // 1. UserIntentPreservation detects yank > 1500ms & playstate inversion
  const r1 = checkUserIntentPreservation({
    actions: [{ tBase: 1000, peerId: "a", playing: true, positionMs: 50_000 }],
    samples: [{ tBase: 1500, peerId: "a", playing: true, positionMs: 20_000 }],
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.violations[0].code, "intent-position-yanked");

  // 2. BoundedConvergence detects WASM rev mismatch & playhead drift > 2200ms (and respects 3000ms Spotify tolerance)
  const r2SpotifyOk = checkBoundedConvergence({
    peers: [
      {
        peerId: "a",
        provider: "spotify",
        wallNowMs: 10_000,
        wasmState: { rev: 2, actor: "a", active: true, playing: true, mediaId: "x", positionMs: 10_000, anchorMs: 10_000, rateMilli: 1000 },
        playerSnapshot: { ready: true, playing: true, positionMs: 10_000, durationMs: 200_000 },
      },
      {
        peerId: "b",
        provider: "spotify",
        wallNowMs: 10_000,
        wasmState: { rev: 2, actor: "a", active: true, playing: true, mediaId: "x", positionMs: 10_000, anchorMs: 10_000, rateMilli: 1000 },
        playerSnapshot: { ready: true, playing: true, positionMs: 12_600, durationMs: 200_000 },
      },
    ],
  });
  assert.equal(r2SpotifyOk.ok, true, "2600ms drift is within Spotify 3000ms tolerance");

  const r2 = checkBoundedConvergence({
    peers: [
      {
        peerId: "a",
        provider: "youtube",
        wallNowMs: 10_000,
        wasmState: { rev: 2, actor: "a", active: true, playing: true, mediaId: "x", positionMs: 10_000, anchorMs: 10_000, rateMilli: 1000 },
        playerSnapshot: { ready: true, playing: true, positionMs: 10_000, durationMs: 200_000 },
      },
      {
        peerId: "b",
        provider: "youtube",
        wallNowMs: 10_000,
        wasmState: { rev: 1, actor: "a", active: true, playing: true, mediaId: "x", positionMs: 10_000, anchorMs: 10_000, rateMilli: 1000 },
        playerSnapshot: { ready: true, playing: true, positionMs: 15_000, durationMs: 200_000 },
      },
    ],
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.violations.some((v) => v.code === "wasm-state-field-mismatch"));
  assert.ok(r2.violations.some((v) => v.code === "player-position-drift"));

  // 3. ZeroOscillationAndWireCap detects wire & adapter command churn
  const r3 = checkZeroOscillationAndWireCap({
    mediaSyncWireCount: 2,
    adapterCmdsByPeer: { a: 3, b: 1 },
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.violations.length, 2);

  // 4. FaultIsolation detects errored/sleeping peer emitting onNegotiateState
  const r4 = checkFaultIsolation({
    faultyPeers: [{ peerId: "c", faultKind: "sleeping", startMs: 1000, endMs: 5000 }],
    events: [{ tBase: 2500, peerId: "c", kind: "onNegotiateState" }],
  });
  assert.equal(r4.ok, false);
  assert.equal(r4.violations[0].code, "faulty-peer-disrupted-room");

  // 5. LocalOnlyPrivacy detects wire emission during volume change
  const r5 = checkLocalOnlyPrivacy({
    localOnlyWindows: [{ peerId: "a", action: "volume", startMs: 100, endMs: 200 }],
    wireEvents: [{ tBase: 150, fromPeerId: "a", toPeerId: "b", isKeepalive: false }],
  });
  assert.equal(r5.ok, false);
  assert.equal(r5.violations[0].code, "local-only-emitted-wire");

  // 6. TimerHygiene detects leaked virtual timer
  const leakyClock = new VirtualClock();
  const p = leakyClock.forPeer("a");
  p.setInterval(() => {}, 333);
  const r6 = checkTimerHygiene({ clock: leakyClock, peerIds: ["a"] });
  assert.equal(r6.ok, false);
  assert.ok(r6.violations.some((v) => v.code === "leaked-peer-timers"));
  leakyClock.clearAllTimers();
  assert.equal(checkTimerHygiene({ clock: leakyClock, peerIds: ["a"] }).ok, true);
});

test("invariants: ddmin shrinker minimizes 5-peer 24-event scenario to exact 2-peer 2-event repro", async () => {
  const peers = ["p0", "p1", "p2", "p3", "p4"];
  const events = [];
  for (let i = 0; i < 24; i++) {
    if (i === 7) {
      events.push({ id: i, peerId: "p2", kind: "clickSeek", targetMs: 60_000 });
    } else if (i === 19) {
      events.push({ id: i, peerId: "p4", kind: "pause" });
    } else {
      events.push({ id: i, peerId: peers[i % peers.length], kind: "noop", n: i });
    }
  }

  const scenario = { seed: "0xbeef", peers, events };
  // Synthetic oracle: bug triggers iff `p2` executes clickSeek BEFORE `p4` executes pause
  const oracle = (cand) => {
    let sawSeek = false;
    for (const ev of cand.events) {
      if (ev.peerId === "p2" && ev.kind === "clickSeek") sawSeek = true;
      if (sawSeek && ev.peerId === "p4" && ev.kind === "pause") {
        return { failed: true, reason: "seek-then-pause-yank" };
      }
    }
    return false;
  };

  const res = await ddmin(scenario, oracle, { maxEvaluations: 250 });
  assert.equal(res.reduced, true);
  assert.deepEqual(res.shrunk.peers, ["p2", "p4"]);
  assert.equal(res.shrunk.events.length, 2);
  assert.equal(res.shrunk.events[0].kind, "clickSeek");
  assert.equal(res.shrunk.events[1].kind, "pause");

  const timeline = new TimelineLog();
  timeline.record({ tBase: 100, peerId: "p2", kind: "clickSeek", detail: "60000ms" });
  timeline.record({ tBase: 200, peerId: "p4", kind: "pause", detail: "yank" });
  const dump = formatReproDump({
    seed: scenario.seed,
    shrunk: res.shrunk,
    failure: res.lastFailure,
    timeline,
  });
  assert.match(dump, /Seed: 0xbeef/);
  assert.match(dump, /seek-then-pause-yank/);
  assert.match(dump, /Events \(2\)/);
  assert.match(dump, /clickSeek/);
});

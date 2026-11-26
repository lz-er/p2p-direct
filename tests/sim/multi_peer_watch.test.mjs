/**
 * Layer 1 Real-WASM Scripted Multi-Peer Watch Together Integration Suite.
 *
 * Exercises the full production stack:
 *   real `p2p_mesh.wasm` + real `MediaSyncController` + real `WatchTogetherPlayer`
 *   + realistic async `FakeProviderAdapter`s on deterministic `VirtualClock`
 * across all 4 providers (YouTube, SoundCloud, Spotify, Twitch) and asserts all 6 universal
 * invariants from `tests/harness/invariants.mjs` (including 0 leaked timers & E2EE wire auditing).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SimRoom } from "../harness/wasm_peer_node.mjs";
import { YT_STATE } from "../harness/fake_providers/youtube_adapter.mjs";
import { assertAllInvariants } from "../harness/invariants.mjs";

const YT_VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const SC_PLAYLIST_URL = "https://soundcloud.com/simartist/sets/party-mix";
const SPOTIFY_TRACK_URL = "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT";
const TWITCH_VOD_URL = "https://www.twitch.tv/videos/12345678";
const TWITCH_LIVE_URL = "https://www.twitch.tv/simchannel";

async function bootConnectedRoom(room, peerSpecs, linkMatrixFn = null) {
  for (const spec of peerSpecs) {
    await room.addPeer(spec.id, spec);
  }
  if (typeof linkMatrixFn === "function") {
    linkMatrixFn(room);
  } else {
    room.connectFullMesh({ latencyMs: 35, jitterMs: 5 });
  }
  await room.clock.runUntilIdle(1500);
  room.sendKeepalivePings();
  await room.clock.runUntilIdle(1500);
}

/* ==================== 1. YouTube Pre-BUFFERING Click-Seek + Extreme Skew ==================== */

test("sim(youtube): pre-BUFFERING click-seek (forward & backward) across 3 peers with asymmetric latency & -10h/+20h clock skew", async () => {
  const room = new SimRoom({ seed: "sim-yt-prebuf-skew" });
  await bootConnectedRoom(
    room,
    [
      { id: "alice", wallSkewMs: 0, adaptersConfig: { youtube: { cmdLatencyMs: 30, cmdLatencyJitterMs: 5, bufferMs: 140 } } },
      { id: "bob", wallSkewMs: -36_000_000, adaptersConfig: { youtube: { cmdLatencyMs: 65, cmdLatencyJitterMs: 10, bufferMs: 220 } } }, // -10h
      { id: "carol", wallSkewMs: +72_000_000, adaptersConfig: { youtube: { cmdLatencyMs: 80, cmdLatencyJitterMs: 15, bufferMs: 260 } } }, // +20h
    ],
    (r) => {
      r.setLink("alice", "bob", { latencyMs: 40, jitterMs: 5 });
      r.setLink("bob", "alice", { latencyMs: 160, jitterMs: 15 });
      r.setLink("alice", "carol", { latencyMs: 120, jitterMs: 15 });
      r.setLink("carol", "alice", { latencyMs: 45, jitterMs: 5 });
      r.setLink("bob", "carol", { latencyMs: 90, jitterMs: 10, bidirectional: true });
      r.connectFullMesh();
    }
  );

  const alice = room.getPeer("alice");
  const bob = room.getPeer("bob");
  const carol = room.getPeer("carol");

  assert.equal(alice.startUrl(YT_VIDEO_URL), true);
  await room.advanceAndSample(3000, 350);

  // Forward pre-BUFFERING click-seek by Alice (to 90s)
  alice.embedClickSeek(90_000, { preBufferJump: true, bufferMs: 180 });
  room.recordIntent("alice", {
    playing: true,
    positionMs: alice.adapters.youtube.snapshot().positionMs,
    rateMilli: 1000,
  });
  await room.advanceAndSample(5000, 300);

  // Backward pre-BUFFERING click-seek by Bob (to 25s) despite -10h clock skew
  bob.embedClickSeek(25_000, { preBufferJump: true, bufferMs: 220 });
  room.recordIntent("bob", {
    playing: true,
    positionMs: bob.adapters.youtube.snapshot().positionMs,
    rateMilli: 1000,
  });
  await room.advanceAndSample(5500, 300);

  // Steady-state quiescence window + local-only volume/mute changes
  const steadyStartMs = room.clock.nowBaseMs;
  await room.runLocalOnly("carol", "volume-mute", () => {
    carol.setLocalVolume(35);
    carol.setLocalMuted(true);
    carol.setLocalMuted(false);
  });
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["alice", "bob", "carol"],
    convergenceBudgetMs: 4500,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

/* ==================== 2. YouTube Buffered Silent Seek (1->1) & Paused Seek (2->2) ==================== */

test("sim(youtube): buffered silent seek (1->1) and paused seek (2->2) interleaved with live 1200ms correctDrift & 333ms polling", async () => {
  const room = new SimRoom({ seed: "sim-yt-silent-seeks" });
  await bootConnectedRoom(room, [
    { id: "alice", wallSkewMs: 0, adaptersConfig: { youtube: { cmdLatencyMs: 30, cmdLatencyJitterMs: 5, bufferMs: 80 } } },
    { id: "bob", wallSkewMs: 12_000, adaptersConfig: { youtube: { cmdLatencyMs: 40, cmdLatencyJitterMs: 5, bufferMs: 100 } } },
    { id: "carol", wallSkewMs: -8_000, adaptersConfig: { youtube: { cmdLatencyMs: 45, cmdLatencyJitterMs: 5, bufferMs: 100 } } },
  ]);

  const alice = room.getPeer("alice");
  const bob = room.getPeer("bob");

  alice.startUrl(YT_VIDEO_URL);
  await room.advanceAndSample(3100, 300);

  // Advance close to the 1200ms correctDrift cadence boundary, then perform a silent buffered seek (+3.5s)
  await room.advanceAndSample(450, 150);
  const smallTarget = Math.round(alice.adapters.youtube.snapshot().positionMs + 3500);
  alice.embedBufferedSeek(smallTarget);
  room.recordIntent("alice", { playing: true, positionMs: smallTarget, rateMilli: 1000 });
  await room.advanceAndSample(4500, 250);

  // Larger silent buffered seek forward (+45s) while playing (no onStateChange!)
  const largeTarget = Math.round(alice.adapters.youtube.snapshot().positionMs + 45_000);
  alice.embedBufferedSeek(largeTarget);
  room.recordIntent("alice", { playing: true, positionMs: largeTarget, rateMilli: 1000 });
  await room.advanceAndSample(4500, 250);

  // Pause via embed, settle, then perform silent paused seek (2 -> 2) by Bob
  bob.embedPause();
  room.recordIntent("bob", {
    playing: false,
    positionMs: bob.adapters.youtube.snapshot().positionMs,
    rateMilli: 1000,
  });
  await room.advanceAndSample(3000, 250);

  bob.embedPausedSeek(115_000);
  room.recordIntent("bob", { playing: false, positionMs: 115_000, rateMilli: 1000 });
  await room.advanceAndSample(4500, 250);

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["alice", "bob", "carol"],
    convergenceBudgetMs: 4500,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

/* ==================== 3. Slow (>1.4s) & Dropped Async Remote seekTo ==================== */

test("sim(youtube): slow >1.4s and dropped async remote seekTo converge via resync-local and never rewind peers", async () => {
  const room = new SimRoom({ seed: "sim-yt-slow-dropped-seek" });
  await bootConnectedRoom(room, [
    { id: "alice", wallSkewMs: 0, adaptersConfig: { youtube: { cmdLatencyMs: 30, cmdLatencyJitterMs: 0, bufferMs: 100 } } },
    { id: "bob", wallSkewMs: 5000, adaptersConfig: { youtube: { cmdLatencyMs: 40, cmdLatencyJitterMs: 0, slowSeekExtraMs: 1650, bufferMs: 120 } } },
    { id: "carol", wallSkewMs: -5000, adaptersConfig: { youtube: { cmdLatencyMs: 35, cmdLatencyJitterMs: 0, bufferMs: 100 } } },
  ]);

  const alice = room.getPeer("alice");
  const bob = room.getPeer("bob");
  const carol = room.getPeer("carol");

  alice.startUrl(YT_VIDEO_URL);
  await room.advanceAndSample(3200, 300);

  // Part A: Bob has >1.65s slow seekTo; Carol drops its first seekTo completely!
  carol.setAdapterConfig("youtube", { dropCommandProb: 1 });
  alice.embedClickSeek(85_000, { preBufferJump: true, bufferMs: 120 });
  room.recordIntent("alice", { playing: true, positionMs: 85_000, rateMilli: 1000 });

  // After initial remote seek is dropped on Carol, restore Carol's command delivery so resync-local succeeds
  await room.advanceAndSample(600, 200);
  carol.setAdapterConfig("youtube", { dropCommandProb: 0 });

  // Advance enough for resync-local retry to fire and settle on both Bob (slow) & Carol (dropped)
  await room.advanceAndSample(6500, 300);

  // Verify neither Bob nor Carol rewound Alice!
  assert.ok(
    alice.adapters.youtube.snapshot().positionMs >= 90_000,
    `Alice must never be rewound by slow/dropped remote peers (pos=${alice.adapters.youtube.snapshot().positionMs})`
  );

  // Part B: Paused slow/dropped remote seek
  alice.pause();
  room.recordIntent("alice", {
    playing: false,
    positionMs: alice.adapters.youtube.snapshot().positionMs,
    rateMilli: 1000,
  });
  await room.advanceAndSample(2500, 300);
  bob.setAdapterConfig("youtube", { slowSeekExtraMs: 0 });
  carol.setAdapterConfig("youtube", { dropCommandProb: 1 });
  alice.seekTo(140_000);
  room.recordIntent("alice", { playing: false, positionMs: 140_000, rateMilli: 1000 });
  await room.advanceAndSample(500, 250);
  carol.setAdapterConfig("youtube", { dropCommandProb: 0 });
  await room.advanceAndSample(5500, 300);

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["alice", "bob", "carol"],
    convergenceBudgetMs: 6500,
    checkIntent: true,
  });
  // Verify Bob & Carol converged to 140s paused without rewinding
  assert.ok(Math.abs(bob.adapters.youtube.snapshot().positionMs - 140_000) <= 1500);
  assert.ok(Math.abs(carol.adapters.youtube.snapshot().positionMs - 140_000) <= 1500);
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

/* ==================== 4. SoundCloud Fast-Click <100ms + Out-of-Order Async Callbacks ==================== */

test("sim(soundcloud): fast-click <100ms Pause->Resume + out-of-order async getPosition/getCurrentSoundIndex callbacks", async () => {
  const playlistSounds = [
    { id: 201, title: "SC Track 1", user: { username: "DJ Sim" }, duration: 180_000, full_duration: 180_000, policy: "ALLOW", playable: true },
    { id: 202, title: "SC Track 2", user: { username: "DJ Sim" }, duration: 195_000, full_duration: 195_000, policy: "ALLOW", playable: true },
    { id: 203, title: "SC Track 3", user: { username: "DJ Sim" }, duration: 210_000, full_duration: 210_000, policy: "ALLOW", playable: true },
  ];
  const scConfig = {
    cmdLatencyMs: 30,
    cmdLatencyJitterMs: 10,
    postMessageDelayMs: 25,
    postMessageJitterMs: 15,
    outOfOrderProb: 0.7,
    unhydratedStubs: true,
    sounds: playlistSounds,
  };

  const room = new SimRoom({ seed: "sim-sc-fast-click-ooo" });
  await bootConnectedRoom(room, [
    { id: "alice", wallSkewMs: 0, adaptersConfig: { soundcloud: scConfig } },
    { id: "bob", wallSkewMs: 18_000, adaptersConfig: { soundcloud: scConfig } },
    { id: "carol", wallSkewMs: -22_000, adaptersConfig: { soundcloud: scConfig } },
  ]);

  const alice = room.getPeer("alice");
  const bob = room.getPeer("bob");

  alice.startUrl(SC_PLAYLIST_URL);
  await room.advanceAndSample(3200, 300);

  // Fast-click Pause -> Resume within 65ms on Alice while out-of-order postMessage callbacks are in flight!
  alice.embedRapidToggle(2, 65);
  await room.clock.advanceBy(80);
  room.recordIntent("alice", {
    playing: true,
    positionMs: alice.adapters.soundcloud.snapshot().positionMs,
    rateMilli: 1000,
  });
  await room.advanceAndSample(4500, 300);

  // Rapid playlist track switch + play on Bob (unhydrated stubs + out-of-order getCurrentSoundIndex)
  bob.embedSelectPlaylistTrack(1);
  room.recordIntent("bob", { playing: true, positionMs: 0, rateMilli: 1000 });
  await room.advanceAndSample(5000, 300);

  assert.equal(alice.getWasmState().playlistIndex, 1);
  assert.equal(room.getPeer("carol").getWasmState().playlistIndex, 1);

  const steadyStartMs = room.clock.nowBaseMs;
  await room.runLocalOnly("alice", "sc-volume", () => {
    alice.setLocalVolume(60);
  });
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["alice", "bob", "carol"],
    convergenceBudgetMs: 4500,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

/* ==================== 5. SoundCloud Go+ SNIP 30s Cap + FINISH + Unhydrated Stubs ==================== */

test("sim(soundcloud): Go+ SNIP 30s cap + FINISH + unhydrated stubs must NOT drag full-track peers back or skip playlist", async () => {
  const fullSounds = [
    { id: 301, title: "Go+ Anthem", user: { username: "Label" }, duration: 180_000, full_duration: 180_000, policy: "ALLOW", playable: true },
    { id: 302, title: "Track Two", user: { username: "Label" }, duration: 200_000, full_duration: 200_000, policy: "ALLOW", playable: true },
  ];
  const snipSounds = [
    { id: 301, title: "Go+ Anthem", user: { username: "Label" }, duration: 30_000, policy: "SNIP", monetization_model: "SUB_HIGH_TIER", playable: true },
    { id: 302, title: "Track Two", user: { username: "Label" }, duration: 30_000, full_duration: 200_000, policy: "SNIP", monetization_model: "SUB_HIGH_TIER", playable: true },
  ];

  const room = new SimRoom({ seed: "sim-sc-go-plus-snip" });
  await bootConnectedRoom(room, [
    { id: "alice", wallSkewMs: 0, adaptersConfig: { soundcloud: { sounds: fullSounds, unhydratedStubs: true } } },
    { id: "bob", wallSkewMs: -9_000, adaptersConfig: { soundcloud: { sounds: fullSounds, unhydratedStubs: true } } },
    { id: "carol", wallSkewMs: 14_000, adaptersConfig: { soundcloud: { sounds: snipSounds, unhydratedStubs: true } } },
  ]);

  const alice = room.getPeer("alice");
  const bob = room.getPeer("bob");
  const carol = room.getPeer("carol");

  alice.startUrl(SC_PLAYLIST_URL);
  await room.advanceAndSample(2600, 300);

  // Seek to 27s so everyone plays across Carol's 30s SNIP boundary!
  alice.embedClickSeek(27_000);
  room.recordIntent("alice", { playing: true, positionMs: 27_000, rateMilli: 1000 });
  await room.advanceAndSample(2000, 250);

  // Record Carol's fault isolation window before she hits 30s SNIP PAUSE + FINISH
  const snipFaultStart = room.clock.nowBaseMs;
  await room.advanceAndSample(8000, 300);

  // Verify Carol hit 30s preview cap and did NOT pause/rewind Alice/Bob or skip to track 1!
  assert.equal(carol.adapters.soundcloud.snapshot().isPreview, true);
  assert.equal(alice.getWasmState().playing, true);
  assert.equal(alice.getWasmState().playlistIndex, 0, "SNIP FINISH must never skip playlist track");
  assert.ok(alice.adapters.soundcloud.snapshot().positionMs >= 35_000);
  assert.ok(bob.adapters.soundcloud.snapshot().positionMs >= 35_000);

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  room.recordFaultWindow("carol", "soundcloud-snip-30s", snipFaultStart, steadyEndMs);

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["alice", "bob"],
    convergenceBudgetMs: 4500,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

/* ==================== 6. Spotify 30s Preview + Mid-Track Reload + Autoplay Block + Delayed Harmony Boot ==================== */

test("sim(spotify): 30s preview peer vs full-track peer + mid-track reloadPlayerSession() with autoplay block + delayed Harmony boot (0 disruption)", async () => {
  const room = new SimRoom({ seed: "sim-sp-preview-reload" });
  await bootConnectedRoom(room, [
    {
      id: "alice",
      wallSkewMs: 0,
      adaptersConfig: {
        spotify: { durationMs: 213_573, delayedBootPausedMs: 180, updateCadenceMs: 450, previewMode: false },
      },
    },
    {
      id: "bob",
      wallSkewMs: 25_000,
      adaptersConfig: {
        spotify: { durationMs: 213_573, delayedBootPausedMs: 220, updateCadenceMs: 450, previewMode: false },
      },
    },
    {
      id: "carol",
      wallSkewMs: -15_000,
      adaptersConfig: {
        spotify: {
          durationMs: 213_573,
          previewMode: true,
          previewDurationMs: 29_713,
          autoplayBlocked: true,
          delayedBootPausedMs: 250,
          updateCadenceMs: 450,
        },
      },
    },
  ]);

  const alice = room.getPeer("alice");
  const bob = room.getPeer("bob");
  const carol = room.getPeer("carol");

  const faultStart = room.clock.nowBaseMs;
  alice.startUrl(SPOTIFY_TRACK_URL);
  await room.advanceAndSample(3500, 350);

  // Alice seeks mid-track to 55s (well past Carol's 30s preview)
  alice.embedClickSeek(55_000);
  room.recordIntent("alice", { playing: true, positionMs: 55_000, rateMilli: 1000 });
  await room.advanceAndSample(5000, 350);

  // Carol triggers local reloadPlayerSession() mid-track while autoplay-blocked (zero wire frames & zero disruption!)
  await room.runLocalOnly(
    "carol",
    "spotify-reload-session",
    async () => {
      const ok = await carol.reloadPlayerSession({ reason: "manual" });
      assert.equal(ok, true);
      await room.advanceAndSample(3500, 350);
    },
    0
  );

  // Alice & Bob must remain playing past 60s with zero disruption from Carol
  assert.equal(alice.getWasmState().playing, true);
  assert.ok(alice.adapters.spotify.snapshot().positionMs >= 60_000);
  assert.ok(bob.adapters.spotify.snapshot().positionMs >= 58_000);

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  room.recordFaultWindow("carol", "spotify-preview-autoplay-reload", faultStart, steadyEndMs);

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["alice", "bob"],
    convergenceBudgetMs: 4500,
    spotifyConvergenceToleranceMs: 3000,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

/* ==================== 7. Twitch VOD Silent Seek + PLAYBACK_BLOCKED + Live ONLINE/OFFLINE ==================== */

test("sim(twitch): VOD silent seek + PLAYBACK_BLOCKED muted recovery + Live ONLINE/OFFLINE", async () => {
  // Part A: Twitch VOD silent seek + PLAYBACK_BLOCKED recovery
  const vodRoom = new SimRoom({ seed: "sim-tw-vod" });
  await bootConnectedRoom(vodRoom, [
    { id: "alice", wallSkewMs: 0, adaptersConfig: { twitch: { cmdLatencyMs: 30, cmdLatencyJitterMs: 5 } } },
    { id: "bob", wallSkewMs: -12_000, adaptersConfig: { twitch: { cmdLatencyMs: 40, cmdLatencyJitterMs: 5 } } },
    { id: "carol", wallSkewMs: 18_000, adaptersConfig: { twitch: { cmdLatencyMs: 35, cmdLatencyJitterMs: 5, autoplayBlocked: true } } },
  ]);

  const alice = vodRoom.getPeer("alice");
  const bob = vodRoom.getPeer("bob");
  const carol = vodRoom.getPeer("carol");

  alice.startUrl(TWITCH_VOD_URL);
  await vodRoom.advanceAndSample(3200, 300);

  // Carol experienced PLAYBACK_BLOCKED and auto-recovered by muting + playing!
  assert.equal(carol.adapters.twitch.snapshot().muted, true, "Carol should recover from PLAYBACK_BLOCKED via muted autoplay");
  assert.equal(carol.adapters.twitch.snapshot().playing, true);

  // Alice performs silent buffered VOD seek (no SEEK event)
  alice.embedBufferedSeek(70_000);
  vodRoom.recordIntent("alice", { playing: true, positionMs: 70_000, rateMilli: 1000 });
  await vodRoom.advanceAndSample(4800, 300);

  // Bob pauses and performs silent paused VOD seek
  bob.embedPause();
  vodRoom.recordIntent("bob", {
    playing: false,
    positionMs: bob.adapters.twitch.snapshot().positionMs,
    rateMilli: 1000,
  });
  await vodRoom.advanceAndSample(3000, 300);

  bob.embedPausedSeek(125_000);
  vodRoom.recordIntent("bob", { playing: false, positionMs: 125_000, rateMilli: 1000 });
  await vodRoom.advanceAndSample(4800, 300);

  const vodSteadyStart = vodRoom.clock.nowBaseMs;
  await vodRoom.runLocalOnly("alice", "twitch-volume", () => {
    alice.setLocalVolume(40);
  });
  await vodRoom.advanceAndSample(3500, 350);
  const vodSteadyEnd = vodRoom.clock.nowBaseMs;

  const vodPre = vodRoom.evaluatePreTeardownInvariants({
    steadyStartMs: vodSteadyStart,
    steadyEndMs: vodSteadyEnd,
    healthyPeerIds: ["alice", "bob", "carol"],
    convergenceBudgetMs: 4500,
  });
  const vodInv6 = vodRoom.destroyAndCheckTimerHygiene();
  assertAllInvariants([...vodPre, vodInv6], vodRoom.timeline);

  // Part B: Twitch Live Channel ONLINE / OFFLINE
  const liveRoom = new SimRoom({ seed: "sim-tw-live" });
  await bootConnectedRoom(liveRoom, [
    { id: "alice", wallSkewMs: 0 },
    { id: "bob", wallSkewMs: 5000 },
  ]);
  const liveAlice = liveRoom.getPeer("alice");
  const liveBob = liveRoom.getPeer("bob");

  liveAlice.startUrl(TWITCH_LIVE_URL);
  await liveRoom.advanceAndSample(2600, 300);

  const offStart = liveRoom.clock.nowBaseMs;
  liveBob.injectOffline();
  await liveRoom.advanceAndSample(2000, 300);
  assert.equal(liveBob.controller.watchTwitchOffline, true);
  assert.equal(liveAlice.getWasmState().playing, true, "Bob going OFFLINE must not pause Alice");
  const offEnd = liveRoom.clock.nowBaseMs;
  liveRoom.recordFaultWindow("bob", "twitch-offline", offStart, offEnd);

  liveBob.injectOnline();
  liveBob.embedPlay();
  await liveRoom.advanceAndSample(2500, 300);
  assert.equal(liveBob.controller.watchTwitchOffline, false);

  const liveSteadyStart = liveRoom.clock.nowBaseMs;
  await liveRoom.advanceAndSample(3000, 350);
  const liveSteadyEnd = liveRoom.clock.nowBaseMs;

  const livePre = liveRoom.evaluatePreTeardownInvariants({
    steadyStartMs: liveSteadyStart,
    steadyEndMs: liveSteadyEnd,
    healthyPeerIds: ["alice", "bob"],
    checkIntent: false,
  });
  const liveInv6 = liveRoom.destroyAndCheckTimerHygiene();
  assertAllInvariants([...livePre, liveInv6], liveRoom.timeline);
});

/* ==================== 8. Partition/Heal + Autoplay-Blocked Late Joiner + Tab Sleep >2.5s Wake ==================== */

test("sim(network+lifecycle): partition & heal (Hello convergence) + autoplay-blocked late joiner + tab sleep >2.5s wake", async () => {
  const room = new SimRoom({ seed: "sim-partition-late-sleep" });
  await bootConnectedRoom(room, [
    { id: "alice", wallSkewMs: 0, adaptersConfig: { youtube: { cmdLatencyMs: 30, cmdLatencyJitterMs: 5, bufferMs: 100 } } },
    { id: "bob", wallSkewMs: -15_000, adaptersConfig: { youtube: { cmdLatencyMs: 35, cmdLatencyJitterMs: 5, bufferMs: 100 } } },
    { id: "carol", wallSkewMs: 30_000, adaptersConfig: { youtube: { cmdLatencyMs: 40, cmdLatencyJitterMs: 5, bufferMs: 120 } } },
  ]);

  const alice = room.getPeer("alice");
  const bob = room.getPeer("bob");
  const carol = room.getPeer("carol");

  alice.startUrl(YT_VIDEO_URL);
  await room.advanceAndSample(2800, 300);

  // 1. Partition Carol away; Alice seeks to 70s and plays on
  room.partition(["alice", "bob"], ["carol"]);
  alice.embedClickSeek(70_000, { preBufferJump: true, bufferMs: 100 });
  room.recordIntent("alice", { playing: true, positionMs: 70_000, rateMilli: 1000 });
  await room.advanceAndSample(4000, 300);
  assert.notEqual(carol.getWasmState().rev, alice.getWasmState().rev, "Partitioned Carol lags on old rev");

  // Heal partition & reconnect Carol so real WASM Hello snapshot re-syncs Carol cleanly
  room.healAll();
  room.disconnect("alice", "carol");
  room.disconnect("bob", "carol");
  room.connect("alice", "carol", { latencyMs: 35, jitterMs: 5 });
  room.connect("bob", "carol", { latencyMs: 35, jitterMs: 5 });
  await room.advanceAndSample(4500, 300);
  assert.equal(carol.getWasmState().rev, alice.getWasmState().rev, "Healed Carol must converge via Hello snapshot");

  // 2. Late joiner Dave connects with autoplayBlocked (on SoundCloud-like or YouTube) — test YouTube autoplayBlocked
  const daveJoinStart = room.clock.nowBaseMs;
  const dave = await room.addPeer("dave", {
    wallSkewMs: -50_000,
    adaptersConfig: {
      youtube: { cmdLatencyMs: 40, cmdLatencyJitterMs: 5, bufferMs: 100, autoplayBlocked: true },
    },
  });
  room.connect("bob", "dave", { latencyMs: 40, jitterMs: 5 });
  room.connect("alice", "dave", { latencyMs: 40, jitterMs: 5 });
  room.connect("carol", "dave", { latencyMs: 40, jitterMs: 5 });
  await room.advanceAndSample(4500, 300);

  // Dave received Hello snapshot and either auto-muted into synced playback or stayed guarded — NEVER paused Alice!
  assert.equal(dave.getWasmState().rev, alice.getWasmState().rev);
  assert.equal(alice.getWasmState().playing, true, "Autoplay-blocked late joiner must NEVER pause room");
  assert.ok(daveJoinStart > 0);

  // 3. Tab sleep > 2.5s on Bob (4000ms frozen playhead) -> wake triggers tab-wake-resync without rewinding Alice!
  const sleepWin = bob.sleepFor(4000, { freezePlayhead: true });
  room.recordFaultWindow("bob", "tab-sleep", sleepWin.startMs, sleepWin.endMs);
  await room.advanceAndSample(8500, 350);

  // Verify Bob caught back up to Alice after waking from 4s sleep!
  const spreadAfterWake = Math.abs(
    bob.adapters.youtube.snapshot().positionMs - alice.adapters.youtube.snapshot().positionMs
  );
  assert.ok(
    spreadAfterWake <= 2200,
    `Bob must converge via tab-wake-resync after 4s sleep (spread=${spreadAfterWake}ms)`
  );

  // 4. Error 150 + recovery on Carol during session
  const errStart = room.clock.nowBaseMs;
  carol.injectError(150);
  await room.advanceAndSample(2000, 350);
  const errEnd = room.clock.nowBaseMs;
  room.recordFaultWindow("carol", "yt-error-150", errStart, errEnd);
  carol.recoverFromError(YT_STATE.CUED);
  await room.advanceAndSample(4000, 350);

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["alice", "bob", "carol", "dave"],
    convergenceBudgetMs: 5500,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

/* ==================== 9. Chaos-Uncovered Permanent Production Regressions ==================== */

test("sim(regression/youtube): persistent >1.5s slow-WiFi seek converges without Zeno drift loop, pause+seek never auto-resumes, and <100ms pause after rebuffer-catchup propagates immediately", async () => {
  const room = new SimRoom({ seed: "sim-reg-yt-zeno-repause" });
  await bootConnectedRoom(room, [
    {
      id: "fast",
      wallSkewMs: 0,
      adaptersConfig: { youtube: { cmdLatencyMs: 25, cmdLatencyJitterMs: 5, bufferMs: 110 } },
    },
    {
      id: "slow",
      wallSkewMs: -180_000,
      adaptersConfig: {
        youtube: { cmdLatencyMs: 95, cmdLatencyJitterMs: 15, slowSeekExtraMs: 1450, bufferMs: 210 },
      },
    },
  ]);

  const fast = room.getPeer("fast");
  const slow = room.getPeer("slow");

  fast.startUrl(YT_VIDEO_URL);
  await room.advanceAndSample(3000, 300);

  // 1) Remote seek to 120s on persistent >1.5s slow-WiFi peer -> must converge with lead-time
  // compensation + drift cooldown instead of looping forever (Zeno's paradox, chaos seed 0x7f56015d)
  fast.embedClickSeek(120_000, { preBufferJump: true });
  room.recordIntent("fast", { playing: true, positionMs: 120_000, rateMilli: 1000 });
  await room.advanceAndSample(9500, 350);

  assert.equal(slow.adapters.youtube.playing, true);
  assert.ok(
    Math.abs(slow.adapters.youtube.snapshot().positionMs - fast.adapters.youtube.snapshot().positionMs) <= 2200,
    `slow-WiFi peer must converge with fast peer without Zeno loop (slow=${slow.adapters.youtube.snapshot().positionMs}, fast=${fast.adapters.youtube.snapshot().positionMs})`
  );

  // 2) Remote pause + seek from fast peer while slow peer is playing -> pause-before-seek ordering
  // and programmatic-seek-repause guarantee slow peer stays paused and never un-pauses the room
  // (chaos seeds 0x844fa92f & 0xa904e13b)
  fast.togglePlay();
  room.recordIntent("fast", { kind: "boundary" });
  await room.advanceAndSample(400, 200);
  fast.seekTo(45_000);
  room.recordIntent("fast", { playing: false, positionMs: 45_000, rateMilli: 1000 });
  await room.advanceAndSample(4500, 300);

  assert.equal(fast.getWasmState().playing, false);
  assert.equal(slow.adapters.youtube.playing, false);

  // 3) Resume, inject network rebuffer on fast peer, then click Pause 80ms after rebuffer-catchup
  // seekTo -> must NOT be swallowed by 180ms playstate suppression (!cmd.expectPlayState, seed 0x72387643)
  fast.embedPlay();
  room.recordIntent("fast", { playing: true, positionMs: 45_000, rateMilli: 1000 });
  await room.advanceAndSample(2000, 300);

  room.recordIntent("fast", { kind: "boundary" });
  fast.injectRebuffer(1800);
  await room.advanceAndSample(1800, 300);
  // Immediately click Pause 80ms after rebuffer resumes and issues rebuffer-catchup seekTo
  await room.advanceAndSample(80, 80);
  const pausePos = fast.adapters.youtube.snapshot().positionMs;
  fast.embedPause();
  room.recordIntent("fast", { playing: false, positionMs: pausePos, rateMilli: 1000 });
  await room.advanceAndSample(4500, 300);

  assert.equal(fast.getWasmState().playing, false, "Pause 80ms after rebuffer-catchup must propagate immediately");
  assert.equal(slow.getWasmState().playing, false);

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["fast", "slow"],
    convergenceBudgetMs: 9500,
    yankToleranceMs: 2200,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

test("sim(regression/soundcloud): autoplay-blocked seek+noop, skip+rapid-seek settle, 3-step jitter toggle, and unhydrated SNIP 30s cap while paused/playing", async () => {
  const fullSounds = [
    { id: 701, title: "SC Full 1", user: { username: "Artist" }, duration: 240_000, policy: "ALLOW", playable: true },
    { id: 702, title: "SC Full 2", user: { username: "Artist" }, duration: 240_000, policy: "ALLOW", playable: true },
  ];
  const snipSounds = [
    { id: 701, title: "SC Go+ 1", user: { username: "Artist" }, duration: 30_000, full_duration: 240_000, policy: "SNIP", monetization_model: "SUB_HIGH_TIER", playable: true },
    { id: 702, title: "SC Go+ 2", user: { username: "Artist" }, duration: 30_000, full_duration: 240_000, policy: "SNIP", monetization_model: "SUB_HIGH_TIER", playable: true },
  ];
  const room = new SimRoom({ seed: "sim-reg-sc-chaos-bugs" });
  await bootConnectedRoom(room, [
    {
      id: "host",
      wallSkewMs: 0,
      adaptersConfig: { soundcloud: { cmdLatencyMs: 25, cmdLatencyJitterMs: 5, sounds: fullSounds } },
    },
    {
      id: "jitter",
      wallSkewMs: -36_000_000,
      adaptersConfig: { soundcloud: { cmdLatencyMs: 75, cmdLatencyJitterMs: 25, outOfOrderProb: 0.45, sounds: fullSounds } },
    },
    {
      id: "blocked",
      wallSkewMs: 120_000,
      adaptersConfig: { soundcloud: { autoplayBlocked: true, cmdLatencyMs: 35, cmdLatencyJitterMs: 5, sounds: fullSounds } },
    },
    {
      id: "snip",
      wallSkewMs: 40_000,
      adaptersConfig: {
        soundcloud: {
          cmdLatencyMs: 65,
          cmdLatencyJitterMs: 20,
          outOfOrderProb: 0.55,
          sounds: snipSounds,
        },
      },
    },
  ]);

  const host = room.getPeer("host");
  const jitter = room.getPeer("jitter");
  const blocked = room.getPeer("blocked");
  const snip = room.getPeer("snip");

  host.startUrl(SC_PLAYLIST_URL);
  await room.advanceAndSample(3000, 300);

  // 1) Autoplay-blocked peer receives remote seek + no-op update -> must NEVER pause room (seeds 0x8bdaaca4 / 0x40de9a4d)
  const blockedStart = room.clock.nowBaseMs;
  host.seekTo(12_000);
  room.recordIntent("host", { playing: true, positionMs: 12_000 });
  await room.advanceAndSample(1500, 300);
  host.enqueue("https://soundcloud.com/simartist/extra-track");
  await room.advanceAndSample(4000, 300);
  assert.equal(host.getWasmState().playing, true, "Autoplay-blocked peer must never pause room after remote seek + noop");

  // 2a) Track switch with high link delay (~600ms -> 820ms at playlist-settle) on autoplay-blocked peer
  // must mark expectSeek=true on playlist-settle so SEEK(820) never emits pause (seed 0x5fbd3526)
  room.setLink("host", "blocked", { latencyMs: 600, jitterMs: 10 });
  host.selectPlaylistTrack(1);
  room.recordIntent("host", { kind: "boundary" });
  await room.advanceAndSample(1500, 300);
  assert.equal(host.getWasmState().playing, true, "Autoplay-blocked peer playlist-settle seek >800ms must not pause room");
  room.setLink("host", "blocked", { latencyMs: 35, jitterMs: 5 });

  // 2b) Playlist skip() followed 100ms later by seekTo -> must NOT cancel playlist-settle play() (seed 0x8bdaaca4)
  host.selectPlaylistTrack(0);
  room.recordIntent("host", { kind: "boundary" });
  await room.advanceAndSample(100, 50);
  host.seekTo(8_000);
  room.recordIntent("host", { playing: true, positionMs: 8_000 });
  await room.advanceAndSample(3000, 300);
  assert.equal(jitter.adapters.soundcloud.playing, true, "skip()+seekTo must preserve play state on remote peer");
  assert.equal(jitter.adapters.soundcloud.playlistIndex, 0);

  // 3) Rapid 3-step remote Pause->Play->Pause with jitter reordering -> zero echo cascade (seed 0x8bdaaca4)
  host.embedRapidToggle(3, 45);
  room.recordIntent("host", { kind: "boundary" });
  await room.advanceAndSample(3500, 300);
  assert.equal(host.getWasmState().playing, false);
  assert.equal(jitter.adapters.soundcloud.playing, false);

  // 4) Resume and jump past 30s -> SNIP peer hits 30s cap BOTH while room playing AND after room pauses at 160s,
  // plus reloads mid-track with out-of-order postMessage before getCurrentSound hydrates (seeds 0xdca2adf7 / 0x0d294063 / 0x70531d4c)
  host.seekTo(160_000);
  host.togglePlay(); // playing: true at 160s
  room.recordIntent("host", { playing: true, positionMs: 160_000 });
  await room.advanceAndSample(1500, 300);

  const snipStart = room.clock.nowBaseMs;
  await room.runLocalOnly("snip", "snip-reload-past-30s", () => snip.reloadPlayerSession({ reason: "snip" }), 50);
  await room.advanceAndSample(2500, 300);
  assert.equal(host.getWasmState().playing, true, "SNIP reload past 30s with OOO postMessage must not pause/rewind room");
  assert.ok(host.adapters.soundcloud.snapshot().positionMs > 155_000);

  // Pause room at ~164s while SNIP preview hits 30s cap -> must NOT rewind full-track peers back to 30s
  host.togglePlay(); // playing: false
  const pausedAt = host.adapters.soundcloud.snapshot().positionMs;
  room.recordIntent("host", { playing: false, positionMs: pausedAt });
  await room.advanceAndSample(4000, 300);
  assert.ok(host.adapters.soundcloud.snapshot().positionMs > 155_000, "SNIP cap while room paused must not rewind room to 30s");

  const faultEnd = room.clock.nowBaseMs;
  room.recordFaultWindow("blocked", "autoplay-blocked", blockedStart, faultEnd);
  room.recordFaultWindow("snip", "sc-snip-past-30s", snipStart, faultEnd);

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["host", "jitter"],
    convergenceBudgetMs: 5000,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

test("sim(regression/spotify): playlist A->B->A track switch, rapid remote toggle, early ui:replay, 30s preview cap, and reload->user-seek", async () => {
  const SPOTIFY_PL_URL = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M";
  const TRACK_A = "spotify:track:7ouMYWpwJ422jRcDASZB7P";
  const TRACK_B = "spotify:track:3n3Ppam7vgaVa1iaRUc9Lp";

  const room = new SimRoom({ seed: "sim-reg-spotify-chaos-bugs" });
  await bootConnectedRoom(room, [
    {
      id: "alice",
      wallSkewMs: 0,
      adaptersConfig: { spotify: { cmdLatencyMs: 25, cmdLatencyJitterMs: 5, updateCadenceMs: 420 } },
    },
    {
      id: "bob",
      wallSkewMs: -180_000,
      adaptersConfig: { spotify: { cmdLatencyMs: 95, cmdLatencyJitterMs: 22, updateCadenceMs: 390 } },
    },
    {
      id: "preview",
      wallSkewMs: 12_000,
      adaptersConfig: { spotify: { previewMode: true, previewDurationMs: 29_713, cmdLatencyMs: 40 } },
    },
  ]);

  const alice = room.getPeer("alice");
  const bob = room.getPeer("bob");
  const preview = room.getPeer("preview");

  alice.startUrl(SPOTIFY_PL_URL);
  await room.advanceAndSample(3500, 350);

  // 1) Playlist Track A -> Track B -> Track A (caught stale spotifyShowingTrackUri ping-pong, seed 0xa46536bd)
  bob.embedSelectPlaylistTrack(TRACK_A);
  room.recordIntent("bob", { kind: "boundary" });
  await room.advanceAndSample(2500, 350);
  assert.equal(alice.adapters.spotify.trackUri, TRACK_A);

  alice.embedSelectPlaylistTrack(TRACK_B);
  room.recordIntent("alice", { kind: "boundary" });
  await room.advanceAndSample(2500, 350);
  assert.equal(bob.adapters.spotify.trackUri, TRACK_B);

  bob.embedSelectPlaylistTrack(TRACK_A);
  room.recordIntent("bob", { kind: "boundary" });
  await room.advanceAndSample(3500, 350);
  assert.equal(alice.adapters.spotify.trackUri, TRACK_A, "A->B->A switch must NOT get stuck on stale spotifyShowingTrackUri");
  assert.equal(bob.adapters.spotify.trackUri, TRACK_A);

  // 2) ui:replay within first 1.5s of track (caught missing isEpochReplay in Spotify needsSeek, seed 0x39f818e4)
  await room.advanceAndSample(900, 300);
  alice.replay();
  room.recordIntent("alice", { playing: true, positionMs: 0, rateMilli: 1000 });
  await room.advanceAndSample(3000, 350);
  assert.ok(
    Math.abs(alice.adapters.spotify.snapshot().positionMs - bob.adapters.spotify.snapshot().positionMs) <= 1500,
    "Spotify early ui:replay must seek back to 0:00 via isEpochReplay"
  );

  // 3) Rapid 3-step remote Pause->Play->Pause on Spotify playlist (caught _spotifyInFlightPlayOps + _spotifyBrowsingPlaylist, seed 0xa46536bd)
  alice.embedRapidToggle(3, 55);
  room.recordIntent("alice", { kind: "boundary" });
  await room.advanceAndSample(3500, 350);
  assert.equal(alice.getWasmState().playing, false);
  assert.equal(bob.adapters.spotify.playing, false);

  // Resume + seek to 28s so preview peer hits 29.713s cap and must NOT pause/end room (seed 0xa0c70c3f)
  alice.togglePlay();
  alice.seekTo(28_000);
  room.recordIntent("alice", { playing: true, positionMs: 28_000 });
  const prevStart = room.clock.nowBaseMs;
  await room.advanceAndSample(4500, 350);
  assert.equal(alice.getWasmState().playing, true, "Spotify 30s preview cap must never pause full-track peers");
  assert.equal(bob.adapters.spotify.playing, true);
  room.recordFaultWindow("preview", "spotify-preview-cap", prevStart, room.clock.nowBaseMs + 10_000);

  // 4) Mid-track local reloadPlayerSession() followed 1.2s later by a genuine user seek (seed 0xde8f868e),
  // plus a small -1.1s local-ui seek that must project lastKnownPosMs forward and seek cleanly (seed 0x34d8b05d)
  await room.runLocalOnly("alice", "spotify-reload", () => alice.reloadPlayerSession({ reason: "manual" }), 50);
  await room.advanceAndSample(1400, 350);
  alice.embedClickSeek(82_000);
  room.recordIntent("alice", { playing: true, positionMs: 82_000 });
  await room.advanceAndSample(2400, 350);
  assert.ok(bob.adapters.spotify.snapshot().positionMs >= 80_000, "User seek after Spotify reload settle must not be swallowed");

  const beforeSmallSeek = alice.adapters.spotify.snapshot().positionMs;
  const smallTarget = Math.max(0, Math.round(beforeSmallSeek - 1150));
  alice.seekTo(smallTarget);
  room.recordIntent("alice", { playing: true, positionMs: Math.floor(smallTarget / 1000) * 1000 });
  await room.advanceAndSample(3200, 350);
  assert.ok(
    Math.abs(alice.adapters.spotify.snapshot().positionMs - bob.adapters.spotify.snapshot().positionMs) <= 1500,
    "Small -1.15s local-ui Spotify seek must stay in sync across peers"
  );

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["alice", "bob"],
    convergenceBudgetMs: 5500,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

test("sim(regression/twitch): overlapping back-to-back remote seeks never echo stale SEEK as user action", async () => {
  const room = new SimRoom({ seed: "sim-reg-twitch-back2back-seeks" });
  await bootConnectedRoom(room, [
    {
      id: "alice",
      wallSkewMs: 0,
      adaptersConfig: { twitch: { cmdLatencyMs: 25, cmdLatencyJitterMs: 5 } },
    },
    {
      id: "bob",
      wallSkewMs: 36_000,
      adaptersConfig: { twitch: { cmdLatencyMs: 120, cmdLatencyJitterMs: 35 } },
    },
    {
      id: "carol",
      wallSkewMs: -72_000_000,
      adaptersConfig: { twitch: { cmdLatencyMs: 110, cmdLatencyJitterMs: 30 } },
    },
  ]);

  const alice = room.getPeer("alice");
  const bob = room.getPeer("bob");
  const carol = room.getPeer("carol");

  alice.startUrl(TWITCH_VOD_URL);
  await room.advanceAndSample(2500, 300);

  // Two rapid back-to-back seeks 70ms apart (faster than bob/carol's 120ms async SEEK echo!)
  // Caught missing _matchesLateProgrammaticSeek check inside cmd.expectSeek (seed 0x5d5396c8).
  alice.seekTo(35_000);
  await room.advanceAndSample(70, 35);
  alice.seekTo(360_000);
  room.recordIntent("alice", { playing: true, positionMs: 360_000 });
  await room.advanceAndSample(4000, 300);

  assert.ok(alice.adapters.twitch.snapshot().positionMs >= 360_000, "Stale SEEK(35s) echo must NOT rewind room");
  assert.ok(bob.adapters.twitch.snapshot().positionMs >= 360_000);
  assert.ok(carol.adapters.twitch.snapshot().positionMs >= 360_000);

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds: ["alice", "bob", "carol"],
    convergenceBudgetMs: 4500,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
});

/**
 * Layer 2 Seeded Property-Based Chaos Fuzzer for Watch Together P2P Sync.
 *
 * Environment variables:
 * - `FUZZ_SEEDS`: Number of seeds to execute (default: `50` for fast local gate; PR CI: `500`; nightly: `10000`)
 * - `FUZZ_SEED`: Run a single specific seed (e.g. `FUZZ_SEED=0x1a2b3c4d` or `FUZZ_SEED=17`) for instant repro
 * - `FUZZ_PROVIDER`: `youtube` | `soundcloud` | `spotify` | `twitch` | `all` (default: `all`)
 * - `FUZZ_OUT_DIR`: Optional directory to write shrunk counterexample artifacts on failure
 *
 * On any invariant violation, invokes Zeller's `ddmin` shrinker from `tests/harness/invariants.mjs`
 * and prints a one-line `FUZZ_SEED=...` reproduction command + minimal shrunk event sequence.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { projectMediaPositionMs } from "../../watch_together.js";
import { createPrng } from "../harness/prng.mjs";
import { SimRoom } from "../harness/wasm_peer_node.mjs";
import { YT_STATE } from "../harness/fake_providers/youtube_adapter.mjs";
import { ddmin, formatReproDump } from "../harness/invariants.mjs";

const ALL_PROVIDERS = ["youtube", "soundcloud", "spotify", "twitch"];

const MEDIA_CATALOG = {
  youtube: {
    single: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    playlist: "https://www.youtube.com/watch?v=vidA1111111&list=PLsimChaos12345678",
    queue: "https://www.youtube.com/watch?v=9bZkp7q19f0",
  },
  soundcloud: {
    single: "https://soundcloud.com/simartist/chaos-single-track",
    playlist: "https://soundcloud.com/simartist/sets/chaos-mix",
    queue: "https://soundcloud.com/simartist/queued-anthem",
  },
  spotify: {
    single: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    playlist: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    queue: "https://open.spotify.com/track/7ouMYWpwJ422jRcDASZB7P",
  },
  twitch: {
    vod: "https://www.twitch.tv/videos/12345678",
    live: "https://www.twitch.tv/simchannel",
    queue: "https://www.twitch.tv/videos/87654321",
  },
};

const SC_BASE_SOUNDS = [
  { id: 501, title: "SC Chaos 1", user: { username: "SimDJ" }, duration: 240_000, full_duration: 240_000, policy: "ALLOW", playable: true },
  { id: 502, title: "SC Chaos 2", user: { username: "SimDJ" }, duration: 250_000, full_duration: 250_000, policy: "ALLOW", playable: true },
  { id: 503, title: "SC Chaos 3", user: { username: "SimDJ" }, duration: 260_000, full_duration: 260_000, policy: "ALLOW", playable: true },
];

const SPOTIFY_TRACK_URIS = [
  "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
  "spotify:track:7ouMYWpwJ422jRcDASZB7P",
  "spotify:track:3n3Ppam7vgaVa1iaRUc9Lp",
];

function parseProviderFilter() {
  const raw = String(process.env.FUZZ_PROVIDER || "all").trim().toLowerCase();
  if (raw === "all" || raw === "") return ALL_PROVIDERS;
  if (ALL_PROVIDERS.includes(raw)) return [raw];
  throw new Error(`Invalid FUZZ_PROVIDER=${JSON.stringify(raw)}; expected youtube|soundcloud|spotify|twitch|all`);
}

function buildSeedList() {
  const single = String(process.env.FUZZ_SEED || "").trim();
  if (single) {
    return [single];
  }
  const rawCount = Number(process.env.FUZZ_SEEDS);
  const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 50;
  const seeds = [];
  for (let i = 0; i < count; i++) {
    // Deterministic well-distributed hex seeds for readable FUZZ_SEED repro commands
    const mixed = ((Math.imul(i + 1, 2654435761) ^ 0x517cc1b7) >>> 0).toString(16).padStart(8, "0");
    seeds.push(`0x${mixed}`);
  }
  return seeds;
}

/**
 * Generates a pure declarative multi-peer chaos scenario from `seed` so it can be
 * executed deterministically and minimized directly by Zeller's `ddmin`.
 */
export function generateChaosScenario(seed, allowedProviders = ALL_PROVIDERS) {
  const prng = createPrng(seed);
  const provider = prng.pick(allowedProviders);
  const isPlaylist =
    provider === "twitch" ? false : prng.chance(0.45);
  const isTwitchLive = provider === "twitch" && prng.chance(0.25);

  const mediaUrl =
    provider === "twitch"
      ? isTwitchLive
        ? MEDIA_CATALOG.twitch.live
        : MEDIA_CATALOG.twitch.vod
      : isPlaylist
        ? MEDIA_CATALOG[provider].playlist
        : MEDIA_CATALOG[provider].single;

  const durationMs = provider === "twitch" ? 600_000 : 240_000;
  const peerCount = prng.int(2, 5);
  const topology = peerCount >= 3 && prng.chance(0.25) ? "chain" : "full-mesh";
  const horizonMs = prng.int(60_000, 180_000);
  const eventCount = prng.int(30, 150);

  const faultArchetype = prng.pick([
    "autoplay-blocked",
    "preview-30s",
    "errored",
    "sleepy",
    "high-jitter",
  ]);

  const peers = [];
  for (let i = 0; i < peerCount; i++) {
    const id = `p${i}`;
    let archetype = "fast-desktop";
    let wallSkewMs = prng.int(-2000, 2000);
    let clockDriftPpm = prng.int(-60, 60);
    let joinAtMs = 0;
    let autoplayBlocked = false;
    let previewMode = false;
    let slowSeekExtraMs = 0;
    let outOfOrderProb = 0;
    let keyframeSnapMs = 0;
    let cmdLatencyMs = prng.int(20, 45);
    let cmdLatencyJitterMs = prng.int(0, 10);
    let bufferMs = prng.int(70, 140);

    if (i === 1) {
      archetype = "slow-wifi-skew";
      wallSkewMs = prng.pick([-36_000_000, -180_000, 90_000, 72_000_000]);
      clockDriftPpm = prng.int(-500, 500);
      cmdLatencyMs = prng.int(55, 130);
      cmdLatencyJitterMs = prng.int(10, 30);
      bufferMs = prng.int(150, 280);
      if (provider === "youtube" && prng.chance(0.45)) {
        slowSeekExtraMs = prng.int(1200, 1650);
      }
      if (provider === "soundcloud") {
        outOfOrderProb = prng.float(0.35, 0.7);
      }
    } else if (i === 2) {
      archetype = faultArchetype;
      wallSkewMs = prng.int(-45_000, 45_000);
      if (faultArchetype === "autoplay-blocked") {
        autoplayBlocked = true;
      } else if (faultArchetype === "preview-30s" && (provider === "spotify" || provider === "soundcloud")) {
        previewMode = true;
      } else if (faultArchetype === "high-jitter") {
        cmdLatencyMs = prng.int(70, 140);
        cmdLatencyJitterMs = prng.int(20, 45);
        bufferMs = prng.int(180, 320);
      }
    } else if (i === 3) {
      archetype = "late-joiner";
      joinAtMs = prng.int(8_000, Math.min(35_000, Math.floor(horizonMs * 0.35)));
      wallSkewMs = prng.int(-60_000, 60_000);
      autoplayBlocked = prng.chance(0.5);
    } else if (i === 4) {
      archetype = "quirky-mobile";
      wallSkewMs = prng.int(-120_000, 120_000);
      keyframeSnapMs = prng.pick([0, 500, 1000]);
      cmdLatencyMs = prng.int(40, 100);
      cmdLatencyJitterMs = prng.int(5, 25);
    }

    peers.push({
      id,
      archetype,
      wallSkewMs,
      clockDriftPpm,
      joinAtMs,
      autoplayBlocked,
      previewMode,
      slowSeekExtraMs,
      outOfOrderProb,
      keyframeSnapMs,
      cmdLatencyMs,
      cmdLatencyJitterMs,
      bufferMs,
      unhydratedStubs: provider === "soundcloud" && isPlaylist && prng.chance(0.65),
      delayedBootPausedMs: provider === "spotify" ? prng.int(80, 260) : 0,
      updateCadenceMs: provider === "spotify" ? prng.int(350, 550) : 0,
    });
  }

  // Directed link configs
  const links = [];
  for (let i = 0; i < peers.length; i++) {
    for (let j = 0; j < peers.length; j++) {
      if (i === j) continue;
      const slowPeer = peers[i].archetype === "slow-wifi-skew" || peers[j].archetype === "slow-wifi-skew";
      links.push({
        from: peers[i].id,
        to: peers[j].id,
        latencyMs: slowPeer ? prng.int(50, 150) : prng.int(15, 55),
        jitterMs: slowPeer ? prng.int(10, 35) : prng.int(0, 12),
        dupProb: prng.chance(0.25) ? prng.float(0.01, 0.06) : 0,
        reorderProb: prng.chance(0.25) ? prng.float(0.02, 0.12) : 0,
      });
    }
  }

  // Generate weighted random events over [3000ms .. horizonMs]
  const events = [];
  let cursorMs = 3000;
  const avgStepMs = Math.max(400, Math.floor((horizonMs - 8000) / Math.max(1, eventCount)));
  const maxEventTimeMs = horizonMs - 6000;

  let hasActivePartition = false;
  let partitionedPeer = null;
  const erroredPeers = new Set();

  for (let idx = 0; idx < eventCount && cursorMs < maxEventTimeMs; idx++) {
    // Mix of spaced events and occasional fast-click bursts
    const stepMs = prng.chance(0.18)
      ? prng.int(120, 450)
      : prng.int(Math.max(350, Math.floor(avgStepMs * 0.4)), Math.max(600, Math.floor(avgStepMs * 1.5)));
    cursorMs = Math.min(maxEventTimeMs, cursorMs + stepMs);

    const activePeers = peers.filter((p) => p.joinAtMs === 0 || p.joinAtMs + 2500 < cursorMs);
    const nonPreviewPeers = activePeers.filter((p) => !p.previewMode && !p.autoplayBlocked);
    const actorPool = nonPreviewPeers.length > 0 ? nonPreviewPeers : activePeers;
    const actor = prng.pick(actorPool);

    const choices = [
      { value: "embed:clickSeek", weight: isTwitchLive ? 0 : 14 },
      { value: "embed:bufferedSeek", weight: provider === "youtube" || (provider === "twitch" && !isTwitchLive) ? 10 : 0 },
      { value: "embed:pausedSeek", weight: provider === "youtube" || (provider === "twitch" && !isTwitchLive) ? 6 : 0 },
      { value: "embed:dragScrub", weight: provider === "youtube" || (provider === "twitch" && !isTwitchLive) ? 6 : 0 },
      { value: "embed:play", weight: 8 },
      { value: "embed:pause", weight: 8 },
      { value: "embed:rapidToggle", weight: 6 },
      { value: "embed:selectPlaylistTrack", weight: isPlaylist ? 7 : 0 },
      { value: "ui:togglePlay", weight: 10 },
      { value: "ui:seekTo", weight: isTwitchLive ? 0 : 12 },
      { value: "ui:seekBy", weight: isTwitchLive ? 0 : 8 },
      { value: "ui:setRate", weight: provider === "youtube" ? 5 : 0 },
      { value: "ui:replay", weight: isTwitchLive ? 0 : 4 },
      { value: "ui:selectPlaylistTrack", weight: isPlaylist && provider !== "spotify" ? 6 : 0 },
      { value: "ui:enqueue", weight: 3 },
      { value: "local:volume", weight: 7 },
      { value: "local:mute", weight: 6 },
      { value: "local:reloadSession", weight: 5 },
      { value: "fault:rebuffer", weight: 6 },
      { value: "fault:sleep", weight: activePeers.length >= 2 && cursorMs < maxEventTimeMs - 9000 ? 4 : 0 },
      { value: "fault:error", weight: (provider === "youtube" || provider === "soundcloud") && activePeers.length >= 2 && erroredPeers.size === 0 ? 4 : 0 },
      { value: "fault:recover", weight: erroredPeers.size > 0 ? 12 : 0 },
      { value: "fault:snip", weight: (provider === "soundcloud" || provider === "spotify") && activePeers.length >= 2 ? 3 : 0 },
      { value: "fault:offline", weight: isTwitchLive && activePeers.length >= 2 ? 5 : 0 },
      { value: "net:partition", weight: activePeers.length >= 3 && !hasActivePartition && cursorMs < maxEventTimeMs - 10_000 ? 3 : 0 },
      { value: "net:heal", weight: hasActivePartition ? 16 : 0 },
      { value: "net:keepalive", weight: 4 },
    ];

    const kind = prng.weighted(choices);
    if (!kind) continue;

    const ev = { id: idx, tBase: cursorMs, kind, peerId: actor.id };

    if (
      kind === "embed:clickSeek" ||
      kind === "embed:bufferedSeek" ||
      kind === "embed:pausedSeek" ||
      kind === "embed:dragScrub" ||
      kind === "ui:seekTo"
    ) {
      // Keep targets well below track end so random seeks don't immediately hit EOF
      ev.targetMs = prng.int(4_000, Math.max(20_000, durationMs - 45_000));
      if (kind === "embed:clickSeek" && provider === "youtube") {
        ev.preBufferJump = prng.chance(0.8);
      }
    } else if (kind === "ui:seekBy") {
      ev.deltaMs = prng.pick([-15_000, -5_000, 5_000, 15_000, 30_000]);
    } else if (kind === "ui:setRate") {
      ev.rateMilli = prng.pick([750, 1000, 1250, 1500]);
    } else if (kind === "embed:rapidToggle") {
      ev.count = prng.pick([2, 3]);
      ev.intervalMs = prng.int(45, 95);
    } else if (kind === "embed:selectPlaylistTrack" || kind === "ui:selectPlaylistTrack") {
      if (provider === "spotify") {
        ev.trackUri = prng.pick(SPOTIFY_TRACK_URIS);
      } else {
        ev.playlistIndex = prng.int(0, 2);
      }
    } else if (kind === "ui:enqueue") {
      ev.url = MEDIA_CATALOG[provider].queue;
    } else if (kind === "local:volume") {
      ev.volume = prng.int(0, 100);
    } else if (kind === "local:mute") {
      ev.muted = prng.chance(0.5);
    } else if (kind === "fault:rebuffer") {
      ev.durationMs = prng.int(1200, 2800);
    } else if (kind === "fault:sleep") {
      const candidate = prng.pick(activePeers.slice(1));
      ev.peerId = candidate ? candidate.id : actor.id;
      ev.durationMs = prng.int(2800, 5500);
    } else if (kind === "fault:error") {
      const candidate = prng.pick(activePeers.slice(1));
      ev.peerId = candidate ? candidate.id : actor.id;
      ev.code = provider === "youtube" ? prng.pick([100, 101, 150, 153]) : "geo_error";
      erroredPeers.add(ev.peerId);
    } else if (kind === "fault:recover") {
      const targetId = [...erroredPeers][0];
      ev.peerId = targetId;
      erroredPeers.delete(targetId);
    } else if (kind === "fault:snip") {
      const candidate = prng.pick(activePeers.slice(1));
      ev.peerId = candidate ? candidate.id : actor.id;
      ev.omitFullDuration = prng.chance(0.5);
    } else if (kind === "fault:offline") {
      const candidate = prng.pick(activePeers.slice(1));
      ev.peerId = candidate ? candidate.id : actor.id;
      ev.durationMs = prng.int(1500, 3500);
    } else if (kind === "net:partition") {
      const victim = prng.pick(activePeers.slice(1));
      ev.peerId = victim.id;
      hasActivePartition = true;
      partitionedPeer = victim.id;
    } else if (kind === "net:heal") {
      ev.peerId = partitionedPeer || activePeers[activePeers.length - 1].id;
      hasActivePartition = false;
      partitionedPeer = null;
    }

    events.push(ev);
  }

  return {
    seed: String(seed),
    provider,
    mediaUrl,
    isPlaylist,
    isTwitchLive,
    durationMs,
    topology,
    horizonMs,
    quiescenceSettleMs: 6500,
    steadyWindowMs: 3500,
    peers,
    links,
    events,
  };
}

function buildPeerAdapterConfig(spec, scenario) {
  const base = {
    cmdLatencyMs: spec.cmdLatencyMs,
    cmdLatencyJitterMs: spec.cmdLatencyJitterMs,
    bufferMs: spec.bufferMs,
    keyframeSnapMs: spec.keyframeSnapMs,
    durationMs: scenario.durationMs,
    autoplayBlocked: spec.autoplayBlocked,
  };

  const yt = {
    ...base,
    slowSeekExtraMs: spec.slowSeekExtraMs,
    playlistIds: ["vidA1111111", "vidB2222222", "vidC3333333"],
  };

  const scSounds = SC_BASE_SOUNDS.map((s) =>
    spec.previewMode
      ? {
          ...s,
          duration: 30_000,
          policy: "SNIP",
          monetization_model: "SUB_HIGH_TIER",
        }
      : { ...s }
  );
  const sc = {
    ...base,
    postMessageDelayMs: 20,
    postMessageJitterMs: 10,
    outOfOrderProb: spec.outOfOrderProb,
    unhydratedStubs: spec.unhydratedStubs,
    sounds: scenario.isPlaylist ? scSounds : [scSounds[0]],
  };

  const sp = {
    ...base,
    delayedBootPausedMs: spec.delayedBootPausedMs || 150,
    updateCadenceMs: spec.updateCadenceMs || 450,
    previewMode: spec.previewMode,
    previewDurationMs: 29_713,
  };

  const tw = {
    ...base,
  };

  return { youtube: yt, soundcloud: sc, spotify: sp, twitch: tw };
}

/**
 * Executes a declarative chaos scenario through real `p2p_mesh.wasm`, `MediaSyncController`,
 * `WatchTogetherPlayer`, and async `FakeProviderAdapter`s, checking all 6 Layer 2 invariants.
 */
export async function runChaosScenario(scenario, { recordTimeline = false } = {}) {
  const room = new SimRoom({
    seed: scenario.seed,
    recordDebugToTimeline: recordTimeline,
  });

  try {
    const peerSpecsById = new Map(scenario.peers.map((p) => [p.id, p]));
    const joinedIds = new Set();
    const pendingLateJoiners = [];

    const connectPeerToJoined = (newId) => {
      const existing = [...joinedIds].filter((id) => id !== newId);
      if (existing.length === 0) return;
      if (scenario.topology === "chain") {
        room.connect(existing[existing.length - 1], newId);
      } else {
        for (const other of existing) {
          room.connect(other, newId);
        }
      }
    };

    // Configure directed links before connecting
    for (const l of scenario.links || []) {
      if (peerSpecsById.has(l.from) && peerSpecsById.has(l.to)) {
        room.setLink(l.from, l.to, {
          latencyMs: l.latencyMs,
          jitterMs: l.jitterMs,
          dupProb: l.dupProb,
          reorderProb: l.reorderProb,
        });
      }
    }

    // Boot initial peers (joinAtMs === 0)
    const initialPeers = scenario.peers.filter((p) => !p.joinAtMs);
    if (initialPeers.length === 0 && scenario.peers.length > 0) {
      initialPeers.push(scenario.peers[0]);
    }
    for (const spec of scenario.peers) {
      if (initialPeers.includes(spec)) {
        await room.addPeer(spec.id, {
          authorName: spec.id,
          wallSkewMs: spec.wallSkewMs,
          clockDriftPpm: spec.clockDriftPpm,
          adaptersConfig: buildPeerAdapterConfig(spec, scenario),
        });
        joinedIds.add(spec.id);
      } else {
        pendingLateJoiners.push(spec);
      }
    }

    if (scenario.topology === "chain") {
      room.connectChain([...joinedIds]);
    } else {
      room.connectFullMesh();
    }

    await room.clock.runUntilIdle(1500);
    room.sendKeepalivePings();
    await room.clock.runUntilIdle(1500);

    // Track permanent fault isolation windows for peers that start in preview/autoplay-blocked state
    const openFaultWindows = new Map(); // `${peerId}:${kind}` -> window
    const openFault = (peerId, kind) => {
      const key = `${peerId}:${kind}`;
      if (!openFaultWindows.has(key)) {
        openFaultWindows.set(key, room.recordFaultWindow(peerId, kind, room.clock.nowBaseMs, Infinity));
      }
    };
    const closeFault = (peerId, kind) => {
      const key = `${peerId}:${kind}`;
      const win = openFaultWindows.get(key);
      if (win) {
        win.endMs = Math.max(win.startMs, room.clock.nowBaseMs - 1);
        openFaultWindows.delete(key);
      }
    };

    // Start the Watch Together session from the first healthy peer
    const starter = room.getPeer(initialPeers[0].id);
    starter.startUrl(scenario.mediaUrl);
    await room.advanceAndSample(2600, 350);

    for (const spec of initialPeers) {
      if (spec.autoplayBlocked && (scenario.provider === "spotify" || scenario.provider === "soundcloud")) {
        openFault(spec.id, "autoplay-blocked");
      }
    }

    // Merge late-joiner arrivals with scenario events chronologically
    const schedule = [];
    for (const spec of pendingLateJoiners) {
      schedule.push({ tBase: spec.joinAtMs, kind: "__late_join__", peerId: spec.id, spec });
    }
    for (const ev of scenario.events) {
      if (peerSpecsById.has(ev.peerId)) {
        schedule.push(ev);
      }
    }
    schedule.sort((a, b) => a.tBase - b.tBase);

    let activePartitionVictim = null;
    let lastExplicitUserActionMs = -Infinity;
    let lastExplicitActor = "";
    const explicitActions = [];

    const recordChaosBoundary = (peerId, atMs = room.clock.nowBaseMs) => {
      lastExplicitUserActionMs = Math.max(lastExplicitUserActionMs, atMs);
      lastExplicitActor = String(peerId);
      // Superseding boundary marker closes the previous intent window cleanly
      explicitActions.push({ tBase: atMs, peerId });
    };

    const recordChaosIntent = (peerId, intent, isUi = false) => {
      const now = room.clock.nowBaseMs;
      const node = room.getPeer(peerId);
      if (!node || !node.isHealthy() || activePartitionVictim) {
        recordChaosBoundary(peerId, now);
        return;
      }
      const isConcurrentWithOtherPeer =
        now - lastExplicitUserActionMs < 900 && lastExplicitActor && lastExplicitActor !== String(peerId);
      if (now - lastExplicitUserActionMs < 900) {
        // Concurrent/rapid burst — replace previous close intent with a neutral boundary marker
        if (explicitActions.length > 0 && now - explicitActions[explicitActions.length - 1].tBase < 900) {
          const prev = explicitActions[explicitActions.length - 1];
          delete prev.playing;
          delete prev.positionMs;
        }
      }
      lastExplicitUserActionMs = Math.max(lastExplicitUserActionMs, now);
      lastExplicitActor = String(peerId);
      const isSlowActorUi =
        isUi && ((peerSpecsById.get(peerId)?.slowSeekExtraMs || 0) > 400);
      if (isConcurrentWithOtherPeer || isSlowActorUi) {
        // Concurrent cross-peer actions resolve via CRDT LWW (rev, actor); slow-seek UI actors
        // have >1s local SDK execution lag before moving. Record boundary while Invariant 2/3 verify convergence.
        explicitActions.push({ tBase: now, peerId });
        return;
      }
      explicitActions.push({
        tBase: now,
        peerId,
        ...intent,
      });
    };

    for (const ev of schedule) {
      const targetTime = Math.max(room.clock.nowBaseMs, ev.tBase);
      if (targetTime > room.clock.nowBaseMs) {
        await room.advanceAndSample(targetTime - room.clock.nowBaseMs, 500);
      }

      if (ev.kind === "__late_join__") {
        const spec = ev.spec;
        await room.addPeer(spec.id, {
          authorName: spec.id,
          wallSkewMs: spec.wallSkewMs,
          clockDriftPpm: spec.clockDriftPpm,
          adaptersConfig: buildPeerAdapterConfig(spec, scenario),
        });
        joinedIds.add(spec.id);
        connectPeerToJoined(spec.id);
        if (spec.autoplayBlocked && (scenario.provider === "spotify" || scenario.provider === "soundcloud")) {
          openFault(spec.id, "autoplay-blocked");
        }
        continue;
      }

      if (!joinedIds.has(ev.peerId)) continue;
      const node = room.getPeer(ev.peerId);
      if (!node) continue;
      const wasmSt = node.getWasmState("watch");
      const adapter = node.activeAdapter();
      const snap = adapter?.snapshot();

      // Close any error fault window automatically if a playlist track switch cleared the error
      if (snap && !snap.errored) {
        for (const [k, win] of openFaultWindows.entries()) {
          if (k.startsWith(`${node.peerId}:error:`)) {
            win.endMs = Math.max(win.startMs, room.clock.nowBaseMs - 1);
            openFaultWindows.delete(k);
          }
        }
      }

      // Skip user actions on currently faulty/sleeping/stalled/unready peers (they are fault-isolated!)
      const isUserAction = ev.kind.startsWith("embed:") || ev.kind.startsWith("ui:");
      if (isUserAction) {
        if (
          !wasmSt ||
          !wasmSt.active ||
          !snap ||
          !snap.ready ||
          snap.stalled ||
          !node.isHealthy(wasmSt, snap)
        ) {
          continue;
        }
      }

      switch (ev.kind) {
        case "embed:clickSeek": {
          const isPreviewCap =
            Boolean(snap.isPreview || node.getPlayer()?.providerNotice?.isPreview) &&
            ev.targetMs >= 28_000;
          if (isPreviewCap) {
            // Seeking past the 30s cap on a SNIP/preview peer hits its preview end; execute it
            // to verify zero room disruption and mark boundary for prior peer intents.
            node.embedClickSeek(ev.targetMs, { preBufferJump: ev.preBufferJump !== false });
            recordChaosBoundary(node.peerId);
            break;
          }
          const preJump = ev.preBufferJump !== false;
          node.embedClickSeek(ev.targetMs, { preBufferJump: preJump });
          const after = node.activeAdapter().snapshot();
          const targetPos = preJump
            ? after.positionMs
            : node.activeAdapter()._applyKeyframeSnap(ev.targetMs);
          recordChaosIntent(node.peerId, {
            playing: Boolean(snap.playing || snap.buffering),
            positionMs: targetPos,
            rateMilli: wasmSt.rateMilli || 1000,
          });
          break;
        }
        case "embed:bufferedSeek": {
          if (!snap.playing) break;
          node.embedBufferedSeek(ev.targetMs);
          const after = node.activeAdapter().snapshot();
          recordChaosIntent(node.peerId, {
            playing: true,
            positionMs: after.positionMs,
            rateMilli: wasmSt.rateMilli || 1000,
          });
          break;
        }
        case "embed:pausedSeek": {
          if (snap.playing) break;
          node.embedPausedSeek(ev.targetMs);
          const after = node.activeAdapter().snapshot();
          recordChaosIntent(node.peerId, {
            playing: false,
            positionMs: after.positionMs,
            rateMilli: wasmSt.rateMilli || 1000,
          });
          break;
        }
        case "embed:dragScrub": {
          node.embedDragScrub(ev.targetMs, { dragMs: 220 });
          recordChaosBoundary(node.peerId, room.clock.nowBaseMs);
          recordChaosBoundary(node.peerId, room.clock.nowBaseMs + 240);
          break;
        }
        case "embed:play": {
          if (snap.playing || snap.buffering) break;
          node.embedPlay();
          const after = node.activeAdapter().snapshot();
          recordChaosIntent(node.peerId, {
            playing: true,
            ...(scenario.isTwitchLive ? {} : { positionMs: after.positionMs }),
            rateMilli: wasmSt.rateMilli || 1000,
          });
          break;
        }
        case "embed:pause": {
          if (!snap.playing) break;
          const unconverged = Boolean(node.getPlayer() && !node.getPlayer().negotiator.convergedToRev);
          const expectedRoomMs = projectMediaPositionMs(wasmSt, node.clock.wallNow());
          node.embedPause();
          const after = node.activeAdapter().snapshot();
          const intentPos =
            unconverged && Math.abs(after.positionMs - expectedRoomMs) > 2200
              ? expectedRoomMs
              : after.positionMs;
          recordChaosIntent(
            node.peerId,
            {
              playing: false,
              ...(scenario.isTwitchLive ? {} : { positionMs: intentPos }),
              rateMilli: wasmSt.rateMilli || 1000,
            },
            unconverged
          );
          break;
        }
        case "embed:rapidToggle": {
          node.embedRapidToggle(ev.count || 2, ev.intervalMs || 65);
          recordChaosBoundary(node.peerId, room.clock.nowBaseMs);
          lastExplicitUserActionMs = Math.max(
            lastExplicitUserActionMs,
            room.clock.nowBaseMs + (ev.count || 2) * (ev.intervalMs || 65)
          );
          lastExplicitActor = node.peerId;
          break;
        }
        case "embed:selectPlaylistTrack": {
          if (scenario.provider === "spotify") {
            node.embedSelectPlaylistTrack(ev.trackUri || SPOTIFY_TRACK_URIS[0]);
          } else {
            node.embedSelectPlaylistTrack(ev.playlistIndex ?? 0);
          }
          recordChaosBoundary(node.peerId);
          break;
        }
        case "ui:togglePlay": {
          const nextPlaying = !wasmSt.playing;
          const posMs = projectMediaPositionMs(wasmSt, node.clock.wallNow());
          node.togglePlay();
          recordChaosIntent(
            node.peerId,
            {
              playing: nextPlaying,
              ...(scenario.isTwitchLive ? {} : { positionMs: posMs }),
              rateMilli: wasmSt.rateMilli || 1000,
            },
            true
          );
          break;
        }
        case "ui:seekTo": {
          node.seekTo(ev.targetMs);
          const expectedPos =
            scenario.provider === "spotify" ? Math.floor(ev.targetMs / 1000) * 1000 : ev.targetMs;
          recordChaosIntent(
            node.peerId,
            {
              playing: Boolean(wasmSt.playing),
              positionMs: expectedPos,
              rateMilli: wasmSt.rateMilli || 1000,
            },
            true
          );
          break;
        }
        case "ui:seekBy": {
          const curPos = projectMediaPositionMs(wasmSt, node.clock.wallNow());
          const target = Math.max(0, Math.min(scenario.durationMs - 10_000, curPos + ev.deltaMs));
          node.seekTo(target);
          const expectedPos =
            scenario.provider === "spotify" ? Math.floor(target / 1000) * 1000 : target;
          recordChaosIntent(
            node.peerId,
            {
              playing: Boolean(wasmSt.playing),
              positionMs: expectedPos,
              rateMilli: wasmSt.rateMilli || 1000,
            },
            true
          );
          break;
        }
        case "ui:setRate": {
          node.setPlaybackRate(ev.rateMilli || 1000);
          recordChaosBoundary(node.peerId);
          break;
        }
        case "ui:replay": {
          node.replay();
          recordChaosIntent(node.peerId, { playing: true, positionMs: 0, rateMilli: wasmSt.rateMilli || 1000 }, true);
          break;
        }
        case "ui:selectPlaylistTrack": {
          node.selectPlaylistTrack(ev.playlistIndex ?? 0);
          recordChaosBoundary(node.peerId);
          break;
        }
        case "ui:enqueue": {
          if (
            lastExplicitActor &&
            node.peerId !== lastExplicitActor &&
            room.clock.nowBaseMs - lastExplicitUserActionMs < 1500
          ) {
            recordChaosBoundary(node.peerId);
          }
          node.enqueue(ev.url || MEDIA_CATALOG[scenario.provider].queue);
          break;
        }
        case "local:volume": {
          await room.runLocalOnly(
            node.peerId,
            "volume",
            () => {
              node.setLocalVolume(ev.volume ?? 50);
            },
            0
          );
          break;
        }
        case "local:mute": {
          await room.runLocalOnly(
            node.peerId,
            "mute",
            () => {
              node.setLocalMuted(Boolean(ev.muted));
            },
            0
          );
          break;
        }
        case "local:reloadSession": {
          if (!wasmSt || !wasmSt.active) break;
          if (node.peerId === lastExplicitActor) {
            recordChaosBoundary(node.peerId);
          }
          await room.runLocalOnly(
            node.peerId,
            "reloadPlayerSession",
            async () => {
              await node.reloadPlayerSession({ reason: "manual" });
            },
            0
          );
          break;
        }
        case "fault:rebuffer": {
          // Network rebuffering only happens while actively playing
          if (!snap?.playing) break;
          // Injecting a local stall on the current intent actor legitimately freezes its playhead
          // until correctDrift catches it up; close the actor's pre-stall yank window cleanly.
          if (node.peerId === lastExplicitActor) {
            recordChaosBoundary(node.peerId);
          }
          node.injectRebuffer(ev.durationMs || 1800);
          break;
        }
        case "fault:sleep": {
          if (
            !node.isSleeping() &&
            !snap?.buffering &&
            (node.peerId !== lastExplicitActor || room.clock.nowBaseMs - lastExplicitUserActionMs > 500)
          ) {
            if (node.peerId === lastExplicitActor) {
              recordChaosBoundary(node.peerId);
            }
            const win = node.sleepFor(ev.durationMs || 3500, { freezePlayhead: true });
            room.recordFaultWindow(node.peerId, "tab-sleep", win.startMs, win.endMs);
          }
          break;
        }
        case "fault:error": {
          if (node.peerId === lastExplicitActor) {
            recordChaosBoundary(node.peerId);
          }
          openFault(node.peerId, `error:${ev.code}`);
          node.injectError(ev.code);
          break;
        }
        case "fault:recover": {
          if (node.isSleeping() || !snap?.errored) break;
          closeFault(node.peerId, `error:${ev.code}`);
          // Close any open error fault window for this peer
          for (const [k, win] of openFaultWindows.entries()) {
            if (k.startsWith(`${node.peerId}:error:`)) {
              win.endMs = Math.max(win.startMs, room.clock.nowBaseMs - 1);
              openFaultWindows.delete(k);
            }
          }
          if (scenario.provider === "youtube") {
            node.recoverFromError(YT_STATE.CUED);
          } else if (scenario.provider === "soundcloud") {
            node.adapters.soundcloud.errored = false;
            node.adapters.soundcloud.blocked = false;
            await room.runLocalOnly(
              node.peerId,
              "recover-reload",
              async () => {
                await node.reloadPlayerSession({ reason: "recover" });
              },
              20
            );
          }
          break;
        }
        case "fault:snip": {
          if (node.peerId === lastExplicitActor) {
            recordChaosBoundary(node.peerId);
          }
          if (scenario.provider === "soundcloud") {
            // SoundCloud SNIP policy is reported by getCurrentSound() on mount/track load;
            // mark tracks SNIP then reload the local widget so policy metadata is hydrated cleanly.
            const scAdapter = node.adapters.soundcloud;
            for (const target of scAdapter.sounds) {
              target.policy = "SNIP";
              target.duration = 30_000;
              if (ev.omitFullDuration) delete target.full_duration;
              else target.full_duration = 240_000;
              target.monetization_model = "SUB_HIGH_TIER";
              target.playable = true;
            }
            if (wasmSt && wasmSt.active) {
              await room.runLocalOnly(
                node.peerId,
                "snip-reload",
                async () => {
                  await node.reloadPlayerSession({ reason: "snip" });
                },
                0
              );
            }
          } else {
            node.injectSnip({
              previewDurationMs: 29_713,
              omitFullDuration: Boolean(ev.omitFullDuration),
            });
          }
          break;
        }
        case "fault:offline": {
          if (scenario.isTwitchLive && !node.adapters.twitch.offline) {
            const startMs = room.clock.nowBaseMs;
            node.injectOffline();
            const dur = Math.max(500, ev.durationMs || 2000);
            room.recordFaultWindow(node.peerId, "twitch-offline", startMs, startMs + dur - 1);
            room.clock.schedule(dur, () => {
              if (!node.destroyed) {
                node.injectOnline();
                if (node.getWasmState()?.playing) {
                  node.embedPlay();
                }
              }
            });
          }
          break;
        }
        case "net:partition": {
          if (!activePartitionVictim && joinedIds.size >= 3) {
            const joinedList = [...joinedIds];
            // On a linear chain topology, partition a leaf peer so healing reconnects cleanly via Hello
            const victimId =
              scenario.topology === "chain" ? joinedList[joinedList.length - 1] : node.peerId;
            const others = joinedList.filter((id) => id !== victimId);
            room.partition(others, [victimId]);
            activePartitionVictim = victimId;
          }
          break;
        }
        case "net:heal": {
          if (activePartitionVictim) {
            const victim = activePartitionVictim;
            room.healAll();
            recordChaosBoundary("net");
            for (const other of joinedIds) {
              if (other !== victim && room.net.isConnected(other, victim)) {
                room.disconnect(other, victim);
                room.connect(other, victim);
              }
            }
            activePartitionVictim = null;
          }
          break;
        }
        case "net:keepalive": {
          room.sendKeepalivePings();
          break;
        }
        default:
          break;
      }
    }

    // Ensure any lingering partition is healed before quiescence so convergence is always testable
    if (activePartitionVictim) {
      await room.advanceAndSample(100, 100);
      const victim = activePartitionVictim;
      room.healAll();
      for (const other of joinedIds) {
        if (other !== victim && room.net.isConnected(other, victim)) {
          room.disconnect(other, victim);
          room.connect(other, victim);
        }
      }
      activePartitionVictim = null;
    }

    // Quiescence settle phase: let in-flight wire frames, slow seeks, tab-wakes, and resync-local settle
    await room.advanceAndSample(scenario.quiescenceSettleMs || 6500, 400);

    // Steady-state observation window (Invariant 3: 0 MediaSync wire churn, <= 2 adapter cmds/peer)
    const steadyStartMs = room.clock.nowBaseMs;
    await room.advanceAndSample(scenario.steadyWindowMs || 3500, 400);
    const steadyEndMs = room.clock.nowBaseMs;

    // Close open fault windows at steadyEndMs
    for (const win of openFaultWindows.values()) {
      win.endMs = steadyEndMs;
    }

    // Populate userIntents from explicitActions (filtering out actions superseded too fast)
    room.userIntents = explicitActions;

    // Evaluate all 6 universal invariants
    const preResults = room.evaluatePreTeardownInvariants({
      steadyStartMs,
      steadyEndMs,
      requireActive: true,
      maxYankMs: 1500,
      convergenceBudgetMs: 6500,
      convergenceToleranceMs: 2200,
      spotifyConvergenceToleranceMs: 3000,
      yankGraceAfterActionMs: 700,
      maxMediaSyncWireUpdates: 0,
      maxAdapterCmdsPerPeer: 2,
      checkIntent: !scenario.isTwitchLive,
    });

    const inv6 = room.destroyAndCheckTimerHygiene();
    const allResults = [...preResults, inv6];
    const failed = allResults.filter((r) => !r.ok);

    return {
      ok: failed.length === 0,
      failed: failed.length > 0,
      results: allResults,
      failedResults: failed,
      reason: failed.map((r) => r.summary).join(" | "),
      timeline: room.timeline,
    };
  } catch (err) {
    room.destroy();
    return {
      ok: false,
      failed: true,
      results: [],
      failedResults: [{ invariant: "Exception", summary: err.message, violations: [{ code: "exception", message: err.stack || err.message }] }],
      reason: `Exception: ${err.message}`,
      timeline: room.timeline,
    };
  }
}

async function persistCounterexample(seed, reproCmd, dumpText, shrunkScenario) {
  const outDir = String(process.env.FUZZ_OUT_DIR || "").trim();
  if (!outDir) return;
  try {
    await mkdir(outDir, { recursive: true });
    const safeSeed = String(seed).replace(/[^a-zA-Z0-9_-]/g, "_");
    await writeFile(
      join(outDir, `counterexample-${safeSeed}.json`),
      JSON.stringify({ seed, reproCmd, shrunkScenario }, null, 2),
      "utf8"
    );
    await writeFile(
      join(outDir, `counterexample-${safeSeed}.txt`),
      `${reproCmd}\n\n${dumpText}\n`,
      "utf8"
    );
  } catch {
    // best-effort artifact export
  }
}

/* ==================== Chaos Fuzz Test Suite ==================== */

test("fuzz(watch_chaos): seeded multi-peer chaos across all providers enforces all 6 universal invariants", async () => {
  const allowedProviders = parseProviderFilter();
  const seeds = buildSeedList();
  const isSingleSeedRepro = Boolean(String(process.env.FUZZ_SEED || "").trim());

  const stats = {
    total: seeds.length,
    byProvider: { youtube: 0, soundcloud: 0, spotify: 0, twitch: 0 },
  };
  const startedAt = performance.now();

  for (const seed of seeds) {
    const scenario = generateChaosScenario(seed, allowedProviders);
    stats.byProvider[scenario.provider] = (stats.byProvider[scenario.provider] || 0) + 1;

    const outcome = await runChaosScenario(scenario, {
      recordTimeline: isSingleSeedRepro,
    });

    if (outcome.failed) {
      // Shrink failing scenario with Zeller's ddmin for minimal actionable repro!
      const shrinkRes = await ddmin(
        scenario,
        (cand) => runChaosScenario(cand, { recordTimeline: false }),
        { maxEvaluations: 120, minPeers: 2, minEvents: 0 }
      );
      const minimal = shrinkRes.shrunk;
      const finalRun = await runChaosScenario(minimal, { recordTimeline: true });
      const providerEnv = allowedProviders.length === 1 ? ` FUZZ_PROVIDER=${allowedProviders[0]}` : "";
      const reproCmd = `FUZZ_SEED=${seed}${providerEnv} node --test tests/fuzz/watch_chaos.test.mjs`;
      const dump = formatReproDump({
        seed,
        scenario,
        shrunk: minimal,
        failure: finalRun.reason || outcome.reason,
        timeline: finalRun.timeline,
      });

      await persistCounterexample(seed, reproCmd, dump, minimal);

      assert.fail(
        `Chaos fuzz failure on seed=${seed} (provider=${scenario.provider})\n` +
          `Repro: ${reproCmd}\n` +
          `Original failure: ${outcome.reason}\n` +
          `Shrunk: ${shrinkRes.originalSize?.peers ?? scenario.peers.length}p/${shrinkRes.originalSize?.events ?? scenario.events.length}ev -> ` +
          `${shrinkRes.shrunkSize?.peers ?? minimal.peers.length}p/${shrinkRes.shrunkSize?.events ?? minimal.events.length}ev (${shrinkRes.evaluations} evals)\n\n` +
          dump
      );
    }
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  // Sanity check that multi-provider coverage actually occurred when running default all-provider sweeps
  if (!isSingleSeedRepro && allowedProviders.length === 4 && seeds.length >= 20) {
    for (const p of ALL_PROVIDERS) {
      assert.ok(stats.byProvider[p] > 0, `Expected seeds covering provider ${p}`);
    }
  }
  console.log(
    `[watch_chaos] PASS ${stats.total} seed(s) in ${elapsedMs}ms (${(elapsedMs / stats.total).toFixed(1)}ms/seed) — coverage: ${JSON.stringify(stats.byProvider)}`
  );
});

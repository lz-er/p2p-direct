/**
 * Layer 3 Golden Browser Trace Replay Suite (`p2p-direct-watch-trace-v1`).
 *
 * Auto-discovers every `*.json` fixture in `tests/traces/fixtures/` (matching the exact
 * schema exported by Advanced Mode -> Watch Diagnostics -> Export Trace in `app.js` /
 * `WatchTraceRecorder.exportTrace()`), validates schema & zero-secrets sanitization, and
 * replays each trace chronologically on `VirtualClock` through the real production stack:
 *   real `p2p_mesh.wasm` + real `MediaSyncController` + real `WatchTogetherPlayer`
 * paired with a healthy remote observer peer and live 333ms 3 Hz polling + 1200ms
 * `correctDrift` ticks, asserting all applicable Layer 2 universal invariants.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { SimRoom } from "../harness/wasm_peer_node.mjs";
import { YT_STATE } from "../harness/fake_providers/youtube_adapter.mjs";
import { assertAllInvariants } from "../harness/invariants.mjs";
import { projectMediaPositionMs } from "../../watch_together.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

const REQUIRED_GOLDEN_FIXTURES = [
  "youtube_click_seek_pre_buffering.json",
  "youtube_buffered_seek_with_drift.json",
  "youtube_offline_rebuffer_stall.json",
  "youtube_error_150_and_recovery.json",
  "soundcloud_fast_click_async_race.json",
  "soundcloud_go_plus_snip_30s_end.json",
  "spotify_delayed_harmony_preview_reload.json",
  "twitch_vod_silent_seek_and_blocked.json",
];

const FORBIDDEN_SECRET_PATTERNS = [
  /passphrase/i,
  /roomSecret/i,
  /a=ice-pwd:/i,
  /a=fingerprint:/i,
  /c=IN IP4/i,
  /Bearer\s+[A-Za-z0-9._-]{12,}/,
  /Cookie:/i,
];

function reconstructMediaUrl(provider, mediaId, playlistId = "") {
  if (provider === "youtube" || provider === "ytmusic") {
    const host = provider === "ytmusic" ? "https://music.youtube.com" : "https://www.youtube.com";
    if (playlistId) {
      return `${host}/watch?v=${encodeURIComponent(mediaId || "dQw4w9WgXcQ")}&list=${encodeURIComponent(playlistId)}`;
    }
    if (String(mediaId || "").startsWith("ytpl:")) {
      return `${host}/playlist?list=${encodeURIComponent(String(mediaId).slice(5))}`;
    }
    return `${host}/watch?v=${encodeURIComponent(mediaId || "dQw4w9WgXcQ")}`;
  }
  if (provider === "soundcloud") {
    return String(playlistId || mediaId || "https://soundcloud.com/simartist/track");
  }
  if (provider === "spotify") {
    const uri = String(playlistId || mediaId || "spotify:track:4cOdK2wGLETKBW3PvgPWqT");
    const m = /^spotify:(track|playlist|album|episode|show):([A-Za-z0-9]+)$/.exec(uri);
    if (m) return `https://open.spotify.com/${m[1]}/${m[2]}`;
    return "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT";
  }
  if (provider === "twitch") {
    const id = String(mediaId || "video:12345678");
    if (id.startsWith("video:")) return `https://www.twitch.tv/videos/${id.slice(6)}`;
    if (id.startsWith("channel:")) return `https://www.twitch.tv/${id.slice(8)}`;
    if (id.startsWith("collection:")) return `https://www.twitch.tv/collections/${id.slice(11)}`;
    return "https://www.twitch.tv/videos/12345678";
  }
  throw new Error(`Unsupported provider in trace fixture: ${provider}`);
}

/**
 * Validates that a parsed fixture strictly matches `WatchTraceRecorder.exportTrace()`
 * (`schema: "p2p-direct-watch-trace-v1"`) and contains zero leaked secrets/PII.
 */
export function validateTraceSchema(trace, rawText, filename) {
  assert.equal(trace.schema, "p2p-direct-watch-trace-v1", `${filename}: schema mismatch`);
  assert.equal(typeof trace.exportedAtMs, "number", `${filename}: exportedAtMs must be number`);
  assert.equal(typeof trace.exportedAtIso, "string", `${filename}: exportedAtIso must be string`);
  assert.ok(!Number.isNaN(Date.parse(trace.exportedAtIso)), `${filename}: exportedAtIso must be valid ISO date`);
  assert.equal(typeof trace.appVersion, "string", `${filename}: appVersion must be string`);
  assert.ok(trace.appVersion.length > 0, `${filename}: appVersion must be non-empty`);
  assert.equal(typeof trace.peerId, "string", `${filename}: peerId must be string`);
  assert.ok(trace.peerId.length > 0, `${filename}: peerId must be non-empty`);
  assert.equal(typeof trace.maxEntries, "number", `${filename}: maxEntries must be number`);
  assert.equal(typeof trace.dropped, "number", `${filename}: dropped must be number`);
  assert.ok(Array.isArray(trace.entries), `${filename}: entries must be array`);
  assert.equal(trace.count, trace.entries.length, `${filename}: count must match entries.length`);
  assert.ok(trace.entries.length >= 6, `${filename}: fixture must contain realistic multi-step entries`);
  assert.ok(trace.watchState && typeof trace.watchState === "object", `${filename}: watchState required`);
  assert.equal(typeof trace.watchState.provider, "string", `${filename}: watchState.provider required`);
  assert.equal(typeof trace.watchState.mediaId, "string", `${filename}: watchState.mediaId required`);
  assert.equal(typeof trace.watchState.rev, "number", `${filename}: watchState.rev required`);
  assert.ok(
    trace.watchNotice === null || typeof trace.watchNotice === "object",
    `${filename}: watchNotice must be null or object`
  );

  let prevSeq = 0;
  let prevPerf = -Infinity;
  for (const e of trace.entries) {
    assert.equal(typeof e.seq, "number", `${filename}: entry.seq must be number`);
    assert.ok(e.seq > prevSeq, `${filename}: entry.seq must strictly increase`);
    prevSeq = e.seq;
    assert.equal(typeof e.tPerf, "number", `${filename}: entry.tPerf must be number`);
    assert.ok(e.tPerf >= prevPerf, `${filename}: entry.tPerf must be monotonic`);
    prevPerf = e.tPerf;
    assert.equal(typeof e.tWall, "number", `${filename}: entry.tWall must be number`);
    assert.equal(typeof e.src, "string", `${filename}: entry.src must be string`);
    assert.ok(
      e.dir === "in" || e.dir === "out" || e.dir === "internal",
      `${filename}: invalid entry.dir=${e.dir}`
    );
    assert.equal(typeof e.ev, "string", `${filename}: entry.ev must be string`);
    assert.ok("data" in e, `${filename}: entry.data key required`);
    assert.ok("getters" in e, `${filename}: entry.getters key required`);
  }

  for (const pat of FORBIDDEN_SECRET_PATTERNS) {
    assert.ok(!pat.test(rawText), `${filename}: contains forbidden secret/PII pattern ${pat}`);
  }
}

/**
 * Inspects a golden trace to derive realistic subject/observer adapter profiles
 * (e.g., SoundCloud SNIP 30s policy, Spotify 30s preview + autoplay block + delayed Harmony boot,
 * Twitch PLAYBACK_BLOCKED, SoundCloud playlist tracks) without hardcoding fixture filenames.
 */
function inferAdapterProfiles(trace) {
  const entries = trace.entries;
  const provider = trace.watchState.provider;
  const notice = trace.watchNotice || null;

  const isScSnip = Boolean(
    provider === "soundcloud" && (notice?.code === "SNIP" || notice?.isPreview)
  );
  const hasScPlaylist = Boolean(
    provider === "soundcloud" &&
      (trace.watchState.playlistId ||
        entries.some((e) => Number(e.data?.playlistIndex) > 0 || e.getters?.playlistIndex > 0))
  );
  const isSpPreview = Boolean(
    provider === "spotify" &&
      (notice?.isPreview ||
        entries.some(
          (e) =>
            e.src === "spotify" &&
            e.ev === "playback_update" &&
            Number(e.data?.durMs) > 0 &&
            Number(e.data?.durMs) <= 35_000
        ))
  );
  const spAutoplayBlocked = Boolean(
    provider === "spotify" &&
      entries.some(
        (e) =>
          e.src === "spotify" &&
          e.ev === "playback_update" &&
          e.data?.playing === false &&
          e.getters?.awaitingInitialSettle === true
      )
  );
  const twAutoplayBlocked = Boolean(
    provider === "twitch" && entries.some((e) => e.src === "twitch" && e.ev === "PLAYBACK_BLOCKED")
  );
  const hasScFastClick = Boolean(
    provider === "soundcloud" &&
      entries.some((e) => e.src === "soundcloud" && e.ev === "PAUSE") &&
      entries.some((e) => e.src === "soundcloud" && e.ev === "PLAY")
  );

  // Collect SoundCloud soundIds observed in trace to hydrate realistic playlist sounds
  const seenSoundIds = [];
  for (const e of entries) {
    const sid = Number(e.data?.soundId);
    if (Number.isFinite(sid) && sid > 0 && !seenSoundIds.includes(sid)) {
      seenSoundIds.push(sid);
    }
  }
  const soundIds = seenSoundIds.length >= 2 ? seenSoundIds : [seenSoundIds[0] || 501, (seenSoundIds[0] || 501) + 1];
  const fullScSounds = soundIds.map((id, i) => ({
    id,
    title: `Track ${i + 1}`,
    user: { username: "SimDJ" },
    duration: 215_000 - i * 15_000,
    policy: "ALLOW",
    playable: true,
  }));
  const snipScSounds = soundIds.map((id, i) => ({
    id,
    title: `Go+ Preview Track ${i + 1}`,
    user: { username: "SimDJ" },
    duration: 30_000,
    full_duration: 215_000 - i * 15_000,
    policy: "SNIP",
    monetization_model: "SUB_HIGH_TIER",
    playable: true,
  }));

  const subjectAdapters = {
    youtube: { cmdLatencyMs: 30, cmdLatencyJitterMs: 5, bufferMs: 140 },
    soundcloud: {
      cmdLatencyMs: 45,
      cmdLatencyJitterMs: 10,
      outOfOrderProb: hasScFastClick ? 0.4 : 0.15,
      unhydratedStubs: hasScPlaylist || isScSnip,
      sounds: isScSnip ? snipScSounds : fullScSounds,
    },
    spotify: {
      previewMode: isSpPreview,
      previewDurationMs: 29_713,
      autoplayBlocked: spAutoplayBlocked,
      delayedBootPausedMs: spAutoplayBlocked ? 200 : 120,
      cmdLatencyMs: 40,
      updateCadenceMs: 430,
    },
    twitch: {
      autoplayBlocked: twAutoplayBlocked,
      cmdLatencyMs: 30,
      cmdLatencyJitterMs: 5,
    },
  };

  const remoteAdapters = {
    youtube: { cmdLatencyMs: 35, cmdLatencyJitterMs: 5, bufferMs: 130 },
    soundcloud: {
      cmdLatencyMs: 30,
      cmdLatencyJitterMs: 5,
      sounds: fullScSounds,
    },
    spotify: {
      previewMode: false,
      autoplayBlocked: false,
      cmdLatencyMs: 30,
      updateCadenceMs: 420,
    },
    twitch: {
      autoplayBlocked: false,
      cmdLatencyMs: 30,
      cmdLatencyJitterMs: 5,
    },
  };

  return {
    subjectAdapters,
    remoteAdapters,
    isScSnip,
    isSpPreview,
    spAutoplayBlocked,
    twAutoplayBlocked,
  };
}

/**
 * Replays a `p2p-direct-watch-trace-v1` golden trace chronologically on `VirtualClock`
 * through real `p2p_mesh.wasm` + real `MediaSyncController` + real `WatchTogetherPlayer`
 * with live 333ms polling & 1200ms `correctDrift` ticks, then asserts all applicable invariants.
 */
async function replayGoldenTrace(trace, filename) {
  const provider = trace.watchState.provider;
  const entries = trace.entries;
  const firstEntry = entries[0];
  const basePerf = firstEntry.tPerf;
  const baseWall = firstEntry.tWall;
  const profiles = inferAdapterProfiles(trace);

  const room = new SimRoom({
    seed: `trace-replay-${filename}`,
    startWallMs: baseWall,
  });

  const subjectId = trace.peerId || "peer-subject";
  const remoteId =
    entries.find(
      (e) =>
        e.src === "controller" &&
        e.ev === "handleIncomingMediaSync" &&
        e.data?.source === "remote" &&
        e.data?.actor &&
        e.data.actor !== subjectId
    )?.data?.actor || "peer-remote";

  await room.addPeer(subjectId, {
    authorName: "Subject",
    enableTraceRecorder: true,
    adaptersConfig: profiles.subjectAdapters,
  });
  await room.addPeer(remoteId, {
    authorName: "Remote",
    adaptersConfig: profiles.remoteAdapters,
  });

  room.connectFullMesh({ latencyMs: 38, jitterMs: 4 });
  await room.clock.runUntilIdle(1500);
  room.sendKeepalivePings();
  await room.clock.runUntilIdle(1500);

  const subject = room.getPeer(subjectId);
  const remote = room.getPeer(remoteId);
  const bootOffsetMs = room.clock.nowBaseMs;

  const mediaUrl = reconstructMediaUrl(
    provider,
    trace.watchState.mediaId,
    trace.watchState.playlistId
  );

  // Track open fault windows and expected user actions derived strictly from trace entries
  let activeErrorWindow = null;
  let activeRebufferEndPerf = -1;
  let mediaStarted = false;
  let lastYtBufferEntry = null;
  let subjectWasFaultedPermanently = false;
  let permanentFaultStartMs = null;

  // Pre-scan for YouTube BUFFERING -> PLAYING pairs to distinguish click-seek vs rebuffer stall
  const ytBufferDurationBySeq = new Map();
  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i];
    if (cur.src === "youtube" && cur.dir === "in" && cur.ev === "onStateChange" && cur.data?.code === 3) {
      for (let j = i + 1; j < entries.length; j++) {
        const nxt = entries[j];
        if (
          nxt.src === "youtube" &&
          nxt.dir === "in" &&
          nxt.ev === "onStateChange" &&
          (nxt.data?.code === 1 || nxt.data?.code === 2)
        ) {
          ytBufferDurationBySeq.set(cur.seq, {
            endSeq: nxt.seq,
            durationMs: Math.max(20, nxt.tPerf - cur.tPerf),
            endCode: nxt.data.code,
            endPosMs: Number(nxt.data.curMs) || 0,
          });
          break;
        }
      }
    }
  }

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const targetBaseMs = bootOffsetMs + Math.max(0, entry.tPerf - basePerf);
    if (targetBaseMs > room.clock.nowBaseMs) {
      await room.advanceAndSample(targetBaseMs - room.clock.nowBaseMs, 300);
    }

    // 1. Initial session start & remote MediaSync updates
    if (entry.src === "controller" && entry.dir === "in" && entry.ev === "handleIncomingMediaSync") {
      const d = entry.data || {};
      if (!mediaStarted) {
        mediaStarted = true;
        if (d.source === "local-ui") {
          subject.startUrl(mediaUrl);
        } else {
          remote.startUrl(mediaUrl);
        }
        if (profiles.isScSnip || profiles.isSpPreview || profiles.spAutoplayBlocked) {
          subjectWasFaultedPermanently = true;
          permanentFaultStartMs = room.clock.nowBaseMs;
        }
        continue;
      }
      if (d.source === "remote") {
        // Reproduce remote peer's action through real WASM mesh (never mutating subject directly!)
        const remoteSt = remote.getWasmState();
        if (remoteSt && remoteSt.active) {
          const wantPlaying = Boolean(d.playing);
          const wantPos = Math.max(0, Number(d.positionMs) || 0);
          const curRemotePos = projectMediaPositionMs(remoteSt, remote.clock.wallNow());
          if (Math.abs(wantPos - curRemotePos) > 1200) {
            remote.seekTo(wantPos);
            room.recordIntent(remoteId, {
              playing: wantPlaying,
              positionMs: wantPos,
              rateMilli: Number(d.rateMilli) || 1000,
            });
          }
          if (wantPlaying !== Boolean(remoteSt.playing)) {
            remote.togglePlay();
            room.recordIntent(remoteId, {
              playing: wantPlaying,
              positionMs: wantPos,
              rateMilli: Number(d.rateMilli) || 1000,
            });
          }
        }
      }
      continue;
    }

    // 2. Local reloadPlayerSession() -> execute through runLocalOnly to assert 0 wire frames
    if (entry.src === "controller" && entry.dir === "internal" && entry.ev === "reloadWatchPlayerSession") {
      await room.runLocalOnly(
        subjectId,
        "trace-reloadPlayerSession",
        async () => {
          await subject.reloadPlayerSession({ reason: entry.data?.reason || "manual" });
        },
        0
      );
      continue;
    }

    // 3. YouTube inbound SDK events & silent buffered/paused seeks
    if (entry.src === "youtube") {
      if (entry.dir === "in" && entry.ev === "onError") {
        const code = Number(entry.data?.code) || 150;
        activeErrorWindow = { startMs: room.clock.nowBaseMs, code };
        subject.injectError(code);
        continue;
      }
      if (entry.dir === "in" && entry.ev === "onStateChange") {
        const code = Number(entry.data?.code);
        const curMs = Math.max(0, Number(entry.data?.curMs) || 0);
        const expectedCmd = entry.getters?.expectedCmd;
        const isProgrammaticEcho = Boolean(
          expectedCmd &&
            ((expectedCmd.expectSeek && Math.abs(curMs - expectedCmd.targetPosMs) <= 2200) ||
              (expectedCmd.expectPlayState &&
                ((code === 1 && expectedCmd.targetPlaying) || (code === 2 && !expectedCmd.targetPlaying))))
        );
        // Recovery from Error 150 via CUED(5)
        if (code === YT_STATE.CUED && activeErrorWindow) {
          room.recordFaultWindow(
            subjectId,
            `yt-error-${activeErrorWindow.code}`,
            activeErrorWindow.startMs,
            room.clock.nowBaseMs - 1
          );
          activeErrorWindow = null;
          subject.recoverFromError(YT_STATE.CUED);
          continue;
        }
        if (code === YT_STATE.BUFFERING) {
          // Ignore programmatic seekTo buffering (already triggered by real WatchTogetherPlayer)
          if (expectedCmd && expectedCmd.expectSeek && Math.abs(curMs - expectedCmd.targetPosMs) <= 2200) {
            continue;
          }
          const pair = ytBufferDurationBySeq.get(entry.seq);
          const bufMs = pair ? pair.durationMs : 180;
          if (entry.data?.jumped) {
            // Genuine user pre-BUFFERING click-seek
            subject.embedClickSeek(curMs, { preBufferJump: true, bufferMs: bufMs });
            room.recordIntent(subjectId, {
              playing: pair ? pair.endCode === 1 : true,
              positionMs: curMs,
              rateMilli: Number(entry.data?.rateMilli) || 1000,
            });
            lastYtBufferEntry = entry;
          } else {
            // Genuine local network rebuffer stall (curMs did NOT jump!)
            subject.injectRebuffer(bufMs);
            activeRebufferEndPerf = entry.tPerf + bufMs;
            lastYtBufferEntry = entry;
          }
          continue;
        }
        if (code === YT_STATE.PAUSED && !isProgrammaticEcho) {
          if (subject.adapters.youtube.playing) {
            subject.embedPause();
            room.recordIntent(subjectId, {
              playing: false,
              positionMs: subject.adapters.youtube.snapshot().positionMs,
              rateMilli: Number(entry.data?.rateMilli) || 1000,
            });
          }
          continue;
        }
        if (code === YT_STATE.PLAYING && !isProgrammaticEcho) {
          // Skip completion of click-seek/rebuffer already scheduled on BUFFERING
          if (lastYtBufferEntry || entry.tPerf <= activeRebufferEndPerf + 20) {
            lastYtBufferEntry = null;
            continue;
          }
          if (!subject.adapters.youtube.playing) {
            subject.embedPlay();
            room.recordIntent(subjectId, {
              playing: true,
              positionMs: curMs,
              rateMilli: Number(entry.data?.rateMilli) || 1000,
            });
          }
          continue;
        }
      }
      // Silent buffered seek (1->1) or silent paused seek (2->2): detected in original trace
      // as `onUserAction` with NO preceding `onStateChange` at the same timestamp!
      if (entry.dir === "out" && entry.ev === "onUserAction") {
        const prev = idx > 0 ? entries[idx - 1] : null;
        const hadStateChange =
          prev && prev.src === "youtube" && prev.dir === "in" && prev.ev === "onStateChange" && prev.tPerf === entry.tPerf;
        if (!hadStateChange) {
          const targetPos = Math.max(0, Number(entry.data?.positionMs) || 0);
          if (entry.data?.playing) {
            subject.embedBufferedSeek(targetPos);
            room.recordIntent(subjectId, {
              playing: true,
              positionMs: targetPos,
              rateMilli: Number(entry.data?.rateMilli) || 1000,
            });
          } else {
            subject.embedPausedSeek(targetPos);
            room.recordIntent(subjectId, {
              playing: false,
              positionMs: targetPos,
              rateMilli: Number(entry.data?.rateMilli) || 1000,
            });
          }
        }
      }
      continue;
    }

    // 4. SoundCloud inbound user interactions (PLAY/PAUSE/SEEK)
    if (entry.src === "soundcloud" && entry.dir === "in") {
      const next = idx + 1 < entries.length ? entries[idx + 1] : null;
      const producedUserAction =
        next && next.src === "soundcloud" && next.dir === "out" && next.ev === "onUserAction" && next.tPerf === entry.tPerf;

      if (entry.ev === "PAUSE" && producedUserAction) {
        subject.embedPause();
        room.recordIntent(subjectId, {
          playing: false,
          positionMs: subject.adapters.soundcloud.snapshot().positionMs,
        });
      } else if (entry.ev === "PLAY" && producedUserAction) {
        const desiredIdx = Number(next.data?.playlistIndex);
        if (
          Number.isFinite(desiredIdx) &&
          desiredIdx >= 0 &&
          desiredIdx !== subject.adapters.soundcloud.playlistIndex
        ) {
          subject.embedSelectPlaylistTrack(desiredIdx);
          room.recordIntent(subjectId, { kind: "boundary" });
        } else if (!subject.adapters.soundcloud.playing) {
          subject.embedPlay();
          room.recordIntent(subjectId, {
            playing: true,
            positionMs: subject.adapters.soundcloud.snapshot().positionMs,
          });
        }
      } else if (entry.ev === "SEEK" && producedUserAction) {
        const targetPos = Math.max(0, Number(entry.data?.posMs) || 0);
        subject.embedClickSeek(targetPos);
        room.recordIntent(subjectId, {
          playing: subject.adapters.soundcloud.playing,
          positionMs: targetPos,
        });
      }
      continue;
    }

    // 5. Twitch VOD silent seek (detected as `onUserAction` with no preceding `SEEK`/`PLAY`/`PAUSE`)
    if (entry.src === "twitch" && entry.dir === "out" && entry.ev === "onUserAction") {
      const prev = idx > 0 ? entries[idx - 1] : null;
      const hadSdkEvent =
        prev && prev.src === "twitch" && prev.dir === "in" && prev.tPerf === entry.tPerf;
      if (!hadSdkEvent) {
        const targetPos = Math.max(0, Number(entry.data?.positionMs) || 0);
        subject.embedBufferedSeek(targetPos);
        room.recordIntent(subjectId, {
          playing: Boolean(entry.data?.playing),
          positionMs: targetPos,
        });
      }
    }
  }

  // Quiescence settle + steady-state window (with live 333ms polling & 1200ms correctDrift)
  await room.advanceAndSample(4500, 350);

  if (activeErrorWindow) {
    room.recordFaultWindow(
      subjectId,
      `yt-error-${activeErrorWindow.code}`,
      activeErrorWindow.startMs,
      room.clock.nowBaseMs
    );
  }
  if (subjectWasFaultedPermanently && permanentFaultStartMs !== null) {
    room.recordFaultWindow(
      subjectId,
      profiles.isScSnip ? "sc-snip-preview" : "spotify-preview-autoplay",
      permanentFaultStartMs,
      room.clock.nowBaseMs + 10_000
    );
  }

  const steadyStartMs = room.clock.nowBaseMs;
  await room.advanceAndSample(3500, 350);
  const steadyEndMs = room.clock.nowBaseMs;

  // Verify final WASM state still matches the golden trace's expected playstate & media/provider
  const finalRemoteState = remote.getWasmState();
  assert.ok(finalRemoteState && finalRemoteState.active, `${filename}: remote peer must have active Watch state`);
  assert.equal(
    finalRemoteState.provider,
    trace.watchState.provider,
    `${filename}: replayed provider must match golden watchState.provider`
  );
  assert.equal(
    finalRemoteState.playing,
    trace.watchState.playing,
    `${filename}: replayed playing state must match golden watchState.playing`
  );
  if (trace.watchState.playlistIndex > 0) {
    assert.equal(
      finalRemoteState.playlistIndex,
      trace.watchState.playlistIndex,
      `${filename}: replayed playlistIndex must match golden trace`
    );
  }
  // For preview/SNIP/error/rebuffer traces where subject was faulted, verify remote peer was NEVER dragged back
  if (profiles.isScSnip || profiles.isSpPreview) {
    const remotePos = projectMediaPositionMs(finalRemoteState, remote.clock.wallNow());
    assert.ok(
      remotePos > 30_000,
      `${filename}: full-track remote peer must progress cleanly past 30s (got ${remotePos}ms)`
    );
  }
  if (profiles.twAutoplayBlocked) {
    assert.equal(
      subject.adapters.twitch.muted,
      true,
      `${filename}: Twitch PLAYBACK_BLOCKED must auto-recover muted locally`
    );
    assert.equal(
      subject.adapters.twitch.playing,
      true,
      `${filename}: Twitch PLAYBACK_BLOCKED must converge to playing locally`
    );
  }
  if (filename === "youtube_offline_rebuffer_stall.json") {
    assert.equal(
      finalRemoteState.rev,
      1,
      `${filename}: local network rebuffer stall must emit 0 disruptive rev bumps to remote peer`
    );
  }
  if (filename === "youtube_error_150_and_recovery.json") {
    assert.equal(
      subject.getPlayer().providerNotice,
      null,
      `${filename}: Error 150 notice must clear on CUED recovery`
    );
    assert.equal(
      subject.adapters.youtube.playing,
      true,
      `${filename}: recovered peer must resume synced playback`
    );
  }

  // Evaluate ALL 6 universal invariants (BoundedConvergence, ZeroOscillationAndWireCap,
  // UserIntentPreservation, FaultIsolation, LocalOnlyIsolation + E2EEWireAuditor, TimerHygiene)
  const healthyPeerIds = subjectWasFaultedPermanently ? [remoteId] : [subjectId, remoteId];
  const pre = room.evaluatePreTeardownInvariants({
    steadyStartMs,
    steadyEndMs,
    healthyPeerIds,
    convergenceBudgetMs: 5500,
    yankToleranceMs: 1800,
    yankGraceAfterActionMs: 300,
  });
  const inv6 = room.destroyAndCheckTimerHygiene();
  assertAllInvariants([...pre, inv6], room.timeline);
}

/* ==================== Auto-Discovered Golden Trace Regression Suite ==================== */

const discoveredFiles = (await readdir(FIXTURES_DIR))
  .filter((f) => f.endsWith(".json"))
  .sort();

test("trace_replay: all 8 required golden browser trace fixtures exist and pass strict p2p-direct-watch-trace-v1 schema + zero-secrets audit", async () => {
  for (const required of REQUIRED_GOLDEN_FIXTURES) {
    assert.ok(
      discoveredFiles.includes(required),
      `Missing required golden trace fixture: tests/traces/fixtures/${required}`
    );
  }
  assert.ok(discoveredFiles.length >= 8, `Expected at least 8 golden fixtures, found ${discoveredFiles.length}`);

  for (const file of discoveredFiles) {
    const raw = await readFile(join(FIXTURES_DIR, file), "utf8");
    const parsed = JSON.parse(raw);
    validateTraceSchema(parsed, raw, file);
  }
});

for (const file of discoveredFiles) {
  test(`trace_replay(${basename(file, ".json")}): replays on VirtualClock through real WatchTogetherPlayer + MediaSyncController + p2p_mesh.wasm and satisfies all 6 invariants`, async () => {
    const raw = await readFile(join(FIXTURES_DIR, file), "utf8");
    const trace = JSON.parse(raw);
    validateTraceSchema(trace, raw, file);
    await replayGoldenTrace(trace, file);
  });
}

/**
 * Layer 2 universal invariants, chronological TimelineLog, and Zeller's `ddmin`
 * delta-debugging shrinker for deterministic P2P Watch Together verification.
 */

import assert from "node:assert/strict";
import { projectMediaPositionMs } from "../../watch_together.js";

/* ==================== Chronological Timeline Recorder ==================== */

export class TimelineLog {
  constructor({ maxEntries = 5000 } = {}) {
    this.maxEntries = Math.max(50, Number(maxEntries) || 5000);
    this._entries = [];
    this._seq = 0;
  }

  record({ tBase = 0, peerId = "", kind = "event", detail = "", data = undefined } = {}) {
    const entry = {
      seq: ++this._seq,
      tBase: Math.round(Number(tBase) * 100) / 100,
      peerId: String(peerId || ""),
      kind: String(kind || "event"),
      detail: String(detail || ""),
      ...(data !== undefined ? { data } : {}),
    };
    this._entries.push(entry);
    if (this._entries.length > this.maxEntries) {
      this._entries.splice(0, this._entries.length - this.maxEntries);
    }
    return entry;
  }

  entries() {
    return this._entries.slice();
  }

  filter(predicate) {
    return this._entries.filter(predicate);
  }

  slice(startBaseMs = 0, endBaseMs = Infinity) {
    return this._entries.filter((e) => e.tBase >= startBaseMs && e.tBase <= endBaseMs);
  }

  clear() {
    this._entries.length = 0;
  }

  formatCompact({ maxLines = 80 } = {}) {
    const list =
      this._entries.length > maxLines
        ? this._entries.slice(this._entries.length - maxLines)
        : this._entries;
    return list
      .map((e) => {
        const ts = String(Math.round(e.tBase)).padStart(6, " ");
        const peer = (e.peerId || "-").padEnd(8, " ");
        const extra = e.detail ? ` ${e.detail}` : "";
        return `[t=${ts}ms] #${e.seq} ${peer} ${e.kind}${extra}`;
      })
      .join("\n");
  }
}

/* ==================== Helpers ==================== */

function makeResult(invariant, violations) {
  return {
    ok: violations.length === 0,
    invariant,
    violations,
    summary:
      violations.length === 0
        ? `${invariant}: PASS`
        : `${invariant}: FAIL (${violations.length} violation(s)): ${violations[0].message}`,
  };
}

function projectIntentPosMs(action, tBase) {
  const base = Math.max(0, Number(action.positionMs) || 0);
  if (!action.playing) return base;
  const elapsed = Math.max(0, tBase - (Number(action.tBase) || 0));
  const rateMilli = Math.max(250, Math.min(4000, Number(action.rateMilli) || 1000));
  return Math.max(0, Math.round(base + (elapsed * rateMilli) / 1000));
}

/* ==================== 6 Universal Invariant Checkers ==================== */

/**
 * Invariant 1 — User-Intent Preservation:
 * No yank > 1500ms or inverted `playing` state against a healthy peer's explicit user action
 * unless superseded by a newer explicit user action elsewhere; healthy peers converge within budget.
 */
export function checkUserIntentPreservation({
  actions = [],
  samples = [],
  healthyPeerIds = null,
  maxYankMs = 1500,
  convergenceBudgetMs = 4500,
  convergenceToleranceMs = 2200,
  spotifyConvergenceToleranceMs = 3000,
  yankGraceAfterActionMs = 0,
} = {}) {
  const violations = [];
  const sortedActions = actions
    .filter((a) => a && a.healthy !== false)
    .slice()
    .sort((a, b) => (a.tBase || 0) - (b.tBase || 0));
  const sortedSamples = samples.slice().sort((a, b) => (a.tBase || 0) - (b.tBase || 0));
  const healthySet = healthyPeerIds ? new Set(healthyPeerIds) : null;

  const isSampleHealthy = (s) =>
    s &&
    s.healthy !== false &&
    !s.blocked &&
    !s.errored &&
    !s.autoplayBlocked &&
    !s.reloading &&
    !s.sleeping &&
    !s.isPreviewOutOfRange &&
    (!healthySet || healthySet.has(s.peerId));

  for (let i = 0; i < sortedActions.length; i++) {
    const act = sortedActions[i];
    const nextAct = sortedActions[i + 1] || null;
    const windowStart = (Number(act.tBase) || 0) + Math.max(0, Number(yankGraceAfterActionMs) || 0);
    const windowEnd = nextAct ? Number(nextAct.tBase) : Infinity;

    // 1a. Actor must not be yanked > maxYankMs or have `playing` inverted before a newer user action
    for (const s of sortedSamples) {
      if (s.tBase < windowStart) continue;
      if (s.tBase >= windowEnd) break;
      if (s.peerId !== act.peerId || !isSampleHealthy(s)) continue;
      if (s.buffering || s.unstarted || s.ended) continue;

      if (typeof act.playing === "boolean" && typeof s.playing === "boolean" && s.playing !== act.playing) {
        violations.push({
          code: "intent-playstate-inverted",
          peerId: act.peerId,
          tBase: s.tBase,
          message: `Peer ${act.peerId} playstate inverted from ${act.playing} to ${s.playing} at t=${s.tBase}ms (intent at t=${act.tBase}ms)`,
          details: { action: act, sample: s },
        });
        break;
      }

      if (typeof act.positionMs === "number" && typeof s.positionMs === "number") {
        const expectedMs = projectIntentPosMs(act, s.tBase);
        const diffMs = Math.abs(s.positionMs - expectedMs);
        if (diffMs > maxYankMs) {
          violations.push({
            code: "intent-position-yanked",
            peerId: act.peerId,
            tBase: s.tBase,
            message: `Peer ${act.peerId} yanked by ${Math.round(diffMs)}ms (> ${maxYankMs}ms): got ${Math.round(s.positionMs)}ms vs expected ${expectedMs}ms at t=${s.tBase}ms`,
            details: { action: act, sample: s, expectedMs, diffMs },
          });
          break;
        }
      }
    }

    // 1b. Healthy peers observed after convergenceBudgetMs (and before next user action) must match intent
    const convergeCheckStart = (Number(act.tBase) || 0) + convergenceBudgetMs;
    if (windowEnd > convergeCheckStart) {
      const latestByPeer = new Map();
      for (const s of sortedSamples) {
        if (s.tBase < convergeCheckStart) continue;
        if (s.tBase >= windowEnd) break;
        if (!isSampleHealthy(s)) continue;
        latestByPeer.set(s.peerId, s);
      }
      for (const [peerId, s] of latestByPeer.entries()) {
        if (s.buffering || s.unstarted || s.ended) continue;
        const tol = s.provider === "spotify" ? spotifyConvergenceToleranceMs : convergenceToleranceMs;
        if (typeof act.playing === "boolean" && typeof s.playing === "boolean" && s.playing !== act.playing) {
          violations.push({
            code: "intent-peer-playstate-diverged",
            peerId,
            tBase: s.tBase,
            message: `Healthy peer ${peerId} did not converge to playing=${act.playing} within ${convergenceBudgetMs}ms (got ${s.playing} at t=${s.tBase}ms)`,
            details: { action: act, sample: s },
          });
        }
        if (typeof act.positionMs === "number" && typeof s.positionMs === "number") {
          const expectedMs = projectIntentPosMs(act, s.tBase);
          const diffMs = Math.abs(s.positionMs - expectedMs);
          if (diffMs > tol) {
            violations.push({
              code: "intent-peer-position-diverged",
              peerId,
              tBase: s.tBase,
              message: `Healthy peer ${peerId} diverged by ${Math.round(diffMs)}ms (> ${tol}ms) from user intent at t=${s.tBase}ms`,
              details: { action: act, sample: s, expectedMs, diffMs, tol },
            });
          }
        }
      }
    }
  }

  return makeResult("UserIntentPreservation", violations);
}

/**
 * Invariant 2 — Bounded Convergence:
 * All connected peers hold identical WASM `media_states["watch"]` metadata
 * `(rev, actor, active, playing, mediaId, playlistIndex, trackUri, rateMilli)`
 * and healthy peers' playheads stay within tolerance (`<= 2200ms`, `<= 3000ms` Spotify).
 */
export function checkBoundedConvergence({
  peers = [],
  toleranceMs = 2200,
  spotifyToleranceMs = 3000,
  requireActive = false,
} = {}) {
  const violations = [];
  const connected = peers.filter((p) => p && !p.partitioned && !p.disconnected);
  if (connected.length === 0) {
    return makeResult("BoundedConvergence", violations);
  }

  const refPeer = connected.find((p) => p.wasmState) || connected[0];
  const ref = refPeer?.wasmState || null;

  if (requireActive && (!ref || !ref.active)) {
    violations.push({
      code: "missing-active-state",
      peerId: refPeer?.peerId,
      message: "Expected active WASM media state, got null/inactive",
    });
    return makeResult("BoundedConvergence", violations);
  }

  // 2a. Exact WASM CRDT state agreement across all connected peers
  const fields = ["rev", "actor", "active", "playing", "mediaId", "playlistIndex", "trackUri", "rateMilli"];
  for (const p of connected) {
    const st = p.wasmState || null;
    if (!ref && !st) continue;
    if (!ref || !st) {
      violations.push({
        code: "wasm-state-presence-mismatch",
        peerId: p.peerId,
        message: `Peer ${p.peerId} WASM state presence disagrees with ${refPeer.peerId}`,
        details: { ref, actual: st },
      });
      continue;
    }
    for (const f of fields) {
      const a = ref[f] ?? (f === "playlistIndex" ? 0 : f === "rateMilli" ? 1000 : "");
      const b = st[f] ?? (f === "playlistIndex" ? 0 : f === "rateMilli" ? 1000 : "");
      if (a !== b) {
        violations.push({
          code: "wasm-state-field-mismatch",
          peerId: p.peerId,
          message: `Peer ${p.peerId} WASM state.${f}=${JSON.stringify(b)} !== ${refPeer.peerId} (${JSON.stringify(a)})`,
          details: { field: f, expected: a, actual: b, ref, state: st },
        });
      }
    }
  }

  // 2b. Playhead & playstate convergence across healthy non-faulty peers
  const healthy = connected.filter(
    (p) =>
      p.healthy !== false &&
      !p.blocked &&
      !p.errored &&
      !p.autoplayBlocked &&
      !p.reloading &&
      !p.sleeping &&
      !p.isPreviewOutOfRange &&
      p.playerSnapshot
  );

  for (const p of healthy) {
    const snap = p.playerSnapshot;
    const st = p.wasmState;
    if (!st || !st.active || !snap.ready) continue;
    if (snap.buffering || snap.unstarted || snap.ended) continue;

    const provider = p.provider || snap.provider || st.provider || "";
    const tol = provider === "spotify" ? spotifyToleranceMs : toleranceMs;
    const wallNow = Number(p.wallNowMs ?? snap.wallNowMs ?? st.anchorMs ?? 0);
    let expectedPosMs = projectMediaPositionMs(st, wallNow);
    if (snap.durationMs > 0) {
      expectedPosMs = Math.min(expectedPosMs, snap.durationMs);
    }

    if (snap.hasPlayState !== false && Boolean(snap.playing) !== Boolean(st.playing)) {
      violations.push({
        code: "player-playstate-mismatch",
        peerId: p.peerId,
        message: `Healthy peer ${p.peerId} player playing=${Boolean(snap.playing)} !== WASM playing=${Boolean(st.playing)}`,
        details: { snap, wasmState: st },
      });
    }

    if (snap.hasPosition !== false && typeof snap.positionMs === "number") {
      const driftMs = Math.abs(snap.positionMs - expectedPosMs);
      if (driftMs > tol) {
        violations.push({
          code: "player-position-drift",
          peerId: p.peerId,
          message: `Healthy peer ${p.peerId} drift ${Math.round(driftMs)}ms exceeds tolerance ${tol}ms (pos=${Math.round(snap.positionMs)}ms, expected=${expectedPosMs}ms)`,
          details: { driftMs, tol, posMs: snap.positionMs, expectedPosMs, provider },
        });
      }
    }
  }

  // 2c. Pairwise healthy playhead agreement
  for (let i = 0; i < healthy.length; i++) {
    for (let j = i + 1; j < healthy.length; j++) {
      const a = healthy[i];
      const b = healthy[j];
      const sa = a.playerSnapshot;
      const sb = b.playerSnapshot;
      if (!sa.ready || !sb.ready || sa.hasPosition === false || sb.hasPosition === false) continue;
      if (sa.buffering || sb.buffering || sa.unstarted || sb.unstarted || sa.ended || sb.ended) continue;
      const isSpotify =
        (a.provider || sa.provider) === "spotify" || (b.provider || sb.provider) === "spotify";
      const tol = isSpotify ? spotifyToleranceMs : toleranceMs;
      const spread = Math.abs(sa.positionMs - sb.positionMs);
      if (spread > tol) {
        violations.push({
          code: "pairwise-playhead-spread",
          peerId: `${a.peerId},${b.peerId}`,
          message: `Healthy peers ${a.peerId} (${Math.round(sa.positionMs)}ms) and ${b.peerId} (${Math.round(sb.positionMs)}ms) differ by ${Math.round(spread)}ms (> ${tol}ms)`,
          details: { a: a.peerId, b: b.peerId, posA: sa.positionMs, posB: sb.positionMs, spread, tol },
        });
      }
    }
  }

  return makeResult("BoundedConvergence", violations);
}

/**
 * Invariant 3 — Zero Oscillation & Wire Cap:
 * In a steady-state quiescence window, 0 new `MediaSync` wire updates and `<= 2` adapter
 * commands per peer.
 */
export function checkZeroOscillationAndWireCap({
  mediaSyncWireCount = undefined,
  mediaSyncWireEvents = [],
  adapterCmdsByPeer = {},
  maxMediaSyncWireUpdates = 0,
  maxAdapterCmdsPerPeer = 2,
  windowStartMs = 0,
  windowEndMs = Infinity,
} = {}) {
  const violations = [];

  const wireCount =
    typeof mediaSyncWireCount === "number"
      ? mediaSyncWireCount
      : mediaSyncWireEvents.filter((e) => {
          const t = Number(e?.tBase ?? 0);
          return t >= windowStartMs && t <= windowEndMs;
        }).length;

  if (wireCount > maxMediaSyncWireUpdates) {
    violations.push({
      code: "steady-state-media-sync-churn",
      message: `Observed ${wireCount} MediaSync wire update(s) in steady-state window (cap: ${maxMediaSyncWireUpdates})`,
      details: { wireCount, maxMediaSyncWireUpdates, windowStartMs, windowEndMs },
    });
  }

  for (const [peerId, cmdsOrCount] of Object.entries(adapterCmdsByPeer)) {
    const count = Array.isArray(cmdsOrCount)
      ? cmdsOrCount.filter((c) => {
          const t = Number(c?.tBase ?? 0);
          return t >= windowStartMs && t <= windowEndMs;
        }).length
      : Number(cmdsOrCount) || 0;
    if (count > maxAdapterCmdsPerPeer) {
      violations.push({
        code: "steady-state-adapter-cmd-churn",
        peerId,
        message: `Peer ${peerId} issued ${count} adapter command(s) in steady-state window (cap: ${maxAdapterCmdsPerPeer})`,
        details: { peerId, count, maxAdapterCmdsPerPeer, windowStartMs, windowEndMs },
      });
    }
  }

  return makeResult("ZeroOscillationAndWireCap", violations);
}

/**
 * Invariant 4 — Fault Isolation:
 * Blocked, errored, autoplay-blocked, reloading, preview-out-of-range, or sleeping peers
 * must emit 0 `onUserAction`, `onNegotiateState`, or WASM `mediaSyncUpdate` events.
 */
export function checkFaultIsolation({ faultyPeers = [], events = [] } = {}) {
  const violations = [];
  const forbiddenKinds = new Set(["onUserAction", "onNegotiateState", "mediaSyncUpdate"]);

  for (const fault of faultyPeers) {
    if (!fault || !fault.peerId) continue;
    const startMs = Number(fault.startMs ?? 0);
    const endMs = Number(fault.endMs ?? Infinity);
    const faultKind = fault.faultKind || "faulty";

    for (const ev of events) {
      if (!ev || ev.peerId !== fault.peerId) continue;
      if (!forbiddenKinds.has(ev.kind)) continue;
      const t = Number(ev.tBase ?? 0);
      if (t >= startMs && t <= endMs) {
        violations.push({
          code: "faulty-peer-disrupted-room",
          peerId: fault.peerId,
          tBase: t,
          message: `Faulty peer ${fault.peerId} (${faultKind}) emitted ${ev.kind} at t=${t}ms during [${startMs}, ${endMs}]`,
          details: { fault, event: ev },
        });
      }
    }
  }

  return makeResult("FaultIsolation", violations);
}

/**
 * Invariant 5 — Local-Only Privacy & E2EE Wire Confidentiality:
 * Local volume/mute/reload/playlist-browse produce 0 non-keepalive wire frames, and
 * every wire frame passes E2EE envelope + zero-plaintext audit.
 */
export function checkLocalOnlyPrivacy({
  localOnlyWindows = [],
  wireEvents = [],
  wireAuditor = null,
} = {}) {
  const violations = [];

  for (const win of localOnlyWindows) {
    if (!win || !win.peerId) continue;
    const startMs = Number(win.startMs ?? 0);
    const endMs = Number(win.endMs ?? Infinity);
    const action = win.action || "local-only";

    for (const ev of wireEvents) {
      if (!ev || ev.fromPeerId !== win.peerId) continue;
      if (ev.isKeepalive) continue;
      const t = Number(ev.tBase ?? 0);
      if (t >= startMs && t <= endMs) {
        violations.push({
          code: "local-only-emitted-wire",
          peerId: win.peerId,
          tBase: t,
          message: `Peer ${win.peerId} emitted wire frame to ${ev.toPeerId} during local-only "${action}" window [${startMs}, ${endMs}]`,
          details: { window: win, wireEvent: ev },
        });
      }
    }
  }

  if (wireAuditor && Array.isArray(wireAuditor.violations)) {
    for (const av of wireAuditor.violations) {
      violations.push({
        code: `e2ee-audit:${av.code}`,
        peerId: av.fromPeerId,
        tBase: av.tBase,
        message: av.message,
        details: av,
      });
    }
  }

  return makeResult("LocalOnlyPrivacy", violations);
}

/**
 * Invariant 6 — Timer Hygiene:
 * Zero active virtual timers after teardown/destroy (on clock & adapters), and zero stale callbacks.
 */
export function checkTimerHygiene({
  clock = null,
  peerIds = null,
  adapters = [],
  staleCallbackEvents = [],
  checkGlobalClock = true,
} = {}) {
  const violations = [];

  if (clock) {
    if (Array.isArray(peerIds)) {
      for (const pid of peerIds) {
        const count = clock.activeTimerCount(pid);
        if (count > 0) {
          violations.push({
            code: "leaked-peer-timers",
            peerId: pid,
            message: `Peer ${pid} still has ${count} active virtual timer(s) after teardown`,
            details: { peerId: pid, count },
          });
        }
      }
    }
    if (checkGlobalClock) {
      const total = clock.activeTimerCount();
      if (total > 0) {
        violations.push({
          code: "leaked-clock-timers",
          message: `VirtualClock still has ${total} active timer(s) after teardown`,
          details: { total, pending: clock.pendingEvents?.() || [] },
        });
      }
    }
  }

  for (const adapter of adapters) {
    if (!adapter || typeof adapter.activeTimerCount !== "function") continue;
    const count = adapter.activeTimerCount();
    if (count > 0) {
      violations.push({
        code: "leaked-adapter-timers",
        peerId: adapter.peerId,
        message: `Adapter (${adapter.provider || "unknown"}:${adapter.peerId || ""}) still has ${count} active timer(s) after teardown`,
        details: { provider: adapter.provider, peerId: adapter.peerId, count },
      });
    }
  }

  for (const ev of staleCallbackEvents) {
    violations.push({
      code: "stale-callback-fired",
      peerId: ev?.peerId,
      tBase: ev?.tBase,
      message: `Stale callback fired after teardown: ${ev?.detail || ev?.kind || "unknown"}`,
      details: ev,
    });
  }

  return makeResult("TimerHygiene", violations);
}

export function assertInvariant(result, timeline = null) {
  if (!result || result.ok) return;
  const lines = result.violations.map((v, idx) => `  ${idx + 1}. [${v.code}] ${v.message}`);
  const dump = timeline ? `\n--- Timeline ---\n${timeline.formatCompact()}` : "";
  assert.fail(`${result.summary}\n${lines.join("\n")}${dump}`);
}

export function assertAllInvariants(results, timeline = null) {
  const failed = results.filter((r) => r && !r.ok);
  if (failed.length === 0) return;
  const sections = failed.map((r) => {
    const lines = r.violations.map((v, idx) => `  ${idx + 1}. [${v.code}] ${v.message}`);
    return `${r.summary}\n${lines.join("\n")}`;
  });
  const dump = timeline ? `\n--- Timeline ---\n${timeline.formatCompact()}` : "";
  assert.fail(`Invariant failure(s):\n${sections.join("\n\n")}${dump}`);
}

/* ==================== Delta-Debugging Shrinker (ddmin) ==================== */

async function ddminArray(items, testSubset, { minLength = 0, budget }) {
  let current = items.slice();
  let n = 2;

  while (current.length > minLength && budget.remaining > 0) {
    const chunkLen = Math.max(1, Math.ceil(current.length / n));
    let reduced = false;

    // 1. Try keeping only a single subset (fast exponential shrinkage)
    if (n > 1) {
      for (let i = 0; i < current.length && budget.remaining > 0; i += chunkLen) {
        const subset = current.slice(i, i + chunkLen);
        if (subset.length < minLength || subset.length === current.length) continue;
        budget.remaining -= 1;
        budget.evaluations += 1;
        if (await testSubset(subset)) {
          current = subset;
          n = 2;
          reduced = true;
          break;
        }
      }
      if (reduced) continue;
    }

    // 2. Try removing each complement chunk
    for (let i = 0; i < current.length && budget.remaining > 0; i += chunkLen) {
      const complement = current.slice(0, i).concat(current.slice(i + chunkLen));
      if (complement.length < minLength || complement.length === current.length) continue;
      budget.remaining -= 1;
      budget.evaluations += 1;
      if (await testSubset(complement)) {
        current = complement;
        n = Math.max(2, n - 1);
        reduced = true;
        break;
      }
    }

    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(current.length, n * 2);
    }
  }

  return current;
}

function isFailingOutcome(res) {
  if (typeof res === "boolean") return res;
  if (res && typeof res === "object") {
    if ("failed" in res) return Boolean(res.failed);
    if ("ok" in res) return !res.ok;
  }
  return Boolean(res);
}

function filterEventsForPeers(events, keptPeers) {
  const peerIds = new Set(
    keptPeers.map((p) => (typeof p === "string" ? p : p?.peerId || p?.id)).filter(Boolean)
  );
  return events.filter((ev) => {
    if (!ev || typeof ev !== "object") return true;
    if (ev.peerId && !peerIds.has(ev.peerId)) return false;
    if (ev.fromPeerId && !peerIds.has(ev.fromPeerId)) return false;
    if (ev.toPeerId && !peerIds.has(ev.toPeerId)) return false;
    if (ev.targetPeerId && !peerIds.has(ev.targetPeerId)) return false;
    return true;
  });
}

/**
 * Zeller's `ddmin` delta-debugging shrinker.
 * Minimizes `scenario.events` and `scenario.peers` (preserving peer references cleanly)
 * while `testFn(candidate)` still reports a failure.
 *
 * @param {object} scenario - `{ peers?: Array, events?: Array, ... }`
 * @param {(candidate: object) => (boolean | { failed: boolean } | Promise<boolean | { failed: boolean }>)} testFn
 * @param {{ maxEvaluations?: number, minPeers?: number, minEvents?: number }} [options]
 */
export async function ddmin(scenario, testFn, options = {}) {
  const maxEvaluations = Math.max(10, Number(options.maxEvaluations) || 300);
  const minPeers = Math.max(0, Number(options.minPeers ?? 1));
  const minEvents = Math.max(0, Number(options.minEvents ?? 0));
  const budget = { remaining: maxEvaluations, evaluations: 0 };

  let lastFailure = null;
  const check = async (candidate) => {
    const out = await testFn(candidate);
    const failed = isFailingOutcome(out);
    if (failed) {
      lastFailure = out;
    }
    return failed;
  };

  budget.remaining -= 1;
  budget.evaluations += 1;
  const initialFails = await check(scenario);
  if (!initialFails) {
    return {
      shrunk: scenario,
      reduced: false,
      evaluations: budget.evaluations,
      lastFailure: null,
    };
  }

  let best = {
    ...scenario,
    ...(Array.isArray(scenario.peers) ? { peers: scenario.peers.slice() } : {}),
    ...(Array.isArray(scenario.events) ? { events: scenario.events.slice() } : {}),
  };

  // Phase 1: shrink events
  if (Array.isArray(best.events) && best.events.length > minEvents) {
    best.events = await ddminArray(
      best.events,
      (evSubset) => check({ ...best, events: evSubset }),
      { minLength: minEvents, budget }
    );
  }

  // Phase 2: shrink peers (pruning events belonging to removed peers)
  if (Array.isArray(best.peers) && best.peers.length > minPeers) {
    best.peers = await ddminArray(
      best.peers,
      (peerSubset) => {
        const nextEvents = Array.isArray(best.events)
          ? filterEventsForPeers(best.events, peerSubset)
          : best.events;
        return check({ ...best, peers: peerSubset, events: nextEvents });
      },
      { minLength: minPeers, budget }
    );
    if (Array.isArray(best.events)) {
      best.events = filterEventsForPeers(best.events, best.peers);
    }
  }

  // Phase 3: second pass on events after peer minimization
  if (Array.isArray(best.events) && best.events.length > minEvents && budget.remaining > 0) {
    best.events = await ddminArray(
      best.events,
      (evSubset) => check({ ...best, events: evSubset }),
      { minLength: minEvents, budget }
    );
  }

  const origEvents = Array.isArray(scenario.events) ? scenario.events.length : 0;
  const origPeers = Array.isArray(scenario.peers) ? scenario.peers.length : 0;
  const newEvents = Array.isArray(best.events) ? best.events.length : 0;
  const newPeers = Array.isArray(best.peers) ? best.peers.length : 0;

  return {
    shrunk: best,
    reduced: newEvents < origEvents || newPeers < origPeers,
    evaluations: budget.evaluations,
    originalSize: { peers: origPeers, events: origEvents },
    shrunkSize: { peers: newPeers, events: newEvents },
    lastFailure,
  };
}

/**
 * Formats a compact, actionable repro dump for shrunk failing scenarios.
 */
export function formatReproDump({ seed = null, scenario = null, shrunk = null, failure = null, timeline = null } = {}) {
  const lines = ["=== P2P Watch Chaos Minimal Repro ==="];
  if (seed !== null && seed !== undefined) {
    lines.push(`Seed: ${seed}`);
  }
  if (failure) {
    const msg =
      typeof failure === "string"
        ? failure
        : failure.summary || failure.reason || failure.message || JSON.stringify(failure);
    lines.push(`Failure: ${msg}`);
  }
  const target = shrunk || scenario;
  if (target) {
    if (Array.isArray(target.peers)) {
      lines.push(`Peers (${target.peers.length}): ${JSON.stringify(target.peers)}`);
    }
    if (Array.isArray(target.events)) {
      lines.push(`Events (${target.events.length}):`);
      for (let i = 0; i < target.events.length; i++) {
        lines.push(`  [${i}] ${JSON.stringify(target.events[i])}`);
      }
    }
    const extraKeys = Object.keys(target).filter((k) => k !== "peers" && k !== "events");
    if (extraKeys.length > 0) {
      const extra = {};
      for (const k of extraKeys) extra[k] = target[k];
      lines.push(`Config: ${JSON.stringify(extra)}`);
    }
  }
  if (timeline && typeof timeline.formatCompact === "function") {
    const compact = timeline.formatCompact({ maxLines: 40 });
    if (compact) {
      lines.push("--- Timeline (tail) ---");
      lines.push(compact);
    }
  }
  return lines.join("\n");
}

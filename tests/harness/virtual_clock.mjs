/**
 * Deterministic discrete-event VirtualClock with per-peer clock skew, ppm drift,
 * and tab-sleep timer deferral. Zero real `setTimeout`/`setInterval` calls.
 */

const DEFAULT_START_WALL_MS = 1_700_000_000_000;

function compareTasks(a, b) {
  if (a.fireAtBaseMs !== b.fireAtBaseMs) {
    return a.fireAtBaseMs - b.fireAtBaseMs;
  }
  return a.seq - b.seq;
}

class MinHeap {
  constructor() {
    this._items = [];
  }

  get size() {
    return this._items.length;
  }

  push(item) {
    const arr = this._items;
    arr.push(item);
    let idx = arr.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >>> 1;
      if (compareTasks(arr[idx], arr[parent]) >= 0) break;
      const tmp = arr[parent];
      arr[parent] = arr[idx];
      arr[idx] = tmp;
      idx = parent;
    }
  }

  peek() {
    return this._items.length > 0 ? this._items[0] : null;
  }

  pop() {
    const arr = this._items;
    if (arr.length === 0) return null;
    const top = arr[0];
    const last = arr.pop();
    if (arr.length > 0) {
      arr[0] = last;
      let idx = 0;
      const len = arr.length;
      while (true) {
        const left = (idx << 1) + 1;
        const right = left + 1;
        let smallest = idx;
        if (left < len && compareTasks(arr[left], arr[smallest]) < 0) {
          smallest = left;
        }
        if (right < len && compareTasks(arr[right], arr[smallest]) < 0) {
          smallest = right;
        }
        if (smallest === idx) break;
        const tmp = arr[idx];
        arr[idx] = arr[smallest];
        arr[smallest] = tmp;
        idx = smallest;
      }
    }
    return top;
  }

  clear() {
    this._items.length = 0;
  }
}

async function drainMicrotasks(turns = 16) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function normalizeSleepWindows(windows) {
  if (!Array.isArray(windows)) return [];
  return windows
    .map((w) => ({
      startMs: Number(w?.startMs) || 0,
      endMs: Number(w?.endMs) || 0,
    }))
    .filter((w) => w.endMs > w.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

export class VirtualClock {
  /**
   * @param {{ startWallMs?: number, startPerfMs?: number, maxStepsPerAdvance?: number, microtaskTurns?: number }} [options]
   */
  constructor(options = {}) {
    this.startWallMs =
      typeof options.startWallMs === "number" && Number.isFinite(options.startWallMs)
        ? Math.max(1, Math.round(options.startWallMs))
        : DEFAULT_START_WALL_MS;
    this.startPerfMs =
      typeof options.startPerfMs === "number" && Number.isFinite(options.startPerfMs)
        ? options.startPerfMs
        : 0;
    this.maxStepsPerAdvance = Math.max(1000, Number(options.maxStepsPerAdvance) || 200_000);
    this.microtaskTurns = Math.max(4, Number(options.microtaskTurns) || 16);

    this._baseMs = 0;
    this._nextSeq = 1;
    this._nextTimerId = 1;
    this._heap = new MinHeap();
    this._activeTimers = new Map();
    this._peers = new Map();
  }

  get nowBaseMs() {
    return this._baseMs;
  }

  get nowWallMs() {
    return Math.round(this.startWallMs + this._baseMs);
  }

  perfNow() {
    return Math.round((this.startPerfMs + this._baseMs) * 1000) / 1000;
  }

  wallNow() {
    return Math.round(this.startWallMs + this._baseMs);
  }

  _getPeerState(peerId) {
    return peerId !== null && peerId !== undefined ? this._peers.get(peerId) || null : null;
  }

  _isPeerSleepingAt(peerState, baseMs) {
    if (!peerState || peerState.sleepWindows.length === 0) return false;
    for (const w of peerState.sleepWindows) {
      if (baseMs >= w.startMs && baseMs < w.endMs) {
        return true;
      }
      if (w.startMs > baseMs) break;
    }
    return false;
  }

  _deferForSleep(peerState, baseMs) {
    if (!peerState || peerState.sleepWindows.length === 0) return baseMs;
    let t = baseMs;
    let changed = true;
    while (changed) {
      changed = false;
      for (const w of peerState.sleepWindows) {
        if (t >= w.startMs && t < w.endMs) {
          t = w.endMs;
          changed = true;
          break;
        }
        if (w.startMs > t) break;
      }
    }
    return t;
  }

  _scheduleInternal({
    fireAtBaseMs,
    fn,
    intervalBaseMs = 0,
    peerId = null,
    kind = "timer",
    deferOnSleep = true,
  }) {
    if (typeof fn !== "function") {
      throw new TypeError("VirtualClock timer callback must be a function");
    }
    const id = this._nextTimerId++;
    const peerState = deferOnSleep ? this._getPeerState(peerId) : null;
    const rawTarget = Math.max(this._baseMs, Number(fireAtBaseMs) || this._baseMs);
    const adjustedTarget = peerState ? this._deferForSleep(peerState, rawTarget) : rawTarget;

    const task = {
      id,
      fireAtBaseMs: adjustedTarget,
      seq: this._nextSeq++,
      fn,
      intervalBaseMs: intervalBaseMs > 0 ? intervalBaseMs : 0,
      peerId,
      kind,
      deferOnSleep: Boolean(deferOnSleep),
      cancelled: false,
    };
    this._activeTimers.set(id, task);
    this._heap.push(task);
    return id;
  }

  /**
   * Schedules a system-level event (e.g. network delivery or adapter physics) that is NOT
   * paused by peer tab-sleep windows.
   */
  schedule(delayMs, fn, { peerId = null, kind = "system" } = {}) {
    const delay = Math.max(0, Number(delayMs) || 0);
    return this._scheduleInternal({
      fireAtBaseMs: this._baseMs + delay,
      fn,
      intervalBaseMs: 0,
      peerId,
      kind,
      deferOnSleep: false,
    });
  }

  scheduleAt(baseMs, fn, { peerId = null, kind = "system" } = {}) {
    return this._scheduleInternal({
      fireAtBaseMs: Math.max(this._baseMs, Number(baseMs) || this._baseMs),
      fn,
      intervalBaseMs: 0,
      peerId,
      kind,
      deferOnSleep: false,
    });
  }

  cancel(id) {
    const task = this._activeTimers.get(id);
    if (!task) return false;
    task.cancelled = true;
    this._activeTimers.delete(id);
    return true;
  }

  setTimeout(fn, ms = 0) {
    const delay = Math.max(0, Number(ms) || 0);
    return this._scheduleInternal({
      fireAtBaseMs: this._baseMs + delay,
      fn,
      intervalBaseMs: 0,
      peerId: null,
      kind: "timeout",
      deferOnSleep: false,
    });
  }

  clearTimeout(id) {
    this.cancel(id);
  }

  setInterval(fn, ms = 0) {
    const step = Math.max(1, Number(ms) || 1);
    return this._scheduleInternal({
      fireAtBaseMs: this._baseMs + step,
      fn,
      intervalBaseMs: step,
      peerId: null,
      kind: "interval",
      deferOnSleep: false,
    });
  }

  clearInterval(id) {
    this.cancel(id);
  }

  /**
   * Returns a per-peer clock & scheduler view matching the exact WatchTogetherPlayer /
   * MediaSyncController `scheduler` contract plus timer inspection & sleep controls.
   *
   * @param {string} peerId
   * @param {{ wallSkewMs?: number, clockDriftPpm?: number, sleepWindows?: Array<{ startMs: number, endMs: number }> }} [config]
   */
  forPeer(peerId, config = {}) {
    const key = String(peerId);
    let state = this._peers.get(key);
    if (!state) {
      state = {
        peerId: key,
        wallSkewMs: Number(config.wallSkewMs) || 0,
        clockDriftPpm: Number(config.clockDriftPpm) || 0,
        sleepWindows: normalizeSleepWindows(config.sleepWindows),
      };
      this._peers.set(key, state);
    } else {
      if (config.wallSkewMs !== undefined) state.wallSkewMs = Number(config.wallSkewMs) || 0;
      if (config.clockDriftPpm !== undefined) {
        state.clockDriftPpm = Number(config.clockDriftPpm) || 0;
      }
      if (config.sleepWindows !== undefined) {
        state.sleepWindows = normalizeSleepWindows(config.sleepWindows);
      }
    }

    const clock = this;
    const driftFactor = () => Math.max(0.5, 1 + state.clockDriftPpm / 1_000_000);

    return {
      peerId: key,
      get wallSkewMs() {
        return state.wallSkewMs;
      },
      get clockDriftPpm() {
        return state.clockDriftPpm;
      },
      perfNow() {
        const val = clock.startPerfMs + clock._baseMs * driftFactor();
        return Math.round(val * 1000) / 1000;
      },
      wallNow() {
        return Math.round(clock.startWallMs + state.wallSkewMs + clock._baseMs * driftFactor());
      },
      setTimeout(fn, ms = 0) {
        const delayPeerMs = Math.max(0, Number(ms) || 0);
        const delayBaseMs = delayPeerMs / driftFactor();
        return clock._scheduleInternal({
          fireAtBaseMs: clock._baseMs + delayBaseMs,
          fn,
          intervalBaseMs: 0,
          peerId: key,
          kind: "timeout",
          deferOnSleep: true,
        });
      },
      clearTimeout(id) {
        clock.cancel(id);
      },
      setInterval(fn, ms = 0) {
        const stepPeerMs = Math.max(1, Number(ms) || 1);
        const stepBaseMs = stepPeerMs / driftFactor();
        return clock._scheduleInternal({
          fireAtBaseMs: clock._baseMs + stepBaseMs,
          fn,
          intervalBaseMs: stepBaseMs,
          peerId: key,
          kind: "interval",
          deferOnSleep: true,
        });
      },
      clearInterval(id) {
        clock.cancel(id);
      },
      activeTimerCount() {
        return clock.activeTimerCount(key);
      },
      isSleeping() {
        return clock._isPeerSleepingAt(state, clock._baseMs);
      },
      clearAllTimers() {
        return clock.clearAllTimers(key);
      },
      addSleepWindow(startMs, endMs) {
        const s = Number(startMs) || 0;
        const e = Number(endMs) || 0;
        if (e <= s) return;
        state.sleepWindows = normalizeSleepWindows([...state.sleepWindows, { startMs: s, endMs: e }]);
      },
      setSleepWindows(windows) {
        state.sleepWindows = normalizeSleepWindows(windows);
      },
      getSleepWindows() {
        return state.sleepWindows.map((w) => ({ ...w }));
      },
    };
  }

  activeTimerCount(peerId = undefined) {
    if (peerId === undefined) {
      return this._activeTimers.size;
    }
    const key = String(peerId);
    let count = 0;
    for (const task of this._activeTimers.values()) {
      if (task.peerId === key) count += 1;
    }
    return count;
  }

  clearAllTimers(peerId = undefined) {
    let cleared = 0;
    if (peerId === undefined) {
      for (const task of this._activeTimers.values()) {
        task.cancelled = true;
        cleared += 1;
      }
      this._activeTimers.clear();
      this._heap.clear();
      return cleared;
    }
    const key = String(peerId);
    for (const [id, task] of this._activeTimers.entries()) {
      if (task.peerId === key) {
        task.cancelled = true;
        this._activeTimers.delete(id);
        cleared += 1;
      }
    }
    return cleared;
  }

  pendingEvents() {
    const out = [];
    for (const task of this._activeTimers.values()) {
      if (!task.cancelled) {
        out.push({
          id: task.id,
          fireAtBaseMs: task.fireAtBaseMs,
          seq: task.seq,
          peerId: task.peerId,
          kind: task.kind,
          intervalBaseMs: task.intervalBaseMs,
        });
      }
    }
    out.sort(compareTasks);
    return out;
  }

  _popNextLiveTask() {
    while (this._heap.size > 0) {
      const top = this._heap.peek();
      if (top.cancelled) {
        this._heap.pop();
        continue;
      }
      return top;
    }
    return null;
  }

  _executeTask(task) {
    // Re-check dynamic sleep windows right before firing!
    if (task.deferOnSleep && task.peerId !== null) {
      const peerState = this._getPeerState(task.peerId);
      if (peerState && this._isPeerSleepingAt(peerState, task.fireAtBaseMs)) {
        const wakeAt = this._deferForSleep(peerState, task.fireAtBaseMs);
        task.fireAtBaseMs = wakeAt;
        task.seq = this._nextSeq++;
        this._heap.push(task);
        return false;
      }
    }

    this._baseMs = task.fireAtBaseMs;

    if (task.intervalBaseMs > 0) {
      // Schedule next interval tick from wake/fire time (prevents wake storm!)
      const nextRaw = this._baseMs + task.intervalBaseMs;
      const peerState = task.deferOnSleep ? this._getPeerState(task.peerId) : null;
      const nextTarget = peerState ? this._deferForSleep(peerState, nextRaw) : nextRaw;
      const nextTask = {
        id: task.id,
        fireAtBaseMs: nextTarget,
        seq: this._nextSeq++,
        fn: task.fn,
        intervalBaseMs: task.intervalBaseMs,
        peerId: task.peerId,
        kind: task.kind,
        deferOnSleep: task.deferOnSleep,
        cancelled: false,
      };
      // Replace live handle BEFORE invoking callback so clearInterval(id) inside callback cancels it
      this._activeTimers.set(task.id, nextTask);
      this._heap.push(nextTask);
    } else {
      this._activeTimers.delete(task.id);
    }

    task.fn();
    return true;
  }

  /**
   * Advances simulation time to `targetBaseMs`, executing all events with
   * `fireAtBaseMs <= targetBaseMs` in deterministic `(fireAtBaseMs, seq)` order
   * and draining microtasks between ticks.
   */
  async advanceTo(targetBaseMs) {
    const target = Math.max(this._baseMs, Number(targetBaseMs) || this._baseMs);
    await drainMicrotasks(this.microtaskTurns);

    let steps = 0;
    while (true) {
      const next = this._popNextLiveTask();
      if (!next || next.fireAtBaseMs > target) {
        break;
      }
      this._heap.pop();
      steps += 1;
      if (steps > this.maxStepsPerAdvance) {
        throw new Error(
          `VirtualClock exceeded maxStepsPerAdvance (${this.maxStepsPerAdvance}) at baseMs=${this._baseMs}`
        );
      }
      const fired = this._executeTask(next);
      if (fired) {
        await drainMicrotasks(this.microtaskTurns);
      }
    }

    this._baseMs = target;
    await drainMicrotasks(this.microtaskTurns);
    return this._baseMs;
  }

  /**
   * Advances simulation time by `deltaMs`.
   */
  async advanceBy(deltaMs) {
    const delta = Math.max(0, Number(deltaMs) || 0);
    return this.advanceTo(this._baseMs + delta);
  }

  /**
   * Advances time executing pending one-shot / system tasks until none remain or `maxMs` elapses.
   * Recurring `setInterval` timers still fire as time advances to scheduled one-shot events,
   * but do not prevent idleness once no one-shot/system tasks remain (unless `includeIntervals: true`).
   */
  async runUntilIdle(maxMs = 60_000, { includeIntervals = false } = {}) {
    const horizon = this._baseMs + Math.max(0, Number(maxMs) || 0);
    await drainMicrotasks(this.microtaskTurns);

    let steps = 0;
    while (true) {
      if (!includeIntervals) {
        let hasOneShot = false;
        for (const t of this._activeTimers.values()) {
          if (!t.cancelled && t.intervalBaseMs === 0 && t.fireAtBaseMs <= horizon) {
            hasOneShot = true;
            break;
          }
        }
        if (!hasOneShot) break;
      }

      const next = this._popNextLiveTask();
      if (!next || next.fireAtBaseMs > horizon) {
        break;
      }
      this._heap.pop();
      steps += 1;
      if (steps > this.maxStepsPerAdvance) {
        throw new Error(
          `VirtualClock.runUntilIdle exceeded maxStepsPerAdvance (${this.maxStepsPerAdvance}) at baseMs=${this._baseMs}`
        );
      }
      const fired = this._executeTask(next);
      if (fired) {
        await drainMicrotasks(this.microtaskTurns);
      }
    }

    await drainMicrotasks(this.microtaskTurns);
    return this._baseMs;
  }
}

export function createVirtualClock(options = {}) {
  return new VirtualClock(options);
}

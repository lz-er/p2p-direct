/**
 * Built-in Non-External Pure-P2P Persistent Bots (ZERO external servers, 100% E2EE).
 *
 * All 5 bots are opt-in (disabled by default in Settings). Because their state is
 * carried directly inside each persistent card's E2EE payload, ANY connected peer
 * clicking a button on the card immediately computes the next state and broadcasts
 * an `edit_message` — even if the peer who originally posted the card has left.
 *
 * Included bots:
 *  1. Live Poll / Decision Maker          (`poll`,       prefix `poll:`)
 *  2. Synced Pomodoro / Focus Timer       (`pomodoro`,   prefix `pomo:`)
 *  3. Shared Checklist / Notes            (`checklist`,  prefix `todo:`)
 *  4. Randomizer / Dice / Coin / Peer     (`randomizer`, prefix `rng:`)
 *  5. Group Scoreboard & 1–5★ Ratings     (`scoreboard`, prefix `score:`)
 */

export const POLL_BOT_ID = "poll";
export const POMODORO_BOT_ID = "pomodoro";
export const CHECKLIST_BOT_ID = "checklist";
export const RANDOMIZER_BOT_ID = "randomizer";
export const SCOREBOARD_BOT_ID = "scoreboard";

export const PURE_P2P_BOT_IDS = Object.freeze([
  POLL_BOT_ID,
  POMODORO_BOT_ID,
  CHECKLIST_BOT_ID,
  RANDOMIZER_BOT_ID,
  SCOREBOARD_BOT_ID,
]);

export const DEFAULT_POLL_SETTINGS = Object.freeze({
  enabled: false,
  question: "What should we do tonight?",
  options: "Slay the Spire 2, Warframe, Watch a Movie, Chill & Chat",
});

export const DEFAULT_POMODORO_SETTINGS = Object.freeze({
  enabled: false,
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
});

export const DEFAULT_CHECKLIST_SETTINGS = Object.freeze({
  enabled: false,
  title: "Room Checklist",
  items: "Pick game or movie, Check mic & audio, Grab snacks",
});

export const DEFAULT_RANDOMIZER_SETTINGS = Object.freeze({
  enabled: false,
  options: "Pizza, Ramen, Burgers, Sushi",
});

export const DEFAULT_SCOREBOARD_SETTINGS = Object.freeze({
  enabled: false,
  mode: "scores", // "scores" | "ratings"
  ratingTitle: "",
});

export function parseCsvOrLines(raw, { max = 6, maxLen = 48, fallback = [] } = {}) {
  const list = String(raw || "")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.slice(0, maxLen));
  const out = [];
  for (const item of list) {
    out.push(item);
    if (out.length >= max) break;
  }
  return out.length > 0 ? out : [...fallback];
}

export function sanitizePollSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const question =
    typeof src.question === "string" && src.question.trim()
      ? src.question.trim().slice(0, 120)
      : DEFAULT_POLL_SETTINGS.question;
  const parsed = parseCsvOrLines(src.options, {
    max: 6,
    maxLen: 44,
    fallback: parseCsvOrLines(DEFAULT_POLL_SETTINGS.options, { max: 6 }),
  });
  const opts = parsed.length >= 2 ? parsed : [...parsed, "Option B"];
  return {
    enabled: Boolean(src.enabled),
    question,
    options: opts.join(", "),
  };
}

export function sanitizePomodoroSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const clampMin = (v, def, min, max) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) return def;
    return n;
  };
  return {
    enabled: Boolean(src.enabled),
    focusMin: clampMin(src.focusMin, DEFAULT_POMODORO_SETTINGS.focusMin, 1, 120),
    breakMin: clampMin(src.breakMin, DEFAULT_POMODORO_SETTINGS.breakMin, 1, 60),
    longBreakMin: clampMin(src.longBreakMin, DEFAULT_POMODORO_SETTINGS.longBreakMin, 1, 90),
  };
}

export function sanitizeChecklistSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const title =
    typeof src.title === "string" && src.title.trim()
      ? src.title.trim().slice(0, 80)
      : DEFAULT_CHECKLIST_SETTINGS.title;
  const items = parseCsvOrLines(src.items, {
    max: 12,
    maxLen: 64,
    fallback: parseCsvOrLines(DEFAULT_CHECKLIST_SETTINGS.items, { max: 12 }),
  });
  return {
    enabled: Boolean(src.enabled),
    title,
    items: items.join(", "),
  };
}

export function sanitizeRandomizerSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const opts = parseCsvOrLines(src.options, {
    max: 12,
    maxLen: 48,
    fallback: parseCsvOrLines(DEFAULT_RANDOMIZER_SETTINGS.options, { max: 12 }),
  });
  return {
    enabled: Boolean(src.enabled),
    options: opts.join(", "),
  };
}

export function sanitizeScoreboardSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: Boolean(src.enabled),
    mode: String(src.mode || "").toLowerCase() === "ratings" ? "ratings" : "scores",
    ratingTitle: typeof src.ratingTitle === "string" ? src.ratingTitle.trim().slice(0, 90) : "",
  };
}

function formatClock(nowMs) {
  try {
    return new Date(nowMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "now";
  }
}

function renderBar(ratio, width = 8) {
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  const filled = Math.round(clamped * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

// ---------------------------------------------------------------------------
// 1. LIVE POLL / DECISION MAKER
// ---------------------------------------------------------------------------

export function parsePollAction(actionId) {
  if (typeof actionId !== "string" || !actionId.startsWith("poll:")) return null;
  const rest = actionId.slice(5);
  if (rest === "reset") return { kind: "reset" };
  if (rest === "dismiss") return { kind: "dismiss" };
  if (rest.startsWith("vote:")) {
    const idx = Number(rest.slice(5));
    if (Number.isInteger(idx) && idx >= 0 && idx < 6) return { kind: "vote", index: idx };
  }
  return null;
}

export function createPollStateFromSettings(settingsInput) {
  const s = sanitizePollSettings(settingsInput);
  return {
    question: s.question,
    options: parseCsvOrLines(s.options, { max: 6, maxLen: 44 }),
    votes: {},
  };
}

export function applyPollAction(prevState, action, { peerId = "self", peerName = "Peer" } = {}) {
  const base = prevState && typeof prevState === "object" ? prevState : createPollStateFromSettings(null);
  const options = Array.isArray(base.options) && base.options.length > 0 ? [...base.options] : ["Yes", "No"];
  const votes = { ...(base.votes && typeof base.votes === "object" ? base.votes : {}) };

  if (action?.kind === "reset") {
    return { question: base.question || DEFAULT_POLL_SETTINGS.question, options, votes: {} };
  }
  if (action?.kind === "vote" && action.index >= 0 && action.index < options.length) {
    // Clicking the same option again toggles vote off; clicking another switches vote cleanly
    if (votes[peerId] && votes[peerId].idx === action.index) {
      delete votes[peerId];
    } else {
      votes[peerId] = { name: peerName || "Peer", idx: action.index };
    }
  }
  return { question: base.question || DEFAULT_POLL_SETTINGS.question, options, votes };
}

export function buildPollCard(stateInput, { nowMs = Date.now() } = {}) {
  const state = stateInput && typeof stateInput === "object" ? stateInput : createPollStateFromSettings(null);
  const options = Array.isArray(state.options) ? state.options : [];
  const votes = state.votes && typeof state.votes === "object" ? state.votes : {};
  const votersByIdx = options.map(() => []);

  for (const v of Object.values(votes)) {
    if (v && Number.isInteger(v.idx) && v.idx >= 0 && v.idx < options.length) {
      votersByIdx[v.idx].push(v.name || "Peer");
    }
  }
  const totalVotes = votersByIdx.reduce((acc, arr) => acc + arr.length, 0);
  const maxVotes = votersByIdx.reduce((m, arr) => Math.max(m, arr.length), 0);

  const fields = options.map((opt, idx) => {
    const voters = votersByIdx[idx];
    const count = voters.length;
    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const leadMark = totalVotes > 0 && count === maxVotes && count > 0 ? " ★" : "";
    const voterNames = voters.length > 0 ? ` · ${voters.slice(0, 5).join(", ")}${voters.length > 5 ? "…" : ""}` : "";
    return {
      label: `${idx + 1}. ${opt}${leadMark}`,
      value: `\`${renderBar(totalVotes > 0 ? count / totalVotes : 0)}\` **${pct}%** (${count})${voterNames}`,
      inline: false,
    };
  });

  const voteButtons = options.map((opt, idx) => {
    const count = votersByIdx[idx].length;
    const shortOpt = opt.length > 22 ? `${opt.slice(0, 21)}…` : opt;
    return {
      id: `poll:vote:${idx}`,
      label: `${idx + 1}. ${shortOpt} (${count})`,
      style: totalVotes > 0 && count === maxVotes && count > 0 ? "success" : "primary",
    };
  });

  const btnRows = [];
  for (let i = 0; i < voteButtons.length; i += 2) {
    btnRows.push(voteButtons.slice(i, i + 2));
  }
  btnRows.push([
    { id: "poll:reset", label: "↺ Reset Votes", style: "warning" },
    { id: "poll:dismiss", label: "✕ Hide", style: "danger" },
  ]);

  return {
    builtinBot: POLL_BOT_ID,
    persistent: true,
    botState: state,
    botUpdatedAt: nowMs,
    subtitle: "POLL",
    title: state.question || DEFAULT_POLL_SETTINGS.question,
    badge: `${totalVotes} ${totalVotes === 1 ? "VOTE" : "VOTES"}`,
    color: "cobalt",
    fields,
    buttons: btnRows,
    footer: `Updated ${formatClock(nowMs)}`,
  };
}

export function summarizePollPill(msg) {
  const votes = msg?.payload?.botState?.votes || {};
  const n = Object.keys(votes).length;
  return `POLL · ${n}V`;
}

// ---------------------------------------------------------------------------
// 2. SYNCED POMODORO / GROUP FOCUS TIMER
// ---------------------------------------------------------------------------

export function parsePomodoroAction(actionId) {
  if (typeof actionId !== "string" || !actionId.startsWith("pomo:")) return null;
  const rest = actionId.slice(5);
  if (rest === "toggle") return { kind: "toggle" };
  if (rest === "reset") return { kind: "reset" };
  if (rest === "dismiss") return { kind: "dismiss" };
  if (rest === "mode:focus" || rest === "mode:break" || rest === "mode:long") {
    return { kind: "mode", mode: rest.slice(5) };
  }
  return null;
}

export function computePomodoroRemainingMs(state, nowMs = Date.now()) {
  if (!state || typeof state !== "object") return 25 * 60 * 1000;
  const rem = Math.max(0, Number(state.remainingMs) || 0);
  if (!state.running || !state.startedAtMs) return rem;
  const elapsed = Math.max(0, nowMs - Number(state.startedAtMs));
  return Math.max(0, rem - elapsed);
}

export function formatCountdownMmSs(ms) {
  const totalSec = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function createPomodoroStateFromSettings(settingsInput) {
  const s = sanitizePomodoroSettings(settingsInput);
  const durationMs = s.focusMin * 60 * 1000;
  return {
    mode: "focus",
    focusMin: s.focusMin,
    breakMin: s.breakMin,
    longBreakMin: s.longBreakMin,
    durationMs,
    remainingMs: durationMs,
    running: false,
    startedAtMs: null,
    sessionsCompleted: 0,
  };
}

export function applyPomodoroAction(prevState, action, { nowMs = Date.now() } = {}) {
  const s = prevState && typeof prevState === "object" ? { ...prevState } : createPomodoroStateFromSettings(null);
  const modeDurationMs = (mode) => {
    if (mode === "break") return (s.breakMin || 5) * 60 * 1000;
    if (mode === "long") return (s.longBreakMin || 15) * 60 * 1000;
    return (s.focusMin || 25) * 60 * 1000;
  };

  if (action?.kind === "mode") {
    const dur = modeDurationMs(action.mode);
    return {
      ...s,
      mode: action.mode,
      durationMs: dur,
      remainingMs: dur,
      running: false,
      startedAtMs: null,
    };
  }
  if (action?.kind === "reset") {
    const dur = modeDurationMs(s.mode);
    return {
      ...s,
      durationMs: dur,
      remainingMs: dur,
      running: false,
      startedAtMs: null,
    };
  }
  if (action?.kind === "toggle") {
    if (s.running) {
      const rem = computePomodoroRemainingMs(s, nowMs);
      const finishedFocus = rem === 0 && s.mode === "focus";
      return {
        ...s,
        remainingMs: rem,
        running: false,
        startedAtMs: null,
        sessionsCompleted: (Number(s.sessionsCompleted) || 0) + (finishedFocus ? 1 : 0),
      };
    } else {
      const curRem = computePomodoroRemainingMs(s, nowMs);
      const nextRem = curRem > 0 ? curRem : modeDurationMs(s.mode);
      return {
        ...s,
        remainingMs: nextRem,
        running: true,
        startedAtMs: nowMs,
      };
    }
  }
  return s;
}

export function buildPomodoroCard(stateInput, { nowMs = Date.now() } = {}) {
  const s = stateInput && typeof stateInput === "object" ? stateInput : createPomodoroStateFromSettings(null);
  const remMs = computePomodoroRemainingMs(s, nowMs);
  const clock = formatCountdownMmSs(remMs);
  const isDone = s.running && remMs === 0;
  const modeLabel =
    s.mode === "break"
      ? `Short Break (${s.breakMin || 5}m)`
      : s.mode === "long"
        ? `Long Break (${s.longBreakMin || 15}m)`
        : `Focus Session (${s.focusMin || 25}m)`;
  const statusLabel = isDone ? "DONE" : s.running ? "RUNNING" : "PAUSED";
  const pct = s.durationMs > 0 ? Math.round(((s.durationMs - remMs) / s.durationMs) * 100) : 0;

  return {
    builtinBot: POMODORO_BOT_ID,
    persistent: true,
    botState: s,
    botUpdatedAt: nowMs,
    subtitle: "POMODORO",
    title: `${modeLabel} — ${clock}`,
    badge: `${statusLabel} · ${clock}`,
    color: s.mode === "focus" ? (s.running ? "coral" : "ochre") : "mint",
    fields: [
      { label: "Countdown", value: `\`${clock}\` · ${renderBar(pct / 100, 10)} **${pct}%**`, inline: true },
      { label: "Completed", value: `**${Number(s.sessionsCompleted) || 0}** sessions`, inline: true },
    ],
    buttons: [
      [
        {
          id: "pomo:toggle",
          label: s.running ? "⏸ Pause" : "▶ Start",
          style: s.running ? "warning" : "success",
        },
        { id: "pomo:reset", label: "↺ Reset", style: "secondary" },
      ],
      [
        { id: "pomo:mode:focus", label: `${s.focusMin || 25}m Focus`, style: s.mode === "focus" ? "primary" : "secondary" },
        { id: "pomo:mode:break", label: `${s.breakMin || 5}m Break`, style: s.mode === "break" ? "primary" : "secondary" },
        { id: "pomo:mode:long", label: `${s.longBreakMin || 15}m Long`, style: s.mode === "long" ? "primary" : "secondary" },
        { id: "pomo:dismiss", label: "✕ Hide", style: "danger" },
      ],
    ],
    footer: `Updated ${formatClock(nowMs)}`,
  };
}

export function summarizePomodoroPill(msg, nowMs = Date.now()) {
  const st = msg?.payload?.botState;
  const clock = formatCountdownMmSs(computePomodoroRemainingMs(st, nowMs));
  return st?.running ? `POMO · ${clock}` : `POMO · PAUSED ${clock}`;
}

// ---------------------------------------------------------------------------
// 3. SHARED CHECKLIST / NOTES
// ---------------------------------------------------------------------------

export function parseChecklistAction(actionId) {
  if (typeof actionId !== "string" || !actionId.startsWith("todo:")) return null;
  const rest = actionId.slice(5);
  if (rest === "uncheck_all") return { kind: "uncheck_all" };
  if (rest === "clear_done") return { kind: "clear_done" };
  if (rest === "dismiss") return { kind: "dismiss" };
  if (rest.startsWith("toggle:")) {
    const idx = Number(rest.slice(7));
    if (Number.isInteger(idx) && idx >= 0 && idx < 12) return { kind: "toggle", index: idx };
  }
  return null;
}

export function extractChecklistAppendText(text) {
  if (typeof text !== "string") return null;
  const m = /^\s*\+todo\s+(.{1,80})$/i.exec(text.trim());
  return m && m[1].trim() ? m[1].trim() : null;
}

export function createChecklistStateFromSettings(settingsInput) {
  const s = sanitizeChecklistSettings(settingsInput);
  return {
    title: s.title,
    items: parseCsvOrLines(s.items, { max: 12, maxLen: 64 }).map((text) => ({
      text,
      done: false,
      by: "",
    })),
  };
}

export function applyChecklistAction(prevState, action, { peerName = "Peer" } = {}) {
  const base = prevState && typeof prevState === "object" ? prevState : createChecklistStateFromSettings(null);
  const items = Array.isArray(base.items) ? base.items.map((it) => ({ ...it })) : [];

  if (action?.kind === "toggle" && action.index >= 0 && action.index < items.length) {
    const cur = items[action.index];
    cur.done = !cur.done;
    cur.by = cur.done ? peerName || "Peer" : "";
  } else if (action?.kind === "uncheck_all") {
    for (const it of items) {
      it.done = false;
      it.by = "";
    }
  } else if (action?.kind === "clear_done") {
    return {
      title: base.title || DEFAULT_CHECKLIST_SETTINGS.title,
      items: items.filter((it) => !it.done),
    };
  } else if (action?.kind === "add" && action.text && items.length < 12) {
    items.push({ text: String(action.text).trim().slice(0, 64), done: false, by: "" });
  }
  return { title: base.title || DEFAULT_CHECKLIST_SETTINGS.title, items };
}

export function buildChecklistCard(stateInput, { nowMs = Date.now() } = {}) {
  const state = stateInput && typeof stateInput === "object" ? stateInput : createChecklistStateFromSettings(null);
  const items = Array.isArray(state.items) ? state.items : [];
  const doneCount = items.filter((it) => it.done).length;
  const allDone = items.length > 0 && doneCount === items.length;

  const fields =
    items.length > 0
      ? items.map((it, idx) => ({
          label: `${it.done ? "☑" : "☐"} #${idx + 1}`,
          value: it.done
            ? `**${it.text}** · _done${it.by ? ` by ${it.by}` : ""}_`
            : it.text,
          inline: false,
        }))
      : [{ label: "Empty List", value: "Type `+todo Buy snacks` in chat or edit items in Settings.", inline: false }];

  const toggleBtns = items.map((it, idx) => {
    const short = it.text.length > 18 ? `${it.text.slice(0, 17)}…` : it.text;
    return {
      id: `todo:toggle:${idx}`,
      label: `${it.done ? "☑" : "☐"} ${idx + 1}. ${short}`,
      style: it.done ? "success" : "secondary",
    };
  });
  const rows = [];
  for (let i = 0; i < toggleBtns.length; i += 2) {
    rows.push(toggleBtns.slice(i, i + 2));
  }
  rows.push([
    { id: "todo:uncheck_all", label: "↺ Uncheck All", style: "secondary" },
    { id: "todo:clear_done", label: "Clear Done", style: "warning" },
    { id: "todo:dismiss", label: "✕ Hide", style: "danger" },
  ]);

  return {
    builtinBot: CHECKLIST_BOT_ID,
    persistent: true,
    botState: state,
    botUpdatedAt: nowMs,
    subtitle: "CHECKLIST",
    title: state.title || DEFAULT_CHECKLIST_SETTINGS.title,
    badge: `${doneCount}/${items.length} DONE`,
    color: allDone ? "mint" : "cyan",
    text: "Add via `+todo <item>`",
    fields,
    buttons: rows,
    footer: `Updated ${formatClock(nowMs)}`,
  };
}

export function summarizeChecklistPill(msg) {
  const items = msg?.payload?.botState?.items || [];
  const done = items.filter((i) => i.done).length;
  return `TODO · ${done}/${items.length}`;
}

// ---------------------------------------------------------------------------
// 4. RANDOMIZER / TIE-BREAKER / DICE & COIN
// ---------------------------------------------------------------------------

export function parseRandomizerAction(actionId) {
  if (typeof actionId !== "string" || !actionId.startsWith("rng:")) return null;
  const rest = actionId.slice(4);
  if (rest === "coin") return { kind: "coin" };
  if (rest === "peer") return { kind: "peer" };
  if (rest === "option") return { kind: "option" };
  if (rest === "clear") return { kind: "clear" };
  if (rest === "dismiss") return { kind: "dismiss" };
  if (rest === "dice:d6" || rest === "dice:d20" || rest === "dice:2d6" || rest === "dice:d100") {
    return { kind: "dice", expr: rest.slice(5) };
  }
  return null;
}

export function createRandomizerStateFromSettings(settingsInput) {
  const s = sanitizeRandomizerSettings(settingsInput);
  return {
    options: parseCsvOrLines(s.options, { max: 12, maxLen: 48 }),
    lastLabel: "",
    lastResult: "",
    history: [],
  };
}

export function applyRandomizerAction(
  prevState,
  action,
  { peerName = "Peer", roomPeers = [], rng = Math.random, nowMs = Date.now() } = {}
) {
  const base = prevState && typeof prevState === "object" ? prevState : createRandomizerStateFromSettings(null);
  const options = Array.isArray(base.options) ? [...base.options] : [];
  const history = Array.isArray(base.history) ? [...base.history] : [];

  if (action?.kind === "clear") {
    return { options, lastLabel: "", lastResult: "", history: [] };
  }

  const pickInt = (max) => Math.floor(rng() * max);
  let label = "";
  let result = "";

  if (action?.kind === "coin") {
    label = "Coin Flip";
    result = rng() < 0.5 ? "HEADS" : "TAILS";
  } else if (action?.kind === "peer") {
    label = "Random Peer";
    const names = Array.isArray(roomPeers) && roomPeers.length > 0 ? roomPeers : [peerName || "Peer"];
    result = names[pickInt(names.length)];
  } else if (action?.kind === "option") {
    label = "Option Pick";
    result = options.length > 0 ? options[pickInt(options.length)] : "No options set";
  } else if (action?.kind === "dice") {
    label = `Roll ${action.expr}`;
    if (action.expr === "2d6") {
      const a = pickInt(6) + 1;
      const b = pickInt(6) + 1;
      result = `${a + b} (${a} + ${b})`;
    } else {
      const sides = Number(action.expr.slice(1)) || 6;
      const val = pickInt(sides) + 1;
      const crit = sides === 20 && val === 20 ? " — NAT 20!" : sides === 20 && val === 1 ? " — NAT 1!" : "";
      result = `${val}${crit}`;
    }
  } else {
    return base;
  }

  const nextHistory = [{ label, result, by: peerName || "Peer", ts: nowMs }, ...history].slice(0, 5);
  return { options, lastLabel: label, lastResult: result, history: nextHistory };
}

export function buildRandomizerCard(stateInput, { nowMs = Date.now() } = {}) {
  const state = stateInput && typeof stateInput === "object" ? stateInput : createRandomizerStateFromSettings(null);
  const history = Array.isArray(state.history) ? state.history : [];

  const fields = [];
  if (state.lastResult) {
    fields.push({
      label: `Latest · ${state.lastLabel || "Roll"}`,
      value: `**${state.lastResult}**${history[0]?.by ? ` (rolled by ${history[0].by})` : ""}`,
      inline: false,
    });
  }
  if (history.length > 1) {
    fields.push({
      label: "Recent Rolls",
      value: history
        .slice(1)
        .map((h) => `${h.label}: **${h.result}** (${h.by})`)
        .join(" · "),
      inline: false,
    });
  }
  if (state.options?.length > 0) {
    fields.push({
      label: "Configured Options",
      value: state.options.join(" · "),
      inline: false,
    });
  }

  return {
    builtinBot: RANDOMIZER_BOT_ID,
    persistent: true,
    botState: state,
    botUpdatedAt: nowMs,
    subtitle: "RANDOMIZER",
    title: state.lastResult ? `${state.lastLabel}: ${state.lastResult}` : "Randomizer & Dice",
    badge: state.lastResult ? String(state.lastResult).slice(0, 14).toUpperCase() : "READY",
    color: "ochre",
    fields,
    buttons: [
      [
        { id: "rng:coin", label: "🪙 Flip Coin", style: "primary" },
        { id: "rng:peer", label: "👥 Pick Peer", style: "success" },
        { id: "rng:option", label: "🎯 Pick Option", style: "warning" },
      ],
      [
        { id: "rng:dice:d6", label: "🎲 d6", style: "secondary" },
        { id: "rng:dice:d20", label: "🎲 d20", style: "secondary" },
        { id: "rng:dice:2d6", label: "🎲 2d6", style: "secondary" },
        { id: "rng:dice:d100", label: "🎲 d100", style: "secondary" },
      ],
      [
        { id: "rng:clear", label: "Clear History", style: "secondary" },
        { id: "rng:dismiss", label: "✕ Hide", style: "danger" },
      ],
    ],
    footer: `Updated ${formatClock(nowMs)}`,
  };
}

export function summarizeRandomizerPill(msg) {
  const res = msg?.payload?.botState?.lastResult;
  return res ? `RNG · ${String(res).slice(0, 10).toUpperCase()}` : "RNG · DICE";
}

// ---------------------------------------------------------------------------
// 5. GROUP SCOREBOARD & WATCH TOGETHER 1–5★ RATING BOARD
// ---------------------------------------------------------------------------

export function parseScoreboardAction(actionId) {
  if (typeof actionId !== "string" || !actionId.startsWith("score:")) return null;
  const rest = actionId.slice(6);
  if (rest === "mode:scores") return { kind: "mode", mode: "scores" };
  if (rest === "mode:ratings") return { kind: "mode", mode: "ratings" };
  if (rest === "sync_peers") return { kind: "sync_peers" };
  if (rest === "use_watch") return { kind: "use_watch" };
  if (rest === "reset") return { kind: "reset" };
  if (rest === "dismiss") return { kind: "dismiss" };
  if (rest.startsWith("inc:")) {
    const idx = Number(rest.slice(4));
    if (Number.isInteger(idx) && idx >= 0 && idx < 6) return { kind: "delta", index: idx, delta: 1 };
  }
  if (rest.startsWith("dec:")) {
    const idx = Number(rest.slice(4));
    if (Number.isInteger(idx) && idx >= 0 && idx < 6) return { kind: "delta", index: idx, delta: -1 };
  }
  if (rest.startsWith("rate:")) {
    const stars = Number(rest.slice(5));
    if (Number.isInteger(stars) && stars >= 1 && stars <= 5) return { kind: "rate", stars };
  }
  return null;
}

export function createScoreboardStateFromSettings(settingsInput, { roomPeers = [], watchTitle = "" } = {}) {
  const s = sanitizeScoreboardSettings(settingsInput);
  const peers = Array.isArray(roomPeers) && roomPeers.length > 0 ? roomPeers.slice(0, 6) : [{ id: "self", name: "Host" }];
  return {
    mode: s.mode,
    entries: peers.map((p) => ({
      id: typeof p === "string" ? p : p.id || p.name,
      name: typeof p === "string" ? p : p.name || "Peer",
      score: 0,
    })),
    ratingTitle: s.ratingTitle || watchTitle || "Tonight's Watch / Pick",
    ratings: {},
  };
}

export function applyScoreboardAction(
  prevState,
  action,
  { peerId = "self", peerName = "Peer", roomPeers = [], watchTitle = "" } = {}
) {
  const base =
    prevState && typeof prevState === "object"
      ? prevState
      : createScoreboardStateFromSettings(null, { roomPeers, watchTitle });
  const entries = Array.isArray(base.entries) ? base.entries.map((e) => ({ ...e })) : [];
  const ratings = { ...(base.ratings && typeof base.ratings === "object" ? base.ratings : {}) };
  let mode = base.mode === "ratings" ? "ratings" : "scores";
  let ratingTitle = base.ratingTitle || watchTitle || "Tonight's Watch / Pick";

  if (action?.kind === "mode") {
    mode = action.mode;
    if (mode === "ratings" && watchTitle && (!base.ratingTitle || base.ratingTitle === "Tonight's Watch / Pick")) {
      ratingTitle = watchTitle;
    }
  } else if (action?.kind === "use_watch") {
    if (watchTitle) ratingTitle = watchTitle;
  } else if (action?.kind === "sync_peers") {
    const known = new Set(entries.map((e) => e.id));
    for (const p of roomPeers || []) {
      const pid = typeof p === "string" ? p : p.id || p.name;
      const pname = typeof p === "string" ? p : p.name || "Peer";
      if (!known.has(pid) && entries.length < 6) {
        entries.push({ id: pid, name: pname, score: 0 });
        known.add(pid);
      }
    }
    if (!known.has(peerId) && entries.length < 6) {
      entries.push({ id: peerId, name: peerName || "Peer", score: 0 });
    }
  } else if (action?.kind === "delta" && action.index >= 0 && action.index < entries.length) {
    entries[action.index].score = (Number(entries[action.index].score) || 0) + Number(action.delta || 0);
  } else if (action?.kind === "rate" && action.stars >= 1 && action.stars <= 5) {
    ratings[peerId] = { name: peerName || "Peer", stars: action.stars };
  } else if (action?.kind === "reset") {
    if (mode === "ratings") {
      return { mode, entries, ratingTitle, ratings: {} };
    }
    for (const e of entries) e.score = 0;
  }

  return { mode, entries, ratingTitle, ratings };
}

export function buildScoreboardCard(stateInput, { nowMs = Date.now() } = {}) {
  const state =
    stateInput && typeof stateInput === "object" ? stateInput : createScoreboardStateFromSettings(null);
  const mode = state.mode === "ratings" ? "ratings" : "scores";

  if (mode === "ratings") {
    const ratings = state.ratings && typeof state.ratings === "object" ? state.ratings : {};
    const list = Object.values(ratings);
    const avg =
      list.length > 0
        ? (list.reduce((acc, r) => acc + (Number(r.stars) || 0), 0) / list.length).toFixed(1)
        : "—";
    const fields =
      list.length > 0
        ? list.map((r) => {
            const st = Math.max(1, Math.min(5, Number(r.stars) || 1));
            return {
              label: r.name || "Peer",
              value: `${"★".repeat(st)}${"☆".repeat(5 - st)} **(${st}/5)**`,
              inline: true,
            };
          })
        : [{ label: "No Ratings Yet", value: "Click 1★–5★ below to rate it!", inline: false }];

    return {
      builtinBot: SCOREBOARD_BOT_ID,
      persistent: true,
      botState: state,
      botUpdatedAt: nowMs,
      subtitle: "RATINGS",
      title: `Rate It: ${state.ratingTitle || "Tonight's Watch / Pick"}`,
      badge: list.length > 0 ? `★ ${avg} / 5 (${list.length})` : "RATE 1–5★",
      color: "ochre",
      fields,
      buttons: [
        [
          { id: "score:rate:1", label: "1★", style: "secondary" },
          { id: "score:rate:2", label: "2★", style: "secondary" },
          { id: "score:rate:3", label: "3★", style: "primary" },
          { id: "score:rate:4", label: "4★", style: "success" },
          { id: "score:rate:5", label: "5★", style: "warning" },
        ],
        [
          { id: "score:use_watch", label: "Use Watch Title", style: "secondary" },
          { id: "score:mode:scores", label: "Scoreboard", style: "secondary" },
          { id: "score:reset", label: "↺ Clear", style: "warning" },
          { id: "score:dismiss", label: "✕ Hide", style: "danger" },
        ],
      ],
      footer: `Updated ${formatClock(nowMs)}`,
    };
  }

  // Scoreboard mode
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const ranked = entries
    .map((e, origIdx) => ({ ...e, origIdx }))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

  const fields =
    ranked.length > 0
      ? ranked.map((e, rankIdx) => ({
          label: `#${rankIdx + 1} ${e.name}`,
          value: `**${Number(e.score) || 0} pts**`,
          inline: true,
        }))
      : [{ label: "No Players", value: "Click Sync Peers.", inline: false }];

  const scoreBtns = [];
  for (let i = 0; i < Math.min(4, entries.length); i++) {
    const short = entries[i].name.slice(0, 10);
    scoreBtns.push({ id: `score:inc:${i}`, label: `+1 ${short}`, style: "success" });
    scoreBtns.push({ id: `score:dec:${i}`, label: `-1 ${short}`, style: "secondary" });
  }
  const btnRows = [];
  for (let i = 0; i < scoreBtns.length; i += 4) {
    btnRows.push(scoreBtns.slice(i, i + 4));
  }
  btnRows.push([
    { id: "score:sync_peers", label: "+ Sync Peers", style: "primary" },
    { id: "score:mode:ratings", label: "★ 1–5 Ratings", style: "warning" },
    { id: "score:reset", label: "↺ Reset", style: "secondary" },
    { id: "score:dismiss", label: "✕ Hide", style: "danger" },
  ]);

  const leader = ranked[0];
  return {
    builtinBot: SCOREBOARD_BOT_ID,
    persistent: true,
    botState: state,
    botUpdatedAt: nowMs,
    subtitle: "SCOREBOARD",
    title: "Room Scoreboard",
    badge: leader ? `LEAD: ${leader.name.slice(0, 10).toUpperCase()} (${leader.score})` : "0 PTS",
    color: "mint",
    fields,
    buttons: btnRows,
    footer: `Updated ${formatClock(nowMs)}`,
  };
}

export function summarizeScoreboardPill(msg) {
  const st = msg?.payload?.botState;
  if (st?.mode === "ratings") {
    const list = Object.values(st.ratings || {});
    if (list.length > 0) {
      const avg = (list.reduce((a, r) => a + (Number(r.stars) || 0), 0) / list.length).toFixed(1);
      return `RATE · ★${avg}`;
    }
    return "RATE · 1-5★";
  }
  return "SCOREBOARD";
}

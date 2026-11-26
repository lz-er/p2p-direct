import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHECKLIST_BOT_ID,
  POLL_BOT_ID,
  POMODORO_BOT_ID,
  RANDOMIZER_BOT_ID,
  SCOREBOARD_BOT_ID,
  applyChecklistAction,
  applyPollAction,
  applyPomodoroAction,
  applyRandomizerAction,
  applyScoreboardAction,
  buildChecklistCard,
  buildPollCard,
  buildPomodoroCard,
  buildRandomizerCard,
  buildScoreboardCard,
  computePomodoroRemainingMs,
  createChecklistStateFromSettings,
  createPollStateFromSettings,
  createPomodoroStateFromSettings,
  createRandomizerStateFromSettings,
  createScoreboardStateFromSettings,
  extractChecklistAppendText,
  formatCountdownMmSs,
  sanitizeChecklistSettings,
  sanitizePollSettings,
  sanitizePomodoroSettings,
  sanitizeRandomizerSettings,
  sanitizeScoreboardSettings,
} from "../room_bots.js";

describe("room_bots (5 Pure-P2P Offline Bots)", () => {
  it("defaults all 5 room bots to disabled", () => {
    assert.equal(sanitizePollSettings(null).enabled, false);
    assert.equal(sanitizePomodoroSettings(null).enabled, false);
    assert.equal(sanitizeChecklistSettings(null).enabled, false);
    assert.equal(sanitizeRandomizerSettings(null).enabled, false);
    assert.equal(sanitizeScoreboardSettings(null).enabled, false);
  });

  it("1. Live Poll: multi-peer voting, vote switching, retracting, and reset", () => {
    let st = createPollStateFromSettings({ question: "Game night?", options: "StS2, Warframe" });
    st = applyPollAction(st, { kind: "vote", index: 0 }, { peerId: "a", peerName: "Alice" });
    st = applyPollAction(st, { kind: "vote", index: 1 }, { peerId: "b", peerName: "Bob" });
    let card = buildPollCard(st);
    assert.equal(card.builtinBot, POLL_BOT_ID);
    assert.equal(card.badge, "2 VOTES");
    assert.match(card.fields[0].value, /50%/);

    // Bob switches to StS2
    st = applyPollAction(st, { kind: "vote", index: 0 }, { peerId: "b", peerName: "Bob" });
    card = buildPollCard(st);
    assert.match(card.fields[0].value, /100%.*Alice, Bob/);

    // Alice retracts her vote by clicking same option
    st = applyPollAction(st, { kind: "vote", index: 0 }, { peerId: "a", peerName: "Alice" });
    assert.equal(Object.keys(st.votes).length, 1);

    st = applyPollAction(st, { kind: "reset" });
    assert.equal(Object.keys(st.votes).length, 0);
  });

  it("2. Synced Pomodoro: start, elapsed countdown, pause, mode switch, and reset", () => {
    const t0 = 1_700_000_000_000;
    let st = createPomodoroStateFromSettings({ focusMin: 25, breakMin: 5, longBreakMin: 15 });
    assert.equal(formatCountdownMmSs(st.remainingMs), "25:00");

    st = applyPomodoroAction(st, { kind: "toggle" }, { nowMs: t0 });
    assert.equal(st.running, true);
    assert.equal(formatCountdownMmSs(computePomodoroRemainingMs(st, t0 + 65_000)), "23:55");

    st = applyPomodoroAction(st, { kind: "toggle" }, { nowMs: t0 + 65_000 });
    assert.equal(st.running, false);
    assert.equal(formatCountdownMmSs(st.remainingMs), "23:55");

    st = applyPomodoroAction(st, { kind: "mode", mode: "break" }, { nowMs: t0 + 70_000 });
    const card = buildPomodoroCard(st, { nowMs: t0 + 70_000 });
    assert.equal(card.builtinBot, POMODORO_BOT_ID);
    assert.match(card.title, /Short Break \(5m\) — 05:00/);
  });

  it("3. Shared Checklist: toggle, +todo append, clear done, and uncheck all", () => {
    assert.equal(extractChecklistAppendText("+todo Bring drinks"), "Bring drinks");
    assert.equal(extractChecklistAppendText("hello world"), null);

    let st = createChecklistStateFromSettings({ title: "Co-op Prep", items: "Mic check, Ready up" });
    st = applyChecklistAction(st, { kind: "add", text: "Pick snacks" }, { peerName: "Bob" });
    assert.equal(st.items.length, 3);

    st = applyChecklistAction(st, { kind: "toggle", index: 0 }, { peerName: "Alice" });
    let card = buildChecklistCard(st);
    assert.equal(card.builtinBot, CHECKLIST_BOT_ID);
    assert.equal(card.badge, "1/3 DONE");
    assert.match(card.fields[0].value, /Alice/);

    st = applyChecklistAction(st, { kind: "clear_done" });
    assert.equal(st.items.length, 2);
  });

  it("4. Randomizer & Dice: coin, random peer, custom option, and tabletop dice", () => {
    let st = createRandomizerStateFromSettings({ options: "Pizza, Ramen" });
    st = applyRandomizerAction(st, { kind: "coin" }, { peerName: "Alice", rng: () => 0.1 });
    assert.equal(st.lastResult, "HEADS");

    st = applyRandomizerAction(st, { kind: "peer" }, { peerName: "Alice", roomPeers: ["Alice", "Bob"], rng: () => 0.8 });
    assert.equal(st.lastResult, "Bob");

    st = applyRandomizerAction(st, { kind: "option" }, { peerName: "Bob", rng: () => 0.7 });
    assert.equal(st.lastResult, "Ramen");

    st = applyRandomizerAction(st, { kind: "dice", expr: "d20" }, { peerName: "Bob", rng: () => 0.99 });
    assert.match(st.lastResult, /20 — NAT 20!/);

    const card = buildRandomizerCard(st);
    assert.equal(card.builtinBot, RANDOMIZER_BOT_ID);
    assert.equal(st.history.length, 4);
  });

  it("5. Group Scoreboard & 1–5★ Rating Board: points, peer sync, mode switch, and average rating", () => {
    let st = createScoreboardStateFromSettings(
      { mode: "scores", ratingTitle: "" },
      { roomPeers: [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }], watchTitle: "Dune Part Two" }
    );
    st = applyScoreboardAction(st, { kind: "delta", index: 0, delta: 1 });
    st = applyScoreboardAction(st, { kind: "delta", index: 0, delta: 1 });
    st = applyScoreboardAction(st, { kind: "delta", index: 1, delta: 1 });
    let card = buildScoreboardCard(st);
    assert.equal(card.builtinBot, SCOREBOARD_BOT_ID);
    assert.match(card.badge, /LEAD: ALICE \(2\)/);

    st = applyScoreboardAction(st, { kind: "mode", mode: "ratings" }, { watchTitle: "Dune Part Two" });
    st = applyScoreboardAction(st, { kind: "rate", stars: 5 }, { peerId: "a", peerName: "Alice" });
    st = applyScoreboardAction(st, { kind: "rate", stars: 4 }, { peerId: "b", peerName: "Bob" });
    card = buildScoreboardCard(st);
    assert.equal(card.title, "Rate It: Dune Part Two");
    assert.equal(card.badge, "★ 4.5 / 5 (2)");
  });
});

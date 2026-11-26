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
  parseChecklistAction,
  sanitizeChecklistSettings,
  sanitizePollSettings,
  sanitizePomodoroSettings,
  sanitizeRandomizerSettings,
  sanitizeScoreboardSettings,
  updateChecklistFromInlineEdit,
  updatePollFromInlineEdit,
  updatePomodoroFromInlineEdit,
  updateRandomizerFromInlineEdit,
  updateScoreboardFromInlineEdit,
} from "../room_bots.js";

describe("room_bots (5 Pure-P2P Offline Bots)", () => {
  it("defaults all 5 room bots to disabled", () => {
    assert.equal(sanitizePollSettings(null).enabled, false);
    assert.equal(sanitizePomodoroSettings(null).enabled, false);
    assert.equal(sanitizeChecklistSettings(null).enabled, false);
    assert.equal(sanitizeRandomizerSettings(null).enabled, false);
    assert.equal(sanitizeScoreboardSettings(null).enabled, false);
  });

  it("1. Live Poll: multi-peer voting, vote switching, retracting, reset, and declarative progress blocks", () => {
    let st = createPollStateFromSettings({ question: "Game night?", options: "StS2, Warframe" });
    st = applyPollAction(st, { kind: "vote", index: 0 }, { peerId: "a", peerName: "Alice" });
    st = applyPollAction(st, { kind: "vote", index: 1 }, { peerId: "b", peerName: "Bob" });
    let card = buildPollCard(st);
    assert.equal(card.builtinBot, POLL_BOT_ID);
    assert.equal(card.badge, "2 VOTES");
    assert.equal(card.blocks.length, 2);
    assert.equal(card.blocks[0].type, "progress");
    assert.match(card.blocks[0].display, /50%/);

    // Bob switches to StS2
    st = applyPollAction(st, { kind: "vote", index: 0 }, { peerId: "b", peerName: "Bob" });
    card = buildPollCard(st);
    assert.match(card.blocks[0].display, /100%.*Alice, Bob/);
    assert.equal(card.blocks[0].value, 2);

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

  it("3. Shared Checklist: toggle, in-card add_inline, +todo append, clear done, and uncheck all", () => {
    assert.equal(extractChecklistAppendText("+todo Bring drinks"), "Bring drinks");
    assert.equal(extractChecklistAppendText("hello world"), null);
    assert.deepEqual(parseChecklistAction("todo:add_inline"), { kind: "add_inline" });

    let st = createChecklistStateFromSettings({ title: "Co-op Prep", items: "Mic check, Ready up" });
    st = applyChecklistAction(st, { kind: "add_inline", text: "Pick snacks, Start stream" }, { peerName: "Bob" });
    assert.equal(st.items.length, 4);
    assert.equal(st.items[3].text, "Start stream");

    st = applyChecklistAction(st, { kind: "toggle", index: 0 }, { peerName: "Alice" });
    let card = buildChecklistCard(st);
    assert.equal(card.builtinBot, CHECKLIST_BOT_ID);
    assert.equal(card.badge, "1/4 DONE");
    assert.match(card.fields[0].value, /Alice/);
    assert.equal(card.blocks[0].type, "input");
    assert.equal(card.blocks[0].id, "todo:add_inline");

    st = applyChecklistAction(st, { kind: "clear_done" });
    assert.equal(st.items.length, 3);
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

  it("6. Visual inline edit updaters preserve existing votes, checked state, scores, and history", () => {
    // Poll: re-index votes cleanly when options reorder or expand
    let poll = createPollStateFromSettings({ question: "Game?", options: "StS2, Warframe" });
    poll = applyPollAction(poll, { kind: "vote", index: 1 }, { peerId: "a", peerName: "Alice" });
    const pollEdited = updatePollFromInlineEdit(poll, {
      question: "Friday Game?",
      options: ["Hades 2", "Warframe", "StS2"],
    });
    assert.equal(pollEdited.question, "Friday Game?");
    assert.deepEqual(pollEdited.options, ["Hades 2", "Warframe", "StS2"]);
    assert.equal(pollEdited.votes.a.idx, 1); // Warframe stayed at index 1

    // Checklist: preserves done/by status on matching items
    let list = createChecklistStateFromSettings({ title: "Prep", items: "Mic, Snacks" });
    list = applyChecklistAction(list, { kind: "toggle", index: 0 }, { peerName: "Alice" });
    const listEdited = updateChecklistFromInlineEdit(list, {
      title: "Raid Prep",
      items: ["Mic", "Potions"],
    });
    assert.equal(listEdited.title, "Raid Prep");
    assert.equal(listEdited.items[0].done, true);
    assert.equal(listEdited.items[0].by, "Alice");
    assert.equal(listEdited.items[1].done, false);

    // Randomizer: keeps history intact
    let rand = createRandomizerStateFromSettings({ options: "A, B" });
    rand = applyRandomizerAction(rand, { kind: "coin" }, { peerName: "Alice", rng: () => 0.1 });
    const randEdited = updateRandomizerFromInlineEdit(rand, { options: ["Pizza", "Sushi", "Tacos"] });
    assert.deepEqual(randEdited.options, ["Pizza", "Sushi", "Tacos"]);
    assert.equal(randEdited.history.length, 1);

    // Pomodoro: updates durations cleanly
    const pomo = createPomodoroStateFromSettings({ focusMin: 25, breakMin: 5, longBreakMin: 15 });
    const pomoEdited = updatePomodoroFromInlineEdit(pomo, { focusMin: 40, breakMin: 10, longBreakMin: 20 });
    assert.equal(pomoEdited.focusMin, 40);
    assert.equal(formatCountdownMmSs(pomoEdited.remainingMs), "40:00");

    // Scoreboard: preserves scores for existing players while adding new ones
    let sb = createScoreboardStateFromSettings(
      { mode: "scores" },
      { roomPeers: [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }] }
    );
    sb = applyScoreboardAction(sb, { kind: "delta", index: 0, delta: 3 });
    const sbEdited = updateScoreboardFromInlineEdit(sb, {
      mode: "scores",
      ratingTitle: "Movie Night",
      players: ["Alice", "Charlie"],
    });
    assert.equal(sbEdited.entries[0].score, 3);
    assert.equal(sbEdited.entries[1].name, "Charlie");
    assert.equal(sbEdited.entries[1].score, 0);
  });
});

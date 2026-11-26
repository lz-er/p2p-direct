import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_WARFRAME_SETTINGS,
  WARFRAME_BOT_ID,
  buildWarframeCardFromData,
  buildWarframeErrorCard,
  fetchWarframeWorldstateCard,
  findPersistentWarframeMessage,
  formatWarframeCountdown,
  isPersistentWarframeMessage,
  parseWarframeAction,
  sanitizeWarframeSettings,
  summarizeWarframePill,
} from "../warframe_bot.js";

test("sanitizeWarframeSettings enforces valid defaults and rejects bogus values", () => {
  assert.deepEqual(sanitizeWarframeSettings(null), DEFAULT_WARFRAME_SETTINGS);
  assert.deepEqual(
    sanitizeWarframeSettings({
      enabled: 1,
      platform: "PS4",
      defaultView: "fissures",
      autoRefreshSec: 60,
    }),
    {
      enabled: true,
      platform: "ps4",
      defaultView: "fissures",
      autoRefreshSec: 60,
    }
  );
  assert.deepEqual(
    sanitizeWarframeSettings({
      enabled: false,
      platform: "invalid",
      defaultView: "bogus",
      autoRefreshSec: 999,
    }),
    DEFAULT_WARFRAME_SETTINGS
  );
});

test("formatWarframeCountdown computes live countdowns from ISO timestamps and falls back cleanly", () => {
  const now = Date.parse("2026-11-26T18:00:00.000Z");
  assert.equal(formatWarframeCountdown("2026-11-26T18:10:05.000Z", now), "10m 5s");
  assert.equal(formatWarframeCountdown("2026-11-26T18:00:42.000Z", now), "42s");
  assert.equal(formatWarframeCountdown("2026-11-26T20:15:00.000Z", now), "2h 15m");
  assert.equal(formatWarframeCountdown("2026-11-28T21:30:00.000Z", now), "2d 3h 30m");
  assert.equal(formatWarframeCountdown("2026-11-26T17:59:00.000Z", now), "Expired");
  assert.equal(formatWarframeCountdown(null, now, "4m 12s"), "4m 12s");
  assert.equal(formatWarframeCountdown(null, now, ""), "—");
});

test("parseWarframeAction parses tabs, fissure filters, refresh, dismiss, and rejects unknown IDs", () => {
  assert.deepEqual(parseWarframeAction("wf:tab:cycles"), { kind: "tab", view: "cycles" });
  assert.deepEqual(parseWarframeAction("wf:tab:sortie"), { kind: "tab", view: "sortie" });
  assert.deepEqual(parseWarframeAction("wf:tab:baro"), { kind: "tab", view: "baro" });
  assert.deepEqual(parseWarframeAction("wf:tab:invasions"), { kind: "tab", view: "invasions" });
  assert.deepEqual(parseWarframeAction("wf:fissures:steel"), {
    kind: "filter",
    view: "fissures",
    filter: "steel",
  });
  assert.deepEqual(parseWarframeAction("wf:fissures:storm"), {
    kind: "filter",
    view: "fissures",
    filter: "storm",
  });
  assert.deepEqual(parseWarframeAction("wf:refresh:baro"), { kind: "refresh", view: "baro" });
  assert.deepEqual(parseWarframeAction("wf:dismiss"), { kind: "dismiss" });
  assert.equal(parseWarframeAction("wf:lfg"), null);
  assert.equal(parseWarframeAction("other:btn"), null);
});

test("findPersistentWarframeMessage deterministically selects the earliest persistent card", () => {
  const msgs = [
    { id: "m1", type: "chat", lamport: 1, payload: { text: "hi" } },
    {
      id: "m3",
      type: "bot",
      lamport: 5,
      payload: { builtinBot: WARFRAME_BOT_ID, persistent: true, badge: "LATER" },
    },
    {
      id: "m2",
      type: "bot",
      lamport: 2,
      payload: { builtinBot: WARFRAME_BOT_ID, persistent: true, badge: "EARLIEST" },
    },
    {
      id: "m4",
      type: "bot",
      lamport: 1,
      payload: { builtinBot: WARFRAME_BOT_ID, persistent: false, badge: "NON-PERSISTENT" },
    },
  ];
  const found = findPersistentWarframeMessage(msgs);
  assert.equal(found?.id, "m2");
  assert.equal(isPersistentWarframeMessage(found), true);
  assert.equal(summarizeWarframePill(found), "WF · EARLIEST");
});

test("buildWarframeCardFromData builds accurate cards for all 5 views including missing API strings", () => {
  const now = Date.parse("2026-11-26T18:00:00.000Z");

  // 1. Cycles (notice Vallis has no timeLeft string, only expiry!)
  const cycles = buildWarframeCardFromData(
    "cycles",
    {
      cetus: { isDay: false, expiry: "2026-11-26T18:10:00.000Z" },
      vallis: { isWarm: false, expiry: "2026-11-26T18:06:30.000Z" },
      cambion: { state: "vome", expiry: "2026-11-26T18:10:00.000Z" },
      zariman: { isCorpus: false, expiry: "2026-11-26T18:10:00.000Z" },
      duviri: {
        state: "sorrow",
        expiry: "2026-11-26T20:00:00.000Z",
        choices: [
          { category: "normal", choices: ["Garuda", "Baruuk", "Hildryn"] },
          { category: "hard", choices: ["Lex", "Boltor"] },
        ],
      },
    },
    { nowMs: now, autoRefreshSec: 120 }
  );
  assert.equal(cycles.builtinBot, WARFRAME_BOT_ID);
  assert.equal(cycles.persistent, true);
  assert.equal(cycles.wfView, "cycles");
  assert.equal(cycles.badge, "EIDOLON NIGHT · 10m 0s");
  assert.equal(cycles.color, "cobalt");
  assert.ok(cycles.fields.some((f) => f.label === "Orb Vallis" && f.value.includes("6m 30s")));
  assert.ok(cycles.fields.some((f) => f.label === "Circuit Warframes" && f.value.includes("Garuda")));

  // 2. Fissures filtering (Normal vs Steel Path vs Void Storms, ignoring expired)
  const rawFissures = [
    { tier: "Axi", tierNum: 4, missionType: "Capture", node: "Hepit", isHard: false, isStorm: false, expiry: "2026-11-26T18:20:00.000Z" },
    { tier: "Lith", tierNum: 1, missionType: "Exterminate", node: "E Prime", isHard: false, isStorm: false, expiry: "2026-11-26T18:15:00.000Z" },
    { tier: "Neo", tierNum: 3, missionType: "Survival", node: "Mot", isHard: true, isStorm: false, expiry: "2026-11-26T18:30:00.000Z" },
    { tier: "Meso", tierNum: 2, missionType: "Skirmish", node: "Saturn Proxima", isHard: false, isStorm: true, expiry: "2026-11-26T18:40:00.000Z" },
    { tier: "Lith", tierNum: 1, missionType: "Old", node: "Expired", isHard: false, isStorm: false, expiry: "2026-11-26T17:50:00.000Z" },
  ];
  const fNorm = buildWarframeCardFromData("fissures", { fissures: rawFissures }, { nowMs: now, fissureFilter: "normal" });
  assert.equal(fNorm.badge, "2 ACTIVE");
  assert.equal(fNorm.fields[0].label, "Lith"); // sorted by tierNum
  const fSteel = buildWarframeCardFromData("fissures", { fissures: rawFissures }, { nowMs: now, fissureFilter: "steel" });
  assert.equal(fSteel.badge, "1 ACTIVE");
  assert.ok(fSteel.fields[0].value.includes("Mot"));
  const fStorm = buildWarframeCardFromData("fissures", { fissures: rawFissures }, { nowMs: now, fissureFilter: "storm" });
  assert.equal(fStorm.badge, "1 ACTIVE");
  assert.ok(fStorm.fields[0].value.includes("Saturn Proxima"));

  // 3. Sortie & Archon
  const sortie = buildWarframeCardFromData(
    "sortie",
    {
      sortie: {
        boss: "Sargas Ruk",
        faction: "Grineer",
        expiry: "2026-11-26T22:00:00.000Z",
        variants: [{ missionType: "Rescue", node: "Rhea", modifier: "Pistol Only" }],
      },
      archon: {
        boss: "Archon Boreal",
        expiry: "2026-11-29T00:00:00.000Z",
        missions: [{ type: "Spy", node: "Cervantes" }],
      },
    },
    { nowMs: now }
  );
  assert.equal(sortie.badge, "RESETS 4h 0m");
  assert.equal(sortie.fields.length, 2);

  // 4. Baro (away, derived purely from activation/expiry timestamps!) + Steel Path
  const baroAway = buildWarframeCardFromData(
    "baro",
    {
      trader: {
        location: "Strata Relay (Earth)",
        activation: "2026-11-27T14:00:00.000Z",
        expiry: "2026-11-29T14:00:00.000Z",
        inventory: [],
      },
      steelPath: {
        currentReward: { name: "Kitgun Riven Mod", cost: 75 },
        remaining: "3d 5h",
      },
    },
    { nowMs: now }
  );
  assert.equal(baroAway.badge, "IN 20h 0m");
  assert.ok(baroAway.text.includes("Strata Relay"));
  assert.ok(baroAway.fields.some((f) => f.label.includes("Steel Path") && f.value.includes("75 Steel Essence")));

  // 5. Invasions & Alerts
  const inv = buildWarframeCardFromData(
    "invasions",
    {
      alerts: [
        {
          expiry: "2026-11-27T18:00:00.000Z",
          mission: {
            description: "Gift of the Lotus",
            node: "Cinxia (Ceres)",
            reward: { countedItems: [{ type: "Orokin Catalyst", count: 1 }] },
          },
        },
      ],
      invasions: [
        {
          node: "Dione (Saturn)",
          completed: false,
          completion: 66.8,
          attacker: { reward: { countedItems: [{ type: "Fieldron", count: 3 }] } },
          defender: { reward: { countedItems: [{ type: "Detonite Injector", count: 3 }] } },
        },
      ],
    },
    { nowMs: now }
  );
  assert.equal(inv.badge, "1 ALERTS · 1 INV");
  assert.ok(inv.fields[0].value.includes("Orokin Catalyst"));
  assert.ok(inv.fields[1].value.includes("3x Fieldron"));
});

test("fetchWarframeWorldstateCard fetches only tab-relevant endpoints and degrades cleanly on network failure", async () => {
  const seen = [];
  const mockFetch = async (url) => {
    seen.push(url);
    return {
      ok: true,
      json: async () => ({
        isDay: true,
        isWarm: true,
        state: "fass",
        isCorpus: true,
        expiry: "2026-11-26T19:00:00.000Z",
      }),
    };
  };
  const card = await fetchWarframeWorldstateCard("cycles", {
    platform: "pc",
    fetchImpl: mockFetch,
    nowMs: Date.parse("2026-11-26T18:00:00.000Z"),
  });
  assert.equal(seen.length, 5);
  assert.ok(seen[0].endsWith("/pc/cetusCycle"));
  assert.equal(card.badge, "CETUS DAY · 1h 0m");

  const errCard = await fetchWarframeWorldstateCard("fissures", {
    platform: "pc",
    fetchImpl: async () => {
      throw new Error("Simulated offline");
    },
  });
  assert.equal(errCard.badge, "RETRY");
  assert.equal(errCard.persistent, true);
  assert.ok(errCard.text.includes("Simulated offline"));
  assert.equal(buildWarframeErrorCard("baro", "timeout").wfView, "baro");
});

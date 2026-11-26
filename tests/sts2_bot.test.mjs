import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STS2_SETTINGS,
  STS2_BOT_ID,
  applySts2CoopAction,
  buildSts2CoopCard,
  cleanSts2Markup,
  clearSts2Cache,
  extractSts2BracketQuery,
  fetchSts2Card,
  findPersistentSts2Message,
  parseSts2Action,
  resolveSts2ImageUrl,
  sanitizeSts2Settings,
  summarizeSts2Pill,
} from "../sts2_bot.js";

describe("sts2_bot settings & helpers", () => {
  it("defaults to disabled with safe defaults", () => {
    const s = sanitizeSts2Settings(null);
    assert.deepEqual(s, DEFAULT_STS2_SETTINGS);
    assert.equal(s.enabled, false);
  });

  it("cleans Spire Codex BBCode tags into clean bold markdown", () => {
    const out = cleanSts2Markup("Deal 8 damage.\nApply 2 [gold]Vulnerable[/gold] and [blue]20[/blue].");
    assert.equal(out, "Deal 8 damage.\nApply 2 **Vulnerable** and **20**.");
  });

  it("resolves relative and absolute HTTPS Spire Codex image URLs", () => {
    assert.equal(
      resolveSts2ImageUrl("/static/images/relics/burning_blood.webp"),
      "https://spire-codex.com/static/images/relics/burning_blood.webp"
    );
    assert.equal(
      resolveSts2ImageUrl("https://cdn.spire-codex.com/cards-full/stable/bash.webp"),
      "https://cdn.spire-codex.com/cards-full/stable/bash.webp"
    );
    assert.equal(resolveSts2ImageUrl("javascript:alert(1)"), "");
  });

  it("extracts inline [[Card Name]] and typed prefixes while ignoring [[wiki:...]]", () => {
    assert.deepEqual(extractSts2BracketQuery("Check out [[Bash]] please"), {
      kind: "auto",
      query: "Bash",
    });
    assert.deepEqual(extractSts2BracketQuery("Look up [[relic:Burning Blood]]"), {
      kind: "relic",
      query: "Burning Blood",
    });
    assert.deepEqual(extractSts2BracketQuery("[[potion:Fire Potion]]"), {
      kind: "potion",
      query: "Fire Potion",
    });
    assert.equal(extractSts2BracketQuery("Read [[wiki:Slay the Spire]]"), null);
  });

  it("parses all StS2 action IDs accurately", () => {
    assert.deepEqual(parseSts2Action("sts2:tab:encounters"), { kind: "tab", tab: "encounters" });
    assert.deepEqual(parseSts2Action("sts2:char:silent"), { kind: "char", character: "silent" });
    assert.deepEqual(parseSts2Action("sts2:bracket:2p"), { kind: "bracket", bracket: "2p" });
    assert.deepEqual(parseSts2Action("sts2:metric:relics"), { kind: "metric", metricKind: "relics" });
    assert.deepEqual(parseSts2Action("sts2:codex:upgrade"), { kind: "codex_upgrade" });
    assert.deepEqual(parseSts2Action("sts2:coop:fool"), { kind: "coop_claim", character: "fool" });
    assert.deepEqual(parseSts2Action("sts2:coop:leave"), { kind: "coop_leave" });
    assert.equal(parseSts2Action("wf:tab:cycles"), null);
  });
});

describe("sts2_bot Co-op Party Picker & API cards", () => {
  it("supports 2P-4P Co-op Party seat claiming, switching, leaving, and 4-seat cap offline", () => {
    let seats = {};
    seats = applySts2CoopAction(seats, { kind: "coop_claim", character: "ironclad" }, { peerId: "p1", peerName: "Alice" });
    seats = applySts2CoopAction(seats, { kind: "coop_claim", character: "silent" }, { peerId: "p2", peerName: "Bob" });
    assert.equal(Object.keys(seats).length, 2);
    assert.equal(seats.p1.character, "ironclad");
    assert.equal(seats.p2.character, "silent");

    const card = buildSts2CoopCard({ tab: "coop", character: "ironclad", bracket: "2p", metricKind: "cards", coopSeats: seats, nowMs: 1_700_000_000_000 });
    assert.equal(card.builtinBot, STS2_BOT_ID);
    assert.equal(card.persistent, true);
    assert.equal(card.badge, "2/4 READY");
    assert.match(summarizeSts2Pill({ payload: card }), /CO-OP \(2\/4\)/);

    seats = applySts2CoopAction(seats, { kind: "coop_leave" }, { peerId: "p1", peerName: "Alice" });
    assert.equal(Object.keys(seats).length, 1);
  });

  it("fetches Meta, Encounters, Codex (with Upgrade+ card art), and News cards via Spire Codex API", async () => {
    clearSts2Cache();
    const mockFetch = async (url) => {
      const ok = (body) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes("/api/runs/metrics/cards")) {
        return ok({
          baseline_win_rate: 31.4,
          character_runs: 149574,
          rows: [
            { id: "BASH", upgraded: false, score: 82, tier: "A", win_rate: 44.2, pick_rate: 30.1, picks: 500 },
            { id: "OFFERING", upgraded: false, score: 96, tier: "S", win_rate: 53.1, pick_rate: 78.4, picks: 900 },
          ],
        });
      }
      if (url.includes("/api/runs/encounter-stats")) {
        return ok({
          encounters: [
            { encounter_id: "HEART_BOSS", act: 3, room_type: "boss", total: 1000, fatal: 420, avg_damage: 38.5, avg_turns: 7.2 },
          ],
        });
      }
      if (url.includes("/api/search?q=Bash")) {
        return ok({
          categories: [{ kind: "card", items: [{ name: "Bash", path: "/cards/bash" }] }],
        });
      }
      if (url.includes("/api/cards/bash")) {
        return ok({
          id: "BASH",
          name: "Bash",
          cost: 2,
          type: "Attack",
          rarity: "Basic",
          color: "ironclad",
          description: "Deal 8 damage.\nApply 2 [gold]Vulnerable[/gold].",
          upgrade: { damage: "+2", vulnerable: "+1" },
          image_url_card: "https://cdn.spire-codex.com/cards-full/stable/bash.webp",
          image_url_card_upg: "https://cdn.spire-codex.com/cards-full/stable/bash_upg.webp",
        });
      }
      if (url.includes("/api/news")) {
        return ok({ items: [{ title: "Beta Patch Notes - v0.114.0", date: 1795600000, feedlabel: "Community", url: "https://store.steampowered.com/news/1" }] });
      }
      if (url.includes("/api/beta/version")) {
        return ok({ beta_version: "v0.114.0", render_version: "2" });
      }
      if (url.includes("/api/beta/diff")) {
        return ok({ beta_version: "v0.114.0", types: { cards: { added: ["A", "B"], changed: ["C"], removed: [] } } });
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const meta = await fetchSts2Card({ tab: "meta", character: "ironclad", bracket: "2p" }, { fetchImpl: mockFetch });
    assert.match(meta.title, /Top Ironclad Cards/);
    assert.match(meta.fields[0].label, /Offering/);

    const enc = await fetchSts2Card({ tab: "encounters" }, { fetchImpl: mockFetch });
    assert.match(enc.fields[0].value, /42\.0% fatal/);

    const codexBase = await fetchSts2Card({ tab: "codex", lookupQuery: "Bash", upgraded: false }, { fetchImpl: mockFetch });
    assert.equal(codexBase.title, "Bash");
    assert.equal(codexBase.image.url, "https://cdn.spire-codex.com/cards-full/stable/bash.webp");
    assert.match(codexBase.text, /\*\*Vulnerable\*\*/);

    const codexUpg = await fetchSts2Card({ tab: "codex", entityPath: "/cards/bash", upgraded: true }, { fetchImpl: mockFetch });
    assert.equal(codexUpg.title, "Bash+");
    assert.equal(codexUpg.image.url, "https://cdn.spire-codex.com/cards-full/stable/bash_upg.webp");

    const news = await fetchSts2Card({ tab: "news" }, { fetchImpl: mockFetch });
    assert.equal(news.badge, "BETA v0.114.0");
    assert.ok(news.fields.some((f) => f.value.includes("Cards (+2/~1)")));

    const found = findPersistentSts2Message([{ id: "m1", type: "bot", payload: meta }]);
    assert.equal(found?.id, "m1");
  });
});

/**
 * Built-in Slay the Spire 2 Bot (Spire Codex REST API).
 *
 * Opt-in only (disabled by default in Settings). Zero external requests are made
 * unless the user enables the bot. Operates primarily via a single persistent,
 * interactive card message per room that updates in place via `edit_message`.
 *
 * Features:
 *  - Meta & Top Picks (cards / relics by Codex Score, Win Rate, Pick Rate across characters & brackets)
 *  - Deadliest Encounters (Act 1–3 & Boss fatal rates, avg damage, avg turns)
 *  - Codex Lookup & Spotlight (cards, relics, potions, events, monsters + full rendered card art + Upgrade+ toggle)
 *  - Patch Notes & Beta Diff (Steam announcements + current beta version & diff summary)
 *  - Co-op Party Picker (2P–4P interactive character seat claiming synced inside the persistent E2EE card)
 *  - Inline chat trigger: `[[Card Name]]`, `[[relic:...]]`, `[[potion:...]]`, `[[event:...]]`, `[[monster:...]]`
 */

export const STS2_BOT_ID = "sts2";
export const STS2_API_BASE = "https://spire-codex.com";
export const STS2_ACTION_PREFIX = "sts2:";

export const STS2_TABS = Object.freeze([
  { id: "meta", label: "Meta & Picks", short: "Meta" },
  { id: "encounters", label: "Deadliest Fights", short: "Fights" },
  { id: "codex", label: "Codex Spotlight", short: "Codex" },
  { id: "news", label: "Patches & Beta", short: "Patches" },
  { id: "coop", label: "Co-op Party", short: "Co-op" },
]);

export const STS2_CHARACTERS = Object.freeze([
  { id: "ironclad", label: "Ironclad", short: "Ironclad", accent: "coral" },
  { id: "silent", label: "Silent", short: "Silent", accent: "mint" },
  { id: "defect", label: "Defect", short: "Defect", accent: "cyan" },
  { id: "regent", label: "Regent", short: "Regent", accent: "ochre" },
  { id: "necrobinder", label: "Necrobinder", short: "Necro", accent: "cobalt" },
  { id: "fool", label: "Fool", short: "Fool", accent: "ochre" },
]);

export const STS2_BRACKETS = Object.freeze([
  { id: "all", label: "All Runs" },
  { id: "a10", label: "A10" },
  { id: "2p", label: "2P Co-op" },
  { id: "3p", label: "3P Co-op" },
  { id: "4p", label: "4P Co-op" },
]);

export const DEFAULT_STS2_SETTINGS = Object.freeze({
  enabled: false,
  defaultTab: "meta",
  defaultCharacter: "ironclad",
  defaultBracket: "all",
  inlineLookup: true,
});

const VALID_TABS = new Set(STS2_TABS.map((t) => t.id));
const VALID_CHARS = new Set(STS2_CHARACTERS.map((c) => c.id));
const VALID_BRACKETS = new Set(STS2_BRACKETS.map((b) => b.id));
const VALID_METRIC_KINDS = new Set(["cards", "relics"]);

const SPOTLIGHT_CARDS = Object.freeze([
  "bash",
  "dash",
  "zap",
  "pommel_strike",
  "backflip",
  "defend_ironclad",
  "impervious",
  "adrenaline",
  "seek",
  "offering",
  "bludgeon",
  "noxious_fumes",
]);

// 5-minute TTL response cache to respect Spire Codex's 15 req/min keyless limit
const RESPONSE_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function clearSts2Cache() {
  RESPONSE_CACHE.clear();
}

export function sanitizeSts2Settings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const defaultTab = VALID_TABS.has(String(src.defaultTab || "").toLowerCase())
    ? String(src.defaultTab).toLowerCase()
    : DEFAULT_STS2_SETTINGS.defaultTab;
  const defaultCharacter = VALID_CHARS.has(String(src.defaultCharacter || "").toLowerCase())
    ? String(src.defaultCharacter).toLowerCase()
    : DEFAULT_STS2_SETTINGS.defaultCharacter;
  const defaultBracket = VALID_BRACKETS.has(String(src.defaultBracket || "").toLowerCase())
    ? String(src.defaultBracket).toLowerCase()
    : DEFAULT_STS2_SETTINGS.defaultBracket;
  return {
    enabled: Boolean(src.enabled),
    defaultTab,
    defaultCharacter,
    defaultBracket,
    inlineLookup: src.inlineLookup !== false,
  };
}

export function isPersistentSts2Message(msg) {
  return Boolean(
    msg &&
      msg.type === "bot" &&
      msg.payload &&
      typeof msg.payload === "object" &&
      msg.payload.builtinBot === STS2_BOT_ID &&
      msg.payload.persistent === true
  );
}

export function findPersistentSts2Message(logMessages) {
  if (!Array.isArray(logMessages)) return null;
  for (let i = logMessages.length - 1; i >= 0; i--) {
    if (isPersistentSts2Message(logMessages[i])) {
      return logMessages[i];
    }
  }
  return null;
}

export function summarizeSts2Pill(msg) {
  const tab = msg?.payload?.sts2Tab || "meta";
  if (tab === "coop") {
    const seats = msg?.payload?.sts2CoopSeats || {};
    const count = Object.keys(seats).length;
    return `STS2 · CO-OP (${count}/4)`;
  }
  if (tab === "codex") {
    const name = msg?.payload?.sts2EntityName;
    return name ? `STS2 · ${String(name).slice(0, 14).toUpperCase()}` : "STS2 · CODEX";
  }
  const tabObj = STS2_TABS.find((t) => t.id === tab);
  return `STS2 · ${(tabObj?.short || "META").toUpperCase()}`;
}

/**
 * Strips Spire Codex BBCode tags like `[gold]Vulnerable[/gold]` and converts
 * highlighted keywords to markdown `**...**` for `formatBotRichText`.
 */
export function cleanSts2Markup(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\[(?:gold|blue|green|red|purple|orange|aqua|b|sine|jitter|rainbow)\]([\s\S]*?)\[\/(?:gold|blue|green|red|purple|orange|aqua|b|sine|jitter|rainbow)\]/gi, "**$1**")
    .replace(/\[\/?[a-z0-9_=-]+\]/gi, "")
    .replace(/\*{3,}/g, "**")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function resolveSts2ImageUrl(rawUrl, apiBase = STS2_API_BASE) {
  if (typeof rawUrl !== "string") return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (/^https:\/\/[^\s<>"']+$/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) {
    return `${apiBase.replace(/\/+$/, "")}${trimmed}`;
  }
  return "";
}

export function humanizeEntityId(id) {
  if (!id) return "Unknown";
  return String(id)
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Parses `[[Card Name]]` or typed `[[relic:Burning Blood]]` / `[[potion:...]]` /
 * `[[event:...]]` / `[[monster:...]]` inline chat lookup triggers.
 * Explicitly ignores `[[wiki:...]]` (reserved for the Wikipedia bot).
 */
export function extractSts2BracketQuery(text) {
  if (typeof text !== "string" || !text.includes("[[")) return null;
  const re = /\[\[([^\[\]\n]{2,80})\]\]/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const inner = match[1].trim();
    if (!inner) continue;
    const colonIdx = inner.indexOf(":");
    if (colonIdx > 0) {
      const prefix = inner.slice(0, colonIdx).trim().toLowerCase();
      const rest = inner.slice(colonIdx + 1).trim();
      if (prefix === "wiki" || prefix === "wikipedia" || prefix === "w") {
        continue;
      }
      if (
        rest &&
        (prefix === "card" ||
          prefix === "relic" ||
          prefix === "potion" ||
          prefix === "event" ||
          prefix === "monster" ||
          prefix === "sts2")
      ) {
        return { kind: prefix === "sts2" ? "auto" : prefix, query: rest };
      }
    }
    return { kind: "auto", query: inner };
  }
  return null;
}

export function parseSts2Action(actionId) {
  if (typeof actionId !== "string" || !actionId.startsWith(STS2_ACTION_PREFIX)) {
    return null;
  }
  const rest = actionId.slice(STS2_ACTION_PREFIX.length);
  if (rest === "refresh") return { kind: "refresh" };
  if (rest === "dismiss") return { kind: "dismiss" };
  if (rest === "search") return { kind: "search" };
  if (rest === "codex:random") return { kind: "codex_random" };
  if (rest === "codex:upgrade") return { kind: "codex_upgrade" };
  if (rest === "coop:leave") return { kind: "coop_leave" };
  if (rest === "coop:clear") return { kind: "coop_clear" };

  if (rest.startsWith("open:")) {
    const entityPath = rest.slice(5).trim();
    if (/^\/(?:cards|relics|potions|events|monsters)\/[a-z0-9_-]+$/i.test(entityPath)) {
      return { kind: "open", entityPath };
    }
    return null;
  }
  if (rest.startsWith("tab:")) {
    const tab = rest.slice(4);
    return VALID_TABS.has(tab) ? { kind: "tab", tab } : null;
  }
  if (rest.startsWith("char:")) {
    const character = rest.slice(5);
    return VALID_CHARS.has(character) ? { kind: "char", character } : null;
  }
  if (rest.startsWith("bracket:")) {
    const bracket = rest.slice(8);
    return VALID_BRACKETS.has(bracket) ? { kind: "bracket", bracket } : null;
  }
  if (rest.startsWith("metric:")) {
    const metricKind = rest.slice(7);
    return VALID_METRIC_KINDS.has(metricKind) ? { kind: "metric", metricKind } : null;
  }
  if (rest.startsWith("coop:")) {
    const character = rest.slice(5);
    return VALID_CHARS.has(character) ? { kind: "coop_claim", character } : null;
  }
  return null;
}

function formatUpdatedClock(nowMs) {
  try {
    return new Date(nowMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "now";
  }
}

function buildNavButtonRows(activeTab) {
  const row1 = STS2_TABS.map((t) => ({
    id: `${STS2_ACTION_PREFIX}tab:${t.id}`,
    label: t.short,
    style: t.id === activeTab ? "primary" : "secondary",
  }));
  return row1;
}

function buildFooterControls(extraButtons = []) {
  return [
    ...extraButtons,
    { id: `${STS2_ACTION_PREFIX}refresh`, icon: "refresh", label: "Refresh", style: "secondary" },
    { id: `${STS2_ACTION_PREFIX}dismiss`, icon: "close", label: "Hide", style: "danger" },
  ];
}

function charInfo(charId) {
  return STS2_CHARACTERS.find((c) => c.id === charId) || STS2_CHARACTERS[0];
}

function bracketLabel(bracketId) {
  return STS2_BRACKETS.find((b) => b.id === bracketId)?.label || "All Runs";
}

async function fetchJsonCached(url, { fetchImpl = globalThis.fetch, bypassCache = false, nowMs = Date.now() } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable");
  }
  if (!bypassCache) {
    const cached = RESPONSE_CACHE.get(url);
    if (cached && nowMs - cached.ts < CACHE_TTL_MS) {
      return cached.data;
    }
  }
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  RESPONSE_CACHE.set(url, { ts: nowMs, data });
  return data;
}

export function buildSts2SearchBlock() {
  return {
    type: "input",
    id: `${STS2_ACTION_PREFIX}search`,
    autocomplete: "sts2",
    placeholder: "Search card, relic, potion, monster…",
    submitLabel: "Go",
  };
}

/**
 * Live autocomplete suggestions from Spire Codex `/api/search` (5-min cached).
 */
export async function searchSts2Suggestions(
  query,
  { fetchImpl = globalThis.fetch, apiBase = STS2_API_BASE, nowMs = Date.now(), limit = 8 } = {}
) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const base = apiBase.replace(/\/+$/, "");
  const data = await fetchJsonCached(`${base}/api/search?q=${encodeURIComponent(q)}`, {
    fetchImpl,
    bypassCache: false,
    nowMs,
  });
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  const out = [];
  for (const cat of categories) {
    if (!Array.isArray(cat?.items)) continue;
    for (const item of cat.items) {
      if (!item?.name || !item?.path) continue;
      out.push({
        label: item.name,
        sublabel: item.subtitle || cat.label || cat.kind || "",
        value: item.path,
        image: resolveSts2ImageUrl(item.image_url || item.image || ""),
        actionId: `${STS2_ACTION_PREFIX}open:${item.path}`,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function basePayload(state, overrides) {
  const nowMs = state.nowMs || Date.now();
  const extraBlocks = Array.isArray(overrides?.blocks) ? overrides.blocks : [];
  return {
    builtinBot: STS2_BOT_ID,
    persistent: true,
    sts2Tab: state.tab,
    sts2Char: state.character,
    sts2Bracket: state.bracket,
    sts2MetricKind: state.metricKind,
    sts2EntityPath: state.entityPath || null,
    sts2EntityName: state.entityName || null,
    sts2Upgraded: Boolean(state.upgraded),
    sts2CoopSeats: state.coopSeats || {},
    sts2UpdatedAt: nowMs,
    subtitle: "SLAY THE SPIRE 2",
    ...overrides,
    blocks: [buildSts2SearchBlock(), ...extraBlocks],
  };
}

export function buildSts2MetaCard(metricsData, state) {
  const c = charInfo(state.character);
  const metricKind = VALID_METRIC_KINDS.has(state.metricKind) ? state.metricKind : "cards";
  const rows = Array.isArray(metricsData?.rows) ? metricsData.rows : [];
  const sorted = [...rows]
    .filter((r) => r && !r.upgraded && Number(r.picks || 0) >= 10)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(b.win_rate) || 0) - (Number(a.win_rate) || 0));
  const topRows = (sorted.length > 0 ? sorted : rows).slice(0, 6);

  const blocks =
    topRows.length > 0
      ? topRows.map((r, idx) => {
          const tier = r.tier ? `[${r.tier}] ` : "";
          const rawId = String(r.id || r.entity_id || "");
          const slug = rawId.toLowerCase();
          const entityPath = /^[a-z0-9_-]+$/.test(slug) ? `/${metricKind}/${slug}` : "";
          const wrNum = r.win_rate != null ? Math.max(0, Math.min(100, Number(r.win_rate))) : 0;
          const score = r.score != null ? `S:${Math.round(Number(r.score))}` : "";
          const wr = r.win_rate != null ? `WR ${wrNum.toFixed(1)}%` : "";
          const pr = r.pick_rate != null ? `Pick ${Number(r.pick_rate).toFixed(0)}%` : "";
          const tierColor =
            r.tier === "S" ? "mint" : r.tier === "A" ? c.accent : r.tier === "B" ? "ochre" : "cobalt";
          return {
            type: "progress",
            id: entityPath ? `${STS2_ACTION_PREFIX}open:${entityPath}` : undefined,
            label: `#${idx + 1} ${tier}${humanizeEntityId(rawId)}`,
            value: Math.round(wrNum * 10),
            max: 1000,
            display: [wr, pr, score].filter(Boolean).join(" · "),
            color: tierColor,
          };
        })
      : [];

  const totalRuns = Number(metricsData?.character_runs || metricsData?.total_runs || 0);
  const baseWr = metricsData?.baseline_win_rate != null ? `${Number(metricsData.baseline_win_rate).toFixed(1)}%` : "—";
  const kindLabel = metricKind === "relics" ? "Relics" : "Cards";
  const nextKind = metricKind === "relics" ? "cards" : "relics";

  const charRow = STS2_CHARACTERS.map((ch) => ({
    id: `${STS2_ACTION_PREFIX}char:${ch.id}`,
    label: ch.short,
    style: ch.id === state.character ? "success" : "secondary",
  }));
  const bracketRow = [
    ...STS2_BRACKETS.map((b) => ({
      id: `${STS2_ACTION_PREFIX}bracket:${b.id}`,
      label: b.id.toUpperCase(),
      style: b.id === state.bracket ? "warning" : "secondary",
    })),
    {
      id: `${STS2_ACTION_PREFIX}metric:${nextKind}`,
      label: nextKind === "relics" ? "Show Relics" : "Show Cards",
      style: "secondary",
    },
  ];

  return basePayload(state, {
    title: `Top ${c.label} ${kindLabel} · ${bracketLabel(state.bracket)}`,
    badge: totalRuns > 0 ? `${totalRuns.toLocaleString()} RUNS` : "META",
    color: c.accent,
    text: blocks.length > 0 ? `Baseline WR **${baseWr}**` : "No data for this filter.",
    blocks,
    fields: [],
    buttons: [buildNavButtonRows("meta"), charRow, bracketRow, buildFooterControls()],
    footer: `Spire Codex · ${formatUpdatedClock(state.nowMs || Date.now())}`,
  });
}

export function buildSts2EncountersCard(encData, state) {
  const list = Array.isArray(encData?.encounters)
    ? encData.encounters
    : Array.isArray(encData)
      ? encData
      : [];

  const sorted = [...list]
    .filter((e) => e && Number(e.total || 0) >= 20)
    .sort((a, b) => {
      const rateA = Number(a.fatal || 0) / Math.max(1, Number(a.total || 1));
      const rateB = Number(b.fatal || 0) / Math.max(1, Number(b.total || 1));
      return rateB - rateA;
    });
  const top = (sorted.length > 0 ? sorted : list).slice(0, 6);

  const blocks = top.map((e, idx) => {
    const total = Math.max(1, Number(e.total || 0));
    const fatalNum = Math.max(0, Math.min(100, (Number(e.fatal || 0) / total) * 100));
    const fatalPct = fatalNum.toFixed(1);
    const avgDmg = e.avg_damage != null ? `${Number(e.avg_damage).toFixed(1)} dmg` : "—";
    const avgTurns = e.avg_turns != null ? `${Number(e.avg_turns).toFixed(1)}t` : "—";
    const metaTag = [e.act ? `Act ${e.act}` : "", e.room_type ? humanizeEntityId(e.room_type) : ""]
      .filter(Boolean)
      .join(" ");
    return {
      type: "progress",
      label: `#${idx + 1} ${humanizeEntityId(e.encounter_id || e.name)}${metaTag ? ` · ${metaTag}` : ""}`,
      value: Math.round(fatalNum * 10),
      max: 1000,
      display: `${fatalPct}% fatal · ${avgDmg} · ${avgTurns}`,
      color: fatalNum >= 35 ? "coral" : fatalNum >= 20 ? "ochre" : "cobalt",
    };
  });

  return basePayload(state, {
    title: "Deadliest Spire Encounters",
    badge: `${top.length} TRACKED`,
    color: "coral",
    text: blocks.length === 0 ? "No data." : "",
    blocks,
    fields: [],
    buttons: [buildNavButtonRows("encounters"), buildFooterControls()],
    footer: `Spire Codex · ${formatUpdatedClock(state.nowMs || Date.now())}`,
  });
}

export function buildSts2CodexCard(entity, state, { kind = "card", metricRow = null, apiBase = STS2_API_BASE } = {}) {
  const upgraded = Boolean(state.upgraded);
  const name = entity?.name || humanizeEntityId(entity?.id || "Spotlight");
  const isCard = kind === "card";
  const desc = cleanSts2Markup(entity?.description || entity?.flavor || "No description available.");

  const fields = [];
  if (isCard) {
    const costStr = entity?.is_x_cost ? "X" : entity?.cost != null ? String(entity.cost) : "—";
    fields.push({
      label: "Card Profile",
      value: `**${humanizeEntityId(entity?.color || "colorless")}** · ${entity?.type || "Card"} · ${entity?.rarity || "Common"} · Cost \`${costStr}\``,
      inline: false,
    });
    if (entity?.upgrade && typeof entity.upgrade === "object" && Object.keys(entity.upgrade).length > 0) {
      const upgParts = Object.entries(entity.upgrade).map(
        ([k, v]) => `${humanizeEntityId(k)} \`${v}\``
      );
      fields.push({
        label: upgraded ? "Upgrade + Active" : "Upgrade + Bonus",
        value: upgParts.join(" · "),
        inline: true,
      });
    }
  } else if (kind === "relic") {
    fields.push({
      label: "Relic",
      value: `**${entity?.rarity || "Relic"}**${entity?.pool ? ` · ${humanizeEntityId(entity.pool)}` : ""}`,
      inline: true,
    });
  } else if (kind === "potion") {
    fields.push({
      label: "Potion",
      value: `**${entity?.rarity || "Potion"}**`,
      inline: true,
    });
  } else if (kind === "event") {
    fields.push({
      label: "Event",
      value: entity?.act ? `Act / Zone: **${entity.act}**` : "Spire Event",
      inline: true,
    });
  } else if (kind === "monster") {
    const hp =
      entity?.min_hp != null && entity?.max_hp != null
        ? `${entity.min_hp}–${entity.max_hp} HP`
        : entity?.min_hp != null
          ? `${entity.min_hp} HP`
          : "Unknown HP";
    fields.push({
      label: "Monster",
      value: `**${entity?.type || "Enemy"}** · ${hp}`,
      inline: true,
    });
  }

  if (metricRow) {
    const wr = metricRow.win_rate != null ? `WR **${Number(metricRow.win_rate).toFixed(1)}%**` : "";
    const pr = metricRow.pick_rate != null ? `Pick ${Number(metricRow.pick_rate).toFixed(0)}%` : "";
    const tier = metricRow.tier ? `Tier **${metricRow.tier}**` : "";
    const score = metricRow.score != null ? `Score ${Math.round(Number(metricRow.score))}` : "";
    fields.push({
      label: "Community Run Stats",
      value: [tier, score, wr, pr].filter(Boolean).join(" · "),
      inline: true,
    });
  }

  const rawImg = isCard
    ? upgraded
      ? entity?.image_url_card_upg || entity?.image_url_card || entity?.image_url
      : entity?.image_url_card || entity?.image_url
    : entity?.image_url;
  const imgUrl = resolveSts2ImageUrl(rawImg, apiBase);

  const codexRow = [
    { id: `${STS2_ACTION_PREFIX}codex:random`, icon: "dice", label: "Random Card", style: "warning" },
  ];
  if (isCard && (entity?.image_url_card_upg || entity?.upgrade)) {
    codexRow.push({
      id: `${STS2_ACTION_PREFIX}codex:upgrade`,
      label: upgraded ? "Show Base" : "Upgrade +",
      style: upgraded ? "success" : "primary",
    });
  }
  const webSlug = state.entityPath ? `${apiBase.replace(/\/+$/, "")}${state.entityPath}` : `${apiBase.replace(/\/+$/, "")}/cards`;
  codexRow.push({ id: "sts2_open_codex", label: "Spire Codex", url: webSlug, style: "secondary" });

  const c = charInfo(String(entity?.color || state.character).toLowerCase());
  const payload = basePayload(
    { ...state, entityName: name },
    {
      title: `${name}${isCard && upgraded ? "+" : ""}`,
      badge: `${kind.toUpperCase()}${isCard && upgraded ? " +" : ""}`,
      color: c.accent,
      text: desc.length > 520 ? `${desc.slice(0, 517)}…` : desc,
      fields,
      buttons: [buildNavButtonRows("codex"), codexRow, buildFooterControls()],
      footer: `Lookup: [[Card]] / [[relic:Name]] · ${formatUpdatedClock(state.nowMs || Date.now())}`,
    }
  );
  if (imgUrl) {
    payload.image = { url: imgUrl, alt: `${name}${isCard && upgraded ? "+" : ""} (Slay the Spire 2)` };
  }
  return payload;
}

export function buildSts2NewsCard({ newsData, betaVersion, betaDiff }, state) {
  const items = Array.isArray(newsData?.items) ? newsData.items : [];
  const fields = [];

  if (betaVersion?.beta_version) {
    const types = betaDiff?.types && typeof betaDiff.types === "object" ? betaDiff.types : {};
    const diffBits = [];
    for (const [k, v] of Object.entries(types)) {
      if (!v || typeof v !== "object") continue;
      const added = Array.isArray(v.added) ? v.added.length : 0;
      const changed = Array.isArray(v.changed) ? v.changed.length : 0;
      const removed = Array.isArray(v.removed) ? v.removed.length : 0;
      if (added || changed || removed) {
        const parts = [];
        if (added) parts.push(`+${added}`);
        if (changed) parts.push(`~${changed}`);
        if (removed) parts.push(`-${removed}`);
        diffBits.push(`${humanizeEntityId(k)} (${parts.join("/")})`);
      }
    }
    fields.push({
      label: `Beta Branch · ${betaVersion.beta_version}`,
      value:
        diffBits.length > 0
          ? diffBits.slice(0, 5).join(" · ")
          : `Render ${betaVersion.render_version || "latest"}`,
      inline: false,
    });
  }

  for (const item of items.slice(0, 4)) {
    const dateStr = item.date
      ? new Date(Number(item.date) * 1000).toLocaleDateString([], { month: "short", day: "numeric" })
      : "";
    const feed = item.feedlabel || item.author || "Steam";
    fields.push({
      label: `${dateStr ? `${dateStr} · ` : ""}${feed}`,
      value: `**${item.title || "Update"}**`,
      inline: false,
    });
  }

  if (fields.length === 0) {
    fields.push({ label: "Patch Feed", value: "No updates.", inline: false });
  }

  const extra = [];
  const topUrl = items[0]?.url;
  if (typeof topUrl === "string" && /^https?:\/\//i.test(topUrl)) {
    extra.push({ id: "sts2_open_news", label: "Latest Notes", url: topUrl, style: "primary" });
  }

  return basePayload(state, {
    title: "Patch Notes & Beta Diff",
    badge: betaVersion?.beta_version ? `BETA ${betaVersion.beta_version}` : "PATCHES",
    color: "cobalt",
    fields,
    buttons: [buildNavButtonRows("news"), buildFooterControls(extra)],
    footer: `Spire Codex · ${formatUpdatedClock(state.nowMs || Date.now())}`,
  });
}

export function buildSts2CoopCard(state) {
  const seats = state.coopSeats && typeof state.coopSeats === "object" ? state.coopSeats : {};
  const seatEntries = Object.entries(seats);
  const count = seatEntries.length;

  const fields = [];
  for (let i = 0; i < 4; i++) {
    const entry = seatEntries[i];
    if (entry) {
      const [, info] = entry;
      const c = charInfo(info.character);
      fields.push({
        label: `Seat ${i + 1}`,
        value: `**${info.name || "Player"}** → \`${c.label}\``,
        inline: true,
      });
    } else {
      fields.push({
        label: `Seat ${i + 1}`,
        value: "_Open_",
        inline: true,
      });
    }
  }

  const charCounts = {};
  for (const [, info] of seatEntries) {
    charCounts[info.character] = (charCounts[info.character] || 0) + 1;
  }
  const dupes = Object.entries(charCounts)
    .filter(([, n]) => n > 1)
    .map(([ch]) => charInfo(ch).label);

  const summaryText =
    count === 0
      ? "Pick a character below."
      : dupes.length > 0
        ? `Duplicate: **${dupes.join(", ")}**`
        : "Party ready.";

  const charRow = STS2_CHARACTERS.map((ch) => ({
    id: `${STS2_ACTION_PREFIX}coop:${ch.id}`,
    label: ch.short,
    style: charCounts[ch.id] ? "success" : "secondary",
  }));

  const controlsRow = [
    { id: `${STS2_ACTION_PREFIX}coop:leave`, label: "Leave Seat", style: "secondary" },
    { id: `${STS2_ACTION_PREFIX}coop:clear`, icon: "reset", label: "Reset Party", style: "warning" },
    { id: `${STS2_ACTION_PREFIX}dismiss`, icon: "close", label: "Hide", style: "danger" },
  ];

  return basePayload(state, {
    title: "Co-op Party Picker (2P–4P)",
    badge: `${count}/4 READY`,
    color: count >= 2 ? "mint" : "ochre",
    text: summaryText,
    blocks: [
      {
        type: "progress",
        icon: "users",
        label: "Party Seats",
        value: count,
        max: 4,
        display: `${count} / 4 ready`,
        color: count >= 2 ? "mint" : "ochre",
      },
    ],
    fields,
    buttons: [buildNavButtonRows("coop"), charRow, controlsRow],
    footer: `Updated ${formatUpdatedClock(state.nowMs || Date.now())}`,
  });
}

export function applySts2CoopAction(existingSeats, action, { peerId = "self", peerName = "Peer" } = {}) {
  const next = { ...(existingSeats && typeof existingSeats === "object" ? existingSeats : {}) };
  if (action.kind === "coop_clear") {
    return {};
  }
  if (action.kind === "coop_leave") {
    delete next[peerId];
    return next;
  }
  if (action.kind === "coop_claim" && VALID_CHARS.has(action.character)) {
    const alreadySeated = Object.prototype.hasOwnProperty.call(next, peerId);
    if (!alreadySeated && Object.keys(next).length >= 4) {
      // Room party full (4 seats max)
      return next;
    }
    next[peerId] = { name: peerName || "Peer", character: action.character };
    return next;
  }
  return next;
}

/**
 * Fetches live Spire Codex data for the requested tab & state and builds the persistent card.
 */
export async function fetchSts2Card(
  stateInput = {},
  { fetchImpl = globalThis.fetch, apiBase = STS2_API_BASE, bypassCache = false } = {}
) {
  const base = apiBase.replace(/\/+$/, "");
  const nowMs = stateInput.nowMs || Date.now();
  const state = {
    tab: VALID_TABS.has(stateInput.tab) ? stateInput.tab : "meta",
    character: VALID_CHARS.has(stateInput.character) ? stateInput.character : "ironclad",
    bracket: VALID_BRACKETS.has(stateInput.bracket) ? stateInput.bracket : "all",
    metricKind: VALID_METRIC_KINDS.has(stateInput.metricKind) ? stateInput.metricKind : "cards",
    entityPath: stateInput.entityPath || null,
    entityName: stateInput.entityName || null,
    upgraded: Boolean(stateInput.upgraded),
    coopSeats: stateInput.coopSeats && typeof stateInput.coopSeats === "object" ? stateInput.coopSeats : {},
    lookupQuery: stateInput.lookupQuery || null,
    lookupKind: stateInput.lookupKind || "auto",
    nowMs,
  };

  if (state.tab === "coop") {
    return buildSts2CoopCard(state);
  }

  try {
    if (state.tab === "meta") {
      const url = `${base}/api/runs/metrics/${state.metricKind}?bracket=${encodeURIComponent(state.bracket)}&character=${encodeURIComponent(state.character)}`;
      const data = await fetchJsonCached(url, { fetchImpl, bypassCache, nowMs });
      return buildSts2MetaCard(data, state);
    }

    if (state.tab === "encounters") {
      const url = `${base}/api/runs/encounter-stats?limit=12`;
      const data = await fetchJsonCached(url, { fetchImpl, bypassCache, nowMs });
      return buildSts2EncountersCard(data, state);
    }

    if (state.tab === "news") {
      const [steamNews, betaVersion, betaDiff] = await Promise.all([
        fetchJsonCached(`${base}/api/news?limit=4&feedname=steam_community_announcements`, {
          fetchImpl,
          bypassCache,
          nowMs,
        }).catch(() => fetchJsonCached(`${base}/api/news?limit=4`, { fetchImpl, bypassCache, nowMs })),
        fetchJsonCached(`${base}/api/beta/version`, { fetchImpl, bypassCache, nowMs }).catch(() => null),
        fetchJsonCached(`${base}/api/beta/diff`, { fetchImpl, bypassCache, nowMs }).catch(() => null),
      ]);
      return buildSts2NewsCard({ newsData: steamNews, betaVersion, betaDiff }, state);
    }

    // Codex lookup / spotlight tab
    let entityPath = state.entityPath;
    let resolvedKind = "card";

    if (state.lookupQuery) {
      const searchUrl = `${base}/api/search?q=${encodeURIComponent(state.lookupQuery)}`;
      const searchData = await fetchJsonCached(searchUrl, { fetchImpl, bypassCache, nowMs });
      const categories = Array.isArray(searchData?.categories) ? searchData.categories : [];
      const wantedKind = state.lookupKind && state.lookupKind !== "auto" ? state.lookupKind : null;
      let chosenCat = wantedKind ? categories.find((c) => c.kind === wantedKind && c.items?.length) : null;
      if (!chosenCat) {
        chosenCat = categories.find((c) => c.items && c.items.length > 0);
      }
      if (!chosenCat || !chosenCat.items?.length) {
        return basePayload(state, {
          title: `Codex Search: "${state.lookupQuery}"`,
          badge: "NOT FOUND",
          color: "ochre",
          text: `No Slay the Spire 2 entry matched **${state.lookupQuery}**. Try another name or click **Random Card**.`,
          buttons: [
            buildNavButtonRows("codex"),
            [{ id: `${STS2_ACTION_PREFIX}codex:random`, icon: "dice", label: "Random Card", style: "warning" }],
            buildFooterControls(),
          ],
          footer: `Spire Codex Search · ${formatUpdatedClock(nowMs)}`,
        });
      }
      const qLower = state.lookupQuery.toLowerCase();
      const exact = chosenCat.items.find((it) => String(it.name || "").toLowerCase() === qLower);
      const best = exact || chosenCat.items[0];
      entityPath = best.path;
      resolvedKind = chosenCat.kind || "card";
    } else if (!entityPath) {
      const slug = SPOTLIGHT_CARDS[Math.floor(Math.random() * SPOTLIGHT_CARDS.length)];
      entityPath = `/cards/${slug}`;
      resolvedKind = "card";
    } else {
      if (entityPath.startsWith("/relics/")) resolvedKind = "relic";
      else if (entityPath.startsWith("/potions/")) resolvedKind = "potion";
      else if (entityPath.startsWith("/events/")) resolvedKind = "event";
      else if (entityPath.startsWith("/monsters/")) resolvedKind = "monster";
      else resolvedKind = "card";
    }

    const detailUrl = `${base}/api${entityPath.startsWith("/") ? entityPath : `/${entityPath}`}`;
    const entity = await fetchJsonCached(detailUrl, { fetchImpl, bypassCache, nowMs });

    let metricRow = null;
    if (resolvedKind === "card" && entity?.id && entity?.color && VALID_CHARS.has(String(entity.color).toLowerCase())) {
      try {
        const metricsUrl = `${base}/api/runs/metrics/cards?bracket=${encodeURIComponent(state.bracket)}&character=${encodeURIComponent(String(entity.color).toLowerCase())}`;
        const mData = await fetchJsonCached(metricsUrl, { fetchImpl, bypassCache: false, nowMs });
        const rows = Array.isArray(mData?.rows) ? mData.rows : [];
        metricRow =
          rows.find((r) => r.id === entity.id && Boolean(r.upgraded) === Boolean(state.upgraded)) ||
          rows.find((r) => r.id === entity.id) ||
          null;
      } catch {
        // Optional enrichment — never fail card display
      }
    }

    return buildSts2CodexCard(entity, { ...state, entityPath }, { kind: resolvedKind, metricRow, apiBase: base });
  } catch (err) {
    return basePayload(state, {
      title: "Spire Codex Temporarily Unavailable",
      badge: "OFFLINE",
      color: "coral",
      text: `Could not reach **spire-codex.com** (${err?.message || "network error"}). Co-op Party Picker still works 100% offline!`,
      buttons: [buildNavButtonRows(state.tab), buildFooterControls()],
      footer: `Spire Codex · Retry at ${formatUpdatedClock(nowMs)}`,
    });
  }
}

export function pickRandomSpotlightPath(excludePath = null) {
  const pool = SPOTLIGHT_CARDS.map((s) => `/cards/${s}`).filter((p) => p !== excludePath);
  return pool[Math.floor(Math.random() * pool.length)] || "/cards/bash";
}

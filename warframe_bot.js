/**
 * Built-in Warframe Worldstate Bot for p2p-direct (`voice.dequ.org`).
 *
 * Design principles:
 * - Zero network requests to `api.warframestat.us` unless explicitly enabled in Settings.
 * - Operates through a single persistent, interactive bot message per room updated in place
 *   via event-sourced `edit_message` frames (keeping chat clean while preserving raw edit history).
 * - Any peer in the room can click tab, filter, or refresh buttons on the persistent card;
 *   actions route over E2EE to any peer running the built-in Warframe bot.
 */

export const WARFRAME_BOT_ID = "warframe";
export const WARFRAME_API_BASE = "https://api.warframestat.us";

export const WARFRAME_PLATFORMS = Object.freeze(["pc", "ps4", "xb1", "swi"]);
export const WARFRAME_VIEWS = Object.freeze([
  "cycles",
  "fissures",
  "sortie",
  "baro",
  "invasions",
]);
export const WARFRAME_FISSURE_FILTERS = Object.freeze(["normal", "steel", "storm"]);
export const WARFRAME_REFRESH_SECONDS = Object.freeze([0, 60, 120, 300]);

export const DEFAULT_WARFRAME_SETTINGS = Object.freeze({
  enabled: false,
  platform: "pc",
  defaultView: "cycles",
  autoRefreshSec: 120,
});

const TIER_ORDER = Object.freeze({
  lith: 1,
  meso: 2,
  neo: 3,
  axi: 4,
  requiem: 5,
  omnia: 6,
});

export function sanitizeWarframeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const platform = WARFRAME_PLATFORMS.includes(String(src.platform || "").toLowerCase())
    ? String(src.platform).toLowerCase()
    : DEFAULT_WARFRAME_SETTINGS.platform;
  const defaultView = WARFRAME_VIEWS.includes(String(src.defaultView || "").toLowerCase())
    ? String(src.defaultView).toLowerCase()
    : DEFAULT_WARFRAME_SETTINGS.defaultView;
  const rawRefresh = Number(src.autoRefreshSec);
  const autoRefreshSec = WARFRAME_REFRESH_SECONDS.includes(rawRefresh)
    ? rawRefresh
    : DEFAULT_WARFRAME_SETTINGS.autoRefreshSec;
  return {
    enabled: Boolean(src.enabled),
    platform,
    defaultView,
    autoRefreshSec,
  };
}

/**
 * Formats a future ISO timestamp (or epoch ms) into a compact countdown (`2d 4h`, `12m 34s`, `45s`).
 * Falls back to API-supplied text when timestamps are missing.
 */
export function formatWarframeCountdown(isoOrMs, nowMs = Date.now(), fallbackText = "") {
  let targetMs = NaN;
  if (typeof isoOrMs === "number" && Number.isFinite(isoOrMs)) {
    targetMs = isoOrMs;
  } else if (typeof isoOrMs === "string" && isoOrMs.trim()) {
    targetMs = Date.parse(isoOrMs);
  }
  if (Number.isFinite(targetMs)) {
    const diffSec = Math.floor((targetMs - nowMs) / 1000);
    if (diffSec <= 0) return "Expired";
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const secs = diffSec % 60;
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }
  if (typeof fallbackText === "string" && fallbackText.trim()) {
    return fallbackText.trim();
  }
  return "—";
}

function formatUtcClock(nowMs = Date.now()) {
  try {
    return new Date(nowMs).toISOString().slice(11, 19);
  } catch {
    return "00:00:00";
  }
}

function capitalizeWord(s) {
  const clean = String(s || "").trim();
  if (!clean) return "Unknown";
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

function formatRewardSummary(reward) {
  if (!reward || typeof reward !== "object") return "—";
  if (typeof reward.asString === "string" && reward.asString.trim()) {
    return reward.asString.trim();
  }
  const parts = [];
  if (Array.isArray(reward.items)) {
    for (const item of reward.items) {
      if (item) parts.push(String(item));
    }
  }
  if (Array.isArray(reward.countedItems)) {
    for (const ci of reward.countedItems) {
      if (!ci) continue;
      const name = ci.type || ci.key || ci.name || "";
      const count = Number(ci.count) || 1;
      if (name) parts.push(count > 1 ? `${count}x ${name}` : String(name));
    }
  }
  const credits = Number(reward.credits) || 0;
  if (credits > 0 && parts.length === 0) {
    parts.push(`${credits.toLocaleString("en-US")} Cr`);
  }
  return parts.length > 0 ? parts.join(" + ") : "—";
}

/**
 * Checks whether a log message is the built-in persistent Warframe dashboard message.
 */
export function isPersistentWarframeMessage(msg) {
  return Boolean(
    msg &&
      msg.type === "bot" &&
      msg.payload &&
      typeof msg.payload === "object" &&
      msg.payload.builtinBot === WARFRAME_BOT_ID &&
      msg.payload.persistent === true
  );
}

/**
 * Deterministically selects the canonical persistent Warframe dashboard message in the room log
 * (earliest by Lamport clock, tie-broken by message id) so multiple peers converge on one card.
 */
export function findPersistentWarframeMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let best = null;
  for (const m of messages) {
    if (!isPersistentWarframeMessage(m)) continue;
    if (!best) {
      best = m;
      continue;
    }
    const lA = Number(m.lamport) || 0;
    const lB = Number(best.lamport) || 0;
    if (lA < lB || (lA === lB && String(m.id || "") < String(best.id || ""))) {
      best = m;
    }
  }
  return best;
}

/**
 * Parses a Warframe bot card button action ID into a structured command, or returns `null`.
 */
export function parseWarframeAction(actionId) {
  const raw = String(actionId || "").trim();
  if (!raw.startsWith("wf:")) return null;

  if (raw === "wf:dismiss") {
    return { kind: "dismiss" };
  }
  if (raw === "wf:refresh") {
    return { kind: "refresh" };
  }
  if (raw.startsWith("wf:refresh:")) {
    const view = raw.slice("wf:refresh:".length);
    return {
      kind: "refresh",
      view: WARFRAME_VIEWS.includes(view) ? view : undefined,
    };
  }
  if (raw.startsWith("wf:tab:")) {
    const view = raw.slice("wf:tab:".length);
    if (WARFRAME_VIEWS.includes(view)) {
      return { kind: "tab", view };
    }
    return null;
  }
  if (raw.startsWith("wf:fissures:")) {
    const filter = raw.slice("wf:fissures:".length);
    if (WARFRAME_FISSURE_FILTERS.includes(filter)) {
      return { kind: "filter", view: "fissures", filter };
    }
    return null;
  }
  // Legacy / shorthand aliases
  const legacyView = raw.slice(3);
  if (WARFRAME_VIEWS.includes(legacyView)) {
    return { kind: "tab", view: legacyView };
  }
  return null;
}

function buildWarframeButtons(activeView, fissureFilter = "normal") {
  const tabStyle = (id) => (activeView === id ? "primary" : "secondary");
  const rows = [
    [
      { id: "wf:tab:cycles", label: "Open Worlds", style: tabStyle("cycles") },
      { id: "wf:tab:fissures", label: "Fissures", style: tabStyle("fissures") },
      { id: "wf:tab:sortie", label: "Sortie & Archon", style: tabStyle("sortie") },
      { id: "wf:tab:baro", label: "Baro & Steel", style: tabStyle("baro") },
      { id: "wf:tab:invasions", label: "Invasions", style: tabStyle("invasions") },
    ],
  ];

  if (activeView === "fissures") {
    const fStyle = (f) => (fissureFilter === f ? "success" : "secondary");
    rows.push([
      { id: "wf:fissures:normal", label: "Normal Relics", style: fStyle("normal") },
      { id: "wf:fissures:steel", label: "Steel Path", style: fStyle("steel") },
      { id: "wf:fissures:storm", label: "Void Storms", style: fStyle("storm") },
      { id: "wf:refresh:fissures", label: "↻ Refresh", style: "secondary" },
      { id: "wf:dismiss", label: "Remove", style: "danger" },
    ]);
  } else {
    rows.push([
      { id: `wf:refresh:${activeView}`, label: "↻ Refresh", style: "success" },
      {
        id: "wf:lfg",
        label: "Squad Up!",
        style: "warning",
        mode: "reply",
        replyText: "Who wants to squad up for Warframe?",
      },
      { id: "wf:dismiss", label: "Remove", style: "danger" },
    ]);
  }

  return rows;
}

/**
 * Pure builder turning fetched Warframe API JSON objects into a Flat Metro persistent bot card payload.
 */
export function buildWarframeCardFromData(view, data, opts = {}) {
  const cleanView = WARFRAME_VIEWS.includes(view) ? view : "cycles";
  const platform = WARFRAME_PLATFORMS.includes(String(opts.platform || "").toLowerCase())
    ? String(opts.platform).toLowerCase()
    : "pc";
  const fissureFilter = WARFRAME_FISSURE_FILTERS.includes(opts.fissureFilter)
    ? opts.fissureFilter
    : "normal";
  const nowMs = typeof opts.nowMs === "number" && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const autoRefreshSec = Number(opts.autoRefreshSec) || 0;
  const autoTag = autoRefreshSec > 0 ? ` · Auto ${Math.round(autoRefreshSec / 60)}m` : "";
  const footer = `Warframe ${platform.toUpperCase()} · Persistent Dashboard · Updated ${formatUtcClock(nowMs)} UTC${autoTag}`;

  const baseMeta = {
    builtinBot: WARFRAME_BOT_ID,
    persistent: true,
    wfView: cleanView,
    wfFilter: fissureFilter,
    wfPlatform: platform,
    wfUpdatedAt: nowMs,
    subtitle: "WARFRAME WORLDSTATE · LIVE",
    buttons: buildWarframeButtons(cleanView, fissureFilter),
    footer,
  };

  if (cleanView === "cycles") {
    const cetus = data?.cetus || {};
    const vallis = data?.vallis || {};
    const cambion = data?.cambion || {};
    const zariman = data?.zariman || {};
    const duviri = data?.duviri || {};

    const cetusIsDay =
      typeof cetus.isDay === "boolean"
        ? cetus.isDay
        : String(cetus.state || "").toLowerCase() === "day";
    const cetusLeft = formatWarframeCountdown(cetus.expiry, nowMs, cetus.timeLeft);
    const vallisIsWarm =
      typeof vallis.isWarm === "boolean"
        ? vallis.isWarm
        : String(vallis.state || "").toLowerCase() === "warm";
    const vallisLeft = formatWarframeCountdown(vallis.expiry, nowMs, vallis.timeLeft);
    const cambionState = String(cambion.state || cambion.active || "—").toUpperCase();
    const cambionLeft = formatWarframeCountdown(cambion.expiry, nowMs, cambion.timeLeft);
    const zarimanState =
      typeof zariman.isCorpus === "boolean"
        ? zariman.isCorpus
          ? "Corpus"
          : "Grineer"
        : capitalizeWord(zariman.state);
    const zarimanLeft = formatWarframeCountdown(zariman.expiry, nowMs, zariman.timeLeft);
    const duviriMood = capitalizeWord(duviri.state);
    const duviriLeft = formatWarframeCountdown(duviri.expiry, nowMs, duviri.timeLeft);

    const fields = [
      {
        label: "Cetus (Plains)",
        value: `**${cetusIsDay ? "Day" : "Night"}** · ${cetusLeft}`,
        inline: true,
      },
      {
        label: "Orb Vallis",
        value: `**${vallisIsWarm ? "Warm" : "Cold"}** · ${vallisLeft}`,
        inline: true,
      },
      {
        label: "Cambion Drift",
        value: `**${cambionState}** · ${cambionLeft}`,
        inline: true,
      },
      {
        label: "Zariman",
        value: `**${zarimanState}** · ${zarimanLeft}`,
        inline: true,
      },
      {
        label: "Duviri Spiral",
        value: `**${duviriMood}** · ${duviriLeft}`,
        inline: true,
      },
    ];

    if (Array.isArray(duviri.choices) && duviri.choices.length > 0) {
      const normalCircuit = duviri.choices.find((c) => c?.category === "normal");
      const hardCircuit = duviri.choices.find((c) => c?.category === "hard");
      if (normalCircuit && Array.isArray(normalCircuit.choices) && normalCircuit.choices.length > 0) {
        fields.push({
          label: "Circuit Warframes",
          value: normalCircuit.choices.join(" · "),
          inline: true,
        });
      }
      if (hardCircuit && Array.isArray(hardCircuit.choices) && hardCircuit.choices.length > 0) {
        fields.push({
          label: "Steel Path Incarnons",
          value: hardCircuit.choices.join(" · "),
          inline: false,
        });
      }
    }

    return {
      ...baseMeta,
      title: "Open World Cycles",
      badge: cetusIsDay ? `CETUS DAY · ${cetusLeft}` : `EIDOLON NIGHT · ${cetusLeft}`,
      color: cetusIsDay ? "ochre" : "cobalt",
      text: "Live worldstate timers across Cetus, Orb Vallis, Cambion Drift, Zariman, and Duviri. Switch tabs below to update this card in place.",
      fields,
    };
  }

  if (cleanView === "fissures") {
    const list = Array.isArray(data?.fissures) ? data.fissures : [];
    const filtered = list
      .filter((f) => {
        if (!f || f.expired) return false;
        const expMs = Date.parse(f.expiry || "");
        if (Number.isFinite(expMs) && expMs <= nowMs) return false;
        if (fissureFilter === "storm") return Boolean(f.isStorm);
        if (fissureFilter === "steel") return Boolean(f.isHard) && !f.isStorm;
        return !f.isHard && !f.isStorm;
      })
      .sort((a, b) => {
        const ta = Number(a.tierNum) || TIER_ORDER[String(a.tier || "").toLowerCase()] || 99;
        const tb = Number(b.tierNum) || TIER_ORDER[String(b.tier || "").toLowerCase()] || 99;
        if (ta !== tb) return ta - tb;
        return (Date.parse(a.expiry || "") || 0) - (Date.parse(b.expiry || "") || 0);
      });

    const shown = filtered.slice(0, 8);
    const modeLabel =
      fissureFilter === "steel"
        ? "Steel Path"
        : fissureFilter === "storm"
          ? "Void Storms"
          : "Normal";

    return {
      ...baseMeta,
      title: `Void Fissures — ${modeLabel}`,
      badge: `${filtered.length} ACTIVE`,
      color: fissureFilter === "steel" ? "coral" : fissureFilter === "storm" ? "cyan" : "mint",
      text:
        shown.length > 0
          ? `Showing ${shown.length} of ${filtered.length} active **${modeLabel}** fissures:`
          : `No active **${modeLabel}** fissures right now.`,
      fields: shown.map((f) => {
        const left = formatWarframeCountdown(f.expiry, nowMs, f.eta);
        const enemy = f.enemy ? ` · ${f.enemy}` : "";
        return {
          label: `${f.tier || "Relic"}${f.isHard ? " · SP" : ""}${f.isStorm ? " · Railjack" : ""}`,
          value: `**${f.missionType || "Mission"}** — ${f.node || "Unknown"}${enemy} (\`${left}\`)`,
          inline: true,
        };
      }),
    };
  }

  if (cleanView === "sortie") {
    const sortie = data?.sortie || {};
    const archon = data?.archon || {};
    const variants = Array.isArray(sortie.variants) ? sortie.variants : [];
    const archonMissions = Array.isArray(archon.missions) ? archon.missions : [];
    const sortieLeft = formatWarframeCountdown(sortie.expiry, nowMs, sortie.eta);
    const archonLeft = formatWarframeCountdown(archon.expiry, nowMs, archon.eta);

    const fields = [];
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i] || {};
      fields.push({
        label: `Sortie ${i + 1} · ${v.missionType || "Mission"}`,
        value: `${v.node || "Unknown"} — \`${v.modifier || "Standard"}\``,
        inline: false,
      });
    }
    if (archon.boss || archonMissions.length > 0) {
      const missionLine = archonMissions
        .map((m, idx) => `${idx + 1}. **${m.type || "Mission"}** (${m.node || "?"})`)
        .join("  ·  ");
      fields.push({
        label: `Weekly Archon Hunt — ${archon.boss || "Archon"} (${archonLeft})`,
        value: missionLine || "Check navigation for active stages.",
        inline: false,
      });
    }

    return {
      ...baseMeta,
      title: `Sortie — ${sortie.boss || "Daily Sortie"}`,
      badge: `RESETS ${sortieLeft}`,
      color: "coral",
      text: `Sortie Faction: **${sortie.faction || "Unknown"}** · Archon: **${archon.boss || "—"}**`,
      fields,
    };
  }

  if (cleanView === "baro") {
    const trader = data?.trader || {};
    const sp = data?.steelPath || {};
    const actMs = Date.parse(trader.activation || "");
    const expMs = Date.parse(trader.expiry || "");
    const isActive =
      typeof trader.active === "boolean"
        ? trader.active
        : Number.isFinite(actMs) && Number.isFinite(expMs)
          ? nowMs >= actMs && nowMs < expMs
          : false;

    const etaStr = isActive
      ? formatWarframeCountdown(trader.expiry, nowMs, trader.endString)
      : formatWarframeCountdown(trader.activation, nowMs, trader.startString);
    const location = trader.location || "Tenno Relay";

    const fields = [];
    if (isActive && Array.isArray(trader.inventory) && trader.inventory.length > 0) {
      for (const item of trader.inventory.slice(0, 6)) {
        fields.push({
          label: item.item || "Item",
          value: `${item.ducats ?? 0} Ducats · ${(Number(item.credits) || 0).toLocaleString("en-US")} Cr`,
          inline: true,
        });
      }
    } else {
      fields.push({
        label: "Baro Ki'Teer",
        value: isActive
          ? `Visiting **${location}** · Leaves in \`${etaStr}\``
          : `Next visit: **${location}** · Arrives in \`${etaStr}\``,
        inline: false,
      });
    }

    if (sp && sp.currentReward) {
      const spLeft = formatWarframeCountdown(sp.expiry, nowMs, sp.remaining);
      fields.push({
        label: "Steel Path Weekly Honor",
        value: `**${sp.currentReward.name || "Reward"}** · ${sp.currentReward.cost ?? "?"} Steel Essence (\`${spLeft}\`)`,
        inline: false,
      });
    }

    return {
      ...baseMeta,
      title: "Baro Ki'Teer & Steel Path",
      badge: isActive ? `HERE · ${etaStr}` : `IN ${etaStr}`,
      color: isActive ? "mint" : "cyan",
      text: isActive
        ? `Baro is at **${location}** and leaves in **${etaStr}**.`
        : `Baro Ki'Teer arrives at **${location}** in **${etaStr}**.`,
      fields,
    };
  }

  // invasions + alerts
  const alerts = (Array.isArray(data?.alerts) ? data.alerts : []).filter((a) => {
    if (!a || a.expired) return false;
    const expMs = Date.parse(a.expiry || "");
    return !Number.isFinite(expMs) || expMs > nowMs;
  });
  const invasions = (Array.isArray(data?.invasions) ? data.invasions : []).filter(
    (inv) => inv && !inv.completed
  );

  const fields = [];
  for (const a of alerts.slice(0, 3)) {
    const m = a.mission || {};
    const left = formatWarframeCountdown(a.expiry, nowMs, a.eta);
    const reward = formatRewardSummary(m.reward);
    fields.push({
      label: `Alert · ${m.description || m.type || "Mission"}`,
      value: `**${reward}** — ${m.node || "Unknown"} (\`${left}\`)`,
      inline: false,
    });
  }
  for (const inv of invasions.slice(0, 5)) {
    const atk = formatRewardSummary(inv.attacker?.reward);
    const def = formatRewardSummary(inv.defender?.reward);
    const rewardText = inv.vsInfestation || atk === "—" ? def : `${atk}  vs  ${def}`;
    const pct =
      typeof inv.completion === "number" && Number.isFinite(inv.completion)
        ? `${Math.max(0, Math.min(100, Math.round(inv.completion)))}%`
        : "";
    fields.push({
      label: `Invasion · ${inv.node || "Unknown"}${pct ? ` (${pct})` : ""}`,
      value: `**${rewardText}**`,
      inline: true,
    });
  }

  return {
    ...baseMeta,
    title: "Alerts & Invasions",
    badge: `${alerts.length} ALERTS · ${invasions.length} INV`,
    color: alerts.length > 0 ? "ochre" : "cobalt",
    text:
      fields.length > 0
        ? "Active Gift of the Lotus alerts and ongoing faction invasions:"
        : "No active alerts or invasions right now.",
    fields,
  };
}

export function buildWarframeErrorCard(view, errorMessage, opts = {}) {
  const cleanView = WARFRAME_VIEWS.includes(view) ? view : "cycles";
  const platform = WARFRAME_PLATFORMS.includes(String(opts.platform || "").toLowerCase())
    ? String(opts.platform).toLowerCase()
    : "pc";
  const fissureFilter = WARFRAME_FISSURE_FILTERS.includes(opts.fissureFilter)
    ? opts.fissureFilter
    : "normal";
  const nowMs = typeof opts.nowMs === "number" && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  return {
    builtinBot: WARFRAME_BOT_ID,
    persistent: true,
    wfView: cleanView,
    wfFilter: fissureFilter,
    wfPlatform: platform,
    wfUpdatedAt: nowMs,
    subtitle: "WARFRAME WORLDSTATE · OFFLINE",
    title: "Worldstate Unavailable",
    badge: "RETRY",
    color: "coral",
    text: `Could not reach \`api.warframestat.us\`: ${String(errorMessage || "Network error").slice(0, 160)}`,
    fields: [],
    buttons: buildWarframeButtons(cleanView, fissureFilter),
    footer: `Warframe ${platform.toUpperCase()} · Click ↻ Refresh to retry · ${formatUtcClock(nowMs)} UTC`,
  };
}

async function fetchJsonEndpoint(platform, endpoint, fetchImpl, timeoutMs = 7000) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const resp = await fetchImpl(`${WARFRAME_API_BASE}/${platform}/${endpoint}`, {
      signal: controller ? controller.signal : undefined,
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return await resp.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetches live Warframe worldstate endpoints for `view` and returns a ready-to-publish bot card payload.
 */
export async function fetchWarframeWorldstateCard(view = "cycles", opts = {}) {
  const cleanView = WARFRAME_VIEWS.includes(view) ? view : "cycles";
  const platform = WARFRAME_PLATFORMS.includes(String(opts.platform || "").toLowerCase())
    ? String(opts.platform).toLowerCase()
    : "pc";
  const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const nowMs = typeof opts.nowMs === "number" && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  if (!fetchImpl) {
    return buildWarframeErrorCard(cleanView, "fetch unavailable", { ...opts, platform, nowMs });
  }

  try {
    let data = {};
    if (cleanView === "cycles") {
      const [cetus, vallis, cambion, zariman, duviri] = await Promise.all([
        fetchJsonEndpoint(platform, "cetusCycle", fetchImpl),
        fetchJsonEndpoint(platform, "vallisCycle", fetchImpl),
        fetchJsonEndpoint(platform, "cambionCycle", fetchImpl),
        fetchJsonEndpoint(platform, "zarimanCycle", fetchImpl).catch(() => ({})),
        fetchJsonEndpoint(platform, "duviriCycle", fetchImpl).catch(() => ({})),
      ]);
      data = { cetus, vallis, cambion, zariman, duviri };
    } else if (cleanView === "fissures") {
      const fissures = await fetchJsonEndpoint(platform, "fissures", fetchImpl);
      data = { fissures };
    } else if (cleanView === "sortie") {
      const [sortie, archon] = await Promise.all([
        fetchJsonEndpoint(platform, "sortie", fetchImpl),
        fetchJsonEndpoint(platform, "archonHunt", fetchImpl).catch(() => ({})),
      ]);
      data = { sortie, archon };
    } else if (cleanView === "baro") {
      const [trader, steelPath] = await Promise.all([
        fetchJsonEndpoint(platform, "voidTrader", fetchImpl),
        fetchJsonEndpoint(platform, "steelPath", fetchImpl).catch(() => ({})),
      ]);
      data = { trader, steelPath };
    } else if (cleanView === "invasions") {
      const [alerts, invasions] = await Promise.all([
        fetchJsonEndpoint(platform, "alerts", fetchImpl).catch(() => []),
        fetchJsonEndpoint(platform, "invasions", fetchImpl),
      ]);
      data = { alerts, invasions };
    }

    return buildWarframeCardFromData(cleanView, data, { ...opts, platform, nowMs });
  } catch (err) {
    return buildWarframeErrorCard(cleanView, err?.message || String(err), { ...opts, platform, nowMs });
  }
}

/**
 * Builds a compact one-line summary for the Chat header jump-pill pointing at the persistent card.
 */
export function summarizeWarframePill(msg) {
  if (!isPersistentWarframeMessage(msg)) return "";
  const p = msg.payload || {};
  const badge = typeof p.badge === "string" && p.badge.trim() ? p.badge.trim() : "";
  if (badge) return `WF · ${badge}`;
  return "WF · WORLDSTATE";
}

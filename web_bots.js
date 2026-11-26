/**
 * Built-in 3rd-Party Public-API Persistent Bots (Keyless, CORS-enabled):
 *  1. Weather & Forecast (Open-Meteo: geocoding-api.open-meteo.com + api.open-meteo.com)
 *  2. Wikipedia / Quick Reference (Wikimedia REST API: en.wikipedia.org/api/rest_v1)
 *  3. GitHub Releases & Repo Tracker (GitHub Public REST API: api.github.com)
 *
 * All bots are opt-in (disabled by default). Zero external requests occur while
 * disabled. Each bot operates via one persistent interactive card per room.
 */

export const WEATHER_BOT_ID = "weather";
export const WIKI_BOT_ID = "wikipedia";
export const GITHUB_BOT_ID = "github";

export const WEATHER_ACTION_PREFIX = "wx:";
export const WIKI_ACTION_PREFIX = "wiki:";
export const GITHUB_ACTION_PREFIX = "gh:";

export const DEFAULT_WEATHER_SETTINGS = Object.freeze({
  enabled: false,
  cities: "Berlin, Tokyo, New York",
  unit: "c", // "c" | "f"
});

export const DEFAULT_WIKI_SETTINGS = Object.freeze({
  enabled: false,
  defaultTab: "featured", // "featured" | "random" | "onthisday"
  inlineLookup: true,
});

export const DEFAULT_GITHUB_SETTINGS = Object.freeze({
  enabled: false,
  repo: "lz-er/p2p-direct",
  defaultTab: "overview", // "overview" | "commits" | "issues"
});

const VALID_WIKI_TABS = new Set(["featured", "random", "onthisday", "lookup"]);
const VALID_GH_TABS = new Set(["overview", "commits", "issues"]);

const GEOCODE_CACHE = new Map();

export function clearWebBotCaches() {
  GEOCODE_CACHE.clear();
}

export function parseCitiesList(raw) {
  const list = String(raw || "")
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const city of list) {
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(city.slice(0, 48));
    if (unique.length >= 4) break;
  }
  return unique.length > 0 ? unique : ["Berlin"];
}

export function sanitizeWeatherSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const citiesStr =
    typeof src.cities === "string" && src.cities.trim()
      ? parseCitiesList(src.cities).join(", ")
      : DEFAULT_WEATHER_SETTINGS.cities;
  return {
    enabled: Boolean(src.enabled),
    cities: citiesStr,
    unit: String(src.unit || "").toLowerCase() === "f" ? "f" : "c",
  };
}

export function sanitizeWikiSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const dt = String(src.defaultTab || "").toLowerCase();
  return {
    enabled: Boolean(src.enabled),
    defaultTab: dt === "random" || dt === "onthisday" ? dt : "featured",
    inlineLookup: src.inlineLookup !== false,
  };
}

export function sanitizeGithubRepo(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2 && /^[A-Za-z0-9_.-]+$/.test(parts[0]) && /^[A-Za-z0-9_.-]+$/.test(parts[1])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return DEFAULT_GITHUB_SETTINGS.repo;
}

export function sanitizeGithubSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const dt = String(src.defaultTab || "").toLowerCase();
  return {
    enabled: Boolean(src.enabled),
    repo: sanitizeGithubRepo(src.repo),
    defaultTab: VALID_GH_TABS.has(dt) ? dt : "overview",
  };
}

function formatClock(nowMs) {
  try {
    return new Date(nowMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "now";
  }
}

export function findPersistentBotMessage(logMessages, botId) {
  if (!Array.isArray(logMessages) || !botId) return null;
  for (let i = logMessages.length - 1; i >= 0; i--) {
    const m = logMessages[i];
    if (
      m &&
      m.type === "bot" &&
      m.payload &&
      typeof m.payload === "object" &&
      m.payload.builtinBot === botId &&
      m.payload.persistent === true
    ) {
      return m;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. WEATHER BOT (Open-Meteo)
// ---------------------------------------------------------------------------

const WMO_CODES = Object.freeze({
  0: "Clear Sky",
  1: "Mainly Clear",
  2: "Partly Cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing Rime Fog",
  51: "Light Drizzle",
  53: "Moderate Drizzle",
  55: "Dense Drizzle",
  56: "Freezing Drizzle",
  57: "Dense Freezing Drizzle",
  61: "Slight Rain",
  63: "Moderate Rain",
  65: "Heavy Rain",
  66: "Freezing Rain",
  67: "Heavy Freezing Rain",
  71: "Slight Snow",
  73: "Moderate Snow",
  75: "Heavy Snow",
  77: "Snow Grains",
  80: "Rain Showers",
  81: "Moderate Showers",
  82: "Violent Showers",
  85: "Snow Showers",
  86: "Heavy Snow Showers",
  95: "Thunderstorm",
  96: "Thunderstorm + Hail",
  99: "Severe Thunderstorm",
});

export function describeWmoCode(code) {
  return WMO_CODES[Number(code)] || `Weather #${code ?? "?"}`;
}

export function formatTemp(celsius, unit = "c") {
  if (celsius == null || !Number.isFinite(Number(celsius))) return "—";
  const c = Number(celsius);
  if (unit === "f") {
    return `${Math.round((c * 9) / 5 + 32)}°F`;
  }
  return `${Math.round(c)}°C`;
}

export function parseWeatherAction(actionId) {
  if (typeof actionId !== "string" || !actionId.startsWith(WEATHER_ACTION_PREFIX)) return null;
  const rest = actionId.slice(WEATHER_ACTION_PREFIX.length);
  if (rest === "refresh") return { kind: "refresh" };
  if (rest === "dismiss") return { kind: "dismiss" };
  if (rest === "unit:c" || rest === "unit:f") return { kind: "unit", unit: rest.slice(5) };
  if (rest.startsWith("city:")) {
    const idx = Number(rest.slice(5));
    if (Number.isInteger(idx) && idx >= 0 && idx < 4) return { kind: "city", index: idx };
  }
  return null;
}

export function summarizeWeatherPill(msg) {
  const city = msg?.payload?.wxCity || "WEATHER";
  const temp = msg?.payload?.wxTempLabel || "";
  return temp ? `WX · ${String(city).slice(0, 10).toUpperCase()} ${temp}` : `WX · ${String(city).slice(0, 12).toUpperCase()}`;
}

export async function fetchWeatherCard(
  settingsInput,
  { cityIndex = 0, unitOverride = null, nowMs = Date.now(), fetchImpl = globalThis.fetch } = {}
) {
  const settings = sanitizeWeatherSettings(settingsInput);
  const cities = parseCitiesList(settings.cities);
  const safeIdx = Math.max(0, Math.min(cities.length - 1, Number(cityIndex) || 0));
  const cityName = cities[safeIdx];
  const unit = unitOverride === "f" || unitOverride === "c" ? unitOverride : settings.unit;

  const cityRow = cities.map((c, idx) => ({
    id: `${WEATHER_ACTION_PREFIX}city:${idx}`,
    label: c,
    style: idx === safeIdx ? "primary" : "secondary",
  }));
  const nextUnit = unit === "f" ? "c" : "f";
  const controlRow = [
    { id: `${WEATHER_ACTION_PREFIX}unit:${nextUnit}`, label: `Switch to °${nextUnit.toUpperCase()}`, style: "secondary" },
    { id: `${WEATHER_ACTION_PREFIX}refresh`, label: "↻ Refresh", style: "secondary" },
    { id: `${WEATHER_ACTION_PREFIX}dismiss`, label: "✕ Hide", style: "danger" },
  ];

  try {
    if (typeof fetchImpl !== "function") throw new Error("fetch unavailable");
    const geoKey = cityName.toLowerCase();
    let place = GEOCODE_CACHE.get(geoKey);
    if (!place) {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`;
      const geoRes = await fetchImpl(geoUrl, { headers: { Accept: "application/json" } });
      if (!geoRes.ok) throw new Error(`Geocoding HTTP ${geoRes.status}`);
      const geoJson = await geoRes.json();
      const first = Array.isArray(geoJson?.results) ? geoJson.results[0] : null;
      if (!first) throw new Error(`City "${cityName}" not found`);
      place = {
        name: first.name || cityName,
        country: first.country_code || first.country || "",
        lat: first.latitude,
        lon: first.longitude,
      };
      GEOCODE_CACHE.set(geoKey, place);
    }

    const wxUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(place.lat)}&longitude=${encodeURIComponent(place.lon)}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max&timezone=auto&forecast_days=3`;
    const wxRes = await fetchImpl(wxUrl, { headers: { Accept: "application/json" } });
    if (!wxRes.ok) throw new Error(`Forecast HTTP ${wxRes.status}`);
    const wx = await wxRes.json();

    const cur = wx.current || {};
    const tempStr = formatTemp(cur.temperature_2m, unit);
    const feelsStr = formatTemp(cur.apparent_temperature, unit);
    const condStr = describeWmoCode(cur.weather_code);
    const humidity = cur.relative_humidity_2m != null ? `${Math.round(Number(cur.relative_humidity_2m))}%` : "—";
    const wind = cur.wind_speed_10m != null ? `${Math.round(Number(cur.wind_speed_10m))} km/h` : "—";

    const fields = [
      {
        label: "Now",
        value: `**${tempStr}** · ${condStr} · Feels like ${feelsStr}`,
        inline: false,
      },
      { label: "Humidity & Wind", value: `Humidity **${humidity}** · Wind **${wind}**`, inline: true },
    ];

    const daily = wx.daily || {};
    const times = Array.isArray(daily.time) ? daily.time : [];
    const maxs = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
    const mins = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
    const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
    const precip = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max : [];

    for (let i = 0; i < Math.min(3, times.length); i++) {
      const dayLabel = i === 0 ? "Today" : i === 1 ? "Tomorrow" : times[i];
      const rain = precip[i] != null ? ` · 💧 ${precip[i]}%` : "";
      fields.push({
        label: dayLabel,
        value: `**${formatTemp(maxs[i], unit)}** / ${formatTemp(mins[i], unit)} · ${describeWmoCode(codes[i])}${rain}`,
        inline: true,
      });
    }

    const placeLabel = place.country ? `${place.name}, ${place.country}` : place.name;
    return {
      builtinBot: WEATHER_BOT_ID,
      persistent: true,
      wxCityIndex: safeIdx,
      wxCity: place.name,
      wxTempLabel: tempStr,
      wxUnit: unit,
      wxUpdatedAt: nowMs,
      subtitle: "WEATHER",
      title: `${placeLabel} — ${tempStr}`,
      badge: condStr.toUpperCase(),
      color: "cyan",
      fields,
      buttons: [cityRow, controlRow],
      footer: `Open-Meteo · ${formatClock(nowMs)}`,
    };
  } catch (err) {
    return {
      builtinBot: WEATHER_BOT_ID,
      persistent: true,
      wxCityIndex: safeIdx,
      wxCity: cityName,
      wxTempLabel: "",
      wxUnit: unit,
      wxUpdatedAt: nowMs,
      subtitle: "WEATHER",
      title: `Weather Unavailable (${cityName})`,
      badge: "OFFLINE",
      color: "coral",
      text: `Unavailable (${err?.message || "offline"}).`,
      buttons: [cityRow, controlRow],
      footer: `Open-Meteo · ${formatClock(nowMs)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 2. WIKIPEDIA / QUICK REFERENCE BOT (Wikimedia REST API)
// ---------------------------------------------------------------------------

export function extractWikiBracketQuery(text) {
  if (typeof text !== "string" || !text.includes("[[")) return null;
  const re = /\[\[(?:wiki|wikipedia|w):([^\[\]\n]{1,100})\]\]/i;
  const m = re.exec(text);
  return m && m[1].trim() ? m[1].trim() : null;
}

export function parseWikiAction(actionId) {
  if (typeof actionId !== "string" || !actionId.startsWith(WIKI_ACTION_PREFIX)) return null;
  const rest = actionId.slice(WIKI_ACTION_PREFIX.length);
  if (rest === "refresh") return { kind: "refresh" };
  if (rest === "dismiss") return { kind: "dismiss" };
  if (rest.startsWith("tab:")) {
    const tab = rest.slice(4);
    if (VALID_WIKI_TABS.has(tab)) return { kind: "tab", tab };
  }
  return null;
}

export function summarizeWikiPill(msg) {
  const t = msg?.payload?.wikiTopic;
  return t ? `WIKI · ${String(t).slice(0, 14).toUpperCase()}` : "WIKI · LIVE";
}

function wikiNavRow(activeTab) {
  const tabs = [
    { id: "featured", label: "Featured" },
    { id: "random", label: "🎲 Random" },
    { id: "onthisday", label: "On This Day" },
  ];
  return tabs.map((t) => ({
    id: `${WIKI_ACTION_PREFIX}tab:${t.id}`,
    label: t.label,
    style: t.id === activeTab ? "primary" : "secondary",
  }));
}

export async function fetchWikiCard(
  { tab = "featured", query = null, nowMs = Date.now(), fetchImpl = globalThis.fetch } = {}
) {
  const activeTab = query ? "lookup" : VALID_WIKI_TABS.has(tab) ? tab : "featured";
  const d = new Date(nowMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");

  const baseControls = (articleUrl = null) => {
    const row = [];
    if (articleUrl && /^https?:\/\//i.test(articleUrl)) {
      row.push({ id: "wiki_open_article", label: "Open Article", url: articleUrl, style: "primary" });
    }
    row.push({ id: `${WIKI_ACTION_PREFIX}refresh`, label: "↻ Refresh", style: "secondary" });
    row.push({ id: `${WIKI_ACTION_PREFIX}dismiss`, label: "✕ Hide", style: "danger" });
    return row;
  };

  try {
    if (typeof fetchImpl !== "function") throw new Error("fetch unavailable");

    if (activeTab === "onthisday") {
      const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/selected/${mm}/${dd}`;
      const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const selected = Array.isArray(data?.selected) ? data.selected.slice(0, 4) : [];
      const fields = selected.map((ev) => ({
        label: String(ev.year ?? "History"),
        value: String(ev.text || "").slice(0, 220),
        inline: false,
      }));
      const firstUrl = selected[0]?.pages?.[0]?.content_urls?.desktop?.page || "https://en.wikipedia.org";
      return {
        builtinBot: WIKI_BOT_ID,
        persistent: true,
        wikiTab: "onthisday",
        wikiTopic: `${mm}/${dd}`,
        wikiUpdatedAt: nowMs,
        subtitle: "WIKIPEDIA",
        title: `On This Day — ${mm}/${dd}`,
        badge: "HISTORY",
        color: "cobalt",
        fields: fields.length > 0 ? fields : [{ label: "Events", value: "No events.", inline: false }],
        buttons: [wikiNavRow("onthisday"), baseControls(firstUrl)],
        footer: `Lookup: [[wiki:Topic]] · ${formatClock(nowMs)}`,
      };
    }

    if (activeTab === "featured") {
      const url = `https://en.wikipedia.org/api/rest_v1/feed/featured/${yyyy}/${mm}/${dd}`;
      const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const tfa = data?.tfa || null;
      const mostread = Array.isArray(data?.mostread?.articles) ? data.mostread.articles.slice(0, 2) : [];
      const title = tfa?.titles?.normalized || tfa?.title || "Wikipedia Today";
      const extract = String(tfa?.extract || "Summary unavailable.").slice(0, 480);
      const articleUrl = tfa?.content_urls?.desktop?.page || "https://en.wikipedia.org";
      const thumb = tfa?.thumbnail?.source || "";

      const fields = [];
      if (tfa?.description) {
        fields.push({ label: "Topic", value: `**${tfa.description}**`, inline: false });
      }
      if (mostread.length > 0) {
        fields.push({
          label: "Trending",
          value: mostread
            .map((a) => `**${a.titles?.normalized || a.title}** (${Number(a.views || 0).toLocaleString()} views)`)
            .join(" · "),
          inline: false,
        });
      }

      const payload = {
        builtinBot: WIKI_BOT_ID,
        persistent: true,
        wikiTab: "featured",
        wikiTopic: title,
        wikiUpdatedAt: nowMs,
        subtitle: "WIKIPEDIA",
        title,
        badge: "FEATURED",
        color: "cobalt",
        text: extract,
        fields,
        buttons: [wikiNavRow("featured"), baseControls(articleUrl)],
        footer: `Lookup: [[wiki:Topic]] · ${formatClock(nowMs)}`,
      };
      if (thumb && /^https:\/\//i.test(thumb)) {
        payload.image = { url: thumb, alt: title };
      }
      return payload;
    }

    // Random or Explicit Lookup
    let summary = null;
    if (activeTab === "lookup" && query) {
      const slug = encodeURIComponent(query.trim().replace(/\s+/g, "_"));
      const directUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;
      const directRes = await fetchImpl(directUrl, { headers: { Accept: "application/json" } });
      if (directRes.ok) {
        summary = await directRes.json();
      } else {
        // Fallback to OpenSearch for fuzzy topic match
        const osUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&origin=*&limit=1&search=${encodeURIComponent(query.trim())}`;
        const osRes = await fetchImpl(osUrl, { headers: { Accept: "application/json" } });
        if (osRes.ok) {
          const osData = await osRes.json();
          const matchedTitle = Array.isArray(osData?.[1]) ? osData[1][0] : null;
          if (matchedTitle) {
            const retryRes = await fetchImpl(
              `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(matchedTitle.replace(/\s+/g, "_"))}`,
              { headers: { Accept: "application/json" } }
            );
            if (retryRes.ok) summary = await retryRes.json();
          }
        }
      }
      if (!summary) {
        return {
          builtinBot: WIKI_BOT_ID,
          persistent: true,
          wikiTab: "lookup",
          wikiTopic: query,
          wikiQuery: query,
          wikiUpdatedAt: nowMs,
          subtitle: "WIKIPEDIA",
          title: `Not Found: "${query}"`,
          badge: "NO MATCH",
          color: "ochre",
          text: `No article found for **${query}**.`,
          buttons: [wikiNavRow("random"), baseControls()],
          footer: `Wikipedia · ${formatClock(nowMs)}`,
        };
      }
    } else {
      const randRes = await fetchImpl("https://en.wikipedia.org/api/rest_v1/page/random/summary", {
        headers: { Accept: "application/json" },
      });
      if (!randRes.ok) throw new Error(`HTTP ${randRes.status}`);
      summary = await randRes.json();
    }

    const title = summary?.titles?.normalized || summary?.title || "Wikipedia";
    const extract = String(summary?.extract || "No summary.").slice(0, 520);
    const articleUrl = summary?.content_urls?.desktop?.page || "https://en.wikipedia.org";
    const thumb = summary?.thumbnail?.source || "";

    const payload = {
      builtinBot: WIKI_BOT_ID,
      persistent: true,
      wikiTab: activeTab,
      wikiTopic: title,
      wikiQuery: query || null,
      wikiUpdatedAt: nowMs,
      subtitle: "WIKIPEDIA",
      title,
      badge: activeTab === "lookup" ? "LOOKUP" : "RANDOM",
      color: "cobalt",
      text: extract,
      fields: summary?.description ? [{ label: "Summary", value: `**${summary.description}**`, inline: false }] : [],
      buttons: [wikiNavRow(activeTab), baseControls(articleUrl)],
      footer: `Lookup: [[wiki:Topic]] · ${formatClock(nowMs)}`,
    };
    if (thumb && /^https:\/\//i.test(thumb)) {
      payload.image = { url: thumb, alt: title };
    }
    return payload;
  } catch (err) {
    return {
      builtinBot: WIKI_BOT_ID,
      persistent: true,
      wikiTab: activeTab,
      wikiTopic: query || activeTab,
      wikiUpdatedAt: nowMs,
      subtitle: "WIKIPEDIA",
      title: "Wikipedia Unavailable",
      badge: "OFFLINE",
      color: "coral",
      text: `Unavailable (${err?.message || "offline"}).`,
      buttons: [wikiNavRow(activeTab), baseControls()],
      footer: `Wikipedia · ${formatClock(nowMs)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 3. GITHUB RELEASES & REPO TRACKER BOT (GitHub Public REST API)
// ---------------------------------------------------------------------------

export function parseGithubAction(actionId) {
  if (typeof actionId !== "string" || !actionId.startsWith(GITHUB_ACTION_PREFIX)) return null;
  const rest = actionId.slice(GITHUB_ACTION_PREFIX.length);
  if (rest === "refresh") return { kind: "refresh" };
  if (rest === "dismiss") return { kind: "dismiss" };
  if (rest.startsWith("tab:")) {
    const tab = rest.slice(4);
    if (VALID_GH_TABS.has(tab)) return { kind: "tab", tab };
  }
  return null;
}

export function summarizeGithubPill(msg) {
  const repo = msg?.payload?.ghRepo || "GITHUB";
  const short = String(repo).split("/").pop() || repo;
  return `GH · ${short.slice(0, 14).toUpperCase()}`;
}

function ghNavRow(activeTab) {
  const tabs = [
    { id: "overview", label: "Overview & Release" },
    { id: "commits", label: "Commits" },
    { id: "issues", label: "Issues & PRs" },
  ];
  return tabs.map((t) => ({
    id: `${GITHUB_ACTION_PREFIX}tab:${t.id}`,
    label: t.label,
    style: t.id === activeTab ? "primary" : "secondary",
  }));
}

function formatShortDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return String(iso).slice(0, 10);
  }
}

export async function fetchGithubCard(
  settingsInput,
  { tab = null, nowMs = Date.now(), fetchImpl = globalThis.fetch } = {}
) {
  const settings = sanitizeGithubSettings(settingsInput);
  const repo = settings.repo;
  const activeTab = VALID_GH_TABS.has(tab) ? tab : settings.defaultTab;
  const repoWebUrl = `https://github.com/${repo}`;

  const controlsRow = (extraUrl = repoWebUrl, extraLabel = "Open Repo") => [
    { id: "gh_open_repo", label: extraLabel, url: extraUrl, style: "secondary" },
    { id: `${GITHUB_ACTION_PREFIX}refresh`, label: "↻ Refresh", style: "secondary" },
    { id: `${GITHUB_ACTION_PREFIX}dismiss`, label: "✕ Hide", style: "danger" },
  ];

  try {
    if (typeof fetchImpl !== "function") throw new Error("fetch unavailable");
    const headers = { Accept: "application/vnd.github+json" };

    if (activeTab === "commits") {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits?per_page=5`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const commits = await res.json();
      const list = Array.isArray(commits) ? commits.slice(0, 5) : [];
      const fields = list.map((c) => {
        const sha = String(c.sha || "").slice(0, 7);
        const headline = String(c.commit?.message || "").split("\n")[0].slice(0, 90);
        const author = c.author?.login || c.commit?.author?.name || "author";
        const dateStr = formatShortDate(c.commit?.author?.date);
        return {
          label: `\`${sha}\` · ${author} · ${dateStr}`,
          value: headline || "(no commit message)",
          inline: false,
        };
      });
      return {
        builtinBot: GITHUB_BOT_ID,
        persistent: true,
        ghRepo: repo,
        ghTab: "commits",
        ghUpdatedAt: nowMs,
        subtitle: `GITHUB · ${repo.toUpperCase()}`,
        title: `${repo} — Recent Commits`,
        badge: `${list.length} LATEST`,
        color: "ink",
        fields: fields.length > 0 ? fields : [{ label: "Commits", value: "No commits.", inline: false }],
        buttons: [ghNavRow("commits"), controlsRow(`${repoWebUrl}/commits`, "All Commits")],
        footer: `GitHub · ${formatClock(nowMs)}`,
      };
    }

    if (activeTab === "issues") {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues?state=open&per_page=5`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = await res.json();
      const list = Array.isArray(items) ? items.slice(0, 5) : [];
      const fields = list.map((it) => {
        const kind = it.pull_request ? "PR" : "Issue";
        const user = it.user?.login || "user";
        return {
          label: `${kind} #${it.number} · ${user} · ${formatShortDate(it.created_at)}`,
          value: `**${String(it.title || "").slice(0, 95)}**`,
          inline: false,
        };
      });
      return {
        builtinBot: GITHUB_BOT_ID,
        persistent: true,
        ghRepo: repo,
        ghTab: "issues",
        ghUpdatedAt: nowMs,
        subtitle: `GITHUB · ${repo.toUpperCase()}`,
        title: `${repo} — Open Issues & PRs`,
        badge: `${list.length} OPEN`,
        color: "mint",
        fields:
          fields.length > 0
            ? fields
            : [{ label: "Open Issues", value: "None.", inline: false }],
        buttons: [ghNavRow("issues"), controlsRow(`${repoWebUrl}/issues`, "Open Issues")],
        footer: `GitHub · ${formatClock(nowMs)}`,
      };
    }

    // Overview & Latest Release
    const [repoRes, relRes] = await Promise.all([
      fetchImpl(`https://api.github.com/repos/${repo}`, { headers }),
      fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers }).catch(() => null),
    ]);
    if (!repoRes.ok) throw new Error(`HTTP ${repoRes.status}`);
    const info = await repoRes.json();
    const release = relRes && relRes.ok ? await relRes.json() : null;

    const fields = [
      {
        label: "Stats",
        value: `★ **${Number(info.stargazers_count || 0).toLocaleString()}** · Forks **${Number(info.forks_count || 0).toLocaleString()}** · Open Issues **${Number(info.open_issues_count || 0).toLocaleString()}**`,
        inline: false,
      },
      {
        label: "Branch",
        value: `\`${info.default_branch || "main"}\` · Push **${formatShortDate(info.pushed_at)}**${info.language ? ` · ${info.language}` : ""}`,
        inline: true,
      },
      {
        label: "Latest Release",
        value: release
          ? `**${release.tag_name || release.name}** (${formatShortDate(release.published_at)})`
          : "None yet",
        inline: true,
      },
    ];

    const relUrl = release?.html_url || info.html_url || repoWebUrl;
    const overviewCard = {
      builtinBot: GITHUB_BOT_ID,
      persistent: true,
      ghRepo: repo,
      ghTab: "overview",
      ghUpdatedAt: nowMs,
      subtitle: "GITHUB",
      title: info.full_name || repo,
      badge: release?.tag_name ? String(release.tag_name).toUpperCase() : "REPO",
      color: "ink",
      fields,
      buttons: [ghNavRow("overview"), controlsRow(relUrl, release ? "View Release" : "Open Repo")],
      footer: `GitHub · ${formatClock(nowMs)}`,
    };
    if (info.description) {
      overviewCard.text = info.description;
    }
    return overviewCard;
  } catch (err) {
    return {
      builtinBot: GITHUB_BOT_ID,
      persistent: true,
      ghRepo: repo,
      ghTab: activeTab,
      ghUpdatedAt: nowMs,
      subtitle: "GITHUB",
      title: `GitHub Unavailable (${repo})`,
      badge: "OFFLINE",
      color: "coral",
      text: `Unavailable (${err?.message || "offline"}).`,
      buttons: [ghNavRow(activeTab), controlsRow()],
      footer: `GitHub · ${formatClock(nowMs)}`,
    };
  }
}

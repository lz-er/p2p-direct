import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GITHUB_SETTINGS,
  DEFAULT_WEATHER_SETTINGS,
  DEFAULT_WIKI_SETTINGS,
  GITHUB_BOT_ID,
  WEATHER_BOT_ID,
  WIKI_BOT_ID,
  clearWebBotCaches,
  describeWmoCode,
  extractWikiBracketQuery,
  fetchGithubCard,
  fetchWeatherCard,
  fetchWikiCard,
  formatTemp,
  parseGithubAction,
  parseWeatherAction,
  parseWikiAction,
  sanitizeGithubRepo,
  sanitizeGithubSettings,
  sanitizeWeatherSettings,
  sanitizeWikiSettings,
} from "../web_bots.js";

describe("web_bots settings & parsers", () => {
  it("defaults all 3 web bots to disabled", () => {
    assert.equal(sanitizeWeatherSettings(null).enabled, false);
    assert.equal(sanitizeWikiSettings(null).enabled, false);
    assert.equal(sanitizeGithubSettings(null).enabled, false);
    assert.equal(DEFAULT_WEATHER_SETTINGS.enabled, false);
    assert.equal(DEFAULT_WIKI_SETTINGS.enabled, false);
    assert.equal(DEFAULT_GITHUB_SETTINGS.enabled, false);
  });

  it("sanitizes GitHub repo slugs and full GitHub URLs safely", () => {
    assert.equal(sanitizeGithubRepo("https://github.com/lz-er/p2p-direct.git"), "lz-er/p2p-direct");
    assert.equal(sanitizeGithubRepo("octocat/hello-world"), "octocat/hello-world");
    assert.equal(sanitizeGithubRepo("not-valid"), "lz-er/p2p-direct");
  });

  it("extracts [[wiki:Topic]] and parses wx/wiki/gh actions", () => {
    assert.equal(extractWikiBracketQuery("See [[wiki:WebRTC]] for details"), "WebRTC");
    assert.equal(extractWikiBracketQuery("Check [[Bash]] card"), null);
    assert.deepEqual(parseWeatherAction("wx:city:2"), { kind: "city", index: 2 });
    assert.deepEqual(parseWeatherAction("wx:unit:f"), { kind: "unit", unit: "f" });
    assert.deepEqual(parseWikiAction("wiki:tab:onthisday"), { kind: "tab", tab: "onthisday" });
    assert.deepEqual(parseGithubAction("gh:tab:commits"), { kind: "tab", tab: "commits" });
    assert.equal(formatTemp(20, "c"), "20°C");
    assert.equal(formatTemp(20, "f"), "68°F");
    assert.equal(describeWmoCode(95), "Thunderstorm");
  });
});

describe("web_bots live card builders (mocked fetch)", () => {
  it("builds Weather card with geocoding + 3-day forecast + unit conversion", async () => {
    clearWebBotCaches();
    const mockFetch = async (url) => {
      if (url.includes("geocoding-api.open-meteo.com")) {
        return {
          ok: true,
          json: async () => ({
            results: [{ name: "Berlin", country_code: "DE", latitude: 52.52, longitude: 13.41 }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          current: { temperature_2m: 10, apparent_temperature: 8, relative_humidity_2m: 72, weather_code: 2, wind_speed_10m: 14 },
          daily: {
            time: ["2026-11-26", "2026-11-27", "2026-11-28"],
            temperature_2m_max: [12, 11, 9],
            temperature_2m_min: [4, 3, 2],
            weather_code: [2, 61, 0],
            precipitation_probability_max: [20, 70, 5],
          },
        }),
      };
    };

    const cardC = await fetchWeatherCard({ enabled: true, cities: "Berlin, Tokyo", unit: "c" }, { fetchImpl: mockFetch });
    assert.equal(cardC.builtinBot, WEATHER_BOT_ID);
    assert.match(cardC.title, /Berlin, DE — 10°C/);
    assert.equal(cardC.badge, "PARTLY CLOUDY");

    const cardF = await fetchWeatherCard({ enabled: true, cities: "Berlin, Tokyo", unit: "f" }, { fetchImpl: mockFetch });
    assert.match(cardF.title, /50°F/);
  });

  it("builds Wikipedia Featured, Lookup, and On This Day cards", async () => {
    const mockFetch = async (url) => {
      if (url.includes("/feed/featured/")) {
        return {
          ok: true,
          json: async () => ({
            tfa: {
              titles: { normalized: "WebRTC" },
              description: "Real-time communication standard",
              extract: "WebRTC enables peer-to-peer audio, video, and data channels in browsers.",
              thumbnail: { source: "https://upload.wikimedia.org/thumb.png" },
              content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/WebRTC" } },
            },
            mostread: { articles: [{ titles: { normalized: "Rust" }, views: 54321 }] },
          }),
        };
      }
      if (url.includes("/page/summary/Slay_the_Spire")) {
        return {
          ok: true,
          json: async () => ({
            titles: { normalized: "Slay the Spire" },
            description: "Roguelike deck-building game",
            extract: "Slay the Spire is developed by Mega Crit.",
            content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Slay_the_Spire" } },
          }),
        };
      }
      if (url.includes("/feed/onthisday/")) {
        return {
          ok: true,
          json: async () => ({
            selected: [{ year: 1922, text: "Howard Carter enters Tutankhamun's tomb." }],
          }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const feat = await fetchWikiCard({ tab: "featured", fetchImpl: mockFetch });
    assert.equal(feat.builtinBot, WIKI_BOT_ID);
    assert.equal(feat.title, "WebRTC");
    assert.equal(feat.image.url, "https://upload.wikimedia.org/thumb.png");

    const lookup = await fetchWikiCard({ tab: "lookup", query: "Slay the Spire", fetchImpl: mockFetch });
    assert.equal(lookup.badge, "LOOKUP");
    assert.equal(lookup.title, "Slay the Spire");

    const otd = await fetchWikiCard({ tab: "onthisday", fetchImpl: mockFetch });
    assert.equal(otd.badge, "HISTORY");
    assert.match(otd.fields[0].value, /Howard Carter/);
  });

  it("builds GitHub Overview, Commits, and Issues cards", async () => {
    const mockFetch = async (url) => {
      if (url.endsWith("/releases/latest")) {
        return { ok: true, json: async () => ({ tag_name: "v1.4.0", published_at: "2026-11-20T00:00:00Z", html_url: "https://github.com/lz-er/p2p-direct/releases/v1.4.0" }) };
      }
      if (url.includes("/commits")) {
        return {
          ok: true,
          json: async () => [{ sha: "abcdef123456", commit: { message: "Add StS2 bot\nbody", author: { name: "dev", date: "2026-11-26T10:00:00Z" } } }],
        };
      }
      if (url.includes("/issues")) {
        return {
          ok: true,
          json: async () => [{ number: 42, title: "Add Steam companion", user: { login: "alice" }, created_at: "2026-11-25T10:00:00Z" }],
        };
      }
      return {
        ok: true,
        json: async () => ({
          full_name: "lz-er/p2p-direct",
          description: "Zero-storage E2EE voice & chat",
          stargazers_count: 128,
          forks_count: 14,
          open_issues_count: 3,
          default_branch: "main",
          pushed_at: "2026-11-26T18:00:00Z",
          language: "Rust",
          html_url: "https://github.com/lz-er/p2p-direct",
        }),
      };
    };

    const ov = await fetchGithubCard({ enabled: true, repo: "lz-er/p2p-direct" }, { tab: "overview", fetchImpl: mockFetch });
    assert.equal(ov.builtinBot, GITHUB_BOT_ID);
    assert.equal(ov.badge, "V1.4.0");
    assert.match(ov.fields[0].value, /128/);

    const commits = await fetchGithubCard({ enabled: true, repo: "lz-er/p2p-direct" }, { tab: "commits", fetchImpl: mockFetch });
    assert.match(commits.fields[0].label, /abcdef1/);

    const issues = await fetchGithubCard({ enabled: true, repo: "lz-er/p2p-direct" }, { tab: "issues", fetchImpl: mockFetch });
    assert.match(issues.fields[0].label, /Issue #42/);
  });
});

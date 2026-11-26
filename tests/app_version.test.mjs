import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  APP_CACHE_NAME,
  APP_CACHE_PREFIX,
  APP_VERSION,
  extractShellCacheVersions,
  formatAppRuntimeSummary,
  parseAppVersionNumber,
  resolveSwVersionState,
} from "../app.js";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function readRepoFile(relPath) {
  return readFileSync(join(ROOT_DIR, relPath), "utf8");
}

test("APP_VERSION in app.js stays strictly in sync with sw.js CACHE_NAME", () => {
  assert.match(APP_VERSION, /^v\d+(?:\.\d+)*$/, "APP_VERSION should use v<N> format");
  assert.equal(APP_CACHE_NAME, `${APP_CACHE_PREFIX}${APP_VERSION}`);

  const swSource = readRepoFile("sw.js");
  const match = swSource.match(/const\s+CACHE_NAME\s*=\s*"([^"]+)"\s*;/);
  assert.ok(match, "sw.js must define const CACHE_NAME = \"...\"");
  assert.equal(
    match[1],
    APP_CACHE_NAME,
    `sw.js CACHE_NAME (${match[1]}) must match app.js APP_CACHE_NAME (${APP_CACHE_NAME})`
  );

  // sw.js must expose its version cleanly over postMessage for live mismatch/update checks
  assert.match(swSource, /p2p-get-version/, "sw.js should handle p2p-get-version message queries");
  assert.match(swSource, /p2p-sw-version/, "sw.js should reply with p2p-sw-version metadata");
});

test("index.html exposes Advanced-only version DOM hooks synced with APP_VERSION", () => {
  const html = readRepoFile("index.html");

  // Topbar version chip must be strictly advanced-only and contain APP_VERSION
  const topbarChipRe =
    /<button\b[^>]*class="[^"]*\badvanced-only\b[^"]*"[^>]*id="app-version-chip"[^>]*>[\s\S]*?<strong\s+id="app-version-display">([^<]+)<\/strong>[\s\S]*?<\/button>/;
  const topbarMatch = html.match(topbarChipRe);
  assert.ok(topbarMatch, "index.html must include #app-version-chip (.advanced-only) with #app-version-display");
  assert.equal(
    topbarMatch[1].trim(),
    APP_VERSION,
    `index.html #app-version-display (${topbarMatch[1].trim()}) must match APP_VERSION (${APP_VERSION})`
  );

  // Advanced rail build footer must be strictly advanced-only and contain APP_VERSION + SW/runtime hooks
  const footerRe =
    /<footer\b[^>]*id="adv-version-footer"[^>]*class="[^"]*\badvanced-only\b[^"]*"[^>]*>([\s\S]*?)<\/footer>/;
  const footerMatch = html.match(footerRe);
  assert.ok(footerMatch, "index.html must include #adv-version-footer (.advanced-only)");

  const footerHtml = footerMatch[1];
  const footVerMatch = footerHtml.match(/id="adv-version-number">([^<]+)</);
  assert.ok(footVerMatch, "#adv-version-footer must include #adv-version-number");
  assert.equal(
    footVerMatch[1].trim(),
    APP_VERSION,
    `index.html #adv-version-number (${footVerMatch[1].trim()}) must match APP_VERSION (${APP_VERSION})`
  );
  assert.match(footerHtml, /id="adv-version-dot"/, "footer must include status dot hook");
  assert.match(footerHtml, /id="adv-version-sw"/, "footer must include SW status hook");
  assert.match(footerHtml, /id="adv-version-runtime"/, "footer must include runtime summary hook");
  assert.match(footerHtml, /id="btn-version-action"/, "footer must include check/reload action button");

  // Confirm normal mode hides .advanced-only in styles.css
  const css = readRepoFile("styles.css");
  assert.match(
    css,
    /html\[data-advanced="false"\]\s+\.advanced-only\s*\{\s*display:\s*none\s*!important;/,
    "styles.css must keep .advanced-only hidden in normal mode"
  );
  assert.match(css, /\.adv-version-footer\s*\{/, "styles.css must define .adv-version-footer styles");
  assert.match(css, /\.stat-chip\.chip-version\s*\{/, "styles.css must define .stat-chip.chip-version styles");
});

test("parseAppVersionNumber and extractShellCacheVersions parse & sort version strings cleanly", () => {
  assert.equal(parseAppVersionNumber("v24"), 24_000_000);
  assert.equal(parseAppVersionNumber("v25"), 25_000_000);
  assert.equal(parseAppVersionNumber("v24.1.2"), 24_001_002);
  assert.equal(parseAppVersionNumber("invalid"), null);
  assert.equal(parseAppVersionNumber(null), null);

  const extracted = extractShellCacheVersions([
    "unrelated-cache",
    "p2p-direct-shell-v9",
    "p2p-direct-shell-v24",
    "p2p-direct-shell-v23",
    "p2p-direct-shell-v24",
    "p2p-direct-shell-bad",
  ]);
  assert.deepEqual(extracted, ["v24", "v23", "v9"]);
});

test("resolveSwVersionState handles synced, update-ready, stale mismatch, installing, and SW-off states", () => {
  // 1. SW unsupported / direct load
  const off = resolveSwVersionState({ appVersion: "v24", supported: false });
  assert.equal(off.state, "unavailable");
  assert.equal(off.badge, "SW off");
  assert.equal(off.needsReload, false);
  assert.equal(off.severity, "muted");

  // 2. Synced active controller
  const synced = resolveSwVersionState({
    appVersion: "v24",
    supported: true,
    hasController: true,
    controllerVersion: "v24",
    cacheVersions: ["v24"],
  });
  assert.equal(synced.state, "synced");
  assert.equal(synced.badge, "SW v24");
  assert.equal(synced.needsReload, false);
  assert.equal(synced.severity, "ok");

  // 3. Waiting SW update ready (with & without explicit version)
  const waitingNamed = resolveSwVersionState({
    appVersion: "v24",
    supported: true,
    hasController: true,
    controllerVersion: "v24",
    hasWaiting: true,
    waitingVersion: "v25",
  });
  assert.equal(waitingNamed.state, "update-ready");
  assert.equal(waitingNamed.badge, "Update v25");
  assert.equal(waitingNamed.needsReload, true);
  assert.equal(waitingNamed.severity, "warn");

  const waitingAnon = resolveSwVersionState({
    appVersion: "v24",
    supported: true,
    hasController: true,
    hasWaiting: true,
  });
  assert.equal(waitingAnon.state, "update-ready");
  assert.equal(waitingAnon.badge, "Update ready");
  assert.equal(waitingAnon.needsReload, true);

  // 4. Newer SW activated & claimed page via skipWaiting while old tab stays open
  const newerCtrl = resolveSwVersionState({
    appVersion: "v24",
    supported: true,
    hasController: true,
    controllerVersion: "v25",
    cacheVersions: ["v25"],
  });
  assert.equal(newerCtrl.state, "update-ready");
  assert.equal(newerCtrl.badge, "Update v25");
  assert.equal(newerCtrl.needsReload, true);
  assert.equal(newerCtrl.severity, "warn");

  // 5. Stale SW controlling newer page
  const staleCtrl = resolveSwVersionState({
    appVersion: "v24",
    supported: true,
    hasController: true,
    controllerVersion: "v23",
  });
  assert.equal(staleCtrl.state, "mismatch");
  assert.equal(staleCtrl.badge, "SW v23");
  assert.equal(staleCtrl.needsReload, true);
  assert.equal(staleCtrl.severity, "warn");

  // 6. Legacy pre-v24 SW (no message handler) detected via Cache API fallback
  const legacyCache = resolveSwVersionState({
    appVersion: "v24",
    supported: true,
    hasController: true,
    controllerVersion: null,
    cacheVersions: ["v23"],
  });
  assert.equal(legacyCache.state, "mismatch");
  assert.equal(legacyCache.badge, "SW v23");
  assert.equal(legacyCache.needsReload, true);
  assert.equal(legacyCache.severity, "warn");

  // 7. Installing new SW suppresses transient mismatch warning during upgrade
  const installing = resolveSwVersionState({
    appVersion: "v24",
    supported: true,
    hasController: true,
    controllerVersion: null,
    hasInstalling: true,
    cacheVersions: ["v23"],
  });
  assert.equal(installing.state, "installing");
  assert.equal(installing.badge, "SW updating…");
  assert.equal(installing.needsReload, false);
  assert.equal(installing.severity, "muted");

  // 8. Newer cache already populated without message reply
  const newerCache = resolveSwVersionState({
    appVersion: "v24",
    supported: true,
    hasController: true,
    controllerVersion: null,
    cacheVersions: ["v25", "v24"],
  });
  assert.equal(newerCache.state, "update-ready");
  assert.equal(newerCache.badge, "Update v25");
  assert.equal(newerCache.needsReload, true);

  // 9. First visit before claim
  const firstVisit = resolveSwVersionState({
    appVersion: "v24",
    supported: true,
    hasController: false,
    cacheVersions: [],
  });
  assert.equal(firstVisit.state, "registering");
  assert.equal(firstVisit.badge, "SW ready");
  assert.equal(firstVisit.needsReload, false);
});

test("formatAppRuntimeSummary produces concise monospace build tags", () => {
  assert.equal(formatAppRuntimeSummary({ wasmReady: false }), "Init");
  assert.equal(formatAppRuntimeSummary({ wasmReady: true, opusSupported: true }), "WASM · Opus 48k");
  assert.equal(
    formatAppRuntimeSummary({ wasmReady: true, opusSupported: false, isStandalone: true }),
    "WASM · ADPCM · PWA"
  );
});

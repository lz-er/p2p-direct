/**
 * Service Worker shell-asset completeness check.
 *
 * Dynamically parses local relative ES module imports, HTML <script>/<link> tags,
 * Web App Manifest icons, CSS font/asset `url(...)` references, and `.wasm` assets
 * referenced by `index.html`, `styles.css`, `app.js`, `watch_together.js`, `wasm_client.js`,
 * `mqtt_relay.js`, `storage.js` (and `media_sync_controller.js` when present), then asserts:
 *   1. Every discovered local runtime shell asset exists on disk.
 *   2. Every discovered local runtime shell asset is listed in `sw.js` `SHELL_ASSETS`.
 *   3. Every entry in `sw.js` `SHELL_ASSETS` exists on disk with zero duplicates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoText(relPath) {
  return readFileSync(resolve(ROOT_DIR, relPath), "utf8");
}

function isLocalAssetRef(raw) {
  if (!raw || typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed)) return false;
  return true;
}

function normalizeShellAsset(fromFilePosix, rawRef) {
  const clean = rawRef.trim().split(/[?#]/)[0];
  if (!clean) return null;
  const baseDir = posix.dirname(fromFilePosix);
  const joined = clean.startsWith("/") ? clean.slice(1) : posix.join(baseDir, clean);
  const norm = posix.normalize(joined).replace(/^\.\//, "");
  if (!norm || norm === ".") return "./";
  return `./${norm}`;
}

function stripJsComments(source) {
  // Remove block comments and line comments outside string literals
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function extractHtmlLocalAssets(htmlText, fromFile = "index.html") {
  const found = new Set();
  const attrRe = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = attrRe.exec(htmlText)) !== null) {
    const raw = m[1];
    if (!isLocalAssetRef(raw)) continue;
    const norm = normalizeShellAsset(fromFile, raw);
    if (norm) found.add(norm);
  }
  return found;
}

function extractCssLocalAssets(cssText, fromFile = "styles.css") {
  const found = new Set();
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let m;
  while ((m = urlRe.exec(stripped)) !== null) {
    const raw = m[1];
    if (!isLocalAssetRef(raw)) continue;
    const norm = normalizeShellAsset(fromFile, raw);
    if (norm) found.add(norm);
  }
  return found;
}

function extractManifestLocalAssets(manifestText, fromFile = "manifest.webmanifest") {
  const found = new Set();
  const data = JSON.parse(manifestText);
  if (Array.isArray(data.icons)) {
    for (const icon of data.icons) {
      if (isLocalAssetRef(icon?.src)) {
        const norm = normalizeShellAsset(fromFile, icon.src);
        if (norm) found.add(norm);
      }
    }
  }
  return found;
}

function extractJsLocalAssets(jsText, fromFile) {
  const found = new Set();
  const code = stripJsComments(jsText);

  // Static ES module imports/re-exports: `import ... from "./..."`, `export ... from "./..."`, `import "./..."`
  const staticImportRe =
    /(?:^|[\s;{}()])(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.\.?\/[^"']+)["']/gm;
  let m;
  while ((m = staticImportRe.exec(code)) !== null) {
    const norm = normalizeShellAsset(fromFile, m[1]);
    if (norm) found.add(norm);
  }

  // Dynamic imports: `import("./...")`
  const dynamicImportRe = /\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;
  while ((m = dynamicImportRe.exec(code)) !== null) {
    const norm = normalizeShellAsset(fromFile, m[1]);
    if (norm) found.add(norm);
  }

  // Local .wasm asset strings (e.g. "./p2p_mesh.wasm")
  const wasmRe = /["'](\.\.?\/[^"'\s]+\.wasm(?:\?[^"']*)?)["']/g;
  while ((m = wasmRe.exec(code)) !== null) {
    const norm = normalizeShellAsset(fromFile, m[1]);
    if (norm) found.add(norm);
  }

  return found;
}

function parseSwShellAssets(swSource) {
  const cacheMatch = swSource.match(/const\s+CACHE_NAME\s*=\s*"([^"]+)"\s*;/);
  assert.ok(cacheMatch, "sw.js must define const CACHE_NAME = \"...\"");
  assert.match(
    cacheMatch[1],
    /^p2p-direct-shell-v\d+(?:\.\d+)*$/,
    `sw.js CACHE_NAME (${cacheMatch[1]}) must follow p2p-direct-shell-v<N> format`
  );

  const listMatch = swSource.match(/const\s+SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]\s*;/);
  assert.ok(listMatch, "sw.js must define const SHELL_ASSETS = [ ... ];");

  const entries = [];
  const strRe = /["']([^"']+)["']/g;
  let m;
  while ((m = strRe.exec(listMatch[1])) !== null) {
    entries.push(m[1]);
  }
  return {
    cacheName: cacheMatch[1],
    entries,
  };
}

test("sw.js SHELL_ASSETS has no duplicates and every listed asset exists on disk", () => {
  const swSource = readRepoText("sw.js");
  const { entries } = parseSwShellAssets(swSource);

  assert.ok(entries.length > 0, "SHELL_ASSETS must not be empty");

  const seen = new Set();
  for (const asset of entries) {
    assert.ok(!seen.has(asset), `Duplicate entry in sw.js SHELL_ASSETS: ${asset}`);
    seen.add(asset);

    if (asset === "./") {
      assert.ok(existsSync(resolve(ROOT_DIR, "index.html")), "Root './' requires index.html on disk");
      continue;
    }
    const rel = asset.replace(/^\.\//, "");
    const abs = resolve(ROOT_DIR, rel);
    assert.ok(existsSync(abs), `sw.js SHELL_ASSETS entry does not exist on disk: ${asset}`);
    assert.ok(statSync(abs).isFile(), `sw.js SHELL_ASSETS entry is not a regular file: ${asset}`);
  }
});

test("Every local runtime shell asset referenced by index.html, CSS, manifest, and JS modules is in sw.js SHELL_ASSETS", () => {
  const swSource = readRepoText("sw.js");
  const { entries } = parseSwShellAssets(swSource);
  const swSet = new Set(entries);

  const discovered = new Set(["./", "./index.html"]);
  const visitedJs = new Set();
  const jsQueue = [];

  const enqueueJs = (asset) => {
    if (!asset || asset === "./sw.js") return;
    if (!/\.(?:m?js)$/i.test(asset)) return;
    if (visitedJs.has(asset)) return;
    visitedJs.add(asset);
    jsQueue.push(asset);
  };

  // 1. Parse index.html <script> & <link> local assets
  const htmlAssets = extractHtmlLocalAssets(readRepoText("index.html"), "index.html");
  for (const asset of htmlAssets) {
    discovered.add(asset);
    enqueueJs(asset);
  }

  // 2. Also explicitly include core root runtime modules (plus media_sync_controller.js if present)
  const coreModules = [
    "./app.js",
    "./watch_together.js",
    "./wasm_client.js",
    "./mqtt_relay.js",
    "./storage.js",
    "./media_sync_controller.js",
  ];
  for (const mod of coreModules) {
    const abs = resolve(ROOT_DIR, mod.replace(/^\.\//, ""));
    if (existsSync(abs)) {
      discovered.add(mod);
      enqueueJs(mod);
    }
  }

  // 3. Parse local CSS stylesheets referenced by index.html for font/media url(...) assets
  for (const asset of Array.from(discovered)) {
    if (/\.css$/i.test(asset)) {
      const rel = asset.replace(/^\.\//, "");
      if (existsSync(resolve(ROOT_DIR, rel))) {
        for (const cssAsset of extractCssLocalAssets(readRepoText(rel), rel)) {
          discovered.add(cssAsset);
        }
      }
    }
  }

  // 4. Parse web app manifest icons referenced by index.html
  for (const asset of Array.from(discovered)) {
    if (/\.webmanifest$/i.test(asset)) {
      const rel = asset.replace(/^\.\//, "");
      if (existsSync(resolve(ROOT_DIR, rel))) {
        for (const iconAsset of extractManifestLocalAssets(readRepoText(rel), rel)) {
          discovered.add(iconAsset);
        }
      }
    }
  }

  // 5. Recursively walk all local ES module imports and .wasm references
  while (jsQueue.length > 0) {
    const modAsset = jsQueue.shift();
    const rel = modAsset.replace(/^\.\//, "");
    const abs = resolve(ROOT_DIR, rel);
    assert.ok(existsSync(abs), `Referenced local runtime JS module missing on disk: ${modAsset}`);
    const jsRefs = extractJsLocalAssets(readRepoText(rel), rel);
    for (const ref of jsRefs) {
      if (ref === "./sw.js") continue; // Service Worker itself must not be precached
      discovered.add(ref);
      enqueueJs(ref);
    }
  }

  // Verify every discovered asset exists on disk and is cached by sw.js
  const missingFromDisk = [];
  const missingFromSw = [];
  for (const asset of Array.from(discovered).sort()) {
    if (asset !== "./") {
      const abs = resolve(ROOT_DIR, asset.replace(/^\.\//, ""));
      if (!existsSync(abs)) {
        missingFromDisk.push(asset);
      }
    }
    if (!swSet.has(asset)) {
      missingFromSw.push(asset);
    }
  }

  assert.deepEqual(
    missingFromDisk,
    [],
    `Discovered runtime shell assets missing from disk: ${missingFromDisk.join(", ")}`
  );
  assert.deepEqual(
    missingFromSw,
    [],
    `Runtime shell assets missing from sw.js SHELL_ASSETS: ${missingFromSw.join(", ")}`
  );
});

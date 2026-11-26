/**
 * Zero-dependency loopback HTTP static asset server for Chromium E2E & layout tests.
 *
 * Serves the repository root with strict MIME types, `Cache-Control: no-store`, and an
 * in-memory Service Worker version override hook so E2E tests can exercise live SW updates
 * without ever modifying files on disk.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
});

export function getMimeType(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

function normalizeVersionTag(version) {
  const s = String(version || "").trim();
  if (!s) return null;
  return /^v\d/i.test(s) ? s : `v${s}`;
}

/**
 * Starts a loopback static server bound to `127.0.0.1:0`.
 */
export async function startStaticServer({ rootDir = DEFAULT_ROOT, host = "127.0.0.1", port = 0 } = {}) {
  const absRoot = resolve(rootDir);
  let swVersionOverride = null;
  let syncAppVersionWithSw = false;

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("Method Not Allowed\n");
        return;
      }

      const rawUrl = req.url || "/";
      const pathname = decodeURIComponent(rawUrl.split("?")[0] || "/");
      const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const safeRel = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
      const absPath = resolve(absRoot, safeRel);

      if (absPath !== absRoot && !absPath.startsWith(absRoot + "/") && !absPath.startsWith(absRoot + "\\")) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("Forbidden\n");
        return;
      }

      let body = await readFile(absPath);
      const mime = getMimeType(absPath);
      const headers = {
        "Content-Type": mime,
        "Cache-Control": "no-store, max-age=0",
      };

      if (safeRel === "sw.js") {
        headers["Service-Worker-Allowed"] = "/";
        if (swVersionOverride) {
          const text = body.toString("utf8").replace(
            /const\s+CACHE_NAME\s*=\s*"p2p-direct-shell-[^"]+"\s*;/,
            `const CACHE_NAME = "p2p-direct-shell-${swVersionOverride}";`
          );
          body = Buffer.from(text, "utf8");
        }
      } else if (swVersionOverride && syncAppVersionWithSw && safeRel === "app.js") {
        const text = body.toString("utf8").replace(
          /export\s+const\s+APP_VERSION\s*=\s*"v\d+(?:\.\d+)*"\s*;/,
          `export const APP_VERSION = "${swVersionOverride}";`
        );
        body = Buffer.from(text, "utf8");
      } else if (swVersionOverride && syncAppVersionWithSw && safeRel === "index.html") {
        const text = body
          .toString("utf8")
          .replace(/(id="app-version-display">)v\d+(?:\.\d+)*(<)/, `$1${swVersionOverride}$2`)
          .replace(/(id="adv-version-number">)v\d+(?:\.\d+)*(<)/, `$1${swVersionOverride}$2`);
        body = Buffer.from(text, "utf8");
      }

      headers["Content-Length"] = String(body.byteLength);
      res.writeHead(200, headers);
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(body);
      }
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "EISDIR")) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("Not Found\n");
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`Internal Server Error: ${err?.message || err}\n`);
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const origin = `http://${host}:${actualPort}`;

  return {
    host,
    port: actualPort,
    origin,
    url: `${origin}/`,
    rootDir: absRoot,
    /**
     * Dynamically rewrites `CACHE_NAME` in served `sw.js` (e.g. `v24` -> `v25`) without touching disk.
     * Pass `{ syncAppVersion: true }` to also serve the matching `APP_VERSION` in `app.js` / `index.html`
     * so a subsequent page reload settles cleanly into synced state on the new version.
     */
    setSwVersionOverride(nextVersion, { syncAppVersion = false } = {}) {
      swVersionOverride = normalizeVersionTag(nextVersion);
      syncAppVersionWithSw = Boolean(syncAppVersion);
    },
    clearSwVersionOverride() {
      swVersionOverride = null;
      syncAppVersionWithSw = false;
    },
    getSwVersionOverride() {
      return swVersionOverride;
    },
    async close() {
      await new Promise((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
    },
  };
}

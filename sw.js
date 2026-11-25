// Static App-Shell Service Worker for Direct Voice & Chat PWA.
// Caches ONLY immutable public static shell assets (HTML, CSS, JS, WASM, fonts, icons).
// Never caches chat messages, room secrets, URL fragments, or cross-origin traffic.

const CACHE_NAME = "p2p-direct-shell-v13";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./watch_together.js",
  "./storage.js",
  "./wasm_client.js",
  "./mqtt_relay.js",
  "./p2p_mesh.wasm",
  "./favicon.svg",
  "./manifest.webmanifest",
  "./fonts/KodeMono-Bold.woff2",
  "./fonts/Sora-ExtraBold.woff2",
  "./fonts/Sora-Light.woff2",
  "./fonts/Sora-Regular.woff2",
  "./fonts/Sora-SemiBold.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Strip query/hash so room metadata is never stored in the Cache API.
  const cacheKey = new Request(url.origin + url.pathname, { method: "GET" });

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.match("./index.html").then((hit) => hit || cache.match("./")))
        )
    );
    return;
  }

  // Network-first with static cache fallback so new deploys take effect immediately.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
        }
        return res;
      })
      .catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(cacheKey)))
  );
});

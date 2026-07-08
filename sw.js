// SkyRaven service worker — offline app shell + catalog cache.
// Paths are relative to the SW's own location, so this works under a project-site
// subpath (e.g. /SkyRaven/) without change. Bump CACHE to invalidate on deploy —
// app.js also fetches this file and parses CACHE to show the version in Settings,
// so this is the single place to update.

const CACHE = "skyraven-v2026.07.08-5531a53";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./js/app.js",
  "./js/astro.js",
  "./js/projection.js",
  "./js/catalog.js",
  "./js/iss.js",
  "./js/vendor/satellite.min.js",
  "./data/catalog.json",
  "./data/iss-tle.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// NETWORK-FIRST for same-origin GETs: always try the network (so a deploy is
// picked up immediately and the SW can never get stuck serving a stale shell),
// refresh the cache with what we get, and fall back to the cache only when the
// network fails (offline). Cross-origin requests (the ISS TLE API) are left
// entirely to the browser — the SW never touches them.
//
// Cache-first was the previous strategy and is what pinned browsers to a stale
// cached copy across deploys; network-first + proper no-cache headers fixes that.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(
        (hit) => hit || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined),
      )),
  );
});

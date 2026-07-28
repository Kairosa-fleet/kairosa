/*
 * Kairosa service worker — the offline-first layer.
 *
 * This is what makes the dashboard behave like Google Docs or Spotify offline:
 * the app shell and build assets are cached so the app loads instantly (and
 * even with no connection), and the last data the backend returned is kept so
 * lists stay readable when the network drops. Nothing here touches writes —
 * every non-GET request goes straight to the network, because replaying a
 * create/update blindly against a server that assigns LR numbers and validates
 * uploads is how you corrupt data. Draft persistence (localStorage) covers the
 * "don't lose my typed work" half; this covers the "app still loads / data
 * still shows" half.
 *
 * Caching strategy, by request kind:
 *   - build assets (/_next/static, fonts, images) -> stale-while-revalidate
 *   - page navigations                            -> network-first, then the
 *                                                    cached route, then /offline
 *   - backend JSON (cross-origin GET)             -> network-first, then cache
 *   - other same-origin GET                       -> network-first, then cache
 */

const VERSION = "kairosa-v1";
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;
const DATA = `${VERSION}-data`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PAGES);
      try {
        await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      } catch {
        /* offline page not reachable at install — page handler still degrades */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from an older worker version so an update never serves
      // stale build assets.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Lets the page tell a freshly-installed worker to take over immediately.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Never intercept writes — bookings, uploads, edits always hit the network.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin GETs are the backend API (and map tiles). Cache only JSON so
  // the last-loaded lists survive offline without filling storage with tiles.
  if (url.origin !== self.location.origin) {
    event.respondWith(networkFirst(req, DATA, true));
    return;
  }

  // Whole-page loads: try the network, fall back to the cached route, then to
  // the offline page.
  if (req.mode === "navigate") {
    event.respondWith(pageHandler(req));
    return;
  }

  // Immutable, content-hashed build assets: serve fast from cache, refresh in
  // the background.
  if (
    url.pathname.startsWith("/_next/static/") ||
    /\.(?:woff2?|ttf|otf|png|jpe?g|svg|webp|gif|ico|css|js)$/.test(url.pathname)
  ) {
    event.respondWith(staleWhileRevalidate(req, STATIC));
    return;
  }

  // Anything else same-origin (e.g. /_next/data payloads).
  event.respondWith(networkFirst(req, DATA, false));
});

async function networkFirst(req, cacheName, jsonOnly) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    const type = res.headers.get("content-type") || "";
    if (res.ok && (!jsonOnly || type.includes("application/json"))) {
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

async function pageHandler(req) {
  const cache = await caches.open(PAGES);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    const offline = await cache.match(OFFLINE_URL);
    return (
      offline ||
      new Response("You are offline.", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      })
    );
  }
}

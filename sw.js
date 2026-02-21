const CACHE = "isivolt-v3-cache-1";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./db.js", "./manifest.json"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.map(k => k !== CACHE ? caches.delete(k) : null)))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.hostname !== self.location.hostname && !url.pathname.startsWith("./")) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const cached = await c.match(e.request);
    const fresh = fetch(e.request).then(r => { if (r && r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return cached || await fresh;
  }));
});

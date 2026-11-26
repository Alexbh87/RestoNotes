// Service worker RestoNotes : l'application et ses données (IndexedDB) restent utilisables hors-ligne.
// Pour forcer une mise à jour du cache, incrémente VERSION.
const VERSION = "restonotes-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Jamais de cache pour les fonctions (clé Maps, IA) ni pour les services tiers (cartes, Nominatim, Overpass…).
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/.netlify/functions/")) {
    // Seules les photos de façade (proxy Places) sont mises en cache pour l'affichage hors-ligne.
    if (!url.search.startsWith("?photo=")) return;
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Pages : réseau d'abord (toujours la dernière version), cache en secours hors-ligne.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put("/index.html", copy)); return res; })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Fichiers statiques : cache d'abord, rafraîchi en arrière-plan.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});

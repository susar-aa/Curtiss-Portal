const CACHE_NAME = "curtiss-picking-v1";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// Install: Cache static assets
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[Service Worker] Caching app shell");
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate: Clean up old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log("[Service Worker] Removing old cache", key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: Serve from cache or fallback to network
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Exclude API requests from cache-first strategy
  if (url.pathname.includes("/api_") || url.pathname.includes("/picking/")) {
    e.respondWith(
      fetch(e.request).catch(() => {
        // Fallback for when API fails (will be caught by application logic)
        return new Response(JSON.stringify({ success: false, offline: true, error: "Currently offline" }), {
          headers: { "Content-Type": "application/json" }
        });
      })
    );
  } else {
    // Cache-first strategy for static assets
    e.respondWith(
      caches.match(e.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(e.request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== "basic") {
            return networkResponse;
          }
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
          return networkResponse;
        });
      })
    );
  }
});

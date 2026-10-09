// Offline support: keeps the app shell on the phone so it opens without a connection.
const CACHE = 'styk-app-0.2.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/ble.js', 'js/demo.js', 'js/format.js', 'js/icons.js', 'js/map.js', 'js/qr.js', 'js/sound.js', 'js/store.js',
  'icons/favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'img/styk-tag-light.webp', 'img/styk-tag-dark.webp',
  'lib/leaflet/leaflet.js', 'lib/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('styk-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // map tiles and fonts go straight to the network

  if (req.mode === 'navigate') {
    // Pages: try the network for the newest version, fall back to the saved copy.
    e.respondWith(fetch(req).catch(() => caches.match('index.html')));
    return;
  }
  // Files: answer from the saved copy at once and refresh it in the background.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const w = wins.find((c) => c.url.startsWith(self.registration.scope));
      if (w) { w.navigate(target); return w.focus(); }
      return self.clients.openWindow(target);
    }),
  );
});

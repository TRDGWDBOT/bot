// Service Worker — keeps PWA installable. No cache to avoid stale data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // No-op — always go to network

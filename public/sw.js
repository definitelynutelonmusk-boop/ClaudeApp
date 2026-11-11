// Lets the app be installed on a phone's home screen. Everything still comes
// straight from your computer: nothing is cached, so you always see the latest pictures.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

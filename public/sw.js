/* Service worker: shows order notifications even when the app is closed (Web Push). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'أطلب أبيس', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'أطلب أبيس';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || 'otlob',
    renotify: true,                          // ring again even if a notification with the same tag is already showing
    requireInteraction: data.requireInteraction !== false, // stays on screen until the user opens or dismisses it
    vibrate: [300, 150, 300, 150, 300, 150, 300],
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});

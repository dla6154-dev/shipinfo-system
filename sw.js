const CACHE_NAME = 'shipinfo-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('push', (e) => {
  if (!e.data) return;
  const data = e.data.json();
  const options = {
    body: data.body || '',
    icon: '/shipinfo-system/icon-192.png',
    badge: '/shipinfo-system/icon-96.png',
    tag: data.tag || 'shipinfo-warning',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/shipinfo-system/' },
  };
  e.waitUntil(self.registration.showNotification(data.title || '진도 운항관리', options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/shipinfo-system/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('shipinfo-system') && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});

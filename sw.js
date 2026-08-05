'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload = { title: 'Vixcord', body: 'You have a new notification.', url: './index.html' };
  try { payload = { ...payload, ...event.data.json() }; } catch {}
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const visible = clients.filter(client => client.visibilityState === 'visible');
    if (visible.length) {
      visible.forEach(client => client.postMessage({ type: 'vixcord-push', title: payload.title, body: payload.body }));
      return;
    }
    return self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag || `vixcord-${Date.now()}`,
      renotify: false,
      data: { url: payload.url || './index.html' }
    });
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './index.html';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => 'focus' in client);
    return existing ? existing.focus() : self.clients.openWindow(targetUrl);
  }));
});

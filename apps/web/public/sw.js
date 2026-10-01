function sameOriginPath(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

self.addEventListener('push', (event) => {
  let payload = { title: 'EveOps', body: 'You have an update', url: '/' };
  try {
    payload = { ...payload, ...(event.data ? event.data.json() : {}) };
  } catch {
    payload.body = 'You have an update';
  }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    data: { url: sameOriginPath(payload.url) },
    tag: payload.tag || 'eveops',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = sameOriginPath(event.notification.data?.url);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (client.url.includes(url) && 'focus' in client) return client.focus();
    }
    return self.clients.openWindow(url);
  }));
});

function sameOriginPath(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

function textField(value, fallback, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = textField(data.title, 'EveOps', 40);
  const body = textField(data.body, 'You have an update', 180);
  const tag = textField(data.tag, 'eveops', 80);
  const url = sameOriginPath(data.url);
  event.waitUntil(self.registration.showNotification(title, {
    body,
    data: { url },
    tag,
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

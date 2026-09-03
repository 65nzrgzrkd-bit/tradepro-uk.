self.addEventListener('install', event => self.skipWaiting());

self.addEventListener('activate', event => event.waitUntil((async () => {

  for (const key of await caches.keys()) await caches.delete(key);

  await self.registration.unregister();

  const windows = await self.clients.matchAll({ type: 'window' });

  for (const client of windows) client.navigate(client.url);

})()));

self.addEventListener('fetch', () => {});

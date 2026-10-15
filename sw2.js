// sw2.js — Service Worker passthrough del port de GTA V
// No cachea, solo existe para que register() no falle.
// Todo el trabajo lo hace el Worker de Cloudflare delante del dominio.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  // No interceptamos nada: dejamos que el navegador (y el Worker de CF) hagan su trabajo.
  // Simplemente existimos para que el registro del SW sea válido.
});

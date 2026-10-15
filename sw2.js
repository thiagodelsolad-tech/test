// sw2.js — Service Worker para el port de GTA V
// Intercepta las peticiones de assets y las deja pasar al Worker de Cloudflare.

const PROXY_PREFIXES = [
  '/b/',
  '/game/',
  '/data/',
  '/log',
  '/loader.js',
  '/prejs.js',
  '/wgpu_worker.js',
  '/io_worker.js',
  '/audio-worklet.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Solo interceptamos rutas del juego
  const needsProxy = PROXY_PREFIXES.some(p => url.pathname.startsWith(p));
  if (!needsProxy) return; // Dejar pasar al navegador normalmente

  // Dejamos que el Worker de Cloudflare haga su trabajo.
  // El fetch normal ya pasa por el Worker porque está delante del dominio.
  // No hacemos nada especial: el Worker añade CORS/COOP/COEP.
  event.respondWith(fetch(event.request));
});

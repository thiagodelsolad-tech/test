// ==========================================
// CONTROLADOR DE RED UNIFICADO (CLOUDFLARE R2)
// ==========================================
const CACHE_NAME = 'playgta5-vfs-cache-v1';

// URL Pública de tu contenedor real de Cloudflare R2
const CLOUDFLARE_R2_URL = 'https://r2.dev'; 

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Interceptor inteligente de tráfico de datos masivos
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Capturamos las llamadas internas que el motor gráfico intente hacer localmente
  if (url.origin === self.location.origin) {
    const relativePath = url.pathname.substring(1);

    // Si el motor pide el mapa, audio o DLCs (todo dentro de mirror/, runtime/ o configuraciones)
    if (relativePath.startsWith('mirror/') || relativePath.startsWith('runtime/') || relativePath.includes('bootset') || relativePath.includes('manifest')) {
      const targetUrl = CLOUDFLARE_R2_URL + relativePath;

      event.respondWith(
        caches.open(CACHE_NAME).then((cache) => {
          // 1. Primer escudo: Buscamos si el jugador ya descargó este bloque a su PC (Caché local)
          return cache.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
              return injectSecurityHeaders(cachedResponse); // Carga instantánea local
            }

            // 2. Si no está en su PC, lo streamea de Cloudflare R2 por primera y única vez
            return fetch(targetUrl, {
              method: event.request.method,
              headers: event.request.headers,
              mode: 'cors'
            }).then((networkResponse) => {
              if (networkResponse.ok) {
                // Lo clonamos y guardamos en el almacenamiento físico del jugador de por vida
                cache.put(event.request, networkResponse.clone());
              }
              return injectSecurityHeaders(networkResponse);
            });
          });
        })
      );
      return;
    }
  }

  // Flujo normal para los scripts ligeros del cargador que viven directo en GitHub Pages
  event.respondWith(
    fetch(event.request)
      .then(res => injectSecurityHeaders(res))
      .catch(() => fetch(event.request))
  );
});

// Cabeceras obligatorias Cross-Origin para activar WebGPU a 60 FPS estables
function injectSecurityHeaders(response) {
  if (!response || response.status === 404) return response;
  
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
  newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

/**
 * sw.js — Service Worker para GTA V Web Edition
 *
 * Arquitectura:
 *   Jugador → https://apkrprojects.xyz (GitHub Pages, sirve index.html + sw.js)
 *               ↓ el SW intercepta /mirror/ y /runtime/
 *             https://r2.dev/mirror/... y /runtime/...  (Cloudflare R2)
 *               ↓ se inyectan COOP/COEP y se cachea en disco
 *             El motor WebAssembly recibe los bytes sin notar el cambio.
 *
 * Responsabilidades:
 *   1. Inyectar COOP/COEP/CORP en cada respuesta (crítico para SharedArrayBuffer + WebGPU)
 *   2. Redirigir /mirror/ y /runtime/ a R2
 *   3. Cache-First: primera visita descarga de R2, siguientes leen de disco
 */

// ============================================================
// CONFIGURACIÓN
// ============================================================
const R2_BASE_URL = 'https://r2.dev';
const PROXY_PREFIXES = ['/mirror/', '/runtime/'];
const CACHE_NAME = 'gta5-resources-v1';

// Límite de caché local (2 GB). Si se supera, se borran las entradas más antiguas.
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

// ============================================================
// INSTALACIÓN Y ACTIVACIÓN
// ============================================================
self.addEventListener('install', () => {
  // Toma control inmediatamente sin esperar a que se cierren las pestañas antiguas
  self.skipWaiting();
  console.log('[GTA5-SW] Instalado.');
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Limpia versiones antiguas de caché si cambias CACHE_NAME
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      // Toma el control de todas las pestañas abiertas
      await self.clients.claim();
      console.log('[GTA5-SW] Activo y controlando clientes.');
    })()
  );
});

// ============================================================
// UTILIDADES
// ============================================================

/**
 * Añade las cabeceras de aislamiento cross-origin a una Response.
 * Sin ellas, crossOriginIsolated es false y SharedArrayBuffer no existe.
 */
function injectIsolationHeaders(response) {
  const headers = new Headers(response.headers);

  // Requerido para SharedArrayBuffer + WebGPU multihilo
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

  // Permite que R2 sirva recursos embebidos bajo COEP: require-corp
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Decide si una URL debe ser proxeada a R2.
 */
function shouldProxy(url) {
  const pathname = new URL(url).pathname;
  return PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Recorta la caché si supera MAX_CACHE_BYTES. Borra las entradas más antiguas
 * (FIFO aproximado). Se ejecuta en segundo plano, no bloquea la respuesta.
 */
async function trimCache() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    let total = 0;
    const sizes = [];

    for (const req of requests) {
      const res = await cache.match(req);
      if (!res) continue;
      const len = parseInt(res.headers.get('Content-Length') || '0', 10);
      sizes.push({ req, len });
      total += len;
    }

    if (total <= MAX_CACHE_BYTES) return;

    // Borra desde el principio hasta que bajemos al 80% del límite
    let removed = 0;
    for (const { req, len } of sizes) {
      if (total - removed <= MAX_CACHE_BYTES * 0.8) break;
      await cache.delete(req);
      removed += len;
    }

    console.log(`[GTA5-SW] Caché recortada: ${(removed / 1048576).toFixed(1)} MB liberados.`);
  } catch (err) {
    console.warn('[GTA5-SW] trimCache falló:', err);
  }
}

// ============================================================
// MANEJO DE PETICIONES PROXEADAS A R2
// ============================================================
async function handleProxiedRequest(event) {
  const request = event.request;
  const url = new URL(request.url);

  // 1. Cache-First: busca en disco local
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  if (cached) {
    return injectIsolationHeaders(cached);
  }

  // 2. Cache MISS: descarga desde R2
  const r2Url = R2_BASE_URL + url.pathname + url.search;
  console.log(`[GTA5-SW] MISS → R2: ${url.pathname}`);

  try {
    const r2Response = await fetch(r2Url, {
      method: request.method,
      headers: request.headers,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
    });

    if (!r2Response.ok && r2Response.status !== 206) {
      // Error del servidor: devolvemos tal cual con cabeceras inyectadas
      console.warn(`[GTA5-SW] R2 ${r2Response.status} en ${url.pathname}`);
      return injectIsolationHeaders(r2Response);
    }

    // 3. Cachea solo respuestas completas (no fragmentos 206 parciales)
    if (r2Response.status === 200) {
      const toCache = r2Response.clone();
      cache.put(request, toCache)
        .then(() => trimCache())
        .catch((err) => console.warn('[GTA5-SW] cache.put falló:', err));
    }

    return injectIsolationHeaders(r2Response);
  } catch (err) {
    console.error(`[GTA5-SW] fetch a R2 falló (${url.pathname}):`, err);

    // Fallback: si hay algo parcial en caché, usarlo
    const fallback = await cache.match(request);
    if (fallback) return injectIsolationHeaders(fallback);

    return new Response('Recurso no disponible temporalmente', {
      status: 503,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Content-Type': 'text/plain',
      },
    });
  }
}

// ============================================================
// FETCH PRINCIPAL
// ============================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ignora peticiones a otros orígenes (analytics, CDNs externas, etc.)
  if (url.origin !== self.location.origin) return;

  // Ignora métodos que no sean GET/HEAD
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;

  // Evita el error "only-if-cached" cuando mode no es same-origin
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

  // Caso 1: /mirror/* y /runtime/* → proxy a R2 con caché
  if (shouldProxy(event.request.url)) {
    event.respondWith(handleProxiedRequest(event));
    return;
  }

  // Caso 2: todo lo demás (HTML, JS, WASM, workers) → red + inyección COOP/COEP
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request);

        // No tocar respuestas opacas (no podemos leer sus headers)
        if (!response || response.type === 'opaque') return response;

        return injectIsolationHeaders(response);
      } catch (err) {
        // Fallback a caché si existe (recursos críticos ya visitados)
        const cached = await caches.match(event.request);
        if (cached) return injectIsolationHeaders(cached);
        throw err;
      }
    })()
  );
});

// ============================================================
// MENSAJES DESDE EL FRONTEND (ping/pong para depuración)
// ============================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PING') {
    event.source?.postMessage({ type: 'PONG', status: 'ready' });
  }
});

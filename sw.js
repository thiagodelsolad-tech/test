// ═══════════════════════════════════════════════════════════════════════
// Service Worker Proxy — GTA V + Simpsons + Cyberpunk 2077
// ═══════════════════════════════════════════════════════════════════════

const ORIGIN_GTA = 'https://fiveplay.lol';
const ORIGIN_SIMPSONS = 'https://simpsons-proxy.kitofree1221.workers.dev';
const ORIGIN_CYBERPUNK = 'https://cyberpunk2077.lol';

const CYBERPUNK_URL = 'https://cyberpunk2077.lol/game?ioShared=1&ioSharedMB=128&ioInflight=4&ioPersist=1&ioPersistMB=6144&binkRecycle=1&psoWarm=0&skipIntro=1&ioLookahead=16&behindLoad=0&floodKeep=1';

const GTA_PREFIXES = [
  '/b/', '/game/', '/data/', '/audio/', '/x64/',
  '/log', '/loader.js', '/prejs.js', '/wgpu_worker.js',
  '/io_worker.js', '/audio-worklet.js', '/sw2.js',
];

const SIMPSONS_CACHE = 'simpsons-v1';
const CYBERPUNK_CACHE = 'cyberpunk-v1';
const GTA_HTML_CACHE = 'gta-html-v1';
const GTA_HTML_TTL = 5 * 60 * 1000;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const keep = [SIMPSONS_CACHE, CYBERPUNK_CACHE, GTA_HTML_CACHE];
    await Promise.all(keys.filter(k => keep.indexOf(k) === -1).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isOwnStatic(path) {
  return path === '/' || path === '/index.html' ||
         path.startsWith('/img/') ||
         path === '/favicon.ico';
}

function matchesGta(path) {
  return GTA_PREFIXES.some(p => p.endsWith('/') ? path.startsWith(p) : path === p);
}

function isGamePage(path, base) {
  return path === base || path === base + '/' || path === base + '/index.html';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (isOwnStatic(url.pathname)) return;
  event.respondWith(handleFetch(event, url));
});

async function detectMode(event) {
  const check = (u) => {
    if (!u) return null;
    if (u.indexOf('/gta5') !== -1) return 'gta';
    if (u.indexOf('/simpsons') !== -1) return 'simpsons';
    if (u.indexOf('/cyberpunk') !== -1) return 'cyberpunk';
    return null;
  };
  if (event.clientId) {
    try {
      const client = await self.clients.get(event.clientId);
      const m = client && check(client.url);
      if (m) return m;
    } catch (e) {}
  }
  return check(event.request.referrer);
}

async function handleFetch(event, url) {
  const path = url.pathname;

  // ── Páginas de juego (bootstrap) ──
  if (isGamePage(path, '/gta5')) return serveGameHTML(ORIGIN_GTA, 'gta');
  if (isGamePage(path, '/simpsons')) return serveGameHTML(ORIGIN_SIMPSONS, 'simpsons');
  if (isGamePage(path, '/cyberpunk')) return serveGameHTML(ORIGIN_CYBERPUNK, 'cyberpunk');

  // ── Detectar de qué juego viene la petición ──
  let mode = await detectMode(event);

  let assetPath = path;
  const m = path.match(/^\/(gta5|simpsons|cyberpunk)(\/.*)$/);
  if (m) {
    mode = mode || (m[1] === 'gta5' ? 'gta' : m[1] === 'simpsons' ? 'simpsons' : 'cyberpunk');
    assetPath = m[2];
  }

  // ── Cyberpunk: capturar TODAS sus peticiones (usa /game, /assets, /wasm, etc.) ──
  if (mode === 'cyberpunk') {
    return proxyCyberpunk(event.request, path);
  }

  // ── GTA ──
  if ((mode === 'gta' || mode === null) && matchesGta(assetPath)) {
    return proxyAsset(event.request, ORIGIN_GTA, assetPath);
  }

  // ── Simpsons ──
  if (mode === 'simpsons') {
    return proxySimpsons(event.request, assetPath);
  }

  return fetch(event.request);
}

// ═══════════════════════════════════════════════════════════════════════
// Proxies
// ═══════════════════════════════════════════════════════════════════════
async function proxyAsset(request, origin, assetPath) {
  const url = new URL(request.url);
  const target = origin + assetPath + url.search;

  if (assetPath === '/sw2.js') {
    return new Response('self.addEventListener("install",()=>self.skipWaiting());', {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }

  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const reqHeaders = new Headers();
    const range = request.headers.get('range');
    if (range) reqHeaders.set('Range', range);
    if (hasBody) {
      const ct = request.headers.get('content-type');
      if (ct) reqHeaders.set('Content-Type', ct);
    }

    const upstream = await fetch(target, {
      method: request.method,
      headers: reqHeaders,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      body: hasBody ? await request.arrayBuffer() : undefined,
    });

    const headers = new Headers();
    ['content-type', 'content-range', 'accept-ranges',
     'last-modified', 'etag', 'cache-control'].forEach(k => {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    });

    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Access-Control-Allow-Origin', '*');

    const p = assetPath.toLowerCase();
    if (p.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    if (p.endsWith('.js') || p.endsWith('.mjs')) headers.set('Content-Type', 'application/javascript');
    if (p.endsWith('.json')) headers.set('Content-Type', 'application/json');
    if (p.endsWith('.woff')) headers.set('Content-Type', 'font/woff');
    if (p.endsWith('.woff2')) headers.set('Content-Type', 'font/woff2');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (e) {
    return new Response('Proxy error: ' + e.message, { status: 502 });
  }
}

async function proxySimpsons(request, assetPath) {
  try {
    const url = new URL(request.url);
    const key = ORIGIN_SIMPSONS + assetPath + url.search;
    const canCache = request.method === 'GET' && !request.headers.has('range');
    const cache = await caches.open(SIMPSONS_CACHE);
    if (canCache) {
      const cached = await cache.match(key);
      if (cached) return cached;
    }
    const response = await proxyAsset(request, ORIGIN_SIMPSONS, assetPath);
    if (canCache && response.status === 200) {
      cache.put(key, response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    return new Response('SW cache error: ' + e.message, { status: 502 });
  }
}

async function proxyCyberpunk(request, path) {
  try {
    const url = new URL(request.url);
    const target = ORIGIN_CYBERPUNK + path + url.search;
    const canCache = request.method === 'GET' && !request.headers.has('range');
    const cache = await caches.open(CYBERPUNK_CACHE);

    if (canCache) {
      const cached = await cache.match(target);
      if (cached) return cached;
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const reqHeaders = new Headers();
    const range = request.headers.get('range');
    if (range) reqHeaders.set('Range', range);

    const upstream = await fetch(target, {
      method: request.method,
      headers: reqHeaders,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      body: hasBody ? await request.arrayBuffer() : undefined,
    });

    const headers = new Headers();
    ['content-type', 'content-range', 'accept-ranges',
     'last-modified', 'etag', 'cache-control'].forEach(k => {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    });

    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Access-Control-Allow-Origin', '*');

    const p = path.toLowerCase();
    if (p.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    if (p.endsWith('.js') || p.endsWith('.mjs')) headers.set('Content-Type', 'application/javascript');
    if (p.endsWith('.json')) headers.set('Content-Type', 'application/json');

    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });

    if (canCache && response.status === 200) {
      cache.put(target, response.clone()).catch(() => {});
    }

    return response;
  } catch (e) {
    return new Response('Cyberpunk proxy error: ' + e.message, { status: 502 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HTML del juego
// ═══════════════════════════════════════════════════════════════════════
async function serveGameHTML(origin, type) {
  try {
    // Cache corto de HTML para GTA
    if (type === 'gta') {
      try {
        const cache = await caches.open(GTA_HTML_CACHE);
        const hit = await cache.match('gta-html');
        if (hit) {
          const ts = parseInt(hit.headers.get('x-cached-at') || '0', 10);
          if (ts && (Date.now() - ts) < GTA_HTML_TTL) {
            return new Response(hit.body, {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'credentialless',
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'Access-Control-Allow-Origin': '*',
              },
            });
          }
        }
      } catch (e) {}
    }

    // URL específica para cada juego
    let targetUrl = origin + '/';
    if (type === 'simpsons') targetUrl = origin + '/?skipmovie';
    if (type === 'cyberpunk') targetUrl = CYBERPUNK_URL;

    const upstream = await fetch(targetUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
    });

    if (!upstream.ok) {
      return new Response('Error: el servidor respondió ' + upstream.status, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    let html = await upstream.text();

    // Limpieza de ads solo para GTA
    if (type === 'gta') {
      html = html.replace(
        /<script[^>]*src\s*=\s*["'][^"']*(quge5\.com|alwingulla\.com|monetag|tag\.min\.js|cloudflareinsights)[^"']*["'][^>]*>\s*<\/script>/gi,
        ''
      );
      html = html.replace(/<meta\s+name=["']monetag["'][^>]*>/gi, '');
      html = html.replace(
        /<iframe[^>]*src=["'][^"']*(adsterra|monetag|highrevenue)[^"']*["'][^>]*>\s*<\/iframe>/gi,
        ''
      );
      html = html.replace(
        /navigator\.serviceWorker\.register\(\s*['"]\/sw2\.js['"][^)]*\)/g,
        'Promise.resolve()'
      );
    }

    const headPatch = buildHeadPatch(type);
    const bodyPatch = buildBodyPatch(type);

    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => m + headPatch);
    } else {
      html = headPatch + html;
    }

    const idx = html.toLowerCase().lastIndexOf('</body>');
    if (idx !== -1) {
      html = html.slice(0, idx) + bodyPatch + html.slice(idx);
    } else {
      html += bodyPatch;
    }

    if (type === 'gta') {
      try {
        const cache = await caches.open(GTA_HTML_CACHE);
        const cached = new Response(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'x-cached-at': String(Date.now()),
          },
        });
        cache.put('gta-html', cached).catch(() => {});
      } catch (e) {}
    }

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><style>body{background:#0e1419;color:#8ba6bf;font:14px Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style><div>Error: ' + e.message + '</div>',
      { status: 502, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HEAD PATCH — ads (solo GTA)
// ═══════════════════════════════════════════════════════════════════════
function buildHeadPatch(type) {
  if (type !== 'gta') return '';

  return `<script>
(function(){
  var BLOCKED = ['alwingulla.com','quge5.com','monetag','profit','adsterra','popads','popcash','hilltopads'];
  function isBlocked(v){
    if (!v) return false;
    v = String(v);
    return BLOCKED.some(function(b){ return v.indexOf(b) !== -1; });
  }
  var _srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  if (_srcDesc && _srcDesc.set) {
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      get: _srcDesc.get,
      set: function(v){ if (isBlocked(v)) return; _srcDesc.set.call(this, v); },
      configurable: true,
      enumerable: _srcDesc.enumerable
    });
  }
  var _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value){
    if (this.tagName === 'SCRIPT' && String(name).toLowerCase() === 'src' && isBlocked(value)) return;
    return _setAttr.call(this, name, value);
  };

  var AD_SELECTORS = [
    '[id*="adsterra"]', '[class*="adsterra"]',
    '[id*="popads"]', '[id*="popcash"]',
    '[id*="monetag"]', '[class*="monetag"]',
    'iframe[src*="profit"]', 'iframe[src*="adsterra"]',
    'iframe[src*="highrevenue"]', 'iframe[src*="monetag"]'
  ];
  var AD_TEXTS = ['new message', 'play now', 'hot new game', 'click here', 'sponsored'];

  function isProtected(el){
    if (el.id === 'canvas' || el.id === '__gp_hud' || el.id === '__gp_btn') return true;
    if (el.closest && el.closest('#loading, #__gp_hud, #__gp_btn, .my-ad')) return true;
    if (el.className && typeof el.className === 'string' && el.className.indexOf('my-ad') !== -1) return true;
    return false;
  }

  function killAds() {
    AD_SELECTORS.forEach(function(sel){
      try {
        document.querySelectorAll(sel).forEach(function(el){
          if (isProtected(el)) return;
          el.remove();
        });
      } catch(e){}
    });
    document.querySelectorAll('div, section, aside').forEach(function(el){
      if (isProtected(el)) return;
      var text = (el.textContent || '').toLowerCase().trim();
      if (text.length < 100 && AD_TEXTS.some(function(t){ return text.indexOf(t) !== -1; })) {
        var style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'absolute') el.remove();
      }
    });
  }

  var pending = false;
  var observer = new MutationObserver(function(){
    if (pending) return;
    pending = true;
    setTimeout(function(){ pending = false; killAds(); }, 300);
  });

  function init() {
    if (!document.body) return setTimeout(init, 100);
    observer.observe(document.body, { childList: true, subtree: true });
    killAds();
    setTimeout(killAds, 3000);
  }
  init();
})();
<\/script>`;
}

function buildBodyPatch(type) {
  if (type === 'simpsons' || type === 'cyberpunk') return buildAudioScript();
  return buildAdsScript() + buildAudioScript() + buildGamepadScript();
}

// ═══════════════════════════════════════════════════════════════════════
// ADS (solo GTA)
// ═══════════════════════════════════════════════════════════════════════
function buildAdsScript() {
  return `<script>
(function(){
  function addAd(id, w, h, key, pos){
    var f = document.createElement('iframe');
    f.id = id

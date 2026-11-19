// ═══════════════════════════════════════════════════════════════════════
// Service Worker Proxy — GTA V + Simpsons + Cyberpunk (Corregido)
// ═══════════════════════════════════════════════════════════════════════

const WORKER_URL = 'https://games-proxy.thiagodelsolad.workers.dev';
const ORIGIN_GTA = 'https://v2.fiveplay.lol';
const CYBERPUNK_URL =
  'https://cyberpunk2077.lol/game?ioShared=1&ioSharedMB=128&ioInflight=4&ioPersist=1&ioPersistMB=6144&binkRecycle=1&psoWarm=0&skipIntro=1&ioLookahead=16&behindLoad=0&floodKeep=1';

const BLOCKED_HOSTS = ['quge5.com', 'alwingulla.com', 'highrevenueformat.com'];

const GTA_PREFIXES = [
  '/b/',
  '/game/',
  '/data/',
  '/audio/',
  '/x64/',
  '/js/',
  '/css/',
  '/log',
  '/loader.js',
  '/prejs.js',
  '/wgpu_worker.js',
  '/io_worker.js',
  '/audio-worklet.js',
  '/sw2.js',
];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim())
);

function isOwnStatic(path) {
  return (
    path === '/' ||
    path === '/index.html' ||
    path.startsWith('/img/') ||
    path === '/favicon.ico'
  );
}

function matchesGta(path) {
  return GTA_PREFIXES.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

function isGamePage(path, base) {
  return path === base || path === base + '/' || path === base + '/index.html';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && isOwnStatic(url.pathname)) return;
  event.respondWith(handleFetch(event, url));
});

async function detectMode(event) {
  const check = (u) => {
    if (!u) return null;
    if (u.includes('/gta5')) return 'gta';
    if (u.includes('/simpsons')) return 'simpsons';
    if (u.includes('/cyberpunk')) return 'cyberpunk';
    return null;
  };

  if (event.clientId) {
    try {
      const client = await self.clients.get(event.clientId);
      const m = client && check(client.url);
      if (m) return m;
    } catch (_) {}
  }
  return check(event.request.referrer);
}

function withSecurityHeaders(baseHeaders = {}) {
  const headers = new Headers(baseHeaders);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Access-Control-Allow-Origin', '*');
  return headers;
}

async function handleFetch(event, url) {
  const path = url.pathname;

  // ── 0. Bloquear hosts de anuncios sin errores de red ──
  if (BLOCKED_HOSTS.some((h) => url.hostname.includes(h))) {
    return new Response('', {
      status: 200,
      headers: { 'Content-Type': 'application/javascript' },
    });
  }

  // Normalizar rutas sin barra final en páginas principales (/gta5 -> /gta5/)
  if (path === '/gta5' || path === '/simpsons' || path === '/cyberpunk') {
    return Response.redirect(`${url.origin}${path}/${url.search}`, 302);
  }

  // ── 1. CDN externo de Cyberpunk ──
  if (url.hostname.includes('part.fn-web-worker.workers.dev')) {
    return proxyViaWorker(event.request, '/cyberpunk-cdn' + path + url.search);
  }

  // ── 2. Páginas Bootstrap ──
  if (isGamePage(path, '/gta5')) {
    return serveGameHTML(ORIGIN_GTA, 'gta', url.search);
  }
  if (isGamePage(path, '/simpsons')) {
    return serveGameHTML(WORKER_URL + '/simpsons/', 'simpsons');
  }
  if (isGamePage(path, '/cyberpunk')) {
    return serveGameHTML(WORKER_URL + '/cyberpunk/game', 'cyberpunk');
  }

  let mode = await detectMode(event);
  let assetPath = path;

  const match = path.match(/^\/(gta5|simpsons|cyberpunk)(\/.*)$/);
  if (match) {
    mode =
      mode ||
      (match[1] === 'gta5'
        ? 'gta'
        : match[1] === 'simpsons'
        ? 'simpsons'
        : 'cyberpunk');
    assetPath = match[2];
  }

  // ── 3. Assets por modo ──
  if (mode === 'gta' || (mode === null && matchesGta(assetPath))) {
    return proxyAssetDirect(event.request, ORIGIN_GTA, assetPath);
  }

  if (mode === 'simpsons') {
    return proxyViaWorker(event.request, '/simpsons' + assetPath + url.search);
  }

  if (mode === 'cyberpunk' || path.startsWith('/api/') || path.startsWith('/build/')) {
    return proxyViaWorker(event.request, '/cyberpunk' + path + url.search);
  }

  return fetch(event.request);
}

// ═══════════════════════════════════════════════════════════════════════
// PROXIES
// ═══════════════════════════════════════════════════════════════════════
async function proxyViaWorker(request, targetPath) {
  try {
    const reqHeaders = new Headers();
    const range = request.headers.get('range');
    const contentType = request.headers.get('content-type');
    if (range) reqHeaders.set('Range', range);
    if (contentType) reqHeaders.set('Content-Type', contentType);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const upstream = await fetch(WORKER_URL + targetPath, {
      method: request.method,
      headers: reqHeaders,
      body: hasBody ? await request.arrayBuffer() : undefined,
    });

    const headers = withSecurityHeaders();
    ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((k) => {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (e) {
    return new Response('Worker error: ' + e.message, { status: 502 });
  }
}

async function proxyAssetDirect(request, origin, assetPath) {
  const url = new URL(request.url);
  const target = origin + assetPath + url.search;

  if (assetPath === '/sw2.js') {
    return new Response('self.addEventListener("install",()=>self.skipWaiting());', {
      headers: { 'Content-Type': 'application/javascript' },
    });
  }

  try {
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

    const headers = withSecurityHeaders();
    ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((k) => {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    });

    // Solo ajustar MIME type cuando la respuesta es válida (evita tratar HTML 404 como JS/WASM)
    if (upstream.ok || upstream.status === 206) {
      const p = assetPath.toLowerCase();
      if (p.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
      else if (p.endsWith('.js') || p.endsWith('.mjs')) headers.set('Content-Type', 'application/javascript');
      else if (p.endsWith('.json')) headers.set('Content-Type', 'application/json');
      else if (p.endsWith('.css')) headers.set('Content-Type', 'text/css');
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (e) {
    return new Response('Proxy error: ' + e.message, { status: 502 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HTML DEL JUEGO
// ═══════════════════════════════════════════════════════════════════════
async function serveGameHTML(origin, type, search = '') {
  try {
    let targetUrl = origin + '/';

    if (type === 'gta') {
      const q = new URLSearchParams(search);
      const mode = q.get('mode') === 'sandbox' ? 'sandbox' : 'story';
      targetUrl = `${origin}/game.html?mode=${mode}&cfg=1`;
    } else if (type === 'simpsons') {
      targetUrl = origin + '?skipmovie';
    } else if (type === 'cyberpunk') {
      targetUrl = CYBERPUNK_URL;
    }

    const upstream = await fetch(targetUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
    });

    if (!upstream.ok) {
      return new Response('Upstream error ' + upstream.status, { status: 502 });
    }

    let html = await upstream.text();
    const headPatch = buildHeadPatch(type);
    const bodyPatch = buildBodyPatch(type);

    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => m + headPatch);
    } else {
      html = headPatch + html;
    }

    const bodyCloseIdx = html.toLowerCase().lastIndexOf('</body>');
    if (bodyCloseIdx !== -1) {
      html = html.slice(0, bodyCloseIdx) + bodyPatch + html.slice(bodyCloseIdx);
    } else {
      html += bodyPatch;
    }

    return new Response(html, {
      status: 200,
      headers: withSecurityHeaders({
        'Content-Type': 'text/html; charset=utf-8',
      }),
    });
  } catch (e) {
    return new Response('HTML error: ' + e.message, { status: 502 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PATCHES (Ads, Audio, Gamepad)
// ═══════════════════════════════════════════════════════════════════════
function buildHeadPatch(type) {
  if (type !== 'gta') return '';
  return `<script>
(function(){
  var BLOCKED = ['alwingulla.com','quge5.com','highrevenueformat.com','monetag','profit','adsterra','popads','popcash','hilltopads'];
  function isBlocked(v){
    if (!v) return false;
    v = String(v).toLowerCase();
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
    '[id*="adsterra"]','[class*="adsterra"]','[id*="popads"]','[id*="popcash"]',
    '[id*="monetag"]','[class*="monetag"]','iframe[src*="profit"]',
    'iframe[src*="adsterra"]','iframe[src*="highrevenue"]','iframe[src*="monetag"]'
  ];
  var AD_TEXTS = ['new message', 'play now', 'hot new game', 'click here', 'sponsored'];

  function isProtected(el){
    if (!el) return true;
    if (el.id === 'canvas' || el.id === '__gp_hud' || el.id === '__gp_btn') return true;
    if (el.closest && el.closest('#loading, #__gp_hud, #__gp_btn')) return true;
    return false;
  }

  function killAds() {
    AD_SELECTORS.forEach(function(sel){
      try {
        document.querySelectorAll(sel).forEach(function(el){
          if (!isProtected(el)) el.remove();
        });
      } catch(_) {}
    });

    document.querySelectorAll('div, section, aside').forEach(function(el){
      if (isProtected(el)) return;
      var text = (el.textContent || '').toLowerCase().trim();
      if (text.length > 0 && text.length < 100 && AD_TEXTS.some(function(t){ return text.indexOf(t) !== -1; })) {
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
</script>`;
}

function buildBodyPatch(type) {
  if (type === 'simpsons' || type === 'cyberpunk') return buildAudioScript();
  return buildAudioScript() + buildGamepadScript();
}

function buildAudioScript() {
  return `<script>
(function(){
  var unlocked = false;
  function resumeAll(){
    try {
      if (window.__audioContexts) {
        window.__audioContexts.forEach(function(c){
          if (c && c.state === 'suspended') c.resume().catch(function(){});
        });
      }
    } catch(_) {}
  }
  function unlock(){
    if (unlocked) return;
    unlocked = true;
    try {
      resumeAll();
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        var ctx = new AudioCtx();
        if (ctx.state === 'suspended') ctx.resume().catch(function(){});
      }
    } catch(_) {}
    var count = 0;
    var timer = setInterval(function(){
      resumeAll();
      if (++count > 20) clearInterval(timer);
    }, 500);
  }
  ['click','pointerdown','keydown','touchstart'].forEach(function(ev){
    window.addEventListener(ev, unlock, { once: false, capture: true, passive: true });
  });
})();
</script>`;
}

function buildGamepadScript() {
  return `<script>
  // ⬇️ PEGA AQUÍ TU CÓDIGO DEL GAMEPAD ⬇️
</script>`;
}

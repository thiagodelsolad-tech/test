// ═══════════════════════════════════════════════════════════════════════
// Service Worker Proxy — GTA V + Simpsons + Cyberpunk (100% Corregido)
// Flujo GTA: /gta5 -> launcher.html -> [Play] -> game.html
// ═══════════════════════════════════════════════════════════════════════

const WORKER_URL = 'https://games-proxy.thiagodelsolad.workers.dev';
const ORIGIN_GTA = 'https://v2.fiveplay.lol';
const CYBERPUNK_URL =
  'https://cyberpunk2077.lol/game?ioShared=1&ioSharedMB=128&ioInflight=4&ioPersist=1&ioPersistMB=6144&binkRecycle=1&psoWarm=0&skipIntro=1&ioLookahead=16&behindLoad=0&floodKeep=1';

const BLOCKED_HOSTS = [
  'quge5.com',
  'alwingulla.com',
  'highrevenueformat.com',
];

const GTA_PREFIXES = [
  '/b/',
  '/game/',
  '/data/',
  '/audio/',
  '/x64/',
  '/js/',
  '/css/',
  '/img/',
  '/assets/',
  '/log',
  '/loader.js',
  '/prejs.js',
  '/wgpu_worker.js',
  '/io_worker.js',
  '/audio-worklet.js',
  '/sw2.js',
];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function isOwnStatic(path) {
  return (
    path === '/' ||
    path === '/index.html' ||
    path.startsWith('/img/') ||
    path === '/favicon.ico'
  );
}

function matchesGta(path) {
  return GTA_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix
  );
}

function isGtaRoot(path) {
  return path === '/gta5' || path === '/gta5/' || path === '/gta5/index.html';
}

function isGamePage(path, base) {
  return path === base || path === base + '/' || path === base + '/index.html';
}

function withIsolationHeaders(initHeaders = {}) {
  const headers = new Headers(initHeaders);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Access-Control-Allow-Origin', '*');
  return headers;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.origin === self.location.origin && isOwnStatic(url.pathname)) {
    return;
  }

  event.respondWith(handleFetch(event, url));
});

async function detectMode(event) {
  const matchMode = (rawUrl) => {
    if (!rawUrl) return null;
    if (rawUrl.includes('/gta5')) return 'gta';
    if (rawUrl.includes('/simpsons')) return 'simpsons';
    if (rawUrl.includes('/cyberpunk')) return 'cyberpunk';
    return null;
  };

  if (event.clientId) {
    try {
      const client = await self.clients.get(event.clientId);
      const detected = client && matchMode(client.url);
      if (detected) return detected;
    } catch (_) {}
  }

  return matchMode(event.request.referrer);
}

async function handleFetch(event, url) {
  const path = url.pathname;

  // 0. Bloquear dominios de anuncios conocidos con respuesta JS vacía
  if (BLOCKED_HOSTS.some((host) => url.hostname.includes(host))) {
    return new Response('', {
      status: 200,
      headers: withIsolationHeaders({
        'Content-Type': 'application/javascript; charset=utf-8',
      }),
    });
  }

  // Normalizar rutas base sin barra final conservando query strings
  if (path === '/gta5' || path === '/simpsons' || path === '/cyberpunk') {
    return Response.redirect(`${url.origin}${path}/${url.search}`, 302);
  }

  // 1. CDN externo de Cyberpunk
  if (url.hostname.includes('part.fn-web-worker.workers.dev')) {
    return proxyViaWorker(event.request, '/cyberpunk-cdn' + path + url.search);
  }

  let mode = await detectMode(event);

  // 2. Páginas HTML de GTA V:
  // - /gta5/ o /gta5/launcher.html -> launcher.html original
  // - /gta5/game.html (o /game.html dentro de modo gta) -> game.html original
  if (path === '/gta5/launcher.html' || isGtaRoot(path)) {
    return serveGtaLauncherHTML(url.search);
  }

  if (path === '/gta5/game.html' || (mode === 'gta' && path === '/game.html')) {
    return serveGameHTML(ORIGIN_GTA, 'gta', url.search);
  }

  // Otras páginas de juego
  if (isGamePage(path, '/simpsons')) {
    return serveGameHTML(WORKER_URL + '/simpsons/', 'simpsons');
  }
  if (isGamePage(path, '/cyberpunk')) {
    return serveGameHTML(WORKER_URL + '/cyberpunk/game', 'cyberpunk');
  }

  let assetPath = path;
  const subPathMatch = path.match(/^\/(gta5|simpsons|cyberpunk)(\/.*)$/);
  if (subPathMatch) {
    mode =
      mode ||
      (subPathMatch[1] === 'gta5'
        ? 'gta'
        : subPathMatch[1] === 'simpsons'
        ? 'simpsons'
        : 'cyberpunk');
    assetPath = subPathMatch[2];
  }

  // 3. Enrutamiento de recursos por juego
  if (mode === 'gta' || (mode === null && matchesGta(assetPath))) {
    return proxyAssetDirect(event.request, ORIGIN_GTA, assetPath);
  }

  if (mode === 'simpsons') {
    return proxyViaWorker(event.request, '/simpsons' + assetPath + url.search);
  }

  if (
    mode === 'cyberpunk' ||
    path.startsWith('/api/') ||
    path.startsWith('/build/')
  ) {
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

    const headers = withIsolationHeaders();
    [
      'content-type',
      'content-range',
      'accept-ranges',
      'content-length',
      'last-modified',
      'etag',
    ].forEach((key) => {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (err) {
    return new Response('Worker proxy error: ' + err.message, {
      status: 502,
      headers: withIsolationHeaders({ 'Content-Type': 'text/plain' }),
    });
  }
}

async function proxyAssetDirect(request, origin, assetPath) {
  const url = new URL(request.url);
  const cleanAssetPath = assetPath.startsWith('/') ? assetPath : '/' + assetPath;
  const target = origin + cleanAssetPath + url.search;

  if (cleanAssetPath === '/sw2.js') {
    return new Response(
      'self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));',
      {
        status: 200,
        headers: withIsolationHeaders({
          'Content-Type': 'application/javascript; charset=utf-8',
        }),
      }
    );
  }

  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const reqHeaders = new Headers();
    const range = request.headers.get('range');
    const accept = request.headers.get('accept');
    if (range) reqHeaders.set('Range', range);
    if (accept) reqHeaders.set('Accept', accept);

    const upstream = await fetch(target, {
      method: request.method,
      headers: reqHeaders,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      referrer: origin + '/',
      body: hasBody ? await request.arrayBuffer() : undefined,
    });

    const headers = withIsolationHeaders();
    [
      'content-type',
      'content-range',
      'accept-ranges',
      'content-length',
      'last-modified',
      'etag',
    ].forEach((key) => {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    });

    if (upstream.ok || upstream.status === 206) {
      const lower = cleanAssetPath.toLowerCase();
      if (lower.endsWith('.wasm')) {
        headers.set('Content-Type', 'application/wasm');
      } else if (lower.endsWith('.js') || lower.endsWith('.mjs')) {
        headers.set('Content-Type', 'application/javascript; charset=utf-8');
      } else if (lower.endsWith('.json')) {
        headers.set('Content-Type', 'application/json; charset=utf-8');
      } else if (lower.endsWith('.css')) {
        headers.set('Content-Type', 'text/css; charset=utf-8');
      } else if (lower.endsWith('.mp3')) {
        headers.set('Content-Type', 'audio/mpeg');
      } else if (lower.endsWith('.ogg')) {
        headers.set('Content-Type', 'audio/ogg');
      } else if (lower.endsWith('.wav')) {
        headers.set('Content-Type', 'audio/wav');
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (err) {
    return new Response('Asset proxy error: ' + err.message, {
      status: 502,
      headers: withIsolationHeaders({ 'Content-Type': 'text/plain' }),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HTML DEL LAUNCHER Y DEL JUEGO
// ═══════════════════════════════════════════════════════════════════════
function injectGtaHtmlPatches(html, type) {
  const baseTag = '<base href="/gta5/">';
  const headPatch = buildHeadPatch(type);
  const bodyPatch = buildBodyPatch(type);

  let output = html;
  if (/<head[^>]*>/i.test(output)) {
    output = output.replace(/<head[^>]*>/i, (match) => match + baseTag + headPatch);
  } else {
    output = baseTag + headPatch + output;
  }

  const bodyCloseIdx = output.toLowerCase().lastIndexOf('</body>');
  if (bodyCloseIdx !== -1) {
    output = output.slice(0, bodyCloseIdx) + bodyPatch + output.slice(bodyCloseIdx);
  } else {
    output += bodyPatch;
  }
  return output;
}

async function serveGtaLauncherHTML(search = '') {
  try {
    const targetUrl = `${ORIGIN_GTA}/launcher.html${search}`;
    const upstream = await fetch(targetUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
      referrer: ORIGIN_GTA + '/',
    });

    if (!upstream.ok) {
      return new Response('Launcher error ' + upstream.status, {
        status: 502,
        headers: withIsolationHeaders({ 'Content-Type': 'text/plain' }),
      });
    }

    const rawHtml = await upstream.text();
    const patchedHtml = injectGtaHtmlPatches(rawHtml, 'launcher');

    return new Response(patchedHtml, {
      status: 200,
      headers: withIsolationHeaders({
        'Content-Type': 'text/html; charset=utf-8',
      }),
    });
  } catch (err) {
    return new Response('Launcher fetch error: ' + err.message, {
      status: 502,
      headers: withIsolationHeaders({ 'Content-Type': 'text/plain' }),
    });
  }
}

async function serveGameHTML(origin, type, search = '') {
  try {
    let targetUrl = origin + '/';

    if (type === 'gta') {
      const params = new URLSearchParams(search);
      const mode = params.get('mode') === 'sandbox' ? 'sandbox' : 'story';
      const cfg = params.get('cfg') || '1';
      targetUrl = `${origin}/game.html?mode=${mode}&cfg=${cfg}`;
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
      referrer: origin + '/',
    });

    if (!upstream.ok) {
      return new Response('Upstream HTML error: ' + upstream.status, {
        status: 502,
        headers: withIsolationHeaders({ 'Content-Type': 'text/plain' }),
      });
    }

    let html = await upstream.text();

    if (type === 'gta') {
      html = injectGtaHtmlPatches(html, 'gta');
    } else {
      const headPatch = buildHeadPatch(type);
      const bodyPatch = buildBodyPatch(type);

      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (match) => match + headPatch);
      } else {
        html = headPatch + html;
      }

      const bodyCloseIdx = html.toLowerCase().lastIndexOf('</body>');
      if (bodyCloseIdx !== -1) {
        html = html.slice(0, bodyCloseIdx) + bodyPatch + html.slice(bodyCloseIdx);
      } else {
        html += bodyPatch;
      }
    }

    return new Response(html, {
      status: 200,
      headers: withIsolationHeaders({
        'Content-Type': 'text/html; charset=utf-8',
      }),
    });
  } catch (err) {
    return new Response('HTML serve error: ' + err.message, {
      status: 502,
      headers: withIsolationHeaders({ 'Content-Type': 'text/plain' }),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PATCHES (Bloqueo de popups/ads, Audio, Gamepad)
// ═══════════════════════════════════════════════════════════════════════
function buildHeadPatch(type) {
  if (type !== 'gta' && type !== 'launcher') return '';

  return `<script>
(function () {
  var BLOCKED = [
    'alwingulla.com',
    'quge5.com',
    'highrevenueformat.com',
    'monetag',
    'profit',
    'adsterra',
    'popads',
    'popcash',
    'hilltopads'
  ];

  function isBlocked(val) {
    if (!val) return false;
    var s = String(val).toLowerCase();
    return BLOCKED.some(function (b) {
      return s.indexOf(b) !== -1;
    });
  }

  var srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      get: srcDesc.get,
      set: function (val) {
        if (isBlocked(val)) return;
        srcDesc.set.call(this, val);
      },
      configurable: true,
      enumerable: srcDesc.enumerable
    });
  }

  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (
      this.tagName === 'SCRIPT' &&
      String(name).toLowerCase() === 'src' &&
      isBlocked(value)
    ) {
      return;
    }
    return origSetAttr.call(this, name, value);
  };

  var AD_SELECTORS = [
    '[id*="adsterra"]',
    '[class*="adsterra"]',
    '[id*="popads"]',
    '[id*="popcash"]',
    '[id*="monetag"]',
    '[class*="monetag"]',
    'iframe[src*="profit"]',
    'iframe[src*="adsterra"]',
    'iframe[src*="highrevenue"]',
    'iframe[src*="monetag"]'
  ];

  var AD_TEXTS = ['new message', 'play now', 'hot new game', 'click here', 'sponsored'];

  function isProtected(el) {
    if (!el) return true;
    if (el.id === 'canvas' || el.id === '__gp_hud' || el.id === '__gp_btn') return true;
    if (el.closest && el.closest('#loading, #__gp_hud, #__gp_btn')) return true;
    return false;
  }

  function cleanAdOverlays() {
    AD_SELECTORS.forEach(function (sel) {
      try {
        document.querySelectorAll(sel).forEach(function (el) {
          if (!isProtected(el)) el.remove();
        });
      } catch (_) {}
    });

    document.querySelectorAll('div, section, aside').forEach(function (el) {
      if (isProtected(el)) return;
      var txt = (el.textContent || '').toLowerCase().trim();
      if (
        txt.length > 0 &&
        txt.length < 100 &&
        AD_TEXTS.some(function (t) { return txt.indexOf(t) !== -1; })
      ) {
        var st = window.getComputedStyle(el);
        if (st.position === 'fixed' || st.position === 'absolute') {
          el.remove();
        }
      }
    });
  }

  var queued = false;
  var observer = new MutationObserver(function () {
    if (queued) return;
    queued = true;
    setTimeout(function () {
      queued = false;
      cleanAdOverlays();
    }, 300);
  });

  function startObserver() {
    if (!document.body) return setTimeout(startObserver, 100);
    observer.observe(document.body, { childList: true, subtree: true });
    cleanAdOverlays();
    setTimeout(cleanAdOverlays, 3000);
  }

  startObserver();
})();
<\/script>`;
}

function buildBodyPatch(type) {
  if (type === 'launcher') {
    return buildAudioScript();
  }
  if (type === 'simpsons' || type === 'cyberpunk') {
    return buildAudioScript();
  }
  return buildAudioScript() + buildGamepadScript();
}

function buildAudioScript() {
  return `<script>
(function () {
  var trackedContexts = new Set();

  function registerCtx(ctx) {
    if (ctx && typeof ctx.resume === 'function') {
      trackedContexts.add(ctx);
    }
  }

  var OrigAudioCtx = window.AudioContext || window.webkitAudioContext;
  if (OrigAudioCtx && !OrigAudioCtx.__patchedBySw) {
    function WrappedAudioContext(opts) {
      var instance = opts ? new OrigAudioCtx(opts) : new OrigAudioCtx();
      registerCtx(instance);
      return instance;
    }
    WrappedAudioContext.prototype = OrigAudioCtx.prototype;
    Object.setPrototypeOf(WrappedAudioContext, OrigAudioCtx);
    WrappedAudioContext.__patchedBySw = true;
    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext) {
      window.webkitAudioContext = WrappedAudioContext;
    }
  }

  function resumeAllContexts() {
    try {
      if (Array.isArray(window.__audioContexts)) {
        window.__audioContexts.forEach(registerCtx);
      }
      trackedContexts.forEach(function (ctx) {
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().catch(function () {});
        }
      });
      document.querySelectorAll('audio, video').forEach(function (media) {
        if (media.muted) media.muted = false;
        if (media.paused && media.autoplay) {
          media.play().catch(function () {});
        }
      });
    } catch (_) {}
  }

  function unlockAudio() {
    resumeAllContexts();
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && trackedContexts.size === 0) {
        var tempCtx = new Ctx();
        registerCtx(tempCtx);
        if (tempCtx.state === 'suspended') {
          tempCtx.resume().catch(function () {});
        }
      }
    } catch (_) {}

    var ticks = 0;
    var interval = setInterval(function () {
      resumeAllContexts();
      if (++ticks > 20) clearInterval(interval);
    }, 500);
  }

  ['click', 'pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, unlockAudio, {
      once: false,
      capture: true,
      passive: true
    });
  });
})();
<\/script>`;
}

function buildGamepadScript() {
  return `<script>
  // ⬇️ PEGA AQUÍ TU CÓDIGO DEL GAMEPAD ⬇️
<\/script>`;
}

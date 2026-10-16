// ═══════════════════════════════════════════════════════════════════════
// GTA V Service Worker Proxy
// Intercepta /gta5 y los assets del juego → fiveplay.lol
// Añade COOP/COEP · Bloquea ads · Inyecta gamepad + audio + tus 2 ads
// ═══════════════════════════════════════════════════════════════════════

const ORIGIN = 'https://fiveplay.lol';

const GAME_PREFIXES = [
  '/b/', '/game/', '/data/', '/audio/', '/x64/',
  '/log', '/loader.js', '/prejs.js', '/wgpu_worker.js',
  '/io_worker.js', '/audio-worklet.js', '/sw2.js',
];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  // ⚠️ FIX: soportar todas las formas de la ruta del juego
  const isGamePage = url.pathname === '/gta5'
                  || url.pathname === '/gta5/'
                  || url.pathname === '/gta5/index.html';

  const isGameAsset = GAME_PREFIXES.some(p => url.pathname.startsWith(p));

  if (isGamePage) {
    event.respondWith(serveGameHTML());
  } else if (isGameAsset) {
    event.respondWith(proxyAsset(event.request));
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PROXY DE ASSETS
// ═══════════════════════════════════════════════════════════════════════
async function proxyAsset(request) {
  const url = new URL(request.url);
  const target = ORIGIN + url.pathname + url.search;

  if (url.pathname === '/sw2.js') {
    return new Response('self.addEventListener("install",()=>self.skipWaiting());', {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: buildUpstreamHeaders(request),
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
      redirect: 'follow',
    });

    const headers = new Headers();
    ['content-type','content-length','content-encoding','content-range',
     'accept-ranges','last-modified','etag','cache-control'].forEach(k => {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    });

    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Access-Control-Allow-Origin', '*');

    const p = url.pathname.toLowerCase();
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

function buildUpstreamHeaders(request) {
  const h = new Headers();
  const acc = request.headers.get('accept');
  const rng = request.headers.get('range');
  if (acc) h.set('Accept', acc);
  if (rng) h.set('Range', rng);
  h.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  h.set('Referer', ORIGIN + '/');
  h.set('Origin', ORIGIN);
  return h;
}

// ═══════════════════════════════════════════════════════════════════════
// HTML DEL JUEGO (fiveplay.lol parcheado)
// ═══════════════════════════════════════════════════════════════════════
async function serveGameHTML() {
  try {
    const upstream = await fetch(ORIGIN + '/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    let html = await upstream.text();

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

    const headPatch = buildHeadPatch();
    const bodyPatch = buildBodyPatch();

    if (html.indexOf('<head>') !== -1) {
      html = html.replace('<head>', '<head>' + headPatch);
    }
    if (html.indexOf('</body>') !== -1) {
      html = html.replace('</body>', bodyPatch + '</body>');
    } else {
      html += bodyPatch;
    }

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
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

function buildHeadPatch() {
  return `<script>
(function(){
  var _create = document.createElement.bind(document);
  var _srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  var BLOCKED = ['alwingulla.com', 'quge5.com', 'monetag'];
  document.createElement = function(tag){
    var el = _create(tag);
    if (tag && tag.toLowerCase() === 'script') {
      Object.defineProperty(el, 'src', {
        set: function(v){
          if (v && BLOCKED.some(function(b){ return v.indexOf(b) !== -1; })) return;
          _srcDesc.set.call(this, v);
        },
        get: function(){ return _srcDesc.get.call(this); },
        configurable: true
      });
    }
    return el;
  };
})();
<\/script>`;
}

function buildBodyPatch() {
  return buildAdsScript() + buildAudioScript() + buildGamepadScript();
}

function buildAdsScript() {
  return `<script>
(function(){
  function addAd(id, w, h, key, pos){
    var f = document.createElement('iframe');
    f.id = id; f.className = 'my-ad';
    f.width = w; f.height = h; f.scrolling = 'no';
    f.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:9000;border:0;' + (pos==='top'?'top:8px;':'bottom:8px;');
    document.body.appendChild(f);
    var doc = f.contentDocument || f.contentWindow.document;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}</style></head><body>');
    doc.write('<scr' + 'ipt>atOptions={"key":"' + key + '","format":"iframe","height":' + h + ',"width":' + w + ',"params":{}};</scr' + 'ipt>');
    doc.write('<scr' + 'ipt src="https://www.highrevenueformat.com/' + key + '/invoke.js"></scr' + 'ipt>');
    doc.write('</body></html>');
    doc.close();
  }
  function rm(){ document.querySelectorAll('.my-ad').forEach(function(e){ try{e.remove();}catch(x){} }); }
  function init(){
    if (!document.body) return setTimeout(init, 50);
    addAd('my-ad-728', 728, 90, '76a4887bf5246065c1644d5ff3ee96ae', 'top');
    addAd('my-ad-320', 320, 50, '0c552db9603823b8354d2c686ebe16d7', 'bottom');
    var obs = new MutationObserver(function(){
      var l = document.getElementById('loading');
      if (!l || l.classList.contains('done')) { rm(); obs.disconnect(); }
    });
    obs.observe(document.documentElement, {childList:true,subtree:true,attributes:true,attributeFilter:['class']});
    setTimeout(function(){ rm(); obs.disconnect(); }, 5*60*1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
<\/script>`;
}

function buildAudioScript() {
  return `<script>
(function(){
  var u = false;
  function unlock(){
    if (u) return; u = true;
    try {
      if (window.__audioContexts) window.__audioContexts.forEach(function(c){ if(c.state==='suspended') c.resume().catch(function(){}); });
      var ctx = new (window.AudioContext||window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(function(){});
    } catch(e){}
    var n = 0, iv = setInterval(function(){
      try { if (window.__audioContexts) window.__audioContexts.forEach(function(c){ if(c.state==='suspended') c.resume().catch(function(){}); }); } catch(e){}
      if (++n > 20) clearInterval(iv);
    }, 500);
  }
  ['click','pointerdown','keydown','touchstart'].forEach(function(e){
    window.addEventListener(e, unlock, {once:false, capture:true, passive:true});
  });
})();
<\/script>`;
}

function buildGamepadScript() {
  return `<script>
(function(){
  if (window.__gamepadInjected) return;
  window.__gamepadInjected = true;

  var MODE = 'foot';
  var HUD_HIDE = 3000;
  var hideTimer = null;

  var MODES = {
    foot: {
      emoji: '🚶', name: 'ON FOOT', accent: '#22c55e', accentSoft: 'rgba(34,197,94,.15)',
      buttons: [
        {key:'STICK L', fn:'Move (WASD)'},{key:'STICK R', fn:'Camera'},
        {key:'L2', fn:'Aim / Fight (Right Click)'},{key:'R2', fn:'Shoot / Punch (Left Click)'},
        {key:'L1', fn:'Weapon Wheel (Tab)'},{key:'R1', fn:'Take Cover (Q)'},
        {key:'A / ✕', fn:'Sprint (Shift)'},{key:'B / ○', fn:'Reload (R)'},
        {key:'X / □', fn:'Jump / Climb (Space)'},{key:'Y / △', fn:'Enter / Exit Vehicle (F)'},
        {key:'L3', fn:'Stealth (CapsLock)'},{key:'R3', fn:'Look Behind (C)'},
        {key:'D-PAD', fn:'Navigation'},{key:'START', fn:'Pause (Esc)'},{key:'BACK', fn:'Switch Mode'}
      ]
    },
    vehicle: {
      emoji: '🚗', name: 'VEHICLE', accent: '#3b82f6', accentSoft: 'rgba(59,130,246,.15)',
      buttons: [
        {key:'STICK L', fn:'Steer (A / D)'},{key:'STICK R', fn:'Camera'},
        {key:'L2', fn:'Brake / Reverse (S)'},{key:'R2', fn:'Accelerate (W)'},
        {key:'L1', fn:'Drive-by Aim (Right Click)'},{key:'R1', fn:'Drive-by Shoot (Left Click)'},
        {key:'A / ✕', fn:'Duck (X)'},{key:'B / ○', fn:'Reload (R)'},
        {key:'X / □', fn:'Handbrake (Space)'},{key:'Y / △', fn:'Exit Vehicle (F)'},
        {key:'L3', fn:'Horn (E)'},{key:'R3', fn:'Rear View (C)'},
        {key:'D-PAD', fn:'Navigation'},{key:'START', fn:'Pause (Esc)'},{key:'BACK', fn:'Switch Mode'}
      ]
    },
    air: {
      emoji: '✈️', name: 'AIRCRAFT', accent: '#f97316', accentSoft: 'rgba(249,115,22,.15)',
      buttons: [
        {key:'STICK L ↑', fn:'Descend (Num 8)'},{key:'STICK L ↓', fn:'Ascend (Num 5)'},
        {key:'STICK L ←', fn:'Roll Left (Num 4)'},{key:'STICK L →', fn:'Roll Right (Num 6)'},
        {key:'STICK R', fn:'Camera'},
        {key:'L2', fn:'Throttle Down (S)'},{key:'R2', fn:'Throttle Up (W)'},
        {key:'L1', fn:'Yaw Left (A)'},{key:'R1', fn:'Yaw Right (D)'},
        {key:'A / ✕', fn:'Change Weapon (Tab)'},{key:'B / ○', fn:'Reload (R)'},
        {key:'X / □', fn:'Fire (Space)'},{key:'Y / △', fn:'Exit Aircraft (F)'},
        {key:'L3', fn:'Landing Gear (G)'},{key:'R3', fn:'Look Behind (C)'},
        {key:'START', fn:'Pause (Esc)'},{key:'BACK', fn:'Switch Mode'}
      ]
    }
  };

  var MAP_FOOT    = {0:'ShiftLeft',1:'KeyR',2:'Space',3:'KeyF',4:'Tab',5:'KeyQ',9:'Escape',10:'CapsLock',11:'KeyC',12:'ArrowUp',13:'KeyZ',14:'KeyG',15:'KeyE'};
  var MAP_VEHICLE = {0:'KeyX',1:'KeyR',2:'Space',3:'KeyF',9:'Escape',10:'KeyE',11:'KeyC',12:'ArrowUp',13:'KeyZ',14:'ArrowLeft',15:'KeyH'};
  var MAP_AIR     = {0:'Tab',1:'KeyR',2:'Space',3:'KeyF',4:'KeyA',5:'KeyD',9:'Escape',10:'KeyG',11:'KeyC',12:'ArrowUp',13:'KeyZ',14:'KeyQ',15:'KeyE'};
  var MODE_MAP = {foot:MAP_FOOT, vehicle:MAP_VEHICLE, air:MAP_AIR};

  var SENS = 29, DZ = 0.12, TT = 0.25, BT = 400;
  var held = new Set();
  var lm = false, rm = false;

  var KC = {'ShiftLeft':16,'KeyR':82,'Space':32,'KeyF':70,'Tab':9,'KeyQ':81,'Escape':27,'CapsLock':20,'KeyC':67,'ArrowUp':38,'ArrowDown':40,'ArrowLeft':37,'ArrowRight':39,'KeyZ':90,'KeyG':71,'KeyE':69,'KeyW':87,'KeyA':65,'KeyS':83,'KeyD':68,'KeyX':88,'KeyH':72,'Numpad4':100,'Numpad5':101,'Numpad6':102,'Numpad8':104,'Backspace':8};
  var KCh = {'ShiftLeft':'Shift','Space':' ','Tab':'Tab','Escape':'Escape','CapsLock':'CapsLock','ArrowUp':'ArrowUp','ArrowDown':'ArrowDown','ArrowLeft':'ArrowLeft','ArrowRight':'ArrowRight','Backspace':'Backspace','KeyA':'a','KeyC':'c','KeyD':'d','KeyE':'e','KeyF':'f','KeyG':'g','KeyH':'h','KeyQ':'q','KeyR':'r','KeyS':'s','KeyW':'w','KeyX':'x','KeyZ':'z','Numpad4':'4','Numpad5':'5','Numpad6':'6','Numpad8':'8'};

  function mk(t,c){
    var e = new KeyboardEvent(t, {code:c, key:KCh[c]||c, bubbles:true, cancelable:true, view:window});
    try {
      Object.defineProperty(e,'keyCode',{get:function(){return KC[c]||0;}});
      Object.defineProperty(e,'which',{get:function(){return KC[c]||0;}});
    } catch(x){}
    return e;
  }
  function pk(c){ if(held.has(c))return; held.add(c); window.dispatchEvent(mk('keydown',c)); document.dispatchEvent(mk('keydown',c)); }
  function rk(c){ if(!held.has(c))return; held.delete(c); window.dispatchEvent(mk('keyup',c)); document.dispatchEvent(mk('keyup',c)); }
  function rAll(){ held.forEach(function(k){ window.dispatchEvent(mk('keyup',k)); document.dispatchEvent(mk('keyup',k)); }); held.clear(); }

  function gc(){ return document.getElementById('canvas'); }
  function lock(){
    var c = gc(); if(!c || document.pointerLockElement === c) return;
    try {
      var p = c.requestPointerLock({unadjustedMovement:true});
      if (p && p.catch) p.catch(function(){ try{c.requestPointerLock();}catch(x){} });
    } catch(x){ try{c.requestPointerLock();}catch(y){} }
  }
  function mv(dx,dy){
    if (!dx && !dy) return;
    var c = gc(); if (!c) return;
    if (document.pointerLockElement !== c) lock();
    var e = new MouseEvent('mousemove', {bubbles:true,cancelable:true,view:window,movementX:dx,movementY:dy,clientX:(c.clientWidth/2)|0,clientY:(c.clientHeight/2)|0});
    try{window.dispatchEvent(e);}catch(x){}
    try{document.dispatchEvent(e);}catch(x){}
    try{c.dispatchEvent(e);}catch(x){}
  }
  function hm(w){
    var c = gc(); if(!c) return;
    if (w==='left' && lm) return; if (w==='right' && rm) return;
    if (w==='left') lm=true; else rm=true;
    var bc = w==='left'?0:2, bm = w==='left'?1:2;
    c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window,button:bc,buttons:bm,clientX:(c.clientWidth/2)|0,clientY:(c.clientHeight/2)|0}));
  }
  function rmv(w){
    var c = gc(); if(!c) return;
    if (w==='left' && !lm) return; if (w==='right' && !rm) return;
    if (w==='left') lm=false; else rm=false;
    var bc = w==='left'?0:2;
    c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window,button:bc,buttons:0,clientX:(c.clientWidth/2)|0,clientY:(c.clientHeight/2)|0}));
  }

  function sty(){
    if (document.getElementById('__gp_style')) return;
    var s = document.createElement('style'); s.id='__gp_style';
    s.textContent =
      '@keyframes gp-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.5;transform:scale(.85);}}' +
      '@keyframes gp-fadeIn{from{opacity:0;transform:translateY(10px) scale(.97);}to{opacity:1;transform:translateY(0) scale(1);}}' +
      '@keyframes gp-fadeOut{from{opacity:1;transform:translateY(0) scale(1);}to{opacity:0;transform:translateY(10px) scale(.97);}}' +
      '#__gp_hud{position:fixed;left:14px;bottom:14px;z-index:9500;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;line-height:1.4;color:#fff;max-width:420px;filter:drop-shadow(0 10px 24px rgba(0,0,0,.5));}' +
      '#__gp_hud.gp-show{animation:gp-fadeIn .35s cubic-bezier(.16,1,.3,1) forwards;}' +
      '#__gp_hud.gp-hide{animation:gp-fadeOut .35s cubic-bezier(.16,1,.3,1) forwards;}' +
      '#__gp_btn{position:fixed;left:14px;bottom:14px;z-index:9501;width:52px;height:52px;border-radius:50%;background:linear-gradient(145deg,rgba(18,18,24,.94),rgba(28,28,38,.90));backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.10);display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;pointer-events:auto;user-select:none;}' +
      '#__gp_btn.gp-hidden{display:none;}';
    document.head.appendChild(s);
  }

  function ch(){ sty(); var h = document.getElementById('__gp_hud'); if(h) return h; h = document.createElement('div'); h.id='__gp_hud'; document.body.appendChild(h); return h; }
  function cb(){ sty(); var b = document.getElementById('__gp_btn'); if(b) return b; b = document.createElement('div'); b.id='__gp_btn'; b.textContent='🎮'; b.addEventListener('click',function(e){e.stopPropagation();brief();}); document.body.appendChild(b); return b; }

  function render(){
    var hud = ch(), m = MODES[MODE], rows='';
    m.buttons.forEach(function(btn,i){
      var last = i === m.buttons.length - 1;
      rows += '<div style="display:flex;align-items:center;gap:10px;padding:5px 0;'+(last?'':'border-bottom:1px solid rgba(255,255,255,.05);')+'"><span style="flex-shrink:0;min-width:86px;display:inline-flex;align-items:center;justify-content:center;background:'+m.accentSoft+';border:1px solid '+m.accent+'50;color:'+m.accent+';padding:3px 9px;border-radius:6px;font-size:10px;font-weight:700;font-family:Consolas,monospace;white-space:nowrap;">'+btn.key+'</span><span style="color:rgba(255,255,255,.88);font-size:11.5px;">'+btn.fn+'</span></div>';
    });
    hud.innerHTML = '<div style="position:relative;background:linear-gradient(145deg,rgba(18,18,24,.94) 0%,rgba(28,28,38,.90) 100%);backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%);border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:14px 16px;box-shadow:0 12px 40px rgba(0,0,0,.5);overflow:hidden;"><div style="position:absolute;left:0;top:16px;bottom:16px;width:3px;background:'+m.accent+';border-radius:0 4px 4px 0;box-shadow:0 0 16px '+m.accent+'80;"></div><div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;padding-left:8px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.08);"><div style="width:42px;height:42px;border-radius:12px;background:'+m.accentSoft+';border:1px solid '+m.accent+'40;display:flex;align-items:center;justify-content:center;font-size:22px;">'+m.emoji+'</div><div style="flex:1;"><div style="font-size:9.5px;letter-spacing:2.5px;color:'+m.accent+';font-weight:700;opacity:.8;">CONTROLLER</div><div style="font-size:17px;font-weight:700;color:#fff;">'+m.name+'</div></div></div><div style="padding-left:8px;">'+rows+'</div><div style="padding:10px 8px 0;margin-top:6px;border-top:1px solid rgba(255,255,255,.08);font-size:10.5px;color:rgba(255,255,255,.55);"><span style="display:inline-flex;align-items:center;gap:5px;background:'+m.accentSoft+';border:1px solid '+m.accent+'60;color:'+m.accent+';padding:2px 9px;border-radius:6px;font-weight:700;font-size:9.5px;">⟵ BACK</span> <span>switch mode</span></div></div>';
  }

  function show(){ if(!active) return; var h=ch(), b=document.getElementById('__gp_btn'); if(b) b.classList.add('gp-hidden'); h.classList.remove('gp-hide'); h.classList.add('gp-show'); h.style.display='block'; }
  function hide(){ var h=document.getElementById('__gp_hud'), b=document.getElementById('__gp_btn'); if(b) b.classList.remove('gp-hidden'); if(h){ h.classList.remove('gp-show'); h.classList.add('gp-hide'); setTimeout(function(){ if(h) h.style.display='none'; },350); } }
  function brief(){ if(!active) return; render(); show(); if(hideTimer) clearTimeout(hideTimer); hideTimer = setTimeout(hide, HUD_HIDE); }
  function destroy(){ var h=document.getElementById('__gp_hud'), b=document.getElementById('__gp_btn'); if(h) try{h.remove();}catch(e){} if(b) try{b.remove();}catch(e){} }

  var active = false, backAt = 0, backLong = false;

  function toggle(){
    rAll(); if(lm) rmv('left'); if(rm) rmv('right');
    MODE = MODE === 'foot' ? 'vehicle' : MODE === 'vehicle' ? 'air' : 'foot';
    brief(); lock();
  }

  function poll(){
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    var gp = null;
    for (var i=0;i<pads.length;i++) if(pads[i]){gp=pads[i];break;}

    if (gp && !active) { active=true; cb(); brief(); }
    else if (!gp && active) { active=false; destroy(); rAll(); if(lm) rmv('left'); if(rm) rmv('right'); }

    if (gp) {
      var map = MODE_MAP[MODE];

      gp.buttons.forEach(function(b,i){
        if (i===8) {
          if (b.pressed && backAt===0) { backAt=Date.now(); backLong=false; }
          else if (b.pressed && backAt>0) { if (!backLong && Date.now()-backAt>BT) { backLong=true; pk('Backspace'); } }
          else if (!b.pressed && backAt>0) {
            var d = Date.now()-backAt;
            if (!backLong && d<BT) toggle();
            if (backLong) rk('Backspace');
            backAt=0; backLong=false;
          }
          return;
        }
        var code = map[i];
        if (!code) return;
        if (b.pressed) pk(code); else rk(code);
      });

      var ltV = gp.buttons[6] ? (gp.buttons[6].value||0) : 0;
      var rtV = gp.buttons[7] ? (gp.buttons[7].value||0) : 0;
      var ltOn = ltV>TT, rtOn = rtV>TT;

      if (MODE==='foot') {
        if (ltOn) hm('right'); else rmv('right');
        if (rtOn) hm('left'); else rmv('left');
      } else {
        if (rtOn) pk('KeyW'); else rk('KeyW');
        if (ltOn) pk('KeyS'); else rk('KeyS');
      }

      var lx = gp.axes[0]||0, ly = gp.axes[1]||0;

      if (MODE==='air') {
        if (Math.abs(lx)>DZ) { if(lx>0){pk('Numpad6');rk('Numpad4');} else {pk('Numpad4');rk('Numpad6');} }
        else { rk('Numpad4'); rk('Numpad6'); }
      } else {
        if (Math.abs(lx)>DZ) { if(lx>0){pk('KeyD');rk('KeyA');} else {pk('KeyA');rk('KeyD');} }
        else { rk('KeyA'); rk('KeyD'); }
      }

      if (MODE==='foot') {
        if (Math.abs(ly)>DZ) { if(ly>0){pk('KeyS');rk('KeyW');} else {pk('KeyW');rk('KeyS');} }
        else { rk('KeyW'); rk('KeyS'); }
      } else if (MODE==='air') {
        if (Math.abs(ly)>DZ) { if(ly>0){pk('Numpad5');rk('Numpad8');} else {pk('Numpad8');rk('Numpad5');} }
        else { rk('Numpad5'); rk('Numpad8'); }
      }

      var rx = gp.axes[2]||0, ry = gp.axes[3]||0;
      var curve = function(v){ return Math.sign(v)*v*v; };
      if (Math.abs(rx)>DZ) mv(curve(rx)*SENS, 0);
      if (Math.abs(ry)>DZ) mv(0, curve(ry)*SENS);
    }
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);

  window.addEventListener('gamepadconnected', function(){
    active=true; cb(); brief();
    var c = gc();
    if (c) {
      c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
      setTimeout(function(){ c.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0})); }, 30);
      setTimeout(lock, 200); setTimeout(lock, 600); setTimeout(lock, 1500);
    }
  });
  window.addEventListener('gamepaddisconnected', function(){
    active=false; destroy(); rAll(); if(lm) rmv('left'); if(rm) rmv('right');
  });

  function wire(){ var c=gc(); if(!c||c.__gpWired) return; c.__gpWired=true; c.addEventListener('mousedown', lock); c.addEventListener('click', lock); }
  wire(); setInterval(wire, 2000);

  window.__gamepad = {toggle:toggle, getMode:function(){return MODE;}, isConnected:function(){return active;}};
})();
<\/script>`;
}

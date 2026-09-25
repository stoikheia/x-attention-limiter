// Content script for X: post tracking, Attention Cost model, `+xxx pt` badges,
// Attention meter, BLACKOUT / BLOCK overlays. Runs at document_start, top frame only.
//
// The service worker owns the global state; this script only measures while the
// worker says this tab is `active`, and reports deltas once per second.
(() => {
  'use strict';
  if (window.top !== window) return;
  if (window.__xalLoaded) return;
  window.__xalLoaded = true;

  // Only the real X hosts; other subdomains (help.x.com, ads.x.com, ...) are never overlaid.
  const X_HOST_RE = /^(www\.|mobile\.)?(x|twitter)\.com$/;
  if (!X_HOST_RE.test(location.hostname)) return;

  // UI strings (SPEC §9, §13, §14, §17). Localize here; a locale file would go in .english-only-ignore.
  const STRINGS = {
    restricted: 'Restriction active',
    resetDone: 'Reset done',
    resume: 'Return to X',
    resumeAfterUnlimited: 'Return to X during the controlled period',
    blockedTitle: 'Attention Limit reached',
    blockedBody: 'X has been stopped',
    idle: 'X is in use elsewhere. Click here to use it in this window.',
    meter: 'Attention',
    pending: 'Limit reached — finish what is on screen',
    pendingReplies: 'Limit reached — finish this thread',
    masked: 'Hidden — limit reached',
    home: 'Home',
    search: 'Search:',
    profile: 'Profile',
    bookmarks: 'Bookmarks',
    notifications: 'Notifications',
    messages: 'Messages',
    explore: 'Explore',
    list: 'List',
    compose: 'Compose',
    post: 'Post',
    lastViewed: 'last viewed',
    opened: 'opened',
  };

  const MAX_RECORDS = 1500; // LRU cap on tracked posts per tab
  const RECORD_IDLE_MS = 30 * 60e3; // records unseen for this long are evicted
  const MAX_INTERACTIONS = 50;

  const TAB_TIMES_KEY = 'xal.tabTimes';
  let openedAt = null;
  let lastViewedAt = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(TAB_TIMES_KEY));
    if (Number.isFinite(saved?.openedAt)) openedAt = saved.openedAt;
    if (Number.isFinite(saved?.lastViewedAt)) lastViewedAt = saved.lastViewedAt;
  } catch {
    // Storage may be unavailable; keep tab times in memory.
  }
  if (openedAt === null) {
    openedAt = Date.now();
    persistTabTimes();
  }

  function persistTabTimes() {
    try {
      sessionStorage.setItem(TAB_TIMES_KEY, JSON.stringify({ lastViewedAt, openedAt }));
    } catch {
      // Storage may be unavailable; keep tab times in memory.
    }
  }

  // Mirrors DEFAULT_SETTINGS.cost in src/shared/defaults.js; replaced by the worker's copy on connect.
  const S = {
    tabId: null,
    active: false,
    mode: 'INACTIVE',
    unlimited: false,
    resetDone: false,
    debug: true,
    consumed: 0,
    limit: 10000,
    minCost: 5,
    fromUnlimited: false,
    blockPending: false, // LIMIT reached; what is on screen may still be finished
    blockPendingTabId: null,
    session: null, // worker session counter; changes on FULL RESET
    block: {
      tolerancePx: 120,
      maxPendingMs: 300000,
      onNavigation: true,
      repliesFirst: true,
    },
    cost: {
      basePtPerSec: 10,
      minVisibleRatio: 0.15,
      edgeWeight: 0.2,
      positionCurve: 1.5,
      scrollingFactor: 0.4,
      scrollIdleMs: 300,
      scrollResetPx: 60,
      dwellAccelSec: 20,
      dwellAccelMax: 2,
      videoFactor: 1.5,
      detailPtPerSec: 15,
      detailMinMs: 3000,
      detailBonus: 30,
      mediaMinMs: 2000,
      mediaBonus: 40,
      likeBonus: 50,
      bookmarkBonus: 80,
      replyBonus: 40,
      repostBonus: 30,
      externalLinkBonus: 60,
    },
  };

  let torndown = false;
  // Badges are tagged with the instance that created them, so a re-injected script (extension
  // reload) can remove leftovers of an orphaned instance and an orphan removes only its own.
  const INSTANCE_ID = Math.random().toString(36).slice(2, 10);

  // ------------------------------------------------------------ worker connection

  let port = null;
  let gotState = false;
  let reconnectDelay = 1000;
  let reconnectTimer = null;

  function scheduleReconnect() {
    if (torndown || reconnectTimer) return;
    if (document.visibilityState === 'hidden') return; // reconnect on visibilitychange instead
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function connect() {
    if (torndown || port) return;
    if (!chrome.runtime?.id) {
      teardown(); // extension reloaded or removed: this script is orphaned
      return;
    }
    try {
      port = chrome.runtime.connect({ name: 'xal' });
    } catch {
      port = null;
      if (!chrome.runtime?.id) teardown();
      else scheduleReconnect();
      return;
    }
    port.onMessage.addListener(onWorkerMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      S.active = false;
      if (!chrome.runtime?.id) teardown();
      else scheduleReconnect();
    });
    send({ type: 'visibility', visible: document.visibilityState === 'visible' });
  }

  function send(msg) {
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch {
      return false;
    }
  }

  function onWorkerMessage(msg) {
    if (msg.type === 'state') {
      reconnectDelay = 1000;
      if (gotState && S.unlimited && !msg.unlimited) S.fromUnlimited = true;
      if (msg.mode === 'ACTIVE') S.fromUnlimited = false;
      if (msg.session != null && S.session != null && msg.session !== S.session) dropUnsentDeltas();
      if (msg.session != null) S.session = msg.session;
      gotState = true;
      S.tabId = msg.tabId;
      S.active = !!msg.active;
      if (S.active) {
        lastViewedAt = Date.now();
        persistTabTimes();
        refreshOverlayContext();
      }
      S.mode = msg.mode;
      S.unlimited = !!msg.unlimited;
      S.resetDone = !!msg.resetDone;
      S.debug = !!msg.debug;
      S.consumed = msg.consumed || 0;
      S.limit = msg.limit || S.limit;
      S.blockPending = !!msg.blockPending;
      S.blockPendingTabId = msg.blockPendingTabId;
      if (msg.block) S.block = { ...S.block, ...msg.block };
      if (msg.cost) S.cost = { ...S.cost, ...msg.cost };
      if (msg.snapshot && msg.snapshot.minCost != null) S.minCost = msg.snapshot.minCost;
      syncPending();
      render();
    } else if (msg.type === 'ack') {
      S.consumed = msg.consumed;
      S.limit = msg.limit || S.limit;
      onAck(msg.seq, !!msg.accepted);
      renderMeter();
    }
  }

  function onVisibilityChange() {
    if (torndown) return;
    if (document.visibilityState === 'visible') refreshOverlayContext();
    if (!port && document.visibilityState === 'visible') connect();
    send({ type: 'visibility', visible: document.visibilityState === 'visible' });
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  // ------------------------------------------------------------ styles

  const styleEl = document.createElement('style');
  // Badge color follows X's theme (detected from the body background): dark green on the light
  // theme, light green on dim/dark, no outline.
  styleEl.textContent = `
    .xal-badge{position:absolute;left:14px;bottom:6px;z-index:5;pointer-events:none;
      font:700 12px/1 -apple-system,system-ui,sans-serif;color:#7ee787;
      letter-spacing:.02em;white-space:nowrap}
    html[data-xal-theme="light"] .xal-badge{color:#0f7b3d}
    html[data-xal-hide] .xal-badge{display:none}
    .xal-mask{position:absolute;inset:0;z-index:6;pointer-events:auto;background:#000;
      display:flex;align-items:center;justify-content:center;text-align:center;color:#9aa0a6;
      font:600 12px/1 -apple-system,system-ui,sans-serif}
    html[data-xal-hide] .xal-mask{display:none}
  `;
  (document.head || document.documentElement).appendChild(styleEl);

  let lastThemeCheckAt = 0;
  function detectTheme(now) {
    if (now - lastThemeCheckAt < 2000 || !document.body) return;
    lastThemeCheckAt = now;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor || '');
    if (!m) return;
    const lum = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
    const theme = lum > 0.5 ? 'light' : 'dark';
    if (document.documentElement.getAttribute('data-xal-theme') !== theme) document.documentElement.setAttribute('data-xal-theme', theme);
  }

  // ------------------------------------------------------------ overlay (BLACKOUT / BLOCK)

  let overlayHost = null;
  let overlayRoot = null;
  let overlayShown = false;
  let overlayContext = null;
  let lastContextRefreshAt = -Infinity;

  function clipGraphemes(text, n) {
    text = text.replace(/\s+/g, ' ').trim();
    const chars = typeof Intl.Segmenter === 'function'
      ? Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), (part) => part.segment)
      : Array.from(text);
    return chars.slice(0, n).join('') + (chars.length > n ? '…' : '');
  }

  function formatClock(ms) {
    const date = new Date(ms);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${date.getMonth() + 1}/${date.getDate()} ${hours}:${minutes}`;
  }

  function describePage() {
    updateRoute();
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const collapse = (text) => text.replace(/\s+/g, ' ').trim();
    const title = collapse(document.title.replace(/\s*\/\s*(X|Twitter)\s*$/, ''));
    const decode = (text) => {
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    };
    if (path === '/' || path === '/home') return { kind: 'home', text: STRINGS.home };
    if (path === '/search') {
      const q = new URLSearchParams(location.search).get('q') || '';
      return { kind: 'search', text: `${STRINGS.search} ${collapse(q)}`.trim() };
    }
    const hashtag = /^\/hashtag\/([^/]+)$/.exec(path);
    if (hashtag) return { kind: 'search', text: `${STRINGS.search} #${collapse(decode(hashtag[1]))}` };
    if (route.detailId) {
      let el = posts.get(route.detailId)?.el;
      if (!el || !el.isConnected) {
        el = [...document.querySelectorAll('article[data-testid="tweet"]')].find((article) => extractId(article) === route.detailId);
      }
      if (!el) return { kind: 'post', text: clipGraphemes(title, 30) || STRINGS.post, pending: true };
      const meta = extractMeta(el, route.detailId);
      const author = collapse(`${meta.author} ${meta.handle}`);
      const excerpt = clipGraphemes(meta.text, 30);
      const text = author ? `${author}${excerpt ? ': ' + excerpt : ''}` : excerpt || STRINGS.post;
      return { kind: 'post', text };
    }
    if (path === '/i/bookmarks') return { kind: 'bookmarks', text: STRINGS.bookmarks };
    for (const kind of ['notifications', 'messages', 'explore', 'compose']) {
      if (path === '/' + kind || path.startsWith('/' + kind + '/')) return { kind, text: STRINGS[kind] };
    }
    if (path === '/i/lists' || path.startsWith('/i/lists/')) {
      return { kind: 'list', text: title ? `${STRINGS.list}: ${clipGraphemes(title, 30)}` : STRINGS.list };
    }
    const user = /^\/([^/]+)$/.exec(path);
    const reserved = ['home', 'search', 'hashtag', 'i', 'notifications', 'messages', 'explore', 'compose'];
    if (user && !reserved.includes(user[1])) return { kind: 'profile', text: `${STRINGS.profile} @${decode(user[1])}` };
    return { kind: 'other', text: clipGraphemes(title, 30) || location.pathname };
  }

  function refreshOverlayContext() {
    if (!overlayShown) return;
    lastContextRefreshAt = performance.now();
    overlayContext = describePage();
    const label = lastViewedAt === null ? STRINGS.opened : STRINGS.lastViewed;
    const time = formatClock(lastViewedAt === null ? openedAt : lastViewedAt);
    overlayRoot.getElementById('ctx').textContent = `${overlayContext.text} · ${label} ${time}`;
  }

  // SPEC §9 "the X content is not shown" includes moving pictures and sound.
  // Only pause covered videos; X's own autoplay decides what resumes after uncovering.
  function onPlay(e) {
    const video = e.target;
    if (!(video instanceof HTMLVideoElement)) return;
    const article = video.closest('article');
    if (overlayShown || (article && isMasked(article))) video.pause();
  }
  document.addEventListener('play', onPlay, true);

  function ensureOverlay() {
    if (overlayHost) return;
    overlayHost = document.createElement('div');
    overlayHost.id = 'xal-overlay-host';
    overlayHost.dataset.xalInst = INSTANCE_ID;
    overlayHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none';
    overlayRoot = overlayHost.attachShadow({ mode: 'closed' });
    overlayRoot.innerHTML = `
      <style>
        :host{all:initial}
        .bg{position:fixed;inset:0;background:#000;color:#e7e9ea;display:flex;align-items:center;justify-content:center;
          font:16px/1.5 -apple-system,system-ui,sans-serif;text-align:center;user-select:none}
        .box{display:flex;flex-direction:column;align-items:center;gap:22px}
        .status{font-size:15px;color:#9aa0a6;display:flex;align-items:center;gap:8px}
        .dot{width:10px;height:10px;border-radius:50%;background:#e0245e;display:inline-block}
        .dot.ok{background:#7ee787}
        .title{font-size:26px;font-weight:700;color:#fff}
        .body{font-size:15px;color:#9aa0a6}
        .ctx{color:#71767b;font-size:13px;text-align:center;max-width:70vw;display:-webkit-box;
          -webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
        button{all:unset;cursor:pointer;padding:12px 28px;border-radius:999px;background:#eff3f4;color:#0f1419;
          font:600 15px -apple-system,system-ui,sans-serif}
        button:hover{background:#d7dbdc}
      </style>
      <div class="bg"><div class="box" id="box"></div></div>`;
    // The overlay itself swallows scroll gestures (SPEC §9 "no scrolling"); the page's own
    // overflow style is never touched, since X rewrites it too and a mismatched restore left
    // the timeline unscrollable after the overlay was cleared (BJ-004).
    const swallow = (e) => {
      if (overlayShown) e.preventDefault();
    };
    overlayHost.addEventListener('wheel', swallow, { passive: false });
    overlayHost.addEventListener('touchmove', swallow, { passive: false });
    document.documentElement.appendChild(overlayHost);
  }

  function blockKeys(e) {
    if (!overlayShown) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // keep browser-level shortcuts
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  window.addEventListener('keydown', blockKeys, true);
  window.addEventListener('keyup', blockKeys, true);
  window.addEventListener('keypress', blockKeys, true);

  function showOverlay(kind, opts) {
    ensureOverlay();
    const box = overlayRoot.getElementById('box');
    if (kind === 'blackout') {
      const ok = opts ? !!opts.resetDone : S.resetDone;
      const label = S.fromUnlimited ? STRINGS.resumeAfterUnlimited : STRINGS.resume;
      box.innerHTML = `
        <div class="status"><span class="dot ${ok ? 'ok' : ''}"></span><span>${ok ? STRINGS.resetDone : STRINGS.restricted}</span></div>
        <div class="ctx" id="ctx"></div>
        <button id="resume">${label}</button>`;
      box.querySelector('#resume').addEventListener('click', () => {
        S.fromUnlimited = false;
        send({ type: 'resume' });
      });
    } else if (kind === 'idle') {
      // This tab is not the focused X tab; focusing it (any click) makes the worker re-evaluate.
      box.innerHTML = `<div class="status"><span class="dot"></span><span>${STRINGS.idle}</span></div>
        <div class="ctx" id="ctx"></div>`;
    } else {
      box.innerHTML = `
        <div class="title">${STRINGS.blockedTitle}</div>
        <div class="body">${STRINGS.blockedBody}</div>
        <div class="ctx" id="ctx"></div>`;
    }
    if (!overlayShown) {
      overlayShown = true;
      overlayHost.style.display = 'block';
      for (const video of document.querySelectorAll('video')) video.pause();
    }
    refreshOverlayContext();
  }

  function hideOverlay() {
    if (!overlayShown) return;
    overlayShown = false;
    overlayHost.style.display = 'none';
  }

  // Pre-render the overlay from the last persisted mode so the page is never briefly readable
  // while the worker cold-starts (SPEC §9).
  function preRenderFromStorage() {
    try {
      chrome.storage.local.get(['state', 'settings'], (r) => {
        if (gotState || torndown || chrome.runtime.lastError) return;
        const st = r && r.state;
        if (!st || st.unlimited) return;
        if (st.mode === 'INACTIVE') showOverlay('blackout', { resetDone: !!st.resetDone });
        else if (st.mode === 'BLOCKED') showOverlay('block');
      });
    } catch {
      /* storage unavailable: wait for the worker */
    }
  }

  // ------------------------------------------------------------ meter

  let meterHost = null;
  let meterRoot = null;
  const METER_BLOCKS = 12;

  function ensureMeter() {
    if (meterHost) return;
    meterHost = document.createElement('div');
    meterHost.id = 'xal-meter-host';
    meterHost.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;pointer-events:none;display:none';
    meterRoot = meterHost.attachShadow({ mode: 'closed' });
    meterRoot.innerHTML = `
      <style>
        :host{all:initial}
        .m{background:rgba(0,0,0,.72);color:#e7e9ea;border-radius:10px;padding:8px 10px;
          font:11px/1.3 -apple-system,system-ui,sans-serif;min-width:120px;backdrop-filter:blur(4px)}
        .m.pending{border-top:2px solid #e0245e}
        .p{margin-top:5px;color:#ffb3c4;font-weight:600;white-space:nowrap}
        .l{color:#9aa0a6;font-size:10px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}
        .bar{display:flex;gap:2px}
        .b{width:8px;height:12px;border-radius:2px;background:#3a3f44}
        .b.on{background:#7ee787}
        .b.hot{background:#f2a33a}
        .b.crit{background:#e0245e}
        .d{margin-top:5px;color:#c9d1d9;font-variant-numeric:tabular-nums;white-space:nowrap}
      </style>
      <div class="m" id="m"><div class="l">${STRINGS.meter}</div><div class="bar" id="bar"></div>
        <div class="p" id="p">${STRINGS.pending}</div><div class="d" id="d"></div></div>`;
    const bar = meterRoot.getElementById('bar');
    for (let i = 0; i < METER_BLOCKS; i++) {
      const b = document.createElement('span');
      b.className = 'b';
      bar.appendChild(b);
    }
    document.documentElement.appendChild(meterHost);
  }

  function renderMeter() {
    ensureMeter();
    const show = gotState && !S.unlimited;
    meterHost.style.display = show ? 'block' : 'none';
    if (!show) return;
    const ratio = S.limit > 0 ? Math.min(1, S.consumed / S.limit) : 0;
    // While pending the bar is full and critical whatever the ratio: the limit is already reached.
    const pending = S.blockPending && S.mode === 'ACTIVE' && !S.unlimited;
    const on = pending ? METER_BLOCKS : Math.round(ratio * METER_BLOCKS);
    const blocks = meterRoot.querySelectorAll('.b');
    blocks.forEach((b, i) => {
      b.className = 'b' + (i < on ? (pending || ratio >= 0.9 ? ' crit' : ratio >= 0.7 ? ' hot' : ' on') : '');
    });
    meterRoot.getElementById('m').className = 'm' + (pending ? ' pending' : '');
    const p = meterRoot.getElementById('p');
    p.style.display = pending ? '' : 'none'; // shown outside Debug too
    p.textContent = pend.armed && pend.stage === 'replies' ? STRINGS.pendingReplies : STRINGS.pending;
    const d = meterRoot.getElementById('d');
    if (S.debug) {
      d.style.display = '';
      d.textContent = `${Math.round(S.consumed).toLocaleString()} / ${S.limit.toLocaleString()} pt (${(ratio * 100).toFixed(1)}%) · ${S.mode}${S.active ? '' : ' · idle'}`;
    } else {
      d.style.display = 'none';
    }
  }

  function render() {
    if (S.unlimited) {
      document.documentElement.setAttribute('data-xal-hide', '');
      hideOverlay();
    } else {
      document.documentElement.removeAttribute('data-xal-hide');
      if (S.mode === 'INACTIVE') showOverlay('blackout');
      else if (S.mode === 'BLOCKED') showOverlay('block');
      else if (!S.active) showOverlay('idle'); // ACTIVE elsewhere: no free reading in other windows (SPEC §9)
      else hideOverlay();
    }
    renderMeter();
  }

  // ------------------------------------------------------------ post registry

  const posts = new Map(); // id -> record
  const elToId = new WeakMap(); // article element -> post id
  const badgeByEl = new WeakMap();
  const visibleEls = new Set();
  let viewCounter = 0;

  function emptyRecord(id) {
    return {
      id,
      cost: 0,
      breakdown: {},
      timelineDwellMs: 0,
      detailDwellMs: 0,
      videoMs: 0,
      interactions: [],
      newInter: [], // interactions not yet delivered to the worker
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      viewOrder: ++viewCounter,
      stationaryMs: 0,
      stationaryY: window.scrollY,
      detailBonusGiven: false,
      mediaBonusKeys: new Set(),
      bonus: {}, // granted interaction bonuses by type, so an undo can take them back
      meta: null,
      metaComplete: false,
      metaSent: false,
      dirty: false,
      sentCost: 0,
      snap: { cost: 0, breakdown: {}, timelineDwellMs: 0, detailDwellMs: 0, videoMs: 0 },
      el: null,
    };
  }

  function getOrCreate(id) {
    let rec = posts.get(id);
    if (!rec) {
      rec = emptyRecord(id);
      posts.set(id, rec);
    }
    return rec;
  }

  // Evict idle records so a day-long infinite scroll does not grow the heap without bound.
  function evictRecords() {
    if (posts.size <= MAX_RECORDS) return;
    const now = Date.now();
    const candidates = [...posts.values()].filter((r) => !r.dirty && !(r.el && r.el.isConnected) && now - r.lastSeenAt > RECORD_IDLE_MS);
    candidates.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const r of candidates) {
      if (posts.size <= MAX_RECORDS) break;
      posts.delete(r.id);
    }
  }

  function isInsideQuote(node, root) {
    let n = node.parentElement;
    while (n && n !== root) {
      if (n.getAttribute('role') === 'link' && n.tagName === 'DIV') return true;
      n = n.parentElement;
    }
    return false;
  }

  // The post id is the /status/<id> link that wraps the <time> element (the header timestamp),
  // ignoring links inside a quoted post. The focal article of a detail page has no such link in
  // some layouts; there the URL's own id is used.
  function extractId(el) {
    updateRoute(); // the detail id must be current even while this tab is idle
    const links = [...el.querySelectorAll('a[href*="/status/"]')].filter((a) => !isInsideQuote(a, el));
    let a = links.find((l) => l.querySelector('time'));
    if (!a && route.detailId && el.getAttribute('tabindex') === '-1') return route.detailId;
    if (!a) a = links[0];
    if (!a) return null;
    const m = /\/status\/(\d+)/.exec(a.getAttribute('href') || '');
    return m ? m[1] : null;
  }

  function textOf(node) {
    return node ? (node.innerText || node.textContent || '').trim() : '';
  }

  function safeUrl(u) {
    if (!u) return ''; // an empty src must not resolve to the page URL
    try {
      const url = new URL(u, location.href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function parseUserName(un) {
    if (!un) return { author: '', handle: '' };
    const parts = textOf(un)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const handle = parts.find((p) => /^@\w+$/.test(p)) || '';
    const author = parts.find((p) => p && !p.startsWith('@') && p !== '·') || '';
    return { author, handle };
  }

  function extractMeta(el, id) {
    const userNames = el.querySelectorAll('[data-testid="User-Name"]');
    const texts = el.querySelectorAll('[data-testid="tweetText"]');
    const { author, handle } = parseUserName(userNames[0]);
    const text = textOf(texts[0]);
    const time = el.querySelector('a[href*="/status/"] time') || el.querySelector('time');
    const createdAt = time ? time.getAttribute('datetime') : null;
    let quote = null;
    if (texts.length > 1) {
      const q = parseUserName(userNames[1]);
      quote = { author: q.author, handle: q.handle, text: textOf(texts[1]) };
    }
    const media = [];
    for (const img of el.querySelectorAll('[data-testid="tweetPhoto"] img')) {
      const url = safeUrl(img.src);
      if (!url) continue;
      media.push({ type: 'photo', url, alt: img.alt || '', width: img.naturalWidth || null, height: img.naturalHeight || null });
    }
    for (const v of el.querySelectorAll('video')) {
      const src = v.currentSrc || v.src || '';
      media.push({ type: 'video', url: safeUrl(src), poster: safeUrl(v.poster), width: v.videoWidth || null, height: v.videoHeight || null });
    }
    const card = el.querySelector('[data-testid="card.wrapper"] a[href]');
    if (card && safeUrl(card.href)) media.push({ type: 'card', url: safeUrl(card.href), alt: textOf(card).slice(0, 200) });
    const url = handle ? `https://x.com/${handle.slice(1)}/status/${id}` : `https://x.com/i/status/${id}`;
    return { url, author, handle, text, createdAt, quote, media };
  }

  function refreshMeta(rec) {
    const el = rec.el;
    if (!el || !el.isConnected) return;
    const m = extractMeta(el, rec.id);
    rec.meta = m;
    rec.metaComplete = !!(m.author && (m.text || m.media.length));
    rec.metaSent = false;
  }

  function attachBadge(el, rec) {
    let b = badgeByEl.get(el);
    if (!b) {
      for (const stale of el.querySelectorAll('.xal-badge')) if (stale.dataset.xalInst !== INSTANCE_ID) stale.remove();
      b = document.createElement('span');
      b.className = 'xal-badge';
      b.dataset.xalInst = INSTANCE_ID;
      try {
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      } catch {
        /* ignore */
      }
      el.appendChild(b);
      badgeByEl.set(el, b);
    }
    b.textContent = rec.cost > 0 ? `+${Math.round(rec.cost)} pt` : '';
  }

  function bindElement(el, id) {
    elToId.set(el, id);
    const rec = getOrCreate(id);
    rec.el = el;
    if (!rec.metaComplete) refreshMeta(rec);
    attachBadge(el, rec);
    maskPost(el, id); // a post that arrives while pending was not on screen at arming time
    return rec;
  }

  function register(el) {
    if (elToId.has(el)) {
      // Re-attached node (released on removal): observe again; observe() is idempotent.
      const id = elToId.get(el);
      const rec = posts.get(id);
      if (rec && !rec.el) rec.el = el;
      maskPost(el, id);
      io.observe(el);
      return id;
    }
    const id = extractId(el);
    if (!id) return null; // not cached: a later mutation inside the article retries
    bindElement(el, id);
    io.observe(el);
    return id;
  }

  function releaseElement(el) {
    io.unobserve(el);
    visibleEls.delete(el);
    const id = elToId.get(el);
    const rec = id && posts.get(id);
    if (rec && rec.el === el) rec.el = null;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visibleEls.add(e.target);
        else visibleEls.delete(e.target);
      }
    },
    { threshold: 0 }
  );

  function scan(root) {
    if (!(root instanceof Element)) return;
    if (root.matches('article[data-testid="tweet"]')) register(root);
    else {
      const parent = root.closest('article[data-testid="tweet"]');
      if (parent) register(parent);
    }
    for (const el of root.querySelectorAll('article[data-testid="tweet"]')) register(el);
  }

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) scan(n);
      for (const n of m.removedNodes) {
        if (!(n instanceof Element)) continue;
        if (elToId.has(n)) releaseElement(n);
        for (const el of n.querySelectorAll('article[data-testid="tweet"]')) if (elToId.has(el)) releaseElement(el);
      }
    }
    if (overlayShown && overlayContext?.pending && performance.now() - lastContextRefreshAt >= 500) refreshOverlayContext();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // ------------------------------------------------------------ signals: scroll, route, clicks

  let lastScrollAt = 0;
  const onScroll = () => (lastScrollAt = performance.now());
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('wheel', onScroll, { passive: true, capture: true });

  const route = { path: null, detailId: null, mediaId: null, mediaKey: null, mediaMs: 0 };

  function updateRoute() {
    const p = location.pathname;
    if (p === route.path) return;
    route.path = p;
    const m = /\/status\/(\d+)/.exec(p);
    const newDetail = m ? m[1] : null;
    if (newDetail && newDetail !== route.detailId) {
      const rec = getOrCreate(newDetail);
      pushInteraction(rec, { type: 'detail-open', ts: Date.now() });
      rec.dirty = true;
    }
    route.detailId = newDetail;
    const mm = /\/status\/(\d+)\/(photo|video)\/(\d+)/.exec(p);
    if (mm) {
      if (route.mediaKey !== mm[0]) route.mediaMs = 0;
      route.mediaId = mm[1];
      route.mediaKey = mm[0];
    } else {
      route.mediaId = null;
      route.mediaKey = null;
      route.mediaMs = 0;
    }
  }

  function pushInteraction(rec, it) {
    rec.interactions.push(it);
    if (rec.interactions.length > MAX_INTERACTIONS) rec.interactions.splice(0, rec.interactions.length - MAX_INTERACTIONS);
    rec.newInter.push(it);
    if (rec.newInter.length > MAX_INTERACTIONS) rec.newInter.splice(0, rec.newInter.length - MAX_INTERACTIONS);
  }

  function addCost(rec, delta, breakdown) {
    if (!(delta > 0)) return;
    rec.cost += delta;
    for (const [k, v] of Object.entries(breakdown)) rec.breakdown[k] = (rec.breakdown[k] || 0) + v;
    rec.lastSeenAt = Date.now();
    rec.dirty = true;
  }

  function interact(rec, type, bonus, extra) {
    pushInteraction(rec, { type, ts: Date.now(), ...(extra || {}) });
    addCost(rec, bonus, { interaction: bonus });
    rec.bonus[type] = (rec.bonus[type] || 0) + bonus;
    rec.dirty = true;
  }

  // Undoing a Like / Bookmark / Repost takes back the bonus it granted (never more than that):
  // during tuning the signal of interest is sustained interest in the post, not the click itself.
  function revoke(rec, type, undoType) {
    pushInteraction(rec, { type: undoType, ts: Date.now() });
    const amount = rec.bonus[type] || 0;
    if (amount > 0) {
      rec.bonus[type] = 0;
      rec.cost = Math.max(0, rec.cost - amount);
      rec.breakdown.interaction = (rec.breakdown.interaction || 0) - amount;
    }
    rec.dirty = true;
  }

  const onClick = (e) => {
    if (!S.active) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const C = S.cost;
    const article = t.closest('article[data-testid="tweet"]');
    const recOfArticle = () => {
      if (!article) return route.detailId ? getOrCreate(route.detailId) : null;
      const id = register(article);
      return id ? getOrCreate(id) : null;
    };
    const btn = t.closest('[data-testid]');
    const tid = btn ? btn.getAttribute('data-testid') : '';
    const map = { like: ['like', C.likeBonus], bookmark: ['bookmark', C.bookmarkBonus], reply: ['reply', C.replyBonus], retweet: ['repost', C.repostBonus] };
    if (map[tid]) {
      const rec = recOfArticle();
      if (rec) interact(rec, map[tid][0], map[tid][1]);
      return;
    }
    const undo = { unlike: ['like', 'unlike'], removeBookmark: ['bookmark', 'unbookmark'], unretweet: ['repost', 'unrepost'] };
    if (undo[tid]) {
      const rec = recOfArticle();
      if (rec) revoke(rec, undo[tid][0], undo[tid][1]);
      return;
    }
    const a = t.closest('a[href]');
    if (a) {
      try {
        const u = new URL(a.getAttribute('href'), location.href);
        if (/^https?:$/.test(u.protocol) && !X_HOST_RE.test(u.hostname)) {
          const rec = recOfArticle();
          if (rec) interact(rec, 'external-link', C.externalLinkBonus, { url: u.href.slice(0, 300) });
        }
      } catch {
        /* ignore */
      }
    }
  };
  document.addEventListener('click', onClick, true);

  function playingVideo(el) {
    for (const v of el.querySelectorAll('video')) if (!v.paused && !v.ended && v.readyState > 2) return true;
    return false;
  }

  // ------------------------------------------------------------ BLOCK_PENDING (SPEC Amendments v0.3)

  // The LIMIT is reached, but the post being read is not cut in half: the posts that were on
  // screen at that moment may be finished, and X ends as soon as new information arrives. Every
  // other post is covered by an opaque mask, so the scroll tolerance cannot buy extra reading.
  //
  // On a post's detail page the window opens in the `replies` stage instead (A2): its replies are
  // part of finishing the post, so nothing is masked and only leaving the post ends the window.
  // When the stage runs out of time the `extent` stage above takes over from that moment.
  const pend = { armed: false, stage: 'extent', armedAt: 0, top: 0, bottom: 0, path: null, detailId: null, sent: false, allowed: new Set() };
  const masks = new Set();
  let maskByEl = new WeakMap();
  let pendingTabNavigationSent = false;

  function armPending() {
    updateRoute();
    pend.armed = true;
    pend.sent = false;
    if (S.block.repliesFirst && route.detailId) {
      pend.stage = 'replies';
      pend.armedAt = Date.now();
      pend.path = location.pathname;
      pend.detailId = route.detailId;
      pend.top = 0;
      pend.bottom = 0;
      pend.allowed = new Set();
      return;
    }
    enterExtentStage();
  }

  // Start (or switch to) the extent stage: the posts on screen right now may be finished, every
  // other one is masked, and the pending clock restarts from this moment.
  function enterExtentStage() {
    updateRoute();
    const H = window.innerHeight;
    const sy = window.scrollY;
    let top = Infinity;
    let bottom = -Infinity;
    const allowed = new Set();
    for (const rec of posts.values()) {
      if (!rec.el || !rec.el.isConnected) continue;
      const r = rec.el.getBoundingClientRect();
      if (r.height <= 0 || r.bottom <= 0 || r.top >= H) continue;
      top = Math.min(top, r.top + sy);
      bottom = Math.max(bottom, r.bottom + sy);
      allowed.add(rec.id); // a partially visible post is allowed in full: it is being read
    }
    if (!(top < bottom)) {
      top = sy; // no post on screen (DMs, settings): the viewport itself is the extent
      bottom = sy + H;
    }
    pend.armed = true;
    pend.stage = 'extent';
    pend.armedAt = Date.now();
    pend.top = top;
    pend.bottom = bottom;
    pend.path = location.pathname; // re-read: the replies stage may have ended on the media viewer
    pend.detailId = route.detailId;
    pend.allowed = allowed;
    applyMasks();
    renderMeter();
  }

  function disarmPending() {
    pend.armed = false;
    pend.stage = 'extent';
    pend.allowed = new Set();
    for (const m of masks) m.remove();
    masks.clear();
    maskByEl = new WeakMap();
  }

  function maskPost(el, id) {
    if (!pend.armed || pend.stage !== 'extent' || !id || pend.allowed.has(id)) return;
    const cur = maskByEl.get(el);
    if (cur && cur.isConnected) {
      masks.add(cur);
      return;
    }
    const m = document.createElement('div');
    m.className = 'xal-mask';
    m.dataset.xalInst = INSTANCE_ID;
    m.textContent = STRINGS.masked;
    try {
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    } catch {
      /* ignore */
    }
    el.appendChild(m);
    maskByEl.set(el, m);
    masks.add(m);
    for (const video of el.querySelectorAll('video')) video.pause();
  }

  function applyMasks() {
    if (!pend.armed || pend.stage !== 'extent') return;
    for (const m of masks) if (!m.isConnected) masks.delete(m);
    for (const rec of posts.values()) if (rec.el && rec.el.isConnected) maskPost(rec.el, rec.id);
  }

  function isMasked(el) {
    const m = maskByEl.get(el);
    return !!(m && m.isConnected);
  }

  // Mirrors shouldBlock() in src/shared/blockpending.js (content scripts cannot import modules);
  // keep the two in sync. Precedence when several conditions hold: navigation > timeout > scroll.
  // 'stage2' is a non-blocking sentinel: the replies stage is over and the extent stage takes over.
  function pendingReason(now) {
    const B = S.block;
    const replies = pend.stage === 'replies';
    const routeChanged = location.pathname !== pend.path;
    const sameDetail = pend.detailId != null && route.detailId === pend.detailId && /\/status\/\d+(\/(photo|video)\/\d+)?\/?$/.test(location.pathname);
    if (routeChanged && B.onNavigation && !(replies && sameDetail)) return 'navigation';
    if (now - pend.armedAt > B.maxPendingMs) return replies ? 'stage2' : 'timeout';
    if (replies) return null; // the replies of the post being finished: scrolling is not new information
    if (window.scrollY < pend.top - B.tolerancePx || window.scrollY + window.innerHeight > pend.bottom + B.tolerancePx) return 'scroll';
    return null;
  }

  function syncPending() {
    if (!S.blockPending) pendingTabNavigationSent = false;
    const want = S.blockPending && S.active && S.mode === 'ACTIVE' && !S.unlimited;
    if (want && S.blockPendingTabId != null && S.blockPendingTabId !== S.tabId) {
      if (pend.armed) disarmPending();
      if (!pendingTabNavigationSent && send({ type: 'blockNow', reason: 'navigation' })) pendingTabNavigationSent = true;
      return;
    }
    if (want && !pend.armed) armPending();
    else if (!want && pend.armed) disarmPending();
  }

  // ------------------------------------------------------------ measurement tick (100 ms)

  let lastTick = performance.now();
  let lastRekeyAt = 0;

  // X may reconcile a different post into an already-registered <article>; re-key when the id moved.
  function revalidateIds() {
    for (const el of visibleEls) {
      const cur = elToId.get(el);
      const fresh = extractId(el);
      if (fresh && cur !== fresh) {
        const old = cur && posts.get(cur);
        if (old && old.el === el) old.el = null;
        const mask = maskByEl.get(el);
        if (mask) {
          mask.remove();
          masks.delete(mask);
        }
        maskByEl.delete(el);
        bindElement(el, fresh);
      }
    }
  }

  function measure(dt, now) {
    const C = S.cost;
    const H = window.innerHeight;
    const scrolling = now - lastScrollAt < C.scrollIdleMs;
    const sy = window.scrollY;
    const nowMs = Date.now();

    for (const el of visibleEls) {
      if (!el.isConnected) {
        releaseElement(el);
        continue;
      }
      const id = elToId.get(el);
      const rec = id && posts.get(id);
      if (!rec) continue;
      if (isMasked(el)) continue; // covered while pending: nothing to read, nothing to charge
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || r.bottom <= 0 || r.top >= H) continue;
      const visTop = Math.max(r.top, 0);
      const visBot = Math.min(r.bottom, H);
      const vis = (visBot - visTop) / Math.min(r.height, H);
      if (vis < C.minVisibleRatio) continue;

      const center = (visTop + visBot) / 2;
      const d = Math.min(1, Math.abs(center - H / 2) / (H / 2));
      const pos = C.edgeWeight + (1 - C.edgeWeight) * Math.pow(1 - d, C.positionCurve);

      rec.lastSeenAt = nowMs;
      rec.timelineDwellMs += dt * 1000;
      rec.dirty = true;

      let mult;
      if (scrolling || Math.abs(sy - rec.stationaryY) > C.scrollResetPx) {
        rec.stationaryMs = 0;
        rec.stationaryY = sy;
        mult = scrolling ? C.scrollingFactor : 1;
      } else {
        rec.stationaryMs += dt * 1000;
        mult = 1 + Math.min(C.dwellAccelMax, rec.stationaryMs / 1000 / C.dwellAccelSec);
      }
      const base = C.basePtPerSec * dt * vis * pos;
      let delta = base * mult;
      const bd = mult >= 1 ? { timeline: base, dwell: base * (mult - 1) } : { timeline: delta };
      if (playingVideo(el)) {
        rec.videoMs += dt * 1000;
        const extra = delta * (C.videoFactor - 1);
        delta += extra;
        bd.video = extra;
      }
      addCost(rec, delta, bd);
    }

    const detailRec = posts.get(route.detailId);
    if (route.detailId && !(detailRec && detailRec.el && isMasked(detailRec.el))) {
      const rec = getOrCreate(route.detailId);
      rec.detailDwellMs += dt * 1000;
      addCost(rec, C.detailPtPerSec * dt, { detail: C.detailPtPerSec * dt });
      if (!rec.detailBonusGiven && rec.detailDwellMs >= C.detailMinMs) {
        rec.detailBonusGiven = true;
        interact(rec, 'detail', C.detailBonus, { dwellMs: Math.round(rec.detailDwellMs) });
      }
    }
    const mediaRec = posts.get(route.mediaId);
    if (route.mediaId && !(mediaRec && mediaRec.el && isMasked(mediaRec.el))) {
      route.mediaMs += dt * 1000;
      const rec = getOrCreate(route.mediaId);
      if (route.mediaMs >= C.mediaMinMs && !rec.mediaBonusKeys.has(route.mediaKey)) {
        rec.mediaBonusKeys.add(route.mediaKey);
        interact(rec, 'media', C.mediaBonus, { path: route.mediaKey });
      }
    }
  }

  function renderBadges() {
    for (const el of visibleEls) {
      const id = elToId.get(el);
      const rec = id && posts.get(id);
      const b = badgeByEl.get(el);
      if (!rec || !b) continue;
      const txt = rec.cost > 0 ? `+${Math.round(rec.cost)} pt` : '';
      if (b.textContent !== txt) b.textContent = txt;
      if (S.debug) {
        const parts = Object.entries(rec.breakdown).map(([k, v]) => `${k} ${Math.round(v)}`);
        const title = `${parts.join(' · ')} · tl ${(rec.timelineDwellMs / 1000).toFixed(1)}s`;
        if (b.title !== title) b.title = title;
      }
    }
  }

  let lastEvictAt = 0;

  function tick() {
    const now = performance.now();
    const dt = Math.min((now - lastTick) / 1000, 0.5);
    lastTick = now;
    updateRoute(); // also while idle: the detail id is needed to identify the focal article
    detectTheme(now);
    if (now - lastEvictAt > 30000) {
      lastEvictAt = now;
      evictRecords(); // records are created while browsing in any state, so evict in any state
    }
    // Idle tabs (BLACKOUT, BLOCKED, UNLIMITED, unfocused) do no work beyond this point.
    if (!S.active || document.visibilityState !== 'visible' || overlayShown) return;
    if (pend.armed || now - lastRekeyAt > 1000) {
      lastRekeyAt = now;
      revalidateIds();
    }
    if (pend.armed) {
      applyMasks();
      if (!pend.sent) {
        const reason = pendingReason(Date.now());
        if (reason === 'stage2') enterExtentStage();
        else if (reason && send({ type: 'blockNow', reason })) pend.sent = true;
      }
    }
    measure(dt, now);
    renderBadges();
  }
  const tickTimer = setInterval(tick, 100);

  // ------------------------------------------------------------ flush to worker (1 s)

  // Delivery protocol: every batch carries a sequence number and is held as `pending` until the
  // worker acks that number. A lost ack re-sends the same batch (the worker de-duplicates by
  // sequence), a rejected batch is rolled back so measured cost is never silently dropped, and
  // a RESET (session change) discards deltas measured in the previous session.
  let pending = null;
  let seq = 0;
  const MAX_RETRIES = 3;

  function diffObj(a, b) {
    const out = {};
    for (const [k, v] of Object.entries(a)) {
      const d = v - (b[k] || 0);
      if (d !== 0) out[k] = d;
    }
    return out;
  }

  function rollback() {
    if (!pending) return;
    for (const [id, prev] of pending.prev) {
      const rec = posts.get(id);
      if (!rec) continue;
      rec.sentCost = prev.sentCost;
      rec.snap = prev.snap;
      rec.metaSent = prev.metaSent;
      rec.newInter = prev.newInter.concat(rec.newInter);
      rec.dirty = true;
    }
    pending = null;
  }

  function onAck(ackSeq, accepted) {
    if (!pending || ackSeq !== pending.seq) return; // stale ack for an earlier batch
    if (accepted) pending = null;
    else rollback();
  }

  // The worker started a new session (FULL RESET): unsent deltas belong to the old one.
  function dropUnsentDeltas() {
    pending = null;
    for (const rec of posts.values()) {
      rec.sentCost = rec.cost;
      rec.snap = { cost: rec.cost, breakdown: { ...rec.breakdown }, timelineDwellMs: rec.timelineDwellMs, detailDwellMs: rec.detailDwellMs, videoMs: rec.videoMs };
      rec.newInter = [];
      rec.dirty = false;
    }
  }

  function flush() {
    if (torndown) return;
    if (pending) {
      if (performance.now() - pending.at <= 3000) return;
      // ack lost: re-send the same sequence (worker de-duplicates) a few times, then give up
      if (pending.tries < MAX_RETRIES && port && S.active) {
        pending.tries++;
        pending.at = performance.now();
        send({ type: 'batch', seq: pending.seq, items: pending.items });
        return;
      }
      rollback();
    }
    if (!port || !S.active) return;
    const items = [];
    const prev = new Map();
    for (const rec of posts.values()) {
      if (!rec.dirty) continue;
      rec.dirty = false;
      prev.set(rec.id, { sentCost: rec.sentCost, snap: rec.snap, metaSent: rec.metaSent, newInter: rec.newInter });
      const item = { id: rec.id, delta: rec.cost - rec.sentCost };
      rec.sentCost = rec.cost;
      if (rec.cost >= S.minCost) {
        if (!rec.metaComplete) refreshMeta(rec);
        const sn = rec.snap;
        item.snapshot = {
          costDelta: rec.cost - sn.cost,
          breakdownDelta: diffObj(rec.breakdown, sn.breakdown),
          timelineDwellMsDelta: rec.timelineDwellMs - sn.timelineDwellMs,
          detailDwellMsDelta: rec.detailDwellMs - sn.detailDwellMs,
          videoMsDelta: rec.videoMs - sn.videoMs,
          interactions: rec.newInter,
          firstSeenAt: rec.firstSeenAt,
          lastSeenAt: rec.lastSeenAt,
          meta: rec.metaSent ? undefined : rec.meta || undefined,
        };
        if (rec.meta) rec.metaSent = true;
        rec.newInter = [];
        rec.snap = {
          cost: rec.cost,
          breakdown: { ...rec.breakdown },
          timelineDwellMs: rec.timelineDwellMs,
          detailDwellMs: rec.detailDwellMs,
          videoMs: rec.videoMs,
        };
      }
      if (item.delta !== 0 || item.snapshot) items.push(item); // negative = an undone interaction
    }
    if (!items.length) return;
    seq++;
    pending = { seq, items, at: performance.now(), prev, tries: 0 };
    if (!send({ type: 'batch', seq, items })) rollback();
  }
  const flushTimer = setInterval(flush, 1000);

  // Presence heartbeat: lets the worker keep `lastActiveAt` fresh even on pages that generate
  // no cost (DMs, settings), so a browser quit is dated correctly.
  const heartbeatTimer = setInterval(() => {
    if (S.active && document.visibilityState === 'visible') send({ type: 'heartbeat' });
  }, 10000);

  // ------------------------------------------------------------ teardown (extension reloaded)

  function teardown() {
    if (torndown) return;
    torndown = true;
    clearInterval(tickTimer);
    clearInterval(flushTimer);
    clearInterval(heartbeatTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    for (const b of document.querySelectorAll('.xal-badge')) if (b.dataset.xalInst === INSTANCE_ID) b.remove();
    for (const m of document.querySelectorAll('.xal-mask')) if (m.dataset.xalInst === INSTANCE_ID) m.remove();
    masks.clear();
    hideOverlay();
    if (overlayHost) overlayHost.remove();
    if (meterHost) meterHost.remove();
    styleEl.remove();
    document.documentElement.removeAttribute('data-xal-hide');
    document.documentElement.removeAttribute('data-xal-theme');
    window.removeEventListener('keydown', blockKeys, true);
    window.removeEventListener('keyup', blockKeys, true);
    window.removeEventListener('keypress', blockKeys, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('wheel', onScroll, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('play', onPlay, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('DOMContentLoaded', bootDom);
    io.disconnect();
    mo.disconnect();
    posts.clear();
    visibleEls.clear();
    window.__xalLoaded = false;
  }

  // ------------------------------------------------------------ boot

  // Injected into an already loaded page (extension reload): clear what an orphaned older
  // instance may have left behind — badges it never removed and, from versions before BJ-004,
  // an inline `overflow: hidden` on <html> that made the timeline unscrollable.
  if (document.readyState !== 'loading') {
    for (const b of document.querySelectorAll('.xal-badge')) if (b.dataset.xalInst !== INSTANCE_ID) b.remove();
    for (const m of document.querySelectorAll('.xal-mask')) if (m.dataset.xalInst !== INSTANCE_ID) m.remove();
    if (document.documentElement.style.overflow === 'hidden') document.documentElement.style.overflow = '';
  }

  preRenderFromStorage();
  connect();
  function bootDom() {
    scan(document.documentElement);
    refreshOverlayContext();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootDom, { once: true });
  else bootDom();
})();

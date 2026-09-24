// Service worker: global state machine (SPEC §7-17, §34), reset timer, IndexedDB writer.
//
// mode      : 'ACTIVE' | 'INACTIVE' (= BLACKOUT shown on X tabs) | 'BLOCKED'
// unlimited : true while inside an UNLIMITED period; overrides everything visually
// effective : unlimited ? 'UNLIMITED' : mode   (recorded as StateEvent, SPEC §31)
//
// Absence (the RESET clock, SPEC §11) means "not on X": it runs while the user is away in any
// mode, and while looking at BLACKOUT/BLOCK. Using X during UNLIMITED is presence, not absence.

import { DEFAULT_SETTINGS, mergeSettings } from './shared/defaults.js';
import { isUnlimited, nextBoundary } from './shared/periods.js';
import { XalDB } from './shared/db.js';

const db = new XalDB();
const X_HOST_RE = /^(www\.|mobile\.)?(x|twitter)\.com$/;
const DEBUG_PAGE_PREFIX = chrome.runtime.getURL('');

let settings = structuredClone(DEFAULT_SETTINGS);
let state = {
  mode: 'INACTIVE',
  consumed: 0,
  inactiveSince: null, // start of the continuous absence (reset timer origin); null while on X
  resetDone: false, // a FULL RESET happened during the current absence
  unlimited: false,
  lastEffective: null,
  viewCounter: 0,
  blockPending: false, // LIMIT reached; the user may finish what is on screen (SPEC Amendments v0.3)
  blockPendingSince: null,
  blockReason: null, // what ended the pending window: 'scroll' | 'navigation' | 'timeout' | ...
  blockedAt: null,
  lastActiveAt: 0, // last accepted batch or heartbeat (restores the absence origin after a browser quit)
  lastPruneAt: 0,
  session: 1, // incremented on every FULL RESET; content scripts drop deltas from an older session
};

// A stored ACTIVE mode with no activity for this long means the worker was not running
// (browser quit or crash): the user left X at lastActiveAt, not now.
const STALE_ACTIVE_MS = 60e3;

const ports = new Map(); // tabId -> { port, visible, lastSeq }
let focusedWindowId = null;
let currentXTabId = null; // the X tab that currently satisfies the ACTIVE conditions
let leaveTimer = null;
let attentionBuffer = [];
let flushTimer = null;
let persistTimer = null;
let snapshotQueue = Promise.resolve();

const ready = init().catch((e) => console.error('[XAL] init failed; running on defaults', e));

async function init() {
  try {
    const stored = await chrome.storage.local.get(['settings', 'state']);
    settings = clampSettings(mergeSettings(DEFAULT_SETTINGS, stored.settings));
    if (stored.state) state = { ...state, ...stored.state };
  } catch (e) {
    console.error('[XAL] storage read failed', e);
  }
  try {
    const w = await chrome.windows.getLastFocused();
    focusedWindowId = w && w.focused ? w.id : null;
  } catch {
    focusedWindowId = null;
  }
  try {
    for (const t of await chrome.tabs.query({ active: true })) activeTabByWindow.set(t.windowId, t.id);
  } catch {
    /* fall back to queries in findFocusedXTab */
  }
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  if (state.mode === 'ACTIVE' && Date.now() - (state.lastActiveAt || 0) > STALE_ACTIVE_MS) restoreAfterBrowserStart();
  refreshUnlimited();
  checkReset();
  scheduleResetAlarm();
  // A dead content script must not be able to keep a pending session open forever.
  if (state.blockPending) scheduleBlockPendingAlarm();
  await evaluate();
  if (Date.now() - (state.lastPruneAt || 0) > 6 * 3600e3) prune();
}

// The browser was quit (or the worker died) while ACTIVE: the absence started at the last
// accepted batch or heartbeat, not now. Runs before refreshUnlimited() so an absence that
// spans an UNLIMITED period is still dated from the real departure.
function restoreAfterBrowserStart() {
  if (state.mode !== 'ACTIVE') return;
  state.mode = 'INACTIVE';
  state.inactiveSince = state.lastActiveAt || Date.now();
  state.resetDone = false;
  checkReset();
  scheduleResetAlarm();
  commit();
}

function isXUrl(url) {
  try {
    return X_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function resetMs() {
  return settings.resetHours * 3600e3;
}

// ---------------------------------------------------------------- settings

const LIMITS = {
  limit: [1, 1e9],
  resetHours: [0.01, 168],
  leaveGraceMs: [0, 20000],
};

const BLOCK_LIMITS = {
  tolerancePx: [0, 5000],
  maxPendingMs: [10000, 3600000],
};

function clampSettings(s) {
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = Number(s[k]);
    s[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_SETTINGS[k];
  }
  if (!s.block || typeof s.block !== 'object') s.block = structuredClone(DEFAULT_SETTINGS.block);
  for (const [k, [lo, hi]] of Object.entries(BLOCK_LIMITS)) {
    const v = Number(s.block[k]);
    s.block[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_SETTINGS.block[k];
  }
  s.block.onNavigation = !!s.block.onNavigation;
  for (const k of Object.keys(DEFAULT_SETTINGS.cost)) {
    const v = Number(s.cost[k]);
    s.cost[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS.cost[k];
  }
  for (const k of Object.keys(DEFAULT_SETTINGS.snapshot)) {
    const v = Number(s.snapshot[k]);
    s.snapshot[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS.snapshot[k];
  }
  if (!Array.isArray(s.unlimitedPeriods)) s.unlimitedPeriods = [];
  return s;
}

async function applySettings(next) {
  settings = clampSettings(next);
  await chrome.storage.local.set({ settings });
  refreshUnlimited();
  scheduleResetAlarm();
  checkReset();
  if (state.mode === 'ACTIVE' && state.consumed >= settings.limit) armBlockPending();
  broadcast();
  return settings;
}

// ---------------------------------------------------------------- persistence

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.local.set({ state });
  }, 2000); // bounds the cost lost if the worker dies between an ack and the write
}

function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return chrome.storage.local.set({ state });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushAttention, 5000);
}

function flushAttention() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!attentionBuffer.length) return Promise.resolve();
  const batch = attentionBuffer;
  attentionBuffer = [];
  return db.addAttention(batch).catch((e) => console.error('[XAL] addAttention', e));
}

function effectiveState() {
  return state.unlimited ? 'UNLIMITED' : state.mode;
}

function commit() {
  const eff = effectiveState();
  if (eff !== state.lastEffective) {
    state.lastEffective = eff;
    db.addState({ ts: Date.now(), state: eff }).catch((e) => console.error('[XAL] addState', e));
  }
  flushAttention();
  persistNow();
  broadcast();
}

async function prune() {
  state.lastPruneAt = Date.now();
  schedulePersist();
  try {
    await db.prune(settings.snapshot);
  } catch (e) {
    console.error('[XAL] prune', e);
  }
}

// ---------------------------------------------------------------- transitions

function startAbsence() {
  if (state.inactiveSince == null) {
    state.inactiveSince = Date.now();
    scheduleResetAlarm();
  }
}

function leaveX() {
  if (state.mode !== 'ACTIVE') return;
  state.mode = 'INACTIVE';
  state.inactiveSince = Date.now();
  state.resetDone = false;
  // The pending window stays armed across the absence: the session is still unfinished, so the
  // next Return to X goes straight to BLOCK. Only the timeout alarm is pointless while away.
  chrome.alarms.clear('blockPending');
  scheduleResetAlarm();
  commit();
}

function resume() {
  if (state.mode !== 'INACTIVE' || state.unlimited) return false;
  // The LIMIT was already reached when the user left: returning resumes nothing. The absence
  // accumulated since then was real absence, so it keeps counting towards the RESET (SPEC §12).
  if (state.blockPending || state.consumed >= settings.limit) {
    block({ reason: 'return', keepAbsence: true });
    return true;
  }
  state.mode = 'ACTIVE';
  state.inactiveSince = null;
  state.resetDone = false;
  state.lastActiveAt = Date.now();
  chrome.alarms.clear('reset');
  commit();
  evaluate();
  return true;
}

// Arms the pending window: the LIMIT is reached, but the post being read is not cut in half.
// The active tab (or the timeout alarm) reports the new information that ends the session.
function armBlockPending() {
  if (state.blockPending || state.mode !== 'ACTIVE') return;
  state.blockPending = true;
  state.blockPendingSince = Date.now();
  state.blockReason = null;
  scheduleBlockPendingAlarm();
  commit();
}

function scheduleBlockPendingAlarm() {
  chrome.alarms.create('blockPending', { when: (state.blockPendingSince || Date.now()) + settings.block.maxPendingMs });
}

function clearBlockPending() {
  state.blockPending = false;
  state.blockPendingSince = null;
  chrome.alarms.clear('blockPending');
}

// `keepAbsence` blocks on return from an absence that started while the limit was already
// reached: that absence was never interrupted by usage, so its clock must not restart.
function block(opts) {
  if (state.mode === 'BLOCKED') return;
  state.mode = 'BLOCKED';
  state.blockedAt = Date.now();
  state.blockReason = (opts && opts.reason) || null;
  clearBlockPending();
  // Provisional (SPEC §35, "BLOCK release condition"): the reset timer starts at the moment of BLOCK.
  if (!(opts && opts.keepAbsence && state.inactiveSince != null)) {
    state.inactiveSince = Date.now();
    state.resetDone = false;
  }
  scheduleResetAlarm();
  commit();
}

function doReset(source) {
  state.consumed = 0;
  state.session = (state.session || 1) + 1;
  state.mode = 'INACTIVE';
  state.inactiveSince = null;
  state.resetDone = true;
  state.blockedAt = null;
  state.blockReason = null;
  clearBlockPending();
  chrome.alarms.clear('reset');
  db.addState({ ts: Date.now(), state: 'RESET', source }).catch((e) => console.error('[XAL] addState', e));
  commit();
}

function forceBlackout() {
  state.mode = 'INACTIVE';
  state.inactiveSince = Date.now();
  state.resetDone = false;
  state.blockedAt = null;
  scheduleResetAlarm();
  commit();
}

function checkReset() {
  if (state.inactiveSince != null && Date.now() - state.inactiveSince >= resetMs()) doReset('timer');
}

function scheduleResetAlarm() {
  if (state.inactiveSince == null) {
    chrome.alarms.clear('reset');
    return;
  }
  chrome.alarms.create('reset', { when: state.inactiveSince + resetMs() + 250 });
}

function refreshUnlimited() {
  const unl = isUnlimited(settings.unlimitedPeriods);
  if (unl !== state.unlimited) {
    state.unlimited = unl;
    // The controlled session is over either way, so an armed pending window ends with it; the
    // cost stays, so the next Return to X after UNLIMITED blocks through resume().
    if (unl && state.blockPending) clearBlockPending();
    if (unl && state.mode === 'ACTIVE') {
      // Entering UNLIMITED ends the controlled session. The user is still on X, so the
      // absence clock does not start (SPEC §11); evaluate() starts it when they leave.
      state.mode = 'INACTIVE';
      state.inactiveSince = null;
      state.resetDone = false;
      chrome.alarms.clear('reset');
    } else if (!unl && state.mode !== 'ACTIVE' && state.inactiveSince == null && !state.resetDone) {
      // Back to CONTROLLED while still on X: BLACKOUT (or BLOCK) counts as waiting (SPEC §9).
      startAbsence();
    }
    commit();
    // Presence may have changed meaning at the boundary (e.g. a foreground BLACKOUT whose
    // absence clock must stop now that the user is using X in UNLIMITED).
    evaluate();
  }
  const nb = nextBoundary(settings.unlimitedPeriods);
  if (nb) chrome.alarms.create('boundary', { when: nb + 500 });
  else chrome.alarms.clear('boundary');
}

// ---------------------------------------------------------------- focus tracking

// Returns the focused X tab id, null when the user is elsewhere, or 'neutral' when the focused
// tab is this extension's own page (the Debug page must not affect the RESET timer, SPEC §21).
// Active tab per window as reported by tab events. `tabs.query({active:true})` can lag behind
// tabs.onActivated right after a new tab opens (the New Tab Page), which left X ACTIVE until the
// next navigation; the event payload is authoritative, the query is only a fallback.
const activeTabByWindow = new Map();

async function findFocusedXTab() {
  if (focusedWindowId == null || focusedWindowId === chrome.windows.WINDOW_ID_NONE) return null;
  let tab = null;
  const knownId = activeTabByWindow.get(focusedWindowId);
  if (knownId != null) {
    try {
      tab = await chrome.tabs.get(knownId);
    } catch {
      tab = null;
    }
    if (tab && (!tab.active || tab.windowId !== focusedWindowId)) tab = null;
  }
  if (!tab) {
    try {
      [tab] = await chrome.tabs.query({ active: true, windowId: focusedWindowId });
    } catch {
      return null;
    }
  }
  if (!tab) return null;
  if (typeof tab.url === 'string' && tab.url.startsWith(DEBUG_PAGE_PREFIX)) return 'neutral';
  if (!isXUrl(tab.url)) return null;
  const p = ports.get(tab.id);
  if (p && p.visible === false) return null;
  return tab.id;
}

function clearLeaveTimer() {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

function armLeaveTimer() {
  if (leaveTimer) return;
  if (!(state.mode === 'ACTIVE' || (state.unlimited && state.inactiveSince == null))) return;
  leaveTimer = setTimeout(async () => {
    leaveTimer = null;
    const gen = ++evalGen; // supersede evaluations still in flight
    const t = await findFocusedXTab();
    if (gen !== evalGen) return;
    if (t == null) onLeftX();
    else if (t !== 'neutral') {
      currentXTabId = t;
      broadcast();
    }
  }, settings.leaveGraceMs);
}

// Called after the grace period confirmed the user is not on X.
function onLeftX() {
  if (state.mode === 'ACTIVE') leaveX();
  else if (state.unlimited && state.inactiveSince == null && !state.resetDone) {
    startAbsence();
    persistNow();
  }
}

// Evaluations are generation-numbered: several can be in flight at once (tabs.onCreated,
// tabs.onActivated and the tab's own visibility report arrive together when the "+" button
// opens a tab), and one that looked up the tab before the switch must not overwrite the
// conclusion of a newer one, otherwise it cancels the leave timer and X stays ACTIVE hidden.
let evalGen = 0;

async function evaluate() {
  const gen = ++evalGen;
  const found = await findFocusedXTab();
  if (gen !== evalGen) return; // superseded by a newer evaluation
  const neutral = found === 'neutral';
  const xTab = neutral ? null : found;
  currentXTabId = xTab;
  if (xTab != null) {
    clearLeaveTimer();
    if (state.unlimited && state.inactiveSince != null) {
      // Using X during UNLIMITED is presence: the absence clock stops (nothing is recovered).
      state.inactiveSince = null;
      chrome.alarms.clear('reset');
      persistNow();
    }
  } else if (neutral) {
    clearLeaveTimer();
  } else {
    armLeaveTimer();
  }
  broadcast();
}

chrome.windows.onFocusChanged.addListener((wid) => {
  focusedWindowId = wid;
  ready.then(evaluate);
});

// Safety net: while a controlled session is in progress, re-check presence every few seconds so
// a missed or mis-ordered browser event can never leave X ACTIVE while hidden. The worker is
// alive whenever an X tab is connected, so a plain interval is enough.
setInterval(() => {
  if (state.mode === 'ACTIVE' || (state.unlimited && state.inactiveSince == null)) ready.then(evaluate);
}, 5000);
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  activeTabByWindow.set(windowId, tabId);
  ready.then(evaluate);
});
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.active && tab.windowId != null) activeTabByWindow.set(tab.windowId, tab.id);
  ready.then(evaluate);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === 'complete') ready.then(evaluate);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  ports.delete(tabId);
  ready.then(evaluate);
});

// ---------------------------------------------------------------- content ports

function stateFor(tabId) {
  return {
    type: 'state',
    mode: state.mode,
    unlimited: state.unlimited,
    resetDone: state.resetDone,
    debug: settings.debug,
    consumed: state.consumed,
    limit: settings.limit,
    blockPending: !!state.blockPending,
    block: settings.block,
    cost: settings.cost,
    snapshot: { minCost: settings.snapshot.minCost },
    session: state.session,
    active: state.mode === 'ACTIVE' && !state.unlimited && tabId === currentXTabId,
  };
}

function broadcast() {
  for (const [tabId, p] of ports) {
    try {
      p.port.postMessage(stateFor(tabId));
    } catch {
      ports.delete(tabId);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'xal' || !port.sender || !port.sender.tab) return;
  const tabId = port.sender.tab.id;
  ports.set(tabId, { port, visible: true });
  port.onMessage.addListener((msg) => ready.then(() => onPortMessage(tabId, msg)));
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId)?.port === port) ports.delete(tabId);
    ready.then(evaluate);
  });
  ready.then(() => {
    port.postMessage(stateFor(tabId));
    evaluate();
  });
});

function onPortMessage(tabId, msg) {
  const p = ports.get(tabId);
  switch (msg.type) {
    case 'visibility':
      if (p) p.visible = !!msg.visible;
      if (!msg.visible && tabId === currentXTabId) {
        // A hidden document cannot be ACTIVE (SPEC §7), whatever the tab query says.
        currentXTabId = null;
        armLeaveTimer();
      }
      evaluate();
      break;
    case 'resume':
      resume();
      break;
    case 'heartbeat':
      if (state.mode === 'ACTIVE' && !state.unlimited && tabId === currentXTabId) {
        state.lastActiveAt = Date.now();
        schedulePersist();
      }
      break;
    case 'blockNow':
      // The measuring tab saw new information while the pending window was armed.
      if (state.mode === 'ACTIVE' && state.blockPending && tabId === currentXTabId) {
        const reason = ['scroll', 'navigation', 'timeout'].includes(msg.reason) ? msg.reason : 'scroll';
        block({ reason });
      }
      break;
    case 'batch':
      onBatch(tabId, msg);
      break;
    default:
      break;
  }
}

function onBatch(tabId, msg) {
  const p0 = ports.get(tabId);
  const seq = Number(msg.seq) || 0;
  // A re-sent batch whose ack was lost: already applied, ack again without charging.
  const duplicate = !!(p0 && p0.lastSeq != null && seq !== 0 && seq === p0.lastSeq);
  const accept = duplicate || (state.mode === 'ACTIVE' && !state.unlimited && tabId === currentXTabId);
  if (accept && p0) p0.lastSeq = seq;
  if (accept && !duplicate && Array.isArray(msg.items)) {
    const now = Date.now();
    let total = 0;
    for (const it of msg.items) {
      const d = Number(it.delta) || 0;
      if (d !== 0) {
        // negative deltas come from undone interactions (unlike etc.), bounded by the bonus granted
        total += d;
        attentionBuffer.push({ ts: now, postId: String(it.id), delta: d });
      }
    }
    state.lastActiveAt = now;
    if (total !== 0) {
      state.consumed = Math.max(0, state.consumed + total);
      scheduleFlush();
    }
    schedulePersist();
    if (settings.debug) upsertSnapshots(msg.items.filter((i) => i.snapshot));
    if (state.consumed >= settings.limit) armBlockPending();
  }
  const p = ports.get(tabId);
  if (p) {
    try {
      p.port.postMessage({ type: 'ack', seq, accepted: accept, consumed: state.consumed, limit: settings.limit });
    } catch {
      /* port gone */
    }
  }
}

function upsertSnapshots(items) {
  if (!items.length) return;
  snapshotQueue = snapshotQueue
    .then(async () => {
      const merged = [];
      for (const it of items) {
        const s = it.snapshot;
        const id = String(it.id);
        const existing = await db.getPost(id);
        const base = existing || {
          id,
          url: '',
          author: '',
          handle: '',
          text: '',
          createdAt: null,
          quote: null,
          media: [],
          cost: 0,
          breakdown: {},
          timelineDwellMs: 0,
          detailDwellMs: 0,
          videoMs: 0,
          interactions: [],
          firstSeenAt: s.firstSeenAt || Date.now(),
          lastSeenAt: 0,
          viewOrder: ++state.viewCounter,
          label: null,
        };
        const m = s.meta || {};
        for (const k of ['url', 'author', 'handle', 'text', 'createdAt', 'quote']) {
          if (m[k] != null && m[k] !== '' && (base[k] == null || base[k] === '')) base[k] = m[k];
        }
        if (Array.isArray(m.media) && m.media.length && (!base.media || !base.media.length)) base.media = m.media;
        base.cost += s.costDelta || 0;
        for (const [k, v] of Object.entries(s.breakdownDelta || {})) base.breakdown[k] = (base.breakdown[k] || 0) + v;
        base.timelineDwellMs += s.timelineDwellMsDelta || 0;
        base.detailDwellMs += s.detailDwellMsDelta || 0;
        base.videoMs += s.videoMsDelta || 0;
        if (Array.isArray(s.interactions) && s.interactions.length) base.interactions = base.interactions.concat(s.interactions).slice(-200);
        base.lastSeenAt = Math.max(base.lastSeenAt, s.lastSeenAt || Date.now());
        base.firstSeenAt = Math.min(base.firstSeenAt, s.firstSeenAt || base.firstSeenAt);
        merged.push(base);
      }
      await db.putPosts(merged);
      schedulePersist();
    })
    .catch((e) => console.error('[XAL] snapshot', e));
}

// ---------------------------------------------------------------- alarms

chrome.alarms.onAlarm.addListener((alarm) => {
  ready.then(() => {
    if (alarm.name === 'reset' || alarm.name === 'tick') checkReset();
    if (alarm.name === 'boundary' || alarm.name === 'tick') refreshUnlimited();
    if (alarm.name === 'blockPending' && state.mode === 'ACTIVE' && state.blockPending) block({ reason: 'timeout' });
    if (alarm.name === 'tick') {
      flushAttention();
      if (Date.now() - (state.lastPruneAt || 0) > 6 * 3600e3) prune();
    }
  });
});

// Chrome does not inject content scripts into tabs that were already open when the extension
// was installed or reloaded; those X tabs would stay readable for free (SPEC §9). Inject now.
const X_URL_PATTERNS = [
  'https://x.com/*',
  'https://www.x.com/*',
  'https://mobile.x.com/*',
  'https://twitter.com/*',
  'https://www.twitter.com/*',
  'https://mobile.twitter.com/*',
];

async function injectIntoOpenXTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: X_URL_PATTERNS });
  } catch (e) {
    console.error('[XAL] tabs.query', e);
    return;
  }
  for (const t of tabs) {
    if (t.discarded) continue; // a discarded tab runs the script when it reloads
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/content/content.js'] });
    } catch (e) {
      console.warn('[XAL] inject failed for tab', t.id, String(e));
    }
  }
}

chrome.runtime.onInstalled.addListener(() =>
  ready.then(async () => {
    broadcast();
    await injectIntoOpenXTabs();
    evaluate();
  })
);
chrome.runtime.onStartup.addListener(() => ready.then(restoreAfterBrowserStart));

// ---------------------------------------------------------------- debug page messages

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/debug/debug.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ready.then(() => handleMessage(msg)).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'getState':
      return {
        state,
        settings,
        effective: effectiveState(),
        currentXTabId,
        xTabs: [...ports.keys()],
        resetAt: state.inactiveSince != null ? state.inactiveSince + resetMs() : null,
      };
    case 'setSettings': {
      const next = mergeSettings(settings, msg.patch);
      if (Array.isArray(msg.patch?.unlimitedPeriods)) next.unlimitedPeriods = msg.patch.unlimitedPeriods;
      return { settings: await applySettings(next) };
    }
    case 'resetSettings':
      return { settings: await applySettings(structuredClone(DEFAULT_SETTINGS)) };
    case 'debugReset':
      doReset('debug');
      return { state };
    case 'debugBlackout':
      forceBlackout();
      return { state };
    case 'debugBlock':
      block({ reason: 'debug' });
      return { state };
    case 'flush':
      await flushAttention();
      await snapshotQueue;
      return { ok: true };
    case 'setLabel': {
      // Serialized through snapshotQueue so a concurrent merge cannot overwrite the label.
      const id = String(msg.id);
      const label = msg.label == null ? null : String(msg.label);
      snapshotQueue = snapshotQueue.then(async () => {
        const p = await db.getPost(id);
        if (p) {
          p.label = label;
          p.labeledAt = Date.now();
          await db.putPosts([p]);
        }
      });
      await snapshotQueue;
      return { ok: true };
    }
    case 'clearData':
      await flushAttention().catch(() => {});
      attentionBuffer = [];
      await db.clearAll();
      state.viewCounter = 0;
      state.lastEffective = null;
      commit();
      return { ok: true };
    case 'export': {
      await flushAttention();
      await snapshotQueue;
      const data = await db.exportAll();
      return { ...data, settings, state };
    }
    default:
      return { error: 'unknown message ' + msg.type };
  }
}

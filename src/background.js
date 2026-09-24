// Service worker: global state machine (SPEC §7-17, §34), reset timer, IndexedDB writer.
//
// mode      : 'ACTIVE' | 'INACTIVE' (= BLACKOUT shown on X tabs) | 'BLOCKED'
// unlimited : true while inside an UNLIMITED period; overrides everything visually
// effective : unlimited ? 'UNLIMITED' : mode   (recorded as StateEvent, SPEC §31)

import { DEFAULT_SETTINGS, mergeSettings } from './shared/defaults.js';
import { isUnlimited, nextBoundary } from './shared/periods.js';
import { XalDB } from './shared/db.js';

const db = new XalDB();
const X_HOST_RE = /^(www\.|mobile\.)?(x|twitter)\.com$/;

let settings = structuredClone(DEFAULT_SETTINGS);
let state = {
  mode: 'INACTIVE',
  consumed: 0,
  inactiveSince: null, // start of the continuous absence (reset timer origin)
  resetDone: false, // a FULL RESET happened during the current absence
  unlimited: false,
  lastEffective: null,
  viewCounter: 0,
  blockedAt: null,
  lastPruneAt: 0,
};

const ports = new Map(); // tabId -> { port, visible }
let focusedWindowId = null;
let currentXTabId = null; // the X tab that currently satisfies the ACTIVE conditions
let leaveTimer = null;
let attentionBuffer = [];
let flushTimer = null;
let persistTimer = null;
let snapshotQueue = Promise.resolve();

const ready = init();

async function init() {
  const stored = await chrome.storage.local.get(['settings', 'state']);
  settings = mergeSettings(DEFAULT_SETTINGS, stored.settings);
  if (stored.state) state = { ...state, ...stored.state };
  try {
    const w = await chrome.windows.getLastFocused();
    focusedWindowId = w && w.focused ? w.id : null;
  } catch {
    focusedWindowId = null;
  }
  await chrome.alarms.create('tick', { periodInMinutes: 1 });
  refreshUnlimited();
  checkReset();
  scheduleResetAlarm();
  await evaluate();
  if (Date.now() - (state.lastPruneAt || 0) > 6 * 3600e3) prune();
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

// ---------------------------------------------------------------- persistence

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.local.set({ state });
  }, 500);
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

function leaveX() {
  if (state.mode !== 'ACTIVE') return;
  state.mode = 'INACTIVE';
  state.inactiveSince = Date.now();
  state.resetDone = false;
  scheduleResetAlarm();
  commit();
}

function resume() {
  if (state.mode !== 'INACTIVE' || state.unlimited) return false;
  state.mode = 'ACTIVE';
  state.inactiveSince = null;
  state.resetDone = false;
  chrome.alarms.clear('reset');
  commit();
  evaluate();
  return true;
}

function block() {
  if (state.mode === 'BLOCKED') return;
  state.mode = 'BLOCKED';
  state.blockedAt = Date.now();
  // Provisional (SPEC §35, "BLOCK release condition"): the reset timer starts at the moment of BLOCK.
  state.inactiveSince = Date.now();
  state.resetDone = false;
  scheduleResetAlarm();
  commit();
}

function doReset(source) {
  state.consumed = 0;
  state.mode = 'INACTIVE';
  state.inactiveSince = null;
  state.resetDone = true;
  state.blockedAt = null;
  chrome.alarms.clear('reset');
  db.addState({ ts: Date.now(), state: 'RESET', source }).catch((e) => console.error('[XAL] addState', e));
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
    if (unl && state.mode === 'ACTIVE') {
      // Entering UNLIMITED ends the controlled session; the absence timer runs during UNLIMITED.
      state.mode = 'INACTIVE';
      state.inactiveSince = Date.now();
      state.resetDone = false;
      scheduleResetAlarm();
    }
    commit();
  }
  const nb = nextBoundary(settings.unlimitedPeriods);
  if (nb) chrome.alarms.create('boundary', { when: nb + 500 });
  else chrome.alarms.clear('boundary');
}

// ---------------------------------------------------------------- focus tracking

async function findFocusedXTab() {
  if (focusedWindowId == null || focusedWindowId === chrome.windows.WINDOW_ID_NONE) return null;
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, windowId: focusedWindowId });
  } catch {
    return null;
  }
  if (!tab || !isXUrl(tab.url)) return null;
  const p = ports.get(tab.id);
  if (p && p.visible === false) return null;
  return tab.id;
}

async function evaluate() {
  const xTab = await findFocusedXTab();
  currentXTabId = xTab;
  if (xTab != null) {
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  } else if (state.mode === 'ACTIVE' && !leaveTimer) {
    leaveTimer = setTimeout(async () => {
      leaveTimer = null;
      const t = await findFocusedXTab();
      if (t == null) leaveX();
      else {
        currentXTabId = t;
        broadcast();
      }
    }, settings.leaveGraceMs);
  }
  broadcast();
}

chrome.windows.onFocusChanged.addListener((wid) => {
  focusedWindowId = wid;
  ready.then(evaluate);
});
chrome.tabs.onActivated.addListener(() => ready.then(evaluate));
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
    cost: settings.cost,
    snapshot: { minCost: settings.snapshot.minCost },
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
      evaluate();
      break;
    case 'resume':
      resume();
      break;
    case 'batch':
      onBatch(tabId, msg);
      break;
    default:
      break;
  }
}

function onBatch(tabId, msg) {
  const accept = state.mode === 'ACTIVE' && !state.unlimited && tabId === currentXTabId;
  if (accept && Array.isArray(msg.items)) {
    const now = Date.now();
    let total = 0;
    for (const it of msg.items) {
      const d = Number(it.delta) || 0;
      if (d > 0) {
        total += d;
        attentionBuffer.push({ ts: now, postId: String(it.id), delta: d });
      }
    }
    if (total > 0) {
      state.consumed += total;
      scheduleFlush();
      schedulePersist();
    }
    if (settings.debug) upsertSnapshots(msg.items.filter((i) => i.snapshot));
    if (state.consumed >= settings.limit) block();
  }
  const p = ports.get(tabId);
  if (p) {
    try {
      p.port.postMessage({ type: 'ack', accepted: accept, consumed: state.consumed, limit: settings.limit });
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
        if (Array.isArray(s.interactions) && s.interactions.length) base.interactions = base.interactions.concat(s.interactions);
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
    if (alarm.name === 'tick') {
      flushAttention();
      if (Date.now() - (state.lastPruneAt || 0) > 6 * 3600e3) prune();
    }
  });
});

chrome.runtime.onInstalled.addListener(() => ready.then(() => broadcast()));
chrome.runtime.onStartup.addListener(() => ready.then(() => broadcast()));

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
      settings = mergeSettings(settings, msg.patch);
      if (Array.isArray(msg.patch?.unlimitedPeriods)) settings.unlimitedPeriods = msg.patch.unlimitedPeriods;
      await chrome.storage.local.set({ settings });
      refreshUnlimited();
      scheduleResetAlarm();
      checkReset();
      if (state.mode === 'ACTIVE' && state.consumed >= settings.limit) block();
      broadcast();
      return { settings };
    }
    case 'resetSettings':
      settings = structuredClone(DEFAULT_SETTINGS);
      await chrome.storage.local.set({ settings });
      refreshUnlimited();
      broadcast();
      return { settings };
    case 'debugReset':
      doReset('debug');
      return { state };
    case 'debugBlackout':
      leaveX();
      return { state };
    case 'debugBlock':
      block();
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

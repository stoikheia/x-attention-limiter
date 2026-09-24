// Debug page: Status, Attention Review, Attention History, Settings.
// Reads IndexedDB directly (same origin as the service worker); all writes go through the worker.

import { XalDB } from '../shared/db.js';
import { isValidPeriod, nextBoundary } from '../shared/periods.js';
import { HistoryChart } from './chart.js';
import { buildAnalysisMarkdown } from './export.js';

const db = new XalDB();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const rpc = (msg) => chrome.runtime.sendMessage(msg);
const fmtN = (n) => Math.round(n).toLocaleString();
const fmtDT = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtSec = (ms) => `${(ms / 1000).toFixed(1)}s`;

// ---------------------------------------------------------------- tabs

const tabs = { status: refreshStatus, review: loadReview, history: loadHistory, settings: loadSettings };
let currentTab = 'status';

function showTab(name) {
  currentTab = name;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((s) => s.classList.toggle('on', s.id === `tab-${name}`));
  tabs[name]();
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});

// ---------------------------------------------------------------- status

async function refreshStatus() {
  let r;
  try {
    r = await rpc({ type: 'getState' });
  } catch (e) {
    $('#st-effective').textContent = 'worker unavailable';
    return;
  }
  if (!r || r.error) return;
  const { state, settings, effective, currentXTabId, xTabs, resetAt } = r;
  $('#st-effective').textContent = effective;
  const sub = [`mode ${state.mode}`];
  if (state.blockPending) sub.push('BLOCK PENDING');
  if (state.mode === 'BLOCKED' && state.blockReason) sub.push(`reason ${state.blockReason}`);
  if (currentXTabId != null) sub.push(`measuring tab ${currentXTabId}`);
  $('#st-mode').textContent = sub.join(' · ');
  $('#st-consumed').textContent = fmtN(state.consumed);
  $('#st-limit').textContent = fmtN(settings.limit);
  const rem = Math.max(0, settings.limit - state.consumed);
  const pct = settings.limit > 0 ? (state.consumed / settings.limit) * 100 : 0;
  $('#st-remaining').textContent = fmtN(rem);
  $('#st-pct').textContent = `${pct.toFixed(1)}% used`;
  const bar = $('#st-bar');
  bar.style.width = `${Math.min(100, pct)}%`;
  bar.className = 'fill' + (pct >= 90 ? ' crit' : pct >= 70 ? ' hot' : '');
  let resetTxt = '–';
  if (state.mode === 'ACTIVE') resetTxt = 'IN USE';
  else if (state.resetDone) resetTxt = 'DONE';
  else if (state.inactiveSince != null) resetTxt = 'PENDING';
  $('#st-reset').textContent = resetTxt;
  $('#st-reset-at').textContent = resetAt && !state.resetDone && state.mode !== 'ACTIVE' ? `at ${fmtDT(resetAt)} (${settings.resetHours}h)` : '';
  $('#st-unlimited').textContent = state.unlimited ? 'YES' : 'no';
  const nb = nextBoundary(settings.unlimitedPeriods);
  $('#st-next-boundary').textContent = nb ? `next boundary ${fmtDT(nb)}` : 'no periods';
  $('#st-tabs').textContent = `X tabs connected: ${xTabs.length ? xTabs.join(', ') : 'none'} · debug ${settings.debug ? 'ON' : 'OFF'}`;
}
setInterval(() => {
  if (currentTab === 'status' && document.visibilityState === 'visible') refreshStatus();
}, 1000);

$('#act-reset').addEventListener('click', async () => {
  if (!confirm('FULL RESET now (consumed -> 0, state -> BLACKOUT with "reset done")?')) return;
  await rpc({ type: 'debugReset' });
  refreshStatus();
});
$('#act-blackout').addEventListener('click', async () => {
  await rpc({ type: 'debugBlackout' });
  refreshStatus();
});
$('#act-block').addEventListener('click', async () => {
  if (!confirm('Force BLOCK now?')) return;
  await rpc({ type: 'debugBlock' });
  refreshStatus();
});

// ---------------------------------------------------------------- review

const review = { sort: 'cost', label: 'all', range: null, posts: [], shown: 0 };
const PAGE = 100;

$('#rv-sort').addEventListener('change', (e) => {
  review.sort = e.target.value;
  renderReview();
});
$('#rv-label').addEventListener('change', (e) => {
  review.label = e.target.value;
  renderReview();
});
$('#rv-range-clear').addEventListener('click', () => {
  review.range = null;
  loadReview();
});
$('#rv-reload').addEventListener('click', loadReview);
$('#rv-more').addEventListener('click', () => renderReview(true));

async function loadReview() {
  await rpc({ type: 'flush' }).catch(() => {});
  let posts;
  if (review.range) {
    const { lo, hi } = review.range;
    const evs = await db.getAttention(lo, hi);
    const agg = new Map();
    for (const e of evs) agg.set(e.postId, (agg.get(e.postId) || 0) + e.delta);
    posts = await db.getPosts([...agg.keys()]);
    for (const p of posts) p.rangeCost = agg.get(p.id) || 0;
    $('#rv-range-text').textContent = `${fmtDT(lo)} – ${fmtDT(hi)}`;
    $('#rv-range').hidden = false;
  } else {
    posts = await db.getAllPosts();
    $('#rv-range').hidden = true;
  }
  review.posts = posts;
  renderReview();
}

function sortPosts(list) {
  const key = review.range ? (p) => p.rangeCost : (p) => p.cost;
  const s = [...list];
  if (review.sort === 'cost') s.sort((a, b) => key(b) - key(a));
  else if (review.sort === 'order') s.sort((a, b) => a.viewOrder - b.viewOrder || a.firstSeenAt - b.firstSeenAt);
  else s.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return s;
}

function filterPosts(list) {
  if (review.label === 'all') return list;
  if (review.label === 'unlabeled') return list.filter((p) => !p.label);
  return list.filter((p) => p.label === review.label);
}

function renderReview(more = false) {
  const list = sortPosts(filterPosts(review.posts));
  const box = $('#rv-list');
  if (!more) {
    box.textContent = '';
    review.shown = 0;
  }
  const end = Math.min(list.length, review.shown + PAGE);
  for (let i = review.shown; i < end; i++) box.appendChild(postCard(list[i]));
  review.shown = end;
  $('#rv-more').hidden = end >= list.length;
  $('#rv-count').textContent = `${list.length} posts${review.range ? ' in range' : ''}`;
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'post muted';
    p.textContent = 'No snapshots yet. Browse X in Debug mode with the extension ACTIVE.';
    box.appendChild(p);
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Stored URLs are scraped content: only http(s) may reach src/href (SPEC §33).
function safeUrl(u) {
  try {
    const url = new URL(String(u || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

// Renders saved text as text (SPEC §33); media URLs go only into src/href attributes.
function postCard(p) {
  const card = el('article', 'post');
  card.dataset.id = p.id;
  const av = el('div', 'avatar', (p.author || p.handle || '?').replace('@', '').slice(0, 1).toUpperCase());
  card.appendChild(av);
  const main = el('div');
  const head = el('div', 'head');
  head.appendChild(el('span', 'name', p.author || '(unknown)'));
  head.appendChild(el('span', 'handle', p.handle || ''));
  const time = el('span', 'time');
  const a = el('a', null, p.createdAt ? '· ' + fmtDT(Date.parse(p.createdAt)) : '· open');
  a.href = safeUrl(p.url) || `https://x.com/i/status/${encodeURIComponent(p.id)}`;
  a.target = '_blank';
  a.rel = 'noopener';
  time.appendChild(a);
  head.appendChild(time);
  main.appendChild(head);
  main.appendChild(el('div', 'body', p.text || ''));
  if (p.quote) {
    const q = el('div', 'quote');
    q.appendChild(el('span', 'name', `${p.quote.author || ''} ${p.quote.handle || ''}`.trim()));
    q.appendChild(el('div', 'body', p.quote.text || ''));
    main.appendChild(q);
  }
  if (Array.isArray(p.media) && p.media.length) {
    const m = el('div', 'media');
    for (const md of p.media) {
      const url = safeUrl(md.url);
      const poster = safeUrl(md.poster);
      if (md.type === 'photo' && url) {
        const img = el('img');
        img.loading = 'lazy';
        img.src = url;
        img.alt = md.alt || '';
        m.appendChild(img);
      } else if (md.type === 'video') {
        if (url) {
          const v = el('video');
          v.controls = true;
          v.preload = 'none';
          v.src = url;
          if (poster) v.poster = poster;
          m.appendChild(v);
        } else if (poster) {
          const img = el('img');
          img.loading = 'lazy';
          img.src = poster;
          img.alt = 'video poster';
          m.appendChild(img);
        }
      } else if (md.type === 'card' && url) {
        const c = el('a', 'card', md.alt || url);
        c.href = url;
        c.target = '_blank';
        c.rel = 'noopener';
        m.appendChild(c);
      }
    }
    if (m.childNodes.length) main.appendChild(m);
  }
  const pts = el('div', 'pts', `+${fmtN(review.range ? p.rangeCost : p.cost)} pt`);
  if (review.range) pts.title = `total +${fmtN(p.cost)} pt`;
  card.appendChild(pts);

  const stats = el('div', 'stats');
  const addStat = (k, v) => {
    const s = el('span');
    s.appendChild(el('b', null, k + ' '));
    s.appendChild(document.createTextNode(v));
    stats.appendChild(s);
  };
  addStat('Timeline', fmtSec(p.timelineDwellMs || 0));
  if (p.detailDwellMs) addStat('Detail', fmtSec(p.detailDwellMs));
  if (p.videoMs) addStat('Video', fmtSec(p.videoMs));
  const inter = (p.interactions || []).map((i) => i.type);
  if (inter.length) addStat('Interactions', [...new Set(inter)].join(', '));
  addStat('#', String(p.viewOrder));
  addStat('seen', `${fmtDT(p.firstSeenAt)}${p.lastSeenAt - p.firstSeenAt > 60e3 ? ' → ' + fmtDT(p.lastSeenAt) : ''}`);
  main.appendChild(stats);

  const bd = el('div', 'bd');
  for (const [k, v] of Object.entries(p.breakdown || {}).sort((a, b) => b[1] - a[1])) bd.appendChild(el('span', null, `${k} ${fmtN(v)}`));
  main.appendChild(bd);

  const rate = el('div', 'rate');
  rate.appendChild(el('span', 'lbl', 'Actual attention'));
  for (const [val, label] of [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']]) {
    const b = el('button', p.label === val ? 'on' : '', label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      const next = p.label === val ? null : val;
      await rpc({ type: 'setLabel', id: p.id, label: next });
      p.label = next;
      $$('button', rate).forEach((x) => x.classList.toggle('on', x.textContent.toLowerCase() === next));
    });
    rate.appendChild(b);
  }
  main.appendChild(rate);
  card.appendChild(main);
  return card;
}

// ---------------------------------------------------------------- history

const SPANS = {
  '3h': { ms: 3 * 3600e3, bucket: 60e3 },
  '6h': { ms: 6 * 3600e3, bucket: 120e3 },
  '12h': { ms: 12 * 3600e3, bucket: 300e3 },
  '1d': { ms: 86400e3, bucket: 600e3 },
  '3d': { ms: 3 * 86400e3, bucket: 1800e3 },
  '7d': { ms: 7 * 86400e3, bucket: 3600e3 },
};
const hist = { span: '3h', metric: 'rate', data: null, selection: null };
const chart = new HistoryChart($('#hs-canvas'), $('#hs-tip'), { onSelect: onRangeSelected });

$('#hs-span').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-span]');
  if (!b) return;
  hist.span = b.dataset.span;
  loadHistory();
});
$('#hs-metric').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-metric]');
  if (!b) return;
  hist.metric = b.dataset.metric;
  $$('#hs-metric button').forEach((x) => x.classList.toggle('on', x === b));
  chart.setMetric(hist.metric);
  renderTable();
});
$('#hs-reload').addEventListener('click', loadHistory);
$('#hs-table-toggle').addEventListener('click', () => {
  const t = $('#hs-table');
  t.hidden = !t.hidden;
  renderTable();
});

async function loadHistory() {
  await rpc({ type: 'flush' }).catch(() => {});
  $$('#hs-span button').forEach((b) => b.classList.toggle('on', b.dataset.span === hist.span));
  const { ms, bucket } = SPANS[hist.span];
  const hi = Math.ceil(Date.now() / bucket) * bucket; // wall-clock aligned buckets (SPEC §26)
  const lo = hi - ms;
  const n = Math.ceil(ms / bucket);
  const buckets = new Array(n).fill(0);
  const events = await db.getAttention(lo, hi);
  for (const e of events) {
    const i = Math.floor((e.ts - lo) / bucket);
    if (i >= 0 && i < n) buckets[i] += e.delta;
  }
  const cumulative = [];
  let acc = 0;
  for (const v of buckets) cumulative.push((acc += v));

  // State segments: the state at `lo` is the last non-RESET event before it; with no history at
  // all the extension was INACTIVE (its initial mode), never ACTIVE.
  let prev = await db.lastStateBefore(lo);
  if (prev && prev.state === 'RESET') {
    const older = (await db.getStates(prev.ts - 30 * 86400e3, prev.ts)).filter((s) => s.state !== 'RESET');
    prev = older.length ? older[older.length - 1] : null;
  }
  const states = await db.getStates(lo, hi);
  let cur = prev ? prev.state : 'INACTIVE';
  let curFrom = lo;
  const segments = [];
  const markers = [];
  for (const s of states) {
    if (s.state === 'RESET') {
      markers.push({ ts: s.ts, kind: 'RESET' });
      continue;
    }
    if (s.state === 'BLOCKED') markers.push({ ts: s.ts, kind: 'BLOCK' });
    segments.push({ from: curFrom, to: s.ts, state: cur });
    cur = s.state;
    curFrom = s.ts;
  }
  segments.push({ from: curFrom, to: hi, state: cur });

  hist.data = { lo, hi, bucketMs: bucket, buckets, cumulative, segments, markers, events };
  $('#hs-bucket').textContent = `bucket ${bucket / 60e3} min · ${events.length} events · total ${fmtN(acc)} pt`;
  chart.setData(hist.data);
  chart.setMetric(hist.metric);
  $('#hs-panel').hidden = true;
  renderTable();
}

function renderTable() {
  const t = $('#hs-table');
  if (t.hidden || !hist.data) return;
  const { lo, bucketMs, buckets, cumulative } = hist.data;
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Bucket', 'Cost Rate (pt)', 'Cumulative (pt)']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tb = el('tbody');
  buckets.forEach((v, i) => {
    if (v === 0 && (i === 0 || buckets[i - 1] === 0)) return; // collapse long zero runs
    const tr = el('tr');
    tr.appendChild(el('td', null, fmtDT(lo + i * bucketMs)));
    tr.appendChild(el('td', null, fmtN(v)));
    tr.appendChild(el('td', null, fmtN(cumulative[i])));
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  t.textContent = '';
  t.appendChild(table);
}

async function onRangeSelected(lo, hi) {
  hist.selection = { lo, hi };
  const evs = hist.data.events.filter((e) => e.ts >= lo && e.ts < hi);
  const agg = new Map();
  let total = 0;
  for (const e of evs) {
    agg.set(e.postId, (agg.get(e.postId) || 0) + e.delta);
    total += e.delta;
  }
  const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const posts = await db.getPosts(top.map(([id]) => id));
  const byId = new Map(posts.map((p) => [p.id, p]));
  $('#hs-panel-range').textContent = `${fmtDT(lo)} – ${fmtDT(hi)}`;
  $('#hs-panel-total').textContent = fmtN(total);
  const ol = $('#hs-panel-top');
  ol.textContent = '';
  for (const [id, cost] of top) {
    const p = byId.get(id);
    const li = el('li');
    li.appendChild(el('span', 'p', `+${fmtN(cost)}`));
    const t = p ? `${p.author || p.handle || ''}: ${(p.text || '').slice(0, 80)}` : `post ${id} (no snapshot)`;
    li.appendChild(el('span', 't', t));
    ol.appendChild(li);
  }
  if (!top.length) ol.appendChild(el('li', 'muted', 'no attention in this range'));
  $('#hs-panel').hidden = false;
}

$('#hs-panel-review').addEventListener('click', () => {
  if (!hist.selection) return;
  review.range = { ...hist.selection };
  review.sort = 'cost';
  $('#rv-sort').value = 'cost';
  showTab('review');
});

// ---------------------------------------------------------------- settings

let settingsCache = null;

const FIELD_HELP = {
  limit: 'Session LIMIT (pt)',
  resetHours: 'Continuous absence for FULL RESET (h)',
  leaveGraceMs: 'Grace before leaving counts (ms)',
  debug: 'Debug mode (show hidden values, save snapshots)',
  'block.tolerancePx': 'Scroll tolerance around the posts on screen (px)',
  'block.maxPendingMs': 'Longest pending window after the LIMIT (ms)',
  'block.onNavigation': 'Navigating away from the posts on screen blocks at once',
};

function numField(path, value, label) {
  const l = el('label');
  l.appendChild(el('span', null, label || path));
  const i = el('input');
  i.type = 'number';
  i.step = 'any';
  i.name = path;
  i.value = value;
  l.appendChild(i);
  return l;
}

function boolField(path, value, label) {
  const l = el('label', 'check');
  const i = el('input');
  i.type = 'checkbox';
  i.name = path;
  i.checked = !!value;
  l.appendChild(i);
  l.appendChild(el('span', null, label || path));
  return l;
}

function periodRow(p) {
  const row = el('div', 'period');
  const s = el('input');
  s.type = 'time';
  s.value = p.start || '21:00';
  const e = el('input');
  e.type = 'time';
  e.value = p.end || '06:00';
  row.appendChild(el('span', 'muted small', 'from'));
  row.appendChild(s);
  row.appendChild(el('span', 'muted small', 'to'));
  row.appendChild(e);
  const days = el('div', 'days');
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((n, i) => {
    const l = el('label');
    const c = el('input');
    c.type = 'checkbox';
    c.dataset.day = i;
    c.checked = !Array.isArray(p.days) || p.days.includes(i);
    l.appendChild(c);
    l.appendChild(el('span', null, n));
    days.appendChild(l);
  });
  row.appendChild(days);
  const del = el('button', 'ghost', '×');
  del.type = 'button';
  del.title = 'remove';
  del.addEventListener('click', () => row.remove());
  row.appendChild(del);
  row._get = () => {
    const d = $$('input[data-day]', row).filter((c) => c.checked).map((c) => Number(c.dataset.day));
    const out = { start: s.value, end: e.value };
    if (d.length < 7) out.days = d; // [] = disabled period (never matches)
    return out;
  };
  return row;
}

async function loadSettings() {
  const r = await rpc({ type: 'getState' });
  if (!r || r.error) return;
  settingsCache = r.settings;
  fillSettings(settingsCache);
  const [np, ne] = await Promise.all([db.countPosts(), db.countAttention()]);
  $('#data-stats').textContent = `${np} posts · ${ne} attention events`;
}

function fillSettings(s) {
  const g = $('#set-general');
  g.textContent = '';
  g.appendChild(numField('limit', s.limit, FIELD_HELP.limit));
  g.appendChild(numField('resetHours', s.resetHours, FIELD_HELP.resetHours));
  g.appendChild(numField('leaveGraceMs', s.leaveGraceMs, FIELD_HELP.leaveGraceMs));
  g.appendChild(boolField('debug', s.debug, FIELD_HELP.debug));
  const pr = $('#set-periods');
  pr.textContent = '';
  for (const p of s.unlimitedPeriods) pr.appendChild(periodRow(p));
  const bl = $('#set-block');
  bl.textContent = '';
  bl.appendChild(numField('block.tolerancePx', s.block.tolerancePx, FIELD_HELP['block.tolerancePx']));
  bl.appendChild(numField('block.maxPendingMs', s.block.maxPendingMs, FIELD_HELP['block.maxPendingMs']));
  bl.appendChild(boolField('block.onNavigation', s.block.onNavigation, FIELD_HELP['block.onNavigation']));
  const c = $('#set-cost');
  c.textContent = '';
  for (const [k, v] of Object.entries(s.cost)) c.appendChild(numField(`cost.${k}`, v));
  const sn = $('#set-snapshot');
  sn.textContent = '';
  for (const [k, v] of Object.entries(s.snapshot)) sn.appendChild(numField(`snapshot.${k}`, v));
}

$('#set-period-add').addEventListener('click', () => $('#set-periods').appendChild(periodRow({})));

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {};
  for (const i of $$('#set-general input, #set-block input, #set-cost input, #set-snapshot input')) {
    const val = i.type === 'checkbox' ? i.checked : Number(i.value);
    if (i.type !== 'checkbox' && !Number.isFinite(val)) continue;
    const [a, b] = i.name.split('.');
    if (b) (patch[a] = patch[a] || {})[b] = val;
    else patch[a] = val;
  }
  patch.unlimitedPeriods = $$('#set-periods .period').map((r) => r._get()).filter(isValidPeriod);
  const r = await rpc({ type: 'setSettings', patch });
  $('#set-msg').textContent = r && r.settings ? 'saved' : 'error: ' + (r && r.error);
  setTimeout(() => ($('#set-msg').textContent = ''), 2000);
  if (r && r.settings) fillSettings(r.settings);
});

$('#set-defaults').addEventListener('click', async () => {
  if (!confirm('Reset all settings to defaults?')) return;
  const r = await rpc({ type: 'resetSettings' });
  if (r && r.settings) fillSettings(r.settings);
});

$('#data-export').addEventListener('click', async () => {
  const data = await rpc({ type: 'export' });
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = `x-attention-limiter-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('#data-export-ai').addEventListener('click', async () => {
  await rpc({ type: 'flush' }).catch(() => {});
  const [posts, attention, states, r] = await Promise.all([
    db.getAllPosts(),
    db.getAttention(0, Number.MAX_SAFE_INTEGER),
    db.getStates(0, Number.MAX_SAFE_INTEGER),
    rpc({ type: 'getState' }),
  ]);
  if (!r || r.error) return;
  const md = buildAnalysisMarkdown({
    posts,
    attention,
    states,
    settings: r.settings,
    state: r.state,
    now: Date.now(),
    range: review.range, // the History drill-down filter, if any; null = all retained data
    version: chrome.runtime.getManifest().version,
  });
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
  a.download = `x-attention-limiter-analysis-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('#data-clear').addEventListener('click', async () => {
  if (!confirm('Delete ALL snapshots and history? This cannot be undone.')) return;
  await rpc({ type: 'clearData' });
  loadSettings();
});

// ---------------------------------------------------------------- boot

showTab(Object.hasOwn(tabs, location.hash.slice(1)) ? location.hash.slice(1) : 'status');

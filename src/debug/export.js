// Builds the "Export for AI" Markdown analysis pack (see README / Debug page).
// Pure function: no DOM, no chrome.* calls, so it can be exercised from Node (tools/test_export.mjs).
// The file is meant to be pasted whole into an AI assistant to help tune the cost coefficients
// and the LIMIT; nothing here is sent anywhere automatically (SPEC §33).

const MIN_MS = 60e3;
const LABELS = ['low', 'normal', 'high', 'unlabeled'];
const BREAKDOWN_KEYS = ['timeline', 'dwell', 'detail', 'video', 'interaction'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function localParts(ts) {
  const d = new Date(ts);
  return {
    y: d.getFullYear(),
    mo: d.getMonth() + 1,
    day: d.getDate(),
    h: d.getHours(),
    mi: d.getMinutes(),
    s: d.getSeconds(),
  };
}

// Local ISO-like timestamp, e.g. "2026-09-24 08:30:00".
function fmtLocalDateTime(ts) {
  const p = localParts(ts);
  return `${p.y}-${pad(p.mo)}-${pad(p.day)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

function utcOffsetStr(ts) {
  const offMin = -new Date(ts).getTimezoneOffset(); // minutes east of UTC
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function tzName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
}

function fmtExportedAt(ts) {
  return `${fmtLocalDateTime(ts)} (${tzName()}, UTC${utcOffsetStr(ts)})`;
}

function n1(v) {
  return (Number(v) || 0).toFixed(1);
}

function sec1(ms) {
  return ((Number(ms) || 0) / 1000).toFixed(1);
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// RFC 4180 field quoting: quote fields containing a comma, quote or newline; double inner quotes.
function csvField(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(fields) {
  return fields.map(csvField).join(',');
}

function truncateText(s, max) {
  const clean = String(s || '').replace(/\r?\n/g, ' ');
  return clean.length > max ? clean.slice(0, max) : clean;
}

// A post's presence interval [firstSeenAt, lastSeenAt] overlaps the half-open range [lo, hi).
function postInRange(p, lo, hi) {
  return p.firstSeenAt < hi && p.lastSeenAt >= lo;
}

// The concrete numeric span covered by the export: the given range, or (when range is null) the
// span of everything retained, from the earliest event/post to `now`.
function computeSpan(range, posts, attention, states, now) {
  if (range) return { lo: range.lo, hi: range.hi };
  const ts = [];
  for (const e of attention) ts.push(e.ts);
  for (const s of states) ts.push(s.ts);
  for (const p of posts) {
    ts.push(p.firstSeenAt);
    ts.push(p.lastSeenAt);
  }
  const lo = ts.length ? Math.min(...ts) : now;
  return { lo, hi: now };
}

// Background state at or before `ts`, from the full (unfiltered) state-event history: the last
// non-RESET event at or before ts, INACTIVE if none. `sorted` must be ascending by ts and calls
// must be made with non-decreasing ts (bucket walk order) for the pointer to stay correct.
function makeStateAt(statesFull) {
  const sorted = [...statesFull].filter((s) => s.state !== 'RESET').sort((a, b) => a.ts - b.ts);
  let i = 0;
  let cur = 'INACTIVE';
  return (ts) => {
    while (i < sorted.length && sorted[i].ts <= ts) {
      cur = sorted[i].state;
      i++;
    }
    return cur;
  };
}

function buildHeader({ posts, attention, states, version, now, range, span }) {
  const rangeText = range
    ? `${fmtLocalDateTime(range.lo)} – ${fmtLocalDateTime(range.hi)}`
    : `all retained data (${fmtLocalDateTime(span.lo)} – ${fmtLocalDateTime(span.hi)})`;
  const labeled = posts.filter((p) => p.label).length;
  return [
    '# X Attention Limiter — analysis pack',
    '',
    `- Exported at: ${fmtExportedAt(now)}`,
    `- Extension version: ${version}`,
    `- Range covered: ${rangeText}`,
    `- Posts: ${posts.length} (${labeled} labeled) · Attention events: ${attention.length} · State events: ${states.length}`,
  ].join('\n');
}

function buildHowToRead() {
  return [
    '## How to read this file',
    '',
    '- Per-post cost = base rate × visibility × position × dwell multiplier (accumulated while',
    '  ACTIVE), plus one-off bonuses for the detail view, media viewer and interactions.',
    '- Undoing a Like, Bookmark or Repost subtracts that bonus again (never below zero): the signal',
    '  of interest is sustained interest, not the click itself. The undo shows up as an interaction.',
    '- `bd_*` columns in the Posts table are the cost breakdown by source: timeline (viewport dwell',
    '  while scrolling the feed), dwell (extra rate from staying stationary), detail, video, interaction.',
    '- `label` is the user\'s own rating of actual attention paid to that post (low/normal/high) and is',
    '  the ground truth to tune the cost coefficients against — not something derived from cost.',
    '- All times in this file are local time; `minute` in the per-minute table is the bucket start.',
    '- All cost values (`cost`, `bd_*`, and the per-minute `cost`) are in pt, the extension\'s cost unit.',
    '- The Posts table only lists posts saved as snapshots (cost ≥ `snapshot.minCost`); the totals in',
    '  Summary and Attention per minute include every measured post, snapshotted or not.',
  ].join('\n');
}

function buildSettings(settings) {
  const picked = {
    limit: settings.limit,
    resetHours: settings.resetHours,
    leaveGraceMs: settings.leaveGraceMs,
    unlimitedPeriods: settings.unlimitedPeriods,
    cost: settings.cost,
    snapshot: settings.snapshot,
  };
  return [
    '## Settings at export time',
    '',
    'These are the coefficients in effect when this file was exported. Older data in the tables',
    'below may have been measured under different values if settings were changed since.',
    '',
    '```json',
    JSON.stringify(picked, null, 2),
    '```',
  ].join('\n');
}

function buildSummary({ postsInRange, attentionInRange, state, settings }) {
  const totalCost = attentionInRange.reduce((a, e) => a + e.delta, 0);
  const labeled = postsInRange.filter((p) => p.label).length;

  const overview = [
    '| Metric | Value |',
    '|---|---|',
    `| Total cost in range | ${n1(totalCost)} pt |`,
    `| Posts seen | ${postsInRange.length} |`,
    `| Posts labeled | ${labeled} |`,
  ].join('\n');

  const rows = LABELS.map((label) => {
    const group = label === 'unlabeled' ? postsInRange.filter((p) => !p.label) : postsInRange.filter((p) => p.label === label);
    const costs = group.map((p) => p.cost || 0);
    const dwellSec = group.map((p) => (p.timelineDwellMs || 0) / 1000);
    const withInteraction = group.filter((p) => Array.isArray(p.interactions) && p.interactions.length).length;
    const count = group.length;
    const share = count ? `${Math.round((withInteraction / count) * 100)}%` : '–';
    return `| ${label} | ${count} | ${count ? n1(mean(costs)) : '–'} | ${count ? n1(median(costs)) : '–'} | ${count ? n1(mean(dwellSec)) : '–'} | ${share} |`;
  });
  const table = [
    '| Label | Count | Mean cost | Median cost | Mean timeline (s) | Any interaction |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');

  const unlimited = state.unlimited ? ', unlimited period' : '';
  const sessionLine = `Current session: mode ${state.mode} · consumed ${n1(state.consumed)} / limit ${n1(settings.limit)} pt${unlimited}`;

  return ['## Summary', '', overview, '', table, '', sessionLine].join('\n');
}

function buildPostsCsv(postsInRange) {
  const header = 'id,view_order,first_seen,last_seen,author,handle,created_at,cost,bd_timeline,bd_dwell,bd_detail,bd_video,bd_interaction,timeline_s,detail_s,video_s,interactions,has_media,quote,label,text';
  const sorted = [...postsInRange].sort((a, b) => (b.cost || 0) - (a.cost || 0));
  const lines = sorted.map((p) => {
    const bd = p.breakdown || {};
    const interactions = (p.interactions || []).map((i) => i.type).join(';');
    const hasMedia = Array.isArray(p.media) && p.media.length ? 1 : 0;
    const quote = p.quote ? 1 : 0;
    return csvRow([
      p.id,
      p.viewOrder,
      fmtLocalDateTime(p.firstSeenAt),
      fmtLocalDateTime(p.lastSeenAt),
      p.author || '',
      p.handle || '',
      p.createdAt ? fmtLocalDateTime(Date.parse(p.createdAt)) : '',
      n1(p.cost || 0),
      ...BREAKDOWN_KEYS.map((k) => n1(bd[k] || 0)),
      sec1(p.timelineDwellMs),
      sec1(p.detailDwellMs),
      sec1(p.videoMs),
      interactions,
      hasMedia,
      quote,
      p.label || '',
      truncateText(p.text, 160),
    ]);
  });
  return ['## Posts', '', '```csv', header, ...lines, '```'].join('\n');
}

// One row per minute that has cost > 0 or a non-INACTIVE state; long runs of zero-cost INACTIVE
// minutes are collapsed, keeping only the first and last minute of each run so gaps stay visible.
function buildMinuteRows(loMin, hiMin, attentionInRange, statesFull) {
  const stateAt = makeStateAt(statesFull);
  const buckets = [];
  const index = new Map();
  for (let m = loMin; m < hiMin; m += MIN_MS) {
    index.set(m, buckets.length);
    buckets.push({ minute: m, cost: 0, state: stateAt(m) });
  }
  for (const e of attentionInRange) {
    const m = Math.floor(e.ts / MIN_MS) * MIN_MS;
    const i = index.get(m);
    if (i != null) buckets[i].cost += e.delta;
  }
  const included = buckets.map((b) => b.cost > 0 || b.state !== 'INACTIVE');
  for (let i = 0; i < buckets.length; i++) {
    if (included[i]) continue;
    let j = i;
    while (j < buckets.length && !included[j]) j++;
    included[i] = true;
    included[j - 1] = true;
    i = j - 1;
  }
  return buckets.filter((_, i) => included[i]);
}

function buildMinuteCsv(loMin, hiMin, attentionInRange, statesFull) {
  const rows = buildMinuteRows(loMin, hiMin, attentionInRange, statesFull);
  const lines = rows.map((b) => csvRow([fmtLocalDateTime(b.minute), n1(b.cost), b.state]));
  return ['## Attention per minute', '', '```csv', 'minute,cost,state', ...lines, '```'].join('\n');
}

function buildStatesCsv(statesInRange) {
  const sorted = [...statesInRange].sort((a, b) => a.ts - b.ts);
  const lines = sorted.map((s) => csvRow([fmtLocalDateTime(s.ts), s.state]));
  return ['## State events', '', '```csv', 'time,state', ...lines, '```'].join('\n');
}

function buildQuestions() {
  return [
    '## Suggested questions for the AI',
    '',
    '- Which coefficient best separates label=high from label=low? Compare bd_dwell vs bd_timeline ratios.',
    '- Is the current LIMIT reached at a realistic daily usage, based on the per-minute and Summary totals?',
    '- Which hours of the day carry the most cost, and does that match when the user wants to be limited?',
    '- Do posts with media (`has_media`) or quotes (`quote`) get systematically higher cost than their labels justify?',
    '- Do posts with an interaction (like/bookmark/reply/repost) score meaningfully higher than ones without?',
    '- Are there label=low posts with unusually high cost (or label=high posts with low cost)? What do they have in common?',
    '- Given the Settings block, would a different `dwellAccelSec` or `basePtPerSec` fit the labeled data better?',
  ].join('\n');
}

export function buildAnalysisMarkdown({ posts, attention, states, settings, state, now, range, version }) {
  const span = computeSpan(range, posts, attention, states, now);
  const postsInRange = posts.filter((p) => postInRange(p, span.lo, span.hi));
  const attentionInRange = attention.filter((e) => e.ts >= span.lo && e.ts < span.hi);
  const statesInRange = states.filter((s) => s.ts >= span.lo && s.ts < span.hi);

  const loMin = Math.floor(span.lo / MIN_MS) * MIN_MS;
  let hiMin = Math.ceil(span.hi / MIN_MS) * MIN_MS;
  if (hiMin <= loMin) hiMin = loMin + MIN_MS;

  const sections = [
    buildHeader({ posts: postsInRange, attention: attentionInRange, states: statesInRange, version, now, range, span }),
    buildHowToRead(),
    buildSettings(settings),
    buildSummary({ postsInRange, attentionInRange, state, settings }),
    buildPostsCsv(postsInRange),
    buildMinuteCsv(loMin, hiMin, attentionInRange, states),
    buildStatesCsv(statesInRange),
    buildQuestions(),
  ];
  return sections.join('\n\n') + '\n';
}

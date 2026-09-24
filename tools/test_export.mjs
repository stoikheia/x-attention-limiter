// Node test for src/debug/export.js (buildAnalysisMarkdown). No dependencies.
// Run with: node tools/test_export.mjs

import { buildAnalysisMarkdown } from '../src/debug/export.js';

const MIN = 60e3;
const HOUR = 3600e3;
let failures = 0;

function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}

function section(md, heading) {
  const re = new RegExp('## ' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n\\n```csv\\n([\\s\\S]*?)\\n```');
  const m = md.match(re);
  check(!!m, `csv section found: ${heading}`);
  return m ? m[1].split('\n') : [];
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

const SETTINGS = {
  limit: 10000,
  resetHours: 2,
  leaveGraceMs: 1500,
  unlimitedPeriods: [{ start: '21:00', end: '06:00' }],
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
  snapshot: { minCost: 5, retentionDays: 14, maxPosts: 5000, eventRetentionDays: 30 },
};

const STATE = { mode: 'ACTIVE', consumed: 1234.5, unlimited: false };

// ---------------------------------------------------------------- dataset A
// 8 posts (mixed labels, breakdowns, interactions incl. an unlike, a quote, media, one post with a
// comma and quotes in the text), 90 attention events across ~3 hours, 6 state events incl.
// UNLIMITED and a RESET marker. One post (p7) sits entirely before the window, for the range test.

const BASE = Date.UTC(2024, 0, 10, 3, 0, 0); // minute-aligned, fixed (no wall-clock dependency)

const posts = [
  {
    id: 'p1',
    viewOrder: 1,
    firstSeenAt: BASE + 5 * MIN,
    lastSeenAt: BASE + 8 * MIN,
    author: 'Alice',
    handle: '@alice',
    createdAt: new Date(BASE).toISOString(),
    cost: 120,
    breakdown: { timeline: 40, dwell: 50, detail: 20, interaction: 10 },
    timelineDwellMs: 30000,
    detailDwellMs: 5000,
    videoMs: 0,
    interactions: [{ type: 'like', ts: BASE + 6 * MIN }],
    media: [{ type: 'photo', url: 'https://pbs.twimg.com/img1.jpg' }],
    quote: null,
    label: 'high',
    text: 'He said "hi, there" — cool',
  },
  {
    id: 'p2',
    viewOrder: 2,
    firstSeenAt: BASE + 15 * MIN,
    lastSeenAt: BASE + 16 * MIN,
    author: 'Bob',
    handle: '@bob',
    createdAt: null,
    cost: 8,
    breakdown: { timeline: 8 },
    timelineDwellMs: 6000,
    interactions: [],
    label: 'low',
    text: 'short glance',
  },
  {
    id: 'p3',
    viewOrder: 3,
    firstSeenAt: BASE + 25 * MIN,
    lastSeenAt: BASE + 28 * MIN,
    author: 'Carol',
    handle: '@carol',
    cost: 45,
    breakdown: { timeline: 20, dwell: 15, interaction: 10 },
    timelineDwellMs: 20000,
    interactions: [
      { type: 'like', ts: BASE + 26 * MIN },
      { type: 'unlike', ts: BASE + 27 * MIN },
    ],
    quote: { author: 'Dan', handle: '@dan', text: 'quoted text' },
    label: 'normal',
    text: 'normal engagement post',
  },
  {
    id: 'p4',
    viewOrder: 4,
    firstSeenAt: BASE + 35 * MIN,
    lastSeenAt: BASE + 37 * MIN,
    cost: 15,
    breakdown: { timeline: 15 },
    label: null,
    text: 'unlabeled post one',
  },
  {
    id: 'p5',
    viewOrder: 5,
    firstSeenAt: BASE + 2 * HOUR + 10 * MIN,
    lastSeenAt: BASE + 2 * HOUR + 14 * MIN,
    author: 'Eve',
    handle: '@eve',
    cost: 200,
    breakdown: { timeline: 80, dwell: 90, detail: 30 },
    timelineDwellMs: 60000,
    detailDwellMs: 15000,
    videoMs: 12000,
    interactions: [{ type: 'bookmark', ts: BASE + 2 * HOUR + 11 * MIN }],
    media: [{ type: 'video', url: 'https://video.twimg.com/v1.mp4' }],
    label: 'high',
    text: 'high engagement video post',
  },
  {
    id: 'p6',
    viewOrder: 6,
    firstSeenAt: BASE + 2 * HOUR + 40 * MIN,
    lastSeenAt: BASE + 2 * HOUR + 41 * MIN,
    cost: 3,
    breakdown: { timeline: 3 },
    label: 'low',
    text: 'brief low post',
  },
  {
    id: 'p7',
    viewOrder: 0,
    firstSeenAt: BASE - 20 * MIN,
    lastSeenAt: BASE - 19 * MIN,
    cost: 50,
    breakdown: { timeline: 50 },
    label: null,
    text: 'outside range post',
  },
  {
    id: 'p8',
    viewOrder: 7,
    firstSeenAt: BASE + 45 * MIN,
    lastSeenAt: BASE + 46 * MIN,
    cost: 50,
    breakdown: { timeline: 50 },
    label: 'low',
    text: 'another low post but higher cost',
  },
];

const attention = [];
for (let k = 0; k < 90; k++) {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  attention.push({ ts: BASE + k * 2 * MIN, postId: ids[k % ids.length], delta: 10 });
}
check(attention.length >= 60, 'dataset A has at least 60 attention events');

const states = [
  { ts: BASE - 30 * MIN, state: 'INACTIVE' },
  { ts: BASE, state: 'ACTIVE' },
  { ts: BASE + HOUR, state: 'UNLIMITED' },
  { ts: BASE + HOUR + 30 * MIN, state: 'RESET' },
  { ts: BASE + 2 * HOUR, state: 'ACTIVE' },
  { ts: BASE + 2 * HOUR + 30 * MIN, state: 'BLOCKED' },
];

const now = BASE + 3 * HOUR;

// ---- full pack (range = null) ----
const mdFull = buildAnalysisMarkdown({ posts, attention, states, settings: SETTINGS, state: STATE, now, range: null, version: '1.2.3-test' });

for (const heading of [
  '# X Attention Limiter — analysis pack',
  '## How to read this file',
  '## Settings at export time',
  '## Summary',
  '## Posts',
  '## Attention per minute',
  '## State events',
  '## Suggested questions for the AI',
]) {
  check(mdFull.includes(heading), `heading present: ${heading}`);
}

check(mdFull.includes('Extension version: 1.2.3-test'), 'version is included in the header');
check(mdFull.includes('Posts: 8 (6 labeled)'), 'header post/labeled counts');
check(mdFull.includes('Attention events: 90'), 'header attention event count');
check(mdFull.includes('State events: 6'), 'header state event count');

const postsCsv = section(mdFull, 'Posts');
check(postsCsv[0] === 'id,view_order,first_seen,last_seen,author,handle,created_at,cost,bd_timeline,bd_dwell,bd_detail,bd_video,bd_interaction,timeline_s,detail_s,video_s,interactions,has_media,quote,label,text', 'posts CSV header');
const postRows = postsCsv.slice(1).filter((l) => l.length);
check(postRows.length === 8, `all 8 posts present with range=null (got ${postRows.length})`);

// cost-descending sort: p5 (200) must come before p1 (120)
const idsInOrder = postRows.map((l) => parseCsvLine(l)[0]);
check(idsInOrder[0] === 'p5' && idsInOrder[1] === 'p1', `posts sorted by cost descending (got ${idsInOrder.join(',')})`);

// RFC 4180 quoting of the comma+quote text (p1)
const p1Line = postRows.find((l) => l.startsWith('p1,'));
check(p1Line.includes('"He said ""hi, there"" — cool"'), 'comma+quote text is RFC 4180 quoted');
const p1Fields = parseCsvLine(p1Line);
check(p1Fields[20] === 'He said "hi, there" — cool', 'parsed text round-trips through CSV quoting');
check(p1Fields[16] === 'like', 'p1 interactions column');
check(p1Fields[17] === '1', 'p1 has_media = 1');
const p3Fields = parseCsvLine(postRows.find((l) => l.startsWith('p3,')));
check(p3Fields[16] === 'like;unlike', 'p3 interactions include the unlike');
check(p3Fields[18] === '1', 'p3 quote flag = 1');

// summary: per-label median (low group = p2:8, p6:3, p8:50 -> sorted 3,8,50 -> median 8.0, mean 20.3)
check(mdFull.includes('| low | 3 | 20.3 | 8.0 |'), 'low-label mean/median computed correctly');
check(mdFull.includes('Total cost in range | 900.0 pt'), 'total cost in range (90 events x 10pt)');
check(mdFull.includes('Current session: mode ACTIVE'), 'current session line present');

const statesCsv = section(mdFull, 'State events');
check(statesCsv[0] === 'time,state', 'states CSV header');
const stateRows = statesCsv.slice(1).filter((l) => l.length);
check(stateRows.length === 6, `all 6 state events present (got ${stateRows.length})`);
check(mdFull.split('\n').some((l) => l.trim() === 'UNLIMITED' || l.includes(',UNLIMITED')), 'UNLIMITED state event present in output');
check(statesCsv.slice(1).some((l) => l.endsWith(',RESET')), 'RESET marker present in state events CSV');

// ---- range filter: only the 3-hour window, p7 (entirely before it) must be excluded ----
const mdRange = buildAnalysisMarkdown({
  posts,
  attention,
  states,
  settings: SETTINGS,
  state: STATE,
  now,
  range: { lo: BASE, hi: BASE + 3 * HOUR },
  version: '1.2.3-test',
});
const rangePostsCsv = section(mdRange, 'Posts');
const rangeRows = rangePostsCsv.slice(1).filter((l) => l.length);
check(rangeRows.length === 7, `range filter excludes p7 (got ${rangeRows.length} rows)`);
check(!rangeRows.some((l) => l.startsWith('p7,')), 'p7 is excluded from the ranged Posts CSV');
check(mdRange.includes('Posts: 7 (6 labeled)'), 'ranged header counts exclude p7');

// ---------------------------------------------------------------- dataset B
// A small, hand-verifiable 10-minute window for the per-minute bucket / state-marking logic:
// minute0 ACTIVE cost>0, minute1 ACTIVE cost0, minutes 2-4 INACTIVE cost0 (run: keep first+last,
// drop the middle), minute5-6 UNLIMITED cost0, minute7 UNLIMITED cost>0 (RESET marker inside,
// must not affect the state), minute8-9 BLOCKED cost0.

const T0 = Date.UTC(2024, 2, 1, 12, 0, 0); // minute-aligned
const statesB = [
  { ts: T0, state: 'ACTIVE' },
  { ts: T0 + 2 * MIN, state: 'INACTIVE' },
  { ts: T0 + 5 * MIN, state: 'UNLIMITED' },
  { ts: T0 + 7 * MIN, state: 'RESET' },
  { ts: T0 + 8 * MIN, state: 'BLOCKED' },
];
const attentionB = [
  { ts: T0 + 10e3, postId: 'x1', delta: 5 },
  { ts: T0 + 7 * MIN + 15e3, postId: 'x1', delta: 7 },
];
const mdB = buildAnalysisMarkdown({
  posts: [],
  attention: attentionB,
  states: statesB,
  settings: SETTINGS,
  state: STATE,
  now: T0 + 10 * MIN,
  range: { lo: T0, hi: T0 + 10 * MIN },
  version: '1.2.3-test',
});
const minuteCsv = section(mdB, 'Attention per minute');
check(minuteCsv[0] === 'minute,cost,state', 'minute CSV header');
const minuteRows = minuteCsv.slice(1).filter((l) => l.length).map(parseCsvLine);
check(minuteRows.length === 9, `9 of 10 minutes kept, middle of the INACTIVE run dropped (got ${minuteRows.length})`);

function localHHMM(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function rowFor(offsetMin) {
  return minuteRows.find((r) => r[0] === localHHMM(T0 + offsetMin * MIN));
}

check(!!rowFor(0) && rowFor(0)[1] === '5.0' && rowFor(0)[2] === 'ACTIVE', 'minute0: ACTIVE, cost 5.0');
check(!!rowFor(1) && rowFor(1)[1] === '0.0' && rowFor(1)[2] === 'ACTIVE', 'minute1: ACTIVE, cost 0.0 (kept, state != INACTIVE)');
check(!!rowFor(2) && rowFor(2)[2] === 'INACTIVE', 'minute2: INACTIVE run start, kept');
check(!rowFor(3), 'minute3: middle of the INACTIVE run, dropped');
check(!!rowFor(4) && rowFor(4)[2] === 'INACTIVE', 'minute4: INACTIVE run end, kept');
check(!!rowFor(5) && rowFor(5)[2] === 'UNLIMITED', 'minute5: UNLIMITED (state event applied at bucket start)');
check(!!rowFor(6) && rowFor(6)[2] === 'UNLIMITED', 'minute6: still UNLIMITED');
check(!!rowFor(7) && rowFor(7)[1] === '7.0' && rowFor(7)[2] === 'UNLIMITED', 'minute7: RESET marker does not change the state, cost 7.0');
check(!!rowFor(8) && rowFor(8)[2] === 'BLOCKED', 'minute8: BLOCKED');
check(!!rowFor(9) && rowFor(9)[2] === 'BLOCKED', 'minute9: BLOCKED');

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('ALL PASS');

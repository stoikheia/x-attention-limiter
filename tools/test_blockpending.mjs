// Node test for src/shared/blockpending.js (shouldBlock). No dependencies.
// Run with: node tools/test_blockpending.mjs

import { shouldBlock } from '../src/shared/blockpending.js';

let failures = 0;

function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}

// A viewport of 800 px sitting inside the extent of the posts that were on screen at arming time.
const ARMED_AT = 1000;
const BASE = {
  scrollY: 2000,
  innerHeight: 800,
  extentTop: 1900,
  extentBottom: 3000,
  tolerancePx: 120,
  routeChanged: false,
  onNavigation: true,
  armedAt: ARMED_AT,
  now: ARMED_AT + 5000,
  maxPendingMs: 300000,
};
const at = (over) => shouldBlock({ ...BASE, ...over });

check(at({}) === null, 'inside the extent: no block');
check(at({ scrollY: 1900 }) === null, 'top edge of the extent: no block');
check(at({ scrollY: 2200 }) === null, 'bottom edge of the extent: no block');

// Jitter of just under the tolerance in both directions is still "finishing what is on screen".
check(at({ scrollY: 1900 - 119 }) === null, 'jitter up by tol-1: no block');
check(at({ scrollY: 2200 + 119 }) === null, 'jitter down by tol-1: no block');
check(at({ scrollY: 1900 - 119, tolerancePx: 0 }) === 'scroll', 'zero tolerance: the same jitter blocks');

check(at({ scrollY: 1900 - 121 }) === 'scroll', 'beyond the tolerance above: scroll');
check(at({ scrollY: 2200 + 121 }) === 'scroll', 'beyond the tolerance below: scroll');
check(at({ scrollY: 1900 - 121, extentBottom: 1e9 }) === 'scroll', 'above the extent even with no bottom edge: scroll');

check(at({ routeChanged: true }) === 'navigation', 'route change with onNavigation: navigation');
check(at({ routeChanged: true, onNavigation: false }) === null, 'route change with onNavigation off: no block');

check(at({ now: ARMED_AT + 300001 }) === 'timeout', 'past maxPendingMs: timeout');
check(at({ now: ARMED_AT + 300000 }) === null, 'exactly maxPendingMs: not yet');

// Deterministic precedence when several conditions hold: timeout > navigation > scroll.
const all = { scrollY: 0, routeChanged: true, now: ARMED_AT + 300001 };
check(shouldBlock({ ...BASE, ...all }) === 'timeout', 'timeout wins over navigation and scroll');
check(shouldBlock({ ...BASE, ...all, now: ARMED_AT + 5000 }) === 'navigation', 'navigation wins over scroll');
check(shouldBlock({ ...BASE, ...all, now: ARMED_AT + 5000, onNavigation: false }) === 'scroll', 'scroll remains when navigation is off');

// Stage 1 of a pending window armed on a post's detail page (SPEC Amendments v0.3 A2): the
// replies are part of finishing the post, so scrolling is not new information and there is no
// extent to leave.
const REPLIES = { ...BASE, stage: 'replies', sameDetail: true };
const rep = (over) => shouldBlock({ ...REPLIES, ...over });

check(rep({}) === null, 'replies stage on the same post: no block');
check(rep({ scrollY: 1900 - 121 }) === null, 'replies stage ignores scrolling above the extent');
check(rep({ scrollY: 2200 + 121 }) === null, 'replies stage ignores scrolling below the extent');
check(rep({ scrollY: 1e6, tolerancePx: 0 }) === null, 'replies stage ignores scrolling however far');

// The media viewer of the same post is a new path but still that post; another path is not.
check(rep({ routeChanged: true }) === null, 'same post on a new path (media viewer): no navigation');
check(rep({ routeChanged: true, sameDetail: false }) === 'navigation', 'a different path: navigation');
check(rep({ routeChanged: true, sameDetail: false, onNavigation: false }) === null, 'a different path with onNavigation off: no block');

// Running out of time in the replies stage switches to the extent stage instead of blocking.
check(rep({ now: ARMED_AT + 300001 }) === 'stage2', 'past maxPendingMs in the replies stage: stage-2 sentinel');
check(rep({ now: ARMED_AT + 300000 }) === null, 'exactly maxPendingMs in the replies stage: not yet');
check(rep({ now: ARMED_AT + 300001, sameDetail: false, routeChanged: true }) === 'stage2', 'the stage switch wins over navigation');
check(shouldBlock({ ...BASE, stage: 'extent', now: ARMED_AT + 300001 }) === 'timeout', 'the extent stage still times out into a block');

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('ALL PASS');

// Default settings. All values are provisional (SPEC §35) and tunable from the Debug page.
export const DEFAULT_SETTINGS = {
  debug: true,
  limit: 10000, // pt
  resetHours: 2, // continuous absence required for FULL RESET
  leaveGraceMs: 1500, // focus must be lost for this long before ACTIVE -> BLACKOUT
  unlimitedPeriods: [
    // { start: "HH:MM", end: "HH:MM", days?: [0..6] (Sun=0) }
    { start: '21:00', end: '06:00' },
  ],
  block: {
    // Reaching the LIMIT arms BLOCK_PENDING instead of blocking at once (SPEC Amendments v0.3).
    tolerancePx: 120, // scrolling this far beyond the posts that were on screen still counts as finishing them
    maxPendingMs: 300000, // hard end of the pending window (5 min)
    onNavigation: true, // a route change (detail page, media viewer, another timeline) blocks at once
    repliesFirst: true, // pending on a post's detail page: reading its replies is part of finishing it
  },
  cost: {
    basePtPerSec: 10, // full-visibility, center-of-viewport, stationary base rate
    minVisibleRatio: 0.15, // below this share of the post visible, no cost
    edgeWeight: 0.2, // position weight at viewport edges (center = 1.0)
    positionCurve: 1.5, // exponent of the center -> edge falloff
    scrollingFactor: 0.4, // multiplier while the page is scrolling
    scrollIdleMs: 300, // no scroll event for this long = stationary
    scrollResetPx: 60, // scrolling more than this restarts a post's dwell
    dwellAccelSec: 20, // stationary seconds per +1.0 of rate multiplier
    dwellAccelMax: 2, // cap of the extra multiplier (total max = 1 + this)
    videoFactor: 1.5, // multiplier while a video in the post is playing
    detailPtPerSec: 15, // extra rate while the post's detail page is open
    detailMinMs: 3000, // detail bonus only after staying this long (SPEC §5)
    detailBonus: 30,
    mediaMinMs: 2000, // photo/video viewer bonus only after staying this long
    mediaBonus: 40,
    likeBonus: 50,
    bookmarkBonus: 80,
    replyBonus: 40,
    repostBonus: 30,
    externalLinkBonus: 60,
  },
  snapshot: {
    minCost: 5, // posts below this cost are not saved
    retentionDays: 14,
    maxPosts: 5000,
    eventRetentionDays: 30,
  },
};

export function mergeSettings(base, patch) {
  const out = structuredClone(base);
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeSettings(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

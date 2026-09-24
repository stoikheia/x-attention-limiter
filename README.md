# X Attention Limiter

Chrome Extension (Manifest V3) that measures the **Attention Cost** of every post you look at on X
and blocks X once a session limit is reached. Fully local: no external requests, no analytics,
no build step, no dependencies.

Specification: [docs/SPEC.md](docs/SPEC.md) (v0.2). Current status: **MVP / verification phase** (SPEC §36).

## Install (unpacked)

1. Open `chrome://extensions`, enable *Developer mode*.
2. *Load unpacked* → select this directory.
3. Open https://x.com. The first screen is BLACKOUT; press **Return to X** to start measuring.
4. Click the extension icon to open the Debug page (Status / Review / History / Settings).

Debug mode is ON by default (SPEC §18-19): the meter shows exact numbers and post snapshots are saved.

## How it works

| Piece | File | Role |
|---|---|---|
| Service worker | `src/background.js` | Global state machine (`ACTIVE`, `ACTIVE` + BLOCK_PENDING, `INACTIVE`=BLACKOUT, `BLOCKED`, `UNLIMITED` overlay), focus tracking, 2 h reset timer, IndexedDB writer |
| Content script | `src/content/content.js` | Post tracking (IntersectionObserver + MutationObserver), cost model at 100 ms, `+xxx pt` badges, meter, BLOCK_PENDING masks, BLACKOUT / BLOCK overlays |
| Debug page | `src/debug/` | Status, Attention Review (X-like timeline, manual Low/Normal/High labels), Attention History (line chart, state backgrounds, RESET/BLOCK markers, range → Review drill-down), Settings, data export (raw JSON, and an "Export for AI" Markdown analysis pack built by `src/debug/export.js`) |
| Shared | `src/shared/` | IndexedDB helper, default settings, UNLIMITED period logic |

Data lives in IndexedDB (`posts`, `attention`, `states`) and `chrome.storage.local` (settings, state).
Nothing is ever sent anywhere.

### Cost model (provisional, all tunable in Settings)

Per visible post, every 100 ms while ACTIVE:

```
delta = basePtPerSec × dt × visibility × position × dwellMultiplier (× videoFactor)
```

- `visibility`: visible height / min(post height, viewport height); below `minVisibleRatio` → 0
- `position`: `edgeWeight + (1 - edgeWeight) × (1 - d)^positionCurve`, `d` = distance of the visible center from the viewport center (0..1)
- `dwellMultiplier`: `scrollingFactor` while scrolling; otherwise `1 + min(dwellAccelMax, stationarySeconds / dwellAccelSec)`
- Detail page: `detailPtPerSec` while open; `detailBonus` once after `detailMinMs` (SPEC §5)
- Photo/video viewer: `mediaBonus` once after `mediaMinMs`
- Like / Bookmark / Reply / Repost / external link click: fixed bonuses. Undoing a Like, Bookmark or
  Repost takes that bonus back (never below zero): during tuning the signal of interest is sustained
  interest in the post, not the click itself. The undo is recorded as an interaction.

The breakdown (`timeline`, `dwell`, `detail`, `video`, `interaction`) is stored per post and shown in Review.

### Decisions made while implementing (spec left them open)

- **Reaching the LIMIT** does not cut a post in half: it arms BLOCK_PENDING (SPEC Amendments v0.3,
  settings under *Block timing*). The posts that were on screen at that moment may be finished —
  every other post is covered by an opaque mask and generates no cost — and X is blocked on the
  next piece of new information: scrolling out of that extent by more than `block.tolerancePx`,
  navigating if `block.onNavigation`, or `block.maxPendingMs` elapsing (the worker enforces the
  timeout too). Leaving X while pending blocks on the next **Return to X**, keeping the absence
  already accumulated. On a post's detail page the window instead starts in a *replies* stage
  (`block.repliesFirst`, on by default): nothing is masked and scrolling never blocks, so the
  thread can be read to the end, and only leaving that post does — after `block.maxPendingMs` the
  window switches to the extent rules above instead of blocking. **BLOCK release**: the reset timer starts at the moment of BLOCK; after
  `resetHours` of continuous absence a FULL RESET returns to BLACKOUT ("reset done"). No manual
  release exists outside Debug.
- **Entering UNLIMITED while ACTIVE** ends the controlled session (mode → INACTIVE); usage during
  UNLIMITED never adds cost. The absence clock (SPEC §11) only runs while the user is *not on X*, in
  any period: reading X all night does not count as absence, so the morning starts with yesterday's
  cost on BLACKOUT with the "return during the controlled period" button (SPEC §17).
- **Leaving X** is detected via `windows.onFocusChanged` + active-tab URL + page visibility, with a
  `leaveGraceMs` (1.5 s) grace so focus flicker or a page reload does not trigger BLACKOUT. The
  extension's own Debug page is neutral: focusing it neither counts as using X nor as leaving (SPEC §21).
- **Browser quit while ACTIVE**: on the next start the absence is counted from the last accepted
  measurement, so an overnight quit still yields a FULL RESET.
- **Only `x.com`, `www.`, `mobile.` and the twitter.com equivalents** are controlled; other
  subdomains (help, ads, business, …) are never overlaid.
- **Snapshots** are saved only in Debug mode and only for posts with cost ≥ `snapshot.minCost`;
  retention is `retentionDays` / `maxPosts`, pruned every 6 h.
- **Post ID** = the `/status/<id>` link that wraps the `<time>` element inside `article[data-testid="tweet"]`.

## Development

```
python3 tools/gen_icons.py     # regenerate icons/ (needs Pillow)
node --check src/content/content.js
node tools/test_blockpending.mjs  # tests the BLOCK_PENDING trigger (src/shared/blockpending.js)
node tools/test_export.mjs     # tests the "Export for AI" Markdown builder (src/debug/export.js)
```

The Debug page's Settings tab has an **Export for AI (Markdown)** button next to Export JSON: it
builds a single self-describing Markdown file (settings, a summary, and CSV tables of posts,
per-minute attention and state events) meant to be pasted into an AI assistant to help tune the
cost coefficients and the LIMIT against your own Low/Normal/High labels. Like everything else in
this extension, it is never sent anywhere automatically (SPEC §33) — only downloaded.

Reload the extension from `chrome://extensions` after editing. Open X tabs are re-injected
automatically on install and reload (`scripting` permission); the previous script tears itself
down when it notices the extension context is gone.

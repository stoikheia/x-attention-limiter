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
| Service worker | `src/background.js` | Global state machine (`ACTIVE` / `INACTIVE`=BLACKOUT / `BLOCKED`, `UNLIMITED` overlay), focus tracking, 2 h reset timer, IndexedDB writer |
| Content script | `src/content/content.js` | Post tracking (IntersectionObserver + MutationObserver), cost model at 100 ms, `+xxx pt` badges, meter, BLACKOUT / BLOCK overlays |
| Debug page | `src/debug/` | Status, Attention Review (X-like timeline, manual Low/Normal/High labels), Attention History (line chart, state backgrounds, RESET/BLOCK markers, range → Review drill-down), Settings |
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
- Like / Bookmark / Reply / Repost / external link click: fixed bonuses

The breakdown (`timeline`, `dwell`, `detail`, `video`, `interaction`) is stored per post and shown in Review.

### Decisions made while implementing (spec left them open)

- **BLOCK release**: the reset timer starts at the moment of BLOCK; after `resetHours` of continuous
  absence a FULL RESET returns to BLACKOUT ("reset done"). No manual release exists outside Debug.
- **Entering UNLIMITED while ACTIVE** ends the controlled session (mode → INACTIVE) and starts the
  absence timer; usage during UNLIMITED never adds cost. Leaving UNLIMITED therefore lands on BLACKOUT
  with the "return during the controlled period" button (SPEC §17).
- **Leaving X** is detected via `windows.onFocusChanged` + active-tab URL + page visibility, with a
  `leaveGraceMs` (1.5 s) grace so focus flicker or a page reload does not trigger BLACKOUT.
- **Snapshots** are saved only in Debug mode and only for posts with cost ≥ `snapshot.minCost`;
  retention is `retentionDays` / `maxPosts`, pruned every 6 h.
- **Post ID** = the `/status/<id>` link that wraps the `<time>` element inside `article[data-testid="tweet"]`.

## Development

```
python3 tools/gen_icons.py     # regenerate icons/ (needs Pillow)
node --check src/content/content.js
```

Reload the extension from `chrome://extensions` after editing; X tabs need a reload too.

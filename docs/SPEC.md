# X Attention Limiter — Specification v0.2

## 1. Purpose

A Chrome Extension that discourages unconsciously spending long stretches of time on X in Chrome.

Instead of a simple "N minutes per day" time limit, it converts the **Attention** (gaze, interest, digging deeper) spent while using X into points, and forcibly BLOCKs X once a certain amount has been consumed.

It is specifically meant to prevent:

- Long sessions driven by infinite scroll
- Digging deeper and deeper into one interesting post after another
- Unconsciously drifting back to X after returning to work
- Fragmented usage of the form "I have recovered a little, so I will look a little"
- The feeling that "it would be a waste not to use up the remaining points"
- Reading X for free in a background window without consuming points

On the other hand, it must not get in the way of:

- Looking at X because you actually need to
- Keeping long posts open as tabs to "read later"
- Catching up on X in bulk during designated free time

The extension is, as a rule, **fully local**.

---

# 2. Basic Concept

Internally the extension keeps an `Attention Cost`.

```text
Session Attention Cost

0 ───────────────────── LIMIT
                         │
                         ▼
                       BLOCK
```

Attention Cost is not "points granted to the user". It represents

> how much Attention has been spent on X.

During normal use, neither the exact LIMIT value nor the remaining points are shown.

---

# 3. Unit of Attention Cost

Attention Cost is measured **per post**.

Each post on screen shows the Cost that post has generated in the current session.

```text
┌─────────────────────────────────┐
│ Alice @alice                    │
│                                 │
│ About Kubernetes ...            │
│                                 │
│                         +126 pt │
└─────────────────────────────────┘
```

The display color is light green.

As a rule the display is updated at a **100 ms (0.1 s) interval**.

A post that merely passed by while scrolling shows something like

```text
+3 pt
```

while a post that was looked at for a long time shows something like

```text
+247 pt
```

so the degree of Attention is visualized in real time.

---

# 4. Attention Cost Model

Concrete formulas and coefficients are decided after testing.

The base model is

```text
visibility
    ×
viewport position
    ×
dwell time
    ×
interaction
```

## 4.1 Viewport

Take into account how much of the post is visible on screen.

A post that is sufficiently visible is rated higher than one that is only partially visible.

## 4.2 Position

The area around the center of the screen is treated as the primary gaze region with a higher weight.

Conceptual example:

```text
viewport top

    ×0.2
    ×0.7
    ×1.0   ← primary gaze region
    ×0.7
    ×0.2

viewport bottom
```

## 4.3 Dwell Time

Take into account the time during which scrolling has stopped on the same post.

The longer it is read, the more Cost it accumulates.

Besides linear accumulation, raising the Cost rate for long gazes is also under consideration.

## 4.4 Interaction

The following are used as additional Attention signals:

- Like
- Bookmark
- Reply
- Opening the post detail view
- Staying on the detail view
- Scrolling towards the replies
- Viewing images
- Watching videos
- External links

Concrete additional Cost and multipliers are undecided.

---

# 5. Accidental Operations

A single click alone is not judged as strong Attention.

For example,

```text
open post detail
↓
immediately go back
```

may be a mis-click, so no large interaction bonus is granted.

Multiple signals are combined: dwell time on the detail view, scrolling, Like, and so on.

The usual Cost from on-screen dwell is generated separately.

---

# 6. Attention Display During Normal Use

The Attention state is shown in a non-scrolling area of X.

In normal mode only a rough state is shown, such as

```text
Attention

████████░░░░
```

The following are NOT shown:

```text
Remaining: 3,482 pt
Limit: 10,000 pt
Reset in: 38:21
```

This prevents the user from thinking

> let me use up all the remaining points

or

> I can look at X again in 38 minutes.

---

# 7. ACTIVE

The state in which Attention Cost is generated is called `ACTIVE`.

Basic conditions:

```text
the X tab is active
AND
document.visibilityState == visible
AND
the Chrome / X window is in the foreground
AND
BLACKOUT has been cleared
AND
inside a CONTROLLED period
```

Attention Cost is added only while ACTIVE.

---

# 8. Leaving X

ACTIVE ends when any of the following occurs:

- Switching to another tab
- Switching to another Chrome window
- Switching from Chrome to another application
- Minimizing Chrome
- The X page becoming hidden
- Any other state in which the X window is no longer in the foreground

At that moment the state transitions

```text
ACTIVE
   ↓
BLACKOUT
```

**Closing the X tab is not required.**

Leaving multiple X tabs open to "read later" is allowed.

The number or existence of X tabs itself has no effect on the RESET decision.

---

# 9. BLACKOUT

An X screen that has once left ACTIVE is hidden by a black overlay.

Returning to X does not clear it automatically.

```text
┌──────────────────────────────┐
│                              │
│                              │
│      Restriction active      │
│                              │
│        [ Return to X ]       │
│                              │
│                              │
└──────────────────────────────┘
```

During BLACKOUT:

- The X content is not shown
- No scrolling
- No clicking
- No Attention Cost
- The RESET wait continues
- Returning to the foreground does not clear it automatically

This also prevents reading X for free from a background window.

---

# 10. Explicit Return

Clearing BLACKOUT requires

**explicitly pressing the "Return to X" button.**

```text
BLACKOUT
   ↓
[ Return to X ]
   ↓
ACTIVE
```

Therefore the sequence

```text
working
↓
accidentally select the X tab
↓
see the BLACKOUT screen
↓
go back to the original tab
```

alone is not judged as resuming X usage.

It does not affect the RESET timer either.

---

# 11. RESET

When the user has been away from X for **2 continuous hours**, the Attention state is fully RESET.

Recovery is not linear.

```text
left X

0:00 ───────────────── 1:59:59
       no recovery

2:00:00
       │
       ▼
   FULL RESET
```

Partial recovery such as

```text
30min → 25%
60min → 50%
90min → 75%
```

is NOT performed.

The reason is that it would encourage fragmented usage of the form

> I have recovered a little, so I will look at X a little.

---

# 12. Accidental Operations While Waiting for RESET

Example:

```text
10:00 leave X
      RESET wait starts

11:30 accidentally select the X tab
      BLACKOUT shown
      RESET wait continues

11:31 back to work

12:00 FULL RESET
```

On the other hand, pressing

```text
11:30
[ Return to X ]
```

counts as resuming usage.

The continuous absence accumulated so far no longer counts.

A new 2-hour period is measured from the next time the user leaves X.

---

# 13. RESET State Display

The BLACKOUT screen does not show the remaining time until RESET.

Before RESET:

```text
● Restriction active

[ Return to X ]
```

After RESET:

```text
● Reset done

[ Return to X ]
```

That is:

| Information | Shown |
|---|---|
| Whether RESET has happened | yes |
| Remaining time until RESET | no |
| Remaining Attention | no |
| LIMIT value | no |

---

# 14. BLOCK

When Attention Cost reaches the internal LIMIT, the state transitions

```text
ACTIVE
  ↓
Attention LIMIT
  ↓
BLOCKED
```

Unlike BLACKOUT, no ordinary return operation is offered.

```text
┌──────────────────────────────┐
│                              │
│      Attention Limit         │
│         reached              │
│                              │
│      X has been stopped      │
│                              │
└──────────────────────────────┘
```

Roles:

**BLACKOUT**

> friction that can be cleared by one's own will

**BLOCK**

> a hard limit that cannot be cleared by oneself

The details of the BLOCK release condition are undecided.

---

# 15. UNLIMITED

During designated periods, the extension's restrictions are completely disabled.

Initial proposal:

```text
21:00 – 06:00 (next day)
```

Main uses:

- Catching up on "read later" posts
- Free use at night

During UNLIMITED:

- No Attention Cost
- No `+xxx pt` display
- No Attention meter
- No BLACKOUT
- No BLOCK

In other words, X behaves as normal X.

---

# 16. UNLIMITED Period Settings

Multiple periods can be registered.

Example:

```text
21:00 – 06:00
12:00 – 13:00
```

Periods crossing midnight are allowed.

Internal model example:

```json
{
  "unlimitedPeriods": [
    {
      "start": "21:00",
      "end": "06:00"
    },
    {
      "start": "12:00",
      "end": "13:00"
    }
  ]
}
```

The data structure must be able to accommodate future day-of-week specification.

---

# 17. Boundaries with UNLIMITED

CONTROLLED → UNLIMITED:

```text
20:59 CONTROLLED
21:00
   ↓
UNLIMITED
   ↓
restrictions lifted immediately
```

UNLIMITED → CONTROLLED:

```text
05:59 browsing X
06:00
   ↓
CONTROLLED
   ↓
BLACKOUT

[ Return to X during the controlled period ]
```

This prevents drifting from nighttime browsing straight into the morning CONTROLLED period.

Usage during UNLIMITED is not added to the CONTROLLED-period Attention Cost.

---

# 18. Test / Debug Mode

Test/Debug Mode is used while tuning the Attention Cost.

Debug Mode does not change the restriction logic itself.

It additionally shows internal information that is hidden during normal use.

```text
Attention Debug

Limit       10,000 pt
Consumed     3,482 pt
Remaining    6,518 pt

███████░░░░░░░░░ 34.8%

Reset        PENDING
```

In Debug Mode the following can be inspected:

- LIMIT
- Consumed
- Remaining
- RESET state
- Cost breakdown

In particular, **the remaining points can be shown**.

---

# 19. Post Snapshot

While in Debug Mode, viewed posts are saved locally for verification.

Saved fields:

```text
Post ID
Author display name
handle
body text
posted at

quoted post
media URLs

Attention Cost
Cost breakdown

timeline dwell time
detail dwell time
interactions

firstSeenAt
lastSeenAt
viewOrder
```

The HTML itself is not saved; data is saved in structured form.

---

# 20. Media

Image and video bodies are not saved locally.

What is saved:

```text
type
URL
thumbnail URL
alt text
width / height (if obtainable)
```

and the like.

The Review screen fetches images and videos from the saved URLs.

If the original media has been deleted or expired, it is acceptable that it can no longer be displayed.

Media is lazy-loaded.

---

# 21. Attention Review

The Debug screen shows the saved Post Snapshots in an **X-like timeline UI**.

```text
Attention Review

[ By cost ▼ ] [ By view order ]


┌──────────────────────────────────┐
│ Alice @alice                     │
│                                  │
│ About Kubernetes ...             │
│                                  │
│                         +842 pt  │
│                                  │
│ Timeline 12.4s · Detail 7.3s ♥  │
│                                  │
│        [Low] [Normal] [High]     │
└──────────────────────────────────┘
```

The Review screen

- does not fetch new posts
- does not perform Like / Reply etc.
- does not generate Attention Cost
- does not affect the RESET timer

It is a static analysis screen.

---

# 22. Review Sort

At minimum, switching between

```text
by Attention Cost
by viewing order (chronological)
```

must be possible.

The Cost order is used to check the validity of the Attention model.

The chronological order is used to see how Attention changed during a session.

---

# 23. Manual Attention Rating

During Debug, each post can be given a manual label:

```text
Actual attention

[ Low ] [ Normal ] [ High ]
```

The purpose is to compare

**the computed Attention Cost**

with

**the user's own impression.**

This is for tuning the Cost formula, not for machine learning.

---

# 24. Attention History

The Debug / analysis screen has a time-series chart.

Purpose:

- See how Attention Cost changes over time
- See in which periods X was used
- See the inactive periods in which the user could focus
- See the relationship with BLOCK / RESET
- Investigate the posts behind Attention peaks

---

# 25. History Display Span

The following must be switchable:

```text
[ 3h ] [ 6h ] [ 12h ] [ 1d ] [ 3d ] [ 7d ]
```

The bucket width changes automatically with the span.

Initial proposal:

| Span | Bucket |
|---|---:|
| 3h | 1 min |
| 6h | 2 min |
| 12h | 5 min |
| 1d | 10 min |
| 3d | 30 min |
| 7d | 1 hour |

Raw data is not stored per bucket; it is aggregated at display time.

This allows the bucket settings to be changed later.

---

# 26. Attention History Chart

Attention Cost is shown as a **line chart**.

The basic metric is not the cumulative value but

```text
Attention Cost / time
```

For example, with 1-minute buckets:

```text
11:20   120 pt
11:21   480 pt
11:22   930 pt
11:23   210 pt
```

Periods in which Attention was strongly captured then appear as "peaks".

For Debug use, switching between

```text
Cost Rate
Cumulative Cost
```

is also under consideration.

---

# 27. Inactive Periods

The chart background is used to express the X state.

In particular, **inactive periods use a different background color**.

Concept:

```text
Attention
  │
  │        ╭──╮                 ╭╮
  │   ╭────╯  ╰╮                ││
  │───╯        ╰────────────────╯╰──
  └────────────────────────────────── time
       ░░░░░░░░░░      ░░░░░░░░
         INACTIVE          INACTIVE
```

The state is recorded explicitly rather than inferred from periods where Attention Cost was 0.

This distinguishes

```text
ACTIVE but Attention Cost 0
```

from

```text
away from X
```

---

# 28. States on the History Chart

At least the following are distinguished:

```text
ACTIVE       normal background
INACTIVE     background A
UNLIMITED    background B
BLOCKED      background C
```

The actual colors are decided during UI implementation.

UNLIMITED is not "time spent focused", so it must not share INACTIVE's background.

---

# 29. RESET / BLOCK Markers

Event markers are shown on the History chart.

RESET:

```text
           RESET
             │
             ▼
─────────────│─────────────
```

BLOCK:

```text
           BLOCK
             │
             ▼
─────────────│─────────────
```

This makes patterns such as

> use X → long absence → RESET → use again

visible along the time axis.

---

# 30. History → Post Review Drill-down

Selecting an Attention Cost peak or a time range on the chart shows details such as

```text
11:20–11:25

Attention Cost: 2,840 pt

High-cost posts

+842  Kubernetes...
+617  ...
+381  ...

[ Show posts in this period ]
```

"Show posts in this period" opens Attention Review filtered to that time range.

This realizes the verification workflow

```text
Attention History
       ↓
notice an abnormal peak
       ↓
select the period
       ↓
Post Review
       ↓
check what was being read
       ↓
evaluate the validity of the Attention Cost
```

---

# 31. Time-series Data

Separately from Post Snapshots, a lightweight time-series log is kept.

Concept:

```text
AttentionEvent
  timestamp
  postId
  costDelta

StateEvent
  timestamp
  state
```

State candidates:

```text
ACTIVE
INACTIVE
BLOCKED
UNLIMITED
RESET
```

Attention Cost does not need to be written to persistent storage every 100 ms.

It is aggregated in memory and flushed to IndexedDB in suitable units.

---

# 32. Data Storage

IndexedDB is the primary storage.

Stored data is split broadly into

```text
PostSnapshots
AttentionEvents
StateEvents
Settings
```

Post body snapshots and large time-series data are never put into Chrome `storage.sync`.

Only small data such as settings may use Chrome Storage.

---

# 33. Security / Privacy

Principles:

- No external API communication
- No analytics
- No CDN JavaScript
- Minimal external dependencies
- No automatic sending to ChatGPT
- No external transmission of X browsing data
- Target hosts limited to X / Twitter
- Minimal Chrome permissions
- Post HTML itself is never saved
- On Review, saved text is rendered as text
- Media URLs are used only as permitted media attributes

Communication with X / CDN during Media Review is accepted.

---

# 34. State Transitions

Overall picture:

```text
                    ┌─────────────┐
                    │  UNLIMITED  │
                    │  normal X   │
                    └──────┬──────┘
                           │
                    CONTROLLED starts
                           │
                           ▼
                    ┌─────────────┐
              ┌────►│  BLACKOUT   │
              │     └──────┬──────┘
              │            │
              │     [ Return to X ]
              │            │
              │            ▼
              │     ┌─────────────┐
              │     │   ACTIVE    │
              │     │ Cost added  │
              │     └──┬───────┬──┘
              │        │       │
              │      leave   LIMIT
              │        │       │
              └────────┘       ▼
                         ┌─────────────┐
                         │   BLOCKED   │
                         └─────────────┘
```

In BLACKOUT / INACTIVE:

```text
INACTIVE starts
      │
      │ less than 2 hours
      │ no Cost recovery
      │
      ▼
2 hours of continuous absence
      │
      ▼
 FULL RESET
```

---

# 35. Currently Undecided Items

### Attention Cost

- Base pt/sec
- Viewport visibility coefficient
- Position coefficient
- Dwell-time acceleration
- Like bonus
- Bookmark bonus
- Detail bonus
- Reply-viewing bonus
- Handling of media viewing

### Attention Limit

- LIMIT value
- Fixed or variable
- Meter representation in the normal UI

### BLOCK

- BLOCK release condition
- Relationship with RESET

### Unlimited

- Whether day-of-week specification is in the first version

### Snapshot

- Minimum display time to be saved
- Retention period
- Maximum number of records
- Automatic deletion conditions

### History

- Final bucket widths
- Cost Rate / Cumulative toggle
- Concrete background representation
- Chart interaction

### X DOM

- Post identification method
- SPA navigation handling
- MutationObserver / IntersectionObserver design
- Resilience to X-side DOM changes

---

## 36. MVP and Verification Phase

Rather than trying to get the Attention Cost "right" from the start, the first version is built as an **extension that can measure and visualize**.

The first stage builds up to:

1. ACTIVE / BLACKOUT / UNLIMITED state management
2. FULL RESET after 2 hours of continuous absence
3. Per-post Attention Cost measurement
4. Real-time `+xxx pt` on posts
5. Limit / Consumed / Remaining display in Debug
6. Post Snapshot
7. X-like Attention Review
8. Attention History
9. Background display for INACTIVE / UNLIMITED etc.
10. RESET / BLOCK markers
11. Drill-down from History to Post Review

Then use it for real for several days to a week and verify

**how well the Attention Cost matches "the posts I actually paid strong attention to".**

Use the result to tune the Cost formula and the LIMIT, and only once that is convincing, move to the normal mode **"hard BLOCK with hidden remaining amount"**.

---

## Amendments (v0.3)

### A1. BLOCK_PENDING — finish what is on screen

§14 blocked the moment Attention Cost reached the LIMIT, which could cut a post in half. The
transition now has an intermediate stage.

```text
ACTIVE
  ↓
Attention LIMIT
  ↓
BLOCK_PENDING     finish what is on screen
  ↓
new information
  ↓
BLOCKED
```

BLOCK_PENDING is not a separate mode: the state stays `ACTIVE` with a `blockPending` flag, so
measurement continues as before. The Attention Cost may therefore exceed the LIMIT; that is
intended and is not corrected.

#### What may still be done

The posts that were on screen at the moment the LIMIT was reached may be finished. Their
**extent** (the top of the topmost visible post to the bottom of the bottommost visible one, in
document coordinates) is recorded; with no post on screen, the viewport itself is the extent.

Every post that was **not** on screen at that moment is covered by an **opaque** mask, whether it
was already loaded or arrives afterwards. A masked post cannot be read and generates no Attention
Cost, so scrolling inside the tolerance cannot be used to keep reading.

#### What triggers BLOCK

Whichever comes first:

| Trigger | Condition |
|---|---|
| Scroll | the viewport leaves the extent by more than `block.tolerancePx` in either direction |
| Navigation | the route changes (post detail, media viewer, another timeline), if `block.onNavigation` |
| Timeout | `block.maxPendingMs` have passed since the LIMIT was reached |

Scrolling *within* the extent — finishing a long post, trackpad jitter up and down — is allowed,
and coming back inside does not move the extent: it is fixed at the moment the LIMIT was reached.

The timeout is also enforced by the service worker, so a stopped or dead content script cannot
keep a pending session open.

#### Leaving X while pending

Leaving X while pending is ordinary absence: BLACKOUT is shown and the RESET clock runs (§9, §11).
The pending state survives, so the next **Return to X** goes straight to BLOCK instead of ACTIVE,
and the absence accumulated since the LIMIT was reached **keeps counting** — the user never used X
in between, so §12 does not apply. A FULL RESET during that absence clears the pending state with
everything else.

Entering UNLIMITED ends the controlled session and with it the pending state (§17). The Attention
Cost stays, so the next Return to X during the controlled period blocks at once.

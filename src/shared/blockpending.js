// BLOCK_PENDING trigger decision (SPEC Amendments v0.3), kept pure so it can be tested in Node.
//
// Once the LIMIT is reached the controlled session does not end mid-post: the user may finish
// what is on screen. It ends as soon as new information arrives — the viewport leaves the extent
// of the posts that were visible when the limit was reached, the route changes, or the pending
// window expires.
//
// The pending window has two stages (A2). On a post's detail page with `block.repliesFirst` the
// window opens in the `'replies'` stage: the replies of that post are part of finishing it, so
// scrolling never ends the window and no post is masked. Only leaving the post ends it — the
// media viewer of the same post (`/status/<id>/photo/N`) is still that post, which the caller
// reports as `sameDetail`. Everywhere else, and after the replies stage, the window is in the
// `'extent'` stage: the original rules, triggered by scroll, navigation or timeout.
//
// Content scripts cannot import modules, so src/content/content.js inlines the same logic in
// `pendingReason()`; keep the two in sync.
//
// Returns the block reason, or null while the session may continue. When several conditions hold
// at once the precedence is timeout > navigation > scroll. The one return value that is not a
// block is the `'stage2'` sentinel: the replies stage ran out of time, and the caller switches to
// the extent stage (fresh `armedAt`, extent recorded, masks applied) instead of blocking.
export function shouldBlock({ stage = 'extent', sameDetail = false, scrollY, innerHeight, extentTop, extentBottom, tolerancePx, routeChanged, onNavigation, armedAt, now, maxPendingMs }) {
  const replies = stage === 'replies';
  if (now - armedAt > maxPendingMs) return replies ? 'stage2' : 'timeout';
  if (routeChanged && onNavigation && !(replies && sameDetail)) return 'navigation';
  if (replies) return null; // the replies of the post being finished: scrolling is not new information
  if (scrollY < extentTop - tolerancePx || scrollY + innerHeight > extentBottom + tolerancePx) return 'scroll';
  return null;
}

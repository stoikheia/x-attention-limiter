// BLOCK_PENDING trigger decision (SPEC Amendments v0.3), kept pure so it can be tested in Node.
//
// Once the LIMIT is reached the controlled session does not end mid-post: the user may finish
// what is on screen. It ends as soon as new information arrives — the viewport leaves the extent
// of the posts that were visible when the limit was reached, the route changes, or the pending
// window expires.
//
// Content scripts cannot import modules, so src/content/content.js inlines the same logic in
// `pendingReason()`; keep the two in sync.
//
// Returns the block reason, or null while the session may continue. When several conditions hold
// at once the precedence is timeout > navigation > scroll.
export function shouldBlock({ scrollY, innerHeight, extentTop, extentBottom, tolerancePx, routeChanged, onNavigation, armedAt, now, maxPendingMs }) {
  if (now - armedAt > maxPendingMs) return 'timeout';
  if (routeChanged && onNavigation) return 'navigation';
  if (scrollY < extentTop - tolerancePx || scrollY + innerHeight > extentBottom + tolerancePx) return 'scroll';
  return null;
}

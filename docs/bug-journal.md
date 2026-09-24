# Bug journal (BJ-xxx)

Real bugs in this extension found at runtime. Newest first. Library/browser-behaviour issues
that we only work around go to `third-party-issues.md` instead.

## BJ-001 — X tabs open before install/reload were never controlled (2026-09-24)

- **Symptom**: after loading or reloading the extension, X tabs that were already open showed no
  overlay, no badges and no meter; only newly loaded X pages were controlled.
- **Root cause**: Chrome injects `content_scripts` only into documents loaded after the extension
  is (re)installed. Nothing re-injected into existing tabs, so SPEC §9 ("no free reading") was
  violated until the user reloaded each tab.
- **Fix**: on `runtime.onInstalled`, query open X tabs and inject `src/content/content.js` with
  `chrome.scripting.executeScript` (`scripting` permission added). The script's load guard makes a
  second injection a no-op; the orphaned previous script tears itself down (commit 90c2215).
- **Status**: fixed, awaiting confirmation in real use.
- **Lesson**: treat "already open" as a first-class state for anything that must be enforced on
  existing pages; the smoke test opened X *after* loading the extension and could not see this.

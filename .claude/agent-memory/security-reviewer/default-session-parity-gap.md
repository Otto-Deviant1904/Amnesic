---
name: default-session-parity-gap
description: configureSession() and cleanupAndExit() in src/main/index.ts only act on the in-memory tab partition, never on session.defaultSession used by the shell BrowserWindow
metadata:
  type: project
---

The shell `BrowserWindow` created in `createWindow()` (`src/main/index.ts`)
has no `session` set in its `webPreferences`, so it runs on Electron's
`session.defaultSession`. `configureSession()` — which disables the
spellchecker, denies all permission requests, and strips/rewrites the
`Referer` header — only ever calls methods on `getInMemorySession()` (the
`'inmemory-session'` partition used by tab `WebContentsView`s). Same for
`cleanupAndExit()`, which only calls `clearStorageData()` / `clearCache()` /
`clearAuthCache()` on that same partition, never on `defaultSession`.

**Why this matters:** the shell window hosts the address bar (free-text
input) and tab strip, which is trusted first-party UI, not
attacker-controlled content, so the practical risk is low. But it's a real
parity gap against the threat-model.md mitigation table (e.g. spellchecker
row), and on platforms without the tmpfs `userData` redirect (macOS/Windows
— see threat-model.md §4 known limitation 5, Linux-only redirect as of this
commit), anything Chromium writes for `defaultSession` lands on a real
persistent disk path, uncleaned by `cleanupAndExit()`.

**How to apply:** On future reviews, check whether this has been resolved
by either (a) also applying `setSpellCheckerEnabled(false)` /
`setPermissionRequestHandler` / storage-clearing to `session.defaultSession`,
or (b) an explicit ADR/comment stating defaultSession is intentionally out
of scope because it never loads user-navigable content. Absent either, keep
flagging as a Warning (not Critical — the shell UI is trusted content, so
this is a docs/parity gap, not an active leak of browsed-page data).

Related: [[webrtc-preload-layer-gap]], [[project-verification-rigor]]

# Exit behavior, Windows integration APIs, and sandbox defaults — verified against Electron 43.0.0

**Date:** 2026-07-01
**Pinned version:** electron@43.0.0 / Chromium 150.0.7871.46
Sources: `https://www.electronjs.org/docs/latest/api/app`, `https://www.electronjs.org/docs/latest/api/dialog`, `https://www.electronjs.org/docs/latest/api/browser-window`.

## 12. `app.exit(0)` vs `app.quit()`

**Verified: TRUE, behavioral difference confirmed, matches the plan's assumption exactly.**

- `app.quit()`: "Try to close all windows. The `before-quit` event will be emitted first. If all windows are successfully closed, the `will-quit` event will be emitted and by default the application will terminate." — i.e. graceful, cancelable (a window's `beforeunload`/close handler can abort it), and asynchronous relative to the calling code.
- `app.exit([exitCode])`: "Exits immediately with `exitCode`. `exitCode` defaults to 0. All windows will be closed immediately without asking the user, and the `before-quit` and `will-quit` events will not be emitted." — immediate, synchronous-feeling, uncancelable, skips lifecycle events entirely.
- This confirms the plan's Section 4.3 design is correct as documented: run the `clearStorageData`/`clearCache`/`clearAuthCache` cleanup **first**, `await` them, _then_ call `app.exit(0)` — since `app.exit()` skips `will-quit`, any cleanup that was hooked to that event instead of being awaited inline before the call would never run. The plan's actual code already awaits cleanup before calling `app.exit(0)`, so it does not have this bug — just confirming the reasoning is sound for v43.
- No code change needed. Source: https://www.electronjs.org/docs/latest/api/app

## 13. `app.setJumpList(null)`

**Verified: TRUE, still valid, Windows-only, signature slightly more specific than the plan implies.**

- Current signature: `app.setJumpList(categories)` where `categories` is `JumpListCategory[] | null`. Windows-only (no-op on other platforms, per docs — safe to call unconditionally, doesn't need an `if (process.platform === 'win32')` guard, though adding one costs nothing and documents intent).
- Passing `null` "replaces the previously set custom Jump List... with the standard Windows Jump List" per current docs — meaning `setJumpList(null)` **restores Windows' default automatic Jump List behavior (recently/frequently used items), it does not disable Jump List tracking entirely.** This is a meaningful gap versus the plan's stated intent ("Set `app.setJumpList(null)` ... don't register file associations" as the mitigation for "Windows tracks recently opened files/apps").
- **Correction needed:** to actually prevent Windows from populating a Jump List with recent-item entries for this app, you need `app.setJumpList([])` (an **empty array**, not `null`) which Electron's docs describe as clearing/removing the custom Jump List content — combined with never calling `app.addRecentDocument()` anywhere in the codebase (that's the API that actually feeds Windows' recent-items/Jump List tracking; if it's never called, there's nothing for Windows to show regardless of the `setJumpList` argument). Recommend the implementation explicitly bans `app.addRecentDocument` (e.g., grep in CI) rather than relying solely on `setJumpList(null)`.
- Source: https://www.electronjs.org/docs/latest/api/app

## 14. `dialog.showOpenDialog(..., { properties: ['dontAddToRecent'] })`

**Verified: TRUE but narrower platform scope than the plan implies.**

- `dontAddToRecent` is confirmed present in current `dialog` docs: "Do not add the item being opened to the recent documents list." **Platform: Windows only.**
- **Correction needed:** the plan's table (Section 3.2) lists this flag as the mitigation for Linux's `recently-used.xbel` (GTK file-chooser recent-files tracking). That's incorrect — `dontAddToRecent` does nothing on Linux; it's a Windows-specific dialog property. There is no equivalent Electron-level flag for suppressing GTK's `recently-used.xbel` entry on Linux — GTK's native file chooser (which Electron's dialog wraps on GTK-based desktops) manages that list itself. The realistic mitigations are: (a) avoid native file open/save dialogs entirely in v1 (the plan already scopes out downloads/file-save features, so this may be moot), or (b) if a dialog is unavoidable, post-process by removing the corresponding entry from `~/.local/share/recently-used.xbel` after the dialog closes — a real disk write/rewrite, which itself needs its own audit per this project's `CLAUDE.md` rule about non-tmpfs writes needing an ADR.
- Source: https://www.electronjs.org/docs/latest/api/dialog

## Bonus — 18. BrowserWindow security defaults (`sandbox`, `contextIsolation`, `nodeIntegration`)

**Verified: the plan's assumption that these must be explicitly set is partially outdated — good news, less code needed.**

- `sandbox`: current docs state "Default is `true` since Electron 20." Electron 43 is far past that threshold — **sandboxing is on by default for all new `BrowserWindow`/`webPreferences` unless explicitly set to `false`.** The plan's architecture doc (Section 2.2) treats `sandbox: true` as something that must be explicitly configured; it's actually already the default and only needs to be explicit if you want to _document intent_ (recommended for a security-focused README/ADR) or guard against a future contributor accidentally setting it to `false`.
- `contextIsolation`: docs confirm "Defaults to `true`." Also has been the default since Electron 12. Same situation — explicit setting is for documentation/guard-rail purposes, not because it's required to achieve the behavior.
- `nodeIntegration`: docs confirm "Default is `false`." Also already off by default.
- **Recommendation:** keep explicit `sandbox: true, contextIsolation: true, nodeIntegration: false` in the `BrowserWindow` constructor anyway — not because Electron 43 needs it to function correctly, but because (a) it's self-documenting for a privacy/security portfolio project where the README explicitly wants to show "here's the exact list of flags we set, verify it yourself," and (b) an explicit setting survives future Electron defaults changes or a contributor's local override more safely than relying on implicit defaults. This is a case where the plan's over-caution is harmless and worth keeping for narrative/audit reasons even though it's not strictly load-bearing on v43.
- Source: https://www.electronjs.org/docs/latest/api/browser-window

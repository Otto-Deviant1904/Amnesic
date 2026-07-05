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

## 19. Which mechanism actually delivers the panic key (`Ctrl+Shift+Q`) regardless of focus

**Verified: `before-input-event`, already wired for every existing shortcut, is sufficient — no `Menu`/accelerator table needed.**

- The codebase has no `Menu.setApplicationMenu()` call anywhere (grepped `src/`); `autoHideMenuBar: true` only hides Electron's default menu bar, it doesn't construct a custom one with `accelerator` strings. Introducing a `Menu` solely to carry one global shortcut would be new subsystem surface (with its own Linux GTK/Wayland accelerator-dispatch quirks) duplicating what the existing mechanism already does.
- Every existing browser-chrome shortcut (`Ctrl+T`, `Ctrl+W`, `Ctrl+L`, `Ctrl+F`, `Ctrl+R`, `Ctrl+1..9`, `Alt+Left/Right`, …) is delivered through `webContents.on('before-input-event', ...)`, attached independently in two places: `attachShortcuts(mainWindow.webContents, 'shell')` in `createWindow()`, and `attachShortcuts(view.webContents, 'tab')` inside `createTab()` for every tab. Both feed the same `handleShortcut(input, source)` function.
- Per Electron's `WebContents` docs, `before-input-event` "is emitted before dispatching the `keydown` and `keyup` events in the page" — it fires for **all** keyboard input reaching that `WebContents`, with no built-in carve-out for a focused editable element (this is precisely why it's usable to intercept shortcuts a focused `<input>` would otherwise consume, e.g. overriding `Ctrl+A`). That means `mainWindow.webContents`'s handler already fires regardless of whether the address bar `<input>` or the find bar currently holds DOM focus — both live in the same shell `WebContents` — and a tab's `WebContentsView` is a structurally separate renderer the shell's own `window` object cannot observe at all, which is exactly why the `'tab'`-sourced attachment (not a renderer-side listener) is the only way to guarantee delivery there.
- **Conclusion:** the two existing `attachShortcuts()` call sites already cover every location the panic key must reach (address bar, find bar → `'shell'` source; page content → `'tab'` source). Adding `Ctrl+Shift+Q` to the shared `handleShortcut()` shift-branch (alongside `Ctrl+Shift+R`) is sufficient; no `Menu` accelerator, no new IPC channel, and no renderer-side (`App.tsx`) duplicate handler are needed. `cleanupAndExit()`'s existing `cleanupStarted` guard (src/main/index.ts) makes this safe even if some future input source fires it more than once.
- Verified by direct test, not just by reading docs: `tests/e2e/panic-key.spec.ts` fires the accelerator via `webContents.sendInputEvent()` targeted at a **tab's own** `WebContents` (bypassing the shell entirely, since Playwright's `_electron` API only exposes `BrowserWindow`-level pages, not individual `WebContentsView`s) and asserts the process exits and the tmpfs userData dir is removed — proving the `'tab'`-source path independently of the `'shell'`-source path.
- Source: https://www.electronjs.org/docs/latest/api/web-contents (`before-input-event`, `sendInputEvent`)

## 20. Playwright's `page.keyboard.press()` does not reach `before-input-event` at all — `webContents.sendInputEvent()` does

**Verified empirically by a controlled comparison — not documented in either project's docs, and easy to get burned by while writing e2e coverage for any future main-process-only keyboard shortcut.**

- Building the New Identity (`Ctrl+Shift+N`, ADR 0009) e2e test, `window.keyboard.press('Control+Shift+N')` (Playwright's `_electron` `Page.keyboard`, which drives Chromium via CDP's `Input.dispatchKeyEvent`) produced **zero** `before-input-event` firings on `mainWindow.webContents` — confirmed by temporarily instrumenting `handleShortcut()` to log every invocation to a file: the log stayed empty through an entire test run that pressed the combo, even though the same combo sent via `webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control', 'shift'] })` (called from the main process via `app.evaluate()`) reached `handleShortcut()` immediately and drove `newIdentity()` to completion correctly.
- Practical consequence for this codebase's existing tests: shortcuts implemented in **both** places (main's `handleShortcut()` and the renderer's own `App.tsx` `window.addEventListener('keydown', ...)` — e.g. `Ctrl+T`, `Ctrl+F`) appear to work when driven by `page.keyboard.press()` in e2e tests, but that success is coming entirely from the renderer-side listener (a real DOM `keydown`, which CDP's `Input.dispatchKeyEvent` does reliably deliver to the focused element) — not from main's `before-input-event` handler. Shortcuts added **only** to `handleShortcut()` (the shift-modified combos: `Ctrl+Shift+Q`, `Ctrl+Shift+R`, `Ctrl+Shift+N` — none of which are duplicated in `App.tsx`, see §19) are consequently **untestable via `page.keyboard.press()`** and need `webContents.sendInputEvent()` targeted at the relevant `WebContents` instead — `mainWindow.webContents` for the `'shell'` source, a tab's own `webContents` (looked up via `webContents.getAllWebContents()`) for the `'tab'` source.
- This says nothing about real end-user keyboard behavior — physical key presses reach Electron through the OS's native input path (X11/Wayland → Chromium's browser-process-side widget host), a different pipeline from CDP's synthetic injection, which is built for automating page content rather than embedder-level (`before-input-event`) shortcuts. The gap is a testing-methodology fact about this Electron/Playwright pairing, not a regression in the app.
- Applied in `tests/e2e/new-identity.spec.ts` and `tests/e2e/panic-key.spec.ts`: both drive their shift-combo via `sendInputEvent()`, not `page.keyboard.press()`.

## 21. No runtime API reports whether `crashReporter.start()` was ever called

**Verified: TRUE, confirmed against Electron 43's own type definitions, not just its docs prose.**

Checked every member of the `CrashReporter` interface in `node_modules/electron/electron.d.ts`
(v43.0.0): `addExtraParameter`, `getLastCrashReport`, `getParameters`, `getUploadedReports`,
`getUploadToServer`, `removeExtraParameter`, `setUploadToServer`, `start`. None of them is a
boolean/status getter for "has `start()` been called" — `getUploadToServer()` reflects a
setting `start()` or `setUploadToServer()` would configure, not whether either was ever
invoked, and the crash-report-listing methods (`getLastCrashReport`, `getUploadedReports`)
answer a different question (were any crashes _uploaded_) that says nothing about whether the
reporter is _armed_. There is no supported way for a self-audit panel to ask Electron 43 "is
the crash reporter currently active" at runtime.

- Consequence for the self-audit panel (Phase 1.3): the crash-reporter row must be presented
  honestly as build/CI-enforced (the `crashReporter.start(` grep, ADR 0002), not as a runtime
  check — doing otherwise would be exactly the overclaiming this project exists to avoid.
- Source: `node_modules/electron/electron.d.ts` (`CrashReporter` interface, v43.0.0).

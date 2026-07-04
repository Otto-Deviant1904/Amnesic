# 0005: Sprint 2 usability features and how each stays inside the amnesic envelope

## Status

Accepted

## Context

After ADR 0004 the core claim is proven in CI, but the first hour of real
use hits missing table-stakes browser behavior: no context menus anywhere
(Electron ships none), no find-in-page, sites behind HTTP basic auth
silently fail (the `login` event was unhandled), failed loads and rejected
certificates leave Chromium's blank grey page, and HTML5 video fullscreen
is broken by the blanket permission denial. None of these are charter-gated
non-goals, but several touch surfaces the threat model cares about
(permissions, network fetches, credentials), so the mechanism choices are
recorded here.

## Decisions

1. **HTML5 fullscreen is carved out of the blanket permission denial.**
   `setPermissionRequestHandler` now answers `permission === 'fullscreen'`
   instead of `false`. Fullscreen is a display-state request — it exposes no
   sensor, storage, or network capability — and denying it broke video
   fullscreen everywhere. Every other permission (media, geolocation,
   notifications, …) remains denied; `'media'` denial stays load-bearing as
   WebRTC mitigation layer 3 (ADR 0002/0003). The `enter/leave-html-full-screen`
   events drive layout (view covers the chrome, OS window goes fullscreen);
   switching or closing the fullscreen tab force-resets the state because
   those events never fire for hidden/destroyed views.

2. **Favicons are fetched by main through the tab's own session.** The
   obvious implementation — the shell renderer rendering
   `<img src="https://…">` — would make the privileged shell session issue
   network requests to page-controlled URLs. Instead main fetches via
   `ses.fetch()` on the in-memory partition (inheriting its referrer
   stripping), caps the payload at 256 KB, and ships the shell a `data:` URI
   over IPC. The shell renderer performs no network I/O; the bytes die with
   the session.

3. **HTTP basic/proxy auth uses an in-shell dialog; credentials are
   pass-through only.** `app.on('login')` holds the challenge open and asks
   the user via the shell. Credentials cross IPC once, go straight into
   Chromium's auth callback, and are stored nowhere by the app. Chromium's
   own per-session auth cache is memory-backed here (non-persistent
   partition) and `clearAuthCache()` at exit remains as belt-and-suspenders.
   The requesting tab's view is hidden while the dialog is up because shell
   DOM cannot render above a `WebContentsView` — which is also why the find
   bar is a chrome row rather than an overlay.

4. **Failed loads render an in-shell error page; no certificate bypass.**
   `did-fail-load` (main frame, code ≠ -3/ERR_ABORTED) hides the view and
   hands the renderer the error triple; the shell renders a friendly page
   with retry. There is deliberately no `certificate-error` handler:
   Electron's default — reject the connection — stands, so ERR_CERT_* is
   just another error page and v1 offers no "proceed anyway". Two
   empirically-found subtleties (both caught by the new e2e tests, in the
   project's verify-don't-assert spirit):
   - Chromium commits an internal error page _after_ `did-fail-load`, which
     fires `did-finish-load` — clearing error state on that event erases it
     the moment it is set. Recovery is instead detected via `did-navigate`
     with `httpResponseCode !== -1` (-1 means a non-HTTP commit, and tabs
     only load http(s), so -1 is exactly the internal error page).
   - `findInPage`'s `findNext` option means the reverse of its name in
     current Electron: `true` begins a NEW find session, `false` continues
     it (verified against electron@43 typings).

5. **Find bar, context menus, tab niceties live in the existing
   architecture.** The find bar is a third chrome row; the renderer reports
   its chrome height to main (`SHELL_CHROME_HEIGHT`, bounds-checked) so the
   view shrinks under it. Context menus are built per-right-click from
   `context-menu` event params in main (native menus, no state, no disk).
   Link/image "open in new tab" goes through the same `isAllowedUrl` gate
   and `createTab()` path as every other navigation, so popups/new tabs
   keep every mitigation. Tab reorder rebuilds the main-process Map (the
   source of tab order for Ctrl+1..9/Ctrl+Tab) and only accepts an exact
   permutation of live tab ids.

## Consequences

- The permission handler is no longer "deny everything" — the threat-model
  WebRTC row now names the fullscreen exception explicitly. Any future
  carve-out must argue, as fullscreen does, that the permission grants no
  sensor/storage/network capability.
- New e2e coverage drives error pages, find, favicons, and both auth paths
  end-to-end; fullscreen enter/leave layout was verified against a live
  instance (Playwright cannot deliver the required user gesture through a
  native menu, and context menus are native and untestable from CDP).
- `verify_footprint.sh` still passes in CI: favicons and auth introduce no
  new write path — both are memory-only by construction.

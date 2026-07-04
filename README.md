# Amnesic Browser

A desktop app that behaves like a normal tabbed browser but is engineered so
that nothing recoverable is left on disk once the process exits — no
history, no cookies, no cache, no OS-level breadcrumbs from the app itself.

This is not a general-purpose "private browsing" claim. It is a specific,
narrow, and verifiable one: **read [docs/threat-model.md](docs/threat-model.md)
before trusting anything about what this app does or doesn't protect
against.** That document lists, mechanism by mechanism, what's actually
mitigated and what isn't — including the things this project cannot fix
(OS swap/hibernation, live RAM forensics, network-level observers,
website fingerprinting).

## Status

v1 — Linux only. Single-window, in-memory-session tabbed browsing with a
hard-exit cleanup routine. `scripts/verify_footprint.sh` (the empirical
proof of the core claim — a scripted session followed by a filesystem
diff) runs in CI on every push and must pass before any PR touching
session/storage/cache handling merges (see `CLAUDE.md` and ADR 0004).

## Why the claims are verified, not asserted

Every Chromium command-line switch and Electron session API this project
relies on was checked against the exact pinned Electron version
(`electron@43.0.0`, Chromium 150.0.7871.46) rather than trusted from
general knowledge or older tutorials — flags and APIs change between
releases. See `research/` for the verification notes and
`docs/adr/` for the architectural decisions and corrections that came out
of that process.

## Using it

New tabs open on an in-app start page; the address bar accepts URLs or
search terms (searches go to DuckDuckGo). `target=_blank` links and
ctrl+click open as new tabs in the same hardened in-memory session —
real popup windows are never created. Closing the last tab closes the
window, which triggers the wipe-and-exit routine.

Everyday browsing niceties are in and stay inside the amnesic envelope:
right-click context menus (page, links, images, selections, address bar),
find in page (`Ctrl+F`), session-only tab favicons (fetched through the
tab's in-memory session, never by the shell), drag-to-reorder tabs, an
audio indicator with click-to-mute, and a zoom chip in the address bar
when zoom ≠ 100%. HTML5 fullscreen (video players) works; all other
permission requests remain denied. Failed loads — DNS errors, refused
connections, invalid certificates — render an in-shell error page with a
retry button; there is deliberately **no** "proceed anyway" bypass for bad
certificates. Sites behind HTTP basic auth get an in-shell sign-in dialog;
credentials go only into the request and are forgotten with the session.

| Shortcut                       | Action                                                   |
| ------------------------------ | -------------------------------------------------------- |
| `Ctrl+T` / `Ctrl+W`            | new / close tab                                          |
| `Ctrl+Tab`, `Ctrl+PgUp/PgDn`   | cycle tabs                                               |
| `Ctrl+1…8`, `Ctrl+9`           | nth / last tab                                           |
| `Ctrl+L`                       | focus address bar                                        |
| `Ctrl+F`                       | find in page (`Enter`/`Shift+Enter` cycle, `Esc` closes) |
| `Ctrl+R`, `F5`, `Ctrl+Shift+R` | reload (hard)                                            |
| `Alt+←` / `Alt+→`              | back / forward                                           |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | zoom in / out / reset                                    |
| `Esc`                          | stop loading (or revert address bar while typing)        |

## Development

```sh
npm install
npm run dev      # electron-vite dev server + app
npm run build    # production build
npm run typecheck
npm run lint
npm test         # vitest unit tests
npm run test:e2e # playwright e2e tests
```

## Non-goals for v1

See `CLAUDE.md`. Tor/SOCKS integration, anti-fingerprinting, extensions,
bookmarks, downloads, password/autofill management, and any telemetry are
explicitly out of scope and require explicit approval before being added.

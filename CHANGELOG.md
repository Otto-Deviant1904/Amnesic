# Changelog

All notable changes to Amnesic Browser are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] — Unreleased

### Added

- **Tor / SOCKS5 mode** (shield chip in the toolbar) — bring-your-own-Tor:
  connects tab traffic through a user-supplied SOCKS5 proxy (default
  `127.0.0.1:9050`), off by default and never persisted. Hostnames resolve
  at the proxy, never locally; an unreachable proxy fails navigation
  closed rather than falling back to direct. Gated on no open tab having
  navigated yet, since a proxy change under a live page could leave it on
  a stale route. See ADR 0007 for the full design, including the
  candidly-stated limits (not anonymity parity with Tor Browser).
- **DNS-over-HTTPS toggle** (DNS chip next to it) — independent of Tor,
  forces encrypted DNS to Quad9 or Mullvad (no Google/Cloudflare default,
  no free-text server field). Off by default, never persisted. Greys out
  while Tor mode is on (proxied DNS already covers that traffic) without
  resetting the underlying selection. See ADR 0010.
- README gains a "Network privacy" section; `docs/threat-model.md`'s
  network-observer scope updates from "out of scope" to "mitigated when
  Tor mode is enabled, with these limits," plus a new DNS row with the
  same candid framing.

### Verification

- Both features are verified end-to-end against a hand-rolled, hermetic
  SOCKS5 test server (`tests/e2e/tor.spec.ts`, `tests/e2e/dns.spec.ts`) —
  never a real Tor instance or real network egress in CI. Confirmed
  empirically (not assumed from docs): SOCKS5 hostnames arrive at the
  proxy unresolved, the kill-switch holds when the proxy disappears
  mid-session, and Chromium bypasses `localhost` by default even with an
  empty `proxyBypassRules`.
- One honestly un-asserted limit, documented rather than overclaimed:
  neither test suite proves at the packet level that DNS queries leave
  the process as HTTPS rather than plaintext port 53 — this project's CI
  has no root/netns access for packet capture, and won't stand up a live
  HTTPS DoH mock requiring weakened TLS validation just to test it. A
  manual `tcpdump`-based check is documented instead.
- `research/session-and-userdata.md` gains verification notes for the
  exact `proxyRules`/`proxyBypassRules` grammar and the
  `configureHostResolver` repeat-call behavior (undocumented by Electron,
  checked directly rather than assumed).

## [0.2.0] — Unreleased

### Added

- **Panic key (`Ctrl+Shift+Q`)** — runs the exact same `cleanupAndExit()`
  wipe-and-exit routine as closing the last tab, reachable from anywhere in
  the window (address bar, page content, find bar) regardless of keyboard
  focus. See `research/cleanup-and-exit.md` §19.
- **New Identity (`Ctrl+Shift+N`, or the mask icon in the toolbar)** — closes
  every open tab and rotates the in-memory session to a brand-new, freshly
  hardened partition without restarting the app, giving a forensically fresh
  session mid-run. See ADR 0009 for the design (partition rotation over
  clear-in-place) and the `hardenSession()` refactor that guarantees startup
  and mid-session hardening can never diverge.
- **Self-audit panel** (start page) — a live, in-app view of several of the
  amnesic guarantees, run in the main process and delivered over the
  existing IPC bridge: is the session directory really on tmpfs right now,
  is the tab partition really non-persistent, is the HTTP cache switch
  really active, and more. Each row is explicit about whether it was
  verified in this running process this instant, or is a guarantee enforced
  by build/CI tooling with no reliable Electron 43 runtime signal (the
  crash-reporter row, notably — see `research/cleanup-and-exit.md` §21).
- README shortcut table and prose updated for both new shortcuts; a
  screenshot of the self-audit panel added.

### Fixed

- A CSS `overflow: hidden` rule on the self-audit panel's outer container
  collapsed its own computed height to a few pixels once it became a flex
  item of the start page, silently letting the start page's content spill
  past its own box into the chrome above it — occluding the address bar and
  nav buttons from real pointer input at certain window sizes, and making
  the panel's own "Re-check" button unclickable. Fixed by dropping the
  unneeded `overflow: hidden` (no child painted a background that needed
  clipping) and giving the start page its own `overflow-y: auto` scroll
  boundary.

### Verification

- `scripts/footprint-session.mjs` (the CI-gating forensic verifier) now
  fires New Identity mid-session and asserts the tmpfs userData directory
  survives the reset (only final exit may remove it), that exactly one
  fresh tab remains, and that the rotated session is still fully functional
  — a new subsystem is only a guarantee once the verifier exercises it.
- New e2e coverage: `tests/e2e/panic-key.spec.ts`,
  `tests/e2e/new-identity.spec.ts` (cookies and Chromium's basic-auth cache
  both proven gone after a reset), `tests/e2e/self-audit.spec.ts`.
- Along the way: confirmed empirically that Playwright's `page.keyboard.press()`
  (CDP-driven) never reaches Electron's `before-input-event`, unlike
  `webContents.sendInputEvent()` — documented in
  `research/cleanup-and-exit.md` §20 so future shift-combo tests don't
  rediscover this the hard way.

## [0.1.2]

- New app icon and wordmark; license synced to Apache-2.0 across the repo.

## [0.1.1]

- Fixed a crash where the packaged AppImage never survived
  `app.relaunch()`'s internal spawn mechanism; replaced with an explicit
  `child_process.spawn()` (ADR 0008). v0.1.0 did not launch as a packaged
  AppImage at all.

## [0.1.0]

- First tagged release: Linux AppImage, forensic footprint verified in CI,
  AUR PKGBUILD prepared.

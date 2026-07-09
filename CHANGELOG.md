# Changelog

All notable changes to Amnesic Browser are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.1] — Unreleased

### Fixed

- **arm64 release build was broken**: `electron-builder.yml`'s `linux.target`
  restricted the AppImage target to `arch: [x64]`. On the arm64 CI runner, no
  configured target matched the build arch, so electron-builder silently fell
  back to its own default Linux target list (AppImage _and_ snap) instead of
  just AppImage — and `snapcraft` isn't installed on the runner, so the arm64
  leg of `release.yml` failed with `spawn snapcraft ENOENT` on every v0.6.0
  release attempt. Fixed by listing both arches (`arch: [x64, arm64]`)
  explicitly. v0.6.0's GitHub release therefore shipped with no AppImage
  binaries (source archive only); v0.6.1 is a packaging-only patch to restore
  working release artifacts, no application code changed.

## [0.6.0] — Unreleased

### Added

- **Content blocking** (ADR 0013): the @ghostery/adblocker engine (pinned
  2.18.1, MPL-2.0, bundled into the app — no native code) over bundled verbatim
  snapshots of EasyList and the uBlock Origin `filters` / `quick-fixes` /
  `privacy` lists plus the uBO scriptlet resources (sources, retrieval dates,
  and SHA-256 recorded in `resources/adblock/ATTRIBUTION.md`; refreshed only at
  release time by `scripts/update-blocklists.mjs` — never at runtime). On by
  default (owner-approved exception to off-by-default), session-only, never
  persisted.
  - Network cancellation with full ABP/uBO filter semantics (`$third-party`,
    `$domain=`, `@@` exceptions, `$important`, `$redirect`, `$badfilter`) and
    PSL-correct party classification; `$csp` directive injection on document
    responses.
  - Cosmetic filtering (`##` hide rules) and **uBO scriptlet injection**
    (`##+js(...)` — e.g. `json-prune` against the YouTube player response),
    driven per page by a session frame preload. This is what makes same-origin
    video ads blockable; entirely data-driven from the filter lists, no
    site-specific code.
  - `Blocking` toolbar chip with a live session blocked-count (pushed from the
    main process, throttled; resets on New Identity). Toggling off/on applies
    to every live session instantly, including container tabs.
  - Engine parse cost ~150 ms once at startup; per-request match overhead
    measured at ~1.3 µs mean (the interim homemade matcher this replaces before
    any release measured 60–78 ms per request and could not support scriptlets).

## [0.5.0] — Unreleased

### Changed

- **The Tor/SOCKS5 proxy is generalized to any user-supplied proxy scheme**
  (ADR 0012, extending ADR 0007). The shield chip in the toolbar now offers
  three schemes — **Tor / SOCKS5** (the unchanged one-click default,
  `127.0.0.1:9050`), **HTTP**, and **HTTPS** — so the browser can route its own
  traffic through a proxy a VPN or provider already exposes, not only a local
  Tor SOCKS5 endpoint. This is the honest, browser-scoped equivalent of "use my
  VPN": still bring-your-own-proxy, still session-only and never persisted, and
  **not** a system VPN (no TUN, no root, no bundled tunnel — out of scope).
  - Every ADR 0007 guarantee holds for all three schemes: DNS resolves **at the
    proxy, never locally** (proven for HTTP against a hermetic test proxy that
    asserts the destination hostname arrives unresolved); the kill-switch
    **fails closed** for an unreachable proxy (a bare `<scheme>://host:port`
    rule has no direct fallback); the no-tabs-navigated gate, both-sessions +
    all-live-tab-sessions application, empty bypass list, and mandatory WebRTC
    layers are unchanged.
  - **SOCKS4 is deliberately excluded** — it has no domain-name address type and
    would leak every hostname to the local resolver (ADR 0007 decision 3).
  - Honest per-scheme UI/README copy: all three resolve DNS at the proxy, but an
    HTTP/HTTPS proxy is a **single operator** (your VPN endpoint) who sees your
    real IP and can correlate your traffic — transport privacy, not anonymity,
    and never as private as Tor's relay model.
  - Renamed for honesty (a `tor.ts` carrying HTTP-proxy logic would mislead):
    `src/main/tor.ts`→`proxy.ts`, `TorControl.tsx`→`ProxyControl.tsx`, the
    `TOR_*` IPC channels→`PROXY_*`, and the `Tor*` types/state→`Proxy*`. No
    behavior change for existing SOCKS5/Tor users — the default and its
    fail-closed guarantees are identical.

## [0.4.0] — Unreleased

### Added

- **Containers mode** (the "Containers" chip in the toolbar) — opt-in,
  off-by-default per-tab session isolation. When on, each tab you open gets
  its own fresh, never-reused in-memory partition, so a cookie or
  `localStorage` entry a tracker sets in one tab is invisible to that same
  tracker in another tab — closing off the storage-based cross-tab
  correlation that a single shared session allows. Session-only, never
  persisted, matching every other network/privacy toggle. See ADR 0011.
  - Turning it on affects only tabs opened afterward; tabs already open keep
    their session, and there is no teardown of existing tabs (New Identity
    remains the one mass reset).
  - Links a page opens itself (`window.open`, `target=_blank`, and the
    context-menu "open in new tab") inherit the opener tab's container, so
    OAuth/login pop-ups don't land in a different container and lose the
    session — matching Firefox Multi-Account Containers semantics.
  - Integrates with the existing network toggles: the Tor/SOCKS5 proxy is
    applied to every live per-tab session (a fresh container opened while Tor
    is on is proxied before it loads anything, and the fail-closed kill-switch
    holds identically); DoH needs no per-session work since it is a
    process-global resolver setting.
- README "Using it" section documents the chip with its honest limits;
  `docs/threat-model.md` gains a containers row stating plainly that this is
  per-tab (not per-site/first-party) isolation — third parties within one tab
  still share that tab's partition, every tab still shares one IP, and
  fingerprinting can still correlate tabs.

### Verification

- Per-tab partition naming is refactored into the pure, unit-tested
  `src/main/partitions.ts`; `tests/unit/partitions.test.ts` proves the
  never-reuse invariant across both generations and toggle flips, and the
  absence of any `persist:` prefix.
- The "no view may be built on an unhardened session" rule is enforced by the
  type system, not a comment: `createTab()` now requires an already-prepared
  `Session`, and the only async door that mints a fresh one
  (`prepareFreshTabSession()`) hardens it first.
- New e2e coverage (`tests/e2e/containers.spec.ts`): containers-off shares a
  cookie across tabs; containers-on isolates it; a page-opened tab shares its
  opener's container; New Identity under containers leaves one working,
  isolated fresh tab; and a container tab opened under Tor routes through the
  SOCKS5 proxy (reusing the hermetic fake-proxy harness).
- `scripts/footprint-session.mjs` now toggles containers on mid-session and
  stores data in a fresh per-tab partition while keeping every existing
  tmpfs-residue assertion green.
- Memory tradeoff measured with `scripts/measure-containers.mjs` and recorded
  honestly in ADR 0011: on this workstation, 10 container tabs cost ≈1% more
  RSS than 10 shared-session tabs and add zero processes (per-tab partitions
  are network contexts inside the existing network-service process, not new
  processes) — with the explicit caveat that this is a floor measured on an
  empty hermetic page, not a figure for heavy real-world sites.

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

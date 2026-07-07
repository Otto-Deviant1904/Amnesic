# 0013: Content blocking — @ghostery/adblocker engine over bundled filter lists

## Status

Accepted (owner approval for on-by-default, 2026-07-06; engine swap to
@ghostery/adblocker approved 2026-07-07 under the directive "Brave-grade ad
blocking that actually works on YouTube, with no hardcoded site-specific
fixes"). Session-only feature with bundled static filter snapshots — no runtime
downloads, consistent with this project's no-phone-home charter.

## Context

Phase 3.1 called for Brave-style network-layer ad/tracker blocking inside the
existing amnesic envelope. The first implementation (v0.6.0 pre-release, now
replaced — see "Rejected: homemade v1 engine" below) was a homemade parser and
matcher: a linear scan of ~53k compiled RegExps at 60–78 ms **per request**,
network cancellation plus cosmetic CSS only. It structurally could not block
YouTube ads: those are served same-origin from `googlevideo.com`, and defeating
them requires uBlock-Origin-style **scriptlet injection** (e.g. `json-prune`
applied to the player response) driven by filter-list `##+js(...)` rules — a
mechanism the homemade design lacked entirely. Per the owner's directive,
everything must stay data-driven from real filter lists; no per-site code.

## Decision

### 1. Engine: `@ghostery/adblocker` (pinned 2.18.1), driven through its public API

The blocker is Ghostery's production engine (MPL-2.0, pure TypeScript/WASM-free,
also used by Cliqz/Ghostery browsers): reverse-indexed network filter buckets,
cosmetic filter buckets, `$csp` filter support, redirect resources, and
uBO-compatible scriptlet injection. `FiltersEngine.parse(lists)` builds the
engine from concatenated filter-list text; `engine.updateResources(json)` loads
the uBO scriptlet/redirect resources; `engine.match(Request)` decides each
request; `engine.getCosmeticsFilters(...)` returns per-page styles + scriptlets;
`engine.getCSPDirectives(...)` returns `$csp` injections.

Split kept from v1: `src/main/blocking-engine.ts` is the **Electron-free core**
(owns the engine + session-only enabled/blockedCount state; unit-testable with
plain strings), `src/main/blocking.ts` is the **thin Electron adapter**
(bundled-snapshot loading, per-session listeners, frame preload, IPC).

### 2. NOT `ElectronBlocker.enableBlockingInSession()` — deliberate, with reasons

The library ships an Electron helper whose `enable()`/`disable()` we do **not**
use, after reading its implementation (`@ghostery/adblocker-electron` 2.18.1):

- Its `enable()` registers its **own** `session.webRequest.onHeadersReceived`.
  Electron supports exactly one listener per webRequest event per session, so it
  would silently clobber this app's referrer-suppression response header
  (ADR 0002) registered in `hardenSession()`.
- Its `disable()` calls `webRequest.onHeadersReceived(null)` /
  `onBeforeRequest(null)` — nulling the whole event and dropping referrer
  suppression (and any other shared listener) on toggle-off.
- Its `preload_path.js` runs a top-level
  `require.resolve('@ghostery/adblocker-electron-preload')` at **import time**,
  which throws inside the packaged asar (this app ships `out/**` only, no
  `node_modules`).

Instead the adapter drives the engine's public API itself:

- **One combined `onHeadersReceived` per session** (in `hardenSession()`):
  always sets `Referrer-Policy: no-referrer`; for blocking sessions also merges
  `$csp` directives via `applyBlockingResponseHeaders()` (same header-fold shape
  as the upstream adapter).
- **`onBeforeRequest`** registered by `installContentBlocking(ses)`: cancels on
  `engine.match().match`, honours `$redirect` via `redirectURL: dataUrl`, never
  cancels a main-frame document (uBO/Brave semantics — you cannot cancel the
  page you asked for).
- **Frame preload + IPC** (see decision 4) replicated with hardened handlers.

The package remains the dependency (`@ghostery/adblocker` for the engine,
`@ghostery/adblocker-electron-preload` for the frame preload file);
`@ghostery/adblocker-electron` itself is kept pinned as the reference
implementation the adapter tracks, but no code imports it at runtime.

### 3. Hook placement — inside `hardenSession()`, blocking sessions only

`hardenSession()` remains the single funnel every session passes through
(startup shared session, fresh container sessions, the rotated New Identity
session). `installContentBlocking(ses)` is called there, so all of those are
covered automatically with no session-iteration loop. **Exception:**
`session.defaultSession` — it backs only the trusted local shell UI (tab strip,
address bar), so it is hardened with `blockContent = false`: no wasted
per-request matching, and a filter rule can never cancel a shell asset.
The former `installTabContentBlocking()` per-tab wiring is gone — cosmetics are
session-level now (the frame preload), not per-WebContents listeners.

### 4. Cosmetics + scriptlets: frame preload → IPC → `insertCSS` / `executeJavaScript`

`@ghostery/adblocker-electron-preload/dist/index.cjs` is registered on every
blocking session via `session.registerPreloadScript({ type: 'frame' })`. It is
self-contained (requires only `electron`), works under the tab sessions'
`sandbox: true` / `contextIsolation: true`, and:

1. on `DOMContentLoaded`, invokes `@ghostery/adblocker/inject-cosmetic-filters`
   with the page URL; the main process answers by computing
   `getCosmeticsFilters()` and pushing styles via `insertCSS(..., {cssOrigin:
'user'})` and scriptlets via `executeJavaScript(script, true)` into the
   page's MAIN world (scriptlets like `json-prune` must patch page globals, so
   an isolated world would be useless);
2. starts a `MutationObserver` (gated by the
   `@ghostery/adblocker/is-mutation-observer-enabled` IPC) and sends new DOM
   class/id/href hints for incremental cosmetic updates.

This is the YouTube-critical mechanism: `ubo-quick-fixes.txt` carries
`youtube.com##+js(json-prune, playerResponse.adPlacements ...)` and related
rules whose scriptlet bodies resolve from the bundled `ubo-resources.json` —
entirely data-driven, zero YouTube-specific code in this repository. (The
"YouTube-specific in-page player script" from the pre-swap draft of this ADR
was never acceptable under the directive and does not exist.)

Both IPC handlers are reachable from page frames, so they are hardened in
`blocking.ts`: enabled-flag gate, `typeof url` check, full try/catch (a hostile
page can never throw into the main process), and they only ever inject content
derived from the bundled lists into the **calling** frame (`event.sender`).
Worst case for a malicious page invoking them with a forged URL: it applies to
itself the cosmetic rules of some other hostname — a self-inflicted
display:none. The exposed surface is documented in `docs/threat-model.md`.

### 5. Live on/off toggle — shared flag, all sessions at once

The enabled flag lives in `blocking-engine.ts` and is read per request and per
IPC call. Flipping it takes effect on every live session's very next request
with no re-registration and no session iteration (unlike proxy state, which is
mutable per-session Electron state that must be re-pushed). Sessions created
while blocking is off still register their (gated) listener at hardening time,
so turning blocking back on covers them instantly. `blockedCount` increments on
the engine's `request-blocked` event and is pushed to the shell renderer via
`BLOCKING_STATUS_CHANGED` (throttled to one update per 250 ms; immediate on
toggle/reset). New Identity resets the counter (existing `resetBlockedCount()`
call site); the enabled flag survives New Identity like proxy/DNS/containers.

### 6. On by default — unchanged owner-approved exception to off-by-default

Rationale unchanged from v1: ad-blocking is a feature users expect on out of
the box (Brave, uBlock Origin); the downside of the default is site breakage,
not a false privacy guarantee. Session-only, never persisted.

### 7. No party-scope modes: the lists' own semantics apply

The v1 Standard/Aggressive `BlockingMode` is **removed** (types, IPC channel,
preload bridge, UI). The engine implements ABP/uBO filter semantics natively —
`$third-party`, `$domain=`, `$important`, `@@` exceptions, `$csp`, `$redirect`,
`$badfilter`, preprocessor directives — with proper PSL-based party
classification via `tldts`. A homemade party-scope layer on top of that would
re-introduce exactly the kind of subtly-wrong approximation decision 5 of the
old ADR apologized for (the "naive last-two-label third-party check" is gone
with it).

### 8. Bundled lists, resources, licenses

Shipped in `resources/adblock/` (verbatim snapshots; exact URLs, retrieval
dates, SHA-256 in `ATTRIBUTION.md`; refreshed only by
`scripts/update-blocklists.mjs` at release time — **no runtime downloads**):

| File                    | Source                                                           | License                                              |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `easylist-snapshot.txt` | easylist.to                                                      | CC BY-SA 3.0 (elected over GPLv3, unchanged from v1) |
| `ubo-filters.txt`       | uBO "filters" via ghostery/adblocker asset mirror                | GPLv3                                                |
| `ubo-quick-fixes.txt`   | uBO "quick fixes" (carries the YouTube scriptlet rules)          | GPLv3                                                |
| `ubo-privacy.txt`       | uBO "privacy"                                                    | GPLv3                                                |
| `ubo-resources.json`    | uBO scriptlet/redirect resources, prebuilt by ghostery/adblocker | GPLv3                                                |

The uBO lists are fetched from the ghostery/adblocker asset mirror rather than
uBlockOrigin/uAssets directly, on purpose: the mirror is version-matched to the
engine, so scriptlet names referenced by the lists are guaranteed to resolve
against `ubo-resources.json` from the same tree (pulling lists and resources
from different trees risks silent scriptlet breakage).

**Licensing note (owner attention):** uAssets is GPLv3. The snapshots are
carried as static _data_ files (an aggregation, not linked code) inside this
Apache-2.0 repo, with the GPLv3 grant and attribution preserved in
`ATTRIBUTION.md` — mirroring the EasyList CC BY-SA election pattern. The owner
should confirm this aggregation stance before distribution.

Lists are baked into the main bundle via Vite `?raw` imports (verified to
survive electron-vite's main-process build); the frame preload ships as a real
file via electron-builder `extraResources` (`adblocker-preload.cjs` next to the
asar) because `registerPreloadScript` needs an on-disk path — resolved via
`process.resourcesPath` when packaged, `node_modules` in dev.

`AMNESIC_BLOCKLIST_PATH` remains a **test-only seam**: when set, the engine
parses that file _instead of_ the bundled lists (hermetic e2e + footprint
verifier). Scriptlet resources are always the bundled `ubo-resources.json`, so
fixture `##+js(...)` rules resolve real scriptlet bodies.

### 9. Startup strategy: parse at launch, no serialized-engine prebuild

Measured on this workstation (Node 26, cold `FiltersEngine.parse()` +
`updateResources()` of all four snapshots, 2.79 MB combined): **127–155 ms
median** (worst first-run outlier 303 ms). That is under the ~250 ms budget, so
the engine is parsed once at startup (`warmBlockingEngine()` in `whenReady`)
and the serialized-engine build step (`engine.serialize()` → bundled binary →
`deserialize()` at ~5 ms) was **deliberately skipped** — it would add a build
artifact, a cache-invalidation surface, and an integrity question for ~150 ms
of one-time gain. Revisit if the list set grows.

### 10. Fail-open on classification error, disposed-frame hazard

The `onBeforeRequest` callback wraps matching in try/catch and **allows** the
request on any error — a never-invoked callback would stall the load, and a
crashed classifier must not take navigation down with it. Unlike the v1 engine,
request classification no longer touches `details.frame` (a disposed
`WebFrameMain` there was a known crash hazard); party classification uses
`details.referrer` (`sourceUrl`) only. Fail-open cases are recorded in
`docs/threat-model.md`.

## Alternatives considered

- **Homemade v1 engine (replaced).** Linear scan of 53,319 RegExp-compiled
  rules measured at **~78 ms per matching request / ~60 ms per non-matching
  request** on this workstation — three to four orders of magnitude slower than
  the Ghostery engine's measured ~1.3 µs mean, on the request hot path. Network
  - cosmetic CSS only; no scriptlets, so YouTube ads (same-origin
    `googlevideo.com`) were structurally unblockable; naive last-two-label
    third-party classification (no PSL). Kept as the reference for why "parse the
    list yourself" is not a weekend project. Deleted: `src/main/blocklist.ts`,
    `src/main/cosmetic.ts`, their unit tests.
- **`adblock-rust` (Brave's engine).** Rejected: native Node module — per-platform
  builds, arm64 cross-compilation complexity, and a native-code supply-chain
  surface, against @ghostery/adblocker's pure-TS implementation with comparable
  filter semantics.
- **Chromium `declarativeNetRequest` / extension machinery.** Rejected:
  Extensions support is an explicit v1 non-goal (CLAUDE.md), and DNR alone
  cannot do scriptlet injection.
- **`ElectronBlocker.enableBlockingInSession()`.** Rejected for the three
  concrete defects in decision 2.
- **Serialized-engine prebuild.** Rejected for now (decision 9 — parse is fast
  enough).

## Consequences

- `src/main/blocking-engine.ts` (pure core) + `src/main/blocking.ts` (Electron
  adapter). `@ghostery/adblocker` is bundled INTO `out/main/index.js`
  (electron-vite `externalizeDepsPlugin({ exclude })`) because the package ships
  no `node_modules`; the frame preload ships via `extraResources`.
- `BlockingControl.tsx` chip in the toolbar; `BlockingStatus` IPC with `enabled`
  - `blockedCount` (live-pushed); `BlockingMode` and `blocking:set-mode` are gone.
- `docs/threat-model.md` content-blocking rows rewritten (engine, preload/IPC
  surface, fail-open notes).
- Verification: `tests/unit/blocking.test.ts` (pure-core semantics + a CI guard
  that parses the real bundled snapshots, proves YouTube scriptlet injection
  data-driven, and bounds mean match latency), `tests/e2e/blocking.spec.ts`
  (hermetic: network block, cosmetic hide, **scriptlet execution in the page**,
  toggle-off passthrough, containers coverage, counter increment), and
  `scripts/footprint-session.mjs` still browses with blocking on and toggles it
  mid-session (empty-list fixture).

### Measured performance (2026-07-07, this workstation)

| Metric                                                                     | Value                                      |
| -------------------------------------------------------------------------- | ------------------------------------------ |
| Cold `parse()` + `updateResources()`, all 4 snapshots (2.79 MB)            | 127–155 ms median (303 ms worst first-run) |
| `engine.serialize()` / `deserialize()` (not used; measured for decision 9) | 5.8 ms / 5.3 ms (3.59 MB)                  |
| Mean `match()` latency, 140k mixed requests after warmup                   | **~1.3 µs per request**                    |
| Homemade v1 (replaced), same workstation                                   | 60–78 **ms** per request                   |

The unit suite re-asserts a generous `< 5 ms` mean bound on every CI run so a
regression back toward v1-style latency fails loudly.

# @ghostery/adblocker 2.18.1 — installed-source study (Electron 43)

Findings from reading the INSTALLED packages in `node_modules` (not docs),
recorded before the ADR 0013 engine swap. Companion to
`research/webrequest-and-frame-host.md`.

## Packages

| Package                                | Role                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ghostery/adblocker`                  | The engine: `FiltersEngine` (parse/serialize/match/cosmetics/CSP), `Request`, `Resources`. Pure TS, no native code. Deps: `@ghostery/adblocker-content`, `-extended-selectors`, `url-parser`, `@remusao/*`, `tldts-experimental`. |
| `@ghostery/adblocker-electron`         | `ElectronBlocker extends FiltersEngine` + `BlockingContext` session glue. We import NOTHING from it at runtime (reasons below).                                                                                                   |
| `@ghostery/adblocker-electron-preload` | The frame preload (`dist/index.cjs`). Self-contained — its only `require` is `electron`.                                                                                                                                          |

## `ElectronBlocker.enableBlockingInSession(session)` (dist/commonjs/index.js)

Creates a `BlockingContext` (WeakMap-cached per session) whose `enable()`:

1. if `config.loadCosmeticFilters`: `session.registerPreloadScript({ type:
'frame', filePath: PRELOAD_PATH })` + registers two GLOBAL `ipcMain.handle`
   channels: `@ghostery/adblocker/inject-cosmetic-filters` and
   `@ghostery/adblocker/is-mutation-observer-enabled`;
2. if `config.loadNetworkFilters`: registers ITS OWN
   `session.webRequest.onHeadersReceived` (CSP injection) and
   `onBeforeRequest` (cancel/redirect) with `{ urls: ['<all_urls>'] }`.

`disable()` calls `webRequest.onBeforeRequest(null)` / `onHeadersReceived(null)`
— the library's own comment admits Electron has no listener multiplexing, so
disabling nulls the WHOLE event on that session.

**Why we can't use it here (ADR 0013 decision 2):**

- `hardenSession()` already owns `onHeadersReceived` for
  `Referrer-Policy: no-referrer` (ADR 0002). The library's `enable()` would
  clobber it; its `disable()` would null it.
- `dist/*/preload_path.js` runs
  `resolve(require.resolve('@ghostery/adblocker-electron-preload'))` at MODULE
  LOAD — importing `ElectronBlocker` inside the packaged asar (which ships no
  `node_modules`) throws before any code runs.
- Bonus landmine: importing the module sets
  `process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'` as a side effect.

Our adapter (`src/main/blocking.ts`) therefore re-implements the ~60 lines of
glue against the engine's public API, folding CSP into the existing
`onHeadersReceived` and loading the preload from an `extraResources` copy.

## Request construction (`fromElectronDetails`)

Builds `Request.fromRawDetails({ requestId: id, sourceUrl: referrer, tabId:
webContentsId, type: resourceType || 'other', url })`. Notably it does NOT
touch `details.frame` — party classification comes from `referrer` via
tldts (PSL-correct). No disposed-`WebFrameMain` hazard on the request path
(cf. `research/webrequest-and-frame-host.md`, which the old engine needed).
`onBeforeRequest` semantics: main-frame documents are never cancelled;
`match()` → `{ cancel: true }`; `$redirect` → `{ redirectURL: redirect.dataUrl }`
(a data: URI stub from the resources).

## Cosmetic/scriptlet flow (preload ↔ main)

Preload (`dist/index.cjs`):

- on `DOMContentLoaded` invokes `inject-cosmetic-filters` with
  `window.location.href` (no msg = "first run"), then asks
  `is-mutation-observer-enabled` and, if true, starts a `MutationObserver`
  that batches NEW ids/classes/hrefs and re-invokes the channel with
  `{ classes, hrefs, ids, lifecycle }`.

Main handler (`onInjectCosmeticFilters`): parses the URL with tldts, calls
`engine.getCosmeticsFilters({ url, hostname, domain, classes, hrefs, ids,
getBaseRules/getInjectionRules/getRulesFromHostname: firstRun,
getRulesFromDOM: !firstRun, getExtendedRules: false })`, then:

- `event.sender.insertCSS(styles, { cssOrigin: 'user' })`
- `event.sender.executeJavaScript(script, true)` per scriptlet — MAIN world,
  by design: scriptlets like `json-prune` must patch page globals.

## Scriptlet resources

`engine.updateResources(jsonText, checksum)` → `Resources.parse()` expecting
`{ scriptlets: [{ name, aliases, body, dependencies, executionWorld,
requiresTrust }...], redirects: [...] }`. The version-matched prebuilt file is
`ublock-origin/resources.json` on the ghostery/adblocker asset mirror
(`raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/`),
which also mirrors the uBO filter lists the engine's own `fromLists()` presets
use — same-tree list+resources = scriptlet names always resolve. Bundled
snapshot: `resources/adblock/ubo-resources.json` (146 scriptlets, 63
redirects; `json-prune` present).

## Runtime network audit

`fetch.js` contains the only network code: `fetchLists`/`fetchResources`, used
solely by the opt-in statics `fromLists` / `fromPrebuilt*`. Our code calls only
`FiltersEngine.parse`, `updateResources`, `match`, `getCosmeticsFilters`,
`getCSPDirectives` — no runtime fetch paths reachable. Verified by grep over
`dist/` and by our adapter's import surface.

## Events

`FiltersEngine extends` a custom `EventEmitter` whose `emit` runs listeners via
**`queueMicrotask`** — `request-blocked` (and friends) fire asynchronously,
one microtask after `match()` returns. Unit tests must flush a task before
asserting `blockedCount`; the count is eventually-consistent by one tick.

## Config defaults (constructor)

`loadNetworkFilters/loadCosmeticFilters/loadCSPFilters/loadExceptionFilters/
loadGenericCosmeticsFilters: true`, `enableMutationObserver: true`,
`enableOptimizations: true`, `enableInMemoryCache: true`;
`loadExtendedSelectors/enableHtmlFiltering/loadPreprocessors/
guessRequestTypeFromUrl/enableCompression/debug: false`. We keep the defaults
(Electron supplies accurate `resourceType`, so no type-guessing needed).

## Measured (2026-07-07, this workstation, Node 26)

- `parse()` + `updateResources()`, EasyList+uBO×3 (2.79 MB): 127/155/303 ms.
- `serialize()` 5.8 ms → 3.59 MB; `deserialize()` 5.3 ms (prebuild skipped —
  ADR 0013 decision 9).
- `match()` mean over 140k mixed requests: **~1.25 µs**.

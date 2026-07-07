// Electron adapter for the content blocker (ADR 0013).
//
// Thin wiring layer over src/main/blocking-engine.ts (the Electron-free core
// that owns the @ghostery/adblocker engine). This file:
//   - feeds the engine the bundled EasyList + uBlock Origin snapshots (or the
//     AMNESIC_BLOCKLIST_PATH override used by hermetic e2e tests);
//   - registers the network listener (onBeforeRequest) per session;
//   - registers the frame preload + the two IPC handlers the preload calls, so
//     cosmetic CSS and scriptlets (e.g. json-prune on YouTube's player
//     response) are injected in the page;
//   - exposes CSP-directive injection for the shared onHeadersReceived listener
//     in index.ts (which also carries the referrer-policy header).
//
// WHY NOT ElectronBlocker.enableBlockingInSession(): the library's own
// enable() registers its own session.webRequest.onHeadersReceived, and Electron
// supports only one listener per event per session — it would silently clobber
// this app's referrer-suppression header (ADR 0002). Its disable() then nulls
// the whole event, dropping referrer suppression on toggle-off. Its
// preload_path.js also runs a top-level require.resolve() at import time that
// throws inside the packaged asar (no node_modules). So instead we drive the
// engine's public API ourselves and gate blocking with a single shared flag —
// flipping it covers every live session at once, and new sessions register
// their (gated) listener at hardening time. See ADR 0013 + docs/threat-model.md.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, type Session } from 'electron'
import * as core from './blocking-engine'

// Bundled via Vite ?raw — verified to survive electron-vite's main-process
// build with externalizeDepsPlugin active (same mechanism the pre-swap
// blocker used for EasyList). Refreshed only by scripts/update-blocklists.mjs
// (docs/adr/0013-content-blocking.md; no runtime downloads).
import EASYLIST_RAW from '../../resources/adblock/easylist-snapshot.txt?raw'
import UBO_FILTERS_RAW from '../../resources/adblock/ubo-filters.txt?raw'
import UBO_QUICK_FIXES_RAW from '../../resources/adblock/ubo-quick-fixes.txt?raw'
import UBO_PRIVACY_RAW from '../../resources/adblock/ubo-privacy.txt?raw'
import UBO_RESOURCES_RAW from '../../resources/adblock/ubo-resources.json?raw'

// Re-export the session-only state surface so index.ts has a single import.
export {
  blockingStatus,
  setBlockingEnabled,
  resetBlockedCount,
  setBlockingChangeListener
} from './blocking-engine'

const CSP_HEADER = 'content-security-policy'
const COSMETIC_CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters'
const MUTATION_CHANNEL = '@ghostery/adblocker/is-mutation-observer-enabled'

const BUNDLED_LISTS = [EASYLIST_RAW, UBO_FILTERS_RAW, UBO_QUICK_FIXES_RAW, UBO_PRIVACY_RAW].join(
  '\n'
)

let ipcRegistered = false

/** Parse the engine once, from the bundled snapshots or — when the test seam
 *  AMNESIC_BLOCKLIST_PATH is set — from that file. Scriptlet/redirect resources
 *  are always the bundled uBO resources.json, so a fixture +js(...) rule can
 *  resolve a real scriptlet even in seam mode. */
function ensureEngine(): void {
  if (core.hasEngine()) return
  const override = process.env['AMNESIC_BLOCKLIST_PATH']
  const lists = override ? readFileSync(override, 'utf8') : BUNDLED_LISTS
  core.initEngine({ lists, resources: UBO_RESOURCES_RAW })
}

/** Parse the engine eagerly at startup so the first blocked request never pays
 *  the one-time parse cost (~150 ms, ADR 0013). Safe to call before any session
 *  exists; installContentBlocking() reuses the already-built engine. */
export function warmBlockingEngine(): void {
  ensureEngine()
}

/** Absolute path to the @ghostery frame preload script on real disk.
 *  Packaged: copied next to the asar via electron-builder extraResources
 *  (electron-builder.yml). Dev / e2e: read straight from node_modules two
 *  levels up from out/main. Never resolved through the library's PRELOAD_PATH
 *  (see file header). */
function framePreloadPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'adblocker-preload.cjs')
  }
  return join(__dirname, '../../node_modules/@ghostery/adblocker-electron-preload/dist/index.cjs')
}

/** Register the two IPC handlers the frame preload invokes. Global (ipcMain),
 *  so registered exactly once. Both honour the enabled gate and fail closed to
 *  "inject nothing" on any error — a hostile page cannot make them throw into
 *  the main process. See docs/threat-model.md for the exposed-surface note. */
function ensureIpcHandlers(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.handle(
    COSMETIC_CHANNEL,
    (event: Electron.IpcMainInvokeEvent, url: unknown, msg: unknown) => {
      if (!core.isEnabled() || typeof url !== 'string') return undefined
      try {
        const { active, styles, scripts } = core.cosmeticsFor(
          url,
          (msg ?? undefined) as core.CosmeticMessage | undefined,
          { frameId: event.frameId, processId: event.processId }
        )
        if (!active) return undefined
        if (styles.length > 0) {
          event.sender.insertCSS(styles, { cssOrigin: 'user' })
        }
        for (const script of scripts) {
          try {
            event.sender.executeJavaScript(script, true)
          } catch {
            /* frame torn down mid-inject — ignore */
          }
        }
      } catch {
        /* malformed message or engine hiccup: inject nothing (fail closed) */
      }
      return undefined
    }
  )

  ipcMain.handle(MUTATION_CHANNEL, () => core.isEnabled() && core.mutationObserverEnabled())
}

/** Register content blocking on a hardened tab/container session. Called from
 *  hardenSession() in index.ts for every session that backs untrusted page
 *  content (NOT the shell/default session). The onBeforeRequest listener and
 *  the cosmetic pipeline both read the shared enabled flag live, so the on/off
 *  toggle takes effect across every session without re-registration. */
export function installContentBlocking(ses: Session): void {
  ensureEngine()
  ensureIpcHandlers()

  // Frame preload: collects DOM class/id/href hints and drives cosmetic +
  // scriptlet injection through COSMETIC_CHANNEL. Compatible with the tab
  // sessions' sandbox:true / contextIsolation:true (the preload only uses
  // ipcRenderer, available in sandboxed preloads).
  ses.registerPreloadScript({ type: 'frame', filePath: framePreloadPath() })

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!core.isEnabled()) {
      callback({})
      return
    }
    try {
      callback(core.matchRequest(details))
    } catch {
      // Classification must never leave a request hanging (a never-invoked
      // callback stalls the load). Fail OPEN: allow the request.
      callback({})
    }
  })
}

/** Merge any $csp filter directives for this document response into
 *  `responseHeaders` (mutated in place). Invoked by the shared
 *  onHeadersReceived listener in index.ts, only for blocking sessions and only
 *  when blocking is enabled. No-op / fail-open on anything unexpected. */
export function applyBlockingResponseHeaders(
  details: Electron.OnHeadersReceivedListenerDetails,
  responseHeaders: Record<string, string[]>
): void {
  if (!core.isEnabled()) return
  if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return
  try {
    const directives = core.cspDirectivesFor(details)
    if (!directives) return
    const policies = directives
      .split(';')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    // Fold in any CSP the origin already set (case-insensitive), then replace
    // with a single combined header — same shape as the upstream adapter.
    for (const name of Object.keys(responseHeaders)) {
      if (name.toLowerCase() === CSP_HEADER) {
        policies.push(...responseHeaders[name])
        delete responseHeaders[name]
      }
    }
    if (policies.length > 0) {
      responseHeaders[CSP_HEADER] = [policies.join(';')]
    }
  } catch {
    /* fail open: no CSP added */
  }
}

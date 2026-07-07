// Pure, Electron-free core of the content blocker (ADR 0013).
//
// This module owns the @ghostery/adblocker FiltersEngine and all the
// engine-level logic — parsing filter lists, matching requests, computing
// cosmetic/scriptlet injections and CSP directives, and the session-only
// enabled/blocked-count state. It imports NO Electron API and reads NO bundled
// asset, so it is exercised directly by the unit tests (tests/unit/blocking.test.ts)
// with plain strings. The thin Electron adapter (src/main/blocking.ts) feeds it
// the bundled snapshots and wires it to webRequest / IPC / preload.
//
// Engine choice and the homemade v1 it replaces are documented in ADR 0013.

import { FiltersEngine, Request, type RequestType } from '@ghostery/adblocker'
import type { BlockingStatus } from '../shared/ipc'

/** Minimal shape of an Electron webRequest details object the engine needs.
 *  Declared locally so this module never imports Electron types at runtime. */
export interface RawRequest {
  id?: number
  url: string
  resourceType?: string
  referrer?: string
  webContentsId?: number
}

/** DOM hints the frame preload sends on cosmetic-filter update calls. */
export interface CosmeticMessage {
  classes?: string[]
  hrefs?: string[]
  ids?: string[]
  lifecycle?: unknown
}

export interface EngineInput {
  /** One or more filter lists concatenated (EasyList + uBO snapshots). */
  lists: string
  /** uBlock Origin resources.json (scriptlets + redirects) as text. */
  resources: string
}

let engine: FiltersEngine | null = null
let enabled = true
let blockedCount = 0

// Throttled "something changed" notifier. The adapter registers a listener that
// pushes the current BlockingStatus to the renderer. request-blocked can fire
// hundreds of times per page, so notifications are coalesced (see scheduleNotify).
let changeListener: (() => void) | null = null
let notifyTimer: ReturnType<typeof setTimeout> | null = null
const NOTIFY_THROTTLE_MS = 250

export function setBlockingChangeListener(fn: (() => void) | null): void {
  changeListener = fn
}

function scheduleNotify(): void {
  if (notifyTimer !== null || changeListener === null) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    changeListener?.()
  }, NOTIFY_THROTTLE_MS)
  // Never keep the process alive purely to flush a counter update.
  if (typeof notifyTimer === 'object' && notifyTimer !== null) {
    ;(notifyTimer as { unref?: () => void }).unref?.()
  }
}

function notifyNow(): void {
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
  changeListener?.()
}

/** Build (or rebuild) the engine from filter-list + resources text. The engine
 *  is parsed with the library defaults: network + cosmetic + CSP + generic
 *  cosmetic filters and the mutation observer are all on; guessRequestTypeFromUrl
 *  stays off because Electron always supplies an accurate resourceType. */
export function initEngine(input: EngineInput): FiltersEngine {
  const e = FiltersEngine.parse(input.lists)
  // Scriptlet + redirect resources (e.g. json-prune for YouTube). The checksum
  // is only used to skip redundant re-parses; list length is a stable token.
  e.updateResources(input.resources, `${input.resources.length}`)
  e.on('request-blocked', () => {
    blockedCount += 1
    scheduleNotify()
  })
  engine = e
  return e
}

export function hasEngine(): boolean {
  return engine !== null
}

export function getEngine(): FiltersEngine {
  if (engine === null) throw new Error('blocking engine used before initEngine()')
  return engine
}

/** Test-only: drop the engine and reset session state so each test file starts
 *  from a clean slate. Not called by the app. */
export function __resetForTests(): void {
  engine = null
  enabled = true
  blockedCount = 0
  changeListener = null
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
}

export function isEnabled(): boolean {
  return enabled
}

export function blockingStatus(): BlockingStatus {
  return { enabled, blockedCount }
}

export function setBlockingEnabled(next: boolean): BlockingStatus {
  enabled = next
  notifyNow()
  return blockingStatus()
}

export function resetBlockedCount(): void {
  blockedCount = 0
  notifyNow()
}

function toRequest(d: RawRequest): Request {
  return Request.fromRawDetails({
    requestId: d.id !== undefined ? `${d.id}` : undefined,
    sourceUrl: d.referrer,
    tabId: d.webContentsId,
    type: (d.resourceType || 'other') as RequestType,
    url: d.url
  })
}

/** Network decision for a sub-resource request. Never blocks the main document
 *  frame (matches uBO/Brave semantics — you cannot cancel the page you asked
 *  for). Returns the mutation to hand back to Electron's onBeforeRequest
 *  callback. The caller is responsible for the enabled gate and for
 *  fail-open behaviour if this throws. */
export function matchRequest(d: RawRequest): { cancel?: true; redirectURL?: string } {
  const request = toRequest(d)
  if (request.isMainFrame()) return {}
  const { redirect, match } = getEngine().match(request)
  if (redirect) return { redirectURL: redirect.dataUrl }
  if (match) return { cancel: true }
  return {}
}

/** CSP directives ($csp filters) to inject for a main/sub-frame document, or
 *  undefined if none apply. */
export function cspDirectivesFor(d: RawRequest): string | undefined {
  return getEngine().getCSPDirectives(toRequest(d))
}

/** Styles + scriptlets to inject for a page. `msg` is undefined on the first
 *  (navigation) call and carries DOM hints on subsequent mutation-observer
 *  updates. */
export function cosmeticsFor(
  url: string,
  msg: CosmeticMessage | undefined,
  callerContext?: unknown
): { active: boolean; styles: string; scripts: string[] } {
  const r = Request.fromRawDetails({ url, type: 'document' as RequestType })
  const isFirstRun = msg === undefined
  const { active, styles, scripts } = getEngine().getCosmeticsFilters({
    url,
    hostname: r.hostname,
    domain: r.domain || undefined,
    classes: msg?.classes,
    hrefs: msg?.hrefs,
    ids: msg?.ids,
    getBaseRules: isFirstRun,
    getInjectionRules: isFirstRun,
    getExtendedRules: false,
    getRulesFromHostname: isFirstRun,
    getRulesFromDOM: !isFirstRun,
    callerContext
  })
  return { active, styles, scripts }
}

export function mutationObserverEnabled(): boolean {
  return getEngine().config.enableMutationObserver
}

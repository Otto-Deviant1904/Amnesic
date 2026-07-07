import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  type Session,
  type WebContents
} from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  IPC_CHANNELS,
  type AuditCheck,
  type AuditReport,
  type AuthCredentials,
  type ContainersStatus,
  type DnsProviderOption,
  type DnsResult,
  type DnsStatus,
  type ProxyResult,
  type ProxyScheme,
  type ProxyStatus,
  type ShellNotice,
  type TabLoadError,
  type TabState
} from '../shared/ipc'
import { attachShellContextMenu, attachTabContextMenu } from './context-menu'
import {
  applyBlockingResponseHeaders,
  blockingStatus,
  installContentBlocking,
  resetBlockedCount,
  setBlockingChangeListener,
  setBlockingEnabled,
  warmBlockingEngine
} from './blocking'
import { DOH_PROVIDERS, findDohProvider, resolverConfigFor } from './dns'
import { sharedPartitionName, tabPartitionName } from './partitions'
import { acquireSingleInstance, defaultLockDir, type SingleInstanceLock } from './single-instance'
import {
  DEFAULT_PROXY_CONFIG,
  probeProxy,
  proxyRulesFor,
  validateProxyConfig,
  type ProxyConfig
} from './proxy'
import { diskBackedSwapDevices } from './swap'

// --- Command-line switches (must be set before app is ready) ---
// Each entry verified against electron@43.0.0 / Chromium 150.0.7871.46.
// See research/command-line-switches.md and docs/adr/0002-electron-43-flag-and-api-corrections.md.
// Re-verify all of these with the electron-researcher subagent before any Electron version bump.
app.commandLine.appendSwitch('disable-http-cache') // disables the HTTP disk cache (userData/Cache)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache') // disables userData/GPUCache
app.commandLine.appendSwitch('disable-background-networking') // reduces background phone-home; defense-in-depth, not exhaustive
app.commandLine.appendSwitch('disable-component-update') // disables Chromium's component updater (e.g. Certificate Transparency)
// disable-crash-reporter / disable-breakpad kept as defense-in-depth only. The actual
// guarantee against crash dumps is "never call crashReporter.start()" anywhere below — see ADR 0002.
app.commandLine.appendSwitch('disable-crash-reporter')
app.commandLine.appendSwitch('disable-breakpad')
app.commandLine.appendSwitch(
  'disable-features',
  'Translate,OptimizationHints,MediaRouter,SafeBrowsing'
)
// Intentionally NOT using `no-referrers` — verified dead/no-op in current Chromium (ADR 0002).
// Referrer suppression is implemented via session.webRequest in configureSession() below.
// Intentionally NEVER importing/calling `crashReporter.start()` anywhere in this codebase (ADR 0002).

// --- Redirect userData onto tmpfs (Linux only for v1; see docs/threat-model.md for other platforms) ---
// Child processes also honour XDG_CACHE_HOME for non-Chromium caches — Mesa's
// shader cache (~/.cache/mesa_shader_cache*) and fontconfig's cache are
// written by the GPU process via the graphics stack, not by Chromium code, so
// no Chromium switch covers them. Pointing XDG_CACHE_HOME at the tmpfs dir
// sweeps those writes into RAM — but simply mutating process.env here does
// NOT work: Chromium forks its zygote processes before this script runs, and
// the GPU/renderer processes inherit the zygote's environment (verified
// empirically by reading /proc/<gpu-pid>/environ — XDG_CACHE_HOME was unset
// there; and by CI, where Mesa wrote to ~/.cache despite the env mutation).
// The fix is a one-time relaunch with the env in place from birth. Automation
// harnesses (Playwright et al., detected via --remote-debugging-port/-pipe)
// can't survive a relaunch, so they must pass AMNESIC_SHM_DIR + XDG_CACHE_HOME
// themselves — scripts/footprint-session.mjs does, and CI proves the
// mechanism. Found and iterated via scripts/verify_footprint.sh; see ADR 0004.
// Development-time environments (Playwright, electron-vite dev) — they own
// the process lifecycle, so both the relaunch bootstrap and the
// single-instance lock are skipped under them (a dev instance must neither
// hijack a running real instance nor be hijacked by one).
const automated =
  app.commandLine.hasSwitch('remote-debugging-port') ||
  app.commandLine.hasSwitch('remote-debugging-pipe') ||
  Boolean(process.env['ELECTRON_RENDERER_URL'])

let ramUserData: string | null = null
let relaunching = false
if (process.platform === 'linux') {
  const preset = process.env['AMNESIC_SHM_DIR']
  ramUserData =
    preset && preset.startsWith('/dev/shm/')
      ? preset
      : join('/dev/shm', `amnesic-browser-${process.pid}`)
  const xdgCache = join(ramUserData, 'xdg-cache')
  mkdirSync(xdgCache, { recursive: true }) // app.setPath throws if the directory doesn't already exist
  app.setPath('userData', ramUserData)
  // Skip the bootstrap under automation (Playwright would lose its
  // connection) and in dev (the relaunched instance would outlive its dev
  // server). Both are development-time environments, not the shipped
  // configuration.
  if (!preset && !automated) {
    process.env['AMNESIC_SHM_DIR'] = ramUserData
    process.env['XDG_CACHE_HOME'] = xdgCache
    relaunching = true
    // Deliberately NOT app.relaunch(): on this AppImage packaging it reliably
    // fails to produce a surviving process — verified empirically (the
    // relaunched process never reaches this module's own top-level code, so
    // it dies during Electron/Chromium's native startup, before any JS runs;
    // a manually spawned process with the identical env survives and runs a
    // full, healthy process tree). app.relaunch()'s exact failure mode inside
    // this AppImage wasn't fully root-caused (no strace/coredump available in
    // the environment this was diagnosed in) — spawning it ourselves sidesteps
    // whatever internal assumption of Electron's relaunch implementation
    // doesn't hold here, rather than depending on unverified internals.
    //
    // process.execPath is still correct as the exec target here. spawn()
    // only returns after fork() has completed, so the child process already
    // exists by the time app.exit() below runs — no dying-FUSE-mount race
    // like the one app.relaunch()'s (opaque) internal timing was suspected of.
    const child = spawn(process.execPath, process.argv.slice(1), {
      env: process.env,
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    app.exit(0)
  }
}

// A crash or SIGKILL can't run cleanup, so its tmpfs dir would sit in
// /dev/shm until reboot. Sweep dirs whose owning pid is gone at every
// startup — the best-effort recovery for exits nothing can intercept.
// NOTE: our own dir is named after the *bootstrap* pid (which has exited
// by the time the relaunched instance runs), so it must be skipped by
// path, not by pid liveness.
function sweepStaleShmDirs(): void {
  try {
    for (const entry of readdirSync('/dev/shm')) {
      const match = /^amnesic-browser-(?:footprint-)?(\d+)$/.exec(entry)
      if (!match) continue
      const dir = join('/dev/shm', entry)
      if (dir === ramUserData) continue
      if (!existsSync(`/proc/${match[1]}`)) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  } catch {
    /* /dev/shm unreadable — nothing to sweep */
  }
}

interface TabEntry {
  view: WebContentsView
  /** The session backing this tab's WebContentsView. The shared per-generation
   *  session (containers off / inherited from an opener) or a fresh per-tab
   *  partition (containers on). Held so proxy toggles and exit-time clears can
   *  reach every live tab session, not just the shared one. */
  session: Session
  /** False until the first loadURL — the renderer shows the start page instead. */
  navigated: boolean
  /** data: URI fetched through the in-memory session; see updateFavicon(). */
  favicon: string | null
  /** Set on a failed main-frame load; the renderer shows an error page while set. */
  error: TabLoadError | null
}

let mainWindow: BrowserWindow | null = null
const tabs = new Map<string, TabEntry>() // insertion order doubles as tab order
let activeTabId: string | null = null

// New Identity (ADR 0009) rotates to a brand-new partition name rather than
// clearing the existing one in place — session.fromPartition() returns the
// SAME session object for the same name for the app's lifetime, so a new
// name is what actually abandons the old session object rather than trusting
// clearStorageData() to be exhaustive. Monotonically increasing and never
// reused, so a generation number is never revisited within one app run.
let sessionGeneration = 0

function currentPartitionName(): string {
  return sharedPartitionName(sessionGeneration)
}

function getInMemorySession() {
  return session.fromPartition(currentPartitionName(), { cache: false })
}

// Containers mode (ADR 0011): per-tab isolated sessions. Session-only state —
// never persisted, always off on a fresh launch (CLAUDE.md's no-persisted-
// settings rule), and preserved as-is across New Identity like proxyEnabled /
// dohProviderId. When on, each USER-opened tab gets its own fresh partition;
// existing tabs and page-opened (opener-inherited) tabs are unaffected — see
// decisions 1 and 3.
let containersEnabled = false

// Monotonic per-tab partition counter (ADR 0011 decision 2). Only ever
// incremented, never reset — not even by New Identity — so a per-tab
// partition name is never revisited for the life of the process (zero reuse
// risk, the simplest possible invariant).
let tabPartitionCounter = 0

function containersStatus(): ContainersStatus {
  return { enabled: containersEnabled }
}

// Toggling containers affects only tabs created AFTER the change (decision 1):
// there is no teardown of existing tabs, so no mass-teardown ambiguity — the
// only mass reset remains New Identity. Plain, no gate, no async work.
function setContainersEnabled(next: boolean): ContainersStatus {
  containersEnabled = next
  return containersStatus()
}

// Builds and fully hardens a fresh per-tab session BEFORE it can back a view
// (ADR 0011 decision 4). hardenSession() also applies currentProxyConfig(), so
// a fresh partition created while the proxy is on is proxied before any content
// loads (decision 5b). Returning the prepared Session and passing it into the
// synchronous createTab() makes the "no view on an unhardened session"
// invariant a type fact, not a comment — createTab has no way to obtain an
// unprepared session.
async function prepareFreshTabSession(): Promise<Session> {
  const ses = session.fromPartition(tabPartitionName(sessionGeneration, ++tabPartitionCounter), {
    cache: false
  })
  await hardenSession(ses)
  return ses
}

// The session a USER-initiated new tab (Ctrl+T, the + button, a forwarded
// second-instance URL, the fresh tab New Identity opens) should use: a fresh
// per-tab partition when containers mode is on, otherwise the shared
// per-generation session. The shared session is always already hardened
// (startup / New Identity await hardenSession on it), so only the fresh path
// needs the await — hence this is the one async door into createTab for user
// tabs, while opener-inherited tabs pass their (already-hardened) opener
// session straight in.
async function openUserTab(url?: string, options: { background?: boolean } = {}): Promise<string> {
  const ses = containersEnabled ? await prepareFreshTabSession() : getInMemorySession()
  return createTab(ses, url, options)
}

// Every session currently backing a live tab, plus the shared per-generation
// session and defaultSession (the shell). Deduplicated via a Set: with
// containers off, tabs share getInMemorySession(), so the set collapses to the
// same {shared, default} it always was. This is the set Tor apply/clear and
// the exit-time wipe must cover — "the tab session" became "the tab sessions"
// once per-tab partitions exist (ADR 0011 decision 5).
function liveTabSessions(): Set<Session> {
  const sessions = new Set<Session>([getInMemorySession(), session.defaultSession])
  for (const entry of tabs.values()) sessions.add(entry.session)
  return sessions
}

// Proxy mode (ADR 0007, generalized to any scheme by ADR 0012). Session-only
// state — never persisted, always off on a fresh launch (CLAUDE.md's
// no-persisted-settings rule), defaulting to the Tor SOCKS5 endpoint. Applied
// to every session hardenSession() ever touches (below), so a freshly rotated
// New Identity partition never briefly exists unproxied while the proxy is on —
// New Identity preserves "proxy is on" as an ongoing preference, consistent
// with Tor Browser's own New Identity (a fresh circuit/session, not a proxy
// disconnect).
let proxyEnabled = false
let proxyConfig: ProxyConfig = DEFAULT_PROXY_CONFIG

function proxyStatus(): ProxyStatus {
  return {
    enabled: proxyEnabled,
    scheme: proxyConfig.scheme,
    host: proxyConfig.host,
    port: proxyConfig.port
  }
}

// A bare <scheme>://host:port with no comma-joined fallback entry and an
// empty bypass list — the fail-closed shape verified in
// research/session-and-userdata.md §22/§24 for socks5, http, and https alike.
// `{ mode: 'direct' }` when the proxy is off is explicit rather than relying on
// Electron's own default, so "no proxy" is never ambient/implicit.
function currentProxyConfig(): Electron.ProxyConfig {
  return proxyEnabled
    ? { proxyRules: proxyRulesFor(proxyConfig), proxyBypassRules: '' }
    : { mode: 'direct' }
}

// Applied to both the in-memory tab session AND session.defaultSession, and
// re-applied to the new session object every time New Identity rotates the
// partition (ADR 0009) — the single function both paths call so hardening
// can never diverge between "fresh start" and "mid-session reset". Never
// call session.fromPartition() elsewhere and skip this: an unhardened
// session backing a tab is a silent regression of every row in
// docs/threat-model.md's mitigation table that lives at the session level.
// defaultSession backs the shell BrowserWindow (tab strip/address bar UI) and
// is used by Electron for anything not explicitly assigned a session — it
// previously went unmitigated even though nothing untrusted should load
// there, which security review flagged as a real parity gap against
// docs/threat-model.md's mitigation table (a future bug that let untrusted
// content reach defaultSession would otherwise be unprotected).
async function hardenSession(ses: Session, blockContent = true): Promise<void> {
  ses.setSpellCheckerEnabled(false)

  // Referrer suppression — replaces the dead `no-referrers` switch (ADR 0002).
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    delete headers['Referer']
    callback({ requestHeaders: headers })
  })
  // Single onHeadersReceived per session (Electron allows only one listener per
  // event): always the referrer-policy header, plus — for content-blocking
  // sessions — any $csp filter directives from the engine (ADR 0013). The
  // adblocker library would otherwise register its own onHeadersReceived and
  // silently clobber this referrer header, which is why blocking.ts drives the
  // engine directly instead of enableBlockingInSession().
  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders: Record<string, string[]> = {
      ...details.responseHeaders,
      'Referrer-Policy': ['no-referrer']
    }
    if (blockContent) applyBlockingResponseHeaders(details, responseHeaders)
    callback({ responseHeaders })
  })

  // The shell/default session backs only trusted local file:// UI — never ad
  // block it (wasted per-request work, and a filter rule cancelling a shell
  // asset would be a real bug). ADR 0013: blocking covers tab, container, and
  // New-Identity-rotated sessions only.
  if (blockContent) installContentBlocking(ses)

  // Deny all permission requests except HTML5 fullscreen. Fullscreen is a
  // display-state request, not a privacy surface — it exposes no sensor,
  // storage, or network capability — and blanket denial broke video
  // fullscreen on every site (ADR 0005). 'media' denial remains one of
  // three WebRTC leak mitigation layers (ADR 0002).
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'fullscreen')
  })

  // Downloads are a v1 non-goal (CLAUDE.md), but Electron's DEFAULT
  // will-download behavior is to open a native save dialog and write wherever
  // the user picks — a real-disk write path plus a GTK recently-used.xbel
  // entry (threat-model §2). Cancel every download outright and tell the
  // shell, so the promise in the threat model is enforced, not assumed.
  ses.on('will-download', (event, item) => {
    event.preventDefault()
    sendNotice({ kind: 'download-blocked', detail: item.getFilename() })
  })

  // Every session this function ever touches is brand new (never had a
  // request in flight), so there's nothing to closeAllConnections() here —
  // that only matters for the live, explicit toggle (setProxyEnabled below).
  await ses.setProxy(currentProxyConfig())
}

// The single door for every main→shell push. `mainWindow` is never nulled, so
// after the window closes it points at a DESTROYED BrowserWindow — and during
// exit teardown tab WebContents still emit events (did-stop-loading,
// audio-state-changed, found-in-page, ...). A `.send()` on the destroyed shell
// throws "Object has been destroyed" INSIDE a native WebContents.emit, which
// kills the completion callbacks of whatever cleanupAndExit() is awaiting at
// that moment — observed as session.clearStorageData() never resolving, the
// app never exiting, and the tmpfs wipe never running (a direct violation of
// the exit-residue charter; found by scripts/verify_footprint.sh). Bailing out
// silently is not lossy: with the shell gone there is nobody to render the
// update anyway.
function sendToShell(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, ...args)
}

function sendNotice(notice: ShellNotice): void {
  sendToShell(IPC_CHANNELS.SHELL_NOTICE, notice)
}

async function configureSession(): Promise<void> {
  await hardenSession(getInMemorySession())
  // defaultSession backs the trusted shell UI only — harden it, but without
  // content blocking (ADR 0013).
  await hardenSession(session.defaultSession, false)
}

// "No tabs open" (ADR 0007 decision 7) means no tab has ever loaded real
// content — not literally zero tabs in the Map, which this app never has
// (closing the last tab quits the app entirely; there is no "zero tabs,
// blank window" state to gate on). The risk decision 7 guards against is a
// page keeping in-flight requests on a stale route while the UI claims a
// new one — a tab still showing the start page has no content and nothing
// in flight, so it's harmless to change the proxy under it.
function hasNavigatedTab(): boolean {
  return [...tabs.values()].some((entry) => entry.navigated)
}

// Human-readable label for the active scheme, used in error copy so a failed
// probe names what was actually tried (a SOCKS5/Tor endpoint vs. an HTTP/HTTPS
// proxy), never a generic "proxy".
function schemeLabel(scheme: ProxyScheme): string {
  return scheme === 'socks5' ? 'SOCKS5' : scheme === 'http' ? 'HTTP' : 'HTTPS'
}

// Explicit proxy toggle (ADR 0007 decisions 4 and 7; ADR 0012 for the scheme
// dispatch). Only when no tab has navigated anywhere yet — a proxy setting that
// changes while a tab might be relying on the old route is worse than no proxy
// at all. Enabling requires a successful scheme-appropriate handshake probe
// first; an endpoint that isn't actually speaking the configured proxy protocol
// must never be treated as "proxy is on".
async function setProxyEnabled(next: boolean): Promise<ProxyResult> {
  if (hasNavigatedTab()) {
    return { ok: false, error: 'Close all tabs before changing proxy mode', status: proxyStatus() }
  }
  if (next === proxyEnabled) return { ok: true, status: proxyStatus() }
  if (next) {
    const reachable = await probeProxy(proxyConfig)
    if (!reachable) {
      return {
        ok: false,
        error: `Could not reach a ${schemeLabel(proxyConfig.scheme)} proxy at ${proxyConfig.host}:${proxyConfig.port}`,
        status: proxyStatus()
      }
    }
  }
  proxyEnabled = next
  const config = currentProxyConfig()
  // Apply to every live tab session, not just the shared one: with containers
  // mode (ADR 0011) each per-tab partition is its own session, and a proxy gap
  // on any of them would be exactly the fail-open leak decision 4 forbids. The
  // set collapses to {shared, default} when containers are off. The handshake
  // probe above runs once, not per session — it validates the endpoint, which
  // is the same for all sessions.
  for (const ses of liveTabSessions()) {
    await ses.setProxy(config)
    // Stale pooled sockets on the old route must not be reused after the
    // config changes (session.setProxy()'s own docs call this out).
    await ses.closeAllConnections()
  }
  return { ok: true, status: proxyStatus() }
}

// Config edits are only allowed while the proxy is off — editing the
// scheme/host/port behind a live, already-proxied session is exactly the kind
// of change decision 7 exists to prevent; disable first, reconfigure, then
// re-enable (which re-probes against the new endpoint).
function setProxyConfig(scheme: ProxyScheme, host: string, port: number): ProxyResult {
  if (proxyEnabled) {
    return {
      ok: false,
      error: 'Disable the proxy before changing its configuration',
      status: proxyStatus()
    }
  }
  const error = validateProxyConfig(scheme, host, port)
  if (error) return { ok: false, error, status: proxyStatus() }
  proxyConfig = { scheme, host, port }
  return { ok: true, status: proxyStatus() }
}

// DNS-over-HTTPS provider selection (ADR 0010). Session-only state — never
// persisted, always off (null) on a fresh launch, same rule as the proxy
// above. This is independent of the proxy: app.configureHostResolver() is a
// separate, app-wide Chromium network-service setting that only governs
// the local resolver path, not requests already routed through a proxy
// (those resolve at the proxy regardless of this setting, for socks5/http/
// https alike — ADR 0007 decision 3, generalized by ADR 0012). The two
// features are not mutually exclusive in code; they are made mutually
// exclusive in the UI (see DnsControl.tsx) because changing DNS provider
// while a proxy is on has no visible effect on proxied tab traffic and would
// be confusing to expose as if it did.
let dohProviderId: string | null = null

function dnsStatus(): DnsStatus {
  return { providerId: dohProviderId, proxyEnabled }
}

// Must be called after 'ready' per Electron's docs; safe to call again
// later to change the mode — verified empirically (research/session-and-
// userdata.md §23), since Electron's docs don't say whether a repeat call
// is honored, ignored, or an error, and this project doesn't assume
// undocumented behavior without checking.
function applyHostResolver(): void {
  app.configureHostResolver(resolverConfigFor(dohProviderId))
}

function setDnsProvider(providerId: string | null): DnsResult {
  if (providerId !== null && !findDohProvider(providerId)) {
    return { ok: false, error: `Unknown DNS provider: ${providerId}`, status: dnsStatus() }
  }
  dohProviderId = providerId
  applyHostResolver()
  return { ok: true, status: dnsStatus() }
}

const TOOLBAR_HEIGHT = 88 // must match the renderer's tab-strip + address-bar height in CSS

// The renderer reports its actual chrome height (it grows when the find bar
// opens) via SHELL_CHROME_HEIGHT; TOOLBAR_HEIGHT is just the initial value.
let chromeHeight = TOOLBAR_HEIGHT

// While a page holds HTML5 fullscreen (video etc.) the active view covers the
// whole window, and the OS window itself goes fullscreen like every browser.
let htmlFullscreen = false
let wasWindowFullscreen = false // restore state when HTML fullscreen ends

function layoutActiveView(): void {
  if (!mainWindow || !activeTabId) return
  const entry = tabs.get(activeTabId)
  if (!entry) return
  const bounds = mainWindow.getContentBounds()
  const top = htmlFullscreen ? 0 : chromeHeight
  entry.view.setBounds({
    x: 0,
    y: top,
    width: bounds.width,
    height: Math.max(0, bounds.height - top)
  })
}

// A tab's view is only shown when it has something real to display — the
// shell's start page (never navigated) or error page (failed load) show
// through an invisible view instead.
function viewHasContent(entry: TabEntry): boolean {
  return entry.navigated && !entry.error
}

// Leaving the tab that holds HTML5 fullscreen (switch or close) must drop the
// fullscreen layout itself — 'leave-html-full-screen' never fires for a view
// that is hidden or destroyed while fullscreen.
function resetHtmlFullscreen(): void {
  if (!mainWindow || !htmlFullscreen) return
  htmlFullscreen = false
  if (!wasWindowFullscreen) mainWindow.setFullScreen(false)
}

function setActiveTab(id: string): void {
  if (!mainWindow || !tabs.has(id)) return
  if (id !== activeTabId) resetHtmlFullscreen()
  const previous = activeTabId ? tabs.get(activeTabId) : null
  if (previous) previous.view.setVisible(false)
  activeTabId = id
  const next = tabs.get(id)
  if (next && viewHasContent(next)) {
    next.view.setVisible(true)
    layoutActiveView()
  }
  sendToShell(IPC_CHANNELS.TAB_ACTIVATED, id)
}

function sendTabUpdate(id: string): void {
  const entry = tabs.get(id)
  if (!entry || !mainWindow) return
  const wc = entry.view.webContents
  // Teardown-safe: during exit the tab's WebContents can already be destroyed
  // while its event emitters still fire; every getter below would throw (see
  // sendToShell's comment for why a throw here is charter-critical).
  if (wc.isDestroyed()) return
  const state: TabState = {
    tabId: id,
    url: entry.navigated ? wc.getURL() : '',
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    favicon: entry.favicon,
    audible: wc.isCurrentlyAudible(),
    muted: wc.isAudioMuted(),
    zoomPercent: Math.round(wc.getZoomFactor() * 100),
    error: entry.error
  }
  sendToShell(IPC_CHANNELS.TAB_UPDATED, state)
}

// Favicons are fetched by us (main) through the tab's own in-memory session —
// NOT by the shell renderer via <img src>, which would make the privileged
// shell session issue network requests to page-controlled URLs. The result
// crosses IPC as a size-capped data: URI, so the shell never talks to the
// network at all (ADR 0005).
async function updateFavicon(id: string, url: string | undefined): Promise<void> {
  const entry = tabs.get(id)
  if (!entry) return
  if (!url || !isAllowedUrl(url)) {
    entry.favicon = null
    sendTabUpdate(id)
    return
  }
  try {
    // Fetch through the tab's OWN session so cookies, referrer stripping, and
    // (with containers or the proxy on) the tab's partition/proxy all match the
    // page the favicon belongs to — not the shared session's.
    const response = await entry.session.fetch(url)
    if (!response.ok) return
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > 256 * 1024) return
    const contentType = response.headers.get('content-type') ?? ''
    const mime = contentType.startsWith('image/') ? contentType : 'image/x-icon'
    const current = tabs.get(id)
    if (!current) return // tab closed while the favicon was in flight
    current.favicon = `data:${mime};base64,${buffer.toString('base64')}`
    sendTabUpdate(id)
  } catch {
    /* favicons are cosmetic — a failed fetch just leaves the tab icon-less */
  }
}

function activeWebContents(): WebContents | null {
  return activeTabId ? (tabs.get(activeTabId)?.view.webContents ?? null) : null
}

function focusAddressBar(): void {
  if (!mainWindow) return
  mainWindow.webContents.focus()
  sendToShell(IPC_CHANNELS.SHELL_FOCUS_ADDRESS)
}

function cycleTab(delta: number): void {
  const ids = [...tabs.keys()]
  if (ids.length < 2 || !activeTabId) return
  const index = ids.indexOf(activeTabId)
  setActiveTab(ids[(index + delta + ids.length) % ids.length]!)
}

function selectTabByDigit(digit: number): void {
  const ids = [...tabs.keys()]
  const id = digit === 9 ? ids[ids.length - 1] : ids[digit - 1]
  if (id) setActiveTab(id)
}

function adjustZoom(delta: number | null): void {
  const wc = activeWebContents()
  if (!wc || !activeTabId) return
  const level = delta === null ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta))
  wc.setZoomLevel(level)
  sendTabUpdate(activeTabId) // the renderer's zoom chip mirrors zoomPercent
}

function openFindBar(): void {
  if (!mainWindow) return
  mainWindow.webContents.focus()
  sendToShell(IPC_CHANNELS.SHELL_OPEN_FIND)
}

// Browser-chrome shortcuts, handled in main so they work no matter whether the
// shell renderer or a page's WebContentsView has keyboard focus. `source` is
// 'tab' for page views, 'shell' for the toolbar renderer — Escape is only a
// stop-loading shortcut inside pages (the address bar owns Escape in the shell).
function handleShortcut(input: Electron.Input, source: 'tab' | 'shell'): boolean {
  if (input.type !== 'keyDown') return false
  const mod = input.control || input.meta
  const key = input.key.toLowerCase()
  const wc = activeWebContents()

  if (mod && !input.alt) {
    if (key === 'tab') {
      cycleTab(input.shift ? -1 : 1)
      return true
    }
    if (!input.shift) {
      switch (key) {
        case 't':
          void openUserTab()
          return true
        case 'w':
          if (activeTabId) closeTab(activeTabId)
          return true
        case 'l':
          focusAddressBar()
          return true
        case 'f':
          openFindBar()
          return true
        case 'r':
          wc?.reload()
          return true
        case '=':
        case '+':
          adjustZoom(0.5)
          return true
        case '-':
          adjustZoom(-0.5)
          return true
        case '0':
          adjustZoom(null)
          return true
        case 'pagedown':
          cycleTab(1)
          return true
        case 'pageup':
          cycleTab(-1)
          return true
      }
      if (key >= '1' && key <= '9') {
        selectTabByDigit(Number(key))
        return true
      }
    } else {
      if (key === 'r') {
        wc?.reloadIgnoringCache()
        return true
      }
      if (key === '+' || key === '=') {
        adjustZoom(0.5)
        return true
      }
      if (key === 'q') {
        // Panic key: same cleanupAndExit() as window-all-closed/before-quit —
        // one wipe routine, reached from every input source that can carry
        // it (research/cleanup-and-exit.md §19).
        void cleanupAndExit()
        return true
      }
      if (key === 'n') {
        void newIdentity()
        return true
      }
    }
    return false
  }

  if (input.alt && !mod) {
    if (key === 'arrowleft' && wc?.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack()
      return true
    }
    if (key === 'arrowright' && wc?.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward()
      return true
    }
    return false
  }

  if (key === 'f5') {
    wc?.reload()
    return true
  }
  if (key === 'escape' && source === 'tab' && wc?.isLoading()) {
    wc.stop()
    return true
  }
  return false
}

function attachShortcuts(wc: WebContents, source: 'tab' | 'shell'): void {
  wc.on('before-input-event', (event, input) => {
    if (handleShortcut(input, source)) event.preventDefault()
  })
}

// Layer 2 of the three-layer WebRTC mitigation (ADR 0002): removes the
// WebRTC API surface from the page before any page script runs. This is
// deliberately NOT done via a preload script — with contextIsolation
// enabled, a preload script's `window` is a separate JS realm from the
// page's, so `delete window.RTCPeerConnection` in preload never reaches
// the page (see Electron's context-isolation docs: preload and page do
// not share a global object). The only documented way to guarantee
// main-world injection before page scripts run is the Chrome DevTools
// Protocol via webContents.debugger — the same mechanism Playwright's own
// page.addInitScript() uses under the hood.
const WEBRTC_BLOCK_SCRIPT = `(() => {
  delete window.RTCPeerConnection;
  delete window.webkitRTCPeerConnection;
  delete window.RTCDataChannel;
  if (window.navigator && window.navigator.mediaDevices) {
    delete window.navigator.mediaDevices.getUserMedia;
  }
})();`

async function installWebRtcBlock(wc: WebContents): Promise<void> {
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
      await wc.debugger.sendCommand('Page.enable')
    }
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: WEBRTC_BLOCK_SCRIPT
    })
  } catch (error) {
    console.error('Failed to install WebRTC API removal for tab:', error)
  }
}

// Only ever load web content — a compromised shell renderer must not be able
// to point a tab at file:// or other local schemes via the navigate IPC.
function isAllowedUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

// `ses` is a REQUIRED, already-hardened session — the type signature is the
// enforcement of ADR 0011 decision 4 (no view is ever constructed on an
// unhardened session). User tabs reach here through openUserTab() (which
// prepares a fresh partition when containers are on); opener-inherited tabs
// (window.open / context-menu "open in new tab") pass the opener's own
// already-hardened session, so a container's links stay in its container
// (decision 3, Firefox Multi-Account Containers semantics).
function createTab(ses: Session, url?: string, options: { background?: boolean } = {}): string {
  if (!mainWindow) throw new Error('createTab called before mainWindow exists')
  const id = randomUUID()
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // setWebRTCIPHandlingPolicy is per-webContents, not per-session — must be (re-)applied
  // to every tab. One of three WebRTC leak mitigation layers (ADR 0002).
  view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  void installWebRtcBlock(view.webContents)
  // Cosmetic + scriptlet injection is handled by the engine's frame preload
  // registered on the session (installContentBlocking), so there is no per-tab
  // content-blocking wiring here anymore (ADR 0013).

  // Never create real popup windows. window.open / target=_blank / ctrl+click
  // instead open as a new tab, which goes through this same createTab path and
  // therefore carries every mitigation (in-memory session, WebRTC block,
  // permission denial). Non-http(s) popup URLs are dropped entirely.
  view.webContents.setWindowOpenHandler(({ url: popupUrl, disposition }) => {
    // Inherit THIS tab's session even when containers mode is on (ADR 0011
    // decision 3): a page-opened tab (OAuth/login popup, target=_blank) stays
    // in its opener's container. `ses` is already hardened, so no await.
    if (isAllowedUrl(popupUrl)) {
      createTab(ses, popupUrl, { background: disposition === 'background-tab' })
    }
    return { action: 'deny' }
  })

  attachShortcuts(view.webContents, 'tab')
  attachTabContextMenu(view.webContents, {
    openInNewTab: (linkUrl) => {
      // Same gate as every other way into createTab — a page can put
      // javascript:/file: URLs in links, and those must never become tabs.
      // Inherits the opener session too (decision 3): "open in new tab" from a
      // page's own context menu keeps the link in that page's container.
      if (isAllowedUrl(linkUrl)) createTab(ses, linkUrl, { background: true })
    }
  })

  const notify = () => sendTabUpdate(id)
  view.webContents.on('did-start-loading', notify)
  view.webContents.on('did-stop-loading', notify)
  view.webContents.on('did-navigate', notify)
  view.webContents.on('did-navigate-in-page', notify)
  view.webContents.on('page-title-updated', notify)
  view.webContents.on('audio-state-changed', notify)

  view.webContents.on('page-favicon-updated', (_event, favicons) => {
    void updateFavicon(id, favicons[0])
  })
  view.webContents.on('did-navigate', (_event, _url, httpResponseCode) => {
    const entry = tabs.get(id)
    if (!entry) return
    // New document: the old favicon no longer describes this tab.
    entry.favicon = null
    // httpResponseCode is -1 for non-HTTP commits. Tabs only ever load
    // http(s), so -1 here means Chromium committed its internal error page
    // (which follows did-fail-load — clearing on it would erase the error
    // state the moment it was set; found the hard way via the e2e test).
    // A real HTTP commit means any previous failure is over.
    if (httpResponseCode !== -1) {
      entry.error = null
      if (id === activeTabId && viewHasContent(entry)) {
        entry.view.setVisible(true)
        layoutActiveView()
      }
    }
  })

  // Failed main-frame loads swap Chromium's grey default error page for an
  // in-shell one: hide the view (the shell DOM shows through, like the start
  // page) and hand the renderer the error details. ERR_ABORTED (-3) is not a
  // failure — it fires for stop(), superseded navigations, and the
  // will-download cancel. Certificate errors arrive here too (as ERR_CERT_*):
  // there is deliberately no 'certificate-error' handler, so Electron's
  // default — reject the connection — stands, and v1 offers no bypass button.
  view.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    const entry = tabs.get(id)
    if (!entry) return
    entry.error = { code, description, url: failedUrl }
    entry.view.setVisible(false)
    notify()
  })

  view.webContents.on('found-in-page', (_event, result) => {
    if (!result.finalUpdate) return // interim updates would make the count flicker
    sendToShell(IPC_CHANNELS.FIND_RESULT, {
      tabId: id,
      matches: result.matches,
      activeMatchOrdinal: result.activeMatchOrdinal
    })
  })

  // HTML5 fullscreen (allowed by the permission carve-out above): the view
  // covers the toolbar and the OS window goes fullscreen, like any browser.
  // Chromium itself handles Esc-to-exit.
  view.webContents.on('enter-html-full-screen', () => {
    if (!mainWindow || id !== activeTabId) return
    htmlFullscreen = true
    wasWindowFullscreen = mainWindow.isFullScreen()
    if (!wasWindowFullscreen) mainWindow.setFullScreen(true)
    layoutActiveView()
  })
  view.webContents.on('leave-html-full-screen', () => {
    if (!mainWindow || !htmlFullscreen) return
    htmlFullscreen = false
    if (!wasWindowFullscreen) mainWindow.setFullScreen(false)
    layoutActiveView()
  })

  const navigated = Boolean(url)
  if (url) view.webContents.loadURL(url)

  view.setVisible(false)
  mainWindow.contentView.addChildView(view)
  tabs.set(id, { view, session: ses, navigated, favicon: null, error: null })
  if (!options.background) {
    setActiveTab(id)
    if (!navigated) focusAddressBar() // fresh empty tab: start typing immediately
  }
  notify()
  return id
}

// HTTP basic/proxy auth challenges intercepted from the 'login' event, keyed
// by request id, awaiting credentials (or cancel) from the shell's dialog.
// Held in memory only — clearAuthCache() on exit wipes whatever Chromium
// caches from a successful login.
interface PendingAuth {
  callback: (username?: string, password?: string) => void
  tabId: string | null
}
const pendingAuth = new Map<string, PendingAuth>()

function resolveAuth(requestId: string, credentials: AuthCredentials | null): void {
  const pending = pendingAuth.get(requestId)
  if (!pending) return
  pendingAuth.delete(requestId)
  try {
    if (credentials) pending.callback(credentials.username, credentials.password)
    else pending.callback() // no args = cancel; the site's 401 page renders instead
  } catch {
    /* the requesting webContents may already be destroyed */
  }
  // The view was hidden while the dialog covered the page area — restore it.
  if (pending.tabId && pending.tabId === activeTabId) {
    const entry = tabs.get(pending.tabId)
    if (entry && viewHasContent(entry)) {
      entry.view.setVisible(true)
      layoutActiveView()
    }
  }
}

function closeTab(id: string, options: { quitOnEmpty?: boolean } = {}): void {
  const entry = tabs.get(id)
  if (!entry || !mainWindow) return
  // A closed tab can't answer its auth challenges; cancel them and tell the
  // shell to drop the matching dialogs.
  for (const [requestId, pending] of [...pendingAuth]) {
    if (pending.tabId === id) {
      resolveAuth(requestId, null)
      sendToShell(IPC_CHANNELS.AUTH_CANCELLED, requestId)
    }
  }
  if (id === activeTabId) resetHtmlFullscreen()
  const ids = [...tabs.keys()]
  const index = ids.indexOf(id)
  mainWindow.contentView.removeChildView(entry.view)
  entry.view.webContents.close()
  tabs.delete(id)
  sendToShell(IPC_CHANNELS.TAB_CLOSED, id)
  if (activeTabId === id) {
    activeTabId = null
    // Prefer the right-hand neighbour, then the left one — matches what every
    // mainstream browser does and keeps closing a run of tabs predictable.
    const next = ids[index + 1] ?? ids[index - 1]
    if (next && tabs.has(next)) setActiveTab(next)
  }
  // Closing the last tab closes the window, which triggers the wipe-and-exit
  // path below — coherent with the product promise: nothing lingers.
  // New Identity (ADR 0009) closes every tab down to zero on purpose without
  // wanting the app to quit, so it passes quitOnEmpty: false.
  if (tabs.size === 0 && (options.quitOnEmpty ?? true)) mainWindow.close()
}

// New Identity: forensically fresh session mid-run, no app restart (ADR
// 0009). Every existing tab is destroyed (closeTab, not just hidden — their
// WebContentsViews are still bound to the session being abandoned) and the
// in-memory partition is rotated to a new name rather than cleared in place,
// so the old session object is dropped entirely rather than trusted to have
// been exhaustively cleared. The old session is still explicitly cleared
// first — the same immediate, awaited pattern cleanupAndExit uses — so
// Chromium drops its own references and the allocator can reclaim before GC
// would otherwise get around to it (threat-model.md §3).
let identityResetInProgress = false

async function newIdentity(): Promise<void> {
  if (!mainWindow || identityResetInProgress) return
  identityResetInProgress = true
  try {
    // Capture every session about to be abandoned BEFORE closing tabs empties
    // the map: the shared per-generation session plus, under containers mode
    // (ADR 0011), each open tab's own per-tab session. All of them are cleared
    // explicitly (belt-and-suspenders on top of rotation, exactly as ADR 0009
    // reasons for the shared session) — closing tabs alone drops the views but
    // not the sessions' in-RAM storage.
    const oldSessions = liveTabSessions()
    oldSessions.delete(session.defaultSession) // the shell session is never rotated
    for (const id of [...tabs.keys()]) {
      closeTab(id, { quitOnEmpty: false })
    }
    for (const ses of oldSessions) {
      await ses.clearStorageData()
      await ses.clearCache()
      await ses.clearAuthCache()
    }

    // Bump the generation first, then open the fresh tab through the normal
    // user-tab door: with containers on, that tab gets a fresh per-tab
    // partition under the NEW generation; with them off, the new shared
    // session. tabPartitionCounter is deliberately NOT reset (decision 2).
    sessionGeneration += 1
    await hardenSession(getInMemorySession())
    resetBlockedCount()

    await openUserTab()
    sendNotice({ kind: 'identity-reset', detail: '' })
  } finally {
    identityResetInProgress = false
  }
}

function registerIpcHandlers(): void {
  // The renderer requests its first tab once mounted and subscribed; that
  // same moment is the earliest a notice can be delivered without racing
  // the shell's listener registration, so startup checks run here.
  let startupChecksDone = false
  ipcMain.handle(IPC_CHANNELS.TAB_NEW, async (_event, url?: string) => {
    const id = await openUserTab(url)
    if (!startupChecksDone) {
      startupChecksDone = true
      checkSwap()
    }
    await drainForwardedUrls() // URLs forwarded by a second launch before the renderer mounted
    return id
  })
  ipcMain.handle(IPC_CHANNELS.TAB_CLOSE, (_event, tabId: string) => closeTab(tabId))
  ipcMain.handle(IPC_CHANNELS.TAB_ACTIVATE, (_event, tabId: string) => setActiveTab(tabId))
  ipcMain.handle(IPC_CHANNELS.TAB_NAVIGATE, (_event, tabId: string, url: string) => {
    const entry = tabs.get(tabId)
    if (!entry || !isAllowedUrl(url)) return
    const hadError = entry.error !== null
    entry.navigated = true
    entry.error = null
    entry.view.webContents.loadURL(url)
    // Coming from an error page, stay hidden until did-finish-load — showing
    // now would flash Chromium's stale built-in error page over the shell's.
    if (tabId === activeTabId && !hadError) {
      entry.view.setVisible(true)
      layoutActiveView()
    }
  })
  ipcMain.handle(IPC_CHANNELS.TAB_BACK, (_event, tabId: string) => {
    tabs.get(tabId)?.view.webContents.navigationHistory.goBack()
  })
  ipcMain.handle(IPC_CHANNELS.TAB_FORWARD, (_event, tabId: string) => {
    tabs.get(tabId)?.view.webContents.navigationHistory.goForward()
  })
  ipcMain.handle(IPC_CHANNELS.TAB_RELOAD, (_event, tabId: string) => {
    tabs.get(tabId)?.view.webContents.reload()
  })
  ipcMain.handle(IPC_CHANNELS.TAB_STOP, (_event, tabId: string) => {
    tabs.get(tabId)?.view.webContents.stop()
  })
  ipcMain.handle(IPC_CHANNELS.TAB_REORDER, (_event, order: string[]) => {
    // The Map's insertion order is the tab order (Ctrl+1..9, Ctrl+Tab), so a
    // drag-reorder rebuilds it. Only accept an exact permutation — anything
    // else (duplicates, unknown or missing ids) would drop tabs.
    if (
      !Array.isArray(order) ||
      new Set(order).size !== tabs.size ||
      !order.every((id) => tabs.has(id))
    ) {
      return
    }
    const reordered = order.map((id) => [id, tabs.get(id)!] as const)
    tabs.clear()
    for (const [id, entry] of reordered) tabs.set(id, entry)
  })
  ipcMain.handle(IPC_CHANNELS.TAB_TOGGLE_MUTE, (_event, tabId: string) => {
    const wc = tabs.get(tabId)?.view.webContents
    if (!wc) return
    wc.setAudioMuted(!wc.isAudioMuted())
    sendTabUpdate(tabId)
  })
  ipcMain.handle(IPC_CHANNELS.TAB_ZOOM_RESET, (_event, tabId: string) => {
    if (tabId === activeTabId) adjustZoom(null)
  })
  ipcMain.handle(IPC_CHANNELS.IDENTITY_NEW, () => newIdentity())
  ipcMain.handle(IPC_CHANNELS.AUDIT_REQUEST, (): AuditReport => buildAuditReport())
  ipcMain.handle(IPC_CHANNELS.PROXY_GET_STATUS, (): ProxyStatus => proxyStatus())
  ipcMain.handle(IPC_CHANNELS.PROXY_SET_ENABLED, (_event, enabled: boolean) =>
    setProxyEnabled(enabled)
  )
  ipcMain.handle(
    IPC_CHANNELS.PROXY_SET_CONFIG,
    (_event, scheme: ProxyScheme, host: string, port: number): ProxyResult =>
      setProxyConfig(scheme, host, port)
  )
  ipcMain.handle(IPC_CHANNELS.DNS_GET_STATUS, (): DnsStatus => dnsStatus())
  ipcMain.handle(IPC_CHANNELS.DNS_SET_PROVIDER, (_event, providerId: string | null): DnsResult =>
    setDnsProvider(providerId)
  )
  ipcMain.handle(IPC_CHANNELS.DNS_LIST_PROVIDERS, (): DnsProviderOption[] =>
    DOH_PROVIDERS.map(({ id, label }) => ({ id, label }))
  )
  ipcMain.handle(IPC_CHANNELS.CONTAINERS_GET_STATUS, (): ContainersStatus => containersStatus())
  ipcMain.handle(
    IPC_CHANNELS.CONTAINERS_SET_ENABLED,
    (_event, enabled: boolean): ContainersStatus => setContainersEnabled(enabled)
  )
  ipcMain.handle(IPC_CHANNELS.BLOCKING_GET_STATUS, () => blockingStatus())
  ipcMain.handle(IPC_CHANNELS.BLOCKING_SET_ENABLED, (_event, enabled: unknown) => {
    // Validate rather than coerce: an unexpected payload must not silently flip
    // blocking. Ignore non-booleans and just report current status.
    if (typeof enabled !== 'boolean') return blockingStatus()
    return setBlockingEnabled(enabled)
  })
  // Push status to the renderer as the blocked count climbs (throttled inside
  // blocking-engine.ts) and immediately on reset/toggle, so the popover count
  // stays live instead of being a stale mount-time snapshot. Also fixes the
  // New Identity case where resetBlockedCount() left the shown count stale.
  setBlockingChangeListener(() => {
    sendToShell(IPC_CHANNELS.BLOCKING_STATUS_CHANGED, blockingStatus())
  })
  ipcMain.handle(
    IPC_CHANNELS.FIND_START,
    (_event, tabId: string, text: string, forward: boolean, findNext: boolean) => {
      const wc = tabs.get(tabId)?.view.webContents
      if (!wc || typeof text !== 'string' || text.length === 0) return
      wc.findInPage(text, { forward, findNext })
    }
  )
  ipcMain.handle(IPC_CHANNELS.FIND_STOP, (_event, tabId: string, keepSelection: boolean) => {
    tabs
      .get(tabId)
      ?.view.webContents.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection')
  })
  ipcMain.handle(
    IPC_CHANNELS.AUTH_RESPONSE,
    (_event, requestId: string, credentials: AuthCredentials | null) => {
      resolveAuth(requestId, credentials)
    }
  )
  ipcMain.handle(IPC_CHANNELS.SHELL_CHROME_HEIGHT, (_event, px: number) => {
    // Bounds-check: a bogus height from a compromised shell renderer could
    // otherwise shove the page view off-window.
    if (typeof px !== 'number' || !Number.isFinite(px) || px < 44 || px > 320) return
    chromeHeight = Math.round(px)
    layoutActiveView()
  })
}

// Warn (don't block) when disk-backed swap is active: under memory pressure
// the OS can write this app's memory to disk, which no userspace process can
// prevent — threat-model §3 tells users to run encrypted swap or none, and
// this surfaces that advice exactly when it applies. Errors are swallowed:
// missing /proc/swaps (non-Linux, hardened kernels) just means no warning.
function checkSwap(): void {
  if (process.platform !== 'linux') return
  try {
    const devices = diskBackedSwapDevices(readFileSync('/proc/swaps', 'utf8'))
    if (devices.length > 0) {
      sendNotice({ kind: 'swap-active', detail: devices.join(', ') })
    }
  } catch {
    /* no /proc/swaps — nothing to warn about */
  }
}

// Self-audit panel (start page) — turns the CI-only trust story user-facing.
// Every row here runs in the main process; the shell only ever receives this
// plain, serializable result over the existing IPC bridge (no new capability
// crosses into the renderer). Each row's `verifiedAtRuntime` must be honest:
// true only for checks actually performed in this running process just now,
// false for guarantees that only a CI lint rule enforces — conflating the two
// would be exactly the overselling this project exists to avoid.
//
// Parses /proc/mounts to find the filesystem type backing a path — same
// "longest matching mount point wins" logic the kernel itself uses, since a
// path can sit under several nested mounts (e.g. / then /dev then /dev/shm).
function mountFsType(mountsContent: string, targetPath: string): string | null {
  let best: { mountPoint: string; fsType: string } | null = null
  for (const line of mountsContent.split('\n')) {
    const fields = line.split(' ')
    if (fields.length < 3) continue
    // /proc/mounts octal-escapes spaces and a few other characters in paths.
    const mountPoint = fields[1]!.replace(/\\040/g, ' ')
    const fsType = fields[2]!
    const isUnder = targetPath === mountPoint || targetPath.startsWith(`${mountPoint}/`)
    if (isUnder && (!best || mountPoint.length > best.mountPoint.length)) {
      best = { mountPoint, fsType }
    }
  }
  return best?.fsType ?? null
}

function buildAuditReport(): AuditReport {
  const userDataPath = app.getPath('userData')
  const linux = process.platform === 'linux'
  const checks: AuditCheck[] = []

  checks.push(
    (() => {
      if (!linux) {
        return {
          id: 'tmpfs',
          label: 'Session data directory is RAM-backed (tmpfs)',
          verifiedAtRuntime: false,
          status: 'warn' as const,
          detail: 'Only checked on Linux — see docs/threat-model.md §4 for other platforms'
        }
      }
      try {
        const fsType = mountFsType(readFileSync('/proc/mounts', 'utf8'), userDataPath)
        return {
          id: 'tmpfs',
          label: 'Session data directory is RAM-backed (tmpfs)',
          verifiedAtRuntime: true,
          status: fsType === 'tmpfs' ? ('pass' as const) : ('fail' as const),
          detail: `${userDataPath} is mounted "${fsType ?? 'unknown'}"`
        }
      } catch {
        return {
          id: 'tmpfs',
          label: 'Session data directory is RAM-backed (tmpfs)',
          verifiedAtRuntime: false,
          status: 'warn' as const,
          detail: '/proc/mounts was not readable — could not verify this instant'
        }
      }
    })()
  )

  checks.push({
    id: 'userdata-path',
    label: 'Session data directory is per-instance and present',
    verifiedAtRuntime: linux,
    status: !linux
      ? 'warn'
      : /^\/dev\/shm\/amnesic-browser-/.test(userDataPath) && existsSync(userDataPath)
        ? 'pass'
        : 'fail',
    detail: linux ? userDataPath : 'Only checked on Linux — see docs/threat-model.md §4'
  })

  {
    let swapDevices: string[] = []
    let swapReadable = false
    if (linux) {
      try {
        swapDevices = diskBackedSwapDevices(readFileSync('/proc/swaps', 'utf8'))
        swapReadable = true
      } catch {
        /* /proc/swaps unreadable — reported below as not runtime-checkable */
      }
    }
    checks.push({
      id: 'swap',
      label: 'No disk-backed swap active',
      verifiedAtRuntime: swapReadable,
      status: !swapReadable ? 'warn' : swapDevices.length === 0 ? 'pass' : 'warn',
      detail: !swapReadable
        ? 'Only checked on Linux, and only when /proc/swaps is readable'
        : swapDevices.length === 0
          ? 'No disk-backed swap device found (zram is exempt)'
          : `Disk-backed swap active: ${swapDevices.join(', ')} — see docs/threat-model.md §4`
    })
  }

  checks.push({
    id: 'crash-reporter',
    label: 'Crash reporter never started',
    // Electron 43's CrashReporter API has no boolean/status getter for
    // "has start() been called" (research/cleanup-and-exit.md §21) — the
    // only honest thing to show here is that this is a build-time guarantee,
    // not something this panel actually checked just now.
    verifiedAtRuntime: false,
    status: 'pass',
    detail:
      'No Electron 43 runtime signal exists for this. Enforced by a CI lint rule that bans ' +
      "the crash reporter's start call anywhere in src/ — see docs/threat-model.md §2 and ADR 0002."
  })

  const httpCacheDisabled = app.commandLine.hasSwitch('disable-http-cache')
  checks.push({
    id: 'http-cache',
    label: 'HTTP disk cache disabled',
    verifiedAtRuntime: true,
    status: httpCacheDisabled ? 'pass' : 'fail',
    detail: httpCacheDisabled
      ? 'The disable-http-cache command-line switch is active'
      : 'disable-http-cache switch not found — this should never happen'
  })

  const partitionName = currentPartitionName()
  checks.push({
    id: 'partition',
    label: 'Tab session partition is non-persistent',
    verifiedAtRuntime: true,
    status: partitionName.startsWith('persist:') ? 'fail' : 'pass',
    detail: `Actual partition name: "${partitionName}" (no persist: prefix)`
  })

  const downloadHandlerAttached = getInMemorySession().listenerCount('will-download') > 0
  checks.push({
    id: 'downloads',
    label: 'Downloads are cancelled, not saved to disk',
    verifiedAtRuntime: true,
    status: downloadHandlerAttached ? 'pass' : 'fail',
    detail: downloadHandlerAttached
      ? 'A will-download handler is attached and unconditionally cancels every download — ' +
        'a real download attempt is exercised end-to-end by scripts/footprint-session.mjs, ' +
        'not by this panel.'
      : 'No will-download handler is attached — this should never happen'
  })

  const xdgCacheHome = process.env['XDG_CACHE_HOME']
  const xdgInsideTmpfs = Boolean(
    linux && ramUserData && xdgCacheHome && xdgCacheHome.startsWith(ramUserData)
  )
  checks.push({
    id: 'xdg-cache',
    label: 'Non-Chromium child-process caches (Mesa, fontconfig) redirected into tmpfs',
    verifiedAtRuntime: linux,
    status: !linux ? 'warn' : xdgInsideTmpfs ? 'pass' : 'fail',
    detail: linux
      ? `XDG_CACHE_HOME=${xdgCacheHome ?? '(unset)'}`
      : 'Linux-only mitigation — see docs/threat-model.md §4'
  })

  return { checks }
}

// --- Single-instance lock (see src/main/single-instance.ts and ADR 0006) ---
// A second launch forwards its http(s) argv URLs here and exits; this
// instance opens them as tabs and raises its window. URLs arriving before
// the renderer has mounted (it creates the first tab itself via TAB_NEW)
// are buffered and drained once tabs exist.
let instanceLock: SingleInstanceLock | null = null
const forwardedUrls: string[] = []

async function drainForwardedUrls(): Promise<void> {
  if (!mainWindow || tabs.size === 0) return // renderer not ready yet
  // Second-instance URL handoff is user-initiated, so each opens through the
  // user-tab door — a fresh per-tab partition when containers mode is on.
  for (const url of forwardedUrls.splice(0)) {
    if (isAllowedUrl(url)) await openUserTab(url, { background: true })
  }
}

function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function onSecondInstance(urls: string[]): void {
  forwardedUrls.push(...urls)
  void drainForwardedUrls()
  focusMainWindow()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 560,
    minHeight: 400,
    title: 'Amnesic',
    backgroundColor: '#141413', // matches --bg in the renderer; avoids a white flash at startup
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('resize', layoutActiveView)
  attachShortcuts(mainWindow.webContents, 'shell')
  attachShellContextMenu(mainWindow.webContents)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // The renderer requests the first tab itself once mounted (via newTab()),
  // rather than main creating one here — avoids a race where a `tab:updated`
  // event could be sent before the renderer's IPC listener is registered.
}

let cleanupStarted = false

async function cleanupAndExit(): Promise<void> {
  if (cleanupStarted) return // several exit paths converge here; run once
  cleanupStarted = true
  // Clear every live session: the shared per-generation session, defaultSession
  // (backs the shell window — clearing it too was a security review finding),
  // and every open tab's own per-tab session under containers mode (ADR 0011).
  // liveTabSessions() is the single source of "all sessions in play", so this
  // can't drift from the Tor-apply set. This is belt-and-suspenders on top of
  // the tmpfs deletion below — the partitions are memory-only, so nothing was
  // on disk — but it drops Chromium's own references before exit.
  // NOTE: while these clears are awaited, tab WebContents are still tearing
  // down and their events still fire. Any synchronous throw inside one of
  // those native emits (e.g. a `.send()` to the already-destroyed shell
  // window) aborts Chromium's in-flight completion dispatch and the awaited
  // promise below NEVER resolves — the app hangs and the tmpfs wipe never
  // runs. That is why every main→shell push goes through the destroyed-safe
  // sendToShell() and sendTabUpdate() bails on destroyed WebContents.
  for (const ses of liveTabSessions()) {
    await ses.clearStorageData()
    await ses.clearCache()
    await ses.clearAuthCache()
  }
  // Remove the tmpfs userData directory itself. tmpfs contents survive
  // process exit until reboot, so without this, whatever Chromium wrote
  // there (Local Storage, Local State, ...) stays readable in
  // /dev/shm/amnesic-browser-<pid> after the app closes — found by
  // scripts/verify_footprint.sh (ADR 0004). Deleting after the clears and
  // immediately before exit; open file handles don't block unlinking on
  // Linux. force:true because a failure to delete must not block exit.
  if (ramUserData) {
    rmSync(ramUserData, { recursive: true, force: true })
  }
  // Release the single-instance socket so the next launch doesn't have to
  // detect it as stale (it would recover anyway — see single-instance.ts).
  instanceLock?.release()
  // Hard exit, not app.quit() — app.exit() is immediate and skips will-quit,
  // so all cleanup must be awaited inline before calling it (ADR 0002 / threat-model §3).
  app.exit(0)
}

// HTTP basic/proxy auth. Unhandled, Electron cancels the auth and the site
// silently fails; instead, hold the challenge open and ask the user through
// an in-shell dialog. The requesting view is hidden while the dialog is up
// because the shell's DOM cannot render above a WebContentsView.
app.on('login', (event, webContents, _details, authInfo, callback) => {
  if (!mainWindow) return // no UI to ask through — let Electron cancel it
  event.preventDefault()
  const requestId = randomUUID()
  const tabId = [...tabs.entries()].find(([, e]) => e.view.webContents === webContents)?.[0] ?? null
  pendingAuth.set(requestId, { callback, tabId })
  if (tabId && tabId === activeTabId) tabs.get(tabId)?.view.setVisible(false)
  sendToShell(IPC_CHANNELS.AUTH_REQUEST, {
    requestId,
    host: authInfo.host,
    realm: authInfo.realm,
    isProxy: authInfo.isProxy
  })
})

app.whenReady().then(async () => {
  if (relaunching) return // this instance only exists to re-exec with the cache env set
  if (process.platform === 'linux') sweepStaleShmDirs()
  warmBlockingEngine()
  // The lock lives on tmpfs like everything else; a second launch hands its
  // URLs to the running instance and exits. Skipped under automation for the
  // same reason as the relaunch bootstrap: Playwright and dev instances own
  // their process lifecycles. getuid always exists on Linux.
  if (process.platform === 'linux' && !automated) {
    const uid = process.getuid!()
    instanceLock = await acquireSingleInstance({
      lockDir: defaultLockDir(uid),
      uid,
      argv: process.argv.slice(1),
      onSecondInstance
    })
    if (!instanceLock.acquired) {
      // URLs delivered to the running instance. Remove this launch's tmpfs
      // dir before exiting — nothing was browsed, but the bootstrap created
      // it, and cleanupAndExit never runs on this path.
      if (ramUserData) rmSync(ramUserData, { recursive: true, force: true })
      app.exit(0)
      return
    }
  }
  await configureSession()
  applyHostResolver() // off (automatic) by default — see ADR 0010
  registerIpcHandlers()
  createWindow()
})

// SIGTERM (kill, logout, shutdown) runs Chromium's own quit sequence, which
// terminates the process while cleanupAndExit is still awaiting the session
// clears — verified empirically: a SIGTERM'd instance left its tmpfs dir
// behind even though window-all-closed had fired. Holding the quit open with
// preventDefault until cleanup calls app.exit(0) itself closes that race
// (app.exit does not re-emit before-quit, so there is no loop). SIGKILL and
// crashes can't be intercepted; sweepStaleShmDirs() covers those on the next
// launch.
app.on('before-quit', (event) => {
  if (relaunching || cleanupStarted) return
  event.preventDefault()
  void cleanupAndExit()
})

// No tray, no background mode: always quit when all windows close, on every
// platform (overriding macOS's default of staying alive).
app.on('window-all-closed', () => {
  void cleanupAndExit()
})

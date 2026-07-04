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
  type AuthCredentials,
  type ShellNotice,
  type TabLoadError,
  type TabState
} from '../shared/ipc'
import { attachShellContextMenu, attachTabContextMenu } from './context-menu'
import { acquireSingleInstance, defaultLockDir, type SingleInstanceLock } from './single-instance'
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

const SESSION_PARTITION = 'inmemory-session' // no `persist:` prefix — this is what makes it memory-only

interface TabEntry {
  view: WebContentsView
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

function getInMemorySession() {
  return session.fromPartition(SESSION_PARTITION, { cache: false })
}

// Applied to both the in-memory tab session AND session.defaultSession.
// defaultSession backs the shell BrowserWindow (tab strip/address bar UI) and
// is used by Electron for anything not explicitly assigned a session — it
// previously went unmitigated even though nothing untrusted should load
// there, which security review flagged as a real parity gap against
// docs/threat-model.md's mitigation table (a future bug that let untrusted
// content reach defaultSession would otherwise be unprotected).
function applySessionMitigations(ses: Session): void {
  ses.setSpellCheckerEnabled(false)

  // Referrer suppression — replaces the dead `no-referrers` switch (ADR 0002).
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    delete headers['Referer']
    callback({ requestHeaders: headers })
  })
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Referrer-Policy': ['no-referrer']
      }
    })
  })

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
}

function sendNotice(notice: ShellNotice): void {
  mainWindow?.webContents.send(IPC_CHANNELS.SHELL_NOTICE, notice)
}

function configureSession(): void {
  applySessionMitigations(getInMemorySession())
  applySessionMitigations(session.defaultSession)
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
  mainWindow.webContents.send(IPC_CHANNELS.TAB_ACTIVATED, id)
}

function sendTabUpdate(id: string): void {
  const entry = tabs.get(id)
  if (!entry || !mainWindow) return
  const wc = entry.view.webContents
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
  mainWindow.webContents.send(IPC_CHANNELS.TAB_UPDATED, state)
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
    const response = await getInMemorySession().fetch(url)
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
  mainWindow.webContents.send(IPC_CHANNELS.SHELL_FOCUS_ADDRESS)
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
  mainWindow.webContents.send(IPC_CHANNELS.SHELL_OPEN_FIND)
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
          createTab()
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

async function installWebRtcBlock(view: WebContentsView): Promise<void> {
  const wc = view.webContents
  try {
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Page.enable')
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

function createTab(url?: string, options: { background?: boolean } = {}): string {
  if (!mainWindow) throw new Error('createTab called before mainWindow exists')
  const id = randomUUID()
  const view = new WebContentsView({
    webPreferences: {
      session: getInMemorySession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // setWebRTCIPHandlingPolicy is per-webContents, not per-session — must be (re-)applied
  // to every tab. One of three WebRTC leak mitigation layers (ADR 0002).
  view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  void installWebRtcBlock(view)

  // Never create real popup windows. window.open / target=_blank / ctrl+click
  // instead open as a new tab, which goes through this same createTab path and
  // therefore carries every mitigation (in-memory session, WebRTC block,
  // permission denial). Non-http(s) popup URLs are dropped entirely.
  view.webContents.setWindowOpenHandler(({ url: popupUrl, disposition }) => {
    if (isAllowedUrl(popupUrl)) {
      createTab(popupUrl, { background: disposition === 'background-tab' })
    }
    return { action: 'deny' }
  })

  attachShortcuts(view.webContents, 'tab')
  attachTabContextMenu(view.webContents, {
    openInNewTab: (linkUrl) => {
      // Same gate as every other way into createTab — a page can put
      // javascript:/file: URLs in links, and those must never become tabs.
      if (isAllowedUrl(linkUrl)) createTab(linkUrl, { background: true })
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
    mainWindow?.webContents.send(IPC_CHANNELS.FIND_RESULT, {
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
  tabs.set(id, { view, navigated, favicon: null, error: null })
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

function closeTab(id: string): void {
  const entry = tabs.get(id)
  if (!entry || !mainWindow) return
  // A closed tab can't answer its auth challenges; cancel them and tell the
  // shell to drop the matching dialogs.
  for (const [requestId, pending] of [...pendingAuth]) {
    if (pending.tabId === id) {
      resolveAuth(requestId, null)
      mainWindow.webContents.send(IPC_CHANNELS.AUTH_CANCELLED, requestId)
    }
  }
  if (id === activeTabId) resetHtmlFullscreen()
  const ids = [...tabs.keys()]
  const index = ids.indexOf(id)
  mainWindow.contentView.removeChildView(entry.view)
  entry.view.webContents.close()
  tabs.delete(id)
  mainWindow.webContents.send(IPC_CHANNELS.TAB_CLOSED, id)
  if (activeTabId === id) {
    activeTabId = null
    // Prefer the right-hand neighbour, then the left one — matches what every
    // mainstream browser does and keeps closing a run of tabs predictable.
    const next = ids[index + 1] ?? ids[index - 1]
    if (next && tabs.has(next)) setActiveTab(next)
  }
  // Closing the last tab closes the window, which triggers the wipe-and-exit
  // path below — coherent with the product promise: nothing lingers.
  if (tabs.size === 0) mainWindow.close()
}

function registerIpcHandlers(): void {
  // The renderer requests its first tab once mounted and subscribed; that
  // same moment is the earliest a notice can be delivered without racing
  // the shell's listener registration, so startup checks run here.
  let startupChecksDone = false
  ipcMain.handle(IPC_CHANNELS.TAB_NEW, (_event, url?: string) => {
    const id = createTab(url)
    if (!startupChecksDone) {
      startupChecksDone = true
      checkSwap()
    }
    drainForwardedUrls() // URLs forwarded by a second launch before the renderer mounted
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

// --- Single-instance lock (see src/main/single-instance.ts and ADR 0006) ---
// A second launch forwards its http(s) argv URLs here and exits; this
// instance opens them as tabs and raises its window. URLs arriving before
// the renderer has mounted (it creates the first tab itself via TAB_NEW)
// are buffered and drained once tabs exist.
let instanceLock: SingleInstanceLock | null = null
const forwardedUrls: string[] = []

function drainForwardedUrls(): void {
  if (!mainWindow || tabs.size === 0) return // renderer not ready yet
  for (const url of forwardedUrls.splice(0)) {
    if (isAllowedUrl(url)) createTab(url, { background: true })
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
  drainForwardedUrls()
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
  const ses = getInMemorySession()
  await ses.clearStorageData()
  await ses.clearCache()
  await ses.clearAuthCache()
  // defaultSession backs the shell window — clear it too, not just the tab
  // session (security review finding: this was previously left uncleared).
  await session.defaultSession.clearStorageData()
  await session.defaultSession.clearCache()
  await session.defaultSession.clearAuthCache()
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
  mainWindow.webContents.send(IPC_CHANNELS.AUTH_REQUEST, {
    requestId,
    host: authInfo.host,
    realm: authInfo.realm,
    isProxy: authInfo.isProxy
  })
})

app.whenReady().then(async () => {
  if (relaunching) return // this instance only exists to re-exec with the cache env set
  if (process.platform === 'linux') sweepStaleShmDirs()
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
  configureSession()
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

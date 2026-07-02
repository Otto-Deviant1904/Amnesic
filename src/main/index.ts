import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  type Session,
  type WebContents
} from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS, type TabState } from '../shared/ipc'

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
if (process.platform === 'linux') {
  const ramUserData = join('/dev/shm', `amnesic-browser-${process.pid}`)
  mkdirSync(ramUserData, { recursive: true }) // app.setPath throws if the directory doesn't already exist
  app.setPath('userData', ramUserData)
}

const SESSION_PARTITION = 'inmemory-session' // no `persist:` prefix — this is what makes it memory-only

interface TabEntry {
  view: WebContentsView
  /** False until the first loadURL — the renderer shows the start page instead. */
  navigated: boolean
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

  // Deny all permission requests by default; v1 has no feature that needs any of them.
  // 'media' denial is one of three WebRTC leak mitigation layers (ADR 0002).
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

function configureSession(): void {
  applySessionMitigations(getInMemorySession())
  applySessionMitigations(session.defaultSession)
}

const TOOLBAR_HEIGHT = 88 // must match the renderer's tab-strip + address-bar height in CSS

function layoutActiveView(): void {
  if (!mainWindow || !activeTabId) return
  const entry = tabs.get(activeTabId)
  if (!entry) return
  const bounds = mainWindow.getContentBounds()
  entry.view.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width: bounds.width,
    height: Math.max(0, bounds.height - TOOLBAR_HEIGHT)
  })
}

function setActiveTab(id: string): void {
  if (!mainWindow || !tabs.has(id)) return
  const previous = activeTabId ? tabs.get(activeTabId) : null
  if (previous) previous.view.setVisible(false)
  activeTabId = id
  const next = tabs.get(id)
  // A never-navigated tab stays hidden so the shell's start page shows through.
  if (next && next.navigated) {
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
    canGoForward: wc.navigationHistory.canGoForward()
  }
  mainWindow.webContents.send(IPC_CHANNELS.TAB_UPDATED, state)
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
  if (!wc) return
  const level = delta === null ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta))
  wc.setZoomLevel(level)
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

  const notify = () => sendTabUpdate(id)
  view.webContents.on('did-start-loading', notify)
  view.webContents.on('did-stop-loading', notify)
  view.webContents.on('did-navigate', notify)
  view.webContents.on('did-navigate-in-page', notify)
  view.webContents.on('page-title-updated', notify)

  const navigated = Boolean(url)
  if (url) view.webContents.loadURL(url)

  view.setVisible(false)
  mainWindow.contentView.addChildView(view)
  tabs.set(id, { view, navigated })
  if (!options.background) {
    setActiveTab(id)
    if (!navigated) focusAddressBar() // fresh empty tab: start typing immediately
  }
  notify()
  return id
}

function closeTab(id: string): void {
  const entry = tabs.get(id)
  if (!entry || !mainWindow) return
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
  ipcMain.handle(IPC_CHANNELS.TAB_NEW, (_event, url?: string) => createTab(url))
  ipcMain.handle(IPC_CHANNELS.TAB_CLOSE, (_event, tabId: string) => closeTab(tabId))
  ipcMain.handle(IPC_CHANNELS.TAB_ACTIVATE, (_event, tabId: string) => setActiveTab(tabId))
  ipcMain.handle(IPC_CHANNELS.TAB_NAVIGATE, (_event, tabId: string, url: string) => {
    const entry = tabs.get(tabId)
    if (!entry || !isAllowedUrl(url)) return
    entry.navigated = true
    entry.view.webContents.loadURL(url)
    if (tabId === activeTabId) {
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

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // The renderer requests the first tab itself once mounted (via newTab()),
  // rather than main creating one here — avoids a race where a `tab:updated`
  // event could be sent before the renderer's IPC listener is registered.
}

async function cleanupAndExit(): Promise<void> {
  const ses = getInMemorySession()
  await ses.clearStorageData()
  await ses.clearCache()
  await ses.clearAuthCache()
  // defaultSession backs the shell window — clear it too, not just the tab
  // session (security review finding: this was previously left uncleared).
  await session.defaultSession.clearStorageData()
  await session.defaultSession.clearCache()
  await session.defaultSession.clearAuthCache()
  // Hard exit, not app.quit() — app.exit() is immediate and skips will-quit,
  // so all cleanup must be awaited inline before calling it (ADR 0002 / threat-model §3).
  app.exit(0)
}

app.whenReady().then(() => {
  configureSession()
  registerIpcHandlers()
  createWindow()
})

// No tray, no background mode: always quit when all windows close, on every
// platform (overriding macOS's default of staying alive).
app.on('window-all-closed', () => {
  void cleanupAndExit()
})

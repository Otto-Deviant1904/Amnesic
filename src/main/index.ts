import { app, BrowserWindow, WebContentsView, session, ipcMain } from 'electron'
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

let mainWindow: BrowserWindow | null = null
const tabViews = new Map<string, WebContentsView>()
let activeTabId: string | null = null

function getInMemorySession() {
  return session.fromPartition(SESSION_PARTITION, { cache: false })
}

function configureSession(): void {
  const ses = getInMemorySession()
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

const TOOLBAR_HEIGHT = 88 // must match the renderer's tab-strip + address-bar height in CSS

function layoutActiveView(): void {
  if (!mainWindow || !activeTabId) return
  const view = tabViews.get(activeTabId)
  if (!view) return
  const bounds = mainWindow.getContentBounds()
  view.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width: bounds.width,
    height: Math.max(0, bounds.height - TOOLBAR_HEIGHT)
  })
}

function setActiveTab(id: string): void {
  if (!mainWindow) return
  const previous = activeTabId ? tabViews.get(activeTabId) : null
  if (previous) previous.setVisible(false)
  activeTabId = id
  const next = tabViews.get(id)
  if (next) {
    next.setVisible(true)
    layoutActiveView()
  }
}

function sendTabUpdate(id: string, view: WebContentsView): void {
  if (!mainWindow) return
  const wc = view.webContents
  const state: TabState = {
    tabId: id,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward()
  }
  mainWindow.webContents.send(IPC_CHANNELS.TAB_UPDATED, state)
}

function createTab(url: string): string {
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

  const notify = () => sendTabUpdate(id, view)
  view.webContents.on('did-start-loading', notify)
  view.webContents.on('did-stop-loading', notify)
  view.webContents.on('did-navigate', notify)
  view.webContents.on('did-navigate-in-page', notify)
  view.webContents.on('page-title-updated', notify)

  view.webContents.loadURL(url)

  mainWindow.contentView.addChildView(view)
  tabViews.set(id, view)
  setActiveTab(id)
  notify()
  return id
}

function closeTab(id: string): void {
  const view = tabViews.get(id)
  if (!view || !mainWindow) return
  mainWindow.contentView.removeChildView(view)
  view.webContents.close()
  tabViews.delete(id)
  mainWindow.webContents.send(IPC_CHANNELS.TAB_CLOSED, id)
  if (activeTabId === id) {
    const next = tabViews.keys().next().value ?? null
    activeTabId = null
    if (next) setActiveTab(next)
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TAB_NEW, (_event, url?: string) =>
    createTab(url || 'https://example.com')
  )
  ipcMain.handle(IPC_CHANNELS.TAB_CLOSE, (_event, tabId: string) => closeTab(tabId))
  ipcMain.handle(IPC_CHANNELS.TAB_NAVIGATE, (_event, tabId: string, url: string) => {
    tabViews.get(tabId)?.webContents.loadURL(url)
  })
  ipcMain.handle(IPC_CHANNELS.TAB_BACK, (_event, tabId: string) => {
    tabViews.get(tabId)?.webContents.navigationHistory.goBack()
  })
  ipcMain.handle(IPC_CHANNELS.TAB_FORWARD, (_event, tabId: string) => {
    tabViews.get(tabId)?.webContents.navigationHistory.goForward()
  })
  ipcMain.handle(IPC_CHANNELS.TAB_RELOAD, (_event, tabId: string) => {
    tabViews.get(tabId)?.webContents.reload()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('resize', layoutActiveView)

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

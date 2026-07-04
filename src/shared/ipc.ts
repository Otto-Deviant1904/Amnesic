export const IPC_CHANNELS = {
  TAB_NEW: 'tab:new',
  TAB_CLOSE: 'tab:close',
  TAB_ACTIVATE: 'tab:activate',
  TAB_NAVIGATE: 'tab:navigate',
  TAB_BACK: 'tab:back',
  TAB_FORWARD: 'tab:forward',
  TAB_RELOAD: 'tab:reload',
  TAB_STOP: 'tab:stop',
  TAB_REORDER: 'tab:reorder',
  TAB_TOGGLE_MUTE: 'tab:toggle-mute',
  TAB_ZOOM_RESET: 'tab:zoom-reset',
  TAB_UPDATED: 'tab:updated',
  TAB_CLOSED: 'tab:closed',
  TAB_ACTIVATED: 'tab:activated',
  FIND_START: 'find:start',
  FIND_STOP: 'find:stop',
  FIND_RESULT: 'find:result',
  AUTH_REQUEST: 'auth:request',
  AUTH_RESPONSE: 'auth:response',
  AUTH_CANCELLED: 'auth:cancelled',
  SHELL_FOCUS_ADDRESS: 'shell:focus-address',
  SHELL_OPEN_FIND: 'shell:open-find',
  SHELL_CHROME_HEIGHT: 'shell:chrome-height',
  SHELL_NOTICE: 'shell:notice'
} as const

/** A failed main-frame load, rendered as an in-shell error page. */
export interface TabLoadError {
  /** Chromium net error code, e.g. -105. */
  code: number
  /** Chromium's symbolic name, e.g. 'ERR_NAME_NOT_RESOLVED'. */
  description: string
  /** The URL that failed — target of the error page's retry button. */
  url: string
}

export interface TabState {
  tabId: string
  /** Empty string while the tab has never been navigated (start page). */
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** data: URI fetched through the tab session, or null while none is known. */
  favicon: string | null
  audible: boolean
  muted: boolean
  /** Rounded percentage; 100 means default zoom. */
  zoomPercent: number
  error: TabLoadError | null
}

export interface FindResult {
  tabId: string
  matches: number
  activeMatchOrdinal: number
}

/** An HTTP basic-auth (or proxy-auth) challenge awaiting user credentials. */
export interface AuthRequest {
  requestId: string
  host: string
  realm: string
  isProxy: boolean
}

export interface AuthCredentials {
  username: string
  password: string
}

export interface ShellNotice {
  /** download-blocked: transient toast; swap-active: persistent start-page warning. */
  kind: 'download-blocked' | 'swap-active'
  detail: string
}

export interface AmnesicBridge {
  newTab: (url?: string) => Promise<string>
  closeTab: (tabId: string) => Promise<void>
  activateTab: (tabId: string) => Promise<void>
  navigate: (tabId: string, url: string) => Promise<void>
  back: (tabId: string) => Promise<void>
  forward: (tabId: string) => Promise<void>
  reload: (tabId: string) => Promise<void>
  stop: (tabId: string) => Promise<void>
  reorderTabs: (order: string[]) => Promise<void>
  toggleMute: (tabId: string) => Promise<void>
  resetZoom: (tabId: string) => Promise<void>
  findStart: (tabId: string, text: string, forward: boolean, findNext: boolean) => Promise<void>
  findStop: (tabId: string, keepSelection: boolean) => Promise<void>
  respondAuth: (requestId: string, credentials: AuthCredentials | null) => Promise<void>
  setChromeHeight: (px: number) => Promise<void>
  onTabUpdated: (listener: (state: TabState) => void) => () => void
  onTabClosed: (listener: (tabId: string) => void) => () => void
  onTabActivated: (listener: (tabId: string) => void) => () => void
  onFindResult: (listener: (result: FindResult) => void) => () => void
  onAuthRequest: (listener: (request: AuthRequest) => void) => () => void
  onAuthCancelled: (listener: (requestId: string) => void) => () => void
  onFocusAddress: (listener: () => void) => () => void
  onOpenFind: (listener: () => void) => () => void
  onNotice: (listener: (notice: ShellNotice) => void) => () => void
}

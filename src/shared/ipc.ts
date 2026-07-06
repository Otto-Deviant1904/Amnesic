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
  IDENTITY_NEW: 'identity:new',
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
  SHELL_NOTICE: 'shell:notice',
  AUDIT_REQUEST: 'audit:request',
  PROXY_GET_STATUS: 'proxy:get-status',
  PROXY_SET_ENABLED: 'proxy:set-enabled',
  PROXY_SET_CONFIG: 'proxy:set-config',
  DNS_GET_STATUS: 'dns:get-status',
  DNS_SET_PROVIDER: 'dns:set-provider',
  DNS_LIST_PROVIDERS: 'dns:list-providers',
  CONTAINERS_GET_STATUS: 'containers:get-status',
  CONTAINERS_SET_ENABLED: 'containers:set-enabled'
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
  /** download-blocked: transient toast; swap-active: persistent start-page warning;
   *  identity-reset: brief full-window flash confirming a completed New Identity. */
  kind: 'download-blocked' | 'swap-active' | 'identity-reset'
  detail: string
}

/** One row of the self-audit panel (start page). All checks run in the main
 *  process; the shell renderer only ever receives this plain, serializable
 *  result — no new capability crosses the bridge. */
export interface AuditCheck {
  id: string
  label: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
  /** true: verified in this running process right now. false: a guarantee
   *  enforced by build/CI tooling with no reliable Electron 43 runtime
   *  signal — must never be presented as if it were freshly checked. */
  verifiedAtRuntime: boolean
}

export interface AuditReport {
  checks: AuditCheck[]
}

/** Proxy scheme = how the browser talks to the proxy, independent of the
 *  destination's scheme. SOCKS4 is deliberately excluded (ADR 0012): it leaks
 *  every hostname to the local resolver. */
export type ProxyScheme = 'socks5' | 'http' | 'https'

/** Proxy mode (ADR 0007, generalized by ADR 0012). Session-only — never
 *  persisted, always off on a fresh launch, defaulting to the Tor SOCKS5
 *  endpoint (127.0.0.1:9050). */
export interface ProxyStatus {
  enabled: boolean
  scheme: ProxyScheme
  host: string
  port: number
}

export interface ProxyResult {
  ok: boolean
  /** Present only when ok is false — e.g. the scheme-specific probe failed, or
   *  tabs are still open (decision 7's gate). */
  error?: string
  status: ProxyStatus
}

/** DNS-over-HTTPS provider selection (ADR 0010). Session-only — never
 *  persisted, always off (providerId: null) on a fresh launch. `proxyEnabled`
 *  is echoed here so the DNS control can grey itself out without a second
 *  round trip: while any proxy is on, DNS for tab traffic resolves at the
 *  proxy (ADR 0007/0012 — true for socks5, http, and https alike), and this
 *  setting only affects the local, non-proxied resolver path. */
export interface DnsStatus {
  /** null means off — Electron/Chromium's own default ('automatic'), never
   *  a forced plaintext-only mode. */
  providerId: string | null
  proxyEnabled: boolean
}

export interface DnsResult {
  ok: boolean
  /** Present only when ok is false — e.g. the change was rejected because
   *  Tor mode is on. */
  error?: string
  status: DnsStatus
}

/** Renderer-facing provider listing — id/label only; the renderer only
 *  ever needs to display a name and send the id back. The main process
 *  (src/main/dns.ts) is the sole holder of what URL template a given id
 *  maps to. */
export interface DnsProviderOption {
  id: string
  label: string
}

/** Containers mode (ADR 0011): per-tab isolated sessions. Session-only —
 *  never persisted, always off on a fresh launch. Turning it on affects only
 *  tabs opened afterward; existing tabs keep the session they already have. */
export interface ContainersStatus {
  enabled: boolean
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
  newIdentity: () => Promise<void>
  getAuditReport: () => Promise<AuditReport>
  getProxyStatus: () => Promise<ProxyStatus>
  setProxyEnabled: (enabled: boolean) => Promise<ProxyResult>
  setProxyConfig: (scheme: ProxyScheme, host: string, port: number) => Promise<ProxyResult>
  getDnsStatus: () => Promise<DnsStatus>
  setDnsProvider: (providerId: string | null) => Promise<DnsResult>
  listDnsProviders: () => Promise<DnsProviderOption[]>
  getContainersStatus: () => Promise<ContainersStatus>
  setContainersEnabled: (enabled: boolean) => Promise<ContainersStatus>
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

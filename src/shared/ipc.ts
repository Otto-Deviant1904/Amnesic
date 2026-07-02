export const IPC_CHANNELS = {
  TAB_NEW: 'tab:new',
  TAB_CLOSE: 'tab:close',
  TAB_ACTIVATE: 'tab:activate',
  TAB_NAVIGATE: 'tab:navigate',
  TAB_BACK: 'tab:back',
  TAB_FORWARD: 'tab:forward',
  TAB_RELOAD: 'tab:reload',
  TAB_STOP: 'tab:stop',
  TAB_UPDATED: 'tab:updated',
  TAB_CLOSED: 'tab:closed',
  TAB_ACTIVATED: 'tab:activated',
  SHELL_FOCUS_ADDRESS: 'shell:focus-address'
} as const

export interface TabState {
  tabId: string
  /** Empty string while the tab has never been navigated (start page). */
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
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
  onTabUpdated: (listener: (state: TabState) => void) => () => void
  onTabClosed: (listener: (tabId: string) => void) => () => void
  onTabActivated: (listener: (tabId: string) => void) => () => void
  onFocusAddress: (listener: () => void) => () => void
}

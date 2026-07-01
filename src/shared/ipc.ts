export const IPC_CHANNELS = {
  TAB_NEW: 'tab:new',
  TAB_CLOSE: 'tab:close',
  TAB_NAVIGATE: 'tab:navigate',
  TAB_BACK: 'tab:back',
  TAB_FORWARD: 'tab:forward',
  TAB_RELOAD: 'tab:reload',
  TAB_UPDATED: 'tab:updated',
  TAB_CLOSED: 'tab:closed'
} as const

export interface TabState {
  tabId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface AmnesicBridge {
  newTab: (url?: string) => Promise<string>
  closeTab: (tabId: string) => Promise<void>
  navigate: (tabId: string, url: string) => Promise<void>
  back: (tabId: string) => Promise<void>
  forward: (tabId: string) => Promise<void>
  reload: (tabId: string) => Promise<void>
  onTabUpdated: (listener: (state: TabState) => void) => () => void
  onTabClosed: (listener: (tabId: string) => void) => () => void
}

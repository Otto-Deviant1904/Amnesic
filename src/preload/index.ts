import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type AmnesicBridge,
  type AuthRequest,
  type FindResult,
  type ShellNotice,
  type TabState
} from '../shared/ipc'

function subscribe<Args extends unknown[]>(
  channel: string,
  listener: (...args: Args) => void
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, ...args: Args) => listener(...args)
  ipcRenderer.on(channel, handler as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void)
  return () =>
    ipcRenderer.removeListener(
      channel,
      handler as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
    )
}

const bridge: AmnesicBridge = {
  newTab: (url) => ipcRenderer.invoke(IPC_CHANNELS.TAB_NEW, url),
  closeTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_CLOSE, tabId),
  activateTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_ACTIVATE, tabId),
  navigate: (tabId, url) => ipcRenderer.invoke(IPC_CHANNELS.TAB_NAVIGATE, tabId, url),
  back: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_BACK, tabId),
  forward: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_FORWARD, tabId),
  reload: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_RELOAD, tabId),
  stop: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_STOP, tabId),
  reorderTabs: (order) => ipcRenderer.invoke(IPC_CHANNELS.TAB_REORDER, order),
  toggleMute: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_TOGGLE_MUTE, tabId),
  resetZoom: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_ZOOM_RESET, tabId),
  newIdentity: () => ipcRenderer.invoke(IPC_CHANNELS.IDENTITY_NEW),
  getAuditReport: () => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_REQUEST),
  getProxyStatus: () => ipcRenderer.invoke(IPC_CHANNELS.PROXY_GET_STATUS),
  setProxyEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.PROXY_SET_ENABLED, enabled),
  setProxyConfig: (scheme, host, port) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROXY_SET_CONFIG, scheme, host, port),
  getDnsStatus: () => ipcRenderer.invoke(IPC_CHANNELS.DNS_GET_STATUS),
  setDnsProvider: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.DNS_SET_PROVIDER, providerId),
  listDnsProviders: () => ipcRenderer.invoke(IPC_CHANNELS.DNS_LIST_PROVIDERS),
  getContainersStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CONTAINERS_GET_STATUS),
  setContainersEnabled: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTAINERS_SET_ENABLED, enabled),
  findStart: (tabId, text, forward, findNext) =>
    ipcRenderer.invoke(IPC_CHANNELS.FIND_START, tabId, text, forward, findNext),
  findStop: (tabId, keepSelection) =>
    ipcRenderer.invoke(IPC_CHANNELS.FIND_STOP, tabId, keepSelection),
  respondAuth: (requestId, credentials) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTH_RESPONSE, requestId, credentials),
  setChromeHeight: (px) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_CHROME_HEIGHT, px),
  onTabUpdated: (listener) => subscribe<[TabState]>(IPC_CHANNELS.TAB_UPDATED, listener),
  onTabClosed: (listener) => subscribe<[string]>(IPC_CHANNELS.TAB_CLOSED, listener),
  onTabActivated: (listener) => subscribe<[string]>(IPC_CHANNELS.TAB_ACTIVATED, listener),
  onFindResult: (listener) => subscribe<[FindResult]>(IPC_CHANNELS.FIND_RESULT, listener),
  onAuthRequest: (listener) => subscribe<[AuthRequest]>(IPC_CHANNELS.AUTH_REQUEST, listener),
  onAuthCancelled: (listener) => subscribe<[string]>(IPC_CHANNELS.AUTH_CANCELLED, listener),
  onFocusAddress: (listener) => subscribe<[]>(IPC_CHANNELS.SHELL_FOCUS_ADDRESS, listener),
  onOpenFind: (listener) => subscribe<[]>(IPC_CHANNELS.SHELL_OPEN_FIND, listener),
  onNotice: (listener) => subscribe<[ShellNotice]>(IPC_CHANNELS.SHELL_NOTICE, listener)
}

contextBridge.exposeInMainWorld('amnesic', bridge)

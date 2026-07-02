import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type AmnesicBridge, type TabState } from '../shared/ipc'

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
  onTabUpdated: (listener) => subscribe<[TabState]>(IPC_CHANNELS.TAB_UPDATED, listener),
  onTabClosed: (listener) => subscribe<[string]>(IPC_CHANNELS.TAB_CLOSED, listener),
  onTabActivated: (listener) => subscribe<[string]>(IPC_CHANNELS.TAB_ACTIVATED, listener),
  onFocusAddress: (listener) => subscribe<[]>(IPC_CHANNELS.SHELL_FOCUS_ADDRESS, listener)
}

contextBridge.exposeInMainWorld('amnesic', bridge)

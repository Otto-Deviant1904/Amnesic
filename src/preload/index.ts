import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type AmnesicBridge, type TabState } from '../shared/ipc'

const bridge: AmnesicBridge = {
  newTab: (url) => ipcRenderer.invoke(IPC_CHANNELS.TAB_NEW, url),
  closeTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_CLOSE, tabId),
  navigate: (tabId, url) => ipcRenderer.invoke(IPC_CHANNELS.TAB_NAVIGATE, tabId, url),
  back: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_BACK, tabId),
  forward: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_FORWARD, tabId),
  reload: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TAB_RELOAD, tabId),
  onTabUpdated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: TabState) => listener(state)
    ipcRenderer.on(IPC_CHANNELS.TAB_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TAB_UPDATED, handler)
  },
  onTabClosed: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, tabId: string) => listener(tabId)
    ipcRenderer.on(IPC_CHANNELS.TAB_CLOSED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TAB_CLOSED, handler)
  }
}

contextBridge.exposeInMainWorld('amnesic', bridge)

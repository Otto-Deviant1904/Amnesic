import { create } from 'zustand'
import type { TabState } from '../../../shared/ipc'

interface TabsStore {
  tabs: Record<string, TabState>
  order: string[]
  activeTabId: string | null
  upsertTab: (state: TabState) => void
  removeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  /** Reorder tabs (drag & drop). Ignores lists that aren't a permutation of the current order. */
  setOrder: (order: string[]) => void
}

export const useTabsStore = create<TabsStore>((set) => ({
  tabs: {},
  order: [],
  activeTabId: null,
  upsertTab: (state) =>
    set((store) => {
      const isNew = !(state.tabId in store.tabs)
      return {
        tabs: { ...store.tabs, [state.tabId]: state },
        order: isNew ? [...store.order, state.tabId] : store.order,
        activeTabId: store.activeTabId ?? state.tabId
      }
    }),
  removeTab: (tabId) =>
    set((store) => {
      const { [tabId]: _removed, ...rest } = store.tabs
      const order = store.order.filter((id) => id !== tabId)
      const activeTabId = store.activeTabId === tabId ? (order[0] ?? null) : store.activeTabId
      return { tabs: rest, order, activeTabId }
    }),
  setActiveTab: (tabId) => set({ activeTabId: tabId }),
  setOrder: (order) =>
    set((store) => {
      const valid =
        new Set(order).size === store.order.length && order.every((id) => id in store.tabs)
      return valid ? { order } : {}
    })
}))

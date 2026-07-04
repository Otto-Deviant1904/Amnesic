import { describe, it, expect, beforeEach } from 'vitest'
import { useTabsStore } from '../../src/renderer/src/store/tabs'
import type { TabState } from '../../src/shared/ipc'

function makeTab(overrides: Partial<TabState> = {}): TabState {
  return {
    tabId: 'tab-1',
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    favicon: null,
    audible: false,
    muted: false,
    zoomPercent: 100,
    error: null,
    ...overrides
  }
}

describe('useTabsStore', () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: {}, order: [], activeTabId: null })
  })

  it('adds a new tab and makes it active', () => {
    useTabsStore.getState().upsertTab(makeTab())
    const state = useTabsStore.getState()
    expect(state.order).toEqual(['tab-1'])
    expect(state.activeTabId).toBe('tab-1')
    expect(state.tabs['tab-1']?.title).toBe('Example')
  })

  it('updates an existing tab without duplicating it in order', () => {
    useTabsStore.getState().upsertTab(makeTab())
    useTabsStore.getState().upsertTab(makeTab({ title: 'Updated', loading: true }))
    const state = useTabsStore.getState()
    expect(state.order).toEqual(['tab-1'])
    expect(state.tabs['tab-1']?.title).toBe('Updated')
    expect(state.tabs['tab-1']?.loading).toBe(true)
  })

  it('reorders tabs when given a permutation of the current order', () => {
    useTabsStore.getState().upsertTab(makeTab({ tabId: 'tab-1' }))
    useTabsStore.getState().upsertTab(makeTab({ tabId: 'tab-2' }))
    useTabsStore.getState().upsertTab(makeTab({ tabId: 'tab-3' }))
    useTabsStore.getState().setOrder(['tab-3', 'tab-1', 'tab-2'])
    expect(useTabsStore.getState().order).toEqual(['tab-3', 'tab-1', 'tab-2'])
  })

  it('rejects orders with unknown, missing, or duplicate ids', () => {
    useTabsStore.getState().upsertTab(makeTab({ tabId: 'tab-1' }))
    useTabsStore.getState().upsertTab(makeTab({ tabId: 'tab-2' }))
    useTabsStore.getState().setOrder(['tab-1', 'tab-nope'])
    useTabsStore.getState().setOrder(['tab-1'])
    useTabsStore.getState().setOrder(['tab-1', 'tab-1'])
    expect(useTabsStore.getState().order).toEqual(['tab-1', 'tab-2'])
  })

  it('removes a tab and falls back active selection to the next remaining tab', () => {
    useTabsStore.getState().upsertTab(makeTab({ tabId: 'tab-1' }))
    useTabsStore.getState().upsertTab(makeTab({ tabId: 'tab-2' }))
    useTabsStore.getState().setActiveTab('tab-1')
    useTabsStore.getState().removeTab('tab-1')
    const state = useTabsStore.getState()
    expect(state.tabs['tab-1']).toBeUndefined()
    expect(state.order).toEqual(['tab-2'])
    expect(state.activeTabId).toBe('tab-2')
  })
})

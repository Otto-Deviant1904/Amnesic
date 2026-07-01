import { useEffect, useRef, useState } from 'react'
import { useTabsStore } from './store/tabs'

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  if (/^localhost(:\d+)?/i.test(trimmed) || /\.[a-z]{2,}$/i.test(trimmed.split('/')[0] ?? '')) {
    return `https://${trimmed}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

export default function App() {
  const { tabs, order, activeTabId, upsertTab, removeTab, setActiveTab } = useTabsStore()
  const [addressInput, setAddressInput] = useState('')
  const hasRequestedInitialTab = useRef(false)

  useEffect(() => {
    const unsubUpdated = window.amnesic.onTabUpdated(upsertTab)
    const unsubClosed = window.amnesic.onTabClosed(removeTab)
    return () => {
      unsubUpdated()
      unsubClosed()
    }
  }, [upsertTab, removeTab])

  useEffect(() => {
    if (hasRequestedInitialTab.current) return
    hasRequestedInitialTab.current = true
    void window.amnesic.newTab()
  }, [])

  const activeTab = activeTabId ? tabs[activeTabId] : null

  // Sync the address bar to the newly-active tab's URL only when the active
  // tab actually changes (switching tabs) — not on every navigation event
  // for the current tab, which would overwrite whatever the user is typing.
  // Adjusting state during render (rather than in a useEffect) is the
  // React-documented pattern for this: https://react.dev/learn/you-might-not-need-an-effect
  const [syncedTabId, setSyncedTabId] = useState<string | null>(null)
  if (activeTabId !== syncedTabId) {
    setSyncedTabId(activeTabId)
    setAddressInput(activeTab?.url ?? '')
  }

  const handleNavigate = (event: React.FormEvent) => {
    event.preventDefault()
    if (!activeTabId || !addressInput) return
    void window.amnesic.navigate(activeTabId, normalizeUrl(addressInput))
  }

  return (
    <div className="app">
      <div className="tab-strip">
        {order.map((id) => {
          const tab = tabs[id]
          if (!tab) return null
          return (
            <div
              key={id}
              className={`tab${id === activeTabId ? ' tab--active' : ''}`}
              onClick={() => setActiveTab(id)}
            >
              <span className="tab__title">
                {tab.loading ? 'Loading…' : tab.title || 'New Tab'}
              </span>
              <button
                className="tab__close"
                onClick={(event) => {
                  event.stopPropagation()
                  void window.amnesic.closeTab(id)
                }}
                aria-label="Close tab"
              >
                ×
              </button>
            </div>
          )
        })}
        <button
          className="tab-strip__new"
          onClick={() => void window.amnesic.newTab()}
          aria-label="New tab"
        >
          +
        </button>
      </div>
      <form className="address-bar" onSubmit={handleNavigate}>
        <button
          type="button"
          disabled={!activeTab?.canGoBack}
          onClick={() => activeTabId && void window.amnesic.back(activeTabId)}
          aria-label="Back"
        >
          ←
        </button>
        <button
          type="button"
          disabled={!activeTab?.canGoForward}
          onClick={() => activeTabId && void window.amnesic.forward(activeTabId)}
          aria-label="Forward"
        >
          →
        </button>
        <button
          type="button"
          onClick={() => activeTabId && void window.amnesic.reload(activeTabId)}
          aria-label="Reload"
        >
          ⟳
        </button>
        <input
          className="address-bar__input"
          value={addressInput}
          onChange={(event) => setAddressInput(event.target.value)}
          placeholder="Search or enter address"
        />
      </form>
    </div>
  )
}

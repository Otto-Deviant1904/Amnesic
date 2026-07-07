import { useEffect, useRef, useState } from 'react'
import type { AuthCredentials, AuthRequest } from '../../shared/ipc'
import AuthDialog from './components/AuthDialog'
import BlockingControl from './components/BlockingControl'
import ContainersControl from './components/ContainersControl'
import DnsControl from './components/DnsControl'
import ErrorPage from './components/ErrorPage'
import FindBar from './components/FindBar'
import ProxyControl from './components/ProxyControl'
import SelfAuditPanel from './components/SelfAuditPanel'
import {
  BackIcon,
  CloseIcon,
  ForwardIcon,
  LockIcon,
  MaskIcon,
  PlusIcon,
  ReloadIcon,
  SpeakerIcon,
  SpeakerMutedIcon
} from './icons'
import { useTabsStore } from './store/tabs'

// Chrome heights in px; the base value must match the CSS (tab strip +
// nav bar) and TOOLBAR_HEIGHT in src/main/index.ts. Main is told the current
// value via setChromeHeight so the page view shrinks when the find bar opens.
const CHROME_BASE_HEIGHT = 88
const FIND_BAR_HEIGHT = 35

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  const host = trimmed.split('/')[0] ?? ''
  // localhost is almost always a plain-http dev server; everything else
  // that looks like a hostname defaults to https.
  if (/^localhost(:\d+)?$/i.test(host)) return `http://${trimmed}`
  if (
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host) ||
    (!/\s/.test(trimmed) && /\.[a-z]{2,}$/i.test(host))
  ) {
    return `https://${trimmed}`
  }
  // DuckDuckGo, not Google — the default search shouldn't undercut the
  // no-trace posture of everything else in this app.
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`
}

function cycle(ids: string[], active: string | null, delta: number): void {
  if (ids.length < 2 || !active) return
  const index = ids.indexOf(active)
  const next = ids[(index + delta + ids.length) % ids.length]
  if (next) void window.amnesic.activateTab(next)
}

function tabLabel(title: string, url: string): string {
  if (title) return title
  if (!url) return 'New tab'
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export default function App() {
  const { tabs, order, activeTabId, upsertTab, removeTab, setActiveTab, setOrder } = useTabsStore()
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [authQueue, setAuthQueue] = useState<AuthRequest[]>([])
  const [blockedDownload, setBlockedDownload] = useState<string | null>(null)
  const [swapWarning, setSwapWarning] = useState<string | null>(null)
  const [identityFlash, setIdentityFlash] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeTabRef = useRef<HTMLDivElement | null>(null)
  const dragTabId = useRef<string | null>(null)
  const hasRequestedInitialTab = useRef(false)
  const downloadToastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const identityFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const unsubscribers = [
      window.amnesic.onTabUpdated(upsertTab),
      window.amnesic.onTabClosed(removeTab),
      window.amnesic.onTabActivated(setActiveTab),
      window.amnesic.onFocusAddress(() => inputRef.current?.focus()),
      window.amnesic.onOpenFind(() => setFindOpen(true)),
      window.amnesic.onAuthRequest((request) => setAuthQueue((queue) => [...queue, request])),
      window.amnesic.onAuthCancelled((requestId) =>
        setAuthQueue((queue) => queue.filter((request) => request.requestId !== requestId))
      ),
      window.amnesic.onNotice((notice) => {
        if (notice.kind === 'download-blocked') {
          setBlockedDownload(notice.detail)
          clearTimeout(downloadToastTimer.current)
          downloadToastTimer.current = setTimeout(() => setBlockedDownload(null), 5000)
        } else if (notice.kind === 'swap-active') {
          setSwapWarning(notice.detail)
        } else if (notice.kind === 'identity-reset') {
          setIdentityFlash(true)
          clearTimeout(identityFlashTimer.current)
          identityFlashTimer.current = setTimeout(() => setIdentityFlash(false), 900)
        }
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [upsertTab, removeTab, setActiveTab])

  useEffect(() => {
    if (hasRequestedInitialTab.current) return
    hasRequestedInitialTab.current = true
    void window.amnesic.newTab()
  }, [])

  // The page's WebContentsView is laid out by main directly below the chrome,
  // so main must know when the find bar changes the chrome's height.
  useEffect(() => {
    void window.amnesic.setChromeHeight(
      findOpen ? CHROME_BASE_HEIGHT + FIND_BAR_HEIGHT : CHROME_BASE_HEIGHT
    )
  }, [findOpen])

  // Find state is per-page — switching tabs closes the bar (FindBar's unmount
  // cleanup stops the search on the tab it belonged to).
  const previousTabId = useRef<string | null>(null)
  useEffect(() => {
    if (previousTabId.current && previousTabId.current !== activeTabId) setFindOpen(false)
    previousTabId.current = activeTabId
  }, [activeTabId])

  // Keep the active tab visible when the strip overflows.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeTabId])

  // Browser-chrome shortcuts for when keyboard focus is in the shell (tab
  // strip / address bar). The main process handles the same combos via
  // before-input-event when a page's WebContentsView has focus, and calls
  // preventDefault there, so the two handlers never both fire for one keypress.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { order: ids, activeTabId: active } = useTabsStore.getState()
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      let handled = true

      if (mod && !event.altKey && key === 'tab') {
        cycle(ids, active, event.shiftKey ? -1 : 1)
      } else if (mod && !event.altKey && !event.shiftKey) {
        if (key === 't') void window.amnesic.newTab()
        else if (key === 'w' && active) void window.amnesic.closeTab(active)
        else if (key === 'l') inputRef.current?.focus()
        else if (key === 'f' && active) setFindOpen(true)
        else if (key === 'r' && active) void window.amnesic.reload(active)
        else if (key === 'pagedown') cycle(ids, active, 1)
        else if (key === 'pageup') cycle(ids, active, -1)
        else if (key >= '1' && key <= '9') {
          const id = key === '9' ? ids[ids.length - 1] : ids[Number(key) - 1]
          if (id) void window.amnesic.activateTab(id)
        } else handled = false
      } else if (event.altKey && !mod && key === 'arrowleft' && active) {
        void window.amnesic.back(active)
      } else if (event.altKey && !mod && key === 'arrowright' && active) {
        void window.amnesic.forward(active)
      } else handled = false

      if (handled) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const activeTab = activeTabId ? tabs[activeTabId] : null
  // On a failed load the address bar and error page both talk about the URL
  // that failed, not whatever was committed before it.
  const activeUrl = activeTab?.error ? activeTab.error.url : (activeTab?.url ?? '')

  // Reset the draft when the active tab changes so the address bar always
  // reflects the tab being looked at. Adjusting state during render (rather
  // than in a useEffect) is the React-documented pattern for this:
  // https://react.dev/learn/you-might-not-need-an-effect
  const [syncedTabId, setSyncedTabId] = useState<string | null>(null)
  if (activeTabId !== syncedTabId) {
    setSyncedTabId(activeTabId)
    setDraft(activeUrl)
  }

  // While the user is typing, show their draft; otherwise mirror the tab's
  // live URL so navigations inside the page keep the address bar honest.
  const displayValue = editing ? draft : activeUrl
  const scheme = activeUrl.startsWith('https://')
    ? 'https'
    : activeUrl.startsWith('http://')
      ? 'http'
      : null

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!activeTabId || !draft.trim()) return
    void window.amnesic.navigate(activeTabId, normalizeUrl(draft))
    setEditing(false)
    inputRef.current?.blur()
  }

  const handleTabDrop = (targetId: string) => {
    const sourceId = dragTabId.current
    if (!sourceId || sourceId === targetId) return
    const current = useTabsStore.getState().order
    const from = current.indexOf(sourceId)
    const to = current.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = [...current]
    next.splice(from, 1)
    next.splice(to, 0, sourceId)
    setOrder(next)
    void window.amnesic.reorderTabs(next)
  }

  const respondAuth = (credentials: AuthCredentials | null) => {
    const request = authQueue[0]
    if (!request) return
    void window.amnesic.respondAuth(request.requestId, credentials)
    setAuthQueue((queue) => queue.slice(1))
  }

  return (
    <div className="app">
      {identityFlash && (
        <div className="identity-flash" role="status">
          <MaskIcon size={22} />
          <span>New identity — session reset</span>
        </div>
      )}
      <div className="chrome">
        <div className="tab-strip" role="tablist">
          {order.map((id) => {
            const tab = tabs[id]
            if (!tab) return null
            const isActive = id === activeTabId
            return (
              <div
                key={id}
                ref={isActive ? activeTabRef : undefined}
                role="tab"
                aria-selected={isActive}
                className={`tab${isActive ? ' tab--active' : ''}`}
                title={tab.url || undefined}
                draggable
                onDragStart={(event) => {
                  dragTabId.current = id
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  handleTabDrop(id)
                }}
                onDragEnd={() => {
                  dragTabId.current = null
                }}
                onClick={() => void window.amnesic.activateTab(id)}
                onAuxClick={(event) => {
                  if (event.button === 1) void window.amnesic.closeTab(id)
                }}
              >
                {tab.loading ? (
                  <span className="tab__spinner" />
                ) : tab.favicon ? (
                  <img className="tab__favicon" src={tab.favicon} alt="" draggable={false} />
                ) : null}
                {(tab.audible || tab.muted) && (
                  <button
                    className={`tab__audio${tab.muted ? ' tab__audio--muted' : ''}`}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation()
                      void window.amnesic.toggleMute(id)
                    }}
                    aria-label={tab.muted ? 'Unmute tab' : 'Mute tab'}
                    title={tab.muted ? 'Unmute tab' : 'Mute tab'}
                  >
                    {tab.muted ? <SpeakerMutedIcon size={11} /> : <SpeakerIcon size={11} />}
                  </button>
                )}
                <span className="tab__title">{tabLabel(tab.title, tab.url)}</span>
                <button
                  className="tab__close"
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation()
                    void window.amnesic.closeTab(id)
                  }}
                  aria-label="Close tab"
                >
                  <CloseIcon size={11} />
                </button>
              </div>
            )
          })}
          <button
            className="tab-strip__new"
            onClick={() => void window.amnesic.newTab()}
            aria-label="New tab"
            title="New tab (Ctrl+T)"
          >
            <PlusIcon size={13} />
          </button>
        </div>

        <form className="nav-bar" onSubmit={handleSubmit}>
          <button
            type="button"
            className="nav-bar__button"
            disabled={!activeTab?.canGoBack}
            onClick={() => activeTabId && void window.amnesic.back(activeTabId)}
            aria-label="Back"
            title="Back (Alt+Left)"
          >
            <BackIcon />
          </button>
          <button
            type="button"
            className="nav-bar__button"
            disabled={!activeTab?.canGoForward}
            onClick={() => activeTabId && void window.amnesic.forward(activeTabId)}
            aria-label="Forward"
            title="Forward (Alt+Right)"
          >
            <ForwardIcon />
          </button>
          <button
            type="button"
            className="nav-bar__button"
            disabled={!activeUrl}
            onClick={() => {
              if (!activeTabId) return
              void (activeTab?.loading
                ? window.amnesic.stop(activeTabId)
                : window.amnesic.reload(activeTabId))
            }}
            aria-label={activeTab?.loading ? 'Stop' : 'Reload'}
            title={activeTab?.loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)'}
          >
            {activeTab?.loading ? <CloseIcon size={13} /> : <ReloadIcon size={14} />}
          </button>
          <button
            type="button"
            className="nav-bar__button"
            onClick={() => void window.amnesic.newIdentity()}
            aria-label="New identity"
            title="New identity — close all tabs and start a fresh session (Ctrl+Shift+N)"
          >
            <MaskIcon size={14} />
          </button>
          <ProxyControl />
          <DnsControl />
          <ContainersControl />
          <BlockingControl />

          <div className="address-field">
            {!editing && scheme === 'https' && (
              <span className="address-field__badge" title="Connection is encrypted (HTTPS)">
                <LockIcon size={12} />
              </span>
            )}
            {!editing && scheme === 'http' && (
              <span
                className="address-field__badge address-field__badge--insecure"
                title="Connection is not encrypted"
              >
                not secure
              </span>
            )}
            <input
              ref={inputRef}
              className="address-bar__input"
              value={displayValue}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => {
                setEditing(true)
                setDraft(activeUrl)
                event.target.select()
              }}
              onBlur={() => setEditing(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setDraft(activeUrl)
                  setEditing(false)
                  event.currentTarget.blur()
                }
              }}
              placeholder="Search or type a URL"
            />
            {!editing && activeTab && activeTab.zoomPercent !== 100 && (
              <button
                type="button"
                className="zoom-chip"
                onClick={() => activeTabId && void window.amnesic.resetZoom(activeTabId)}
                title="Reset zoom (Ctrl+0)"
              >
                {activeTab.zoomPercent}%
              </button>
            )}
          </div>

          {blockedDownload && (
            <span className="download-notice" title={blockedDownload}>
              download blocked · {blockedDownload}
            </span>
          )}
        </form>

        {findOpen && activeTabId && (
          <FindBar key={activeTabId} tabId={activeTabId} onClose={() => setFindOpen(false)} />
        )}

        <div className={`progress${activeTab?.loading ? ' progress--active' : ''}`} />
      </div>

      <div className="page-area">
        {activeTab?.error ? (
          <ErrorPage
            error={activeTab.error}
            onRetry={() => {
              if (activeTabId && activeTab.error) {
                void window.amnesic.navigate(activeTabId, activeTab.error.url)
              }
            }}
          />
        ) : (
          !activeUrl && (
            <div className="start-page">
              <div className="start-page__mark">amnesic</div>
              <p className="start-page__tagline">
                Nothing is written to disk. Close the window and this session never happened.
              </p>
              <div className="start-page__hints">
                <span>
                  <kbd>Ctrl</kbd>
                  <kbd>T</kbd> new tab
                </span>
                <span>
                  <kbd>Ctrl</kbd>
                  <kbd>L</kbd> address
                </span>
                <span>
                  <kbd>Ctrl</kbd>
                  <kbd>W</kbd> close
                </span>
              </div>

              {swapWarning && (
                <div className="swap-warning" role="note">
                  <span>
                    Disk-backed swap is active ({swapWarning}). Under memory pressure the OS can
                    write this session&apos;s memory to disk — use encrypted swap or disable swap
                    for the full guarantee. See docs/threat-model.md.
                  </span>
                  <button
                    className="swap-warning__dismiss"
                    onClick={() => setSwapWarning(null)}
                    aria-label="Dismiss warning"
                  >
                    <CloseIcon size={11} />
                  </button>
                </div>
              )}

              <SelfAuditPanel />
            </div>
          )
        )}

        {authQueue[0] && (
          <AuthDialog key={authQueue[0].requestId} request={authQueue[0]} onSubmit={respondAuth} />
        )}
      </div>
    </div>
  )
}

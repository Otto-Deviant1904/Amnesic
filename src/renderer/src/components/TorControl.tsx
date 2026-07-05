import { useEffect, useRef, useState } from 'react'
import type { TorStatus } from '../../../shared/ipc'
import { useTabsStore } from '../store/tabs'

export default function TorControl() {
  // "No tabs open" (ADR 0007 decision 7) means no tab has navigated
  // anywhere yet — this app always has at least one tab (closing the last
  // one quits), so gating on tab *count* would make the toggle permanently
  // unusable. A tab still on the start page has no content and nothing in
  // flight, so it's harmless to change the proxy under it.
  const hasNavigatedTab = useTabsStore((store) =>
    Object.values(store.tabs).some((t) => t.url !== '')
  )
  const [status, setStatus] = useState<TorStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hostDraft, setHostDraft] = useState('')
  const [portDraft, setPortDraft] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.amnesic.getTorStatus().then((s) => {
      setStatus(s)
      setHostDraft(s.host)
      setPortDraft(String(s.port))
    })
  }, [])

  // Click-outside closes the popover, like a native menu would.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const canChange = !hasNavigatedTab

  const handleToggle = () => {
    if (!status || pending || !canChange) return
    setPending(true)
    setError(null)
    void window.amnesic
      .setTorEnabled(!status.enabled)
      .then((result) => {
        setStatus(result.status)
        if (!result.ok && result.error) setError(result.error)
      })
      .finally(() => setPending(false))
  }

  const handleSaveConfig = () => {
    const port = Number(portDraft)
    setPending(true)
    setError(null)
    void window.amnesic
      .setTorConfig(hostDraft.trim(), port)
      .then((result) => {
        setStatus(result.status)
        if (!result.ok && result.error) setError(result.error)
      })
      .finally(() => setPending(false))
  }

  if (!status) return null

  return (
    <div className="tor-control" ref={rootRef}>
      <button
        type="button"
        className={`tor-control__chip${status.enabled ? ' tor-control__chip--on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={status.enabled ? 'Tor is on' : 'Tor is off'}
        title={status.enabled ? `Tor is on (${status.host}:${status.port})` : 'Tor is off'}
      >
        Tor: {status.enabled ? 'On' : 'Off'}
      </button>

      {open && (
        <div className="tor-control__popover" role="dialog" aria-label="Tor settings">
          <div className="tor-control__row">
            <span>Status</span>
            <strong>{pending ? 'Working…' : status.enabled ? 'Connected' : 'Off'}</strong>
          </div>

          {!canChange && (
            <p className="tor-control__hint">
              Close every tab that has loaded a page to change Tor mode — a proxy change while a
              page is open could leave it on the old route.
            </p>
          )}

          {/* A plain div, not a <form> — this popover already lives inside the
              shell's own nav-bar <form> (the address bar), and a nested form
              is invalid HTML that this app's build does not reliably deliver
              submit events through. Every other control here is already a
              plain button + onClick; this matches that pattern instead of
              introducing the only form-based control in the app. */}
          <div className="tor-control__form">
            <label className="tor-control__field">
              Host
              <input
                value={hostDraft}
                disabled={status.enabled || pending}
                onChange={(event) => setHostDraft(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="tor-control__field">
              Port
              <input
                value={portDraft}
                disabled={status.enabled || pending}
                onChange={(event) => setPortDraft(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
              />
            </label>
            {!status.enabled && (
              <button
                type="button"
                className="tor-control__save"
                disabled={pending}
                onClick={handleSaveConfig}
              >
                Save
              </button>
            )}
          </div>

          {error && <p className="tor-control__error">{error}</p>}

          <button
            type="button"
            className="tor-control__toggle"
            onClick={handleToggle}
            disabled={!canChange || pending}
          >
            {status.enabled ? 'Disable Tor' : 'Enable Tor'}
          </button>

          <p className="tor-control__note">
            Bring your own Tor — this connects to a SOCKS5 proxy already running on your machine
            (Tor Browser, the system <code>tor</code> service, or your own <code>tor</code>
            process). Nothing here is saved between sessions.
          </p>
        </div>
      )}
    </div>
  )
}

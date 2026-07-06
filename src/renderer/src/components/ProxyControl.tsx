import { useEffect, useRef, useState } from 'react'
import type { ProxyScheme, ProxyStatus } from '../../../shared/ipc'
import { useTabsStore } from '../store/tabs'

// The scheme choices, Tor first as the flagship default. SOCKS4 is absent by
// design (ADR 0012): it has no domain-name address type and would leak every
// hostname to the local resolver.
const SCHEME_OPTIONS: { value: ProxyScheme; label: string }[] = [
  { value: 'socks5', label: 'Tor / SOCKS5' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' }
]

// Chip/button wording keeps Tor as the recognizable flagship for the SOCKS5
// default, while naming the other schemes honestly when selected.
function chipLabel(scheme: ProxyScheme): string {
  return scheme === 'socks5' ? 'Tor' : scheme === 'http' ? 'HTTP' : 'HTTPS'
}

export default function ProxyControl() {
  // "No tabs open" (ADR 0007 decision 7) means no tab has navigated
  // anywhere yet — this app always has at least one tab (closing the last
  // one quits), so gating on tab *count* would make the toggle permanently
  // unusable. A tab still on the start page has no content and nothing in
  // flight, so it's harmless to change the proxy under it.
  const hasNavigatedTab = useTabsStore((store) =>
    Object.values(store.tabs).some((t) => t.url !== '')
  )
  const [status, setStatus] = useState<ProxyStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [schemeDraft, setSchemeDraft] = useState<ProxyScheme>('socks5')
  const [hostDraft, setHostDraft] = useState('')
  const [portDraft, setPortDraft] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.amnesic.getProxyStatus().then((s) => {
      setStatus(s)
      setSchemeDraft(s.scheme)
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
      .setProxyEnabled(!status.enabled)
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
      .setProxyConfig(schemeDraft, hostDraft.trim(), port)
      .then((result) => {
        setStatus(result.status)
        if (!result.ok && result.error) setError(result.error)
      })
      .finally(() => setPending(false))
  }

  if (!status) return null

  const label = chipLabel(status.scheme)
  const isTorDefault = status.scheme === 'socks5'

  return (
    <div className="proxy-control" ref={rootRef}>
      <button
        type="button"
        className={`proxy-control__chip${status.enabled ? ' proxy-control__chip--on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={status.enabled ? `${label} proxy is on` : `${label} proxy is off`}
        title={
          status.enabled
            ? `${label} proxy is on (${status.scheme}://${status.host}:${status.port})`
            : `${label} proxy is off`
        }
      >
        {label}: {status.enabled ? 'On' : 'Off'}
      </button>

      {open && (
        <div className="proxy-control__popover" role="dialog" aria-label="Proxy settings">
          <div className="proxy-control__row">
            <span>Status</span>
            <strong>{pending ? 'Working…' : status.enabled ? 'Connected' : 'Off'}</strong>
          </div>

          {!canChange && (
            <p className="proxy-control__hint">
              Close every tab that has loaded a page to change proxy mode — a proxy change while a
              page is open could leave it on the old route.
            </p>
          )}

          {/* Scheme picker. Tor (SOCKS5) is the one-click default; HTTP/HTTPS
              are for a VPN or other provider's proxy. Disabled while the proxy
              is on (config edits require disabling first, like host/port). */}
          <div className="proxy-control__schemes" role="group" aria-label="Proxy scheme">
            {SCHEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`proxy-control__scheme${schemeDraft === option.value ? ' proxy-control__scheme--active' : ''}`}
                disabled={status.enabled || pending}
                onClick={() => setSchemeDraft(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {/* A plain div, not a <form> — this popover already lives inside the
              shell's own nav-bar <form> (the address bar), and a nested form
              is invalid HTML that this app's build does not reliably deliver
              submit events through. Every other control here is already a
              plain button + onClick; this matches that pattern instead of
              introducing the only form-based control in the app. */}
          <div className="proxy-control__form">
            <label className="proxy-control__field">
              Host
              <input
                value={hostDraft}
                disabled={status.enabled || pending}
                onChange={(event) => setHostDraft(event.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="proxy-control__field">
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
                className="proxy-control__save"
                disabled={pending}
                onClick={handleSaveConfig}
              >
                Save
              </button>
            )}
          </div>

          {error && <p className="proxy-control__error">{error}</p>}

          <button
            type="button"
            className="proxy-control__toggle"
            onClick={handleToggle}
            disabled={!canChange || pending}
          >
            {status.enabled ? `Disable ${label}` : `Enable ${label}`}
          </button>

          {isTorDefault ? (
            <p className="proxy-control__note">
              Bring your own Tor — this connects to a SOCKS5 proxy already running on your machine
              (Tor Browser, the system <code>tor</code> service, or your own <code>tor</code>{' '}
              process; <code>127.0.0.1:9050</code> is the default). Switch the scheme to HTTP or
              HTTPS to point the browser at a VPN or other provider&rsquo;s proxy instead.
            </p>
          ) : (
            <p className="proxy-control__note">
              Point the browser at a {label} proxy a VPN or provider already runs. DNS resolves at
              the proxy (no local leak), but you are trusting that one operator, who sees your real
              IP and can correlate your traffic — this is transport privacy, <strong>not</strong>{' '}
              anonymity like Tor&rsquo;s relay model. Switch back to Tor / SOCKS5 for that.
            </p>
          )}

          <p className="proxy-control__note proxy-control__note--faint">
            Nothing here is saved between sessions.
          </p>
        </div>
      )}
    </div>
  )
}

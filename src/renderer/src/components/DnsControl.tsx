import { useEffect, useRef, useState } from 'react'
import type { DnsProviderOption, DnsStatus } from '../../../shared/ipc'

export default function DnsControl() {
  const [status, setStatus] = useState<DnsStatus | null>(null)
  const [providers, setProviders] = useState<DnsProviderOption[]>([])
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.amnesic.getDnsStatus().then(setStatus)
    void window.amnesic.listDnsProviders().then(setProviders)
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

  // Refetch on open, not just on mount — Tor mode (a separate control) can
  // toggle while this popover has never been opened, and torEnabled here
  // must reflect that live, not a stale snapshot from app start.
  const handleOpen = () => {
    void window.amnesic.getDnsStatus().then(setStatus)
    setOpen((v) => !v)
  }

  // DNS for tab traffic resolves through the SOCKS5 proxy while Tor is on
  // (ADR 0007 decision 3) — this setting only governs the local, non-
  // proxied resolver path, so changing it has no visible effect on proxied
  // requests. Greyed out here rather than silently overridden, so the UI
  // never implies a guarantee this setting isn't providing right now.
  const canChange = !!status && !status.torEnabled

  const handleSelect = (providerId: string | null) => {
    if (!status || pending || !canChange) return
    if (providerId === status.providerId) return
    setPending(true)
    setError(null)
    void window.amnesic
      .setDnsProvider(providerId)
      .then((result) => {
        setStatus(result.status)
        if (!result.ok && result.error) setError(result.error)
      })
      .finally(() => setPending(false))
  }

  if (!status) return null

  const activeLabel = status.providerId
    ? (providers.find((p) => p.id === status.providerId)?.label ?? status.providerId)
    : 'Off'

  return (
    <div className="dns-control" ref={rootRef}>
      <button
        type="button"
        className={`dns-control__chip${status.providerId ? ' dns-control__chip--on' : ''}`}
        onClick={handleOpen}
        aria-label={status.providerId ? `DNS-over-HTTPS via ${activeLabel}` : 'DNS-over-HTTPS off'}
        title={
          status.providerId ? `DNS-over-HTTPS via ${activeLabel}` : 'Using the default resolver'
        }
      >
        DNS: {activeLabel}
      </button>

      {open && (
        <div className="dns-control__popover" role="dialog" aria-label="DNS settings">
          {status.torEnabled && (
            <p className="dns-control__hint">
              DNS already resolves through the Tor proxy while Tor mode is on — this setting only
              affects non-proxied lookups, so it&rsquo;s locked while Tor is enabled.
            </p>
          )}

          <div className="dns-control__options">
            <button
              type="button"
              className={`dns-control__option${status.providerId === null ? ' dns-control__option--active' : ''}`}
              disabled={!canChange || pending}
              onClick={() => handleSelect(null)}
            >
              Off (default resolver)
            </button>
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={`dns-control__option${status.providerId === provider.id ? ' dns-control__option--active' : ''}`}
                disabled={!canChange || pending}
                onClick={() => handleSelect(provider.id)}
              >
                {provider.label}
              </button>
            ))}
          </div>

          {error && <p className="dns-control__error">{error}</p>}

          <p className="dns-control__note">
            Forces DNS-over-HTTPS to the selected resolver for lookups that don&rsquo;t go through
            Tor. No Google or Cloudflare option by design. Nothing here is saved between sessions.
          </p>
        </div>
      )}
    </div>
  )
}

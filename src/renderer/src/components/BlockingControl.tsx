import { useEffect, useRef, useState } from 'react'
import type { BlockingStatus } from '../../../shared/ipc'

export default function BlockingControl() {
  const [status, setStatus] = useState<BlockingStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.amnesic.getBlockingStatus().then(setStatus)
    // Stay live: the main process pushes status as the blocked count climbs
    // (throttled) and on reset/toggle, so the count is never a stale snapshot.
    return window.amnesic.onBlockingStatus(setStatus)
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const handleToggle = () => {
    if (!status || pending) return
    setPending(true)
    void window.amnesic
      .setBlockingEnabled(!status.enabled)
      .then(setStatus)
      .finally(() => setPending(false))
  }

  if (!status) return null

  return (
    <div className="blocking-control" ref={rootRef}>
      <button
        type="button"
        className={`blocking-control__chip${status.enabled ? ' blocking-control__chip--on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={status.enabled ? 'Content blocking is on' : 'Content blocking is off'}
        title={
          status.enabled
            ? 'Blocking on — bundled EasyList + uBlock Origin filters'
            : 'Blocking off — all network requests allowed'
        }
      >
        Blocking: {status.enabled ? 'On' : 'Off'}
      </button>

      {open && (
        <div className="blocking-control__popover" role="dialog" aria-label="Blocking settings">
          <div className="blocking-control__row">
            <span>Filter-list blocking</span>
            <strong>{pending ? 'Working…' : status.enabled ? 'On' : 'Off'}</strong>
          </div>

          <div className="blocking-control__row">
            <span>Blocked this session</span>
            <strong>{status.blockedCount}</strong>
          </div>

          <button
            type="button"
            className="blocking-control__toggle"
            onClick={handleToggle}
            disabled={pending}
          >
            {status.enabled ? 'Turn off blocking' : 'Turn on blocking'}
          </button>

          <p className="blocking-control__note">
            Uses bundled EasyList and uBlock Origin filter snapshots (updated at release time only —
            no runtime downloads). Blocks network requests, hides in-page ad slots with cosmetic
            filters, and injects scriptlets (the mechanism that stops same-origin video ads).
            Third-party scoping comes from the filter lists themselves. Nothing here is saved
            between sessions; the blocked count resets on New Identity.
          </p>
        </div>
      )}
    </div>
  )
}

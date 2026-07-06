import { useEffect, useRef, useState } from 'react'
import type { ContainersStatus } from '../../../shared/ipc'

export default function ContainersControl() {
  const [status, setStatus] = useState<ContainersStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.amnesic.getContainersStatus().then(setStatus)
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

  // No no-tabs-open gate (unlike Tor): toggling only affects tabs opened
  // afterward, so there is never a live tab relying on the setting mid-change
  // — turning it on or off touches no existing tab's session (ADR 0011
  // decision 1).
  const handleToggle = () => {
    if (!status || pending) return
    setPending(true)
    void window.amnesic
      .setContainersEnabled(!status.enabled)
      .then(setStatus)
      .finally(() => setPending(false))
  }

  if (!status) return null

  return (
    <div className="containers-control" ref={rootRef}>
      <button
        type="button"
        className={`containers-control__chip${status.enabled ? ' containers-control__chip--on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={status.enabled ? 'Containers are on' : 'Containers are off'}
        title={
          status.enabled
            ? 'Containers on — new tabs get their own isolated session'
            : 'Containers off — tabs share one session'
        }
      >
        Containers: {status.enabled ? 'On' : 'Off'}
      </button>

      {open && (
        <div className="containers-control__popover" role="dialog" aria-label="Containers settings">
          <div className="containers-control__row">
            <span>Per-tab isolation</span>
            <strong>{pending ? 'Working…' : status.enabled ? 'On' : 'Off'}</strong>
          </div>

          <button
            type="button"
            className="containers-control__toggle"
            onClick={handleToggle}
            disabled={pending}
          >
            {status.enabled ? 'Turn off containers' : 'Turn on containers'}
          </button>

          <p className="containers-control__note">
            When on, each new tab you open gets its own isolated session — cookies and storage set
            in one tab are invisible to another. Only affects tabs opened <em>after</em> the change;
            tabs already open keep their session. Links a page opens itself (pop-ups,
            <code> target=_blank</code>) stay in that page&rsquo;s container. This isolates tabs
            from each other — it is not per-site isolation, and every tab still shares one IP.
            Nothing here is saved between sessions.
          </p>
        </div>
      )}
    </div>
  )
}

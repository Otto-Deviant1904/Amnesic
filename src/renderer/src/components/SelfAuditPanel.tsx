import { useEffect, useState } from 'react'
import type { AuditCheck } from '../../../shared/ipc'
import { ReloadIcon } from '../icons'

const STATUS_GLYPH: Record<AuditCheck['status'], string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✕'
}

export default function SelfAuditPanel() {
  const [checks, setChecks] = useState<AuditCheck[] | null>(null)

  const refresh = () => {
    void window.amnesic.getAuditReport().then((report) => setChecks(report.checks))
  }

  useEffect(refresh, [])

  return (
    <div className="self-audit">
      <div className="self-audit__header">
        <h2 className="self-audit__title">Self-audit</h2>
        <button
          type="button"
          className="self-audit__refresh"
          onClick={refresh}
          aria-label="Re-check now"
          title="Re-check now"
        >
          <ReloadIcon size={12} />
          Re-check
        </button>
      </div>
      <ul className="self-audit__list">
        {(checks ?? []).map((check) => (
          <li key={check.id} className={`self-audit__row self-audit__row--${check.status}`}>
            <span className="self-audit__glyph" aria-hidden="true">
              {STATUS_GLYPH[check.status]}
            </span>
            <div className="self-audit__text">
              <span className="self-audit__label">{check.label}</span>
              <span className="self-audit__detail">{check.detail}</span>
            </div>
            <span
              className="self-audit__provenance"
              title={
                check.verifiedAtRuntime
                  ? 'Checked in this running process, just now'
                  : 'Enforced by build/CI tooling — no reliable way to check this at runtime on Electron 43'
              }
            >
              {check.verifiedAtRuntime ? 'checked now' : 'enforced by CI'}
            </span>
          </li>
        ))}
      </ul>
      <p className="self-audit__footnote">
        Rows marked <strong>checked now</strong> were verified in this process this instant. Rows
        marked <strong>enforced by CI</strong> are guarantees with no reliable runtime signal on
        Electron 43 — see <code>docs/threat-model.md</code>.
      </p>
    </div>
  )
}

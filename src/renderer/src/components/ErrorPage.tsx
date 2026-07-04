import type { TabLoadError } from '../../../shared/ipc'
import { WarningIcon } from '../icons'

// Friendly text for the Chromium net error codes users actually hit.
// Anything unlisted falls back to the symbolic name from did-fail-load.
// Cert errors get one shared message: v1 deliberately has no "proceed
// anyway" bypass, so there is nothing more specific for the user to act on.
export function describeNetError(error: TabLoadError): { title: string; detail: string } {
  if (error.code <= -200 && error.code > -300) {
    return {
      title: 'This connection is not secure',
      detail:
        'The site presented an invalid or untrusted certificate, so the connection was refused. This browser has no way to proceed anyway — that is deliberate.'
    }
  }
  switch (error.code) {
    case -105: // ERR_NAME_NOT_RESOLVED
      return {
        title: 'Site not found',
        detail: 'The server address could not be resolved. Check the URL for typos.'
      }
    case -106: // ERR_INTERNET_DISCONNECTED
      return {
        title: 'No internet connection',
        detail: 'The network is down or unreachable.'
      }
    case -102: // ERR_CONNECTION_REFUSED
      return {
        title: 'Connection refused',
        detail: 'The server is reachable but refused the connection.'
      }
    case -101: // ERR_CONNECTION_RESET
      return {
        title: 'Connection reset',
        detail: 'The connection was interrupted before the page loaded.'
      }
    case -7: // ERR_TIMED_OUT
    case -118: // ERR_CONNECTION_TIMED_OUT
      return {
        title: 'Connection timed out',
        detail: 'The server took too long to respond.'
      }
    default:
      return {
        title: 'This page could not be loaded',
        detail: 'The load failed before the page could render.'
      }
  }
}

interface ErrorPageProps {
  error: TabLoadError
  onRetry: () => void
}

export default function ErrorPage({ error, onRetry }: ErrorPageProps) {
  const { title, detail } = describeNetError(error)
  return (
    <div className="error-page">
      <span className="error-page__icon">
        <WarningIcon size={28} />
      </span>
      <div className="error-page__title">{title}</div>
      <p className="error-page__detail">{detail}</p>
      <div className="error-page__code">
        {error.description} · {error.url}
      </div>
      <button type="button" className="button button--primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

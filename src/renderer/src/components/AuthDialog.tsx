import { useEffect, useRef, useState } from 'react'
import type { AuthCredentials, AuthRequest } from '../../../shared/ipc'

interface AuthDialogProps {
  request: AuthRequest
  onSubmit: (credentials: AuthCredentials | null) => void
}

// HTTP basic/proxy auth prompt. Rendered in the page area — main hides the
// requesting view while a challenge is pending, so the shell DOM shows
// through. Credentials only ever travel over IPC into Chromium's auth
// callback; nothing here (or in main) stores them.
export default function AuthDialog({ request, onSubmit }: AuthDialogProps) {
  // App keys this component by requestId, so a new challenge remounts it
  // with blank fields — no reset logic needed here.
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const usernameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    usernameRef.current?.focus()
  }, [])

  return (
    <div className="auth-dialog" role="dialog" aria-modal="true" aria-label="Sign in">
      <form
        className="auth-dialog__card"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit({ username, password })
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onSubmit(null)
        }}
      >
        <div className="auth-dialog__title">
          {request.isProxy ? 'Proxy sign-in required' : 'Sign in'}
        </div>
        <div className="auth-dialog__host">
          {request.host}
          {request.realm ? ` — “${request.realm}”` : ''}
        </div>
        <p className="auth-dialog__note">
          Sent to the site only. Nothing is saved — closing this session forgets it.
        </p>
        <input
          ref={usernameRef}
          className="auth-dialog__input"
          value={username}
          placeholder="Username"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setUsername(event.target.value)}
        />
        <input
          className="auth-dialog__input"
          type="password"
          value={password}
          placeholder="Password"
          autoComplete="off"
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="auth-dialog__actions">
          <button type="button" className="button" onClick={() => onSubmit(null)}>
            Cancel
          </button>
          <button type="submit" className="button button--primary">
            Sign in
          </button>
        </div>
      </form>
    </div>
  )
}

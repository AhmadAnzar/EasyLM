import { useState } from 'react'
import { useAuth } from '../auth/authContext'
import { useGo, workspaceUrl } from '../nav'

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,23}$/

// Log in or create an account, or skip both and try the demo as a guest.
function LoginPage({ siteName }) {
  const { login, register, sessionEnded, dismissSessionNotice } = useAuth()
  const go = useGo()
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const isSignup = mode === 'signup'

  const switchMode = (next) => {
    setMode(next)
    setError('')
  }

  const submit = async (event) => {
    event.preventDefault()
    const name = username.trim().toLowerCase()
    if (isSignup) {
      if (!USERNAME_PATTERN.test(name)) {
        setError('Usernames are 3 to 24 characters: letters, numbers, - or _.')
        return
      }
      if (password.length < 8) {
        setError('Use at least 8 characters for the password.')
        return
      }
    }
    setBusy(true)
    setError('')
    dismissSessionNotice()
    try {
      const user = await (isSignup ? register : login)(name, password)
      go(workspaceUrl(user.username, user.workspaces[0] ?? { n: 1, name: 'Workspace 1' }, user.workspaces))
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <section className="landing auth-page">
      <div className="ambient ambient-one"></div>
      <div className="ambient ambient-two"></div>
      <div className="auth-shell">
        <button type="button" className="auth-brand" onClick={() => go('/')}>
          {siteName}
        </button>

        <div className="auth-card">
          <div className="auth-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={!isSignup} className={!isSignup ? 'active' : ''} onClick={() => switchMode('login')}>
              Log in
            </button>
            <button type="button" role="tab" aria-selected={isSignup} className={isSignup ? 'active' : ''} onClick={() => switchMode('signup')}>
              Create account
            </button>
          </div>

          <h1 className="auth-title">{isSignup ? 'Create your free account' : 'Welcome back'}</h1>
          <p className="auth-sub">
            {isSignup
              ? 'Get private workspaces for your own documents, each with its own link.'
              : 'Log in to open your workspaces and manage your documents.'}
          </p>

          {sessionEnded && !error && (
            <p className="auth-error" role="alert">
              Your session ended. Please log in again.
            </p>
          )}

          <form className="auth-form" onSubmit={submit}>
            <label className="auth-field">
              <span>Username</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="e.g. jane"
                disabled={busy}
                required
              />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                placeholder={isSignup ? 'At least 8 characters' : 'Your password'}
                disabled={busy}
                required
              />
            </label>
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn primary auth-submit" type="submit" disabled={busy}>
              {busy ? 'Please wait...' : isSignup ? 'Create account' : 'Log in'}
            </button>
          </form>

          <div className="auth-divider">
            <span>or</span>
          </div>

          <button type="button" className="btn auth-guest" onClick={() => go('/demo')}>
            Browse as guest
            <small>Try the live demo, no account needed</small>
          </button>
        </div>
      </div>
    </section>
  )
}

export default LoginPage

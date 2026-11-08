// Talking to the backend. A logged-in visitor's session token is kept in this browser and sent with
// every request; guests send nothing and only get the read-only demo workspace.

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

const TOKEN_KEY = 'easylm:token'
const USER_KEY = 'easylm:user'

// Fired when the server rejects the saved session (expired, or the account is gone).
export const authEvents = new EventTarget()

function readStorage(key) {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // storage can be unavailable (private window); the visitor is then logged out on the next visit
  }
}

export const getToken = () => readStorage(TOKEN_KEY)

export function getSavedUser() {
  try {
    const user = JSON.parse(readStorage(USER_KEY) || 'null')
    return user && getToken() ? user : null
  } catch {
    return null
  }
}

export function saveSession(token, user) {
  writeStorage(TOKEN_KEY, token)
  writeStorage(USER_KEY, token ? JSON.stringify(user) : '')
}

export function authHeaders(extra = {}) {
  const token = getToken()
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra }
}

export function notifyUnauthorized() {
  authEvents.dispatchEvent(new Event('unauthorized'))
}

export async function apiFetch(path, init = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const resp = await fetch(url, { ...init, headers: authHeaders(init.headers) })
  // a 401 while holding a session means it is no longer valid; guests are never "unauthorized"
  if (resp.status === 401 && getToken()) notifyUnauthorized()
  return resp
}

// The server's explanation of a failed request (its JSON "detail"), or a fallback.
export function errorMessage(status, bodyText, fallback = 'Something went wrong') {
  try {
    const parsed = JSON.parse(bodyText || '{}')
    if (parsed.detail) {
      if (typeof parsed.detail === 'string') return parsed.detail
      if (Array.isArray(parsed.detail) && parsed.detail[0]?.msg) return parsed.detail[0].msg
      return JSON.stringify(parsed.detail)
    }
  } catch {
    // not JSON
  }
  return `${fallback} (${status})`
}

async function authRequest(path, init) {
  let resp
  try {
    resp = await apiFetch(path, init)
  } catch {
    throw new Error('Could not reach the server. If it has been idle it may need a minute to wake up, so try again shortly.')
  }
  const text = await resp.text()
  if (!resp.ok) throw new Error(errorMessage(resp.status, text, 'Request failed'))
  return JSON.parse(text || '{}')
}

const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

export const registerAccount = (username, password) => authRequest('/auth/register', jsonPost({ username, password }))
export const loginAccount = (username, password) => authRequest('/auth/login', jsonPost({ username, password }))
export const fetchMe = () => authRequest('/auth/me')
export const createWorkspaceRequest = () => authRequest('/workspaces', { method: 'POST' })

// Wake the (free, sleeping) backend as soon as the site opens so the first real request is quicker.
export function warmUpBackend() {
  fetch(`${API_BASE}/sources?workspace=demo`).catch(() => {})
}

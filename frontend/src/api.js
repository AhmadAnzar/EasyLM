// Talking to the backend. When the backend has an access code set (APP_ACCESS_KEY), every request
// carries the code the visitor typed in; a 401 tells the app to ask for it again.

const KEY_STORAGE = 'easylm:access-key'

export const authEvents = new EventTarget()

export function getAccessKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || ''
  } catch {
    return ''
  }
}

export function setAccessKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key)
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    // storage can be unavailable (private window); the code is then asked for again next time
  }
}

export function authHeaders(extra = {}) {
  const key = getAccessKey()
  return key ? { ...extra, 'X-Access-Key': key } : { ...extra }
}

export function notifyUnauthorized() {
  authEvents.dispatchEvent(new Event('unauthorized'))
}

export async function apiFetch(url, init = {}) {
  const resp = await fetch(url, { ...init, headers: authHeaders(init.headers) })
  if (resp.status === 401) notifyUnauthorized()
  return resp
}

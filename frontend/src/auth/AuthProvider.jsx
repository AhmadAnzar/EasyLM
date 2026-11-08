import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  authEvents,
  createWorkspaceRequest,
  fetchMe,
  getSavedUser,
  getToken,
  loginAccount,
  registerAccount,
  saveSession
} from '../api'
import { AuthContext } from './authContext'

// Keeps who is logged in. The saved user is trusted straight away so the page never waits on a
// (possibly sleeping) server; it is verified in the background and dropped if the server says no.
function AuthProvider({ children }) {
  const [user, setUser] = useState(getSavedUser)
  const [sessionEnded, setSessionEnded] = useState(false)

  const startSession = useCallback((payload) => {
    saveSession(payload.token, payload.user)
    setUser(payload.user)
    setSessionEnded(false)
    return payload.user
  }, [])

  const logout = useCallback(() => {
    saveSession('', null)
    setUser(null)
  }, [])

  useEffect(() => {
    if (!getToken()) return undefined
    let stopped = false
    fetchMe()
      .then((me) => {
        if (stopped) return
        const next = { username: me.username, workspaces: me.workspaces }
        saveSession(getToken(), next)
        setUser(next)
      })
      .catch(() => {
        // an unreachable server keeps the saved session; a rejected one is handled by the event below
      })
    return () => {
      stopped = true
    }
  }, [])

  useEffect(() => {
    const onUnauthorized = () => {
      saveSession('', null)
      setUser(null)
      setSessionEnded(true)
    }
    authEvents.addEventListener('unauthorized', onUnauthorized)
    return () => authEvents.removeEventListener('unauthorized', onUnauthorized)
  }, [])

  const value = useMemo(
    () => ({
      user,
      sessionEnded,
      dismissSessionNotice: () => setSessionEnded(false),
      login: async (username, password) => startSession(await loginAccount(username, password)),
      register: async (username, password) => startSession(await registerAccount(username, password)),
      logout,
      addWorkspace: async () => {
        const { workspaces } = await createWorkspaceRequest()
        const next = { ...user, workspaces }
        saveSession(getToken(), next)
        setUser(next)
        return workspaces[workspaces.length - 1]
      }
    }),
    [user, sessionEnded, startSession, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export default AuthProvider

import { useEffect } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import './App.css'
import LandingPage from './components/LandingPage'
import LoginPage from './components/LoginPage'
import Workspace from './components/Workspace'
import { warmUpBackend } from './api'
import { useAuth } from './auth/authContext'
import { findBySegment, useGo, useViewTransitionFallback, workspaceItems, workspaceUrl } from './nav'

const SITE_NAME = 'EasyLM'

// The first workspace of the logged-in user, or the demo for guests.
function homePath(user) {
  return user ? workspaceUrl(user.username, user.workspaces[0] ?? { n: 1, name: 'Workspace 1' }, user.workspaces) : '/demo'
}

// "/demo/*" and "/u/:username/workspace/:ws/*" carry an optional "chats/<id or name>" tail.
function chatFromTail(params) {
  const match = /^chats\/([^/]+)\/?$/.exec(params['*'] || '')
  return match ? decodeURIComponent(match[1]) : undefined
}

function DemoWorkspace() {
  const params = useParams()
  return <Workspace key="demo" workspaceId="demo" readOnly chatSegment={chatFromTail(params)} />
}

// /u/:username/workspace/:ws - only the owner gets in; anyone else is sent somewhere sensible.
function UserWorkspace() {
  const { user } = useAuth()
  const params = useParams()
  const { username, ws } = params
  if (!user) return <Navigate to="/login" replace />
  if (user.username !== username.toLowerCase()) return <Navigate to={homePath(user)} replace />
  // the link may name the workspace by its id or by its custom name
  const found = findBySegment(workspaceItems(user.workspaces), ws)
  if (!found) return <Navigate to={homePath(user)} replace />
  const workspaceId = `${user.username}:${found.id}`
  // `key` gives every workspace its own fresh state (chat, sources, uploads)
  return <Workspace key={workspaceId} workspaceId={workspaceId} readOnly={false} chatSegment={chatFromTail(params)} />
}

function App() {
  const { user } = useAuth()
  const go = useGo()
  useViewTransitionFallback()

  useEffect(() => {
    warmUpBackend()
  }, [])

  return (
    <Routes>
      <Route
        path="/"
        element={
          <div className="app">
            <LandingPage
              siteName={SITE_NAME}
              user={user}
              onTryDemo={() => go('/demo')}
              onLogin={() => go('/login')}
              onOpenWorkspace={() => go(homePath(user))}
            />
          </div>
        }
      />
      <Route
        path="/login"
        element={user ? <Navigate to={homePath(user)} replace /> : <div className="app"><LoginPage siteName={SITE_NAME} /></div>}
      />
      <Route path="/demo/*" element={<DemoWorkspace />} />
      <Route path="/u/:username/workspace/:ws/*" element={<UserWorkspace />} />
      <Route path="/home" element={<Navigate to={homePath(user)} replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App

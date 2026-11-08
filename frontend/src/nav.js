import { useCallback, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'

const supportsViewTransitions = typeof document !== 'undefined' && 'startViewTransition' in document

// Mark browsers without the View Transitions API so the CSS can fall back to a simple fade-in.
export function useViewTransitionFallback() {
  useEffect(() => {
    document.documentElement.classList.toggle('no-vt', !supportsViewTransitions)
  }, [])
}

// navigate() that cross-fades between pages where the browser supports it.
export function useGo() {
  const navigate = useNavigate()
  return useCallback(
    (path) => {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      if (supportsViewTransitions && !reduceMotion) {
        document.startViewTransition(() => {
          flushSync(() => navigate(path))
        })
      } else {
        navigate(path)
      }
    },
    [navigate]
  )
}

// ---- Link segments -------------------------------------------------------------------------------
// A workspace or chat is reachable by its stable id or, once it has a custom name, by that name
// ("/u/jane/workspace/thesis/chats/chapter-2"). Links we build use the name when it is custom and
// unambiguous, and the id otherwise; both forms always resolve.

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop the accent marks NFKD splits off
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

// items: [{ id, name, custom }] where custom says whether the name was chosen by the user
export function segmentFor(item, items) {
  const id = String(item.id)
  if (!item.custom) return id
  const slug = slugify(item.name)
  if (!slug) return id
  const clash = items.some(
    (other) => other !== item && (String(other.id) === slug || (other.custom && slugify(other.name) === slug))
  )
  return clash ? id : slug
}

export function findBySegment(items, segment) {
  if (segment == null) return undefined
  const wanted = String(segment).toLowerCase()
  return items.find((item) => String(item.id) === wanted) || items.find((item) => item.custom && slugify(item.name) === wanted)
}

// The server stores workspaces as { n, name }. A name other than the default "Workspace n" is custom.
export const workspaceItems = (workspaces) =>
  (workspaces || []).map((w) => ({ id: w.n, name: w.name, custom: w.name !== `Workspace ${w.n}` }))

export function workspaceUrl(username, workspace, workspaces, chatSegment) {
  const items = workspaceItems(workspaces)
  const item = items.find((i) => i.id === workspace.n) || { id: workspace.n, name: workspace.name, custom: false }
  const base = `/u/${username}/workspace/${segmentFor(item, items)}`
  return chatSegment ? `${base}/chats/${chatSegment}` : base
}

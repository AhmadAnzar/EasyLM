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

export const workspacePath = (username, n) => `/u/${username}/workspace/${n}`

import { useEffect, useState } from 'react'

const EXIT_MS = 220

// A dialog that fades/scales in and out instead of popping in and out of existence.
// Keep it rendered and drive it with `open`; it stays in the DOM just long enough to animate out.
function Modal({ open, onClose, children, className = '', overlayClassName = '', dismissible = true, onTop = false, label }) {
  const [mounted, setMounted] = useState(open)
  const [entered, setEntered] = useState(false)

  // mount as soon as we are asked to open (adjusting state during render is the supported pattern)
  if (open && !mounted) setMounted(true)

  useEffect(() => {
    if (open) {
      // wait two frames so the closed styles are painted first and the transition can run
      let second
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setEntered(true))
      })
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
      }
    }
    const timer = setTimeout(() => {
      setMounted(false)
      setEntered(false)
    }, EXIT_MS)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open || !dismissible || !onClose) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, dismissible, onClose])

  if (!mounted) return null

  const isShown = open && entered

  return (
    <div
      className={`modal-overlay ${isShown ? 'is-open' : ''} ${onTop ? 'on-top' : ''} ${overlayClassName}`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible && onClose) onClose()
      }}
    >
      <div className={`modal ${className}`}>{children}</div>
    </div>
  )
}

export default Modal

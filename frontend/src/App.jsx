import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import './App.css'
import AddSourcesModal from './components/AddSourcesModal'
import HomePage from './components/HomePage'
import LandingPage from './components/LandingPage'
import Modal from './components/Modal'

const STORAGE_KEY = 'easylm:v1'
const MAX_SOURCES = 5
const MAX_HISTORY_TURNS = 6

const SUPPORTED_EXTENSIONS = ['.pdf', '.csv']
const SUPPORTED_LABEL = 'PDF or CSV'
// While dragging, browsers only expose the MIME type (not the file name). Windows reports CSVs as
// text/csv or as the Excel type depending on what is installed, so those all count as "maybe fine".
const DRAG_OK_MIME_TYPES = new Set([
  'application/pdf',
  'text/csv',
  'application/csv',
  'text/comma-separated-values',
  'application/vnd.ms-excel'
])

const isSupportedFile = (file) => {
  const name = (file?.name || '').toLowerCase()
  return SUPPORTED_EXTENSIONS.some((extension) => name.endsWith(extension))
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimeLeft(seconds) {
  if (seconds < 8) return 'a few seconds'
  if (seconds < 55) return `about ${Math.round(seconds / 5) * 5} s`
  return `about ${Math.ceil(seconds / 60)} min`
}

// 'ok' (or unknown until drop), 'bad' (a file type we can't read) or 'multi' (more than one file)
function classifyDrag(dataTransfer) {
  const fileItems = Array.from(dataTransfer?.items || []).filter((item) => item.kind === 'file')
  if (fileItems.length === 0) return 'ok' // dragging text
  if (fileItems.length > 1) return 'multi'
  const type = fileItems[0].type
  if (!type) return 'ok'
  return DRAG_OK_MIME_TYPES.has(type) ? 'ok' : 'bad'
}

const SEED_MESSAGE = {
  id: 'seed-assistant',
  role: 'assistant',
  text: 'Add one or more sources (clipboard text or files), then ask your question. EasyLM will retrieve context across all active sources collectively.'
}

// The chat and the list of sources survive a page refresh (the vectors already live in the database).
function loadSavedState() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (!data) return { messages: [SEED_MESSAGE], sources: [] }
    const messages = Array.isArray(data.messages)
      ? data.messages.filter((m) => m && m.id && m.status !== 'typing').map(({ status, ...rest }) => rest) // eslint-disable-line no-unused-vars
      : []
    return {
      messages: messages.length ? messages : [SEED_MESSAGE],
      sources: Array.isArray(data.sources) ? data.sources : []
    }
  } catch {
    return { messages: [SEED_MESSAGE], sources: [] }
  }
}

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const typingTimersRef = useRef(new Map())
  const sourcesRef = useRef([])
  const dragCounterRef = useRef(0)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [clipboardText, setClipboardText] = useState('')
  const [pdfFile, setPdfFile] = useState(null)
  const [initialState] = useState(loadSavedState)
  const [sources, setSources] = useState(initialState.sources)
  const [messages, setMessages] = useState(initialState.messages)
  const [input, setInput] = useState('')
  const [sourceMode, setSourceMode] = useState('text')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadStage, setUploadStage] = useState('') // '', 'uploading', 'chunking', 'embedding', 'done', 'error'
  const [embedPercent, setEmbedPercent] = useState(0)
  const [uploadDetail, setUploadDetail] = useState('')
  const [uploadError, setUploadError] = useState('')
  const pollTimerRef = useRef(null)
  const xhrRef = useRef(null)
  const jobIdRef = useRef(null)
  const abortRef = useRef(null)
  const etaRef = useRef(null)
  const cancelledRef = useRef(false)
  const handleDropRef = useRef(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [dragKind, setDragKind] = useState('ok') // what is currently being dragged: 'ok' | 'bad' | 'multi'
  const [toast, setToast] = useState({ open: false, text: '', kind: 'error' })
  const toastTimerRef = useRef(null)
  const [previewModal, setPreviewModal] = useState({ open: false, url: '', name: '' })
  const [confirmDelete, setConfirmDelete] = useState({ open: false, id: null, name: '' })

  const siteName = 'EasyLM'
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
  const hasSource = sources.length > 0
  const onHomePage = location.pathname === '/home'

  useEffect(() => {
    sourcesRef.current = sources
  }, [sources])

  // Persist the conversation and the source list (not the in-flight typing state or blob URLs).
  useEffect(() => {
    try {
      const savedMessages = messages
        .filter((m) => m.status !== 'typing')
        .slice(-60)
        .map(({ status, ...rest }) => rest) // eslint-disable-line no-unused-vars
      const savedSources = sources
        .filter((s) => !s.removing)
        .map(({ previewUrl, removing, ...rest }) => rest) // eslint-disable-line no-unused-vars
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: savedMessages, sources: savedSources }))
    } catch {
      // storage can be unavailable (private window, quota); the app works without it
    }
  }, [messages, sources])

  useEffect(() => {
    document.title = onHomePage ? `${siteName} · Workspace` : `${siteName} · Ask your documents`
  }, [onHomePage])

  // Cross-fade between pages with the View Transitions API where the browser has it.
  const supportsViewTransitions = typeof document !== 'undefined' && 'startViewTransition' in document
  useEffect(() => {
    document.documentElement.classList.toggle('no-vt', !supportsViewTransitions)
  }, [supportsViewTransitions])

  const go = (path) => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (supportsViewTransitions && !reduceMotion) {
      document.startViewTransition(() => {
        flushSync(() => navigate(path))
      })
    } else {
      navigate(path)
    }
  }

  useEffect(() => {
    return () => {
      clearInterval(pollTimerRef.current)
      clearTimeout(toastTimerRef.current)
      typingTimersRef.current.forEach((timerId) => clearInterval(timerId))
      typingTimersRef.current.clear()
      sourcesRef.current.forEach((source) => {
        if (source.previewUrl) {
          URL.revokeObjectURL(source.previewUrl)
        }
      })
    }
  }, [])

  // A short in-app message (instead of a browser alert) for things like unsupported files.
  const showToast = (text, kind = 'error') => {
    clearTimeout(toastTimerRef.current)
    setToast({ open: true, text, kind })
    toastTimerRef.current = setTimeout(() => setToast((prev) => ({ ...prev, open: false })), 5000)
  }

  const dismissToast = () => {
    clearTimeout(toastTimerRef.current)
    setToast((prev) => ({ ...prev, open: false }))
  }

  // Used by the Add Sources dialog (file picker and its own drop zone) so every entry point
  // applies the same file-type rule.
  const selectFile = (file) => {
    if (file && !isSupportedFile(file)) {
      showToast(`"${file.name}" isn't supported. Please choose a ${SUPPORTED_LABEL} file.`)
      return
    }
    setPdfFile(file)
  }

  // Drag & drop anywhere on the page: a supported file (or text) is added; anything else gets a message.
  // The newest handler is kept in a ref so the document listeners below are attached once.
  handleDropRef.current = async (e) => {
    const files = Array.from(e.dataTransfer?.files || [])

    if (files.length > 1) {
      showToast('Please drop one file at a time.')
      return
    }

    if (files.length === 1) {
      const file = files[0]
      if (!isSupportedFile(file)) {
        showToast(`"${file.name}" isn't supported. Please upload a ${SUPPORTED_LABEL} file.`)
        return
      }
      if (isBusy) {
        showToast('Please wait for the current upload to finish.', 'info')
        return
      }
      if (!onHomePage) go('/home')
      setSourceMode('pdf')
      setPdfFile(file)
      // With the Add Sources dialog open the file is just selected (the user presses Save).
      if (!isModalOpen) saveSource({ mode: 'pdf', file })
      return
    }

    try {
      const text = e.dataTransfer.getData('text/plain')
      if (text && text.trim()) {
        if (isBusy) {
          showToast('Please wait for the current upload to finish.', 'info')
          return
        }
        if (!onHomePage) go('/home')
        setSourceMode('text')
        setClipboardText(text)
        if (!isModalOpen) saveSource({ mode: 'text', text })
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    const onDocDragEnter = (e) => {
      e.preventDefault()
      dragCounterRef.current += 1
      setDragKind(classifyDrag(e.dataTransfer))
      setIsDragging(true)
    }

    const onDocDragOver = (e) => {
      e.preventDefault()
      const kind = classifyDrag(e.dataTransfer)
      setDragKind(kind) // bails out when unchanged, so this is cheap even though dragover fires constantly
      if (e.dataTransfer) e.dataTransfer.dropEffect = kind === 'ok' ? 'copy' : 'none' // "not allowed" cursor
    }

    const onDocDragLeave = (e) => {
      e.preventDefault()
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
      if (dragCounterRef.current === 0) setIsDragging(false)
    }

    const onDocDrop = (e) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragging(false)
      handleDropRef.current?.(e)
    }

    document.addEventListener('dragenter', onDocDragEnter)
    document.addEventListener('dragover', onDocDragOver)
    document.addEventListener('dragleave', onDocDragLeave)
    document.addEventListener('drop', onDocDrop)

    return () => {
      document.removeEventListener('dragenter', onDocDragEnter)
      document.removeEventListener('dragover', onDocDragOver)
      document.removeEventListener('dragleave', onDocDragLeave)
      document.removeEventListener('drop', onDocDrop)
    }
  }, [])

  // The dialogs below stay mounted and are driven by `open`, so they can animate out;
  // that is why closing only flips `open` and keeps the rest of the data.
  const openPreviewModal = (source) => {
    if (!source) return
    setPreviewModal({
      open: true,
      id: source.id,
      name: source.name,
      kind: source.type,
      url: source.type === 'pdf' ? source.previewUrl || '' : '',
      text: source.preview || '',
      size: source.size,
      chunks: source.chunks
    })
  }

  const closePreviewModal = () => setPreviewModal((prev) => ({ ...prev, open: false }))

  const requestDeleteSource = (id, name) => setConfirmDelete({ open: true, id, name })

  const confirmDeleteNow = () => {
    if (confirmDelete.id) removeSource(confirmDelete.id)
    setConfirmDelete((prev) => ({ ...prev, open: false }))
    closePreviewModal()
  }

  const cancelDelete = () => setConfirmDelete((prev) => ({ ...prev, open: false }))

  const clearTypingTimer = (messageId) => {
    const existingTimer = typingTimersRef.current.get(messageId)
    if (existingTimer) {
      clearInterval(existingTimer)
      typingTimersRef.current.delete(messageId)
    }
  }

  const updateMessageById = (id, patch) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
  }

  const animateAssistantMessage = (messageId, fullText, onComplete) => {
    clearTypingTimer(messageId)

    let currentIndex = 0
    // ~14 ticks of 18 ms: still reads as typing, but doesn't add a second after the answer arrives
    const stepSize = Math.max(1, Math.ceil(fullText.length / 14))
    const timerId = setInterval(() => {
      currentIndex = Math.min(fullText.length, currentIndex + stepSize)

      setMessages((prevMessages) =>
        prevMessages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                text: fullText.slice(0, currentIndex),
                status: currentIndex >= fullText.length ? undefined : 'streaming'
              }
            : message
        )
      )

      if (currentIndex >= fullText.length) {
        clearTypingTimer(messageId)
        if (typeof onComplete === 'function') {
          onComplete()
        }
      }
    }, 18)

    typingTimersRef.current.set(messageId, timerId)
  }

  const openHome = () => {
    go('/home')
  }

  const stopProgressPolling = () => {
    clearInterval(pollTimerRef.current)
    pollTimerRef.current = null
  }

  // Poll the backend for the real indexing stage (parsing, chunking, embedding n/N, ...).
  const startProgressPolling = (jobId) => {
    stopProgressPolling()
    pollTimerRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${apiBaseUrl}/progress/${jobId}`)
        if (!resp.ok) return
        const p = await resp.json()
        if (pollTimerRef.current === null) return // finished while this poll was in flight
        if (p.stage === 'parsing') {
          setUploadStage('reading')
          setEmbedPercent(p.total ? Math.round((p.done / p.total) * 100) : 0)
          setUploadDetail(p.total ? `Reading page ${Math.min(p.done + 1, p.total)} of ${p.total}` : 'Reading the document...')
        } else if (p.stage === 'chunking' || p.stage === 'queued') {
          setUploadStage('reading')
          setEmbedPercent(100)
          setUploadDetail('Splitting the text into chunks...')
        } else if (p.stage === 'embedding') {
          setUploadStage('embedding')
          setEmbedPercent(p.total ? Math.round((p.done / p.total) * 100) : 0)
          // estimate the time left from how fast the batches have been finishing
          let timeLeft = ''
          if (p.total && p.done >= 1) {
            const now = Date.now()
            if (!etaRef.current || p.done < etaRef.current.done0) etaRef.current = { t0: now, done0: p.done }
            const { t0, done0 } = etaRef.current
            if (p.done - done0 >= 2) {
              const secondsLeft = ((now - t0) / 1000 / (p.done - done0)) * (p.total - p.done)
              timeLeft = ` · ${formatTimeLeft(secondsLeft)} left`
            }
          }
          const base = p.total ? `Embedding batch ${Math.min(p.done + 1, p.total)} of ${p.total}${timeLeft}` : 'Generating embeddings...'
          setUploadDetail(p.note ? `${base} - ${p.note}` : base)
        } else if (p.stage === 'storing') {
          setUploadStage('embedding')
          setEmbedPercent(100)
          setUploadDetail('Saving to the vector database...')
        }
      } catch {
        // the request itself reports real failures; ignore a missed poll
      }
    }, 1000)
  }

  const readErrorMessage = (status, bodyText) => {
    try {
      const parsed = JSON.parse(bodyText || '{}')
      if (parsed.detail) return typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail)
    } catch {
      // not JSON
    }
    return `Upload failed (${status})`
  }

  // Cancel takes effect in the UI immediately; the server stops its work as soon as it sees the flag.
  const cancelUpload = () => {
    cancelledRef.current = true
    xhrRef.current?.abort()
    abortRef.current?.abort()
    if (jobIdRef.current) {
      fetch(`${apiBaseUrl}/cancel/${jobIdRef.current}`, { method: 'POST' }).catch(() => {})
    }
    stopProgressPolling()
    setUploadStage('')
    setUploadProgress(0)
  }

  const dismissUploadModal = () => {
    setUploadStage('')
    setUploadError('')
  }

  const saveSource = async (override) => {
    const mode = override?.mode ?? sourceMode
    const trimmed = (override?.text ?? clipboardText).trim()
    const file = override?.file ?? pdfFile
    const hasText = mode === 'text' && Boolean(trimmed)
    const hasPdf = mode === 'pdf' && Boolean(file)
    if (!hasText && !hasPdf) {
      return
    }

    if (sources.length >= MAX_SOURCES) {
      setMessages((prev) => [
        ...prev,
        {
          id: `source-limit-${Date.now()}`,
          role: 'assistant',
          variant: 'warning',
          text: `You can keep up to ${MAX_SOURCES} sources at the same time. Remove one to add another.`
        }
      ])
      return
    }

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    jobIdRef.current = jobId
    etaRef.current = null
    cancelledRef.current = false
    setIsBusy(true)
    setUploadError('')
    setUploadProgress(0)
    setEmbedPercent(0)
    setUploadDetail('')
    setUploadStage('uploading')
    startProgressPolling(jobId)

    // Each pasted text gets its own name in the database, so a second paste doesn't replace the first.
    const textSourceName = `pasted-text-${Date.now().toString(36)}`

    try {
      let data = {}

      if (mode === 'text') {
        // The text itself is tiny; the real wait is the server chunking + embedding it.
        setUploadProgress(100)
        abortRef.current = new AbortController()
        const resp = await fetch(`${apiBaseUrl}/upload-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed, job_id: jobId, source_name: textSourceName }),
          signal: abortRef.current.signal
        })
        const bodyText = await resp.text()
        if (!resp.ok) throw new Error(readErrorMessage(resp.status, bodyText))
        data = JSON.parse(bodyText || '{}')
      } else {
        // use XHR so we can track upload progress for large files
        data = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhrRef.current = xhr
          const formData = new FormData()
          formData.append('file', file)
          formData.append('job_id', jobId)
          xhr.open('POST', `${apiBaseUrl}/upload`)

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setUploadProgress(Math.round((e.loaded / e.total) * 100))
            }
          }

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText || '{}'))
              } catch (err) {
                reject(err)
              }
            } else {
              reject(new Error(readErrorMessage(xhr.status, xhr.responseText)))
            }
          }

          xhr.onerror = () => reject(new Error('Could not reach the backend. Is it running?'))
          xhr.onabort = () => reject(new Error('Upload cancelled.'))
          xhr.send(formData)
        })
      }

      stopProgressPolling()
      setUploadStage('done')
      setUploadDetail('Ready to chat!')
      setTimeout(() => setUploadStage((current) => (current === 'done' ? '' : current)), 900)

      if (mode === 'text') {
        setSources((prev) => [
          ...prev,
          {
            id: `text-${Date.now()}`,
            type: 'text',
            name: `Pasted text ${prev.length + 1}`,
            sourceName: textSourceName,
            preview: trimmed.slice(0, 4000),
            size: new Blob([trimmed]).size,
            chunks: data.total_chunks ?? 0
          }
        ])
      } else {
        const fileName = file.name.toLowerCase()
        const fileType = fileName.endsWith('.csv') ? 'csv' : 'pdf'
        // PDFs preview in the browser's own viewer; for CSVs show the first few KB as text.
        const previewUrl = fileType === 'pdf' ? URL.createObjectURL(file) : undefined
        const csvPreview = fileType === 'csv' ? await file.slice(0, 6000).text() : ''
        setSources((prev) => [
          ...prev,
          {
            id: `file-${Date.now()}`,
            type: fileType,
            name: file.name,
            sourceName: file.name,
            preview: csvPreview,
            previewUrl,
            size: file.size,
            chunks: data.total_chunks ?? 0
          }
        ])
      }

      setMessages((prev) => [
        ...prev,
        {
          id: `source-confirm-${Date.now()}`,
          role: 'assistant',
          variant: 'success',
          text: `Source indexed successfully (${data.total_chunks ?? 0} chunks).`
        }
      ])

      setIsModalOpen(false)
      setClipboardText('')
      setPdfFile(null)
      setUploadProgress(0)
    } catch (error) {
      stopProgressPolling()
      const message = error instanceof Error ? error.message : 'Upload failed.'
      if (cancelledRef.current) {
        // user pressed Cancel: close the progress dialog quietly
        setUploadStage('')
        setUploadProgress(0)
        setMessages((prev) => [
          ...prev,
          { id: `source-cancel-${Date.now()}`, role: 'assistant', variant: 'info', text: 'Upload cancelled.' }
        ])
      } else {
        // keep the dialog open on the error so the failure can't be missed
        setUploadStage('error')
        setUploadError(message)
        setUploadProgress(0)
        setMessages((prev) => [
          ...prev,
          {
            id: `source-error-${Date.now()}`,
            role: 'assistant',
            variant: 'error',
            text: `Could not index source: ${message}`
          }
        ])
      }
    } finally {
      xhrRef.current = null
      abortRef.current = null
      jobIdRef.current = null
      setIsBusy(false)
    }
  }

  const removeSource = async (id) => {
    const found = sources.find((s) => s.id === id)
    if (!found) return

    setIsBusy(true)
    try {
      // sources saved before pasted texts got their own name used one shared name
      const sourceName = found.sourceName || (found.type === 'text' ? 'clipboard-text' : found.name)
      const resp = await fetch(`${apiBaseUrl}/delete-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_name: sourceName })
      })
      if (!resp.ok) throw new Error('Failed to delete source from database')

      // fade the card out, then drop it from the list
      setSources((prev) => prev.map((s) => (s.id === id ? { ...s, removing: true } : s)))
      setTimeout(() => {
        if (found.previewUrl) URL.revokeObjectURL(found.previewUrl)
        setSources((prev) => prev.filter((s) => s.id !== id))
      }, 220)

      setMessages((prev) => [
        ...prev,
        {
          id: `source-removed-${Date.now()}`,
          role: 'assistant',
          variant: 'info',
          text: `Source "${found.name}" removed successfully.`
        }
      ])
    } catch (err) {
      console.error(err)
      setMessages((prev) => [
        ...prev,
        {
          id: `source-remove-error-${Date.now()}`,
          role: 'assistant',
          variant: 'error',
          text: `Failed to remove source: ${err.message}`
        }
      ])
    } finally {
      setIsBusy(false)
    }
  }

  const closeModal = () => {
    setIsModalOpen(false)
  }

  const newChat = () => {
    typingTimersRef.current.forEach((timerId) => clearInterval(timerId))
    typingTimersRef.current.clear()
    setMessages([SEED_MESSAGE])
    setIsBusy(false)
  }

  const clearSources = async () => {
    setIsBusy(true)
    try {
      const resp = await fetch(`${apiBaseUrl}/clear`, {
        method: 'POST'
      })
      if (!resp.ok) throw new Error('Failed to clear database')

      sources.forEach((source) => {
        if (source.previewUrl) {
          URL.revokeObjectURL(source.previewUrl)
        }
      })
      setSources([])
      setPdfFile(null)
      
      setMessages((prev) => [
        ...prev,
        {
          id: `sources-cleared-${Date.now()}`,
          role: 'assistant',
          variant: 'info',
          text: 'All sources cleared successfully.'
        }
      ])
    } catch (err) {
      console.error(err)
      setMessages((prev) => [
        ...prev,
        {
          id: `sources-clear-error-${Date.now()}`,
          role: 'assistant',
          variant: 'error',
          text: `Failed to clear sources: ${err.message}`
        }
      ])
    } finally {
      setIsBusy(false)
    }
  }

  const sendMessage = async () => {
    const trimmed = input.trim()
    if (!trimmed) {
      return
    }

    if (!hasSource) {
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: 'user', text: trimmed, skipHistory: true },
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: 'Please add a source first using Add Sources.',
          skipHistory: true
        }
      ])
      setInput('')
      return
    }

    // The last few real question/answer turns, so follow-ups like "and its battery?" make sense.
    const history = messages
      .filter((m) => m.id !== SEED_MESSAGE.id && !m.variant && !m.skipHistory && m.text && m.status !== 'typing')
      .slice(-MAX_HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.text }))

    const userMessageId = `user-${Date.now()}`
    const assistantMessageId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: 'user', text: trimmed },
      {
        id: assistantMessageId,
        role: 'assistant',
        text: '',
        status: 'typing'
      }
    ])
    setInput('')
    setIsBusy(true)

    try {
      const response = await fetch(`${apiBaseUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, history })
      })

      if (!response.ok) {
        throw new Error(readErrorMessage(response.status, await response.text()).replace(/^Upload failed/, 'Query failed'))
      }

      const data = await response.json()
      const citationChunks = Array.isArray(data.source_chunks) ? data.source_chunks.slice(0, 4) : []

      animateAssistantMessage(
        assistantMessageId,
        data.answer || 'No answer returned.',
        () => {
          updateMessageById(assistantMessageId, { citations: citationChunks })
          setIsBusy(false)
        }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Query failed.'
      updateMessageById(assistantMessageId, { variant: 'error' })
      animateAssistantMessage(assistantMessageId, `Error calling backend: ${message}`, () =>
        setIsBusy(false)
      )
    }
  }

  // keep showing the last stage while the progress dialog fades out
  const lastStageRef = useRef('uploading')
  if (uploadStage) lastStageRef.current = uploadStage
  const shownStage = uploadStage || lastStageRef.current

  return (
    <div className={`app ${isDragging ? 'is-dragging' : ''}`}>
      <Routes>
        <Route
          path="/"
          element={<LandingPage siteName={siteName} onOpenApp={openHome} />}
        />
        <Route
          path="/home"
          element={
            <HomePage
              siteName={siteName}
              hasSource={hasSource}
              sources={sources}
              messages={messages}
              input={input}
              onInputChange={setInput}
              onSend={sendMessage}
              onOpenModal={() => setIsModalOpen(true)}
              onClearSources={clearSources}
              onNewChat={newChat}
              isBusy={isBusy}
              busyLabel={uploadStage ? 'Indexing...' : 'Thinking...'}
              onEnterSend={sendMessage}
              onPreviewSource={openPreviewModal}
              onRemoveSource={requestDeleteSource}
              isDragging={isDragging}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <AddSourcesModal
        open={onHomePage && isModalOpen}
        sourceMode={sourceMode}
        clipboardText={clipboardText}
        pdfFile={pdfFile}
        onChangeMode={setSourceMode}
        onChangeClipboardText={setClipboardText}
        onChangePdfFile={selectFile}
        onCancel={closeModal}
        onSave={() => saveSource()}
        isBusy={isBusy}
        uploadDetail={uploadDetail}
        isDragging={isDragging}
      />

      {/* full-screen drop zone, shown while anything is dragged over the window */}
      <div className={`drop-overlay ${isDragging ? 'active' : ''} ${dragKind !== 'ok' ? 'is-bad' : ''}`} aria-hidden={!isDragging}>
        <div className="drop-wash" />
        <div className="drop-card">
          <div className="drop-title">
            {dragKind === 'ok' && 'Drop to add your source'}
            {dragKind === 'bad' && "This file type isn't supported"}
            {dragKind === 'multi' && 'Drop one file at a time'}
          </div>
          <div className="drop-sub">
            {dragKind === 'ok' && `${SUPPORTED_LABEL} files, or selected text`}
            {dragKind === 'bad' && `Only ${SUPPORTED_LABEL} files can be added.`}
            {dragKind === 'multi' && `Choose a single ${SUPPORTED_LABEL} file.`}
          </div>
        </div>
      </div>

      {/* in-app notice (used instead of browser alerts) */}
      <div className={`toast ${toast.open ? 'is-open' : ''} ${toast.kind}`} role="alert" aria-live="assertive">
        <span>{toast.text}</span>
        <button className="toast-close" onClick={dismissToast} aria-label="Dismiss">
          ×
        </button>
      </div>

      {/* thin bar along the top while the file itself is uploading */}
      <div className={`top-progress ${uploadStage === 'uploading' && uploadProgress > 0 && uploadProgress < 100 ? 'visible' : ''}`}>
        <div className="top-progress-fill" style={{ width: `${uploadProgress}%` }} />
      </div>

      {/* source preview */}
      <Modal open={previewModal.open} onClose={closePreviewModal} className="preview-modal" label="Source preview">
        <div className="preview-head">
          <div className={`file-icon file-icon-${previewModal.kind || 'text'}`} aria-hidden="true">
            {previewModal.kind === 'text' ? 'TXT' : (previewModal.kind || 'txt').toUpperCase()}
          </div>
          <div className="preview-title">
            <h3 title={previewModal.name}>{previewModal.name}</h3>
            <span className="preview-sub">
              {[
                previewModal.kind === 'text' ? 'Pasted text' : (previewModal.kind || '').toUpperCase(),
                previewModal.size ? formatFileSize(previewModal.size) : '',
                previewModal.chunks != null ? `${previewModal.chunks} chunks indexed` : ''
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          <div className="preview-actions">
            <button className="btn danger-outline" onClick={() => requestDeleteSource(previewModal.id, previewModal.name)} disabled={isBusy}>
              Delete
            </button>
            <button className="close" onClick={closePreviewModal} aria-label="Close preview">
              ×
            </button>
          </div>
        </div>
        <div className="preview-body">
          {previewModal.kind === 'pdf' && previewModal.url ? (
            <iframe src={`${previewModal.url}#view=FitH`} title={previewModal.name} />
          ) : previewModal.kind === 'pdf' ? (
            <div className="preview-empty">
              <strong>The PDF preview isn&apos;t available after a page refresh.</strong>
              <span>The file is still indexed and searchable. Upload it again if you want to view it here.</span>
            </div>
          ) : (
            <pre className="preview-text">{previewModal.text || 'No preview available.'}</pre>
          )}
        </div>
      </Modal>

      {/* delete confirmation (opens on top of the preview) */}
      <Modal open={confirmDelete.open} onClose={cancelDelete} className="confirm-modal" onTop label="Delete source">
        <div className="modal-head">
          <h3>Delete source?</h3>
        </div>
        <p className="confirm-text">
          <strong>{confirmDelete.name || 'This source'}</strong> will be removed from your sources and from the search
          index. This can&apos;t be undone.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={cancelDelete}>
            Cancel
          </button>
          <button className="btn danger" onClick={confirmDeleteNow}>
            Delete
          </button>
        </div>
      </Modal>

      {/* indexing progress */}
      <Modal open={Boolean(uploadStage)} dismissible={false} onTop className="progress-modal" label="Indexing progress">
        <div role="status" aria-live="polite">
          <h3>{shownStage === 'error' ? 'Indexing failed' : 'Indexing your source...'}</h3>
          {shownStage === 'error' ? (
            <p className="upload-error">{uploadError}</p>
          ) : (
            <>
              <div className="progress-stages">
                <div className={`stage ${shownStage === 'uploading' ? 'active' : ''} ${['reading', 'embedding', 'done'].includes(shownStage) ? 'done' : ''}`}>Uploading</div>
                <div className={`stage ${shownStage === 'reading' ? 'active' : ''} ${['embedding', 'done'].includes(shownStage) ? 'done' : ''}`}>Reading</div>
                <div className={`stage ${shownStage === 'embedding' ? 'active' : ''} ${shownStage === 'done' ? 'done' : ''}`}>Embedding</div>
                <div className={`stage ${shownStage === 'done' ? 'active' : ''}`}>Ready</div>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    transform: `scaleX(${
                      (shownStage === 'uploading' ? uploadProgress : shownStage === 'done' ? 100 : embedPercent) / 100
                    })`
                  }}
                />
              </div>
              <div className="upload-text">
                {shownStage === 'uploading' && `Uploading... ${uploadProgress}%`}
                {shownStage !== 'uploading' && (uploadDetail || 'Working...')}
              </div>
            </>
          )}
          <div className="upload-actions">
            {['uploading', 'reading', 'embedding'].includes(shownStage) && (
              <button className="btn" onClick={cancelUpload}>
                Cancel upload
              </button>
            )}
            {shownStage === 'error' && (
              <button className="btn primary" onClick={dismissUploadModal}>
                Close
              </button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default App

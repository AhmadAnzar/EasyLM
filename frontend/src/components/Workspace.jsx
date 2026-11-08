import { useEffect, useRef, useState } from 'react'
import AddSourcesModal from './AddSourcesModal'
import HomePage from './HomePage'
import Modal from './Modal'
import { API_BASE, apiFetch, authHeaders, errorMessage, notifyUnauthorized } from '../api'
import { useAuth } from '../auth/authContext'
import { getFile, putFile, removeFile } from '../fileStore'
import { useGo, workspacePath } from '../nav'

const STORAGE_PREFIX = 'easylm:v1'
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

// The name a source is stored under in the database (pasted texts get a unique one; older ones shared one).
const sourceKey = (source) => source.sourceName || (source.type === 'text' ? 'clipboard-text' : source.name)

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

const DEMO_SEED_MESSAGE = {
  id: 'seed-assistant',
  role: 'assistant',
  text: 'This is a live demo over a sample document about how EasyLM works. Ask anything about it, or pick a question below. Log in to add your own PDFs, CSVs and text.'
}

const DEMO_SUGGESTIONS = [
  'What is retrieval-augmented generation?',
  'How are documents split into chunks?',
  'How many workspaces can each user have?',
  'What are the upload limits?'
]

// The chat and the list of sources survive a page refresh (the vectors already live in the database).
// The demo workspace keeps only its chat: its sources always come from the server.
function loadSavedState(storageKey, seed, keepSources) {
  const fresh = { messages: [seed], sources: [] }
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (!data) return fresh
    const messages = Array.isArray(data.messages)
      ? data.messages.filter((m) => m && m.id && m.status !== 'typing').map(({ status, ...rest }) => rest) // eslint-disable-line no-unused-vars
      : []
    return {
      messages: messages.length ? messages : [seed],
      sources: keepSources && Array.isArray(data.sources) ? data.sources : []
    }
  } catch {
    return fresh
  }
}

// One workspace: its sources, its chat and everything around them. `readOnly` is the shared demo
// workspace that guests use; otherwise this is one of the logged-in user's own workspaces.
function Workspace({ workspaceId, readOnly }) {
  const { user, logout, addWorkspace } = useAuth()
  const go = useGo()
  const storageKey = `${STORAGE_PREFIX}:${workspaceId}`
  const seed = readOnly ? DEMO_SEED_MESSAGE : SEED_MESSAGE
  const typingTimersRef = useRef(new Map())
  const sourcesRef = useRef([])
  const syncRetryRef = useRef(null)
  const dragCounterRef = useRef(0)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [clipboardText, setClipboardText] = useState('')
  const [pdfFile, setPdfFile] = useState(null)
  const [initialState] = useState(() => loadSavedState(storageKey, seed, !readOnly))
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
  const [demoLoading, setDemoLoading] = useState(readOnly) // the demo document is being indexed on the server
  const [serverWaking, setServerWaking] = useState(false) // the free host is starting up after being idle
  const [previewModal, setPreviewModal] = useState({ open: false, url: '', name: '' })
  const [citationModal, setCitationModal] = useState({ open: false, number: 1, text: '', source: '', page: null, row: null })
  const [confirmDelete, setConfirmDelete] = useState({ open: false, id: null, name: '' })

  const siteName = 'EasyLM'
  const apiBaseUrl = API_BASE
  const hasSource = sources.length > 0

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
      localStorage.setItem(storageKey, JSON.stringify({ messages: savedMessages, sources: readOnly ? [] : savedSources }))
    } catch {
      // storage can be unavailable (private window, quota); the app works without it
    }
  }, [messages, sources, storageKey, readOnly])

  useEffect(() => {
    document.title = readOnly ? `${siteName} · Live demo` : `${siteName} · Workspace`
  }, [readOnly])

  // Bring back the original PDFs kept in this browser, so their preview works after a refresh.
  useEffect(() => {
    let stopped = false
    initialState.sources
      .filter((source) => source.type === 'pdf')
      .forEach(async (source) => {
        const file = await getFile(source.id)
        if (!file || stopped) return
        const previewUrl = URL.createObjectURL(file)
        setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, previewUrl } : s)))
      })
    return () => {
      stopped = true
    }
  }, [initialState])

  useEffect(() => {
    const typingTimers = typingTimersRef.current // the same Map for the whole life of the component
    return () => {
      clearInterval(pollTimerRef.current)
      clearTimeout(toastTimerRef.current)
      clearTimeout(syncRetryRef.current)
      typingTimers.forEach((timerId) => clearInterval(timerId))
      typingTimers.clear()
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

  // The database is the source of truth: on load, make the list match what is really indexed. Sources
  // that were indexed but are missing here (cleared browser data, another browser) come back, and ones
  // that are gone from the database (cleared, different collection) are dropped from the list.
  const syncSourcesWithServer = async () => {
    // A sleeping free host can take a minute to answer; say so instead of looking broken.
    const wakingTimer = setTimeout(() => setServerWaking(true), 3500)
    try {
      const resp = await apiFetch(`${apiBaseUrl}/sources?workspace=${encodeURIComponent(workspaceId)}`)
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
        showToast('That workspace is not available for this account.')
        return
      }
      if (!resp.ok) return // e.g. the vector database is unreachable: keep what we have
      const data = await resp.json()
      setDemoLoading(Boolean(data.loading))
      if (data.loading) syncRetryRef.current = setTimeout(syncSourcesWithServer, 2500)
      const remote = Array.isArray(data.sources) ? data.sources : []
      const remoteByName = new Map(remote.map((r) => [r.name, r]))

      const next = []
      const known = new Set()
      let removed = 0
      let changed = false
      sourcesRef.current.forEach((source) => {
        const match = remoteByName.get(sourceKey(source))
        if (!match) {
          removed += 1
          removeFile(source.id)
          if (source.previewUrl) URL.revokeObjectURL(source.previewUrl)
          return
        }
        known.add(match.name)
        if (match.chunks !== source.chunks) changed = true
        next.push({ ...source, chunks: match.chunks })
      })

      let added = 0
      let textCount = next.filter((s) => s.type === 'text').length
      remote.forEach((r) => {
        if (known.has(r.name) || next.length >= MAX_SOURCES) return
        added += 1
        if (r.type === 'text') textCount += 1
        next.push({
          id: `recovered-${r.name}`,
          type: ['pdf', 'csv', 'text'].includes(r.type) ? r.type : 'text',
          name: r.type === 'text' ? `Pasted text ${textCount}` : r.name,
          sourceName: r.name,
          preview: '',
          // the demo's PDF is served by the backend, so guests can preview it too
          previewUrl: readOnly && r.type === 'pdf' ? `${apiBaseUrl}/demo/file/${encodeURIComponent(r.name)}` : undefined,
          chunks: r.chunks,
          recovered: true
        })
      })

      if (!added && !removed && !changed) return
      setSources(next)
      if ((added || removed) && !readOnly) {
        const parts = [added && `${added} added`, removed && `${removed} removed`].filter(Boolean).join(', ')
        showToast(`Your sources were synced with the database (${parts}).`, 'info')
      }
    } catch {
      // backend not reachable yet: the list stays as saved in this browser
    } finally {
      clearTimeout(wakingTimer)
      setServerWaking(false)
    }
  }

  // Make the source list match the database as soon as the workspace opens.
  useEffect(() => {
    syncSourcesWithServer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    if (readOnly) {
      showToast('The demo is read-only. Log in to add your own documents.', 'info')
      return
    }
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
      if (readOnly) return
      dragCounterRef.current += 1
      setDragKind(classifyDrag(e.dataTransfer))
      setIsDragging(true)
    }

    const onDocDragOver = (e) => {
      e.preventDefault()
      if (readOnly) return
      const kind = classifyDrag(e.dataTransfer)
      setDragKind(kind) // bails out when unchanged, so this is cheap even though dragover fires constantly
      if (e.dataTransfer) e.dataTransfer.dropEffect = kind === 'ok' ? 'copy' : 'none' // "not allowed" cursor
    }

    const onDocDragLeave = (e) => {
      e.preventDefault()
      if (readOnly) return
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
  }, [readOnly])

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

  const stopProgressPolling = () => {
    clearInterval(pollTimerRef.current)
    pollTimerRef.current = null
  }

  // Poll the backend for the real indexing stage (parsing, chunking, embedding n/N, ...).
  const startProgressPolling = (jobId) => {
    stopProgressPolling()
    pollTimerRef.current = setInterval(async () => {
      try {
        const resp = await apiFetch(`${apiBaseUrl}/progress/${jobId}`)
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

  const readErrorMessage = (status, bodyText) => errorMessage(status, bodyText, 'Upload failed')

  // Cancel takes effect in the UI immediately; the server stops its work as soon as it sees the flag.
  const cancelUpload = () => {
    cancelledRef.current = true
    xhrRef.current?.abort()
    abortRef.current?.abort()
    if (jobIdRef.current) {
      apiFetch(`${apiBaseUrl}/cancel/${jobIdRef.current}`, { method: 'POST' }).catch(() => {})
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
        const resp = await apiFetch(`${apiBaseUrl}/upload-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed, job_id: jobId, source_name: textSourceName, workspace: workspaceId }),
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
          formData.append('workspace', workspaceId)
          xhr.open('POST', `${apiBaseUrl}/upload`)
          Object.entries(authHeaders()).forEach(([name, value]) => xhr.setRequestHeader(name, value))

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
              if (xhr.status === 401) notifyUnauthorized()
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
        const newId = `file-${Date.now()}`
        // The database replaced any earlier source with the same name, so the list must do the same.
        sourcesRef.current
          .filter((s) => sourceKey(s) === file.name)
          .forEach((old) => {
            removeFile(old.id)
            if (old.previewUrl) URL.revokeObjectURL(old.previewUrl)
          })
        setSources((prev) => [
          ...prev.filter((s) => sourceKey(s) !== file.name),
          {
            id: newId,
            type: fileType,
            name: file.name,
            sourceName: file.name,
            preview: csvPreview,
            previewUrl,
            size: file.size,
            chunks: data.total_chunks ?? 0
          }
        ])
        // keep the original PDF in this browser so the preview survives a refresh
        if (fileType === 'pdf') putFile(newId, file)
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
      const resp = await apiFetch(`${apiBaseUrl}/delete-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_name: sourceKey(found), workspace: workspaceId })
      })
      if (!resp.ok) throw new Error('Failed to delete source from database')

      // fade the card out, then drop it from the list
      setSources((prev) => prev.map((s) => (s.id === id ? { ...s, removing: true } : s)))
      removeFile(found.id)
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
    setMessages([seed])
    setIsBusy(false)
  }

  const clearSources = async () => {
    setIsBusy(true)
    try {
      const resp = await apiFetch(`${apiBaseUrl}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: workspaceId })
      })
      if (!resp.ok) throw new Error('Failed to clear database')

      sources.forEach((source) => {
        if (source.previewUrl) {
          URL.revokeObjectURL(source.previewUrl)
        }
      })
      setSources([])
      sources.forEach((source) => removeFile(source.id)) // only this workspace's stored files
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

  const sendMessage = async (suggested) => {
    const trimmed = (typeof suggested === 'string' ? suggested : input).trim()
    if (!trimmed || isBusy) {
      return
    }

    // The demo always has a document on the server (or is still preparing it), so let the server answer.
    if (!hasSource && !readOnly) {
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
      const response = await apiFetch(`${apiBaseUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, history, workspace: workspaceId })
      })

      if (!response.ok) {
        throw new Error(readErrorMessage(response.status, await response.text()).replace(/^Upload failed/, 'Query failed'))
      }

      const data = await response.json()
      // newer servers describe each passage (text, file, page); older ones send the bare text
      const citationChunks = (Array.isArray(data.citations) && data.citations.length ? data.citations : data.source_chunks || [])
        .slice(0, 4)

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

  const switchWorkspace = (n) => go(workspacePath(user.username, n))

  const createWorkspace = async () => {
    try {
      const created = await addWorkspace()
      go(workspacePath(user.username, created.n))
    } catch (err) {
      showToast(err.message)
    }
  }

  const leave = () => {
    logout()
    go('/')
  }

  // keep showing the last stage while the progress dialog fades out
  const lastStageRef = useRef('uploading')
  if (uploadStage) lastStageRef.current = uploadStage
  const shownStage = uploadStage || lastStageRef.current

  return (
    <div className={`app ${isDragging ? 'is-dragging' : ''}`}>
      <HomePage
        siteName={siteName}
        hasSource={hasSource}
        sources={sources}
        maxSources={MAX_SOURCES}
        messages={messages}
        input={input}
        onInputChange={setInput}
        onSend={() => sendMessage()}
        onOpenModal={() => setIsModalOpen(true)}
        onClearSources={clearSources}
        onNewChat={newChat}
        isBusy={isBusy}
        busyLabel={uploadStage ? 'Indexing...' : 'Thinking...'}
        onEnterSend={() => sendMessage()}
        onPreviewSource={openPreviewModal}
        onRemoveSource={requestDeleteSource}
        isDragging={isDragging}
        readOnly={readOnly}
        user={user}
        workspaceId={workspaceId}
        onSwitchWorkspace={switchWorkspace}
        onNewWorkspace={createWorkspace}
        onLogout={leave}
        onLogin={() => go('/login')}
        suggestions={readOnly && messages.length <= 1 ? DEMO_SUGGESTIONS : []}
        onSuggest={sendMessage}
        onOpenCitation={(citation, number) =>
          setCitationModal({
            open: true,
            number,
            text: citation.text || '',
            source: citation.source || '',
            page: citation.page ?? null,
            row: citation.row ?? null
          })
        }
        notice={
          serverWaking
            ? 'Waking up the server. It runs on free hosting that sleeps when idle, so the first visit can take up to a minute.'
            : readOnly && demoLoading
              ? 'Preparing the demo document. This takes a few seconds.'
              : ''
        }
      />

      <AddSourcesModal
        open={isModalOpen && !readOnly}
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

      {/* the passage a citation points to */}
      <Modal
        open={citationModal.open}
        onClose={() => setCitationModal((prev) => ({ ...prev, open: false }))}
        className="citation-modal"
        label="Citation"
      >
        <div className="modal-head">
          <h3>Citation [{citationModal.number}]</h3>
          <button className="close" onClick={() => setCitationModal((prev) => ({ ...prev, open: false }))} aria-label="Close citation">
            ×
          </button>
        </div>
        {(citationModal.source || citationModal.page != null || citationModal.row != null) && (
          <div className="citation-source">
            {citationModal.source && <strong>{citationModal.source}</strong>}
            {citationModal.page != null && <span className="count-pill">Page {citationModal.page}</span>}
            {citationModal.row != null && <span className="count-pill">Row {citationModal.row}</span>}
          </div>
        )}
        <pre className="citation-text">{citationModal.text}</pre>
      </Modal>

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
            {!readOnly && (
              <button className="btn danger-outline" onClick={() => requestDeleteSource(previewModal.id, previewModal.name)} disabled={isBusy}>
                Delete
              </button>
            )}
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
              <strong>This PDF isn&apos;t stored in this browser, so it can&apos;t be previewed here.</strong>
              <span>It is still indexed and searchable. Upload it again if you want to view it here.</span>
            </div>
          ) : (
            <pre className="preview-text">
              {previewModal.text ||
                "The original content isn't stored in this browser, but this source is still indexed and searchable."}
            </pre>
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

export default Workspace

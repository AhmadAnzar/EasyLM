import { useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import './App.css'
import AddSourcesModal from './components/AddSourcesModal'
import HomePage from './components/HomePage'
import LandingPage from './components/LandingPage'

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const typingTimersRef = useRef(new Map())
  const sourcesRef = useRef([])
  const dragCounterRef = useRef(0)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [clipboardText, setClipboardText] = useState('')
  const [pdfFile, setPdfFile] = useState(null)
  const [sources, setSources] = useState([])
  const [messages, setMessages] = useState([
    {
      id: 'seed-assistant',
      role: 'assistant',
      text: 'Add one or more sources (clipboard text or files), then ask your question. EasyLM will retrieve context across all active sources collectively.'
    }
  ])
  const [input, setInput] = useState('')
  const [sourceMode, setSourceMode] = useState('text')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadStage, setUploadStage] = useState('') // '', 'uploading', 'chunking', 'embedding', 'done'
  const [isBusy, setIsBusy] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [previewModal, setPreviewModal] = useState({ open: false, url: '', name: '' })
  const [confirmDelete, setConfirmDelete] = useState({ open: false, id: null, name: '' })

  const siteName = 'EasyLM'
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:10000').replace(/\/$/, '')
  const hasSource = sources.length > 0
  const onHomePage = location.pathname === '/home'

  useEffect(() => {
    sourcesRef.current = sources
  }, [sources])

  useEffect(() => {
    return () => {
      typingTimersRef.current.forEach((timerId) => clearInterval(timerId))
      typingTimersRef.current.clear()
      sourcesRef.current.forEach((source) => {
        if (source.previewUrl) {
          URL.revokeObjectURL(source.previewUrl)
        }
      })
    }
  }, [])

  useEffect(() => {
    // expose upload progress for modal (simple bridge)
    try {
      window.__UPLOAD_PROGRESS__ = uploadProgress
    } catch (e) {}
  }, [uploadProgress])

  // Drag & drop handlers for entire app: accept supported files or plain text drops
  const handleDragOver = (e) => {
    e.preventDefault()
  }

  const handleDragEnter = (e) => {
    e.preventDefault()
    dragCounterRef.current = (dragCounterRef.current || 0) + 1
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    dragCounterRef.current = Math.max(0, (dragCounterRef.current || 0) - 1)
    if (dragCounterRef.current === 0) setIsDragging(false)
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)

    // Files first
    const files = e.dataTransfer?.files
    if (files && files.length) {
      const file = files[0]
      const fileName = file.name?.toLowerCase() || ''
      const isSupportedFile =
        file.type === 'application/pdf' ||
        file.type === 'text/csv' ||
        fileName.endsWith('.pdf') ||
        fileName.endsWith('.csv')

      if (isSupportedFile) {
        setSourceMode('pdf')
        setPdfFile(file)
        // auto-save the dropped file
        // slight delay to ensure state updates
        setTimeout(() => saveSource(), 80)
        return
      }
    }

    // fallback: text/plain drop
    try {
      const text = e.dataTransfer.getData('text/plain')
      if (text && text.trim()) {
        setSourceMode('text')
        setClipboardText(text)
        setTimeout(() => saveSource(), 80)
      }
    } catch (err) {
      // ignore
    }
  }

  // ensure drag/drop works anywhere on the page by attaching document-level listeners
  useEffect(() => {
    const onDocDragEnter = (e) => {
      e.preventDefault()
      dragCounterRef.current = (dragCounterRef.current || 0) + 1
      setIsDragging(true)
    }

    const onDocDragOver = (e) => {
      e.preventDefault()
    }

    const onDocDragLeave = (e) => {
      e.preventDefault()
      dragCounterRef.current = Math.max(0, (dragCounterRef.current || 0) - 1)
      if (dragCounterRef.current === 0) setIsDragging(false)
    }

    const onDocDrop = (e) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragging(false)
      handleDrop(e)
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
  }, [handleDrop])

  const openPreviewModal = (source) => {
    if (!source) return
    if (source.type === 'pdf' && source.previewUrl) {
      setPreviewModal({ open: true, url: source.previewUrl, name: source.name, id: source.id, type: 'pdf', text: '' })
    } else {
      setPreviewModal({ open: true, url: '', name: source.name, id: source.id, type: 'text', text: source.preview || '' })
    }
  }

  const closePreviewModal = () => setPreviewModal({ open: false, url: '', name: '' })

  const requestDeleteSource = (id, name) => setConfirmDelete({ open: true, id, name })

  const confirmDeleteNow = () => {
    if (confirmDelete.id) removeSource(confirmDelete.id)
    setConfirmDelete({ open: false, id: null, name: '' })
  }

  const cancelDelete = () => setConfirmDelete({ open: false, id: null, name: '' })

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
    const stepSize = Math.max(1, Math.ceil(fullText.length / 42))
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
    navigate('/home')
  }

  const saveSource = async () => {
    const trimmed = clipboardText.trim()
    const hasText = sourceMode === 'text' && Boolean(trimmed)
    const hasPdf = sourceMode === 'pdf' && Boolean(pdfFile)
    if (!hasText && !hasPdf) {
      return
    }

    if (sources.length >= 5) {
      setMessages((prev) => [
        ...prev,
        {
          id: `source-limit-${Date.now()}`,
          role: 'assistant',
          variant: 'warning',
          text: 'You can keep up to 5 sources at the same time. Remove one to add another.'
        }
      ])
      return
    }

    setIsBusy(true)
    setUploadStage('uploading')

    try {
      let data = {}

      if (sourceMode === 'text') {
        const resp = await fetch(`${apiBaseUrl}/upload-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed })
        })
        if (!resp.ok) throw new Error(`Upload failed (${resp.status})`)
        data = await resp.json()
        // simulate server chunking/embedding stages briefly for UX
        setUploadStage('chunking')
        await new Promise((r) => setTimeout(r, 600))
        setUploadStage('embedding')
        await new Promise((r) => setTimeout(r, 900))
        setUploadStage('done')
        setTimeout(() => setUploadStage(''), 700)
      } else {
        // use XHR so we can track upload progress for large files
        data = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          const formData = new FormData()
          formData.append('file', pdfFile)
          xhr.open('POST', `${apiBaseUrl}/upload`)

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100)
              setUploadProgress(pct)
            }
          }

          xhr.onload = async () => {
            try {
              if (xhr.status >= 200 && xhr.status < 300) {
                const parsed = JSON.parse(xhr.responseText || '{}')
                // server likely already did chunking/embedding, but present staged UX
                resolve(parsed)
                setUploadStage('chunking')
                await new Promise((r) => setTimeout(r, 600))
                setUploadStage('embedding')
                await new Promise((r) => setTimeout(r, 900))
                setUploadStage('done')
                setTimeout(() => setUploadStage(''), 700)
              } else {
                reject(new Error(`Upload failed (${xhr.status})`))
              }
            } catch (err) {
              reject(err)
            }
          }

          xhr.onerror = () => reject(new Error('Network error'))
          xhr.send(formData)
        })
        // leave progress visible until done -> reset later
      }

      if (sourceMode === 'text') {
        setSources((prev) => [
          ...prev,
          {
            id: `text-${Date.now()}`,
            type: 'text',
            name: `Pasted text ${prev.length + 1}`,
            preview: trimmed.slice(0, 180)
          }
        ])
      } else {
        const previewUrl = URL.createObjectURL(pdfFile)
        const fileName = pdfFile.name.toLowerCase()
        const fileType = fileName.endsWith('.csv') ? 'csv' : 'pdf'
        const newId = `file-${Date.now()}`
        setSources((prev) => [
          ...prev,
          {
            id: newId,
            type: fileType,
            name: pdfFile.name,
            preview: `File uploaded: ${pdfFile.name}`,
            previewUrl: fileType === 'pdf' ? previewUrl : undefined
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
      const message = error instanceof Error ? error.message : 'Upload failed.'
      setMessages((prev) => [
        ...prev,
        {
          id: `source-error-${Date.now()}`,
          role: 'assistant',
          variant: 'error',
          text: `Could not index source: ${message}`
        }
      ])
    } finally {
      setIsBusy(false)
    }
  }

  const removeSource = async (id) => {
    const found = sources.find((s) => s.id === id)
    if (!found) return

    setIsBusy(true)
    try {
      const sourceName = found.type === 'text' ? 'clipboard-text' : found.name
      const resp = await fetch(`${apiBaseUrl}/delete-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_name: sourceName })
      })
      if (!resp.ok) throw new Error('Failed to delete source from database')

      if (found.previewUrl) URL.revokeObjectURL(found.previewUrl)
      setSources((prev) => prev.filter((s) => s.id !== id))
      
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
        { id: `user-${Date.now()}`, role: 'user', text: trimmed },
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: 'Please add a source first using Add Sources.'
        }
      ])
      setInput('')
      return
    }

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
        body: JSON.stringify({ query: trimmed })
      })

      if (!response.ok) {
        throw new Error(`Query failed (${response.status})`)
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
      animateAssistantMessage(assistantMessageId, `Error calling backend: ${message}`, () =>
        setIsBusy(false)
      )
    }
  }

  return (
    <div className={`app ${isDragging ? 'is-dragging' : ''}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDrop={handleDrop}>
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
              onBackToLanding={() => navigate('/')}
              isBusy={isBusy}
              onEnterSend={sendMessage}
              onPreviewSource={openPreviewModal}
              onRemoveSource={requestDeleteSource}
                isDragging={isDragging}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {onHomePage && isModalOpen && (
        <AddSourcesModal
          sourceMode={sourceMode}
          clipboardText={clipboardText}
          pdfFile={pdfFile}
          onChangeMode={setSourceMode}
          onChangeClipboardText={setClipboardText}
          onChangePdfFile={setPdfFile}
          onCancel={closeModal}
          onSave={saveSource}
          isBusy={isBusy}
          uploadProgress={uploadProgress}
          isDragging={isDragging}
        />
      )}

      <div className={`drop-overlay ${isDragging ? 'active' : ''}`}>
        <div className="drop-card">Release anywhere to drop</div>
      </div>

      {/* top upload progress bar */}
      <div className={`top-progress ${uploadProgress > 0 && uploadProgress < 100 ? 'visible' : ''} ${uploadStage === 'chunking' || uploadStage === 'embedding' ? 'indeterminate' : ''}`}>
        <div className="top-progress-fill" style={{ width: uploadStage === 'chunking' || uploadStage === 'embedding' ? undefined : `${uploadProgress}%` }} />
      </div>

      {/* pdf preview modal (in-app) */}
      {previewModal.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closePreviewModal()
            }
          }}
        >
          <div className="modal" style={{ width: 'min(900px, 95%)', height: '80vh', padding: 12 }}>
            <div className="modal-head">
              <h3>{previewModal.name}</h3>
              <div>
                <button className="btn ghost" onClick={() => requestDeleteSource(previewModal.id, previewModal.name)} title="Delete">
                  Delete
                </button>
                <button className="close" onClick={closePreviewModal}>x</button>
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {previewModal.type === 'pdf' ? (
                <iframe src={previewModal.url} title={previewModal.name} style={{ width: '100%', height: '100%' }} />
              ) : (
                <div style={{ padding: 12, color: '#4b2b12' }}>{previewModal.text}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* delete confirm modal */}
      {confirmDelete.open && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              cancelDelete()
            }
          }}
        >
          <div className="modal">
            <div className="modal-head">
              <h3>Delete source</h3>
            </div>
            <p>Are you sure you want to delete {confirmDelete.name || 'this source'}?</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn" onClick={cancelDelete}>Cancel</button>
              <button className="btn primary" onClick={confirmDeleteNow}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* upload progress modal with stages */}
      <div
        className={`upload-progress-modal ${uploadStage ? 'visible' : ''}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setUploadStage('')
          }
        }}
      >
        <div className="progress-card">
          <h3>Indexing your source...</h3>
          <div className="progress-stages">
            <div className={`stage ${uploadStage === 'uploading' ? 'active' : ''} ${['chunking', 'embedding', 'done'].includes(uploadStage) ? 'done' : ''}`}>Uploading</div>
            <div className={`stage ${uploadStage === 'chunking' ? 'active' : ''} ${['embedding', 'done'].includes(uploadStage) ? 'done' : ''}`}>Chunking</div>
            <div className={`stage ${uploadStage === 'embedding' ? 'active' : ''} ${uploadStage === 'done' ? 'done' : ''}`}>Embedding</div>
            <div className={`stage ${uploadStage === 'done' ? 'active' : ''}`}>Ready</div>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
          <div className="upload-text">
            {uploadStage === 'uploading' && `Uploading... ${uploadProgress}%`}
            {uploadStage === 'chunking' && 'Breaking content into chunks...'}
            {uploadStage === 'embedding' && 'Generating embeddings...'}
            {uploadStage === 'done' && 'Ready to chat!'}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App

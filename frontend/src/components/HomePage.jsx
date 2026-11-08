import { useEffect, useRef } from 'react'

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  )
}

function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function SourceCard({ source, disabled, onPreview, onRemove }) {
  const badge = source.type === 'text' ? 'TXT' : source.type.toUpperCase()
  const kindLabel = source.type === 'text' ? 'Pasted text' : badge
  const meta = [
    kindLabel,
    formatBytes(source.size),
    source.chunks != null ? `${source.chunks} chunk${source.chunks === 1 ? '' : 's'}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={`source-card ${source.removing ? 'is-removing' : ''}`}>
      <div className={`file-icon file-icon-${source.type}`} aria-hidden="true">
        {badge}
      </div>
      <div className="source-main">
        <div className="source-name" title={source.name}>
          {source.name}
        </div>
        <div className="source-meta">{meta}</div>
      </div>
      <div className="source-actions">
        <button className="icon-btn" title="Preview" aria-label={`Preview ${source.name}`} onClick={() => onPreview(source)}>
          <EyeIcon />
        </button>
        <button
          className="icon-btn danger"
          title="Remove this source"
          aria-label={`Remove ${source.name}`}
          disabled={disabled}
          onClick={() => onRemove(source.id, source.name)}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  )
}

function HomePage({
  siteName,
  hasSource,
  sources,
  maxSources = 5,
  messages,
  input,
  onInputChange,
  onSend,
  onOpenModal,
  onClearSources,
  onNewChat,
  isBusy,
  busyLabel = 'Thinking...',
  onEnterSend,
  onPreviewSource,
  onRemoveSource,
  isDragging
}) {
  const messagesContainerRef = useRef(null)
  const lastMessageCountRef = useRef(0)

  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return
    // Smooth-scroll only when a new message arrives. While an answer is being typed out the
    // text changes every tick, and restarting a smooth scroll that often made the chat janky.
    const isNewMessage = messages.length !== lastMessageCountRef.current
    lastMessageCountRef.current = messages.length
    container.scrollTo({ top: container.scrollHeight, behavior: isNewMessage ? 'smooth' : 'auto' })
  }, [messages])

  return (
    <section className="workspace">
      <header className={`topbar ${isDragging ? 'drop-zone' : ''}`}>
        <div className="title-wrap">
          <h2>{siteName} Home</h2>
        </div>
        <div className="topbar-actions">
          <button className="btn primary" onClick={onOpenModal} disabled={isBusy}>
            Add Sources
          </button>
          <button className="btn" onClick={onClearSources} disabled={isBusy || !hasSource}>
            Clear Sources
          </button>
        </div>
      </header>

      <div className="app-grid">
        <aside className={`source-summary ${isDragging ? 'drop-zone' : ''}`}>
          <div className="section-head">
            <h3>Sources</h3>
            <span className="count-pill">
              {sources.length}/{maxSources}
            </span>
          </div>

          {hasSource ? (
            <div className="source-list">
              {sources.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  disabled={isBusy}
                  onPreview={onPreviewSource}
                  onRemove={onRemoveSource}
                />
              ))}
            </div>
          ) : (
            <button type="button" className="source-empty" onClick={onOpenModal} disabled={isBusy}>
              <span className="source-empty-icon" aria-hidden="true">
                +
              </span>
              <strong>Add your first source</strong>
              <span>Drop a PDF or CSV anywhere on the page, or paste some text.</span>
            </button>
          )}

          <div className="source-hint">You can keep up to {maxSources} sources at the same time.</div>
        </aside>

        <div className={`chat-box ${isDragging ? 'drop-zone' : ''}`}>
          <div className="section-head">
            <h3>Chat</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="badge online">Ready</span>
              <button className="btn" onClick={onNewChat} disabled={isBusy || messages.length <= 1} style={{ padding: '6px 12px', fontSize: '12px' }}>
                New chat
              </button>
              <button className="btn primary" onClick={onOpenModal} disabled={isBusy} style={{ padding: '6px 12px', fontSize: '12px' }}>
                + Add Source
              </button>
            </div>
          </div>

          <div className="messages" ref={messagesContainerRef} aria-live="polite">
            {messages.map((msg, index) => (
              <div
                key={msg.id || `${msg.role}-${index}`}
                className={`bubble ${msg.role} ${msg.variant || ''} ${msg.status === 'streaming' ? 'streaming' : ''}`}
              >
                {msg.status === 'typing' ? (
                  <span className="typing-state" aria-label="Assistant is typing">
                    <span className="typing-label">Thinking</span>
                    <span className="typing-dots" aria-hidden="true">
                      <i></i>
                      <i></i>
                      <i></i>
                    </span>
                  </span>
                ) : (
                  <MessageWithCitations text={msg.text} citations={msg.citations || []} />
                )}
              </div>
            ))}
          </div>

          <div className="composer">
            <input
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              placeholder={hasSource ? 'Ask a question about your sources' : 'Add a source to get started'}
              aria-label="Question input"
              disabled={isBusy}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  onEnterSend()
                }
              }}
            />
            <button className="btn primary" onClick={onSend} disabled={isBusy}>
              {isBusy ? busyLabel : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function MessageWithCitations({ text, citations }) {
  if (!text) {
    return null
  }

  const visibleCitations = Array.isArray(citations) ? citations.filter(Boolean).slice(0, 4) : []

  return (
    <div className="message-body">
      <div className="message-text">{text}</div>
      {visibleCitations.length > 0 && (
        <div className="citation-row">
          <span className="citation-label">Citations:</span>
          {visibleCitations.map((citation, index) => (
            <span key={`${index}-${citation.slice(0, 20)}`} className="citation-chip" title={previewCitation(citation)}>
              [{index + 1}]
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function previewCitation(text) {
  const compactText = text.replace(/\s+/g, ' ').trim()
  const sentenceMatch = compactText.match(/^(.+?[.!?])\s/)
  if (sentenceMatch) {
    return sentenceMatch[1]
  }

  return compactText.length > 180 ? `${compactText.slice(0, 180)}...` : compactText
}

export default HomePage

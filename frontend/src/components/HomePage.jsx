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

function BotIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="8" width="16" height="11" rx="4" />
      <path d="M12 8V5" />
      <circle cx="12" cy="4" r="1" />
      <circle cx="9" cy="13" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.1" fill="currentColor" stroke="none" />
      <path d="M9.5 16.2h5" />
      <path d="M2 12v3M22 12v3" />
    </svg>
  )
}

function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function SourceCard({ source, disabled, readOnly, onPreview, onRemove }) {
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
        {!readOnly && (
          <button
            className="icon-btn danger"
            title="Remove this source"
            aria-label={`Remove ${source.name}`}
            disabled={disabled}
            onClick={() => onRemove(source.id, source.name)}
          >
            <TrashIcon />
          </button>
        )}
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
  isDragging,
  readOnly = false,
  user = null,
  workspaceId,
  onSwitchWorkspace,
  onNewWorkspace,
  onLogout,
  onLogin,
  suggestions = [],
  onSuggest,
  onOpenCitation,
  notice = ''
}) {
  const userInitial = user ? user.username.charAt(0).toUpperCase() : 'G'
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
          <h2>{siteName}</h2>
          {readOnly ? (
            <span className="ws-chip demo">Live demo · read-only</span>
          ) : (
            user && (
              <div className="ws-switcher">
                <select
                  className="ws-select"
                  aria-label="Workspace"
                  value={Number(workspaceId.split(':')[1])}
                  disabled={isBusy}
                  onChange={(event) => onSwitchWorkspace(Number(event.target.value))}
                >
                  {user.workspaces.map((ws) => (
                    <option key={ws.n} value={ws.n}>
                      {ws.name}
                    </option>
                  ))}
                </select>
                <button className="ws-new" onClick={onNewWorkspace} disabled={isBusy || user.workspaces.length >= 5} title="Create another workspace">
                  + New
                </button>
              </div>
            )
          )}
        </div>
        <div className="topbar-actions">
          {!readOnly && (
            <>
              <button className="btn primary" onClick={onOpenModal} disabled={isBusy}>
                Add Sources
              </button>
              <button className="btn" onClick={onClearSources} disabled={isBusy || !hasSource}>
                Clear Sources
              </button>
            </>
          )}
          {user ? (
            <div className="user-chip">
              <span className="avatar" aria-hidden="true">
                {user.username.charAt(0).toUpperCase()}
              </span>
              <span className="user-name">{user.username}</span>
              <button className="btn" onClick={onLogout} disabled={isBusy}>
                Log out
              </button>
            </div>
          ) : (
            <button className="btn primary" onClick={onLogin}>
              Log in / Sign up
            </button>
          )}
        </div>
      </header>

      <div className="app-grid">
        <aside className={`source-summary ${isDragging ? 'drop-zone' : ''}`}>
          <div className="section-head">
            <h3>Sources</h3>
            <span className="count-pill">
              {readOnly ? sources.length : `${sources.length}/${maxSources}`}
            </span>
          </div>

          {hasSource ? (
            <div className="source-list">
              {sources.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  disabled={isBusy}
                  readOnly={readOnly}
                  onPreview={onPreviewSource}
                  onRemove={onRemoveSource}
                />
              ))}
            </div>
          ) : readOnly ? (
            <div className="source-empty is-static">
              <span className="source-empty-icon spinner" aria-hidden="true"></span>
              <strong>Loading the demo document</strong>
              <span>It will appear here in a moment.</span>
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

          <div className="source-hint">
            {readOnly
              ? 'The demo is read-only. Log in to add and manage your own sources.'
              : `You can keep up to ${maxSources} sources at the same time.`}
          </div>
        </aside>

        <div className={`chat-box ${isDragging ? 'drop-zone' : ''}`}>
          <div className="section-head">
            <h3>Chat</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="badge online">Ready</span>
              <button className="btn" onClick={onNewChat} disabled={isBusy || messages.length <= 1} style={{ padding: '6px 12px', fontSize: '12px' }}>
                New chat
              </button>
              {!readOnly && (
                <button className="btn primary" onClick={onOpenModal} disabled={isBusy} style={{ padding: '6px 12px', fontSize: '12px' }}>
                  + Add Source
                </button>
              )}
            </div>
          </div>

          {notice && (
            <div className="notice-banner" role="status">
              <span className="notice-dot" aria-hidden="true"></span>
              {notice}
            </div>
          )}

          <div className="messages" ref={messagesContainerRef} aria-live="polite">
            {messages.map((msg, index) => (
              <div key={msg.id || `${msg.role}-${index}`} className={`msg-row ${msg.role}`}>
                {msg.role === 'user' ? (
                  <span className="msg-avatar user" title={user ? user.username : 'Guest'} aria-hidden="true">
                    {userInitial}
                  </span>
                ) : (
                  <span className="msg-avatar bot" title="EasyLM" aria-hidden="true">
                    <BotIcon />
                  </span>
                )}
                <div className={`bubble ${msg.role} ${msg.variant || ''} ${msg.status === 'streaming' ? 'streaming' : ''}`}>
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
                    <MessageWithCitations text={msg.text} citations={msg.citations || []} onOpenCitation={onOpenCitation} />
                  )}
                </div>
              </div>
            ))}
          </div>

          {suggestions.length > 0 && (
            <div className="suggestions" aria-label="Suggested questions">
              {suggestions.map((question) => (
                <button key={question} type="button" className="suggestion" disabled={isBusy} onClick={() => onSuggest(question)}>
                  {question}
                </button>
              ))}
            </div>
          )}

          <div className="composer">
            <input
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              placeholder={hasSource || readOnly ? 'Ask a question about your sources' : 'Add a source to get started'}
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

// Older saved chats stored a citation as plain text; newer ones carry the source and page too.
const asCitation = (citation) => (typeof citation === 'string' ? { text: citation } : citation)

function MessageWithCitations({ text, citations, onOpenCitation }) {
  if (!text) {
    return null
  }

  const visibleCitations = Array.isArray(citations) ? citations.filter(Boolean).map(asCitation).slice(0, 4) : []

  return (
    <div className="message-body">
      <div className="message-text">{text}</div>
      {visibleCitations.length > 0 && (
        <div className="citation-row">
          <span className="citation-label">Citations:</span>
          {visibleCitations.map((citation, index) => (
            <button
              key={`${index}-${(citation.text || '').slice(0, 20)}`}
              type="button"
              className="citation-chip"
              title={previewCitation(citation.text || '')}
              aria-label={`Open citation ${index + 1}`}
              onClick={() => onOpenCitation?.(citation, index + 1)}
            >
              [{index + 1}]
            </button>
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

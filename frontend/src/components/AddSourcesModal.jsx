function AddSourcesModal({
  sourceMode,
  clipboardText,
  pdfFile,
  onChangeMode,
  onChangeClipboardText,
  onChangePdfFile,
  onCancel,
  onSave,
  isBusy,
  isDragging
}) {
  const displayFileName = pdfFile
    ? pdfFile.name.length > 60
      ? `${pdfFile.name.slice(0, 60)}...`
      : pdfFile.name
    : 'No file selected'

  const onDragOver = (e) => {
    e.preventDefault()
  }

  const onDrop = (e) => {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (files && files.length) {
      const file = files[0]
      onChangeMode('pdf')
      onChangePdfFile(file)
    } else {
      const text = e.dataTransfer.getData('text/plain')
      if (text) onChangeClipboardText(text)
    }
  }
  // optionally show progress if parent supplies it via window state (App passes uploadProgress prop)
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onCancel()
        }
      }}
    >
      <div className={`modal ${isDragging ? 'drop-zone' : ''}`} onDragOver={onDragOver} onDrop={onDrop}>
        <div className="modal-head">
          <h3>Add Sources</h3>
          <button className="close" onClick={onCancel}>
            x
          </button>
        </div>

        <div className="mode-switch">
          <button
            className={`mode-btn ${sourceMode === 'text' ? 'active' : ''}`}
            onClick={() => onChangeMode('text')}
            disabled={isBusy}
          >
            Clipboard Text
          </button>
          <button
            className={`mode-btn ${sourceMode === 'pdf' ? 'active' : ''}`}
            onClick={() => onChangeMode('pdf')}
            disabled={isBusy}
          >
            File Upload
          </button>
        </div>

        {sourceMode === 'text' && (
          <>
            <label className="field-label" htmlFor="clipboard-source">
              Paste text from clipboard
            </label>
            <textarea
              id="clipboard-source"
              value={clipboardText}
              onChange={(event) => onChangeClipboardText(event.target.value)}
              placeholder="Paste text here"
              rows={7}
              disabled={isBusy}
            />
          </>
        )}

        {sourceMode === 'pdf' && (
          <>
            <label className="field-label" htmlFor="pdf-source">
              Upload one file
            </label>

            <div className="pdf-upload">
              <input
                id="pdf-source"
                type="file"
                accept=".pdf,.csv,application/pdf,text/csv"
                className="native-file-input"
                onChange={(event) => {
                  const file = event.target.files?.[0] || null
                  if (file) onChangeMode('pdf')
                  onChangePdfFile(file)
                }}
                disabled={isBusy}
              />

              <label htmlFor="pdf-source" className="file-chooser" aria-hidden={isBusy}>
                <div className="upload-placeholder">
                  <div className="upload-main-row">
                    <div className="upload-icon">📄</div>
                    <div className="upload-text">
                      <strong>Drag & drop a file here</strong>
                      <div className="muted">or click to choose a file</div>
                    </div>
                  </div>
                  <div className="file-name" title={pdfFile ? pdfFile.name : 'No file selected'}>
                    {displayFileName}
                  </div>
                </div>
              </label>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={isBusy}>
            Cancel
          </button>
          <button className="btn primary" onClick={onSave} disabled={isBusy}>
            {isBusy ? 'Indexing...' : 'Save Source'}
          </button>
        </div>
        {isBusy && (
          <div style={{ marginTop: 8 }}>
            <div className="progress-wrap">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${window.__UPLOAD_PROGRESS__ || 0}%` }} />
              </div>
              <div className="muted">Uploading: {window.__UPLOAD_PROGRESS__ || 0}%</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default AddSourcesModal

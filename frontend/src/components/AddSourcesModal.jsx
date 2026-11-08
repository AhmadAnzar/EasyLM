import Modal from './Modal'

function AddSourcesModal({
  open,
  sourceMode,
  clipboardText,
  pdfFile,
  onChangeMode,
  onChangeClipboardText,
  onChangePdfFile,
  onCancel,
  onSave,
  isBusy,
  uploadDetail,
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

  return (
    <Modal open={open} onClose={isBusy ? undefined : onCancel} dismissible={!isBusy} className={isDragging ? 'drop-zone' : ''} label="Add sources">
      <div onDragOver={onDragOver} onDrop={onDrop} className="add-sources">
        <div className="modal-head">
          <h3>Add Sources</h3>
          <button className="close" onClick={onCancel} disabled={isBusy} aria-label="Close">
            ×
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
              Upload one file (PDF or CSV)
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
        {isBusy && <div className="muted">{uploadDetail || 'Working...'}</div>}
      </div>
    </Modal>
  )
}

export default AddSourcesModal

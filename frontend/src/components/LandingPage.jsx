function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  )
}

function LandingPage({ siteName, user, onTryDemo, onLogin, onOpenWorkspace }) {
  // Signed-in visitors go straight back to their workspace; everyone else is offered the live demo first.
  const primary = user
    ? { label: 'Open my workspace', action: onOpenWorkspace }
    : { label: 'Try the live demo', action: onTryDemo }
  const secondary = user
    ? { label: 'Try the demo', action: onTryDemo }
    : { label: 'Log in / Sign up', action: onLogin }

  return (
    <section className="landing">
      <div className="ambient ambient-one"></div>
      <div className="ambient ambient-two"></div>
      <div className="landing-shell">
        <header className="landing-nav">
          <p className="brand-name">{siteName}</p>
          <button className="btn nav-cta" onClick={user ? onOpenWorkspace : onLogin}>
            {user ? `Hi, ${user.username}` : 'Log in'}
          </button>
        </header>

        <div className="landing-card">
          <div className="hero-copy">
            <p className="kicker">Smart Document Assistant</p>
            <h1 className="hero-title">{siteName}</h1>
            <h2 className="hero-subtitle">Ask better questions. Get grounded answers.</h2>
            <p className="landing-copy">
              A focused RAG workspace that keeps your source workflow simple:
              paste text or upload PDF and CSV files, then ask questions about them.
            </p>
            <div className="landing-points">
              <span>Fast setup</span>
              <span>Clear citations</span>
              <span>Simple workflow</span>
            </div>
            <div className="hero-actions">
              <button className="btn primary cta" onClick={primary.action}>
                <span>{primary.label}</span>
                <ArrowIcon />
              </button>
              <button className="btn cta-secondary" onClick={secondary.action}>
                {secondary.label}
              </button>
            </div>
            <p className="cta-note">
              No sign-up needed. The demo opens with a sample document, ready for your questions.
            </p>
          </div>

          <aside className="hero-preview">
            <p className="preview-label">Example Prompt</p>
            <div className="preview-block source-block">
              <strong>Source</strong>
              <span>reflections_in_light.file</span>
            </div>
            <div className="preview-block question-block">
              <strong>Question</strong>
              <span>How does the document distinguish specular reflection from diffuse reflection?</span>
            </div>
            <div className="preview-block answer-block">
              <strong>Answer</strong>
              <span>
                The document explains that specular reflection keeps ray direction coherent on smooth
                surfaces, so reflected light can form clear images. Diffuse reflection happens on rough
                surfaces where micro-facets redirect light in many directions, reducing sharp visual detail.
                [1] [3]
              </span>
            </div>
            <div className="preview-block citations-block">
              <strong>Citations</strong>
              <span>[1] reflections_in_light.file, p. 4, paragraph 2</span>
              <span>[3] reflections_in_light.file, p. 7, figure caption</span>
            </div>
          </aside>
        </div>
      </div>
    </section>
  )
}

export default LandingPage

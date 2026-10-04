// app.js — shared layout, sidebar, language toggle.
// Theme init: restore saved preference before first paint to avoid flash.
(function initTheme() {
  const saved = localStorage.getItem('arbiter-theme');
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset.theme = saved;
  }
})();

(function () {
  // Inline SVG icon set so we don't depend on an external file or font.
  const ICONS = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    scrape:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 10 15 10"/></svg>',
    scanner:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
    analytics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>',
    ai:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6L12 2z"/><path d="M19 14l.9 2.6L22 17.5l-2.1.9L19 21l-.9-2.6L16 17.5l2.1-.9L19 14z" opacity="0.6"/></svg>',
    chevron:   '<svg class="nav-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  };

  // Layout copy lives here so shared RO/EN dictionaries remain untouched.
  const WORKSPACE_COPY = {
    ro: {
      eyebrow: 'Spațiu de analiză', heading: 'O perspectivă clară.',
      description: 'Verifică sursele, compară oportunitățile și pregătește următorul pas.',
      sourcesAction: 'Gestionează sursele', scannerAction: 'Deschide scannerul',
      guideTitle: 'Înainte de analiză',
      guideBody: 'Verifică momentul ultimei colectări și starea surselor înainte de a compara cotele.',
      guideLink: 'Verifică sursele →', skip: 'Sari la conținut', navigation: 'Navigare în spațiul de lucru',
      toggle: 'Comută navigarea', language: 'Selectează limba', theme: 'Temă luminoasă', summary: 'Rezumatul analizei'
    },
    en: {
      eyebrow: 'Analyst workspace', heading: 'A clearer perspective.',
      description: 'Check your sources, compare opportunities, and prepare your next move.',
      sourcesAction: 'Manage sources', scannerAction: 'Open scanner',
      guideTitle: 'Before you compare',
      guideBody: 'Review the latest collection time and source health before comparing odds.',
      guideLink: 'Review sources →', skip: 'Skip to content', navigation: 'Workspace navigation',
      toggle: 'Toggle navigation', language: 'Select language', theme: 'Light theme', summary: 'Analysis summary'
    }
  };
  function workspaceCopy() {
    return WORKSPACE_COPY[window.arbiterI18n.lang] || WORKSPACE_COPY.ro;
  }

  function buildSidebar(active) {
    const t = window.arbiterI18n.t.bind(window.arbiterI18n);
    const curLang = window.arbiterI18n.lang || 'ro';
    const items = [
      { href: '/', label: 'dashboard', icon: 'dashboard' },
      { href: '/admin/scrape.html', label: 'scrape', icon: 'scrape' },
      { href: '/admin/scanner.html', label: 'scanner', icon: 'scanner' },
      { href: '/admin/analytics.html', label: 'analytics', icon: 'analytics' },
      { href: '/admin/ai.html', label: 'ai', icon: 'ai' },
    ];
    const nav = items.map((it) => {
      const aria = active === it.label ? ' aria-current="page"' : '';
      return `
        <a href="${it.href}" class="${active === it.label ? 'active' : ''}"${aria} role="link">
          <span class="nav-icon">${ICONS[it.icon]}</span>
          <span class="nav-label" data-i18n="${it.label}">${t(it.label)}</span>
          ${ICONS.chevron}
        </a>`;
    }).join('');

    const skip = `<a class="visually-hidden-focusable" href="#main-content" style="position:absolute;inset:8px auto auto 8px;background:var(--accent);color:var(--surface-logo-text);padding:8px 12px;border-radius:var(--r-sm);z-index:9999;transform:translateY(-100%);">Skip to content</a>`;
    const skipStyle = `<style>.visually-hidden-focusable:focus{transform:translateY(0)!important;position:fixed}</style>`;
    const hamburger = `<button type="button" class="sidebar-toggle" aria-label="Toggle navigation" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>`;

    return `
      ${skipStyle}
      ${skip}
      ${hamburger}
      <aside class="sidebar" role="navigation" aria-label="Workspace navigation">
        <div class="sidebar-brand">
          <div class="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 2 22 22 22"/>
              <line x1="6.5" y1="14" x2="17.5" y2="14"/>
            </svg>
          </div>
          <div class="brand-text">
            <div class="name-row">
              <span class="name">Arbiter</span>
              <span class="badge">v0.1</span>
            </div>
            <div class="subtitle" data-i18n="terminalSubtitle">${t('terminalSubtitle')}</div>
          </div>
        </div>

        <div class="sidebar-section">
          <div class="label" id="nav-workspace" data-i18n="workspace">${t('workspace')}</div>
          <nav aria-labelledby="nav-workspace" role="navigation">${nav}</nav>
        </div>

        <div class="sidebar-status-card workspace-guide">
          <h2 data-workspace-copy="guideTitle">${workspaceCopy().guideTitle}</h2>
          <p data-workspace-copy="guideBody">${workspaceCopy().guideBody}</p>
          <a href="/admin/scrape.html" data-workspace-copy="guideLink">${workspaceCopy().guideLink}</a>
        </div>

        <div class="sidebar-footer" role="contentinfo">
          <div class="footer-row">
            <div class="connection-status" title="127.0.0.1:3022">
              <span class="dot live"></span>
              <span class="conn-text" data-i18n="localOnly">${t('localOnly')}</span>
            </div>
            <div class="footer-controls">
              <div class="lang-switch" role="group" aria-label="Language selection">
                <button type="button" class="lang-btn ${curLang === 'ro' ? 'active' : ''}" data-lang-set="ro">RO</button>
                <button type="button" class="lang-btn ${curLang === 'en' ? 'active' : ''}" data-lang-set="en">EN</button>
              </div>
              <button type="button" class="theme-toggle" role="switch"
                      aria-label="Toggle light/dark theme"
                      aria-checked="${document.documentElement.dataset.theme === 'light'}"
                      data-theme-toggle>
                <svg class="theme-icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                <svg class="theme-icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              </button>
            </div>
          </div>
        </div>
      </aside>
    `;
  }

  function mount(active) {
    if (document.querySelector('.sidebar')) return;
    const main = document.querySelector('main');
    if (!main) return;
    if (main && !main.id) main.id = 'main-content';
    main.setAttribute('role', 'main');
    const app = document.createElement('div');
    app.className = 'app';
    app.innerHTML = buildSidebar(active);
    document.body.insertBefore(app, document.body.firstChild);
    app.appendChild(main);
    document.body.classList.add('has-sidebar');
    const copy = workspaceCopy();
    document.documentElement.lang = window.arbiterI18n.lang || 'ro';
    main.tabIndex = -1;
    document.querySelectorAll('[data-workspace-copy]').forEach((node) => {
      const text = copy[node.dataset.workspaceCopy];
      if (text) node.textContent = text;
    });
    app.querySelector('.visually-hidden-focusable').textContent = copy.skip;
    app.querySelector('.sidebar').setAttribute('aria-label', copy.navigation);
    app.querySelector('.sidebar').id = 'workspace-sidebar';
    app.querySelector('.sidebar-toggle').setAttribute('aria-label', copy.toggle);
    app.querySelector('.sidebar-toggle').setAttribute('aria-controls', 'workspace-sidebar');
    app.querySelector('.lang-switch').setAttribute('aria-label', copy.language);
    app.querySelector('[data-theme-toggle]').setAttribute('aria-label', copy.theme);
    const summary = main.querySelector('.dash-quickbar');
    if (summary) summary.setAttribute('aria-label', copy.summary);
    app.querySelectorAll('[data-lang-set]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.langSet === document.documentElement.lang));
    });

    // Wire up segmented language switchers
    document.querySelectorAll('[data-lang-set]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.langSet;
        if (target && target !== window.arbiterI18n.lang) {
          window.arbiterI18n.setLang(target);
          document.documentElement.lang = target;
          location.reload();
        }
      });
    });

    // Wire theme toggle
    const themeToggle = app.querySelector('[data-theme-toggle]');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        const current = document.documentElement.dataset.theme || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        themeToggle.setAttribute('aria-checked', String(next === 'light'));
        localStorage.setItem('arbiter-theme', next);
        window.dispatchEvent(new Event('arbiter-theme-change'));
      });
    }

    // Mobile sidebar toggle
    const toggle = app.querySelector('.sidebar-toggle');
    const sidebar = app.querySelector('.sidebar');
    if (toggle && sidebar) {
      const overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      document.body.appendChild(overlay);

      function closeSidebar() {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
        main.inert = false;
        toggle.focus();
      }
      function openSidebar() {
        sidebar.classList.add('open');
        overlay.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
        main.inert = true;
        sidebar.querySelector('a[aria-current="page"], a').focus();
      }

      toggle.addEventListener('click', () => {
        if (sidebar.classList.contains('open')) closeSidebar();
        else openSidebar();
      });
      overlay.addEventListener('click', closeSidebar);
      document.addEventListener('keydown', (e) => {
        if (!sidebar.classList.contains('open')) return;
        if (e.key === 'Escape') closeSidebar();
        if (e.key === 'Tab') {
          const controls = [toggle, ...sidebar.querySelectorAll('a[href], button:not(:disabled)')];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
          }
        }
      });
      const mobile = window.matchMedia('(max-width: 980px)');
      mobile.addEventListener('change', () => {
        if (!mobile.matches && sidebar.classList.contains('open')) {
          closeSidebar();
          sidebar.querySelector('a[aria-current="page"], a').focus();
        }
      });
    }
  }

  /**
   * Say what the desktop updater is doing, on whichever page is open.
   *
   * The updater runs in the main process and pushes five `update-*` events
   * (electron/auto-update.mjs). Before this, every one of them arrived with
   * nobody listening: the page has no update UI at all, so the operator found
   * out an update had been downloaded and was waiting to be installed by
   * noticing that nothing had changed. Four of the five say something; the
   * fifth — `update-not-available` — deliberately says nothing, because
   * "nothing to install" is the absence of news and a toast for it would train
   * the operator to dismiss toasts.
   *
   * A browser tab has no `window.arbiter` and no main process behind it, so
   * this returns on the first line and costs the tab nothing.
   */
  function watchUpdates() {
    const bridge = window.arbiter;
    if (!bridge || typeof bridge.onUpdateAvailable !== 'function') return;
    const t = (key) => (window.arbiterI18n ? window.arbiterI18n.t(key) : key);
    const say = (message, type, duration) => {
      if (typeof window.showToast === 'function') window.showToast(message, type, { duration });
    };
    bridge.onUpdateChecking(() => say(t('updateChecking'), 'info', 2500));
    bridge.onUpdateAvailable((info) => say(t('updateAvailable').replace('{version}', String((info && info.version) || '')), 'info', 6000));
    bridge.onUpdateDownloaded((info) => say(t('updateReady').replace('{version}', String((info && info.version) || '')), 'success', 8000));
    bridge.onUpdateError((err) => say(t('updateFailed').replace('{error}', String((err && err.error) || t('failedShort'))), 'error', 6000));
    // Subscribed, and deliberately silent: the main process says this when the
    // check found nothing, and the right answer to that is no toast at all.
    bridge.onUpdateNotAvailable(() => {});
  }
  watchUpdates();

  window.arbiterApp = { mount };
})();

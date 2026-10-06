// app.js — shared layout, sidebar, language toggle.
//
// There is no theme preference any more. The app was dark-first with a light
// override; it is now the ArbEdge palette only, which lives in design-tokens.css
// as plain `:root` values. `design-tokens.css` keeps a `[data-theme]` selector as
// a no-op so a stale attribute cannot ask for a palette that no longer exists.
//
// What this function still does is clear that stale state. A browser that ran
// before the retheme has `arbiter-theme=dark` in localStorage and possibly
// `data-theme="dark"` on the documentElement; both are removed here so nothing
// downstream — a script reading `dataset.theme`, or a stale stylesheet rule —
// can conclude the page is meant to be dark.
(function clearLegacyTheme() {
  try {
    localStorage.removeItem('arbiter-theme');
  } catch (_err) {
    // A page opened with storage blocked still has to render.
  }
  delete document.documentElement.dataset.theme;
})();

(function () {
  // Inline SVG icon set so we don't depend on an external file or font.
  const ICONS = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    scrape:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 10 15 10"/></svg>',
    scanner:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
    analytics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>',
    ai:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6L12 2z"/><path d="M19 14l.9 2.6L22 17.5l-2.1.9L19 21l-.9-2.6L16 17.5l2.1-.9L19 14z" opacity="0.6"/></svg>',
    live:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>',
    bookies:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5m-4 0h4"/></svg>',
    settings:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/></svg>',
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
    // Grouped rather than one flat list: the console pages answer "where is the
    // edge" (arbitrage / live / bookies) while the existing five answer "how do
    // I run and inspect it". The ArbEdge mockup made that split explicit, and it
    // is the only way a seven-item sidebar stays scannable.
    const groups = [
      {
        key: 'navTrading',
        items: [
          { href: '/admin/arbitrage.html', label: 'arbitrage', icon: 'dashboard' },
          { href: '/admin/live.html', label: 'liveArbitrage', icon: 'live' },
          { href: '/admin/bookies.html', label: 'bookies', icon: 'bookies' },
        ],
      },
      {
        key: 'workspace',
        id: 'nav-workspace',
        items: [
          { href: '/', label: 'dashboard', icon: 'dashboard' },
          { href: '/admin/scrape.html', label: 'scrape', icon: 'scrape' },
          { href: '/admin/scanner.html', label: 'scanner', icon: 'scanner' },
          { href: '/admin/analytics.html', label: 'analytics', icon: 'analytics' },
          { href: '/admin/ai.html', label: 'ai', icon: 'ai' },
        ],
      },
      {
        key: 'navSystem',
        items: [
          { href: '/admin/settings.html', label: 'settings', icon: 'settings' },
        ],
      },
    ];

    const nav = groups.map((group) => {
      const labelId = group.id || ('nav-' + group.key);
      const links = group.items.map((it) => {
        const on = active === it.label;
        // The ArbEdge item, verbatim from the console pages: a full-width row, a
        // fixed-size icon, and a label that collapses with the sidebar. The active
        // state is the design's blue wash plus a hairline border rather than
        // theme.css's left rule, so a generated sidebar and a hand-written one are
        // the same component.
        const row = on
          ? 'bg-[var(--edge-blueDim)] text-[var(--edge-blue)] border border-[var(--edge-blue)]/15'
          : 'text-[var(--edge-text)] hover:bg-[var(--edge-surface2)] hover:text-[var(--edge-textBright)] transition-colors';
        return `
          <a href="${it.href}" class="flex items-center gap-3 px-2 py-2 rounded-lg ${row}"${on ? ' aria-current="page"' : ''} role="link">
            <span class="w-5 h-5 shrink-0 flex items-center justify-center">${ICONS[it.icon]}</span>
            <span class="edge-label text-sm font-medium" data-i18n="${it.label}">${t(it.label)}</span>
          </a>`;
      }).join('');
      return `
        <div>
          <div class="edge-label px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--edge-textMuted)]" id="${labelId}" data-i18n="${group.key}">${t(group.key)}</div>
          <div class="space-y-1">
            <nav aria-labelledby="${labelId}" role="navigation">${links}</nav>
          </div>
        </div>`;
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
          </div>
          <div class="brand-text">
            <div class="name-row">
              <span class="name">ArbEdge</span>
            </div>
          </div>
        </div>

        <nav class="sidebar-nav" aria-label="Workspace pages">${nav}</nav>

        <div class="sidebar-footer" role="contentinfo">
          <div class="footer-row">
            <span class="connection-status sse-status chip" id="sse-status" title="127.0.0.1:3022"
                  data-connected-text="${t('localOnly')}" data-disconnected-text="${t('reconnecting')}">
              <span class="dot"></span>
              <span class="conn-text" data-i18n="localOnly">${t('localOnly')}</span>
            </span>
            <div class="footer-controls">
              <div class="lang-switch" role="group" aria-label="Language selection">
                <button type="button" class="lang-btn ${curLang === 'ro' ? 'active' : ''}" data-lang-set="ro">RO</button>
                <button type="button" class="lang-btn ${curLang === 'en' ? 'active' : ''}" data-lang-set="en">EN</button>
              </div>
              <!-- No theme control: the palette is fixed. The console pages never
                   had one either, so this is the switch finally agreeing with them. -->
            </div>
          </div>
        </div>
      </aside>
    `;
  }

  /**
   * Wire the segmented language switch, wherever it appears on the page.
   *
   * Called from mount() rather than run at module scope for two reasons. It needs
   * the DOM, and mount() is the point every page has already established that the
   * DOM exists. And it has to run for a page that ships its own sidebar
   * (`body.edge`) as well as a theme.css one: the ArbEdge console pages render
   * the switch in their own markup, so a switch bound only on the path that
   * builds a sidebar looks real and does nothing.
   *
   * `active` is recomputed from the dictionary's language rather than trusted from
   * the markup. On a generated sidebar the markup was just written with the right
   * answer; on the console pages it is static HTML, so a hand-written
   * `class="active"` would be wrong for every session in the other language.
   */
  function wireLangSwitch() {
    document.querySelectorAll('[data-lang-set]').forEach((button) => {
      const isCurrent = button.dataset.langSet === window.arbiterI18n.lang;
      button.classList.toggle('active', isCurrent);
      button.setAttribute('aria-pressed', String(isCurrent));
      button.addEventListener('click', () => {
        const target = button.dataset.langSet;
        if (target && target !== window.arbiterI18n.lang) {
          window.arbiterI18n.setLang(target);
          document.documentElement.lang = target;
          location.reload();
        }
      });
    });
  }

  function mount(active) {
    const main = document.querySelector('main');
    if (!main) return;

    if (document.querySelector('.sidebar')) return;
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
    const summary = main.querySelector('.dash-quickbar');
    if (summary) summary.setAttribute('aria-label', copy.summary);
    // Sets `active` and `aria-pressed` on every switch on the page, the one the
    // generated sidebar included and the console pages render themselves.
    wireLangSwitch();

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

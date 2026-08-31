// app.js — shared layout, sidebar, language toggle.
(function () {
  // Inline SVG icon set so we don't depend on an external file or font.
  const ICONS = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    scrape:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 10 15 10"/></svg>',
    scanner:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
    analytics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>',
    ai:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6L12 2z"/><path d="M19 14l.9 2.6L22 17.5l-2.1.9L19 21l-.9-2.6L16 17.5l2.1-.9L19 14z" opacity="0.6"/></svg>',
  };

  function buildSidebar(active) {
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
          ${ICONS[it.icon]}
          <span>${window.arbiterI18n.t(it.label)}</span>
        </a>`;
    }).join('');

    const langBtn = `<button type="button" class="ghost lang-toggle" data-lang-toggle aria-label="Toggle language">${window.arbiterI18n.lang === 'ro' ? 'RO' : 'EN'}</button>`;

    const skip = `<a class="visually-hidden-focusable" href="#main-content" style="position:absolute;inset:8px auto auto 8px;background:var(--accent);color:#06121d;padding:8px 12px;border-radius:var(--r-sm);z-index:9999;transform:translateY(-100%);">Skip to content</a>`;
    // reveal on focus via CSS transform
    const skipStyle = `<style>.visually-hidden-focusable:focus{transform:translateY(0)!important;position:fixed}</style>`;

    return `
      ${skipStyle}
      ${skip}
      <aside class="sidebar" role="navigation" aria-label="Workspace navigation">
        <div class="sidebar-brand">
          <div class="logo" aria-hidden="true">A</div>
          <div>
            <div class="name">Arbiter<span class="badge">v0.1</span></div>
          </div>
        </div>

        <div class="sidebar-section">
          <div class="label" id="nav-workspace">Workspace</div>
          <nav aria-labelledby="nav-workspace" role="navigation">${nav}</nav>
        </div>

        <div class="sidebar-footer" role="contentinfo">
          <div class="status" role="status" aria-live="polite">
            <span class="dot live" aria-hidden="true"></span>
            <span>Local · <span class="mono">127.0.0.1</span></span>
          </div>
          <div class="row" style="gap:8px">
            <span class="muted text-xs" style="flex:1">Language</span>
            ${langBtn}
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
    main.setAttribute('aria-live', 'polite');
    const wrap = document.createElement('div');
    wrap.className = 'app';
    const sidebar = document.createElement('div');
    sidebar.innerHTML = buildSidebar(active);
    document.body.insertBefore(sidebar, document.body.firstChild);
    document.body.classList.add('has-sidebar');
    document.querySelectorAll('[data-lang-toggle]').forEach((btn) => btn.addEventListener('click', () => {
      const cur = window.arbiterI18n.lang;
      window.arbiterI18n.setLang(cur === 'ro' ? 'en' : 'ro');
      location.reload();
    }));
  }

  window.arbiterApp = { mount };
})();

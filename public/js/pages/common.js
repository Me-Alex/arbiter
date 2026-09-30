/**
 * Common UI helpers for Arbiter pages.
 *
 * Exposes {@link createDropdown}, {@link createChip}, and
 * {@link applyDesignTokens} on the global window object so
 * every admin page can share the same widget builders.
 *
 * @module common
 */

/**
 * Populate a `<select>` element with options and optionally persist
 * the selected value to localStorage.
 *
 * @param {string} id        - DOM id of the `<select>` element.
 * @param {Array<{value:string,text:string}>} options - Options to render.
 * @param {Object}  [config] - Optional configuration.
 * @param {string}  [config.storageKey] - localStorage key for persistence.
 * @param {string}  [config.placeholder] - Placeholder option text.
 * @returns {HTMLSelectElement|null} The populated select, or null if not found.
 */
window.escapeHtml = function (value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
};

window.createDropdown = function (id, options, config = {}) {
  const sel = document.getElementById(id);
  if (!sel) return null;
  const escape = (s) => s && typeof s === 'string' ? s.replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) : '';
  sel.innerHTML = options.map(o => `<option value="${escape(o.value)}">${escape(o.text)}</option>`).join('');
  if (config.storageKey) {
    const saved = localStorage.getItem(config.storageKey) || '';
    if (saved) sel.value = saved;
    sel.addEventListener('change', () => {
      localStorage.setItem(config.storageKey, sel.value);
    });
  }
  return sel;
};

/**
 * Create a styled chip `<span>` element.
 *
 * @param {string} text        - Visible chip label.
 * @param {string} [extraClass] - Additional CSS class(es) to append.
 * @returns {HTMLSpanElement} The chip element.
 */
window.createChip = function (text, extraClass = '') {
  const span = document.createElement('span');
  span.className = 'chip ' + extraClass;
  span.textContent = text;
  return span;
};

/**
 * Apply design token theme to the document root and persist the choice.
 * Sets `data-theme` on `document.documentElement` and saves to localStorage
 * so the preference survives page reloads.
 *
 * @param {string} theme - 'light' or 'dark'.
 * @returns {string} The applied theme.
 */
window.applyDesignTokens = function (theme) {
  if (theme !== 'light' && theme !== 'dark') {
    theme = document.documentElement.dataset.theme || 'dark';
  }
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('arbiter-theme', theme);
  return theme;
};

/**
 * Lightweight toast notification system.
 *
 * Renders a transient, dismissible toast in a fixed container (bottom-right).
 * Used to confirm user actions (scrape start/complete, scheduler save, bet
 * add, export) without making the user hunt for feedback.
 *
 * @namespace arbiterToast
 * @see {@link toasts}
 */
(function () {
  const CONTAINER_ID = 'toast-container';
  const DEFAULT_DURATION = 3200;

  function container() {
    let el = document.getElementById(CONTAINER_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = CONTAINER_ID;
      el.className = 'toast-container';
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', 'Notifications');
      document.body.appendChild(el);
    }
    return el;
  }

  /**
   * Show a toast notification.
   *
   * @param {string} message       - Message text (already translated by caller).
   * @param {string} [type='info'] - One of 'info' | 'success' | 'error' | 'warning'.
   * @param {Object} [opts]        - Options.
   * @param {number} [opts.duration=3200] - Auto-dismiss delay in ms.
   * @returns {HTMLDivElement} The toast element created.
   */
  window.showToast = function (message, type = 'info', opts = {}) {
    const c = container();
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (['info', 'success', 'error', 'warning'].includes(type) ? type : 'info');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const span = document.createElement('span');
    span.className = 'toast-msg';
    span.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    toast.appendChild(span);
    toast.appendChild(close);
    c.appendChild(toast);

    const dismiss = () => {
      toast.classList.add('toast-leave');
      window.setTimeout(() => toast.remove(), 260);
    };
    close.addEventListener('click', dismiss);

    const duration = opts.duration === null || opts.duration === undefined ? DEFAULT_DURATION : opts.duration;
    let timer = null;
    const arm = () => { timer = window.setTimeout(dismiss, duration); };
    const disarm = () => { if (timer) { window.clearTimeout(timer); timer = null; } };
    toast.addEventListener('mouseenter', disarm);
    toast.addEventListener('mouseleave', arm);
    arm();
    return toast;
  };

  window.arbiterToast = { show: window.showToast };
})();


/**
 * The header language button (`<button data-lang-toggle>`).
 *
 * It ships in the markup of ai, analytics, scanner and scrape, and it is
 * styled as a normal control — but nothing wired it. Only login.html loads
 * pages/login.js, which is the one place that ever bound this selector, so on
 * the other four pages the button rendered, took focus, and did nothing at
 * all. The sidebar switcher (injected by app.js) is the one that worked, and
 * it lives inside a drawer that is closed on a phone.
 *
 * common.js is loaded on exactly those four pages and not on login.html, so
 * binding here fixes them without double-binding the one that already works.
 * Switching reloads, like the sidebar does, so anything already rendered from
 * a fetch is rebuilt in the new language.
 */
(function () {
  function wire() {
    const buttons = document.querySelectorAll('[data-lang-toggle]');
    if (!buttons.length || !window.arbiterI18n) return;
    const target = () => (window.arbiterI18n.lang === 'ro' ? 'en' : 'ro');
    const label = (code) => (code === 'ro' ? 'RO' : 'EN');
    buttons.forEach((btn) => {
      // Show the language you would land in, not the one you are already in.
      btn.textContent = label(target());
      btn.setAttribute('aria-label', window.arbiterI18n.t('language'));
      if (btn.dataset.langToggleWired === '1') return;
      btn.dataset.langToggleWired = '1';
      btn.addEventListener('click', () => {
        // The disabled attribute alone would be enough — a browser will not
        // deliver a click to a disabled button — but the guard is repeated
        // here so the handler is idempotent on its own terms rather than
        // leaning on that.
        if (btn.disabled) return;
        const next = target();
        if (next === window.arbiterI18n.lang) return;
        btn.disabled = true;
        window.arbiterI18n.setLang(next);
        document.documentElement.lang = next;
        location.reload();
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();


/**
 * Shared number formatting utilities for consistent display across all pages.
 *
 * All financial/betting values should use these formatters instead of
 * ad-hoc toFixed() or toLocaleString() calls.
 *
 * This *extends* the object defined in /js/format.js rather than replacing it.
 * Both files are loaded on the dashboard and event pages, and a plain
 * assignment here would silently drop paletteFor/fmtStake/parseDate/
 * formatKickoff, which event-detail.js calls unguarded. The admin pages do not
 * load format.js, so every key this file owns is also defined standalone below
 * and the base object only contributes on the pages that have it.
 *
 * Keys deliberately not redefined here: fmtOdds, fmtStake and timeAgo are
 * already provided by format.js with identical bodies.
 */
window.arbiterFormat = Object.assign(Object.create(null), window.arbiterFormat || {}, {
  /**
   * Format odds value (e.g. 2.35 → "2.35").
   * @param {number} n - The odds value.
   * @returns {string} Formatted odds string.
   */
  odds(n) {
    return Number(n || 0).toFixed(2);
  },

  /**
   * Format stake/profit values with thousand separators (e.g. 1500 → "1,500").
   * @param {number} n - The monetary value.
   * @returns {string} Formatted number string.
   */
  stake(n) {
    return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  },

  /**
   * Format ROI percentage (e.g. 3.456 → "3.46").
   * @param {number} n - The ROI percentage.
   * @returns {string} Formatted ROI string.
   */
  roi(n) {
    return Number(n || 0).toFixed(2);
  },

  /**
   * Format EV percentage (e.g. 2.1 → "2.10").
   * @param {number} n - The EV percentage.
   * @returns {string} Formatted EV string.
   */
  ev(n) {
    return Number(n || 0).toFixed(2);
  },

  /**
   * Format a count with thousand separators (e.g. 1234 → "1,234").
   * @param {number} n - The count value.
   * @returns {string} Formatted count string.
   */
  count(n) {
    return Number(n || 0).toLocaleString('en-US');
  },

  /**
   * Get the CSS class for ROI magnitude (for color-coded displays).
   * @param {number} roi - The ROI percentage.
   * @returns {string} CSS class name: 'roi-low', 'roi-mid', 'roi-high', or 'roi-hot'.
   */
  roiClass(roi) {
    const r = Number(roi || 0);
    if (r >= 5) return 'roi-hot';
    if (r >= 3) return 'roi-high';
    if (r >= 1) return 'roi-mid';
    return 'roi-low';
  },

  /**
   * Get a human-readable time ago string (e.g. "2m ago", "1h ago").
   * Only used as a fallback: when format.js is loaded (dashboard, event pages)
   * its identical implementation is kept instead.
   * @param {number} ms - Milliseconds elapsed.
   * @returns {string} Human-readable time string.
   */
  timeAgo: (window.arbiterFormat || {}).timeAgo || function timeAgoFallback(ms) {
    if (!ms) return '—';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    return h + 'h ago';
  },
});

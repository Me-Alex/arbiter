/**
 * format.js — shared frontend formatters.
 *
 * Loaded once before dashboard.js, event-detail-modal.js, and analytics.js.
 * Provides paletteFor, fmtStake, fmtOdds, fmtMarketKey, parseStakeAmount,
 * formatKickoff, and parseDate on the window object so every page shares a
 * single implementation (no copy-paste drift).
 *
 * @module format
 */
(function () {
  // Per-bookmaker palette (initials color, bg, border). Stable by sourceId.
  const PALETTE = [
    { color: '#f472b6', bg: 'rgba(244,114,182,0.12)', border: 'rgba(244,114,182,0.30)' },
    { color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', border: 'rgba(167,139,250,0.30)' },
    { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.30)' },
    { color: '#34d399', bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.30)' },
    { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.30)' },
    { color: '#f87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.30)' },
  ];

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < String(s || '').length; i++) {
      h = (h * 31 + String(s).charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }

  /** Stale-stable palette for a bookmaker id (does not change on every render). */
  function paletteFor(sourceId) {
    return PALETTE[hashStr(sourceId) % PALETTE.length] || PALETTE[0];
  }

  /** Format odds value (e.g. 2.35 → "2.35"). */
  function fmtOdds(n) {
    return Number(n || 0).toFixed(2);
  }

  /** Format stake/profit values with thousand separators (e.g. 1500 → "1,500"). */
  function fmtStake(n) {
    return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  /** Normalize a market key for display (e.g. "OVER_UNDER_2_5" → "OVER UNDER 2.5"). */
  function fmtMarketKey(k) {
    return String(k || '').replace(/_/g, ' ');
  }

  /**
   * Parse a stake amount from a label (e.g. "Miză 500" → 500).
   * @param {string} s
   * @returns {number|null}
   */
  function parseStakeAmount(s) {
    if (!s || typeof s !== 'string') return null;
    const digits = s.match(/([\d,]+(?:\.\d+)?)/);
    if (!digits) return null;
    const n = Number(digits[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Parse a date-like value into a Date, returning null when missing/malformed.
   * @returns {Date|null}
   */
  function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Format a kickoff timestamp for display, tolerating malformed values. */
  function formatKickoff(kickoff) {
    const d = parseDate(kickoff);
    return d ? d.toLocaleString() : '';
  }

  window.arbiterFormat = {
    paletteFor,
    fmtOdds,
    fmtStake,
    fmtMarketKey,
    parseStakeAmount,
    parseDate,
    formatKickoff,
    timeAgo(ms) {
      if (!ms) return '—';
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return s + 's ago';
      const m = Math.round(s / 60);
      if (m < 60) return m + 'm ago';
      const h = Math.round(m / 60);
      return h + 'h ago';
    },
  };
})();

// event-detail-modal.js — event detail dialog subsystem.
//
// Owns everything related to the "event detail" modal that opens from an
// opportunity card's event link: the shared dialog DOM handles, the serial
// request token, the live odds matrix renderer, and the card-snapshot fallback
// renderer. dashboard.js only needs to call EventDetailModal.openEventDetail.
//
// Plain-script (non-ESM) to match the rest of the app. Helpers the renderers
// need (paletteFor, fmtOdds, ...) are provided once via EventDetailModal.init
// so this module does not depend on the order other page scripts load.
(function () {
  'use strict';

  let helpers = {};

  // Dialog elements resolved lazily on first open so the module works whether
  // the page renders the <dialog> before or after this script loads.
  let evDialog, evDialogTitle, evDialogMeta, evDialogBody;

  // Serial token so a stale in-flight response can't overwrite a newer open's
  // dialog body after a rapid close/reopen (or a close-then-resolve).
  let eventDetailReqSeq = 0;

  // Denylist of scraper API/CDN/backend endpoints that are operationally not
  // browseable event pages. Single source of truth: src/shared/event-url.mjs.
  // Keep this copy in sync with that file — both define the same patterns.
  const API_URL_PATTERNS = [
    /nsoftcdn\.com/, /nsoft\.com/, /\/api\//, /\/api2\//,
    /getPalinsestoDelGiorno/, /\?companyUuid=/, /offerTemplate=/, /dataFormat=/,
    /freetls\.fastly\.net/, /efortuna\.ro\/offer/, /sportify\.bet/,
    /gambling-solutions\.ro/, /service\/lineout/,
  ];

  // Render a single leg row used by both the opportunity card and the
  // market-chip swap path — a single source of truth for leg markup.
  function renderLeg(l, t, roiPercent) {
    const pal = helpers.paletteFor(l.sourceId);
    const url = l.eventUrl ? ` data-event-url="${helpers.escapeHtml(l.eventUrl)}"` : '';
    return `<div class="leg"${url}>
      <div class="head">
        <span class="book" style="color:${pal.color};">${helpers.escapeHtml(l.sourceId)}</span>
        <span class="stake">${t('stake')} ${helpers.fmtStake(l.stake)}</span>
      </div>
      <div class="pick">${helpers.escapeHtml(l.selection)}</div>
      <div class="odds">${helpers.fmtOdds(l.odds)}</div>
      <div class="profit">+${helpers.fmtStake((l.stake || 0) * (roiPercent || 0) / 100)} RON</div>
    </div>`;
  }

  /**
   * Parse a date-like value into a Date, returning null when it is missing or
   * malformed (never throws). Centralizes the tolerant-parse behaviour shared
   * by formatKickoff and the detectedAt time badge.
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

  /**
   * True when `url` is a browseable event page (https/http and not a
   * scraper API/CDN endpoint). The denylist is API_URL_PATTERNS above.
   * @param {string} url
   * @returns {boolean}
   */
  function isEventUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.length > 2048) return false;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    return !API_URL_PATTERNS.some((re) => re.test(url));
  }

  /**
   * Snapshot the leg data from an opportunity card into plain objects so the
   * event-detail fallback stays valid even after the card is re-rendered by an
   * SSE refresh. Returns `{ legs, marketLabel }` or null when the card has no
   * legs.
   * @param {Element} card
   * @returns {{legs:Array, marketLabel:string}|null}
   */
function collectCardLegs(card) {
  if (!card || !card.querySelector) return null;
  const marketLabel = card.querySelector('.chip-market')?.textContent?.trim() || '';
  const legs = [];
  for (const leg of card.querySelectorAll('.leg')) {
    if (!leg || !leg.querySelector) continue;
    const book = leg.querySelector('.book')?.textContent?.trim() || '';
    const stakeLabel = leg.querySelector('.stake')?.textContent?.trim() || '';
    const pick = leg.querySelector('.pick')?.textContent?.trim() || '';
    const oddsEl = leg.querySelector('.odds');
    const odds = oddsEl ? parseFloat(oddsEl.textContent) : NaN;
    const profit = leg.querySelector('.profit')?.textContent?.trim() || '';
    const eventUrl = (typeof leg.getAttribute === 'function' ? leg.getAttribute('data-event-url') : leg.eventUrl) || null;
    legs.push({ book, stakeLabel, stakeAmount: helpers.parseStakeAmount(stakeLabel), pick, odds: Number.isFinite(odds) ? odds : null, profit, eventUrl });
  }
  return legs.length ? { legs, marketLabel } : null;
}

  /**
   * Render the live event view into the dialog body. `data` is the raw
   * /api/event-detail response. Behavioural contract:
   *  - `data.events` empty/successful-but-empty → fall back to the card
   *    snapshot (when provided) with the "offline" note.
   *  - `opts.error` set (API/network failure) → fall back with the distinct
   *    "error" note. These two states must render different user-facing
   *    messages; both note strings live in i18n and must stay translatable.
   * @param {any} data
   * @param {{fallbackLegs?:{legs:Array,marketLabel:string}|null, error?:boolean, target?:Element}} opts
   */
  function renderEventDetail(data, opts) {
    const t = helpers.arbiterI18n.t.bind(helpers.arbiterI18n);
    // Accept an explicit output element so the renderer is testable in
    // isolation; production calls it without one and renders into the dialog
    // body resolved by init().
    const body = (opts && opts.target) || evDialogBody;
    if (!body) return; // nothing to render into (e.g. modal missing)
    const events = (data && Array.isArray(data.events) ? data.events : [])
      .filter((e) => Array.isArray(e.markets) && e.markets.length);

    if (!events.length) {
      const fallback = opts && opts.fallbackLegs ? buildFallbackFromLegs(opts.fallbackLegs) : null;
      if (fallback && fallback.sections.length) {
        body.className = 'dialog-body';
        // Show a note whenever we fall back to the card snapshot: the snapshot
        // odds are never live bookmaker odds. Distinguish a network/API failure
        // (opts.error) from a healthy-but-empty snapshot so diagnostics are
        // honest — the note text is user-facing, so it lives in i18n.
        const noteKey = opts && opts.error ? 'offlineFallbackError' : 'offlineFallback';
        // When the card told us when it detected this opportunity, surface the
        // snapshot's age so the user can judge freshness.
        let note = `<div class="dialog-note">${helpers.escapeHtml(t(noteKey))}</div>`;
        const detectedAt = opts && opts.fallbackLegs && opts.fallbackLegs.detectedAt;
        const detectedDate = detectedAt ? helpers.parseDate(detectedAt) : null;
        if (detectedDate) {
          const ageMs = Math.max(0, Date.now() - detectedDate.getTime());
          const ageText = helpers.arbiterFormat?.timeAgo ? helpers.arbiterFormat.timeAgo(ageMs) : '';
          if (ageText) {
            note = note.replace('</div>', ` · ${helpers.escapeHtml(t('detectedAgo'))} ${helpers.escapeHtml(ageText)}</div>`);
          }
        }
        body.innerHTML = note + fallback.sections.join('');
        return;
      }
      body.className = 'dialog-body empty';
      body.innerHTML = `<div>${helpers.escapeHtml(t('noOddsFound'))}</div>`;
      return;
    }

    // Map sourceId -> a browseable event page url (only actual event pages).
    const sourceUrls = new Map();
    for (const ev of events) {
      if (isEventUrl(ev.sourceUrl) && !sourceUrls.has(ev.sourceId)) sourceUrls.set(ev.sourceId, ev.sourceUrl);
    }

    // Aggregate by market key: name + map of sourceId -> selections.
    const byMarket = new Map();
    for (const ev of events) {
      for (const m of ev.markets) {
        let entry = byMarket.get(String(m.key));
        if (!entry) {
          entry = { key: String(m.key), name: m.name || String(m.key), books: new Map() };
          byMarket.set(entry.key, entry);
        }
        entry.books.set(ev.sourceId, m.selections || []);
      }
    }

    // Extract threshold from an OVER_UNDER market key, e.g. OVER_UNDER_2_5 → "2.5".
    function thresholdFromKey(key) {
      const m = /^OVER_UNDER_(\d+)_(\d+)$/i.exec(String(key));
      return m ? `${m[1]}.${m[2]}` : null;
    }

    body.className = 'dialog-body';
    const sections = [];
    for (const m of byMarket.values()) {
      const threshold = thresholdFromKey(m.key);
      const headingLabel = threshold
        ? `${helpers.escapeHtml(m.name)} <span class="market-threshold">${helpers.escapeHtml(threshold)}</span>`
        : helpers.escapeHtml(m.name);

      // Determine the union of selection names across books for this market.
      const selNames = new Map();
      for (const [, sels] of m.books) {
        for (const s of sels) {
          const name = s.name || s.id || '';
          if (name && !selNames.has(name)) selNames.set(name, name);
        }
      }
      const selList = [...selNames.keys()];

      // Pre-compute edge % per book: sum(1/odds) - 1, using only selections in
      // selList. A book qualifies only when 2+ selections have odds > 1.
      const edgeMap = new Map();
      let minEdge = Infinity;
      for (const [book, sels] of m.books) {
        let overround = 0;
        let validCount = 0;
        for (const selName of selList) {
          const match = (sels || []).find((s) => (s.name || s.id || '') === selName);
          if (match && match.odds > 1) { overround += 1 / match.odds; validCount++; }
        }
        const edge = validCount >= 2 ? (overround - 1) * 100 : null;
        edgeMap.set(book, edge);
        if (edge !== null && edge < minEdge) minEdge = edge;
      }

      const rows = [];
      for (const [book, sels] of m.books) {
        const pal = helpers.paletteFor(book);
        const initials = String(book).slice(0, 2);
        const url = sourceUrls.get(book);
        const linkIcon = url
          ? `<a class="book-link" href="${helpers.escapeHtml(url)}" target="_blank" rel="noopener" title="Open ${helpers.escapeHtml(book)} →"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`
          : '';
        const oddsCells = selList.map((selName) => {
          const match = (sels || []).find((s) => (s.name || s.id || '') === selName);
          return `<span>${match ? helpers.fmtOdds(match.odds) : '—'}</span>`;
        }).join('');
        const edge = edgeMap.get(book);
        const isBest = edge !== null && edge === minEdge;
        const edgeCell = edge !== null
          ? `<td class="edge-cell${isBest ? ' best-edge' : ''}">${edge >= 0 ? '+' : ''}${edge.toFixed(1)}%</td>`
          : `<td class="edge-cell dim">—</td>`;
        rows.push(`
        <tr>
          <td>
            <div class="bookmaker-cell">
              <span class="book-avatar" style="color:${pal.color};background:${pal.bg};border:1px solid ${pal.border};">${helpers.escapeHtml(initials)}</span>
              ${helpers.escapeHtml(book)}${linkIcon}
            </div>
          </td>
          <td class="odds-cell-row">${oddsCells}</td>
          ${edgeCell}
        </tr>`);
      }

      sections.push(`
      <div class="ev-market-section">
        <h4>${headingLabel}</h4>
        <div class="odds-table-wrap">
          <table class="odds-table">
            <thead>
              <tr>
                <th>${helpers.escapeHtml(t('bookmaker'))}</th>
                <th><div class="selections-header">${selList.map((s) => `<span>${helpers.escapeHtml(s)}</span>`).join('')}</div></th>
                <th class="num">Edge</th>
              </tr>
            </thead>
            <tbody>${rows.join('')}</tbody>
          </table>
        </div>
      </div>`);
    }

    body.innerHTML = sections.join('') || `<div class="empty">${helpers.escapeHtml(t('noOddsFound'))}</div>`;
  }

  /**
   * Fallback renderer: when the event-detail API has no snapshot data (e.g.
   * the workspace snapshots are missing), build the odds comparison table from
   * the opportunity card's own embedded legs so the event link always lands on
   * a data-rich view. `snapshot` is `{ legs, marketLabel }` from
   * collectCardLegs(); a bare array of legs is also accepted for backwards
   * compatibility. Returns `{ sections }`.
   * @param {{legs:Array, marketLabel:string}|Array} snapshot
   * @returns {{sections:Array<string>}}
   */
  function buildFallbackFromLegs(snapshot) {
    const t = helpers.arbiterI18n.t.bind(helpers.arbiterI18n);
    const legs = Array.isArray(snapshot)
      ? snapshot
      : (snapshot && Array.isArray(snapshot.legs) ? snapshot.legs : []);
    if (!legs.length) return { sections: [] };
    const marketLabel = (snapshot.marketLabel || '').trim() || t('markets');

    const rows = legs.map((leg) => {
      const book = leg.book || '—';
      const pal = helpers.paletteFor(book);
      const stakeText = leg.stakeAmount !== null && leg.stakeAmount !== undefined
        ? `${t('stake')} ${helpers.fmtStake(leg.stakeAmount)}`
        : leg.stakeLabel || '';
      const url = leg.eventUrl;
      const linkIcon = url
        ? `<a class="book-link" href="${helpers.escapeHtml(url)}" target="_blank" rel="noopener" title="Open ${helpers.escapeHtml(book)} →"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`
        : '';
      return `
      <tr>
        <td>
          <div class="bookmaker-cell">
            <span class="book-avatar" style="color:${pal.color};background:${pal.bg};border:1px solid ${pal.border};">${helpers.escapeHtml(book.slice(0, 2))}</span>
            ${helpers.escapeHtml(book)}${linkIcon}
          </div>
        </td>
        <td class="odds-cell-row"><span>${leg.odds ? helpers.fmtOdds(leg.odds) : '—'}</span></td>
        <td class="edge-cell dim">${helpers.escapeHtml(leg.pick || '—')}</td>
        <td class="stake-cell"><span class="dim">${helpers.escapeHtml(stakeText)}</span><br><span class="profit">${helpers.escapeHtml(leg.profit || '')}</span></td>
      </tr>`;
    }).join('');

    const sections = [`
    <div class="ev-market-section">
      <h4>${helpers.escapeHtml(marketLabel)}</h4>
      <div class="odds-table-wrap">
        <table class="odds-table">
          <thead>
            <tr>
              <th>${helpers.escapeHtml(t('bookmaker'))}</th>
              <th>${helpers.escapeHtml(t('odds'))}</th>
              <th class="num">${helpers.escapeHtml(t('pick'))}</th>
              <th class="num">${helpers.escapeHtml(t('stake'))}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`];
    return { sections };
  }

  // Cache of card -> fallback snapshot so repeated opens on the same live DOM
  // node don't re-walk it after the first snapshot. Keyed weakly so the entry
  // is reclaimed when the card is garbage collected.
  const fallbackCache = new WeakMap();

  /**
   * Open the event detail dialog for `card` and load its odds. Only the raw
   * kickoff string is assumed; API response shape is only used for its
   * `data.events` array. The card legs are snapshotted synchronously BEFORE
   * the async /api/event-detail call so the fallback survives an SSE re-render
   * detaching the card.
   * @param {Element} card
   * @returns {boolean} true when the dialog actually opened; false when the
   *   <dialog> markup is absent so the caller can surface an inline notice.
   */
  function openEventDetail(card) {
    if (!evDialog || !evDialog.showModal) return false;
    const sport = card.dataset.sport || '';
    const home = card.dataset.home || '';
    const away = card.dataset.away || '';
    const kickoff = card.dataset.kickoff || '';
    const detectedAt = card.dataset.detectedAt || '';

    const t = helpers.arbiterI18n.t.bind(helpers.arbiterI18n);
    const kickoffLabel = formatKickoff(kickoff);
    evDialogTitle.textContent = `${home} ${t('vs')} ${away}`;
    evDialogMeta.innerHTML = [
      sport ? `<span class="chip">${helpers.escapeHtml(sport)}</span>` : '',
      kickoffLabel ? `<span class="dim">${helpers.escapeHtml(kickoffLabel)}</span>` : '',
    ].join('');
    evDialogBody.className = 'dialog-body loading';
    evDialogBody.textContent = t('loadingOdds');
    evDialog.showModal();

    const d = parseDate(detectedAt);
    // Cache the card snapshot: repeated opens on the same DOM node reuse it.
    // After an SSE re-render the node is replaced, so the WeakMap misses and
    // the new card is walked once.
    let snapshot = fallbackCache.get(card);
    if (!snapshot) {
      snapshot = collectCardLegs(card);
      if (snapshot) fallbackCache.set(card, snapshot);
    }
    const fallbackLegs = snapshot
      ? { legs: snapshot.legs, marketLabel: snapshot.marketLabel, detectedAt: d ? d.toISOString() : '' }
      : null;

    const qs = new URLSearchParams({ sport, home, away, kickoff });
    const seq = ++eventDetailReqSeq;
    const render = (data, opts) => {
      if (seq !== eventDetailReqSeq) return; // superseded by a newer open/close
      renderEventDetail(data, { ...opts, fallbackLegs });
    };
    helpers.arbiterApi.get(`/api/event-detail?${qs.toString()}`)
      .then((data) => render(data, {}))
      .catch(() => {
        // API/network failure — fall back to the card's embedded legs so the
        // event still opens, but label the snapshot as an error, not offline.
        render(null, { error: true });
      });
    return true;
  }

  /**
   * Close the dialog and invalidate any in-flight request so a response that
   * resolves after the close cannot mutate the (now hidden) dialog body.
   */
  function closeEventDetail() {
    eventDetailReqSeq++; // supersede any pending response
    if (evDialog) evDialog.close();
  }

  /**
   * Wire the DOM event listeners for the dialog and provide the shared
   * helpers used by the renderers. Call once from the page that owns the
   * dialog markup.
   * @param {object} h helpers: paletteFor, fmtOdds, fmtStake, fmtMarketKey,
   *   parseStakeAmount, escapeHtml, arbiterI18n, arbiterApi.
   */
  function init(h) {
    helpers = h || helpers;
    evDialog = document.getElementById('event-detail-dialog');
    evDialogTitle = document.getElementById('event-detail-title');
    evDialogMeta = evDialog?.querySelector('.match-chips');
    evDialogBody = document.getElementById('event-detail-body');

    if (evDialog) {
      evDialog.querySelector('[data-close-event-detail]')?.addEventListener('click', () => closeEventDetail());
      evDialog.addEventListener('click', (e) => { if (e.target === evDialog) closeEventDetail(); });
      evDialog.addEventListener('cancel', () => closeEventDetail());
    }
    return window.EventDetailModal;
  }

  window.EventDetailModal = {
    init,
    openEventDetail,
    closeEventDetail,
    renderEventDetail,
    collectCardLegs,
    buildFallbackFromLegs,
    isEventUrl,
    formatKickoff,
    parseDate,
    renderLeg,
  };
})();
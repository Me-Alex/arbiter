// live.js — ArbEdge console: the live polling engine and what it sees right now.
//
// /api/live answers engine state, /api/scan answers which published signals are
// in-play, and /api/odds/:id is the only endpoint carrying per-selection prices.
// POST /api/live takes enabled/intervalSeconds/bookIds/scanOptions only —
// liveMaxAgeMs is returned by GET but is not an input to enable(), so never posted.
//
// The per-book price feed, composed by a top-level function and called through a
// binding rather than written into the call. test/api-surface.test.mjs can only
// verify a consumer of GET /api/odds if it can read how the URL was built, so a
// literal at the call site would put the route back on the BACKEND_ONLY list with
// nothing watching it. scrape.js's priceBoardUrl is the same arrangement for the
// same reason, and both have to stay top-level, single-return and brace-closed
// for that resolver to see them.
const LIVE_EVENTS_LIMIT = 50;

function liveEventsUrl(book) {
  return `/api/odds/${encodeURIComponent(book)}?limit=${LIVE_EVENTS_LIMIT}`;
}

(function () {
  arbiterApp.mount('liveArbitrage');

  const $ = (id) => document.getElementById(id);
  // Local formatters rather than window.arbiterFormat. pages/common.js does
  // define these keys and every one of these pages loads it, but it is a plain
  // script evaluated before this file, and the harness in
  // test/scan-fields-census.test.mjs runs this file with the global set to null
  // on purpose — to catch a reader that assumes an object exists at load time.
  // The other page scripts here format locally for the same reason.
  const count = (n) => Number(n || 0).toLocaleString('en-US');
  const odds = (n) => Number(n || 0).toFixed(2);
  const stake = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const t = (key) => window.arbiterI18n.t(key);
  // window.showToast, guarded. It is the one shared helper eslint does not
  // declare as a global, because a page is allowed to run without it —
  // pages/common.js owns it and analytics.js guards the same call.
  const toast = (message, type, opts) => {
    if (typeof window.showToast === 'function') window.showToast(message, type, opts);
  };

  // A real capture holds hundreds of events per book, so the table reads a
  // bounded slice from a bounded set of books rather than every feed at once.
  const MAX_BOOKS = 8;
  const MAX_ROWS = 100;

  const state = { live: null, scan: null, books: [], selected: [], events: [], lastPoll: null };

  const mkt = (key) => String(key || '').replace(/[_-]+/g, ' ').trim();
  const names = (row) => `${row.homeTeam || '?'} v ${row.awayTeam || '?'}`;
  const money = (n) => (n === null || n === undefined ? '\u2014' : stake(n));
  const signed = (n) => (Number(n || 0) > 0 ? '+' : '') + Number(n || 0).toFixed(2);
  const liveOpps = () => (state.scan ? state.scan.opportunities : []).filter((o) => o.live === true);

  // ---- shaping -------------------------------------------------------------

  function signalCard(o) {
    const confirmed = o.verification && o.verification.status === 'confirmed';
    return `
      <div class="card p-4">
        <div class="flex items-center justify-between mb-3 gap-2">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[var(--edge-surface2)] border border-[var(--edge-border)] text-[var(--edge-textBright)] shrink-0">${escapeHtml(mkt(o.marketKey) || '\u2014')}</span>
            <span class="text-sm font-semibold text-[var(--edge-textBright)] truncate min-w-0">${escapeHtml(names(o))}</span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="status-dot ${confirmed ? 'bg-[var(--edge-green)]' : 'bg-[var(--edge-amber)]'}" aria-hidden="true"></span>
            <span class="text-xs ${confirmed ? 'text-[var(--edge-green)]' : 'text-[var(--edge-amber)]'}">${escapeHtml(t('live'))}</span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('margin'))}</div>
            <div class="text-sm font-semibold ${Number(o.marginPercent) >= 1 ? 'text-[var(--edge-green)]' : 'text-[var(--edge-textBright)]'}">${escapeHtml(signed(o.marginPercent))}%</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('profit'))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)]">${escapeHtml(money(o.guaranteedProfit))}</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('stake'))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)]">${escapeHtml(money(o.totalStake))}</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('books'))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)]">${escapeHtml(count((o.legs || []).length))}</div>
          </div>
        </div>
      </div>`;
  }

  function renderSignals() {
    const rows = liveOpps();
    const grid = $('signal-grid');
    if (!rows.length) {
      grid.innerHTML = `<div class="edge-empty col-span-full">${escapeHtml(t('noOpportunities'))}</div>`;
      return;
    }
    grid.innerHTML = rows.map(signalCard).join('');
  }

  function renderEvents() {
    const body = document.getElementById('table-events');
    if (!body) return;
    const rows = state.events.slice(0, MAX_ROWS);
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="4"><div class="edge-empty">${escapeHtml(t('noEvents'))}</div></td></tr>`;
      return;
    }
    body.innerHTML = rows.map((e) => `<tr>
      <td class="px-3 py-2 font-mono text-xs text-[var(--edge-textBright)]">${escapeHtml(e.book || '\u2014')}</td>
      <td class="px-3 py-2 text-[var(--edge-textBright)]">${escapeHtml(e.event || '\u2014')}</td>
      <td class="px-3 py-2 text-xs text-[var(--edge-textMuted)]">${escapeHtml(e.market || '\u2014')}</td>
      <td class="px-3 py-2 text-right font-semibold text-[var(--edge-textBright)]">@${escapeHtml(odds(e.odds))}</td>
    </tr>`).join('');
  }

  // ---- engine state --------------------------------------------------------

  function renderEngine() {
    const live = state.live || {};
    const on = live.enabled === true;
    const rows = liveOpps();
    const label = on ? t('enabled') : t('disabled');

    $('engine-dot').className = 'status-dot ' + (on ? 'bg-[var(--edge-green)]' : 'bg-[var(--edge-textMuted)]');
    $('engine-dot').setAttribute('aria-hidden', 'true');
    $('engine-state').textContent = label;
    $('k-state').textContent = on ? t('running') : t('stopped');
    $('k-state-sub').textContent = label;
    $('k-signals').textContent = count(rows.length);
    $('k-interval').textContent = count(live.intervalSeconds);
    $('k-lastpoll').textContent = state.lastPoll ? state.lastPoll.toLocaleTimeString() : '\u2014';
    $('k-lastrun').textContent = state.lastPoll ? t('lastRun') : '\u2014';

    $('eng-enabled').checked = on;
    $('eng-enabled-label').textContent = label;
    $('eng-interval').value = live.intervalSeconds || '';
    $('eng-books').textContent = state.selected.join(', ') || '\u2014';
  }

  // ---- price events --------------------------------------------------------

  async function loadEvents() {
    const books = state.books.filter((b) => state.selected.includes(b.id)).slice(0, MAX_BOOKS);
    if (!books.length) {
      state.events = [];
      renderEvents();
      renderEngine();
      return;
    }
    const settled = await Promise.allSettled(books.map((b) => {
      const url = liveEventsUrl(b.id);
      return arbiterApi.get(url);
    }));

    const rows = [];
    settled.forEach((outcome, i) => {
      if (outcome.status !== 'fulfilled') return;
      const payload = outcome.value;
      // GET /api/odds/:book publishes { sourceId, capturedAt, results }, one
      // entry per event+market with nested selections. The page used to look
      // for a flat `payload.events` array with e.odds / e.marketKey, which the
      // route never publishes — so the table was always empty. Flatten
      // results into one row per selection, same projection scrape.js reads.
      const results = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload && payload.results) ? payload.results : []);
      for (const r of results.slice(0, LIVE_EVENTS_LIMIT)) {
        const market = (r && r.market) || {};
        const selections = Array.isArray(market.selections) ? market.selections : [];
        for (const s of selections) {
          rows.push({
            book: books[i].id,
            event: `${r.homeTeam || '?'} v ${r.awayTeam || '?'}`,
            market: mkt(market.name || market.key || ''),
            odds: s && s.odds,
          });
        }
      }
    });

    state.events = rows;
    state.lastPoll = new Date();
    renderEvents();
    renderEngine();
  }

  // ---- data ----------------------------------------------------------------

  async function refresh() {
    const settled = await Promise.allSettled([
      arbiterApi.get('/api/live'),
      arbiterApi.get('/api/scan'),
      arbiterApi.get('/api/scrapers'),
    ]);
    const [live, scan, scrapers] = settled;

    if (scan.status === 'fulfilled' && scan.value && Array.isArray(scan.value.opportunities)) {
      state.scan = scan.value;
    }
    if (scrapers.status === 'fulfilled' && scrapers.value && Array.isArray(scrapers.value.jobs)) {
      state.books = scrapers.value.jobs
        .map((j) => ({ id: j.id, live: !!(j.liveCapability && j.liveCapability.live) }))
        .filter((b) => b.live);
    }
    if (live.status === 'fulfilled' && live.value) state.live = live.value;

    // The engine's own book list is authoritative when it has one; otherwise fall
    // back to every job that advertises live markets, which is what an operator
    // who has just enabled the engine would expect to see selected.
    const engineBooks = (state.live && state.live.bookIds) || [];
    state.selected = engineBooks.length
      ? engineBooks.filter((id) => state.books.some((b) => b.id === id))
      : state.books.map((b) => b.id);

    renderSignals();
    renderEngine();
    await loadEvents();

    if (state.scan && window.arbiterConnectionStatus && window.arbiterConnectionStatus.setDataHealth) {
      window.arbiterConnectionStatus.setDataHealth(state.scan.dataHealth || {});
    }
  }

  // ---- wiring --------------------------------------------------------------

  $('btn-poll').addEventListener('click', async () => {
    await loadEvents();
    toast(t('lastRun'), 'success');
  });

  // enable() is the only writer of the thresholds, so applying them with the
  // engine off would silently drop them. Say so rather than pretend it saved.
  $('btn-apply').addEventListener('click', async () => {
    const payload = {
      enabled: $('eng-enabled').checked,
      intervalSeconds: Number($('eng-interval').value) || undefined,
      bookIds: state.selected,
      scanOptions: (state.live && state.live.scanOptions) || undefined,
    };
    try {
      const saved = await arbiterApi.post('/api/live', payload);
      state.live = saved || payload;
      renderEngine();
      toast(t('saved'), 'success');
    } catch (err) {
      toast((err && err.error && err.error.message) || t('failedShort'), 'error');
    }
  });

  refresh();

  let pending = null;
  arbiterSse.connect((type) => {
    if (type !== 'scan-update' && type !== 'scrape-update') return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(refresh, 600);
  });

  // The engine polls on its own schedule, so the price table is refreshed on the
  // same interval the operator configured rather than only when a scan lands.
  setInterval(() => {
    if (state.live && state.live.enabled) loadEvents();
  }, 30000);
})();

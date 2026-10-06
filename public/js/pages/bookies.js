// bookies.js — ArbEdge console: bookmaker cards, feed health and per-source detail.
//
// The mockup this came from showed balances, daily P&L and win rates per book.
// None of those exist anywhere in this app: there is no balance endpoint and no
// settlement ledger behind /api/scrapers, so rendering them would have meant
// inventing numbers. The card keeps the mockup's anatomy — monogram, name,
// status dot, a 2x2 stat block, sport chips, a sync line — and the four stats
// are the things the scan envelope can actually answer: how many events the feed
// returned, how many arbitrages the book is currently a leg of, whether the feed
// validated, and whether the book exposes live markets at all.

(function () {
  arbiterApp.mount('bookies');

  const $ = (id) => document.getElementById(id);
  // Local formatters rather than window.arbiterFormat. pages/common.js does
  // define these keys and every one of these pages loads it, but it is a plain
  // script evaluated before this file, and the harness in
  // test/scan-fields-census.test.mjs runs this file with the global set to null
  // on purpose — to catch a reader that assumes an object exists at load time.
  // The other page scripts here format locally for the same reason.
  const count = (n) => Number(n || 0).toLocaleString('en-US');
  function timeAgo(ms) {
    if (!ms) return '\u2014';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.round(m / 60) + 'h ago';
  }
  const t = (key) => window.arbiterI18n.t(key);
  // window.showToast, guarded. It is the one shared helper eslint does not
  // declare as a global, because a page is allowed to run without it —
  // pages/common.js owns it and analytics.js guards the same call.
  const toast = (message, type, opts) => {
    if (typeof window.showToast === 'function') window.showToast(message, type, opts);
  };

  const state = { jobs: [], byId: new Map() };

  // ---- derived per-book view of the two endpoints --------------------------

  function buildIndex(scrapers, scan) {
    const sources = new Map();
    for (const s of scan.sources || []) sources.set(s.sourceId, s);

    const arbsByBook = new Map();
    for (const o of scan.opportunities || []) {
      for (const leg of o.legs || []) {
        arbsByBook.set(leg.sourceId, (arbsByBook.get(leg.sourceId) || 0) + 1);
      }
    }

    state.jobs = (scrapers.jobs || []).map((job) => {
      const sourceIds = job.sourceIds && job.sourceIds.length ? job.sourceIds : [job.id];
      const captured = sourceIds.map((id) => sources.get(id)).filter(Boolean);
      const events = captured.reduce((sum, s) => sum + (Number(s.count) || 0), 0);
      const lastCapturedAt = captured.map((s) => s.capturedAt).filter(Boolean).sort().pop() || null;
      const live = job.liveCapability || {};
      const arbs = sourceIds.reduce((sum, id) => sum + (arbsByBook.get(id) || 0), 0);

      // "Connected" is not a stored flag anywhere, so it is derived from the two
      // that are: a job counts as connected only once it is switched on and its
      // feed has passed validation.
      let status = 'connected';
      if (!job.enabled) status = 'offline';
      else if (job.validationStatus !== 'validated' || job.feedStatus !== 'verified') status = 'warning';

      return {
        id: job.id,
        name: job.name || job.id,
        status,
        enabled: !!job.enabled,
        validationStatus: job.validationStatus || 'unknown',
        validationReason: job.validationReason || '',
        feedStatus: job.feedStatus || 'verified',
        engine: job.engine || '\u2014',
        transport: job.transport || '\u2014',
        sports: job.supportedSports || [],
        sourceIds,
        events,
        arbs,
        liveCapable: live.live === true,
        liveScope: live.scope || '\u2014',
        liveField: live.field || '\u2014',
        liveMeasured: live.measured === true,
        lastCapturedAt,
      };
    });

    state.byId = new Map(state.jobs.map((j) => [j.id, j]));
  }

  // ---- KPI row and the sidebar footer --------------------------------------
  //
  // The mockup's footer card held Total Balance, Today's P&L, Active Arbs and a
  // Week Goal bar. Balance and P&L have no source in this app; signals, arbs,
  // middles and a source-coverage bar do, and the last one keeps the progress
  // bar the design spends on the goal.

  function renderCounts(scan) {
    const sources = scan.sources || [];
    const fresh = sources.filter((s) => s.dataStatus === 'fresh').length;
    const connected = state.jobs.filter((j) => j.status === 'connected').length;
    const events = state.jobs.reduce((sum, j) => sum + j.events, 0);

    $('kpi-tracked').textContent = count(state.jobs.length);
    $('kpi-tracked-sub').textContent = count(connected) + ' ' + t('connected');
    $('kpi-events').textContent = count(events);
    $('kpi-events-sub').textContent = count(sources.length) + ' ' + t('sources');
    $('kpi-online').textContent = count(fresh);
    $('kpi-stale').textContent = count(sources.length - fresh);
    $('kpi-stale-sub').textContent = count(sources.length) + ' ' + t('sources');
  }

  // ---- card grid -----------------------------------------------------------
  //
  // Status rides on a utility class on the dot and on the label, which is how
  // the mockup expressed it with Tailwind's arbitrary-value syntax.

  const DOT = {
    connected: 'bg-[var(--edge-green)]',
    warning: 'bg-[var(--edge-amber)]',
    offline: 'bg-[var(--edge-red)]',
  };
  const TEXT = {
    connected: 'text-[var(--edge-green)]',
    warning: 'text-[var(--edge-amber)]',
    offline: 'text-[var(--edge-red)]',
  };
  const LABEL = { connected: 'connected', warning: 'warning', offline: 'offline' };

  function monogram(id) {
    return String(id || '?').replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase() || '?';
  }

  function sportChips(sports) {
    if (!sports || !sports.length) {
      return `<span class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('noSports'))}</span>`;
    }
    return sports.map((s) => `<span class="text-sm">${escapeHtml(s)}</span>`).join('');
  }

  function stat(label, value, tone) {
    const colour = tone || 'text-[var(--edge-textBright)]';
    return `<div>
      <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(label)}</div>
      <div class="text-sm font-semibold ${colour}">${escapeHtml(value)}</div>
    </div>`;
  }

  function bookCard(j) {
    const sync = j.lastCapturedAt ? timeAgo(Date.now() - new Date(j.lastCapturedAt).getTime()) : '\u2014';
    return `
      <button type="button" class="card edge-card-button p-4 text-left w-full flex flex-col items-stretch" data-book="${escapeHtml(j.id)}">
        <div class="flex items-center justify-between mb-3 gap-2 w-full">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[var(--edge-surface2)] border border-[var(--edge-border)] text-[var(--edge-textBright)] shrink-0">${escapeHtml(monogram(j.id))}</span>
            <span class="text-sm font-semibold text-[var(--edge-textBright)] truncate min-w-0">${escapeHtml(j.name)}</span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="status-dot ${DOT[j.status]}" aria-hidden="true"></span>
            <span class="text-xs ${TEXT[j.status]}">${escapeHtml(t(LABEL[j.status]))}</span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-3">
          ${stat(t('events'), count(j.events))}
          ${stat(t('activeArbs'), count(j.arbs), j.arbs > 0 ? 'text-[var(--edge-green)]' : 'text-[var(--edge-textBright)]')}
          ${stat(t('feed'), j.feedStatus, j.feedStatus === 'verified' ? 'text-[var(--edge-green)]' : 'text-[var(--edge-amber)]')}
          ${stat(t('live'), j.liveCapable ? t('yes') : t('no'), j.liveCapable ? 'text-[var(--edge-blue)]' : 'text-[var(--edge-textBright)]')}
        </div>
        <div class="flex items-center justify-between gap-2 pt-3 border-t border-[var(--edge-border)]">
          <div class="flex flex-wrap gap-1 min-w-0">${sportChips(j.sports)}</div>
          <span class="shrink-0 text-[10px] text-[var(--edge-textMuted)]">${escapeHtml(t('sync'))} ${escapeHtml(sync)}</span>
        </div>
      </button>`;
  }

  // The mockup closed its grid with a dashed "Add Bookmaker" tile. There is no
  // endpoint that creates a bookmaker — a book is an entry in
  // config/scrapers.json — so the tile opens a dialog that says so rather than
  // letting a click look like it worked.
  function addCard() {
    return `
      <button type="button" class="card p-4 flex flex-col items-center justify-center gap-2 border-dashed border-[var(--edge-border2)] text-[var(--edge-textMuted)] hover:text-[var(--edge-text)] hover:border-[var(--edge-textMuted)] cursor-pointer min-h-[200px]" data-add>
        <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
        <span class="text-sm font-medium">Add Bookmaker</span>
      </button>`;
  }

  function renderGrid() {
    $('bookies-grid').innerHTML = state.jobs.map(bookCard).join('') + addCard();
  }

  // ---- detail modal --------------------------------------------------------

  function tile(label, value, tone) {
    const colour = tone || 'text-[var(--edge-textBright)]';
    return `<div class="bg-[var(--edge-surface2)] rounded-lg p-3">
      <div class="text-xs text-[var(--edge-textMuted)] mb-1">${escapeHtml(label)}</div>
      <div class="font-semibold ${colour}">${escapeHtml(value)}</div>
    </div>`;
  }

  function openDetail(id) {
    const j = state.byId.get(id);
    if (!j) return;

    $('modal-title').textContent = j.name;
    $('modal-body').innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <span class="px-1.5 py-0.5 rounded text-xs font-bold bg-[var(--edge-surface2)] border border-[var(--edge-border)] text-[var(--edge-textBright)]">${escapeHtml(monogram(j.id))}</span>
        <span class="status-dot ${DOT[j.status]}" aria-hidden="true"></span>
        <span class="text-sm ${TEXT[j.status]}">${escapeHtml(t(LABEL[j.status]))}</span>
      </div>
      <div class="grid grid-cols-2 gap-3 text-sm">
        ${tile(t('events'), count(j.events))}
        ${tile(t('activeArbs'), count(j.arbs))}
        ${tile(t('validation'), j.validationStatus, j.validationStatus === 'validated' ? 'text-[var(--edge-green)]' : 'text-[var(--edge-amber)]')}
        ${tile(t('live'), j.liveMeasured ? (j.liveCapable ? t('yes') : t('no')) : t('notMeasured'))}
      </div>
      <div class="bg-[var(--edge-surface2)] rounded-lg p-3 text-sm">
        <div class="text-xs text-[var(--edge-textMuted)] mb-1">${escapeHtml(t('sourceIds'))}</div>
        <div class="font-mono text-xs text-[var(--edge-textBright)]">${escapeHtml(j.sourceIds.join(', '))}</div>
      </div>
      <div class="bg-[var(--edge-surface2)] rounded-lg p-3 text-sm">
        <div class="text-xs text-[var(--edge-textMuted)] mb-1">${escapeHtml(t('coveredSports'))}</div>
        <div class="flex gap-2 text-lg">${sportChips(j.sports)}</div>
      </div>
      ${j.validationReason ? `<div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(j.validationReason)}</div>` : ''}
      <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('engine'))} ${escapeHtml(j.engine)} &middot; ${escapeHtml(t('transport'))} ${escapeHtml(j.transport)}</div>
      ${j.lastCapturedAt ? `<div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('lastSync'))} ${escapeHtml(new Date(j.lastCapturedAt).toLocaleString())}</div>` : ''}`;

    $('detail-modal').classList.remove('hidden');
    document.addEventListener('keydown', onKey);
  }

  function closeDetail() {
    $('detail-modal').classList.add('hidden');
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') closeDetail();
  }

  // ---- add dialog ----------------------------------------------------------

  function openAdd() {
    $('add-modal').classList.remove('hidden');
  }

  function closeAdd() {
    $('add-modal').classList.add('hidden');
  }

  // ---- data ----------------------------------------------------------------

  async function refresh() {
    let scrapers;
    let scan;
    try {
      [scrapers, scan] = await Promise.all([
        arbiterApi.get('/api/scrapers'),
        arbiterApi.get('/api/scan'),
      ]);
    } catch (_err) {
      $('kpi-tracked-sub').textContent = t('failedShort');
      return;
    }
    if (!scrapers || !Array.isArray(scrapers.jobs)) return;

    const envelope = scan && Array.isArray(scan.opportunities) ? scan : { sources: [], opportunities: [] };
    buildIndex(scrapers, envelope);
    renderCounts(envelope);
    renderGrid();

    if (window.arbiterConnectionStatus && window.arbiterConnectionStatus.setDataHealth) {
      window.arbiterConnectionStatus.setDataHealth(envelope.dataHealth || {});
    }
  }

  // ---- wiring --------------------------------------------------------------

  $('bookies-grid').addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) {
      openAdd();
      return;
    }
    const card = e.target.closest('[data-book]');
    if (card) openDetail(card.dataset.book);
  });

  document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeDetail));
  document.querySelectorAll('[data-close-add]').forEach((el) => el.addEventListener('click', closeAdd));
  $('btn-add').addEventListener('click', openAdd);

  // There is no create endpoint, so the form does not pretend to submit. It says
  // what a real one would have to touch instead, which is also the only honest
  // answer while config/scrapers.json is the source of truth for a book.
  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('add-id').value.trim();
    if (!id) {
      toast(t('failedShort'), 'error');
      return;
    }
    toast(id + ' → config/scrapers.json', 'info', { duration: 6000 });
    closeAdd();
  });

  refresh();

  let pending = null;
  arbiterSse.connect((type) => {
    if (type !== 'scrape-update' && type !== 'scan-update') return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(refresh, 600);
  });
})();

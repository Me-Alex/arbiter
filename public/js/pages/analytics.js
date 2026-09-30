arbiterApp.mount('analytics');
    const $ = (id) => document.getElementById(id);
    let _isFirstAnalyticsLoad = true;

    // Skeleton loading states for tables while data loads
    const TABLE_SKELETON_ROWS = 4;
    // The tracker table's real width. It was 8 while the header row had 8
    // <th>s; adding the placed-at column means the loading state and the empty
    // state have to move with it or a slow /api/tracker paints one wide cell
    // across a nine-column table.
    const TRACKER_COLS = 9;
    function skeletonRow(cols) {
      return `<tr class="loading-row"><td colspan="${cols}"><div class="skeleton skeleton-line" style="width:${60 + Math.random() * 30}%"></div></td></tr>`;
    }
    function showTableSkeleton(tableId, cols) {
      const tbody = document.querySelector(`#${tableId} tbody`);
      if (tbody) tbody.innerHTML = Array(TABLE_SKELETON_ROWS).fill('').map(() => skeletonRow(cols)).join('');
    }

    // Show skeleton loading immediately
    showTableSkeleton('tracker-table', TRACKER_COLS);
    showTableSkeleton('catalog-table', 4);

    function eventLabel(value) {
      const parts = String(value || '').split('|').slice(-2);
      const vs = arbiterI18n.t.bind(arbiterI18n)('vs');
      return parts.map(escapeHtml).join(` <span class="muted">${vs}</span> `);
    }

    /**
     * A stored timestamp, or an em dash when there is not one.
     *
     * `createdAt` is written by the service on every bet and `updatedAt` only
     * once a row has been settled, so the second is genuinely optional. The
     * falsy check is the load-bearing part: `new Date(null)` is the epoch and
     * `new Date(0)` is too, so without it a bet with no date at all is stamped
     * 1 January 1970 and reads as a fact about the bet rather than as a gap in
     * the record. The service writes an ISO string, so a falsy number arriving
     * here is an uninitialised field, not a placement in 1970.
     */
    function fmtWhen(value) {
      if (!value) return '—';
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : '—';
    }

    /**
     * What to say about an import the route has just run.
     *
     * The route counts what it skipped, and the answer used to be thrown away:
     * a file whose rows were mostly unusable closed the dialog and re-rendered
     * a shorter table, which is exactly what a clean import looks like. Three
     * answers, because "nothing happened" and "something happened and here is
     * what was lost" are the two cases a silent re-render folds into one.
     */
    function importSummary(result, t) {
      const imported = Number(result?.imported) || 0;
      const skipped = Number(result?.skipped) || 0;
      if (!imported && !skipped) return { message: t('toastImportEmpty'), type: 'warning' };
      if (skipped) {
        return { message: t('toastImportPartial').replace('{n}', String(imported)).replace('{skipped}', String(skipped)), type: 'warning' };
      }
      return { message: t('toastImportDone').replace('{n}', String(imported)), type: 'success' };
    }

    async function init() {
      const t = arbiterI18n.t.bind(arbiterI18n);
      const scan = await arbiterApi.get('/api/scan').catch(() => ({}));
      $('k-opps').textContent = (scan.opportunities || []).length;
      $('k-mids').textContent = (scan.middles || []).length;
      $('k-ev').textContent = (scan.positiveEv || []).length;
      $('k-low').textContent = (scan.lowHold || []).length;

      // Update data-freshness banner (A4)
      if (window.arbiterConnectionStatus && window.arbiterConnectionStatus.setDataHealth) {
        window.arbiterConnectionStatus.setDataHealth(scan.dataHealth || {});
      }

      // Flash effect on KPI cards (skip first load)
      if (!_isFirstAnalyticsLoad) {
        document.querySelectorAll('.analytics-kpis .kpi-card').forEach((card, i) => {
          setTimeout(() => card.classList.add('flash'), i * 40);
          setTimeout(() => card.classList.remove('flash'), 500 + i * 40);
        });
      }
      _isFirstAnalyticsLoad = false;

      const cat = await arbiterApi.get('/api/catalog').catch(() => ({}));
      const tb = document.querySelector('#catalog-table tbody');
      const all = (cat.markets || []).slice().sort((a, b) => b.eventCount - a.eventCount);
      const renderCatalog = (rows) => {
        tb.innerHTML = rows.length ? rows.map((m) => `
          <tr>
            <td class="mono accent">${escapeHtml(m.sourceId)}</td>
            <td class="mono">${escapeHtml(m.marketKey)}</td>
            <td class="num tabnum">${Number(m.eventCount || 0).toLocaleString()}</td>
            <td class="num tabnum">${Number(m.selectionCount || 0).toLocaleString()}</td>
          </tr>`).join('') : `<tr><td colspan="4"><div class="empty">
            <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg></div>
            <div>${escapeHtml(t('noMarkets'))}</div>
            <div class="empty-actions"><a class="btn primary" href="/admin/scrape.html">${escapeHtml(t('runScrape'))}</a></div>
          </div></td></tr>`;
      };
      renderCatalog(all);
      $('cat-search').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        renderCatalog(all.filter((m) => m.sourceId.toLowerCase().includes(q) || m.marketKey.toLowerCase().includes(q)));
      });

      const tracker = await arbiterApi.get('/api/tracker');
      renderTracker(tracker);
    }

    function renderTracker(tracker) {
      const t = arbiterI18n.t.bind(arbiterI18n);
      const tb = document.querySelector('#tracker-table tbody');
      const items = tracker.items || [];
      $('tracker-count').textContent = `${items.length} ${t(items.length === 1 ? 'item' : 'items')}`;
      tb.innerHTML = items.length ? items.map((b) => `
        <tr class="${b.status === 'won' ? 'row-confirmed' : b.status === 'lost' ? 'row-rejected' : ''}">
          <td><div>${escapeHtml(fmtWhen(b.createdAt))}</div>${
            b.updatedAt ? `<div class="bet-when-updated">${escapeHtml(t('betUpdated'))} ${escapeHtml(fmtWhen(b.updatedAt))}</div>` : ''
          }</td>
          <td><div class="strong">${eventLabel(b.eventKey)}</div></td>
          <td class="mono text-xs">${escapeHtml(b.marketKey || '')}</td>
          <td><div>${escapeHtml(b.selection || '')}</div>${
            // The note is the one field on this bet the table had no place for
            // at all, and the only way one gets in is the CSV import this page
            // offers — so an imported bet's own annotation was unreadable after
            // the import that carried it. Clamped, with the full text on the
            // title, because 1000 characters of free prose is not a column.
            b.notes ? `<span class="bet-note muted text-xs" title="${escapeHtml(b.notes)}">${escapeHtml(b.notes)}</span>` : ''
          }</td>
          <td><div class="mono accent">${escapeHtml(b.sourceId || '')}</div>${
            b.provenance ? `<span class="bet-origin">${escapeHtml(b.provenance)}</span>` : ''
          }</td>
          <td class="num tabnum">${(b.odds || 0).toFixed(2)}</td>
          <td class="num tabnum">${(b.stake || 0).toFixed(2)}</td>
          <td><span class="status ${escapeHtml(b.status || 'pending')}">${escapeHtml(b.status || 'pending')}</span></td>
          <td class="num">
            <div class="row gap-2" style="justify-content:flex-end">
              <button class="ghost sm" data-action="won" data-id="${escapeHtml(b.id)}" title="${escapeHtml(t('markWon'))}" aria-label="${escapeHtml(t('markWon'))}">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 8 7 12 13 4"/></svg>
              </button>
              <button class="ghost sm" data-action="lost" data-id="${escapeHtml(b.id)}" title="${escapeHtml(t('markLost'))}" aria-label="${escapeHtml(t('markLost'))}">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
              </button>
              <button class="ghost sm danger" data-action="del" data-id="${escapeHtml(b.id)}" title="${escapeHtml(t('delete'))}" aria-label="${escapeHtml(t('delete'))}">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 4 8 9 13 4"/><line x1="3" y1="4" x2="3" y2="14" /><line x1="13" y1="4" x2="13" y2="14" /></svg>
              </button>
            </div>
          </td>
        </tr>
      `).join('') : `<tr><td colspan="${TRACKER_COLS}"><div class="empty">
            <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></div>
            <div>${escapeHtml(t('noBets'))}</div>
          </div></td></tr>`;
      tb.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          const action = btn.getAttribute('data-action');
          try {
            if (action === 'del') {
              if (!window.confirm(t('confirmDelete') || t('delete') + '?')) return;
              await arbiterApi.del('/api/tracker/' + encodeURIComponent(id));
            } else {
              await arbiterApi.put('/api/tracker/' + encodeURIComponent(id), { status: action === 'won' ? 'won' : 'lost' });
            }
            renderTracker(await arbiterApi.get('/api/tracker'));
          } catch (err) {
            console.warn('tracker update failed', err);
          }
        });
      });
    }

    // — add-bet modal —
    const addBetDialog = $('add-bet-dialog');
    const addBetForm = $('add-bet-form');
    const addBetError = $('add-bet-error');
    function openAddBet() {
      addBetForm.reset();
      if (addBetForm.querySelector('#ab-market')) addBetForm.querySelector('#ab-market').value = 'MATCH_ODDS';
      addBetError.classList.add('hidden');
      addBetError.textContent = '';
      addBetDialog.showModal();
    }
    $('add-bet').addEventListener('click', openAddBet);
    addBetDialog.querySelectorAll('[data-close-add-bet]').forEach((b) => b.addEventListener('click', () => addBetDialog.close()));
    addBetDialog.addEventListener('click', (e) => { if (e.target === addBetDialog) addBetDialog.close(); });
    addBetDialog.addEventListener('cancel', () => addBetDialog.close());
    addBetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = arbiterI18n.t.bind(arbiterI18n);
      const fd = new FormData(addBetForm);
      const selection = String(fd.get('selection') || '').trim();
      const odds = Number(fd.get('odds'));
      const stake = Number(fd.get('stake'));
      const sourceId = String(fd.get('sourceId') || '').trim() || 'unknown';
      const marketKey = String(fd.get('marketKey') || '').trim() || 'MATCH_ODDS';
      if (!selection || !Number.isFinite(odds) || odds < 1.01 || !Number.isFinite(stake) || stake <= 0) {
        addBetError.textContent = t('requiredFieldsError');
        addBetError.classList.remove('hidden');
        return;
      }
      try {
        await arbiterApi.post('/api/tracker', { selection, odds, stake, sourceId, marketKey, status: 'pending', provenance: 'manual' });
        addBetDialog.close();
        renderTracker(await arbiterApi.get('/api/tracker'));
      } catch (err) {
        addBetError.textContent = err.message || t('failedAddBet');
        addBetError.classList.remove('hidden');
      }
    });
    // — import-csv modal —
    const importCsvDialog = $('import-csv-dialog');
    const importCsvForm = $('import-csv-form');
    const importCsvError = $('import-csv-error');
    const csvInput = $('import-csv-input');
    $('import-csv').addEventListener('click', () => {
      importCsvError.classList.add('hidden');
      importCsvError.textContent = '';
      csvInput.value = '';
      importCsvDialog.showModal();
    });
    importCsvDialog.querySelectorAll('[data-close-import-csv]').forEach((b) => b.addEventListener('click', () => importCsvDialog.close()));
    importCsvDialog.addEventListener('click', (e) => { if (e.target === importCsvDialog) importCsvDialog.close(); });
    importCsvDialog.addEventListener('cancel', () => importCsvDialog.close());
    importCsvForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = arbiterI18n.t.bind(arbiterI18n);
      const csv = csvInput.value.trim();
      if (!csv) {
        importCsvError.textContent = t('pasteCsvFirst');
        importCsvError.classList.remove('hidden');
        return;
      }
      try {
        const result = await arbiterApi.post('/api/tracker/import', { csv });
        importCsvDialog.close();
        renderTracker(await arbiterApi.get('/api/tracker'));
        if (typeof window.showToast === 'function') {
          const summary = importSummary(result, t);
          window.showToast(summary.message, summary.type);
        }
      } catch (err) {
        importCsvError.textContent = err.message || t('failedImport');
        importCsvError.classList.remove('hidden');
      }
    });
    $('export-csv').addEventListener('click', () => window.location.href = '/api/tracker/export.csv');

    arbiterSse.connect((type) => { if (type === 'scan-update') init(); });
    init().catch((err) => console.warn('analytics init failed', err));

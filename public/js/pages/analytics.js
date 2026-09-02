arbiterApp.mount('analytics');
    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
      })[char]);
    }

    function eventLabel(value) {
      const parts = String(value || '').split('|').slice(-2);
      return parts.map(escapeHtml).join(' <span class="muted">vs</span> ');
    }

    async function init() {
      const t = arbiterI18n.t.bind(arbiterI18n);
      const scan = await arbiterApi.get('/api/scan').catch(() => ({}));
      $('k-opps').textContent = (scan.opportunities || []).length;
      $('k-mids').textContent = (scan.middles || []).length;
      $('k-ev').textContent = (scan.positiveEv || []).length;
      $('k-low').textContent = (scan.lowHold || []).length;

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
          </tr>`).join('') : `<tr><td colspan="4" class="empty">${escapeHtml(t('noMarkets'))}</td></tr>`;
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
          <td><div class="strong">${eventLabel(b.eventKey)}</div></td>
          <td class="mono text-xs">${escapeHtml(b.marketKey || '')}</td>
          <td>${escapeHtml(b.selection || '')}</td>
          <td class="mono accent">${escapeHtml(b.sourceId || '')}</td>
          <td class="num tabnum">${(b.odds || 0).toFixed(2)}</td>
          <td class="num tabnum">${(b.stake || 0).toFixed(2)}</td>
          <td><span class="status ${escapeHtml(b.status || 'pending')}">${escapeHtml(b.status || 'pending')}</span></td>
          <td class="num">
            <div class="row" style="gap:4px;justify-content:flex-end">
              <button class="ghost sm" data-action="won" data-id="${escapeHtml(b.id)}" title="${escapeHtml(t('markWon'))}" aria-label="${escapeHtml(t('markWon'))}">W</button>
              <button class="ghost sm" data-action="lost" data-id="${escapeHtml(b.id)}" title="${escapeHtml(t('markLost'))}" aria-label="${escapeHtml(t('markLost'))}">L</button>
              <button class="ghost sm" data-action="del" data-id="${escapeHtml(b.id)}" title="${escapeHtml(t('delete'))}" aria-label="${escapeHtml(t('delete'))}">×</button>
            </div>
          </td>
        </tr>
      `).join('') : `<tr><td colspan="8" class="empty">${escapeHtml(t('noBets'))}</td></tr>`;
      tb.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          const action = btn.getAttribute('data-action');
          try {
            if (action === 'del') {
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
        await arbiterApi.post('/api/tracker/import', { csv });
        importCsvDialog.close();
        renderTracker(await arbiterApi.get('/api/tracker'));
      } catch (err) {
        importCsvError.textContent = err.message || t('failedImport');
        importCsvError.classList.remove('hidden');
      }
    });
    $('export-csv').addEventListener('click', () => window.location.href = '/api/tracker/export.csv');

    arbiterSse.connect((type) => { if (type === 'scan-update') init(); });
    init().catch((err) => console.warn('analytics init failed', err));

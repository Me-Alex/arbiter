arbiterApp.mount('analytics');
    const $ = (id) => document.getElementById(id);

    async function init() {
      const scan = await arbiterApi.get('/api/scan').catch(() => ({}));
      $('k-opps').textContent = (scan.opportunities || []).length;
      $('k-mids').textContent = (scan.middles || []).length;
      $('k-ev').textContent = (scan.positiveEv || []).length;
      $('k-low').textContent = (scan.lowHold || []).length;

      const cat = await arbiterApi.get('/api/catalog').catch(() => ({}));
      const tb = document.querySelector('#catalog-table tbody');
      const all = (cat.markets || []).slice().sort((a, b) => b.eventCount - a.eventCount);
      const render = (rows) => {
        tb.innerHTML = rows.length ? rows.map((m) => `
          <tr>
            <td class="mono accent">${m.sourceId}</td>
            <td class="mono">${m.marketKey}</td>
            <td class="num tabnum">${m.eventCount.toLocaleString()}</td>
            <td class="num tabnum">${m.selectionCount.toLocaleString()}</td>
          </tr>`).join('') : `<tr><td colspan="4" class="empty">no markets discovered yet</td></tr>`;
      };
      render(all);
      $('cat-search').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        render(all.filter((m) => m.sourceId.includes(q) || m.marketKey.toLowerCase().includes(q)));
      });

      const tracker = await arbiterApi.get('/api/tracker');
      renderTracker(tracker);
    }

    function renderTracker(t) {
      const tb = document.querySelector('#tracker-table tbody');
      const items = t.items || [];
      $('tracker-count').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
      tb.innerHTML = items.length ? items.map((b) => `
        <tr class="${b.status === 'won' ? 'row-confirmed' : b.status === 'lost' ? 'row-rejected' : ''}">
          <td class="mono">${b.eventKey || ''}</td>
          <td class="mono text-xs">${b.marketKey || ''}</td>
          <td>${b.selection || ''}</td>
          <td class="mono accent">${b.sourceId || ''}</td>
          <td class="num tabnum">${(b.odds||0).toFixed(2)}</td>
          <td class="num tabnum">${(b.stake||0).toFixed(2)}</td>
          <td><span class="status ${b.status || 'pending'}">${b.status || 'pending'}</span></td>
          <td class="num">
            <div class="row" style="gap:4px;justify-content:flex-end">
              <button class="ghost sm" data-action="won" data-id="${b.id}" title="Won">W</button>
              <button class="ghost sm" data-action="lost" data-id="${b.id}" title="Lost">L</button>
              <button class="ghost sm" data-action="del" data-id="${b.id}" title="Delete">×</button>
            </div>
          </td>
        </tr>
      `).join('') : `<tr><td colspan="8" class="empty">no bets tracked yet — click "Add bet" to start</td></tr>`;
      tb.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          const action = btn.getAttribute('data-action');
          if (action === 'del') {
            await arbiterApi.del('/api/tracker/' + encodeURIComponent(id));
          } else {
            await arbiterApi.put('/api/tracker/' + encodeURIComponent(id), { status: action === 'won' ? 'won' : 'lost' });
          }
          renderTracker(await arbiterApi.get('/api/tracker'));
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
      const fd = new FormData(addBetForm);
      const selection = String(fd.get('selection') || '').trim();
      const odds = Number(fd.get('odds'));
      const stake = Number(fd.get('stake'));
      const sourceId = String(fd.get('sourceId') || '').trim() || 'unknown';
      const marketKey = String(fd.get('marketKey') || '').trim() || 'MATCH_ODDS';
      if (!selection || !Number.isFinite(odds) || odds < 1.01 || !Number.isFinite(stake) || stake <= 0) {
        addBetError.textContent = 'Please fill selection, odds (>=1.01) and stake (>0).';
        addBetError.classList.remove('hidden');
        return;
      }
      try {
        await arbiterApi.post('/api/tracker', { selection, odds, stake, sourceId, marketKey, status: 'pending', provenance: 'manual' });
        addBetDialog.close();
        renderTracker(await arbiterApi.get('/api/tracker'));
      } catch (err) {
        addBetError.textContent = err.message || 'failed to add bet';
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
      const csv = csvInput.value.trim();
      if (!csv) {
        importCsvError.textContent = 'Paste some CSV first.';
        importCsvError.classList.remove('hidden');
        return;
      }
      try {
        await arbiterApi.post('/api/tracker/import', { csv });
        importCsvDialog.close();
        renderTracker(await arbiterApi.get('/api/tracker'));
      } catch (err) {
        importCsvError.textContent = err.message || 'failed to import csv';
        importCsvError.classList.remove('hidden');
      }
    });
    $('export-csv').addEventListener('click', () => window.location.href = '/api/tracker/export.csv');

    arbiterSse.connect((type) => { if (type === 'scan-update') init(); });
    init();

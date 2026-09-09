/* global createDropdown */

    const $ = (id) => document.getElementById(id);
    let _sportsData = [];
    let _isFirstScanLoad = true;

    function evMatchLabel(eventKey) {
      const parts = String(eventKey || '').split('|').slice(-2);
      const vs = arbiterI18n.t.bind(arbiterI18n)('vs');
      return parts.map(escapeHtml).join(` <span class="muted">${vs}</span> `);
    }

    function verificationCell(t, o) {
      return o.verification
        ? `<span class="status ${escapeHtml(o.verification.status)}">${escapeHtml(o.verification.status)}</span>`
        : `<span class="muted text-xs">${escapeHtml(t('unverified'))}</span>`;
    }

    async function init() {
      const [profiles, sportsData] = await Promise.all([
        arbiterApi.get('/api/profiles').then((d) => d.profiles || []),
        arbiterApi.get('/api/sports').then((d) => d.sports || []).catch(() => []),
      ]);
      _sportsData = sportsData;
      $('profile').innerHTML = profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
      $('profile').value = profiles[0]?.id || '';
// Create sport filter dropdown with persistence using common helper
      createDropdown('sport-filter', [{value: '', text: arbiterI18n.t('allSports')}].concat(sportsData.map(s => ({value: s.id, text: s.name}))), {storageKey: 'arbiter.scannerSportFilter'});
      // The createDropdown handles restoring value and change listener.
      // No further manual handling needed.

      $('profile').addEventListener('change', () => {
        const p = profiles.find((x) => x.id === $('profile').value);
        if (!p) return;
        const d = p.defaults || {};
        if (d.bankroll !== null && d.bankroll !== undefined) $('bankroll').value = d.bankroll;
        if (d.minRoiPercent !== null && d.minRoiPercent !== undefined) $('min-roi').value = d.minRoiPercent;
        if (d.maxMiddleRiskPercent !== null && d.maxMiddleRiskPercent !== undefined) $('mid-risk').value = d.maxMiddleRiskPercent;
        if (d.minMiddleRoiPercent !== null && d.minMiddleRoiPercent !== undefined) $('mid-roi').value = d.minMiddleRoiPercent;
      });
      await refreshPublished();
    }

    function setTableState(message, className = 'empty') {
      [['arb-table', 6], ['mid-table', 5], ['ev-table', 6]].forEach(([id, colspan]) => {
        const body = document.querySelector(`#${id} tbody`);
        if (body) body.innerHTML = `<tr><td colspan="${colspan}" class="${className}">${escapeHtml(message)}</td></tr>`;
      });
    }

    function setLoading() {
      [['arb-table', 6], ['mid-table', 5], ['ev-table', 6]].forEach(([id, colspan]) => {
        const body = document.querySelector(`#${id} tbody`);
        if (body) body.innerHTML = `<tr class="loading-row"><td colspan="${colspan}"><span class="skeleton skeleton-line lg">Loading scan results</span></td></tr>`;
      });
    }

    async function refreshPublished() {
      try {
        setLoading();
        render(await arbiterApi.get('/api/scan'));
      } catch (err) {
        const t = arbiterI18n.t.bind(arbiterI18n);
        console.warn('published scan unavailable', err);
        setTableState(err.message || t('failedToLoad'), 'scanner-error');
        $('health-state').textContent = t('failedToLoad');
        $('health-state').className = 'health-error';
      }
    }

    async function previewScan() {
      const button = $('rescan');
      button.disabled = true;
      button.classList.add('pulse');
      setLoading();
      try {
        const sportVal = $('sport-filter').value || undefined;
        const data = await arbiterApi.post('/api/scan', {
          bankroll: Number($('bankroll').value),
          minRoiPercent: Number($('min-roi').value),
          maxMiddleRiskPercent: Number($('mid-risk').value),
          minMiddleRoiPercent: Number($('mid-roi').value),
          includeLive: false,
          includePast: false,
          ...(sportVal ? { sport: sportVal } : {}),
        });
        render(data);
      } catch (err) {
        console.warn('scan preview failed', err);
        setTableState(err.message || arbiterI18n.t('failedToLoad'), 'scanner-error');
      } finally {
        button.disabled = false;
        button.classList.remove('pulse');
      }
    }

    function filterBySport(items, sport) {
      if (!sport) return items;
      return (items || []).filter((o) => (o.sport || 'football').toLowerCase() === sport.toLowerCase());
    }

    function render(scan) {
      const t = arbiterI18n.t.bind(arbiterI18n);
      const activeSport = $('sport-filter')?.value || '';
      const health = scan.dataHealth || {};
      const healthStatus = health.status || 'empty';
      const noData = healthStatus !== 'fresh';

      // Update data-freshness banner (A4)
      if (window.arbiterConnectionStatus && window.arbiterConnectionStatus.setDataHealth) {
        window.arbiterConnectionStatus.setDataHealth(health);
      }
      const healthLabel = healthStatus === 'fresh' ? t('freshSources') : healthStatus;
      $('health-state').textContent = healthLabel;
      $('health-state').className = `health-${escapeHtml(healthStatus)}`;
      $('health-detail').textContent = `${Number(health.actionableSourceCount || 0)} ${t('freshSources')}`;
      $('scan-updated').textContent = scan.scannedAt || scan.scanStartedAt ? new Date(scan.scannedAt || scan.scanStartedAt).toLocaleString() : '—';
      $('scan-events').textContent = `${Number(scan.eventCount || 0).toLocaleString()} events`;

      const emptyBox = $('scan-empty');
      if (noData && !(scan.opportunities || []).length && !(scan.middles || []).length && !(scan.positiveEv || []).length) {
        emptyBox.className = 'alert warn';
        emptyBox.innerHTML = `${escapeHtml(t('noFreshData'))} <a href="/admin/scrape.html">${escapeHtml(t('runScrape'))}</a>`;
      } else {
        emptyBox.className = 'hidden';
      }

      // Show active sport filter indicator with display name
      const sportBanner = $('scan-sport-indicator');
      if (sportBanner) {
        if (activeSport) {
          const sportName = _sportsData.find((s) => s.id === activeSport)?.name || activeSport;
          sportBanner.textContent = `${t('sport')}: ${sportName}`;
          sportBanner.className = 'chip chip-sport';
        } else {
          sportBanner.textContent = '';
          sportBanner.className = 'hidden';
        }
      }

      const arb = document.querySelector('#arb-table tbody');
      const opps = filterBySport(scan.opportunities || [], activeSport).sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));
      $('arb-count').textContent = `${opps.length} ${t('opps')}`;
      $('signal-mix').textContent = `${opps.length} arb · ${(scan.middles || []).length} middle · ${(scan.positiveEv || []).length} EV`;
      arb.innerHTML = opps.length ? opps.map((o) => {
        const cls = o.verification?.status === 'confirmed' ? 'row-confirmed' :
                    o.verification?.status === 'rejected' ? 'row-rejected' : '';
        const legRows = (o.legs || []).map((l) => `
          <tr class="arb-detail-row" style="display:none">
            <td>${escapeHtml(l.sourceId)}</td>
            <td>${escapeHtml(l.selection)}</td>
            <td>${escapeHtml(l.handicap || '—')}</td>
            <td class="num tabnum">${(l.odds || 0).toFixed(2)}</td>
            <td class="num tabnum">${(l.stake || 0).toFixed(0)}</td>
            <td class="num tabnum">${(l.profit || 0).toFixed(2)}</td>
          </tr>
        `).join('');
        return `
        <tr class="arb-main-row ${cls}" data-arb-toggle aria-expanded="false">
          <td>
            <div class="strong">${escapeHtml(o.homeTeam)} <span class="muted">${t('vs')}</span> ${escapeHtml(o.awayTeam)}</div>
            <div class="secondary"><span class="chip chip-sport">${escapeHtml(o.sport || 'Football')}</span> ${escapeHtml(o.league || '')}${o.kickoff ? ` · <span class="mono">${escapeHtml(new Date(o.kickoff).toLocaleString())}</span>` : ''}</div>
          </td>
          <td>
            <div class="mono">${escapeHtml(o.marketKey)}</div>
            <div class="secondary">${(o.legs || []).map((l) => escapeHtml(l.sourceId)).join(' · ')}</div>
          </td>
          <td class="num tabnum"><span class="strong green">+${(o.roiPercent || 0).toFixed(2)}</span></td>
          <td class="num tabnum">${(o.totalStake || 0).toFixed(0)}</td>
          <td class="num tabnum"><span class="strong">${(o.guaranteedProfit || 0).toFixed(2)}</span></td>
          <td>${verificationCell(t, o)}</td>
        </tr>${legRows}`;
      }).join('') : `<tr><td colspan="6" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noArbsFound'))}</td></tr>`;

      const mid = document.querySelector('#mid-table tbody');
      const mids = filterBySport(scan.middles || [], activeSport).sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));
      $('mid-count').textContent = `${mids.length} ${t('middles')}`;
      mid.innerHTML = mids.length ? mids.map((m) => `
        <tr class="${m.verification?.status === 'confirmed' ? 'row-confirmed' : ''}">
          <td><div class="strong">${escapeHtml(m.homeTeam)} <span class="muted">${t('vs')}</span> ${escapeHtml(m.awayTeam)}</div><div class="secondary"><span class="chip chip-sport">${escapeHtml(m.sport || 'Football')}</span></div></td>
          <td><div class="mono text-xs market-label">${escapeHtml(m.marketKey || '—')}</div>${(m.legs || []).map((l) => `<div class="mono text-xs">${escapeHtml(l.sourceId)} ${escapeHtml(l.selection)} ${escapeHtml(l.handicap)} <span class="muted">@</span> <span class="strong">${(l.odds || 0).toFixed(2)}</span></div>`).join('')}</td>
          <td class="num tabnum"><span class="strong purple">+${(m.roiPercent || 0).toFixed(2)}</span></td>
          <td class="num tabnum"><span class="yellow">${(m.riskPercent || 0).toFixed(2)}</span></td>
          <td>${verificationCell(t, m)}</td>
        </tr>
      `).join('') : `<tr><td colspan="5" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noMiddlesFound'))}</td></tr>`;

      const ev = document.querySelector('#ev-table tbody');
      const evs = filterBySport(scan.positiveEv || [], activeSport).sort((a, b) => (b.evPercent || 0) - (a.evPercent || 0)).slice(0, 100);
      ev.innerHTML = evs.length ? evs.map((e) => `
        <tr>
          <td><div class="strong">${evMatchLabel(e.eventKey)}</div><div class="secondary mono">${escapeHtml(e.marketKey || '—')}</div></td>
          <td>${escapeHtml(e.selection)}</td>
          <td class="mono">${escapeHtml(e.sourceId)}</td>
          <td class="num tabnum">${(e.odds || 0).toFixed(2)}</td>
          <td class="num tabnum"><span class="strong yellow">+${(e.evPercent || 0).toFixed(2)}</span></td>
          <td class="num tabnum">${(e.legs?.[0]?.stake || 0).toFixed(2)}</td>
        </tr>
      `).join('') : `<tr><td colspan="6" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noEvFound'))}</td></tr>`;

      // Flash effect on data update (skip first load)
      if (!_isFirstScanLoad) {
        document.querySelectorAll('.summary-item').forEach((el, i) => {
          setTimeout(() => el.classList.add('flash'), i * 40);
          setTimeout(() => el.classList.remove('flash'), 500 + i * 40);
        });
        document.querySelectorAll('.scanner-section').forEach((el, i) => {
          setTimeout(() => el.classList.add('flash'), i * 60);
          setTimeout(() => el.classList.remove('flash'), 700 + i * 60);
        });
      }
      _isFirstScanLoad = false;
    }

    $('rescan').addEventListener('click', previewScan);

    // Arb table: click to expand/collapse per-leg detail
    document.addEventListener('click', (e) => {
      const mainRow = e.target.closest('tr.arb-main-row');
      if (!mainRow) return;
      const expanded = mainRow.getAttribute('aria-expanded') === 'true';
      mainRow.setAttribute('aria-expanded', String(!expanded));
      const next = mainRow.nextElementSibling;
      if (next && next.classList.contains('arb-detail-row')) {
        next.style.display = expanded ? 'none' : '';
      }
    });
    arbiterSse.connect((type) => { if (type === 'scan-update' || type === 'scrape-update') refreshPublished(); });
    window.arbiterApp.mount('scanner');
    init();

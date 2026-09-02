arbiterApp.mount('scanner');
    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
      })[char]);
    }

    function evMatchLabel(eventKey) {
      const parts = String(eventKey || '').split('|').slice(-2);
      return parts.map(escapeHtml).join(' <span class="muted">vs</span> ');
    }

    function verificationCell(t, o) {
      return o.verification
        ? `<span class="status ${escapeHtml(o.verification.status)}">${escapeHtml(o.verification.status)}</span>`
        : `<span class="muted text-xs">${escapeHtml(t('unverified'))}</span>`;
    }

    async function init() {
      const profiles = (await arbiterApi.get('/api/profiles')).profiles || [];
      $('profile').innerHTML = profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
      $('profile').value = profiles[0]?.id || '';
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

    async function refreshPublished() {
      try {
        render(await arbiterApi.get('/api/scan'));
      } catch (err) {
        const t = arbiterI18n.t.bind(arbiterI18n);
        console.warn('published scan unavailable', err);
        document.querySelector('#arb-table tbody').innerHTML =
          `<tr><td colspan="6" class="muted">${escapeHtml(err.message || t('failedToLoad'))}</td></tr>`;
      }
    }

    async function previewScan() {
      try {
        const data = await arbiterApi.post('/api/scan', {
          bankroll: Number($('bankroll').value),
          minRoiPercent: Number($('min-roi').value),
          maxMiddleRiskPercent: Number($('mid-risk').value),
          minMiddleRoiPercent: Number($('mid-roi').value),
          includeLive: false,
          includePast: false,
        });
        render(data);
      } catch (err) {
        console.warn('scan preview failed', err);
      }
    }

    function render(scan) {
      const t = arbiterI18n.t.bind(arbiterI18n);
      const healthStatus = scan.dataHealth?.status || '';
      const noData = healthStatus !== 'fresh';

      const emptyBox = $('scan-empty');
      if (noData && !(scan.opportunities || []).length && !(scan.middles || []).length && !(scan.positiveEv || []).length) {
        emptyBox.className = 'alert warn';
        emptyBox.innerHTML = `${escapeHtml(t('noFreshData'))} <a href="/admin/scrape.html">${escapeHtml(t('runScrape'))}</a>`;
      } else {
        emptyBox.className = 'hidden';
      }

      const arb = document.querySelector('#arb-table tbody');
      const opps = (scan.opportunities || []).sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));
      $('arb-count').textContent = `${opps.length} ${t('opps')}`;
      arb.innerHTML = opps.length ? opps.map((o) => {
        const cls = o.verification?.status === 'confirmed' ? 'row-confirmed' :
                    o.verification?.status === 'rejected' ? 'row-rejected' : '';
        return `
        <tr class="${cls}">
          <td>
            <div class="strong">${escapeHtml(o.homeTeam)} <span class="muted">vs</span> ${escapeHtml(o.awayTeam)}</div>
            <div class="secondary">${escapeHtml(o.sport)} · ${escapeHtml(o.league || '')}${o.kickoff ? ` · <span class="mono">${escapeHtml(new Date(o.kickoff).toLocaleString())}</span>` : ''}</div>
          </td>
          <td>
            <div class="mono">${escapeHtml(o.marketKey)}</div>
            <div class="secondary">${(o.legs || []).map((l) => escapeHtml(l.sourceId)).join(' · ')}</div>
          </td>
          <td class="num tabnum"><span class="strong green">+${(o.roiPercent || 0).toFixed(2)}</span></td>
          <td class="num tabnum">${(o.totalStake || 0).toFixed(0)}</td>
          <td class="num tabnum"><span class="strong">${(o.guaranteedProfit || 0).toFixed(2)}</span></td>
          <td>${verificationCell(t, o)}</td>
        </tr>`;
      }).join('') : `<tr><td colspan="6" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noArbsFound'))}</td></tr>`;

      const mid = document.querySelector('#mid-table tbody');
      const mids = (scan.middles || []).sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));
      $('mid-count').textContent = `${mids.length} ${t('middles')}`;
      mid.innerHTML = mids.length ? mids.map((m) => `
        <tr class="${m.verification?.status === 'confirmed' ? 'row-confirmed' : ''}">
          <td><div class="strong">${escapeHtml(m.homeTeam)} <span class="muted">vs</span> ${escapeHtml(m.awayTeam)}</div></td>
          <td>${(m.legs || []).map((l) => `<div class="mono text-xs">${escapeHtml(l.sourceId)} ${escapeHtml(l.selection)} ${escapeHtml(l.handicap)} <span class="muted">@</span> <span class="strong">${(l.odds || 0).toFixed(2)}</span></div>`).join('')}</td>
          <td class="num tabnum"><span class="strong purple">+${(m.roiPercent || 0).toFixed(2)}</span></td>
          <td class="num tabnum"><span class="yellow">${(m.riskPercent || 0).toFixed(2)}</span></td>
          <td>${verificationCell(t, m)}</td>
        </tr>
      `).join('') : `<tr><td colspan="5" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noMiddlesFound'))}</td></tr>`;

      const ev = document.querySelector('#ev-table tbody');
      const evs = (scan.positiveEv || []).sort((a, b) => (b.evPercent || 0) - (a.evPercent || 0)).slice(0, 100);
      ev.innerHTML = evs.length ? evs.map((e) => `
        <tr>
          <td><div class="strong">${evMatchLabel(e.eventKey)}</div></td>
          <td>${escapeHtml(e.selection)}</td>
          <td class="mono">${escapeHtml(e.sourceId)}</td>
          <td class="num tabnum">${(e.odds || 0).toFixed(2)}</td>
          <td class="num tabnum"><span class="strong yellow">+${(e.evPercent || 0).toFixed(2)}</span></td>
          <td class="num tabnum">${(e.legs?.[0]?.stake || 0).toFixed(2)}</td>
        </tr>
      `).join('') : `<tr><td colspan="6" class="empty">${escapeHtml(noData ? t('noFreshData') : t('noEvFound'))}</td></tr>`;
    }

    $('rescan').addEventListener('click', previewScan);
    arbiterSse.connect((type) => { if (type === 'scan-update' || type === 'scrape-update') refreshPublished(); }, (state) => {
      const t = arbiterI18n.t.bind(arbiterI18n);
      const label = $('conn-state');
      const dot = $('conn-dot');
      if (label) label.textContent = state === 'open' ? t('connected') : t('reconnecting');
      if (dot) dot.className = `dot ${state === 'open' ? 'live' : 'error'}`;
    });
    init();

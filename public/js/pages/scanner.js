arbiterApp.mount('scanner');
    const $ = (id) => document.getElementById(id);

    async function init() {
      const profiles = (await arbiterApi.get('/api/profiles')).profiles || [];
      $('profile').innerHTML = profiles.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
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
        console.warn('published scan unavailable', err);
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
      const arb = document.querySelector('#arb-table tbody');
      const opps = (scan.opportunities || []).sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));
      $('arb-count').textContent = `${opps.length} ${opps.length === 1 ? 'opportunity' : 'opportunities'}`;
      arb.innerHTML = opps.length ? opps.map((o) => {
        const cls = o.verification?.status === 'confirmed' ? 'row-confirmed' :
                    o.verification?.status === 'rejected' ? 'row-rejected' : '';
        return `
        <tr class="${cls}">
          <td>
            <div class="strong">${o.homeTeam} <span class="muted">vs</span> ${o.awayTeam}</div>
            <div class="secondary">${o.sport} · ${o.league}</div>
          </td>
          <td>
            <div class="mono">${o.marketKey}</div>
            <div class="secondary">${(o.legs||[]).map((l)=>l.sourceId).join(' · ')}</div>
          </td>
          <td class="num tabnum"><span class="strong green">+${(o.roiPercent||0).toFixed(2)}</span></td>
          <td class="num tabnum">${(o.totalStake||0).toFixed(0)}</td>
          <td class="num tabnum"><span class="strong">${(o.guaranteedProfit||0).toFixed(2)}</span></td>
          <td>${o.verification ? `<span class="status ${o.verification.status}">${o.verification.status}</span>` : '<span class="muted text-xs">—</span>'}</td>
        </tr>`;
      }).join('') : `<tr><td colspan="6" class="empty">no arbs found</td></tr>`;

      const mid = document.querySelector('#mid-table tbody');
      const mids = (scan.middles || []).sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));
      $('mid-count').textContent = `${mids.length} ${mids.length === 1 ? 'middle' : 'middles'}`;
      mid.innerHTML = mids.length ? mids.map((m) => `
        <tr class="${m.verification?.status === 'confirmed' ? 'row-confirmed' : ''}">
          <td><div class="strong">${m.homeTeam} <span class="muted">vs</span> ${m.awayTeam}</div></td>
          <td>${(m.legs||[]).map((l) => `<div class="mono text-xs">${l.sourceId} ${l.selection} ${l.handicap} <span class="muted">@</span> <span class="strong">${(l.odds||0).toFixed(2)}</span></div>`).join('')}</td>
          <td class="num tabnum"><span class="strong purple">+${(m.roiPercent||0).toFixed(2)}</span></td>
          <td class="num tabnum"><span class="yellow">${(m.riskPercent||0).toFixed(2)}</span></td>
          <td>${m.verification ? `<span class="status ${m.verification.status}">${m.verification.status}</span>` : '<span class="muted text-xs">—</span>'}</td>
        </tr>
      `).join('') : `<tr><td colspan="5" class="empty">no middles found</td></tr>`;

      const ev = document.querySelector('#ev-table tbody');
      const evs = (scan.positiveEv || []).sort((a, b) => (b.evPercent || 0) - (a.evPercent || 0)).slice(0, 100);
      ev.innerHTML = evs.length ? evs.map((e) => `
        <tr>
          <td><div class="strong">${e.eventKey.split('|').slice(-2).join(' <span class="muted">vs</span> ')}</div></td>
          <td>${e.selection}</td>
          <td class="mono">${e.sourceId}</td>
          <td class="num tabnum">${(e.odds||0).toFixed(2)}</td>
          <td class="num tabnum"><span class="strong yellow">+${(e.evPercent||0).toFixed(2)}</span></td>
          <td class="num tabnum">${(e.legs?.[0]?.stake || 0).toFixed(2)}</td>
        </tr>
      `).join('') : `<tr><td colspan="6" class="empty">no positive EV found</td></tr>`;
    }

    $('rescan').addEventListener('click', previewScan);
    arbiterSse.connect((type) => { if (type === 'scan-update' || type === 'scrape-update') refreshPublished(); });
    init();

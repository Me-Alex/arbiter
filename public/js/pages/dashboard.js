arbiterApp.mount('dashboard');

    async function refresh() {
      try {
        const scan = await arbiterApi.get('/api/scan');
        const opportunities = scan.opportunities || [];
        const middles = scan.middles || [];
        const ev = scan.positiveEv || [];
        const low = scan.lowHold || [];
        const verified = scan.verificationSummary || { confirmed: 0 };
        const health = scan.dataHealth || {};
        const healthStatus = health.status || 'no published data';
        const healthLabel = healthStatus === 'fresh'
          ? `${Number(health.actionableSourceCount || 0)} fresh sources`
          : healthStatus;
        document.getElementById('data-health').textContent = healthLabel;
        document.getElementById('data-health-dot').className = `dot ${healthStatus === 'fresh' ? 'live' : healthStatus === 'partial' || healthStatus === 'stale' ? 'warn' : 'error'}`;

        document.getElementById('m-opps').textContent = opportunities.length;
        document.getElementById('m-middles').textContent = middles.length;
        document.getElementById('m-ev').textContent = ev.length;
        document.getElementById('m-low').textContent = low.length;
        document.getElementById('m-confirmed').textContent = verified.confirmed || 0;
        document.getElementById('m-review').textContent = middles.filter(m => !m.verification || m.verification.status !== 'confirmed').length;
        document.getElementById('m-src').textContent = (scan.sources || []).length;
        document.getElementById('m-events').textContent = (scan.eventCount || 0).toLocaleString();

        const list = document.getElementById('opp-list');
        if (opportunities.length === 0 && middles.length === 0) {
          list.innerHTML = `
            <div class="empty">
              <div class="empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>
              </div>
              ${arbiterI18n.t('noOpportunities')}
            </div>`;
        } else {
          const top = [...opportunities, ...middles]
            .sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0))
            .slice(0, 12);
          list.innerHTML = top.map(renderOpp).join('');
        }
        if (scan.scannedAt || scan.scanStartedAt) {
          document.getElementById('last-updated').textContent =
            arbiterI18n.t('lastUpdated') + ': ' +
            new Date(scan.scannedAt || scan.scanStartedAt).toLocaleString();
        }
      } catch (err) {
        document.getElementById('opp-list').innerHTML =
          `<div class="alert">${err.message || 'failed to load'}</div>`;
      }
    }

    function renderOpp(o) {
      const legs = (o.legs || []).map((l) => `
        <div class="leg">
          <div class="book">${l.sourceId}</div>
          <div class="selection">${l.selection}</div>
          <div class="odds">${(l.odds || 0).toFixed(2)}</div>
          <div class="stake">stake ${(l.stake || 0).toFixed(0)} RON</div>
        </div>`).join('');

      const status = o.verification
        ? `<span class="status ${o.verification.status}">${o.verification.status}</span>`
        : '<span class="muted text-xs">unverified</span>';

      const kindClass = o.kind === 'middle' ? 'is-middle' : '';
      const roi = Math.max(0, Math.min(100, (o.roiPercent || 0) * 12));

      return `
        <div class="opp-card ${kindClass}">
          <div class="head">
            <div style="min-width:0;flex:1">
              <div class="match">${o.homeTeam || ''} <span class="muted">vs</span> ${o.awayTeam || ''}</div>
              <div class="match-meta">
                <span class="chip">${o.sport || ''}</span>
                <span>${o.league || ''}</span>
                <span class="dim mono">${o.marketKey || ''}</span>
              </div>
            </div>
            <div class="roi-wrap">
              <div class="roi">+${(o.roiPercent || 0).toFixed(2)}%</div>
              <div class="roi-meta">${status}</div>
              <div class="roi-bar" aria-hidden="true"><div class="fill" style="width:${roi.toFixed(1)}%"></div></div>
            </div>
          </div>
          <div class="legs">${legs}</div>
        </div>`;
    }

    arbiterSse.connect((type, payload) => {
      if (type === 'scrape-update' && payload && payload.status === 'completed') refresh();
      if (type === 'scan-update') refresh();
    });
    refresh();
    setInterval(refresh, 15000);

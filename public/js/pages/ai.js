arbiterApp.mount('ai');
const $ = (id) => document.getElementById(id);

function renderHealth(scan) {
  const t = arbiterI18n.t.bind(arbiterI18n);
  const health = scan.dataHealth || {};
  const sources = health.sources || {};
  const sourceRows = Object.entries(sources)
    .filter(([, count]) => Number(count) > 0)
    .map(([status, count]) => `<span class="chip ${status === 'fresh' ? 'green' : status === 'partial' || status === 'stale' ? 'yellow' : 'outline'}">${escapeHtml(status)}: ${Number(count)}</span>`)
    .join(' ');
  $('scan-health').innerHTML = health.status
    ? `<div class="ai-health-status"><span class="status ${escapeHtml(health.status)}">${escapeHtml(health.status)}</span><span class="muted text-sm">${escapeHtml(t('fromPublishedScan'))}</span></div><div class="row ai-source-chips">${sourceRows || `<span class="muted">${escapeHtml(t('noSources'))}</span>`}</div><div class="ai-health-meta muted text-sm"><span>${escapeHtml(t('actionableSources'))}: <strong>${Number(health.actionableSourceCount || 0)}</strong></span><span>${escapeHtml(t('runLabel'))}: <span class="mono">${escapeHtml(scan.scrapeRunId || t('manualPreview'))}</span></span></div>`
    : `<div class="empty">${escapeHtml(t('noPublishedScan'))}</div>`;
}

function renderInsights(scan) {
  const t = arbiterI18n.t.bind(arbiterI18n);
  const opportunities = scan.opportunities || [];
  const list = opportunities.filter((opportunity) => opportunity.verification?.status === 'confirmed');
  $('insights-count').textContent = list.length
    ? `${list.length} ${t(list.length === 1 ? 'verifiedOpp' : 'verifiedOpps')}`
    : t('noneVerified');
  $('ai-insights').innerHTML = list.length
    ? list.map((item) => `
      <div class="opp-card" style="margin-bottom:8px">
        <div class="head">
          <div style="flex:1;min-width:0">
            <div class="match">${escapeHtml(item.homeTeam)} <span class="muted">${t('vs')}</span> ${escapeHtml(item.awayTeam)}</div>
            <div class="match-meta"><span class="chip green">${escapeHtml(t('confirmedLabel'))}</span><span>${escapeHtml(item.marketKey)}</span></div>
          </div>
          <div class="roi-wrap"><div class="roi" style="font-size:18px">+${Number(item.roiPercent || 0).toFixed(2)}%</div></div>
        </div>
        <div class="muted text-sm" style="margin-top:8px;position:relative;z-index:1">${escapeHtml(t('freshLegsFrom'))} ${escapeHtml((item.legs || []).map((leg) => leg.sourceId).join(' · '))}</div>
      </div>`).join('')
    : `<div class="empty">${escapeHtml(t('noVerifiedOpps'))}</div>`;
}

async function refresh() {
  const scan = await arbiterApi.get('/api/scan').catch(() => ({}));
  renderHealth(scan);
  renderInsights(scan);
}

refresh();
arbiterSse.connect((type) => { if (type === 'scan-update') refresh(); });

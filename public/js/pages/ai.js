arbiterApp.mount('ai');
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function renderHealth(scan) {
  const t = arbiterI18n.t.bind(arbiterI18n);
  const health = scan.dataHealth || {};
  const sources = health.sources || {};
  const sourceRows = Object.entries(sources)
    .filter(([, count]) => Number(count) > 0)
    .map(([status, count]) => `<span class="chip ${status === 'fresh' ? 'green' : status === 'partial' || status === 'stale' ? 'yellow' : 'outline'}">${escapeHtml(status)}: ${Number(count)}</span>`)
    .join(' ');
  $('scan-health').innerHTML = health.status
    ? `<div class="strong">${escapeHtml(health.status)}</div><div class="row" style="margin-top:10px;gap:6px;flex-wrap:wrap">${sourceRows || `<span class="muted">${escapeHtml(t('noSources'))}</span>`}</div><div class="muted text-sm" style="margin-top:12px">${escapeHtml(t('actionableSources'))}: ${Number(health.actionableSourceCount || 0)} · ${escapeHtml(t('runLabel'))}: ${escapeHtml(scan.scrapeRunId || t('manualPreview'))}</div>`
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
            <div class="match">${escapeHtml(item.homeTeam)} <span class="muted">vs</span> ${escapeHtml(item.awayTeam)}</div>
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
arbiterSse.connect((type) => { if (type === 'scan-update') refresh(); }, (state) => {
  const t = arbiterI18n.t.bind(arbiterI18n);
  const label = $('conn-state');
  const dot = $('conn-dot');
  if (label) label.textContent = state === 'open' ? t('connected') : t('reconnecting');
  if (dot) dot.className = `dot ${state === 'open' ? 'live' : 'error'}`;
});

arbiterApp.mount('ai');
const $ = (id) => document.getElementById(id);

// Show loading skeleton while data loads
const AI_LOADING_HTML = `<div class="empty" aria-busy="true"><div class="skeleton skeleton-line lg" style="width:140px;margin:0 auto 12px"></div><div class="skeleton skeleton-line" style="width:220px;margin:0 auto 8px"></div><div class="skeleton skeleton-line" style="width:180px;margin:0 auto"></div></div>`;
$('scan-health').innerHTML = AI_LOADING_HTML;
$('ai-insights').innerHTML = AI_LOADING_HTML;

function renderHealth(scan) {
  const t = arbiterI18n.t.bind(arbiterI18n);
  const health = scan.dataHealth || {};
  const sources = health.sources || {};
  const sourceRows = Object.entries(sources)
    .filter(([, count]) => Number(count) > 0)
    .map(([status, count]) => `<span class="chip ${status === 'fresh' ? 'green' : status === 'partial' || status === 'stale' ? 'yellow' : 'outline'}">${escapeHtml(status)}: ${Number(count)}</span>`)
    .join(' ');
  // This branch was gated on `health.status`, which is never falsy for a served
  // scan: the fallback the route hands out when nothing has been published is
  // built from the same envelope as a real scan, and its status is "empty".
  // So the "no published scan" panel below could not render, and the run label
  // fell through to "manual preview" — a claim that a trader ran a scan by
  // hand, on an install that has never scraped at all. Only the route's flag
  // says which of the two states this is.
  const published = scan.published !== false;
  // No `runLabel` for the never-ran panel: it names the run that produced a
  // scan, and there was no run. A conditional here would be a branch the empty
  // panel never reaches — which is how a label can be "handled" for a state
  // that never renders it.
  const runLabel = scan.scrapeRunId || t('manualPreview');
  $('scan-health').innerHTML = published
    ? `<div class="ai-health-status"><span class="status ${escapeHtml(health.status)}">${escapeHtml(health.status)}</span><span class="muted text-sm">${escapeHtml(t('fromPublishedScan'))}</span></div><div class="row ai-source-chips">${sourceRows || `<span class="muted">${escapeHtml(t('noSources'))}</span>`}</div><div class="ai-health-meta muted text-sm"><span>${escapeHtml(t('actionableSources'))}: <strong>${Number(health.actionableSourceCount || 0)}</strong></span><span>${escapeHtml(t('runLabel'))}: <span class="mono">${escapeHtml(runLabel)}</span></span></div>`
    : `<div class="empty">
        <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
        <div>${escapeHtml(t('noPublishedScan'))}</div>
        <div class="empty-actions"><a class="btn primary" href="/admin/scrape.html">${escapeHtml(t('runScrape'))}</a></div>
      </div>`;
}

function renderInsights(scan) {
  const t = arbiterI18n.t.bind(arbiterI18n);
  const opportunities = scan.opportunities || [];
  const list = opportunities.filter((opportunity) => opportunity.verification?.status === 'confirmed');
  // Same mark as the scanner and the dashboard, for the same reason: a card of
  // "verified opportunities" that renders a live price and a pre-match price
  // identically is a card a trader reads as the calm one. It never reads the
  // kickoff — a pre-match price whose kickoff has passed is stale, not running.
  const liveBadge = (item) => item.live === true
    ? `<span class="chip red live-badge" title="${escapeHtml(t('liveTooltip'))}">${escapeHtml(t('live'))}</span>`
    : '';
  $('insights-count').textContent = list.length
    ? `${list.length} ${t(list.length === 1 ? 'verifiedOpp' : 'verifiedOpps')}`
    : t('noneVerified');
  $('ai-insights').innerHTML = list.length
    ? list.map((item) => `
      <div class="opp-card" style="margin-bottom:8px">
        <div class="head">
          <div style="flex:1;min-width:0">
            <div class="match">${escapeHtml(item.homeTeam)} <span class="muted">${t('vs')}</span> ${escapeHtml(item.awayTeam)}</div>
            <div class="match-meta"><span class="chip green">${escapeHtml(t('confirmedLabel'))}</span>${liveBadge(item)}<span>${escapeHtml(item.marketKey)}</span></div>
          </div>
          <div class="roi-wrap"><div class="roi" style="font-size:18px">+${Number(item.marginPercent || item.roiPercent || 0).toFixed(2)}%</div></div>
        </div>
        <div class="muted text-sm" style="margin-top:8px;position:relative;z-index:1">${escapeHtml(t('freshLegsFrom'))} ${escapeHtml((item.legs || []).map((leg) => leg.sourceId).join(' · '))}</div>
      </div>`).join('')
    : `<div class="empty">
        <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg></div>
        <div>${escapeHtml(t('noVerifiedOpps'))}</div>
        <div class="empty-actions"><a class="btn ghost" href="/admin/scanner.html">${escapeHtml(t('openScanner'))}</a> <a class="btn primary" href="/admin/scrape.html">${escapeHtml(t('runScrape'))}</a></div>
      </div>`;
}

async function refresh() {
  // A failed read used to land on the "no published scan" panel by way of an
  // empty `health.status`, which was right by accident. With the flag it has to
  // be stated: `{}` has no `published` at all, which now reads as "published".
  const scan = await arbiterApi.get('/api/scan').catch(() => ({ published: false }));
  renderHealth(scan);
  renderInsights(scan);
  // Update data-freshness banner (A4)
  if (window.arbiterConnectionStatus && window.arbiterConnectionStatus.setDataHealth) {
    window.arbiterConnectionStatus.setDataHealth(scan.dataHealth || {});
  }
}

refresh();
arbiterSse.connect((type) => { if (type === 'scan-update') refresh(); });

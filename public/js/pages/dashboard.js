// Dashboard v2 — premium KPI cards, ticker, source rows, opportunity cards v2.
arbiterApp.mount('dashboard');

const oppList = document.getElementById('opp-list');
const sourceHealthList = document.getElementById('source-health');

// Card-shaped skeleton for opportunities
const oppSkeleton = `<div class="dash-loading" aria-label="Loading opportunities">
  ${Array(3).fill('').map((_, i) => `
    <div class="skeleton-card" style="animation-delay:${i * 80}ms">
      <div class="skel-head">
        <div class="skel-match">
          <div class="skel-bar w-60"></div>
          <div class="skel-bar w-40"></div>
        </div>
        <div class="skel-roi"></div>
      </div>
      <div class="skel-legs">
        <div class="skel-leg"><div class="skel-bar w-40"></div><div class="skel-bar w-80"></div><div class="skel-bar w-20"></div></div>
        <div class="skel-leg"><div class="skel-bar w-40"></div><div class="skel-bar w-80"></div><div class="skel-bar w-20"></div></div>
      </div>
    </div>`).join('')}
</div>`;

// Source-shaped skeleton for source health
const sourceSkeleton = `<div class="dash-loading" aria-label="Loading sources">
  ${Array(4).fill('').map((_, i) => `
    <div class="skeleton-source" style="animation-delay:${i * 60}ms">
      <div class="skel-avatar"></div>
      <div class="skel-info">
        <div class="skel-bar w-50"></div>
        <div class="skel-bar w-30"></div>
      </div>
      <div class="skel-status"></div>
    </div>`).join('')}
</div>`;

oppList.innerHTML = oppSkeleton;
sourceHealthList.innerHTML = sourceSkeleton;

// Book avatar palette
const BOOK_PALETTE = [
  { color: '#60c9fa', bg: 'rgba(96, 201, 250, 0.12)', border: 'rgba(96, 201, 250, 0.30)' },
  { color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.12)', border: 'rgba(167, 139, 250, 0.30)' },
  { color: '#34d399', bg: 'rgba(52, 211, 153, 0.12)', border: 'rgba(52, 211, 153, 0.30)' },
  { color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.12)', border: 'rgba(251, 191, 36, 0.30)' },
  { color: '#22d3ee', bg: 'rgba(34, 211, 238, 0.12)', border: 'rgba(34, 211, 238, 0.30)' },
  { color: '#f472b6', bg: 'rgba(244, 114, 182, 0.12)', border: 'rgba(244, 114, 182, 0.30)' },
  { color: '#a3e635', bg: 'rgba(163, 230, 53, 0.12)', border: 'rgba(163, 230, 53, 0.30)' },
  { color: '#f87171', bg: 'rgba(248, 113, 113, 0.12)', border: 'rgba(248, 113, 113, 0.30)' },
];

function paletteFor(id) {
  if (!id) return BOOK_PALETTE[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return BOOK_PALETTE[h % BOOK_PALETTE.length];
}

function fmtStake(n) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtOdds(n) {
  return Number(n || 0).toFixed(2);
}

/** Extract the numeric stake amount from a localized stake label like "Miză 500" or "Stake 500". */
function parseStakeAmount(label) {
  if (!label || typeof label !== 'string') return null;
  const digits = label.match(/([\d,]+(?:\.\d+)?)/);
  if (!digits) return null;
  const n = Number(digits[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Track if this is the first load (no flash on initial render)
let isFirstLoad = true;

async function refresh() {
  const t = arbiterI18n.t.bind(arbiterI18n);
  try {
    const scan = await arbiterApi.get('/api/scan');
    const opportunities = scan.opportunities || [];
    const middles = scan.middles || [];
    const ev = scan.positiveEv || [];
  const health = scan.dataHealth || {};
  const healthStatus = health.status || t('noPublishedData');


    // Count chips with animation
    const totalOpps = opportunities.length + middles.length;
    const animateValue = (id, newValue) => {
      const el = document.getElementById(id);
      if (!el) return;
      const oldText = el.textContent;
      const newText = String(newValue);
      if (oldText !== newText) {
        el.textContent = newText;
        el.classList.add('counting');
        setTimeout(() => el.classList.remove('counting'), 300);
      }
    };
    animateValue('opps-count', totalOpps);
    animateValue('src-count', (scan.sources || []).length);
    animateValue('ev-count', ev.length);

    // Update quick-stats bar
    const qbOpps = document.getElementById('qb-opps');
    const qbOppsSub = document.getElementById('qb-opps-sub');
    const qbBestRoi = document.getElementById('qb-best-roi');
    const qbBestRoiMatch = document.getElementById('qb-best-roi-match');
    const qbEvents = document.getElementById('qb-events');
    const qbSources = document.getElementById('qb-sources');
    const qbScrapeTime = document.getElementById('qb-scrape-time');
    const qbScrapeStatus = document.getElementById('qb-scrape-status');

    if (qbOpps) qbOpps.textContent = totalOpps;
    if (qbOppsSub) qbOppsSub.textContent = `${opportunities.length} arbs, ${middles.length} middles`;

    // Best ROI
    const allOpps = [...opportunities, ...middles].sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));
    if (allOpps.length > 0) {
      const best = allOpps[0];
      if (qbBestRoi) {
        const roiClass = window.arbiterFormat?.roiClass(best.roiPercent) || '';
        qbBestRoi.textContent = `+${(best.roiPercent || 0).toFixed(2)}%`;
        qbBestRoi.className = `v ${roiClass}`;
      }
      if (qbBestRoiMatch) {
        const parts = (best.eventKey || '').split('|');
        const home = parts[parts.length - 2] || best.homeTeam || '';
        const away = parts[parts.length - 1] || best.awayTeam || '';
        qbBestRoiMatch.textContent = `${home} ${t('vs')} ${away}`;
      }
    } else {
      if (qbBestRoi) qbBestRoi.textContent = '—';
      if (qbBestRoiMatch) qbBestRoiMatch.textContent = '—';
    }

    // Total events and sources
    const totalEvents = ev.length + totalOpps;
    if (qbEvents) qbEvents.textContent = totalEvents.toLocaleString();
    if (qbSources) {
      const sourceCount = (scan.sources || []).length;
      const freshCount = (scan.sources || []).filter(s => s.dataStatus === 'fresh').length;
      qbSources.textContent = `${freshCount}/${sourceCount} ${t('fresh')}`;
    }

    // Last scrape time
    if (qbScrapeTime) {
      const sources = scan.sources || [];
      if (sources.length > 0) {
        const oldestAge = Math.max(...sources.map(s => s.ageMs || 0));
        qbScrapeTime.textContent = window.arbiterFormat?.timeAgo(oldestAge) || '—';
        if (qbScrapeStatus) {
          const freshRatio = sources.filter(s => s.dataStatus === 'fresh').length / sources.length;
          if (freshRatio > 0.8) {
            qbScrapeStatus.textContent = t('allFresh');
            qbScrapeStatus.className = 's green';
          } else if (freshRatio > 0.5) {
            qbScrapeStatus.textContent = t('someStale');
            qbScrapeStatus.className = 's yellow';
          } else {
            qbScrapeStatus.textContent = t('dataStale');
            qbScrapeStatus.className = 's red';
          }
        }
      } else {
        if (qbScrapeTime) qbScrapeTime.textContent = '—';
        if (qbScrapeStatus) qbScrapeStatus.textContent = t('noData');
      }
    }

    // Update last updated timestamp
    const updatedEl = document.getElementById('last-updated');
    if (updatedEl) updatedEl.textContent = new Date().toLocaleTimeString();

    // Source health
    sourceHealthList.setAttribute('aria-busy', 'false');
    const sourceRows = (scan.sources || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 8);
    sourceHealthList.innerHTML = sourceRows.length ? sourceRows.map((source) => {
      const state = source.dataStatus || 'unknown';
      const stateClass = state === 'fresh' ? 'completed' : state === 'failed' ? 'failed' : 'partial';
      const pal = paletteFor(source.sourceId);
      const initials = String(source.sourceId || '?').slice(0, 2);
      // Freshness bar: 100% = fresh, decreasing with age
      const maxAge = 3600000; // 1h = fully stale
      const freshness = source.ageMs ? Math.max(0, Math.min(100, (1 - source.ageMs / maxAge) * 100)) : 100;
      const freshClass = freshness > 70 ? 'fresh' : freshness > 30 ? 'stale' : 'old';
      return `<div class="source-row" style="--source-color:${pal.color};--source-bg:${pal.bg};--source-border:${pal.border};">
        <div class="source-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
        <div style="min-width:0">
          <div class="source-name">${escapeHtml(source.sourceId || '—')}</div>
          <div class="source-meta">${Number(source.count || 0).toLocaleString()} ${t('events')}${source.ageMs ? ` · ${window.arbiterFormat?.timeAgo(source.ageMs) || '—'}` : ''}</div>
        </div>
        <div class="freshness-bar" aria-hidden="true"><div class="fill ${freshClass}" style="width:${freshness.toFixed(0)}%"></div></div>
        <div class="source-stats">${Number(source.count || 0).toLocaleString()} <span class="muted">ev</span></div>
        <span class="status ${stateClass}">${escapeHtml(state)}</span>
      </div>`;
    }).join('') : `<div class="empty">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div>${escapeHtml(t('noSources'))}</div>
      <div class="empty-actions">
        <a class="btn primary" href="/admin/scrape.html">${escapeHtml(t('runScrape'))}</a>
      </div>
    </div>`;

    // Opportunity list
    const list = document.getElementById('opp-list');
    list.setAttribute('aria-busy', 'false');
    if (opportunities.length === 0 && middles.length === 0) {
      const hint = healthStatus === 'fresh' ? t('noArbsFresh') : t('noFreshData');
      list.innerHTML = `
        <div class="empty">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>
          </div>
          <div>${escapeHtml(hint)}</div>
          <div class="empty-actions">
            <a class="btn primary" href="/admin/scrape.html">${escapeHtml(t('runScrape'))}</a>
            <a class="btn ghost" href="/admin/scanner.html">${escapeHtml(t('openScanner'))}</a>
          </div>
        </div>`;
    } else {
      const all = [...opportunities, ...middles]
        .sort((a, b) => (b.roiPercent || 0) - (a.roiPercent || 0));

      // Group by match identity: home|away|kickoff
      const groups = new Map();
      for (const o of all) {
        const key = `${o.homeTeam}|${o.awayTeam}|${o.kickoff}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
      }

      const groupValues = [...groups.values()];
      const MAX_CARDS = 20;
      const initialCards = groupValues.slice(0, MAX_CARDS);
      const remainingCards = groupValues.slice(MAX_CARDS);

      list.innerHTML = initialCards.map(renderOppGroup).join('');

      // Add "Show more" button if there are more cards
      if (remainingCards.length > 0) {
        const showMoreBtn = document.createElement('button');
        showMoreBtn.className = 'btn ghost show-more-btn';
        showMoreBtn.type = 'button';
        showMoreBtn.innerHTML = `<span data-i18n="showMore">Show more</span> <span class="muted">(${remainingCards.length})</span>`;
        showMoreBtn.addEventListener('click', () => {
          // Remove the button
          showMoreBtn.remove();
          // Append remaining cards
          const remainingHtml = remainingCards.map(renderOppGroup).join('');
          list.insertAdjacentHTML('beforeend', remainingHtml);
          // Reinitialize navigation
          initCardNavigation();
          // Update count
          animateValue('opps-count', groups.size);
        });
        list.appendChild(showMoreBtn);
      }

      animateValue('opps-count', groups.size);
      initCardNavigation();
    }

    // +EV table
    const evCard = document.getElementById('ev-card');
    const evs = [...ev].sort((a, b) => (b.evPercent || 0) - (a.evPercent || 0)).slice(0, 8);
    if (evs.length === 0) {
      evCard.classList.add('hidden');
    } else {
      evCard.classList.remove('hidden');
      document.getElementById('ev-list').innerHTML = evs.map((e) => {
        const parts = (e.eventKey || '').split('|');
        const home = parts[parts.length - 2] || '';
        const away = parts[parts.length - 1] || '';
        const pal = paletteFor(e.sourceId);
        return `<tr class="ev-row">
          <td><div class="strong">${escapeHtml(home)} <span class="muted">${t('vs')}</span> ${escapeHtml(away)}</div></td>
          <td>${escapeHtml(e.selection)}</td>
          <td><span class="chip" style="color:${pal.color};background:${pal.bg};border-color:${pal.border};"><span class="dot" style="background:${pal.color}"></span>${escapeHtml(e.sourceId)}</span></td>
          <td class="num tabnum mono">${fmtOdds(e.odds)}</td>
          <td class="num tabnum ev-pct">+${(e.evPercent || 0).toFixed(2)}</td>
          <td class="num tabnum mono">${fmtStake(e.legs?.[0]?.stake || 0)}</td>
        </tr>`;
      }).join('');
    }

    // Flash effect on data update (skip first load)
    if (!isFirstLoad) {
      document.querySelectorAll('.opp-card-v2').forEach((card, i) => {
        setTimeout(() => card.classList.add('flash'), i * 50);
        setTimeout(() => card.classList.remove('flash'), 800 + i * 50);
      });
      document.querySelectorAll('.source-row').forEach((row, i) => {
        setTimeout(() => row.classList.add('flash'), i * 30);
        setTimeout(() => row.classList.remove('flash'), 600 + i * 30);
      });
    }
    isFirstLoad = false;

  } catch (err) {
    document.getElementById('opp-list').setAttribute('aria-busy', 'false');
    sourceHealthList.setAttribute('aria-busy', 'false');
    document.getElementById('opp-list').innerHTML =
      `<div class="alert" role="alert"><span>${escapeHtml(err.message || t('failedToLoad'))}</span><button class="ghost sm" type="button" data-dashboard-retry>${escapeHtml(t('rescan'))}</button></div>`;
    sourceHealthList.innerHTML = `<div class="empty">${escapeHtml(t('noPublishedData'))}</div>`;
    document.querySelector('[data-dashboard-retry]')?.addEventListener('click', refresh, { once: true });
  }
}

// Format a raw market key into a human-readable label with threshold
function fmtMarketKey(key) {
  if (!key) return '';
  const ou1hMatch = /^OVER_UNDER_(\d+)_(\d+)_1H$/i.exec(key);
  if (ou1hMatch) return `O/U ${ou1hMatch[1]}.${ou1hMatch[2]} 1H`;
  const ouMatch = /^OVER_UNDER_(\d+)_(\d+)$/i.exec(key);
  if (ouMatch) return `O/U ${ouMatch[1]}.${ouMatch[2]}`;
  const cornersOuMatch = /^CORNERS_OVER_UNDER_(\d+)_(\d+)$/i.exec(key);
  if (cornersOuMatch) return `Corners O/U ${cornersOuMatch[1]}.${cornersOuMatch[2]}`;
  const cardsOuMatch = /^CARDS_OVER_UNDER_(\d+)_(\d+)$/i.exec(key);
  if (cardsOuMatch) return `Cards O/U ${cardsOuMatch[1]}.${cardsOuMatch[2]}`;
  const ahMatch = /^AH_([0-9_]+)$/i.exec(key);
  if (ahMatch) return `AH ${ahMatch[1].replace('_', '.')}`;
  const hcapMatch = /^HANDICAP_([0-9_]+)$/i.exec(key);
  if (hcapMatch) return `H ${hcapMatch[1].replace('_', '.')}`;
  // Prettify other known keys
  const pretty = {
    MATCH_WINNER: '1X2',
    MATCH_ODDS: '1X2',
    MATCH_ODDS_1H: '1X2 1H',
    '1X2_1H': '1X2 1H',
    HALF_MATCH_ODDS: '1X2 1H',
    BOTH_TEAMS_SCORE: 'BTTS',
    BOTH_TEAMS_SCORE_1H: 'BTTS 1H',
    BTTS: 'BTTS',
    BTTS_1H: 'BTTS 1H',
    DOUBLE_CHANCE: 'DC',
    DOUBLE_CHANCE_1H: 'DC 1H',
    DRAW_NO_BET: 'DNB',
    DRAW_NO_BET_1H: 'DNB 1H',
    DNB: 'DNB',
    DNB_1H: 'DNB 1H',
    ASIAN_HANDICAP: 'AH',
  };
  const upper = String(key).toUpperCase();
  return pretty[upper] || key.replace(/_/g, ' ');
}

// Render a group of opportunities for the same match as one collapsed card
function renderOppGroup(opps) {
  if (!opps || !opps.length) return '';
  const best = opps[0]; // already sorted by ROI desc
  return renderOppV2(best, opps);
}

// Badge age thresholds (ms) for the card's "detected ago" time badge.
const BADGE_FRESH_MS = 5 * 60 * 1000;   // <5 min
const BADGE_RECENT_MS = 30 * 60 * 1000; // <30 min

// ROI bar scale: map roiPercent onto the 0-100 fill width.
const ROI_BAR_SCALE = 12;

// Format a kickoff timestamp for display, tolerating malformed values.
// Preferred implementation is the modal module's shared parseDate; a local
// tolerant fallback keeps renderOppV2 standalone (e.g. in harnesses).
function formatKickoff(kickoff) {
  const parse = (window.EventDetailModal && window.EventDetailModal.parseDate) || ((v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; });
  const d = parse(kickoff);
  return d ? d.toLocaleString() : '';
}

function renderOppV2(o, allMarkets) {
  const t = arbiterI18n.t.bind(arbiterI18n);
  const legs = (o.legs || []).map((l) => dashRenderLeg(l, t, o.roiPercent)).join('');

  const status = o.verification
    ? `<span class="status ${o.verification.status}">${escapeHtml(o.verification.status)}</span>`
    : `<span class="muted text-xs">${escapeHtml(t('unverified'))}</span>`;

  const kindClass = o.kind === 'middle' ? 'is-middle' : '';
  const roi = Math.max(0, Math.min(100, (o.roiPercent || 0) * ROI_BAR_SCALE));
  const hotClass = (o.roiPercent || 0) > 5 ? 'opp-hot' : '';
  const rawMarket = o.marketKey || o.market || '';
  const marketLabel = fmtMarketKey(rawMarket);
  const league = o.league || '';
  const sport = o.sport || 'Football';
  const kickoff = formatKickoff(o.kickoff);

  // Time since detection badge
  const detectedAt = o.detectedAt || o.createdAt || o.firstSeen;
  let timeBadge = '';
  if (detectedAt) {
    const parse = (window.EventDetailModal && window.EventDetailModal.parseDate) || ((v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; });
    const detectedDate = parse(detectedAt);
    if (detectedDate) {
      const ageMs = Date.now() - detectedDate.getTime();
      const ageText = window.arbiterFormat?.timeAgo(ageMs) || '—';
      let badgeClass = 'time-badge';
      if (ageMs < BADGE_FRESH_MS) badgeClass += ' fresh'; // <5min
      else if (ageMs < BADGE_RECENT_MS) badgeClass += ' recent'; // <30min
      else badgeClass += ' old';
      timeBadge = `<span class="${badgeClass}" title="${t('detectedAgo')} ${ageText}">${ageText}</span>`;
    }
  }

  // Market chips: one per unique market key in the group, best one active
  const markets = allMarkets && allMarkets.length > 1 ? allMarkets : null;
  const marketChips = markets
    ? `<div class="opp-market-chips">${markets.map((m, i) => {
        const mk = m.marketKey || m.market || '';
        const label = fmtMarketKey(mk);
        const roi2 = (m.roiPercent || 0).toFixed(2);
        return `<button class="opp-market-chip${i === 0 ? ' active' : ''}" type="button" data-market-idx="${i}" title="${escapeHtml(mk)} · +${roi2}%">${escapeHtml(label)}</button>`;
      }).join('')}</div>`
    : '';

const dataAttrs = [
    `data-sport="${escapeHtml(o.sport)}"`,
    `data-home="${escapeHtml(o.homeTeam || '')}"`,
    `data-away="${escapeHtml(o.awayTeam || '')}"`,
    `data-kickoff="${escapeHtml(o.kickoff || '')}"`,
    `data-detected-at="${escapeHtml(o.detectedAt || o.createdAt || o.firstSeen || '')}"`,
    markets ? `data-group-size="${markets.length}"` : '',
    // data-group holds only the serializable projection used by the market-chip
    // swap: market key, ROI, and per-leg {sourceId, selection, odds, stake}.
    // No verification/other mutable fields — the JSON is idempotent and safe to
    // re-stringify.
    markets ? `data-group="${escapeHtml(JSON.stringify(markets.map((m) => ({
      roiPercent: m.roiPercent,
      marketKey: m.marketKey || m.market || '',
      legs: (m.legs || []).map((l) => ({ sourceId: l.sourceId, selection: l.selection, odds: l.odds, stake: l.stake })),
    }))))}"` : '',
  ].join(' ');

  const eventLabel = `${o.homeTeam || '—'} ${t('vs')} ${o.awayTeam || '—'}${kickoff ? ` — ${kickoff}` : ''}`;

  return `
    <article class="opp-card-v2 ${kindClass} ${hotClass}" ${dataAttrs}>
      <div class="head">
        <div class="match-row">
          <div class="match">
            <button type="button" class="event-link" data-event-link aria-haspopup="dialog" title="${escapeHtml(t('viewEvent'))}" aria-label="${escapeHtml(eventLabel)}">
              <span class="home">${escapeHtml(o.homeTeam || '—')}</span>
              <span class="vs">${t('vs')}</span>
              <span class="away">${escapeHtml(o.awayTeam || '—')}</span>
              <svg class="event-link-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </button>
</div>
<div class="match-meta">
          <span class="chip">${escapeHtml(sport)}</span>
          ${league ? `<span>${escapeHtml(league)}</span>` : ''}
          ${kickoff ? `<span class="dim mono">${escapeHtml(kickoff)}</span>` : ''}
          ${marketLabel ? `<span class="chip chip-market">${escapeHtml(marketLabel)}</span>` : ''}
            ${timeBadge}
            ${status}
          </div>
        </div>
        <div class="roi-block">
          <div class="roi">+${(o.roiPercent || 0).toFixed(2)}<span class="pct">%</span></div>
          ${o.guaranteedProfit !== null && o.guaranteedProfit !== undefined ? `<div class="profit-badge green" title="${t('guaranteedProfit')}">+${fmtStake(o.guaranteedProfit)} RON</div>` : ''}
          <div class="roi-bar" aria-hidden="true"><div class="fill" style="width:${roi.toFixed(1)}%"></div></div>
          ${markets ? `<div class="opp-market-count">${markets.length} ${t('markets')}</div>` : ''}
        </div>
      </div>
      ${marketChips}
      <div class="legs">${legs}</div>
    </article>`;
}

/* ---------------- Keyboard navigation for opportunity cards ---------------- */
let currentCardIndex = -1;

function updateCardFocus() {
  const cards = document.querySelectorAll('.opp-card-v2');
  cards.forEach((card, i) => {
    if (i === currentCardIndex) {
      card.setAttribute('tabindex', '0');
      card.focus();
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      card.setAttribute('tabindex', '-1');
    }
  });
}

document.addEventListener('keydown', (e) => {
  const oppList = document.getElementById('opp-list');
  if (!oppList || !oppList.contains(document.activeElement)) return;

  const cards = document.querySelectorAll('.opp-card-v2');
  if (cards.length === 0) return;

  switch (e.key) {
    case 'ArrowDown':
    case 'j':
      e.preventDefault();
      currentCardIndex = Math.min(currentCardIndex + 1, cards.length - 1);
      updateCardFocus();
      break;
    case 'ArrowUp':
    case 'k':
      e.preventDefault();
      currentCardIndex = Math.max(currentCardIndex - 1, 0);
      updateCardFocus();
      break;
    case 'Enter':
      // If focus is on a card's own interactive element (event link, market
      // chip), let it handle the key — don't also toggle leg expansion.
      if (e.target.closest && e.target.closest('.opp-card-v2 button')) return;
      e.preventDefault();
      if (currentCardIndex >= 0 && currentCardIndex < cards.length) {
        const card = cards[currentCardIndex];
        // Toggle card expansion
        const legs = card.querySelector('.legs');
        if (legs) {
          const isExpanded = legs.style.display !== 'none';
          legs.style.display = isExpanded ? 'none' : 'grid';
          card.setAttribute('aria-expanded', !isExpanded);
        }
      }
      break;
    case 'Home':
      e.preventDefault();
      currentCardIndex = 0;
      updateCardFocus();
      break;
    case 'End':
      e.preventDefault();
      currentCardIndex = cards.length - 1;
      updateCardFocus();
      break;
  }
});

// Initialize card tabindex when cards are rendered
function initCardNavigation() {
  const cards = document.querySelectorAll('.opp-card-v2');
  cards.forEach((card, i) => {
    card.setAttribute('tabindex', i === 0 ? '0' : '-1');
    card.setAttribute('role', 'article');
    card.setAttribute('aria-label', `Opportunity ${i + 1} of ${cards.length}`);
  });
}

arbiterSse.connect((type, payload) => {
  if (type === 'scrape-update' && payload && payload.status === 'completed') refresh();
  if (type === 'scan-update') refresh();
}, (state) => {
  const t = arbiterI18n.t.bind(arbiterI18n);
  const indicator = document.getElementById('sse-status');
  if (indicator) {
    indicator.className = `live-indicator ${state === 'open' ? 'connected' : 'disconnected'}`;
    const label = indicator.querySelector('span:last-child');
    if (label) label.textContent = state === 'open' ? 'Live' : t('reconnecting');
  }
});

/* ---------------- Event detail modal ---------------- */
// The modal itself (open/render/fallback/race-token) lives in
// event-detail-modal.js. dashboard.js only wires the shared helpers, owns the
// card-click delegation, and delegates the actual open to the module so the
// race/fallback logic has a single owner.
const eventDetailModal = window.EventDetailModal;
if (eventDetailModal) {
  eventDetailModal.init({
    paletteFor,
    fmtOdds,
    fmtStake,
    parseStakeAmount,
    escapeHtml,
    arbiterI18n,
    arbiterApi,
    arbiterFormat: window.arbiterFormat,
    parseDate: (v) => { const d = v ? new Date(v) : null; return (d && !Number.isNaN(d.getTime())) ? d : null; },
  });
}

// Single source of truth for leg markup lives in event-detail-modal.js (so the
// card and the dialog render legs identically). Dashboards whose module loaded
// delegate to it; only when the module failed to load (eventDetailModal null)
// does this render its own copy as a degraded fallback.
function dashRenderLeg(l, t, roiPercent) {
  if (eventDetailModal) return eventDetailModal.renderLeg(l, t, roiPercent);
  const pal = paletteFor(l.sourceId);
  return `<div class="leg">
      <div class="head">
        <span class="book" style="color:${pal.color};">${escapeHtml(l.sourceId)}</span>
        <span class="stake">${t('stake')} ${fmtStake(l.stake)}</span>
      </div>
      <div class="pick">${escapeHtml(l.selection)}</div>
      <div class="odds">${fmtOdds(l.odds)}</div>
      <div class="profit">+${fmtStake((l.stake || 0) * (roiPercent || 0) / 100)} RON</div>
    </div>`;
}

// Market-chip click — swap legs, don't open modal. Extracted to a named
// function so it can be extracted/tested by the harness.
function swapMarketLegs(card, chip) {
  const idx = Number(chip.dataset.marketIdx);
  let group;
  try { group = JSON.parse(card.dataset.group || '[]'); } catch { return; }
  const picked = group[idx];
  if (!picked) return;
  // Update active chip
  card.querySelectorAll('.opp-market-chip').forEach((c, i) => c.classList.toggle('active', i === idx));
  // Swap legs and market chip label in meta
  const fakeOpp = { ...picked, homeTeam: card.dataset.home, awayTeam: card.dataset.away, sport: card.dataset.sport, kickoff: card.dataset.kickoff };
  const t = arbiterI18n.t.bind(arbiterI18n);
  const legsHtml = (fakeOpp.legs || []).map((l) => dashRenderLeg(l, t, fakeOpp.roiPercent)).join('');
  const legsEl = card.querySelector('.legs');
  if (legsEl) legsEl.innerHTML = legsHtml;
  // Update the market chip in match-meta
  const metaChip = card.querySelector('.chip-market');
  if (metaChip) metaChip.textContent = fmtMarketKey(fakeOpp.marketKey);
  // Update ROI
  const roiEl = card.querySelector('.roi');
  if (roiEl) roiEl.innerHTML = `+${(fakeOpp.roiPercent || 0).toFixed(2)}<span class="pct">%</span>`;
}

// When event-detail-modal.js failed to load, the event-link affordance cannot
// open the dialog. Surface a brief inline notice on the card so the user sees
// why nothing happened, instead of leaving the console as the only witness.
function flashDetailUnavailable(card) {
  const existing = card.querySelector('.dialog-note[data-detail-unavailable]');
  if (existing) return; // already visible on this card
  const note = document.createElement('div');
  note.className = 'dialog-note';
  note.setAttribute('data-detail-unavailable', '');
  note.textContent = arbiterI18n.t('detailUnavailable');
  card.appendChild(note);
  setTimeout(() => note.remove(), 4000);
}

// Delegated click handler for the opportunity list: market chips swap legs,
// the event link (and the plain card) open the event detail dialog.
function handleOppListClick(e) {
  // Market chip click — swap legs, don't open modal
  const chip = e.target.closest('.opp-market-chip');
  if (chip) {
    const card = chip.closest('.opp-card-v2');
    if (card) swapMarketLegs(card, chip);
    return;
  }
  // Event link click — open modal for this card
  const eventLink = e.target.closest('[data-event-link]');
  if (eventLink) {
    const card = eventLink.closest('.opp-card-v2');
    if (!card) return;
    if (eventDetailModal) {
      eventDetailModal.openEventDetail(card);
    } else {
      console.warn('[dashboard] event-detail-modal.js did not load; event link cannot open the dialog', card);
      flashDetailUnavailable(card);
    }
    return;
  }
  if (e.target.closest('a')) return;
  const card = e.target.closest('.opp-card-v2');
  if (!card) return;
  if (eventDetailModal) eventDetailModal.openEventDetail(card);
  else {
    console.warn('[dashboard] event-detail-modal.js did not load; card click cannot open the dialog', card);
    flashDetailUnavailable(card);
  }
}

document.getElementById('opp-list').addEventListener('click', handleOppListClick);

refresh();

// Dashboard v2 — premium KPI cards, ticker, source rows, opportunity cards v2.
arbiterApp.mount('dashboard');

const oppList = document.getElementById('opp-list');
const sourceHealthList = document.getElementById('source-health');

// Compact loading state; avoid the former full-card layout shift.
const oppSkeleton = `<p role="status">${arbiterI18n.lang === 'en' ? 'Loading opportunities…' : 'Se încarcă oportunitățile…'}</p>`;

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

// Shared formatters — single source of truth in /js/format.js (window.arbiterFormat),
// which index.html always loads before this file. The local book palette that used
// to sit here duplicated format.js's palette with a different hash, so a book
// changed color depending on script order; there is now exactly one palette.
function paletteFor(id) {
  if (window.arbiterFormat && window.arbiterFormat.paletteFor) return window.arbiterFormat.paletteFor(id);
  return { color: '#f472b6', bg: 'rgba(244,114,182,0.12)', border: 'rgba(244,114,182,0.30)' };
}

/**
 * The books the source-health card lists, largest first.
 *
 * This used to end in `.slice(0, 8)` while the card's own header counted all
 * of them, so a scan over 22 books announced 22 and showed 8. The cap protected
 * nothing: `.source-health` is `max-height: 420px; overflow-y: auto`
 * (dashboard.css), a panel built to scroll. The fourteen books that a cap
 * omitted were not summarised anywhere else — the quick bar says "0/22 fresh"
 * and the scrape page lists no per-book data at all — so the one question this
 * card exists to answer, "which of my books is not contributing", had an
 * answer that named only the eight busiest.
 *
 * Every book is listed now. The order is unchanged: a book that failed with
 * zero events still sorts last, which is a judgement call about what this card
 * is for and not a fact about the data, so it is left to stand.
 *
 * @param {Array<object>} [sources] - The scan's `sources` array.
 * @returns {Array<object>} A new array; the scan's own is not sorted in place.
 */
function sourceHealthRows(sources) {
  return (sources || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0));
}

/**
 * Which other books this one cannot be paired against, and why.
 *
 * `sharedFeedPeers` is annotated onto every source for exactly this purpose —
 * "so the UI can say why a pairing was not considered" (feed-groups.mjs:114) —
 * and no page said it. The annotation cannot live on an opportunity either: a
 * shared-feed pair is absent from every list by construction, so there is no
 * leg row to hang it on. A book list is the only place a reader ever meets it.
 *
 * It is not a rare case. Over the capture, with 22 books fresh, the engine
 * refused 178,660 pairings across 24 distinct book pairs, the largest being
 * casa-pariurilor/fortuna at 14,262. A reader who sees thousands of +EV rows and
 * no arbitrage between two brands has no other way to learn the answer.
 *
 * The group slug is deliberately not shown. `feedGroup` reads `nsoft-company`,
 * `exalogic-xsport`, `everymatrix-wamp` — operator identifiers, the same
 * mistake the market key was on the catalog page. What a reader needs is which
 * books, and `sharedFeedWith` is already that list.
 *
 * @param {object} [source] - One record of the scan's `sources` array.
 * @param {(key: string) => string} t - The dictionary lookup.
 * @returns {string} Empty for a book that stands alone.
 */
function sourceFeedNote(source, t) {
  const clones = Number((source && source.duplicateFeedEvents) || 0);
  const peers = Array.isArray(source && source.sharedFeedWith)
    ? source.sharedFeedWith.filter(Boolean)
    : [];
  const parts = [];
  // Clones first: a book whose feed was caught out at runtime is a stronger
  // statement than one whose group was declared up front.
  if (clones > 0) parts.push(t('droppedClones').replace('{count}', String(clones)));
  if (peers.length) parts.push(`${t('sameFeedAs')}: ${peers.join(', ')}`);
  return parts.join(' · ');
}

/**
 * The badge text for a data status, in the page's language.
 *
 * This card rendered `source.dataStatus` raw, so a Romanian page showed
 * "stale" and "partial" in English while the dictionary held the translations
 * two hundred lines away. The key is assembled the way connection-status.js
 * assembles it — `'status' + Capitalised` — so one rule covers every status and
 * `statusFresh`, added alongside, repairs that page too: it builds the same key
 * and was silently falling back to the English token because the key was absent.
 *
 * @param {string} [state] - A `DATA_STATUS` value from the scan.
 * @param {(key: string) => string} t - The dictionary lookup.
 * @returns {string} The translation, or the raw token when there is none.
 */
function sourceStatusLabel(state, t) {
  const token = String(state || 'unknown');
  const key = 'status' + token.charAt(0).toUpperCase() + token.slice(1);
  const translated = t(key);
  // t() hands back the key itself when a key is missing, so a truthy check here
  // would print "statusCancelled" on the card instead of the word.
  return translated === key ? token : translated;
}

/**
 * Why this book is in the state it is in, in the page's language.
 *
 * The backend was publishing an English sentence in `dataReason` on every one
 * of the capture's twenty-two books and no page read it. A sentence a page
 * cannot translate is a sentence the page does not show, so `dataReasonCode`
 * now names which failure this is and this translates it. The prose stays as
 * the fallback for a code added to the backend after this page shipped: an
 * unrecognised code shows the operator's sentence rather than nothing, which is
 * the difference between a stale build and a blank card.
 *
 * @param {object} [source] - One record of the scan's `sources` array.
 * @param {(key: string) => string} t - The dictionary lookup.
 * @returns {string} Empty when the book needs no explanation — a fresh one.
 */
function sourceReasonText(source, t) {
  const code = source && source.dataReasonCode;
  if (!code) return '';
  const key = 'reason' + code.charAt(0).toUpperCase() + code.slice(1);
  let text = t(key);
  if (text === key) return (source.dataReason || '');

  const params = source.dataReasonParams || {};
  // {status} is filled from the translated badge rather than the raw token, so
  // a reason never quotes an English word inside a translated sentence.
  if (text.includes('{status}')) text = text.replace('{status}', sourceStatusLabel(source.dataStatus, t));
  if (text.includes('{minutes}')) text = text.replace('{minutes}', String(Math.round(Number(params.limit || 0) / 60000)));
  if (text.includes('{count}')) text = text.replace('{count}', String(params.count ?? ''));
  if (text.includes('{checked}')) text = text.replace('{checked}', String(params.checked ?? ''));
  return text;
}

function fmtStake(n) {
  if (typeof window !== 'undefined' && window.arbiterFormat && window.arbiterFormat.fmtStake) {
    return window.arbiterFormat.fmtStake(n);
  }
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtOdds(n) {
  if (typeof window !== 'undefined' && window.arbiterFormat && window.arbiterFormat.fmtOdds) {
    return window.arbiterFormat.fmtOdds(n);
  }
  return Number(n || 0).toFixed(2);
}

function parseStakeAmount(label) {
  if (typeof window !== 'undefined' && window.arbiterFormat && window.arbiterFormat.parseStakeAmount) {
    return window.arbiterFormat.parseStakeAmount(label);
  }
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

    // Update data-freshness banner (A4)
    if (window.arbiterConnectionStatus && window.arbiterConnectionStatus.setDataHealth) {
      window.arbiterConnectionStatus.setDataHealth(health);
    }


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
    const totalEvents = scan.eventCount;
    if (qbEvents) qbEvents.textContent = Number.isFinite(totalEvents) && totalEvents >= 0
      ? totalEvents.toLocaleString()
      : '—';
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
    const sourceRows = sourceHealthRows(scan.sources);
    sourceHealthList.innerHTML = sourceRows.length ? sourceRows.map((source) => {
      const state = source.dataStatus || 'unknown';
      const stateClass = state === 'fresh' ? 'completed' : state === 'failed' ? 'failed' : 'partial';
      const pal = paletteFor(source.sourceId);
      const initials = String(source.sourceId || '?').slice(0, 2);
      const reason = sourceReasonText(source, t);
      const feedNote = sourceFeedNote(source, t);
      // Freshness bar: 100% = fresh, decreasing with age
      const maxAge = 3600000; // 1h = fully stale
      const freshness = source.ageMs ? Math.max(0, Math.min(100, (1 - source.ageMs / maxAge) * 100)) : 100;
      const freshClass = freshness > 70 ? 'fresh' : freshness > 30 ? 'stale' : 'old';
      return `<div class="source-row" style="--source-color:${pal.color};--source-bg:${pal.bg};--source-border:${pal.border};">
        <div class="source-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
        <div style="min-width:0">
          <div class="source-name">${escapeHtml(source.sourceId || '—')}${feedNote ? `<span class="chip source-feed" title="${escapeHtml(feedNote)}">${escapeHtml(feedNote)}</span>` : ''}</div>
          <div class="source-meta">${Number(source.count || 0).toLocaleString()} ${t('events')}${source.ageMs ? ` · ${window.arbiterFormat?.timeAgo(source.ageMs) || '—'}` : ''}</div>
          ${reason ? `<div class="source-reason">${escapeHtml(reason)}</div>` : ''}
        </div>
        <div class="freshness-bar" aria-hidden="true"><div class="fill ${freshClass}" style="width:${freshness.toFixed(0)}%"></div></div>
        <div class="source-stats">${Number(source.count || 0).toLocaleString()} <span class="muted">ev</span></div>
        <span class="status ${stateClass}">${escapeHtml(sourceStatusLabel(state, t))}</span>
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
        const key = JSON.stringify([o.sport || '', o.homeTeam || o.eventKey || '', o.awayTeam || '', o.kickoff || '']);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
      }

      const groupValues = [...groups.values()];
      const MAX_CARDS = 20;
      const initialCards = groupValues.slice(0, MAX_CARDS);
      const remainingCards = groupValues.slice(MAX_CARDS);

      const headings = arbiterI18n.lang === 'en'
        ? ['Event / sport', 'Best market', 'Type / verification', 'Markets', 'ROI', 'Details']
        : ['Eveniment / sport', 'Cea mai bună piață', 'Tip / verificare', 'Piețe', 'ROI', 'Detalii'];
      list.innerHTML = `<div class="opportunity-table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(t('topOpportunities'))}"><table class="opportunity-table"><thead><tr>${headings.map(h => `<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${initialCards.map(renderOppGroup).join('')}</tbody></table></div>`;

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
          list.querySelector('tbody').insertAdjacentHTML('beforeend', remainingHtml);
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

    // Flash effect on data update (skip first load). The overview renders
    // rows, so the highlight applies to them; the source-health list is
    // unchanged.
    if (!isFirstLoad) {
      document.querySelectorAll('#opp-list .opportunity-row').forEach((row, i) => {
        setTimeout(() => row.classList.add('flash'), i * 50);
        setTimeout(() => row.classList.remove('flash'), 800 + i * 50);
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

// Format a raw market key into a human-readable label with threshold.
// Single source of truth in /js/format.js; this wrapper keeps it testable.
function fmtMarketKey(key) {
  if (window.arbiterFormat && window.arbiterFormat.fmtMarketKey) {
    // Use shared formatter but apply local pretty-names on top
    const shared = window.arbiterFormat.fmtMarketKey(key);
    if (shared) return shared;
  }
  if (!key) return '';
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

/**
 * The in-play marker, identical to the scanner page's.
 *
 * The dashboard is where a signal is first looked at, so an in-play price that
 * is not marked here is a price a trader places on a match that has moved on.
 * It is given a boolean, not a signal, because the caller decides what "this
 * match is being played" means across the group — see renderOppGroup. It never
 * reads the kickoff: a pre-match price whose kickoff has passed is stale, not
 * running.
 */
function dashLiveBadge(t, inPlay) {
  return inPlay === true
    ? `<span class="chip red live-badge" title="${escapeHtml(t('liveTooltip'))}">${escapeHtml(t('live'))}</span>`
    : '';
}

// Render a group of opportunities for the same match as one collapsed card
function renderOppGroup(opps) {
  if (!opps || !opps.length) return '';
  const best = opps[0]; // already sorted by ROI desc
  const t = arbiterI18n.t.bind(arbiterI18n);
  const params = new URLSearchParams({ sport: best.sport || '', home: best.homeTeam || '', away: best.awayTeam || '', kickoff: best.kickoff || '' });
  const href = escapeHtml(`/event.html?${params}`);
  const event = `${best.homeTeam || '—'} ${t('vs')} ${best.awayTeam || '—'}`;
  const marketCount = new Set(opps.map(o => o.marketKey || o.market || '').filter(Boolean)).size;
  const roi = Number(best.roiPercent || 0);
  const kind = best.kind === 'middle' ? (arbiterI18n.lang === 'en' ? 'Middle' : 'Mijloc') : (arbiterI18n.lang === 'en' ? 'Arbitrage' : 'Arbitraj');
  // A row is one match with every market found on it, so the row is live when
  // any of them is — not only when the ROI-best one happens to be. Marking only
  // the best would leave a live match unmarked whenever a cheaper pre-match
  // market sorts first.
  const inPlay = opps.some(o => o.live === true);
  return `<tr class="opportunity-row">
    <th scope="row"><span class="strong">${escapeHtml(event)}</span> ${dashLiveBadge(t, inPlay)}<small>${escapeHtml([best.sport, best.league, formatKickoff(best.kickoff)].filter(Boolean).join(' · '))}</small></th>
    <td>${escapeHtml(fmtMarketKey(best.marketKey || best.market || ''))}</td>
    <td>${escapeHtml(kind)}<small>${escapeHtml(best.verification?.status ? t(best.verification.status) : t('unverified'))}</small></td>
    <td class="num">${marketCount}</td><td class="num tabnum mono">${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%</td>
    <td><a class="opportunity-details" href="${href}" aria-label="${escapeHtml(`${t('viewDetails')}: ${event}`)}">${escapeHtml(t('viewDetails'))}</a></td>
  </tr>`;
}

// Badge age thresholds (ms) for the card's "detected ago" time badge.
const BADGE_FRESH_MS = 5 * 60 * 1000;   // <5 min
const BADGE_RECENT_MS = 30 * 60 * 1000; // <30 min

// ROI bar scale: map roiPercent onto the 0-100 fill width.
const ROI_BAR_SCALE = 12;

// Shared formatters are loaded once via /js/format.js (see window.arbiterFormat).
function formatKickoff(kickoff) {
  if (window.arbiterFormat && window.arbiterFormat.formatKickoff) return window.arbiterFormat.formatKickoff(kickoff);
  // standalone fallback (keeps the function self-contained for tests/harnesses)
  if (!kickoff) return '';
  const d = new Date(kickoff);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}
function parseDate(value) {
  if (window.arbiterFormat && window.arbiterFormat.parseDate) return window.arbiterFormat.parseDate(value);
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Retained for the existing card-renderer regression harness; overview uses rows.
// eslint-disable-next-line no-unused-vars
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
  // '' when the record carries no sport, so the chip below is omitted rather
  // than labelled Football — the same fact the CSV writes as an empty cell
  // and renderOppGroup filters out of the match line above.
  const sport = o.sport || '';
  const kickoff = formatKickoff(o.kickoff);

  // Time since detection badge
  const detectedAt = o.detectedAt || o.createdAt || o.firstSeen;
  let timeBadge = '';
  if (detectedAt) {
    const detectedDate = parseDate(detectedAt);
    if (detectedDate) {
      const ageMs = Date.now() - detectedDate.getTime();
      const ageText = (window.arbiterFormat && window.arbiterFormat.timeAgo(ageMs)) || '—';
      let badgeClass = 'time-badge';
      if (ageMs < BADGE_FRESH_MS) badgeClass += ' fresh'; // <5min
      else if (ageMs < BADGE_RECENT_MS) badgeClass += ' recent'; // <30min
      else badgeClass += ' old';
      timeBadge = `<span class="${badgeClass}" title="${t('detectedAgo')} ${ageText}">${ageText}</span>`;
    }
  }

  // Market chips: one per unique market key in the group, best one active
  const markets = allMarkets && allMarkets.length > 1 ? allMarkets : null;
  // The card groups several opportunities of one match, so the verdict is taken
  // over the whole group: a card is live if any market in it is. Reading `o`
  // alone would mark it from the one opportunity the card was built for.
  const inPlay = o.live === true || (markets || []).some((m) => m.live === true);
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
      legs: (m.legs || []).map((l) => ({ sourceId: l.sourceId, selection: l.selection, odds: l.odds, stake: l.stake, eventUrl: l.eventUrl || null })),
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
          ${sport ? `<span class="chip">${escapeHtml(sport)}</span>` : ''}
          ${dashLiveBadge(t, inPlay)}
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

/* ---------------- Keyboard navigation for the opportunity table ---------------- */
let currentRowIndex = -1;

/**
 * Move focus between opportunity rows.
 *
 * The overview is a table, not a stack of cards: each row's Details link is a
 * real anchor, so Tab already reaches it and Enter opens it. What the table
 * does not give for free is arrow-key movement between rows, which is what the
 * card layout provided. Rows are given a roving tabindex so exactly one is in
 * the tab order and the arrow keys have something to move between.
 */
function focusRow(rows, index) {
  if (index < 0 || index >= rows.length) return;
  currentRowIndex = index;
  rows.forEach((row, i) => row.setAttribute('tabindex', i === index ? '0' : '-1'));
  const row = rows[index];
  row.focus();
  row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function opportunityRows() {
  return [...document.querySelectorAll('#opp-list .opportunity-row')];
}

document.addEventListener('keydown', (e) => {
  const oppList = document.getElementById('opp-list');
  if (!oppList || !oppList.contains(document.activeElement)) return;

  const rows = opportunityRows();
  if (rows.length === 0) return;
  const from = Math.max(0, currentRowIndex);

  switch (e.key) {
    case 'ArrowDown':
    case 'j':
      e.preventDefault();
      focusRow(rows, Math.min(from + 1, rows.length - 1));
      break;
    case 'ArrowUp':
    case 'k':
      e.preventDefault();
      focusRow(rows, Math.max(from - 1, 0));
      break;
    case 'Home':
      e.preventDefault();
      focusRow(rows, 0);
      break;
    case 'End':
      e.preventDefault();
      focusRow(rows, rows.length - 1);
      break;
    default:
      break;
  }
});

/** Give the rows a roving tabindex once they are rendered. */
function initCardNavigation() {
  const rows = opportunityRows();
  rows.forEach((row, i) => {
    if (row.getAttribute('tabindex') === null) {
      row.setAttribute('tabindex', i === 0 ? '0' : '-1');
    }
  });
}

arbiterSse.connect((type, payload) => {
  if (type === 'scrape-update' && payload && payload.status === 'completed') refresh();
  if (type === 'scan-update') refresh();
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
function dashRenderLeg(l, t, _roiPercent) {
  if (eventDetailModal) return eventDetailModal.renderLeg(l, t, _roiPercent);
  const pal = paletteFor(l.sourceId);
  // No link here, deliberately. This body only runs when the modal module failed
  // to load, and the module owns the denylist that decides whether a leg's
  // eventUrl is a browseable page or the adapter's capture endpoint — for most
    // books it is the endpoint. Rendering the link unconditionally is what the two
  // paths disagreed about; with the module absent there is no gate to ask, so
  // this degraded row shows the leg without one rather than guessing.
  // Same rule as the module: a leg's own money is payout − stake. ROI is a
  // property of the whole combination, so it is never scaled by one stake.
  const stake = Number(l.stake) || 0;
  const odds = Number(l.odds) || 0;
  const hasPayout = Number.isFinite(l.payout) && l.payout > 0;
  const net = hasPayout ? Math.round((l.payout - stake + Number.EPSILON) * 100) / 100 : null;
  return `<div class="leg">
      <div class="head">
        <span class="book" style="color:${pal.color};">${escapeHtml(l.sourceId)}</span>
        <span class="stake">${t('stake')} ${fmtStake(stake)}</span>
      </div>
      <div class="pick">${escapeHtml(l.selection)}</div>
      <div class="odds">${fmtOdds(odds)}</div>
      ${hasPayout
        ? `<div class="profit${net < 0 ? ' is-neg' : ''}">${net >= 0 ? '+' : ''}${fmtStake(net)} RON</div>`
        : '<div class="profit is-muted">' + fmtStake(odds) + '</div>'}
    </div>`;
}

// The overview renders one row per opportunity (see renderOppGroup), and the
// row's Details link carries the event identity in its query string — there is
// no per-card modal any more. A click on the row body is a convenience for the
// mouse; the link itself stays the keyboard-reachable control.
function handleOppListClick(e) {
  const row = e.target.closest('.opportunity-row');
  if (!row) return;
  // A click on the link, a modified click, or a text selection belongs to the
  // browser, not to us.
  if (e.target.closest('a, button')) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  if (window.getSelection()?.toString()) return;
  row.querySelector('.opportunity-details')?.click();
}

document.getElementById('opp-list').addEventListener('click', handleOppListClick);

refresh();

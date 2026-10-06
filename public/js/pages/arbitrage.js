// arbitrage.js — ArbEdge console: arbitrages, middles and positive-EV signals.
//
// One document, three families. The mockups had no version of this page, so it
// follows the same grammar as the two they did: a four-tile KPI row, then the
// signal itself as cards, then the two families that are naturally tabular as
// the design's bordered tables. Everything it shows is a field of GET /api/scan.
//
// The one thing it does not do is rank. marginPercent is the number, but the
// publisher already sorts, and re-sorting here would make the page disagree with
// the CSV the same data produces.

(function () {
  arbiterApp.mount('arbitrage');

  const $ = (id) => document.getElementById(id);
  // Local formatters rather than window.arbiterFormat. pages/common.js does
  // define these keys and every one of these pages loads it, but it is a plain
  // script evaluated before this file, and the harness in
  // test/scan-fields-census.test.mjs runs this file with the global set to null
  // on purpose — to catch a reader that assumes an object exists at load time.
  // The other page scripts here format locally for the same reason.
  const count = (n) => Number(n || 0).toLocaleString('en-US');
  const odds = (n) => Number(n || 0).toFixed(2);
  const stake = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const tone = (r) => {
    const n = Number(r || 0);
    if (n >= 3) return 'text-[var(--edge-green)]';
    if (n >= 1) return 'text-[var(--edge-blue)]';
    return 'text-[var(--edge-textBright)]';
  };
  const t = (key) => window.arbiterI18n.t(key);

  const state = { scan: null, sports: [], sport: '', q: '', confirmedOnly: false };

  // A driven scan publishes thousands of middles and positive-EV signals — 1961
  // and 11818 on the fixture this was built against — and rendering every row
  // costs more than the table can return. Each table is capped and says so, in
  // the row itself, with the count it is hiding rather than a bare "load more"
  // that leaves the reader unsure whether the filter is working.
  const MAX_ROWS = 200;

  // ---- shaping -------------------------------------------------------------

  const MONO = (v) => String(v || '').replace(/[_-]+/g, ' ').trim();
  const textOf = (row, extra) => {
    const legs = (row.legs || []).map((l) => l.sourceId).filter(Boolean);
    const names = [...new Set(legs)];
    return names.length ? names.join(' v ') : (extra || '\u2014');
  };
  const namesOf = (row) => `${row.homeTeam || '?'} v ${row.awayTeam || '?'}`;
  const signed = (n) => (Number(n || 0) > 0 ? '+' : '') + Number(n || 0).toFixed(2);
  const pct = (n) => `${Number(n || 0).toFixed(2)}%`;
  const money = (n) => (n === null || n === undefined ? '\u2014' : stake(n));

  function visible(list) {
    return list.filter((row) => {
      if (state.sport && row.sport !== state.sport) return false;
      if (state.confirmedOnly && !(row.verification && row.verification.status === 'confirmed')) return false;
      if (state.q) {
        const hay = [row.homeTeam, row.awayTeam, row.league, row.marketKey, textOf(row)]
          .join(' ').toLowerCase();
        if (!hay.includes(state.q)) return false;
      }
      return true;
    });
  }

  // ---- KPI row and the sidebar footer --------------------------------------

  function renderKpis(scan, shown) {
    const opps = scan.opportunities;
    const middles = shown.middles;
    const evs = shown.evs;
    const deployed = opps.reduce((sum, o) => sum + (Number(o.totalStake) || 0), 0);
    const profit = opps.reduce((sum, o) => sum + (Number(o.guaranteedProfit) || 0), 0);

    $('k-arbs').textContent = count(opps.length);
    $('k-profit').textContent = signed(profit);
    $('k-stake').textContent = money(deployed);
    $('k-middles').textContent = count(middles.length);
    $('k-ev').textContent = count(evs.length) + ' ' + t('ev');
  }

  // ---- arbitrage cards -----------------------------------------------------
  //
  // No arbitrage card existed in the mockups, so this follows the bookie tile
  // exactly: an identity row, a 2x2 stat block, then a bordered foot of legs.

  function legRow(leg) {
    // Named `oddsText`/`stakeText`, not `odds`/`stake`: a local const of the
    // same name shadows the formatter above, and `stake(leg.stake)` inside its own
    // initialiser is a temporal-dead-zone read that throws on the first leg.
    const oddsText = leg.odds === null || leg.odds === undefined ? '\u2014' : odds(leg.odds);
    const stakeText = leg.stake === null || leg.stake === undefined ? '\u2014' : stake(leg.stake);
    // Each leg carries the bookmaker's own URL for the same event. Render it as
    // an explicit, labelled link so the two-leg book pairing is auditable
    // against the book's own page, not just asserted by the feed id. The exact
    // form of that URL differs by adapter: betano/favbet/getsbet/excelbet give
    // a browseable event page, the NSoft/EGT/Sportify brands give the API
    // capture endpoint, and superbet publishes none. Label accordingly so a
    // raw JSON feed is never advertised as a book's event page, and never
    // invent one to fill the gap.
    const rawUrl = /^https?:\/\//i.test(String(leg.eventUrl || '')) ? String(leg.eventUrl) : null;
    const isCaptureFeed = rawUrl ? /api\/|jsonrpc|v2\/ro|offer\/structure|twapi|access-management|sportsbook-sm-distribution/i.test(rawUrl) : false;
    const bookLink = rawUrl
      ? `<a class="text-[var(--edge-blue)] hover:underline ml-1" href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(leg.eventUrl)}">${isCaptureFeed ? 'capture &#8599;' : 'page &#8599;'}</a>`
      : '';
    return `
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-[var(--edge-text)] truncate">${escapeHtml(leg.sourceId || '\u2014')} &middot; ${escapeHtml(MONO(leg.selection))}${bookLink}</span>
        <span class="text-xs whitespace-nowrap"><b>@${escapeHtml(oddsText)}</b> <span class="text-[var(--edge-textMuted)]">${escapeHtml(stakeText)}</span></span>
      </div>`;
  }

  function arbCard(o) {
    // A verification object only exists where a real verification pass
    // stamped one. Opportunities get one when the pass ran; middles and +EV
    // rows generally do not, because the engine still reports them as
    // informational while their payoff model is classic two-way/exclusivity.
    // Rendering every missing verdict as amber "unconfirmed" conflated "we
    // ran the check and it did not confirm" with "we never ran the check".
    // All three cases are now distinct.
    //
    //   confirmed   → green dot + "confirmed"
    //   rejected / expired / unconfirmed → amber dot + the real status
    //   no verification object          → neutral dot + "unverified"
    const vStatus = o.verification ? o.verification.status : null;
      const notVerified = !vStatus;
      const confirmed = vStatus === 'confirmed';
      const badgeText = confirmed ? t('confirmed') : (notVerified ? t('unverified') : (t(vStatus) || vStatus));
      const dotCls = confirmed ? 'bg-[var(--edge-green)]' : (notVerified ? 'bg-[var(--edge-textMuted)]' : 'bg-[var(--edge-amber)]');
      const textCls = confirmed ? 'text-[var(--edge-green)]' : (notVerified ? 'text-[var(--edge-textMuted)]' : 'text-[var(--edge-amber)]');
      const rejectedExplain = o.verification && o.verification.reason ? ` title="${escapeHtml(o.verification.reason)}"` : (notVerified ? ` title="${escapeHtml(t('notVerifiedYet'))}"` : '');
    return `
      <div class="card p-4">
        <div class="flex items-center justify-between mb-3 gap-2">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[var(--edge-surface2)] border border-[var(--edge-border)] text-[var(--edge-textBright)] shrink-0">${escapeHtml(MONO(o.marketKey) || '\u2014')}</span>
            <a class="text-sm font-semibold text-[var(--edge-textBright)] truncate min-w-0 hover:underline" href="${escapeHtml(eventLink(o))}">${escapeHtml(namesOf(o))}</a>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="status-dot ${dotCls}" aria-hidden="true"${rejectedExplain}></span>
            <span class="text-xs ${textCls}"${rejectedExplain}>${escapeHtml(badgeText)}</span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('margin'))}</div>
            <div class="text-sm font-semibold ${tone(o.marginPercent)}">${escapeHtml(signed(o.marginPercent))}%</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('profit'))}</div>
            <div class="text-sm font-semibold ${Number(o.guaranteedProfit) > 0 ? 'text-[var(--edge-green)]' : 'text-[var(--edge-textBright)]'}">${escapeHtml(money(o.guaranteedProfit))}</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('stake'))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)]">${escapeHtml(money(o.totalStake))}</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('payout'))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)]">${escapeHtml(money(o.worstCasePayout))}</div>
          </div>
        </div>
        <div class="space-y-1 pt-3 border-t border-[var(--edge-border)]">
          ${(o.legs || []).map(legRow).join('')}
        </div>
      </div>`;
  }

  function renderCards(opps) {
    const grid = $('arb-grid');
    if (!opps.length) {
      grid.innerHTML = `<div class="edge-empty">${escapeHtml(t('noOpportunities'))}</div>`;
      return;
    }
    grid.innerHTML = opps.map(arbCard).join('');
  }

  // ---- the three tables ---------------------------------------------------
  //
  // A leg is rendered as `book · selection @odds`, which is what makes a middle
  // or a positive-EV signal actionable: the number alone says there is an edge,
  // the leg says where to take it. `handicap` rides along when the market carries
  // one, because a middle on an Asian line is not the same middle as a total.

  function verifyBadge(row) {
    const v = row.verification;
    if (!v || !v.status) return '';
    const good = v.status === 'confirmed';
    const reason = v.reason ? ` title="${escapeHtml(v.reason)}"` : '';
    return `<span class="status-dot ${good ? 'bg-[var(--edge-green)]' : 'bg-[var(--edge-amber)]'}" aria-hidden="true"${reason}></span>`;
  }

  function liveBadge(row) {
    if (row.live !== true) return '';
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[var(--edge-blueDim)] border border-[var(--edge-blue)]/15 text-[var(--edge-blue)] ml-1">${escapeHtml(t('live'))}</span>`;
  }

  function moreRow(total, shown, cols) {
    if (total <= shown) return '';
    return `<tr><td colspan="${cols}" class="px-3 py-2 text-xs text-[var(--edge-textMuted)]">
      ${count(shown)} ${escapeHtml(t('of'))} ${count(total)} ${escapeHtml(t('shown'))} &mdash;
      ${escapeHtml(t('narrowHint'))}
    </td></tr>`;
  }

  function eventLink(row) {
    // Same deep-link the dashboard uses: /event.html?sport=&home=&away=&kickoff=
    const params = new URLSearchParams({
      sport: row.sport || '',
      home: row.homeTeam || '',
      away: row.awayTeam || '',
      kickoff: row.kickoff || '',
    });
    return `/event.html?${params}`;
  }

  function middleCard(m) {
    // Middles are informational: the engine does not yet re-quote their payoff
    // model, so no verification object is ever stamped on them. A null
    // verification is 'unverified', not 'unconfirmed'.
    const vStatus = m.verification ? m.verification.status : null;
    const notVerified = !vStatus;
    const confirmed = vStatus === 'confirmed';
    const badgeText = confirmed ? t('confirmed') : (notVerified ? t('unverified') : (t(vStatus) || vStatus));
    const dotCls = confirmed ? 'bg-[var(--edge-green)]' : (notVerified ? 'bg-[var(--edge-textMuted)]' : 'bg-[var(--edge-amber)]');
    const textCls = confirmed ? 'text-[var(--edge-green)]' : (notVerified ? 'text-[var(--edge-textMuted)]' : 'text-[var(--edge-amber)]');
    const explain = m.verification && m.verification.reason ? ` title="${escapeHtml(m.verification.reason)}"` : (notVerified ? ` title="${escapeHtml(t('notVerifiedYet'))}"` : '');
    const riskTone = Number(m.riskPercent) > 0 ? 'text-[var(--edge-amber)]' : 'text-[var(--edge-textBright)]';
    return `
      <div class="card p-4">
        <div class="flex items-center justify-between mb-3 gap-2">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[var(--edge-surface2)] border border-[var(--edge-border)] text-[var(--edge-textBright)] shrink-0">${escapeHtml(MONO(m.marketKey) || '—')}</span>
            ${m.arb ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[var(--edge-green)] text-white shrink-0" title="${escapeHtml(t('surebetHint'))}">${escapeHtml(t('surebet'))}</span>` : ''}
            <a class="text-sm font-semibold text-[var(--edge-textBright)] truncate min-w-0 hover:underline" href="${escapeHtml(eventLink(m))}">${escapeHtml(namesOf(m))}${liveBadge(m)}</a>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="status-dot ${dotCls}" aria-hidden="true"${explain}></span>
            <span class="text-xs ${textCls}"${explain}>${escapeHtml(badgeText)}</span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('margin'))}</div>
            <div class="text-sm font-semibold ${tone(m.marginPercent)}">${escapeHtml(signed(m.marginPercent))}%</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">Gap</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)]">${escapeHtml(String(m.gap === undefined ? '—' : m.gap))}</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">Risk</div>
            <div class="text-sm font-semibold ${m.arb ? 'text-[var(--edge-green)]' : riskTone}">${m.arb ? escapeHtml(pct(0)) : escapeHtml(pct(m.riskPercent))}</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('stake'))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)]">${escapeHtml(money(m.totalStake))} ${verifyBadge(m)}</div>
          </div>
        </div>
        ${m.arb && m.guaranteedProfit !== undefined && m.guaranteedProfit !== null ? `
        <div class="flex items-center justify-between gap-2 mb-3 px-3 py-2 rounded-lg bg-[var(--edge-green)]/10 border border-[var(--edge-green)]/25">
          <span class="text-xs text-[var(--edge-green)] font-semibold">${escapeHtml(t('guaranteedProfit'))}</span>
          <span class="text-sm font-bold text-[var(--edge-green)]">${escapeHtml(money(m.guaranteedProfit))}</span>
        </div>` : ''}
        <div class="space-y-1 pt-3 border-t border-[var(--edge-border)]">
          ${(m.legs || []).map(legRow).join('')}
        </div>
      </div>`;
  }

  function renderMiddles(middles) {
    const grid = document.getElementById('middle-grid');
    if (!grid) return;
    if (!middles.length) {
      grid.innerHTML = `<div class="edge-empty">${escapeHtml(t('noOpportunities'))}</div>`;
      return;
    }
    const shown = Math.min(middles.length, MAX_ROWS);
    grid.innerHTML = middles.slice(0, MAX_ROWS).map(middleCard).join('') +
      (middles.length > shown
        ? `<div class="text-xs text-[var(--edge-textMuted)] px-1">${count(shown)} ${escapeHtml(t('of'))} ${count(middles.length)} ${escapeHtml(t('shown'))} — ${escapeHtml(t('narrowHint'))}</div>`
        : '');
  }

  function renderEv(evs) {
    const body = document.getElementById('table-ev');
    if (!body) return;
    if (!evs.length) {
      body.innerHTML = `<tr><td colspan="7"><div class="edge-empty">${escapeHtml(t('noOpportunities'))}</div></td></tr>`;
      return;
    }
    const shown = Math.min(evs.length, MAX_ROWS);
    body.innerHTML = evs.slice(0, MAX_ROWS).map((e) => {
      // Read off the leg unconditionally rather than behind an `||`. The signal
      // copies the whole record onto its single leg, so `sourceId`/`odds` on the
      // parent and on the leg are the same value — but the fallback is what makes
      // the row correct for a producer that populates only one of the two, and a
      // short-circuit would leave the leg unread on every record that has both.
      const leg = (e.legs || [])[0];
      const legBook = leg && leg.sourceId;
      const legPrice = leg && leg.odds;
      const legStake = leg && leg.stake;
      const book = e.sourceId || legBook || '';
      const price = e.odds === null || e.odds === undefined ? (legPrice ?? null) : e.odds;
      return `<tr>
        <td class="px-3 py-2">
          <div class="text-[var(--edge-textBright)]">${escapeHtml(namesOf(e))}${liveBadge(e)}</div>
          <div class="text-xs text-[var(--edge-textMuted)] font-mono">${escapeHtml(String(e.eventKey || ''))}</div>
        </td>
        <td class="px-3 py-2 text-xs text-[var(--edge-textMuted)]">
          ${escapeHtml(MONO(e.marketKey))}
          ${e.selection ? `<div class="text-[var(--edge-text)]">${escapeHtml(MONO(e.selection))}</div>` : ''}
        </td>
        <td class="px-3 py-2 font-mono text-xs text-[var(--edge-textMuted)]">${escapeHtml(book)}</td>
        <td class="px-3 py-2 text-right text-[var(--edge-textBright)]">@${escapeHtml(price === null ? '—' : odds(price))}</td>
        <td class="px-3 py-2 text-right text-[var(--edge-textMuted)]">${escapeHtml(pct(e.consensusProbability * 100))}</td>
        <td class="px-3 py-2 text-right font-semibold text-[var(--edge-green)]">${escapeHtml(signed(e.evPercent))}%</td>
        <td class="px-3 py-2 text-right text-[var(--edge-textBright)]">${escapeHtml(legStake === undefined ? money(e.totalStake) : stake(legStake))}</td>
      </tr>`;
    }).join('') + moreRow(evs.length, shown, 7);
  }

  // Low hold is not an opportunity — it is a warning that the bookmaker is
  // holding a selection, which is why it gets its own table rather than a tab
  // on the arbitrages above: the operator's action differs.
  function renderLowHold(rows) {
    const body = document.getElementById('table-lowhold');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5"><div class="edge-empty">${escapeHtml(t('noOpportunities'))}</div></td></tr>`;
      return;
    }
    const shown = Math.min(rows.length, MAX_ROWS);
    body.innerHTML = rows.slice(0, MAX_ROWS).map((h) => `<tr>
      <td class="px-3 py-2">
        <div class="text-[var(--edge-textBright)]">${escapeHtml(namesOf(h))}</div>
        <div class="text-xs text-[var(--edge-textMuted)] font-mono">
          ${escapeHtml(String(h.eventKey || ''))}${h.sport ? ` · ${escapeHtml(h.sport)}` : ''}
        </div>
      </td>
      <td class="px-3 py-2 text-xs text-[var(--edge-textMuted)]">${escapeHtml(MONO(h.marketKey))}</td>
      <td class="px-3 py-2 font-mono text-xs text-[var(--edge-textMuted)]">${escapeHtml(h.sourceId || '')}</td>
      <td class="px-3 py-2 text-right text-[var(--edge-textBright)]">${escapeHtml(count(h.selectionCount))}</td>
      <td class="px-3 py-2 text-right font-semibold text-[var(--edge-amber)]">${escapeHtml(signed(h.holdPercent))}%</td>
    </tr>`).join('') + moreRow(rows.length, shown, 5);
  }

  // ---- data ----------------------------------------------------------------

  function render() {
    const scan = state.scan;
    if (!scan) return;
    const shown = {
      opps: visible(scan.opportunities),
      middles: visible(scan.middles),
      evs: visible(scan.positiveEv),
      holds: visible(scan.lowHold),
    };

    renderKpis(scan, shown);
    renderCards(shown.opps);
    renderMiddles(shown.middles);
    renderEv(shown.evs);
    renderLowHold(shown.holds);
    $('f-count').textContent = count(shown.opps.length + shown.middles.length + shown.evs.length);
  }

  async function refresh() {
    let scan;
    try {
      scan = await arbiterApi.get('/api/scan');
    } catch (_err) {
      $('f-count').textContent = t('failedShort');
      return;
    }
    if (!scan || !Array.isArray(scan.opportunities)) return;

    scan.middles = Array.isArray(scan.middles) ? scan.middles : [];
    scan.positiveEv = Array.isArray(scan.positiveEv) ? scan.positiveEv : [];
    scan.lowHold = Array.isArray(scan.lowHold) ? scan.lowHold : [];
    scan.sources = Array.isArray(scan.sources) ? scan.sources : [];
    state.scan = scan;
    state.sports = [...new Set(scan.opportunities.concat(scan.middles, scan.positiveEv)
      .map((r) => r.sport).filter(Boolean))].sort();

    $('f-sport').innerHTML = `<option value="">${escapeHtml(t('all'))}</option>`
      + state.sports.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    $('f-sport').value = state.sport;

    render();

    if (window.arbiterConnectionStatus && window.arbiterConnectionStatus.setDataHealth) {
      window.arbiterConnectionStatus.setDataHealth(scan.dataHealth || {});
    }
  }

  // ---- wiring --------------------------------------------------------------

  $('f-sport').addEventListener('change', (e) => {
    state.sport = e.target.value;
    render();
  });

  $('f-q').addEventListener('input', (e) => {
    state.q = e.target.value.trim().toLowerCase();
    render();
  });

  $('f-confirmed').addEventListener('change', (e) => {
    state.confirmedOnly = e.target.checked;
    render();
  });

  // The server publishes the CSV for this document, so the button goes there
  // rather than rebuilding the rows here and risking a second, drifting
  // definition of the same export.
  $('btn-export').addEventListener('click', () => {
    window.location.href = '/api/scan/export.csv';
  });

  refresh();

  let pending = null;
  arbiterSse.connect((type) => {
    if (type !== 'scan-update') return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(refresh, 600);
  });
})();

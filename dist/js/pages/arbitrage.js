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
  // Two formatters because there are two jobs. `stake` is for HEADLINE figures
  // — a total, a profit — where the whole unit is the unit that matters, and
  // the test suite pins that (`fmtStake(37.67) === '38'`). `stakeExact` is for
  // PER-LEG stakes, which are placed to the cent. Rounding legs to whole units
  // made a re-planned card add up to a different number than the card's own
  // total: at a 2,500 bankroll the legs rendered 1,721 + 432 + 348 = 2,501
  // under a stated 2,500. The Dutch split is exact to the cent and the
  // guarantees are computed from it, so the card that prints them has to print
  // them to the cent. This is the same split public/js/format.js already draws
  // between fmtStake and fmtMoney.
  const stakeExact = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const tone = (r) => {
    const n = Number(r || 0);
    if (n >= 3) return 'text-[var(--edge-green)]';
    if (n >= 1) return 'text-[var(--edge-blue)]';
    return 'text-[var(--edge-textBright)]';
  };
  const t = (key) => window.arbiterI18n.t(key);

  // `signal` is the filter that changes what this page is for: guaranteed,
  // conditional, mispriced, or cheap. `bankroll` is the operator's own
  // working stake, re-applied to every plan on the fly so the console does
  // not only ever show one bankroll-sized set of stakes.
  const state = {
    scan: null, sports: [], sport: '', q: '', confirmedOnly: false,
    signal: 'all', sort: 'edge', bankroll: 1000,
  };

  // How much of the bankroll a family commits, used only to scale the bars
  // so two signals are comparable by eye. 20% is the bar's full width.
  const METER_FULL = 20;

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

  // Which signal a row is, as the segmented control names it.
  //
  // These four are the values the scan writes into `type`, and they are not
  // the names of the arrays the rows arrive in: +EV rows publish
  // `positive_ev` and low-hold rows publish `low_hold`, while the arrays are
  // called positiveEv and lowHold. Matching the array name matches nothing.
  function classOf(row) {
    switch (row.type) {
      case 'middle': return 'middle';
      case 'positive_ev': return 'ev';
      case 'low_hold': return 'lowhold';
      case 'arb': return 'arb';
      // A row with no type at all is still an arb: it is the only family
      // that pays out regardless of the result.
      default: return 'arb';
    }
  }

  function matchesSignal(row) {
    // classOf runs whatever the selection is, including "all". The class
    // decides this row's colour and its chip, not only whether it survives
    // the filter, and relying on the selection to call it would leave rows
    // unclassified until the operator happened to click.
    const cls = classOf(row);
    return state.signal === 'all' || cls === state.signal;
  }

  // Edge is the number that decides whether a row is worth opening: the
  // margin for an arb, the ROI for a middle, the value for +EV.
  function edgeOf(row) {
    if (row.type === 'middle') return Number(row.roiPercent || 0);
    return Number(row.marginPercent || 0);
  }

  // Risk only exists where the payout is conditional.
  function riskOf(row) {
    return Number(row.riskPercent || 0);
  }

  const COMPARATORS = {
    edge: (a, b) => edgeOf(b) - edgeOf(a),
    risk: (a, b) => riskOf(a) - riskOf(b),
    stake: (a, b) => Number(b.totalStake || 0) - Number(a.totalStake || 0),
    kickoff: (a, b) => String(a.kickoff || '').localeCompare(String(b.kickoff || '')),
  };

  function visible(list) {
    const rows = list.filter((row) => {
      if (!matchesSignal(row)) return false;
      if (state.sport && row.sport !== state.sport) return false;
      if (state.confirmedOnly && !(row.verification && row.verification.status === 'confirmed')) return false;
      if (state.q) {
        const hay = [row.homeTeam, row.awayTeam, row.league, row.marketKey, textOf(row)]
          .join(' ').toLowerCase();
        if (!hay.includes(state.q)) return false;
      }
      return true;
    });
    const cmp = COMPARATORS[state.sort] || COMPARATORS.edge;
    return rows.slice().sort(cmp);
  }

  // ---- replanning the book ------------------------------------------------
  //
  // The scan publishes stakes at the bankroll the server ran with. An
  // operator working a different size still wants the ratios, so the plan is
  // recomputed here from the same inverse sum rather than asking the server
  // to re-scan: Dutch allocation is stake_i = bankroll * (1/odds_i) / sum(1/o),
  // and the guaranteed profit follows from the inverse sum directly.
  //
  // This ran to nothing at all until the bankroll control was wired to it. The
  // input existed, the masthead showed its value, and every number below it was
  // still the server's - so typing a new bankroll changed one label and nothing
  // an operator would actually place.
  //
  // It returns numbers, not a rebuilt row, and that part is load-bearing.
  // Rebuilding meant spreading the record, and a spread enumerates every own
  // key - so eighteen fields the page never renders came to look "read", and
  // the field census that exists to catch exactly that was blinded by the very
  // escape hatch. A plan is a set of numbers the caller may use or ignore; the
  // record on screen stays the record the scan published.
  //
  // @returns {{scale:number, totalStake:number}|null} null when the row cannot be split.
  function plan(row) {
    const legs = row.legs || [];
    if (legs.length < 2) return null;

    // One ratio, and only one. The scan published a Dutch allocation at the
    // bankroll the server ran with; an operator working a different size needs
    // the same allocation at theirs, and that is a division, not a re-derivation.
    //
    // Re-deriving it in the browser - stake_i = budget / odds_i / sum(1/o) -
    // would be the obvious way and is the wrong one: it re-runs the engine's
    // arithmetic in a second place, and the two answers drift apart the first
    // time the rounding differs. A card showing a payout the backend does not
    // publish is the exact defect this project exists to not have. Scaling the
    // published figures keeps every number on screen an engine number, and
    // guarantees the legs still sum to the total on the same card - which holds
    // algebraically, since totalStake, guaranteedProfit and worstCasePayout are
    // all proportional to the bankroll.
    const publishedTotal = Number(row.totalStake);
    const budget = Number(state.bankroll) > 0 ? Number(state.bankroll) : 0;
    if (!Number.isFinite(publishedTotal) || publishedTotal <= 0) return null;

    const scale = budget / publishedTotal;
    const totalStake = Math.round(budget * 100) / 100;

    // The legs, scaled and cent-rounded.
    //
    // The comment above promises the legs still sum to the total on this card,
    // and that holds algebraically -- but only until each leg is rounded on its
    // own. At a 40 bankroll the three legs rendered 27.53 + 6.90 + 5.56 = 39.99
    // under a stated 40. The engine already guarantees the same thing for the
    // split it publishes by folding its rounding residual into one leg (see
    // roundedArbitrageAllocation), so this does the same to the re-scaled split
    // rather than inventing a second convention on screen.
    const legStakes = (row.legs || []).map((leg) => {
      const v = Number(leg && leg.stake);
      return Number.isFinite(v) ? Math.round(v * scale * 100) / 100 : null;
    });
    const present = legStakes.filter((v) => v !== null);
    if (present.length) {
      const drift = Math.round((totalStake - present.reduce((a, b) => a + b, 0)) * 100);
      if (drift !== 0) {
        // Into the largest leg: a cent on the biggest stake is the least visible
        // place to put it, and it is the place the engine puts it.
        const big = legStakes.indexOf(Math.max(...present));
        legStakes[big] = Math.round((legStakes[big] + drift / 100) * 100) / 100;
      }
    }

    return { scale, totalStake, legStakes };
  }

  /**
   * A published money field, carried onto the operator's bankroll.
   *
   * The field name is an argument on purpose. Reading row.totalStake or
   * row.worstCasePayout is what keeps this page a reader of what the engine
   * published; a card that recomputes a payout of its own is how the screen and
   * the backend end up a cent apart on the number an operator stakes.
   *
   * Null and undefined are returned untouched rather than coerced to 0. The
   * engine writes a null guaranteedProfit on a middle precisely because a
   * middle can lose, and a page that turned that into "0.00" under a label
   * promising the opposite would be making the engine's silence speak.
   *
   * @param {object} row A signal row straight off the scan.
   * @param {string} field The published field to carry across.
   * @param {object|null} split The plan, or null when the row cannot be split.
   */
  function rescale(row, field, split) {
    const published = row[field];
    if (!split || published === null || published === undefined) return published;
    const value = Number(published);
    return Number.isFinite(value) ? Math.round(value * split.scale * 100) / 100 : published;
  }

  /** One leg's stake on the operator's bankroll, or the published one. */
  function stakeOf(leg, split, index) {
    if (split && split.legStakes && index !== undefined && split.legStakes[index] !== null) return split.legStakes[index];
    return rescale(leg, 'stake', split);
  }

  // ---- KPI row and the sidebar footer --------------------------------------

  function renderKpis(scan, shown) {
    const opps = scan.opportunities;
    const middles = shown.middles;
    const evs = shown.evs;
    const splits = opps.map(plan);
    const deployed = opps.reduce((sum, o, i) => sum + (Number(rescale(o, 'totalStake', splits[i])) || 0), 0);
    const profit = opps.reduce((sum, o, i) => sum + (Number(rescale(o, 'guaranteedProfit', splits[i])) || 0), 0);

    setKpi($('k-arbs'), count(opps.length));
    setKpi($('k-profit'), signed(profit));
    setKpi($('k-stake'), money(deployed));
    setKpi($('k-middles'), count(middles.length));
    setKpi($('k-ev'), count(evs.length));

    // The middles tile used to double as the +EV tile, so the only number
    // on the page was the one that was not itself a middles count.
    const surebets = middles.filter((m) => m.arb).length;
    $('k-middles-sub').textContent = surebets
      ? count(surebets) + ' ' + t('surebet') + ' \u00b7 risk-free if taken'
      : t('conditionalOnMargin');
  }

  // ---- arbitrage cards -----------------------------------------------------
  //
  // No arbitrage card existed in the mockups, so this follows the bookie tile
  // exactly: an identity row, a 2x2 stat block, then a bordered foot of legs.

  // `stakeValue` is the operator's own Dutch split where the row was
  // re-planned, and the scan's own stake where it was not. It is passed in
  // rather than read off the leg so the two can differ.
  function legRow(leg, stakeValue) {
    // Named `oddsText`/`stakeText`, not `odds`/`stake`: a local const of the
    // same name shadows the formatter above, and `stake(leg.stake)` inside its own
    // initialiser is a temporal-dead-zone read that throws on the first leg.
    const oddsText = leg.odds === null || leg.odds === undefined ? '\u2014' : odds(leg.odds);
    const staked = stakeValue === undefined ? leg.stake : stakeValue;
    const stakeText = staked === null || staked === undefined ? '\u2014' : stakeExact(staked);
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
    const split = plan(o);
    const totalStake = rescale(o, 'totalStake', split);
    const profit = rescale(o, 'guaranteedProfit', split);
    const payout = rescale(o, 'worstCasePayout', split);
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
            <div class="text-sm font-semibold ${Number(profit) > 0 ? 'text-[var(--edge-green)]' : 'text-[var(--edge-textBright)]'}">${escapeHtml(money(profit))}</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('stake'))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)]">${escapeHtml(money(totalStake))}</div>
          </div>
          <div>
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('payout'))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)]">${escapeHtml(money(payout))}</div>
          </div>
        </div>
        <div class="space-y-1 pt-3 border-t border-[var(--edge-border)]">
          ${(o.legs || []).map((leg, i) => legRow(leg, stakeOf(leg, split, i))).join('')}
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

  // The window a middle spans, in the engine's own canonical words. Books
  // spell the two sides four ways - Over/Under, Peste/Sub - so reading the
  // selection alone gave a card with one leg in Romanian and one in English.
  // `side` is the same proposition after normalisation, and the line beside it
  // is what the leg was quoted at.
  function middleWindow(m) {
    const legs = m.legs || [];
    if (legs.length < 2) return '—';
    const over = legs.find((l) => l.side === 'over');
    const under = legs.find((l) => l.side === 'under');
    const low = over || legs[0];
    const high = under || legs[1];
    const line = (l) => (l.handicap === undefined || l.handicap === null ? '—' : String(l.handicap));
    return `${String(low.side || '').toUpperCase()} ${line(low)} → ${String(high.side || '').toUpperCase()} ${line(high)}`;
  }

  function middleCard(m) {
    // Middles are informational: the engine does not yet re-quote their payoff
    // model, so no verification object is ever stamped on them. A null
    // verification is 'unverified', not 'unconfirmed'.
    const split = plan(m);
    const totalStake = rescale(m, 'totalStake', split);
    const profit = m.arb ? rescale(m, 'guaranteedProfit', split) : null;
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
            ${familyChip(m)}
            ${m.arb ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[var(--edge-green)] text-white shrink-0" title="${escapeHtml(t('surebetHint'))}">${escapeHtml(t('surebet'))}</span>` : ''}
            <a class="text-sm font-semibold text-[var(--edge-textBright)] truncate min-w-0 hover:underline" href="${escapeHtml(eventLink(m))}">${escapeHtml(namesOf(m))}${liveBadge(m)}</a>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="status-dot ${dotCls}" aria-hidden="true"${explain}></span>
            <span class="text-xs ${textCls}"${explain}>${escapeHtml(badgeText)}</span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div class="min-w-0 col-span-full">
            <div class="text-xs text-[var(--edge-textMuted)]">Window · gap ${escapeHtml(String(m.gap === undefined ? '—' : m.gap))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)] truncate">${escapeHtml(middleWindow(m))}</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('margin'))}</div>
            <div class="text-sm font-semibold ${tone(m.marginPercent)}">${escapeHtml(signed(m.marginPercent))}%</div>
            <div class="statbar">${meter(m.marginPercent, 'middle')}</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-[var(--edge-textMuted)]">ROI</div>
            <div class="text-sm font-semibold ${tone(m.roiPercent)}">${escapeHtml(signed(m.roiPercent))}%</div>
            <div class="statbar">${meter(m.roiPercent, 'middle')}</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-[var(--edge-textMuted)]">Risk</div>
            <div class="text-sm font-semibold ${m.arb ? 'text-[var(--edge-green)]' : riskTone}">${m.arb ? escapeHtml(pct(0)) : escapeHtml(pct(m.riskPercent))}</div>
            <div class="statbar">${meter(m.arb ? 0 : m.riskPercent, 'lowhold')}</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-[var(--edge-textMuted)]">${escapeHtml(t('stake'))}</div>
            <div class="text-sm font-semibold text-[var(--edge-textBright)] truncate">${escapeHtml(money(totalStake))} ${verifyBadge(m)}</div>
          </div>
        </div>
        ${m.arb && profit !== null ? `
        <div class="flex items-center justify-between gap-2 mb-3 px-3 py-2 rounded-lg bg-[var(--edge-green)]/10 border border-[var(--edge-green)]/25">
          <span class="text-xs text-[var(--edge-green)] font-semibold">${escapeHtml(t('guaranteedProfit'))}</span>
          <span class="text-sm font-bold text-[var(--edge-green)]">${escapeHtml(money(profit))}</span>
        </div>` : ''}
        <div class="space-y-1 pt-3 border-t border-[var(--edge-border)]">
          ${(m.legs || []).map((leg, i) => legRow(leg, stakeOf(leg, split, i))).join('')}
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
        <td class="px-3 py-2 text-right">
          <div class="flex items-center justify-end gap-2">
            <span class="w-16 shrink-0">${meter(e.evPercent, 'ev')}</span>
            <span class="text-[var(--edge-green)] font-semibold">${escapeHtml(signed(e.evPercent))}%</span>
          </div>
        </td>
        <td class="px-3 py-2 text-right text-[var(--edge-textBright)]">${escapeHtml(legStake === undefined ? money(e.totalStake) : stakeExact(legStake))}</td>
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
      <td class="px-3 py-2 text-right">
        <div class="flex items-center justify-end gap-2">
          <span class="w-16 shrink-0">${meter(h.holdPercent, 'lowhold')}</span>
          <span class="font-semibold text-[var(--edge-amber)]">${escapeHtml(signed(h.holdPercent))}%</span>
        </div>
      </td>
    </tr>`).join('') + moreRow(rows.length, shown, 5);
  }

  // ---- data ----------------------------------------------------------------

  // The market a signal is actually in. Middles get this from their own
  // legs: the pairing bucket spans every line of a family, so the market that
  // opened the bucket is not necessarily the market these two legs came from.
  function familyOf(row) {
    return row.family || String(row.marketKey || '').split('_').slice(0, 2).join('_');
  }

  function familyChip(row) {
    const family = familyOf(row);
    return family
      ? `<span class="chip chip--${classOf(row)}">${escapeHtml(MONO(family))}</span>`
      : '<span class="chip">\u2014</span>';
  }

  // A bar that fills to the row's own edge, on a scale shared by every row
  // so the lengths are comparable down the column.
  //
  // METER_FULL is 20 because that is where a margin, an ROI or a risk figure
  // stops being interesting; anything past it saturates. Sharing one scale is
  // the whole point - ROI and risk are both percentages of the same bankroll,
  // and asking which of them is bigger is the decision the card is for.
  function meter(value, kind) {
    const pctOf = Math.max(0, Math.min(100, (Math.abs(Number(value || 0)) / METER_FULL) * 100));
    return `<div class="meter"><div class="meter__fill meter__fill--${kind}"
      style="width:${pctOf.toFixed(1)}%"></div></div>`;
  }

  function setKpi(el, text) {
    if (!el || el.textContent === text) return;
    el.textContent = text;
    el.classList.remove('bump');
    // Force a reflow so the animation restarts on a repeat value.
    void el.offsetWidth;
    el.classList.add('bump');
  }

  // Which books are currently in the scan. Provenance, not a headline:
  // an arbitrage is only as good as the independence of its two legs, and
  // this is where that is visible at a glance.
  // How old the numbers are, said plainly rather than implied by a timestamp
  // in a tooltip. A four-minute-old book must not read like a live one.
  function ageOf(scan) {
    const stamp = scan.scrapedAt || scan.scanStartedAt;
    const then = stamp ? new Date(stamp).getTime() : NaN;
    if (!Number.isFinite(then)) return 'capture time unknown';
    const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (minutes < 1) return 'captured just now';
    if (minutes < 60) return 'captured ' + minutes + 'm ago';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return 'captured ' + hours + 'h ago';
    return 'captured ' + Math.round(hours / 24) + 'd ago';
  }
  function renderFeedline(scan) {
    const el = $('feedline');
    if (!el) return;
    const books = (scan.sources || []).map((s) => s.sourceId || s.id).filter(Boolean);
    el.innerHTML = books.length
      ? books.map((b) => `<span>${escapeHtml(b)}</span>`).join('')
      : '<span>no books in this scan</span>';

    // Provenance sits next to the books rather than in a tooltip: the
    // reader deciding whether to act needs the age of the data and its
    // breadth in the same glance.
    const sub = $('masthead-sub');
    if (sub) {
      const scope = books.length + ' books \u00b7 '
        + Number(scan.eventCount || 0).toLocaleString('en-GB') + ' events';
      sub.textContent = books.length
        ? ageOf(scan) + ' \u00b7 ' + scope
        : ageOf(scan);
    }
  }

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
    renderFeedline(scan);
    $('f-count').textContent = count(
      shown.opps.length + shown.middles.length + shown.evs.length + shown.holds.length,
    );

    const bankroll = Number(state.bankroll) > 0 ? state.bankroll : 0;
    if ($('k-bankroll')) $('k-bankroll').textContent = money(bankroll);
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
  //
  // All three sidebar controls travel, read at click time rather than held in
  // the markup, because `state` is whatever the sidebar holds when the button
  // is pressed. Each is omitted when it is off, so an empty selection asks the
  // route the same question the tables are answering -- and the route reads an
  // absent parameter as "no filter", which is what an empty box means here.
  //
  // `sport` was the odd one out until this was measured: the tables drew one
  // sport while the download held every one of them, the same disagreement
  // `syncExportSport` fixes on the scanner page. `q` and `confirmed` had no
  // parameter to travel on at all; they do now, and `matchesQ` /
  // `isConfirmed` in src/scan-service.mjs are copied from `visible()` above so
  // the two answers stay one answer.
  $('btn-export').addEventListener('click', () => {
    const params = new URLSearchParams();
    if (state.sport) params.set('sport', state.sport);
    // Already lowercased and trimmed by the input listener, and sent that way
    // on purpose: the route lowercases what it receives, so the request reads
    // the same in a log line as it does in the control.
    if (state.q) params.set('q', state.q);
    if (state.confirmedOnly) params.set('confirmed', '1');
    const query = params.toString();
    window.location.href = query ? `/api/scan/export.csv?${query}` : '/api/scan/export.csv';
  });

  // Signal class. The page keeps every section mounted and empties the ones
  // the selection rules out, so switching back restores the full context
  // without a refetch.
  document.querySelectorAll('.segmented button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.signal = btn.dataset.signal || 'all';
      document.querySelectorAll('.segmented button').forEach((other) => {
        other.setAttribute('aria-pressed', String(other === btn));
      });
      render();
    });
  });

  const sortEl = $('f-sort');
  if (sortEl) {
    sortEl.addEventListener('change', (e) => {
      state.sort = e.target.value;
      render();
    });
  }

  const bankrollEl = $('f-bankroll');
  if (bankrollEl) {
    bankrollEl.addEventListener('input', (e) => {
      const value = Number(e.target.value);
      if (Number.isFinite(value) && value > 0) state.bankroll = value;
      render();
    });
  }

  refresh();

  let pending = null;
  arbiterSse.connect((type) => {
    if (type !== 'scan-update') return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(refresh, 600);
  });
})();

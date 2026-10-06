import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { UpstreamError, ValidationError } from '../shared/errors.mjs';
import { limitReached, maxEvents, serializedMaxEvents } from '../shared/event-limit.mjs';
import { readBoundedJson, DEFAULT_MAX_BODY_BYTES } from '../shared/bounded-json.mjs';

/**
 * Favbet (Romania) — ErlyLine/Betinvest JSON-RPC gateway.
 *
 * The sports feed is not the Plex SPA; it is the `frontend_api2` lineout
 * gateway. We post JSON-RPC 2.0 requests to
 * `https://www.favbet.ro/service/lineout/frontend_api2/` with the `by`
 * param as the filter object:
 *
 *   frontend/event/get   by:{lang:'ro',service_id:0,sport_id:1,limit:N}
 *                        → result is an ARRAY of events (event_dt epoch s,
 *                          participants[], category_name, tournament_name,
 *                          event_status_type, market_count)
 *   frontend/market/get  by:{lang:'ro',service_id:0,event_id:<number>}
 *                        → result keyed by event_id; markets carry
 *                          market_template_id (1 = "1 X 2"),
 *                          market_suspend and outcomes with outcome_tag
 *                          ("1"/"X"/"2") and outcome_coef (decimal).
 *
 * A `server_time` key inside `by` is rejected (-32600), and the gateway
 * answers HTML 500 to any non-number event_id shape, so keep the payloads
 * exact. Origin/Referer must be first-party or the gateway HTML 500s.
 *
 * THE LINE LIVES IN THE OUTCOME NAME, NOT IN THE MARKET NAME
 *
 * `frontend/market/get` returns every market an event carries, keyed by
 * event_id, and two of those templates are plain football contracts that this
 * reader used to drop on the floor:
 *
 *   template 50   "Peste / Sub"   the goals total     1,334 markets / 120 events
 *   template 190  "Handicap"      the goals handicap   1,280 markets / 120 events
 *
 * Both name their threshold in the OUTCOME, not in the market: the market is
 * called "Peste / Sub" with no number at all, and its legs read "peste (2.5)"
 * and "sub (2.5)". `extractNumber(market_name)` is therefore null for every
 * one of them, and the totals branch dropped on `if (line === null) return
 * null` before pricing anything. The handicap branch dropped the same way.
 * Reading the line out of the leg text is the whole fix.
 *
 * `outcome_tag` is 1/2 on the totals and there it is NOT a side: the total's
 * "sides" are "peste" and "sub", so a tag can only ever hold 1 or 2 whichever
 * way round the legs are, and the totals branch was looking for over/under in
 * it. The words are in `outcome_name` and that is what makes the legs resolve.
 *
 * On the handicap the tag LOOKS like the side and reading it there is a trap
 * that fails silently. It is populated on 15.6% of full-time rows, and the
 * split is not random: it is there on the whole lines and null on the half
 * lines, so a tag-keyed reader accepts exactly the push markets this adapter
 * refuses and drops every half line. Measured on 4,300 rows. The side is read
 * from the club name inside each leg's own text instead — 4,294 of 4,294 — with
 * the tag kept only as a check that may not contradict it. See
 * `handicapLegSide`.
 */

/** template 50 — "Peste / Sub", the two-way goals total. */
const GOALS_TOTAL_TEMPLATE = 50;
/** template 190 — "Handicap", the two-way goals handicap. */
const GOALS_HANDICAP_TEMPLATE = 190;
/** template 1104 — full-time match corners total; team-corners use template 914. */
const CORNERS_TOTAL_TEMPLATE = 1104;
export default class FavbetScraper extends ProviderContract {
  id = 'favbet';
  name = 'Favbet';
  sourceIds = ['favbet'];
  // Four offset pages require more market requests than the original single
  // page; keep the run bounded but allow the verified inventory to finish.
  timeoutMs = 120_000;
  maxAttempts = 2;

  constructor(opts = {}) {
    super({ baseUrl: 'https://www.favbet.ro', locale: 'ro-RO', ...opts });
    // The public event endpoint returned 811 rows when asked for 1,000; keep
    // the default market fan-out bounded while covering more future matches.
    this.maxEvents = maxEvents(opts.maxEvents, 120, 1000);
    this.rpcUrl = 'https://www.favbet.ro/service/lineout/frontend_api2/';
    this.lang = 'ro';
    // event/get answers with ~14 MB, so the shared 16 MB ceiling leaves headroom
    // without letting a runaway response exhaust the process.
    this.maxBodyBytes = Number(opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  }

  async rpc(method, params, { signal } = {}) {
    const resp = await this._httpFetch(this.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.favbet.ro',
        'Referer': 'https://www.favbet.ro/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal,
      // A redirect to a challenge or login page must fail loudly rather than be
      // followed into a body that looks like a JSON-RPC result.
      redirect: 'error',
    });
    if (!resp.ok) {
      throw new UpstreamError(`favbet ${method} HTTP ${resp.status}`, { status: resp.status });
    }
    // Bounded and streaming, like every other adapter: `resp.text()` buffers the
    // whole body with no ceiling, and this endpoint answers with ~14 MB.
    const payload = await readBoundedJson(resp, `favbet ${method}`, signal, this.maxBodyBytes);
    if (payload && payload.error) {
      throw new UpstreamError(`favbet ${method} error ${JSON.stringify(payload.error).slice(0, 200)}`);
    }
    return payload?.result;
  }

  async fetchRaw({ signal } = {}) {
    // The gateway exposes numeric offset pagination. All-mode walks the four
    // observed pages (240 + 240 + 240 + 92 rows); bounded runs use one page.
    const pageSize = 240;
    const pages = this.maxEvents === Infinity ? 4 : 1;
    const eventMap = new Map();
    for (let page = 0; page < pages; page += 1) {
      const pageEvents = await this.rpc('frontend/event/get', {
        by: {
          lang: this.lang,
          service_id: 0,
          sport_id: 1,
          limit: this.maxEvents === Infinity ? pageSize : this.maxEvents * 2,
          ...(this.maxEvents === Infinity ? { offset: page * pageSize } : {}),
        },
      }, { signal });
      if (!Array.isArray(pageEvents)) {
        throw new UpstreamError('favbet event/get returned an invalid page');
      }
      for (const event of pageEvents) {
        const id = String(event?.event_id ?? '');
        if (id) eventMap.set(id, event);
      }
      if (this.maxEvents === Infinity && pageEvents.length < pageSize) break;
    }
    const events = [...eventMap.values()];
    if (events.length === 0) throw new UpstreamError('favbet event/get returned no events');

    // Step 2: per-event 1X2 market (template 1). Fetch concurrently, capped.
    const results = [];
    const queue = events.slice();
    const workers = Array.from({ length: 12 }, async () => {
      while (queue.length) {
        const ev = queue.shift();
        try {
          const markets = await this.rpc('frontend/market/get', {
            by: { lang: this.lang, service_id: 0, event_id: Number(ev.event_id) },
          }, { signal });
          results.push({ event: ev, markets: markets || {} });
        } catch (err) {
          if (err instanceof UpstreamError) {
            results.push({ event: ev, markets: {}, error: err.message });
          } else {
            throw err;
          }
        }
      }
    });
    await Promise.all(workers);

    // Per-event market failures are tolerated so one dead event does not lose
    // the rest of the page — but if every one of them failed, the run collected
    // no prices at all, and reporting that as a successful empty scrape makes a
    // total outage indistinguishable from a day with no matches.
    const marketFailures = results.filter((r) => r.error).length;
    if (results.length > 0 && marketFailures === results.length) {
      throw new UpstreamError(
        `favbet: all ${marketFailures} market/get requests failed (${results[0].error})`,
      );
    }

    return {
      events: new Map(events.map((e) => [String(e.event_id), e])),
      markets: results,
      sourceUrl: this.rpcUrl,
      observedAt: new Date().toISOString(),
      transport: 'favbet-erlyline-jsonrpc',
    };
  }

  normalize(raw) {
    this._lastSourceUrl = raw.sourceUrl;
    this._lastObservedAt = raw.observedAt;
    if (!raw.events || typeof raw.events !== 'object' || raw.events.size === 0) {
      throw new ValidationError(`${this.id}: no favbet events`, { field: 'events' });
    }
    if (!Array.isArray(raw.markets) || raw.markets.length === 0) {
      throw new ValidationError(`${this.id}: no favbet market payloads`, { field: 'markets' });
    }
    return raw;
  }

  extractEvents(raw) {
    const out = [];
    const nowMs = Date.now();
    for (const item of raw.markets) {
      const ev = item?.event;
      if (!ev || item.error) continue;
      const eventId = String(ev.event_id);
      const home = ev.participants?.find((p) => p.participant_number === 1)?.participant_name || '';
      const away = ev.participants?.find((p) => p.participant_number === 2)?.participant_name || '';
      if (!home || !away) continue;
      const kickoffMs = Number(ev.event_dt) * 1000;
      if (!Number.isFinite(kickoffMs) || kickoffMs <= nowMs) continue;
      if (ev.event_status_type && ev.event_status_type !== 'notstarted') continue;

      // Market result may be keyed by event_id or a bare array.
      const mr = item.markets || {};
      const list = Array.isArray(mr) ? mr : Object.values(mr).flatMap((v) => (Array.isArray(v) ? v : [v]));
      const priced = list.filter((m) => m.market_suspend === false);
      const matchOdds = priced.find((m) => Number(m.market_template_id) === 1);
      if (!matchOdds) continue;
      // A fixture quoted as an aggregate over N matches settles on the tie, not
      // on the match, and the provider says so in the 1X2's own outcome text.
      // Withholding the event is the fail-closed reading: the alternative is a
      // full-time 1X2 that settles on something else, which is the same defect
      // as publishing a spread as a result.
      if (isMultiMatchTie(matchOdds)) continue;
      const byKind = new Map();
      for (const s of matchOdds.outcomes || []) {
        const odds = Number(s.outcome_coef);
        if (!Number.isFinite(odds) || odds <= 1) continue;
        const kind = String(s.outcome_tag || s.outcome_short_name).toUpperCase();
        if (['1', 'X', '2'].includes(kind)) byKind.set(kind, s);
      }
      if (!byKind.has('1') || !byKind.has('X') || !byKind.has('2')) continue;

      // The two goals families, read from the line in each leg's own text.
      // They are handled before the generic mapper on purpose: that mapper
      // resolves a family from the market NAME, and both templates are named
      // without a number, so it would classify neither.
      // The handicap needs the two clubs' normalized names to tell its legs
      // apart, because the provider's own side tag is empty on 84% of rows.
      const homeKey = normalizeTeamName(home);
      const awayKey = normalizeTeamName(away);
      const measuredMarkets = [];
      for (const m of priced) {
        const template = Number(m.market_template_id);
        if (template === GOALS_TOTAL_TEMPLATE) {
          const mapped = goalsTotalMarket(m);
          if (mapped) measuredMarkets.push(mapped);
        } else if (template === GOALS_HANDICAP_TEMPLATE) {
          const mapped = goalsHandicapMarket(m, homeKey, awayKey);
          if (mapped) measuredMarkets.push(mapped);
        } else if (template === CORNERS_TOTAL_TEMPLATE) {
          const mapped = cornersTotalMarket(m);
          if (mapped) measuredMarkets.push(mapped);
        }
      }

      // Surface additional markets (totals, BTTS, double chance, handicaps)
      // beyond template 1, mirroring the multi-market pattern of other books.
      const additionalMarkets = [];
      for (const m of priced) {
        if (String(m.market_id) === String(matchOdds.market_id)) continue;
        const mapped = mapFavbetMarket(m);
        if (mapped) additionalMarkets.push(mapped);
      }

      const league = ev.tournament_name || ev.category_name || 'Unknown';
      const kickoff = new Date(kickoffMs).toISOString();
      const directUrl = `https://www.favbet.ro/ro/sports/event/${ev.tournament_id || 'fotbal'}/${eventId}/`;
      out.push({
        id: eventId,
        sourceId: 'favbet',
        sourceUrl: directUrl,
        observedAt: this._lastObservedAt,
        sport: 'Football',
        league,
        kickoff,
        homeTeam: home,
        awayTeam: away,
        eventKey: ['football', normalizeTeamName(league), kickoff, normalizeTeamName(home), normalizeTeamName(away)].join('|'),
        markets: [{
          key: 'MATCH_ODDS',
          name: matchOdds.market_name || 'Match Odds',
          selections: ['1', 'X', '2'].map((kind) => {
            const s = byKind.get(kind);
            return { id: String(s.outcome_id), name: kind, odds: Number(s.outcome_coef), group: 'Main' };
          }),
        }, ...measuredMarkets, ...additionalMarkets],
      });
      if (limitReached(out.length, this.maxEvents)) break;
    }
    return out;
  }

  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      sourceUrl: raw?.sourceUrl || this.rpcUrl,
      transport: 'favbet-erlyline-jsonrpc',
      scrapeLimits: { maxEvents: serializedMaxEvents(this.maxEvents) },
    };
  }
}

/**
 * Best-effort mapping of a non-1X2 Favbet market to a canonical market key.
 * Outcome sides are resolved from each outcome's tag/short name. Markets whose
 * outcome sides cannot be determined are skipped rather than emitted wrong.
 */
function mapFavbetMarket(market) {
  if (!market || !Array.isArray(market.outcomes)) return null;
  const name = String(market.market_name || market.market_type_name || '').trim();
  const valid = market.outcomes
    .filter((s) => Number.isFinite(Number(s.outcome_coef)) && Number(s.outcome_coef) > 1)
    .map((s) => ({
      id: String(s.outcome_id),
      tag: String(s.outcome_tag ?? s.outcome_short_name ?? '').toLowerCase(),
      // `outcome_tag` is a provider-internal index, not a side name, and it is
      // NOT consistent across a market's windows: on the live feed template 779
      // carried tag "1"/"2" for the full-time and first-half rows but null for
      // the second-half row, where the side then came from the short name. So a
      // matcher written against `tag` silently matched only whichever rows
      // happened to omit it — favbet's 1H and full-time BTTS were never emitted
      // at all, and the only BTTS that reached the engine was the second-half
      // one, stamped `fulltime` by the name-derived period. That is what fed the
      // 174 fabricated BTTS arbitrages. `outcome_name` is the provider's own
      // text and is stable ("Da"/"Nu"), so the yes/no match uses it.
      side: String(s.outcome_name ?? s.outcome_short_name ?? '').trim().toLowerCase(),
      odds: Number(s.outcome_coef),
    }));

  // A sub-settlement market must say so. `period` is what the engine reads to
  // keep a first-half price out of the full-time bucket, and an absent period
  // is treated as full-time — so a 1H market published without one was paired
  // against other books' full-time legs and reported as arbitrage.
  //
  // The settlement window is provider metadata, not part of the market name.
  // Favbet publishes the SAME name at every window — event 43441222 carried
  // "Ambele Marcheaza" and "Șansă dublă" three times each, differing only in
  // `result_type_name` (Timp Regulamentar / Prima repriză / A doua repriză).
  // Deriving the period from the name alone stamped `fulltime` on all of them,
  // so the three collapsed into one bucket and the engine kept the best odds
  // per side: Yes 5.25 (first half) against No 1.72 (full time), two different
  // settlement windows paired as one contract. Measured on the live feed,
  // that fabricated 174 BTTS arbitrages against other books at a ~25% median
  // ROI. A name cannot disambiguate a name, so the provider field wins, and
  // the name is only consulted when the feed does not declare one.
  //
  // The tokens are the canonical `fulltime` / `half1` / `half2` that
  // canonicalPeriod() buckets on. Note `half1`, not `firsthalf`: the contracts
  // layer normalizes the Romanian source text itself, but a bare `firsthalf`
  // matches none of its patterns and would silently fall back to full-time.
  // Shared with the goals families above, so there is one answer to what a
  // window is rather than two that can drift apart.
  const declaredPeriod = favbetPeriod(market);

  const isFirstHalf = (label) => /repriza\s*1|1st\s*half|prima\s*repriza/i.test(label);
  const periodFor = (label) => declaredPeriod
    ?? (isFirstHalf(label) ? 'half1' : 'fulltime');

  // The contracts layer resolves a family from the EXACT key (`BOTH_TEAMS_SCORE`,
  // `DOUBLE_CHANCE`, ...) and then buckets on `period` via
  // bucketKeyForContract(eventKey, family, period, line). So the window is
  // carried by `period` alone and the key stays the bare family name. A `_1H` /
  // `_2H` suffix would look more explicit but makes the key unresolvable —
  // resolveContract({ key: 'BOTH_TEAMS_SCORE_1H' }) returns null and the market
  // silently leaves arbitrage entirely. Verified against the resolver.
  const period = periodFor(name);

  /**
   * True only for the unqualified "both teams score" market.
   *
   * Favbet's feed carries several markets whose names all begin "Ambele echipe"
   * but which settle on different events: a goal threshold ("mai mult de 1.5
   * goluri"), a per-half requirement ("în ambele reprize"), or something
   * unrelated to scoring entirely ("vor executa câte un penalty"). Only the
   * bare form is the plain BTTS contract that other books also price, so only
   * the bare form may share the BTTS engine bucket with them.
   *
   * Qualifiers detected here: a numeric goal line, "în ambele"/"in ambele"
   * (both halves), "penalty"/"penalt", and the first-half markers already used
   * by `isFirstHalf`.
   */
  const isPlainBothTeamsScore = (label) =>
    !/\d/.test(label)
    && !/ambele\s+(?:reprize|in\s+ambele)/i.test(label)
    && !/penalty|penalt/i.test(label);

  if (period === 'half1' && /1x2|rezultat|winner|final/i.test(name)) {
    const byKind = new Map(valid.map((s) => [s.tag.toUpperCase(), s]));
    if (['1', 'X', '2'].every((k) => byKind.has(k))) {
      // Bare key for the same reason as the families below: the resolver matches
      // `MATCH_ODDS` exactly and buckets this apart on `period: 'half1'`.
      return { key: 'MATCH_ODDS', name, period, selections: ['1', 'X', '2'].map((k) => ({ id: byKind.get(k).id, name: k, odds: byKind.get(k).odds, group: 'Main' })) };
    }
  }
  if (/fara\s*egal|draw\s*no\s*bet|dnb/i.test(name)) {
    const byKind = new Map(valid.map((s) => [s.tag.toUpperCase(), s]));
    if (['1', '2'].every((k) => byKind.has(k))) {
      return { key: 'DRAW_NO_BET', name, period, selections: ['1', '2'].map((k) => ({ id: byKind.get(k).id, name: k, odds: byKind.get(k).odds, group: 'Main' })) };
    }
  }
  const line = extractNumber(name);
  if (/peste|sub|over|under|total/i.test(name)) {
    if (line === null || valid.length < 2) return null;
    const over = valid.find((s) => /^(over|peste)\b/i.test(s.tag));
    const under = valid.find((s) => /^(under|sub)\b/i.test(s.tag));
    if (!over || !under) return null;
    return { key: `OVER_UNDER_${String(line).replace('.', '_')}`, name, period, selections: [
      { id: over.id, name: 'Over', odds: over.odds, handicap: line, group: 'Main' },
      { id: under.id, name: 'Under', odds: under.odds, handicap: line, group: 'Main' },
    ] };
  }
  if (/ambele.*(?:[iî]nscriu|marcheaz|echipe)|both teams|btts|gg[\s/]*ng/iu.test(name)) {
    const yes = valid.find((s) => /^(yes|da|gg)$/.test(s.side) || /^(yes|da|gg)\b/i.test(s.tag));
    const no = valid.find((s) => /^(no|nu|ng)$/.test(s.side) || /^(no|nu|ng)\b/i.test(s.tag));
    if (!yes || !no) return null;
    // Only the unqualified market is plain BTTS. This branch matches a whole
    // family of "Ambele ..." markets that are NOT plain BTTS, and they settle
    // differently from one another:
    //
    //   "Ambele Marcheaza"                              both teams score, once  ✔
    //   "Ambele echipe marchează mai mult de 1.5 goluri" both score OVER 1.5    ✘
    //   "Ambele echipe să înscrie în ambele reprize"    both score in BOTH halves ✘
    //   "Ambele echipe vor executa câte un penalty"      both teams take a penalty ✘
    //
    // Keying them all `BOTH_TEAMS_SCORE` put them in one engine bucket, so a
    // price from one was paired against another book's plain BTTS leg and
    // reported as arbitrage. On the 2026-09-28 scan that produced 126
    // "live-confirmed" BTTS opportunities; tracing every leg back to its exact
    // selectionId showed 126 of the 128 legs came from a qualified Favbet
    // market (94 over-1.5, 23 under-1.5, 8 both-halves, 1 penalty) and only
    // 2 were genuine plain BTTS. The headline 92% ROI was a both-halves price
    // at 8.40 against another book's plain BTTS "No".
    //
    // A qualifier means the contract differs, so it must not resolve to the
    // plain BTTS family at all. Returning null keeps it out of the comparison
    // rather than inventing a family for it.
    if (!isPlainBothTeamsScore(name)) return null;
    return { key: 'BOTH_TEAMS_SCORE', name, period, selections: [
      { id: yes.id, name: 'Yes', odds: yes.odds, group: 'Main' },
      { id: no.id, name: 'No', odds: no.odds, group: 'Main' },
    ] };
  }
  if (/dubl|double chance/i.test(name)) {
    // Same contract-collision rule as plain BTTS: only the unqualified match
    // double chance is the plain contract, and a qualified one settles on
    // something else entirely. Favbet's feed carries several, all matching the
    // same "dubl" name test:
    //
    //   "Șansă dublă"                double chance on the 1X2        ✔
    //   "Șansă Dublă. Cornere"       double chance on corners        ✘
    //   "Șansă dublă cartonașe"      double chance on cards          ✘
    //
    // All three landed on the DOUBLE_CHANCE key, so a corners or cards price
    // could stand in for a match double chance. A qualified market settles on a
    // different event, so it must not share the family — withhold it rather
    // than invent a family for it. (The engine marks DOUBLE_CHANCE
    // arbEligible: false, so this cannot produce arbitrage today, but it is the
    // same bug class as the BTTS collision and must not be left as a landmine.)
    //
    // The check is the market's own text, matching the BTTS guard: any word
    // that names a non-result target, plus a numeric line, disqualifies it.
    const isPlainDoubleChance = (label) =>
      !/\d/.test(label)
      && !/cornere|corners|cartona|cards?|yellow|red|goluri|goals?|over|under|peste|sub/i.test(label);
    if (!isPlainDoubleChance(name)) return null;
    const combined = valid.filter((s) => /^(1x|x2|12)$/.test(s.tag));
    if (combined.length !== 3) return null;
    return { key: 'DOUBLE_CHANCE', name, period, selections: combined.map((s) => ({ id: s.id, name: s.tag.toUpperCase(), odds: s.odds, group: 'Main' })) };
  }
  if (/handicap/i.test(name)) {
    if (line === null) return null;
    const threeWay = valid.some((s) => /^(x|draw|egal)$/.test(s.tag));
    const key = `${threeWay ? 'HANDICAP' : 'AH'}_${String(Math.abs(line)).replace('.', '_')}`;
    const mapped = valid.map((s) => {
      let kind;
      if (/^(x|draw|egal)$/.test(s.tag)) kind = 'X';
      else if (/^(1|home)$/.test(s.tag)) kind = '1';
      else if (/^(2|away)$/.test(s.tag)) kind = '2';
      else return null;
      return { id: s.id, name: kind, odds: s.odds, group: 'Main' };
    });
    const required = threeWay ? ['1', 'X', '2'] : ['1', '2'];
    const picked = {};
    for (const m of mapped) if (required.includes(m.name) && !picked[m.name]) picked[m.name] = m;
    if (!required.every((k) => picked[k])) return null;
    return { key, name, period, selections: required.map((k) => ({ ...picked[k], handicap: line })) };
  }
  // Corners Over/Under
  if (/cornere|corners|corner/i.test(name)) {
    if (line === null || valid.length < 2) return null;
    const over = valid.find((s) => /^(over|peste)\b/i.test(s.tag));
    const under = valid.find((s) => /^(under|sub)\b/i.test(s.tag));
    if (!over || !under) return null;
    return { key: `CORNERS_OVER_UNDER_${String(line).replace('.', '_')}`, name, period, selections: [
      { id: over.id, name: 'Over', odds: over.odds, handicap: line, group: 'Main' },
      { id: under.id, name: 'Under', odds: under.odds, handicap: line, group: 'Main' },
    ] };
  }
  // Cards Over/Under
  if (/cartonase|cards|yellow|red/i.test(name)) {
    if (line === null || valid.length < 2) return null;
    const over = valid.find((s) => /^(over|peste)\b/i.test(s.tag));
    const under = valid.find((s) => /^(under|sub)\b/i.test(s.tag));
    if (!over || !under) return null;
    return { key: `CARDS_OVER_UNDER_${String(line).replace('.', '_')}`, name, period, selections: [
      { id: over.id, name: 'Over', odds: over.odds, handicap: line, group: 'Main' },
      { id: under.id, name: 'Under', odds: under.odds, handicap: line, group: 'Main' },
    ] };
  }
  return null;
}

function extractNumber(text) {
  const match = String(text || '').match(/[-+]?\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(',', '.')) : null;
}

/**
 * The LAST number in a leg's own text, which is the threshold that leg is
 * quoted at: "peste (2.5)" is 2.5, and "Goluri Gazde (8 Meciuri) (-3.5)" is
 * -3.5 rather than 8. The first number would be the match count on an
 * aggregate market, so the last one is the only reading that can be the line.
 */
function legLine(text) {
  const all = String(text || '').match(/[-+]?\d+(?:[.,]\d+)?/g);
  if (!all) return null;
  return Number(all[all.length - 1].replace(',', '.'));
}

/**
 * The line in goals, or null when it is not on the half.
 *
 * A whole line pushes both legs and a quarter line pushes half of one, so
 * neither pair is exhaustive and an inverse sum below 1 would not be a
 * surebet. Favbet quotes plenty of both — of 20 distinct total lines only 10
 * are on the half, and of 27 handicap lines only 12 — so this is doing real
 * work rather than restating an observation.
 *
 * THE UNIT IS GOALS HERE, NOT HUNDREDTHS. Favbet writes the threshold into the
 * leg text as "2.5", so the test is whether the value is a half-integer.
 * Another feed encodes the same line as 250 hundredths, and a guard written
 * for that one reads 2.5 as "2.5 mod 50, which is not 0" and refuses every
 * market on the board — which is what this did on the first run, publishing
 * none of the 347 it should have. The modulus below is only ever asked whether
 * a number is integral, never compared against a feed-specific constant.
 *
 * The absolute value matters for the same reason as in every other half-line
 * guard here: JavaScript's `%` keeps the sign of the dividend, so a negative
 * half line has to be tested on its magnitude or it is rejected while its
 * positive twin is accepted.
 */
function halfGoalLine(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  // A half line is a non-integer whose double is an integer: 2.5 -> 5, 3 -> 6
  // (integral, and rejected below), 1.25 -> 2.5 (not integral, rejected).
  if (!Number.isInteger(abs * 2)) return null;
  if (Number.isInteger(abs)) return null;
  return n;
}

/** The line with its sign made explicit: "-1.5" / "1.5". */
function signedLine(line) {
  return line < 0 ? String(line) : `+${line}`;
}

/** A market's odds above 1. Anything else is not a price. */
function isPriced(outcome) {
  const odds = Number(outcome?.outcome_coef);
  return Number.isFinite(odds) && odds > 1;
}

/**
 * The settlement window, as the canonical period.
 *
 * Module level so the families below and `mapFavbetMarket` cannot disagree
 * about what a window is. An unrecognised window returns null rather than
 * full-time: a market that will not say when it settles must not be filed as
 * a full-time price, which is how a first-half quote ends up paired against
 * another book's full-time legs.
 */
function favbetPeriod(market) {
  const label = String(market?.result_type_name || market?.result_type_short_name || '').trim();
  if (!label) return null;
  if (/prima\s*repriz|\brepriz\s*1|1st\s*half|first\s*half|\b1\b\s*repriz/i.test(label)) return 'half1';
  if (/a\s*doua\s*repriz|\brepriz\s*2|2nd\s*half|second\s*half|\b2\b\s*repriz/i.test(label)) return 'half2';
  if (/timp\s*regulamentar|\btr\b|full\s*time|fulltime|match\s*time/i.test(label)) return 'fulltime';
  return null;
}

/**
 * True when the event is a multi-match tie rather than one match.
 *
 * Favbet quotes some fixtures as an aggregate over N matches, and says so in
 * its own outcome text: "Goluri Gazde (8 Meciuri)". An eight-match total is not
 * a match total and an eight-match handicap is not a match handicap, so the
 * whole event is withheld rather than published under a contract that settles
 * on something else. The same text appears on the event's own 1X2, which makes
 * this a reading of the provider's declaration and not a guess: 1 of 120
 * sampled events.
 */
function isMultiMatchTie(marketOdds) {
  return (marketOdds?.outcomes || []).some((o) =>
    /\d+\s*meciuri?\b/i.test(String(o?.outcome_name ?? o?.outcome_short_name ?? '')));
}

/**
 * A goals total, or null when this market is not one we may publish.
 *
 * "peste" is Over and "sub" is Under, proved by within-event monotonicity
 * rather than by translation: a threshold that rises cannot make the Over side
 * shorter, so the Over price must rise with the line. Measured 2026-09-29 over
 * 120 events and 1,334 template-50 markets, grouped per event AND per
 * settlement window, the Over price rose on 235 of 235 consecutive steps and
 * the Under price fell on 235 of 235 — and again on the exact 347 markets that
 * survive the filters below, so the filter cannot have decided the direction.
 * The ladder on one event, full time:
 *
 *     0.5 peste 1.02 / sub 11.00      3.5 peste 2.85 / sub 1.45
 *     1.5 peste 1.23 / sub  4.30      4.5 peste 5.20 / sub 1.16
 *     2.5 peste 1.77 / sub  2.16      5.5 peste 9.55 / sub 1.04
 *
 * Read the other way round and Over 0.5 would be 11.00 and Over 5.5 would be
 * 1.04, which is a book that pays 11 to happen and 1.04 not to.
 *
 * Fail-closed on everything else: an unknown settlement window, a missing leg,
 * legs that disagree about the line, or a line that is not on the half. The
 * provider's first-half goals totals use this exact template and settle as a
 * separate contract, so full-time and first-half are both admitted explicitly;
 * second-half remains withheld until it has an independent counterpart.
 */
function goalsTotalMarket(market) {
  const period = favbetPeriod(market);
  if (period !== 'fulltime' && period !== 'half1') return null;
  const legs = (market.outcomes || []).filter(isPriced);
  const over = legs.find((o) => /^(peste|over)\b/i.test(String(o.outcome_name ?? '').trim()));
  const under = legs.find((o) => /^(sub|under)\b/i.test(String(o.outcome_name ?? '').trim()));
  if (!over || !under) return null;
  const overLine = legLine(over.outcome_name);
  const underLine = legLine(under.outcome_name);
  // Two legs that disagree about the threshold are not one market.
  if (overLine === null || overLine !== underLine) return null;
  const line = halfGoalLine(overLine);
  if (line === null) return null;
  return {
    key: 'TOTAL_GOALS',
    providerMarketId: `${GOALS_TOTAL_TEMPLATE}:${overLine}`,
    name: String(market.market_name || 'Peste / Sub'),
    period,
    line,
    selections: [
      { id: String(over.outcome_id), name: `Over ${line}`, odds: Number(over.outcome_coef), group: 'Main' },
      { id: String(under.outcome_id), name: `Under ${line}`, odds: Number(under.outcome_coef), group: 'Main' },
    ],
  };
}

/**
 * The exact Favbet match-corners total template. Template 914 is a separate
 * team-corners product, so it is intentionally not routed here: a team total
 * cannot share a contract with the match-corners total.
 */
function cornersTotalMarket(market) {
  if (favbetPeriod(market) !== 'fulltime') return null;
  if (String(market.market_name || '').trim().toLowerCase() !== 'total cornere') return null;
  const legs = (market.outcomes || []).filter(isPriced);
  const over = legs.find((o) => /^(peste|over)\b/i.test(String(o.outcome_name ?? '').trim()));
  const under = legs.find((o) => /^(sub|under)\b/i.test(String(o.outcome_name ?? '').trim()));
  if (!over || !under) return null;
  const overLine = legLine(over.outcome_name);
  const underLine = legLine(under.outcome_name);
  if (overLine === null || overLine !== underLine) return null;
  const line = halfGoalLine(overLine);
  if (line === null) return null;
  return {
    key: 'CNOU',
    providerMarketId: `${CORNERS_TOTAL_TEMPLATE}:${overLine}`,
    name: market.market_name,
    period: 'fulltime',
    line,
    selections: [
      { id: String(over.outcome_id), name: `Over ${line}`, odds: Number(over.outcome_coef), group: 'Main' },
      { id: String(under.outcome_id), name: `Under ${line}`, odds: Number(under.outcome_coef), group: 'Main' },
    ],
  };
}

/**
 * Which side a handicap leg belongs to, read from the leg's OWN text.
 *
 * `outcome_tag` looks like the side — "1" home, "2" away — and on the 1X2 and on
 * BTTS it is, so it was the first thing to reach for here. It is not: on
 * template 190 the tag is populated on 672 of 4,294 full-time rows (15.6%) and
 * is null on the other 3,622. The split is not random — the tag is there on the
 * WHOLE lines and absent on the HALF lines, so reading the side from the tag
 * accepts the 338-line push markets this reader is meant to reject and drops
 * every half line worth having. Measured on 4300 template-190 full-time rows.
 *
 * What every leg does carry is the team it belongs to, in the leg's own name:
 * "Slovacia (-1.5)" against "Kazakhstan (+1.5)". That reading resolved
 * 4,294 of 4,294 rows, and where the tag is also present the two readings agree
 * on 700 of 700 comparisons with zero contradictions — so this is the tag's own
 * meaning read from a field the provider never leaves empty, not a second
 * guess at it.
 *
 * Matching is on word boundaries and the read fails closed. "Hodd (-1.0)" against
 * home "Hodd" / away "Odd" contains BOTH names as substrings, which is the one
 * pair in 675 where one club's name sits inside the other's; a boundary match
 * reads it correctly and an ambiguous leg is refused rather than guessed.
 * Measured on 8,594 full-time legs: 4,290 whole-token home, 4,298 whole-token
 * away, 0 matching on a bare substring only, 6 ambiguous, 0 unresolved.
 *
 * An aggregate event's legs read "Goluri Gazde" / "Goluri Oaspeti" — home goals
 * and away goals — and the event's own participants are named the same way, so
 * the same match resolves them. Where the word reading and the name reading are
 * both available they agreed on every row measured.
 *
 * The tag is kept as a guard rather than a key: when the provider does fill it
 * in, it must not contradict the name.
 */
function handicapLegSide(outcome, homeKey, awayKey) {
  const text = normalizeTeamName(outcome?.outcome_name ?? '');
  if (!text || !homeKey || !awayKey) return null;
  const hasHome = new RegExp(`(?:^|\\s)${homeKey}(?:\\s|$)`).test(text);
  const hasAway = new RegExp(`(?:^|\\s)${awayKey}(?:\\s|$)`).test(text);
  if (hasHome === hasAway) return null; // neither, or both — never a guess
  return hasHome ? '1' : '2';
}

/**
 * A goals handicap, or null when this market is not one we may publish.
 *
 * Each leg names its own threshold, and the two are exact negations of each
 * other — "Slovacia (-1.5)" against "Kazakhstan (+1.5)" — which held on
 * 1,622 of 1,622 half-line rows. So the home leg's number is the home line and
 * the away leg's is its negation; the selection names carry the signed line
 * because that is where the contract layer reads it, and the side token is what
 * orients the bucket.
 *
 * The Asian templates are NOT here and must not be. Template 1227 "Handicap
 * Asiatic" and 1226 "Total Asiatic" quote quarter lines (-1.25, -0.75,
 * -1.75), which is the push-capable form of this same contract: admitting the
 * half-line template while ignoring the quarter one would be a choice about
 * the sport rather than about settlement.
 *
 * A market with one priced leg is not a two-way contract, and publishing it
 * would enter the bucket as a side that always wins and a side that never does,
 * so a missing or unresolvable leg refuses the whole market.
 */
function goalsHandicapMarket(market, homeKey, awayKey) {
  if (favbetPeriod(market) !== 'fulltime') return null;
  const legs = (market.outcomes || []).filter(isPriced);
  const sides = legs.map((o) => handicapLegSide(o, homeKey, awayKey));
  if (legs.length !== 2 || sides[0] === null || sides[1] === null || sides[0] === sides[1]) return null;
  const home = sides[0] === '1' ? legs[0] : legs[1];
  const away = sides[0] === '1' ? legs[1] : legs[0];
  // The provider's own tag, when it filled one in, may not contradict the name.
  for (const [leg, side] of [[home, '1'], [away, '2']]) {
    const tag = String(leg.outcome_tag);
    if (tag === '1' || tag === '2') {
      if (tag !== side) return null;
    }
  }
  const homeLine = legLine(home.outcome_name);
  const awayLine = legLine(away.outcome_name);
  if (homeLine === null || awayLine === null) return null;
  if (Math.abs(homeLine + awayLine) > 1e-9) return null;
  const line = halfGoalLine(homeLine);
  if (line === null) return null;
  return {
    key: 'ASIAN_HANDICAP',
    providerMarketId: `${GOALS_HANDICAP_TEMPLATE}:${homeLine}`,
    name: String(market.market_name || 'Handicap'),
    period: 'fulltime',
    line,
    selections: [
      { id: String(home.outcome_id), name: `1 (${signedLine(line)})`, odds: Number(home.outcome_coef), group: 'Main' },
      { id: String(away.outcome_id), name: `2 (${signedLine(-line)})`, odds: Number(away.outcome_coef), group: 'Main' },
    ],
  };
}

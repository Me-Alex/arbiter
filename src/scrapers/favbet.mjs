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
 */
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
      const byKind = new Map();
      for (const s of matchOdds.outcomes || []) {
        const odds = Number(s.outcome_coef);
        if (!Number.isFinite(odds) || odds <= 1) continue;
        const kind = String(s.outcome_tag || s.outcome_short_name).toUpperCase();
        if (['1', 'X', '2'].includes(kind)) byKind.set(kind, s);
      }
      if (!byKind.has('1') || !byKind.has('X') || !byKind.has('2')) continue;

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
        }, ...additionalMarkets],
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
    .map((s) => ({ id: String(s.outcome_id), tag: String(s.outcome_tag ?? s.outcome_short_name ?? '').toLowerCase(), odds: Number(s.outcome_coef) }));

  // A sub-settlement market must say so. `period` is what the engine reads to
  // keep a first-half price out of the full-time bucket, and an absent period
  // is treated as full-time — so a 1H market published without one was paired
  // against other books' full-time legs and reported as arbitrage.
  const isFirstHalf = (label) => /repriza\s*1|1st\s*half|prima\s*repriza/i.test(label);
  const periodFor = (label) => (isFirstHalf(label) ? 'firsthalf' : 'fulltime');

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

  if (isFirstHalf(name) && /1x2|rezultat|winner|final/i.test(name)) {
    const byKind = new Map(valid.map((s) => [s.tag.toUpperCase(), s]));
    if (['1', 'X', '2'].every((k) => byKind.has(k))) {
      return { key: 'MATCH_ODDS_1H', name, period: periodFor(name), selections: ['1', 'X', '2'].map((k) => ({ id: byKind.get(k).id, name: k, odds: byKind.get(k).odds, group: 'Main' })) };
    }
  }
  if (/fara\s*egal|draw\s*no\s*bet|dnb/i.test(name)) {
    const is1H = isFirstHalf(name);
    const byKind = new Map(valid.map((s) => [s.tag.toUpperCase(), s]));
    if (['1', '2'].every((k) => byKind.has(k))) {
      return { key: is1H ? 'DNB_1H' : 'DRAW_NO_BET', name, period: periodFor(name), selections: ['1', '2'].map((k) => ({ id: byKind.get(k).id, name: k, odds: byKind.get(k).odds, group: 'Main' })) };
    }
  }
  const line = extractNumber(name);
  if (/peste|sub|over|under|total/i.test(name)) {
    if (line === null || valid.length < 2) return null;
    const over = valid.find((s) => /^(over|peste)\b/i.test(s.tag));
    const under = valid.find((s) => /^(under|sub)\b/i.test(s.tag));
    if (!over || !under) return null;
    const is1H = isFirstHalf(name);
    return { key: `OVER_UNDER_${String(line).replace('.', '_')}${is1H ? '_1H' : ''}`, name, period: periodFor(name), selections: [
      { id: over.id, name: 'Over', odds: over.odds, handicap: line, group: 'Main' },
      { id: under.id, name: 'Under', odds: under.odds, handicap: line, group: 'Main' },
    ] };
  }
  if (/ambele.*(?:[iî]nscriu|marcheaz|echipe)|both teams|btts|gg[\s/]*ng/iu.test(name)) {
    const is1H = isFirstHalf(name);
    const yes = valid.find((s) => /^(yes|da|gg)\b/i.test(s.tag));
    const no = valid.find((s) => /^(no|nu|ng)\b/i.test(s.tag));
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
    return { key: is1H ? 'BOTH_TEAMS_SCORE_1H' : 'BOTH_TEAMS_SCORE', name, period: periodFor(name), selections: [
      { id: yes.id, name: 'Yes', odds: yes.odds, group: 'Main' },
      { id: no.id, name: 'No', odds: no.odds, group: 'Main' },
    ] };
  }
  if (/dubl|double chance/i.test(name)) {
    const is1H = isFirstHalf(name);
    const combined = valid.filter((s) => /^(1x|x2|12)$/.test(s.tag));
    if (combined.length !== 3) return null;
    return { key: is1H ? 'DOUBLE_CHANCE_1H' : 'DOUBLE_CHANCE', name, period: periodFor(name), selections: combined.map((s) => ({ id: s.id, name: s.tag.toUpperCase(), odds: s.odds, group: 'Main' })) };
  }
  if (/handicap/i.test(name)) {
    if (line === null) return null;
    const threeWay = valid.some((s) => /^(x|draw|egal)$/.test(s.tag));
    const key = threeWay ? `HANDICAP_${String(Math.abs(line)).replace('.', '_')}` : `AH_${String(Math.abs(line)).replace('.', '_')}`;
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
    return { key, name, period: periodFor(name), selections: required.map((k) => ({ ...picked[k], handicap: line })) };
  }
  // Corners Over/Under
  if (/cornere|corners|corner/i.test(name)) {
    if (line === null || valid.length < 2) return null;
    const over = valid.find((s) => /^(over|peste)\b/i.test(s.tag));
    const under = valid.find((s) => /^(under|sub)\b/i.test(s.tag));
    if (!over || !under) return null;
    return { key: `CORNERS_OVER_UNDER_${String(line).replace('.', '_')}`, name, period: periodFor(name), selections: [
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
    return { key: `CARDS_OVER_UNDER_${String(line).replace('.', '_')}`, name, period: periodFor(name), selections: [
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
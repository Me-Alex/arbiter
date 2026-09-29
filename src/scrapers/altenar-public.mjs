import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

export const ALTENAR_IDS = ['don', 'topbet', 'million', 'baumbet', 'powerbet', 'winbet'];
const TRANSPORT = 'altenar-sb2-widget-json';
export function matchesAltenarConfig(id, cfg) {
  return ALTENAR_IDS.includes(id) && cfg.engine === 'altenar-tenancy'
    && cfg.transport === TRANSPORT
    && cfg.script === 'altenar-sites.mjs'
    && Array.isArray(cfg.sourceIds) && cfg.sourceIds.length === 1 && cfg.sourceIds[0] === id;
}

const UPCOMING_BASE = 'https://sb2frontend-altenar2.biahosted.com/api/widget/GetUpcoming';

/**
 * Football sport id and the market families we publish. Verified against the
 * tenants' GetSportMenu response, where Fotbal is id 66 (68 = Tenis,
 * 67 = Baschet, …), and against captured GetUpcoming payloads from all six
 * tenants.
 *
 * The six do NOT serve the same catalogue, which the type list below now
 * records per family rather than asserting as a block. Measured 2026-09-29 on
 * the full paginated board of each:
 *
 *   typeId 1  1x2            all six
 *   typeId 18 totals         all six, under two names — "Total goluri" on don
 *                            and topbet (697 and 703 rows), "Total" on the
 *                            other four (~700 each) plus a small "Total" on don
 *                            and topbet (78 each). Same typeId, so one branch
 *                            covers both.
 *   typeId 29 BTTS           all six (434-465 rows)
 *   typeId 16 goals spread   don and topbet ONLY — 465 and 451 rows. million,
 *                            baumbet, powerbet and winbet serve none, so the
 *                            mapping buys two of the six a family and the
 *                            other four nothing. That is a catalogue
 *                            difference, not a reader gap: it was re-measured
 *                            per tenant rather than inferred from the two.
 */
const FOOTBALL_SPORT_ID = 66;

/**
 * Ceiling on pages per tenant, 25 × 100 = 2,500 events.
 *
 * The widget paginates without overlap and each page is a small JSON body, but
 * the request count is still the cost of the run and nothing above this has
 * been observed to be useful: measured 2026-09-29, five pages already reach
 * 2026-10-02 from a 2026-09-29 start.
 */
const MAX_PAGES = 25;

/**
 * Altenar market typeId → the family the engine can price.
 *
 * The feed serves far more than the 1X2 the adapter used to publish; these are
 * the typeIds present in every captured tenant payload that map onto a family
 * `resolveContract()` prices for arbitrage:
 *
 *   1  "1x2"                        full-time match result
 *   18 "Total" / "Total goluri"     goals over/under, line in `sv` ("2.5")
 *   29 "Ambele echipe să înscrie"   both teams to score
 *   16 "Handicap Goluri" / "Handicap"  goals spread, home line in `sv` ("-0.5")
 *
 * Deliberately NOT published, and why — the feed serves them, but the engine
 * cannot price them as a surebet or must not treat them as a match result:
 *
 *   10 "Șansă dublă" (double chance) — DOUBLE_CHANCE is arbEligible:false by
 *      design: taking 2 of 3 double chances is not a surebet.
 *   11 "Egal pariu nul" (draw no bet) — 2-way with a draw refund. The engine
 *      would fall back to routing it as a 2-way MATCH_ODDS, and an Altenar DNB
 *      "1" leg does not share a payoff with another book's match-result "1".
 *      Publishing it under that key would invent an arbitrage.
 *   8  "Golul primul" (first goal)   — first-goalscorer, outcome id 7 is
 *      "Niciunul"; no contract models it.
 *   1  "1x2 - Cote Mărite"           — the same three-way result at a
 *      promotional price, on 5 of 4,348 market rows. It is the same contract
 *      as the 1X2 already published for that event, so both land in one bucket
 *      with one event's two result markets in it. Left out rather than
 *      reshaped; worth revisiting if the engine ever wants the best of a set.
 */
const MATCH_ODDS_MARKET_TYPE = 1;
const TOTALS_MARKET_TYPE = 18;
const BTTS_MARKET_TYPE = 29;
const HANDICAP_MARKET_TYPE = 16;

/**
 * Outcome typeId → canonical selection label, per family.
 *
 * `odd.name` is NOT the label to trust: the same tenant returns "1"/"2" for
 * some integrations and the competitor's own name for others (don/topbet
 * return "Club Dr Benjamin Aceval"/"Tembetary"). The stable field is
 * `odd.typeId`, which is the provider's own outcome taxonomy, so the emitted
 * selection names are canonical regardless of tenant localisation.
 *
 * The totals labels keep the line ("Peste 2.5" / "Sub 2.5") because
 * `classifyAndExtractLine` reads the line out of the selection name when the
 * market key alone does not carry it.
 */
const OUTCOME_LABELS = new Map([
  [1, '1'],
  [2, 'X'],
  [3, '2'],
]);
const TOTALS_LABELS = new Map([
  [12, 'over'],
  [13, 'under'],
]);
const BTTS_LABELS = new Map([
  [74, 'yes'],
  [76, 'no'],
]);

/**
 * Outcome typeId → which side of the goals spread it prices.
 *
 * Measured 2026-09-29 over the whole paginated football board (770 events,
 * 4,348 market rows): 412 handicap markets, every one with exactly the pair
 * 1714/1715, and every one of those legs carrying a `competitorId` — 1714 is
 * always the event's first competitor, 1715 the second. Nothing is inferred
 * from leg order; the anchor is checked per leg below, so a tenant that swaps
 * the two is refused rather than published mirrored.
 */
const HANDICAP_SIDES = new Map([
  [1714, 'home'],
  [1715, 'away'],
]);

/**
 * The goals-spread line the feed quotes at, formatted with an explicit sign.
 *
 * `sv`/`sn` is the HOME line — at `+0.5` the home leg reads
 * "Hitchin Town (+0.5)" and the away leg "Leighton Town (-0.5)", so the two
 * legs are negations of each other and the engine's spread branch, which
 * requires an exact negation, is the one that applies. `handicapLineKey` then
 * orients the bucket from the "1"/"2" side tokens in the selection names, which
 * is what keeps `-0.5/0.5` and `0.5/-0.5` in different buckets.
 *
 * @param {unknown} line
 * @returns {string|null}
 */
function signedLine(line) {
  const n = Number(line);
  if (!Number.isFinite(n)) return null;
  return n < 0 ? String(n) : `+${n}`;
}

export default class AltenarPublic extends ScraperBase {
  maxAttempts = 1;
  constructor(id, opts = {}) {
    super(opts);
    if (!ALTENAR_IDS.includes(id)) throw new ValidationError('Unknown Altenar integration');
    this.id = id;
    this.name = id;
    this.sourceIds = [id];
    this.runId ||= new Date().toISOString();
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Math.min(Number(opts.maxEvents ?? 100), 5000);
    this.sport = opts.sport || 'football';
    this.windowHours = Number(opts.windowHours ?? 24);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0
        || !Number.isFinite(this.windowHours) || this.windowHours <= 0 || this.windowHours > 720
        || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) {
      throw new ValidationError('Altenar: invalid cap/window/timeout');
    }
    // Pages of 100, because the widget rejects a larger `eventCount` (measured:
    // 100 answers JSON, 250/500/1000 answer a non-JSON body). So the board is
    // reached by paging, not by asking for more.
    this.pageSize = 100;
    // At least one page even for a zero event cap: that cap short-circuits inside
    // fetchRaw before any request, and must not be turned into a config error.
    this.pageLimit = Number(opts.pageLimit ?? opts.jobConfig?.pageLimit
      ?? Math.max(1, Math.min(Math.ceil(this.maxEvents / this.pageSize), MAX_PAGES)));
    if (!Number.isInteger(this.pageLimit) || this.pageLimit < 1 || this.pageLimit > MAX_PAGES) {
      throw new ValidationError(`Altenar: invalid pageLimit (1-${MAX_PAGES})`);
    }
    this.sourceUrl = `${UPCOMING_BASE}?integration=${id}`;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    if (this.sport !== 'football') {
      throw new ValidationError('Altenar: only football full-time 1X2 is verified');
    }
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    if (this.maxEvents === 0) {
      this.observedAt = new Date().toISOString();
      return { events: [], markets: [], odds: [], competitors: [], champs: [], categories: [], headers: [], _sportNames: {} };
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const fetchJson = async (url) => {
      const res = await this.fetchImpl(url, {
        signal: bounded,
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new UpstreamError(`Altenar: HTTP ${res.status}`, { status: res.status });
      const reader = res.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          bounded.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 4000000) throw new ValidationError('Altenar: response exceeds 4 MB');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      bounded.throwIfAborted();
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (err) {
        // A captive-portal or challenge page arrives as HTML with a 200.
        throw new ValidationError('Altenar: expected JSON response', { cause: err });
      }
    };

    // Bounded reads of the football feed, one page at a time. These tenants
    // expose a per-sport catalogue and only football full-time 1X2 is a
    // verified contract, so we ask for exactly that instead of fanning out over
    // every sport and discarding the ones we cannot interpret. `redirect:
    // 'error'` above keeps the read on the declared host.
    //
    // Paging is not an optimisation, it is how the board is reached at all.
    // `eventCount` above 100 is refused by the widget (measured: 100 answers
    // JSON, 250/500/1000 answer a non-JSON body), and the query takes a `page`
    // the adapter used to hardcode to 1. Measured 2026-09-29 on `don` and
    // `million`, five pages of 100 returned 500 events with ZERO overlap and a
    // kickoff range running from 2026-09-29T15:27 to 2026-10-02T23:00. Page 1
    // alone starts at "now", so most of its hundred events are already in play
    // and get dropped — which is why a tenant with an event cap of 3000 was
    // publishing 37. A book can only be paired with another book on the same
    // fixture, so a board that stops at kick-off time is a board that can
    // barely be paired at all.
    //
    // Page 1 stays fatal on failure, exactly as a single read was. A later
    // page ends pagination instead: a truncated board with honest gaps beats
    // discarding pages that already succeeded. AbortError is not a page
    // failure and propagates.
    const TABLES = ['events', 'markets', 'odds', 'competitors', 'champs', 'categories', 'headers'];
    const merged = Object.fromEntries(TABLES.map((k) => [k, []]));
    // normalize() rejects a duplicate id outright, and champs/categories/headers
    // repeat identically on every page, so rows are deduplicated as they arrive
    // rather than concatenated.
    const seenRows = new Map(TABLES.map((k) => [k, new Set()]));
    const pageUrl = (page) => `${UPCOMING_BASE}?culture=ro-RO&timezoneOffset=-180&deviceType=1`
      + `&numFormat=en-GB&countryCode=RO&sportId=${FOOTBALL_SPORT_ID}`
      + `&eventCount=${this.pageSize}&page=${page}&integration=${this.id}`;

    let read = 0;
    for (let page = 1; page <= this.pageLimit; page++) {
      let data;
      if (page === 1) {
        data = await fetchJson(pageUrl(1));
      } else {
        bounded.throwIfAborted();
        try {
          data = await fetchJson(pageUrl(page));
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          this.logger('warn', `Altenar: ${this.name} page ${page} failed, keeping ${merged.events.length} events: ${String(err?.message || err).slice(0, 80)}`);
          break;
        }
      }
      if (data?.error) {
        if (page === 1) throw new ValidationError('Altenar: upstream error');
        break;
      }
      let added = 0;
      for (const key of TABLES) {
        for (const row of data?.[key] || []) {
          const id = row?.id;
          if (id === undefined || id === null || seenRows.get(key).has(id)) continue;
          seenRows.get(key).add(id);
          merged[key].push(row);
          if (key === 'events') added++;
        }
      }
      read = page;
      // A page that adds no event is the end of the board, not a transient empty.
      if (added === 0) break;
      if (merged.events.length >= this.maxEvents) break;
    }
    this.sourceUrl = pageUrl(1);
    if (merged.events.length === 0) {
      throw new UpstreamError(`Altenar: ${this.name} returned 0 events over ${read} page(s)`);
    }
    this.observedAt = new Date().toISOString();
    return { ...merged, _sportNames: { [FOOTBALL_SPORT_ID]: 'Football' } };
  }

  normalize(raw) {
    if (raw?.error) throw new ValidationError('Altenar: upstream error');
    for (const key of ['events', 'markets', 'odds', 'competitors', 'champs', 'categories', 'headers']) {
      if (!Array.isArray(raw?.[key])) throw new ValidationError(`Altenar: missing ${key} array`);
    }
    this.tables = {};
    for (const key of ['markets', 'odds', 'competitors', 'champs', 'categories']) {
      const map = new Map();
      for (const item of raw[key]) {
        if (!item || !Number.isSafeInteger(item.id) || map.has(item.id)) throw new ValidationError(`Altenar: invalid/duplicate ${key} id`);
        map.set(item.id, item);
      }
      this.tables[key] = map;
    }
    this.sportNames = raw._sportNames || {};
    if (raw.events.some((e) => !e || !Number.isSafeInteger(e.id) || !Array.isArray(e.marketIds)
        || !Array.isArray(e.competitorIds))) throw new ValidationError('Altenar: malformed event');
    return raw.events;
  }

  extractEvents(events) {
    const out = [];
    const seen = new Set();
    const t = this.tables;
    const sportNames = this.sportNames || {};
    for (const e of events) {
      if (out.length >= this.maxEvents) break;
      const time = Date.parse(e.startDate);
      if (e.status !== 0 || e.et !== 0 || e.isParlay !== false
          || seen.has(e.id) || !Number.isFinite(time) || time <= (this.from ?? Date.now())
          || time > (this.to ?? Date.now() + this.windowHours * 3600000)) continue;
      // Only football full-time 1X2 is a verified contract for this feed.
      if (e.sportId !== FOOTBALL_SPORT_ID) continue;
      if (e.competitorIds.length !== 2 || new Set(e.competitorIds).size !== 2) continue;
      const teams = e.competitorIds.map((id) => t.competitors.get(id)?.name);
      if (teams.some((name) => typeof name !== 'string' || !name.trim()) || teams[0] === teams[1]) continue;
      // Country ISO is required: these tenants publish a country-specific
      // catalogue, and a category without it cannot be attributed.
      const category = t.categories.get(e.catId);
      if (!category || typeof category.iso !== 'string' || !category.iso.trim()) continue;
      const league = t.champs.get(e.champId)?.name;
      if (!league) continue;
      // A simulated (virtual) event carries the empty ISO sentinel.
      if (category.iso === '') continue;
      const markets = this._markets(e);
      if (markets.length === 0) continue;
      const kickoff = new Date(time).toISOString();
      const sportName = sportNames[e.sportId] || 'Football';
      const sportKey = sportName.toLowerCase().replace(/\s+/g, '-');
      seen.add(e.id);
      out.push({ id: String(e.id), sourceId: this.id, sourceUrl: this.sourceUrl,
        transport: TRANSPORT, runId: this.runId, observedAt: this.observedAt,
        providerEventId: String(e.id), attributionStatus: 'public-integration-unverified-brand',
        sport: sportName, league, kickoff, homeTeam: teams[0], awayTeam: teams[1], isLive: false,
        eventKey: [sportKey, normalizeTeamName(league), kickoff, ...teams.map(normalizeTeamName)].join('|'),
        markets });
    }
    return out;
  }

  /**
   * Every market this event publishes that the engine can price, in a fixed
   * order with the 1X2 first.
   *
   * The result is required: an event whose 1X2 is incomplete or mislabelled is
   * not a trustworthy event, so it is dropped whole rather than published with
   * only the extras. The extras are additive and may be absent — a tenant that
   * suspends a total simply yields fewer markets, and an unusable extra is
   * skipped without taking the event down with it.
   */
  _markets(e) {
    const matchOdds = this._matchOddsMarket(e);
    if (!matchOdds) return [];
    const out = [matchOdds];
    const totals = this._totalsMarkets(e);
    if (totals) out.push(...totals);
    const handicap = this._handicapMarkets(e);
    if (handicap) out.push(...handicap);
    const btts = this._bttsMarket(e);
    if (btts) out.push(btts);
    return out;
  }

  /**
   * Locate the single full-time 1X2 market for an event and validate it as a
   * complete contract: exactly the three outcomes 1/X/2, each present once,
   * each anchored to the right competitor (draw has none), all live and
   * priced above 1. A market with a handicap (`sv`) or a non-result name is
   * a different market family and is rejected rather than mislabelled.
   */
  _matchOddsMarket(e) {
    const t = this.tables;
    const candidates = e.marketIds
      .map((id) => t.markets.get(id))
      .filter((m) => m && m.typeId === MATCH_ODDS_MARKET_TYPE
        && !m.sv && m.name === '1x2');
    if (candidates.length !== 1) return null;
    const m = candidates[0];
    const byType = new Map();
    for (const oddId of m.oddIds || []) {
      const o = t.odds.get(oddId);
      if (!o || o.oddStatus !== 0 || !Number.isFinite(o.price) || o.price <= 1) return null;
      if (!OUTCOME_LABELS.has(o.typeId)) return null;
      if (byType.has(o.typeId)) return null;
      byType.set(o.typeId, o);
    }
    if (byType.size !== 3) return null;
    const [homeId, awayId] = e.competitorIds;
    const selections = [];
    for (const typeId of [1, 2, 3]) {
      const o = byType.get(typeId);
      // Each leg must be anchored to the competitor it prices; the draw leg
      // carries no competitor, so any competitor there is a mismatch.
      if (typeId === 1 && o.competitorId !== homeId) return null;
      if (typeId === 3 && o.competitorId !== awayId) return null;
      if (typeId === 2 && o.competitorId !== undefined && o.competitorId !== null) return null;
      selections.push({ id: String(o.id), providerOutcomeId: o.typeId, name: OUTCOME_LABELS.get(typeId), odds: o.price, handicap: null });
    }
    if (new Set(selections.map((s) => s.id)).size !== 3) return null;
    return { key: '1x2', providerMarketId: String(m.id), name: m.name, period: 'fulltime', selections };
  }

  /**
   * Every full-time goals total this event publishes, one market per line.
   *
   * An event carries several totals (1.5, 2.5, 3.5 …) as separate markets, and
   * each is its own contract at its own line: publishing only the first would
   * discard real prices, and merging them would bucket OVER 2.5 with OVER 3.5.
   * The line lives in the market's `sv` and is repeated in each selection name
   * ("Peste 2.5" / "Sub 2.5"), which is where `classifyAndExtractLine` reads it
   * from, so both are emitted.
   */
  _totalsMarkets(e) {
    const t = this.tables;
    const out = [];
    for (const m of e.marketIds.map((id) => t.markets.get(id))) {
      if (!m || m.typeId !== TOTALS_MARKET_TYPE) continue;
      const line = String(m.sv ?? m.sn ?? '').trim();
      // Without a line the market cannot be bucketed, and the two selections
      // would collapse into a nameless 2-way contract.
      if (!line) continue;
      const byType = this._completePair(m, TOTALS_LABELS);
      if (!byType) continue;
      // "Peste 2.5" / "Sub 2.5" — the label carries the line the engine reads.
      const labels = { 12: `Peste ${line}`, 13: `Sub ${line}` };
      const selections = [12, 13].map((typeId) => ({
        id: String(byType.get(typeId).id),
        providerOutcomeId: typeId,
        name: labels[typeId],
        odds: byType.get(typeId).price,
        handicap: null,
      }));
      out.push({ key: 'TOTAL_GOALS', providerMarketId: String(m.id), name: m.name, period: 'fulltime', line, selections });
    }
    return out;
  }

  /** The full-time both-teams-to-score market, or null when absent/unusable. */
  _bttsMarket(e) {
    const t = this.tables;
    for (const m of e.marketIds.map((id) => t.markets.get(id))) {
      if (!m || m.typeId !== BTTS_MARKET_TYPE) continue;
      const byType = this._completePair(m, BTTS_LABELS);
      if (!byType) continue;
      // The engine's BTTS matcher accepts the Romanian spellings directly;
      // keeping them is what makes the market recognisable.
      const selections = [74, 76].map((typeId) => ({
        id: String(byType.get(typeId).id),
        providerOutcomeId: typeId,
        name: BTTS_LABELS.get(typeId) === 'yes' ? 'Da' : 'Nu',
        odds: byType.get(typeId).price,
        handicap: null,
      }));
      return { key: 'BTTS', providerMarketId: String(m.id), name: m.name, period: 'fulltime', selections };
    }
    return null;
  }

  /**
   * Every full-time goals handicap this event publishes, one market per line.
   *
   * Same shape as the totals and for the same reason: an event quotes several
   * spreads (measured -0.5, +0.5, -1.5, +1.5, +2.5, +4.5, +5.5) as separate
   * markets, and each is its own contract at its own line. Merging them would
   * bucket home -0.5 with home -1.5.
   *
   * HALF LINES ONLY, and that is a settlement rule rather than a formatting
   * one, the same rule the totals extractor and the router apply. At a whole
   * line the level result pushes both legs; at a quarter line one leg wins half
   * and the other pushes half. Neither is an exhaustive two-way contract, so an
   * inverse sum below 1 is not a surebet. Measured 2026-10-02 on don, every one
   * of the 53 handicap markets on the board is a half line (-0.5 x27, +0.5 x14,
   * -1.5 x6, +1.5 x4, +2.5 x2), so this guard has not had to reject anything
   * from that feed — it is here so that a future line cannot be published on
   * the strength of that observation.
   */
  _handicapMarkets(e) {
    const t = this.tables;
    const out = [];
    const [homeId, awayId] = e.competitorIds;
    for (const m of e.marketIds.map((id) => t.markets.get(id))) {
      if (!m || m.typeId !== HANDICAP_MARKET_TYPE) continue;
      // The sign is part of the line, and the feed always writes it: "-0.5"
      // when the home side gives goals, "+0.5" when it receives them. A guard
      // that accepted only an optional minus would drop every market whose
      // home side is the underdog — measured 2026-10-02 on don: 20 of the 53
      // handicap markets on the board carry a leading "+".
      const rawLine = String(m.sv ?? m.sn ?? '').trim();
      if (!/^[+-]?\d+\.5$/.test(rawLine)) continue;
      const homeLine = signedLine(rawLine);
      if (homeLine === null) continue;
      const awayLine = signedLine(-Number(homeLine));
      if (awayLine === null) continue;
      const byType = this._completePair(m, HANDICAP_SIDES);
      if (!byType) continue;
      // Each leg must be anchored to the side it claims to price. The feed
      // labels its legs by competitor rather than by outcome type, so this is
      // the only thing that keeps a mirrored tenant from being published with
      // its two sides swapped.
      if (byType.get(1714).competitorId !== homeId) continue;
      if (byType.get(1715).competitorId !== awayId) continue;
      const lines = { home: homeLine, away: awayLine };
      // "1 (-0.5)" / "2 (+0.5)": the side token orients the bucket, and the
      // signed line is what `classifyAndExtractLine` reads.
      const selections = [1714, 1715].map((typeId) => {
        const side = HANDICAP_SIDES.get(typeId);
        return {
          id: String(byType.get(typeId).id),
          providerOutcomeId: typeId,
          name: `${side === 'home' ? '1' : '2'} (${lines[side]})`,
          odds: byType.get(typeId).price,
          handicap: null,
        };
      });
      out.push({ key: 'ASIAN_HANDICAP', providerMarketId: String(m.id), name: m.name, period: 'fulltime', line: homeLine, selections });
    }
    return out;
  }

  /**
   * Read a market's outcomes as a complete, live, priced pair — exactly one of
   * each type in `labels`, no duplicates, nothing suspended, every price > 1.
   * Returns null on any defect so a half-quoted market is never published.
   *
   * @returns {Map<number, {id: number, price: number}>|null}
   */
  _completePair(m, labels) {
    const t = this.tables;
    const byType = new Map();
    for (const oddId of m.oddIds || []) {
      const o = t.odds.get(oddId);
      if (!o || o.oddStatus !== 0 || !Number.isFinite(o.price) || o.price <= 1) return null;
      if (!labels.has(o.typeId) || byType.has(o.typeId)) return null;
      byType.set(o.typeId, o);
    }
    if (byType.size !== labels.size) return null;
    return byType;
  }

  _serializable(events, raw) {
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl, transport: TRANSPORT,
      observedAt: this.observedAt, integration: this.id, attributionStatus: 'public-integration-unverified-brand',
      coverage: { sport: 'football', market: 'fulltime-1x2+tgoals+asian_handicap+btts', live: false, page: 1, exhaustive: false,
        maxEvents: this.maxEvents, windowHours: this.windowHours, requiresCountryIso: true } };
  }
}

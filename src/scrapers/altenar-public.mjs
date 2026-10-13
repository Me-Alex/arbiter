import ScraperBase from './base.mjs';
import { normalizeTeamName, canonicalSport } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor, markMarketsLive } from './live-status.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

export const ALTENAR_IDS = ['don', 'topbet', 'million', 'baumbet', 'powerbet', 'winbet',
  'frankcasino', 'mrbit', 'slotv', 'betinia', 'win2ro', 'swiper',
  'rabona', 'campobet', 'librabet', 'sportaza', 'greatwin', 'fezbet',
  'wazamba', 'nomini', 'casinia', 'quickwin',
  'stake', 'bcgame', 'sportsbetio', 'duelbits', 'solcasino', 'betriot', 'spinanga', 'powbet', 'sportuna', 'casinoly', 'excitewin', 'cazimbo', 'slotspalace', 'malinacasino', 'zet', 'kingmaker', 'crownplay', '5gringos', 'ohmyspins', 'boomerang', 'goldenbet', 'casombie', 'campeonbet', 'betsamigo', 'betalright', 'fairspin', 'spinight', 'goldspin', 'wildsino', 'betstro', 'evobet', 'svenbet', 'sonsofslots', 'wallacebet', 'betrebels', 'prontobet', 'betovo', 'quickslot', 'betbeast', 'slotparadise', 'joker8', 'betway'];
const TRANSPORT = 'altenar-sb2-widget-json';
export function matchesAltenarConfig(id, cfg) {
  return ALTENAR_IDS.includes(id) && cfg.engine === 'altenar-tenancy'
    && cfg.transport === TRANSPORT
    && cfg.script === 'altenar-sites.mjs'
    && Array.isArray(cfg.sourceIds) && cfg.sourceIds.length === 1 && cfg.sourceIds[0] === id;
}

const UPCOMING_BASE = 'https://sb2frontend-altenar2.biahosted.com/api/widget/GetUpcoming';

/**
 * Altenar sport IDs per canonical sport, measured from GetSportMenu on the
 * `don` tenant (2026-10-07). The same GetSportMenu shape exists on every
 * Altenar tenant, and every id that is listed for football is the id for that
 * tenant, so a tenant's own map is the source of truth for it.
 *
 * Tenants may carry a different subset; the scraper reports only the sports
 * it actually collected through this map, so a missing key is a legitimate
 * per-tenant absence, not a code gap.
 */
const ALT_SPORT_ID_BY_CANON = Object.freeze({
  'football': 66,
  'tennis': 68,
  'basketball': 67,
  'table-tennis': 77,
  'esports': 145,
  'volleyball': 69,
  'baseball': 76,
  'handball': 73,
  'ice-hockey': 70,
  'american-football': 75,
  'motorsport': 103,
  'mma': 84,
  'futsal': 88,
  'snooker': 81,
  'darts': 78,
  'badminton': 72,
  'rugby': 102,
  'rugby-league': 101,
  'golf': 85,
  'australian-football': 106,
  'cricket': 74,
  'padel': 164,
  'biathlon': 93,
  'boxing': 71,
  'cycling': 89,
  'water-polo': 83,
  'ski-cross-country': 118,
  'floorball': 80,
  'surfing': 129,
  // Bespoke tenant ids for "Speciale" (special markets) carry no recognizable
  // sport, so they are not mapped.
});

const CORE_SPORT_IDS = Object.freeze([66, 67, 68, 70]);
const CANON_BY_ALT_SPORT_ID = Object.freeze(
  Object.fromEntries(Object.entries(ALT_SPORT_ID_BY_CANON).map(([k, v]) => [v, k]))
);
const CANON_DISPLAY_BY_SPORT_ID = Object.freeze({
  66: 'Football',
  67: 'Basketball',
  68: 'Tennis',
  70: 'Ice Hockey',
});

/**
 * Ceiling on pages per tenant, 25 × 100 = 2,500 events.
 *
 * The widget paginates without overlap and each page is a small JSON body, but
 * the request count is still the cost of the run and nothing above this has
 * been observed to be useful: measured 2026-09-29, five pages already reach
 * 2026-10-02 from a 2026-09-29 start.
 */
const MAX_PAGES = Infinity;

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
const MONEYLINE_MARKET_TYPE = 2;
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
    this.maxEvents = opts.maxEvents === 'all' ? Infinity : Number(opts.maxEvents ?? Infinity);
    this.sport = opts.sport || 'football';
    if (this.sport === 'all') {
      this.sports = ['football', 'basketball', 'tennis', 'ice-hockey'];
      this.sportIds = [...CORE_SPORT_IDS];
      this.sportId = 66;
    } else if (Array.isArray(opts.sports) && opts.sports.length > 0) {
      this.sports = opts.sports;
      this.sportIds = opts.sports.map((s) => ALT_SPORT_ID_BY_CANON[canonicalSport(s)] ?? (Number(s) || null)).filter(Boolean);
      this.sportId = this.sportIds[0] ?? null;
    } else {
      this.sports = [this.sport];
      this.sportId = ALT_SPORT_ID_BY_CANON[canonicalSport(this.sport)] ?? null;
      this.sportIds = this.sportId !== null ? [this.sportId] : [];
    }
    this.windowHours = Number(opts.windowHours ?? 24);
    this.includeLive = opts.includeLive === true;
    if ((!Number.isInteger(this.maxEvents) && this.maxEvents !== Infinity) || this.maxEvents < 0
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
      ?? (this.maxEvents === Infinity ? Infinity : Math.max(1, Math.ceil(this.maxEvents / this.pageSize))));
    if ((!Number.isInteger(this.pageLimit) && this.pageLimit !== Infinity) || this.pageLimit < 1 || this.pageLimit > MAX_PAGES) {
      throw new ValidationError(`Altenar: invalid pageLimit (1-${MAX_PAGES})`);
    }
    this.sourceUrl = `${UPCOMING_BASE}?integration=${id}`;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    if (this.sportId === null || this.sportIds.length === 0) {
      throw new ValidationError(`Altenar: tenant "${this.id}" publishes no catalogue for "${this.sport}" — cannot fetch it`);
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

    const TABLES = ['events', 'markets', 'odds', 'competitors', 'champs', 'categories', 'headers'];
    const merged = Object.fromEntries(TABLES.map((k) => [k, []]));
    const seenRows = new Map(TABLES.map((k) => [k, new Set()]));
    const pageUrl = (sportId, page) => `${UPCOMING_BASE}?culture=ro-RO&timezoneOffset=-180&deviceType=1`
      + `&numFormat=en-GB&countryCode=RO&sportId=${sportId}`
      + `&eventCount=${this.pageSize}&page=${page}&integration=${this.id}`;

    const sportNames = {};
    let readPages = 0;

    for (const sportId of this.sportIds) {
      if (merged.events.length >= this.maxEvents) break;
      const sName = CANON_DISPLAY_BY_SPORT_ID[sportId] || CANON_BY_ALT_SPORT_ID[sportId] || String(sportId);
      sportNames[sportId] = sName;

      let pageCount = this.pageLimit;
      for (let page = 1; page <= pageCount && page <= this.pageLimit; page++) {
        let data;
        if (page === 1 && readPages === 0) {
          data = await fetchJson(pageUrl(sportId, 1));
        } else {
          bounded.throwIfAborted();
          try {
            data = await fetchJson(pageUrl(sportId, page));
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            this.logger('warn', `Altenar: ${this.name} sport ${sportId} page ${page} failed, keeping ${merged.events.length} events: ${String(err?.message || err).slice(0, 80)}`);
            break;
          }
        }
        if (data?.error) {
          if (page === 1 && readPages === 0) throw new ValidationError('Altenar: upstream error');
          break;
        }
        if (Number.isInteger(data?.pageCount) && data.pageCount > 0) {
          pageCount = Math.min(data.pageCount, this.pageLimit);
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
        readPages++;
        if (added === 0) break;
        if (merged.events.length >= this.maxEvents) break;
      }
    }
    this.sourceUrl = pageUrl(this.sportIds[0] ?? this.sportId, 1);
    if (merged.events.length === 0) {
      throw new UpstreamError(`Altenar: ${this.name} returned 0 events over ${readPages} page(s)`);
    }
    this.observedAt = new Date().toISOString();
    return { ...merged, _sportNames: sportNames };
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
      const live = Boolean(e._live || e.isLive || (this.includeLive && e.status === 1));
      const time = Date.parse(e.startDate);
      if (!this.includeLive && (live || e.status === 1)) continue;
      if (e.status !== 0 && !live) continue;
      if (e.et !== 0 || e.isParlay !== false
          || seen.has(e.id) || !Number.isFinite(time) || (!live && time <= (this.from ?? Date.now()))
          || (!this.includeLive && time > (this.to ?? Date.now() + this.windowHours * 3600000))) continue;
      // Only events that already match the requested canonical sport id are
      // published. The menu gives a one-to-one canonical mapping per tenant,
      // so an event that does not carry the requested sport id is a different
      // sport and must be skipped rather than mis-labelled.
      if (this.sportIds && this.sportIds.length > 0 ? !this.sportIds.includes(e.sportId) : e.sportId !== this.sportId) continue;
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
      markMarketsLive(markets, () => live);
      const kickoff = new Date(time).toISOString();
      const sportName = sportNames[e.sportId] || CANON_DISPLAY_BY_SPORT_ID[e.sportId] || 'Football';
      const sportKey = sportName.toLowerCase().replace(/\s+/g, '-');
      seen.add(e.id);
      out.push({ id: String(e.id), sourceId: this.id, sourceUrl: this.sourceUrl,
        transport: TRANSPORT, runId: this.runId, observedAt: this.observedAt,
        providerEventId: String(e.id), attributionStatus: 'public-integration-unverified-brand',
        sport: sportName, league, kickoff, homeTeam: teams[0], awayTeam: teams[1],
        live,
        isLive: live,
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
    const btts = this._bttsMarkets(e);
    if (btts && btts.length > 0) out.push(...btts);
    const periodWinners = this._periodWinnerMarkets(e);
    if (periodWinners) out.push(...periodWinners);
    return out;
  }

  /**
   * Locate the full-time result market for an event: either 3-way 1X2 or
   * 2-way Match Winner / Moneyline (typeId 1 or 2). Validated as a complete
   * contract with all selections live and priced above 1. A market with a
   * handicap (`sv`) or a non-result name is rejected rather than mislabelled.
   */
  _matchOddsMarket(e) {
    const t = this.tables;
    const candidates = e.marketIds
      .map((id) => t.markets.get(id))
      .filter((m) => m && (m.typeId === MATCH_ODDS_MARKET_TYPE || m.typeId === MONEYLINE_MARKET_TYPE)
        && !m.sv && (m.name === '1x2' || /^(?:1\s*2|12|c[aâ][sș]?tig[aă]tor(?:\s+meci)?|winner|match winner|money\s*line|head to head|h2h)$/i.test(m.name)));
    for (const m of candidates) {
      const parsed = this._parseMatchOdds(e, m);
      if (parsed && parsed.key === '1x2') return parsed;
    }
    for (const m of candidates) {
      const parsed = this._parseMatchOdds(e, m);
      if (parsed && parsed.key === 'MATCH_ODDS') return parsed;
    }
    return null;
  }

  _parseMatchOdds(e, m) {
    const t = this.tables;
    const [homeId, awayId] = e.competitorIds;
    const odds = (m.oddIds || []).map((id) => t.odds.get(id)).filter(Boolean);
    if (odds.length !== (m.oddIds || []).length) return null;
    for (const o of odds) {
      if (o.oddStatus !== 0 || !Number.isFinite(o.price) || o.price <= 1) return null;
    }

    if (odds.length === 3) {
      const byType = new Map();
      for (const o of odds) {
        if (!OUTCOME_LABELS.has(o.typeId) || byType.has(o.typeId)) return null;
        byType.set(o.typeId, o);
      }
      const homeOdd = byType.get(1);
      const drawOdd = byType.get(2);
      const awayOdd = byType.get(3);
      if (!homeOdd || !drawOdd || !awayOdd) return null;
      if (homeOdd.competitorId !== homeId || awayOdd.competitorId !== awayId) return null;
      if (drawOdd.competitorId !== undefined && drawOdd.competitorId !== null) return null;
      const selections = [
        { id: String(homeOdd.id), providerOutcomeId: homeOdd.typeId, name: '1', odds: homeOdd.price, handicap: null },
        { id: String(drawOdd.id), providerOutcomeId: drawOdd.typeId, name: 'X', odds: drawOdd.price, handicap: null },
        { id: String(awayOdd.id), providerOutcomeId: awayOdd.typeId, name: '2', odds: awayOdd.price, handicap: null },
      ];
      if (new Set(selections.map((s) => s.id)).size !== 3) return null;
      return { key: '1x2', providerMarketId: String(m.id), name: m.name, period: 'fulltime', selections };
    }

    if (odds.length === 2 && m.name !== '1x2') {
      const homeOdd = odds.find((o) => o.competitorId === homeId);
      const awayOdd = odds.find((o) => o.competitorId === awayId);
      if (!homeOdd || !awayOdd || homeOdd.id === awayOdd.id) return null;
      const selections = [
        { id: String(homeOdd.id), providerOutcomeId: homeOdd.typeId, name: '1', odds: homeOdd.price, handicap: null },
        { id: String(awayOdd.id), providerOutcomeId: awayOdd.typeId, name: '2', odds: awayOdd.price, handicap: null },
      ];
      return { key: 'MATCH_ODDS', providerMarketId: String(m.id), name: m.name, period: 'fulltime', selections };
    }

    return null;
  }

  _periodWinnerMarkets(e) {
    const t = this.tables;
    const out = [];
    const seenKeys = new Set();
    const candidates = (e.marketIds || [])
      .map((id) => t.markets.get(id))
      .filter((m) => m && (m.typeId === MATCH_ODDS_MARKET_TYPE || m.typeId === MONEYLINE_MARKET_TYPE) && !m.sv);
    for (const m of candidates) {
      const period = extractPeriodFromName(m.name);
      if (!period || period === 'fulltime') continue;
      const parsed = this._parsePeriodMatchOdds(e, m, period);
      if (parsed) {
        const dedupeKey = `${parsed.key}:${parsed.period}`;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          out.push(parsed);
        }
      }
    }
    return out;
  }

  _parsePeriodMatchOdds(e, m, period) {
    const t = this.tables;
    const [homeId, awayId] = e.competitorIds;
    const odds = (m.oddIds || []).map((id) => t.odds.get(id)).filter(Boolean);
    if (odds.length !== (m.oddIds || []).length) return null;
    for (const o of odds) {
      if (o.oddStatus !== 0 || !Number.isFinite(o.price) || o.price <= 1) return null;
    }

    if (odds.length === 3) {
      const byType = new Map();
      for (const o of odds) {
        if (!OUTCOME_LABELS.has(o.typeId) || byType.has(o.typeId)) return null;
        byType.set(o.typeId, o);
      }
      const homeOdd = byType.get(1);
      const drawOdd = byType.get(2);
      const awayOdd = byType.get(3);
      if (!homeOdd || !drawOdd || !awayOdd) return null;
      if (homeOdd.competitorId !== homeId || awayOdd.competitorId !== awayId) return null;
      if (drawOdd.competitorId !== undefined && drawOdd.competitorId !== null) return null;
      const selections = [
        { id: String(homeOdd.id), providerOutcomeId: homeOdd.typeId, name: '1', odds: homeOdd.price, handicap: null },
        { id: String(drawOdd.id), providerOutcomeId: drawOdd.typeId, name: 'X', odds: drawOdd.price, handicap: null },
        { id: String(awayOdd.id), providerOutcomeId: awayOdd.typeId, name: '2', odds: awayOdd.price, handicap: null },
      ];
      if (new Set(selections.map((s) => s.id)).size !== 3) return null;
      return { key: '1x2', providerMarketId: String(m.id), name: m.name, period, selections };
    }

    if (odds.length === 2) {
      const homeOdd = odds.find((o) => o.competitorId === homeId);
      const awayOdd = odds.find((o) => o.competitorId === awayId);
      if (!homeOdd || !awayOdd || homeOdd.id === awayOdd.id) return null;
      const selections = [
        { id: String(homeOdd.id), providerOutcomeId: homeOdd.typeId, name: '1', odds: homeOdd.price, handicap: null },
        { id: String(awayOdd.id), providerOutcomeId: awayOdd.typeId, name: '2', odds: awayOdd.price, handicap: null },
      ];
      let key = 'MATCH_ODDS';
      if (period.startsWith('set')) key = 'SET_WINNER';
      else if (period.startsWith('q')) key = 'QUARTER_WINNER';
      return { key, providerMarketId: String(m.id), name: m.name, period, selections };
    }

    return null;
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
    const seenKeys = new Set();
    const isBasketball = e.sportId === 67;
    const isTennis = e.sportId === 68;
    const subject = isBasketball ? 'points' : (isTennis ? 'games' : 'goals');
    const defaultKey = isBasketball
      ? 'TOTAL_POINTS'
      : (isTennis ? 'TOTAL_GAMES' : 'TOTAL_GOALS');
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
      const lineNum = Number(line);
      const key = isBasketball && Number.isFinite(lineNum) && lineNum % 1 === 0.5
        ? `POINTS_OVER_UNDER_${String(lineNum).replace('.', '_')}`
        : defaultKey;
      const period = extractPeriodFromName(m.name) || 'fulltime';
      const dedupeKey = `${period}:${line}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      out.push({ key, subject, providerMarketId: String(m.id), name: m.name, period, line, selections });
    }
    return out;
  }

  /**
   * Every both-teams-to-score market this event publishes, one market per window.
   */
  _bttsMarkets(e) {
    const t = this.tables;
    const out = [];
    const seenKeys = new Set();
    for (const m of (e.marketIds || []).map((id) => t.markets.get(id))) {
      if (!m || m.typeId !== BTTS_MARKET_TYPE) continue;
      const byType = this._completePair(m, BTTS_LABELS);
      if (!byType) continue;
      const period = extractPeriodFromName(m.name) || 'fulltime';
      if (seenKeys.has(period)) continue;
      seenKeys.add(period);
      // The engine's BTTS matcher accepts the Romanian spellings directly;
      // keeping them is what makes the market recognisable.
      const selections = [74, 76].map((typeId) => ({
        id: String(byType.get(typeId).id),
        providerOutcomeId: typeId,
        name: BTTS_LABELS.get(typeId) === 'yes' ? 'Da' : 'Nu',
        odds: byType.get(typeId).price,
        handicap: null,
      }));
      out.push({ key: 'BTTS', providerMarketId: String(m.id), name: m.name, period, selections });
    }
    return out;
  }

  /** The full-time both-teams-to-score market, or null when absent/unusable. */
  _bttsMarket(e) {
    const all = this._bttsMarkets(e);
    return all.find((m) => m.period === 'fulltime') || all[0] || null;
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
   *
   * FOUR OF THE SIX TENANTS PUBLISH NO FOOTBALL HANDICAP AT ALL. Measured
   * 2026-10-02 over each tenant's whole board: don and topbet serve type 16 and
   * reach five contract lines between them, while million (204 events),
   * baumbet (205), powerbet (202) and winbet (202) serve three market shapes
   * each — 1x2, totals and BTTS — and no handicap market on any of them. The
   * adapter published everything those four feeds sent and withheld nothing, so
   * the absence is the feed's, not this reader's.
   *
   * Those four also quote the SAME prices on the same markets, which is what
   * groups them as one independent source in feed-groups.mjs: BTTS reads
   * Da 1.6 / Nu 2.2 and the totals read Peste 2.5 1.7 / Sub 2.5 2.05 on all
   * four. don and topbet are in the same group, so that grouping is about the
   * platform, and a handicap appearing on two of the six does not make them
   * independent of each other.
   */
  _handicapMarkets(e) {
    const t = this.tables;
    const out = [];
    const seenKeys = new Set();
    const [homeId, awayId] = e.competitorIds;
    const isBasketball = e.sportId === 67;
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
      const period = extractPeriodFromName(m.name) || 'fulltime';
      const dedupeKey = `${period}:${homeLine}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      out.push({ key: isBasketball ? 'POINT_SPREAD' : 'ASIAN_HANDICAP', providerMarketId: String(m.id), name: m.name, period, line: homeLine, selections });
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

  /**
   * The families this run actually emitted, not the union this class can read.
   *
   * This used to be the literal 'fulltime-1x2+tgoals+asian_handicap+btts' for
   * all six tenants, which promised million, baumbet, powerbet and winbet a
   * football handicap that none of them serves — measured 2026-10-02, all four
   * send three market shapes and no type-16 market on any of their 200+ events,
   * while don and topbet do send it. nsoft.mjs records the identical defect
   * being fixed for betmen, where a hardcoded union claimed totals and
   * handicaps a tenant does not publish; a coverage string that overstates is
   * the same wrong claim in a different field, and it is the field an operator
   * reads to decide whether a book is worth keeping.
   *
   * Deriving it from the emitted events means the string cannot outrun the run:
   * a tenant whose board carries no handicap reports no handicap, and the day it
   * starts carrying one the string says so with no code change. A thin day
   * understates rather than overstates, which is the right way to be wrong.
   */
  _serializable(events, raw) {
    const seen = new Set();
    for (const e of events || []) {
      for (const m of e.markets || []) seen.add(m.key);
    }
    const families = ['fulltime-1x2'];
    if (seen.has('TOTAL_GOALS')) families.push('tgoals');
    if (seen.has('ASIAN_HANDICAP')) families.push('asian_handicap');
    if (seen.has('BTTS')) families.push('btts');
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl, transport: TRANSPORT,
      observedAt: this.observedAt, integration: this.id, attributionStatus: 'public-integration-unverified-brand',
      coverage: { sport: 'football', market: families.join('+'), ...liveCoverageFor(this.id), page: 1, exhaustive: false,
        maxEvents: this.maxEvents, windowHours: this.windowHours, requiresCountryIso: true } };
  }
}

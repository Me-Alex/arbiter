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
 * tenants, which agree on these typeIds.
 */
const FOOTBALL_SPORT_ID = 66;

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
 */
const MATCH_ODDS_MARKET_TYPE = 1;
const TOTALS_MARKET_TYPE = 18;
const BTTS_MARKET_TYPE = 29;

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

    // One bounded read of the football feed. These tenants expose a
    // per-sport catalogue and only football full-time 1X2 is a verified
    // contract, so we ask for exactly that instead of fanning out over every
    // sport and discarding the ones we cannot interpret. `redirect: 'error'`
    // above keeps the read on the declared host.
    const eventCount = Math.min(this.maxEvents, 100);
    const url = `${UPCOMING_BASE}?culture=ro-RO&timezoneOffset=-180&deviceType=1`
      + `&numFormat=en-GB&countryCode=RO&sportId=${FOOTBALL_SPORT_ID}`
      + `&eventCount=${eventCount}&page=1&integration=${this.id}`;
    const data = await fetchJson(url);
    this.observedAt = new Date().toISOString();
    return { ...data, _sportNames: { [FOOTBALL_SPORT_ID]: 'Football' } };
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
      coverage: { sport: 'football', market: 'fulltime-1x2+tgoals+btts', live: false, page: 1, exhaustive: false,
        maxEvents: this.maxEvents, windowHours: this.windowHours, requiresCountryIso: true } };
  }
}

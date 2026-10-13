import ScraperBase from './base.mjs';
import { normalizeTeamName, canonicalSport } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { superbetEventIsLive, markMarketsLive, liveCoverageFor } from './live-status.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

const HOST = 'https://production-superbet-offer-ro.freetls.fastly.net';

/** Map a provider sport label onto the canonical sport id used everywhere else. */
function canonicalSportKey(label) {
  return canonicalSport(String(label || '').trim().toLowerCase());
}

/** Superbet sport ID → human-readable name. */
const SPORT_NAMES = {
  5: 'Football', 2: 'Tennis', 75: 'eSport-Football', 4: 'Basketball',
  55: 'Counter-Strike 2', 24: 'Table Tennis', 11: 'Handball', 1: 'Volleyball',
  70: 'eSport-Basketball', 3: 'Ice Hockey', 91: 'F1', 20: 'Baseball',
  12: 'American Football', 13: 'Darts', 39: 'League of Legends', 54: 'Dota 2',
  6: 'Snooker', 40: 'MMA', 34: 'Boxing', 28: 'Beach Volleyball',
  8: 'Rugby', 19: 'Australian Football', 15: 'Water Polo', 14: 'Badminton',
  32: 'Cricket', 17: 'Futsal', 93: 'Motorsport', 157: 'eSport-Hockey',
  189: 'eSport-Tennis', 9: 'Floorball', 35: 'Chess', 25: 'Cycling',
  7: 'Bandy', 44: 'Athletics', 16: 'Golf', 61: 'Call of Duty',
  80: 'Rainbow Six', 53: 'Overwatch', 10: 'Winter Sports',
  29: 'Field Hockey', 38: 'Squash', 27: 'Beach Soccer', 30: 'Padel Tennis',
};

/**
 * Public v3 schema verified against the Romanian feed; multi-sport prematch.
 *
 * On totals and BTTS: this reader is generic — it maps every market the payload
 * carries, by line group — so it is not what limits Superbet to the result
 * market. The public INDEX is. Captured 2026-09-29, the `active-prematch` and
 * `active` projections (and the 141-market count the event advertises in
 * `inplay_stats_metadata`) both return exactly one market per event, the
 * featured result market ("Final", or a sport-specific winner such as
 * "Câștigător"); `all-prematch` is not a usable third reading, answering HTTP
 * 400 rather than a payload. No goals total or both-teams-to-score appears on
 * the public index.
 *
 * The per-event surface `/v2/ro-RO/events/{eventId}` is where the rest of the
 * slate lives — the same event advertises `marketCount: 141` (1,400 odds) on the
 * detail read against 1 market on the index. So the index is a lobby listing,
 * not the offer, and the two markets below are read from the detail payload
 * rather than by reading the index differently. The detail call costs one
 * ~750 KB request per event, so it is capped and off by default, like Unibet's
 * `fullMarkets`.
 *
 * Superbet publishes no plain full-time both-teams-to-score at all, which is
 * why BTTS is absent from the list below and is not merely unmeasured: over a
 * four-event census of 2,632 distinct (marketId, marketName) pairs, every
 * "Ambele echipe marchează" is inside a `231194` system bet whose name joins
 * several legs with ";", and the standalone BTTS-shaped markets are all
 * per-period (`200751` "GG în oricare repriză", `200772` "GG în prima
 * repriză/a doua repriză") — "GG in any half" settles on a different event than
 * a full-time GG and is not the same contract.
 */
/**
 * The superbet markets this reader publishes from the per-event detail payload,
 * keyed by the provider's own `marketId` AND its exact `marketName`.
 *
 * The pair, not the id, is the contract. Measured 2026-09-29 over a four-event
 * census of 2,632 distinct (marketId, marketName) pairs, the same id names
 * different contracts depending on the fixture:
 *
 *   200734 "Total goluri"        full-time goals total      -> OVER_UNDER
 *   200735 "Prima repriză - Total goluri"   first-half goals total -> OVER_UNDER
 *   200738 "A doua repriză - Total goluri"  second half     -> not ours
 *   200736 "Handicap"            full-time spread           -> ASIAN_HANDICAP
 *   200737 / 200739             the same spread, per half  -> not ours
 *
 * 535 is the sharper case: it is "Total goluri <Team>", a single team's goal
 * total, and the team changes the name event to event. Keying on the id alone
 * would read a team total as the match total — the exact subject collision the
 * OVER_UNDER contract, which carries no subject dimension, cannot express.
 *
 * Two Superbet markets that LOOK like the ones above are deliberately absent,
 * and this is measured, not assumed. Over 30 football events:
 *
 *   530 "Handicap asiatic"      198 line pairs, 22 magnitudes, 0 on a half line
 *   529 "Total goluri asiatice"  207 line pairs, 13 magnitudes, 0 on a half line
 *
 * Both are published only on whole, quarter and zero lines, where a draw of the
 * margin returns the stake instead of settling it, so the two sides are not
 * jointly exhaustive. A "surebet" on them books a partial stake return as a
 * profit. 200736 covers the same contract: measured 158 of 158 line pairs on a
 * half line, which is the only shape the engine is allowed to pair.
 */
const DETAIL_MARKETS = new Map([
  ['200734|Total goluri', 'OVER_UNDER'],
  ['200735|Prima repriză - Total goluri', 'OVER_UNDER'],
  ['200736|Handicap', 'ASIAN_HANDICAP'],
  ['539|Ambele echipe marchează (GG)', 'BTTS'],
  ['200734|Liczba goli', 'OVER_UNDER'],
  ['200735|1.połowa - liczba goli', 'OVER_UNDER'],
  ['539|Obie drużyny strzelą', 'BTTS'],
]);

/** The provider's key for one (marketId, marketName) pair, as emitted. */
const detailKey = (marketId, marketName) => `sb:${marketId}:${marketName}`;

/**
 * Superbet's handicap leg is "<Team> (<line>)" — the team name carries the
 * side and the bracket carries the line. The engine keys a two-way handicap by
 * the DIRECTED line from home's perspective, because a provider publishes both
 * "home gives 1.5" and "home receives 1.5" as separate markets, and they settle
 * on opposite outcomes. Left as team names, both collapse onto the same
 * unordered key and the engine pairs home -1.5 against away -1.5 — two legs
 * that both pay only when their own team wins by two, which is neither
 * exclusive of nor exhaustive with anything.
 *
 * So the side is resolved here, against the two teams the index already gave
 * us, and written as the "1 (...)" / "2 (...)" shape every other adapter in
 * this codebase emits. Returns null when neither team matches: a handicap this
 * adapter cannot name the sides of is dropped rather than published with a key
 * that would merge it with its own reciprocal.
 */
const SIDE_LINE = /^(.*?)\s*\(\s*([+-]?\d+(?:[.,]\d+)?)\s*\)\s*$/;

function sideTokenFor(name, teams) {
  const m = SIDE_LINE.exec(String(name || '').trim());
  if (!m || !teams) return null;
  const who = normalizeTeamName(m[1]);
  if (!who) return null;
  if (who === teams[0]) return `1 (${m[2]})`;
  if (who === teams[1]) return `2 (${m[2]})`;
  return null;
}

/**
 * One market per market line, for the two families in DETAIL_MARKETS.
 *
 * The detail payload groups by `marketUuid` — one uuid is one line of one
 * market ("Sub 2.5" + "Peste 2.5" is a line; "Sub 3.5" + "Peste 3.5" is
 * another) — so a multi-line market arrives as many groups under one
 * marketId. Emitting one market per group is what keeps OVER 2.5 from sharing a
 * bucket with OVER 3.5.
 *
 * This is also where the line is attached to the SELECTION rather than the
 * market, and that is deliberate: the two sides of a spread carry opposite
 * signed lines ("Belgia (-1.5)" / "Turcia (1.5)"), so stamping one line on both
 * legs is the netbet bug — `findMiddles` does not compare sides, and a market
 * would pair with itself.
 *
 * Only `status: "active"` legs are kept. The detail payload uses the string
 * form, unlike the index's numeric `status`, and publishes suspended legs
 * inline — measured `active` and `block` on the same 200734 market.
 *
 * `teams` is the [home, away] pair from the index, already normalised. It is
 * what lets the handicap legs be re-labelled with a side; see sideTokenFor.
 */
function marketsFromDetail(odds, teams, sport = 'football') {
  if (!Array.isArray(odds)) return [];
  const wanted = new Map();
  for (const o of odds) {
    let family = DETAIL_MARKETS.get(`${o?.marketId}|${o?.marketName}`);
    let team = undefined;
    const mid = String(o?.marketId || '');
    if (!family) {
      if (mid === '544') { family = 'OVER_UNDER'; team = 'home'; }
      else if (mid === '535') { family = 'OVER_UNDER'; team = 'away'; }
      else if (mid === '2529') { family = 'OVER_UNDER'; team = 'home'; }
      else if (mid === '2531') { family = 'OVER_UNDER'; team = 'away'; }
      else if (mid === '201506') { family = 'OVER_UNDER'; team = 'home'; }
      else if (mid === '201507') { family = 'OVER_UNDER'; team = 'away'; }
    }
    if (!family) continue;
    if (o.status !== 'active' || o.offerStateId !== 1) continue;
    let name = String(o.name || '').trim();
    const price = Number(o.price);
    if (!name || !Number.isFinite(price) || price <= 1 || !o.uuid || !o.marketUuid) continue;
    if (family === 'ASIAN_HANDICAP') {
      name = sideTokenFor(name, teams);
      // Drop the leg rather than the market's other half: an unlabelled leg
      // has no side, and a spread with only one keyed leg is the shape that
      // merges with the reciprocal line.
      if (!name) continue;
    } else if (family === '1X2') {
      const norm = normalizeTeamName(name);
      if (teams && norm === teams[0]) {
        name = '1';
      } else if (teams && norm === teams[1]) {
        name = '2';
      } else if (/^(egal|egalitate|draw|x|remis)$/i.test(norm) || name.toUpperCase() === 'X') {
        name = 'X';
      } else {
        continue;
      }
    } else if (family === 'BTTS') {
      const lower = name.toLowerCase();
      if (lower === 'tak' || lower === 'da') name = 'Da';
      else if (lower === 'nie' || lower === 'nu') name = 'Nu';
    }
    const k = `${o.marketId}|${o.marketName}|${o.marketUuid}`;
    if (!wanted.has(k)) wanted.set(k, { family, marketId: o.marketId, marketName: o.marketName, team, selections: [] });
    wanted.get(k).selections.push({ id: o.uuid, name, odds: price, handicap: null });
  }
  const out = [];
  const s = String(sport || '').toLowerCase();
  for (const m of wanted.values()) {
    // Both sides or nothing: a half-line pair is a contract, and one surviving
    // leg of it is an orphan the engine would hold open against nothing.
    // 1X2 requires all 3 sides (1, X, 2).
    if (m.family === '1X2') {
      if (m.selections.length !== 3) continue;
    } else {
      if (m.selections.length !== 2) continue;
    }
    let subject;
    if (s === 'basketball') subject = 'points';
    else if (s === 'tennis') subject = 'games';
    else if (m.family === 'OVER_UNDER') subject = 'goals';

    out.push({
      key: detailKey(m.marketId, m.marketName),
      // The exact-name gate decides which provider contracts are safe to emit.
      // First-half goals totals are a different settlement window from full-time
      // goals, so write that fact explicitly instead of relying on a downstream
      // label parser to correct a full-time default.
      name: m.marketName,
      period: extractPeriodFromName(m.marketName) || (
        (String(m.marketId) === '2529' || String(m.marketId) === '2531') ? 'half1'
          : (String(m.marketId) === '201506' || String(m.marketId) === '201507') ? 'half2'
            : 'fulltime'
      ),
      family: m.family === '1X2' ? 'MATCH_ODDS' : m.family,
      team: m.team,
      ...(subject ? { subject } : {}),
      selections: m.selections,
    });
  }
  return out;
}

export default class SuperbetScraper extends ScraperBase {
  id = 'superbet';
  name = 'Superbet';
  sourceIds = ['superbet'];
  maxAttempts = 1;

  constructor(opts = {}) {
    super(opts);
    this.host = opts.host || HOST;
    this.locale = opts.locale || 'ro-RO';
    if (opts.id) this.id = opts.id;
    if (opts.name) this.name = opts.name;
    if (opts.sourceIds) this.sourceIds = opts.sourceIds;
    this.runId ||= new Date().toISOString();
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    // The detail payload is ~750 KB of JSON per event (85 KB gzipped), so the
    // 15 s the index calls were tuned for is a thin margin on a full response.
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.maxEvents = opts.maxEvents === 'all' ? Infinity : Number(opts.maxEvents ?? Infinity);
    if ((!Number.isInteger(this.maxEvents) && this.maxEvents !== Infinity) || this.maxEvents < 0) {
      throw new ValidationError(`${this.id}: maxEvents must be a non-negative integer`);
    }
    this.sport = opts.sport || 'all';
    // A filter is only applied when the caller actually asked for one sport;
    // 'all' means "no filter", not "filter to the literal sport 'all'".
    this.sportFilter = this.sport && this.sport !== 'all' ? canonicalSportKey(this.sport) : null;
    this.includePast = opts.includePast === true;
    this.windowHours = opts.windowHours ?? 168;
    // Deep mode costs one detail request per event, on top of the index read.
    // It is the difference between Superbet contributing a single result
    // market and Superbet contributing goals totals and handicaps, so it is
    // configured per job rather than hardcoded on.
    this.fullMarkets = Boolean(opts.fullMarkets ?? opts.jobConfig?.fullMarkets);
    this.detailLimit = String(opts.detailLimit ?? opts.jobConfig?.detailLimit ?? '').toLowerCase() === 'all'
      ? Infinity
      : Number.isInteger(opts.detailLimit)
        ? opts.detailLimit
        : Number.isInteger(opts.jobConfig?.detailLimit)
          ? opts.jobConfig.detailLimit
          : this.maxEvents;
    if ((!Number.isInteger(this.detailLimit) && this.detailLimit !== Infinity) || this.detailLimit < 0) {
      throw new ValidationError(`${this.id}: invalid detailLimit`);
    }
    this.concurrency = Math.max(1, Number(opts.concurrency ?? opts.jobConfig?.concurrency ?? 4));
    // The feed publishes in-play events and names them, so the flag is honoured
    // here instead of being answered with a warning that it was unsupported.
    this.includeLive = opts.includeLive === true;
  }


  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    const bounded = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, bounded]) : bounded;
    const start = new Date();
    start.setUTCMinutes(0, 0, 0);
    const windowHours = Number(this.windowHours ?? 168);
    const url = new URL(`${this.host}/v3/${this.locale}/events`);
    url.search = new URLSearchParams({
      index: this.includeLive ? 'active-live' : 'active-prematch',
      startDate: start.toISOString(),
      endDate: new Date(+start + windowHours * 3600000).toISOString(),
    });
    this.sourceUrl = url.href;
    const get = async (address) => {
      requestSignal.throwIfAborted();
      const response = await this.fetchImpl(address, { signal: requestSignal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new UpstreamError(`${this.id}: HTTP ${response.status} on ${address}`, { status: response.status });
      if (!response.headers.get('content-type')?.includes('json')) {
        throw new ValidationError(`${this.id}: expected public JSON, received non-JSON response`);
      }
      return response.json();
    };
    if (this.maxEvents === 0) return { events: [] };
    const raw = await get(url.href);
    this.normalize(raw);
    // Widen the window only while the event cap still has room. The feed is
    // paginated by time, so a cap of 1 must not pay for four 168h reads.
    for (let w = 1; w < 4 && raw.events.length < this.maxEvents; w++) {
      const wUrl = new URL(`${this.host}/v3/${this.locale}/events`);
      wUrl.search = new URLSearchParams({
        index: 'active-prematch',
        startDate: new Date(+start + w * windowHours * 3600000).toISOString(),
        endDate: new Date(+start + (w + 1) * windowHours * 3600000).toISOString(),
      });
      try {
        const raw2 = await get(wUrl.href);
        if (Array.isArray(raw2?.events)) raw.events.push(...raw2.events);
      } catch { /* window is optional */ }
    }
    const structure = await get(`${this.host}/v2/${this.locale}/struct`);
    if (!Array.isArray(structure?.data?.tournaments)) {
      throw new ValidationError(`${this.id}: structure missing data.tournaments`);
    }
    this.tournaments = new Map(structure.data.tournaments.map((t) => [String(t.id), t.localNames?.[this.locale] || t.localNames?.['ro-RO'] || t.localNames?.['pl-PL'] || t.name]));
    if (this.fullMarkets) await this._enrichMarkets(raw.events, get, requestSignal);
    requestSignal.throwIfAborted();
    this.observedAt = new Date().toISOString();
    return raw;
  }

  /**
   * One detail request per event, capped at `detailLimit` and ranked by the
   * scan's sport filter first — the same partition Unibet's deep pass makes,
   * and for the same reason: the feed is multi-sport, so an uncapped pass
   * spends its whole budget on sports the scan never reads.
   *
   * Failures are per-event and swallowed. A single 404 or truncated body must
   * not cost the run the index it already has; the event simply keeps its
   * index-only markets, which is the pre-deep-mode behaviour.
   *
   * The cap is the smaller of `detailLimit` and `maxEvents` because the feed's
   * index runs to thousands of events while the run emits at most `maxEvents`
   * of them: enriching past the emit cap pays ~750 KB per event for markets
   * that are then thrown away with the event.
   */
  async _enrichMarkets(events, get, signal) {
    const rank = (e) => {
      if (!this.sportFilter) return 0;
      return canonicalSportKey(SPORT_NAMES[e?.fixture?.sport_id] || '') === this.sportFilter ? 0 : 1;
    };
    const budget = Math.min(this.detailLimit, this.maxEvents);
    const candidates = (events || [])
      .filter((e) => e?.event_id && rank(e) === 0)
      .map((e, i) => ({ e, i }))
      .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
      .slice(0, budget);
    let enriched = 0;

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, candidates.length || 1) }, async () => {
        while (candidates.length) {
          signal?.throwIfAborted();
          const { e } = candidates.shift();
          let page;
          try {
            page = await get(`${this.host}/v2/${this.locale}/events/${encodeURIComponent(e.event_id)}`);
          } catch (err) {
            // A cancelled run is not a per-event failure. A timeout, a 404 and
            // a truncated body are: the event keeps its index-only markets,
            // which is exactly the pre-deep-mode behaviour.
            if (err?.name === 'AbortError') throw err;
            continue;
          }
          const detail = Array.isArray(page?.data) ? page.data[0] : page?.data;
          // The index already split the fixture into its two teams, and those
          // are the names the handicap legs are written against.
          const names = e.fixture?.event_name?.split('·').map((s) => normalizeTeamName(s.trim()));
          const teams = names?.length === 2 && names.every(Boolean) ? names : null;
          const sportName = SPORT_NAMES[e.fixture?.sport_id] || 'Football';
          const markets = marketsFromDetail(detail?.odds, teams, sportName);
          if (markets.length === 0) continue;
          e._detailMarkets = markets;
          enriched += 1;
        }
      }),
    );
    this.logger('info', `${this.id}: deep markets — ${enriched} events expanded beyond 1X2`);
    return enriched;
  }

  normalize(raw) {
    if (!raw || raw.error || !Array.isArray(raw.events)) {
      throw new ValidationError(`${this.id}: payload missing events array`, { field: 'events' });
    }
    return raw.events;
  }

  extractEvents(rawEvents) {
    const out = [];
    for (const event of rawEvents) {
      if (out.length >= this.maxEvents) break;
      const f = event.fixture;
      // The feed publishes in-play events and names them on
      // `inplay_stats_metadata.status`, which is `NOT_STARTED` until the match
      // begins. That field was read here only to THROW those events away,
      // unconditionally, whatever the caller asked for — so `includeLive` was
      // honoured by warning that it was unsupported. Measured 2026-09-29 22:5x
      // UTC the feed carried 1133 future football fixtures and no started one,
      // so the branch below has not been observed keeping anything; it refuses
      // to claim a live event it cannot see.
      if (f?.offer_state_status?.['1'] !== 1) continue;
      if (!this.includeLive && event.inplay_stats_metadata?.status !== 'NOT_STARTED') continue;
      const teams = f.event_name?.split('·').map((s) => s.trim());
      const date = new Date(f.utc_date);
      const live = superbetEventIsLive(event);
      if (teams?.length !== 2 || teams.some((s) => !s) || !Number.isFinite(+date)
          || (!this.includePast && !live && +date <= Date.now()) || !event.event_id) continue;
      const sportName = SPORT_NAMES[f.sport_id] || 'Unknown';
      // Extract ALL markets with valid odds from the event
      const markets = [];
      for (const m of event.markets || []) {
        if (!Array.isArray(m.odds) || m.odds.length < 2) continue;
        // Group odds by market_line_uuid; each group is one set of outcomes
        const lines = new Map();
        for (const o of m.odds) {
          const lineId = o.metadata?.market_line_uuid || 'default';
          if (!lines.has(lineId)) lines.set(lineId, []);
          lines.get(lineId).push(o);
        }
        for (const [, odds] of lines) {
          const selections = odds
            .map((o) => {
              const name = String(o.metadata?.name || '').trim();
              const price = Number(o.price);
              if (!name || !Number.isFinite(price) || price <= 1) return null;
              if (o.status !== 1 || o.display !== true || o.metadata?.offer_state_id !== 1) return null;
              return { id: o.uuid, name, odds: price, handicap: null };
            })
            .filter(Boolean);
          if (selections.length >= 2) {
            let subject;
            if (sportName === 'Basketball') subject = 'points';
            else if (sportName === 'Tennis') subject = 'games';
            markets.push({
              key: String(m.id),
              name: m.name || `Market ${m.id}`,
              period: extractPeriodFromName(m.name) || 'fulltime',
              ...(subject ? { subject } : {}),
              selections,
            });
          }
        }
      }
      // The deep pass attaches its markets to the raw event (the same way
      // Unibet replaces `contest.propositions` in place), so the index-only
      // path and the detail path stay additive. Checked AFTER the merge: an
      // event whose index market failed validation still has a full slate in
      // the detail payload, and dropping it would throw away the only markets
      // worth having.
      if (Array.isArray(event._detailMarkets)) markets.push(...event._detailMarkets);
      if (markets.length === 0) continue;
      const kickoff = date.toISOString();
      const league = this.tournaments?.get(String(f.tournament_id)) || `Tournament ${f.tournament_id}`;
      // Honour the sport filter. It was stored on the instance and never read,
      // so a run filtered to football still emitted every other sport the feed
      // carried, and they consumed the event cap.
      if (this.sportFilter && canonicalSportKey(sportName) !== this.sportFilter) continue;
      // A live event's markets are live markets; the engine pairs on that flag.
      markMarketsLive(markets, () => live);
      out.push({
        id: String(event.event_id), sourceId: this.id, sport: sportName, league, kickoff,
        homeTeam: teams[0], awayTeam: teams[1], live, isLive: live,
        eventKey: [sportName.toLowerCase(), normalizeTeamName(league), kickoff, ...teams.map(normalizeTeamName)].join('|'),
        // No public per-event page has been verified for this feed; a v2 path on
        // the JSON CDN is not a browseable link, so emit null rather than a URL
        // that dumps raw JSON on the trader.
        sourceUrl: null,
        markets,
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl,
      transport: 'bookmaker-public-json', observedAt: this.observedAt || new Date().toISOString(),
      // Report what was actually collected: the fetch walks up to four
      // `windowHours` windows, not a single 24-hour one, and the sport is
      // whatever the filter selected rather than a hardcoded 'football'.
      coverage: {
        sport: this.sportFilter || 'multi-sport',
        // False means "index only", which is one result market per event. With
        // fullMarkets the run adds the two families the detail payload carries
        // on lines the engine may pair — still not every market, since
        // per-period, team-total, corners/cards and player props are
        // deliberately dropped as un-comparable across books.
        allMarkets: Boolean(this.fullMarkets),
        market: this.fullMarkets ? 'fulltime-1x2+totals+handicap' : 'fulltime-1x2',
        // Measured capability, plus whether this run took its in-play events.
        ...liveCoverageFor(this.id),
        liveCollected: this.includeLive,
        windowHours: this.windowHours * 4,
        maxEvents: this.maxEvents,
        detailLimit: this.fullMarkets ? this.detailLimit : 0,
      } };
  }
}

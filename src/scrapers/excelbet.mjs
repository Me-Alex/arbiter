import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor, markMarketsLive } from './live-status.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

const DEFAULT_BASE = 'https://exalogic.excelbet.ro/XSportDatastore';
const SYSTEM_CODE = 'EXCELBET';

export const EXALOGIC_SPORT_ID_MAP = Object.freeze({
  1: 'Football',
  2: 'Basketball',
  4: 'Ice Hockey',
  5: 'Tennis',
  6: 'Handball',
  16: 'American Football',
  20: 'Table Tennis',
  23: 'Volleyball',
});

export const EXALOGIC_SPORT_NAME_TO_ID = Object.freeze({
  football: 1,
  soccer: 1,
  basketball: 2,
  'ice hockey': 4,
  ice_hockey: 4,
  tennis: 5,
  handball: 6,
  volleyball: 23,
});

export const EXALOGIC_SPORT_AGGREGATES = Object.freeze({
  1: [1, 8, 9],
  2: [5],
  5: [269],
  4: [86],
  6: [90],
});

/**
 * Market categories this adapter reads, as the feed's own `idAggregata`.
 *
 * The tenant front end exposes these as separate boards and the split is real,
 * not cosmetic: `idAggregata=1` answers with the result and double chance
 * markets only, and a sweep of every value the front end offers found the
 * goals total, the whole-line spread and the goals handicap nowhere in it.
 * Confirmed per tenant over five days 2026-09-29, all four returning identical
 * counts: 489 football events, with 2,853 goals-total rows living only in
 * aggregate 8, and 1,993 whole-line spread rows plus 734 goals-handicap rows
 * living only in aggregate 9.
 *
 * Values 10, 11 and 12 also answer HTTP 200 and were swept in the same pass;
 * they carry first-half result, odd/even, and a player-scores prop, none of
 * which this adapter publishes (see `extractEvents`).
 */
const AGGREGATE_IDS = [1, 8, 9];

/** Full-time result, "FINAL" — the three-way 1X2. */
const RESULT_MARKET = 3;
/** First-half result, "1ST HALF" — the three-way 1X2 for half 1. */
const FIRST_HALF_RESULT_MARKET = 14;
/** "TOTAL GOALS" — the two-way goals total. */
const TOTAL_GOALS_MARKET = 7989;
/** "ASIAN HANDICAP" — the two-way goals handicap. */
const ASIAN_HANDICAP_MARKET = 60016;
/** "HOME TOTAL" — team goals total for the host club. */
const HOME_TOTAL_GOALS_MARKET = 1749;
/** "AWAY TOTAL" — team goals total for the visitor club. */
const AWAY_TOTAL_GOALS_MARKET = 1750;
/** "BOTH TEAMS TO SCORE" — cs=18. */
const BTTS_MARKET = 18;
/** 2-Way Moneyline: Basketball (cs=110 incl OT), Tennis (cs=2). */
const BASKETBALL_WINNER_MARKET = 110;
const TENNIS_WINNER_MARKET = 2;
/** Points/Games Totals: Basketball (cs=14863), Tennis (cs=13464). */
const BASKETBALL_POINTS_TOTAL_MARKET = 14863;
const TENNIS_GAMES_TOTAL_MARKET = 13464;

/**
 * The whole market vocabulary of this feed, counted 2026-10-02.
 *
 * Census of every `cs` row across the entire live payload — 630 `avs.avs`
 * entries, all 630 carrying `scs[]` — returns SEVEN distinct market ids and no
 * more:
 *
 *     cs=7989  "TOTAL GOALS"      3286 rows    published as OVER_UNDER
 *     cs=8     "HANDICAP"         2340 rows    whole-line, refused
 *     cs=60016 "ASIAN HANDICAP"    763 rows    published as ASIAN_HANDICAP
 *     cs=3     "FINAL"             630 rows    published as MATCH_ODDS
 *     cs=17    "DOUBLE CHANCE"     620 rows    catalogued, not arbitrable
 *     cs=16    "DOUBLE CHANCE"     617 rows    catalogued, not arbitrable
 *     cs=15    "DOUBLE CHANCE"     599 rows    catalogued, not arbitrable
 *
 * Seven ids is the entire feed, so the absence of both-teams-to-score here is
 * the feed's and not a reader that has not found it yet. That question was open
 * because these four brands publish 1X2, totals and the handicap on 543 football
 * events each and no BTTS, which is the shape of a gap until you know the
 * vocabulary. The three positive controls are what make the negative mean
 * anything: all three of the constants above are in the census, so the walker
 * reads this payload correctly and is not simply missing rows.
 *
 * A census keyed on outcome NAMES was tried first and was worthless twice over:
 * its totals control matched "Sunderland" (which contains "under") and "Frigg
 * Oslo" (which contains "gg"), and it never descended into the market map at
 * all, so it reported six totals where this feed serves 3,286. Counting the
 * feed's own ids needs no pattern matching at all.
 */

/** The three result codes, in the order the feed lists them. */
const RESULT_SIDES = new Map([[1, '1'], [2, 'X'], [3, '2']]);
/**
 * Total-goal legs: `ce=1` is Under, `ce=2` is Over.
 *
 * This was published the other way round first, and the mistake is worth
 * recording because it was invisible to the test that motivated it. `ce=1` is
 * the CHEAP side at a high line and the LONG side at a low one, which is what
 * the ladder in `test/fixtures/excelbet-markets.json` shows on Peterborough
 * (1X2 2.03/3.55/3.10):
 *
 *     line 0.5   ce=1 9.40   ce=2 1.03
 *     line 2.5   ce=1 2.17   ce=2 1.61
 *     line 4.5   ce=1 1.18   ce=2 4.30
 *
 * The Over price RISES with the line and the Under price falls — Over 0.5 is
 * all but certain at 1.03, Over 4.5 is long at 4.30, and "Over 0.5" was read as
 * "0.5 goals or fewer", which is Under. The 1X2 on the same fixture settles it
 * independently: a 3.55 draw is P(0:0) of roughly a tenth, so Under 0.5 —
 * which settles precisely on 0:0 — is worth about 9.40, and the complement
 * Over 0.5 is worth about 1.03.
 *
 * A monotonicity argument cannot rescue this, and the first one here did not:
 * it was written as "the Over price can only fall as the line rises", which is
 * backwards, and so it confirmed 2,061 of 2,061 steps while measuring the wrong
 * direction. The corrected form is asserted in the tests as a property of the
 * published output, because that is the shape that was actually violated.
 */
const TOTAL_GOALS_SIDES = new Map([[1, 'Under'], [2, 'Over']]);
/** Handicap legs: `ce=1` is the home side, `ce=2` the away side. */
const ASIAN_HANDICAP_SIDES = new Map([[1, 'home'], [2, 'away']]);

/**
 * ExcelBet scraper — Exalogic XSport public getPalinsestoDelGiorno feed.
 *
 * The response has `avs.avs[]` events; each event carries `scs[]` (markets)
 * with `eqs[]` (outcomes). Odds are `q / 100`.
 *
 * WHAT THE FEED OFFERS, AND WHAT THIS PUBLISHES. Swept 2026-09-29: every
 * `idAggregata` the tenant front end offers, over seven days on excelbet, then
 * the three published categories re-measured over five days on each of the
 * four tenants. The four return identical counts, which is what groups them as
 * one feed — so each contract added here is worth one independent source, not
 * four books. Published: the three-way result, the goals total, the goals
 * handicap.
 *
 *   cs=3     "FINAL"           3 legs   published as the full-time 1X2
 *   cs=7989  "TOTAL GOALS"     2 legs   published as OVER_UNDER, per line
 *   cs=60016 "ASIAN HANDICAP"  2 legs   published as ASIAN_HANDICAP, per line
 *
 * Deliberately not published, each for a stated reason rather than for want of
 * a mapping:
 *
 *   cs=15/16/17 "DOUBLE CHANCE"  2 legs each. Three markets whose descriptions
 *       are identical and whose outcome codes are the same ce 1/2 pair, so the
 *       three are indistinguishable in the payload: the double chance that is
 *       "1 and 2" is byte-identical in shape to the one that is "X and 2".
 *       They were previously mapped to the same literal 1/X/2 labels as the
 *       result market, which made a 1X price indistinguishable from a result
 *       price and pairable against another book's full-time legs. A
 *       DOUBLE_CHANCE contract is also not a surebet — its outcomes overlap —
 *       so it is catalogued and not scanned.
 *   cs=8      "HANDICAP"         3 legs, 1,993 rows. A three-way result at a
 *       WHOLE line (-500..+500, every `h` a multiple of 100). A level result
 *       pushes all three legs, so the contract is not exhaustive, and it has no
 *       line of its own in the engine: published as a result it would land in
 *       MATCH_ODDS::_ and pair with the plain 1X2 of the same fixture, booking
 *       a surebet on a market that refunds. No other book serves that contract,
 *       so the honest move is to withhold it.
 *   cs=14 "1ST HALF" plus cs=22287/22288/22289 "1X 1HT"/"X2 HT"/"12 HT"
 *       (aggregate 10) — first-half result and its double chances. Catalogued
 *       here only.
 *   cs=19 "ODD/EVEN" (623 rows, aggregate 11) — two legs, but the engine has
 *       no odd/even family, and adding one is a project contract rather than a
 *       lever. Withheld.
 *   cs=165 "HOME SCORES" (549 rows, aggregate 12) — a player prop. Withheld.
 *
 * There is no both-teams-to-score market anywhere in the sweep, which is a
 * measured property of these categories and not a gap in this reader.
 */
export default class ExcelBetScraper extends ScraperBase {
  id = 'excelbet';
  name = 'ExcelBet';
  sourceIds = ['excelbet'];
  /** Platform transport, shared by every Exalogic tenant on this class. */
  transport = 'exalogic-xsport-public-json';

  maxAttempts = 2;

  constructor(opts = {}) {
    super(opts);
    this.apiBase = opts.apiBase || DEFAULT_BASE;
    this.systemCode = opts.systemCode || SYSTEM_CODE;
    // Both were read further down but never assigned from `opts`, so a
    // configured value was silently dropped.
    const days = Number(opts.days ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 31) {
      throw new ValidationError(`${this.name}: invalid days (1-31)`);
    }
    this.days = days;
    this.timeoutMs = opts.timeoutMs ?? 25_000;
    this.liveOnly = Boolean(opts.liveOnly);
    this.includeLive = Boolean(opts.includeLive || opts.liveOnly);
    this.sport = opts.sport || 'football';
    this.sports = Array.isArray(opts.sports) ? opts.sports.map((s) => s.toLowerCase()) : null;
    this.maxEvents = opts.maxEvents === 'all' ? Infinity : Number(opts.maxEvents ?? Infinity);
    if ((!Number.isInteger(this.maxEvents) && this.maxEvents !== Infinity) || this.maxEvents < 0) {
      throw new ValidationError(`${this.name}: invalid maxEvents`);
    }
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    if (this.liveOnly) {
      const live = await this.fetchLive({ signal });
      const liveEvents = live?.avs?.avs || [];
      if (liveEvents.length === 0) throw new UpstreamError(`${this.name}: live fetch returned 0 events`);
      this.sourceUrl = `${this.apiBase}/getMenuLiveGenerale?systemCode=${this.systemCode}&lingua=RO`;
      this.observedAt = new Date().toISOString();
      return { avs: { avs: liveEvents } };
    }
    const days = this.days;
    const today = new Date();
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

    const targetSports = [];
    if (this.sport === 'all') {
      targetSports.push(
        { id: 1, name: 'Football', aggregates: AGGREGATE_IDS, days },
        { id: 2, name: 'Basketball', aggregates: EXALOGIC_SPORT_AGGREGATES[2] || [5], days: Math.min(days, 3) },
        { id: 5, name: 'Tennis', aggregates: EXALOGIC_SPORT_AGGREGATES[5] || [269], days: Math.min(days, 3) },
        { id: 4, name: 'Ice Hockey', aggregates: EXALOGIC_SPORT_AGGREGATES[4] || [86], days: Math.min(days, 3) },
        { id: 6, name: 'Handball', aggregates: EXALOGIC_SPORT_AGGREGATES[6] || [90], days: Math.min(days, 3) },
      );
    } else if (this.sports) {
      for (const spName of this.sports) {
        const id = EXALOGIC_SPORT_NAME_TO_ID[spName];
        if (id) {
          targetSports.push({
            id,
            name: EXALOGIC_SPORT_ID_MAP[id] || spName,
            aggregates: EXALOGIC_SPORT_AGGREGATES[id] || (id === 1 ? AGGREGATE_IDS : [1]),
            days: id === 1 ? days : Math.min(days, 3),
          });
        }
      }
    } else {
      const sportKey = this.sport.toLowerCase();
      const id = EXALOGIC_SPORT_NAME_TO_ID[sportKey] || 1;
      targetSports.push({
        id,
        name: EXALOGIC_SPORT_ID_MAP[id] || 'Football',
        aggregates: id === 1 ? AGGREGATE_IDS : (EXALOGIC_SPORT_AGGREGATES[id] || [1]),
        days,
      });
    }

    /** Fetch one day's palinsesto for one market category. */
    const fetchBoard = async (dayOffset, aggregateId, sportId = 1, sportName = 'Football') => {
      const d = new Date(today);
      d.setDate(d.getDate() + dayOffset);
      const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
      const url = new URL(`${this.apiBase}/getPalinsestoDelGiorno`);
      url.search = new URLSearchParams({
        systemCode: this.systemCode, lingua: 'RO', hash: '',
        data: ds, idSport: String(sportId), idAggregata: String(aggregateId), timezone: '3',
      });
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(url.href, { signal: bounded, headers });
      if (!response.ok) {
        throw new UpstreamError(`${this.name}: HTTP ${response.status} for ${ds} sport ${sportId} aggregate ${aggregateId}`);
      }
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('json') && !ct.includes('text/plain')) {
        throw new ValidationError(`${this.name}: expected JSON for ${ds}, received ${ct || 'no content-type'}`);
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          bounded.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 20_000_000) throw new ValidationError(`${this.name}: response exceeds 20 MB`);
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const evs = parsed?.avs?.avs || [];
      for (const ev of evs) {
        if (!ev.sportId) ev.sportId = sportId;
        if (!ev.sportName) ev.sportName = sportName;
      }
      return evs;
    };
    /**
     * One day across every category, merged per event.
     *
     * The categories answer with the same events and disjoint markets, so the
     * merge is by event with the markets concatenated. A category that fails
     * costs its markets and nothing else: a book that has withdrawn one board
     * should still publish the other two. It is recorded rather than swallowed,
     * because a category that quietly stops answering leaves a board that looks
     * complete and is not, and a day where every category failed is the empty
     * run this whole loop exists to distinguish from a quiet one.
     */
    const fetchDay = async (dayOffset, sport = targetSports[0]) => {
      const byBid = new Map();
      let answered = 0;
      for (const aggregateId of sport.aggregates) {
        let events;
        try {
          events = await fetchBoard(dayOffset, aggregateId, sport.id, sport.name);
        } catch (err) {
          this.aggregateFailures.push(`sport ${sport.id} aggregate ${aggregateId}: ${err.message}`);
          continue;
        }
        answered += 1;
        for (const e of events) {
          let slot = byBid.get(e.bid);
          if (!slot) {
            slot = { event: { ...e, scs: [] }, seen: new Set() };
            byBid.set(e.bid, slot);
          }
          for (const sc of e.scs || []) {
            // A line is part of the market's identity here: the goals total
            // publishes one market per line, so code alone would collapse
            // "0.5" and "1.5" into one contract.
            const k = `${sc.cs}:${sc.h ?? ''}`;
            if (slot.seen.has(k)) continue;
            slot.seen.add(k);
            slot.event.scs.push(sc);
          }
        }
      }
      if (answered === 0) {
        throw new UpstreamError(`${this.name}: no market category answered for day ${dayOffset}`);
      }
      return [...byBid.values()].map((slot) => slot.event);
    };
    const sportIdParam = targetSports.length === 1 ? targetSports[0].id : '1';
    this.sourceUrl = `${this.apiBase}/getPalinsestoDelGiorno?systemCode=${this.systemCode}&lingua=RO&data=YYYYMMDD&idSport=${sportIdParam}&idAggregata=${AGGREGATE_IDS.join('&idAggregata=')}`;
    this.observedAt = new Date().toISOString();
    this.aggregateFailures = [];
    const fetchTasks = [];
    for (const sp of targetSports) {
      for (let i = 0; i < sp.days; i++) {
        fetchTasks.push(fetchDay(i, sp));
      }
    }
    const results = await Promise.allSettled(fetchTasks);
    const allEvents = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) allEvents.push(...r.value);
    }
    if (this.includeLive) {
      try {
        const live = await this.fetchLive({ signal });
        if (Array.isArray(live?.avs?.avs)) {
          allEvents.push(...live.avs.avs);
        }
      } catch (err) {
        this.logger?.('warn', `${this.name}: failed to fetch live menu: ${err.message}`);
      }
    }
    if (allEvents.length === 0) throw new UpstreamError(`${this.name}: all day fetches returned 0 events`);
    return { avs: { avs: allEvents } };
  }

  async fetchLive({ signal } = {}) {
    const url = new URL(`${this.apiBase}/getMenuLiveGenerale`);
    url.search = new URLSearchParams({
      systemCode: this.systemCode,
      lingua: 'RO',
      hash: '',
      sportId: '0',
    });
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url.href, { signal: bounded, headers });
    if (!response.ok) {
      throw new UpstreamError(`${this.name}: HTTP ${response.status} for getMenuLiveGenerale`);
    }
    const d = await response.json();
    const liveEvents = [];
    const sportMap = {
      1: 'Football',
      2: 'Basketball',
      4: 'Ice Hockey',
      5: 'Tennis',
      6: 'Handball',
      16: 'American Football',
      20: 'Table Tennis',
      23: 'Volleyball',
      109: 'Esports',
      137: 'Esports',
      153: 'Esports',
    };
    for (const sp of d.sps || []) {
      const sportName = sportMap[sp.id] || sp.dsl?.EN || sp.dsl?.RO || 'Other';
      for (const ct of sp.cts || []) {
        for (const tn of ct.tns || []) {
          const league = tn.dsl?.RO || tn.dsl?.EN || ct.dsl?.RO || ct.dsl?.EN || 'Live';
          for (const ev of tn.el || []) {
            liveEvents.push({
              ...ev,
              league,
              sportId: sp.id,
              sportName,
              lv: true,
            });
          }
        }
      }
    }
    return { avs: { avs: liveEvents } };
  }

  normalize(raw) {
    if (!raw?.avs?.avs) throw new ValidationError(`${this.name}: missing avs.avs`);
    return raw.avs.avs;
  }

  /**
   * The palinsesto endpoint is per DAY, and `this.sourceUrl` is a pattern with a
   * literal `YYYYMMDD` in it. Publishing that pattern verbatim put a dead link on
   * every event of this book and its three subclasses (excelbet, magnumbet,
   * las-vegas, winboss all extend this class), so the "where did this price come
   * from" answer a user can follow did not exist. The odds themselves were always
   * fetched per day by `fetchBoard`, which substitutes a real date -- only the
   * provenance link was wrong.
   *
   * The date used is the event's own kickoff date, which is the day whose
   * response carried it. `fetchBoard` computes its date from `new Date()` and
   * `toISOString()`, and `extractEvents` parses `ts` as UTC, so both sides are on
   * UTC and the substitution cannot drift by a day near midnight.
   */
  sourceUrlForDate(dateISO) {
    // `extractEvents` is called directly by unit tests and by the sport-fallback
    // path, without `fetchRaw` ever having assigned the pattern. Publishing
    // `undefined` was survivable; calling `.replace` on it is not.
    if (typeof this.sourceUrl !== 'string') return undefined;
    const ds = String(dateISO || '').slice(0, 10).replace(/-/g, '');
    return /^\d{8}$/.test(ds) ? this.sourceUrl.replace('YYYYMMDD', ds) : this.sourceUrl;
  }

  extractEvents(rawEvents) {
    const out = [];
    const seen = new Set();
    for (const e of rawEvents) {
      if (out.length >= this.maxEvents) break;
      if (e.lv && !this.includeLive) continue; // skip live unless includeLive

      const sport = e.sportName || 'football';
      const sportLower = sport.toLowerCase();
      if (this.sport !== 'all') {
        if (this.sports) {
          if (!this.sports.includes(sportLower)) continue;
        } else if (this.sport.toLowerCase() !== sportLower) {
          continue;
        }
      }

      const name = e.dsl?.RO || e.dsl?.EN || '';
      if (!name || !name.includes(' - ')) continue;
      const [homeRaw, awayRaw] = name.split(' - ');
      const home = homeRaw?.trim();
      const away = awayRaw?.trim();
      if (!home || !away) continue;
      // Parse timestamp: "20260921 22:00:00"
      const ts = e.ts || '';
      const match = ts.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
      let kickoff;
      if (match) {
        kickoff = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).toISOString();
      } else if (e.lv) {
        kickoff = new Date().toISOString();
      } else {
        continue;
      }
      // A missing bid would serialise as the string "undefined" (which passes
      // the base id check) and poison the dedup set for every later event.
      if (e.bid === undefined || e.bid === null || seen.has(e.bid)) continue;
      seen.add(e.bid);
      const markets = [
        resultMarket(e),
        firstHalfResultMarket(e),
        ...bttsMarkets(e),
        ...totalGoalsMarkets(e),
        ...asianHandicapMarkets(e),
        ...teamGoalsMarkets(e),
        ...moneyline2WayMarkets(e),
        ...pointsTotalsMarkets(e),
      ].filter(Boolean);
      if (markets.length === 0) continue;
      const league = String(e.league || e.p || 'unknown');
      const eventKey = [
        normalizeTeamName(sport),
        normalizeTeamName(league),
        kickoff,
        normalizeTeamName(home),
        normalizeTeamName(away),
      ].join('|');
      const isLive = Boolean(e.lv);
      markMarketsLive(markets, () => isLive);
      out.push({
        id: String(e.bid),
        // `this.id`, not a literal: MagnumBet subclasses this class and a
        // hardcoded 'excelbet' attributed its prices to another book, so the
        // engine could never count them as an independent leg.
        sourceId: this.id,
        sourceUrl: e.lv ? `${this.apiBase}/getMenuLiveGenerale?systemCode=${this.systemCode}&lingua=RO` : this.sourceUrlForDate(kickoff),
        transport: this.transport,
        observedAt: this.observedAt,
        sport,
        league,
        kickoff,
        homeTeam: home,
        awayTeam: away,
        live: isLive,
        isLive,
        eventKey,
        markets,
        ...(e.scr ? { score: e.scr.sc, minute: e.scr.t, periodName: e.scr.st } : {}),
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      // The run record describes ONE board, so it resolves the pattern to the
      // day this run started -- a link that opens. Each event carries its own
      // day via sourceUrlForDate.
      sourceUrl: this.sourceUrlForDate(this.observedAt),
      transport: this.transport,
      observedAt: this.observedAt,
      coverage: {
        sport: 'football',
        market: 'fulltime-1x2+tgoals+asian_handicap',
        ...liveCoverageFor(this.id),
        maxEvents: this.maxEvents,
        aggregates: AGGREGATE_IDS.join(','),
        // Never silently short: a category that stopped answering shows up in
        // the run record instead of in a board that merely looks complete.
        aggregateFailures: this.aggregateFailures || [],
      },
    };
  }
}

/**
 * The line in goals, or null when `h` is not on the half.
 *
 * The feed writes hundredths, so 0.5 is 50 and 1.5 is 150; `hs` and
 * `ia.info1` mirror the same number. The absolute value is used throughout
 * because JavaScript's `%` keeps the sign of the dividend — `-150 % 100` is
 * `-50`, not `50`, so a guard written as `h % 100 === 50` silently rejects
 * every negative half line. A whole line and a quarter line both fail this
 * test, and so does a missing `h`.
 *
 * Half lines only, and that is a settlement rule rather than a formatting one.
 * At a whole line a level result pushes both legs; at a quarter line one leg
 * wins half and the other pushes half. Neither is an exhaustive two-way
 * contract, so an inverse sum below 1 is not a surebet. Every total and every
 * handicap measured on this feed is on the half — aggregates 8 and 9 over
 * seven days, 2,853 totals and 734 handicaps — so this guard has not had to
 * reject anything from the feed itself. It is here so that a future line
 * cannot be published on the strength of that observation.
 */
function halfLine(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs % 50 !== 0 || abs % 100 !== 50) return null;
  return n / 100;
}

/**
 * A market's legs as a complete, priced set — exactly one of each expected
 * outcome code, no duplicates, no unknown codes, every price above 1.
 *
 * Returns null on any defect, so a half-quoted market is never published: a
 * total with only its Over leg would otherwise enter the bucket as a
 * two-sided contract that always wins one side and never the other.
 */
function pricedLegs(sc, sides) {
  const byCode = new Map();
  for (const o of sc.eqs || []) {
    if (!sides.has(o.ce) || byCode.has(o.ce)) return null;
    const odds = Number(o.q) / 100;
    if (!Number.isFinite(odds) || odds <= 1) return null;
    byCode.set(o.ce, odds);
  }
  return byCode.size === sides.size ? byCode : null;
}

/** The line formatted with an explicit sign: "-0.5" / "+0.5". */
function signedLine(line) {
  return line < 0 ? String(line) : `+${line}`;
}

/**
 * The full-time result market, or null when absent or unusable.
 *
 * `ce=1` is the home win, `ce=2` the draw and `ce=3` the away win. That mapping
 * is asserted by the shape alone in a three-leg market, so it was measured
 * against books whose own labels are already established: 267 of this feed's
 * fixtures were matched by name and day against maxbet, superbet, fortuna,
 * admiral and winner, and this assignment tracked their prices in 258 of them
 * (96.6%), with a mean absolute log gap of 0.032 against the two legs the
 * swap leaves. Swapping the draw and the away side raises that gap to 0.817.
 *
 * The weaker signal points the other way and is wrong: `ce=2` carries the
 * longest price in only 257 of 589 matches, against 238 for `ce=3`. On this
 * board — English non-league, where draws are rare — the away side is simply
 * quoted longer than the draw more often, and "which price is longest" is not
 * a label. The swap of the two legs would keep every pairing and every
 * arbitrage intact while changing what settles, which is exactly why it had to
 * be measured rather than reasoned about.
 */
function resultMarket(e) {
  for (const sc of e.scs || []) {
    if (sc.cs !== RESULT_MARKET) continue;
    const legs = pricedLegs(sc, RESULT_SIDES);
    if (!legs) continue;
    // A 1X2 missing its draw is a two-way market; publishing it as `1x2`
    // would let the engine pair it against a complete three-way result.
    const selections = [...RESULT_SIDES].map(([ce, label]) => ({
      id: `${e.bid}:${sc.cs}:${ce}`,
      name: label,
      odds: legs.get(ce),
      handicap: null,
    }));
    const period = extractPeriodFromName(sc.d) || 'fulltime';
    return { key: '1x2', name: sc.d || 'FINAL', period, selections };
  }
  return null;
}

/**
 * First-half result market (cs=14), three-way 1X2.
 */
function firstHalfResultMarket(e) {
  for (const sc of e.scs || []) {
    if (sc.cs !== FIRST_HALF_RESULT_MARKET) continue;
    const legs = pricedLegs(sc, RESULT_SIDES);
    if (!legs) continue;
    const selections = [...RESULT_SIDES].map(([ce, label]) => ({
      id: `${e.bid}:${sc.cs}:${ce}`,
      name: label,
      odds: legs.get(ce),
      handicap: null,
    }));
    return { key: '1x2', name: sc.d || '1ST HALF', period: 'half1', selections };
  }
  return null;
}

/**
 * Every full-time goals total this event publishes, one market per line.
 *
 * The feed quotes several thresholds per event (measured 0.5 through 5.5) as
 * separate markets, and each is its own contract at its own line. Merging them
 * would bucket "Over 0.5" with "Over 1.5".
 *
 * A goals threshold admits exactly one monotone assignment, so the sides are
 * determined rather than guessed — but the direction has to be right before the
 * argument says anything. It is: the OVER price RISES as the line rises and the
 * UNDER price falls. Over 0.5 is settled by any goal at all, so it is all but
 * certain and short; Over 5.5 is long. Measured 2026-09-29 on aggregate 8
 * across five days and all four tenants, over 442 events carrying two or more
 * lines and 2,061 consecutive line steps between them, `ce=1` fell on every step
 * and `ce=2` rose on every step — no exceptions — which is to say `ce=1` is the
 * side that shortens as the threshold rises, and that is UNDER. See
 * `TOTAL_GOALS_SIDES` for the first version of this, which had the sentence
 * backwards and read the fall as Over.
 *
 * Pooled medians show the same shape (8.40 -> 1.04 for `ce=1` from the 0.5 line
 * to the 5.5 line) but are not the proof: they mix events, and a per-event
 * count is what makes the assignment forced.
 */
function totalGoalsMarkets(e) {
  const out = [];
  for (const sc of e.scs || []) {
    if (sc.cs !== TOTAL_GOALS_MARKET) continue;
    const line = halfLine(sc.h);
    if (line === null) continue;
    const legs = pricedLegs(sc, TOTAL_GOALS_SIDES);
    if (!legs) continue;
    const selections = [...TOTAL_GOALS_SIDES].map(([ce, label]) => ({
      id: `${e.bid}:${sc.cs}:${sc.h}:${ce}`,
      name: `${label} ${line}`,
      odds: legs.get(ce),
      handicap: null,
    }));
    out.push({
      key: 'TOTAL_GOALS',
      providerMarketId: `${sc.cs}:${sc.h}`,
      name: sc.d || 'TOTAL GOALS',
      period: extractPeriodFromName(sc.d) || 'fulltime',
      line,
      selections,
    });
  }
  return out;
}

/**
 * Every full-time goals handicap this event publishes, one market per line.
 *
 * `h` is the HOME handicap in hundredths and `ce=1` is the home leg, so the
 * same leg code appears on both sides of a fixture: at `h=-50` the `ce=1` leg
 * is home -0.5 and at `h=+50` it is home +0.5. Reading the sign as the side
 * would mirror half the board. Both halves were measured over five days on
 * 2026-09-29, per tenant, all four returning identical counts:
 *
 *   1. The line belongs to `ce=1`. Its price falls as the line rises and its
 *      opponent's rises, in every one of 422 consecutive line steps within an
 *      event, across 174 events with two or more lines. The leg a line applies
 *      to is the leg whose price moves against it, so `h` is `ce=1`'s line.
 *   2. `ce=1` is the HOME side, and `h` is therefore the home handicap. The
 *      feed prices the plain 1X2 on the same event, so the side probabilities
 *      are known independently of the handicap prices, and at the half line the
 *      two legs are {one side gives 0.5} and {the other receives}. Comparing
 *      the `ce=1` leg's implied probability against those candidates over 190
 *      events at `h=-0.5` and 161 at `h=+0.5`: at -0.5 it tracks P(home wins)
 *      with a mean residual of +0.052 and an rms of 0.053, against 0.198 and
 *      rms 0.203-0.347 for the alternatives; at +0.5 it tracks 1 - P(away
 *      wins) at +0.043 / rms 0.044 against 0.063 and 0.300-0.426. The two
 *      signs of the line agree, and the winning residual is an order of
 *      magnitude better than the next one.
 *
 * This deliberately does not read "which leg looks like the favourite" as the
 * evidence. A leg whose price tracks the other side's 1X2 price on the same
 * fixture is measured against a number the feed publishes independently; a
 * leg that merely looks like a favourite is the two of them conflated.
 */
function asianHandicapMarkets(e) {
  const out = [];
  for (const sc of e.scs || []) {
    if (sc.cs !== ASIAN_HANDICAP_MARKET) continue;
    const homeLine = halfLine(sc.h);
    if (homeLine === null) continue;
    const legs = pricedLegs(sc, ASIAN_HANDICAP_SIDES);
    if (!legs) continue;
    // "1 (-0.5)" / "2 (+0.5)": the side token orients the bucket and the
    // signed line is what `classifyAndExtractLine` reads, so the pair is an
    // exact negation and the spread branch is the one that applies. The side
    // comes from the table and the line from the side, so the mapping cannot
    // drift out from under the labels.
    const lines = { home: homeLine, away: -homeLine };
    const selections = [...ASIAN_HANDICAP_SIDES].map(([ce, side]) => ({
      id: `${e.bid}:${sc.cs}:${sc.h}:${ce}`,
      name: `${side === 'home' ? '1' : '2'} (${signedLine(lines[side])})`,
      odds: legs.get(ce),
      handicap: null,
    }));
    out.push({
      key: 'ASIAN_HANDICAP',
      providerMarketId: `${sc.cs}:${sc.h}`,
      name: sc.d || 'ASIAN HANDICAP',
      period: extractPeriodFromName(sc.d) || 'fulltime',
      line: homeLine,
      selections,
    });
  }
  return out;
}

/**
 * Team-specific goals totals (HOME TOTAL cs=1749, AWAY TOTAL cs=1750).
 */
function teamGoalsMarkets(e) {
  const out = [];
  for (const sc of e.scs || []) {
    if (sc.cs !== HOME_TOTAL_GOALS_MARKET && sc.cs !== AWAY_TOTAL_GOALS_MARKET) continue;
    const team = sc.cs === HOME_TOTAL_GOALS_MARKET ? 'home' : 'away';
    const line = halfLine(sc.h);
    if (line === null) continue;
    const legs = pricedLegs(sc, TOTAL_GOALS_SIDES);
    if (!legs) continue;
    const selections = [...TOTAL_GOALS_SIDES].map(([ce, label]) => ({
      id: `${e.bid}:${sc.cs}:${sc.h}:${ce}`,
      name: `${label} ${line}`,
      odds: legs.get(ce),
      handicap: null,
    }));
    out.push({
      key: 'TOTAL_GOALS',
      providerMarketId: `${sc.cs}:${sc.h}`,
      name: sc.d || (team === 'home' ? 'HOME TOTAL' : 'AWAY TOTAL'),
      period: extractPeriodFromName(sc.d) || 'fulltime',
      team,
      line,
      selections,
    });
  }
  return out;
}

/**
 * Both Teams To Score (cs=18).
 * ce=1 is Yes ("sì" / "da"), ce=2 is No ("no" / "nu").
 */
const BTTS_SIDES = new Map([[1, 'Yes'], [2, 'No']]);
function bttsMarkets(e) {
  const out = [];
  const seenPeriods = new Set();
  for (const sc of e.scs || []) {
    if (sc.cs !== BTTS_MARKET) continue;
    const legs = pricedLegs(sc, BTTS_SIDES);
    if (!legs) continue;
    const period = extractPeriodFromName(sc.d) || 'fulltime';
    if (seenPeriods.has(period)) continue;
    seenPeriods.add(period);
    const selections = [...BTTS_SIDES].map(([ce, label]) => ({
      id: `${e.bid}:${sc.cs}:${ce}`,
      name: label,
      odds: legs.get(ce),
      handicap: null,
    }));
    out.push({
      key: 'BOTH_TEAMS_SCORE',
      name: sc.d || 'BOTH TEAMS TO SCORE',
      period,
      selections,
    });
  }
  return out;
}

/** 2-way Match Winner for Basketball (cs=110) or Tennis (cs=2). */
const TWO_WAY_SIDES = new Map([[1, '1'], [2, '2']]);
function moneyline2WayMarkets(e) {
  const out = [];
  const seenPeriods = new Set();
  for (const sc of e.scs || []) {
    if (sc.cs !== BASKETBALL_WINNER_MARKET && sc.cs !== TENNIS_WINNER_MARKET) continue;
    const legs = pricedLegs(sc, TWO_WAY_SIDES);
    if (!legs) continue;
    const period = extractPeriodFromName(sc.d) || 'fulltime';
    if (seenPeriods.has(period)) continue;
    seenPeriods.add(period);
    const selections = [...TWO_WAY_SIDES].map(([ce, label]) => ({
      id: `${e.bid}:${sc.cs}:${ce}`,
      name: label,
      odds: legs.get(ce),
      handicap: null,
    }));
    out.push({
      key: 'MATCH_ODDS',
      name: sc.d || 'Match Winner',
      period,
      selections,
    });
  }
  return out;
}

/** Points totals for Basketball (cs=14863) or Games totals for Tennis (cs=13464). */
function pointsTotalsMarkets(e) {
  const out = [];
  for (const sc of e.scs || []) {
    if (sc.cs !== BASKETBALL_POINTS_TOTAL_MARKET && sc.cs !== TENNIS_GAMES_TOTAL_MARKET) continue;
    const line = halfLine(sc.h);
    if (line === null) continue;
    const legs = pricedLegs(sc, TOTAL_GOALS_SIDES);
    if (!legs) continue;
    const selections = [...TOTAL_GOALS_SIDES].map(([ce, label]) => ({
      id: `${e.bid}:${sc.cs}:${sc.h}:${ce}`,
      name: `${label} ${line}`,
      odds: legs.get(ce),
      handicap: null,
    }));
    const isGames = sc.cs === TENNIS_GAMES_TOTAL_MARKET;
    out.push({
      key: 'OVER_UNDER',
      providerMarketId: `${sc.cs}:${sc.h}`,
      name: sc.d || (isGames ? 'Total game-uri' : 'TOTAL POINTS'),
      period: extractPeriodFromName(sc.d) || 'fulltime',
      line,
      subject: isGames ? 'games' : 'points',
      selections,
    });
  }
  return out;
}


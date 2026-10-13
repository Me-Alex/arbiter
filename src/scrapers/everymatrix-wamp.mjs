/**
 * Shared WAMP reader for EveryMatrix ODDS sportsbooks (getsbet, contibet).
 *
 * Implements the reverse-engineered WAMP v2 flow of the real frontend
 * (Wampy.js) against the operator's RealtimeDealer socket:
 *
 *   HELLO  →  WELCOME
 *   REGISTER <topic>  →  REGISTERED
 *   CALL /sports#initialDump {topic}  →  RESULT with the INITIAL_DUMP
 *
 * Pacing matters: the dealer closes the socket if frames are sent in a
 * burst (REGISTER ~1.2s after WELCOME, CALL ~0.8s after REGISTERED).
 * Each dump runs on its own socket so dealer live-update streams never
 * starve an outstanding dump.
 */
import { UpstreamError, TimeoutError, ValidationError } from '../shared/errors.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { isUnlimited, limitReached, maxEvents } from '../shared/event-limit.mjs';
import { markMarketsLive } from './live-status.mjs';
import { extractPeriodFromName, isTradablePeriod } from '../scanner/market-contracts.mjs';
import ScraperBase from './base.mjs';
/* global WebSocket */

export const EVERYMATRIX_SPORT_ID_MAP = Object.freeze({
  1: 'Football',
  2: 'Basketball',
  3: 'Tennis',
  4: 'Ice Hockey',
  5: 'Handball',
  6: 'Volleyball',
});

export const EVERYMATRIX_SPORT_NAME_TO_ID = Object.freeze({
  football: '1',
  basketball: '2',
  tennis: '3',
  'ice hockey': '4',
  ice_hockey: '4',
  handball: '5',
  volleyball: '6',
});

/**
 * The market an outcome (and therefore a BETTING_OFFER) belongs to.
 *
 * A match dump is flat: OFFER records reference an outcome, and the outcome is
 * tied to its market. Matching offers on `bettingTypeId` alone is not enough,
 * because several markets in one dump can share a type — a regulation-time
 * result and a first-half result both look like "match result" to that field —
 * and the last one parsed would silently win.
 *
 * The dealer links an outcome to its market in ONE of two ways, and a live
 * capture of getsbet (2026-09-29) shows the second is the one actually used:
 *
 *   1. `OUTCOME.marketId` directly, or
 *   2. a `MARKET_OUTCOME_RELATION` row carrying { marketId, outcomeId }.
 *
 * In that capture the OUTCOME records carry NO `marketId` field at all — the
 * relation table is the only link. Reading `outcome.marketId` therefore yields
 * `undefined` for every outcome, and because the totals / BTTS / double chance
 * / DNB / corners / cards extractors all scope an offer by comparing
 * `String(outcome.marketId) === String(market.id)`, every one of them discarded
 * every outcome and published nothing. Only the 1X2 survived, and only because
 * extractOneXTwo deliberately keeps offers whose market cannot be resolved
 * (there is nothing to confuse them with) instead of dropping them.
 *
 * Measured on that same capture, the relation join resolves 7,660 of 7,660
 * outcomes and reaches 5,906 of them with a priced offer, unlocking 584
 * full-time goals totals, 199 first-half totals and 484 Asian handicaps that
 * the feed was already publishing and this adapter was discarding.
 *
 * Returns null when neither link establishes a market, so an offer that names no
 * market is still not attributed to one.
 *
 * @param {object} record  an OUTCOME or BETTING_OFFER record
 * @param {object[]} records  the full dump, used to resolve the relation
 * @returns {string|null}
 */
function outcomeMarketId(record, records) {
  if (record?.marketId !== undefined && record?.marketId !== null) return String(record.marketId);

  let outcomeId = record?.outcomeId;
  if (outcomeId === undefined || outcomeId === null) {
    if (record?._type === 'OUTCOME') outcomeId = record.id;
  }
  if (outcomeId === undefined || outcomeId === null) return null;

  // Direct link on the outcome itself.
  const outcome = records.find((r) => r._type === 'OUTCOME' && String(r.id) === String(outcomeId));
  if (outcome?.marketId !== undefined && outcome?.marketId !== null) return String(outcome.marketId);

  // Relation-table link, which is the form the live feed actually uses.
  const relation = records.find((r) =>
    r._type === 'MARKET_OUTCOME_RELATION' && String(r.outcomeId) === String(outcomeId));
  const related = relation?.marketId;
  return related === undefined || related === null ? null : String(related);
}

/**
 * True for a HALF line (`…0.5`) — the only handicap line whose two sides form
 * an exhaustive two-way contract.
 *
 * At a whole line the stake is returned on a push and at a quarter line one
 * side wins half, so the two legs do not cover 100% of the outcome space and an
 * inverse sum below 1 is not a surebet. Same rule, and same reason, as nsoft's
 * `isHalfLine` and unibet's numeric form.
 *
 * @param {number|string} line
 * @returns {boolean}
 */
function isHalfLine(line) {
  return /^-?\d+\.5$/.test(trimLine(line));
}

/**
 * Normalise a line for embedding in a selection name.
 *
 * The contracts layer reads the line back out of the selection NAME, so the
 * name has to carry a form `extractLineFromName` can parse. Provider floats
 * arrive as `2`, `2.50`, `1.5`; `String(Number(x))` collapses those to the
 * canonical `2` / `2.5`, which is what a name parser and `lineKey` both expect.
 *
 * @param {number|string} line
 * @returns {string}
 */
function trimLine(line) {
  const n = Number(line);
  return Number.isFinite(n) ? String(n) : String(line ?? '').trim();
}

/**
 * The human-readable LABEL of one leg of a market.
 *
 * This is the single most consequential line in the adapter, because getting
 * it wrong is silent. A WAMP OUTCOME carries two different strings:
 *
 *   typeName              the English CATEGORY, identical for every leg of the
 *                         market — both totals legs read "Total Score Over" /
 *                         "Total Score Under", both BTTS legs read
 *                         "Both Teams To Score", and a DNB and an Asian
 *                         handicap leg both read "… Money Back On Draw";
 *   shortTranslatedName  the per-leg LABEL — "Peste 2.5", "Da", "Gazde (-1.5)".
 *
 * Every family extractor here used to read `typeName || shortTranslatedName`,
 * so the category won, BOTH legs of a market got the same string, and no side
 * regex could ever tell them apart. That is why this feed published 21 markets
 * (1X2 only) out of the 388 its dumps contain: BTTS, totals, handicaps, double
 * chance and DNB each found "both sides" or "neither side" and published
 * nothing. Category is for classifying a market; label is for splitting it.
 *
 * @param {object} outcome
 * @returns {string}
 */
function outcomeSideLabel(outcome) {
  return String(outcome?.shortTranslatedName || outcome?.name || '').trim();
}

/**
 * The handicap line a leg is quoted at, read from the leg's own label.
 *
 * WAMP writes it in parentheses next to the side — "Gazde (-1.5)",
 * "Oaspeţi (+1.5)" — with an explicit sign, so the sign is the line and not a
 * separator. Returns null when the leg names no line, which makes the caller
 * withhold the market rather than guess.
 *
 * @param {string} side
 * @returns {number|null}
 */
function handicapLineIn(side) {
  const found = /\(([+-]?\d+(?:[.,]\d+)?)\)/.exec(String(side || ''));
  if (!found) return null;
  const n = Number(found[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} cfg
 * @param {string} cfg.wsUrl        e.g. wss://api-online.getsbet.ro/v2
 * @param {string} cfg.realm        e.g. online.getsbet.ro
 * @param {string} cfg.origin       e.g. https://sports2.getsbet.ro
 * @param {string} cfg.operatorId   e.g. '2476'
 * @param {string} cfg.venueId      e.g. '187' (Romania)
 * @param {string} cfg.sportId      e.g. '1' (football)
 */
export default class EveryMatrixWampScraper extends ScraperBase {
  id = 'everymatrix-wamp';
  name = 'EveryMatrix WAMP';
  sourceIds = ['everymatrix-wamp'];

  wsUrl = '';
  realm = '';
  origin = '';
  operatorId = '2476';
  venueId = '187';
  sportId = '1';
  sport = 'Football';
  sportSlug = 'football';

  // Two aggregator group ids observed on the operator: 2794 = Home/Draw/Away,
  // 2795 = totals. The frontend asks for both.
  aggregatorGroups = '2794,2795';

  // 1X2 "Final - Timp regulamentar." betting type on EveryMatrix ODDS.
  oneXTwoTypeId = '69';
  twoWayMatchWinnerTypeId = '249';

  // A tournament index can contain hundreds of historical/derivative groups.
  // Keep discovery bounded while still covering substantially more than the
  // default event target (the live feed observed many matches per group).
  tournamentDumpLimit = 24;
  // Bounded candidate pool compensates for incomplete 1X2 markets without
  // allowing unbounded WebSocket fan-out.
  eventScanLimit = Infinity;
  eventRequestConcurrency = 2;

  // A WAMP scrape opens a socket and then scans up to `eventScanLimit` events
  // at `eventRequestConcurrency` at a time, so this deadline covers the whole
  // scan, not one request. It was 540s, which with maxAttempts=2 let a hung
  // tenant hold a worker slot for 18 minutes against a batch parallelism of
  // 12. 3 minutes still allows the full 240-event scan at the observed rate.
  timeoutMs = 180_000;
  maxAttempts = 2;
  wsTimeoutMs = 30_000;

  constructor(opts = {}) {
    super(opts);
    this.maxEvents = maxEvents(opts.maxEvents, 60, 300);
    if (opts.sportId) this.sportId = String(opts.sportId);
    if (opts.sport) this.sport = opts.sport;
    if (opts.sportSlug) this.sportSlug = opts.sportSlug;
    else if (opts.sport) this.sportSlug = opts.sport.toLowerCase().replace(/\s+/g, '-');
    if (opts.sport && !opts.sportId) {
      const mappedId = EVERYMATRIX_SPORT_NAME_TO_ID[this.sportSlug] || EVERYMATRIX_SPORT_NAME_TO_ID[opts.sport.toLowerCase()];
      if (mappedId) this.sportId = mappedId;
    } else if (opts.sportId && !opts.sport) {
      const mappedSport = EVERYMATRIX_SPORT_ID_MAP[this.sportId];
      if (mappedSport) {
        this.sport = mappedSport;
        this.sportSlug = mappedSport.toLowerCase().replace(/\s+/g, '-');
      }
    }
    if (opts.twoWayMatchWinnerTypeId) this.twoWayMatchWinnerTypeId = String(opts.twoWayMatchWinnerTypeId);
  }

  // ---- WAMP plumbing -----------------------------------------------------

  _openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { origin: this.origin });
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new TimeoutError(`${this.id}: ws connect timeout`, { code: 'ETIMEOUT' }));
      }, this.wsTimeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        try {
          ws.send(JSON.stringify([1, this.realm, {
            agent: 'Wampy.js v6.2.2',
            roles: { publisher: {}, subscriber: {}, caller: {}, callee: {} },
          }]));
        } catch (err) {
          reject(err);
        }
        resolve(ws);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new UpstreamError(`${this.id}: ws error`, { code: 'EUPSTREAM' }));
      };
    });
  }

  /**
   * Dump one topic: fresh socket, paced REGISTER + initialDump, return the
   * INITIAL_DUMP records. Throws UpstreamError when the dump times out so the
   * base retry layer can back off and reconnect.
   */
  async dumpTopic(topic, { waitMs = this.wsTimeoutMs, signal } = {}) {
    // An in-flight dump used to ignore the caller's abort and sit until the
    // dealer timed out — up to `wsTimeoutMs` (30s) — before the `finally` closed
    // the socket. Cancelling a scrape therefore waited out every outstanding
    // tournament instead of unwinding at once.
    if (signal?.aborted) throw new TimeoutError(`${this.id}: aborted before dump of ${topic}`, { code: 'EABORTED' });
    let seq = 1;
    const ws = await this._openSocket();
    // Detach on abort so a cancel tears the socket down now, not at the deadline.
    const onAbort = () => {
      try { ws.close(); } catch { /* already closing */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const records = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        const timer = setTimeout(() => {
          finish(reject, new TimeoutError(`${this.id}: initialDump timeout for ${topic}`, { code: 'ETIMEOUT' }));
        }, waitMs);
        if (signal?.aborted) {
          finish(reject, new TimeoutError(`${this.id}: aborted during dump of ${topic}`, { code: 'EABORTED' }));
          return;
        }
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          const f = Array.isArray(msg[0]) ? msg[0] : msg;
          switch (f[0]) {
            case 2: // WELCOME → REGISTER
              setTimeout(() => ws.send(JSON.stringify([64, seq++, {}, topic])), 1200);
              break;
            case 65: // REGISTERED → CALL initialDump
              setTimeout(() => ws.send(JSON.stringify([48, seq++, {}, '/sports#initialDump', [], { topic }])), 800);
              break;
            case 68: { // INVOCATION (initial dump or live update)
              const kw = f[5] || {};
              if (kw.messageType === 'INITIAL_DUMP' && Array.isArray(kw.records)) {
                finish(resolve, kw.records);
              } else {
                ws.send(JSON.stringify([70, f[1], {}]));
              }
              break;
            }
            case 50: { // RESULT carrying the dump
              const kw = f[4] || {};
              if (Array.isArray(kw.records)) {
                finish(resolve, kw.records);
              }
              break;
            }
            case 8:
              finish(reject, new UpstreamError(`${this.id}: dealer ${JSON.stringify(f).slice(0, 160)}`, { status: 502 }));
              break;
            default:
              break;
          }
        };
        // An abort closes the socket, which lands here; report it as an abort
        // rather than as a dealer fault so the caller can tell them apart.
        ws.onclose = () => {
          finish(reject, signal?.aborted
            ? new TimeoutError(`${this.id}: aborted during dump of ${topic}`, { code: 'EABORTED' })
            : new UpstreamError(`${this.id}: ws closed during dump of ${topic}`));
        };
        ws.onerror = () => {
          finish(reject, new UpstreamError(`${this.id}: ws error during dump of ${topic}`));
        };
      });
      return records;
    } finally {
      // Always detach: leaving the listener on a long-lived caller signal would
      // accumulate one closure per dump across the whole run.
      signal?.removeEventListener('abort', onAbort);
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  // ---- topic helpers -----------------------------------------------------

  tournamentListTopic() {
    return `/sports/${this.operatorId}/ro/tournaments/${this.sportId}/${this.venueId}`;
  }

  aggregatorTopic(tournamentId) {
    return `/sports/${this.operatorId}/ro/tournament-aggregator-groups-overview/${tournamentId}/default-event-info/NOT_LIVE/${this.aggregatorGroups}`;
  }

  matchOddsTopic(eventId) {
    return `/sports/${this.operatorId}/ro/${eventId}/match-odds/market-group/Populare`;
  }

  eventUrl(eventId) {
    return `${this.siteBaseUrl}/sport#/event/${eventId}`;
  }

  // ---- orchestration overrides -------------------------------------------

  async fetchRaw({ signal } = {}) {
    const abortGuard = () => {
      if (signal?.aborted) throw new TimeoutError(`${this.id}: aborted`, { code: 'EABORTED' });
    };

    // 1) tournament index (football / Romania)
    abortGuard();
    let tournaments = [];
    for (let attempt = 0; attempt < 3 && tournaments.length === 0; attempt++) {
      abortGuard();
      const records = await this.dumpTopic(this.tournamentListTopic(), { signal });
      tournaments = records.filter((r) => r._type === 'TOURNAMENT' && String(r.sportId) === this.sportId);
    }
    if (tournaments.length === 0) {
      throw new UpstreamError(`${this.id}: no tournaments found`);
    }

    // 2) aggregate dumps → candidate matches (prefer cup groups that are
    //    already round-robin leaf tournaments, then the remaining list)
    const cupIds = new Set();
    for (const t of tournaments) {
      if (/^cupa/i.test(t.name)) cupIds.add(String(t.id));
    }
    const scanOrder = [
      ...tournaments.filter((t) => cupIds.has(String(t.id))),
      ...tournaments.filter((t) => !cupIds.has(String(t.id))),
    ].slice(0, this.tournamentDumpLimit);
    const seenTournament = new Set();
    const matches = new Map();
    for (const t of scanOrder) {
      if (seenTournament.has(String(t.id))) continue;
      seenTournament.add(String(t.id));
      abortGuard();
      let records = null;
      for (let attempt = 0; attempt < 2 && !records; attempt++) {
        abortGuard();
        try {
          records = await this.dumpTopic(this.aggregatorTopic(t.id), { signal });
        } catch (err) {
          // A cancelled run is not a flaky tournament: retrying would keep the
          // scrape alive after the caller asked it to stop.
          if (signal?.aborted) throw err;
          records = null;
        }
      }
      if (!records) continue;
      for (const r of records) {
        if (r._type === 'MATCH' && !matches.has(String(r.id))) matches.set(String(r.id), r);
      }
    }
    if (matches.size === 0) {
      throw new UpstreamError(`${this.id}: no matches discovered via aggregators`);
    }

    // 3) per-event match-odds dumps → fresh complete odds
    const now = Date.now();
    const future = [...matches.values()]
      .filter((m) => Number(m.startTime) > now)
      .sort((a, b) => a.startTime - b.startTime);
    // Probe a bounded prefix larger than the output target: some events lack
    // a complete 1X2 market, so stopping at maxEvents would underfill results.
    const candidateLimit = isUnlimited(this.maxEvents)
      ? this.eventScanLimit
      : Math.min(this.eventScanLimit, Math.max(this.maxEvents * 2, this.maxEvents));
    const candidates = future.slice(0, candidateLimit);
    if (future.length === 0) {
      throw new UpstreamError(`${this.id}: no future matches in aggregator feeds`);
    }

    const events = [];
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const match = candidates[next++];
        abortGuard();
        let records = null;
        for (let attempt = 0; attempt < 2 && !records; attempt++) {
          abortGuard();
          try {
            records = await this.dumpTopic(this.matchOddsTopic(match.id), { signal });
          } catch (err) {
            // Cancellation is not a flaky match; do not retry past it.
            if (signal?.aborted) throw err;
            records = null;
          }
        }
        if (records) events.push({ match, records });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.eventRequestConcurrency, candidates.length) }, worker));

    return {
      events,
      tournaments: tournaments.map((t) => ({ id: t.id, name: t.name })),
      sourceUrl: this.wsUrl,
      observedAt: new Date().toISOString(),
      transport: this.transport,
    };
  }

  normalize(raw) {
    if (!raw || !Array.isArray(raw.events)) {
      throw new ValidationError(`${this.id}: wamp feed missing events`, { field: 'events' });
    }
    this._lastSourceUrl = 'wss:' + (raw.sourceUrl || this.wsUrl).replace(/^wss?:/, '');
    this._lastObservedAt = raw.observedAt || new Date().toISOString();
    return raw.events;
  }

  /**
   * Every other public adapter adds its provenance here. Without it the
   * snapshot lands without `sourceUrl` or `transport`, and loadWorkspace
   * classifies it PARTIAL and discards every event — so both EveryMatrix books
   * were scraped, reported as valid, and then silently dropped by the scan.
   *
   * The URL is the dealer socket rather than a request URL: there is no REST
   * endpoint for these odds, the WAMP session is the only source. The `wss:`
   * scheme is preserved rather than rewritten to `wss://`, matching the other
   * adapters, so a reader can tell it is a socket.
   */
  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      sourceUrl: raw?.sourceUrl || this._lastSourceUrl || this.wsUrl,
      transport: raw?.transport || this.transport,
    };
  }

  extractEvents(rawEvents) {
    const out = [];
    const seenEventKeys = new Set();
    const isTwoWaySport = this.sportSlug === 'basketball' || this.sportSlug === 'tennis';
    for (const { match, records } of rawEvents) {
      const selected = isTwoWaySport
        ? (this.extractTwoWayMatchWinner(match, records) || this.extractOneXTwo(match, records))
        : this.extractOneXTwo(match, records);
      if (!selected) continue;
      const kickoffMs = Number(match.startTime);
      if (!Number.isFinite(kickoffMs)) continue;
      const isLive = Boolean(match.isLive || match.status === 'LIVE' || match.inPlay);
      if (!this.includeLive && kickoffMs <= Date.now()) continue;
      const home = match.homeParticipantName;
      const away = match.awayParticipantName;
      if (!home || !away) continue;
      const league = match.parentName || 'Unknown';
      const kickoff = new Date(kickoffMs).toISOString();
      const eventKey = [
        this.sportSlug,
        normalizeTeamName(league),
        kickoff,
        normalizeTeamName(home),
        normalizeTeamName(away),
      ].join('|');
      const { market, selections, offers } = selected;
      const extraMarkets = [
        ...this.extractTotals(match, records),
        ...this.extractAsianHandicap(match, records),
        ...this.extractBothTeamsToScore(match, records),
        ...this.extractDoubleChance(match, records),
        ...this.extractDrawNoBet(match, records),
        ...this.extractPeriodWinners(match, records),
      ];
      if (seenEventKeys.has(eventKey)) continue;
      seenEventKeys.add(eventKey);
      const allMarkets = [{
        key: 'MATCH_ODDS',
        name: market.displayName || market.name || 'Match Odds',
        selections: selections.map((kind) => ({
          id: `${match.id}:${kind}`,
          name: kind,
          odds: offers[kind],
          group: 'Main',
        })),
      }, ...extraMarkets];
      markMarketsLive(allMarkets, () => isLive);
      out.push({
        id: String(match.id),
        sourceId: this.sourceIds[0],
        sourceUrl: this.eventUrl(match.id),
        observedAt: this._lastObservedAt,
        sport: this.sport,
        league,
        kickoff,
        homeTeam: home,
        awayTeam: away,
        eventKey,
        live: isLive,
        markets: allMarkets,
      });
      if (limitReached(out.length, this.maxEvents)) break;
    }
    return out;
  }

  /**
   * Period token for a WAMP market, from the dealer's own window wording.
   *
   * WAMP names the window in the market name ("Total Peste/Sub Repriza 1"),
   * so unlike favbet it is legible there — but the key must still carry the
   * CANONICAL token the contracts layer buckets on, because the resolver reads
   * `period` and the bucket key is built from it. `half1`, not `firsthalf`:
   * canonicalPeriod() recognises the Romanian source text and the bare English
   * aliases, and a `firsthalf` string matches none of them and degrades to
   * full-time, which is the favbet bug in a different feed.
   */
  static periodFor(marketOrName) {
    if (!marketOrName) return 'fulltime';
    if (typeof marketOrName === 'string') {
      return extractPeriodFromName(marketOrName) || 'fulltime';
    }
    const candidateTexts = [
      marketOrName.name,
      marketOrName.displayName,
      marketOrName.shortName,
      marketOrName.eventPartName,
      marketOrName.shortEventPartName,
    ].filter(Boolean);
    for (const text of candidateTexts) {
      const extracted = extractPeriodFromName(text);
      if (extracted) return extracted;
    }
    return 'fulltime';
  }

  /**
   * Index one match dump for the family extractors.
   *
   * The dump is flat and the only outcome→market link is the relation table
   * (see outcomeMarketId), so every extractor needs the same three lookups.
   * Building them once per event, instead of an `Array.find` per offer per
   * market, is what makes a 968-record dump finish in milliseconds.
   *
   * A dump is offered to several books, and the family extractors are the only
   * ones that must attribute every price to a market, so nothing here falls
   * back to "unattributed means usable" the way extractOneXTwo does: an offer
   * that cannot be joined to a market is simply not published.
   */
  static indexDump(records) {
    const outcomes = new Map();
    const offers = new Map();
    const relations = new Map();
    for (const record of records) {
      if (record._type === 'OUTCOME') {
        outcomes.set(String(record.id), record);
      } else if (record._type === 'MARKET_OUTCOME_RELATION') {
        const key = String(record.marketId);
        if (!relations.has(key)) relations.set(key, []);
        relations.get(key).push(String(record.outcomeId));
      } else if (record._type === 'BETTING_OFFER') {
        // A contradictory duplicate for one outcome keeps the first price; the
        // last one serialised must not decide what we publish.
        const key = String(record.outcomeId);
        const odds = Number(record.odds);
        if (offers.has(key)) continue;
        if (record.isAvailable === false) continue;
        if (!Number.isFinite(odds) || odds <= 1) continue;
        offers.set(key, odds);
      }
    }
    return { outcomes, offers, relations };
  }

  /** The priced, relation-joined legs of one market, in provider order. */
  static pricedSides(market, index) {
    const out = [];
    for (const outcomeId of index.relations.get(String(market.id)) || []) {
      const outcome = index.outcomes.get(outcomeId);
      if (!outcome) continue;
      const odds = index.offers.get(outcomeId);
      if (!odds) continue;
      out.push({ id: outcomeId, side: outcomeSideLabel(outcome), odds });
    }
    return out;
  }

  /**
   * Goal totals (bettingTypeId 47), at half lines only.
   *
   * Keyed on the dealer's own type id rather than a name pattern: 47 is the
   * MATCH goals total, and 77 is the same "Total Peste/Sub" wording for a
   * single TEAM's goals. A name match on /total|peste\/sub/ collects both and
   * would let another book's match total stand in for this team's total.
   *
   * HALF LINES ONLY, and this is a settlement rule, not a formatting one. WAMP
   * quotes "Total Peste/Sub 2" and "…2.25" alongside "…2.5": at 2 exactly the
   * over and under legs both push, at 2.25 one leg wins half and the other
   * half pushes, so neither is an exhaustive two-way contract and an inverse
   * sum below 1 is not a surebet. The dealer says the same thing in its own
   * `asianLine` flag, which is true on 179 of 178 non-half totals here and
   * false on 237 of 238 half ones — close enough to corroborate, not close
   * enough to gate on, because two markets disagree. The LINE is the rule.
   *
   * `classifyAndExtractLine` does not apply it on the O/U path (it only
   * requires equal magnitudes), so `TOTAL_GOALS` at 2 or 2.25 would resolve and
   * price. The guard has to live here.
   */
  extractTotals(match, records) {
    const index = EveryMatrixWampScraper.indexDump(records);
    const seenTotals = new Set();
    return records
      .filter((r) => r._type === 'MARKET' && (String(r.bettingTypeId) === '47' || String(r.bettingTypeId) === '77'))
      .flatMap((market) => {
        const line = Number(market.paramFloat1);
        if (!Number.isFinite(line) || line <= 0) return [];
        if (!isHalfLine(line)) return []; // whole/quarter totals push or half-settle
        const sides = EveryMatrixWampScraper.pricedSides(market, index);
        const over = sides.find((s) => /^(?:over|peste)\b/i.test(s.side));
        const under = sides.find((s) => /^(?:under|sub)\b/i.test(s.side));
        if (!over || !under) return [];
        const isTeam = String(market.bettingTypeId) === '77';
        let team = 'match';
        let name = market.name || `Total goluri ${trimLine(line)}`;
        if (isTeam) {
          if (String(market.paramParticipantId1) === String(match.homeParticipantId)) {
            team = 'home';
            name = `Echipa 1 Total goluri ${trimLine(line)}`;
          } else if (String(market.paramParticipantId1) === String(match.awayParticipantId)) {
            team = 'away';
            name = `Echipa 2 Total goluri ${trimLine(line)}`;
          } else {
            return []; // side unknown, refuse to prevent match collision
          }
        }
        const isBasketball = this.sportSlug === 'basketball';
        const isTennis = this.sportSlug === 'tennis';
        const subject = isBasketball ? 'points' : (isTennis ? 'games' : 'goals');
        const key = isBasketball ? 'POINTS_OVER_UNDER' : (isTennis ? 'TOTAL_GAMES' : 'TOTAL_GOALS');
        if (!market.name) {
          if (isBasketball) name = `Total puncte ${trimLine(line)}`;
          else if (isTennis) name = `Total game-uri ${trimLine(line)}`;
        }
        const period = EveryMatrixWampScraper.periodFor(market);
        const totalKey = `${period}:${team}:${trimLine(line)}`;
        if (seenTotals.has(totalKey)) return [];
        seenTotals.add(totalKey);
        // The line goes in the SELECTION NAME, not only in `handicap`: the
        // contracts layer reads it via classifyAndExtractLine → extractLineFromName.
        return [{
          key,
          name,
          team,
          subject,
          period,
          selections: [
            { id: over.id, name: `Peste ${trimLine(line)}`, odds: over.odds, handicap: line, group: 'Main' },
            { id: under.id, name: `Sub ${trimLine(line)}`, odds: under.odds, handicap: line, group: 'Main' },
          ],
        }];
      });
  }

  /**
   * Two-way Asian handicaps (bettingTypeId 48), at half lines only.
   *
   * Distinct from 112 (draw no bet), which is the same "money back on draw"
   * product with NO line — a level handicap that refunds the draw and so is
   * not an exhaustive two-way contract. The type id separates them; the name
   * does not, both being "money back on draw" to the outcome category.
   *
   * The legs carry the line in their own labels — "Gazde (-1.5)" and
   * "Oaspeţi (+1.5)" — so the sign is read from the leg rather than inferred
   * from the market's own paramFloat1. All 246 handicaps in the capture label
   * exactly one leg Gazde and one Oaspeţi and quote exact negations, and that
   * is asserted rather than assumed: a pair that is not a negation, or that
   * carries no parsable line, is withheld.
   *
   * Selection names are "1 (-1.5)" / "2 (+1.5)" rather than nsoft's "H1 -1.5" /
   * "H2 1.5". Both resolve the same ASIAN_HANDICAP contract, but only the
   * numbered form routes: canonicalOutcomeFor labels an AH leg home/away by
   * /^[12]\b/, /^home\b/ or /^away\b/, and "H1 …" matches none of them, so the
   * nsoft shape resolves the contract and then prices no legs at all.
   */
  extractAsianHandicap(match, records) {
    const index = EveryMatrixWampScraper.indexDump(records);
    const seenHandicaps = new Set();
    return records
      .filter((r) => r._type === 'MARKET' && String(r.bettingTypeId) === '48')
      .flatMap((market) => {
        const sides = EveryMatrixWampScraper.pricedSides(market, index);
        const legs = sides.map((s) => ({ ...s, line: handicapLineIn(s.side) }));
        const home = legs.find((l) => /^gazde\b|^home\b/i.test(l.side));
        const away = legs.find((l) => /^oasp|^away\b/i.test(l.side));
        if (!home || !away || home === away) return [];
        if (home.line === null || away.line === null) return [];
        if (home.line !== -away.line) return []; // not an exhaustive two-way pair
        if (!isHalfLine(home.line)) return []; // whole/quarter lines are not exhaustive
        const period = EveryMatrixWampScraper.periodFor(market);
        const handicapKey = `${period}:${trimLine(home.line)}`;
        if (seenHandicaps.has(handicapKey)) return [];
        seenHandicaps.add(handicapKey);
        return [{
          key: 'ASIAN_HANDICAP',
          name: market.name || `Handicap asiatic ${trimLine(home.line)}`,
          period,
          selections: [
            { id: home.id, name: `1 (${trimLine(home.line)})`, odds: home.odds, handicap: home.line, group: 'Main' },
            { id: away.id, name: `2 (${trimLine(away.line)})`, odds: away.odds, handicap: away.line, group: 'Main' },
          ],
        }];
      });
  }

  /**
   * Both teams to score (bettingTypeId 76).
   *
   * The type id is 76, not the 70 this used to test, and the name alone cannot
   * carry the family: type 743 ("GG sau Peste 2.5 goluri", sides "… : Da" /
   * "… : Nu") and type 419 ("Ambele echipe marchează și Total goluri") are
   * COMBINATIONS whose labels also carry Da/Nu, and a name match on
   * /ambele.*marcheaza/ collects all three. Only 76 is plain BTTS, and it is
   * the only one of the three that is an exhaustive two-way contract.
   *
   * Key is BOTH_TEAMS_SCORE with the window in `period`, never a `_1H` suffix:
   * `BOTH_TEAMS_SCORE_1H` matches no whitelist, and a suffix that resolves to
   * nothing is worse than one that resolves to the wrong family. The capture
   * carries 21 of these, all full-time.
   */
  extractBothTeamsToScore(match, records) {
    const index = EveryMatrixWampScraper.indexDump(records);
    const seenBtts = new Set();
    return records
      .filter((r) => r._type === 'MARKET' && String(r.bettingTypeId) === '76')
      .flatMap((market) => {
        const sides = EveryMatrixWampScraper.pricedSides(market, index);
        const yes = sides.find((s) => /^(?:yes|da|gg)\b/i.test(s.side));
        const no = sides.find((s) => /^(?:no|nu|ng)\b/i.test(s.side));
        if (!yes || !no) return [];
        const period = EveryMatrixWampScraper.periodFor(market);
        const bttsKey = `${period}`;
        if (seenBtts.has(bttsKey)) return [];
        seenBtts.add(bttsKey);
        return [{
          key: 'BOTH_TEAMS_SCORE',
          name: market.name || 'Ambele echipe marchează',
          period,
          selections: [
            { id: yes.id, name: 'Yes', odds: yes.odds, group: 'Main' },
            { id: no.id, name: 'No', odds: no.odds, group: 'Main' },
          ],
        }];
      });
  }

  /**
   * Double chance (bettingTypeId 9), catalogued but NOT arbitrable.
   *
   * Three legs that overlap — 1X and X2 both settle on a draw — so no two-way
   * inverse sum exists. resolveContract returns `arbEligible: false` for the
   * family, which is what keeps it out of arbitrage buckets; emitting it is
   * still correct so it shows up in coverage as an available market.
   *
   * The type id is 9, not the 71 this used to test. The legs name the sides in
   * Romanian ("Gazde sau Egal"), so they are mapped explicitly rather than by
   * hoping for the literal "1X"/"X2"/"12" tokens no WAMP outcome carries.
   */
  extractDoubleChance(match, records) {
    const index = EveryMatrixWampScraper.indexDump(records);
    const seenDc = new Set();
    return records
      .filter((r) => r._type === 'MARKET' && String(r.bettingTypeId) === '9')
      .flatMap((market) => {
        const sides = EveryMatrixWampScraper.pricedSides(market, index);
        const homeOrDraw = sides.find((s) => /^gazde\s*sau\s*egal/i.test(s.side));
        const drawOrAway = sides.find((s) => /^oasp/i.test(s.side));
        const homeOrAway = sides.find((s) => /^gazde\s*sau\s*oasp/i.test(s.side));
        if (!homeOrDraw || !drawOrAway || !homeOrAway) return [];
        const period = EveryMatrixWampScraper.periodFor(market);
        if (seenDc.has(period)) return [];
        seenDc.add(period);
        return [{
          key: 'DOUBLE_CHANCE',
          name: market.name || 'Șansă Dublă',
          period,
          selections: [
            { id: homeOrDraw.id, name: '1X', odds: homeOrDraw.odds, group: 'Main' },
            { id: drawOrAway.id, name: 'X2', odds: drawOrAway.odds, group: 'Main' },
            { id: homeOrAway.id, name: '12', odds: homeOrAway.odds, group: 'Main' },
          ],
        }];
      });
  }

  /**
   * Draw no bet (bettingTypeId 112), catalogued but NOT arbitrable.
   *
   * "Egal - Pariul se rambursează" — the draw is refunded, so the two legs do
   * not cover the outcome space and no inverse sum below 1 is a surebet.
   * resolveContract marks DRAW_NO_BET `arbEligible: false`, which is the only
   * thing keeping it out of arbitrage buckets.
   *
   * The key MUST stay bare. `DNB_1H` and `DRAW_NO_BET_1H` match no whitelist,
   * and the generic 2-way fallback then reads "1"/"2" as a MATCH_ODDS winner
   * and returns an ARBITRABLE contract for a product that cannot arbitrage —
   * a suffix that turns a withheld market into a fake surebet. The window
   * belongs in `period`, where bucketKeyForContract already accounts for it.
   *
   * Type 112 is distinct from the Asian handicap (48): both are "money back on
   * draw" to the outcome category, but 112 carries no line and 48 does.
   */
  extractDrawNoBet(match, records) {
    const index = EveryMatrixWampScraper.indexDump(records);
    const seenDnb = new Set();
    return records
      .filter((r) => r._type === 'MARKET' && String(r.bettingTypeId) === '112')
      .flatMap((market) => {
        const sides = EveryMatrixWampScraper.pricedSides(market, index);
        const home = sides.find((s) => /^gazde\b|^home\b/i.test(s.side));
        const away = sides.find((s) => /^oasp|^away\b/i.test(s.side));
        if (!home || !away) return [];
        const period = EveryMatrixWampScraper.periodFor(market);
        if (seenDnb.has(period)) return [];
        seenDnb.add(period);
        return [{
          key: 'DRAW_NO_BET',
          name: market.name || 'Egal - Pariul se rambursează',
          period,
          selections: [
            { id: home.id, name: '1', odds: home.odds, group: 'Main' },
            { id: away.id, name: '2', odds: away.odds, group: 'Main' },
          ],
        }];
      });
  }

  /**
   * Extract 2-way and 3-way sub-window derivative markets (halves, quarters, sets).
   * Supports 2-way (Tennis sets, Basketball quarters/halves) and 3-way (Football/Basketball quarter/half 1X2).
   */
  extractPeriodWinners(match, records) {
    const markets = records.filter((r) => r._type === 'MARKET');
    const named = (m) => {
      const parts = [m.displayName, m.name, m.shortName, m.eventPartName, m.shortEventPartName].filter(Boolean);
      return parts.join(' ');
    };

    const isExcludedMarket = (label) => {
      return /\b(total|peste|sub|over|under|handicap|h[12]|ambele|btts|gg|ng|dubl[aă]|double\s*chance|ramburs|dnb|draw\s*no\s*bet)\b/i.test(label);
    };

    const isPeriodCandidate = (m) => {
      const label = named(m);
      if (isExcludedMarket(label)) return false;
      const period = EveryMatrixWampScraper.periodFor(label);
      if (period === 'fulltime' || period === 'unknown' || !isTradablePeriod(period)) return false;

      const type = String(m.bettingTypeId || '');
      if (
        type === this.oneXTwoTypeId ||
        type === this.twoWayMatchWinnerTypeId ||
        type === '249' ||
        type === '70' ||
        type === '1' ||
        type === '300'
      ) {
        return true;
      }

      if (/c[aâ][sș]?tig[aă]tor|winner|rezultat|1x2|mres|final\b/i.test(label)) return true;

      return /set(?:ul)?\s*[1-5]|\b[1-5]\.?\s*set\b|(?:1st|2nd|3rd|4th|5th)\s*set|sfert(?:ul)?\s*[1-4]|\b[1-4]\.?\s*sfert\b|(?:1st|2nd|3rd|4th)\s*quarter|repriz[aă]\s*[12]|\b[12]\.?\s*repriz[aă]\b|(?:1st|2nd)\s*half/i.test(label);
    };

    const candidates = markets.filter(isPeriodCandidate);
    if (candidates.length === 0) return [];

    const outcomes = new Map(
      records.filter((r) => r._type === 'OUTCOME').map((o) => [String(o.id), o]),
    );
    const home = match.homeParticipantName;
    const away = match.awayParticipantName;

    const out = [];
    const seenPeriodKeys = new Set();

    for (const market of candidates) {
      const period = EveryMatrixWampScraper.periodFor(named(market));
      if (period === 'fulltime' || period === 'unknown' || !isTradablePeriod(period)) continue;

      const offers = records.filter((r) => {
        if (r._type !== 'BETTING_OFFER') return false;
        if (String(r.bettingTypeId) !== String(market.bettingTypeId)) return false;
        const offerMarket = outcomeMarketId(r, records);
        return offerMarket === null || offerMarket === String(market.id);
      });
      if (offers.length < 2) continue;

      let homeOffer = null;
      let drawOffer = null;
      let awayOffer = null;
      let hasUnexpectedSide = false;

      for (const offer of offers) {
        const outcome = outcomes.get(String(offer.outcomeId));
        if (!outcome) continue;
        const odds = Number(offer.odds);
        if (!Number.isFinite(odds) || odds <= 1 || offer.isAvailable === false) continue;

        const sideLabel = outcomeSideLabel(outcome);
        const shortName = String(outcome.shortTranslatedName || '').trim();
        const outcomeName = String(outcome.name || '').trim();

        if (
          outcome.typeName === 'Draw' ||
          /^(?:egal|draw|remiza|x)$/i.test(sideLabel) ||
          /^(?:egal|draw|remiza|x)$/i.test(shortName) ||
          /^(?:egal|draw|remiza|x)$/i.test(outcomeName)
        ) {
          if (!drawOffer) drawOffer = { id: String(offer.outcomeId), odds };
        } else if (
          outcome.typeName === 'Home' ||
          outcome.paramParticipantName1 === home ||
          shortName === '1' ||
          outcomeName === '1' ||
          (home && (sideLabel === home || outcomeName === home)) ||
          /^(?:gazde|home|1)\b/i.test(sideLabel)
        ) {
          if (!homeOffer) homeOffer = { id: String(offer.outcomeId), odds };
        } else if (
          outcome.typeName === 'Away' ||
          outcome.paramParticipantName1 === away ||
          shortName === '2' ||
          outcomeName === '2' ||
          (away && (sideLabel === away || outcomeName === away)) ||
          /^(?:oasp|away|2)\b/i.test(sideLabel)
        ) {
          if (!awayOffer) awayOffer = { id: String(offer.outcomeId), odds };
        } else {
          hasUnexpectedSide = true;
          break;
        }
      }

      if (hasUnexpectedSide || !homeOffer || !awayOffer) continue;

      if (drawOffer) {
        // 3-way sub-window market (1X2 for halves, quarters)
        const periodKey = `${period}:3`;
        if (seenPeriodKeys.has(periodKey)) continue;
        seenPeriodKeys.add(periodKey);

        out.push({
          key: 'MATCH_ODDS',
          name: named(market),
          period,
          selections: [
            { id: `${match.id}:${market.id}:1`, name: '1', odds: homeOffer.odds, group: 'Main' },
            { id: `${match.id}:${market.id}:X`, name: 'X', odds: drawOffer.odds, group: 'Main' },
            { id: `${match.id}:${market.id}:2`, name: '2', odds: awayOffer.odds, group: 'Main' },
          ],
        });
      } else {
        // 2-way sub-window market (sets, quarters, halves)
        const periodKey = `${period}:2`;
        if (seenPeriodKeys.has(periodKey)) continue;
        seenPeriodKeys.add(periodKey);

        out.push({
          key: 'MATCH_ODDS',
          name: named(market),
          period,
          selections: [
            { id: `${match.id}:${market.id}:1`, name: '1', odds: homeOffer.odds, group: 'Main' },
            { id: `${match.id}:${market.id}:2`, name: '2', odds: awayOffer.odds, group: 'Main' },
          ],
        });
      }
    }
    return out;
  }

  // Corners and cards extractors were removed here on purpose.
  //
  // A live getsbet capture (2026-09-29, 21 events / 77 markets per dump) has NO
  // corners and NO cards market in any of its 19 betting type ids, so these
  // matched nothing and could only ever fire on a name coincidence.
  //
  // Worse, they were unsafe if they ever did fire. They emitted
  // CARDS_OVER_UNDER_<line> with the line in `handicap` only, and the generic
  // line-in-name path then resolves a lined "Over 4.5"/"Under 4.5" pair as
  // OVER_UNDER line=4.5, arbEligible: true — a card count published as though
  // it were a goals total, and therefore an arbitrable market against every
  // other book's real Over/Under 4.5. Non-goal totals must not enter
  // arbitrage buckets; a speculative extractor for a market the feed does not
  // have is the one place that rule is easiest to break by accident.
  //
  // The feed DOES publish several non-goal families, and all are left out on
  // purpose: 77/78 team totals, 32 goal intervals ("2 sau mai mult" — a
  // staircase, not two legs), 45 correct score, 8 the 3-way European handicap,
  // 11/624 half-time-or-full-time, 114 "wins either half" (a union, not
  // exhaustive), 140 "goal in both halves", and the 163/416/419/743
  // result-and-totals / double-chance-and-totals / BTTS-and-totals
  // combinations. None of them is an exhaustive two-way contract, and several
  // would settle a different way from a goals total with the same numbers.

  /**
   * Extract the 1X2 market (bettingTypeId 69) of one event dump.
   * Returns { market, offers: {'1':odds,'X':odds,'2':odds}, selections }
   * or null when the market/outcomes/offers are incomplete.
   */
  extractOneXTwo(match, records) {
    const markets = records.filter((r) => r._type === 'MARKET');
    // Several markets in one dump can share a bettingTypeId — a
    // regulation-time result and a first-half result both present as "match
    // result" to that field. Taking the first one found made the choice depend
    // on the order the dealer happened to serialise them, so the published
    // price flipped with it. Prefer the market whose own name says it settles
    // at full time, and only fall back to the first when none does.
    const named = (m) => {
      const parts = [m.displayName, m.name, m.shortName, m.eventPartName, m.shortEventPartName].filter(Boolean);
      return parts.join(' ');
    };
    const isSubWindow = (m) => /repriza\s*[12]|1st\s*half|2nd\s*half|first\s*half|second\s*half|half\s*time|pauza|\bpr\b|\bsr\b|sfert|quarter|set\b/i.test(named(m));
    const sameType = markets.filter((r) => String(r.bettingTypeId) === this.oneXTwoTypeId);
    const market = sameType.find((r) => !isSubWindow(r)) || sameType[0];
    if (!market) return null;

    // Scope the offers to *this* market so a half-time market's prices cannot
    // be mistaken for the result market's. When the dump names no market on
    // either side the link cannot be established — keep those offers rather
    // than dropping a complete market, since there is nothing to confuse them
    // with. Confusable dumps do carry the id.
    const offers = records.filter((r) => {
      if (r._type !== 'BETTING_OFFER') return false;
      if (String(r.bettingTypeId) !== this.oneXTwoTypeId) return false;
      const offerMarket = outcomeMarketId(r, records);
      return offerMarket === null || offerMarket === String(market.id);
    });
    if (offers.length < 3) return null;

    const outcomes = new Map(
      records.filter((r) => r._type === 'OUTCOME').map((o) => [String(o.id), o]),
    );
    const home = match.homeParticipantName;
    const away = match.awayParticipantName;
    const mapped = { home: null, draw: null, away: null };
    for (const offer of offers) {
      const outcome = outcomes.get(String(offer.outcomeId));
      if (!outcome) continue;
      const odds = Number(offer.odds);
      if (!Number.isFinite(odds) || odds <= 1 || offer.isAvailable === false) continue;
      if (outcome.typeName === 'Draw' || /egal/i.test(String(outcome.shortTranslatedName || ''))) {
        // Two offers for the same side is a contradiction, not a price. Take
        // the first and ignore the rest rather than letting the last write.
        if (mapped.draw === null) mapped.draw = odds;
      } else if (outcome.paramParticipantName1 === home) {
        if (mapped.home === null) mapped.home = odds;
      } else if (outcome.paramParticipantName1 === away) {
        if (mapped.away === null) mapped.away = odds;
      }
    }
    if (mapped.home === null || mapped.draw === null || mapped.away === null) return null;
    return {
      market,
      selections: ['1', 'X', '2'],
      offers: { '1': mapped.home, X: mapped.draw, '2': mapped.away },
    };
  }

  /**
   * Extract the 2-way Match Winner market for two-way sports (Basketball, Tennis).
   * Supports bettingTypeId 249 / 70 / 1 or named winner markets, without sub-windows.
   * Returns { market, selections: ['1', '2'], offers: { '1': odds, '2': odds } }
   * or null when incomplete or contains a draw outcome.
   */
  extractTwoWayMatchWinner(match, records) {
    const markets = records.filter((r) => r._type === 'MARKET');
    const named = (m) => String(m.displayName || m.name || '');
    const isSubWindow = (m) => /repriza|set\s*\d|quarter|sfert|1st\s*half|2nd\s*half|first\s*half|second\s*half|half\s*time|pauza/i.test(named(m));
    const isCandidate = (m) => {
      const type = String(m.bettingTypeId || '');
      if (type === this.twoWayMatchWinnerTypeId || type === '70' || type === '249' || type === '1') return true;
      if (type === this.oneXTwoTypeId) return true;
      return /câștigător\s*(?:meci)?|castigator\s*(?:meci)?|match\s*winner|winner\b/i.test(named(m));
    };

    const candidates = markets.filter((m) => isCandidate(m) && !isSubWindow(m));
    if (candidates.length === 0) return null;

    const outcomes = new Map(
      records.filter((r) => r._type === 'OUTCOME').map((o) => [String(o.id), o]),
    );
    const home = match.homeParticipantName;
    const away = match.awayParticipantName;

    for (const market of candidates) {
      const offers = records.filter((r) => {
        if (r._type !== 'BETTING_OFFER') return false;
        if (String(r.bettingTypeId) !== String(market.bettingTypeId)) return false;
        const offerMarket = outcomeMarketId(r, records);
        return offerMarket === null || offerMarket === String(market.id);
      });
      if (offers.length < 2) continue;

      let homeOdds = null;
      let awayOdds = null;
      let hasDraw = false;

      for (const offer of offers) {
        const outcome = outcomes.get(String(offer.outcomeId));
        if (!outcome) continue;
        const odds = Number(offer.odds);
        if (!Number.isFinite(odds) || odds <= 1 || offer.isAvailable === false) continue;

        if (outcome.typeName === 'Draw' || /egal/i.test(String(outcome.shortTranslatedName || ''))) {
          hasDraw = true;
          break;
        }

        if (
          outcome.typeName === 'Home' ||
          outcome.paramParticipantName1 === home ||
          outcome.shortTranslatedName === '1' ||
          outcome.name === '1' ||
          (home && outcome.name === home)
        ) {
          if (homeOdds === null) homeOdds = odds;
        } else if (
          outcome.typeName === 'Away' ||
          outcome.paramParticipantName1 === away ||
          outcome.shortTranslatedName === '2' ||
          outcome.name === '2' ||
          (away && outcome.name === away)
        ) {
          if (awayOdds === null) awayOdds = odds;
        }
      }

      if (hasDraw) continue;
      if (homeOdds !== null && awayOdds !== null) {
        return {
          market,
          selections: ['1', '2'],
          offers: { '1': homeOdds, '2': awayOdds },
        };
      }
    }

    return null;
  }
}
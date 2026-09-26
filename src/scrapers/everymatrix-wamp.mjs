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
import ScraperBase from './base.mjs';
/* global WebSocket */

/**
 * The market a BETTING_OFFER belongs to, resolved through its OUTCOME.
 *
 * A match dump is flat: OFFER records reference an outcome, and the outcome
 * carries the market it prices. Matching offers on `bettingTypeId` alone is not
 * enough, because several markets in one dump can share a type — a
 * regulation-time result and a first-half result both look like "match result"
 * to that field — and the last one parsed would silently win.
 *
 * Returns null when the link cannot be established, so an offer that names no
 * market is not attributed to one.
 *
 * @param {object} offer
 * @param {object[]} records  the full dump, used to resolve outcomes
 * @returns {string|null}
 */
function outcomeMarketId(offer, records) {
  if (offer?.marketId !== undefined && offer?.marketId !== null) return String(offer.marketId);
  const outcome = records.find((r) => r._type === 'OUTCOME' && String(r.id) === String(offer?.outcomeId));
  const id = outcome?.marketId;
  return id === undefined || id === null ? null : String(id);
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

  // A tournament index can contain hundreds of historical/derivative groups.
  // Keep discovery bounded while still covering substantially more than the
  // default event target (the live feed observed many matches per group).
  tournamentDumpLimit = 24;
  // Bounded candidate pool compensates for incomplete 1X2 markets without
  // allowing unbounded WebSocket fan-out.
  eventScanLimit = 240;
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
    for (const { match, records } of rawEvents) {
      const selected = this.extractOneXTwo(match, records);
      if (!selected) continue;
      const kickoffMs = Number(match.startTime);
      if (!Number.isFinite(kickoffMs) || kickoffMs <= Date.now()) continue;
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
        ...this.extractBothTeamsToScore(match, records),
        ...this.extractDoubleChance(match, records),
        ...this.extractDrawNoBet(match, records),
        ...this.extractCorners(match, records),
        ...this.extractCards(match, records),
      ];
      if (seenEventKeys.has(eventKey)) continue;
      seenEventKeys.add(eventKey);
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
        markets: [{
          key: 'MATCH_ODDS',
          name: market.displayName || market.name || 'Match Odds',
          selections: selections.map((kind) => ({
            id: `${match.id}:${kind}`,
            name: kind,
            odds: offers[kind],
            group: 'Main',
          })),
        }, ...extraMarkets],
      });
      if (limitReached(out.length, this.maxEvents)) break;
    }
    return out;
  }

  extractTotals(match, records) {
    const markets = records.filter((record) =>
      record._type === 'MARKET' &&
      (String(record.bettingTypeId) === '47' || /^(?:total|peste\/sub|over\/under)/i.test(record.name || record.displayName || '')) &&
      Number.isFinite(Number(record.paramFloat1))
    );
    const offers = records.filter((record) => record._type === 'BETTING_OFFER' && record.isAvailable !== false && Number(record.odds) > 1);
    const outcomeNames = new Map(records.filter((record) => record._type === 'OUTCOME').map((record) => [String(record.id), record]));
    return markets.flatMap((market) => {
      const line = Number(market.paramFloat1);
      if (!Number.isFinite(line) || line <= 0) return [];
      const isAsian = market.asianLine === true;
      const lineOffers = offers.filter((offer) => outcomeNames.has(String(offer.outcomeId)));
      const mapped = lineOffers.map((offer) => {
        const outcome = outcomeNames.get(String(offer.outcomeId));
        if (outcome && String(outcome.marketId) !== String(market.id)) return null;
        const label = String(outcome?.typeName || outcome?.shortTranslatedName || outcome?.name || '');
        if (!/peste|sub|over|under/i.test(label)) return null;
        return { id: String(offer.id), name: /sub|under/i.test(label) ? 'Under' : 'Over', odds: Number(offer.odds), handicap: line, group: 'Main' };
      }).filter(Boolean);
      const unique = new Map(mapped.map((selection) => [selection.name, selection]));
      if (!unique.has('Over') || !unique.has('Under')) return [];
      const marketName = market.displayName || market.name || '';
      const is1H = /repriza\s*1|1st\s*half|prima\s*repriza/i.test(marketName);
      const key = isAsian ? `AH_${String(line).replace('.', '_')}` : `OVER_UNDER_${String(line).replace('.', '_')}${is1H ? '_1H' : ''}`;
      return [{ key, name: marketName || `Total ${line}`, selections: [unique.get('Over'), unique.get('Under')] }];
    });
  }

  extractBothTeamsToScore(match, records) {
    const markets = records.filter((r) =>
      r._type === 'MARKET' &&
      (String(r.bettingTypeId) === '70' || /both.*team|ambele.*(?:inscriu|marcheaza)|gg\/ng/i.test(r.name || r.displayName || ''))
    );
    if (!markets.length) return [];
    const outcomeNames = new Map(records.filter((r) => r._type === 'OUTCOME').map((r) => [String(r.id), r]));
    const offers = records.filter((r) => r._type === 'BETTING_OFFER' && r.isAvailable !== false && Number(r.odds) > 1);

    for (const market of markets) {
      const mapped = offers.map((offer) => {
        const outcome = outcomeNames.get(String(offer.outcomeId));
        if (outcome && String(outcome.marketId) !== String(market.id)) return null;
        const label = String(outcome?.typeName || outcome?.shortTranslatedName || outcome?.name || '');
        if (/^(?:yes|da|gg)\b/i.test(label)) return { id: String(offer.id), name: 'Yes', odds: Number(offer.odds), group: 'Main' };
        if (/^(?:no|nu|ng)\b/i.test(label)) return { id: String(offer.id), name: 'No', odds: Number(offer.odds), group: 'Main' };
        return null;
      }).filter(Boolean);

      const unique = new Map(mapped.map((s) => [s.name, s]));
      if (unique.has('Yes') && unique.has('No')) {
        const is1H = /repriza\s*1|1st\s*half|prima\s*repriza/i.test(market.displayName || market.name || '');
        return [{
          key: is1H ? 'BOTH_TEAMS_SCORE_1H' : 'BOTH_TEAMS_SCORE',
          name: market.displayName || market.name || 'Both Teams To Score',
          selections: [unique.get('Yes'), unique.get('No')],
        }];
      }
    }
    return [];
  }

  extractDoubleChance(match, records) {
    const markets = records.filter((r) =>
      r._type === 'MARKET' &&
      (String(r.bettingTypeId) === '71' || /double\s*chance|sansa\s*dubla/i.test(r.name || r.displayName || ''))
    );
    if (!markets.length) return [];
    const outcomeNames = new Map(records.filter((r) => r._type === 'OUTCOME').map((r) => [String(r.id), r]));
    const offers = records.filter((r) => r._type === 'BETTING_OFFER' && r.isAvailable !== false && Number(r.odds) > 1);

    for (const market of markets) {
      const mapped = offers.map((offer) => {
        const outcome = outcomeNames.get(String(offer.outcomeId));
        if (outcome && String(outcome.marketId) !== String(market.id)) return null;
        const label = String(outcome?.typeName || outcome?.shortTranslatedName || outcome?.name || '').replace(/\s+/g, '').toUpperCase();
        if (['1X', 'X2', '12'].includes(label)) {
          return { id: String(offer.id), name: label, odds: Number(offer.odds), group: 'Main' };
        }
        return null;
      }).filter(Boolean);

      const unique = new Map(mapped.map((s) => [s.name, s]));
      if (['1X', 'X2', '12'].every((k) => unique.has(k))) {
        const is1H = /repriza\s*1|1st\s*half|prima\s*repriza/i.test(market.displayName || market.name || '');
        return [{
          key: is1H ? 'DOUBLE_CHANCE_1H' : 'DOUBLE_CHANCE',
          name: market.displayName || market.name || 'Double Chance',
          selections: ['1X', 'X2', '12'].map((k) => unique.get(k)),
        }];
      }
    }
    return [];
  }

  extractDrawNoBet(match, records) {
    const markets = records.filter((r) =>
      r._type === 'MARKET' &&
      /fara\s*egal|draw\s*no\s*bet|dnb/i.test(r.name || r.displayName || '')
    );
    if (!markets.length) return [];
    const outcomeNames = new Map(records.filter((r) => r._type === 'OUTCOME').map((r) => [String(r.id), r]));
    const offers = records.filter((r) => r._type === 'BETTING_OFFER' && r.isAvailable !== false && Number(r.odds) > 1);

    for (const market of markets) {
      const mapped = offers.map((offer) => {
        const outcome = outcomeNames.get(String(offer.outcomeId));
        if (outcome && String(outcome.marketId) !== String(market.id)) return null;
        const label = String(outcome?.typeName || outcome?.shortTranslatedName || outcome?.name || '');
        if (/^[1]$|^home\b/i.test(label)) return { id: String(offer.id), name: '1', odds: Number(offer.odds), group: 'Main' };
        if (/^[2]$|^away\b/i.test(label)) return { id: String(offer.id), name: '2', odds: Number(offer.odds), group: 'Main' };
        return null;
      }).filter(Boolean);
      const unique = new Map(mapped.map((s) => [s.name, s]));
      if (unique.has('1') && unique.has('2')) {
        const is1H = /repriza\s*1|1st\s*half|prima\s*repriza/i.test(market.displayName || market.name || '');
        return [{ key: is1H ? 'DNB_1H' : 'DRAW_NO_BET', name: market.displayName || market.name || 'Draw No Bet', selections: [unique.get('1'), unique.get('2')] }];
      }
    }
    return [];
  }

  extractCorners(match, records) {
    const markets = records.filter((r) =>
      r._type === 'MARKET' &&
      /cornere|corners|corner/i.test(r.name || r.displayName || '') &&
      Number.isFinite(Number(r.paramFloat1))
    );
    if (!markets.length) return [];
    const outcomeNames = new Map(records.filter((r) => r._type === 'OUTCOME').map((r) => [String(r.id), r]));
    const offers = records.filter((r) => r._type === 'BETTING_OFFER' && r.isAvailable !== false && Number(r.odds) > 1);

    return markets.flatMap((market) => {
      const line = Number(market.paramFloat1);
      if (!Number.isFinite(line) || line <= 0) return [];
      const mapped = offers.map((offer) => {
        const outcome = outcomeNames.get(String(offer.outcomeId));
        if (outcome && String(outcome.marketId) !== String(market.id)) return null;
        const label = String(outcome?.typeName || outcome?.shortTranslatedName || outcome?.name || '');
        if (!/peste|sub|over|under/i.test(label)) return null;
        return { id: String(offer.id), name: /sub|under/i.test(label) ? 'Under' : 'Over', odds: Number(offer.odds), handicap: line, group: 'Main' };
      }).filter(Boolean);
      const unique = new Map(mapped.map((s) => [s.name, s]));
      if (!unique.has('Over') || !unique.has('Under')) return [];
      return [{ key: `CORNERS_OVER_UNDER_${String(line).replace('.', '_')}`, name: market.displayName || market.name || `Corners ${line}`, selections: [unique.get('Over'), unique.get('Under')] }];
    });
  }

  extractCards(match, records) {
    const markets = records.filter((r) =>
      r._type === 'MARKET' &&
      /cartonase|cards|yellow card|red card/i.test(r.name || r.displayName || '') &&
      Number.isFinite(Number(r.paramFloat1))
    );
    if (!markets.length) return [];
    const outcomeNames = new Map(records.filter((r) => r._type === 'OUTCOME').map((r) => [String(r.id), r]));
    const offers = records.filter((r) => r._type === 'BETTING_OFFER' && r.isAvailable !== false && Number(r.odds) > 1);

    return markets.flatMap((market) => {
      const line = Number(market.paramFloat1);
      if (!Number.isFinite(line) || line <= 0) return [];
      const mapped = offers.map((offer) => {
        const outcome = outcomeNames.get(String(offer.outcomeId));
        if (outcome && String(outcome.marketId) !== String(market.id)) return null;
        const label = String(outcome?.typeName || outcome?.shortTranslatedName || outcome?.name || '');
        if (!/peste|sub|over|under/i.test(label)) return null;
        return { id: String(offer.id), name: /sub|under/i.test(label) ? 'Under' : 'Over', odds: Number(offer.odds), handicap: line, group: 'Main' };
      }).filter(Boolean);
      const unique = new Map(mapped.map((s) => [s.name, s]));
      if (!unique.has('Over') || !unique.has('Under')) return [];
      return [{ key: `CARDS_OVER_UNDER_${String(line).replace('.', '_')}`, name: market.displayName || market.name || `Cards ${line}`, selections: [unique.get('Over'), unique.get('Under')] }];
    });
  }

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
    const named = (m) => String(m.displayName || m.name || '');
    const isSubWindow = (m) => /repriza\s*1|repriza\s*2|1st\s*half|2nd\s*half|first\s*half|second\s*half|half\s*time|pauza/i.test(named(m));
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
}
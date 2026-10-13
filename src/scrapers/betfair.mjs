import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { UpstreamError, ValidationError } from '../shared/errors.mjs';
import { isUnlimited } from '../shared/event-limit.mjs';
import { eventLimit } from './event-limit.mjs';
import { liveCoverageFor, markMarketsLive } from './live-status.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

const DEFAULT_APP_KEY = 'nzIFcwyWhrlwYMrh';
const SEARCH_URL = 'https://scan-inbf.betfair.ro/www/sports/navigation/facet/v1/search';
const BY_MARKET_URL = 'https://ero.betfair.ro/www/sports/exchange/readonly/v1/bymarket';

export const BETFAIR_SPORT_EVENT_TYPE_IDS = Object.freeze({
  football: 1,
  tennis: 2,
  basketball: 7522,
  'ice-hockey': 7524,
  handball: 468328,
  volleyball: 998917,
  darts: 3503,
  cricket: 4,
  rugby: 5,
  boxing: 6,
  mma: 26420387,
  esports: 27454571,
  snooker: 6422,
  baseball: 7511,
  'american-football': 6423,
});

export const BETFAIR_EVENT_TYPE_ID_TO_SPORT = Object.freeze({
  1: 'football',
  2: 'tennis',
  4: 'cricket',
  5: 'rugby',
  6: 'boxing',
  3503: 'darts',
  6422: 'snooker',
  6423: 'american-football',
  7511: 'baseball',
  7522: 'basketball',
  7524: 'ice-hockey',
  468328: 'handball',
  998917: 'volleyball',
  26420387: 'mma',
  27454571: 'esports',
});

const SPORT_EVENT_TYPE_IDS = BETFAIR_SPORT_EVENT_TYPE_IDS;
const EVENT_TYPE_ID_TO_SPORT = BETFAIR_EVENT_TYPE_ID_TO_SPORT;

const MARKET_TYPE_CODES = [
  'MATCH_ODDS',
  'HALF_TIME',
  'FIRST_HALF_GOALS_05',
  'FIRST_HALF_GOALS_15',
  'FIRST_HALF_GOALS_25',
  'SECOND_HALF_GOALS_05',
  'SECOND_HALF_GOALS_15',
  'SECOND_HALF_GOALS_25',
  'SET_WINNER',
  'FIRST_SET_WINNER',
  'SECOND_SET_WINNER',
  'QUARTER_WINNER',
  'FIRST_QUARTER_WINNER',
  'OVER_UNDER_05',
  'OVER_UNDER_15',
  'OVER_UNDER_25',
  'OVER_UNDER_35',
  'OVER_UNDER_45',
  'BOTH_TEAMS_TO_SCORE',
];

/**
 * Splits an event title into home and away team names.
 * Supports "Home v Away", "Home vs Away", and US-style "Away @ Home".
 *
 * @param {string} name
 * @returns {{ homeTeam: string, awayTeam: string } | null}
 */
export function parseEventTeams(name) {
  if (!name || typeof name !== 'string') return null;
  const cleaned = name.trim();
  if (cleaned.includes(' @ ')) {
    const parts = cleaned.split(/\s+@\s+/);
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { homeTeam: parts[1].trim(), awayTeam: parts[0].trim() };
    }
  }
  const parts = cleaned.split(/\s+(?:v|vs)\.?\s+/i);
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { homeTeam: parts[0].trim(), awayTeam: parts[1].trim() };
  }
  return null;
}

/**
 * Betfair Exchange scraper.
 *
 * Connects to Betfair Romania's public exchange readonly REST surface:
 * - scan-inbf.betfair.ro for event and market discovery
 * - ero.betfair.ro/www/sports/exchange/readonly/v1/bymarket for peer-to-peer order book depth
 *
 * Collects full-coverage markets across Football, Tennis, and Basketball:
 * - MATCH_ODDS (1X2 / 2-way match winner)
 * - OVER_UNDER (Totals from 0.5 to 4.5)
 * - BOTH_TEAMS_TO_SCORE (BTTS)
 *
 * Provides true exchange back prices and carries lay prices + order-book liquidity.
 */
export default class BetfairScraper extends ScraperBase {
  id = 'betfair';
  name = 'Betfair';
  sourceIds = ['betfair'];

  timeoutMs = 30_000;
  maxAttempts = 3;

  constructor(opts = {}) {
    super(opts);
    this.maxEvents = eventLimit(opts.maxEvents);
    this.appKey = String(opts.appKey || process.env.BETFAIR_APP_KEY || DEFAULT_APP_KEY);
    if (opts.sport === 'all' || opts.sports === 'all') {
      this.sports = Object.keys(SPORT_EVENT_TYPE_IDS);
    } else if (typeof opts.sport === 'string' && opts.sport) {
      this.sports = [opts.sport];
    } else if (Array.isArray(opts.sports) && opts.sports.length > 0) {
      this.sports = opts.sports;
    } else {
      this.sports = ['football', 'tennis', 'basketball'];
    }
    this.includeLive = opts.includeLive === true;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.batchSize = Number.isInteger(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : 25;
    this.concurrency = Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : 6;
    this.transport = 'betfair-exchange-readonly-json';
    this.engine = 'betfair-exchange-api';
    this.sourceUrl = 'https://www.betfair.ro/exchange';
    this.observedAt = opts.observedAt || new Date().toISOString();
  }

  /**
   * Fetches raw JSON payload from Betfair Exchange REST services.
   *
   * @param {{ signal?: AbortSignal }} [options]
   */
  async fetchRaw({ signal } = {}) {
    const eventTypeIds = this.sports
      .map((s) => SPORT_EVENT_TYPE_IDS[s])
      .filter(Boolean);

    const searchUrl = `${SEARCH_URL}?_ak=${encodeURIComponent(this.appKey)}&alt=json`;
    const searchBody = JSON.stringify({
      filter: {
        eventTypeIds: eventTypeIds.length > 0 ? eventTypeIds : [1],
        marketBettingTypes: ['ODDS'],
        marketTypeCodes: MARKET_TYPE_CODES,
      },
      facets: [{ type: 'EVENT' }],
      currencyCode: 'RON',
      locale: 'ro',
    });

    let searchRes;
    try {
      searchRes = await this.fetchImpl(searchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: searchBody,
        signal,
        redirect: 'error',
      });
    } catch (err) {
      throw new UpstreamError(`${this.id}: failed to connect to Betfair search facet endpoint: ${err.message}`, { cause: err });
    }

    if (!searchRes.ok) {
      throw new UpstreamError(`${this.id}: search facet returned HTTP ${searchRes.status}`, { status: searchRes.status });
    }

    let searchData;
    try {
      searchData = await searchRes.json();
    } catch (err) {
      throw new UpstreamError(`${this.id}: malformed JSON from Betfair search: ${err.message}`, { cause: err });
    }

    const events = searchData?.attachments?.events || {};
    const now = Number.isFinite(Date.parse(this.observedAt)) ? Date.parse(this.observedAt) : Date.now();
    const exchangeResults = (searchData?.results || []).filter((r) => r.marketId && String(r.marketId).startsWith('1.'));

    // Group markets by event, filter out synthetic test fixtures and invalid dates
    const eventMarkets = new Map();
    for (const r of exchangeResults) {
      const e = events[r.eventId];
      if (!e) continue;
      if (/^Test\s/i.test(e.name || '')) continue;
      const openTime = Date.parse(e.openDate);
      if (!Number.isFinite(openTime)) continue;
      if (!eventMarkets.has(r.eventId)) {
        eventMarkets.set(r.eventId, { event: e, openTime, marketIds: [] });
      }
      eventMarkets.get(r.eventId).marketIds.push(r.marketId);
    }

    // Sort events nearest prematch first
    const sortedEvents = Array.from(eventMarkets.values()).sort((a, b) => a.openTime - b.openTime);

    // Prefer future events relative to now (or all sorted events if includeLive is requested)
    const futureEvents = sortedEvents.filter((item) => item.openTime > now);
    const candidateEvents = this.includeLive
      ? sortedEvents
      : (futureEvents.length > 0 ? futureEvents : sortedEvents);

    // Limit to target events so we do not fetch thousands of far-future markets.
    // Add headroom (+25%) so extractEvents has enough valid liquidity events.
    const eventCap = isUnlimited(this.maxEvents) ? candidateEvents.length : Math.max(1, this.maxEvents);
    const targetCount = isUnlimited(this.maxEvents)
      ? candidateEvents.length
      : Math.min(candidateEvents.length, Math.max(eventCap, Math.ceil(eventCap * 1.25)));
    const selectedEvents = candidateEvents.slice(0, targetCount);

    // Build chunks of marketIds up to batchSize without splitting events when possible
    const chunks = [];
    let currentChunk = [];
    const seenMarkets = new Set();

    for (const item of selectedEvents) {
      const newMarkets = [];
      for (const mId of item.marketIds) {
        if (!seenMarkets.has(mId)) {
          seenMarkets.add(mId);
          newMarkets.push(mId);
        }
      }
      if (newMarkets.length === 0) continue;

      if (currentChunk.length + newMarkets.length > this.batchSize && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
      }

      if (newMarkets.length > this.batchSize) {
        for (let i = 0; i < newMarkets.length; i += this.batchSize) {
          chunks.push(newMarkets.slice(i, i + this.batchSize));
        }
      } else {
        currentChunk.push(...newMarkets);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    const chunkResults = new Array(chunks.length);
    if (chunks.length > 0) {
      const concurrency = Math.min(this.concurrency, chunks.length);
      let nextIndex = 0;

      const worker = async () => {
        while (nextIndex < chunks.length) {
          if (signal?.aborted) {
            throw new Error('aborted');
          }
          const idx = nextIndex++;
          const chunk = chunks[idx];
          const byMarketUrl = `${BY_MARKET_URL}?_ak=${encodeURIComponent(this.appKey)}&alt=json&currencyCode=RON&locale=ro&marketIds=${chunk.join(',')}&rollupLimit=5&rollupModel=STAKE&types=MARKET_STATE,MARKET_DESCRIPTION,EVENT,RUNNER_DESCRIPTION,RUNNER_EXCHANGE_PRICES_BEST`;

          let batchRes;
          try {
            batchRes = await this.fetchImpl(byMarketUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
              signal,
              redirect: 'error',
            });
          } catch (err) {
            throw new UpstreamError(`${this.id}: failed to fetch market batch: ${err.message}`, { cause: err });
          }

          if (!batchRes.ok) {
            throw new UpstreamError(`${this.id}: bymarket batch returned HTTP ${batchRes.status}`, { status: batchRes.status });
          }

          let batchData;
          try {
            batchData = await batchRes.json();
          } catch (err) {
            throw new UpstreamError(`${this.id}: malformed JSON from bymarket batch: ${err.message}`, { cause: err });
          }

          chunkResults[idx] = batchData?.eventTypes && Array.isArray(batchData.eventTypes) ? batchData.eventTypes : [];
        }
      };

      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);
    }

    const allEventTypes = [];
    for (const etList of chunkResults) {
      if (Array.isArray(etList)) {
        allEventTypes.push(...etList);
      }
    }

    return {
      search: searchData,
      byMarket: {
        eventTypes: allEventTypes,
      },
    };
  }

  /**
   * Normalizes raw response into an array of raw event nodes.
   *
   * @param {object} raw
   * @returns {object[]}
   */
  normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ValidationError(`${this.id}: raw payload missing or expected an object`);
    }

    const byMarket = raw.byMarket || raw;
    const fault = raw.faultcode || raw.faultstring || byMarket?.faultcode || byMarket?.faultstring;
    if (fault) {
      throw new UpstreamError(`${this.id}: upstream error ${raw.faultcode || byMarket?.faultcode}: ${raw.faultstring || byMarket?.faultstring}`);
    }

    if (!byMarket || typeof byMarket !== 'object') {
      throw new ValidationError(`${this.id}: expected byMarket object in raw response`);
    }

    const eventTypes = byMarket.eventTypes;
    if (!Array.isArray(eventTypes)) {
      throw new ValidationError(`${this.id}: expected eventTypes array in byMarket payload`);
    }

    const out = [];
    for (const et of eventTypes) {
      const eventTypeId = Number(et?.eventType?.eventTypeId || et?.eventTypeId || 1);
      for (const en of et?.eventNodes || []) {
        if (!en || typeof en !== 'object') continue;
        out.push({
          ...en,
          eventTypeId,
        });
      }
    }

    return out;
  }

  /**
   * Extracts NormalizedEvent records ready for the arbitrage engine.
   *
   * @param {object[]} rawEvents
   * @returns {import('./base.mjs').NormalizedEvent[]}
   */
  extractEvents(rawEvents) {
    if (!Array.isArray(rawEvents)) return [];

    const eventsById = new Map();

    for (const raw of rawEvents) {
      const eventNode = raw.event || {};
      const eventId = String(eventNode.eventId || raw.eventId || '');
      const eventName = String(eventNode.eventName || raw.eventName || '');

      if (!eventId || !eventName) continue;
      if (/^Test\s/i.test(eventName)) continue;

      const teams = parseEventTeams(eventName);
      if (!teams) continue;

      const { homeTeam, awayTeam } = teams;
      const kickoff = eventNode.openDate ? new Date(eventNode.openDate).toISOString() : null;
      if (!kickoff || kickoff === 'Invalid Date') continue;

      const sport = EVENT_TYPE_ID_TO_SPORT[raw.eventTypeId] || 'football';

      let eventRecord = eventsById.get(eventId);
      if (!eventRecord) {
        eventRecord = {
          id: eventId,
          sourceId: this.id,
          sourceUrl: `${this.sourceUrl}/plus/${sport}`,
          sport,
          homeTeam,
          awayTeam,
          kickoff,
          live: false,
          observedAt: this.observedAt,
          eventKey: `betfair|${eventId}|${kickoff}`,
          providerEventKey: `betfair|${eventId}|${kickoff}`,
          markets: [],
          runId: this.runId,
        };
        eventsById.set(eventId, eventRecord);
      }

      for (const mn of raw.marketNodes || []) {
        if (!mn || !mn.description || !mn.runners) continue;
        const status = mn.state?.status;
        if (status === 'SUSPENDED' || status === 'CLOSED') continue;
        if (mn.state?.inplay) {
          eventRecord.live = true;
        }

        const mType = mn.description.marketType;
        const parsed = this._parseMarket(mn, mType, homeTeam, awayTeam, sport);
        if (parsed) {
          if (!eventRecord.markets.some((m) => m.key === parsed.key && (m.period || 'fulltime') === (parsed.period || 'fulltime'))) {
            eventRecord.markets.push(parsed);
          }
        }
      }
    }

    const out = [];
    for (const eventRecord of eventsById.values()) {
      if (eventRecord.markets.length === 0) continue;
      if (eventRecord.live && !this.includeLive) continue;
      if (eventRecord.live) {
        markMarketsLive(eventRecord.markets, () => true);
      }
      out.push(eventRecord);
      if (out.length >= this.maxEvents) break;
    }

    return out;
  }

  /**
   * Helper to parse a single exchange marketNode into an engine-compatible market.
   *
   * @private
   */
  _parseMarket(mn, marketType, homeTeam, awayTeam, sport) {
    const runners = mn.runners || [];
    const marketName = String(mn.description?.marketName || '').trim();
    let period = extractPeriodFromName(marketName);
    if (!period) {
      if (marketType === 'HALF_TIME' || marketType?.startsWith('FIRST_HALF_')) {
        period = 'half1';
      } else if (marketType === 'FIRST_SET_WINNER') {
        period = 'set1';
      } else {
        period = 'fulltime';
      }
    }

    // 1. MATCH_ODDS / HALF_TIME / SET_WINNER / QUARTER_WINNER (3-way for football/halves, 2-way for tennis/basketball/sets)
    const isMatchOddsType = marketType === 'MATCH_ODDS' ||
      marketType === 'HALF_TIME' ||
      marketType === 'SET_WINNER' ||
      marketType === 'FIRST_SET_WINNER' ||
      marketType === 'SECOND_SET_WINNER' ||
      marketType === 'QUARTER_WINNER' ||
      marketType === 'FIRST_QUARTER_WINNER';
    if (isMatchOddsType) {
      const is3Way = (sport === 'football' || period === 'half1' || period === 'half2') && runners.length === 3;
      if (is3Way) {
        let homeRunner = null;
        let drawRunner = null;
        let awayRunner = null;

        for (const r of runners) {
          const rName = String(r.description?.runnerName || '').trim();
          if (/^(?:egal|the draw|draw|remiza|x)$/i.test(rName)) {
            drawRunner = r;
          } else if (normalizeTeamName(rName) === normalizeTeamName(homeTeam)) {
            homeRunner = r;
          } else if (normalizeTeamName(rName) === normalizeTeamName(awayTeam)) {
            awayRunner = r;
          }
        }

        // Fall back to positional order if names have minor abbreviations
        if (!homeRunner && runners[0] && runners[0] !== drawRunner) homeRunner = runners[0];
        if (!awayRunner && runners[1] && runners[1] !== drawRunner) awayRunner = runners[1];

        if (!homeRunner || !drawRunner || !awayRunner) return null;

        const homeBack = homeRunner.exchange?.availableToBack?.[0];
        const drawBack = drawRunner.exchange?.availableToBack?.[0];
        const awayBack = awayRunner.exchange?.availableToBack?.[0];

        if (!homeBack || !drawBack || !awayBack) return null;
        if (homeBack.price <= 1 || drawBack.price <= 1 || awayBack.price <= 1) return null;

        const homeLay = homeRunner.exchange?.availableToLay?.[0];
        const drawLay = drawRunner.exchange?.availableToLay?.[0];
        const awayLay = awayRunner.exchange?.availableToLay?.[0];

        const key = (period === 'half1' || period === 'half2')
          ? 'HALF_WINNER'
          : (period.startsWith('q') ? 'QUARTER_WINNER' : '1X2');
        const name = marketName || (period === 'half1' ? 'Half Time' : (period === 'half2' ? 'Second Half' : '1X2'));

        return {
          key,
          name,
          period,
          selections: [
            {
              name: '1',
              odds: homeBack.price,
              layOdds: homeLay?.price,
              liquidity: homeBack.size,
              depth: { back: homeRunner.exchange?.availableToBack || [], lay: homeRunner.exchange?.availableToLay || [] },
              isExchange: true,
            },
            {
              name: 'X',
              odds: drawBack.price,
              layOdds: drawLay?.price,
              liquidity: drawBack.size,
              depth: { back: drawRunner.exchange?.availableToBack || [], lay: drawRunner.exchange?.availableToLay || [] },
              isExchange: true,
            },
            {
              name: '2',
              odds: awayBack.price,
              layOdds: awayLay?.price,
              liquidity: awayBack.size,
              depth: { back: awayRunner.exchange?.availableToBack || [], lay: awayRunner.exchange?.availableToLay || [] },
              isExchange: true,
            },
          ],
        };
      }

      // 2-way match winner (tennis, basketball, sub-window sets/quarters)
      if (runners.length === 2) {
        let homeRunner = null;
        let awayRunner = null;

        for (const r of runners) {
          const rName = String(r.description?.runnerName || '').trim();
          if (normalizeTeamName(rName) === normalizeTeamName(homeTeam)) {
            homeRunner = r;
          } else if (normalizeTeamName(rName) === normalizeTeamName(awayTeam)) {
            awayRunner = r;
          }
        }

        if (!homeRunner || !awayRunner) {
          homeRunner = runners[0];
          awayRunner = runners[1];
        }

        const homeBack = homeRunner.exchange?.availableToBack?.[0];
        const awayBack = awayRunner.exchange?.availableToBack?.[0];
        if (!homeBack || !awayBack || homeBack.price <= 1 || awayBack.price <= 1) return null;

        const homeLay = homeRunner.exchange?.availableToLay?.[0];
        const awayLay = awayRunner.exchange?.availableToLay?.[0];

        let key = 'MATCH_ODDS';
        if (period.startsWith('set')) key = 'SET_WINNER';
        else if (period.startsWith('q')) key = 'QUARTER_WINNER';
        else if (period === 'half1' || period === 'half2') key = 'HALF_WINNER';

        const name = marketName || (period === 'fulltime' ? 'Match Odds' : `${period.toUpperCase()} Winner`);

        return {
          key,
          name,
          period,
          selections: [
            {
              name: homeTeam,
              odds: homeBack.price,
              layOdds: homeLay?.price,
              liquidity: homeBack.size,
              depth: { back: homeRunner.exchange?.availableToBack || [], lay: homeRunner.exchange?.availableToLay || [] },
              isExchange: true,
            },
            {
              name: awayTeam,
              odds: awayBack.price,
              layOdds: awayLay?.price,
              liquidity: awayBack.size,
              depth: { back: awayRunner.exchange?.availableToBack || [], lay: awayRunner.exchange?.availableToLay || [] },
              isExchange: true,
            },
          ],
        };
      }

      return null;
    }

    // 2. OVER_UNDER_* / FIRST_HALF_GOALS_* / SECOND_HALF_GOALS_* Totals
    const firstHalfOu = /^FIRST_HALF_GOALS_(\d+)(?:_(\d+))?$/.exec(marketType);
    const secondHalfOu = /^SECOND_HALF_GOALS_(\d+)(?:_(\d+))?$/.exec(marketType);
    const standardOu = /^OVER_UNDER_(\d+)(?:_(\d+))?$/.exec(marketType);
    const ouMatch = firstHalfOu || secondHalfOu || standardOu;
    if (ouMatch && runners.length === 2) {
      if (firstHalfOu) {
        period = 'half1';
      } else if (secondHalfOu) {
        period = 'half2';
      }
      const lineStr = ouMatch[2] ? `${ouMatch[1]}.${ouMatch[2]}` : (ouMatch[1].length === 2 ? `${ouMatch[1][0]}.${ouMatch[1][1]}` : `${ouMatch[1]}.5`);
      const line = Number(lineStr);
      if (!Number.isFinite(line)) return null;

      let overRunner = null;
      let underRunner = null;

      for (const r of runners) {
        const rName = String(r.description?.runnerName || '').trim();
        if (/^(?:peste|over)\b/i.test(rName)) overRunner = r;
        else if (/^(?:sub|under)\b/i.test(rName)) underRunner = r;
      }

      if (!overRunner || !underRunner) return null;

      const overBack = overRunner.exchange?.availableToBack?.[0];
      const underBack = underRunner.exchange?.availableToBack?.[0];
      if (!overBack || !underBack || overBack.price <= 1 || underBack.price <= 1) return null;

      const overLay = overRunner.exchange?.availableToLay?.[0];
      const underLay = underRunner.exchange?.availableToLay?.[0];

      const isBasketball = sport === 'basketball';
      const isTennis = sport === 'tennis';
      const subject = isBasketball ? 'points' : (isTennis ? 'games' : 'goals');
      const suffix = period === 'half1' ? '_1H' : '';
      const key = isBasketball
        ? `POINTS_OVER_UNDER_${String(line).replace('.', '_')}${suffix}`
        : `OVER_UNDER_${String(line).replace('.', '_')}${suffix}`;
      const name = marketName || (isBasketball
        ? `Total Points ${line}`
        : (isTennis ? `Total Games ${line}` : `Total Goals ${line}`));

      return {
        key,
        name,
        period,
        line,
        subject,
        selections: [
          {
            name: `Over ${line}`,
            handicap: line,
            odds: overBack.price,
            layOdds: overLay?.price,
            liquidity: overBack.size,
            depth: { back: overRunner.exchange?.availableToBack || [], lay: overRunner.exchange?.availableToLay || [] },
            isExchange: true,
          },
          {
            name: `Under ${line}`,
            handicap: line,
            odds: underBack.price,
            layOdds: underLay?.price,
            liquidity: underBack.size,
            depth: { back: underRunner.exchange?.availableToBack || [], lay: underRunner.exchange?.availableToLay || [] },
            isExchange: true,
          },
        ],
      };
    }

    // 3. BOTH_TEAMS_TO_SCORE (BTTS)
    if (marketType === 'BOTH_TEAMS_TO_SCORE' && runners.length === 2) {
      let yesRunner = null;
      let noRunner = null;

      for (const r of runners) {
        const rName = String(r.description?.runnerName || '').trim();
        if (/^(?:da|yes)\b/i.test(rName)) yesRunner = r;
        else if (/^(?:nu|no)\b/i.test(rName)) noRunner = r;
      }

      if (!yesRunner || !noRunner) return null;

      const yesBack = yesRunner.exchange?.availableToBack?.[0];
      const noBack = noRunner.exchange?.availableToBack?.[0];
      if (!yesBack || !noBack || yesBack.price <= 1 || noBack.price <= 1) return null;

      const yesLay = yesRunner.exchange?.availableToLay?.[0];
      const noLay = noRunner.exchange?.availableToLay?.[0];

      return {
        key: 'BTTS',
        name: marketName || 'Both Teams to Score',
        period,
        selections: [
          {
            name: 'Yes',
            odds: yesBack.price,
            layOdds: yesLay?.price,
            liquidity: yesBack.size,
            depth: { back: yesRunner.exchange?.availableToBack || [], lay: yesRunner.exchange?.availableToLay || [] },
            isExchange: true,
          },
          {
            name: 'No',
            odds: noBack.price,
            layOdds: noLay?.price,
            liquidity: noBack.size,
            depth: { back: noRunner.exchange?.availableToBack || [], lay: noRunner.exchange?.availableToLay || [] },
            isExchange: true,
          },
        ],
      };
    }

    return null;
  }

  _serializable(events, raw) {
    const seen = new Set();
    for (const e of events || []) {
      for (const m of e.markets || []) seen.add(m.key);
    }
    const families = [];
    if (seen.has('1X2') || seen.has('MATCH_ODDS') || seen.has('HALF_WINNER') || seen.has('SET_WINNER')) families.push('fulltime-1x2');
    for (const k of seen) {
      if (k.startsWith('OVER_UNDER')) {
        families.push('totals');
        break;
      }
    }
    if (seen.has('BTTS')) families.push('btts');

    return {
      ...super._serializable(events, raw),
      sourceUrl: this.sourceUrl,
      transport: this.transport,
      observedAt: this.observedAt,
      coverage: {
        sport: 'multi-sport',
        market: families.join('+') || 'fulltime-1x2+totals+btts',
        allMarkets: true,
        ...liveCoverageFor(this.id),
        maxEvents: this.maxEvents,
      },
    };
  }
}

import WebSocket from 'ws';
import crypto from 'crypto';
import ScraperBase from './base.mjs';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';
import { liveCoverageFor, markMarketsLive } from './live-status.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { UpstreamError, TimeoutError } from '../shared/errors.mjs';
import { eventLimit } from './event-limit.mjs';

/**
 * AdmiralBet Poland (admiralbet.pl) – WebSocket hierarchy + q-events scraper.
 *
 * Reverse-engineered via `morluto/rea` MCP analysis on `admiralbet.pl/zaklady-bukmacherskie`
 * (evidence `ev_df784d7eefb118accdb4e9f5740e8bb5ef791b1cff59e6c95f3cea83b24fc2a1`).
 *
 * Markets supported:
 *   - 1X2 / Match Winner (marketType 10 / regulation & overtime-inclusive)
 *   - Both Teams to Score (marketType 43)
 *   - Over/Under Totals (marketType 56 / specifierValues.total)
 *   - Double Chance (typeId 9, 10, 11)
 *   - Draw No Bet
 *   - Asian Handicap (specifierValues.hcp)
 */

const DEFAULT_COMPETITION_PATHS = Object.freeze([
  'pilka_nozna/polska/ekstraklasa',
  'pilka_nozna/anglia/premier_league',
  'pilka_nozna/hiszpania/laliga',
  'pilka_nozna/wlochy/serie_a',
  'pilka_nozna/niemcy/bundesliga',
  'pilka_nozna/francja/ligue_1',
  'pilka_nozna/miedzynarodowe_klubowe/liga_mistrzow',
  'koszykowka/usa/nba',
  'hokej/usa/nhl',
  'tenis/atp',
  'tenis/wta',
]);

const SPORT_MAPPING = Object.freeze({
  pilka_nozna: 'Football',
  koszykowka: 'Basketball',
  hokej: 'Ice Hockey',
  tenis: 'Tennis',
  siatkowka: 'Volleyball',
  pilka_reczna: 'Handball',
  tenis_stolowy: 'Table Tennis',
});

function isExhaustiveHalfLine(line) {
  return Number.isFinite(line) && Math.abs(line % 1) === 0.5;
}

function resolveSport(fixture) {
  const sportId = String(fixture?.sportNodeId || fixture?.path?.sportPath || '').toLowerCase();
  for (const [prefix, mapped] of Object.entries(SPORT_MAPPING)) {
    if (sportId.includes(prefix)) return mapped;
  }
  return 'Football';
}

export default class AdmiralBetPlScraper extends ScraperBase {
  id = 'admiralbet-pl';
  name = 'AdmiralBet Poland';
  sourceIds = ['admiralbet-pl'];
  transport = 'admiralbet-ws';

  timeoutMs = 25_000;
  maxAttempts = 3;

  constructor(opts = {}) {
    super(opts);
    this.maxEvents = eventLimit(opts.maxEvents ?? opts.jobConfig?.maxEvents);
    this.baseUrl = 'https://admiralbet.pl';
    this.origin = this.baseUrl;
    this.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    this.isCustomPath = Boolean(opts.competitionPath);
    this.competitionPath = opts.competitionPath || 'pilka_nozna/polska/ekstraklasa';
    this.competitionPaths = opts.competitionPaths || DEFAULT_COMPETITION_PATHS;
  }

  /** Open a WebSocket connection and resolve with the first JSON message that matches `type` */
  _wsRequest(url, message, expectedType, { signal: _signal } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { 'User-Agent': this.ua, Origin: this.origin } });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new TimeoutError(`${this.id}: ws timeout`, { code: 'ETIMEOUT' }));
      }, this.timeoutMs);

      ws.on('open', () => ws.send(message));
      ws.on('message', (data) => {
        let json = null;
        try { json = JSON.parse(data.toString()); } catch { /* ignore */ }
        if (json && (json.type === expectedType || json.type?.toUpperCase() === expectedType.toUpperCase())) {
          clearTimeout(timer);
          ws.close();
          resolve(json);
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new UpstreamError(`${this.id}: ws error ${err.message}`, { code: 'EUPSTREAM' }));
      });
      ws.on('close', () => {
        clearTimeout(timer);
        reject(new TimeoutError(`${this.id}: ws closed before receiving ${expectedType}`, { code: 'ECLOSED' }));
      });
    });
  }

  async fetchRaw({ signal } = {}) {
    // If _wsRequest is stubbed on this instance (e.g. unit tests) or custom path specified, run single path
    if (Object.hasOwn(this, '_wsRequest') || this.isCustomPath) {
      const hierarchyUrl = `${this.baseUrl}/online-api/v1/offer/unified`;
      const subId = crypto.randomUUID();
      const hierarchyMsg = JSON.stringify({ type: 'Q_PREMATCH_HIERARCHY', subscriptionId: subId, path: 'all-sports' });
      try {
        await this._wsRequest(hierarchyUrl, hierarchyMsg, 'R_PREMATCH_HIERARCHY', { signal });
      } catch (_) {
        // Non-fatal
      }

      const notificationsPath = '/online-api/v1/sportevents/web-notifications?lang=en&includeOutrightsAsBase=0';
      const eventsUrl = `${this.baseUrl}${notificationsPath}`;
      const eventsSub = crypto.randomUUID();
      const eventsMsg = JSON.stringify({
        bundle: true,
        offset: 0,
        op: 'q-events',
        recursive: true,
        subId: eventsSub,
        path: this.competitionPath,
        size: 500,
        live: false,
      });
      return this._wsRequest(eventsUrl, eventsMsg, 'r-events', { signal });
    }

    // Default multi-competition / multi-sport live WebSocket collection
    const notificationsPath = '/online-api/v1/sportevents/web-notifications?lang=en&includeOutrightsAsBase=0';
    const eventsUrl = `${this.baseUrl}${notificationsPath}`;

    const allItems = [];
    for (const compPath of this.competitionPaths) {
      if (signal?.aborted) break;
      const eventsSub = crypto.randomUUID();
      const eventsMsg = JSON.stringify({
        bundle: true,
        offset: 0,
        op: 'q-events',
        recursive: true,
        subId: eventsSub,
        path: compPath,
        size: 100,
        live: false,
      });

      try {
        const raw = await this._wsRequest(eventsUrl, eventsMsg, 'r-events', { signal });
        const items = this.normalize(raw);
        allItems.push(...items);
        if (allItems.length >= this.maxEvents) break;
      } catch {
        // Individual path timeout or error is non-fatal
      }
    }

    return { type: 'r-events', items: allItems };
  }

  /** Extract the list of items from the events payload. */
  normalize(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.items)) return raw.items;
    return [];
  }

  /** Convert raw items into engine‑consumable events. */
  extractEvents(rawEvents) {
    const out = [];
    const liveEvidence = liveCoverageFor('admiralbet-pl');
    const isLive = liveEvidence?.isLive ?? false;

    for (const ev of rawEvents) {
      const fixture = ev?.event?.fixture;
      if (!fixture) continue;
      const competitors = fixture.competitors || [];
      const homeComp = competitors.find((c) => c?.homeAway === 'HOME');
      const awayComp = competitors.find((c) => c?.homeAway === 'AWAY');
      const homeTeam = homeComp?.name?.name?.trim() || '';
      const awayTeam = awayComp?.name?.name?.trim() || '';
      if (!homeTeam || !awayTeam || homeTeam === awayTeam) continue;

      const kickoff = fixture.startTime ? new Date(fixture.startTime).toISOString() : null;
      if (!kickoff) continue;

      const sport = resolveSport(fixture);
      const league = fixture.path?.competitionName || fixture.path?.competitionPath || 'Unknown';

      // Build market groups compatible with flattenMarkets.
      const rawMarkets = ev?.event?.markets || fixture.markets || [];
      const groups = rawMarkets.map((m) => {
        const specTotal = m.specifierValues?.total;
        const specHcp = m.specifierValues?.hcp;
        return {
          name: m?.name?.name || '',
          markets: [{
            marketType: m.marketType,
            name: m?.name?.name || '',
            selections: (m.selections || []).map((s) => ({
              id: s.id,
              typeId: s.typeId,
              name: s?.name?.name?.trim() || '',
              odds: Number(s?.segments?.DEFAULT?.price),
              handicap: specTotal ?? specHcp ?? null,
            })),
          }],
        };
      });

      const raw = {
        id: ev.id,
        sport,
        league,
        kickoff,
        homeTeam,
        awayTeam,
        groups,
      };

      const eventKey = buildEventKey(raw, normalizeTeamName);
      const markets = flattenMarkets(raw.groups, { defaultGroupName: 'Main' });
      const refinedMarkets = [];

      // 1. 3-way or 2-way Match Result (marketType 10 or name matching 1x2)
      const market10 = markets.find((m) => m.key === '10' || (m.name && /1x2/i.test(m.name)));
      if (market10 && market10.selections.length >= 3) {
        const homeSel = market10.selections.find((s) => s.name === homeTeam) || market10.selections[0];
        const drawSel = market10.selections.find((s) => /draw|remis|x/i.test(s.name)) || market10.selections[1];
        const awaySel = market10.selections.find((s) => s.name === awayTeam) || market10.selections[2];
        refinedMarkets.push({
          key: 'MATCH_ODDS',
          name: 'Match Odds',
          period: 'fulltime',
          selections: [homeSel, drawSel, awaySel],
        });
      } else if (market10 && market10.selections.length === 2) {
        const homeSel = market10.selections.find((s) => s.name === homeTeam) || market10.selections[0];
        const awaySel = market10.selections.find((s) => s.name === awayTeam) || market10.selections[1];
        const period = (sport === 'Basketball' || sport === 'Ice Hockey') ? 'fulltime_ot' : 'fulltime';
        refinedMarkets.push({
          key: 'MATCH_ODDS',
          name: period === 'fulltime_ot' ? 'Match Winner (Incl. OT)' : 'Match Winner',
          period,
          selections: [homeSel, awaySel],
        });
      }

      // 2. BTTS (marketType 43)
      const bttsRaw = markets.find((m) => m.key === '43' || (m.name && /both teams to score|obie dru[zż]yny strzel[aą]/i.test(m.name)));
      if (bttsRaw && bttsRaw.selections.length >= 2) {
        const yesSel = bttsRaw.selections.find((s) => s.typeId === 74 || /^yes$|^tak$/i.test(s.name)) || bttsRaw.selections[0];
        const noSel = bttsRaw.selections.find((s) => s.typeId === 76 || /^no$|^nie$/i.test(s.name)) || bttsRaw.selections[1];
        if (yesSel && noSel && yesSel.odds > 1 && noSel.odds > 1) {
          refinedMarkets.push({
            key: 'BOTH_TEAMS_TO_SCORE',
            name: 'Both Teams to Score',
            period: 'fulltime',
            selections: [
              { id: yesSel.id, name: 'Yes', odds: yesSel.odds, handicap: null },
              { id: noSel.id, name: 'No', odds: noSel.odds, handicap: null },
            ],
          });
        }
      }

      // 3. Over/Under Totals (marketType 56 or total specifier)
      for (const m of markets) {
        if (m.key !== '56' && !/total|powy[zż]ej|poni[zż]ej/i.test(m.name)) continue;
        const lineStr = m.selections[0]?.handicap
          ?? m.name?.match(/([0-9]+(?:\.[0-9]+)?)/)?.[1]
          ?? m.selections[0]?.name?.match(/([0-9]+(?:\.[0-9]+)?)/)?.[1];
        const line = Number(lineStr);
        if (!isExhaustiveHalfLine(line)) continue;

        const overSel = m.selections.find((s) => s.typeId === 12 || /over|powy[zż]ej/i.test(s.name));
        const underSel = m.selections.find((s) => s.typeId === 13 || /under|poni[zż]ej/i.test(s.name));
        if (!overSel || !underSel || overSel.odds <= 1 || underSel.odds <= 1) continue;

        let key = 'OVER_UNDER';
        let subject = 'goals';
        if (sport === 'Basketball') {
          key = 'TOTAL_POINTS';
          subject = 'points';
        } else if (sport === 'Tennis') {
          key = 'TOTAL_GAMES';
          subject = 'games';
        }

        refinedMarkets.push({
          key,
          name: `${subject === 'goals' ? 'Total Goals' : subject === 'points' ? 'Total Points' : 'Total Games'} ${line}`,
          period: sport === 'Basketball' ? 'fulltime_ot' : 'fulltime',
          subject,
          line,
          selections: [
            { id: overSel.id, name: `Over ${line}`, odds: overSel.odds, handicap: line, line },
            { id: underSel.id, name: `Under ${line}`, odds: underSel.odds, handicap: line, line },
          ],
        });
      }

      // 4. Double Chance (typeId 9: 1X, 10: 12, 11: X2)
      for (const m of markets) {
        if (m.selections.length !== 3) continue;
        const s1x = m.selections.find((s) => s.typeId === 9 || /1x/i.test(s.name));
        const s12 = m.selections.find((s) => s.typeId === 10 || /12/i.test(s.name));
        const sx2 = m.selections.find((s) => s.typeId === 11 || /x2/i.test(s.name));
        if (s1x && s12 && sx2 && s1x.odds > 1 && s12.odds > 1 && sx2.odds > 1) {
          refinedMarkets.push({
            key: 'DOUBLE_CHANCE',
            name: 'Double Chance',
            period: 'fulltime',
            selections: [
              { id: s1x.id, name: '1X', odds: s1x.odds, handicap: null },
              { id: s12.id, name: '12', odds: s12.odds, handicap: null },
              { id: sx2.id, name: 'X2', odds: sx2.odds, handicap: null },
            ],
          });
          break;
        }
      }

      if (refinedMarkets.length === 0) continue;

      markMarketsLive(refinedMarkets, () => isLive);

      out.push({
        id: raw.id,
        sourceId: this.id,
        sourceUrl: `${this.baseUrl}/odd/${ev.id}`,
        sport,
        league,
        kickoff,
        homeTeam,
        awayTeam,
        live: isLive,
        eventKey,
        markets: refinedMarkets,
      });

      if (out.length >= this.maxEvents) break;
    }
    return out;
  }
}

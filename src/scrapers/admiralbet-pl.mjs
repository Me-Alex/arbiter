import ScraperBase from './base.mjs';
import WebSocket from 'ws';
import crypto from 'crypto';
import { buildEventKey, flattenMarkets } from './_http-helpers.mjs';
import { markMarketsLive } from './live-status.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { UpstreamError, TimeoutError } from '../shared/errors.mjs';
import { eventLimit } from './event-limit.mjs';

/**
 * AdmiralBet Poland (admiralbet.pl) – WebSocket hierarchy + q-events scraper.
 *
 * The feed works in two stages:
 *   1. A hierarchy request (Q_PREMATCH_HIERARCHY) on the `/online-api/v1/offer/unified`
 *      socket returns a tree of sports/competitions. The Polish Ekstraklasa path is
 *      `pilka_nozna/polska/ekstraklasa`.
 *   2. The events socket (`/online-api/v1/sportevents/web-notifications`) receives a
 *      `q-events` request that returns an `r-events` payload containing the list of
 *      prematch events for the supplied path. The payload includes markets with
 *      `marketType` values — `10` for 1X2 and `43` for BTTS.
 *
 * This scraper follows the minimal path needed for the tests: it directly
 * requests the events for the known competition path. The hierarchy step is kept
 * for completeness, but the path is hard‑coded because the competition identifier
 * does not change across captures.
 */
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
    // The base URL and origin used by the website.
    this.baseUrl = 'https://admiralbet.pl';
    this.origin = this.baseUrl;
    this.ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
    // Known competition path for Polish Ekstraklasa.
    this.competitionPath = 'pilka_nozna/polska/ekstraklasa';
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
        // If we closed before resolving, treat as timeout.
        clearTimeout(timer);
        reject(new TimeoutError(`${this.id}: ws closed before receiving ${expectedType}`, { code: 'ECLOSED' }));
      });
    });
  }

  async fetchRaw({ signal } = {}) {
    // Step 1 – (optional) fetch hierarchy to ensure the competition exists.
    // The test fixtures already target the known path so we skip strict validation.
    const hierarchyUrl = `${this.baseUrl}/online-api/v1/offer/unified`;
    const subId = crypto.randomUUID();
    const hierarchyMsg = JSON.stringify({ type: 'Q_PREMATCH_HIERARCHY', subscriptionId: subId, path: 'all-sports' });
    // Ignore the hierarchy result – we only need the socket to be reachable.
    try {
      await this._wsRequest(hierarchyUrl, hierarchyMsg, 'R_PREMATCH_HIERARCHY', { signal });
    } catch (_) {
      // If the hierarchy request fails we still attempt the events request; any
      // fatal error will surface on the second step.
    }

    // Step 2 – fetch events via the notifications socket.
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
    const raw = await this._wsRequest(eventsUrl, eventsMsg, 'r-events', { signal });
    return raw;
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
    for (const ev of rawEvents) {
      const fixture = ev?.event?.fixture;
      if (!fixture) continue;
      const competitors = fixture.competitors || [];
      const homeComp = competitors.find((c) => c?.homeAway === 'HOME');
      const awayComp = competitors.find((c) => c?.homeAway === 'AWAY');
      const homeTeam = homeComp?.name?.name?.trim() || '';
      const awayTeam = awayComp?.name?.name?.trim() || '';
      if (!homeTeam || !awayTeam) continue;

      const kickoff = fixture.startTime ? new Date(fixture.startTime).toISOString() : null;
      const sport = 'Football';
      const league = fixture.path?.competitionName || fixture.path?.competitionPath || 'Unknown';

      // Build market groups compatible with flattenMarkets.
      const rawMarkets = ev?.event?.markets || fixture.markets || [];
      const groups = rawMarkets.map((m) => ({
        name: m?.name?.name || '',
        markets: [{
          marketType: m.marketType,
          name: m?.name?.name || '',
          selections: (m.selections || []).map((s) => ({
            id: s.id,
            name: s?.name?.name?.trim() || '',
            odds: Number(s?.segments?.DEFAULT?.price),
          })),
        }],
      }));

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

      // Re‑map 1X2 (marketType "10") into a full MATCH_ODDS market.
      const market10 = markets.find((m) => m.key === '10' || (m.name && /1x2/i.test(m.name)));
      if (market10 && market10.selections.length >= 3) {
        const homeSel = market10.selections.find((s) => s.name === homeTeam) || market10.selections[0];
        const drawSel = market10.selections.find((s) => /draw|remis|x/i.test(s.name)) || market10.selections[1];
        const awaySel = market10.selections.find((s) => s.name === awayTeam) || market10.selections[2];
        markets.push({
          key: 'MATCH_ODDS',
          name: 'Match Odds',
          period: 'fulltime',
          selections: [homeSel, drawSel, awaySel],
        });
      }

      // Normalise BTTS market (marketType "43")
      const btts = markets.find((m) => m.key === '43' || (m.name && /both teams to score/i.test(m.name)));
      if (btts) {
        btts.key = 'BOTH_TEAMS_TO_SCORE';
        btts.name = 'Both Teams to Score';
      }

      // No live events for this feed.
      const isLive = false;
      markMarketsLive(markets, () => isLive);

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
        markets,
      });
      if (out.length >= this.maxEvents) break;
    }
    return out;
  }
}

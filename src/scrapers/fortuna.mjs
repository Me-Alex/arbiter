import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

const BASE = 'https://api.efortuna.ro';
const MATCHES_PATH = '/offer/structure/api/v1_0/tournament/';
const MARKETS_URL = `${BASE}/offer/markets/api/v1_0/fixtures/markets/overview`;

const SPORT_IDS = [
  'ufo:sprt:00', // Football (843 fixtures)
  'ufo:sprt:01', // Tennis (36)
  'ufo:sprt:02', // Basketball (32)
  'ufo:sprt:03', // Ice Hockey (6)
  'ufo:sprt:04', // Handball (1)
  'ufo:sprt:07', // Rugby
  'ufo:sprt:09', // Darts (23)
  'ufo:sprt:11', // Futsal (12)
  'ufo:sprt:23', // Bowling? (8)
  'ufo:sprt:26', // ? (1)
  'ufo:sprt:27', // ? (1)
  'ufo:sprt:29', // ? (6)
  'ufo:sprt:35', // ? (1)
];
import { fegSportName, normalizeFegMarket } from './feg-common.mjs';

/** Batch size for market hydration. */
const BATCH_SIZE = 50;

/**
 * Fortuna scraper — catalogue-based traversal.
 *
 * Pipeline: tournament catalogue → tournament matches → market overview.
 * Fetches ALL football tournaments, traverses each for fixtures,
 * then hydrates markets in batches. This captures ~595 football fixtures
 * vs the ~20 from the widget endpoint.
 */
export default class FortunaScraper extends ScraperBase {
  id = 'fortuna';
  name = 'Fortuna';
  sourceIds = ['fortuna'];

  constructor(opts = {}) {
    super(opts);
    // Catalogue traversal performs 13 sport catalogue requests + up to ~120
    // tournament match-list requests + market-overview batches, which routinely
    // takes 25-60s. Keep the per-attempt deadline well above that so the base
    // class doesn't abort the whole run mid-traversal.
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxAttempts = opts.maxAttempts ?? 1;
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Math.min(Number(opts.maxEvents ?? 100), 5000);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 5000) {
      throw new ValidationError('Fortuna: invalid maxEvents');
    }
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.observedAt = new Date().toISOString();
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

    // Step 1: Fetch tournament catalogue for ALL sports
    // Per-request failure accounting. Every step below swallows individual
    // failures so one dead tournament does not lose the other 120, but a run in
    // which every request failed must not be reported as a successful empty
    // scrape:  is indistinguishable from a quiet day.
    let attempted = 0;
    let failed = 0;

    const allTournaments = [];
    for (const sportId of SPORT_IDS) {
      signal?.throwIfAborted();
      attempted += 1;
      try {
        const url = `${BASE}/offer/structure/api/v1_0/sport/${sportId}/tournaments?categories=true&timeFilter=all`;
        const catResp = await fetch(url, { signal, headers });
        if (!catResp.ok) { failed += 1; continue; }
        const catData = await catResp.json();
        for (const t of (catData.tournaments || [])) {
          t._sportId = sportId;
          t._sportName = fegSportName(sportId);
          allTournaments.push(t);
        }
      } catch (err) { if (signal?.aborted) throw err; failed += 1; }
    }
    const withFixtures = allTournaments.filter((t) => t.fixturesCount > 0);
    this.logger('info', `Fortuna: ${withFixtures.length} tournaments with fixtures across ${SPORT_IDS.length} sports`);

    // Step 2: Fetch matches from each tournament
    const allFixtures = [];
    const tourMap = new Map();
    for (const t of allTournaments) tourMap.set(t.id, t);

    for (const t of withFixtures) {
      signal?.throwIfAborted();
      attempted += 1;
      try {
        const url = `${BASE}${MATCHES_PATH}${encodeURIComponent(t.id)}/matches`;
        const resp = await fetch(url, { signal, headers });
        if (!resp.ok) { failed += 1; continue; }
        const data = await resp.json();
        const fixtures = data.fixtures || [];
        for (const f of fixtures) {
          f._tournamentName = t.name;
          f._tournamentSeoName = t.seoName || t.name;
          f._categorySeoName = t.categorySeoName || '';
          f._sportName = t._sportName || 'Football';
          allFixtures.push(f);
        }
      } catch (err) { if (signal?.aborted) throw err; failed += 1; }
    }
    this.logger('info', `Fortuna: ${allFixtures.length} fixtures from catalogue`);

    // Step 3: Hydrate markets in batches
    const fixtureIds = allFixtures.map((f) => f.id);
    const marketsByFixture = new Map();
    for (let i = 0; i < fixtureIds.length; i += BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = fixtureIds.slice(i, i + BATCH_SIZE);
      attempted += 1;
      try {
        const params = batch.map((id) => 'fixtureIds=' + encodeURIComponent(id)).join('&');
        const url = `${MARKETS_URL}?${params}`;
        const resp = await fetch(url, { signal, headers });
        if (!resp.ok) { failed += 1; continue; }
        const data = await resp.json();
        for (const [fid, mkts] of Object.entries(data)) {
          if (Array.isArray(mkts) && mkts.length > 0) {
            marketsByFixture.set(fid, mkts);
          }
        }
      } catch (err) { if (signal?.aborted) throw err; failed += 1; }
    }
    this.logger('info', `Fortuna: ${marketsByFixture.size} fixtures with hydrated markets`);

    // Total upstream failure is a failed run, not an empty one: a scrape that
    // collected nothing because every request failed is not a quiet market day.
    // Partial failure still returns what was collected, and the counters travel
    // with the payload so the shortfall is visible in the run report.
    if (attempted > 0 && failed === attempted) {
      throw new UpstreamError(`Fortuna: all ${attempted} catalogue requests failed`);
    }
    this.sourceUrl = `${BASE}/offer/structure/api/v1_0/sport/tournaments`;
    return { tournaments: [...tourMap.values()], fixtures: allFixtures, marketsByFixture };
  }

  normalize(raw) {
    if (!raw?.fixtures) throw new ValidationError('Fortuna: missing fixtures');
    const out = [];
    for (const fix of raw.fixtures) {
      const homeP = (fix.participants || []).find((p) => p.type === 'HOME');
      const awayP = (fix.participants || []).find((p) => p.type === 'AWAY');
      if (!homeP?.name || !awayP?.name) continue;
      const kickoff = new Date(fix.startDatetime);
      if (!Number.isFinite(+kickoff)) continue;
      const mkts = (raw.marketsByFixture || new Map()).get(fix.id) || [];
      if (mkts.length === 0) continue;
      out.push({
        id: fix.id,
        sport: fix._sportName || 'Football',
        league: fix._tournamentSeoName || 'unknown',
        kickoff: kickoff.toISOString(),
        homeTeam: homeP.name,
        awayTeam: awayP.name,
        markets: mkts,
      });
    }
    return out;
  }

  extractEvents(rawEvents) {
    const out = [];
    const seen = new Set();
    for (const r of rawEvents) {
      if (out.length >= this.maxEvents) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);

      const markets = (r.markets || [])
        .map(normalizeFegMarket)
        .filter(Boolean);
      if (markets.length === 0) continue;

      const eventKey = [
        normalizeTeamName(r.sport), normalizeTeamName(r.league), r.kickoff,
        normalizeTeamName(r.homeTeam), normalizeTeamName(r.awayTeam),
      ].join('|');

      out.push({
        id: r.id, sourceId: 'fortuna', sourceUrl: this.sourceUrl,
        transport: 'fortuna-catalogue-v1', observedAt: this.observedAt,
        sport: r.sport, league: r.league, kickoff: r.kickoff,
        homeTeam: r.homeTeam, awayTeam: r.awayTeam, eventKey, markets,
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      sourceUrl: this.sourceUrl, transport: 'fortuna-catalogue-v1',
      observedAt: this.observedAt,
      // Multi-sport: the traversal walks every sport in SPORT_IDS, so claiming
      // `football` here misdescribed what the run actually collected.
      coverage: { sport: 'multi-sport', allMarkets: true, live: false, maxEvents: this.maxEvents },
    };
  }
}

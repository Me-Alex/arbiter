import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

const BASE = 'https://api.casapariurilor.ro';
const MATCHES_PATH = '/offer/structure/api/v1_0/tournament/';
const MARKETS_URL = `${BASE}/offer/markets/api/v1_0/fixtures/markets/overview`;
const BATCH_SIZE = 50;

const SPORT_IDS = [
  'ufo:sprt:00', 'ufo:sprt:01', 'ufo:sprt:02', 'ufo:sprt:03',
  'ufo:sprt:04', 'ufo:sprt:07', 'ufo:sprt:09', 'ufo:sprt:11',
  'ufo:sprt:23', 'ufo:sprt:26', 'ufo:sprt:27', 'ufo:sprt:29', 'ufo:sprt:35',
];
import { fegSportName, normalizeFegMarket } from './feg-common.mjs';

export default class CasaPariurilorScraper extends ScraperBase {
  id = 'casa-pariurilor';
  name = 'Casa Pariurilor';
  sourceIds = ['casa-pariurilor'];

  constructor(opts = {}) {
    super(opts);
    // Same catalogue traversal as Fortuna (multi-sport → tournaments →
    // match lists → market batches), routinely exceeds 25s.
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxAttempts = opts.maxAttempts ?? 1;
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Math.min(Number(opts.maxEvents ?? 100), 5000);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 5000) {
      throw new ValidationError('CasaPariurilor: invalid maxEvents');
    }
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.observedAt = new Date().toISOString();
    const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

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
    const allFixtures = [];
    const tourMap = new Map();
    for (const t of allTournaments) tourMap.set(t.id, t);

    for (const t of withFixtures) {
      signal?.throwIfAborted();
      attempted += 1;
      try {
        const resp = await fetch(`${BASE}${MATCHES_PATH}${encodeURIComponent(t.id)}/matches`, { signal, headers });
        if (!resp.ok) { failed += 1; continue; }
        const data = await resp.json();
        for (const f of (data.fixtures || [])) {
          f._tournamentName = t.name;
          f._tournamentSeoName = t.seoName || t.name;
          f._categorySeoName = t.categorySeoName || '';
          f._sportName = t._sportName || 'Football';
          allFixtures.push(f);
        }
      } catch (err) { if (signal?.aborted) throw err; failed += 1; }
    }

    const fixtureIds = allFixtures.map((f) => f.id);
    const marketsByFixture = new Map();
    for (let i = 0; i < fixtureIds.length; i += BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = fixtureIds.slice(i, i + BATCH_SIZE);
      attempted += 1;
      try {
        const params = batch.map((id) => 'fixtureIds=' + encodeURIComponent(id)).join('&');
        const resp = await fetch(`${MARKETS_URL}?${params}`, { signal, headers });
        if (!resp.ok) { failed += 1; continue; }
        const data = await resp.json();
        for (const [fid, mkts] of Object.entries(data)) {
          if (Array.isArray(mkts) && mkts.length > 0) marketsByFixture.set(fid, mkts);
        }
      } catch (err) { if (signal?.aborted) throw err; failed += 1; }
    }

    // Total upstream failure is a failed run, not an empty one: a scrape that
    // collected nothing because every request failed is not a quiet market day.
    // Partial failure still returns what was collected, and the counters travel
    // with the payload so the shortfall is visible in the run report.
    if (attempted > 0 && failed === attempted) {
      throw new UpstreamError(`CasaPariurilor: all ${attempted} catalogue requests failed`);
    }
    this.sourceUrl = `${BASE}/offer/structure/api/v1_0/sport/tournaments`;
    return { tournaments: [...tourMap.values()], fixtures: allFixtures, marketsByFixture };
  }

  normalize(raw) {
    if (!raw?.fixtures) throw new ValidationError('CasaPariurilor: missing fixtures');
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
        id: fix.id, sport: fix._sportName || 'Football',
        league: fix._tournamentSeoName || 'unknown',
        kickoff: kickoff.toISOString(),
        homeTeam: homeP.name, awayTeam: awayP.name, markets: mkts,
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
      const sportKey = r.sport.toLowerCase().replace(/\s+/g, '-');
      const eventKey = [sportKey, normalizeTeamName(r.league), r.kickoff,
        normalizeTeamName(r.homeTeam), normalizeTeamName(r.awayTeam)].join('|');
      out.push({
        id: r.id, sourceId: 'casa-pariurilor', sourceUrl: this.sourceUrl,
        transport: 'casa-catalogue-v1', observedAt: this.observedAt,
        sport: r.sport, league: r.league, kickoff: r.kickoff,
        homeTeam: r.homeTeam, awayTeam: r.awayTeam, eventKey, markets,
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl,
      transport: 'casa-catalogue-v1', observedAt: this.observedAt,
      coverage: { sport: 'multi-sport', allMarkets: true, live: false, maxEvents: this.maxEvents } };
  }
}

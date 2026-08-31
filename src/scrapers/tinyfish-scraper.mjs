import ProviderContract from './provider-contract.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { discoverMatches } from '../tinyfish/discovery.mjs';
import { extractOdds } from '../tinyfish/extract.mjs';
import { canonicalSelectionName, normalizeKickoff } from '../tinyfish/normalize.mjs';
import { writeJsonAtomic } from '../shared/atomic-write.mjs';
import { join } from 'node:path';

/**
 * TinyfishScraper — drops into ScraperBase's contract unchanged.
 *
 * fetchRaw() runs the two-phase pipeline:
 *   1. Discover matches on the book's sports landing page (one TinyFish call)
 *   2. Extract odds for every match in parallel (N TinyFish calls, hard cap)
 * Returns an AggregatedPayload in the same shape our other providers use:
 *
 *   {
 *     events: [{
 *       id, homeTeam, awayTeam, league, sport, kickoff,
 *       marketGroups: [{ name, markets: [{ type, name, selections: [...] }] }]
 *     }],
 *     discovery: { count, runId, ... },
 *     extraction: { ok, failed, runs }
 *   }
 *
 * normalize() maps this into the engine's RawEvent[] shape; extractEvents()
 * produces the final NormalizedEvent[].
 *
 * If `dryRun` is true, the scraper does NOT call TinyFish — useful for tests.
 */
export default class TinyfishScraper extends ProviderContract {
  id = 'tinyfish';
  name = 'TinyFish Generic';
  sourceIds = ['tinyfish'];

  /** @param {{ dataDir?: string, logger?: Function, dryRun?: boolean, dryRunPayload?: object, bookConfig?: object }} [opts] */
  constructor(opts = {}) {
    super({
      baseUrl: opts.bookConfig?.baseUrl || '',
      locale: opts.bookConfig?.locale,
      timezone: opts.bookConfig?.timezone,
      currency: opts.bookConfig?.currency,
      dataDir: opts.dataDir,
    });
    this.dryRun = !!opts.dryRun;
    this.dryRunPayload = opts.dryRunPayload || null;
    this.bookConfig = opts.bookConfig || null;
    this.logger = opts.logger || (() => {});
    this.maxMatches = opts.bookConfig?.maxMatches ?? 30;
    this.maxDiscoveredMatches = opts.bookConfig?.maxDiscoveredMatches ?? Math.max(100, this.maxMatches);
    this.maxLiveMatches = opts.bookConfig?.maxLiveMatches ?? this.maxDiscoveredMatches;
    this.maxDurationSeconds = opts.bookConfig?.maxDurationSeconds ?? 180;
    this.maxSteps = opts.bookConfig?.maxSteps;
    this.browserProfile = opts.bookConfig?.browserProfile;
    this.parallel = opts.bookConfig?.parallel ?? 2;
    const runBudgetMs = (this.maxDurationSeconds * 1000) + 30_000;
    this.timeoutMs = opts.timeoutMs ?? (Math.ceil(this.maxMatches / this.parallel) + 2) * runBudgetMs;
    this.maxAttempts = opts.maxAttempts ?? 1;
    if (this.bookConfig) {
      this.id = this.bookConfig.id;
      this.name = this.bookConfig.name;
      this.sourceIds = [this.bookConfig.id];
    }
  }

  async fetchRaw({ signal } = {}) {
    if (this.dryRun) {
      return this.dryRunPayload || { events: [], discovery: { count: 0 }, extraction: { ok: 0, failed: 0, runs: [] } };
    }
    if (!this.bookConfig) {
      throw new Error('TinyfishScraper needs bookConfig');
    }

    const t0 = Date.now();
    this.logger('info', `${this.id}: discovery on ${this.bookConfig.baseUrl}`);
    const { matches, tournaments, raw: discoveryRaw } = await discoverMatches({
      baseUrl: this.bookConfig.baseUrl,
      liveUrl: this.bookConfig.liveUrl,
      locale: this.bookConfig.locale,
      currency: this.bookConfig.currency,
      maxMatches: this.maxDiscoveredMatches,
      maxLiveMatches: this.maxLiveMatches,
      maxSteps: this.maxSteps,
      maxDurationSeconds: this.maxDurationSeconds,
      browserProfile: this.browserProfile,
      strategy: this.bookConfig.discoveryStrategy || 'browser-only',
      eventUrlPattern: this.bookConfig.eventUrlPattern,
      tournamentUrlPattern: this.bookConfig.tournamentUrlPattern,
      eventElementSelector: this.bookConfig.eventElementSelector,
      eventIdSelector: this.bookConfig.eventIdSelector,
      eventIdAttribute: this.bookConfig.eventIdAttribute,
      eventIdPattern: this.bookConfig.eventIdPattern,
      eventUrlTemplate: this.bookConfig.eventUrlTemplate,
      teamSelector: this.bookConfig.teamSelector,
      leagueSelector: this.bookConfig.leagueSelector,
      stripEventQuery: this.bookConfig.stripEventQuery,
      maxTournaments: this.bookConfig.maxTournaments,
      tournamentNavigation: this.bookConfig.tournamentNavigation,
      signal,
    });
    this.logger('info', `${this.id}: discovered ${matches.length} matches`);

    await writeJsonAtomic(join(this.dataDir, 'discovery', `${this.id}_links.json`), {
      schemaVersion: 2,
      sourceId: this.id,
      capturedAt: new Date().toISOString(),
      strategy: discoveryRaw?.strategy || 'unknown',
      routes: discoveryRaw?.routes || [{ mode: 'prematch', url: this.bookConfig.baseUrl }],
      failures: discoveryRaw?.failures || discoveryRaw?.browserFailures || [],
      tournaments: tournaments || [],
      matches,
    });

    if (matches.length === 0) {
      return { events: [], discovery: { count: 0, runId: discoveryRaw?.runId, durationMs: Date.now() - t0 }, extraction: { ok: 0, failed: 0, runs: [] } };
    }

    const extractionMatches = selectExtractionMatches(matches, this.maxMatches);
    this.logger('info', `${this.id}: extracting odds for ${extractionMatches.length}/${matches.length} discovered matches (parallel=${this.parallel})`);
    const { events, runs } = await extractOdds({
      matches: extractionMatches,
      parallel: this.parallel,
      maxSteps: this.maxSteps,
      maxDurationSeconds: this.maxDurationSeconds,
      browserProfile: this.browserProfile,
      signal,
      onProgress: ({ done, total, ok }) => {
        if (done % 5 === 0 || done === total) {
          this.logger('info', `${this.id}: extraction ${done}/${total} (last=${ok ? 'ok' : 'fail'})`);
        }
      },
    });
    const ok = runs.filter((r) => r.ok).length;
    const failed = runs.length - ok;
    this.logger('info', `${this.id}: extraction done ok=${ok} failed=${failed}`);
    return {
      events,
      discovery: { count: matches.length, runId: discoveryRaw?.runId, durationMs: Date.now() - t0 },
      extraction: { ok, failed, runs: runs.map((r) => ({ url: r.url, ok: r.ok, error: r.error })) },
    };
  }

  /** raw → engine-shaped RawEvent[] */
  normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`${this.id}: payload not an object`);
    }
    const list = Array.isArray(raw.events) ? raw.events : [];
    const discovered = Number(raw.discovery?.count || 0);
    const extracted = Number(raw.extraction?.ok || 0);
    const extractionFailed = Number(raw.extraction?.failed || 0);
    if (list.length === 0 && discovered > 0 && extracted === 0 && extractionFailed > 0) {
      const err = new Error(`${this.id}: every discovered event extraction failed`);
      err.code = 'EEXTRACTION';
      throw err;
    }
    return list.map((e) => ({
      id: e.sourceUrl || `${normalizeTeamName(e.homeTeam)}-${normalizeTeamName(e.awayTeam)}-${normalizeKickoff(e.kickoff) || Date.now()}`,
      homeTeam: e.homeTeam,
      awayTeam: e.awayTeam,
      league: e.league || 'Unknown',
      sport: e.sport || 'Football',
      live: Boolean(e.live),
      kickoff: normalizeKickoff(e.kickoff),
      marketGroups: e.markets || [],
    }));
  }

  /** RawEvent[] → NormalizedEvent[] */
  extractEvents(rawEvents) {
    const out = [];
    for (const r of rawEvents) {
      if (!r.homeTeam || !r.awayTeam) continue;
      if (!r.live && !r.kickoff) continue;
      const kickoff = r.kickoff || null;
      const eventTimeKey = r.live && !r.kickoff ? 'live' : new Date(kickoff).toISOString();
      const eventKey = [
        normalizeTeamName(r.sport || 'football'),
        normalizeTeamName(r.league || 'unknown'),
        eventTimeKey,
        normalizeTeamName(r.homeTeam),
        normalizeTeamName(r.awayTeam),
      ].join('|');
      const markets = [];
      for (const m of r.marketGroups || []) {
        if (!m || !Array.isArray(m.selections)) continue;
        const key = String(m.key || '').trim();
        if (!key) continue;
        const selections = m.selections.map((s) => ({
          id: String(s.id ?? `${m.key}::${s.name}`),
          name: canonicalSelectionName(s.name, { homeTeam: r.homeTeam, awayTeam: r.awayTeam }),
          odds: Number(s.odds),
          handicap: s.handicap === null || s.handicap === undefined ? null : Number(s.handicap),
          group: m.name || 'Main',
        })).filter((s) => Number.isFinite(s.odds) && s.odds > 1);
        if (selections.length < 2) continue;
        markets.push({ key, name: String(m.name || key), selections });
      }
      if (markets.length === 0) continue;
      out.push({
        id: String(r.id),
        sourceId: this.sourceIds[0] || this.id,
        sport: r.sport || 'Football',
        live: Boolean(r.live),
        league: r.league || 'Unknown',
        kickoff,
        observedAt: new Date().toISOString(),
        sourceUrl: r.id,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        eventKey,
        markets,
      });
    }
    return out;
  }
}

function selectExtractionMatches(matches, limit) {
  const queues = [matches.filter((match) => !match.live), matches.filter((match) => match.live)];
  const selected = [];
  while (selected.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      if (queue.length > 0 && selected.length < limit) selected.push(queue.shift());
    }
  }
  return selected;
}

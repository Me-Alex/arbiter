import ScraperBase from './base.mjs';
import { UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor } from './live-status.mjs';
import { eventLimit } from './event-limit.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const API_BASE = 'https://api.etoto.pl/rest/market';

/**
 * ETOTO Scraper — Polish Licensed Sportsbook (etoto.pl).
 *
 * REST API architecture:
 *   - Hierarchy: /rest/market/categories (returns ~650 categories across all sports)
 *   - Multi-category events batching: /rest/market/categories/multi/{categoryIds}/events
 *   - Rich prematch football catalog: 1,400+ events across all leagues.
 *   - Markets: 1X2, Podwójna szansa, Remis = zwrot, Obie strzelą, Over/Under totals, etc.
 */
export default class EtotoScraper extends ScraperBase {
  timeoutMs = 25_000;
  maxAttempts = 3;

  constructor(opts = {}) {
    super(opts);
    this.id = 'etoto';
    this.name = 'ETOTO Poland';
    this.sourceIds = ['etoto'];
    this.engine = 'etoto-rest-v1';
    this.transport = 'etoto-public-json';
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxEvents = eventLimit(opts.maxEvents ?? 500);
    this.windowHours = Number(opts.windowHours ?? 168);
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.runId = opts.runId || new Date().toISOString();
    this.sport = opts.sport || 'football';
    this.endpoint = opts.endpoint || `${API_BASE}/categories`;
    this.sourceUrl = this.endpoint;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    this.observedAt = new Date().toISOString();

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;

    // 1. Fetch categories
    let catRes;
    try {
      catRes = await this.fetchImpl(`${API_BASE}/categories`, {
        signal: bounded,
        headers: {
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new UpstreamError(`ETOTO: category fetch failed (${err.message})`, { cause: err });
    }

    if (!catRes.ok) {
      throw new UpstreamError(`ETOTO: categories HTTP ${catRes.status}`, { status: catRes.status });
    }

    const catData = await readBoundedJson(catRes, { maxBytes: 5_000_000 });
    const categories = Array.isArray(catData?.data) ? catData.data : [];

    // Filter football level 3 categories with events
    const footballCats = categories.filter((c) => c.sportId === 1 && c.level === 3 && c.eventsCount > 0);
    if (footballCats.length === 0) {
      return { events: [] };
    }

    // Batch level 3 IDs into chunks of up to 60 categories
    const catIds = footballCats.map((c) => c.categoryId);
    const batches = [];
    const chunkSize = 60;
    for (let i = 0; i < catIds.length; i += chunkSize) {
      batches.push(catIds.slice(i, i + chunkSize));
    }

    const allEvents = [];
    for (const batch of batches) {
      bounded.throwIfAborted();
      const multiUrl = `${API_BASE}/categories/multi/${batch.join(',')}/events`;
      try {
        const evRes = await this.fetchImpl(multiUrl, {
          signal: bounded,
          headers: {
            accept: 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          },
        });
        if (evRes.ok) {
          const evData = await readBoundedJson(evRes, { maxBytes: 15_000_000 });
          if (Array.isArray(evData?.data)) {
            allEvents.push(...evData.data);
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        // Continue partial collection across batches
      }

      if (allEvents.length >= this.maxEvents) break;
    }

    return { events: allEvents };
  }

  normalize(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.events)) return raw.events;
    if (Array.isArray(raw?.data)) return raw.data;
    return [];
  }

  extractEvents(rawEvents) {
    const events = [];
    const seen = new Set();
    const liveEvidence = liveCoverageFor('etoto');
    const isLiveDefault = liveEvidence?.isLive ?? false;

    for (const ev of rawEvents) {
      if (!ev) continue;

      const rawName = String(ev.eventName || '').trim();
      // Format is "Home - Away" or "Home vs Away"
      const parts = rawName.includes(' - ') ? rawName.split(' - ') : rawName.split(/\s+vs\.?\s+/i);
      if (parts.length < 2) continue;

      const homeTeam = parts[0].trim();
      const awayTeam = parts.slice(1).join(' - ').trim();
      if (!homeTeam || !awayTeam) continue;

      const startTime = Number(ev.eventStart);
      if (!Number.isFinite(startTime) || startTime <= 0) continue;

      const now = this.from ?? Date.now();
      const isPast = startTime < now;
      if (isPast && !this.includePast) continue;

      const windowEnd = this.to ?? (now + this.windowHours * 3600000);
      if (startTime > windowEnd) continue;

      const id = String(ev.eventId || ev.remoteId || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const kickoff = new Date(startTime).toISOString();
      const league = String(ev.category3Name || ev.category2Name || 'Ekstraklasa').trim();

      const eventGames = Array.isArray(ev.eventGames) ? ev.eventGames : [];
      const markets = [];

      for (const game of eventGames) {
        if (!game || !Array.isArray(game.outcomes)) continue;

        // 1. Full-time 1X2 (gameType: 1)
        if (game.gameType === 1 || game.gameName === '1X2') {
          let o1 = null;
          let oX = null;
          let o2 = null;
          for (const oc of game.outcomes) {
            const odds = Number(oc.outcomeOdds);
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const name = String(oc.outcomeName || '').trim().toLowerCase();
            if (name === 'x' || name === 'remis') {
              oX = odds;
            } else if (oc.outcomePosition === 0 || name === homeTeam.toLowerCase() || name === '1') {
              o1 = odds;
            } else if (oc.outcomePosition === 2 || name === awayTeam.toLowerCase() || name === '2') {
              o2 = odds;
            }
          }
          if (o1 && oX && o2) {
            markets.push({
              key: '1x2',
              name: '1X2',
              period: 'fulltime',
              live: isLiveDefault,
              selections: [
                { id: `${id}:1x2:1`, name: '1', odds: o1, handicap: null },
                { id: `${id}:1x2:X`, name: 'X', odds: oX, handicap: null },
                { id: `${id}:1x2:2`, name: '2', odds: o2, handicap: null },
              ],
            });
          }
        }

        // 2. Both Teams To Score (gameType: 98, gameName: 'Obie strzelą')
        if (game.gameType === 98 || /obie\s+strzel/i.test(game.gameName || '')) {
          let yesOdds = null;
          let noOdds = null;
          for (const oc of game.outcomes) {
            const odds = Number(oc.outcomeOdds);
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const name = String(oc.outcomeName || '').trim().toLowerCase();
            if (name === 'tak' || name === 'yes') yesOdds = odds;
            else if (name === 'nie' || name === 'no') noOdds = odds;
          }
          if (yesOdds && noOdds) {
            markets.push({
              key: 'btts',
              name: 'Both Teams to Score',
              period: 'fulltime',
              live: isLiveDefault,
              selections: [
                { id: `${id}:btts:yes`, name: 'Yes', odds: yesOdds, handicap: null },
                { id: `${id}:btts:no`, name: 'No', odds: noOdds, handicap: null },
              ],
            });
          }
        }

        // 3. Over / Under Goals (gameType: 8, argument: e.g. 0.5, 1.5, 2.5)
        if (game.gameType === 8 && Number.isFinite(Number(game.argument))) {
          const line = Number(game.argument);
          let overOdds = null;
          let underOdds = null;
          for (const oc of game.outcomes) {
            const odds = Number(oc.outcomeOdds);
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const name = String(oc.outcomeName || '').trim().toLowerCase();
            if (name.includes('powyżej') || name.includes('over')) overOdds = odds;
            else if (name.includes('poniżej') || name.includes('under')) underOdds = odds;
          }
          if (overOdds && underOdds) {
            markets.push({
              key: `total:${line}`,
              name: `Total Over/Under ${line}`,
              period: 'fulltime',
              live: isLiveDefault,
              line,
              selections: [
                { id: `${id}:ou:${line}:over`, name: `Over ${line}`, odds: overOdds, handicap: line },
                { id: `${id}:ou:${line}:under`, name: `Under ${line}`, odds: underOdds, handicap: line },
              ],
            });
          }
        }
      }

      if (markets.length === 0) continue;

      events.push({
        id,
        sport: 'football',
        league,
        homeTeam,
        awayTeam,
        kickoff,
        live: isLiveDefault,
        markets,
      });

      if (events.length >= this.maxEvents) break;
    }

    return events;
  }
}

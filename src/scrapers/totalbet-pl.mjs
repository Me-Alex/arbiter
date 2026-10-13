import ScraperBase from './base.mjs';
import { UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor } from './live-status.mjs';
import { eventLimit } from './event-limit.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const API_BASE = 'https://totalbet.pl/dealer/bdata/v1/bet';

/**
 * TotalBet Poland Scraper — Polish Licensed Sportsbook (totalbet.pl).
 *
 * REST API architecture:
 *   - Events listing: /dealer/bdata/v1/bet/events?type=prematch&per_page={limit}&page={page}
 *   - Event details: /dealer/bdata/v1/bet/events/{uuid}
 *   - Exact odds parity verified against live totalbet.pl in-browser.
 *   - Markets: 1X2 (Wynik meczu), Obie drużyny strzelą gola (BTTS), Total Over/Under.
 */
export default class TotalBetPlScraper extends ScraperBase {
  timeoutMs = 25_000;
  maxAttempts = 3;

  constructor(opts = {}) {
    super(opts);
    this.id = 'totalbet-pl';
    this.name = 'TotalBet Poland';
    this.sourceIds = ['totalbet-pl'];
    this.engine = 'totalbet-rest-v1';
    this.transport = 'totalbet-public-json';
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxEvents = eventLimit(opts.maxEvents ?? 500);
    this.windowHours = Number(opts.windowHours ?? 168);
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.runId = opts.runId || new Date().toISOString();
    this.sport = opts.sport || 'football';
    this.endpoint = opts.endpoint || `${API_BASE}/events?type=prematch&per_page=100&page=1`;
    this.sourceUrl = this.endpoint;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    this.observedAt = new Date().toISOString();

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;

    const allEvents = [];
    const perPage = Math.min(this.maxEvents, 100);
    const maxPages = Math.ceil(this.maxEvents / perPage);

    for (let page = 1; page <= maxPages; page++) {
      bounded.throwIfAborted();
      const url = `${API_BASE}/events?type=prematch&per_page=${perPage}&page=${page}`;
      let res;
      try {
        res = await this.fetchImpl(url, {
          signal: bounded,
          headers: {
            accept: 'application/json',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          },
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new UpstreamError(`TotalBet PL: events fetch failed (${err.message})`, { cause: err });
      }

      if (!res.ok) {
        throw new UpstreamError(`TotalBet PL: events HTTP ${res.status}`, { status: res.status });
      }

      const json = await readBoundedJson(res, { maxBytes: 15_000_000 });
      const pageEvents = Array.isArray(json?.data?.events) ? json.data.events : [];
      if (pageEvents.length === 0) break;

      allEvents.push(...pageEvents);

      const totalPages = Number(json?._meta?.pagination?.total_pages);
      if (Number.isFinite(totalPages) && page >= totalPages) break;
      if (allEvents.length >= this.maxEvents) break;
    }

    // Enrich up to 20 top events with detail component_lists if not already present
    const detailCandidates = allEvents.slice(0, 20).filter((e) => !e.component_lists || e.component_lists.length <= 1);
    await Promise.all(
      detailCandidates.map(async (ev) => {
        try {
          const detailRes = await this.fetchImpl(`${API_BASE}/events/${ev.uuid}`, {
            signal: bounded,
            headers: {
              accept: 'application/json',
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            },
          });
          if (detailRes.ok) {
            const detailData = await readBoundedJson(detailRes, { maxBytes: 5_000_000 });
            if (detailData?.data?.event?.component_lists) {
              ev.component_lists = detailData.data.event.component_lists;
            }
          }
        } catch {
          // Gracefully retain list-level markets
        }
      })
    );

    return { events: allEvents };
  }

  normalize(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.events)) return raw.events;
    if (Array.isArray(raw?.data?.events)) return raw.data.events;
    if (Array.isArray(raw?.data)) return raw.data;
    return [];
  }

  extractEvents(rawEvents) {
    const events = [];
    const seen = new Set();
    const liveEvidence = liveCoverageFor('totalbet-pl');
    const isLiveDefault = liveEvidence?.isLive ?? false;

    for (const ev of rawEvents) {
      if (!ev) continue;

      let homeTeam = '';
      let awayTeam = '';

      if (Array.isArray(ev.participants) && ev.participants.length >= 2) {
        homeTeam = String(ev.participants[0]?.name || '').trim();
        awayTeam = String(ev.participants[1]?.name || '').trim();
      }

      if (!homeTeam || !awayTeam) {
        const rawName = String(ev.name || '').trim();
        const parts = rawName.includes(' - ') ? rawName.split(' - ') : rawName.split(/\s+vs\.?\s+/i);
        if (parts.length >= 2) {
          homeTeam = parts[0].trim();
          awayTeam = parts.slice(1).join(' - ').trim();
        }
      }

      if (!homeTeam || !awayTeam) continue;

      const startTime = Date.parse(ev.start_at);
      if (!Number.isFinite(startTime) || startTime <= 0) continue;

      const now = this.from ?? Date.now();
      const isPast = startTime < now;
      if (isPast && !this.includePast) continue;

      const windowEnd = this.to ?? (now + this.windowHours * 3600000);
      if (startTime > windowEnd) continue;

      const id = String(ev.uuid || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const kickoff = new Date(startTime).toISOString();
      const league = String(ev.tournament?.name || ev.category?.name || 'Ekstraklasa').trim();

      const markets = [];

      // 1. Full-time 1X2 from event.markets
      const eventMarkets = Array.isArray(ev.markets) ? ev.markets : [];
      for (const m of eventMarkets) {
        if (!m || !Array.isArray(m.outcomes)) continue;
        if (m.game_type === 'threeway' || /wynik\s+meczu/i.test(m.name || '')) {
          let o1 = null;
          let oX = null;
          let o2 = null;

          for (const oc of m.outcomes) {
            const odds = Number(oc.odds);
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const sort = oc.sort;
            const name = String(oc.name || '').trim().toLowerCase();

            if (sort === 1 || name === homeTeam.toLowerCase()) {
              o1 = odds;
            } else if (sort === 2 || name === 'remis' || name === 'x') {
              oX = odds;
            } else if (sort === 3 || name === awayTeam.toLowerCase()) {
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
      }

      // 2. Parse component_lists if present (BTTS & Over/Under totals)
      const componentLists = Array.isArray(ev.component_lists) ? ev.component_lists : [];
      for (const comp of componentLists) {
        if (!comp || !Array.isArray(comp.grid)) continue;

        // Obie drużyny strzelą gola (BTTS)
        if (/obie\s+drużyny\s+strzel/i.test(comp.name || '')) {
          let yesOdds = null;
          let noOdds = null;
          for (const row of comp.grid) {
            if (!Array.isArray(row)) continue;
            for (const cell of row) {
              if (cell.type === 'outcome') {
                const odds = Number(cell.odds);
                if (Number.isFinite(odds) && odds > 1) {
                  const label = String(cell.name || '').toLowerCase();
                  if (label === 'tak') yesOdds = odds;
                  else if (label === 'nie') noOdds = odds;
                }
              }
            }
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

        // Total (suma) Over/Under
        if (comp.name === 'Total (suma)' && comp.type === 'total') {
          for (const row of comp.grid) {
            if (!Array.isArray(row) || row.length < 3) continue;
            const lineCell = row[0];
            const line = Number(lineCell?.text);
            if (!Number.isFinite(line)) continue;

            const underCell = row[1];
            const overCell = row[2];

            const underOdds = Number(underCell?.odds);
            const overOdds = Number(overCell?.odds);

            if (Number.isFinite(underOdds) && underOdds > 1 && Number.isFinite(overOdds) && overOdds > 1) {
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
      }

      if (markets.length === 0) continue;

      events.push({
        id,
        sourceId: this.id,
        sourceUrl: this.sourceUrl,
        transport: this.transport,
        runId: this.runId,
        observedAt: this.observedAt ?? new Date().toISOString(),
        sport: this.sport,
        league,
        homeTeam,
        awayTeam,
        kickoff,
        live: isLiveDefault,
        eventKey: `${homeTeam} vs ${awayTeam} ${kickoff}`,
        markets,
      });

      if (events.length >= this.maxEvents) break;
    }

    return events;
  }
}

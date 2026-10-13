import ScraperBase from './base.mjs';
import { UpstreamError } from '../shared/errors.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { eventIdentityKey } from '../shared/text.mjs';
import { liveCoverageFor, markMarketsLive } from './live-status.mjs';
import { eventLimit } from './event-limit.mjs';

/**
 * TotalBet (totalbet) — Oddin Sports Distribution Platform (`oddin-platform`).
 *
 * Feed endpoint: `https://tbet-sofferapi.oddin-platform.com/sofferapi/api/offer/`
 * Public offer pagination providing full-time 1X2 markets across prematch football.
 */
export default class TotalBet extends ScraperBase {
  timeoutMs = 25_000;
  maxAttempts = 3;

  constructor(opts = {}) {
    super(opts);
    this.id = 'totalbet';
    this.name = 'TotalBet';
    this.sourceIds = ['totalbet'];
    this.engine = 'oddin-platform';
    this.transport = 'oddin-public-sports-json';
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxEvents = eventLimit(opts.maxEvents ?? 500);
    this.windowHours = Number(opts.windowHours ?? 168);
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.runId = opts.runId || new Date().toISOString();
    this.endpoint = opts.endpoint || 'https://tbet-sofferapi.oddin-platform.com/sofferapi/api/offer/getOfferPag/1/200/1/0/0/0/0';
    this.sourceUrl = this.endpoint;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    this.observedAt = new Date().toISOString();
    this.sourceUrl = this.endpoint;

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;

    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        signal: bounded,
        headers: {
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new UpstreamError(`TotalBet: fetch failed (${err.message})`, { cause: err });
    }

    if (!res.ok) {
      throw new UpstreamError(`TotalBet: HTTP ${res.status}`, { status: res.status });
    }

    const data = await readBoundedJson(res, { maxBytes: 15_000_000 });
    return data;
  }

  normalize(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      if (raw[0]?.leagues) {
        return raw[0].leagues.flatMap((l) => (l.events || []).map((e) => ({ ...e, leagueName: l.leagueName })));
      }
      return raw;
    }
    if (raw?.leagues) {
      return raw.leagues.flatMap((l) => (l.events || []).map((e) => ({ ...e, leagueName: l.leagueName })));
    }
    return raw?.events || [];
  }

  extractEvents(rawEvents) {
    const events = [];
    const seen = new Set();
    const liveEvidence = liveCoverageFor('totalbet');
    const isLiveDefault = liveEvidence?.isLive ?? false;

    for (const ev of rawEvents) {
      if (!ev) continue;
      const rawName = String(ev.eventName || '').trim();
      const parts = rawName.split(/\s+vs\.?\s+/i);
      if (parts.length < 2) continue;

      const homeTeam = parts[0].trim();
      const awayTeam = parts[1].trim();
      if (!homeTeam || !awayTeam) continue;

      const time = Date.parse(ev.eventDate);
      if (!Number.isFinite(time)) continue;

      const now = this.from ?? Date.now();
      const isPast = time < now;
      if (isPast && !this.includePast) continue;

      const windowEnd = this.to ?? (now + this.windowHours * 3600000);
      if (time > windowEnd) continue;

      const id = String(ev.eventId || ev.fixtureId || ev.eventNo || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const kickoff = new Date(time).toISOString();
      const league = String(ev.leagueName || 'Fotbal').trim();

      let outcomes = [];
      if (Array.isArray(ev.markets)) {
        const finalMkt = ev.markets.find((m) => m.marketId === '1' || m.marketName === 'Final');
        outcomes = finalMkt?.outcomes || [];
      } else if (Array.isArray(ev.outcomes)) {
        outcomes = ev.outcomes.filter((o) => o.marketName === 'Final' || o.marketId === '1');
      }

      let odd1 = null;
      let oddX = null;
      let odd2 = null;

      for (const o of outcomes) {
        const name = String(o.outcomeName || o.name || '').trim();
        const val = Number(o.value ?? o.odds);
        if (!Number.isFinite(val) || val <= 1) continue;
        if (name === '1') odd1 = val;
        else if (name === 'X' || name === 'x') oddX = val;
        else if (name === '2') odd2 = val;
      }

      if (!odd1 || !oddX || !odd2) continue;

      const isLive = isLiveDefault;
      const markets = [
        {
          key: '1x2',
          name: '1X2',
          period: 'fulltime',
          live: isLive,
          selections: [
            { id: `${id}:1`, name: '1', odds: odd1, handicap: null },
            { id: `${id}:X`, name: 'X', odds: oddX, handicap: null },
            { id: `${id}:2`, name: '2', odds: odd2, handicap: null },
          ],
        },
      ];

      markMarketsLive(markets, () => isLive);

      const normalized = {
        id,
        sourceId: 'totalbet',
        sourceUrl: this.sourceUrl,
        transport: this.transport,
        runId: this.runId,
        observedAt: this.observedAt ?? new Date().toISOString(),
        sport: 'Football',
        league,
        kickoff,
        homeTeam,
        awayTeam,
        live: isLive,
        isLive,
        eventKey: eventIdentityKey({ sport: 'Football', league, kickoff, homeTeam, awayTeam }),
        providerEventKey: `${id}|${kickoff}`,
        markets,
      };

      events.push(normalized);
      if (events.length >= this.maxEvents) break;
    }

    return events;
  }
}

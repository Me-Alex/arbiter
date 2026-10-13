import ScraperBase from './base.mjs';
import { ValidationError, UpstreamError, TimeoutError } from '../shared/errors.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { canonicalSport, eventIdentityKey } from '../shared/text.mjs';
import { digitainEventIsLive, markMarketsLive } from './live-status.mjs';
import { eventLimit } from './event-limit.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

export const WINMASTERS_SPORT_ID_MAP = Object.freeze({
  1: 'football',
  2: 'basketball',
  3: 'tennis',
  4: 'ice-hockey',
  5: 'handball',
  6: 'volleyball',
});

export const WINMASTERS_SPORT_NAME_TO_ID = Object.freeze({
  football: 1,
  basketball: 2,
  tennis: 3,
  'ice-hockey': 4,
  handball: 5,
  volleyball: 6,
});

/**
 * Winmasters (winmasters) scraper.
 *
 * Platform: Digitain sportsbook on sport.winmasters.ro (EveryMatrix CMS / Digitain odds).
 * System cards REST endpoint returning structured football matches and 1X2 market odds.
 */
export default class Winmasters extends ScraperBase {
  constructor(opts = {}) {
    super(opts);
    this.id = 'winmasters';
    this.name = 'Winmasters';
    this.sourceIds = ['winmasters'];
    this.engine = 'custom-json';
    this.transport = 'custom-json';
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxEvents = eventLimit(opts.maxEvents ?? 500);

    if (Array.isArray(opts.sports) && opts.sports.length > 0) {
      this.sportsFilter = opts.sports.map((s) => canonicalSport(s));
      this.sportFilter = null;
    } else {
      this.sportsFilter = null;
      this.sportFilter = opts.sport === 'all' ? null : canonicalSport(opts.sport || 'football');
    }

    const defaultSportId = (this.sportFilter && WINMASTERS_SPORT_NAME_TO_ID[this.sportFilter]) || 1;
    this.endpoint = opts.endpoint || this._buildEndpoint(defaultSportId);
    this.sourceUrl = this.endpoint;
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.windowHours = Number(opts.windowHours ?? 168);
    this.timeoutMs = Number(opts.timeoutMs ?? 25_000);
    this.runId = opts.runId || null;
  }

  _buildEndpoint(sportId = 1) {
    return `https://sport.winmasters.ro/b73f1f2d-e2da-48b0-a29c-16088b5a6b4f/account/getsystemcardsbysportid?sportId=${sportId}&langId=42&partnerId=3000235&countryCode=RO`;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    this.sourceUrl = this.endpoint;

    // Single endpoint path if explicit endpoint was passed or single sport requested
    const targetSportIds = [];
    if (this.sportsFilter && this.sportsFilter.length > 0) {
      for (const sp of this.sportsFilter) {
        const id = WINMASTERS_SPORT_NAME_TO_ID[sp];
        if (id) targetSportIds.push(id);
      }
    } else if (this.sportFilter === null) {
      // sport: 'all' -> query core sports
      targetSportIds.push(1, 2, 3);
    }

    if (targetSportIds.length <= 1 || this.endpoint !== this._buildEndpoint(1)) {
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'GET',
          redirect: 'error',
          signal: bounded,
          headers: {
            accept: 'application/json, text/plain, */*',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
      } catch (err) {
        if (err.name === 'AbortError' || bounded.aborted) {
          throw new TimeoutError(`winmasters: fetch timed out after ${this.timeoutMs}ms`);
        }
        throw new UpstreamError(`winmasters: network request failed: ${err.message}`, { cause: err });
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new UpstreamError(`winmasters: HTTP ${response.status}`, { status: response.status });
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json') && !contentType.includes('text/plain')) {
        await response.body?.cancel();
        throw new ValidationError(`winmasters: expected JSON response, got ${contentType}`);
      }

      const raw = await readBoundedJson(response, this.id, bounded, 20_000_000);
      this.observedAt = new Date().toISOString();
      return raw;
    }

    // Multi-sport batch query
    const mergedEvents = [];
    for (const sId of targetSportIds) {
      bounded.throwIfAborted();
      const url = this._buildEndpoint(sId);
      try {
        const resp = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'error',
          signal: bounded,
          headers: {
            accept: 'application/json, text/plain, */*',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        if (resp.ok) {
          const rawPart = await readBoundedJson(resp, `${this.id}-${sId}`, bounded, 20_000_000);
          const normalizedPart = this.normalize(rawPart);
          if (Array.isArray(normalizedPart)) {
            mergedEvents.push(...normalizedPart);
          }
        }
      } catch {
        // Continue partial collection across sports
      }
    }
    this.observedAt = new Date().toISOString();
    return { data: mergedEvents };
  }

  normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ValidationError('winmasters: raw payload must be an object or array');
    }

    if (raw.faultcode || raw.error || raw.status === 'error' || raw.success === false) {
      throw new UpstreamError(`winmasters: upstream error: ${raw.faultstring || raw.error || 'unknown error'}`);
    }

    let events = null;
    if (Array.isArray(raw)) {
      events = raw;
    } else if (Array.isArray(raw.raw)) {
      events = raw.raw;
    } else if (Array.isArray(raw.data)) {
      events = raw.data;
    } else if (Array.isArray(raw.data?.events)) {
      events = raw.data.events;
    } else if (Array.isArray(raw.events)) {
      events = raw.events;
    } else if (Array.isArray(raw.cards)) {
      events = raw.cards;
    }

    if (!Array.isArray(events)) {
      throw new ValidationError('winmasters: missing events array in payload');
    }

    return events;
  }

  _localize(val, fallback = '') {
    if (val === undefined || val === null) return fallback;
    if (typeof val === 'string' || typeof val === 'number') return String(val);
    if (typeof val === 'object') {
      return val['42'] || val['ro'] || val['2'] || val['en'] || Object.values(val)[0] || fallback;
    }
    return String(val);
  }

  extractEvents(rawEvents) {
    if (!Array.isArray(rawEvents)) {
      throw new ValidationError('winmasters: rawEvents must be an array');
    }

    const out = [];
    const nowMs = Date.now();
    const windowEndMs = nowMs + this.windowHours * 3600000;

    for (const event of rawEvents) {
      if (out.length >= this.maxEvents) break;
      if (!event || typeof event !== 'object') continue;
      if (event.active === false || event.bettingStatus === false) continue;

      // Sport verification
      let eventSport = null;
      if (event.SId !== undefined && event.SId !== null) {
        eventSport = WINMASTERS_SPORT_ID_MAP[Number(event.SId)] || null;
      }
      if (!eventSport && event.idSport !== undefined && event.idSport !== null) {
        eventSport = WINMASTERS_SPORT_ID_MAP[Number(event.idSport)] || null;
      }
      if (!eventSport) {
        const sportLabel = this._localize(event.SN || event.ESN || event.sportName || 'Fotbal');
        eventSport = canonicalSport(sportLabel);
      }
      if (this.sportsFilter && !this.sportsFilter.includes(eventSport)) continue;
      if (this.sportFilter && eventSport !== this.sportFilter) continue;

      // Live verification
      const isLive = Boolean(event.IsInL || event.IST || digitainEventIsLive(event));
      if (isLive && !this.includeLive) continue;

      // Kickoff verification
      const rawTime = event.D ?? event.matchDateTime ?? event.kickoff ?? event.startDate;
      const startMs = /^\d+$/.test(String(rawTime ?? '')) ? Number(rawTime) : Date.parse(rawTime);
      if (!Number.isFinite(startMs)) continue;
      if (!this.includePast && !isLive && startMs < nowMs) continue;
      if (!this.includeLive && startMs > windowEndMs) continue;
      const isoKickoff = new Date(startMs).toISOString();

      // Team names
      const home = this._localize(event.HT || event.EHT || event.team1Name || event.homeTeam);
      const away = this._localize(event.AT || event.EAT || event.team2Name || event.awayTeam);
      const cleanHome = home.trim();
      const cleanAway = away.trim();
      if (!cleanHome || !cleanAway) continue;

      // Event ID & League
      const eventId = event.EId || event.Id || event.idMatch || event.id;
      if (!eventId) continue;
      const leagueName = this._localize(event.ECN || event.CN || event.tournamentName || event.league || (eventSport === 'basketball' ? 'Baschet' : 'Fotbal')).trim();

      // Market extraction (1X2 for 3-way sports or MATCH_ODDS for 2-way sports)
      let marketMatch = null;
      const subMarkets = [];

      // Format A: Digitain Card Stakes (event.S)
      if (Array.isArray(event.S) && event.S.length > 0) {
        const resultStakes = event.S.filter((s) => {
          if (!s || s.SS === true) return false;
          const gName = this._localize(s.GN || '').trim();
          const isResult = s.GId === 1
            || /^(castigator meci|rezultat final|1x2|match result|rezultat|winner|match winner|money\s*line)$/i.test(gName)
            || (!s.GId && !gName);
          if (!isResult) return false;
          const odds = Number(s.F);
          return Number.isFinite(odds) && odds > 1;
        });

        const outcome1 = resultStakes.find((s) => s.TeamSide === 1 || this._localize(s.N).trim() === '1' || this._localize(s.EN).trim() === '1');
        const outcomeX = resultStakes.find((s) => s.TeamSide === 0 || this._localize(s.N).trim().toUpperCase() === 'X' || this._localize(s.EN).trim().toUpperCase() === 'X');
        const outcome2 = resultStakes.find((s) => s.TeamSide === 2 || this._localize(s.N).trim() === '2' || this._localize(s.EN).trim() === '2');

        if (outcome1 && outcomeX && outcome2) {
          marketMatch = {
            key: '1X2',
            name: 'Rezultat final',
            period: 'fulltime',
            selections: [
              { name: '1', odds: Number(outcome1.F) },
              { name: 'X', odds: Number(outcomeX.F) },
              { name: '2', odds: Number(outcome2.F) },
            ],
          };
        } else if (outcome1 && outcome2 && !outcomeX && eventSport !== 'football') {
          // 2-way match result (Moneyline / Winner for Basketball, Tennis, etc.)
          marketMatch = {
            key: 'MATCH_ODDS',
            name: 'Castigator meci',
            period: 'fulltime',
            selections: [
              { name: '1', odds: Number(outcome1.F) },
              { name: '2', odds: Number(outcome2.F) },
            ],
          };
        }

        // Sub-window period derivative extraction from event.S
        const groups = new Map();
        for (const s of event.S) {
          if (!s || s.SS === true) continue;
          const odds = Number(s.F);
          if (!Number.isFinite(odds) || odds <= 1) continue;
          const gKey = s.GId || s.GN;
          if (!gKey || gKey === 1) continue;
          if (!groups.has(gKey)) groups.set(gKey, []);
          groups.get(gKey).push(s);
        }

        for (const stakes of groups.values()) {
          const gName = this._localize(stakes[0].GN || stakes[0].EGN || '').trim();
          const period = extractPeriodFromName(gName);
          if (!period) continue;
          const o1 = stakes.find((s) => s.TeamSide === 1 || this._localize(s.N).trim() === '1' || this._localize(s.EN).trim() === '1');
          const oX = stakes.find((s) => s.TeamSide === 0 || this._localize(s.N).trim().toUpperCase() === 'X' || this._localize(s.EN).trim().toUpperCase() === 'X');
          const o2 = stakes.find((s) => s.TeamSide === 2 || this._localize(s.N).trim() === '2' || this._localize(s.EN).trim() === '2');
          if (o1 && oX && o2) {
            subMarkets.push({
              key: '1X2',
              name: gName,
              period,
              selections: [
                { name: '1', odds: Number(o1.F) },
                { name: 'X', odds: Number(oX.F) },
                { name: '2', odds: Number(o2.F) },
              ],
            });
          } else if (o1 && o2 && !oX) {
            subMarkets.push({
              key: 'MATCH_ODDS',
              name: gName,
              period,
              selections: [
                { name: '1', odds: Number(o1.F) },
                { name: '2', odds: Number(o2.F) },
              ],
            });
          }
        }
      }

      // Format B: Digitain MatchBets (event.matchBets)
      if (Array.isArray(event.matchBets) && event.matchBets.length > 0) {
        for (const mb of event.matchBets) {
          if (mb.mbActive === false) continue;
          const mbName = this._localize(mb.mbDisplayName).trim();
          const outcomes = mb.mbOutcomes || [];
          const o1 = outcomes.find((o) => this._localize(o.mboDisplayName).trim() === '1' && o.mboActive && Number(o.mboOddValue) > 1);
          const oX = outcomes.find((o) => this._localize(o.mboDisplayName).trim().toUpperCase() === 'X' && o.mboActive && Number(o.mboOddValue) > 1);
          const o2 = outcomes.find((o) => this._localize(o.mboDisplayName).trim() === '2' && o.mboActive && Number(o.mboOddValue) > 1);

          if (!marketMatch && /^(rezultat|rezultat final|match result|1x2|final|c[aâ][sș]?tig[aă]tor(?:\s+meci)?|winner|match winner|money\s*line)$/i.test(mbName)) {
            if (outcomes.length === 3 && o1 && oX && o2) {
              marketMatch = {
                key: '1X2',
                name: 'Rezultat final',
                period: 'fulltime',
                selections: [
                  { name: '1', odds: Number(o1.mboOddValue) },
                  { name: 'X', odds: Number(oX.mboOddValue) },
                  { name: '2', odds: Number(o2.mboOddValue) },
                ],
              };
              continue;
            } else if (outcomes.length === 2 && o1 && o2 && eventSport !== 'football') {
              marketMatch = {
                key: 'MATCH_ODDS',
                name: 'Castigator meci',
                period: 'fulltime',
                selections: [
                  { name: '1', odds: Number(o1.mboOddValue) },
                  { name: '2', odds: Number(o2.mboOddValue) },
                ],
              };
              continue;
            }
          }

          // Sub-window period match odds / 1X2 from matchBets
          const period = extractPeriodFromName(mbName);
          if (period) {
            if (outcomes.length === 3 && o1 && oX && o2) {
              subMarkets.push({
                key: '1X2',
                name: mbName,
                period,
                selections: [
                  { name: '1', odds: Number(o1.mboOddValue) },
                  { name: 'X', odds: Number(oX.mboOddValue) },
                  { name: '2', odds: Number(o2.mboOddValue) },
                ],
              });
            } else if (outcomes.length === 2 && o1 && o2 && !oX) {
              subMarkets.push({
                key: 'MATCH_ODDS',
                name: mbName,
                period,
                selections: [
                  { name: '1', odds: Number(o1.mboOddValue) },
                  { name: '2', odds: Number(o2.mboOddValue) },
                ],
              });
            }
          }
        }
      }

      // Require a complete match result market
      if (!marketMatch) continue;

      const eventKey = eventIdentityKey({
        kickoff: isoKickoff,
        homeTeam: cleanHome,
        awayTeam: cleanAway,
        sport: eventSport || 'football',
      });

      // Deduplicate extra sub-window markets by key + period
      const dedupedSub = [];
      const seenKeys = new Set([`${marketMatch.key}:${marketMatch.period || 'fulltime'}`]);
      for (const sm of subMarkets) {
        const idKey = `${sm.key}:${sm.period || 'fulltime'}`;
        if (seenKeys.has(idKey)) continue;
        seenKeys.add(idKey);
        dedupedSub.push(sm);
      }

      const markets = [marketMatch, ...dedupedSub];
      if (isLive) {
        markMarketsLive(markets, () => true);
      }

      out.push({
        id: String(eventId),
        sourceId: this.id,
        sourceUrl: this.sourceUrl || this.endpoint,
        sport: eventSport || 'football',
        homeTeam: cleanHome,
        awayTeam: cleanAway,
        league: leagueName,
        kickoff: isoKickoff,
        live: isLive,
        isLive,
        eventKey,
        markets,
        ...(this.runId ? { runId: this.runId } : {}),
      });
    }

    return out;
  }
}

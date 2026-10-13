import ScraperBase from './base.mjs';
import { ValidationError, UpstreamError, TimeoutError } from '../shared/errors.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { canonicalSport, eventIdentityKey } from '../shared/text.mjs';
import { digitainEventIsLive, markMarketsLive } from './live-status.mjs';
import { eventLimit } from './event-limit.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

const KINGCASINO_ENDPOINT = 'https://sport.kingcasino.ro/60110724-301d-4b7d-9255-0ef71c533840/account/getsystemcardsbysportid?sportId=1&tabId=675&langId=42&partnerId=3000245&countryCode=RO';

/**
 * King Casino (kingcasino) scraper.
 *
 * Platform: Digitain sportsbook on sport.kingcasino.ro (EveryMatrix CMS / Digitain odds).
 * System cards REST endpoint returning structured football matches and 1X2 market odds.
 */
export default class Kingcasino extends ScraperBase {
  constructor(opts = {}) {
    super(opts);
    this.id = 'kingcasino';
    this.name = 'King Casino';
    this.sourceIds = ['kingcasino'];
    this.engine = 'custom-json';
    this.transport = 'custom-json';
    this.endpoint = opts.endpoint || KINGCASINO_ENDPOINT;
    this.sourceUrl = this.endpoint;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxEvents = eventLimit(opts.maxEvents ?? 500);
    this.sportFilter = opts.sport === 'all' ? null : canonicalSport(opts.sport || 'football');
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.windowHours = Number(opts.windowHours ?? 168);
    this.timeoutMs = Number(opts.timeoutMs ?? 25_000);
    this.runId = opts.runId || null;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    this.sourceUrl = this.endpoint;

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
        throw new TimeoutError(`kingcasino: fetch timed out after ${this.timeoutMs}ms`);
      }
      throw new UpstreamError(`kingcasino: network request failed: ${err.message}`, { cause: err });
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError(`kingcasino: HTTP ${response.status}`, { status: response.status });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json') && !contentType.includes('text/plain')) {
      await response.body?.cancel();
      throw new ValidationError(`kingcasino: expected JSON response, got ${contentType}`);
    }

    const raw = await readBoundedJson(response, this.id, bounded, 20_000_000);
    this.observedAt = new Date().toISOString();
    return raw;
  }

  normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ValidationError('kingcasino: raw payload must be an object or array');
    }

    if (raw.faultcode || raw.error || raw.status === 'error' || raw.success === false) {
      throw new UpstreamError(`kingcasino: upstream error: ${raw.faultstring || raw.error || 'unknown error'}`);
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
      throw new ValidationError('kingcasino: missing events array in payload');
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
      throw new ValidationError('kingcasino: rawEvents must be an array');
    }

    const out = [];
    const nowMs = Date.now();
    const windowEndMs = nowMs + this.windowHours * 3600000;

    for (const event of rawEvents) {
      if (out.length >= this.maxEvents) break;
      if (!event || typeof event !== 'object') continue;
      if (event.active === false || event.bettingStatus === false) continue;

      // Sport verification
      const sportLabel = this._localize(event.SN || event.ESN || event.sportName || 'Fotbal');
      const canonical = canonicalSport(sportLabel);
      if (this.sportFilter && canonical !== this.sportFilter) continue;
      if (this.sportFilter === 'football') {
        if (event.SId !== undefined && event.SId !== null && Number(event.SId) !== 1) continue;
        if (event.idSport !== undefined && event.idSport !== null && String(event.idSport) !== '1') continue;
      }

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
      const leagueName = this._localize(event.ECN || event.CN || event.tournamentName || event.league || 'Fotbal').trim();

      // 1X2 / 2-Way Market extraction
      let market1X2 = null;
      const subMarkets = [];

      // Format A: Digitain Card Stakes (event.S)
      if (Array.isArray(event.S) && event.S.length > 0) {
        const resultStakes = event.S.filter((s) => {
          if (!s || s.SS === true) return false;
          const gName = this._localize(s.GN || '').trim();
          const isResult = s.GId === 1
            || /^(castigator meci|rezultat final|1x2|match result|rezultat)$/i.test(gName)
            || (!s.GId && !gName);
          if (!isResult) return false;
          const odds = Number(s.F);
          return Number.isFinite(odds) && odds > 1;
        });

        const outcome1 = resultStakes.find((s) => s.TeamSide === 1 || this._localize(s.N).trim() === '1' || this._localize(s.EN).trim() === '1');
        const outcomeX = resultStakes.find((s) => s.TeamSide === 0 || this._localize(s.N).trim().toUpperCase() === 'X' || this._localize(s.EN).trim().toUpperCase() === 'X');
        const outcome2 = resultStakes.find((s) => s.TeamSide === 2 || this._localize(s.N).trim() === '2' || this._localize(s.EN).trim() === '2');

        if (outcome1 && outcomeX && outcome2) {
          market1X2 = {
            key: '1X2',
            name: 'Rezultat final',
            period: 'fulltime',
            selections: [
              { name: '1', odds: Number(outcome1.F) },
              { name: 'X', odds: Number(outcomeX.F) },
              { name: '2', odds: Number(outcome2.F) },
            ],
          };
        } else if (outcome1 && outcome2 && !outcomeX && (canonical === 'tennis' || canonical === 'basketball')) {
          market1X2 = {
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

          if (!market1X2 && /^(rezultat|rezultat final|match result|1x2|final|castigator|castigator meci|winner|match winner)$/i.test(mbName)) {
            if (outcomes.length === 3 && o1 && oX && o2) {
              market1X2 = {
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
            } else if (outcomes.length === 2 && o1 && o2 && (canonical === 'tennis' || canonical === 'basketball')) {
              market1X2 = {
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
      if (!market1X2) continue;

      const eventKey = eventIdentityKey({
        kickoff: isoKickoff,
        homeTeam: cleanHome,
        awayTeam: cleanAway,
        sport: canonical,
      });

      // Deduplicate extra sub-window markets by key + period
      const dedupedSub = [];
      const seenKeys = new Set([`${market1X2.key}:${market1X2.period || 'fulltime'}`]);
      for (const sm of subMarkets) {
        const idKey = `${sm.key}:${sm.period || 'fulltime'}`;
        if (seenKeys.has(idKey)) continue;
        seenKeys.add(idKey);
        dedupedSub.push(sm);
      }

      const markets = [market1X2, ...dedupedSub];
      markMarketsLive(markets, () => isLive);

      out.push({
        id: String(eventId),
        sourceId: this.id,
        sourceUrl: this.sourceUrl || this.endpoint,
        sport: canonical,
        homeTeam: cleanHome,
        awayTeam: cleanAway,
        league: leagueName,
        kickoff: isoKickoff,
        live: isLive,
        eventKey,
        markets,
        ...(this.runId ? { runId: this.runId } : {}),
      });
    }

    return out;
  }
}

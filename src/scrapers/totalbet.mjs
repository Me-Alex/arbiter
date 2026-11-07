import ScraperBase from './base.mjs';
import { UpstreamError } from '../shared/errors.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { eventIdentityKey } from '../shared/text.mjs';
import { liveCoverageFor, markMarketsLive } from './live-status.mjs';
import { eventLimit } from './event-limit.mjs';

/**
 * TotalBet (totalbet) — Oddin Sports Distribution Platform (`oddin-platform`).
 *
 * Reverse-engineered via `morluto/rea` MCP browser analysis on `totalbet.ro/pariuri-sportive`
 * (evidence `ev_ebc5aa2f32c87a9d10091c70d41fa472d8da39c69adce4a85456a3b3e8e924fc`).
 *
 * Feed endpoint:
 *   `https://tbet-sofferapi.oddin-platform.com/sofferapi/api/offer/`
 *
 * Offer pagination:
 *   `getOfferPag/{pageNo}/{itemsPerPage}/{sportId}/{categoryId}/{tournamentId}/{startDate}/{endDate}`
 *
 * Single-event detail:
 *   `getFixturev2/{eventId}`
 */

const ODDIN_SPORTS = Object.freeze({
  football: { id: 1, name: 'Fotbal', display: 'Football' },
  basketball: { id: 2, name: 'Baschet', display: 'Basketball' },
  'ice-hockey': { id: 4, name: 'Hochei pe gheaţă', display: 'Ice Hockey' },
  tennis: { id: 5, name: 'Tenis', display: 'Tennis' },
  handball: { id: 6, name: 'Handbal', display: 'Handball' },
  'table-tennis': { id: 20, name: 'Tenis de Masa', display: 'Table Tennis' },
  volleyball: { id: 23, name: 'Volei', display: 'Volleyball' },
});

const DEFAULT_SPORTS = Object.freeze([
  'football',
  'basketball',
  'tennis',
  'ice-hockey',
  'handball',
  'volleyball',
  'table-tennis',
]);

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function isExhaustiveHalfLine(line) {
  return Number.isFinite(line) && Math.abs(line % 1) === 0.5;
}

function formatSignedLine(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function normalizeSportName(sport) {
  const s = String(sport || '').trim().toLowerCase();
  if (!s) return 'football';
  if (s === 'fotbal' || s === 'soccer') return 'football';
  if (s === 'baschet') return 'basketball';
  if (s === 'tenis') return 'tennis';
  if (s === 'hochei' || s === 'hochei pe gheaţă' || s === 'hockey' || s === 'ice hockey') return 'ice-hockey';
  if (s === 'handbal') return 'handball';
  if (s === 'volei') return 'volleyball';
  if (s === 'tenis de masa' || s === 'table tennis') return 'table-tennis';
  return ODDIN_SPORTS[s] ? s : 'football';
}

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

    this.apiBase = opts.apiBase || 'https://tbet-sofferapi.oddin-platform.com/sofferapi/api/offer';
    this.isCustomEndpoint = Boolean(opts.endpoint);
    this.endpoint = opts.endpoint || `${this.apiBase}/getOfferPag/1/200/1/0/0/0/0`;
    this.sourceUrl = opts.sourceUrl || this.endpoint;

    // Detail fixture fanout configuration
    this.detailLimit = opts.detailLimit !== undefined ? Number(opts.detailLimit) : (this.isCustomEndpoint ? 0 : 35);
    this.detailConcurrency = Math.max(1, Number(opts.detailConcurrency ?? 6));

    const requested = opts.sport
      ? [opts.sport]
      : (Array.isArray(opts.sports) && opts.sports.length > 0 ? opts.sports : DEFAULT_SPORTS);
    const resolved = requested.map(normalizeSportName).filter(Boolean);
    this.sports = resolved.length > 0 ? [...new Set(resolved)] : ['football'];
  }

  async _fetchJson(url, signal) {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;

    let res;
    try {
      res = await this.fetchImpl(url, {
        signal: bounded,
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new UpstreamError(`TotalBet: fetch failed (${err.message})`, { cause: err });
    }

    if (!res.ok) {
      throw new UpstreamError(`TotalBet: HTTP ${res.status}`, { status: res.status });
    }

    return readBoundedJson(res, { maxBytes: 15_000_000 });
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3_600_000;
    this.observedAt = new Date().toISOString();
    this.sourceUrl = this.endpoint;

    // Backward compatibility: if single endpoint passed (e.g. unit tests), fetch it directly.
    if (this.isCustomEndpoint || this.sports.length <= 1) {
      const sportKey = this.sports[0] || 'football';
      const sportId = ODDIN_SPORTS[sportKey]?.id ?? 1;
      const targetUrl = this.isCustomEndpoint ? this.endpoint : `${this.apiBase}/getOfferPag/1/200/${sportId}/0/0/0/0`;
      const data = await this._fetchJson(targetUrl, signal);

      // Optional fixture enrichment if detailLimit > 0
      if (this.detailLimit > 0 && Array.isArray(data)) {
        await this._enrichWithFixtureDetails(data, signal);
      }
      return data;
    }

    // Multi-sport mode
    const payloads = [];
    for (const sportKey of this.sports) {
      if (signal?.aborted) break;
      const sportId = ODDIN_SPORTS[sportKey]?.id;
      if (!sportId) continue;
      const url = `${this.apiBase}/getOfferPag/1/200/${sportId}/0/0/0/0`;
      try {
        const sportData = await this._fetchJson(url, signal);
        if (Array.isArray(sportData)) payloads.push(...sportData);
        else if (sportData) payloads.push(sportData);
      } catch {
        // Individual sport failure is non-fatal; continue collecting other sports
      }
    }

    if (this.detailLimit > 0) {
      await this._enrichWithFixtureDetails(payloads, signal);
    }

    return payloads;
  }

  async _enrichWithFixtureDetails(payloads, signal) {
    const rawEvents = this.normalize(payloads);
    const candidateEvents = rawEvents
      .filter((e) => e && (e.eventId || e.fixtureId))
      .slice(0, this.detailLimit);

    if (candidateEvents.length === 0) return;

    let index = 0;
    const worker = async () => {
      while (index < candidateEvents.length) {
        if (signal?.aborted) break;
        const ev = candidateEvents[index++];
        const id = ev.eventId || ev.fixtureId;
        const fixtureUrl = `${this.apiBase}/getFixturev2/${id}`;
        try {
          const detail = await this._fetchJson(fixtureUrl, signal);
          if (detail?.event?.markets) {
            ev.detailMarkets = detail.event.markets;
          }
        } catch {
          // Graceful fallback to list-level markets
        }
      }
    };

    const pool = [];
    for (let i = 0; i < Math.min(this.detailConcurrency, candidateEvents.length); i++) {
      pool.push(worker());
    }
    await Promise.all(pool);
  }

  normalize(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      const out = [];
      for (const item of raw) {
        if (!item) continue;
        if (item.leagues) {
          const sportName = item.sportName || item.displayName || 'Fotbal';
          for (const l of item.leagues || []) {
            for (const e of l.events || []) {
              out.push({ ...e, leagueName: l.leagueName, sportName });
            }
          }
        } else if (item.events) {
          for (const e of item.events) out.push(e);
        } else {
          out.push(item);
        }
      }
      return out;
    }
    if (raw?.leagues) {
      return raw.leagues.flatMap((l) => (l.events || []).map((e) => ({ ...e, leagueName: l.leagueName })));
    }
    return raw?.events || [];
  }

  _extractDetailMarkets(evId, detailMarkets, _canonicalSport) {
    const out = [];
    const seen = new Set();
    const allOutcomes = (detailMarkets || []).flatMap((m) => m?.outcomes || []);

    // 1. Draw No Bet (Market ID 11 "Winner (RF)")
    const dnbOutcomes = allOutcomes.filter((o) => o?.marketId === '11');
    if (dnbOutcomes.length >= 2) {
      const w1 = dnbOutcomes.find((o) => o.outcomeId === '4');
      const w2 = dnbOutcomes.find((o) => o.outcomeId === '5');
      const val1 = Number(w1?.outcomeOdd ?? w1?.value);
      const val2 = Number(w2?.outcomeOdd ?? w2?.value);
      if (Number.isFinite(val1) && val1 > 1 && Number.isFinite(val2) && val2 > 1) {
        seen.add('DRAW_NO_BET|fulltime');
        out.push({
          key: 'DRAW_NO_BET',
          name: 'Draw No Bet',
          period: 'fulltime',
          selections: [
            { id: `${evId}:dnb:1`, name: '1', odds: val1, handicap: null },
            { id: `${evId}:dnb:2`, name: '2', odds: val2, handicap: null },
          ],
        });
      }
    }

    // 2. Over/Under Goals (Market ID 18 "Total goluri")
    const ou18 = allOutcomes.filter((o) => o?.marketId === '18');
    const byLine18 = new Map();
    for (const o of ou18) {
      const match = String(o?.specifier || '').match(/total=([0-9.]+)/i);
      if (!match) continue;
      const line = Number(match[1]);
      if (!isExhaustiveHalfLine(line)) continue;
      if (!byLine18.has(line)) byLine18.set(line, {});
      const bag = byLine18.get(line);
      const odd = Number(o?.outcomeOdd ?? o?.value);
      if (!Number.isFinite(odd) || odd <= 1) continue;
      if (o.outcomeId === '12') bag.over = { id: `${evId}:ou:${line}:over`, odds: odd };
      else if (o.outcomeId === '13') bag.under = { id: `${evId}:ou:${line}:under`, odds: odd };
    }

    for (const [line, legs] of byLine18) {
      if (legs.over && legs.under) {
        seen.add(`OVER_UNDER|fulltime|goals|${line}`);
        out.push({
          key: 'OVER_UNDER',
          name: 'Total Goals',
          period: 'fulltime',
          subject: 'goals',
          line,
          selections: [
            { id: legs.over.id, name: `Over ${line}`, odds: legs.over.odds, handicap: line, line },
            { id: legs.under.id, name: `Under ${line}`, odds: legs.under.odds, handicap: line, line },
          ],
        });
      }
    }

    // 3. Over/Under First Half Goals (Market ID 68 "Total goluri prima repriza")
    const ou68 = allOutcomes.filter((o) => o?.marketId === '68');
    const byLine68 = new Map();
    for (const o of ou68) {
      const match = String(o?.specifier || '').match(/total=([0-9.]+)/i);
      if (!match) continue;
      const line = Number(match[1]);
      if (!isExhaustiveHalfLine(line)) continue;
      if (!byLine68.has(line)) byLine68.set(line, {});
      const bag = byLine68.get(line);
      const odd = Number(o?.outcomeOdd ?? o?.value);
      if (!Number.isFinite(odd) || odd <= 1) continue;
      if (o.outcomeId === '12') bag.over = { id: `${evId}:ou68:${line}:over`, odds: odd };
      else if (o.outcomeId === '13') bag.under = { id: `${evId}:ou68:${line}:under`, odds: odd };
    }

    for (const [line, legs] of byLine68) {
      if (legs.over && legs.under) {
        seen.add(`OVER_UNDER|half1|goals|${line}`);
        out.push({
          key: 'OVER_UNDER',
          name: '1st Half Total Goals',
          period: 'half1',
          subject: 'goals',
          line,
          selections: [
            { id: legs.over.id, name: `Over ${line}`, odds: legs.over.odds, handicap: line, line },
            { id: legs.under.id, name: `Under ${line}`, odds: legs.under.odds, handicap: line, line },
          ],
        });
      }
    }

    // 4. Corners Total (Market ID 166 "Cornere total")
    const cn166 = allOutcomes.filter((o) => o?.marketId === '166');
    const byLine166 = new Map();
    for (const o of cn166) {
      const match = String(o?.specifier || '').match(/total=([0-9.]+)/i);
      if (!match) continue;
      const line = Number(match[1]);
      if (!isExhaustiveHalfLine(line)) continue;
      if (!byLine166.has(line)) byLine166.set(line, {});
      const bag = byLine166.get(line);
      const odd = Number(o?.outcomeOdd ?? o?.value);
      if (!Number.isFinite(odd) || odd <= 1) continue;
      if (o.outcomeId === '12') bag.over = { id: `${evId}:cn:${line}:over`, odds: odd };
      else if (o.outcomeId === '13') bag.under = { id: `${evId}:cn:${line}:under`, odds: odd };
    }

    for (const [line, legs] of byLine166) {
      if (legs.over && legs.under) {
        seen.add(`CNOU|fulltime|corners|${line}`);
        out.push({
          key: 'CNOU',
          name: 'Corners Over/Under',
          period: 'fulltime',
          subject: 'corners',
          line,
          selections: [
            { id: legs.over.id, name: `Over ${line}`, odds: legs.over.odds, handicap: line, line },
            { id: legs.under.id, name: `Under ${line}`, odds: legs.under.odds, handicap: line, line },
          ],
        });
      }
    }

    // 5. Asian Handicap (Market ID 16 "Handicap asiatic")
    const ah16 = allOutcomes.filter((o) => o?.marketId === '16');
    const byHcp16 = new Map();
    for (const o of ah16) {
      const match = String(o?.specifier || '').match(/hcp=([+-]?[0-9.]+)/i);
      if (!match) continue;
      const hHome = Number(match[1]);
      if (!isExhaustiveHalfLine(hHome)) continue;
      if (!byHcp16.has(hHome)) byHcp16.set(hHome, {});
      const bag = byHcp16.get(hHome);
      const odd = Number(o?.outcomeOdd ?? o?.value);
      if (!Number.isFinite(odd) || odd <= 1) continue;
      if (o.outcomeId === '1714') bag.home = { id: `${evId}:ah:${hHome}:h`, odds: odd };
      else if (o.outcomeId === '1715') bag.away = { id: `${evId}:ah:${hHome}:a`, odds: odd };
    }

    for (const [hHome, legs] of byHcp16) {
      if (legs.home && legs.away) {
        const hAway = -hHome;
        seen.add(`ASIAN_HANDICAP|fulltime|${hHome}/${hAway}`);
        out.push({
          key: 'ASIAN_HANDICAP',
          name: 'Asian Handicap',
          period: 'fulltime',
          line: hHome,
          selections: [
            { id: legs.home.id, name: `1 (${formatSignedLine(hHome)})`, odds: legs.home.odds, handicap: hHome },
            { id: legs.away.id, name: `2 (${formatSignedLine(hAway)})`, odds: legs.away.odds, handicap: hAway },
          ],
        });
      }
    }

    // 6. First Half 1x2 (Market ID 60 "Prima repriza")
    const m60 = allOutcomes.filter((o) => o?.marketId === '60');
    if (m60.length >= 3) {
      const o1 = m60.find((o) => o.outcomeId === '1');
      const oX = m60.find((o) => o.outcomeId === '2');
      const o2 = m60.find((o) => o.outcomeId === '3');
      const val1 = Number(o1?.outcomeOdd ?? o1?.value);
      const valX = Number(oX?.outcomeOdd ?? oX?.value);
      const val2 = Number(o2?.outcomeOdd ?? o2?.value);
      if (Number.isFinite(val1) && val1 > 1 && Number.isFinite(valX) && valX > 1 && Number.isFinite(val2) && val2 > 1) {
        seen.add('MATCH_ODDS|half1|3way');
        out.push({
          key: 'MATCH_ODDS',
          name: '1st Half Result',
          period: 'half1',
          selections: [
            { id: `${evId}:60:1`, name: '1', odds: val1, handicap: null },
            { id: `${evId}:60:X`, name: 'X', odds: valX, handicap: null },
            { id: `${evId}:60:2`, name: '2', odds: val2, handicap: null },
          ],
        });
      }
    }

    return out;
  }

  extractEvents(rawEvents) {
    const events = [];
    const seen = new Set();
    const liveEvidence = liveCoverageFor('totalbet');
    const liveFlag = liveEvidence?.isLive ?? false;

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

      const windowEnd = this.to ?? (now + this.windowHours * 3_600_000);
      if (time > windowEnd) continue;

      const id = String(ev.eventId || ev.fixtureId || ev.eventNo || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const kickoff = new Date(time).toISOString();
      const canonicalSport = normalizeSportName(ev.sportName);
      const sportDisplay = ODDIN_SPORTS[canonicalSport]?.display || 'Football';
      const league = String(ev.leagueName || sportDisplay).trim();

      const markets = [];
      const evMarkets = Array.isArray(ev.markets) ? ev.markets : [];
      const evOutcomes = Array.isArray(ev.outcomes) ? ev.outcomes : [];

      // 1. 3-way Regulation Result (Market ID 1 "Final")
      const finalMkt = evMarkets.find((m) => m?.marketId === '1' || m?.marketName === 'Final');
      const m1Outcomes = finalMkt?.outcomes || evOutcomes.filter((o) => o?.marketName === 'Final' || o?.marketId === '1');
      if (m1Outcomes.length >= 3) {
        let odd1 = null, oddX = null, odd2 = null;
        for (const o of m1Outcomes) {
          const name = String(o.outcomeName || o.name || '').trim();
          const val = Number(o.value ?? o.odds ?? o.outcomeOdd);
          if (!Number.isFinite(val) || val <= 1) continue;
          if (name === '1') odd1 = val;
          else if (name === 'X' || name === 'x') oddX = val;
          else if (name === '2') odd2 = val;
        }
        if (odd1 && oddX && odd2) {
          markets.push({
            key: '1x2',
            name: '1X2',
            period: 'fulltime',
            selections: [
              { id: `${id}:1`, name: '1', odds: odd1, handicap: null },
              { id: `${id}:X`, name: 'X', odds: oddX, handicap: null },
              { id: `${id}:2`, name: '2', odds: odd2, handicap: null },
            ],
          });
        }
      }

      // 2. 2-way Match Odds (Tennis/Volleyball/Table Tennis: Market ID 186; Basketball: Market ID 219)
      const m186 = evMarkets.find((m) => m?.marketId === '186');
      if (m186?.outcomes?.length === 2) {
        const o1 = m186.outcomes.find((o) => o.outcomeName === '1');
        const o2 = m186.outcomes.find((o) => o.outcomeName === '2');
        const val1 = Number(o1?.value ?? o1?.outcomeOdd);
        const val2 = Number(o2?.value ?? o2?.outcomeOdd);
        if (Number.isFinite(val1) && val1 > 1 && Number.isFinite(val2) && val2 > 1) {
          markets.push({
            key: 'MATCH_ODDS',
            name: 'Match Winner',
            period: 'fulltime',
            selections: [
              { id: `${id}:186:1`, name: '1', odds: val1, handicap: null },
              { id: `${id}:186:2`, name: '2', odds: val2, handicap: null },
            ],
          });
        }
      }

      // Basketball Moneyline Incl. OT (Market ID 219 "Castigator Meci (OT)")
      const m219List = evMarkets.filter((m) => m?.marketId === '219');
      if (m219List.length > 0) {
        const oList = m219List.flatMap((m) => m?.outcomes || []);
        const o1 = oList.find((o) => o.outcomeName === 'CM1' || o.outcomeName === '1');
        const o2 = oList.find((o) => o.outcomeName === 'CM2' || o.outcomeName === '2');
        const val1 = Number(o1?.value ?? o1?.outcomeOdd);
        const val2 = Number(o2?.value ?? o2?.outcomeOdd);
        if (Number.isFinite(val1) && val1 > 1 && Number.isFinite(val2) && val2 > 1) {
          markets.push({
            key: 'MATCH_ODDS',
            name: 'Match Winner (Incl. OT)',
            period: 'fulltime_ot',
            selections: [
              { id: `${id}:219:1`, name: '1', odds: val1, handicap: null },
              { id: `${id}:219:2`, name: '2', odds: val2, handicap: null },
            ],
          });
        }
      }

      // 3. Double Chance (Market ID 10)
      const m10 = evMarkets.find((m) => m?.marketId === '10');
      if (m10?.outcomes?.length === 3) {
        const o1x = m10.outcomes.find((o) => o.outcomeName === '1X');
        const o12 = m10.outcomes.find((o) => o.outcomeName === '12');
        const ox2 = m10.outcomes.find((o) => o.outcomeName === 'X2');
        const v1x = Number(o1x?.value ?? o1x?.outcomeOdd);
        const v12 = Number(o12?.value ?? o12?.outcomeOdd);
        const vx2 = Number(ox2?.value ?? ox2?.outcomeOdd);
        if (Number.isFinite(v1x) && v1x > 1 && Number.isFinite(v12) && v12 > 1 && Number.isFinite(vx2) && vx2 > 1) {
          markets.push({
            key: 'DOUBLE_CHANCE',
            name: 'Double Chance',
            period: 'fulltime',
            selections: [
              { id: `${id}:10:1x`, name: '1X', odds: v1x, handicap: null },
              { id: `${id}:10:12`, name: '12', odds: v12, handicap: null },
              { id: `${id}:10:x2`, name: 'X2', odds: vx2, handicap: null },
            ],
          });
        }
      }

      // 4. Both Teams To Score (Market ID 29, split across GG and NG entries)
      const m29List = evMarkets.filter((m) => m?.marketId === '29');
      if (m29List.length > 0) {
        const o29 = m29List.flatMap((m) => m?.outcomes || []);
        const oGg = o29.find((o) => o.outcomeName === 'GG');
        const oNg = o29.find((o) => o.outcomeName === 'NG');
        const vGg = Number(oGg?.value ?? oGg?.outcomeOdd);
        const vNg = Number(oNg?.value ?? oNg?.outcomeOdd);
        if (Number.isFinite(vGg) && vGg > 1 && Number.isFinite(vNg) && vNg > 1) {
          markets.push({
            key: 'BTTS',
            name: 'Both Teams To Score',
            period: 'fulltime',
            selections: [
              { id: `${id}:29:gg`, name: 'Yes', odds: vGg, handicap: null },
              { id: `${id}:29:ng`, name: 'No', odds: vNg, handicap: null },
            ],
          });
        }
      }

      // 5. Fixture-level detail markets if enriched
      if (Array.isArray(ev.detailMarkets) && ev.detailMarkets.length > 0) {
        const enriched = this._extractDetailMarkets(id, ev.detailMarkets, canonicalSport);
        markets.push(...enriched);
      }

      // Require core match winner market (1x2 or MATCH_ODDS)
      const hasWinner = markets.some((m) => m.key === '1x2' || m.key === 'MATCH_ODDS');
      if (!hasWinner) continue;

      markMarketsLive(markets, () => liveFlag);

      events.push({
        id,
        sourceId: this.id,
        sourceUrl: this.sourceUrl,
        transport: this.transport,
        runId: this.runId,
        observedAt: this.observedAt ?? new Date().toISOString(),
        sport: sportDisplay,
        league,
        kickoff,
        homeTeam,
        awayTeam,
        live: liveFlag,
        eventKey: eventIdentityKey({ sport: sportDisplay, league, kickoff, homeTeam, awayTeam }),
        providerEventKey: `${id}|${kickoff}`,
        markets,
      });

      if (events.length >= this.maxEvents) break;
    }

    return events;
  }
}

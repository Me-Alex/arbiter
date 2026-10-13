import ScraperBase from './base.mjs';
import { ValidationError, UpstreamError, TimeoutError } from '../shared/errors.mjs';
import { eventLimit } from './event-limit.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { canonicalSport, eventIdentityKey, normalizeTeamName } from '../shared/text.mjs';

const LVBET_API_BASE = 'https://offer.lvbet.pl/client-api/v5';

export const LVBET_SPORT_MAP = Object.freeze({
  1: 'football',
  3: 'basketball',
  4: 'tennis',
  2: 'ice-hockey',
  29: 'handball',
  5: 'volleyball',
  40: 'table-tennis',
  6: 'american-football',
  11: 'baseball',
  22: 'darts',
  38: 'snooker',
  17: 'boxing',
  19: 'cricket',
  36: 'rugby-union',
  26: 'futsal',
  9: 'badminton',
  51: 'counter-strike-2',
  40253: 'dota-2',
  53: 'league-of-legends',
});

export const LVBET_SPORT_NAME_TO_ID = Object.freeze({
  football: 1,
  soccer: 1,
  basketball: 3,
  tennis: 4,
  'ice-hockey': 2,
  ice_hockey: 2,
  handball: 29,
  volleyball: 5,
  'table-tennis': 40,
  'american-football': 6,
  baseball: 11,
  darts: 22,
  snooker: 38,
  boxing: 17,
  cricket: 19,
  'rugby-union': 36,
  futsal: 26,
  badminton: 9,
});

/**
 * LV BET (lvbet) scraper.
 *
 * Platform: LV BET European Sportsbook (lvbet.pl / lvbet.com).
 * REST API: /client-api/v5/matches/competition-view/ returns prematch & live events
 * with structured primary column markets (1X2 Match Result, Total Goals, BTTS, Asian Handicap, Double Chance).
 */
export default class Lvbet extends ScraperBase {
  timeoutMs = 25_000;

  constructor(opts = {}) {
    super(opts);
    this.id = 'lvbet';
    this.name = 'LV BET';
    this.sourceIds = ['lvbet'];
    this.engine = 'custom-json';
    this.transport = 'custom-json';
    this.endpoint = opts.endpoint || `${LVBET_API_BASE}/matches/competition-view/?sports_groups_ids=1&lang=en`;
    this.sourceUrl = this.endpoint;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxEvents = eventLimit(opts.maxEvents ?? opts.jobConfig?.maxEvents ?? 500);
    this.sport = opts.sport || 'football';
    this.sportFilter = opts.sport === 'all' ? null : canonicalSport(opts.sport || 'football');
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.windowHours = Number(opts.windowHours ?? 168);
    this.timeoutMs = Number(opts.timeoutMs ?? 25_000);
    this.runId = opts.runId || null;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    this.observedAt = new Date().toISOString();

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;

    const sportsToFetch = this.sport === 'all'
      ? [1, 3, 4, 2] // Football, Basketball, Tennis, Ice Hockey
      : [LVBET_SPORT_NAME_TO_ID[this.sportFilter] || 1];

    const aggregated = {
      matches: [],
      primary_column_markets: [],
    };

    for (const sportId of sportsToFetch) {
      bounded.throwIfAborted();
      const url = `${LVBET_API_BASE}/matches/competition-view/?sports_groups_ids=${sportId}&lang=en`;
      this.sourceUrl = url;

      let res;
      try {
        res = await this.fetchImpl(url, {
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
          throw new TimeoutError(`lvbet: fetch timed out after ${this.timeoutMs}ms`);
        }
        throw new UpstreamError(`lvbet: network request failed: ${err.message}`, { cause: err });
      }

      if (!res.ok) {
        await res.body?.cancel();
        throw new UpstreamError(`lvbet: HTTP ${res.status}`, { status: res.status });
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        await res.body?.cancel();
        throw new ValidationError(`lvbet: expected JSON response, got ${contentType}`);
      }

      const raw = await readBoundedJson(res, this.id, bounded, 20_000_000);
      if (Array.isArray(raw?.matches)) {
        aggregated.matches.push(...raw.matches);
      }
      if (Array.isArray(raw?.primary_column_markets)) {
        aggregated.primary_column_markets.push(...raw.primary_column_markets);
      }
    }

    return aggregated;
  }

  normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ValidationError('lvbet: invalid raw payload');
    }

    const payload = raw.raw || raw.data || raw;

    if (!Array.isArray(payload.matches)) {
      throw new ValidationError('lvbet: missing or invalid matches array in payload');
    }

    const rawMarkets = Array.isArray(payload.primary_column_markets) ? payload.primary_column_markets : [];
    const marketsByMatch = new Map();
    for (const m of rawMarkets) {
      if (!m?.match_id) continue;
      if (!marketsByMatch.has(m.match_id)) marketsByMatch.set(m.match_id, []);
      marketsByMatch.get(m.match_id).push(m);
    }

    const items = [];
    for (const match of payload.matches) {
      if (!match || typeof match !== 'object') continue;
      const matchId = match.match_id || match.id;
      if (!matchId) continue;

      items.push({
        ...match,
        match_id: matchId,
        markets: marketsByMatch.get(matchId) || match.markets || [],
      });
    }

    return items;
  }

  extractEvents(normalized) {
    let items = normalized;
    if (items && !Array.isArray(items) && typeof items === 'object') {
      items = this.normalize(items);
    }
    if (!Array.isArray(items)) {
      throw new ValidationError('lvbet: extractEvents expected normalized items array');
    }

    const seen = new Set();
    const events = [];
    const now = this.from ?? Date.now();
    const windowEnd = this.to ?? (now + this.windowHours * 3600000);

    for (const item of items) {
      const matchId = String(item.match_id || '').trim();
      if (!matchId || seen.has(matchId)) continue;
      seen.add(matchId);

      // Raw date parsing
      const rawDate = item.date;
      if (!rawDate) continue;
      const parsedTime = Date.parse(rawDate);
      if (!Number.isFinite(parsedTime) || parsedTime <= 0) continue;

      const isLive = Boolean(item.state?.is_live);
      if (isLive && !this.includeLive) continue;

      const isPast = parsedTime < now;
      if (isPast && !this.includePast && !isLive) continue;
      if (parsedTime > windowEnd && !isLive) continue;

      const kickoff = new Date(parsedTime).toISOString();

      // Participants
      const homeRaw = Array.isArray(item.home) ? item.home[0] : item.home;
      const awayRaw = Array.isArray(item.away) ? item.away[0] : item.away;
      if (!homeRaw || !awayRaw) continue;

      let homeTeam = String(homeRaw).trim();
      let awayTeam = String(awayRaw).trim();
      if (!homeTeam || !awayTeam) continue;

      if (item.teams_reversed) {
        const tmp = homeTeam;
        homeTeam = awayTeam;
        awayTeam = tmp;
      }

      // Sport mapping
      const sportGroupId = item.sports_groups_ids?.[0];
      const sport = canonicalSport(LVBET_SPORT_MAP[sportGroupId] || item.sport || 'football');

      if (this.sportFilter && sport !== this.sportFilter) {
        continue;
      }

      const eventKey = eventIdentityKey({ sport, kickoff, homeTeam, awayTeam });
      const league = String(item.sports_groups_ids?.[2] || item.league_name || sport).trim();

      const markets = [];
      const itemMarkets = Array.isArray(item.markets) ? item.markets : [];

      for (const m of itemMarkets) {
        if (!m || !Array.isArray(m.selections) || m.selections.length === 0) continue;

        const classId = Number(m.markets_class_id);
        const name = String(m.name || m.label || '').trim();
        const label = String(m.label || m.name || '').trim();

        // 1. MATCH_ODDS / 1X2 / Match Winner (class 2669, 4162, 7113 or name matches)
        if (
          classId === 2669 ||
          classId === 4162 ||
          classId === 7113 ||
          /match (?:result|winner)|1x2|zwyci[eę]zca meczu|money line/i.test(name) ||
          /match (?:result|winner)|money line/i.test(label)
        ) {
          const validSels = m.selections.filter((s) => Number(s.rate?.decimal) > 1);
          if (validSels.length >= 3) {
            // 3-way result
            const s1 = validSels.find((s) => s.order === 0 || normalizeTeamName(s.name) === normalizeTeamName(homeTeam)) || validSels[0];
            const sX = validSels.find((s) => s.order === 1 || /draw|remis|x|tie/i.test(s.name) || /draw/i.test(s.label)) || validSels[1];
            const s2 = validSels.find((s) => s.order === 2 || normalizeTeamName(s.name) === normalizeTeamName(awayTeam)) || validSels[2];

            if (s1 && sX && s2 && s1 !== sX && sX !== s2 && s1 !== s2) {
              const p1 = Number(s1.rate.decimal);
              const pX = Number(sX.rate.decimal);
              const p2 = Number(s2.rate.decimal);
              markets.push({
                key: 'MATCH_ODDS',
                name: 'Match Odds',
                period: 'fulltime',
                live: isLive,
                selections: [
                  { id: `${matchId}:1`, name: '1', price: p1, odds: p1 },
                  { id: `${matchId}:X`, name: 'X', price: pX, odds: pX },
                  { id: `${matchId}:2`, name: '2', price: p2, odds: p2 },
                ],
              });
            }
          } else if (validSels.length === 2) {
            // 2-way moneyline (e.g. basketball, tennis)
            const s1 = validSels.find((s) => s.order === 0 || normalizeTeamName(s.name) === normalizeTeamName(homeTeam)) || validSels[0];
            const s2 = validSels.find((s) => s.order === 1 || normalizeTeamName(s.name) === normalizeTeamName(awayTeam)) || validSels[1];
            if (s1 && s2 && s1 !== s2) {
              const p1 = Number(s1.rate.decimal);
              const p2 = Number(s2.rate.decimal);
              markets.push({
                key: 'MATCH_ODDS',
                name: 'Match Odds',
                period: 'fulltime',
                live: isLive,
                selections: [
                  { id: `${matchId}:1`, name: '1', price: p1, odds: p1 },
                  { id: `${matchId}:2`, name: '2', price: p2, odds: p2 },
                ],
              });
            }
          }
        }

        // 2. Both Teams To Score (BTTS) (class 3151)
        if (classId === 3151 || /both teams to score|obie dru[zż]yny strzel/i.test(name) || /both teams to score/i.test(label)) {
          const yesSel = m.selections.find((s) => /^(?:yes|tak)$/i.test(String(s.name || s.label || '').trim()));
          const noSel = m.selections.find((s) => /^(?:no|nie)$/i.test(String(s.name || s.label || '').trim()));

          if (yesSel && noSel) {
            const pYes = Number(yesSel.rate?.decimal);
            const pNo = Number(noSel.rate?.decimal);
            if (pYes > 1 && pNo > 1) {
              markets.push({
                key: 'BTTS',
                name: 'Both Teams to Score',
                period: 'fulltime',
                live: isLive,
                selections: [
                  { id: `${matchId}:btts:yes`, name: 'Yes', price: pYes, odds: pYes },
                  { id: `${matchId}:btts:no`, name: 'No', price: pNo, odds: pNo },
                ],
              });
            }
          }
        }

        // 3. Over / Under (Total Goals / Points) (class 3499)
        if (classId === 3499 || /total goals|total points|liczba goli/i.test(name) || /total goals|total points/i.test(label)) {
          const overSel = m.selections.find((s) => /^(?:over|powy[zż]ej)/i.test(String(s.name || s.label || '').trim()));
          const underSel = m.selections.find((s) => /^(?:under|poni[zż]ej)/i.test(String(s.name || s.label || '').trim()));

          let line = Number(m.line);
          if (!Number.isFinite(line) || line <= 0) {
            const mOver = String(overSel?.name || '').match(/\(([0-9.]+)\)/);
            if (mOver) line = Number(mOver[1]);
          }

          if (overSel && underSel && Number.isFinite(line) && line > 0) {
            const pOver = Number(overSel.rate?.decimal);
            const pUnder = Number(underSel.rate?.decimal);
            if (pOver > 1 && pUnder > 1) {
              markets.push({
                key: 'OVER_UNDER',
                name: `Total Over/Under ${line}`,
                period: 'fulltime',
                line,
                live: isLive,
                selections: [
                  { id: `${matchId}:ou:${line}:over`, name: 'Over', price: pOver, odds: pOver, line },
                  { id: `${matchId}:ou:${line}:under`, name: 'Under', price: pUnder, odds: pUnder, line },
                ],
              });
            }
          }
        }

        // 4. Double Chance (class 2551)
        if (classId === 2551 || /double chance|podw[oó]jna szansa/i.test(name) || /double chance/i.test(label)) {
          if (m.selections.length === 3) {
            const sels = m.selections.map((s, idx) => ({
              id: `${matchId}:dc:${idx}`,
              name: s.name || s.label,
              price: Number(s.rate?.decimal),
              odds: Number(s.rate?.decimal),
            })).filter((s) => s.price > 1);

            if (sels.length === 3) {
              markets.push({
                key: 'DOUBLE_CHANCE',
                name: 'Double Chance',
                period: 'fulltime',
                live: isLive,
                selections: sels,
              });
            }
          }
        }

        // 5. Asian Handicap (class 5747)
        if (classId === 5747 || /asian handicap/i.test(name) || /asian handicap/i.test(label)) {
          if (m.selections.length === 2) {
            const s1 = m.selections[0];
            const s2 = m.selections[1];
            const p1 = Number(s1.rate?.decimal);
            const p2 = Number(s2.rate?.decimal);
            if (p1 > 1 && p2 > 1) {
              const line = Number(m.line ?? 0);
              markets.push({
                key: 'ASIAN_HANDICAP',
                name: `Asian Handicap ${line}`,
                period: 'fulltime',
                line,
                live: isLive,
                selections: [
                  { id: `${matchId}:ah:${line}:1`, name: s1.name, price: p1, odds: p1, line },
                  { id: `${matchId}:ah:${line}:2`, name: s2.name, price: p2, odds: p2, line },
                ],
              });
            }
          }
        }
      }

      events.push({
        eventKey,
        eventId: matchId,
        sourceId: this.id,
        sport,
        league,
        kickoff,
        homeTeam,
        awayTeam,
        isLive,
        markets,
      });

      if (events.length >= this.maxEvents) {
        break;
      }
    }

    return events;
  }
}

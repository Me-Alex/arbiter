import ScraperBase from './base.mjs';
import { ValidationError, UpstreamError, TimeoutError } from '../shared/errors.mjs';
import { eventLimit } from './event-limit.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { canonicalSport, eventIdentityKey, normalizeTeamName } from '../shared/text.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

const BETFAN_API_BASE = 'https://betfan.pl/api/v2';

export const BETFAN_SPORT_MAP = Object.freeze({
  1: 'football',
  2: 'basketball',
  5: 'tennis',
  4: 'ice-hockey',
  6: 'handball',
  10: 'volleyball',
  20: 'table-tennis',
  16: 'american-football',
  3: 'baseball',
  40: 'boxing',
  41: 'mma',
  22: 'darts',
  19: 'snooker',
  31: 'badminton',
  12: 'rugby',
  70: 'counter-strike-2',
  71: 'league-of-legends',
  72: 'dota-2',
});

/**
 * BETFAN (betfan) scraper.
 *
 * Platform: BETFAN Polish & European licensed sportsbook (betfan.pl).
 * REST API: /api/v2/event/all returns prematch & live events with embedded games
 * (1X2 Match Result, Total Goals / Points / Games, BTTS, Double Chance, Asian Handicap).
 */
export default class Betfan extends ScraperBase {
  timeoutMs = 25_000;

  constructor(opts = {}) {
    super(opts);
    this.id = 'betfan';
    this.name = 'BETFAN';
    this.sourceIds = ['betfan'];
    this.engine = 'custom-json';
    this.transport = 'custom-json';
    this.endpoint = opts.endpoint || `${BETFAN_API_BASE}/event/all`;
    this.sourceUrl = this.endpoint;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxEvents = eventLimit(opts.maxEvents ?? opts.jobConfig?.maxEvents ?? 500);
    this.sportSet = !opts.sport && Array.isArray(opts.sports) && opts.sports.length > 0
      ? new Set(opts.sports.map((s) => canonicalSport(s)))
      : null;
    this.sport = opts.sport || (this.sportSet ? 'all' : 'football');
    this.sportFilter = this.sport === 'all' ? null : canonicalSport(this.sport);
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

    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
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
        throw new TimeoutError(`betfan: fetch timed out after ${this.timeoutMs}ms`);
      }
      throw new UpstreamError(`betfan: network request failed: ${err.message}`, { cause: err });
    }

    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamError(`betfan: HTTP ${res.status}`, { status: res.status });
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      await res.body?.cancel();
      throw new ValidationError(`betfan: expected JSON response, got ${contentType}`);
    }

    return await readBoundedJson(res, this.id, bounded, 25_000_000);
  }

  normalize(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new ValidationError('betfan: invalid raw payload');
    }

    const payload = raw.raw || raw.data || raw;

    if (!Array.isArray(payload.events)) {
      throw new ValidationError('betfan: missing or invalid events array in payload');
    }

    return payload.events.filter((e) => e && typeof e === 'object' && e.id);
  }

  extractEvents(normalized) {
    let items = normalized;
    if (items && !Array.isArray(items) && typeof items === 'object') {
      items = this.normalize(items);
    }
    if (!Array.isArray(items)) {
      throw new ValidationError('betfan: extractEvents expected normalized events array');
    }

    const seen = new Set();
    const events = [];
    const now = this.from ?? Date.now();
    const windowEnd = this.to ?? (now + this.windowHours * 3600000);

    for (const item of items) {
      const matchId = String(item.id || '').trim();
      if (!matchId || seen.has(matchId)) continue;
      seen.add(matchId);

      // Raw date parsing from start (epoch ms)
      const rawStart = item.start;
      if (!rawStart) continue;
      const parsedTime = typeof rawStart === 'number' ? rawStart : Date.parse(rawStart);
      if (!Number.isFinite(parsedTime) || parsedTime <= 0) continue;

      // Event type: 1 is prematch, 2 is live
      const isLive = item.type === 2;
      if (isLive && !this.includeLive) continue;

      const isPast = parsedTime < now;
      if (isPast && !this.includePast && !isLive) continue;
      if (parsedTime > windowEnd && !isLive) continue;

      const kickoff = new Date(parsedTime).toISOString();

      // Participants
      let homeTeam = '';
      let awayTeam = '';

      if (Array.isArray(item.participants) && item.participants.length >= 2) {
        homeTeam = String(item.participants[0]?.name || '').trim();
        awayTeam = String(item.participants[1]?.name || '').trim();
      }

      if (!homeTeam || !awayTeam) {
        const cleanName = String(item.name || '').replace(/\s*\(live\)$/i, '').trim();
        const parts = cleanName.split(/\s+-\s+|\s+vs\.?\s+/i);
        if (parts.length === 2) {
          homeTeam = parts[0].trim();
          awayTeam = parts[1].trim();
        }
      }

      if (!homeTeam || !awayTeam) continue;

      // Sport mapping
      const sportId = item.category1Id;
      const sport = canonicalSport(BETFAN_SPORT_MAP[sportId] || item.category1Name || 'football');

      if (this.sportSet ? !this.sportSet.has(sport) : (this.sportFilter && sport !== this.sportFilter)) {
        continue;
      }

      const eventKey = eventIdentityKey({ sport, kickoff, homeTeam, awayTeam });
      const league = String(item.category3Name || item.category2Name || sport).trim();

      const markets = [];
      const itemGames = Array.isArray(item.games) ? item.games : [];

      for (const g of itemGames) {
        if (!g || !Array.isArray(g.outcomes) || g.outcomes.length === 0) continue;

        const gType = Number(g.type);
        const name = String(g.name || '').trim();

        // 1. MATCH_ODDS / 1X2 / Match Winner (type 1, 201, 18002, 202, 190, or name matches)
        if (
          gType === 1 ||
          gType === 201 ||
          gType === 18002 ||
          gType === 202 ||
          gType === 190 ||
          /^(?:mecz|1x2|zwyci[eę]zca(?: meczu)?|zwyci[eę]zca \(z dogrywk[aą]\))$/i.test(name)
        ) {
          if (g.outcomes.length >= 3) {
            // 3-way result
            const s1 = g.outcomes.find((o) => normalizeTeamName(o.name) === normalizeTeamName(homeTeam) || o.name === '1') || g.outcomes[0];
            const sX = g.outcomes.find((o) => /^(?:x|remis|draw|tie)$/i.test(String(o.name || '').trim())) || g.outcomes[1];
            const s2 = g.outcomes.find((o) => normalizeTeamName(o.name) === normalizeTeamName(awayTeam) || o.name === '2') || g.outcomes[2];

            if (s1 && sX && s2 && s1 !== sX && sX !== s2 && s1 !== s2) {
              const p1 = Number(s1.odds);
              const pX = Number(sX.odds);
              const p2 = Number(s2.odds);
              if (p1 > 1 && pX > 1 && p2 > 1) {
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
            }
          } else if (g.outcomes.length === 2) {
            // 2-way moneyline
            const s1 = g.outcomes.find((o) => normalizeTeamName(o.name) === normalizeTeamName(homeTeam) || o.name === '1') || g.outcomes[0];
            const s2 = g.outcomes.find((o) => normalizeTeamName(o.name) === normalizeTeamName(awayTeam) || o.name === '2') || g.outcomes[1];
            if (s1 && s2 && s1 !== s2) {
              const p1 = Number(s1.odds);
              const p2 = Number(s2.odds);
              if (p1 > 1 && p2 > 1) {
                const isOtWinner = !/\bbez\s+dogrywki\b/i.test(name)
                  && (/\b(?:wraz\s+z|z)\s+dogrywk[aą]/i.test(name) || gType === 202 || gType === 2563);
                const moPeriod = isOtWinner ? 'fulltime_ot' : (extractPeriodFromName(name) || 'fulltime');
                markets.push({
                  key: 'MATCH_ODDS',
                  name: isOtWinner ? 'Match Odds (z dogrywką)' : (moPeriod !== 'fulltime' ? (name || 'Match Odds') : 'Match Odds'),
                  period: moPeriod,
                  live: isLive,
                  selections: [
                    { id: `${matchId}:1`, name: '1', price: p1, odds: p1 },
                    { id: `${matchId}:2`, name: '2', price: p2, odds: p2 },
                  ],
                });
              }
            }
          }
        }

        // 2. Both Teams To Score (BTTS) (type 98, 245, 18113 or name matches)
        if (gType === 98 || gType === 245 || gType === 18113 || /^obie dru[zż]yny strzel/i.test(name)) {
          const yesSel = g.outcomes.find((o) => /^(?:tak|yes)$/i.test(String(o.name || '').trim()));
          const noSel = g.outcomes.find((o) => /^(?:nie|no)$/i.test(String(o.name || '').trim()));

          if (yesSel && noSel) {
            const pYes = Number(yesSel.odds);
            const pNo = Number(noSel.odds);
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

        // 3. Over / Under (Total Goals / Points / Games)
        if (
          gType === 8 ||
          gType === 203 ||
          gType === 257 ||
          gType === 18004 ||
          gType === 18108 ||
          gType === 18109 ||
          gType === 18110 ||
          /^liczba (?:goli|punkt[oó]w|gem[oó]w)/i.test(name)
        ) {
          const overSel = g.outcomes.find((o) => /^(?:powy[zż]ej|over)/i.test(String(o.name || '').trim()));
          const underSel = g.outcomes.find((o) => /^(?:poni[zż]ej|under)/i.test(String(o.name || '').trim()));

          let line = null;
          const mLineInName = name.match(/([0-9.]+)/);
          if (mLineInName) line = Number(mLineInName[1]);

          if (!Number.isFinite(line) || line <= 0) {
            const mOver = String(overSel?.name || '').match(/([0-9.]+)/);
            if (mOver) line = Number(mOver[1]);
          }

          if (overSel && underSel && Number.isFinite(line) && line > 0) {
            const pOver = Number(overSel.odds);
            const pUnder = Number(underSel.odds);
            if (pOver > 1 && pUnder > 1) {
              const isOtTotal = !/\bbez\s+dogrywki\b/i.test(name) && /\b(?:wraz\s+z|z)\s+dogrywk[aą]/i.test(name);
              const ouPeriod = isOtTotal ? 'fulltime_ot' : (extractPeriodFromName(name) || 'fulltime');
              const baseDisplayName = (gType === 203 || gType === 18004 || /punkt/i.test(name))
                ? `Total Points Over/Under ${line}`
                : ((gType === 257 || /gem/i.test(name)) ? `Total Games Over/Under ${line}` : `Total Over/Under ${line}`);
              const displayName = isOtTotal ? `${baseDisplayName} (z dogrywką)` : (ouPeriod !== 'fulltime' ? (name || baseDisplayName) : baseDisplayName);
              markets.push({
                key: 'OVER_UNDER',
                name: displayName,
                period: ouPeriod,
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

        // 3b. 1st / 2nd Half 1X2 (type 3, 111)
        if (gType === 3 || gType === 111 || /^[12]\.\s*po[łl]owa\s*-\s*(?:wynik|1x2)$/i.test(name)) {
          if (g.outcomes.length >= 3) {
            const halfPeriod = gType === 111 || /^2\./.test(name) ? 'half2' : 'half1';
            const halfKey = halfPeriod === 'half2' ? 'MRH2' : 'MRH1';
            const s1 = g.outcomes.find((o) => normalizeTeamName(o.name) === normalizeTeamName(homeTeam) || o.name === '1') || g.outcomes[0];
            const sX = g.outcomes.find((o) => /^(?:x|remis|draw|tie)$/i.test(String(o.name || '').trim())) || g.outcomes[1];
            const s2 = g.outcomes.find((o) => normalizeTeamName(o.name) === normalizeTeamName(awayTeam) || o.name === '2') || g.outcomes[2];
            if (s1 && sX && s2 && s1 !== sX && sX !== s2 && s1 !== s2) {
              const p1 = Number(s1.odds);
              const pX = Number(sX.odds);
              const p2 = Number(s2.odds);
              if (p1 > 1 && pX > 1 && p2 > 1) {
                markets.push({
                  key: halfKey,
                  name: halfPeriod === 'half2' ? '2nd Half Result' : '1st Half Result',
                  period: halfPeriod,
                  live: isLive,
                  selections: [
                    { id: `${matchId}:${halfKey}:1`, name: 'Home', price: p1, odds: p1 },
                    { id: `${matchId}:${halfKey}:X`, name: 'Draw', price: pX, odds: pX },
                    { id: `${matchId}:${halfKey}:2`, name: 'Away', price: p2, odds: p2 },
                  ],
                });
              }
            }
          }
        }

        // 3c. 1st / 2nd Half BTTS (type 120, 121)
        if (gType === 120 || gType === 121 || /^[12]\.\s*po[łl]owa\s*-\s*obie dru[zż]yny strzel/i.test(name)) {
          const halfPeriod = gType === 121 || /^2\./.test(name) ? 'half2' : 'half1';
          const halfKey = halfPeriod === 'half2' ? 'BTH2' : 'BTH1';
          const yesSel = g.outcomes.find((o) => /^(?:tak|yes)$/i.test(String(o.name || '').trim()));
          const noSel = g.outcomes.find((o) => /^(?:nie|no)$/i.test(String(o.name || '').trim()));
          if (yesSel && noSel) {
            const pYes = Number(yesSel.odds);
            const pNo = Number(noSel.odds);
            if (pYes > 1 && pNo > 1) {
              markets.push({
                key: halfKey,
                name: halfPeriod === 'half2' ? '2nd Half Both Teams to Score' : '1st Half Both Teams to Score',
                period: halfPeriod,
                live: isLive,
                selections: [
                  { id: `${matchId}:${halfKey}:yes`, name: 'Yes', price: pYes, odds: pYes },
                  { id: `${matchId}:${halfKey}:no`, name: 'No', price: pNo, odds: pNo },
                ],
              });
            }
          }
        }

        // 3d. Draw No Bet (type 93 or Remis = zwrot)
        if (gType === 93 || /^(?:remis\s*=\s*zwrot|zak[łl]ad bez remisu)$/i.test(name)) {
          if (g.outcomes.length === 2) {
            const s1 = g.outcomes.find((o) => normalizeTeamName(o.name) === normalizeTeamName(homeTeam) || o.name === '1') || g.outcomes[0];
            const s2 = g.outcomes.find((o) => normalizeTeamName(o.name) === normalizeTeamName(awayTeam) || o.name === '2') || g.outcomes[1];
            const p1 = Number(s1?.odds);
            const p2 = Number(s2?.odds);
            if (s1 && s2 && s1 !== s2 && p1 > 1 && p2 > 1) {
              markets.push({
                key: 'DRAW_NO_BET',
                name: 'Draw No Bet',
                period: 'fulltime',
                live: isLive,
                selections: [
                  { id: `${matchId}:dnb:1`, name: '1', price: p1, odds: p1 },
                  { id: `${matchId}:dnb:2`, name: '2', price: p2, odds: p2 },
                ],
              });
            }
          }
        }

        // 3e. 1st Half & Team Totals (type -284, 52, 53)
        if (gType === -284 || gType === 52 || gType === 53) {
          const overSel = g.outcomes.find((o) => /^(?:powy[zż]ej|over)/i.test(String(o.name || '').trim()));
          const underSel = g.outcomes.find((o) => /^(?:poni[zż]ej|under)/i.test(String(o.name || '').trim()));
          const mLine = (name.match(/([0-9]+(?:\.[0-9]+)?)/) || String(overSel?.name || '').match(/([0-9]+(?:\.[0-9]+)?)/));
          const line = mLine ? Number(mLine[1]) : NaN;
          if (overSel && underSel && Number.isFinite(line) && line > 0) {
            const pOver = Number(overSel.odds);
            const pUnder = Number(underSel.odds);
            if (pOver > 1 && pUnder > 1) {
              const ouPeriod = gType === -284 ? 'half1' : 'fulltime';
              const ouTeam = gType === 52 ? 'home' : (gType === 53 ? 'away' : null);
              markets.push({
                key: `OVER_UNDER:${ouPeriod}:${ouTeam || 'match'}:${line}`,
                name: name || `Total Over/Under ${line}`,
                period: ouPeriod,
                ...(ouTeam ? { team: ouTeam } : {}),
                line,
                live: isLive,
                selections: [
                  { id: `${matchId}:ou:${ouPeriod}:${ouTeam || 'match'}:${line}:over`, name: `Over ${line}`, price: pOver, odds: pOver, line, handicap: line },
                  { id: `${matchId}:ou:${ouPeriod}:${ouTeam || 'match'}:${line}:under`, name: `Under ${line}`, price: pUnder, odds: pUnder, line, handicap: line },
                ],
              });
            }
          }
        }

        // 4. Double Chance (type 4, 247, 18103, 27 [1H], -188 [2H] or name matches)
        if (gType === 4 || gType === 247 || gType === 18103 || gType === 27 || gType === -188 || /^(?:[12]\.\s*po[łl]owa\s*-\s*)?podw[oó]jna szansa$/i.test(name)) {
          if (g.outcomes.length === 3) {
            const dcPeriod = (gType === 27 || /^1\./.test(name)) ? 'half1' : ((gType === -188 || /^2\./.test(name)) ? 'half2' : 'fulltime');
            const dcKey = dcPeriod === 'half1' ? 'DCH1' : (dcPeriod === 'half2' ? 'DCH2' : 'DOUBLE_CHANCE');
            const normDc = (raw, idx) => {
              const s = String(raw || '').trim();
              if (/^(?:1x|1\/x)$/i.test(s)) return '1X';
              if (/^(?:12|1\/2)$/i.test(s)) return '12';
              if (/^(?:x2|x\/2)$/i.test(s)) return 'X2';
              if (/\/x$/i.test(s) || idx === 0) return '1X';
              if (/^x\//i.test(s) || idx === 2) return 'X2';
              if (idx === 1) return '12';
              return s;
            };
            const sels = g.outcomes.map((o, idx) => ({
              id: `${matchId}:${dcKey}:${idx}`,
              name: normDc(o.name, idx),
              price: Number(o.odds),
              odds: Number(o.odds),
            })).filter((s) => s.price > 1);

            if (sels.length === 3) {
              markets.push({
                key: dcKey,
                name: dcPeriod === 'fulltime' ? 'Double Chance' : `${dcPeriod === 'half1' ? '1st Half' : '2nd Half'} Double Chance`,
                period: dcPeriod,
                live: isLive,
                selections: sels,
              });
            }
          }
        }

        // 5. Asian Handicap
        if (gType === -458 || /^handicap(?:\s*\(?([-+0-9.\s/]+)\)?)?$/i.test(name)) {
          if (g.outcomes.length === 2) {
            const s1 = g.outcomes[0];
            const s2 = g.outcomes[1];
            const p1 = Number(s1.odds);
            const p2 = Number(s2.odds);
            if (p1 > 1 && p2 > 1) {
              const mHandicap = String(s1.name || name).match(/([-+][0-9]+(?:\.[0-9]+)?)/) || name.match(/([-+0-9.]+)/);
              const line = mHandicap ? Number(mHandicap[1]) : 0;
              markets.push({
                key: 'ASIAN_HANDICAP',
                name: `Asian Handicap ${line}`,
                period: 'fulltime',
                line,
                live: isLive,
                selections: [
                  { id: `${matchId}:ah:${line}:1`, name: s1.name, price: p1, odds: p1, line, ...(line !== 0 ? { handicap: line } : {}) },
                  { id: `${matchId}:ah:${line}:2`, name: s2.name, price: p2, odds: p2, line, ...(line !== 0 ? { handicap: -line } : {}) },
                ],
              });
            }
          }
        }
      }

      events.push({
        id: matchId,
        eventKey,
        eventId: matchId,
        sourceId: this.id,
        sport,
        league,
        kickoff,
        homeTeam,
        awayTeam,
        live: isLive,
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

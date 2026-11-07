import ScraperBase from './base.mjs';
import { UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor } from './live-status.mjs';
import { eventLimit } from './event-limit.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { canonicalSport, normalizeTeamName } from '../shared/text.mjs';

const API_BASE = 'https://fuksiarz.pl/rest/market';

const FUKSIARZ_SPORT_MAP = Object.freeze({
  1: 'football',
  2: 'basketball',
  3: 'baseball',
  4: 'ice-hockey',
  5: 'tennis',
  6: 'handball',
  7: 'floorball',
  9: 'golf',
  10: 'volleyball',
  12: 'rugby',
  13: 'australian-football',
  16: 'american-football',
  17: 'cycling',
  19: 'snooker',
  20: 'table-tennis',
  21: 'cricket',
  22: 'darts',
  26: 'water-polo',
  31: 'badminton',
  40: 'boxing',
  41: 'mma',
  70: 'counter-strike-2',
  71: 'league-of-legends',
  77: 'rainbow-six',
});
const FUKSIARZ_SPORT_NAME_TO_ID = Object.freeze(
  Object.fromEntries(Object.entries(FUKSIARZ_SPORT_MAP).map(([k, v]) => [v, Number(k)])),
);

/**
 * Fuksiarz Scraper — Polish Licensed Sportsbook (fuksiarz.pl).
 *
 * REST API architecture:
 *   - Category hierarchy: /rest/market/categories (540+ categories)
 *   - Bulk multi-category events: /rest/market/categories/multi/{categoryIds}/events
 *   - Independent oddsmaking and margins from other regional books.
 *   - Markets: 1X2, Obie strzelą (BTTS), Over/Under totals across standard lines.
 */
export default class FuksiarzScraper extends ScraperBase {
  timeoutMs = 25_000;
  maxAttempts = 3;

  constructor(opts = {}) {
    super(opts);
    this.id = 'fuksiarz';
    this.name = 'Fuksiarz Poland';
    this.sourceIds = ['fuksiarz'];
    this.engine = 'fuksiarz-rest-v1';
    this.transport = 'fuksiarz-public-json';
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.maxEvents = eventLimit(opts.maxEvents ?? 500);
    this.windowHours = Number(opts.windowHours ?? 168);
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.runId = opts.runId || new Date().toISOString();
    this.sports = !opts.sport && Array.isArray(opts.sports) && opts.sports.length > 0
      ? [...new Set(opts.sports.map((s) => canonicalSport(s)))]
      : null;
    this.sport = opts.sport || (this.sports ? 'all' : 'football');
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
      throw new UpstreamError(`Fuksiarz: category fetch failed (${err.message})`, { cause: err });
    }

    if (!catRes.ok) {
      throw new UpstreamError(`Fuksiarz: categories HTTP ${catRes.status}`, { status: catRes.status });
    }

    const catData = await readBoundedJson(catRes, { maxBytes: 5_000_000 });
    const categories = Array.isArray(catData?.data) ? catData.data : [];

    // Filter level 3 categories with events for requested sport(s)
    const allowedSportIds = this.sports
      ? new Set(this.sports.map((s) => FUKSIARZ_SPORT_NAME_TO_ID[s]).filter(Boolean))
      : (this.sport === 'all'
        ? new Set(Object.keys(FUKSIARZ_SPORT_MAP).map(Number))
        : new Set([FUKSIARZ_SPORT_NAME_TO_ID[canonicalSport(this.sport)] || 1]));
    const footballCats = categories.filter((c) => allowedSportIds.has(Number(c.sportId)) && c.level === 3 && c.eventsCount > 0);
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
    const liveEvidence = liveCoverageFor('fuksiarz');
    const isLiveDefault = liveEvidence?.isLive ?? false;

    for (const ev of rawEvents) {
      if (!ev) continue;

      const rawName = String(ev.eventName || '').trim();
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
        const gType = Number(game.gameType);
        const gName = String(game.gameName || '').trim();

        // 1. Full-time 1X2 / 2-way Match Winner
        if (gType === 1 || gType === 201 || gType === 18002 || gType === 202 || gType === 190 || gName === '1X2' || /^(?:zwyci[eę]zca(?: meczu)?|mecz)$/i.test(gName)) {
          if (game.outcomes.length >= 3) {
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
          } else if (game.outcomes.length === 2) {
            let o1 = null;
            let o2 = null;
            for (const oc of game.outcomes) {
              const odds = Number(oc.outcomeOdds);
              if (!Number.isFinite(odds) || odds <= 1) continue;
              const norm = normalizeTeamName(oc.outcomeName);
              if (oc.outcomePosition === 0 || norm === normalizeTeamName(homeTeam) || oc.outcomeName === '1') o1 = odds;
              else if (oc.outcomePosition === 1 || oc.outcomePosition === 2 || norm === normalizeTeamName(awayTeam) || oc.outcomeName === '2') o2 = odds;
            }
            if (o1 && o2) {
              markets.push({
                key: 'MATCH_ODDS',
                name: 'Match Winner',
                period: 'fulltime',
                live: isLiveDefault,
                selections: [
                  { id: `${id}:mw:1`, name: '1', odds: o1, handicap: null },
                  { id: `${id}:mw:2`, name: '2', odds: o2, handicap: null },
                ],
              });
            }
          }
        }

        // 1b. 1st / 2nd Half 1X2 (gameType: 3, 111)
        if (gType === 3 || gType === 111) {
          const halfPeriod = gType === 111 ? 'half2' : 'half1';
          const halfKey = halfPeriod === 'half2' ? 'MRH2' : 'MRH1';
          let o1 = null;
          let oX = null;
          let o2 = null;
          for (const oc of game.outcomes) {
            const odds = Number(oc.outcomeOdds);
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const name = String(oc.outcomeName || '').trim().toLowerCase();
            if (name === 'x' || name === 'remis') oX = odds;
            else if (oc.outcomePosition === 0 || name === homeTeam.toLowerCase() || name === '1') o1 = odds;
            else if (oc.outcomePosition === 2 || name === awayTeam.toLowerCase() || name === '2') o2 = odds;
          }
          if (o1 && oX && o2) {
            markets.push({
              key: halfKey,
              name: halfPeriod === 'half2' ? '2nd Half Result' : '1st Half Result',
              period: halfPeriod,
              live: isLiveDefault,
              selections: [
                { id: `${id}:${halfKey}:1`, name: 'Home', odds: o1, handicap: null },
                { id: `${id}:${halfKey}:X`, name: 'Draw', odds: oX, handicap: null },
                { id: `${id}:${halfKey}:2`, name: 'Away', odds: o2, handicap: null },
              ],
            });
          }
        }

        // 1c. Double Chance (gameType: 4 FT, 27 1H, -188 2H — normalizes 1/X -> 1X, 1/2 -> 12, X/2 -> X2)
        if ((gType === 4 || gType === 27 || gType === -188) && game.outcomes.length === 3) {
          const dcPeriod = gType === 27 ? 'half1' : (gType === -188 ? 'half2' : 'fulltime');
          const dcKey = dcPeriod === 'half1' ? 'DCH1' : (dcPeriod === 'half2' ? 'DCH2' : 'DOUBLE_CHANCE');
          const sels = [];
          for (const oc of game.outcomes) {
            const odds = Number(oc.outcomeOdds);
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const clean = String(oc.outcomeName || '').trim().toUpperCase().replace(/[\s/]+/g, '');
            const dcLabel = (clean === '1X' || oc.outcomePosition === 0) ? '1X'
              : ((clean === '12' || oc.outcomePosition === 1) ? '12'
                : ((clean === 'X2' || oc.outcomePosition === 2) ? 'X2' : null));
            if (dcLabel) sels.push({ id: `${id}:${dcKey}:${dcLabel}`, name: dcLabel, odds, handicap: null });
          }
          if (sels.length === 3) {
            markets.push({
              key: dcKey,
              name: dcPeriod === 'fulltime' ? 'Double Chance' : `${dcPeriod === 'half1' ? '1st Half' : '2nd Half'} Double Chance`,
              period: dcPeriod,
              live: isLiveDefault,
              selections: sels,
            });
          }
        }

        // 1d. Draw No Bet (gameType: 93, Remis = zwrot)
        if ((gType === 93 || /^remis\s*=\s*zwrot$/i.test(gName)) && game.outcomes.length === 2) {
          let o1 = null;
          let o2 = null;
          for (const oc of game.outcomes) {
            const odds = Number(oc.outcomeOdds);
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const norm = normalizeTeamName(oc.outcomeName);
            if (oc.outcomePosition === 0 || norm === normalizeTeamName(homeTeam) || oc.outcomeName === '1') o1 = odds;
            else if (oc.outcomePosition === 1 || norm === normalizeTeamName(awayTeam) || oc.outcomeName === '2') o2 = odds;
          }
          if (o1 && o2) {
            markets.push({
              key: 'DRAW_NO_BET',
              name: 'Draw No Bet',
              period: 'fulltime',
              live: isLiveDefault,
              selections: [
                { id: `${id}:dnb:1`, name: '1', odds: o1, handicap: null },
                { id: `${id}:dnb:2`, name: '2', odds: o2, handicap: null },
              ],
            });
          }
        }

        // 2. Both Teams To Score (FT: 98, 1H: 120, 2H: 121)
        if (gType === 98 || gType === 120 || gType === 121 || /^obie\s+(?:dru[żz]yny\s+)?strzel/i.test(gName)) {
          const bttsPeriod = gType === 120 ? 'half1' : (gType === 121 ? 'half2' : 'fulltime');
          const bttsKey = bttsPeriod === 'fulltime' ? 'btts' : (bttsPeriod === 'half1' ? 'BTH1' : 'BTH2');
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
              key: bttsKey,
              name: bttsPeriod === 'fulltime' ? 'Both Teams to Score' : `${bttsPeriod === 'half1' ? '1st Half' : '2nd Half'} Both Teams to Score`,
              period: bttsPeriod,
              live: isLiveDefault,
              selections: [
                { id: `${id}:${bttsKey}:yes`, name: 'Yes', odds: yesOdds, handicap: null },
                { id: `${id}:${bttsKey}:no`, name: 'No', odds: noOdds, handicap: null },
              ],
            });
          }
        }

        // 3. Over / Under Totals (FT Match: 8/203/257, 1H Match: -284, Home: 52, Away: 53, 1H Home: 110, 1H Away: 117)
        if ((gType === 8 || gType === 203 || gType === 257 || gType === -284 || gType === 52 || gType === 53 || gType === 110 || gType === 117) && Number.isFinite(Number(game.argument))) {
          const line = Number(game.argument);
          if (line > 0) {
            let overOdds = null;
            let underOdds = null;
            for (const oc of game.outcomes) {
              const odds = Number(oc.outcomeOdds);
              if (!Number.isFinite(odds) || odds <= 1) continue;
              const name = String(oc.outcomeName || '').trim().toLowerCase();
              if (name.includes('powyżej') || name.includes('powyzej') || name.includes('over')) overOdds = odds;
              else if (name.includes('poniżej') || name.includes('ponizej') || name.includes('under')) underOdds = odds;
            }
            if (overOdds && underOdds) {
              const ouPeriod = (gType === -284 || gType === 110 || gType === 117) ? 'half1' : 'fulltime';
              const ouTeam = (gType === 52 || gType === 110) ? 'home' : ((gType === 53 || gType === 117) ? 'away' : null);
              const isMainMatch = ouPeriod === 'fulltime' && !ouTeam;
              const mKey = isMainMatch ? `total:${line}` : `total:${ouPeriod}:${ouTeam || 'match'}:${line}`;
              const displayName = isMainMatch
                ? (gType === 203 || /punkt/i.test(gName) ? `Total Points Over/Under ${line}` : (gType === 257 || /gem/i.test(gName) ? `Total Games Over/Under ${line}` : `Total Over/Under ${line}`))
                : (gName || `Total Over/Under ${line}`);
              markets.push({
                key: mKey,
                name: displayName,
                period: ouPeriod,
                ...(ouTeam ? { team: ouTeam } : {}),
                live: isLiveDefault,
                line,
                selections: [
                  { id: `${id}:${mKey}:over`, name: `Over ${line}`, odds: overOdds, handicap: line },
                  { id: `${id}:${mKey}:under`, name: `Under ${line}`, odds: underOdds, handicap: line },
                ],
              });
            }
          }
        }

        // 4. Asian Handicap 2-way (gameType: -458)
        if (gType === -458 && game.outcomes.length === 2 && Number.isFinite(Number(game.argument))) {
          const line = Number(game.argument);
          if (line !== 0) {
            const oc1 = game.outcomes.find((o) => o.outcomePosition === 0) || game.outcomes[0];
            const oc2 = game.outcomes.find((o) => o.outcomePosition === 1) || game.outcomes[1];
            const o1 = Number(oc1?.outcomeOdds);
            const o2 = Number(oc2?.outcomeOdds);
            if (o1 > 1 && o2 > 1) {
              markets.push({
                key: `handicap:${line}`,
                name: gName || `Asian Handicap ${line}`,
                period: 'fulltime',
                live: isLiveDefault,
                line,
                selections: [
                  { id: `${id}:ah:${line}:1`, name: `1 (${line})`, odds: o1, handicap: line },
                  { id: `${id}:ah:${line}:2`, name: `2 (${-line})`, odds: o2, handicap: -line },
                ],
              });
            }
          }
        }
      }

      if (markets.length === 0) continue;

      const evSport = FUKSIARZ_SPORT_MAP[Number(ev.category1Id || ev.sportId)] || canonicalSport(ev.category1Name || 'football');
      events.push({
        id,
        sport: evSport,
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

import WebSocket from 'ws';
import ScraperBase from './base.mjs';
import { UpstreamError, TimeoutError } from '../shared/errors.mjs';
import { eventIdentityKey } from '../shared/text.mjs';
import { markMarketsLive } from './live-status.mjs';
import { eventLimit } from './event-limit.mjs';

/**
 * VictoryBet (victorybet.ro) — BetConstruct Swarm WebSocket (`betconstruct-swarm`).
 *
 * Discovered and verified via `morluto/rea` MCP browser capture against
 * `https://www.victorybet.ro/rv/sport` (`ev_d4c6483857a1861e4eb43b9fc34db512838fa6d3967ce915e4af42e7fff51a3c`).
 *
 * Public unauthenticated Swarm endpoint:
 *   wss://eu-swarm-reverse.victorybet.ro/  (site_id: 18754351, source: 42)
 *
 * Protocol:
 *   1. `request_session` ({ language: 'eng', site_id: 18754351, source: 42 }) -> code: 0
 *   2. `get` on `source: 'betting'` across configured sports & market types -> code: 0
 */

const SPORT_CONFIG = Object.freeze({
  football: { alias: 'Soccer', display: 'Football' },
  basketball: { alias: 'Basketball', display: 'Basketball' },
  tennis: { alias: 'Tennis', display: 'Tennis' },
  'ice-hockey': { alias: 'IceHockey', display: 'Ice Hockey' },
  handball: { alias: 'Handball', display: 'Handball' },
  volleyball: { alias: 'Volleyball', display: 'Volleyball' },
  'table-tennis': { alias: 'TableTennis', display: 'Table Tennis' },
});

const ALIAS_TO_CANONICAL = Object.freeze(
  Object.fromEntries(Object.entries(SPORT_CONFIG).map(([k, v]) => [v.alias, k])),
);

const DEFAULT_SPORTS = Object.freeze([
  'football',
  'basketball',
  'tennis',
  'ice-hockey',
  'handball',
  'volleyball',
  'table-tennis',
]);

const SWARM_MARKET_TYPES = Object.freeze([
  'P1XP2',
  'P1P2',
  '1X12X2',
  'DoubleChance',
  'BothTeamsToScore',
  'DrawNoBet',
  'OverUnder',
  'HalfTimeResult',
  'HalfTimeOverUnder',
  'HalfTimeDoubleChance',
  'AsianHandicap',
  'Handicap',
  'MatchTotal',
  'MatchTotal2',
  'MatchTotal(IncludingOvertime)',
  'MatchHandicap',
  'MatchHandicap2',
  'TotalGamesOver/Under',
  'TotalPointsOver/Under',
  'SetWinner',
  'SetOverUnder',
  'CornersOverUnder',
]);

const SYNTHETIC_FIXTURE_RE = /\b(?:home\s+teams|away\s+teams|hosts|guests|fantasy)\b/i;

function isExhaustiveHalfLine(line) {
  return Number.isFinite(line) && Math.abs(line % 1) === 0.5;
}

function formatSignedLine(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function normalizeSportInput(sport) {
  const s = String(sport || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'soccer') return 'football';
  if (s === 'hockey' || s === 'ice hockey') return 'ice-hockey';
  if (s === 'table tennis' || s === 'ping-pong') return 'table-tennis';
  return SPORT_CONFIG[s] ? s : null;
}

export default class VictoryBetScraper extends ScraperBase {
  id = 'victorybet';
  name = 'VictoryBet';
  sourceIds = ['victorybet'];
  engine = 'betconstruct-swarm';
  transport = 'betconstruct-swarm-ws';

  timeoutMs = 25_000;
  maxAttempts = 3;

  constructor(opts = {}) {
    super(opts);
    this.wsUrl = opts.wsUrl || 'wss://eu-swarm-reverse.victorybet.ro/';
    this.siteId = Number(opts.siteId ?? 18754351);
    this.origin = opts.origin || 'https://www.victorybet.ro';
    this.sourceUrl = opts.sourceUrl || 'https://www.victorybet.ro/rv/sport';
    this.ua = opts.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    this.wsImpl = opts.wsImpl || WebSocket;
    this.maxEvents = eventLimit(opts.maxEvents ?? opts.jobConfig?.maxEvents);
    this.windowHours = Number(opts.windowHours ?? 168);
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.runId = opts.runId || new Date().toISOString();

    const requested = opts.sport
      ? [opts.sport]
      : (Array.isArray(opts.sports) && opts.sports.length > 0 ? opts.sports : DEFAULT_SPORTS);
    const resolved = requested.map(normalizeSportInput).filter(Boolean);
    this.sports = resolved.length > 0 ? [...new Set(resolved)] : [...DEFAULT_SPORTS];
  }

  _swarmQuery({ targetAliases, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || new Error('Aborted'));
        return;
      }

      const WsCtor = this.wsImpl;
      const ws = new WsCtor(this.wsUrl, {
        headers: {
          'User-Agent': this.ua,
          Origin: this.origin,
        },
      });

      let settled = false;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
        fn(val);
      };

      const onAbort = () => {
        try {
          ws.terminate?.();
        } catch {
          // ignore
        }
        finish(reject, signal?.reason || new Error('Aborted'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        try {
          ws.terminate?.();
        } catch {
          // ignore
        }
        finish(reject, new TimeoutError(`${this.id}: Swarm WebSocket timeout after ${this.timeoutMs}ms`, { code: 'ETIMEOUT' }));
      }, this.timeoutMs);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          command: 'request_session',
          params: {
            language: 'eng',
            site_id: this.siteId,
            source: 42,
          },
          rid: 'sess-1',
        }));
      });

      ws.on('message', (data) => {
        let msg = null;
        try {
          msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (msg.rid === 'sess-1') {
          if (msg.code !== 0) {
            finish(reject, new UpstreamError(`${this.id}: Swarm session rejected (code=${msg.code})`, { code: 'EUPSTREAM' }));
            return;
          }
          ws.send(JSON.stringify({
            command: 'get',
            rid: 'games-1',
            params: {
              source: 'betting',
              what: {
                sport: ['id', 'name', 'alias'],
                competition: ['id', 'name'],
                game: ['id', 'team1_name', 'team2_name', 'start_ts', 'type', 'is_blocked'],
                market: ['id', 'type', 'name', 'base', 'main_order'],
                event: ['id', 'type', 'type_1', 'name', 'price', 'base', 'order'],
              },
              where: {
                sport: { alias: { '@in': targetAliases } },
                game: this.includeLive
                  ? { type: { '@in': [0, 1] }, is_blocked: 0 }
                  : { type: 0, is_blocked: 0 },
                market: { type: { '@in': SWARM_MARKET_TYPES } },
              },
            },
          }));
          return;
        }

        if (msg.rid === 'games-1') {
          if (msg.code !== 0) {
            finish(reject, new UpstreamError(`${this.id}: Swarm query failed (code=${msg.code})`, { code: 'EUPSTREAM' }));
            return;
          }
          finish(resolve, msg);
        }
      });

      ws.on('error', (err) => {
        finish(reject, new UpstreamError(`${this.id}: Swarm WebSocket error (${err?.message || err})`, { cause: err, code: 'EUPSTREAM' }));
      });

      ws.on('close', () => {
        finish(reject, new TimeoutError(`${this.id}: Swarm WebSocket closed before response`, { code: 'ECLOSED' }));
      });
    });
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3_600_000;
    this.observedAt = new Date().toISOString();

    const targetAliases = this.sports
      .map((s) => SPORT_CONFIG[s]?.alias)
      .filter(Boolean);

    return this._swarmQuery({ targetAliases, signal });
  }

  normalize(raw) {
    if (!raw || typeof raw !== 'object') return [];
    if (Array.isArray(raw)) return raw;

    const sportsObj = raw?.data?.data?.sport ?? raw?.data?.sport ?? raw?.sport ?? null;
    if (!sportsObj || typeof sportsObj !== 'object') return [];

    const games = [];
    for (const [sportKey, sportNode] of Object.entries(sportsObj)) {
      if (!sportNode || typeof sportNode !== 'object') continue;
      const sportAlias = String(sportNode.alias || '').trim();
      const canonicalSport = ALIAS_TO_CANONICAL[sportAlias] || normalizeSportInput(sportNode.name);
      if (!canonicalSport || !this.sports.includes(canonicalSport)) continue;

      const competitions = sportNode.competition || {};
      for (const [compKey, compNode] of Object.entries(competitions)) {
        if (!compNode || typeof compNode !== 'object') continue;
        const league = String(compNode.name || '').trim() || SPORT_CONFIG[canonicalSport].display;
        const compGames = compNode.game || {};
        for (const [gameKey, gameNode] of Object.entries(compGames)) {
          if (!gameNode || typeof gameNode !== 'object') continue;
          games.push({
            gameId: String(gameNode.id ?? gameKey).trim(),
            sportId: sportNode.id ?? sportKey,
            canonicalSport,
            sportDisplay: SPORT_CONFIG[canonicalSport].display,
            competitionId: compNode.id ?? compKey,
            league,
            team1_name: gameNode.team1_name,
            team2_name: gameNode.team2_name,
            start_ts: gameNode.start_ts,
            type: gameNode.type,
            is_blocked: gameNode.is_blocked,
            markets: Object.entries(gameNode.market || {}).map(([mKey, mVal]) => ({
              ...mVal,
              id: mVal?.id ?? mKey,
            })),
          });
        }
      }
    }

    games.sort((a, b) => (Number(a.start_ts) || 0) - (Number(b.start_ts) || 0));
    return games;
  }

  _resolveHomeTeamFromMarkets(game, fallback) {
    if (fallback) return fallback;
    for (const m of game.markets || []) {
      const evs = Object.values(m.event || {});
      const h = evs.find((s) => s?.type === 'Home' && s?.type_1 === 'Home' && s?.name && !/^w[12]$/i.test(s.name.trim()));
      if (h) return String(h.name).trim();
    }
    return '';
  }

  _resolveAwayTeamFromMarkets(game, fallback) {
    if (fallback) return fallback;
    for (const m of game.markets || []) {
      const evs = Object.values(m.event || {});
      const a = evs.find((s) => s?.type === 'Away' && s?.type_1 === 'Away' && s?.name && !/^w[12]$/i.test(s.name.trim()));
      if (a) return String(a.name).trim();
    }
    return '';
  }

  _extractMarkets(gameId, rawMarkets, canonicalSport) {
    const out = [];
    const seenKeys = new Set();

    const sortedMarkets = [...(rawMarkets || [])].sort(
      (a, b) => (Number(a?.main_order) || 999) - (Number(b?.main_order) || 999),
    );

    for (const m of sortedMarkets) {
      if (!m || typeof m !== 'object') continue;
      const mType = String(m.type || '').trim();
      const mName = String(m.name || '').trim();
      const sels = Object.entries(m.event || {})
        .map(([eKey, s]) => ({ ...s, id: String(s?.id ?? eKey) }))
        .filter((s) => Number.isFinite(Number(s.price)) && Number(s.price) > 1)
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

      if (sels.length < 2) continue;

      // 1. 3-way regulation result (P1XP2 / HalfTimeResult)
      if (mType === 'P1XP2' || mType === 'HalfTimeResult') {
        const period = mType === 'HalfTimeResult' ? 'half1' : 'fulltime';
        const dedup = `MATCH_ODDS|${period}|3way`;
        if (seenKeys.has(dedup)) continue;

        const homeSel = sels.find((s) => s.type === 'P1' || s.type_1 === 'W1' || s.name === 'W1' || s.name === '1');
        const drawSel = sels.find((s) => s.type === 'X' || s.type_1 === 'X' || /^draw$/i.test(String(s.name || '').trim()));
        const awaySel = sels.find((s) => s.type === 'P2' || s.type_1 === 'W2' || s.name === 'W2' || s.name === '2');
        if (!homeSel || !drawSel || !awaySel) continue;

        seenKeys.add(dedup);
        out.push({
          key: 'MATCH_ODDS',
          name: mName || (period === 'half1' ? '1st Half Result' : 'Match Result'),
          period,
          selections: [
            { id: homeSel.id, name: '1', odds: Number(homeSel.price), handicap: null },
            { id: drawSel.id, name: 'X', odds: Number(drawSel.price), handicap: null },
            { id: awaySel.id, name: '2', odds: Number(awaySel.price), handicap: null },
          ],
        });
        continue;
      }

      // 2. 2-way match winner (P1P2 / SetWinner)
      if (mType === 'P1P2' || mType === 'SetWinner') {
        if (sels.length !== 2) continue;
        // Football & handball have regulation draws — skip 2-way P1P2 to prevent OT/tie-advance mismatch.
        if (mType === 'P1P2' && (canonicalSport === 'football' || canonicalSport === 'handball')) continue;

        let period = 'fulltime';
        let label = mName || 'Match Winner';
        if (mType === 'SetWinner') {
          if (mName && !/\b(?:1st\s*set|first\s*set|set\s*1)\b/i.test(mName)) continue;
          period = 'set1';
          label = mName || '1st Set Winner';
        } else if (canonicalSport === 'basketball' || canonicalSport === 'ice-hockey') {
          period = 'fulltime_ot';
          label = /overtime|incl/i.test(label) ? label : `${label} (Incl. OT)`;
        }

        const dedup = `MATCH_ODDS|${period}|2way`;
        if (seenKeys.has(dedup)) continue;

        const homeSel = sels.find((s) => s.type === 'P1' || s.type_1 === 'W1' || s.type === 'Home' || s.name === 'W1');
        const awaySel = sels.find((s) => s.type === 'P2' || s.type_1 === 'W2' || s.type === 'Away' || s.name === 'W2');
        if (!homeSel || !awaySel || homeSel.id === awaySel.id) continue;

        seenKeys.add(dedup);
        out.push({
          key: 'MATCH_ODDS',
          name: label,
          period,
          selections: [
            { id: homeSel.id, name: '1', odds: Number(homeSel.price), handicap: null },
            { id: awaySel.id, name: '2', odds: Number(awaySel.price), handicap: null },
          ],
        });
        continue;
      }

      // 3. Double Chance (1X12X2 / DoubleChance / HalfTimeDoubleChance)
      if (mType === '1X12X2' || mType === 'DoubleChance' || mType === 'HalfTimeDoubleChance') {
        if (sels.length !== 3) continue;
        const period = mType === 'HalfTimeDoubleChance' ? 'half1' : 'fulltime';
        const dedup = `DOUBLE_CHANCE|${period}`;
        if (seenKeys.has(dedup)) continue;

        const s1x = sels.find((s) => s.type === '1X' || s.type_1 === '1X' || String(s.name).trim() === '1X');
        const s12 = sels.find((s) => s.type === '12' || s.type_1 === '12' || String(s.name).trim() === '12');
        const sx2 = sels.find((s) => s.type === 'X2' || s.type_1 === 'X2' || String(s.name).trim() === 'X2');
        if (!s1x || !s12 || !sx2) continue;

        seenKeys.add(dedup);
        out.push({
          key: 'DOUBLE_CHANCE',
          name: mName || (period === 'half1' ? '1st Half Double Chance' : 'Double Chance'),
          period,
          selections: [
            { id: s1x.id, name: '1X', odds: Number(s1x.price), handicap: null },
            { id: s12.id, name: '12', odds: Number(s12.price), handicap: null },
            { id: sx2.id, name: 'X2', odds: Number(sx2.price), handicap: null },
          ],
        });
        continue;
      }

      // 4. Both Teams To Score (BothTeamsToScore)
      if (mType === 'BothTeamsToScore') {
        if (sels.length !== 2) continue;
        if (/\b(?:and|total|2nd|both\s+halves|either\s+half)\b/i.test(mName)) continue;
        const period = /\b(?:1st\s*half|first\s*half)\b/i.test(mName) ? 'half1' : 'fulltime';
        const dedup = `BTTS|${period}`;
        if (seenKeys.has(dedup)) continue;

        const yesSel = sels.find((s) => /^yes$/i.test(String(s.type || s.type_1 || s.name || '').trim()));
        const noSel = sels.find((s) => /^no$/i.test(String(s.type || s.type_1 || s.name || '').trim()));
        if (!yesSel || !noSel) continue;

        seenKeys.add(dedup);
        out.push({
          key: 'BTTS',
          name: mName || 'Both Teams To Score',
          period,
          selections: [
            { id: yesSel.id, name: 'Yes', odds: Number(yesSel.price), handicap: null },
            { id: noSel.id, name: 'No', odds: Number(noSel.price), handicap: null },
          ],
        });
        continue;
      }

      // 5. Draw No Bet (DrawNoBet)
      if (mType === 'DrawNoBet') {
        if (sels.length !== 2) continue;
        const period = /\b(?:1st\s*half|first\s*half)\b/i.test(mName) ? 'half1' : 'fulltime';
        const dedup = `DRAW_NO_BET|${period}`;
        if (seenKeys.has(dedup)) continue;

        const homeSel = sels.find((s) => s.type === 'Home' || s.type_1 === 'Team1' || s.type === 'P1' || s.type_1 === 'W1');
        const awaySel = sels.find((s) => s.type === 'Away' || s.type_1 === 'Team2' || s.type === 'P2' || s.type_1 === 'W2');
        if (!homeSel || !awaySel || homeSel.id === awaySel.id) continue;

        seenKeys.add(dedup);
        out.push({
          key: 'DRAW_NO_BET',
          name: mName || 'Draw No Bet',
          period,
          selections: [
            { id: homeSel.id, name: '1', odds: Number(homeSel.price), handicap: null },
            { id: awaySel.id, name: '2', odds: Number(awaySel.price), handicap: null },
          ],
        });
        continue;
      }

      // 6. Totals (Over/Under across goals, points, games, corners)
      if (
        mType === 'OverUnder' ||
        mType === 'HalfTimeOverUnder' ||
        mType === 'MatchTotal' ||
        mType === 'MatchTotal2' ||
        mType === 'MatchTotal(IncludingOvertime)' ||
        mType === 'TotalGamesOver/Under' ||
        mType === 'TotalPointsOver/Under' ||
        mType === 'SetOverUnder' ||
        mType === 'CornersOverUnder'
      ) {
        if (sels.length !== 2) continue;
        const overSel = sels.find((s) => /^over$/i.test(String(s.type || s.type_1 || s.name || '').trim()));
        const underSel = sels.find((s) => /^under$/i.test(String(s.type || s.type_1 || s.name || '').trim()));
        if (!overSel || !underSel) continue;

        const line = Number(m.base ?? overSel.base ?? underSel.base);
        if (!isExhaustiveHalfLine(line) || line <= 0) continue;
        if (overSel.base !== undefined && Number(overSel.base) !== line) continue;
        if (underSel.base !== undefined && Number(underSel.base) !== line) continue;

        // Guard against per-team totals slipping into match totals
        if (/\b(?:home|away|team\s*[12]|player\s*[12]|individual)\b/i.test(mName)) continue;

        let key = 'OVER_UNDER';
        let period = 'fulltime';
        let subject = 'goals';
        let label = mName || 'Total Goals';

        if (mType === 'HalfTimeOverUnder') {
          period = 'half1';
          label = mName || '1st Half Total Goals';
        } else if (mType === 'MatchTotal') {
          key = 'TOTAL_POINTS';
          subject = 'points';
          period = canonicalSport === 'basketball' ? 'fulltime_ot' : 'fulltime';
          label = canonicalSport === 'basketball'
            ? (mName && /overtime|incl/i.test(mName) ? mName : `${mName || 'Total Points'} (Incl. OT)`)
            : (mName || 'Total Points');
        } else if (mType === 'MatchTotal2') {
          key = 'OVER_UNDER';
          subject = 'goals';
          period = 'fulltime';
          label = mName || 'Total Goals';
        } else if (mType === 'MatchTotal(IncludingOvertime)') {
          key = 'OVER_UNDER';
          subject = 'goals';
          period = 'fulltime_ot';
          label = mName || 'Total Goals (Including Overtime)';
        } else if (mType === 'TotalGamesOver/Under') {
          key = 'TOTAL_GAMES';
          subject = 'games';
          period = 'fulltime';
          label = mName || 'Total Games';
        } else if (mType === 'SetOverUnder') {
          if (mName && !/\b(?:1st\s*set|first\s*set|set\s*1)\b/i.test(mName)) continue;
          key = 'TOTAL_GAMES';
          subject = 'games';
          period = 'set1';
          label = mName || '1st Set Total Games';
        } else if (mType === 'TotalPointsOver/Under') {
          key = 'TOTAL_POINTS';
          subject = 'points';
          period = 'fulltime';
          label = mName || 'Total Points';
        } else if (mType === 'CornersOverUnder') {
          if (/\b(?:1st|2nd|half)\b/i.test(mName)) continue;
          key = 'CNOU';
          subject = 'corners';
          period = 'fulltime';
          label = 'Corners Over/Under';
        }

        const dedup = `${key}|${period}|${subject}|${line}`;
        if (seenKeys.has(dedup)) continue;
        seenKeys.add(dedup);

        out.push({
          key,
          name: label,
          period,
          subject,
          line,
          selections: [
            { id: overSel.id, name: `Over ${line}`, odds: Number(overSel.price), handicap: line, line },
            { id: underSel.id, name: `Under ${line}`, odds: Number(underSel.price), handicap: line, line },
          ],
        });
        continue;
      }

      // 7. Two-way Handicaps / Spreads (AsianHandicap, MatchHandicap, MatchHandicap2, Tennis/Volleyball Handicap)
      if (
        mType === 'AsianHandicap' ||
        mType === 'MatchHandicap' ||
        mType === 'MatchHandicap2' ||
        mType === 'Handicap'
      ) {
        // Reject 3-way European Handicap (e.g. Soccer `Handicap` with `Tie`).
        if (sels.length !== 2) continue;
        if (mType === 'Handicap' && (canonicalSport === 'football' || canonicalSport === 'ice-hockey' || canonicalSport === 'handball')) {
          continue;
        }
        if (/\b(?:1st|2nd|half|set|quarter|corners|cards)\b/i.test(mName)) continue;

        const homeSel = sels.find((s) => s.type === 'Home' || s.type_1 === 'Home' || s.type === 'P1' || s.type_1 === 'W1');
        const awaySel = sels.find((s) => s.type === 'Away' || s.type_1 === 'Away' || s.type === 'P2' || s.type_1 === 'W2');
        if (!homeSel || !awaySel || homeSel.id === awaySel.id) continue;

        const hHome = Number(homeSel.base);
        const hAway = Number(awaySel.base);
        if (!Number.isFinite(hHome) || !Number.isFinite(hAway) || hHome !== -hAway) continue;

        // Level Asian Handicap (0.0) settles identically to Draw No Bet (push on draw).
        if (hHome === 0 && hAway === 0) {
          if (canonicalSport === 'football' || canonicalSport === 'ice-hockey' || canonicalSport === 'handball') {
            const dedup = 'ASIAN_HANDICAP_0|fulltime';
            if (!seenKeys.has(dedup) && !seenKeys.has('DRAW_NO_BET|fulltime')) {
              seenKeys.add(dedup);
              out.push({
                key: 'ASIAN_HANDICAP_0',
                name: mName || 'Asian Handicap (0)',
                period: 'fulltime',
                selections: [
                  { id: homeSel.id, name: '1', odds: Number(homeSel.price), handicap: 0 },
                  { id: awaySel.id, name: '2', odds: Number(awaySel.price), handicap: 0 },
                ],
              });
            }
          }
          continue;
        }

        if (!isExhaustiveHalfLine(hHome)) continue;

        let key = 'ASIAN_HANDICAP';
        let period = 'fulltime';
        let subject = undefined;
        let label = mName || 'Asian Handicap';

        if (mType === 'MatchHandicap' && canonicalSport === 'basketball') {
          key = 'POINT_SPREAD';
          period = 'fulltime_ot';
          subject = 'points';
          label = mName && /overtime|incl/i.test(mName) ? mName : `${mName || 'Points Handicap'} (Incl. OT)`;
        } else if (mType === 'Handicap' && canonicalSport === 'tennis') {
          key = 'GAME_HANDICAP';
          period = 'fulltime';
          subject = 'games';
          label = mName || 'Games Handicap';
        } else if (mType === 'Handicap' && (canonicalSport === 'volleyball' || canonicalSport === 'table-tennis')) {
          key = 'POINT_SPREAD';
          period = 'fulltime';
          subject = 'points';
          label = mName || 'Points Handicap';
        }

        const lineSignature = `${key}|${period}|${hHome}/${hAway}`;
        if (seenKeys.has(lineSignature)) continue;
        seenKeys.add(lineSignature);

        out.push({
          key,
          name: label,
          period,
          ...(subject ? { subject } : {}),
          line: hHome,
          selections: [
            { id: homeSel.id, name: `1 (${formatSignedLine(hHome)})`, odds: Number(homeSel.price), handicap: hHome },
            { id: awaySel.id, name: `2 (${formatSignedLine(hAway)})`, odds: Number(awaySel.price), handicap: hAway },
          ],
        });
      }
    }

    return out;
  }

  extractEvents(rawGames) {
    const events = [];
    const seen = new Set();
    const now = this.from ?? Date.now();
    const windowEnd = this.to ?? (now + this.windowHours * 3_600_000);

    for (const g of rawGames || []) {
      if (!g || Number(g.is_blocked) === 1) continue;

      const gameId = String(g.gameId || g.id || '').trim();
      if (!gameId || seen.has(gameId)) continue;

      const homeTeam = this._resolveHomeTeamFromMarkets(g, String(g.team1_name || '').trim());
      const awayTeam = this._resolveAwayTeamFromMarkets(g, String(g.team2_name || '').trim());
      if (!homeTeam || !awayTeam || homeTeam === awayTeam) continue;
      if (SYNTHETIC_FIXTURE_RE.test(homeTeam) || SYNTHETIC_FIXTURE_RE.test(awayTeam)) continue;

      const live = Number(g.type) === 1;
      if (live && !this.includeLive) continue;

      const startMs = Number(g.start_ts) * 1000;
      if (!Number.isFinite(startMs) || startMs <= 0) continue;
      if (!live && startMs < now && !this.includePast) continue;
      if (!live && startMs > windowEnd) continue;

      const canonicalSport = g.canonicalSport || 'football';
      const sportDisplay = g.sportDisplay || SPORT_CONFIG[canonicalSport]?.display || 'Football';
      const league = String(g.league || sportDisplay).trim();
      const kickoff = new Date(startMs).toISOString();

      const markets = this._extractMarkets(gameId, g.markets, canonicalSport);
      if (markets.length === 0) continue;

      markMarketsLive(markets, () => live);
      seen.add(gameId);

      events.push({
        id: gameId,
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
        live,
        eventKey: eventIdentityKey({ sport: sportDisplay, league, kickoff, homeTeam, awayTeam }),
        providerEventKey: `${gameId}|${kickoff}`,
        markets,
      });

      if (events.length >= this.maxEvents) break;
    }

    return events;
  }
}

import ScraperBase from './base.mjs';
import { normalizeTeamName, canonicalSport } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { digitainEventIsLive, markMarketsLive, liveCoverageFor } from './live-status.mjs';
import { extractPeriodFromName } from '../scanner/market-contracts.mjs';

const DIGITAIN_URL = 'https://micros-prod1-sb.gambling-solutions.ro/api/digitain-fetcher/v2/public/events';

/** Map a provider sport label onto the canonical sport id used everywhere else. */
function canonicalSportKey(label) {
  return canonicalSport(String(label || '').trim().toLowerCase());
}

/**
 * Live, whatever the provider calls it. The status is a localised string whose
 * casing varies with the language entry that answered, so a plain `=== 'live'`
 * comparison missed every capitalised variant.
 *
 * The implementation moved to live-status.mjs, which holds it beside the
 * measurement that justifies it. It stayed byte-identical on the way.
 */
const isLiveStatus = digitainEventIsLive;

/**
 * Settlement window implied by a market's display name.
 *
 * Bet type ids are opaque, so the name is the only evidence available about
 * which window a market settles on. Anything that does not clearly settle at
 * the final whistle is reported as unknown rather than claimed as full-time,
 * which keeps the engine from pairing it with a genuine full-time leg.
 */
function marketPeriod(name) {
  if (/pauza\s*sau\s*final|half\s*time\s*or\s*full/i.test(name)) return 'half-or-full';
  if (/pauza\s*(?!sau)|half\s*time(?!.*full)/i.test(name)) return 'halftime';
  return extractPeriodFromName(name) || 'fulltime';
}

/**
 * Winner scraper — Digitain public events feed (POST).
 *
 * Returns 3,000+ events across 30+ sports in a single POST request.
 * Each event has matchBets[] with outcomes and odds.
 */
/**
 * Digitain (Gambling Solutions) public events feed.
 *
 * On totals: the reader WAS the limit, and has been fixed. An earlier note here
 * said the public endpoint carries no goals total, from a capture in which
 * every football event held exactly one matchBets entry. Re-measured
 * 2026-09-29 on the full 3,533-event payload, that still holds for all but one
 * fixture — 1 of 1,269 football events — and the totals that do exist were
 * being dropped, not absent. Across the whole payload there are 26
 * total-named markets, all under idBet 3: 13 basketball, 4 rugby union, 3
 * handball, 2 American football, 2 polo, 1 bandy, and that single football
 * fixture with "Total goluri" at 4.5/5.5/6.5/7. So this book is genuinely
 * thin on totals, but not empty, and the reason it published none is in
 * extractEvents: the line lives in `argument`, not in the leg name.
 *
 * There is no both-teams-to-score on this endpoint — still unverified as
 * absent rather than merely unpublished, since no such market name appeared
 * in any sport in the payload.
 */
export default class WinnerScraper extends ScraperBase {
  id = 'winner';
  name = 'Winner';
  sourceIds = ['winner'];

  maxAttempts = 2;

  constructor(opts = {}) {
    super(opts);
    this.maxEvents = opts.maxEvents === 'all' ? Infinity : Number(opts.maxEvents ?? Infinity);
    if ((!Number.isInteger(this.maxEvents) && this.maxEvents !== Infinity) || this.maxEvents < 0) {
      throw new ValidationError('Winner: invalid maxEvents');
    }
    this.transport = 'winner-digitain-public-json';
    // Pre-match football is the default contract; `sport: 'all'` accepts all sports.
    if (Array.isArray(opts.sports) && opts.sports.length > 0) {
      this.sportsFilter = opts.sports.map((s) => canonicalSportKey(s));
      this.sportFilter = null;
    } else {
      this.sportsFilter = null;
      this.sportFilter = opts.sport === 'all' ? null : canonicalSportKey(opts.sport || 'football');
    }
    this.includeLive = opts.includeLive === true;
    this.includePast = opts.includePast === true;
    this.windowHours = Number(opts.windowHours ?? 168);
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.sourceUrl = DIGITAIN_URL;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(DIGITAIN_URL, {
      method: 'POST',
      signal: bounded,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new UpstreamError(`Winner: HTTP ${response.status}`, { status: response.status });
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new ValidationError('Winner: expected JSON');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        bounded.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 20_000_000) throw new ValidationError('Winner: response exceeds 20 MB');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    bounded.throwIfAborted();
    this.observedAt = new Date().toISOString();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  normalize(raw) {
    if (!raw?.data?.events) throw new ValidationError('Winner: missing data.events');
    return raw.data.events;
  }

  /** Extract a localized string from a Digitain i18n object like {'2':'Football','42':'Fotbal'}. */
  _localize(val, fallback = '') {
    if (!val) return fallback;
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
      // Prefer Romanian (42), then English (2), then any value
      return val['42'] || val['2'] || Object.values(val)[0] || fallback;
    }
    return String(val);
  }

  extractEvents(rawEvents) {
    const out = [];
    const seen = new Set();
    const nowMs = this.from ?? Date.now();
    const toMs = this.to ?? (nowMs + this.windowHours * 3600000);
    for (const e of rawEvents) {
      if (out.length >= this.maxEvents) break;
      if (e.active === false || e.bettingStatus === false) continue;
      const home = this._localize(e.team1Name);
      const away = this._localize(e.team2Name);
      if (!home || !away) continue;
      // `matchDateTime` is an epoch in milliseconds, not an ISO string:
      // `Date.parse(1790494200000)` is NaN, which silently emptied the whole
      // feed. `Number()` reads the timestamp the dealer actually sends, and
      // still accepts an ISO string if one ever appears.
      const startMs = /^\d+$/.test(String(e.matchDateTime ?? ''))
        ? Number(e.matchDateTime)
        : Date.parse(e.matchDateTime);
      if (!Number.isFinite(startMs)) continue;
      // Digitain states live-ness on the event, so every market of a running
      // match is a live market. It is read BEFORE the window checks on purpose:
      // a live event's kickoff is already in the past, so the pre-match window
      // below drops it a second time — which is what made the flag unusable and
      // left `includeLive` able to collect nothing at all.
      const live = isLiveStatus(e.currentStatus);
      // Pre-match only unless asked otherwise. The feed returns 30+ sports and
      // live events in one payload; without this filter they consumed the event
      // cap and reached the scan as if they were tradable pre-match football.
      // The sport filter below then selects the one requested sport — football
      // gets the bundling branch further down, and every other sport falls
      // through to the generic publisher at the bottom, which is what lets one
      // crawl serve 25 declared sports from the same payload.
      if (live && !this.includeLive) continue;
      if (!this.includePast && !live && startMs <= nowMs) continue;
      if (startMs > toMs) continue;
      const sport = this._localize(e.sportName, 'Unknown');
      const cSport = canonicalSportKey(sport);
      if (this.sportsFilter && !this.sportsFilter.includes(cSport)) continue;
      if (this.sportFilter && cSport !== this.sportFilter) continue;
      const kickoff = new Date(startMs).toISOString();
      const league = this._localize(e.tournamentName, 'Unknown');
      const matchId = String(e.idMatch || e.id);
      if (seen.has(matchId)) continue;
      seen.add(matchId);
      // Extract ALL markets from matchBets
      const matchBets = e.matchBets || [];
      const markets = [];
      for (const bet of matchBets) {
        if (!bet.mbActive) continue;
        const betName = this._localize(bet.mbDisplayName, `Market ${bet.idBet}`);
        const outcomes = bet.mbOutcomes || [];

        // A goals total arrives BUNDLED: one matchBets entry whose outcomes
        // cover every line the book quotes for that fixture. Measured 2026-09-29
        // on the live payload, a single football fixture (idMatch 41130989)
        // carried "Total goluri" with outcomes at 4.5, 5.5, 6.5 and 7 — four
        // lines in one entry, eight legs. Publishing that as one market is the
        // multi-line bug the engine already documents: the legs would collapse
        // into whichever line the router happened to read.
        //
        // The line is not in the leg name either. Every outcome reads bare
        // "Peste"/"Sub" and carries the number in a sibling field, `argument`
        // (4.5, 5.5, …), with the side in `mboType`/`mboCode` (1 Over, 2
        // Under). The name alone therefore yields no lineKey at all, which is
        // why this book contributed no total at all. So the line is composed
        // back into the leg name here — the shape every other adapter already
        // publishes — and each line is emitted as its own market.
        //
        // Only on the half. A whole or quarter line is not a two-sided
        // contract: at exactly 7 goals, "Peste 7" and "Sub 7" both push, so the
        // pair settles to a refund rather than covering the outcome. The router
        // refuses those too; skipping them here keeps a non-exhaustive market
        // out of the payload in the first place.
        const cSport = canonicalSportKey(sport);
        if (cSport === 'football' || cSport === 'basketball' || cSport === 'tennis') {
          const isBasketball = cSport === 'basketball';
          const isTennis = cSport === 'tennis';
          const byLine = new Map();
          let total = true;
          for (const o of outcomes) {
            if (!o.mboActive) continue;
            const line = Number(o.argument);
            const sideWord = this._localize(o.mboType, this._localize(o.mboDisplayName, ''));
            const side = /^(over|peste)$/i.test(sideWord) ? 'over'
              : /^(under|sub)$/i.test(sideWord) ? 'under' : null;
            if (!Number.isFinite(line) || !side) { total = false; break; }
            const odds = Number(o.mboOddValue);
            if (!Number.isFinite(odds) || odds <= 1) { total = false; break; }
            if (!byLine.has(line)) byLine.set(line, {});
            byLine.get(line)[side] = { id: String(o.idMbo || ''), sideWord, odds };
          }
          if (total && byLine.size > 0) {
            if (isBasketball) {
              if (!/^total\b/i.test(betName) || !/\bpuncte\b|\bpoints\b/i.test(betName)) continue;
              for (const [line, sides] of byLine) {
                if (!sides.over || !sides.under) continue;
                if (line % 1 === 0 || line * 2 !== Math.round(line * 2)) continue;
                markets.push({
                  key: `POINTS_OVER_UNDER_${String(line).replace('.', '_')}`,
                  subject: 'points',
                  name: `${betName} ${line}`,
                  period: marketPeriod(betName),
                  selections: [
                    { id: sides.over.id, name: `${sides.over.sideWord} ${line}`, odds: sides.over.odds, handicap: null },
                    { id: sides.under.id, name: `${sides.under.sideWord} ${line}`, odds: sides.under.odds, handicap: null },
                  ],
                });
              }
              continue;
            } else if (isTennis) {
              if (!/^total\b/i.test(betName) || !/\bgame-?uri\b|\bgames\b|\bsets\b|\bseturi\b/i.test(betName)) continue;
              for (const [line, sides] of byLine) {
                if (!sides.over || !sides.under) continue;
                if (line % 1 === 0 || line * 2 !== Math.round(line * 2)) continue;
                markets.push({
                  key: 'TOTAL_GAMES',
                  subject: 'games',
                  name: `${betName} ${line}`,
                  period: marketPeriod(betName),
                  selections: [
                    { id: sides.over.id, name: `${sides.over.sideWord} ${line}`, odds: sides.over.odds, handicap: null },
                    { id: sides.under.id, name: `${sides.under.sideWord} ${line}`, odds: sides.under.odds, handicap: null },
                  ],
                });
              }
              continue;
            } else {
              if (!/^total\b/i.test(betName) || !/\bgoluri\b|\bgoals\b/i.test(betName)) continue;
              for (const [line, sides] of byLine) {
                // Exactly two opposite sides, or it is not a contract.
                if (!sides.over || !sides.under) continue;
                if (line % 1 === 0 || line * 2 !== Math.round(line * 2)) continue;
                markets.push({
                  key: 'total_goals',
                  name: `${betName} ${line}`,
                  period: marketPeriod(betName),
                  selections: [
                    { id: sides.over.id, name: `${sides.over.sideWord} ${line}`, odds: sides.over.odds, handicap: null },
                    { id: sides.under.id, name: `${sides.under.sideWord} ${line}`, odds: sides.under.odds, handicap: null },
                  ],
                });
              }
              continue;
            }
          }
        }

        const selections = [];
        for (const o of outcomes) {
          if (!o.mboActive) continue;
          const odds = Number(o.mboOddValue);
          if (!Number.isFinite(odds) || odds <= 1) continue;
          const name = this._localize(o.mboDisplayName, '');
          if (!name) continue;
          selections.push({
            id: String(o.idMbo || ''),
            name,
            odds,
            handicap: null,
          });
        }
        if (selections.length < 2) continue;
        // Only the full-time result market is claimed as such. Bet type ids are
        // opaque and cover first-half, half-time-or-full and other windows, so
        // stamping every one of them `fulltime` let a 1H price be paired against
        // another book's full-time legs.
        const period = marketPeriod(betName);
        markets.push({ key: bet.idBet, name: betName, period, selections });
      }
      if (markets.length === 0) continue;
      const eventKey = [
        normalizeTeamName(sport),
        normalizeTeamName(league),
        kickoff,
        normalizeTeamName(home),
        normalizeTeamName(away),
      ].join('|');
      // Digitain states live-ness on the event, so all of its markets are live
      // markets. The engine pairs on the MARKET's flag, not the event's: without
      // this a live 1X2 would still bucket with another book's pre-match 1X2,
      // because nothing told the bucket the price was a running-match price.
      markMarketsLive(markets, () => live);
      out.push({
        id: matchId,
        sourceId: this.id,
        sourceUrl: this.sourceUrl,
        transport: this.transport,
        observedAt: this.observedAt,
        sport,
        league,
        kickoff,
        homeTeam: home,
        awayTeam: away,
        // The scanner filters on `live`; `isLive` was never read, so a live
        // event passed the includeLive gate.
        live,
        isLive: live,
        eventKey,
        markets,
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      sourceUrl: this.sourceUrl,
      transport: this.transport,
      observedAt: this.observedAt,
      // `live` here is the measured capability of the feed; `liveCollected` is
      // whether this run actually took its in-play events. The previous
      // `Boolean(this.includeLive)` answered the second question under the first
      // question's name, so a feed that can do live looked incapable whenever a
      // prematch run was configured.
      coverage: {
        sport: this.sportFilter ?? 'all',
        allMarkets: true,
        ...liveCoverageFor(this.id),
        liveCollected: Boolean(this.includeLive),
        maxEvents: this.maxEvents,
      },
    };
  }
}

import ScraperBase from './base.mjs';
import { normalizeTeamName, canonicalSport } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

const DIGITAIN_URL = 'https://micros-prod1-sb.gambling-solutions.ro/api/digitain-fetcher/v2/public/events';

/** Map a provider sport label onto the canonical sport id used everywhere else. */
function canonicalSportKey(label) {
  return canonicalSport(String(label || '').trim().toLowerCase());
}

/**
 * Live, whatever the provider calls it. The status is a localised string whose
 * casing varies with the language entry that answered, so a plain `=== 'live'`
 * comparison missed every capitalised variant.
 */
function isLiveStatus(status) {
  // `currentStatus` is a score object, not a label: {HomeTeamScore, LiveEventTime,
  // LiveMatchShortStatus, …}. A running match is the one whose live clock has
  // started, so that is the signal. The string form is still accepted for the
  // case where the feed sends a plain label.
  if (status && typeof status === 'object') {
    const label = status.LiveMatchShortStatus?.['42'] || status.LiveMatchShortStatus?.['2'] || '';
    if (/^live/i.test(String(label).trim())) return true;
    return Number(status.LiveEventTime) > 0 || status.IsLiveStarted === true;
  }
  return /^live$/i.test(String(status || '').trim());
}

/**
 * Settlement window implied by a market's display name.
 *
 * Bet type ids are opaque, so the name is the only evidence available about
 * which window a market settles on. Anything that does not clearly settle at
 * the final whistle is reported as unknown rather than claimed as full-time,
 * which keeps the engine from pairing it with a genuine full-time leg.
 */
function marketPeriod(name) {
  if (/repriza\s*1|1st\s*half|prima\s*repriza|first\s*half/i.test(name)) return 'firsthalf';
  if (/repriza\s*2|2nd\s*half|a\s*doua\s*repriza|second\s*half/i.test(name)) return 'secondhalf';
  if (/pauza\s*sau\s*final|half\s*time\s*or\s*full/i.test(name)) return 'half-or-full';
  if (/pauza\s*(?!sau)|half\s*time(?!.*full)/i.test(name)) return 'halftime';
  return 'fulltime';
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
 * On totals and BTTS: as with Superbet, the reader is not the limit. Captured
 * 2026-09-29 from the full 3,113-event payload, every one of the 1,159 football
 * events carried exactly one entry in `matchBets` — "Final" (or "Câștigător",
 * and outright-specific labels on the few non-league fixtures). No goals total
 * and no both-teams-to-score is present on this public endpoint, so there is no
 * such contract to publish here; it would take a different, unverified endpoint
 * rather than different parsing.
 */
export default class WinnerScraper extends ScraperBase {
  id = 'winner';
  name = 'Winner';
  sourceIds = ['winner'];

  maxAttempts = 2;

  constructor(opts = {}) {
    super(opts);
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Math.min(Number(opts.maxEvents ?? 100), 5000);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 5000) {
      throw new ValidationError('Winner: invalid maxEvents');
    }
    this.transport = 'winner-digitain-public-json';
    // Pre-match football is the verified contract; `sport: 'all'` is not.
    this.sportFilter = canonicalSportKey(opts.sport || 'football');
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
      // Prematch football only. The feed returns 30+ sports and live events in
      // one payload; without this filter they consumed the event cap and
      // reached the scan as if they were tradable pre-match football.
      if (!this.includeLive && isLiveStatus(e.currentStatus)) continue;
      if (!this.includePast && startMs <= nowMs) continue;
      if (startMs > toMs) continue;
      const sport = this._localize(e.sportName, 'Unknown');
      if (this.sportFilter && canonicalSportKey(sport) !== this.sportFilter) continue;
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
        live: isLiveStatus(e.currentStatus),
        isLive: isLiveStatus(e.currentStatus),
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
      // Pre-match football, matching what extractEvents actually emits.
      coverage: { sport: this.sportFilter || 'football', allMarkets: true, live: Boolean(this.includeLive), maxEvents: this.maxEvents },
    };
  }
}

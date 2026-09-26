import ScraperBase from './base.mjs';
import { normalizeTeamName, canonicalSport } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

const HOST = 'https://production-superbet-offer-ro.freetls.fastly.net';

/** Map a provider sport label onto the canonical sport id used everywhere else. */
function canonicalSportKey(label) {
  return canonicalSport(String(label || '').trim().toLowerCase());
}

/** Superbet sport ID → human-readable name. */
const SPORT_NAMES = {
  5: 'Football', 2: 'Tennis', 75: 'eSport-Football', 4: 'Basketball',
  55: 'Counter-Strike 2', 24: 'Table Tennis', 11: 'Handball', 1: 'Volleyball',
  70: 'eSport-Basketball', 3: 'Ice Hockey', 91: 'F1', 20: 'Baseball',
  12: 'American Football', 13: 'Darts', 39: 'League of Legends', 54: 'Dota 2',
  6: 'Snooker', 40: 'MMA', 34: 'Boxing', 28: 'Beach Volleyball',
  8: 'Rugby', 19: 'Australian Football', 15: 'Water Polo', 14: 'Badminton',
  32: 'Cricket', 17: 'Futsal', 93: 'Motorsport', 157: 'eSport-Hockey',
  189: 'eSport-Tennis', 9: 'Floorball', 35: 'Chess', 25: 'Cycling',
  7: 'Bandy', 44: 'Athletics', 16: 'Golf', 61: 'Call of Duty',
  80: 'Rainbow Six', 53: 'Overwatch', 10: 'Winter Sports',
  29: 'Field Hockey', 38: 'Squash', 27: 'Beach Soccer', 30: 'Padel Tennis',
};

/** Public v3 schema verified against the Romanian feed; multi-sport prematch. */
export default class SuperbetScraper extends ScraperBase {
  id = 'superbet';
  name = 'Superbet';
  sourceIds = ['superbet'];
  maxAttempts = 1;

  constructor(opts = {}) {
    super(opts);
    this.runId ||= new Date().toISOString();
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Number(opts.maxEvents ?? 100);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0) {
      throw new ValidationError('superbet: maxEvents must be a non-negative integer');
    }
    this.sport = opts.sport || 'all';
    // A filter is only applied when the caller actually asked for one sport;
    // 'all' means "no filter", not "filter to the literal sport 'all'".
    this.sportFilter = this.sport && this.sport !== 'all' ? canonicalSportKey(this.sport) : null;
    this.includePast = opts.includePast === true;
    this.windowHours = opts.windowHours ?? 168;
    if (opts.includeLive) this.logger('warn', 'superbet: live collection is unsupported; collecting prematch only');
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    const bounded = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, bounded]) : bounded;
    const start = new Date();
    start.setUTCMinutes(0, 0, 0);
    const windowHours = Number(this.windowHours ?? 168);
    const url = new URL(`${HOST}/v3/ro-RO/events`);
    url.search = new URLSearchParams({
      index: 'active-prematch', startDate: start.toISOString(),
      endDate: new Date(+start + windowHours * 3600000).toISOString(),
    });
    this.sourceUrl = url.href;
    const get = async (address) => {
      requestSignal.throwIfAborted();
      const response = await this.fetchImpl(address, { signal: requestSignal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new UpstreamError(`superbet: HTTP ${response.status} on ${address}`, { status: response.status });
      if (!response.headers.get('content-type')?.includes('json')) {
        throw new ValidationError('superbet: expected public JSON, received non-JSON response');
      }
      return response.json();
    };
    if (this.maxEvents === 0) return { events: [] };
    const raw = await get(url.href);
    this.normalize(raw);
    // Widen the window only while the event cap still has room. The feed is
    // paginated by time, so a cap of 1 must not pay for four 168h reads.
    for (let w = 1; w < 4 && raw.events.length < this.maxEvents; w++) {
      const wUrl = new URL(`${HOST}/v3/ro-RO/events`);
      wUrl.search = new URLSearchParams({
        index: 'active-prematch',
        startDate: new Date(+start + w * windowHours * 3600000).toISOString(),
        endDate: new Date(+start + (w + 1) * windowHours * 3600000).toISOString(),
      });
      try {
        const raw2 = await get(wUrl.href);
        if (Array.isArray(raw2?.events)) raw.events.push(...raw2.events);
      } catch { /* window is optional */ }
    }
    const structure = await get(`${HOST}/v2/ro-RO/struct`);
    if (!Array.isArray(structure?.data?.tournaments)) {
      throw new ValidationError('superbet: structure missing data.tournaments');
    }
    this.tournaments = new Map(structure.data.tournaments.map((t) => [String(t.id), t.localNames?.['ro-RO']]));
    requestSignal.throwIfAborted();
    this.observedAt = new Date().toISOString();
    return raw;
  }

  normalize(raw) {
    if (!raw || raw.error || !Array.isArray(raw.events)) {
      throw new ValidationError('superbet: payload missing events array', { field: 'events' });
    }
    return raw.events;
  }

  extractEvents(rawEvents) {
    const out = [];
    for (const event of rawEvents) {
      if (out.length >= this.maxEvents) break;
      const f = event.fixture;
      if (f?.offer_state_status?.['1'] !== 1
          || event.inplay_stats_metadata?.status !== 'NOT_STARTED') continue;
      const teams = f.event_name?.split('·').map((s) => s.trim());
      const date = new Date(f.utc_date);
      if (teams?.length !== 2 || teams.some((s) => !s) || !Number.isFinite(+date)
          || (!this.includePast && +date <= Date.now()) || !event.event_id) continue;
      // Extract ALL markets with valid odds from the event
      const markets = (event.markets || [])
        .map((m) => {
          if (!Array.isArray(m.odds) || m.odds.length < 2) return null;
          // Group odds by market_line_uuid; each group is one set of outcomes
          const lines = new Map();
          for (const o of m.odds) {
            const lineId = o.metadata?.market_line_uuid || 'default';
            if (!lines.has(lineId)) lines.set(lineId, []);
            lines.get(lineId).push(o);
          }
          // Pick the first line that has valid selections
          for (const [, odds] of lines) {
            const selections = odds
              .map((o) => {
                const name = String(o.metadata?.name || '').trim();
                const price = Number(o.price);
                if (!name || !Number.isFinite(price) || price <= 1) return null;
                if (o.status !== 1 || o.display !== true || o.metadata?.offer_state_id !== 1) return null;
                return { id: o.uuid, name, odds: price, handicap: null };
              })
              .filter(Boolean);
            if (selections.length >= 2) {
              return { key: String(m.id), name: m.name || `Market ${m.id}`, period: 'fulltime', selections };
            }
          }
          return null;
        })
        .filter(Boolean);
      if (markets.length === 0) continue;
      const kickoff = date.toISOString();
      const league = this.tournaments?.get(String(f.tournament_id)) || `Tournament ${f.tournament_id}`;
      const sportName = SPORT_NAMES[f.sport_id] || 'Unknown';
      // Honour the sport filter. It was stored on the instance and never read,
      // so a run filtered to football still emitted every other sport the feed
      // carried, and they consumed the event cap.
      if (this.sportFilter && canonicalSportKey(sportName) !== this.sportFilter) continue;
      out.push({
        id: String(event.event_id), sourceId: this.id, sport: sportName, league, kickoff,
        homeTeam: teams[0], awayTeam: teams[1], isLive: false,
        eventKey: [sportName.toLowerCase(), normalizeTeamName(league), kickoff, ...teams.map(normalizeTeamName)].join('|'),
        // No public per-event page has been verified for this feed; a v2 path on
        // the JSON CDN is not a browseable link, so emit null rather than a URL
        // that dumps raw JSON on the trader.
        sourceUrl: null,
        markets,
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl,
      transport: 'bookmaker-public-json', observedAt: this.observedAt || new Date().toISOString(),
      // Report what was actually collected: the fetch walks up to four
      // `windowHours` windows, not a single 24-hour one, and the sport is
      // whatever the filter selected rather than a hardcoded 'football'.
      coverage: {
        sport: this.sportFilter || 'multi-sport',
        market: 'fulltime-1x2',
        live: false,
        windowHours: this.windowHours * 4,
        maxEvents: this.maxEvents,
      } };
  }
}

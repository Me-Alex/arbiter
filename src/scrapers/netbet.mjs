import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

const SPORTIFY_URL = 'https://api.sportify.bet/api/content/inventory-events';
const BOOKMAKER = 'netbetro';

/** All known Sportify sport slugs. */
const ALL_SPORTS = [
  'fotbal', 'tenis', 'baschet', 'hochei', 'handbal', 'volei',
  'fotbal-sala', 'rugby', 'cricket', 'baseball', 'darts', 'mma',
  'esports', 'hochei-pe-gheata', 'fotbal-american', 'boxing',
  'biliard', 'f1', 'motogp', 'schiat', 'patinaj', 'kitesurf',
  'natatie', 'wrestling', 'cayac', 'snooker',
];

/** Sportify sport slug → human-readable name. */
const SPORT_NAMES = {
  fotbal: 'Football', tenis: 'Tennis', baschet: 'Basketball',
  hochei: 'Ice Hockey', handbal: 'Handball', volei: 'Volleyball',
  'fotbal-sala': 'Futsal', rugby: 'Rugby', cricket: 'Cricket',
  baseball: 'Baseball', darts: 'Darts', mma: 'MMA',
  esports: 'Esports', 'hochei-pe-gheata': 'Ice Hockey',
  'fotbal-american': 'American Football', boxing: 'Boxing',
  biliard: 'Billiards', f1: 'F1', motogp: 'MotoGP',
  schiat: 'Alpine Skiing', patinaj: 'Figure Skating',
  kitesurf: 'Kitesurfing', natatie: 'Swimming',
  wrestling: 'Wrestling', cayac: 'Canoeing', snooker: 'Snooker',
};

/**
 * Sport registry id → Sportify slug. The orchestrator passes the registry id
 * (`football`), which is not a Sportify slug (`fotbal`); passing it straight
 * through produced `?sport=football`, a filter the feed does not recognise, and
 * the run silently returned zero events.
 */
const SPORT_SLUGS = {
  football: 'fotbal',
  tennis: 'tenis',
  basketball: 'baschet',
  'ice-hockey': 'hochei',
  handball: 'handbal',
  volleyball: 'volei',
  futsal: 'fotbal-sala',
  rugby: 'rugby',
  cricket: 'cricket',
  baseball: 'baseball',
  darts: 'darts',
  mma: 'mma',
  esports: 'esports',
  'american-football': 'fotbal-american',
  boxing: 'boxing',
  billiards: 'biliard',
  f1: 'f1',
  motogp: 'motogp',
  'alpine-skiing': 'schiat',
  'figure-skating': 'patinaj',
  kitesurfing: 'kitesurf',
  swimming: 'natatie',
  wrestling: 'wrestling',
  canoeing: 'cayac',
  snooker: 'snooker',
};

/**
 * NetBet scraper — Sportify public JSON inventory-events feed.
 *
 * Fetches one sport per request, bounded by `this.sports`, to maximise total
 * event count. The response is a `tree[]` of
 * sport→region→competition→events with `markets[]` and `outcomes[]`.
 */
export default class NetBetScraper extends ScraperBase {
  id = 'netbet';
  name = 'NetBet';
  sourceIds = ['netbet'];

  maxAttempts = 2;

  constructor(opts = {}) {
    super(opts);
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Math.min(Number(opts.maxEvents ?? 100), 5000);
    /** When no specific sport is set, fetch all supported sports. */
    this.sports = opts.sport
      ? [SPORT_SLUGS[opts.sport] ?? opts.sport]
      : ALL_SPORTS;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 5000) {
      throw new ValidationError('NetBet: invalid maxEvents');
    }
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    };

    /** Fetch one page of a single sport. */
    const fetchPage = async (sport, page) => {
      const url = new URL(SPORTIFY_URL);
      url.search = new URLSearchParams({
        sport, key: 'market_type', lang: 'ro', bookmaker: BOOKMAKER, page: String(page),
      });
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const res = await fetch(url.href, { signal: bounded, headers });
      if (!res.ok) throw new UpstreamError(`NetBet: HTTP ${res.status} for sport=${sport} page=${page}`, { status: res.status });
      if (!res.headers.get('content-type')?.includes('json')) throw new ValidationError('NetBet: expected JSON');
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          bounded.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 20_000_000) throw new ValidationError('NetBet: response exceeds 20 MB');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };

    /**
     * Fetch a single sport. A failure is recorded, not swallowed: this used to
     * return an empty tree, so a football request that 500'd while snooker
     * answered produced `status: 'ok'` with no football in it — the run looked
     * complete and simply had no football.
     */
    const fetchSport = async (sport) => {
      try {
        const data = await fetchPage(sport, 1);
        return { sport, tree: data?.tree || [] };
      } catch (err) {
        return { sport, tree: [], error: err?.message || String(err) };
      }
    };

    this.sourceUrl = `${SPORTIFY_URL}?sport=ALL&bookmaker=${BOOKMAKER}`;
    this.observedAt = new Date().toISOString();

    /** Fetch every configured sport in parallel. */
    const results = await Promise.allSettled(this.sports.map(fetchSport));
    const merged = [];
    const failedSports = [];
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (r.value.error) failedSports.push(`${r.value.sport} (${r.value.error})`);
      if (r.value.tree) merged.push(...r.value.tree);
    }
    if (merged.length === 0) {
      throw new UpstreamError(`NetBet: every sport fetch failed — ${failedSports.join('; ')}`);
    }
    // A partial failure is still a partial result, and it must say so. The
    // shortfall travels with the payload so the run report shows which sport
    // was missing rather than presenting a short run as a complete one.
    if (failedSports.length > 0) {
      this.logger('warn', `NetBet: ${failedSports.length}/${this.sports.length} sport fetches failed: ${failedSports.join('; ')}`);
    }
    return { tree: merged, requestFailures: { attempted: this.sports.length, failed: failedSports.length, sports: failedSports } };
  }

  normalize(raw) {
    if (!raw || !Array.isArray(raw.tree)) throw new ValidationError('NetBet: missing tree array');
    const events = [];
    for (const sportNode of raw.tree) {
      const sportSlug = String(sportNode?.name || '').toLowerCase();
      const sportName = SPORT_NAMES[sportSlug] || sportNode?.name || 'Unknown';
      for (const region of sportNode?.competitions || []) {
        for (const ev of region?.events || []) {
          events.push({ ...ev, _competition: region, _sportName: sportName });
        }
      }
    }
    return events;
  }

  extractEvents(rawEvents) {
    const out = [];
    const seen = new Set();
    for (const e of rawEvents) {
      if (out.length >= this.maxEvents) break;
      if (e.is_live || e.is_suspended) continue;
      const competitors = e.competitors || [];
      if (competitors.length !== 2) continue;
      const home = competitors.find((c) => c.is_home);
      const away = competitors.find((c) => !c.is_home);
      if (!home?.name || !away?.name) continue;
      const kickoff = new Date(e.starts_at).toISOString();
      const compositeId = `${e._sportName || 'unknown'}:${e.id}`;
      if (seen.has(compositeId)) continue;
      seen.add(compositeId);
      const markets = (e.markets || [])
        .map((m) => {
          const key = (m.market_code || '').trim();
          if (!key) return null;
          const selections = (m.outcomes || [])
            .map((o) => {
              const odds = Number(o.odds);
              if (!Number.isFinite(odds) || odds <= 1) return null;
              if (o.suspended) return null;
              const name = String(o.label || o.name || '').trim();
              if (!name) return null;
              return { id: String(o.id ?? ''), name, odds, handicap: null };
            })
            .filter(Boolean);
          if (selections.length < 2) return null;
          return { key, name: m.name || key, period: 'fulltime', selections };
        })
        .filter(Boolean);
      if (markets.length === 0) continue;
      const league = e._competition?.name || e.competition_name || 'Unknown';
      const sportName = e._sportName || 'Football';
      const eventKey = [
        normalizeTeamName(sportName),
        normalizeTeamName(league),
        kickoff,
        normalizeTeamName(home.name),
        normalizeTeamName(away.name),
      ].join('|');
      out.push({
        id: String(e.id),
        sourceId: 'netbet',
        sourceUrl: this.sourceUrl,
        transport: 'netbet-sportify-public-json',
        observedAt: this.observedAt,
        sport: sportName,
        league,
        kickoff,
        homeTeam: home.name,
        awayTeam: away.name,
        isLive: false,
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
      transport: 'netbet-sportify-public-json',
      observedAt: this.observedAt,
      coverage: { sports: this.sports.length, market: 'fulltime-1x2', live: false, maxEvents: this.maxEvents },
    };
  }
}

import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor } from './live-status.mjs';

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
 * Sportify names the SIDE of an outcome in `kind`, and the LINE in the
 * `handicap` field. The adapter used to read neither and took the display
 * string `o.name`, which is where 790 markets died.
 *
 * `kind` is a closed set of nine values, one pair per market_code, measured
 * over a 1,466-event / 2,761-market inventory capture on 2026-09-29:
 *
 *   W1 | W2 | X                 default, current_frame_winner, leg_winner
 *   Home | Away                 handicap, game_handicap, goals_handicap,
 *                               run_line
 *   Over | Under                total_goals, total_points, total_games,
 *                               total_run, total_frame, ou_legs, total_180s
 *   Yes | No                    btts
 *
 * `o.name` is the DISPLAY string and is where the fault was. It is the
 * abbreviated competitor ("B. Celtics", "I. Colts", "F. Panthers") on any
 * event whose market family renders team names, and the contract layer
 * resolves a leg by comparing the selection against homeTeam/awayTeam or a
 * leading "1"/"2" token — so "B. Celtics" matched neither "Boston Celtics"
 * nor "1" and the leg routed to null. The market resolved and could never be
 * priced: 398 two-way `default` markets, 221 `handicap`, 91 `goals_handicap`,
 * 76 `game_handicap` and all 4 `run_line` in that capture.
 *
 * Read those five numbers as this adapter's reach across all sixteen sports,
 * NOT as football. The same capture holds football under three codes only —
 * `default`, `total_goals`, `btts` — and a football result already labels its
 * sides "1"/"2", so the abbreviated-club loss above is almost entirely the
 * other sports' handicaps. The football shapes the scanner arbitrates are the
 * three named here, and for those `kind` is what makes the side independent of
 * the `lang=ro` display language this adapter requests. It is also the
 * provider's own taxonomy, so it needs no team-name matching at all — which is
 * what `o.fullname`, the other way to repair the name comparison, would have
 * required, and would have kept doing wrong for every abbreviation.
 *
 * The line is emitted INTO THE NAME because that is where the contract layer
 * reads it — `extractLineFromName` is the single line parser, and adapters
 * that publish the line only in a `handicap` field have their whole line
 * dropped. Sign convention measured across all 715 priced handicaps: the home
 * leg carries -(market.handicap) and the away leg carries +(market.handicap),
 * and every leg's own `handicap` field agrees with the parenthesised line in
 * its display name. Using the per-leg field means the two cannot disagree.
 */
const SIDE_BY_KIND = {
  W1: '1', X: 'X', W2: '2',
  Home: '1', Away: '2',
  Over: 'Over', Under: 'Under',
  Yes: 'Yes', No: 'No',
};

/**
 * True when a competitor name is a COLUMN of a statistics table rather than a
 * club — "Gazde (Goluri)", "Oaspeți (Goluri)", or the bare "Gazde" / "Home" a
 * matchday board writes in its two columns.
 *
 * Deliberately a closed list of role words, not a heuristic about "names that
 * look like roles": a false positive here deletes a real fixture, and the cost of
 * that is the whole book. The words are the ones the feed itself uses for the
 * sides of a table, and the parenthetical is the tell — a competition is not
 * called "Gazde (Goluri)" anywhere, a table column is.
 */
const ROLE_NAME = /^(gazde|oaspe[tț]i|oaspeti|home|away|gazde\s*\(\s*goluri\s*\)|oaspe[tț]i\s*\(\s*goluri\s*\))$/i;

function isRoleName(name) {
  return ROLE_NAME.test(String(name ?? '').trim());
}

/**
 * Canonical selection name for one outcome, built from the provider's side
 * taxonomy and its own line field. Falls back to the display string when
 * `kind` is absent or unknown, so a market this adapter has never seen is
 * still emitted rather than silently dropped.
 */
function selectionNameFor(o) {
  const side = SIDE_BY_KIND[String(o.kind || '').trim()];
  if (!side) return String(o.label || o.name || '').trim() || null;
  const line = Number(o.handicap);
  const hasLine = Number.isFinite(line);
  // Handicap legs: "1 (-7.5)" / "2 (7.5)" — the side token also tells
  // handicapLineKey which leg is home, so the two books' mirrored markets
  // still bucket together.
  if (o.kind === 'Home' || o.kind === 'Away') return hasLine ? `${side} (${line})` : side;
  // Total legs: "Over 171.5" / "Under 171.5". Magnitudes match, so
  // classifyAndExtractLine reads OVER_UNDER and the magnitude becomes the
  // lineKey.
  if (o.kind === 'Over' || o.kind === 'Under') return hasLine ? `${side} ${line}` : side;
  return side;
}

/**
 * Settlement window for a market.
 *
 * The feed publishes no period field: a token sweep of the 2026-09-29 capture
 * for `half` / `repriza` / `period` / `segment` / `1H` / `2H` / `HT` found
 * none, and every one of the 16 market_codes in it is full-time. The market
 * name is the only place a window could hide, so it is read rather than
 * assumed — and anything unrecognised stays `fulltime`, which is the only
 * window this feed has been observed to publish. The names that carry an
 * explicit window all confirm the default rather than contradict it:
 * "Rezultat Final", "Handicap (Timp Regulamentar)", "Castigator Meci
 * (Inclusiv Prelungiri)" are the full result, regulation time, and the result
 * including extra time. Inventing a half-time label the feed never sent would
 * be worse than the hardcoded default: it would split a market into a bucket
 * with no counterparty on the other side.
 */
const PERIOD_BY_NAME = [
  [/\b(prima\s+repriza|primul\s+set|primul\s+sfert|1\s*h|half\s*time|halftime|1st\s+half)\b/i, 'half1'],
  [/\b(a\s+doua\s+repriza|al\s+doilea\s+set|al\s+doilea\s+sfert|2\s*h|second\s+half|2nd\s+half)\b/i, 'half2'],
];

function periodFor(market) {
  const label = `${market?.name || ''} ${market?.market_code || ''}`;
  for (const [pattern, period] of PERIOD_BY_NAME) {
    if (pattern.test(label)) return period;
  }
  return 'fulltime';
}

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
      // A statistics board, not a match. netbet serves "Gazde (Goluri) v Oaspeți
      // (Goluri)" in the league "UEFA Champions League. Matchday Statistics": the
      // two "competitors" are the home and away columns of a matchday table, and
      // the goals total beside it is quoted at 29.5 or 30.5 because it counts
      // every goal in the round rather than in a game. Published as a fixture it
      // enters the engine's OVER_UNDER buckets as a football line, where 30.5
      // goals reads as a typo rather than as the settlement it actually is.
      //
      // Nothing else catches it: both names are non-empty, the kickoff is a real
      // timestamp, the market is priced, and the sport is served as "Football".
      // It was inert only because no other book quotes the same thing, which is
      // a coincidence of the feed rather than a property of the contract.
      //
      // The test is the participants, not the league: a fixture names two clubs,
      // and these name the two sides of a table. Measured 2026-10-02 over all 24
      // books at maxEvents 3000, this shape is netbet's alone — casa-pariurilor
      // (777 events), winner (706) and fortuna (778) carry none, and the other
      // 73 netbet football events all name real clubs.
      if (isRoleName(home.name) || isRoleName(away.name)) continue;
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
              const name = selectionNameFor(o);
              if (!name) return null;
              // `handicap` stays null on the selection even though the outcome
              // carries a line, and the line is already in the name. findMiddles
              // pairs any two legs in one bucket whose handicaps differ, with
              // no check that they are the same SIDE of the contract: filling
              // this in would offer netbet's home leg at -7.5 against another
              // book's away leg at +7.5 and call the 15-point gap a middle.
              return { id: String(o.id ?? ''), name, odds, handicap: null };
            })
            .filter(Boolean);
          if (selections.length < 2) return null;
          return { key, name: m.name || key, period: periodFor(m), selections };
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
        // A true statement about the emitted set, not about the feed: only future
        // fixtures are emitted, and no measured field distinguishes a running
        // one. The `isLive` field that used to sit here was read by nobody.
        live: false,
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
      // Verified 2026-09-29 against a live all-sports inventory: 1,466 events
      // carry 2,761 markets across 16 market_codes that resolve into four
      // arbitrable families — `default` as MATCH_ODDS (3-way on the draw
      // sports, 2-way on the draw-less ones), `handicap` / `game_handicap` /
      // `goals_handicap` / `run_line` as ASIAN_HANDICAP, `total_goals` /
      // `total_points` / `total_games` / `total_run` / `total_frame` /
      // `ou_legs` as OVER_UNDER, and `btts` as BTTS. The earlier string said
      // 1x2 only, which understated what the run collects and hid three of
      // those four families from the report.
      coverage: { sports: this.sports.length, market: 'fulltime-1x2+asian_handicap+totals+btts', ...liveCoverageFor(this.id), maxEvents: this.maxEvents },
    };
  }
}

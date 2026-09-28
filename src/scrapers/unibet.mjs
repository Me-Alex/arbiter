import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { describeError, summariseReasons } from './feg-common.mjs';

/**
 * Unibet (RO) — Kindred XNS sports BFF.
 *
 * The old Kambi offer endpoint (`/api/kambi/offer/v1/betoffer/list.json`) is
 * gone, but the feed is NOT behind MQTT as the retired adapter's docblock
 * claimed. The live public REST surface is:
 *
 *   https://sportsbff-ams.kindredext.net/sports-api/api/v2/...
 *
 * Two things about that surface are not discoverable from a 404 and are the
 * reason this adapter exists at all:
 *
 *  1. The load balancer answers 400 `InvalidRequestException` (or 503) unless
 *     the request carries the tenant headers the site's own `getBFFClient`
 *     sends. Those are plain lowercase names — `locale`, `jurisdiction`,
 *     `ksp_jurisdiction`, `brand` — NOT the `X-Brand` / `X-Locale` pair the
 *     separate *betting* client uses. Sending the `X-` names produces a 400
 *     that looks exactly like a malformed query, and the response headers
 *     (`x-browser-class`) give no hint why.
 *  2. There is no bulk fixture list. `v2/contests/list` — the endpoint whose
 *     `GetFixtureContestsRequest` model carries `from`/`size` — answers 503 on
 *     every request and is not used by the site either. The working bulk path
 *     is two-hop: `az-menu` for the sport list, then one `views/lobby` per
 *     sport for its leagues, then one `views/lobby` per league for its
 *     contests. Contests live at
 *     `view.matches[].contestGroups[].contests[]` as `_typ: LobbyFixtureContest`
 *     — note that the landing page's widgets use a different type,
 *     `FixtureContest`, so matching on the wrong one silently finds nothing.
 *
 * The lobby returns a one-market preview per contest (the default `1x2`), which
 * is exactly the market the arb engine needs for a result comparison.
 */

/**
 * Sports whose `az-menu` key is crawled, measured 2026-09-28 against the live
 * feed: Football 697 events / 130 leagues, Tennis 267, IceHockey 109,
 * Basketball 97, AmericanFootball 77, TableTennis 68, ESports 57, Handball 25,
 * RugbyUnion 27, Mma 21, Baseball 13, Volleyball 10. The whole 30-sport menu
 * yields 1563 events in ~28s, so the default is the high-volume core rather
 * than everything — sports with no cross-book coverage add events the arb
 * engine can never pair.
 */
const DEFAULT_SPORTS = Object.freeze([
  'Football',
  'Tennis',
  'IceHockey',
  'Basketball',
  'AmericanFootball',
  'TableTennis',
  'ESports',
  'Handball',
  'RugbyUnion',
  'Mma',
  'Boxing',
  'Baseball',
  'Volleyball',
]);

const BFF = 'https://sportsbff-ams.kindredext.net/sports-api/api';

/**
 * Tenant headers. Names are the site's own; see the file header for why the
 * `X-` prefixed variants do not work.
 */
function tenantHeaders() {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    locale: 'ro_RO',
    jurisdiction: 'RO',
    ksp_jurisdiction: 'mga',
    brand: 'unibet',
    origin: 'https://www.unibet.ro',
    referer: 'https://www.unibet.ro/betting/odds',
  };
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** `views/lobby` needs all four of these or it 400s. */
function lobbyQuery(category) {
  return new URLSearchParams({
    category,
    clientOffset: '-120',
    sortBy: 'relevance',
    tab: 'matches',
    timeFilter: 'all',
  }).toString();
}

/** League categoryRns under a sport, from that sport's lobby view. */
export function leaguesIn(view) {
  const out = [];
  for (const accordion of view?.matches || []) {
    for (const child of accordion.children || []) {
      if (child && child.categoryRn) out.push(child.categoryRn);
    }
  }
  return out;
}

/**
 * Contests in a league lobby view.
 *
 * `view.matches[]` are date accordions whose `contestGroups[].contests[]` hold
 * the fixtures. `featuredMatches[]` repeats a handful of them at the top of the
 * page; both are read, and the caller dedupes by `contestKey`.
 */
export function contestsIn(view) {
  const out = new Map();
  const add = (c) => {
    if (c && c.contestKey) out.set(c.contestKey, c);
  };
  for (const accordion of view?.matches || []) {
    for (const group of accordion.contestGroups || []) {
      for (const c of group.contests || []) add(c);
    }
  }
  for (const featured of view?.featuredMatches || []) add(featured.contest || featured);
  return out;
}

/**
 * Render one `LobbyFixtureContestProposition` as an engine-shaped market.
 *
 * The market key is the provider's own `propositionType` (`1x2`, `total`, ...)
 * because the engine already routes both: `1x2` is a named MATCH_ODDS contract
 * and `TOTAL` is a named OVER_UNDER key whose line is read off the selections.
 *
 * Selection names are the bet as the customer sees it. For the result market
 * that is the literal `1` / `X` / `2` triple (`optionDisplayName`), which is
 * what lets the engine recognise a full-time result by shape. For totals the
 * line (`variantName`, e.g. `9.5`) is folded into the name, because the engine's
 * totals resolver extracts the line from the selection text — emitting a bare
 * `Peste` would bucket every total on the event together.
 *
 * @returns {object|null} null when the proposition has no two-sided price.
 */
function normalizeMarket(proposition) {
  const key = String(proposition?.propositionType || proposition?.propositionKey || '').trim();
  if (!key) return null;

  const selections = [];
  for (const option of proposition.options || []) {
    const odds = Number(option?.price);
    if (!Number.isFinite(odds) || odds <= 1) continue;
    if (option.bettingOpen === false) continue;

    const label = String(option.optionDisplayName || option.optionName || '').trim();
    if (!label) continue;

    // `variantName` is the line for over/under ("9.5"); for a plain 1x2 it is
    // "Plain" and must not leak into the selection name.
    const line = String(option.variantName || '').trim();
    const isOverUnder = key === 'total' || /^(TotalOver|TotalUnder)$/.test(String(option.optionType || ''));
    const name = isOverUnder && line && /^\d+(?:\.\d+)?$/.test(line) ? `${label} ${line}` : label;

    selections.push({
      id: String(option.priceKey || option.optionKey || ''),
      name,
      odds,
      handicap: isOverUnder ? line : null,
      group: 'Main',
    });
  }

  if (selections.length < 2) return null;
  return {
    id: String(proposition.key || proposition.propositionKey || key),
    key,
    // The provider's own market label. Kept out of `key` deliberately: the
    // engine's full-time guard reads `name` and rejects anything that names a
    // sub-settlement window, and Unibet's labels ("Rezultat final", "Total
    // goluri") are exactly the ones that must survive that check.
    name: String(proposition.displayName || key),
    period: 'fulltime',
    line: selections[0]?.handicap ?? null,
    selections,
  };
}

export default class UnibetScraper extends ScraperBase {
  id = 'unibet';
  name = 'Unibet';
  sourceIds = ['unibet'];

  constructor(opts = {}) {
    super(opts);
    // Three-hop traversal: 1 sports list + 1 lobby per sport + 1 per league.
    // Football alone is ~130 leagues, so the per-attempt deadline has to sit
    // well above the base default or the run aborts mid-crawl.
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.concurrency = Math.max(1, Number(opts.concurrency ?? 6));
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Math.min(Number(opts.maxEvents ?? 2000), 5000);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 5000) {
      throw new ValidationError('Unibet: invalid maxEvents');
    }
    const requested = Array.isArray(opts.sports) && opts.sports.length ? opts.sports : DEFAULT_SPORTS;
    this.sports = [...new Set(requested.map(String))];
    this.observedAt = new Date().toISOString();
  }

  /**
   * One request against the BFF, with retry on the load balancer's transient
   * 503. A 400 is NOT retried: it means the tenant headers are wrong, and
   * retrying it just spends the whole run's budget proving the same thing.
   */
  async _get(path, { signal, stats }) {
    const url = `${BFF}/${path}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, ...tenantHeaders() },
          signal,
          redirect: 'error',
        });
        if (res.ok) {
          stats.attempted += 1;
          return JSON.parse(await res.text());
        }
        if (res.status !== 503 && res.status !== 429) {
          stats.attempted += 1;
          stats.record(path, `HTTP ${res.status}`);
          return null;
        }
        stats.record(path, `HTTP ${res.status}`);
      } catch (err) {
        if (signal?.aborted) throw err;
        stats.record(path, describeError(err));
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    return null;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.observedAt = new Date().toISOString();

    const stats = {
      attempted: 0,
      failed: 0,
      reasons: new Map(),
      record(stage, why) {
        this.failed += 1;
        const key = `${stage}: ${why}`;
        this.reasons.set(key, (this.reasons.get(key) || 0) + 1);
      },
    };

    const azMenu = await this._get('v2/views/az-menu', { signal, stats });
    if (!azMenu) {
      throw new UpstreamError(
        `Unibet: az-menu unavailable — ${summariseReasons(stats.reasons)}. ` +
          'The BFF rejects requests without the locale/jurisdiction/ksp_jurisdiction/brand tenant headers.',
      );
    }

    const available = new Map((azMenu.items || []).map((i) => [String(i.key), i.displayName]));
    const wanted = this.sports.filter((s) => available.has(s));
    const missing = this.sports.filter((s) => !available.has(s));
    if (missing.length) {
      this.logger('warn', `Unibet: sports not offered by the feed: ${missing.join(', ')}`);
    }
    this.logger('info', `Unibet: crawling ${wanted.length} sports (${wanted.join(', ')})`);

    /** @type {Map<string, object>} contestKey → contest */
    const events = new Map();
    let leagues = 0;

    for (const sport of wanted) {
      signal?.throwIfAborted();
      const sportView = await this._get(`v2/views/lobby?${lobbyQuery(sport)}`, { signal, stats });
      const sportLeagues = sportView ? leaguesIn(sportView.view) : [];
      leagues += sportLeagues.length;

      // Seed from the sport view itself: its featuredMatches are real contests
      // and come free with the league list.
      if (sportView) {
        for (const [key, contest] of contestsIn(sportView.view)) {
          if (!events.has(key)) events.set(key, { ...contest, _sport: sport, _league: contest.category });
        }
      }

      const queue = [...sportLeagues];
      await Promise.all(
        Array.from({ length: this.concurrency }, async () => {
          while (queue.length) {
            signal?.throwIfAborted();
            const league = queue.shift();
            const view = await this._get(`v2/views/lobby?${lobbyQuery(league)}`, { signal, stats });
            if (!view?.view) continue;
            for (const [key, contest] of contestsIn(view.view)) {
              if (events.has(key)) continue;
              events.set(key, { ...contest, _sport: sport, _league: league });
            }
          }
        }),
      );
      this.logger('info', `Unibet: ${sport} — ${sportLeagues.length} leagues, ${events.size} events so far`);
    }

    if (stats.attempted > 0 && stats.failed >= stats.attempted) {
      throw new UpstreamError(`Unibet: all ${stats.attempted} requests failed — ${summariseReasons(stats.reasons)}`);
    }
    if (events.size === 0) {
      throw new UpstreamError(`Unibet: ${leagues} leagues crawled, 0 contests — ${summariseReasons(stats.reasons)}`);
    }

    this.sourceUrl = `${BFF}/v2/views/az-menu`;
    this.discovery = { sports: wanted.length, leagues, contests: events.size };
    this.extraction = { ok: 0, failed: 0 };
    return { contests: [...events.values()] };
  }

  normalize(raw) {
    const contests = raw?.contests;
    if (!Array.isArray(contests)) throw new ValidationError('Unibet: missing contests');

    const out = [];
    for (const contest of contests) {
      const kickoffRaw = contest?.startDateTimeUtc?.value || contest?.startDateTimeUtc?.unixms;
      const kickoff = new Date(typeof kickoffRaw === 'number' ? kickoffRaw : kickoffRaw);
      if (!Number.isFinite(+kickoff)) continue;

      const markets = [];
      // One market per (type, line): the lobby can repeat a propositionType
      // (Unibet lists "Rezultat final" and "Cote meci" as two 1x2 markets on
      // some events). Emitting both would put two full-time result legs in the
      // same engine bucket, so the first priced one wins.
      const taken = new Set();
      for (const proposition of contest.propositions || []) {
        const market = normalizeMarket(proposition);
        if (!market) continue;
        const slot = `${market.key}@${market.line ?? '_'}`;
        if (taken.has(slot)) continue;
        taken.add(slot);
        markets.push(market);
      }
      if (markets.length === 0) continue;

      const { home, away } = resolveTeams(contest);
      if (!home || !away) continue;

      out.push({
        id: String(contest.contestKey),
        sport: String(contest.contestType || contest._sport || 'Unknown'),
        league: leagueNameOf(contest, contest._league),
        kickoff: kickoff.toISOString(),
        homeTeam: home,
        awayTeam: away,
        status: contest.status || 'PreGame',
        markets,
      });
    }
    return out;
  }

  extractEvents(rawEvents) {
    const out = [];
    const seen = new Set();
    for (const r of rawEvents) {
      if (out.length >= this.maxEvents) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.markets.length === 0) continue;

      const eventKey = [
        normalizeTeamName(r.sport),
        normalizeTeamName(r.league),
        r.kickoff,
        normalizeTeamName(r.homeTeam),
        normalizeTeamName(r.awayTeam),
      ].join('|');

      out.push({
        id: r.id,
        sourceId: 'unibet',
        sourceUrl: this.sourceUrl,
        transport: 'kindred-sports-bff-v2',
        observedAt: this.observedAt,
        status: r.status,
        sport: r.sport,
        league: r.league,
        kickoff: r.kickoff,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        eventKey,
        markets: r.markets,
      });
    }
    if (this.extraction) this.extraction.ok = out.length;
    return out;
  }

  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      sourceUrl: 'https://www.unibet.ro/betting/odds',
      transport: 'kindred-sports-bff-v2',
      observedAt: this.observedAt,
      coverage: {
        sport: this.sports.length > 1 ? 'multi-sport' : this.sports[0],
        allMarkets: false,
        live: true,
        maxEvents: this.maxEvents,
      },
    };
  }
}

/**
 * Deepest `categoriesDetailed` entry is the league. The feed orders it from most
 * to least specific, so the first entry is the league the fixture belongs to;
 * `category` is the fallback for a contest that carries no detail list.
 */
function leagueNameOf(contest, fallback) {
  const detailed = contest?.categoriesDetailed;
  if (Array.isArray(detailed) && detailed.length && detailed[0]?.name) return String(detailed[0].name);
  if (typeof contest?.category === 'string' && contest.category) return contest.category.split(':').pop();
  return String(fallback || 'unknown');
}

/**
 * Home and away from the result market's own options.
 *
 * Read off the *proposition*, not the normalised market. The market's
 * selections are deliberately the literal `1` / `X` / `2` labels the engine
 * needs to recognise a full-time result, so the team names have to come from
 * the provider's `optionName` on the `T1` / `T2` options instead — they are
 * already normalised by the feed (correct diacritics, no trailing " (Live)").
 *
 * Falls back to splitting the contest's `"A vs B"` label, which is all the feed
 * gives when the result market is not priced yet.
 */
function resolveTeams(contest) {
  for (const proposition of contest.propositions || []) {
    if (proposition.propositionType !== '1x2') continue;
    let home = '';
    let away = '';
    for (const option of proposition.options || []) {
      const name = String(option.optionName || '').trim();
      if (!name) continue;
      if (option.optionType === 'T1') home = name;
      else if (option.optionType === 'T2') away = name;
    }
    if (home && away) return { home, away };
  }
  const label = String(contest?.name || '');
  const parts = label.split(/\s+vs\.?\s+/i);
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
    return { home: parts[0].trim(), away: parts[1].trim() };
  }
  return { home: '', away: '' };
}

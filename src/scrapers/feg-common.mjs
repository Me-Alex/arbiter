import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { fegMarketIsLive, eventIsLive, liveCoverageFor } from './live-status.mjs';

export const FEG_SPORT_NAMES = Object.freeze({
  'ufo:sprt:00': 'Football', 'ufo:sprt:01': 'Tennis', 'ufo:sprt:02': 'Basketball',
  'ufo:sprt:03': 'Ice Hockey', 'ufo:sprt:04': 'Handball', 'ufo:sprt:07': 'Rugby',
  'ufo:sprt:09': 'Darts', 'ufo:sprt:11': 'Futsal',
});

/**
 * Market types this feed publishes that must not be published onward.
 *
 * A closed list, keyed on the provider's own market-type id rather than on the
 * display name, because the name is a translation layer and the id is the
 * vocabulary: the football namespace `00` on this feed holds exactly ten types
 * with one name each, and a name test would go stale on a rename while an id
 * test cannot.
 *
 * `ufo:mtyp:00-10` "Echipa 1 Total goluri <line>" and `ufo:mtyp:00-13` "Echipa 2
 * Total goluri <line>" are ONE TEAM's own goal total. They resolve as
 * ASIAN_HANDICAP — a match spread — because their legs are bare signed numbers
 * ("+ 4.5" / "- 4.5"), and that is the one shape the engine's line resolver
 * cannot decline. Neither ASIAN_HANDICAP nor OVER_UNDER carries a subject
 * dimension, so a team's goals cannot be expressed through either: the market
 * would bucket beside another book's match handicap on the same half line and
 * settle on a different event. Measured 2026-10-02 on this feed: 3 such markets
 * across 763 live football events, all agreeing with their id.
 *
 * The match handicap on this feed is `ufo:mtyp:00-0b`, whose legs carry the
 * team names; it is unaffected. `scanner/market-contracts.mjs` refuses these two
 * ids authoritatively as well, because this catalogue is not the only thing that
 * can produce them.
 *
 * Measured on one live download on 2026-10-02, the withholding costs exactly
 * the withheld rows and nothing else: four fixtures carried a team total and
 * every one of them kept its other markets (00-00, 00-0u, 00-1c), so no fixture
 * is lost and no priced line is thinned. All ten football market types walked
 * unchanged — 00-00 762, 00-0u 233, 00-1c 23, 00-0b 1, 00-9b 1 — with 00-10
 * going 3 -> 0 and 00-13 at 0 that day.
 */
const FEG_WITHHELD_MARKET_TYPES = Object.freeze(new Set([
  'ufo:mtyp:00-10', // Echipa 1 Total goluri
  'ufo:mtyp:00-13', // Echipa 2 Total goluri
]));

/** @param {string} marketTypeId @returns {boolean} */
export const isFegMarketTypeWithheld = (marketTypeId) =>
  FEG_WITHHELD_MARKET_TYPES.has(String(marketTypeId || '').toLowerCase());

/**
 * The one line that says why a request failed.
 *
 * `fetch` wraps everything in a generic `TypeError: fetch failed` and hides
 * the real cause on `cause`, which is where a DNS failure, a refused
 * connection, a TLS rejection and a timeout each end up. Reported bare, they
 * are four different problems that look like one — and the difference decides
 * whether the fix is a header, a retry, or accepting that the provider blocks
 * this network.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  if (!err) return 'unknown error';
  const cause = err.cause || {};
  const detail = cause.code || cause.message || err.code || err.message || String(err);
  // Undici appends "fetch failed" to every one of these, so the name carries
  // nothing; the cause is the whole story.
  return String(detail).replace(/\s*\(?fetch failed\)?\s*$/i, '').trim() || 'unknown error';
}

/**
 * Render accumulated failure causes for an error message.
 *
 * Deduplicated by the recorder, so this reads as "catalogue: HTTP 403 × 13"
 * rather than the same line thirteen times — one representative per cause is
 * enough, and the count says how widespread it was.
 *
 * @param {Map<string, number>} reasons  key → occurrences
 * @param {number} [limit]
 * @returns {string}
 */
export function summariseReasons(reasons, limit = 3) {
  if (!reasons || reasons.size === 0) return 'no reason recorded';
  return [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([why, n]) => (n > 1 ? `${why} ×${n}` : why))
    .join('; ');
}

/**
 * Human-readable label for a FEG sport id.
 *
 * The catalogue lists ids this table has no name for (23, 26, 27, 29, 35).
 * Returning a shared 'Unknown' for all of them gives every unmapped sport the
 * same `sport` value, and since the sport is part of the event identity key,
 * fixtures from different unmapped sports can collide into one event. Naming
 * the id keeps them apart and says plainly that the label is not known.
 *
 * @param {string} sportId
 * @returns {string}
 */
export function fegSportName(sportId) {
  const known = FEG_SPORT_NAMES[sportId];
  return known || `Unknown (${sportId})`;
}

export function normalizeFegMarket(m) {
  const selections = (m.outcomes || []).map(o => ({
    id: String(o.id || ''), name: String(o.name || '').trim(),
    odds: Number(o.odds ?? NaN), handicap: o.handicap ?? null,
  })).filter(s => s.name && Number.isFinite(s.odds) && s.odds > 1);
  if (selections.length < 2) return null;
  // Opaque provider IDs and 1/X/2 labels do not establish settlement rules.
  return { id: m.id, key: m.marketTypeId || 'unknown', name: m.name || 'Market',
    period: m.period || 'unknown', line: m.line ?? null, selections };
}

const FEG_MATCHES_PATH = '/offer/structure/api/v1_0/tournament/';
const FEG_MARKETS_PATH = '/offer/markets/api/v1_0/fixtures/markets/overview';
/** Batch size for market hydration. */
const FEG_BATCH_SIZE = 50;

/**
 * Sport ids the FEG catalogue is walked for, in traversal order.
 *
 * The ids past `ufo:sprt:11` have no friendly name in `FEG_SPORT_NAMES`; they
 * are still walked because the provider lists live fixtures under them and
 * `fegSportName` keeps them apart by naming the raw id (see there). The two
 * brands of this feed (Fortuna, Casa Pariurilor) expose the same catalogue, so
 * this list is shared rather than copied.
 */
const FEG_SPORT_IDS = Object.freeze([
  'ufo:sprt:00', // Football
  'ufo:sprt:01', // Tennis
  'ufo:sprt:02', // Basketball
  'ufo:sprt:03', // Ice Hockey
  'ufo:sprt:04', // Handball
  'ufo:sprt:07', // Rugby
  'ufo:sprt:09', // Darts
  'ufo:sprt:11', // Futsal
  'ufo:sprt:23', 'ufo:sprt:26', 'ufo:sprt:27', 'ufo:sprt:29', 'ufo:sprt:35',
]);

const FEG_HEADERS = Object.freeze({
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
});

/**
 * FegCatalogueScraper — the shared multi-sport catalogue traversal behind the
 * two brands of the Fortuna BFF (fortuna, casa-pariurilor).
 *
 * Both brands are resold from one upstream (see the `fortuna-bff` feed group in
 * scanner/feed-groups.mjs), so they walk the identical pipeline against their
 * own hostname: sport catalogue → per-tournament match lists → batched market
 * overview. This class holds that one traversal; a brand supplies only its
 * `apiBase` and the `transport` label that appears on its events.
 *
 * `sourceId` is taken from `this.id`, not a literal, so a brand can never
 * publish under another brand's id.
 */
export class FegCatalogueScraper extends ScraperBase {
  /** @type {string} per-brand upstream origin, e.g. https://api.efortuna.ro */
  apiBase = '';
  /** @type {string} provenance label stamped on each event, e.g. fortuna-catalogue-v1 */
  transport = '';

  constructor(opts = {}) {
    super(opts);
    // The traversal performs ~13 sport catalogue requests + up to ~120
    // tournament match-list requests + market-overview batches, which routinely
    // takes 25-60s. Keep the per-attempt deadline well above that so the base
    // class doesn't abort the whole run mid-traversal.
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxAttempts = opts.maxAttempts ?? 1;
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Math.min(Number(opts.maxEvents ?? 100), 5000);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 5000) {
      throw new ValidationError(`${this.id}: invalid maxEvents`);
    }
    // This feed publishes in-play markets, so the flag is honoured here rather
    // than warned about. It was previously ignored entirely, and the class had
    // no field to read.
    this.includeLive = opts.includeLive === true;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.observedAt = new Date().toISOString();
    const headers = { ...FEG_HEADERS };

    // Per-request failure accounting. Every step below swallows individual
    // failures so one dead tournament does not lose the other 120, but a run in
    // which every request failed must not be reported as a successful empty
    // scrape: that is indistinguishable from a quiet day.
    let attempted = 0;
    let failed = 0;
    // Why the requests failed, not just how many. Without this, a refused
    // connection, a 403 and a malformed body all surface as the same line —
    // "all 13 catalogue requests failed" — which is the one message you cannot
    // act on, because it names none of the three causes.
    const reasons = new Map();
    const recordFailure = (stage, why) => {
      failed += 1;
      const key = `${stage}: ${why}`;
      reasons.set(key, (reasons.get(key) || 0) + 1);
    };

    // Step 1: fetch the tournament catalogue for every sport.
    const allTournaments = [];
    for (const sportId of FEG_SPORT_IDS) {
      signal?.throwIfAborted();
      attempted += 1;
      try {
        const url = `${this.apiBase}/offer/structure/api/v1_0/sport/${sportId}/tournaments?categories=true&timeFilter=all`;
        const catResp = await fetch(url, { signal, headers });
        if (!catResp.ok) { recordFailure('catalogue', `HTTP ${catResp.status}`); continue; }
        const catData = await catResp.json();
        for (const t of (catData.tournaments || [])) {
          t._sportId = sportId;
          t._sportName = fegSportName(sportId);
          allTournaments.push(t);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        recordFailure('catalogue', describeError(err));
      }
    }
    const withFixtures = allTournaments.filter((t) => t.fixturesCount > 0);
    this.logger('info', `${this.name}: ${withFixtures.length} tournaments with fixtures across ${FEG_SPORT_IDS.length} sports`);

    // Step 2: fetch matches from each tournament that has any.
    const allFixtures = [];
    const tourMap = new Map();
    for (const t of allTournaments) tourMap.set(t.id, t);

    for (const t of withFixtures) {
      signal?.throwIfAborted();
      attempted += 1;
      try {
        const url = `${this.apiBase}${FEG_MATCHES_PATH}${encodeURIComponent(t.id)}/matches`;
        const resp = await fetch(url, { signal, headers });
        if (!resp.ok) { recordFailure('matches', `HTTP ${resp.status}`); continue; }
        const data = await resp.json();
        const fixtures = data.fixtures || [];
        for (const f of fixtures) {
          f._tournamentName = t.name;
          f._tournamentSeoName = t.seoName || t.name;
          f._categorySeoName = t.categorySeoName || '';
          // Stamped by the catalogue loop above for every tournament —
          // fegSportName is total, so there is no missing case here to
          // default. The honest fallback for a fixture that reaches
          // normalize() without a tree label lives there, in normalize().
          f._sportName = t._sportName;
          allFixtures.push(f);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        recordFailure('matches', describeError(err));
      }
    }
    this.logger('info', `${this.name}: ${allFixtures.length} fixtures from catalogue`);

    // Step 3: hydrate markets in batches.
    const fixtureIds = allFixtures.map((f) => f.id);
    const marketsByFixture = new Map();
    for (let i = 0; i < fixtureIds.length; i += FEG_BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = fixtureIds.slice(i, i + FEG_BATCH_SIZE);
      attempted += 1;
      try {
        const params = batch.map((id) => 'fixtureIds=' + encodeURIComponent(id)).join('&');
        const url = `${this.apiBase}${FEG_MARKETS_PATH}?${params}`;
        const resp = await fetch(url, { signal, headers });
        if (!resp.ok) { recordFailure('markets', `HTTP ${resp.status}`); continue; }
        const data = await resp.json();
        for (const [fid, mkts] of Object.entries(data)) {
          if (Array.isArray(mkts) && mkts.length > 0) {
            marketsByFixture.set(fid, mkts);
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        recordFailure('markets', describeError(err));
      }
    }
    this.logger('info', `${this.name}: ${marketsByFixture.size} fixtures with hydrated markets`);

    // Total upstream failure is a failed run, not an empty one: a scrape that
    // collected nothing because every request failed is not a quiet market day.
    // Partial failure still returns what was collected, and the counters travel
    // with the payload so the shortfall is visible in the run report.
    if (attempted > 0 && failed === attempted) {
      // `attempted` counts every request across all three phases, so the stage
      // in each recorded reason is what tells you which phase died.
      throw new UpstreamError(
        `${this.name}: all ${attempted} requests failed — ${summariseReasons(reasons)}`,
      );
    }
    this.sourceUrl = `${this.apiBase}/offer/structure/api/v1_0/sport/tournaments`;
    return { tournaments: [...tourMap.values()], fixtures: allFixtures, marketsByFixture };
  }

  normalize(raw) {
    if (!raw?.fixtures) throw new ValidationError(`${this.name}: missing fixtures`);
    const out = [];
    for (const fix of raw.fixtures) {
      const homeP = (fix.participants || []).find((p) => p.type === 'HOME');
      const awayP = (fix.participants || []).find((p) => p.type === 'AWAY');
      if (!homeP?.name || !awayP?.name) continue;
      const kickoff = new Date(fix.startDatetime);
      if (!Number.isFinite(+kickoff)) continue;
      const mkts = (raw.marketsByFixture || new Map()).get(fix.id) || [];
      if (mkts.length === 0) continue;
      // A FIXTURE'S OWN sportId, not the tree it was discovered under.
      //
      // The traversal walks one catalogue per sport and stamps each fixture
      // with that tree's label, which is right for every sport this feed maps —
      // measured 2026-10-02 across all 890 fixtures, the tree label and the
      // fixture's own `sportId` agree exactly on football (775/775, 103 real
      // tournaments, 0 esports), tennis, basketball, darts, handball, ice
      // hockey, futsal, rugby and on the unmapped ids 26, 27 and 35.
      //
      // They disagree on exactly one group. Four fixtures found under the
      // FOOTBALL tree carry `sportId: ufo:sprt:0c`, an id absent from
      // FEG_SPORT_NAMES, and all four are esports battles: "Esports Battle -
      // Liga Campionilor (2x6 min.)" and "Esports Battle - Serie A (2x4 min.)",
      // with a player alias welded onto a real club — "Juventus (Pex) v
      // B Dortmund (ZORO)", "Colombia (mPm) v Ecuador (ramzes)". Stamped from
      // the tree they were published as football, and their totals resolved into
      // the engine's football OVER_UNDER buckets.
      //
      // The parenthesised format is the tell and the reason those lines looked
      // impossible: "(2x4 min.)" is a best-of-two-then-four battle series, so
      // its total counts ROUNDS won, not goals. That is where the single-book
      // O/U 9.5, 11.5 and 12.5 rows in the coverage report came from — not
      // football markets at all, and not fixable by listing tournament names,
      // since the provider writes the same prefix on every one of them. Nor by
      // the parenthesised alias, which real clubs carry too.
      //
      // Reading the fixture's own field instead fixes the whole group and needs
      // no maintained list: `ufo:sprt:0c` has no name here, so `fegSportName`
      // renders it exactly as it already renders 26, 27 and 35 — "Unknown
      // (ufo:sprt:0c)" — which keeps it out of the football path and keeps it
      // apart from every other unmapped sport in the event key. The field is
      // preferred, not required: a fixture without one still falls back to the
      // tree label, as before.
      const ownSportId = String(fix.sportId || '').trim();
      out.push({
        id: fix.id,
        sport: ownSportId ? fegSportName(ownSportId) : (fix._sportName || 'Unknown'),
        league: fix._tournamentSeoName || 'unknown',
        kickoff: kickoff.toISOString(),
        homeTeam: homeP.name,
        awayTeam: awayP.name,
        markets: mkts,
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

      // The provider tags every MARKET, not the fixture: `kind` is `LIVE` or
      // `PREMATCH`, measured categorical and disjoint against the kickoff. It is
      // read off the raw market because `normalizeFegMarket` reduces a market to
      // the engine's shape and the kind does not survive that — which is how a
      // live 1X2 ended up indistinguishable from a pre-match one.
      //
      // Dropping live markets when the caller did not ask for them is what makes
      // `includeLive` mean something here. This adapter never filtered on
      // kickoff, so a pre-match run still carried in-play prices to the scanner,
      // which discarded the whole event and took the fixture's pre-match markets
      // with it.
      const markets = (r.markets || [])
        .filter((m) => !isFegMarketTypeWithheld(m?.marketTypeId))
        .filter((m) => this.includeLive || !fegMarketIsLive(m))
        .map((m) => {
          const normalized = normalizeFegMarket(m);
          if (!normalized) return null;
          normalized.live = fegMarketIsLive(m);
          return normalized;
        })
        .filter(Boolean);
      if (markets.length === 0) continue;

      const eventKey = [
        normalizeTeamName(r.sport), normalizeTeamName(r.league), r.kickoff,
        normalizeTeamName(r.homeTeam), normalizeTeamName(r.awayTeam),
      ].join('|');

      out.push({
        id: r.id, sourceId: this.id, sourceUrl: this.sourceUrl,
        transport: this.transport, observedAt: this.observedAt,
        sport: r.sport, league: r.league, kickoff: r.kickoff,
        homeTeam: r.homeTeam, awayTeam: r.awayTeam, eventKey,
        // True when ANY market on the fixture is in-play. The scanner's
        // `includeLive` gate and the 90-second live freshness window both read
        // this field, so leaving it undefined is what kept a live fixture
        // invisible: it was dropped on kickoff like a finished match.
        live: eventIsLive({ markets }),
        markets,
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      sourceUrl: this.sourceUrl, transport: this.transport,
      observedAt: this.observedAt,
      // Multi-sport: the traversal walks every sport in the catalogue, so
      // claiming `football` here misdescribed what the run actually collected.
      // `live` is the measured capability of THIS brand's feed, and
      // `liveCollected` is whether this run took its in-play markets — the two
      // were one blanket `false` before, which said the same thing about all 24
      // books and was true in detail of none of them.
      coverage: {
        sport: 'multi-sport',
        allMarkets: true,
        ...liveCoverageFor(this.id),
        liveCollected: this.includeLive,
        maxEvents: this.maxEvents,
      },
    };
  }
}

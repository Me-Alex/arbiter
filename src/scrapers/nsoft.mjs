import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';

/**
 * The football sportId, per tenant.
 *
 * There is no global NSoft sport numbering: each tenant numbers its own
 * catalogue. Measured on 2026-09-26, football is id 4 for the Admiral /
 * Stanleybet tenant and id 2 for MaxBet's — the same feed, two tenants, two
 * numberings. A single shared table therefore mislabels at least one of them,
 * and a mislabel matters: the emitted `sport` is part of the event identity
 * key, so a MaxBet event published as "Basketball" can never pair with another
 * book's football event.
 *
 * The values come from correlating each tenant's own tournament labels with
 * its sport ids on a live capture, not from a shared list.
 */
const TENANT_FOOTBALL_SPORT = Object.freeze({
  admiral: 4,
  stanleybet: 4,
  maxbet: 2,
  betmen: 18,
});

/**
 * The full-time result contract, per tenant: which market is the match result,
 * what it is called, and which outcome ids carry 1 / X / 2.
 *
 * There is no global NSoft numbering here either. Measured live on 2026-09-27
 * by tallying every active, priced three-outcome market on each tenant's own
 * football events:
 *
 *   admiral / stanleybet   marketId 1  "Rezultat Final"   outcomes 1:1  4:X  7:2
 *   maxbet                 marketId 2  "Final"             outcomes 2:1  5:X  8:2
 *   betmen                 marketId 6  "Final"             outcomes 6:1  9:X  12:2
 *
 * The top shape covered 98.7%, 91.8% and 100% of football events respectively,
 * which is what makes each one the result market rather than a coincidental
 * three-way bet.
 *
 * This replaces a two-branch `maxbet ? 2 : 1` test. That test encoded two of
 * these three tenants, so a third was wired to the wrong market id and would
 * have published nothing at all — the failure mode this project has already
 * been bitten by once, when MaxBet's football was mislabelled and no MaxBet
 * event could pair with another book.
 */
const TENANT_RESULT_MARKET = Object.freeze({
  admiral: Object.freeze({ marketId: 1, name: 'Rezultat Final', outcomes: Object.freeze([[1, '1'], [4, 'X'], [7, '2']]) }),
  stanleybet: Object.freeze({ marketId: 1, name: 'Rezultat Final', outcomes: Object.freeze([[1, '1'], [4, 'X'], [7, '2']]) }),
  maxbet: Object.freeze({ marketId: 2, name: 'Final', outcomes: Object.freeze([[2, '1'], [5, 'X'], [8, '2']]) }),
  betmen: Object.freeze({ marketId: 6, name: 'Final', outcomes: Object.freeze([[6, '1'], [9, 'X'], [12, '2']]) }),
});

/**
 * The arbitrage-eligible extras each tenant's feed serves beyond the 1X2, by the
 * same per-tenant, measured-from-the-feed discipline as the result market
 * above. These are the totals, both-teams-to-score and two-way Asian handicap
 * contracts, keyed by marketId so a tenant's own numbering is used rather than a
 * shared guess.
 *
 * Measured on 2026-09-26 from each tenant's football responses:
 *
 *   admiral / stanleybet   totals 886 "Total goluri S/P"   BTTS 2056 "Ambele Inscriu"
 *                          AH 262 "Handicap"
 *   maxbet                 totals 1547 "Total goluri"     BTTS 1709 "Ambele marchează"
 *                          AH 8 "Handicap Asiatic"
 *
 * `betmen` was listed here as "intentionally absent, and not merely
 * unmeasured" — the claim being that its football projection carried the result
 * market, one half-time/full-time combined market and nothing else, so there
 * was no id to go looking for. That was WRONG, and a capture taken on
 * 2026-09-29 over 293 football events in a 72h window falsifies it: besides
 * "Final", betmen serves "Ambele Marcheaza" (both teams to score) on 261 of
 * them. Only the BTTS id is claimed, and only because it is the one market
 * there that is provably an exhaustive two-way contract:
 *
 *   betmen 4607 "Ambele Marcheaza"  BTTS, GG/NG, 261 of 293 football events
 *
 * Its totals markets are deliberately NOT claimed, and the absence is measured
 * rather than assumed. betmen quotes them as a single four-outcome market whose
 * legs are goal INTERVALS and push lines — 3960 "Total Goluri (TG)" carries
 * "2-4", "2-5", "2+" and "3+" together, and 2439/2442 do the same for the first
 * and second half. There is no over leg and no under leg to pair, the lines are
 * not a single shared value, and `specialValues` is empty, so the line cannot
 * even be read. Publishing "2-4" as one side of a goals total would invent an
 * Over 1.5 / Under 4.5 contract that betmen never quoted.
 *
 * betmen also publishes no handicap on football at all (the 15 market ids
 * measured on the projection contain none), so `ah` stays absent rather than
 * being borrowed from maxbet's id 8 — a tenant's ids are its own.
 *
 * Re-measured 2026-09-29 over the full 72h window at maxEvents 3000: 1,247
 * football events carry exactly 15 distinct `marketId|name` pairs, and all 15
 * are accounted for — `6` Final and `4607` Ambele Marcheaza claimed; 3960,
 * 4008, 3501, 2439 and 2442 are interval or per-team goal buckets; 2484, 3504,
 * 2532 and 2259 are combined legs; 2445 and 398 are pause-or-final and
 * pause/full pairings. None of the remaining 13 is a full-time exhaustive
 * two-way contract, so the tenant's contribution is complete at two families.
 *
 * Two of them are worth naming because they LOOK claimable and are not:
 *
 *   betmen 2517 "Castiga minim o repriza"   1/2 on 1,040 events
 *   betmen 4412 "Avantaj la 2 goluri"       1/2 on 50 events
 *
 * Both carry bare `1` and `2` legs and no `specialValues`, which is exactly the
 * shape a two-way match winner has, so `resolveContract` answers MATCH_ODDS for
 * both on shape alone. Neither is a match winner. 2517 settles on whether a
 * team wins AT LEAST ONE HALF, and a 0-0 leaves both legs undecided, so the
 * pair is not exhaustive; 4412 is a two-goal ADVANTAGE, a handicap on a whole
 * line, where the level result pushes both legs. Publishing either would put a
 * non-surebet in a MATCH_ODDS bucket beside books quoting the real thing.
 *
 * The names also carry the distinction the shape cannot: this feed's handicap
 * markets are `524 "Handicap (incl. OT)"` and `530 "Total puncte (incl. OT)"`,
 * on 1,123 and 1,415 events, and `524` has exactly the H1/H2 half-line shape
 * `_asianHandicapMarkets` is built for. It is BASKETBALL — sport id 36, whose
 * tournaments read "Grecia - A1", "PAOK v AO Mykonos" — and it settles including
 * extra time, so it is neither the projection nor the window anyone else
 * publishes. Measured 2026-09-29: 0 of the 1,247 football events carry it.
 *
 * The market NAME is recorded alongside the id and required on read, because a
 * marketId alone is not a contract. The same feed also serves, under other ids,
 * markets that look similar but settle differently, and requiring the name is
 * what keeps them out:
 *
 *   maxbet 389  "Handicap game-uri"        handicap on goals scored, not the result
 *   maxbet 770  "Handicap 1X2"             three-way, with an HX draw outcome
 *   maxbet 497  "Handicap (Incl.prelungiri)" settles including extra time
 *   maxbet 530  "PR Handicap"              first period
 *   admiral 526 "Handicap (incl prel)"     likewise, extra time
 *   admiral 208 "Prima Rep - Total Goluri" first-half total
 *   maxbet 1571/1574 "Total goluri echipa 1/2"  one team's goals
 *   maxbet 1700  "Ambele marchează sau peste 2.5 goluri"  a single leg
 *   betmen 2532 "Sansa Dubla & Total Goluri (TG)"       combined legs, not a total
 *   betmen 3504 "Combinatii de GG"                     a GG/over combination
 *   betmen 2259 "Marcheaza (GG)"                       scores plus a GG leg
 *
 * A scoring handicap routed to ASIAN_HANDICAP would let a goals-scored price
 * stand in for another book's result handicap and be reported as arbitrage
 * that does not exist, so the name gate is the whole safety mechanism here.
 *
 * MaxBet also serves a second Asian handicap, 779 "Handicap asiatic", which is
 * deliberately not wired here: in the capture it appears only on sport id 17
 * events, never on a football one (0 of 136), and its markets carry a period
 * marker the football handicap does not. A tenant's own sport numbering is
 * exactly the trap this file documents elsewhere, so id 8 — measured on
 * football — is the only one claimed here.
 */
const TENANT_EXTRAS = Object.freeze({
  admiral: Object.freeze({ totals: Object.freeze({ marketId: 886, name: 'Total goluri S/P' }), btts: Object.freeze({ marketId: 2056, name: 'Ambele Inscriu' }), ah: Object.freeze({ marketId: 262, name: 'Handicap' }) }),
  stanleybet: Object.freeze({ totals: Object.freeze({ marketId: 886, name: 'Total goluri S/P' }), btts: Object.freeze({ marketId: 2056, name: 'Ambele Inscriu' }), ah: Object.freeze({ marketId: 262, name: 'Handicap' }) }),
  maxbet: Object.freeze({ totals: Object.freeze({ marketId: 1547, name: 'Total goluri' }), btts: Object.freeze({ marketId: 1709, name: 'Ambele marchează' }), ah: Object.freeze({ marketId: 8, name: 'Handicap Asiatic' }) }),
  // BTTS only. Measured 2026-09-29 on 293 football events: 261 carry this
  // market, and _bttsMarket needs no new code for it — betmen's sides are "GG"
  // and "NG", both already in BTTS_YES / BTTS_NO, and specialValues is empty as
  // the guard expects. This is a 100% clean add of a whole family the tenant
  // was contributing none of.
  betmen: Object.freeze({ btts: Object.freeze({ marketId: 4607, name: 'Ambele Marcheaza' }) }),
});

/**
 * Canonical BTTS selection names, and the provider spellings that map onto them.
 *
 * The tenants disagree on how they label the two sides — the Admiral/Stanleybet
 * feed says "GG"/"NGG" while MaxBet's says "Da"/"Nu" — and the engine's BTTS
 * matcher does not read "NGG" (its no-marker `\b(ng)\b` cannot match inside it),
 * so an Admiral BTTS leg published under its raw name would resolve to no
 * contract at all and be dropped from every comparison. The side is therefore
 * recognised from the provider's own word and emitted under the canonical
 * Romanian pair the matcher accepts. This is a recognition alias, not a
 * relabel: `providerOutcomeId` still carries the feed's own outcome id.
 */
const BTTS_YES = /^(?:gg|da|yes|y)$/i;
const BTTS_NO = /^(?:ngg|ng|nu|no|n)$/i;

/**
 * A label for any sport id, used only for the sport name on an event. The
 * numbers are not comparable between tenants, so an unrecognised id is named
 * after the id itself rather than guessed — a wrong sport label breaks event
 * matching, while an opaque one only reads less nicely.
 *
 * The lookup is scoped to THIS tenant's own football id. Matching the union of
 * every tenant's id would label 18 as "Football" for Admiral too, where 18 is
 * some other sport entirely — the same class of defect as the MaxBet incident
 * this file documents, and one that a new tenant makes easier to reintroduce.
 *
 * @param {string|number} id
 * @param {string} tenantId
 * @returns {string}
 */
function nsoftSportLabel(id, tenantId) {
  const key = String(id);
  if (String(TENANT_FOOTBALL_SPORT[tenantId]) === key) return 'Football';
  return `Sport ${key}`;
}

// Public tenant identifiers recorded in historical snapshots/config; no credentials.
// The companyUuid values are public identifiers read from each brand's own front
// end. The distribution endpoint answers without authentication, which is what
// makes them identifiers rather than secrets.
const TENANTS = {
  admiral: ['682e6a38-b5ad-4c58-a743-3b06c79e55cd', 'nsoft-public-json', 'bookmaker-public-json', 'nsoft.mjs'],
  stanleybet: ['682e6a38-b5ad-4c58-a743-3b06c79e55cd', 'nsoft-public-json', 'nsoft-public-sports-json', 'stanleybet.mjs'],
  maxbet: ['2191e3d6-b0e1-4f06-8b6a-4683203fb2fe', 'nsoft', 'nsoft-public-sports-json', 'maxbet.mjs'],
  betmen: ['7afdd6f5-f954-43d6-b696-2e0dc0ae4ee2', 'nsoft-public-json', 'nsoft-public-sports-json', 'nsoft.mjs'],
};
export function matchesNSoftConfig(id, cfg) {
  const t = TENANTS[id];
  return Boolean(t && cfg.engine === t[1] && cfg.transport === t[2] && cfg.script === t[3]);
}

/**
 * Every tenant this module implements, for the dispatcher's matched-id set.
 *
 * Exported rather than re-typed in src/scrapers/index.mjs: a hand-kept list of
 * tenant ids rots silently, because a tenant missing from that set still fails
 * closed at the fall-through throw, so every test stays green while the guard
 * has quietly stopped guarding.
 */
export const NSOFT_TENANT_IDS = Object.freeze(Object.keys(TENANTS));

export default class NSoftScraper extends ScraperBase {
  maxAttempts = 1;
  constructor(id, opts = {}) {
    super(opts);
    if (!TENANTS[id]) throw new ValidationError('Unknown NSoft tenant');
    this.id = id;
    this.name = id;
    this.sourceIds = [id];
    this.runId ||= new Date().toISOString();
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Number(opts.maxEvents ?? 100);
    this.sport = opts.sport || 'football';
    this.windowHours = Number(opts.windowHours ?? 504);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 5000
        || !Number.isFinite(this.windowHours) || this.windowHours <= 0 || this.windowHours > 720) {
      throw new ValidationError('NSoft: invalid cap/window (maximum 5000 events/720 hours)');
    }
    if (opts.includeLive) this.logger('warn', 'NSoft: only future prematch football is supported');
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    if (this.sport !== 'football') throw new ValidationError('NSoft: only football full-time 1X2 is verified');
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    const url = new URL('https://sportsbook-sm-distribution-api.nsoft.com/api/v1/events');
    url.search = new URLSearchParams({
      companyUuid: TENANTS[this.id][0],
      'filter[from]': new Date(this.from).toISOString().slice(0, 19),
      'filter[to]': new Date(this.to).toISOString().slice(0, 19),
      timezone: 'Europe/Bucharest', language: JSON.stringify({ default: 'ro', tournament: 'ro', category: 'ro', sport: 'ro' }),
      shortProps: '1', offerTemplate: 'WEB_OVERVIEW',
      dataFormat: JSON.stringify({ default: 'array', events: 'object', outcomes: 'array' }),
    });
    this.sourceUrl = url.href;
    // Stamp the observation time before any early return: a zero-cap run still
    // writes a workspace snapshot, and a missing observedAt is what
    // snapshotQuality() reads to decide the file is stale.
    this.observedAt = new Date().toISOString();
    if (this.maxEvents === 0) return { data: { events: {} } };
    const bounded = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, bounded]) : bounded;
    const response = await this.fetchImpl(url.href, {
      signal: requestSignal,
      // Never follow a redirect: a challenge or login redirect must fail
      // loudly rather than be followed into an unrelated response body.
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new UpstreamError(`NSoft: HTTP ${response.status}`, { status: response.status });
    if (!response.headers.get('content-type')?.includes('json')) throw new ValidationError('NSoft: expected JSON');
    // Bound response size as well as request duration. Never follow challenge workflows.
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        requestSignal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16000000) throw new ValidationError('NSoft: response exceeds 16 MB');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    requestSignal.throwIfAborted();
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    this.observedAt = new Date().toISOString();
    return raw;
  }

  normalize(raw) {
    const events = raw?.data?.events;
    if (raw?.error || !events || typeof events !== 'object' || Array.isArray(events)) {
      throw new ValidationError('NSoft: missing data.events object');
    }
    // Decode using the feed's own mapping, not positional assumptions.
    const mapping = raw.data._mapping;
    if (!mapping && Object.keys(events).length) throw new ValidationError('NSoft: missing field mapping');
    const decode = (value, kind) => {
      if (!mapping?.[kind]) throw new ValidationError(`NSoft: missing ${kind} mapping`);
      return Object.fromEntries(Object.entries(mapping[kind]).map(([name, key]) => [name, value?.[key]]));
    };
    return Object.values(events).map((v) => {
      const e = decode(v, 'event');
      e.competitors = (e.competitors || []).map((c) => decode(c, 'competitor'));
      e.markets = (e.markets || []).map((v) => {
        const m = decode(v, 'market');
        m.outcomes = (m.outcomes || []).map((o) => decode(o, 'outcome'));
        return m;
      });
      return e;
    });
  }

  /**
   * The transport this tenant's snapshot records.
   *
   * Read from the tenant table rather than hardcoded: admiral's configured
   * contract is `bookmaker-public-json`, so a literal here would have written a
   * transport that disagrees with the job it came from. Provenance that
   * contradicts its own configuration is worse than no provenance, because
   * nothing flags the disagreement.
   */
  get transport() {
    return TENANTS[this.id]?.[2] || 'nsoft-public-sports-json';
  }

  extractEvents(events) {
    const out = [];
    const seen = new Set();
    for (const e of events) {
      if (out.length >= this.maxEvents) break;
      const time = Date.parse(e.startsAt);
      if (e.active !== 1 || !e.id || seen.has(e.id)
          || !Number.isFinite(time) || time <= (this.from ?? Date.now())
          || time > (this.to ?? Date.now() + this.windowHours * 3600000)) continue;
      const home = e.competitors.filter((c) => c.type === 1);
      const away = e.competitors.filter((c) => c.type === 2);
      if (home.length !== 1 || away.length !== 1 || !home[0].name || !away[0].name) continue;
      // Only publish contracts established by tenant-specific response fixtures.
      // The sport id, the result market id, its display name and its outcome ids
      // all differ per tenant, so they are read from the same measured tables
      // rather than a hardcoded branch: a tenant added later would otherwise be
      // wired to the wrong catalogue and silently publish nothing.
      const footballSportId = TENANT_FOOTBALL_SPORT[this.id];
      const contract = TENANT_RESULT_MARKET[this.id];
      const isFootball = e.sportId === footballSportId;
      let markets;
      if (isFootball && contract) {
        const candidates = e.markets.filter((m) => m.marketId === contract.marketId);
        if (candidates.length !== 1) continue;
        const m = candidates[0];
        if (m.active !== 1 || m.name !== contract.name
            || !Array.isArray(m.specialValues) || m.specialValues.length
            || m.outcomes.length !== 3) continue;
        const selections = [];
        for (const [outcomeId, name] of contract.outcomes) {
          const matches = m.outcomes.filter((o) => o.outcomeId === outcomeId && o.name === name);
          if (matches.length !== 1) break;
          const o = matches[0];
          if (!o.id || o.active !== 1 || !Number.isFinite(o.odd) || o.odd <= 1) break;
          selections.push({ id: String(o.id), providerOutcomeId: o.outcomeId, name, odds: o.odd, handicap: null });
        }
        if (selections.length !== 3 || new Set(selections.map((s) => s.id)).size !== 3) continue;
        markets = [{ key: '1x2', providerMarketId: m.marketId, name: m.name, period: 'fulltime', selections }];
        // The totals and BTTS this tenant also serves are additive: the 1X2 above
        // is the contract that makes the event trustworthy and it is validated
        // first and unconditionally. Each extra is either published whole or
        // skipped on its own, so a suspended or half-quoted extra never costs
        // the event its result market.
        markets.push(...this._extraMarkets(e, TENANT_EXTRAS[this.id]));
      } else {
        // Non-football events are not published. Every configured job declares
        // `supportedSports: ["football"]` and the verified contract is the
        // tenant's football 1X2 only; the generic branch used to emit basketball
        // and the rest stamped `period: 'fulltime'` on whatever three-outcome
        // market it found, which is a settlement claim nobody verified. They
        // also consumed the event cap that football needs.
        continue;
      }
      if (markets.length === 0) continue;
      const kickoff = new Date(time).toISOString();
      const league = e.tournamentName;
      if (!league) continue;
      const teams = [home[0].name, away[0].name];
      seen.add(e.id);
      const sportName = nsoftSportLabel(e.sportId, this.id);
      const sportKey = sportName.toLowerCase().replace(/\s+/g, '-');
      out.push({ id: String(e.id), sourceId: this.id, sourceUrl: this.sourceUrl,
        transport: this.transport, runId: this.runId, observedAt: this.observedAt,
        sport: sportName, league, kickoff, homeTeam: teams[0], awayTeam: teams[1], isLive: false,
        eventKey: [sportKey, normalizeTeamName(league), kickoff, ...teams.map(normalizeTeamName)].join('|'),
        markets });
    }
    return out;
  }

  /**
   * The totals and both-teams-to-score markets this tenant's feed serves for an
   * event, as separate arbitrable contracts. Returns [] for a tenant with no
   * measured extras, or when the event carries none.
   *
   * @param {object} e decoded event
   * @param {{totals?: {marketId:number,name:string}, btts?: {marketId:number,name:string}}|undefined} extras
   * @returns {object[]}
   */
  _extraMarkets(e, extras) {
    if (!extras) return [];
    const out = [];
    if (extras.totals) out.push(...this._totalsMarkets(e, extras.totals));
    if (extras.ah) out.push(...this._asianHandicapMarkets(e, extras.ah));
    if (extras.btts) {
      const btts = this._bttsMarket(e, extras.btts);
      if (btts) out.push(btts);
    }
    return out;
  }

  /**
   * Every two-way Asian handicap the feed serves for the event, one per line.
   *
   * Only half-lines are published. That is a settlement requirement, not a
   * stylistic one: at a whole line the stake is returned on a push, so the
   * market is not an exhaustive two-way contract and pairing it as one would
   * report an arbitrage that a push cancels. It is also where the engine's
   * router stops agreeing with us — a whole-line "H1 -1"/"H2 1" pair is read
   * as OVER_UNDER/1 rather than as a handicap at all. Half-lines are the only
   * lines on which this pair is both exhaustive and correctly routed, and both
   * tenants quote their plain handicap only at half-lines anyway (admiral 262
   * serves -0.5/0.5/-1.5/1.5, maxbet 8 serves -0.5 through 3.5).
   *
   * The two sides are recognised by the "H1"/"H2" prefix the feed uses, and each
   * must carry the handicap it is actually quoted at: the home leg at the
   * market's own line and the away leg at its exact negation. A handicap pair is
   * the one market here whose two legs deliberately disagree, so the totals
   * helper's "both legs carry the market's line" rule cannot be reused — that
   * rule is right for OVER/UNDER and wrong for H1/H2, and applying it rejects
   * every real handicap while accepting none of the impostors.
   *
   * The "H1"/"H2" prefix is how the sides are RECOGNISED, not how they are
   * published: the emitted selection names are "1 (-0.5)" / "2 (0.5)". The
   * engine's AH side matcher reads a leading 1/2, home or away and nothing else,
   * so the feed's own labels resolve the contract and then price no leg. The
   * provider label survives on `providerName`.
   */
  _asianHandicapMarkets(e, spec) {
    const out = [];
    for (const m of e.markets) {
      if (m.marketId !== spec.marketId || m.name !== spec.name || m.active !== 1) continue;
      const line = totalsLine(m.specialValues);
      if (line === null) continue;
      // Reject a whole line: at .0 the result pushes instead of settling.
      if (!isHalfLine(line)) continue;
      const pair = pricedPair(m.outcomes);
      if (!pair) continue;
      const home = pair.find((o) => /^h1\b/i.test(String(o.name).trim()));
      const away = pair.find((o) => /^h2\b/i.test(String(o.name).trim()));
      if (!home || !away || home === away) continue;
      if (!oppositeHandicapLegs(home.name, away.name, line)) continue;
      out.push({
        key: 'ASIAN_HANDICAP',
        providerMarketId: m.marketId,
        name: m.name,
        period: 'fulltime',
        line,
        // "1 (-0.5)" / "2 (0.5)", not the feed's "H1 -0.5" / "H2 0.5". Both
        // resolve the same contract, but only the numbered form ROUTES:
        // canonicalOutcomeFor labels an Asian-handicap leg home/away by /^[12]\b/,
        // /^home\b/ or /^away\b/, and "H1 -0.5" matches none of them, so the
        // nsoft shape resolved ASIAN_HANDICAP and then priced no leg at all.
        // Measured on the 2026-09-29 production sweep across all 24 enabled
        // jobs, that was 583 markets and 1,166 legs on maxbet, admiral and
        // stanleybet — the largest single block of unpriceable contracts in the
        // engine, and larger than any book that was working. The feed's own
        // label is kept on `providerName` and its outcome id on
        // `providerOutcomeId`; only the engine-facing name is canonicalised.
        // everymatrix-wamp.mjs emits the same numbered shape for the same reason.
        selections: [home, away].map((o, i) => {
          // Already proven non-null and exactly opposing by the
          // oppositeHandicapLegs check above, which returns false on either.
          const legLine = nameLine(o.name);
          return {
            id: String(o.id),
            providerOutcomeId: o.outcomeId,
            providerName: o.name,
            name: `${i === 0 ? '1' : '2'} (${legLine})`,
            odds: o.odd,
            // The leg's OWN line, not the market's. A two-way handicap's two
            // legs sit at opposite values by construction, so stamping both
            // with the market line made the home and the away leg carry the
            // same handicap — and findMiddles pairs any two legs in a bucket
            // whose handicaps differ without checking they are the same side,
            // which is exactly the shape that reports a middle between one
            // market's own two sides. everymatrix-wamp.mjs already emits the
            // per-leg value.
            handicap: legLine,
          };
        }),
      });
    }
    return out;
  }

  /**
   * Every full-time goals total for the event, one market per line.
   *
   * The feed carries one market object per line (0.5, 1.5, 2.5 …), so each is
   * its own contract at its own line. Merging them would bucket OVER 2.5 with
   * OVER 3.5, and publishing only the first would discard real prices, so they
   * are emitted one apiece. The line is recovered from the outcome names
   * ("Peste 2.5" / "Sub 2.5") and cross-checked against the market's own
   * `specialValues`; both are emitted, because the engine reads the line out of
   * the selection name.
   */
  _totalsMarkets(e, spec) {
    const out = [];
    for (const m of e.markets) {
      if (m.marketId !== spec.marketId || m.name !== spec.name) continue;
      if (m.active !== 1) continue;
      // A total with no line is not a bucketable contract; the two selections
      // would collapse into a nameless 2-way market.
      const line = totalsLine(m.specialValues);
      if (line === null) continue;
      // A suspended or half-quoted total is skipped, not published.
      const pair = pricedPair(m.outcomes);
      if (!pair) continue;
      const over = pair.find((o) => /^peste\b|^over\b/i.test(String(o.name).trim()));
      const under = pair.find((o) => /^sub\b|^under\b/i.test(String(o.name).trim()));
      if (!over || !under || over === under) continue;
      // The names must agree with the market's own line, so a mislabelled or
      // team/half-specific market can never be published as a full-time total.
      if (!sameLine(over.name, line) || !sameLine(under.name, line)) continue;
      out.push({
        key: 'TOTAL_GOALS',
        providerMarketId: m.marketId,
        name: m.name,
        period: 'fulltime',
        line,
        selections: [over, under].map((o) => ({
          id: String(o.id), providerOutcomeId: o.outcomeId, name: o.name, odds: o.odd, handicap: null,
        })),
      });
    }
    return out;
  }

  /**
   * The full-time both-teams-to-score market, or null when absent/unusable.
   *
   * The two sides are recognised from the provider's own labels and re-emitted
   * as the canonical "Da"/"Nu" pair the engine's BTTS matcher reads (see the
   * BTTS_YES/BTTS_NO comment), because the tenants disagree — "GG"/"NGG" on one
   * feed, "Da"/"Nu" on another — and "NGG" is not a spelling that matcher
   * recognises.
   */
  _bttsMarket(e, spec) {
    for (const m of e.markets) {
      if (m.marketId !== spec.marketId || m.name !== spec.name || m.active !== 1) continue;
      if (m.specialValues && (Array.isArray(m.specialValues) ? m.specialValues.length : 1)) continue;
      const pair = pricedPair(m.outcomes);
      if (!pair) continue;
      const yes = pair.find((o) => BTTS_YES.test(String(o.name).trim()));
      const no = pair.find((o) => BTTS_NO.test(String(o.name).trim()));
      if (!yes || !no || yes === no) continue;
      return {
        key: 'BTTS',
        providerMarketId: m.marketId,
        name: m.name,
        period: 'fulltime',
        selections: [yes, no].map((o, i) => ({
          id: String(o.id), providerOutcomeId: o.outcomeId, name: i === 0 ? 'Da' : 'Nu', odds: o.odd, handicap: null,
        })),
      };
    }
    return null;
  }

  _serializable(events, raw) {
    // The extras are per-tenant and evidence-backed, so the coverage string says
    // which families this tenant actually contributes rather than promising the
    // union for every tenant. It is built from the tenant's own keys: a hardcoded
    // "fulltime-1x2+tgoals+ah+btts" for any tenant with an extras entry claimed
    // totals and handicaps for betmen, which publishes BTTS and neither.
    const extras = TENANT_EXTRAS[this.id];
    const families = ['fulltime-1x2'];
    if (extras?.totals) families.push('tgoals');
    if (extras?.ah) families.push('ah');
    if (extras?.btts) families.push('btts');
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl,
      transport: this.transport, observedAt: this.observedAt,
      coverage: { sport: 'football', market: families.join('+'), live: false, windowHours: this.windowHours, maxEvents: this.maxEvents } };
  }
}

/**
 * The line a totals market is quoted at, or null when it has none.
 *
 * The feed's `specialValues` carries the line in more than one shape — an array
 * such as ["2.5"] on some responses, a bare number 2.5 on others, and an empty
 * array or value on markets with no line at all — so all of them are read and a
 * market with no usable line is refused.
 *
 * @param {unknown} specialValues
 * @returns {string|null} the canonical line, e.g. "2.5"
 */
function totalsLine(specialValues) {
  const raw = Array.isArray(specialValues) ? specialValues[0] : specialValues;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return String(value);
}

/**
 * True when a selection name's own line equals the market's line, so a total
 * whose two legs disagree with the market, or whose name carries a different
 * number, is not published as that line.
 */
function sameLine(selectionName, line) {
  const match = String(selectionName).match(/(-?\d+(?:[.,]\d+)?)/);
  if (!match) return false;
  return String(Number(match[1].replace(',', '.'))) === String(Number(line));
}

/**
 * True when a two-way handicap's two legs are the market's line and its exact
 * negation, so "H1 -0.5" / "H2 0.5" is accepted for a -0.5 market and anything
 * else is not.
 *
 * A handicap is the one market whose legs are *meant* to disagree, so this
 * cannot be the totals rule (both legs equal the line). It is also stricter
 * than "the two lines differ": it pins the home leg to the market's own line
 * and the away leg to its negation, in that order, which is what separates a
 * real handicap from a pair that merely happens to differ — a mislabelled leg,
 * a pair quoted at a line the market does not carry, or a side that repeats the
 * other side's handicap.
 *
 * @param {string} homeName selection name, e.g. "H1 -0.5"
 * @param {string} awayName selection name, e.g. "H2 0.5"
 * @param {string} line the market's own line
 * @returns {boolean}
 */
function oppositeHandicapLegs(homeName, awayName, line) {
  const home = nameLine(homeName);
  const away = nameLine(awayName);
  if (home === null || away === null) return false;
  return home === Number(line) && away === -Number(line);
}

/**
 * The handicap a selection name is quoted at, or null when it carries none.
 *
 * The sign is part of the value, so "-0.5" and "0.5" are different lines and
 * this must not normalise the way `sameLine` does for totals: there, "2.5" and
 * "2.50" are the same line and only the magnitude matters, but a handicap whose
 * sign is dropped is the wrong market.
 *
 * @param {unknown} selectionName
 * @returns {number|null}
 */
function nameLine(selectionName) {
  // The line is the number the name *ends* with, after the "H1"/"H2" token.
  // Scanning from the start would latch onto the digit in "H1" itself and read
  // "H1 -0.5" as 1, which matches nothing and silently drops every handicap.
  const match = String(selectionName).match(/(-?\d+(?:[.,]\d+)?)\s*$/);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/**
 * True when a line is a half line, the only kind on which a two-way Asian
 * handicap has no push. "2.5" and "-0.5" are half lines; "1" and "-2" are not.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isHalfLine(line) {
  return /-?\d+\.5$/.test(String(line).trim());
}

/**
 * A market's outcomes as a complete, live, priced set, or null on any defect.
 *
 * A market missing a leg, carrying a suspended or unpriced outcome, or repeating
 * one must not be published half-formed: the engine would read a single "Peste"
 * as an incomplete 2-way and pair it against another book.
 *
 * @param {Array<{id?:unknown, active?:number, odd?:number}>} outcomes
 * @returns {Array<object>|null}
 */
function pricedPair(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return null;
  const ids = new Set();
  for (const o of outcomes) {
    if (!o || o.active !== 1 || !o.id || !Number.isFinite(o.odd) || o.odd <= 1) return null;
    const id = String(o.id);
    if (ids.has(id)) return null;
    ids.add(id);
  }
  return outcomes;
}

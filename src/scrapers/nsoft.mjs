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

  _serializable(events, raw) {
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl,
      transport: this.transport, observedAt: this.observedAt,
      coverage: { sport: 'football', market: 'fulltime-1x2', live: false, windowHours: this.windowHours, maxEvents: this.maxEvents } };
  }
}

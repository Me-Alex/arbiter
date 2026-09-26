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
});

/**
 * A label for any sport id, used only for the sport name on an event. The
 * numbers are not comparable between tenants, so an unrecognised id is named
 * after the id itself rather than guessed — a wrong sport label breaks event
 * matching, while an opaque one only reads less nicely.
 *
 * @param {string|number} id
 * @returns {string}
 */
function nsoftSportLabel(id) {
  const key = String(id);
  // Only the football ids are known per tenant; anything else is named after
  // the id rather than guessed.
  for (const footballId of Object.values(TENANT_FOOTBALL_SPORT)) {
    if (String(footballId) === key) return 'Football';
  }
  return `Sport ${key}`;
}

// Public tenant identifiers recorded in historical snapshots/config; no credentials.
const TENANTS = {
  admiral: ['682e6a38-b5ad-4c58-a743-3b06c79e55cd', 'nsoft-public-json', 'bookmaker-public-json', 'nsoft.mjs'],
  stanleybet: ['682e6a38-b5ad-4c58-a743-3b06c79e55cd', 'nsoft-public-json', 'nsoft-public-sports-json', 'stanleybet.mjs'],
  maxbet: ['2191e3d6-b0e1-4f06-8b6a-4683203fb2fe', 'nsoft', 'nsoft-public-sports-json', 'maxbet.mjs'],
};
export function matchesNSoftConfig(id, cfg) {
  const t = TENANTS[id];
  return Boolean(t && cfg.engine === t[1] && cfg.transport === t[2] && cfg.script === t[3]);
}

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
      // Both the sport id and the result market id differ per tenant, so they
      // are read from the same measured table rather than one hardcoded
      // branch: a tenant added later would otherwise be wired to the wrong
      // catalogue and silently publish nothing.
      const maxbet = this.id === 'maxbet';
      const footballSportId = TENANT_FOOTBALL_SPORT[this.id];
      const isFootball = e.sportId === footballSportId;
      let markets;
      if (isFootball) {
        const candidates = e.markets.filter((m) => m.marketId === (maxbet ? 2 : 1));
        if (candidates.length !== 1) continue;
        const m = candidates[0];
        if (m.active !== 1 || m.name !== (maxbet ? 'Final' : 'Rezultat Final')
            || !Array.isArray(m.specialValues) || m.specialValues.length
            || m.outcomes.length !== 3) continue;
        const expected = maxbet ? [[2, '1'], [5, 'X'], [8, '2']] : [[1, '1'], [4, 'X'], [7, '2']];
        const selections = [];
        for (const [outcomeId, name] of expected) {
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
      const sportName = nsoftSportLabel(e.sportId);
      const sportKey = sportName.toLowerCase().replace(/\s+/g, '-');
      out.push({ id: String(e.id), sourceId: this.id, sourceUrl: this.sourceUrl,
        transport: 'nsoft-public-sports-json', runId: this.runId, observedAt: this.observedAt,
        sport: sportName, league, kickoff, homeTeam: teams[0], awayTeam: teams[1], isLive: false,
        eventKey: [sportKey, normalizeTeamName(league), kickoff, ...teams.map(normalizeTeamName)].join('|'),
        markets });
    }
    return out;
  }

  _serializable(events, raw) {
    return { ...super._serializable(events, raw), sourceUrl: this.sourceUrl,
      transport: 'nsoft-public-sports-json', observedAt: this.observedAt,
      coverage: { sport: 'football', market: 'fulltime-1x2', live: false, windowHours: this.windowHours, maxEvents: this.maxEvents } };
  }
}

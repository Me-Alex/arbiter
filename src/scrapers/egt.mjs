import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor } from './live-status.mjs';

/**
 * EGT Digital — a new platform, read from its public sports API.
 *
 * A "lobby container" is a curated bundle of events with their markets and
 * prices. Containers are numbered per brand and observed live on 2026-09-27;
 * the list is a measured snapshot, not a guess, and the adapter tolerates a
 * container that has been retired by simply contributing nothing rather than
 * failing the run.
 *
 * The gate: a request without the client device headers answers
 * HTTP 488 {"Message":"Missing user device header!"}. Measured 2026-09-27, the
 * minimum that satisfies it is three ordinary locale headers. `x-platform-hash`
 * is NOT verified server-side (junk and omission both return 200) and
 * `x-platform-exp` is only a client clock, so this is device identification,
 * not a signature and not a challenge — the same read-only access a browser
 * already has. Sending the hash anyway would be cargo-culting an unverified
 * value, so it is not sent.
 */
const DEVICE_HEADERS = Object.freeze({
  'x-platform-device': 'desktop',
  'x-platform-lang': 'ro',
  'x-platform-tz': '180',
});

/** Football on this platform, measured across the brands checked. */
const FOOTBALL_SPORT_ID = 1001;

/**
 * The match-result contract, by the market's own name.
 *
 * A three-way market is NOT automatically the match result on this feed: the
 * same events carry "Golul X" (which goal, in which minute) with outcomes
 * 1 / Niciunul / 2, and a naive three-way test publishes it as a result market
 * and invents a settlement claim. The result market is the one the provider
 * itself calls 1X2.
 */
const RESULT_MARKET_NAMES = Object.freeze(['1X2', '1x2']);

/** Map an outcome name onto a selection name, or null when it is not 1/X/2. */
function resultSelectionName(raw) {
  const n = String(raw ?? '').trim().toLowerCase();
  if (n === '1') return '1';
  if (n === 'x' || n === 'e' || n === 'egal') return 'X';
  if (n === '2') return '2';
  return null;
}

/**
 * The EGT tenants this project has verified, each with its own API host.
 *
 * `businessUnit` appears in the brand's own API paths; it is a public
 * identifier, not a credential.
 *
 * prowin and vipbet are deliberately NOT in one feed group here — that is
 * declared in src/scanner/feed-groups.mjs, and it is a measured decision: they
 * shared 23 of 33 fixtures at byte-identical prices on 2026-09-27 but
 * genuinely differ on the rest. See that file for the evidence.
 */
const TENANTS = Object.freeze({
  prowin: Object.freeze({ host: 'pwro-api.egt-digital.com', businessUnit: 'PWRO', baseUrl: 'https://prowin.ro' }),
  ultrabet: Object.freeze({ host: 'ubro-api.egt-digital.com', businessUnit: 'UBRO', baseUrl: 'https://ultrabet.ro' }),
});

/** Containers measured to carry prematch football 1X2 on 2026-09-27. */
const CONTAINERS = Object.freeze([4155, 4204, 5161, 4136, 4146, 4147, 4161, 4162, 4169, 4170, 4988, 5087, 5170]);

export function matchesEgtConfig(id, cfg) {
  const t = TENANTS[id];
  return Boolean(t && cfg.engine === 'egt-public-sports-api' && cfg.transport === 'egt-public-sports-json' && cfg.script === 'egt.mjs');
}

/**
 * Every tenant this module implements, for the dispatcher's matched-id set.
 * See the note on NSOFT_TENANT_IDS in nsoft.mjs for why this is exported rather
 * than re-typed in src/scrapers/index.mjs.
 */
export const EGT_TENANT_IDS = Object.freeze(Object.keys(TENANTS));

export default class EgtScraper extends ScraperBase {
  maxAttempts = 2;
  timeoutMs = 20_000;

  constructor(id, opts = {}) {
    super(opts);
    const tenant = TENANTS[id];
    if (!tenant) throw new ValidationError(`EGT: unknown tenant ${id}`);
    this.id = id;
    this.name = id;
    this.sourceIds = [id];
    this.tenant = tenant;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.runId ||= new Date().toISOString();
    this.maxEvents = opts.maxEvents === 'all' ? 5000 : Number(opts.maxEvents ?? 500);
    this.windowHours = Number(opts.windowHours ?? 168);
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 5000
        || !Number.isFinite(this.windowHours) || this.windowHours <= 0 || this.windowHours > 720) {
      throw new ValidationError('EGT: invalid cap/window (maximum 5000 events/720 hours)');
    }
    // The feed publishes a `live` boolean per event, so the flag is honoured
    // rather than warned about. The tenant is disabled in config, so this path
    // is exercised only by the fixture suite.
    this.includeLive = opts.includeLive === true;
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    this.observedAt = new Date().toISOString();
    this.sourceUrl = `https://${this.tenant.host}/api/sportsapi/public/sports`;

    // One request per container, bounded concurrency. A container that answers
    // 404 has been retired: it contributes nothing and does not fail the run,
    // because a retired container id is a normal platform change and not
    // evidence of a broken feed.
    const results = [];
    for (const containerId of CONTAINERS) {
      signal?.throwIfAborted();
      const url = `https://${this.tenant.host}/api/sportsapi/public/containers/v2/lobby/normalized/${containerId}`;
      const bounded = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, bounded]) : bounded;
      try {
        const res = await this.fetchImpl(url, {
          signal: requestSignal,
          redirect: 'error',
          headers: { accept: 'application/json', 'accept-language': 'ro-RO', ...DEVICE_HEADERS },
        });
        if (res.status === 404) continue;
        if (!res.ok) throw new UpstreamError(`EGT: container ${containerId} HTTP ${res.status}`, { status: res.status });
        if (!res.headers.get('content-type')?.includes('json')) {
          throw new ValidationError(`EGT: container ${containerId} expected JSON`);
        }
        const text = await res.text();
        results.push({ containerId, url, status: res.status, body: JSON.parse(text) });
      } catch (err) {
        if (signal?.aborted) throw err;
        // One unreadable container must not discard the others.
        this.logger('warn', `EGT: container ${containerId} unreadable: ${err.message}`);
      }
    }
    if (results.length === 0) {
      throw new UpstreamError(`EGT: no readable container among ${CONTAINERS.length} probed`);
    }
    this.observedAt = new Date().toISOString();
    return { containers: results };
  }

  normalize(raw) {
    const containers = raw?.containers;
    if (!Array.isArray(containers) || containers.length === 0) {
      throw new ValidationError('EGT: missing containers');
    }
    const events = [];
    for (const container of containers) {
      const map = container?.body?.events;
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      for (const [key, ev] of Object.entries(map)) {
        if (!ev || typeof ev !== 'object') continue;
        events.push({ containerId: container.containerId, url: container.url, key, ...ev });
      }
    }
    return events;
  }

  extractEvents(rawEvents) {
    const out = [];
    const seen = new Set();
    for (const ev of rawEvents) {
      if (out.length >= this.maxEvents) break;
      // `live` is the provider's own boolean. It was read here only to throw
      // those events away, whatever the caller asked for, so `includeLive` was
      // answered with a warning that live was unsupported on a feed that
      // publishes it. The tenant is disabled and its fixture suite is red for an
      // unrelated reason, so the branch that keeps a live event has not been
      // observed firing; it keeps only what this field actually marks.
      const live = ev.live === true || ev.live === 'true';
      if (ev.sportId !== FOOTBALL_SPORT_ID) continue;
      const time = Date.parse(ev.startTime);
      if (!Number.isFinite(time) || !ev.sportEventId) continue;
      // Two gates that answer different questions, not one condition.
      //
      // `live` is the provider's own boolean and this adapter honours it
      // literally: with the flag off, a live event is refused whatever its
      // kickoff says. Folding that into the window below looks like a tidy
      // simplification and is not one — it rests on "a live event's kickoff is
      // already past", and this feed breaks that. Measured 2026-09-27: fixture
      // container 4155 carries two events flagged live whose kickoffs are 00:00
      // and 02:00 the NEXT day. Folded, they pass the window and a live price
      // is published with `includeLive: false`. The suite had been reporting
      // "the fixture must produce events" for 20 tests and masking it; the
      // `every` at the live-exclusion test passed on an empty array, which is
      // what let it sit here unread.
      if (live && !this.includeLive) continue;
      // The pre-match window, for events the feed does not call live.
      if (!live && (time <= (this.from ?? Date.now()) || time > (this.to ?? Date.now() + this.windowHours * 3600000))) continue;
      if (seen.has(ev.sportEventId)) continue;

      const home = String(ev.homeTeam || '').trim();
      const away = String(ev.awayTeam || '').trim();
      if (!home || !away) continue;
      const league = String(ev.tournamentName || ev.categoryName || '').trim();
      if (!league) continue;

      // Exactly one result market, and only the one the provider calls 1X2.
      const candidates = (ev.markets || []).filter((m) => {
        const label = String(m?.marketTemplateName || m?.marketTitle || m?.marketName || '').trim();
        return RESULT_MARKET_NAMES.includes(label);
      });
      if (candidates.length !== 1) continue;
      const m = candidates[0];
      if (m.marketStatus && m.marketStatus !== 'Active') continue;
      const outcomes = m.outcomes || [];
      if (outcomes.length !== 3) continue;

      const selections = [];
      for (const o of outcomes) {
        const name = resultSelectionName(o.name ?? o.outcomeName ?? o.shortName);
        if (!name) { selections.length = 0; break; }
        const odd = o.odds;
        if (!Number.isFinite(odd) || odd <= 1) { selections.length = 0; break; }
        // The provider's own selection and market ids are int64
        // (e.g. 1551412977691788500), which JSON.parse has already rounded by
        // the time they reach this code. Re-stringifying a rounded number would
        // mint a plausible-looking id that is not the provider's, so identity
        // is derived from the event and the outcome NAME, which is what this
        // adapter matches on and what the engine contracts against.
        selections.push({ id: `${ev.sportEventId}:${name}`, name, odds: odd, handicap: null });
      }
      // Complete, mutually exclusive, one of each outcome.
      if (selections.length !== 3) continue;
      if (new Set(selections.map((s) => s.name)).size !== 3) continue;
      if (new Set(selections.map((s) => s.id)).size !== 3) continue;

      const kickoff = new Date(time).toISOString();
      seen.add(ev.sportEventId);
      out.push({
        id: String(ev.sportEventId),
        sourceId: this.id,
        sourceUrl: String(ev.url || ev.sourceUrl || this.tenant.baseUrl),
        transport: 'egt-public-sports-json',
        runId: this.runId,
        observedAt: this.observedAt,
        sport: 'Football',
        league,
        kickoff,
        homeTeam: home,
        awayTeam: away,
        // `isLive` was written here and read by nobody; the scanner gates on
        // `live`. A live event's markets are live markets — the engine pairs on
        // that flag, so leaving it off would let a running-match price pair
        // against another book's pre-match one.
        live,
        isLive: live,
        eventKey: [
          'football',
          normalizeTeamName(league),
          kickoff,
          normalizeTeamName(home),
          normalizeTeamName(away),
        ].join('|'),
        markets: [{
          key: '1x2',
          // No providerMarketId: the feed's marketId is an int64 that JSON.parse
          // rounds, so publishing it would record a corrupted identifier.
          name: m.marketTemplateName || m.marketTitle || '1X2',
          period: 'fulltime',
          live,
          selections,
        }],
      });
    }
    return out;
  }

  _serializable(events, raw) {
    return {
      ...super._serializable(events, raw),
      sourceUrl: this.sourceUrl,
      transport: 'egt-public-sports-json',
      observedAt: this.observedAt,
      coverage: {
        sport: 'football',
        market: 'fulltime-1x2',
        // The feed names live per event, so this is the measured capability plus
        // whether this run took its in-play events.
        ...liveCoverageFor(this.id),
        liveCollected: this.includeLive,
        windowHours: this.windowHours,
        maxEvents: this.maxEvents,
        containersProbed: CONTAINERS.length,
        containersRead: raw?.containers?.length ?? 0,
      },
    };
  }
}

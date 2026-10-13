import ScraperBase from './base.mjs';
import { normalizeTeamName } from '../shared/text.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { liveCoverageFor, markMarketsLive } from './live-status.mjs';
import { extractPeriodFromName, isTradablePeriod } from '../scanner/market-contracts.mjs';

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

/** Map an outcome name onto a 2-way selection name (1 or 2). */
function twoWaySelectionName(raw) {
  const n = String(raw ?? '').trim().toLowerCase();
  if (n === '1') return '1';
  if (n === '2') return '2';
  return null;
}

/** Map an outcome name onto Over or Under. */
function totalsSelectionName(raw) {
  const n = String(raw ?? '').trim().toLowerCase();
  if (/^(?:peste|over|>)\b/i.test(n)) return 'Over';
  if (/^(?:sub|under|<)\b/i.test(n)) return 'Under';
  return null;
}

/** Map an outcome name onto Yes or No for BTTS. */
function bttsSelectionName(raw) {
  const n = String(raw ?? '').trim().toLowerCase();
  if (/^(?:da|yes|gg)\b/i.test(n)) return 'Yes';
  if (/^(?:nu|no|ng)\b/i.test(n)) return 'No';
  return null;
}

/** Extract numeric line from market specifier string (e.g. "total=2.5"). */
function extractLineFromSpecifier(spec) {
  if (!spec || typeof spec !== 'string') return null;
  const m = /(?:total|line)=([0-9]+(?:\.[0-9]+)?)/i.exec(spec);
  if (m) {
    const val = Number(m[1]);
    return Number.isFinite(val) ? val : null;
  }
  return null;
}

/** Extract numeric line from text (e.g. "Total 2.5", "Peste 1.5"). */
function extractLineFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const m = /\b([0-9]+\.5)\b/.exec(text);
  if (m) {
    const val = Number(m[1]);
    return Number.isFinite(val) ? val : null;
  }
  return null;
}

/**
 * Extract sub-window derivative markets (halves, quarters, sets, totals)
 * with deterministic period assignment and bucket key isolation.
 */
function extractSubWindowMarkets(ev, live) {
  const out = [];
  const seenKeys = new Set();
  for (const m of ev.markets || []) {
    if (m.marketStatus && m.marketStatus !== 'Active') continue;
    const title = String(m.marketTitle || m.marketName || m.marketTemplateName || '').trim();
    const period = extractPeriodFromName(title) || extractPeriodFromName(m.marketPath) || extractPeriodFromName(m.marketTemplateName);
    if (!period || !isTradablePeriod(period) || period === 'fulltime') continue;

    const outcomes = m.outcomes || [];
    // 1. 3-way Period 1X2 (halves, quarters)
    if (outcomes.length === 3) {
      const selections = [];
      for (const o of outcomes) {
        const name = resultSelectionName(o.name ?? o.outcomeName ?? o.shortName);
        if (!name) { selections.length = 0; break; }
        const odd = o.odds;
        if (!Number.isFinite(odd) || odd <= 1) { selections.length = 0; break; }
        selections.push({ id: `${ev.sportEventId}:${period}:${name}`, name, odds: odd, handicap: null });
      }
      if (selections.length === 3 && new Set(selections.map((s) => s.name)).size === 3) {
        const dedupeKey = `1x2:${period}`;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          out.push({
            key: '1x2',
            name: title || `${period.toUpperCase()} 1X2`,
            period,
            live,
            selections,
          });
        }
        continue;
      }
    }

    // 2. 2-way Period Winner (sets, quarters, halves)
    if (outcomes.length === 2 && (period.startsWith('set') || period.startsWith('q') || period === 'half1' || period === 'half2')) {
      const selections = [];
      for (const o of outcomes) {
        const name = twoWaySelectionName(o.name ?? o.outcomeName ?? o.shortName);
        if (!name) { selections.length = 0; break; }
        const odd = o.odds;
        if (!Number.isFinite(odd) || odd <= 1) { selections.length = 0; break; }
        selections.push({ id: `${ev.sportEventId}:${period}:${name}`, name, odds: odd, handicap: null });
      }
      if (selections.length === 2 && new Set(selections.map((s) => s.name)).size === 2) {
        const dedupeKey = `2way:${period}`;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          out.push({
            key: 'MATCH_ODDS',
            name: title || `${period.toUpperCase()} Winner`,
            period,
            live,
            selections,
          });
        }
        continue;
      }
    }

    // 3. Period Over/Under totals (e.g. half1 1.5 goals)
    if (outcomes.length === 2 && /total|peste|sub|over|under/i.test(title)) {
      let overSel = null;
      let underSel = null;
      for (const o of outcomes) {
        const type = totalsSelectionName(o.name ?? o.outcomeName ?? o.shortName ?? o.columnName);
        const odd = o.odds;
        if (!Number.isFinite(odd) || odd <= 1) continue;
        if (type === 'Over') overSel = { id: `${ev.sportEventId}:${period}:over`, name: 'Over', odds: odd, handicap: null };
        else if (type === 'Under') underSel = { id: `${ev.sportEventId}:${period}:under`, name: 'Under', odds: odd, handicap: null };
      }
      if (overSel && underSel) {
        const line = extractLineFromSpecifier(m.marketSpecifier) || extractLineFromText(title) || extractLineFromText(outcomes[0]?.name);
        if (line !== null && Number.isFinite(line)) {
          const dedupeKey = `ou:${period}:${line}`;
          if (!seenKeys.has(dedupeKey)) {
            seenKeys.add(dedupeKey);
            out.push({
              key: 'TOTAL_GOALS',
              name: title || `Total Goals ${period.toUpperCase()}`,
              period,
              line,
              subject: 'goals',
              live,
              selections: [
                { ...overSel, name: `Over ${line}` },
                { ...underSel, name: `Under ${line}` },
              ],
            });
          }
          continue;
        }
      }
    }
  }
  return out;
}

/**
 * Extract full-time extras (goals totals, BTTS) when present alongside 1X2.
 */
function extractFulltimeExtras(ev, live) {
  const out = [];
  const seenKeys = new Set();
  for (const m of ev.markets || []) {
    if (m.marketStatus && m.marketStatus !== 'Active') continue;
    const title = String(m.marketTitle || m.marketName || m.marketTemplateName || '').trim();
    const period = extractPeriodFromName(title) || extractPeriodFromName(m.marketPath) || extractPeriodFromName(m.marketTemplateName);
    if (period && period !== 'fulltime') continue;

    const outcomes = m.outcomes || [];
    // Full-time Totals
    if (outcomes.length === 2 && /total\s*goluri|total\s*goals|peste\/sub/i.test(title)) {
      let overSel = null;
      let underSel = null;
      for (const o of outcomes) {
        const type = totalsSelectionName(o.name ?? o.outcomeName ?? o.shortName ?? o.columnName);
        const odd = o.odds;
        if (!Number.isFinite(odd) || odd <= 1) continue;
        if (type === 'Over') overSel = { id: `${ev.sportEventId}:ft:over`, name: 'Over', odds: odd, handicap: null };
        else if (type === 'Under') underSel = { id: `${ev.sportEventId}:ft:under`, name: 'Under', odds: odd, handicap: null };
      }
      if (overSel && underSel) {
        const line = extractLineFromSpecifier(m.marketSpecifier) || extractLineFromText(title) || extractLineFromText(outcomes[0]?.name);
        if (line !== null && Number.isFinite(line)) {
          const dedupeKey = `ou:fulltime:${line}`;
          if (!seenKeys.has(dedupeKey)) {
            seenKeys.add(dedupeKey);
            out.push({
              key: 'TOTAL_GOALS',
              name: title || 'Total goluri',
              period: 'fulltime',
              line,
              subject: 'goals',
              live,
              selections: [
                { ...overSel, name: `Over ${line}` },
                { ...underSel, name: `Under ${line}` },
              ],
            });
          }
        }
      }
    }

    // Full-time BTTS
    if (outcomes.length === 2 && /ambele\s*echipe|both\s*teams\s*to\s*score|gg\/ng/i.test(title)) {
      let yesSel = null;
      let noSel = null;
      for (const o of outcomes) {
        const type = bttsSelectionName(o.name ?? o.outcomeName ?? o.shortName);
        const odd = o.odds;
        if (!Number.isFinite(odd) || odd <= 1) continue;
        if (type === 'Yes') yesSel = { id: `${ev.sportEventId}:btts:yes`, name: 'Yes', odds: odd, handicap: null };
        else if (type === 'No') noSel = { id: `${ev.sportEventId}:btts:no`, name: 'No', odds: odd, handicap: null };
      }
      if (yesSel && noSel) {
        const dedupeKey = 'btts:fulltime';
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          out.push({
            key: 'BOTH_TEAMS_SCORE',
            name: title || 'Ambele echipe marchează',
            period: 'fulltime',
            live,
            selections: [yesSel, noSel],
          });
        }
      }
    }
  }
  return out;
}

/**
 * The EGT tenants this project has verified, each with its own API host.
 *
 * `businessUnit` appears in the brand's own API paths; it is a public
 * identifier, not a credential.
 *
 * All three brands share one declared feed group in scanner/feed-groups.mjs.
 * The corrected measurement uses kickoff and feedProducerId; price changes
 * between captures alone do not establish independence.
 */
const TENANTS = Object.freeze({
  prowin: Object.freeze({ host: 'pwro-api.egt-digital.com', businessUnit: 'PWRO', baseUrl: 'https://prowin.ro' }),
  ultrabet: Object.freeze({ host: 'ubro-api.egt-digital.com', businessUnit: 'UBRO', baseUrl: 'https://ultrabet.ro' }),
  vipbet: Object.freeze({ host: 'vpro-api.egt-digital.com', businessUnit: 'VPRO', baseUrl: 'https://vipbet.ro' }),
  fortunapalace: Object.freeze({ host: "fpro-api.egt-digital.com", businessUnit: "FPRO", baseUrl: "https://fpro-api.egt-digital.com/api/sportsapi/public/sports" }),
  maxwin: Object.freeze({ host: "mxro-api.egt-digital.com", businessUnit: "MXRO", baseUrl: "https://mxro-api.egt-digital.com/api/sportsapi/public/sports" }),
  luckyseven: Object.freeze({ host: "luckyseven-ro-api.egt-digital.com", businessUnit: "L7RO", baseUrl: "https://luckyseven-ro-api.egt-digital.com/api/sportsapi/public/sports" }),
  onecasino: Object.freeze({ host: "onecasino-ro-api.egt-digital.com", businessUnit: "OCRO", baseUrl: "https://onecasino-ro-api.egt-digital.com/api/sportsapi/public/sports" }),
  vivabet: Object.freeze({ host: "vivabet-ro-api.egt-digital.com", businessUnit: "VVRO", baseUrl: "https://vivabet.ro" }),
});

/** Containers measured to carry prematch football 1X2 on 2026-09-27. */
const CONTAINERS = Object.freeze([4155, 4204, 5161, 4136, 4146, 4147, 4161, 4162, 4169, 4170, 4988, 5087, 5170]);

export function matchesEgtConfig(id, cfg) {
  const t = TENANTS[id];
  // VipBet uses its bounded subclass, registered by exact contract in index.
  return Boolean(t && id !== 'vipbet' && cfg.engine === 'egt-public-sports-api' && cfg.transport === 'egt-public-sports-json' && cfg.script === 'egt.mjs');
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
    this.maxEvents = opts.maxEvents === 'all' ? Infinity : Number(opts.maxEvents ?? Infinity);
    this.windowHours = Number(opts.windowHours ?? 168);
    if ((!Number.isInteger(this.maxEvents) && this.maxEvents !== Infinity) || this.maxEvents < 0
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

    // High-yield full catalog ingestion via tournament trees when available
    if (this.fullCatalog !== false) {
      try {
        const sportsUrl = `https://${this.tenant.host}/api/sportsapi/public/sports`;
        const bounded = AbortSignal.timeout(this.timeoutMs);
        const reqSignal = signal ? AbortSignal.any([signal, bounded]) : bounded;
        const sRes = await this.fetchImpl(sportsUrl, {
          signal: reqSignal,
          redirect: 'error',
          headers: { accept: 'application/json', 'accept-language': 'ro-RO', ...DEVICE_HEADERS },
        });
        if (sRes.ok) {
          const sportsData = await sRes.json();
          const fb = (sportsData?.data || []).find((s) => s.id === FOOTBALL_SPORT_ID || s.id === 1001);
          const tourIds = [];
          if (fb?.categories) {
            for (const cat of fb.categories) {
              for (const tour of cat.tournaments || []) {
                if (tour.id && (tour.eventsCount > 0 || tour.eventCount > 0 || tour.liveEventsCount > 0)) {
                  tourIds.push(tour.id);
                }
              }
            }
          }
          if (tourIds.length > 0) {
            const batchSize = 50;
            const collectedEvents = [];
            for (let i = 0; i < tourIds.length; i += batchSize) {
              reqSignal.throwIfAborted();
              const chunk = tourIds.slice(i, i + batchSize);
              const tUrl = `https://${this.tenant.host}/api/sportsapi/public/sport-events/v2/tournaments/events/${FOOTBALL_SPORT_ID}`;
              const tRes = await this.fetchImpl(tUrl, {
                method: 'POST',
                signal: reqSignal,
                redirect: 'error',
                headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-language': 'ro-RO', ...DEVICE_HEADERS },
                body: JSON.stringify(chunk),
              });
              if (tRes.ok) {
                const tData = await tRes.json();
                const evList = Array.isArray(tData?.data) ? tData.data : (Array.isArray(tData) ? tData : []);
                for (const ev of evList) {
                  collectedEvents.push(ev);
                }
              }
            }
            if (collectedEvents.length > 0) {
              return { events: collectedEvents };
            }
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        // Fall back to lobby containers
      }
    }

    // Fallback: One request per container (used by test fixtures)
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
    if (Array.isArray(raw?.events)) {
      return raw.events;
    }
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

      // Exactly one full-time result market, and only the one the provider calls 1X2.
      const candidates = (ev.markets || []).filter((m) => {
        const label = String(m?.marketTemplateName || m?.marketTitle || m?.marketName || '').trim();
        if (!RESULT_MARKET_NAMES.includes(label)) return false;
        const p = extractPeriodFromName(m?.marketTitle || m?.marketPath || m?.marketName);
        return !p || p === 'fulltime';
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
      const eventMarkets = [{
        key: '1x2',
        // No providerMarketId: the feed's marketId is an int64 that JSON.parse
        // rounds, so publishing it would record a corrupted identifier.
        name: m.marketTemplateName || m.marketTitle || '1X2',
        period: 'fulltime',
        live,
        selections,
      }];
      eventMarkets.push(...extractFulltimeExtras(ev, live));
      eventMarkets.push(...extractSubWindowMarkets(ev, live));
      markMarketsLive(eventMarkets, () => live);

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
        markets: eventMarkets,
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

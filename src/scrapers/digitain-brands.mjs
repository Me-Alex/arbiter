import Winner from './winner.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { ValidationError, UpstreamError } from '../shared/errors.mjs';
import { eventLimit } from './event-limit.mjs';

// Observed hosts in data/endpoints/captures/{mrplay,888sport,bet7}_api.json.
// These are aliases of Winner's public feed, NOT independent prices. No tenant
// credentials or CMS endpoints are used. See docs/platform-findings.json.
const BRANDS = Object.freeze({
  mrplay: { name: 'MrPlay', host: 'micros-prod1.gambling-solutions.ro' },
  '888sport': { name: '888sport', host: 'micros-eagle-prod1.gambling-solutions.ro' },
  bet7: { name: 'Bet7', host: 'micros-prod1.gambling-solutions.ro' },
  eliteslots: { name: "Elite Slots", host: "micros-prod1.gambling-solutions.ro" },
  ladycasino: { name: "Lady Casino", host: "micros-prod1.gambling-solutions.ro" },
  pacanele: { name: "Pacanele", host: "micros-prod1.gambling-solutions.ro" },
  hotspins: { name: "HotSpins", host: "micros-prod1.gambling-solutions.ro" },
});

/** Reuse the tested Digitain wire parser; all instances inherit ScraperBase. */
export default class DigitainBrand extends Winner {
  constructor(id, opts = {}) {
    const brand = BRANDS[id];
    if (!brand) throw new ValidationError(`Digitain: unknown brand ${id}`);
    super({ ...opts, sport: opts.sport || 'football', maxEvents: eventLimit(opts.maxEvents) });
    this.id = id;
    this.name = brand.name;
    this.sourceIds = [id];
    this.endpoint = `https://${brand.host}/api/digitain-fetcher/v2/public/events`;
    this.transport = 'digitain-public-json';
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.runId ||= new Date().toISOString();
    if (!Number.isFinite(this.windowHours) || this.windowHours <= 0 || this.windowHours > 720) {
      throw new ValidationError('Digitain: window must be within 720 hours');
    }
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    this.sourceUrl = this.endpoint;
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST', body: '{}', redirect: 'error', signal: bounded,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError(`${this.id}: HTTP ${response.status}`, { status: response.status });
    }
    if (!response.headers.get('content-type')?.includes('json')) {
      await response.body?.cancel();
      throw new ValidationError(`${this.id}: expected JSON`);
    }
    const raw = await readBoundedJson(response, this.id, bounded, 20_000_000);
    this.observedAt = new Date().toISOString();
    return raw;
  }

  normalize(raw) {
    if (!Array.isArray(raw?.data?.events)) throw new ValidationError(`${this.id}: missing data.events array`);
    return super.normalize(raw);
  }

  extractEvents(rawEvents) {
    // Publish only complete full-time result contracts proven by captures.
    // Inactive/missing outcomes must not turn a 1X2 into a two-way market.
    const complete = rawEvents.filter((event) => event.idMatch || event.id).map((event) => ({
      ...event,
      matchBets: (event.matchBets || []).filter((market) => {
        const name = this._localize(market.mbDisplayName).trim();
        if (!market.mbActive) return false;
        const outcomes = market.mbOutcomes || [];
        const activeOutcomes = outcomes.filter((o) => o.mboActive && Number.isFinite(Number(o.mboOddValue)) && Number(o.mboOddValue) > 1);
        if (activeOutcomes.length !== outcomes.length) return false;

        const getOutcomeLabel = (o) => {
          const disp = this._localize(o.mboDisplayName).trim();
          if (disp === '1' || disp === '2' || disp === 'X') return disp;
          const typ = this._localize(o.mboType).trim();
          if (typ === '1' || typ === '2' || typ === 'X') return typ;
          return disp;
        };

        // 3-way match result: 1X2
        if (/^(final|result|rezultat|match result|1x2)$/i.test(name)) {
          if (outcomes.length === 3
            && ['1', 'X', '2'].every((label) => outcomes.filter((o) => getOutcomeLabel(o) === label).length === 1)) {
            return true;
          }
        }

        // 2-way match result (Moneyline / Winner / Head to Head) for Basketball, Tennis, etc.
        if (/^(c[aâ][sș]?tig[aă]tor(?:\s+meci)?|winner|match winner|money\s*line|head to head|h2h|1\s*2|12|rezultat meci)$/i.test(name)
            || (/^(final|result|rezultat|match result)$/i.test(name) && outcomes.length === 2)) {
          if (outcomes.length === 2
            && (['1', '2'].every((label) => outcomes.filter((o) => getOutcomeLabel(o) === label).length === 1)
              || outcomes.length === 2)) {
            return true;
          }
        }

        // 2-way Period / Set / Quarter / Half Winner (e.g. "Castigator Set 1", "Set 1 Winner", "Sfertul 1 Castigator", "Castigator Repriza 1")
        if (/^(?:c[aâ][sș]?tig[aă]tor\s+(?:set(?:ul)?\s*[1-5]|sfert(?:ul)?\s*[1-4]|repriz[aă]\s*[12]|prima\s*repriz[aă]|a\s*doua\s*repriz[aă]|half\s*[12])|(?:set(?:ul)?\s*[1-5]|sfert(?:ul)?\s*[1-4]|repriz[aă]\s*[12]|prima\s*repriz[aă]|a\s*doua\s*repriz[aă]|half\s*[12])\s*(?:-|–)?\s*c[aâ][sș]?tig[aă]tor|(?:1st|2nd|3rd|4th|5th)\s*(?:set|quarter|half)\s*winner|(?:set|quarter|half)\s*[1-5]\s*winner)$/i.test(name)) {
          if (outcomes.length === 2
            && (['1', '2'].every((label) => outcomes.filter((o) => getOutcomeLabel(o) === label).length === 1)
              || outcomes.length === 2)) {
            return true;
          }
        }

        // Totals (Goals, Points, Games) for all Digitain brands
        if (/^total\b/i.test(name) && /\bgoluri\b|\bgoals\b|\bpuncte\b|\bpoints\b|\bgame-?uri\b|\bgames\b|\bsets\b/i.test(name)) {
          return true;
        }

        return false;
      }),
    }));
    return super.extractEvents(complete).map((event) => ({ ...event, runId: this.runId }));
  }

  _serializable(events, raw) {
    const snapshot = super._serializable(events, raw);
    snapshot.coverage.allMarkets = false;
    snapshot.coverage.market = 'fulltime-1x2';
    return snapshot;
  }
}

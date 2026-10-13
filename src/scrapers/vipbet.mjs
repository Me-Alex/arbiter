import Egt from './egt.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { UpstreamError, ValidationError } from '../shared/errors.mjs';
import { eventLimit } from './event-limit.mjs';

// Public container IDs observed in captures/vipbet_api.json. No range probing.
const CONTAINERS = Object.freeze([4155, 4204, 5161, 4136, 4146, 4147, 4161, 4162, 4169, 4170, 4988, 5087, 5170]);

export default class VipBet extends Egt {
  constructor(opts = {}) {
    super('vipbet', { ...opts, maxEvents: eventLimit(opts.maxEvents) });
    this.name = 'VipBet';
  }

  normalize(raw) {
    for (const container of raw?.containers || []) {
      if (!container.body?.events || typeof container.body.events !== 'object' || Array.isArray(container.body.events)) {
        throw new ValidationError('vipbet: expected container events object');
      }
    }
    return super.normalize(raw);
  }

  extractEvents(rawEvents) {
    return super.extractEvents(rawEvents.filter((event) => !event.isProducerDown && event.hasActiveMarkets !== false)
      .map((event) => ({ ...event, markets: (event.markets || []).filter((market) =>
        (market.outcomes || []).every((outcome) => outcome.isActive !== false && outcome.isSuspended !== true)) })));
  }

  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    this.from = Date.now();
    this.to = this.from + this.windowHours * 3600000;
    const containers = [];
    for (const containerId of CONTAINERS) {
      bounded.throwIfAborted();
      const url = `https://${this.tenant.host}/api/sportsapi/public/containers/v2/lobby/normalized/${containerId}`;
      const response = await this.fetchImpl(url, {
        signal: bounded, redirect: 'error',
        headers: { accept: 'application/json', 'x-platform-device': 'desktop', 'x-platform-lang': 'ro', 'x-platform-tz': '180' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) continue;
        throw new UpstreamError(`vipbet: container ${containerId} HTTP ${response.status}`, { status: response.status });
      }
      if (!response.headers.get('content-type')?.includes('json')) {
        await response.body?.cancel();
        throw new ValidationError(`vipbet: container ${containerId} expected JSON`);
      }
      const body = await readBoundedJson(response, 'vipbet', bounded, 4_000_000);
      containers.push({ containerId, url, status: response.status, body });
    }
    if (!containers.length) throw new UpstreamError('vipbet: no readable public containers');
    this.sourceUrl = containers[0].url;
    this.observedAt = new Date().toISOString();
    return { containers };
  }
}

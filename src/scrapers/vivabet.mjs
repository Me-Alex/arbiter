import Egt from './egt.mjs';
import { eventLimit } from './event-limit.mjs';

/**
 * Vivabet — EGT Digital public sports API, business unit VVRO.
 *
 * The wire parser, request headers and normalized container ingestion are EGT's,
 * verified live on vivabet.ro with exact on-screen odds parity.
 *
 * https://vivabet-ro-api.egt-digital.com/api/sportsapi/public/sports
 */
export default class Vivabet extends Egt {
  constructor(opts = {}) {
    super('vivabet', { ...opts, maxEvents: eventLimit(opts.maxEvents) });
    this.name = 'Vivabet';
  }

  extractEvents(rawEvents) {
    return super.extractEvents(rawEvents.filter((event) => !event.isProducerDown && event.hasActiveMarkets !== false)
      .map((event) => ({
        ...event,
        markets: (event.markets || []).filter((market) =>
          (market.outcomes || []).every((outcome) => outcome.isActive !== false && outcome.isSuspended !== true)),
      })));
  }
}

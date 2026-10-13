import Egt from './egt.mjs';
import { eventLimit } from './event-limit.mjs';

/**
 * Fortuna Palace — egt-digital, scaffolded by `npm run new-book` on 2026-10-11.
 *
 * The wire parser, the request shape and the market mapping are Egt's,
 * already exercised by the books that share this platform.
 *
 * https://fpro-api.egt-digital.com/api/sportsapi/public/sports
 */
export default class Fortunapalace extends Egt {
  constructor(opts = {}) {
    super('fortunapalace', { ...opts, maxEvents: eventLimit(opts.maxEvents) });
    this.name = 'Fortuna Palace';
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

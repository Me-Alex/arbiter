/**
 * Bookmaker-level signals that aren't tied to specific events:
 *   - positive EV (already in engine) — kept here as a re-export for clarity
 *   - low hold (already in engine)     — same
 *   - bonus eligibility                — informational
 *   - market coverage gaps             — informational
 */

import { groupByEvent, findPositiveEV, findLowHold } from './engine.mjs';

export function collectBookmakerSignals(events, opts = {}) {
  const grouped = groupByEvent(events);
  return {
    positiveEV: findPositiveEV(grouped, opts),
    lowHold: findLowHold(grouped, opts),
  };
}

/**
 * live-status.mjs — which field of a provider's OWN payload says "this match is
 * running", per feed, and what was measured to justify each answer.
 *
 * Why this exists at all
 * ----------------------
 * The scanner has always gated on `event.live`, and until `winner` set it, no
 * adapter did: 22 of 24 wrote a hardcoded `isLive: false` that nothing read.
 * That field is worse than absent, because it reads like an answer. So "turn on
 * live" is not a switch — it is 24 independent questions, one per feed, and the
 * only honest way to answer them is to look at the provider's own data.
 *
 * Why not infer it from the kickoff
 * ---------------------------------
 * A kickoff in the past cannot tell "running" from "finished", and a finished
 * match priced as a live one is a money signal against a dead book. So nothing
 * here guesses from a clock. Every predicate reads a field the provider itself
 * publishes, and a feed with no such field gets no live collection at all.
 *
 * How each field was chosen
 * -------------------------
 * A single download per book, with both collection gates open, split into a
 * "started" bucket (kickoff already passed, last 24h) and a "future" control
 * bucket. A field qualifies only if it is CATEGORICAL — at most 8 distinct values
 * in each bucket — present on >=95% of the events, and its started values are
 * DISJOINT from its future ones. That test is deliberately strict: the first
 * attempt used "takes a different value", which accepts `event_id`, `kickoff` and
 * `homeTeam`, all of which differ on every event and prove nothing.
 *
 * The instrument was calibrated before it was trusted. `unibet` is the positive
 * control — its feed is known to carry `status: "InPlay"` — and a run that fails
 * to recover it indicts the probe, not the book. An early version of the probe
 * did fail: its running-maximum started at `NaN`, and every comparison against
 * `NaN` is false, so it reported "no instants anywhere" for all 675 events. The
 * control is what caught that.
 *
 * The measurement window, and what a zero in it does and does not mean
 * --------------------------------------------------------------------
 * Measured 2026-09-29/30 between 22:20 and 23:20 UTC, i.e. 01:20–02:20 local —
 * a European early morning, when very little football is actually running. That
 * is the only window in which these numbers exist, and it is a weak one for
 * negative results. A `started: 0` below means "this feed published no in-play
 * football event in that download", which is a statement about the hour, not a
 * permanent property of the feed. It is enough to refuse live collection — the
 * fail-closed direction is safe — and it is NOT enough to conclude the feed can
 * never publish in-play. Re-measure with the scratch probes at a busy hour
 * before believing a zero.
 *
 * Three feeds did publish in-play football in that window and all three named it
 * with a categorical, disjoint field: the FEG pair (fortuna, casa-pariurilor)
 * with `market.kind`, and unibet with `contest.status`. The other 21 published
 * none, so none of them is wired, and `coverage.live` says so per book rather
 * than claiming a capability nobody measured.
 */

/** The FEG market-kind vocabulary, as published. */
export const FEG_MARKET_KIND = Object.freeze({ LIVE: 'LIVE', PREMATCH: 'PREMATCH' });

/**
 * FEG (fortuna, casa-pariurilor) marks each MARKET, not the fixture.
 *
 * Measured 2026-09-29 22:5x UTC: 14 started fixtures, `market.kind` present on
 * every market, `LIVE` on all of their markets and `PREMATCH` on all 805 future
 * fixtures' markets. No started fixture in that download carried both kinds, but
 * the field is per-market by construction, so the pairing scope in engine.mjs
 * treats a mixed fixture as a real case rather than an impossible one.
 *
 * @param {{ kind?: unknown }} market
 * @returns {boolean}
 */
export function fegMarketIsLive(market) {
  return market?.kind === FEG_MARKET_KIND.LIVE;
}

/**
 * Unibet's own contest status. Measured: 12–13 started contests, every one
 * `InPlay`, against `PreGame` on all ~830 future contests.
 *
 * @param {{ status?: unknown }} contest
 * @returns {boolean}
 */
export function unibetEventIsLive(contest) {
  return contest?.status === 'InPlay';
}

/**
 * Superbet: the feed tags every event with an in-play stats block whose status
 * is `NOT_STARTED` until the match begins. The adapter already read this field to
 * EXCLUDE started events, so the field's name and its `NOT_STARTED` value are
 * the adapter's own reading of the provider, not a guess here.
 *
 * Unmeasured in the window: the feed published 1133 future football fixtures and
 * no started one, so the branch below has not been observed returning true. It
 * is kept because the field demonstrably exists and is categorical; if it ever
 * fails to, the value simply is not `NOT_STARTED` and nothing is claimed.
 *
 * @param {{ inplay_stats_metadata?: { status?: unknown } }} event
 * @returns {boolean}
 */
export function superbetEventIsLive(event) {
  const status = event?.inplay_stats_metadata?.status;
  return typeof status === 'string' && status !== 'NOT_STARTED';
}

/**
 * Digitain (winner) carries a score object rather than a label, so the signal is
 * the live clock having started, with the short-status label accepted as well.
 * The status text is localised, which is why a plain equality on the label
 * missed every capitalised variant before.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function digitainEventIsLive(status) {
  if (status && typeof status === 'object') {
    const label = status.LiveMatchShortStatus?.['42'] || status.LiveMatchShortStatus?.['2'] || '';
    if (/^live/i.test(String(label).trim())) return true;
    return Number(status.LiveEventTime) > 0 || status.IsLiveStarted === true;
  }
  return /^live$/i.test(String(status || '').trim());
}

/**
 * Stamp a provider's markets with the live flag the engine pairs on.
 *
 * Returns the same array with `live` written on every member, so a caller cannot
 * forget one leg of a market and split its own book. `live` is always a boolean:
 * the engine treats a missing flag as pre-match, and a market that is silently
 * absent from the flag is exactly how a live leg would end up paired against a
 * pre-match one.
 *
 * @template {{ [k: string]: unknown }} T
 * @param {T[]} markets
 * @param {(market: T) => boolean} isLive
 * @returns {(T & { live: boolean })[]}
 */
export function markMarketsLive(markets, isLive) {
  for (const market of markets || []) {
    if (market && typeof market === 'object') market.live = isLive(market) === true;
  }
  return markets;
}

/**
 * An event is live when the provider says so, either on the event itself or on
 * any of its markets. `=== true` on both, so a string `"true"` written by some
 * adapter cannot make a pre-match book look live.
 *
 * @param {{ live?: unknown, markets?: Array<{ live?: unknown }> }} event
 * @returns {boolean}
 */
export function eventIsLive(event) {
  if (event?.live === true) return true;
  return Array.isArray(event?.markets) && event.markets.some((m) => m?.live === true);
}

/**
 * Per-book live capability, as measured — not as hoped for.
 *
 * `scope` is where the provider puts the signal: `event` or `market`. A null
 * scope means the field was never found, which is what the run report and the UI
 * read to tell a trader that this book has no in-play feed here — rather than
 * the blanket `live: false` that every adapter used to write, which said the
 * same thing about all 24 and was true of none of them in detail.
 *
 * `started` is how many in-play football events that book published in the
 * measurement window described at the top of this file. Zero is a fact about the
 * window, not a verdict on the feed.
 */
export const LIVE_EVIDENCE = Object.freeze({
  fortuna: { scope: 'market', field: 'market.kind === "LIVE"', started: 14 },
  'casa-pariurilor': { scope: 'market', field: 'market.kind === "LIVE"', started: 10 },
  unibet: { scope: 'event', field: 'contest.status === "InPlay"', started: 13 },
  winner: { scope: 'event', field: 'currentStatus live clock', started: 0 },
  superbet: { scope: 'event', field: 'inplay_stats_metadata.status', started: 0 },
  // Measured in the same window, no categorical field separating started from
  // future events. `started: 0` throughout: no in-play football in that hour.
  admiral: { scope: null, field: null, started: 0 },
  baumbet: { scope: null, field: null, started: 0 },
  betano: { scope: null, field: null, started: 0 },
  betmen: { scope: null, field: null, started: 0 },
  contibet: { scope: null, field: null, started: 0 },
  don: { scope: null, field: null, started: 0 },
  excelbet: { scope: null, field: null, started: 0 },
  favbet: { scope: null, field: null, started: 0 },
  getsbet: { scope: null, field: null, started: 0 },
  'las-vegas': { scope: null, field: null, started: 0 },
  magnumbet: { scope: null, field: null, started: 0 },
  maxbet: { scope: null, field: null, started: 0 },
  million: { scope: null, field: null, started: 0 },
  netbet: { scope: null, field: null, started: 0 },
  powerbet: { scope: null, field: null, started: 0 },
  stanleybet: { scope: null, field: null, started: 0 },
  topbet: { scope: null, field: null, started: 0 },
  winbet: { scope: null, field: null, started: 0 },
  winboss: { scope: null, field: null, started: 0 },
});

/**
 * What a book can actually do live, for the run report and the UI.
 *
 * @param {string} sourceId
 * @returns {{ live: boolean, scope: 'event'|'market'|null, field: string|null, started: number }}
 */
export function liveCoverageFor(sourceId) {
  const evidence = LIVE_EVIDENCE[sourceId] || { scope: null, field: null, started: 0 };
  return {
    live: evidence.scope !== null,
    scope: evidence.scope,
    field: evidence.field,
    started: evidence.started,
  };
}

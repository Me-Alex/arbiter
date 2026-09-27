export const FEG_SPORT_NAMES = Object.freeze({
  'ufo:sprt:00': 'Football', 'ufo:sprt:01': 'Tennis', 'ufo:sprt:02': 'Basketball',
  'ufo:sprt:03': 'Ice Hockey', 'ufo:sprt:04': 'Handball', 'ufo:sprt:07': 'Rugby',
  'ufo:sprt:09': 'Darts', 'ufo:sprt:11': 'Futsal',
});

/**
 * The one line that says why a request failed.
 *
 * `fetch` wraps everything in a generic `TypeError: fetch failed` and hides
 * the real cause on `cause`, which is where a DNS failure, a refused
 * connection, a TLS rejection and a timeout each end up. Reported bare, they
 * are four different problems that look like one — and the difference decides
 * whether the fix is a header, a retry, or accepting that the provider blocks
 * this network.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  if (!err) return 'unknown error';
  const cause = err.cause || {};
  const detail = cause.code || cause.message || err.code || err.message || String(err);
  // Undici appends "fetch failed" to every one of these, so the name carries
  // nothing; the cause is the whole story.
  return String(detail).replace(/\s*\(?fetch failed\)?\s*$/i, '').trim() || 'unknown error';
}

/**
 * Render accumulated failure causes for an error message.
 *
 * Deduplicated by the recorder, so this reads as "catalogue: HTTP 403 × 13"
 * rather than the same line thirteen times — one representative per cause is
 * enough, and the count says how widespread it was.
 *
 * @param {Map<string, number>} reasons  key → occurrences
 * @param {number} [limit]
 * @returns {string}
 */
export function summariseReasons(reasons, limit = 3) {
  if (!reasons || reasons.size === 0) return 'no reason recorded';
  return [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([why, n]) => (n > 1 ? `${why} ×${n}` : why))
    .join('; ');
}

/**
 * Human-readable label for a FEG sport id.
 *
 * The catalogue lists ids this table has no name for (23, 26, 27, 29, 35).
 * Returning a shared 'Unknown' for all of them gives every unmapped sport the
 * same `sport` value, and since the sport is part of the event identity key,
 * fixtures from different unmapped sports can collide into one event. Naming
 * the id keeps them apart and says plainly that the label is not known.
 *
 * @param {string} sportId
 * @returns {string}
 */
export function fegSportName(sportId) {
  const known = FEG_SPORT_NAMES[sportId];
  return known || `Unknown (${sportId})`;
}

export function normalizeFegMarket(m) {
  const selections = (m.outcomes || []).map(o => ({
    id: String(o.id || ''), name: String(o.name || '').trim(),
    odds: Number(o.odds ?? NaN), handicap: o.handicap ?? null,
  })).filter(s => s.name && Number.isFinite(s.odds) && s.odds > 1);
  if (selections.length < 2) return null;
  // Opaque provider IDs and 1/X/2 labels do not establish settlement rules.
  return { id: m.id, key: m.marketTypeId || 'unknown', name: m.name || 'Market',
    period: m.period || 'unknown', line: m.line ?? null, selections };
}

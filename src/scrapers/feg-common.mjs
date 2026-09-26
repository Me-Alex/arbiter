export const FEG_SPORT_NAMES = Object.freeze({
  'ufo:sprt:00': 'Football', 'ufo:sprt:01': 'Tennis', 'ufo:sprt:02': 'Basketball',
  'ufo:sprt:03': 'Ice Hockey', 'ufo:sprt:04': 'Handball', 'ufo:sprt:07': 'Rugby',
  'ufo:sprt:09': 'Darts', 'ufo:sprt:11': 'Futsal',
});

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

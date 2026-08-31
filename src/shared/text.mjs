/**
 * Numeric parsing that tolerates European odds formats: "1,85", "1.85",
 * "1 85", thousand-separator commas, etc.
 */
export function parseOdds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/\s+/g, '').replace(/,/g, '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 1 ? n : null;
}

export function decimalOdds(odds) {
  const n = Number(odds);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/** Implicit probability of an outcome priced at decimal odds o. */
export function impliedProbability(odds) {
  const n = decimalOdds(odds);
  return n ? 1 / n : null;
}

/** Strip diacritics + lowercase + collapse whitespace for event matching. */
export function normalizeTeamName(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(input) {
  return normalizeTeamName(input).split(' ').filter(Boolean);
}

/** Levenshtein distance (small inputs only, not used for huge strings). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

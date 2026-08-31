/**
 * Selection-name normalization.
 *
 * TinyFish returns whatever the page labels things as — "Egalitate", "X",
 * "Draw", "Empate", etc. The engine matches events across books by the
 * normalized selection name, so we collapse the variants into a single
 * canonical form before they reach the scanner.
 */

const DRAW_ALIASES = ['draw', 'x', 'egalitate', 'egal', 'empate', 'pareggio', 'remis', 'unentschieden', 'tie', 'd'];
const HOME_ALIASES = ['home', '1', 'gazde', 'g'];
const AWAY_ALIASES = ['away', '2', 'oaspeti', 'visiting', 'o'];

export function canonicalSelectionName(name, { homeTeam = '', awayTeam = '' } = {}) {
  if (!name) return '';
  const raw = String(name).trim();
  const s = raw.toLowerCase();
  if (DRAW_ALIASES.includes(s) || /^x\s*(?:\(|\.|$)/i.test(raw)) return 'Draw';
  if (HOME_ALIASES.includes(s) || /^1\s*(?:\(|\.|$)/i.test(raw)) return homeTeam || 'Home';
  if (AWAY_ALIASES.includes(s) || /^2\s*(?:\(|\.|$)/i.test(raw)) return awayTeam || 'Away';
  return raw;
}

export function normalizeKickoff(ts) {
  if (!ts) return null;
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

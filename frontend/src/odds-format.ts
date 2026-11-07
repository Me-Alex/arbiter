/**
 * odds-format.ts — Bidirectional odds conversion & formatting (European Decimal,
 * American, English Fractional, Hong Kong, Malay, Implied Probability %, and
 * Back <-> Lay equivalence), matching SureBet.com's /converter & terminal preferences.
 */

export type OddsFormat = 'decimal' | 'american' | 'fractional' | 'hongkong' | 'malay';

export interface ConvertedOddsSide {
  decimal: string;
  american: string;
  fractional: string;
  hongkong: string;
  malay: string;
  probability: string;
}

export interface ConvertedBackLay {
  backDecimal: number;
  layDecimal: number;
  back: ConvertedOddsSide;
  lay: ConvertedOddsSide;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/**
 * Best rational approximation p/q for positive profit multiple x = decimal - 1
 * with denominator q <= maxDenom using continued fractions.
 */
export function decimalToFractional(decimal: number, maxDenom = 100): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return '0/1';
  const x = decimal - 1;
  let h1 = 1;
  let h2 = 0;
  let k1 = 0;
  let k2 = 1;
  let b = x;
  for (let iter = 0; iter < 24; iter += 1) {
    const a = Math.floor(b + 1e-12);
    const h = a * h1 + h2;
    const k = a * k1 + k2;
    if (k > maxDenom) break;
    h2 = h1;
    h1 = h;
    k2 = k1;
    k1 = k;
    const rem = b - a;
    if (Math.abs(rem) < 1e-7 || Math.abs(x - h1 / k1) < 1e-4) break;
    b = 1 / rem;
  }
  if (k1 <= 0) return `${Math.max(1, Math.round(x * 100))}/100`;
  const d = gcd(h1, k1);
  return `${Math.max(1, Math.round(h1 / d))}/${Math.max(1, Math.round(k1 / d))}`;
}

export function decimalToAmerican(decimal: number): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return '+100';
  if (decimal >= 2) {
    return `+${Math.round((decimal - 1) * 100)}`;
  }
  return `-${Math.round(100 / (decimal - 1))}`;
}

export function decimalToHongKong(decimal: number): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return '0.00';
  return (decimal - 1).toFixed(2);
}

export function decimalToMalay(decimal: number): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return '0.00';
  const hk = decimal - 1;
  if (hk <= 1) {
    return hk.toFixed(2);
  }
  return (-1 / hk).toFixed(2);
}

export function decimalToProbability(decimal: number): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return '0.00';
  return (100 / decimal).toFixed(2);
}

/**
 * Format a decimal odd for compact display in OpportunityCard / Slip according
 * to the trader's preferred global OddsFormat.
 */
export function formatOdds(decimal: number, format: OddsFormat = 'decimal'): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return '—';
  switch (format) {
    case 'american':
      return decimalToAmerican(decimal);
    case 'fractional':
      return decimalToFractional(decimal);
    case 'hongkong':
      return decimalToHongKong(decimal);
    case 'malay':
      return decimalToMalay(decimal);
    case 'decimal':
    default:
      return decimal.toFixed(2);
  }
}

/**
 * Lay <-> Back decimal involution: a Lay at decimal L risks (L - 1) to win 1,
 * equivalent to backing the opposite side at decimal L / (L - 1).
 */
export function flipBackLayDecimal(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1.0001) return 2;
  return decimal / (decimal - 1);
}

export function formatConvertedSide(decimal: number): ConvertedOddsSide {
  const safe = Number.isFinite(decimal) && decimal > 1.0001 ? decimal : 2;
  return {
    decimal: safe.toFixed(3).replace(/0$/, ''),
    american: decimalToAmerican(safe),
    fractional: decimalToFractional(safe),
    hongkong: decimalToHongKong(safe),
    malay: decimalToMalay(safe),
    probability: decimalToProbability(safe),
  };
}

/**
 * Parse user input in any of the 6 converter fields ('decimal' | 'american' |
 * 'fractional' | 'hongkong' | 'malay' | 'probability') into a valid decimal odd > 1,
 * or null if incomplete/invalid while typing.
 */
export function parseToDecimal(
  rawInput: string,
  field: OddsFormat | 'probability',
): number | null {
  const cleaned = (rawInput ?? '').trim().replace(',', '.');
  if (!cleaned) return null;

  if (field === 'fractional') {
    const parts = cleaned.split('/');
    if (parts.length !== 2) return null;
    const num = Number(parts[0].trim());
    const den = Number(parts[1].trim());
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
    return 1 + num / den;
  }

  const val = Number(cleaned.replace(/%$/, ''));
  if (!Number.isFinite(val)) return null;

  switch (field) {
    case 'decimal':
      return val > 1.0001 ? val : null;
    case 'american':
      if (val >= 100) return 1 + val / 100;
      if (val <= -100) return 1 + 100 / Math.abs(val);
      return null;
    case 'hongkong':
      return val > 0.0001 ? 1 + val : null;
    case 'malay':
      if (val > 0.0001 && val <= 1) return 1 + val;
      if (val < -0.0001 && val >= -1) return 1 + 1 / Math.abs(val);
      return null;
    case 'probability':
      return val > 0.01 && val < 99.99 ? 100 / val : null;
    default:
      return null;
  }
}

export function convertFromSide(
  decimal: number,
  side: 'back' | 'lay' = 'back',
): ConvertedBackLay {
  const safe = Number.isFinite(decimal) && decimal > 1.0001 ? decimal : 2;
  const backDecimal = side === 'back' ? safe : flipBackLayDecimal(safe);
  const layDecimal = flipBackLayDecimal(backDecimal);
  return {
    backDecimal,
    layDecimal,
    back: formatConvertedSide(backDecimal),
    lay: formatConvertedSide(layDecimal),
  };
}

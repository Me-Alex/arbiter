/**
 * Round a number to 2 decimal places.
 * @param {number} n
 * @returns {number}
 */
export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Round a number to 4 decimal places.
 * @param {number} n
 * @returns {number}
 */
export function round4(n) {
  return Math.round(n * 10000) / 10000;
}

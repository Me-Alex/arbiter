import DigitainBrand from './digitain-brands.mjs';

/**
 * Pacanele — digitain, scaffolded by `npm run new-book` on 2026-10-11.
 *
 * The wire parser, the request shape and the market mapping are DigitainBrand's,
 * already exercised by the books that share this platform. What is new here is
 * one row in that base's table (BRANDS, added by
 * the same command — so this file has no state of its own to get out of sync.
 *
 * https://micros-prod1.gambling-solutions.ro/api/digitain-fetcher/v2/public/events
 *
 * Still unmeasured. Before this book is enabled it needs a real capture under
 * data/endpoints/captures/ and fixtures written from it, because the only claim
 * made here is that the brand was recorded, not that it returns priced markets.
 * docs/adding-a-book.md has the order.
 */
export default class Pacanele extends DigitainBrand {
  constructor(opts = {}) {
    super('pacanele', opts);
  }
}

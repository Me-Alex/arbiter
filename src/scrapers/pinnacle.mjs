import ScraperBase from './base.mjs';

/**
 * Pinnacle scraper stub.
 *
 * No public API endpoint has been identified for Pinnacle; this class is a placeholder
 * to reserve the book ID and allow the scraper registry to be extended.
 * Future work should implement fetchRaw, normalize, and extractEvents similar to other scrapers.
 */
export default class Pinnacle extends ScraperBase {
  id = 'pinnacle';
  name = 'Pinnacle';
  sourceIds = ['pinnacle'];

  constructor(opts = {}) {
    super(opts);
    // Default options can be set here if needed.
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.maxEvents = opts.maxEvents === 'all' ? Infinity : Number(opts.maxEvents ?? Infinity);
  }

  // Placeholder fetchRaw – returns empty raw data.
  async fetchRaw({ signal } = {}) {
    signal?.throwIfAborted();
    return { data: {} };
  }

  // Placeholder normalize – passes through raw data.
  normalize(raw) {
    return raw;
  }

  // Placeholder extractEvents – returns empty array.
  extractEvents(_normalized) {
    return [];
  }
}

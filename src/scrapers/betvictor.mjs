import ScraperBase from './base.mjs';

/**
 * Betvictor scraper stub.
 *
 * No public API endpoint has been identified for Betvictor; this class is a placeholder
 * to reserve the book ID and allow the scraper registry to be extended.
 * Future work should implement fetchRaw, normalize, and extractEvents similar to other scrapers.
 */
export default class Betvictor extends ScraperBase {
  id = 'betvictor';
  name = 'BetVictor';
  sourceIds = ['betvictor'];

  constructor(opts = {}) {
    super(opts);
    // Define default options if needed, e.g., timeoutMs, maxEvents, etc.
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

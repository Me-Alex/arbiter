import { ValidationError } from './errors.mjs';

/**
 * Default ceiling for a single upstream response body.
 *
 * The public adapters (nsoft, altenar) bound their own reads, and this helper
 * exists so every adapter that does not stream itself can borrow the same
 * limit: a provider that streams without a Content-Length would otherwise
 * exhaust memory inside a single scrape.
 *
 * 16 MB, matching nsoft.mjs, and set from measurement rather than taste: the
 * largest live responses observed are superbet ~7.4 MB and favbet ~14.4 MB
 * (scripts/live-check.mjs). A 4 MB cap looked tidy and would have rejected
 * favbet outright, so the limit has to sit above the biggest real feed with
 * room for growth — while still bounding a hostile or runaway response.
 *
 * Bytes are counted as they stream, so an oversized response is abandoned
 * mid-flight rather than buffered in full and measured afterwards.
 */
export const DEFAULT_MAX_BODY_BYTES = 16_000_000;

/**
 * Read a JSON response body, refusing anything over `maxBytes`.
 *
 * Counting while streaming means the cap is a real limit rather than a check
 * performed once the memory is already spent, and the reader is cancelled on
 * every exit path so the socket is released even when the cap trips.
 *
 * @param {Response} res
 * @param {string} id        scraper id, for the error message
 * @param {AbortSignal} [signal]
 * @param {number} [maxBytes]
 * @returns {Promise<object>}
 */
export async function readBoundedJson(res, id, signal, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new ValidationError(
          `${id}: response exceeds ${(maxBytes / 1_000_000).toFixed(1)} MB`,
          { field: 'response.size' },
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  signal?.throwIfAborted();
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    // A JSON parse failure with no context is the least actionable error a
    // provider can produce; say which endpoint and what it actually sent.
    throw new ValidationError(
      `${id}: response is not valid JSON (${text.slice(0, 80).replace(/\s+/g, ' ')})`,
      { field: 'response.body', cause: err },
    );
  }
}

/**
 * code-only.mjs — the one place a test decides "does this code read this
 * field", so it cannot decide it four different ways.
 *
 * The audit this repo keeps running asks the same shape of question in several
 * files: which fields of a payload does the page read, which names does the
 * loader write, which routes does the frontend call. Every answer was a regex
 * over raw source text, and a regex over raw source text cannot tell a read
 * from a mention. It is not a theoretical gap — it shipped. `selection.group`
 * is read by nobody in the whole frontend, and the only mention of it anywhere
 * is the word "group:" inside a comment in dashboard.js. A census that counts
 * comments credits a comment with a read, and the field it was built to find
 * reads clean.
 *
 * Three instruments had that hole (analytics-page twice, source-health-list,
 * and api-surface, fixed earlier). The fix is not four fixes: it is one
 * function, imported everywhere, so the next census written in this tree starts
 * from the honest version by default.
 *
 * `espree` is used because it is the tokenizer ESLint already runs over these
 * files. A hand-written scanner was tried first in api-surface and got a
 * backtick wrong, blanking the rest of a 700-line file from one line on — an
 * instrument that can be broken by ordinary code is not an instrument.
 */
import { createRequire } from 'node:module';

const { parse } = createRequire(import.meta.url)('espree');

/**
 * Blank the ranges the tokenizer calls comments, keeping every offset.
 *
 * Offsets are preserved deliberately: only non-newline characters become
 * spaces, so `codeOnly(src).slice(a, b)` is the same region as `src.slice(a, b)`
 * and a caller that finds its bounds on the raw text can take the same bounds
 * here. Every extraction below depends on that, so it is asserted rather than
 * assumed.
 *
 * A file that tokenizes as neither a module nor a script throws instead of
 * falling back to raw text. Silently keeping the comments is exactly the false
 * pass this exists to remove, so an unparseable input is a loud failure.
 *
 * @param {string} src
 * @param {boolean} [isJs] false for HTML, where `<!-- -->` is the comment form.
 * @returns {string} the same text with comments blanked, same length.
 */
export function codeOnly(src, isJs = true) {
  if (!isJs) {
    const out = src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n\r]/g, ' '));
    if (out.length !== src.length) throw new Error('HTML comment blanking changed the length');
    return out;
  }
  let comments = null;
  // Files under public/ are a mix of ES modules and plain scripts, so both
  // source types are tried before giving up.
  for (const sourceType of ['module', 'script']) {
    try {
      comments = parse(src, { ecmaVersion: 2023, sourceType, comment: true, range: true }).comments;
      break;
    } catch { /* try the other source type */ }
  }
  if (!comments) throw new Error(`could not tokenize ${src.slice(0, 60).replace(/\n/g, ' ')}`);
  const out = src.split('');
  for (const c of comments) {
    for (let i = c.range[0]; i < c.range[1]; i += 1) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  }
  const text = out.join('');
  if (text.length !== src.length) throw new Error('comment blanking changed the length');
  return text;
}

/**
 * Field names read off one receiver, from text that is already blanked.
 *
 * The receiver is boundary-anchored on purpose. `source.includes('b.odds')` is
 * satisfied by `db.odds` and `tb.odds` — and `analytics.js` really does have a
 * `tb`, the table body element — so the looser form credits a read on an object
 * that is not the one being asked about, and a field can look read for a reason
 * unrelated to the page reading it.
 *
 * @param {string} text source or already-blanked source
 * @param {string} receiver a plain identifier
 * @returns {string[]} unique, sorted
 */
export function fieldsOn(text, receiver) {
  if (!/^\w+$/.test(receiver)) throw new Error(`receiver must be an identifier, got ${receiver}`);
  return [...new Set([...text.matchAll(new RegExp(`\\b${receiver}\\.(\\w+)`, 'g'))].map((m) => m[1]))].sort();
}

/**
 * Field names one receiver reads, comments already excluded.
 *
 * @param {string} src whole source file
 * @param {string} receiver
 * @param {boolean} [isJs]
 * @returns {string[]}
 */
export function fieldReads(src, receiver, isJs = true) {
  return fieldsOn(codeOnly(src, isJs), receiver);
}

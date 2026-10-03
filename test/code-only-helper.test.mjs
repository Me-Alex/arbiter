/**
 * code-only-helper.test.mjs — the instrument the payload censuses are built on
 * has to be shown to see, before a negative result from one of them means
 * anything.
 *
 * Four census tests in this tree answer "does the page read this field" by
 * reading the page's source. Before this helper, each of them did that with its
 * own regex over raw text, and raw text cannot tell a read from a mention — the
 * gap this repo already walked into once, with `selection.group`, whose only
 * trace anywhere in the frontend is the word "group:" in a comment.
 *
 * So the helper gets tested in both directions on purpose. A masker that
 * blanks too much is as wrong as one that blanks too little: it would report
 * real reads as absent and quietly turn a census into noise. Both failure modes
 * are pinned here, on samples built so a real read and a comment cannot cancel
 * each other out — an earlier version of that sample put both on the same field
 * and proved nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codeOnly, fieldReads, fieldsOn, guardedPropertyReads } from './helpers/code-only.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');

test('a read in code counts and the same text in a comment does not', () => {
  const src = [
    'function render(cat, m) {',
    '  const rows = cat.markets.length;',      // a real read
    '  // cat.events is never read here',       // a mention only
    '  /* m.sourceId is in the row */',        // a mention only
    '  return m.marketKey;',                    // a real read
    '  // m.eventCount is rendered by the other page',
    '}',
  ].join('\n');
  assert.deepEqual(fieldReads(src, 'cat'), ['markets'],
    'the real read must survive, the comment must not');
  assert.deepEqual(fieldReads(src, 'm'), ['marketKey'],
    'a comment mentioning a field is not a read of it');
});

test('the masker blanks comments without moving anything', () => {
  // Every extraction in the tree that works on a *slice* takes its bounds from
  // the raw text and applies them to the blanked one. That only works if the
  // blanked text is the same length, so the contract is asserted here rather
  // than assumed at four call sites.
  const src = 'const a = cat.markets;\n// a comment\nconst b = m.marketKey;\n/* block\n   comment */\n';
  const out = codeOnly(src, true);
  assert.equal(out.length, src.length, 'offsets moved');
  assert.equal(out.split(/\r?\n/).length, src.split(/\r?\n/).length, 'line count moved');
  assert.equal(out[0], src[0], 'the first line was not left alone');

  // And a slice taken with raw bounds lands on the same region: the read at
  // index 6 in the source is still at index 6.
  const at = src.indexOf('cat.markets');
  assert.match(out.slice(at, at + 11), /cat\.markets/);
  const commentAt = src.indexOf('// a comment');
  assert.doesNotMatch(out.slice(commentAt, commentAt + 12), /comment/);
});

test('a receiver boundary holds, so a longer name cannot answer for a shorter one', () => {
  // `source.includes('b.odds')` is satisfied by `db.odds` and `tb.odds`, and
  // analytics.js does have a `tb` — the table body element. Without the
  // boundary, a field can look read on account of an object that is not the one
  // being asked about.
  const src = 'const t = tb.odds; const d = db.odds; const m = mm.marketKey; const c = cat.markets;';
  assert.deepEqual(fieldsOn(src, 'b'), [], 'tb/db answered for b');
  assert.deepEqual(fieldsOn(src, 'm'), [], 'mm answered for m');
  assert.deepEqual(fieldsOn(src, 'cat'), ['markets'], 'the real receiver still reads its own field');
  assert.equal(src.includes('b.odds'), true, 'the loose form would have matched — control');
});

test('a receiver that is not an identifier is refused rather than interpolated', () => {
  assert.throws(() => fieldsOn('const a = 1;', 'b|cat'), /identifier/);
});

test('source that tokenizes as neither a module nor a script throws', () => {
  // The fallback this replaces kept the comments and reported a false pass,
  // which is the one outcome the helper exists to make impossible.
  const broken = 'const a = {;;;\nfunction (';
  assert.throws(() => codeOnly(broken, true), /could not tokenize/);
});

test('HTML comments are blanked on the HTML path', () => {
  const src = '<div id="a"></div>\n<!-- cat.events used to be here -->\n<div id="b"></div>';
  const out = codeOnly(src, false);
  assert.equal(out.length, src.length);
  assert.doesNotMatch(out, /cat\.events/);
  assert.match(out, /id="b"/, 'the rest of the markup survived');
});

test('a read through a fallback receiver is a read, and a fallback nobody owns is not', () => {
  // `(scan.options || {}).liveMaxAgeMs` is a read of `scan.options`, and a
  // matcher written on the object's own text cannot see it — the object is a
  // LogicalExpression. The blindness is in the direction that invents a gap: the
  // scan census ran over the page that reads it and reported the field unread.
  const src = [
    'function liveWindowNote(t, scan) {',
    '  const ms = Number((scan.options || {}).liveMaxAgeMs);',   // the read
    '  return ms ? t(\'liveWindow\') + ms : \'\';',
    '}',
  ].join('\n');
  assert.deepEqual(guardedPropertyReads(src, ['scan.options']).map((r) => r.key), ['liveMaxAgeMs'],
    'a read through a fallback receiver is invisible');
  assert.deepEqual(guardedPropertyReads(src, ['scan']).map((r) => r.key), ['options'],
    'the inner read still belongs to the outer receiver');

  // The other direction, and it is the one that invents a field: the fallback
  // only widens the match to the receiver it actually falls back FROM. An
  // unrelated object behind the same `||` must not answer for it.
  const other = 'const ms = Number((lastState.options || {}).liveMaxAgeMs);';
  assert.deepEqual(guardedPropertyReads(other, ['scan.options']), [],
    'another object answered for this receiver');
  assert.deepEqual(guardedPropertyReads('const ms = (scan.other || {}).liveMaxAgeMs;', ['scan.options']), [],
    'a sibling key answered for this receiver');

  // And `??` is the same shape, so it is the same rule.
  assert.deepEqual(
    guardedPropertyReads('const ms = (scan.options ?? {}).liveMaxAgeMs;', ['scan.options']).map((r) => r.key),
    ['liveMaxAgeMs'],
    'a nullish fallback is not seen through',
  );
});

test('the real files still parse, and their real reads are still found', () => {
  // Controls on the actual sources rather than on samples: the census this
  // serves reads analytics.js and tracker-service.mjs every run, so a masker
  // that quietly stops working on them would be the failure that matters.
  const analytics = read('public/js/pages/analytics.js');
  const cat = fieldReads(analytics, 'cat');
  const m = fieldReads(analytics, 'm');
  assert.ok(cat.includes('markets') && cat.includes('builtAt') && cat.includes('scrapeRunId'),
    `the catalog card stopped reading its own document: ${cat.join(', ')}`);
  assert.ok(m.includes('marketKey') && m.includes('eventCount') && m.includes('selectionCount'),
    `the catalog table stopped reading its rows: ${m.join(', ')}`);

  // And the loader still reports every name it writes, so the producer-side
  // census in source-health-list has not been emptied by blanking.
  const scanner = codeOnly(read('src/scanner/scanner.mjs'), true);
  assert.ok(/\bsource\.feedGroup\b/.test(scanner), 'the loader stopped writing feedGroup');
  assert.ok(/\bdataReasonCode\s*[:=]\s*'/.test(scanner), 'the loader stopped writing a reason code');
});

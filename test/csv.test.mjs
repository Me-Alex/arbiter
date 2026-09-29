import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvRow, parseCsvLine } from '../src/shared/csv.mjs';

/**
 * The CSV quoting rule lived in two places and they disagreed on the one
 * character that matters. scan-service escaped a carriage return; the tracker
 * copy did not, so a note containing a bare `\r` exported unquoted from the
 * tracker and came back as two rows. These assertions pin the single, stricter
 * rule both callers now share.
 */

test('a value that would break the row is quoted', () => {
  assert.equal(csvCell('a,b'), '"a,b"', 'a comma would start a new column');
  assert.equal(csvCell('a\nb'), '"a\nb"', 'a newline would start a new row');
  assert.equal(csvCell('a\rb'), '"a\rb"', 'a carriage return is the regression: it was exported unquoted');
  assert.equal(csvCell('a"b'), '"a""b"', 'an embedded quote is doubled');
});

test('a plain value is left alone', () => {
  assert.equal(csvCell('abc'), 'abc');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(''), '');
});

test('an absent value is an empty field, not the text null', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0', 'zero is a value and must survive');
  assert.equal(csvCell(false), 'false', 'false is a value and must survive');
});

test('a row joins with commas and quotes each cell', () => {
  assert.equal(csvRow(['a', 'b,c', null]), 'a,"b,c",');
});

test('a quoted field survives a write and read', () => {
  const value = 'has,comma and "quote"';
  assert.deepEqual(parseCsvLine(csvRow(['x', value])), ['x', value]);
});

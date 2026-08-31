import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOdds, impliedProbability, normalizeTeamName, levenshtein, tokens } from '../src/shared/text.mjs';

test('parseOdds accepts decimal and rejects garbage', () => {
  assert.equal(parseOdds('1.85'), 1.85);
  assert.equal(parseOdds('1,85'), 1.85);
  assert.equal(parseOdds(2.10), 2.10);
  assert.equal(parseOdds('foo'), null);
  assert.equal(parseOdds('0.5'), null); // below 1.0
  assert.equal(parseOdds(''), null);
});

test('impliedProbability is 1/odds', () => {
  assert.equal(impliedProbability(2), 0.5);
  assert.equal(impliedProbability(4), 0.25);
  assert.equal(impliedProbability('not odds'), null);
});

test('normalizeTeamName strips diacritics and lowercases', () => {
  assert.equal(normalizeTeamName('FCSB'), 'fcsb');
  assert.equal(normalizeTeamName('CFR Cluj-Napoca'), 'cfr cluj napoca');
  assert.equal(normalizeTeamName('Universitatea Craiova'), 'universitatea craiova');
});

test('tokens splits on whitespace', () => {
  assert.deepEqual(tokens('Manchester United FC'), ['manchester', 'united', 'fc']);
});

test('levenshtein is symmetric and zero on equal strings', () => {
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('abc', 'abd'), 1);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('abc', ''), 3);
});

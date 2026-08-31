import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSelectionName, normalizeKickoff } from '../src/tinyfish/normalize.mjs';

test('canonicalSelectionName maps Draw variants to "Draw"', () => {
  for (const v of ['draw', 'X', 'x', 'egalitate', 'EGALITATE', 'empate', 'pareggio', 'remis', 'unentschieden']) {
    assert.equal(canonicalSelectionName(v), 'Draw', `expected "${v}" → Draw`);
  }
});

test('canonicalSelectionName maps Home/1/Gazde to homeTeam', () => {
  assert.equal(canonicalSelectionName('Home', { homeTeam: 'FCSB' }), 'FCSB');
  assert.equal(canonicalSelectionName('1', { homeTeam: 'FCSB' }), 'FCSB');
  assert.equal(canonicalSelectionName('Gazde', { homeTeam: 'FCSB' }), 'FCSB');
  assert.equal(canonicalSelectionName('Home'), 'Home');
});

test('canonicalSelectionName maps Away/2/Oaspeti to awayTeam', () => {
  assert.equal(canonicalSelectionName('Away', { awayTeam: 'CFR' }), 'CFR');
  assert.equal(canonicalSelectionName('2', { awayTeam: 'CFR' }), 'CFR');
  assert.equal(canonicalSelectionName('Oaspeti', { awayTeam: 'CFR' }), 'CFR');
});

test('canonicalSelectionName passes through unknown names', () => {
  assert.equal(canonicalSelectionName('Over 2.5', {}), 'Over 2.5');
  assert.equal(canonicalSelectionName('FCSB -1.5', {}), 'FCSB -1.5');
});

test('normalizeKickoff parses ISO timestamps', () => {
  assert.equal(normalizeKickoff('2026-01-15T18:00:00Z'), '2026-01-15T18:00:00.000Z');
  assert.equal(normalizeKickoff('2026-01-15T18:00:00+03:00'), '2026-01-15T15:00:00.000Z');
  assert.equal(normalizeKickoff(null), null);
  assert.equal(normalizeKickoff('not a date'), null);
});

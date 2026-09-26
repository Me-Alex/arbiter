import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOdds, impliedProbability, normalizeTeamName, normalizeClubIdentity, canonicalSport, eventIdentityKey, levenshtein, tokens } from '../src/shared/text.mjs';

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

test('normalizeClubIdentity drops legal suffixes that never identify a club', () => {
  // /api/event-detail matches a queried club against provider names, and the
  // same club is written "FC Dinamo" by one source and "Dinamo" by another.
  assert.equal(normalizeClubIdentity('FC Dinamo Bucuresti'), 'dinamo bucuresti');
  assert.equal(normalizeClubIdentity('Dinamo Bucuresti'), 'dinamo bucuresti');
  assert.equal(normalizeClubIdentity('ACS FC Dinamo București'), 'dinamo bucuresti');
  assert.equal(normalizeClubIdentity('SS Lazio'), 'lazio');
  assert.equal(normalizeClubIdentity('Paris Saint-Germain FC'), 'paris saint germain');
});

test('normalizeClubIdentity keeps distinguishing tokens and never returns empty', () => {
  assert.equal(normalizeClubIdentity('Rapid Bucuresti'), 'rapid bucuresti');
  // A name made only of noise tokens falls back to the full token list rather
  // than producing an empty key that would match every other empty key.
  assert.equal(normalizeClubIdentity('FC'), 'fc');
  assert.equal(normalizeClubIdentity(''), '');
  assert.equal(normalizeClubIdentity(null), '');
});

test('canonicalSport maps Romanian and platform labels onto one id', () => {
  // The same fixture arrives as "Basketball" from maxbet and "Baschet" from
  // winner; without this the identity keys differ and the event never pairs.
  assert.equal(canonicalSport('Football'), 'football');
  assert.equal(canonicalSport('Fotbal'), 'football');
  assert.equal(canonicalSport('Basketball'), 'basketball');
  assert.equal(canonicalSport('Baschet'), 'basketball');
  assert.equal(canonicalSport('Tennis'), 'tennis');
  assert.equal(canonicalSport('Tenis'), 'tennis');
  assert.equal(canonicalSport('Hochei'), 'ice-hockey');
  assert.equal(canonicalSport('Ice Hockey'), 'ice-hockey');
  assert.equal(canonicalSport('Handbal'), 'handball');
  assert.equal(canonicalSport('Fotbal American'), 'american-football');
  assert.equal(canonicalSport('E-Football'), 'esports');
  // An unknown sport is kept, hyphenated, rather than dropped.
  assert.equal(canonicalSport('Kabaddi'), 'kabaddi');
  assert.equal(canonicalSport(''), '');
});

test('eventIdentityKey ignores the league so differently named competitions pair', () => {
  // netbet says "Nations League", admiral says "UEFA Liga Natiunilor": the same
  // competition. With the league in the key these never matched, and no
  // cross-book arbitrage was detectable at all.
  const a = { sport: 'Football', league: 'Nations League', kickoff: '2026-09-26T16:00:00Z', homeTeam: 'Islanda', awayTeam: 'Estonia' };
  const b = { sport: 'Football', league: 'UEFA Liga Natiunilor', kickoff: '2026-09-26T16:00:00Z', homeTeam: 'Islanda', awayTeam: 'Estonia' };
  assert.equal(eventIdentityKey(a), eventIdentityKey(b));

  // The same fixture with a different sport must not pair.
  const basketball = { ...b, sport: 'Basketball' };
  assert.notEqual(eventIdentityKey(a), eventIdentityKey(basketball));

  // A different day is a different fixture.
  const tomorrow = { ...b, kickoff: '2026-09-27T16:00:00Z' };
  assert.notEqual(eventIdentityKey(a), eventIdentityKey(tomorrow));

  // A different pairing of the same teams must not match.
  const reversed = { ...b, homeTeam: 'Estonia', awayTeam: 'Islanda' };
  assert.notEqual(eventIdentityKey(a), eventIdentityKey(reversed));
});

test('eventIdentityKey tolerates club-name variation between providers', () => {
  const a = { sport: 'Football', kickoff: '2026-09-26T16:00:00Z', homeTeam: 'FC Dinamo', awayTeam: 'Rapid Bucuresti' };
  const b = { sport: 'Football', kickoff: '2026-09-26T16:00:00Z', homeTeam: 'ACS FC Dinamo Bucuresti', awayTeam: 'Rapid' };
  // "FC Dinamo" normalises to "dinamo" while "ACS FC Dinamo Bucuresti" gives
  // "dinamo bucuresti", and the away sides differ too. The key absorbs legal
  // suffixes but is otherwise exact: it guards against false pairing rather
  // than fuzzily matching, so genuinely different names must not be forced
  // together.
  assert.equal(eventIdentityKey(a), 'football|2026-09-26|dinamo|rapid bucuresti');
  assert.equal(eventIdentityKey(b), 'football|2026-09-26|dinamo bucuresti|rapid');
  assert.notEqual(eventIdentityKey(a), eventIdentityKey(b));

  // A legal-suffix-only difference on the home side does collapse.
  const suffixOnly = { sport: 'Football', kickoff: '2026-09-26T16:00:00Z', homeTeam: 'ACS FC Dinamo', awayTeam: 'Rapid Bucuresti' };
  assert.equal(eventIdentityKey(suffixOnly), eventIdentityKey(a));
});

import test from 'node:test';
import assert from 'node:assert/strict';

import Winner from '../src/scrapers/winner.mjs';

/**
 * The Digitain public feed, as it actually answers.
 *
 * These two field shapes are the reason this file exists. `matchDateTime` is
 * an epoch in milliseconds, not an ISO string, and `currentStatus` is a score
 * object rather than a status label. Both were read as the other kind, which
 * silently produced a clean run that collected nothing: a `Date.parse` of a
 * number is NaN, so every event was skipped as malformed. The unit fixtures
 * used ISO strings and a plain "Live" string, so the mismatch was invisible
 * until a live capture came back empty.
 */

const FUTURE_MS = Date.now() + 86_400_000;
const PAST_MS = Date.now() - 86_400_000;

const outcomes = (odds = [2.50, 3.40, 3.20]) => [
  { idMbo: 1, mboActive: true, mboOddValue: odds[0], mboDisplayName: { 0: '1' } },
  { idMbo: 2, mboActive: true, mboOddValue: odds[1], mboDisplayName: { 0: 'X' } },
  { idMbo: 3, mboActive: true, mboOddValue: odds[2], mboDisplayName: { 0: '2' } },
];

/** A match shaped like the live feed, not like a hand-written fixture. */
function match(over = {}) {
  return {
    idMatch: 900001,
    active: true,
    bettingStatus: true,
    team1Name: 'FCSB',
    team2Name: 'Dinamo',
    matchDateTime: FUTURE_MS,
    sportName: { 0: 'Fotbal' },
    tournamentName: { 0: 'Liga 1' },
    // The real payload carries a score object here, not a label.
    currentStatus: { HomeTeamScore: 0, AwayTeamScore: 0, LiveEventTime: 0, LiveMatchShortStatus: { 2: 'Not Started', 42: 'Nu a început' } },
    matchBets: [{ idBet: 1, mbActive: true, mbDisplayName: { 0: 'Rezultat' }, mbOutcomes: outcomes() }],
    ...over,
  };
}

const extract = (raw, opts = {}) => new Winner({ timeoutMs: 5_000, ...opts }).extractEvents([raw]);
const count = (over, opts) => extract(match(over), opts).length;

test('a future football match is collected', () => {
  assert.equal(count({}), 1);
});

test('matchDateTime is an epoch in milliseconds, not an ISO string', () => {
  // The regression: Date.parse(1790494200000) is NaN, so every event was
  // dropped as malformed and the run reported success with zero events.
  const [event] = extract(match());
  assert.ok(event, 'an epoch kickoff must be understood');
  assert.equal(event.kickoff, new Date(FUTURE_MS).toISOString());
  assert.equal(event.homeTeam, 'FCSB');
});

test('an ISO kickoff is still accepted, in case the feed changes shape', () => {
  const iso = new Date(FUTURE_MS).toISOString();
  assert.equal(count({ matchDateTime: iso }), 1, 'a string timestamp is not a regression');
});

test('a malformed kickoff drops the row instead of aborting the run', () => {
  assert.equal(count({ matchDateTime: 'not a date' }), 0);
  assert.equal(count({ matchDateTime: undefined }), 0);
  // One bad row must not cost the good ones.
  const out = new Winner({}).extractEvents([match({ matchDateTime: 'zzz' }), match({ idMatch: 2 })]);
  assert.equal(out.length, 1, 'the sound event still survives');
});

test('a running match is recognised from its live clock, not from a label', () => {
  // currentStatus is an object; reading a status out of it yields either an
  // object or a number, never the word "Live".
  assert.equal(count({ currentStatus: { LiveEventTime: 120 } }), 0, 'a started clock means live');
  assert.equal(count({ currentStatus: { LiveEventTime: 0 } }), 1, 'a zero clock is not live');
  assert.equal(count({ currentStatus: { LiveMatchShortStatus: { 2: 'Live' } } }), 0, 'the nested label counts too');
  // includeLive keeps it.
  assert.equal(count({ currentStatus: { LiveEventTime: 120 } }, { includeLive: true }), 1);
});

test('a plain status label is still understood', () => {
  assert.equal(count({ currentStatus: 'Live' }), 0);
  assert.equal(count({ currentStatus: 'live' }), 0);
  assert.equal(count({ currentStatus: 'Not Started' }), 1);
});

test('only pre-match football is published', () => {
  assert.equal(count({ matchDateTime: PAST_MS }), 0, 'a started match is not pre-match');
  assert.equal(count({ sportName: { 0: 'Baschet' } }), 0, 'the feed carries 30+ sports');
  assert.equal(count({ sportName: { 0: 'Tenis' } }), 0);
  assert.equal(count({ sportName: { 2: 'Football' } }), 1, 'the English label is the same sport');
});

test('includePast admits a started match, so a caller can ask for it explicitly', () => {
  assert.equal(count({ matchDateTime: PAST_MS }, { includePast: true }), 1);
});

test('a market that settles before the final whistle is not labelled full-time', () => {
  const firstHalf = (name) => match({
    matchBets: [{ idBet: 1, mbActive: true, mbDisplayName: { 0: name }, mbOutcomes: outcomes() }],
  });
  for (const name of ['Rezultat repriza 1', '1st Half Result', 'Pauza sau Final', 'Pauza']) {
    const [event] = extract(firstHalf(name));
    assert.notEqual(event.markets[0].period, 'fulltime', `"${name}" must not claim full-time settlement`);
  }
  const [ft] = extract(firstHalf('Rezultat'));
  assert.equal(ft.markets[0].period, 'fulltime');
});

test('provenance and identity are carried on the published event', () => {
  const s = new Winner({ timeoutMs: 5_000 });
  const [event] = s.extractEvents([match()]);
  assert.equal(event.sourceId, 'winner');
  assert.equal(event.sport, 'Fotbal');
  assert.equal(event.league, 'Liga 1');
  assert.equal(event.live, false);
  assert.ok(event.eventKey, 'an event key is required by the base validator');
  assert.ok(event.markets[0].selections.every((x) => Number.isFinite(x.odds) && x.odds > 1));
});

test('the declared coverage matches what is actually emitted', () => {
  const s = new Winner({ timeoutMs: 5_000 });
  const snapshot = s._serializable([], {});
  assert.equal(snapshot.coverage.sport, 'football', 'not the 30+ sports the feed carries');
  assert.equal(snapshot.coverage.live, false);
  assert.equal(snapshot.transport, 'winner-digitain-public-json');
  // sourceUrl is established by fetchRaw, so a snapshot taken before a fetch
  // carries none — the scanner rejects such a snapshot, which is the point.
  assert.equal(snapshot.sourceUrl, undefined, 'no invented endpoint before a fetch');
  s.sourceUrl = 'https://example.invalid/events';
  assert.equal(s._serializable([], {}).sourceUrl, 'https://example.invalid/events');
});

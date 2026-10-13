import test from 'node:test';
import assert from 'node:assert/strict';

import Winner from '../src/scrapers/winner.mjs';
import DigitainBrand from '../src/scrapers/digitain-brands.mjs';
import { resolveContract, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

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

test('only pre-match football is published by default, sport: all admits any sport', () => {
  assert.equal(count({ matchDateTime: PAST_MS }), 0, 'a started match is not pre-match');
  assert.equal(count({ sportName: { 0: 'Baschet' } }), 0, 'the feed carries 30+ sports');
  assert.equal(count({ sportName: { 0: 'Tenis' } }), 0);
  assert.equal(count({ sportName: { 2: 'Football' } }), 1, 'the English label is the same sport');
  assert.equal(count({ sportName: { 0: 'Baschet' } }, { sport: 'all' }), 1, 'sport: all admits basketball');
  assert.equal(count({ sportName: { 0: 'Tenis' } }, { sport: 'all' }), 1, 'sport: all admits tennis');
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

test('a bundled goals total becomes one market per line, with the line in the leg name', () => {
  // Measured live 2026-09-29: one football fixture carried a single matchBets
  // entry named "Total goluri" whose outcomes spanned every line the book
  // quoted — 4.5, 5.5, 6.5 and 7 — under the same idBet 3. Publishing that as
  // one market is the multi-line bug the engine already documents.
  //
  // The legs read bare "Peste"/"Sub" and carry the number in `argument`, so
  // before this the market produced no lineKey at all and the book contributed
  // no total whatsoever.
  const total = (lines) => ({
    idBet: 3,
    mbActive: true,
    mbDisplayName: { 42: 'Total goluri' },
    mbOutcomes: lines.flatMap((line, i) => ([
      {
        idMbo: 1000 + i * 2, mboActive: true, mboOddValue: 1.2 + i * 0.1,
        mboType: { 42: 'Peste' }, mboDisplayName: { 42: 'Peste' }, argument: line,
      },
      {
        idMbo: 1001 + i * 2, mboActive: true, mboOddValue: 4.1 + i * 0.1,
        mboType: { 42: 'Sub' }, mboDisplayName: { 42: 'Sub' }, argument: line,
      },
    ])),
  });

  const [event] = extract(match({ matchBets: [total([4.5, 5.5, 6.5, 7])] }));
  const totals = event.markets.filter((m) => m.key === 'total_goals');
  assert.equal(totals.length, 3, 'one market per line, and the whole line is not a contract');

  assert.deepEqual(totals.map((m) => m.name), ['Total goluri 4.5', 'Total goluri 5.5', 'Total goluri 6.5']);
  for (const m of totals) {
    assert.equal(m.period, 'fulltime');
    assert.equal(m.selections.length, 2, 'exactly two opposite sides');
    // The line has to be readable by the universal line extractor, which reads
    // the name — a bare "Peste" yields no lineKey and the market is unusable.
    assert.ok(m.selections.every((s) => /\d/.test(s.name)), `leg names must carry the line: ${m.selections.map((s) => s.name)}`);
    assert.ok(m.selections.every((s) => s.odds > 1), 'the book price is preserved verbatim');
  }
  assert.deepEqual(
    totals[0].selections.map((s) => s.name),
    ['Peste 4.5', 'Sub 4.5'],
  );
});

test('a quarter line is dropped from a total too, and the result market is untouched', () => {
  const total = (lines) => ({
    idBet: 3,
    mbActive: true,
    mbDisplayName: { 42: 'Total goluri' },
    mbOutcomes: lines.flatMap((line, i) => ([
      { idMbo: 2000 + i * 2, mboActive: true, mboOddValue: 1.3, mboType: { 42: 'Peste' }, argument: line },
      { idMbo: 2001 + i * 2, mboActive: true, mboOddValue: 3.3, mboType: { 42: 'Sub' }, argument: line },
    ])),
  });
  // 2.25 and 2 both half-push at exactly 2 goals, so neither pair is exhaustive.
  const [event] = extract(match({ matchBets: [total([2, 2.25, 2.5])] }));
  assert.deepEqual(event.markets.map((m) => m.name), ['Total goluri 2.5']);

  // The 1X2 path is unchanged: a result market has no `argument`, so it must
  // still publish as a single three-way market rather than being read as a total.
  const [plain] = extract(match());
  assert.equal(plain.markets.length, 1);
  assert.equal(plain.markets[0].key, 1, 'the provider bet id is published verbatim');
  assert.equal(plain.markets[0].selections.length, 3);
});

test('a bundled total that is not goals is not published at all', () => {
  // The bundled over/under shape is not self-describing: swept across the whole
  // payload 2026-09-29 it appears as "Total puncte Peste/Sub" (basketball,
  // American football, rugby union), "Total goluri" and a bare "Total" (polo,
  // bandy). Only the goals one may be published as total_goals — a points total
  // republished as goals is a mislabel that would pair against a real goals line.
  //
  // Note it is dropped rather than falling through to the generic path: falling
  // through would publish one market spanning every line, which is the
  // multi-line bug the bundled branch exists to prevent.
  const points = (lines) => ({
    idBet: 3,
    mbActive: true,
    mbDisplayName: { 42: 'Total puncte Peste/Sub' },
    mbOutcomes: lines.flatMap((line, i) => ([
      { idMbo: 3000 + i * 2, mboActive: true, mboOddValue: 1.4, mboType: { 42: 'Peste' }, argument: line },
      { idMbo: 3001 + i * 2, mboActive: true, mboOddValue: 3.4, mboType: { 42: 'Sub' }, argument: line },
    ])),
  });
  // With nothing else on the fixture the event carries no market at all and is
  // not published, rather than being emitted with an unusable total in it. The
  // same holds for the bare "Total" of polo and bandy — equally ambiguous.
  const pointsAlone = extract(match({ matchBets: [points([44.5, 45.5, 46.5])] }));
  assert.deepEqual(pointsAlone, [], 'a points total is not a goals contract, so it publishes nothing');

  const bareAlone = extract(match({
    matchBets: [{ ...points([10.5, 26.5]), mbDisplayName: { 42: 'Total' } }],
  }));
  assert.deepEqual(bareAlone, [], 'an unverifiable total publishes nothing');

  // Alongside a real result market the event does publish, with the points total
  // absent rather than mislabelled as goals.
  const mixed = extract(match({
    matchBets: [
      { idBet: 1, mbActive: true, mbDisplayName: { 0: 'Rezultat' }, mbOutcomes: outcomes() },
      points([44.5, 45.5]),
    ],
  }));
  assert.deepEqual(mixed[0].markets.map((m) => m.key), [1]);
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
  // `live` is the feed's measured capability — the Digitain payload names a
  // running match on `currentStatus`, and the adapter reads that field. It is
  // NOT a claim about this run: `liveCollected` is, and defaults to false. The
  // old assertion read `Boolean(this.includeLive)` and so described the run
  // under the capability's name, making a live-capable feed look incapable on
  // every prematch-configured run.
  assert.equal(snapshot.coverage.live, true, 'the feed names in-play events');
  assert.equal(snapshot.coverage.scope, 'event');
  assert.equal(snapshot.coverage.liveCollected, false, 'a prematch run collected no in-play events');
  assert.equal(snapshot.transport, 'winner-digitain-public-json');
  // sourceUrl is established by fetchRaw, so a snapshot taken before a fetch
  // carries none — the scanner rejects such a snapshot, which is the point.
  assert.equal(snapshot.sourceUrl, undefined, 'no invented endpoint before a fetch');
  s.sourceUrl = 'https://example.invalid/events';
  assert.equal(s._serializable([], {}).sourceUrl, 'https://example.invalid/events');
});

test('DigitainBrand extracts 2-way match winner for basketball and tennis events', () => {
  const brand = new DigitainBrand('mrplay', { sport: 'all' });
  const rawTennisMatch = {
    idMatch: 950001,
    active: true,
    bettingStatus: true,
    team1Name: { 2: 'Jannik Sinner', 42: 'Jannik Sinner' },
    team2Name: { 2: 'Carlos Alcaraz', 42: 'Carlos Alcaraz' },
    matchDateTime: FUTURE_MS,
    sportName: { 2: 'Tennis', 42: 'Tenis' },
    tournamentName: { 2: 'ATP Finals', 42: 'ATP Finals' },
    currentStatus: { LiveEventTime: 0 },
    matchBets: [
      {
        idBet: 101,
        mbActive: true,
        mbDisplayName: { 2: 'Match Winner', 42: 'Castigator meci' },
        mbOutcomes: [
          { idMbo: 11, mboActive: true, mboOddValue: 1.75, mboDisplayName: { 2: '1' } },
          { idMbo: 12, mboActive: true, mboOddValue: 2.15, mboDisplayName: { 2: '2' } },
        ],
      },
    ],
  };

  const rawBasketballMatch = {
    idMatch: 950002,
    active: true,
    bettingStatus: true,
    team1Name: { 2: 'Boston Celtics', 42: 'Boston Celtics' },
    team2Name: { 2: 'LA Lakers', 42: 'LA Lakers' },
    matchDateTime: FUTURE_MS,
    sportName: { 2: 'Basketball', 42: 'Baschet' },
    tournamentName: { 2: 'NBA', 42: 'NBA' },
    currentStatus: { LiveEventTime: 0 },
    matchBets: [
      {
        idBet: 102,
        mbActive: true,
        mbDisplayName: { 2: 'Winner', 42: 'Castigator' },
        mbOutcomes: [
          { idMbo: 21, mboActive: true, mboOddValue: 1.50, mboDisplayName: { 2: '1' } },
          { idMbo: 22, mboActive: true, mboOddValue: 2.70, mboDisplayName: { 2: '2' } },
        ],
      },
    ],
  };

  const events = brand.extractEvents([rawTennisMatch, rawBasketballMatch]);
  assert.equal(events.length, 2);

  const [tennis, basketball] = events;
  assert.equal(tennis.sport, 'Tenis');
  assert.equal(tennis.markets.length, 1);
  assert.deepEqual(tennis.markets[0].selections.map((s) => s.name), ['1', '2']);
  assert.equal(tennis.markets[0].selections[0].odds, 1.75);
  assert.equal(tennis.markets[0].selections[1].odds, 2.15);

  const contract = resolveContract(tennis.markets[0]);
  assert.equal(contract.family, 'MATCH_ODDS');
  assert.deepEqual(contract.outcomes, ['home', 'away']);

  assert.equal(basketball.sport, 'Baschet');
  assert.equal(basketball.markets.length, 1);
  assert.deepEqual(basketball.markets[0].selections.map((s) => s.name), ['1', '2']);
  assert.equal(basketball.markets[0].selections[0].odds, 1.50);
  assert.equal(basketball.markets[0].selections[1].odds, 2.70);
});

test('DigitainBrand respects sport: all and sports filters for multi-sport ingestion', () => {
  const rawTennisMatch = {
    idMatch: 950003,
    active: true,
    bettingStatus: true,
    team1Name: 'Djokovic',
    team2Name: 'Nadal',
    matchDateTime: FUTURE_MS,
    sportName: { 2: 'Tennis' },
    currentStatus: { LiveEventTime: 0 },
    matchBets: [
      {
        idBet: 103,
        mbActive: true,
        mbDisplayName: 'Winner',
        mbOutcomes: [
          { idMbo: 31, mboActive: true, mboOddValue: 1.80, mboDisplayName: '1' },
          { idMbo: 32, mboActive: true, mboOddValue: 2.05, mboDisplayName: '2' },
        ],
      },
    ],
  };

  // Default sport is football -> drops tennis match
  const defaultBrand = new DigitainBrand('mrplay');
  assert.equal(defaultBrand.extractEvents([rawTennisMatch]).length, 0);

  // sport: 'all' -> admits tennis match
  const allBrand = new DigitainBrand('mrplay', { sport: 'all' });
  assert.equal(allBrand.extractEvents([rawTennisMatch]).length, 1);

  // sports: ['tennis'] -> admits tennis match
  const sportsBrand = new DigitainBrand('mrplay', { sports: ['tennis'] });
  assert.equal(sportsBrand.extractEvents([rawTennisMatch]).length, 1);

  // sports: ['basketball'] -> drops tennis match
  const bballBrand = new DigitainBrand('mrplay', { sports: ['basketball'] });
  assert.equal(bballBrand.extractEvents([rawTennisMatch]).length, 0);
});

test('Winner: bundled basketball points total extracts as POINTS_OVER_UNDER with subject points', () => {
  const points = (lines) => ({
    idBet: 3,
    mbActive: true,
    mbDisplayName: { 42: 'Total puncte Peste/Sub' },
    mbOutcomes: lines.flatMap((line, i) => ([
      {
        idMbo: 5000 + i * 2, mboActive: true, mboOddValue: 1.85,
        mboType: { 42: 'Peste' }, mboDisplayName: { 42: 'Peste' }, argument: line,
      },
      {
        idMbo: 5001 + i * 2, mboActive: true, mboOddValue: 1.95,
        mboType: { 42: 'Sub' }, mboDisplayName: { 42: 'Sub' }, argument: line,
      },
    ])),
  });

  const bballMatch = match({
    sportName: { 0: 'Baschet' },
    matchBets: [points([214.5, 216.5])],
  });

  const s = new Winner({ sport: 'basketball' });
  const [event] = s.extractEvents([bballMatch]);
  assert.ok(event, 'basketball event extracted');
  assert.equal(event.markets.length, 2);
  assert.equal(event.markets[0].key, 'POINTS_OVER_UNDER_214_5');
  assert.equal(event.markets[0].subject, 'points');
  assert.equal(event.markets[0].name, 'Total puncte Peste/Sub 214.5');
  assert.deepEqual(event.markets[0].selections.map((x) => x.name), ['Peste 214.5', 'Sub 214.5']);
  assert.equal(event.markets[1].key, 'POINTS_OVER_UNDER_216_5');
  assert.equal(event.markets[1].subject, 'points');
});

test('Winner and DigitainBrand: bundled tennis games total extracts as TOTAL_GAMES with subject games', () => {
  const games = (lines) => ({
    idBet: 3,
    mbActive: true,
    mbDisplayName: { 42: 'Total game-uri Peste/Sub' },
    mbOutcomes: lines.flatMap((line, i) => ([
      {
        idMbo: 6000 + i * 2, mboActive: true, mboOddValue: 1.80,
        mboType: { 42: 'Peste' }, mboDisplayName: { 42: 'Peste' }, argument: line,
      },
      {
        idMbo: 6001 + i * 2, mboActive: true, mboOddValue: 2.00,
        mboType: { 42: 'Sub' }, mboDisplayName: { 42: 'Sub' }, argument: line,
      },
    ])),
  });

  const tennisMatch = match({
    sportName: { 0: 'Tenis' },
    matchBets: [games([21.5, 22.5])],
  });

  const s = new Winner({ sport: 'tennis' });
  const [event] = s.extractEvents([tennisMatch]);
  assert.ok(event, 'tennis event extracted');
  assert.equal(event.markets.length, 2);
  assert.equal(event.markets[0].key, 'TOTAL_GAMES');
  assert.equal(event.markets[0].subject, 'games');
  assert.equal(event.markets[0].name, 'Total game-uri Peste/Sub 21.5');
  assert.deepEqual(event.markets[0].selections.map((x) => x.name), ['Peste 21.5', 'Sub 21.5']);

  const contract = resolveContract(event.markets[0]);
  assert.ok(contract);
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.subject, 'games');
  assert.equal(contract.lineKey, '21.5');

  // Test DigitainBrand preserves tennis games total
  const brand = new DigitainBrand('mrplay', { sport: 'tennis' });
  const [brandEvent] = brand.extractEvents([tennisMatch]);
  assert.ok(brandEvent, 'brand extracted tennis totals');
  assert.equal(brandEvent.markets.length, 2);
  assert.equal(brandEvent.markets[0].key, 'TOTAL_GAMES');
  assert.equal(brandEvent.markets[0].subject, 'games');
});

test('DigitainBrand: extracts 2-way Set Winner and Quarter Winner with correct periods', () => {
  const setWinnerBet = {
    idBet: 10,
    mbActive: true,
    mbDisplayName: { 42: 'Câștigător Set 1' },
    mbOutcomes: [
      { idMbo: 7001, mboActive: true, mboOddValue: 1.70, mboType: { 42: '1' }, mboDisplayName: { 42: '1' } },
      { idMbo: 7002, mboActive: true, mboOddValue: 2.15, mboType: { 42: '2' }, mboDisplayName: { 42: '2' } },
    ],
  };

  const tennisMatch = match({
    sportName: { 0: 'Tenis' },
    team1Name: 'Jannik Sinner',
    team2Name: 'Carlos Alcaraz',
    matchBets: [
      {
        idBet: 1,
        mbActive: true,
        mbDisplayName: { 42: 'Câștigător meci' },
        mbOutcomes: [
          { idMbo: 7000, mboActive: true, mboOddValue: 1.80, mboType: { 42: '1' }, mboDisplayName: { 42: '1' } },
          { idMbo: 7003, mboActive: true, mboOddValue: 2.00, mboType: { 42: '2' }, mboDisplayName: { 42: '2' } },
        ],
      },
      setWinnerBet,
    ],
  });

  const brand = new DigitainBrand('mrplay', { sport: 'tennis' });
  const [ev] = brand.extractEvents([tennisMatch]);
  assert.ok(ev);
  assert.equal(ev.markets.length, 2);

  const set1Market = ev.markets.find((m) => m.period === 'set1');
  assert.ok(set1Market, 'Set 1 market extracted with period set1');
  assert.deepEqual(set1Market.selections.map((x) => x.name), ['1', '2']);

  const contract = resolveContract(set1Market, { sport: 'tennis', homeTeam: 'Jannik Sinner', awayTeam: 'Carlos Alcaraz' });
  assert.ok(contract);
  assert.equal(contract.family, 'MATCH_ODDS');
  assert.equal(contract.period, 'set1');
  assert.deepEqual(contract.outcomes, ['home', 'away']);
});

test('Digitain and Winner: period-scoped totals and 2-way winners isolate buckets from full-time markets', () => {
  const brand = new DigitainBrand('mrplay', { sport: 'all' });

  // 1. Basketball match with Full-time Points Total, Q1 Points Total, and 1st Half Winner
  const bballMatch = match({
    sportName: { 0: 'Baschet' },
    team1Name: 'Boston Celtics',
    team2Name: 'Golden State Warriors',
    matchBets: [
      {
        idBet: 1,
        mbActive: true,
        mbDisplayName: { 42: 'Câștigător meci' },
        mbOutcomes: [
          { idMbo: 8001, mboActive: true, mboOddValue: 1.65, mboDisplayName: { 42: '1' } },
          { idMbo: 8002, mboActive: true, mboOddValue: 2.25, mboDisplayName: { 42: '2' } },
        ],
      },
      {
        idBet: 2,
        mbActive: true,
        mbDisplayName: { 42: 'Câștigător Repriza 1' },
        mbOutcomes: [
          { idMbo: 8003, mboActive: true, mboOddValue: 1.75, mboDisplayName: { 42: '1' } },
          { idMbo: 8004, mboActive: true, mboOddValue: 2.10, mboDisplayName: { 42: '2' } },
        ],
      },
      {
        idBet: 3,
        mbActive: true,
        mbDisplayName: { 42: 'Total puncte Peste/Sub' },
        mbOutcomes: [
          { idMbo: 8005, mboActive: true, mboOddValue: 1.90, mboType: { 42: 'Peste' }, argument: 220.5 },
          { idMbo: 8006, mboActive: true, mboOddValue: 1.90, mboType: { 42: 'Sub' }, argument: 220.5 },
        ],
      },
      {
        idBet: 4,
        mbActive: true,
        mbDisplayName: { 42: 'Total puncte Sfertul 1 Peste/Sub' },
        mbOutcomes: [
          { idMbo: 8007, mboActive: true, mboOddValue: 1.85, mboType: { 42: 'Peste' }, argument: 55.5 },
          { idMbo: 8008, mboActive: true, mboOddValue: 1.95, mboType: { 42: 'Sub' }, argument: 55.5 },
        ],
      },
    ],
  });

  const [ev] = brand.extractEvents([bballMatch]);
  assert.ok(ev);
  assert.equal(ev.markets.length, 4);

  const ftWinner = ev.markets.find((m) => m.name === 'Câștigător meci');
  const h1Winner = ev.markets.find((m) => m.name === 'Câștigător Repriza 1');
  const ftPoints = ev.markets.find((m) => m.name === 'Total puncte Peste/Sub 220.5');
  const q1Points = ev.markets.find((m) => m.name === 'Total puncte Sfertul 1 Peste/Sub 55.5');

  assert.ok(ftWinner && h1Winner && ftPoints && q1Points);
  assert.equal(ftWinner.period, 'fulltime');
  assert.equal(h1Winner.period, 'half1');
  assert.equal(ftPoints.period, 'fulltime');
  assert.equal(q1Points.period, 'q1');

  const cFtWinner = resolveContract(ftWinner);
  const cH1Winner = resolveContract(h1Winner);
  const cFtPoints = resolveContract(ftPoints);
  const cQ1Points = resolveContract(q1Points);

  assert.equal(cFtWinner.family, 'MATCH_ODDS');
  assert.equal(cFtWinner.period, 'fulltime');
  assert.equal(cH1Winner.family, 'MATCH_ODDS');
  assert.equal(cH1Winner.period, 'half1');

  assert.equal(cFtPoints.family, 'OVER_UNDER');
  assert.equal(cFtPoints.period, 'fulltime');
  assert.equal(cFtPoints.lineKey, '220.5');
  assert.equal(cQ1Points.family, 'OVER_UNDER');
  assert.equal(cQ1Points.period, 'q1');
  assert.equal(cQ1Points.lineKey, '55.5');

  const bFtWinner = bucketKeyForContract(ev.eventKey, cFtWinner);
  const bH1Winner = bucketKeyForContract(ev.eventKey, cH1Winner);
  const bFtPoints = bucketKeyForContract(ev.eventKey, cFtPoints);
  const bQ1Points = bucketKeyForContract(ev.eventKey, cQ1Points);

  assert.notEqual(bFtWinner, bH1Winner, 'Full-time winner and 1st half winner bucket keys must never collide');
  assert.notEqual(bFtPoints, bQ1Points, 'Full-time points total and Q1 points total bucket keys must never collide');
  assert.ok(bH1Winner.includes('::half1::'), '1st half winner bucket key includes half1');
  assert.ok(bQ1Points.includes('::q1::'), 'Q1 points total bucket key includes q1');
});

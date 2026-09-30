import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByEvent, findArbitrage } from '../src/scanner/engine.mjs';
import { resolveContract, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

/**
 * Two MATCH_ODDS contracts that settle differently must never meet.
 *
 * `scan failed: Cannot read properties of undefined (reading 'get')` sat in
 * server-err.log on every scan from 2026-09-28T23:55 onward, and on
 * POST /api/scan, while data/latest-scan.json published
 * `dataHealth: "empty"` with `eventCount: 0`. The books were being scraped
 * normally the whole time: one market shape threw a TypeError inside
 * findArbitrage, the exception unwound through scanWorkspace, and a single bad
 * market cost the entire capture — zero opportunities instead of a partial
 * result. These tests pin both halves of that failure: it must not throw, and
 * the two shapes must not be treated as one contract.
 */

const EVENT_KEY = 'football|2030-01-01|home|away';

function event(sourceId, markets) {
  return {
    id: `${sourceId}-1`,
    sourceId,
    eventKey: EVENT_KEY,
    sport: 'Football',
    league: 'Liga 1',
    kickoff: '2030-01-01T12:00:00Z',
    homeTeam: 'Home',
    awayTeam: 'Away',
    markets,
  };
}

/** netbet `default` / FEG `ufo:mtyp:00-05` → MATCH_ODDS [home, away]. */
const twoWay = () => ({
  key: 'default', period: 'fulltime', name: 'Rezultat',
  selections: [{ id: 't1', name: '1', odds: 2.20 }, { id: 't2', name: '2', odds: 2.20 }],
});

/** The ordinary 1X2 → MATCH_ODDS [home, draw, away]. */
const threeWay = (home, draw, away) => ({
  key: 'MATCH_ODDS', period: 'fulltime', name: '1X2',
  selections: [
    { id: 'h', name: 'Home', odds: home },
    { id: 'd', name: 'Draw', odds: draw },
    { id: 'a', name: 'Away', odds: away },
  ],
});

test('a 2-way and a 3-way MATCH_ODDS resolve to the same family but different contracts', () => {
  const two = resolveContract(twoWay());
  const three = resolveContract(threeWay(2.10, 4.20, 4.60));
  assert.ok(two && three, 'both shapes resolve to a contract');
  assert.equal(two.family, three.family);
  assert.equal(two.period, three.period);
  assert.equal(two.lineKey, three.lineKey);
  assert.deepEqual(two.outcomes, ['home', 'away']);
  assert.deepEqual(three.outcomes, ['home', 'draw', 'away']);
});

test('bucketKeyForContract separates a 2-way from a 3-way MATCH_ODDS', () => {
  // Without the outcome set both keys were `...::MATCH_ODDS::fulltime::_`, so
  // the two products landed in one bucket that was seeded from whichever market
  // arrived first.
  const two = resolveContract(twoWay());
  const three = resolveContract(threeWay(2.10, 4.20, 4.60));
  assert.notEqual(
    bucketKeyForContract(EVENT_KEY, two),
    bucketKeyForContract(EVENT_KEY, three),
    'a draw-no-bet result and a 1X2 are different contracts and must not share a bucket',
  );
});

test('a 2-way market listed before a 3-way one does not abort the scan', () => {
  // The exact ordering that threw. The 2-way market creates the bucket with
  // [home, away]; the 3-way market's `draw` leg then indexed a map with no
  // `draw` key and the whole scan died.
  const opps = findArbitrage(groupByEvent([
    event('bookA', [twoWay(), threeWay(2.10, 4.20, 4.60)]),
    event('bookB', [threeWay(2.05, 4.50, 5.00)]),
  ]));
  assert.equal(opps.length, 1, 'the genuine cross-book 3-way arb is still found');
  assert.equal(opps[0].legs.length, 3);
  assert.ok(opps[0].legs.every((l) => l.outcome !== undefined));
});

test('market order cannot change the scan result', () => {
  const twoFirst = findArbitrage(groupByEvent([
    event('bookA', [twoWay(), threeWay(2.10, 4.20, 4.60)]),
    event('bookB', [threeWay(2.05, 4.50, 5.00)]),
  ]));
  const threeFirst = findArbitrage(groupByEvent([
    event('bookA', [threeWay(2.10, 4.20, 4.60), twoWay()]),
    event('bookB', [threeWay(2.05, 4.50, 5.00)]),
  ]));
  assert.equal(twoFirst.length, threeFirst.length,
    'the same fixture scans the same way whichever market the adapter listed first');
  assert.equal(threeFirst.length, 1, 'and the arb is found in that order too');
});

test('a 2-way leg never pairs with a 3-way leg', () => {
  // The settlement asymmetry, which is why merging them was worse than the
  // crash. bookA's "2" in a [home, away] result market pays on a DRAW as well
  // as an away win; bookB's "Home" in a 3-way pays only on a home win. Priced
  // together at 2.20 / 2.20 they look like a 10% surebet, and a draw loses
  // both bets at once. Before the fix this combination also threw; with only
  // the crash patched it would have been reported as profit that cannot be
  // placed.
  const opps = findArbitrage(groupByEvent([
    event('bookA', [twoWay()]),
    event('bookB', [threeWay(2.20, 4.20, 4.60)]),
  ]), { minRoiPercent: 0 });
  assert.deepEqual(opps, [], 'different settlement windows must never be arbitraged together');
});

test('one unrecognised market shape cannot take the whole capture with it', () => {
  // The engine's contract with its input: a market nobody can classify is
  // skipped, not thrown on. A scan that dies reports "empty", which the UI
  // reads as a quiet market, so losing one market must not look like losing all
  // of them.
  const opps = findArbitrage(groupByEvent([
    event('bookA', [
      { key: 'TOTALLY_UNKNOWN', period: 'fulltime', selections: [{ name: '?', odds: 1.50 }] },
      threeWay(2.10, 4.20, 4.60),
    ]),
    event('bookB', [threeWay(2.05, 4.50, 5.00)]),
  ]));
  assert.equal(opps.length, 1, 'the real arb survives alongside an unreadable market');
});

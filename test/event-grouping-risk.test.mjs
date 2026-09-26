import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByEvent, findArbitrage } from '../src/scanner/engine.mjs';
import { isSharedFeed } from '../src/scanner/feed-groups.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';
import { implausibleMarginRate, hasImplausibleMarket } from '../src/scanner/scanner.mjs';
import { leaguesMatch } from '../src/scanner/league-aliases.mjs';

/**
 * Two standing guards on the data, both derived from measurement rather than
 * from a specific capture, so they hold on whatever the scrapers return next.
 *
 * 1. Dropping the league from eventIdentityKey lets two fixtures with the same
 *    teams, kickoff and sport collapse into one group — England in Nations
 *    League group A and group C, for example. That trade-off is only safe
 *    while such groups stay unprofitable, so a group that both spans multiple
 *    sources and carries multiple league labels must never produce a
 *    cross-feed opportunity.
 *
 * 2. A book pricing a 1X2 market below its own break-even is not a usable
 *    price source. Measured on the saved capture, contibet published this on
 *    ~20% of its events while every other configured source was at 0%.
 */

function market(names, odds) {
  return { key: 'MATCH_ODDS', selections: names.map((n, i) => ({ name: n, odds: odds[i] })) };
}

test('the same competition pairs across books, different groups do not', () => {
  const at = new Date('2030-01-01T12:00:00Z').toISOString();
  const base = { sport: 'Football', kickoff: at, homeTeam: 'Home', awayTeam: 'Away' };
  const book = (id, sourceId, league, odds) => ({
    ...base,
    id,
    sourceId,
    league,
    eventKey: eventIdentityKey(base),
    markets: [market(['1', 'X', '2'], odds)],
  });

  // The same competition under two names — observed on the capture for psim
  // yogyakarta vs persita tangerang, labelled "Liga 1" by six Altenar tenants
  // and "Super League" by favbet. These must pair, or cross-book arbitrage
  // stays undetectable.
  const same = groupByEvent([
    book('a', 'superbet', 'Liga 1', [2.40, 3.60, 3.80]),
    book('b', 'fortuna', 'Super League', [2.30, 3.70, 3.70]),
  ]);
  assert.equal(same.size, 1, 'the same competition pairs despite the label');
  assert.equal(findArbitrage(same, { minRoiPercent: 0 }).length, 1);

  // The same teams, same kickoff, different competition group: two different
  // fixtures. Merging them would report an arbitrage between matches that were
  // never going to be played against each other.
  const groups = groupByEvent([
    book('a', 'superbet', 'Liga Natiunilor A', [2.40, 3.60, 3.80]),
    book('b', 'fortuna', 'Liga Natiunilor C', [2.30, 3.70, 3.70]),
  ]);
  assert.equal(groups.size, 2, 'group A and group C stay separate');
  assert.equal(findArbitrage(groups, { minRoiPercent: 0 }).length, 0);
});

test('a competition group is compared before the alias table', () => {
  // "Nations League A" and "Liga Natiunilor C" are the same competition in
  // different groups, so the alias must not pull them together.
  assert.equal(leaguesMatch('Nations League A', 'Liga Natiunilor A'), true);
  assert.equal(leaguesMatch('Nations League A', 'Liga Natiunilor C'), false);
  // The same holds when a generic label like "Final" carries no group at all.
  assert.equal(leaguesMatch('Tournament 104', 'Italia - Serie A'), true);
  assert.equal(leaguesMatch('Final', 'Tournament 104'), true);
  // Genuinely different competitions must not be aliased together.
  assert.equal(leaguesMatch('Serie A', 'Serie B'), false);
  assert.equal(leaguesMatch('Premier League', 'Championship'), false);
});

test('prices below break-even are detected and above it are not', () => {
  const healthy = [{ homeTeam: 'A', markets: [market(['1', 'X', '2'], [1.90, 3.40, 4.00])] }];
  assert.equal(implausibleMarginRate(healthy).count, 0);

  // 1/1.99 + 1/3.8 + 1/5.5 = 0.947: the book would pay out more than it takes.
  const corrupt = [{ homeTeam: 'A', markets: [market(['1', 'X', '2'], [1.99, 3.80, 5.50])] }];
  const result = implausibleMarginRate(corrupt);
  assert.equal(result.checked, 1);
  assert.equal(result.count, 1);
  assert.equal(result.rate, 1);

  // A single stray market must not disqualify a source; the scanner threshold
  // is 10%, so a small share is tolerated.
  const mixed = [
    ...healthy,
    ...corrupt,
    { homeTeam: 'C', markets: [market(['1', 'X', '2'], [2.00, 3.50, 4.20])] },
    { homeTeam: 'D', markets: [market(['1', 'X', '2'], [1.80, 3.60, 4.60])] },
  ];
  const mixedResult = implausibleMarginRate(mixed);
  assert.equal(mixedResult.count, 1);
  assert.equal(mixedResult.rate, 0.25);
  assert.ok(mixedResult.rate > 0.1, '25% exceeds the exclusion threshold');

  // Markets without a complete 1X2 are not counted at all.
  assert.equal(implausibleMarginRate([{ homeTeam: 'A', markets: [] }]).checked, 0);
  assert.equal(implausibleMarginRate([{ homeTeam: 'A', markets: [market(['Over', 'Under'], [1.9, 1.9])] }]).checked, 0);
  assert.equal(implausibleMarginRate(null).rate, 0);
});

test('the identity key is the single definition written by the scrapers', () => {
  // Scraper events carry the canonical key, so a key produced by the scanner
  // can be looked up directly in a snapshot (market catalog, /api/odds). Before
  // the adapters were normalised in ScraperBase.validate, every adapter wrote
  // its own league-bearing string and a cross-book lookup by key returned
  // nothing.
  const at = new Date('2030-01-01T12:00:00Z').toISOString();
  const written = { sport: 'Football', league: 'Nations League', kickoff: at, homeTeam: 'Home', awayTeam: 'Away' };
  assert.equal(
    eventIdentityKey(written), 'football|2030-01-01|home|away',
    'the canonical key omits the league, which books name differently',
  );
});

test('a market priced below break-even is dropped, the sound ones kept', () => {
  // A source-level threshold is the wrong unit: contibet measures 9% on the
  // current capture and 22% on an older one, so any cut-off either lets a
  // corrupt market through to fabricate an opportunity, or discards a mostly
  // sound feed. The check is per market instead.
  const corrupt = { homeTeam: 'A', markets: [{ key: 'MATCH_ODDS', selections: [
    { name: '1', odds: 3.30 }, { name: 'X', odds: 3.20 }, { name: '2', odds: 3.10 },
  ] }] };
  const sound = { homeTeam: 'B', markets: [{ key: 'MATCH_ODDS', selections: [
    { name: '1', odds: 2.53 }, { name: 'X', odds: 3.20 }, { name: '2', odds: 2.78 },
  ] }] };

  assert.equal(hasImplausibleMarket(corrupt), true, 'a market under 1.0 is corrupt');
  assert.equal(hasImplausibleMarket(sound), false, 'a market over 1.0 is sound');

  // The rate is still reported so a degrading feed is visible, but on its own it
  // no longer decides what is used. One bad market in three is 33% — high
  // enough that a source-level threshold would have thrown both sound events
  // away alongside it.
  const mixed = implausibleMarginRate([corrupt, sound, {
    homeTeam: 'C',
    markets: [{ key: 'MATCH_ODDS', selections: [
      { name: '1', odds: 2.10 }, { name: 'X', odds: 3.40 }, { name: '2', odds: 3.90 },
    ] }],
  }]);
  assert.equal(mixed.checked, 3);
  assert.equal(mixed.count, 1);
  assert.ok(mixed.rate > 0.1, 'a third of the markets are unusable');

  // The contibet case: a single bad market inside an otherwise sound feed, at a
  // rate low enough to slip under a source-level cut-off. Only the per-market
  // check catches it, which is the whole reason for the change.
  const oneInTwelve = implausibleMarginRate([corrupt, ...Array.from({ length: 11 }, (_, i) => ({
    homeTeam: `T${i}`,
    markets: [{ key: 'MATCH_ODDS', selections: [
      { name: '1', odds: 2.10 }, { name: 'X', odds: 3.40 }, { name: '2', odds: 3.90 },
    ] }],
  }))]);
  assert.equal(oneInTwelve.count, 1);
  assert.ok(oneInTwelve.rate < 0.1, 'and below a source-level cut-off');
  assert.equal(hasImplausibleMarket(corrupt), true, 'so the per-market check is what has to catch it');

  // Markets that are not a complete 1X2 are not judged either way.
  assert.equal(hasImplausibleMarket({ markets: [] }), false);
  assert.equal(hasImplausibleMarket({ markets: [{ key: 'MATCH_ODDS', selections: [
    { name: '1', odds: 0.5 }, { name: 'X', odds: 0.5 },
  ] }] }), false);
});

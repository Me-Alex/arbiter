import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByEvent, findArbitrage } from '../src/scanner/engine.mjs';

function createEvent(sourceId, home, away, markets) {
  const kickoff = new Date(Date.now() + 86400000).toISOString();
  return {
    id: `${sourceId}-ev-1`,
    sourceId,
    sport: 'Football',
    league: 'Premier League',
    kickoff,
    homeTeam: home,
    awayTeam: away,
    eventKey: `football|premier-league|${kickoff}|${home.toLowerCase()}|${away.toLowerCase()}`,
    markets,
  };
}

test('Synthetic Equivalence: Double Chance 1X vs Match Odds Away', () => {
  const evA = createEvent('bookA', 'Arsenal', 'Chelsea', [
    {
      id: 'm1',
      key: 'DOUBLE_CHANCE',
      name: 'Double Chance',
      period: 'fulltime',
      selections: [
        { id: 's1', name: '1X', odds: 1.95 },
        { id: 's2', name: '12', odds: 1.30 },
        { id: 's3', name: 'X2', odds: 1.60 },
      ],
    },
  ]);

  const evB = createEvent('bookB', 'Arsenal', 'Chelsea', [
    {
      id: 'm2',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 's4', name: '1', odds: 1.80 },
        { id: 's5', name: 'X', odds: 3.40 },
        { id: 's6', name: '2', odds: 2.15 },
      ],
    },
  ]);

  const grouped = groupByEvent([evA, evB]);
  const arbs = findArbitrage(grouped, { includeSynthetic: true });
  assert.equal(arbs.length, 1);
  const arb = arbs[0];
  assert.equal(arb.family, 'SYNTHETIC_EQUIVALENCE');
  assert.equal(arb.synthetic, true);
  assert.equal(arb.syntheticType, '1X_VS_AWAY');
  assert.equal(arb.legs.length, 2);
  assert.equal(arb.legs[0].selection, '1X');
  assert.equal(arb.legs[1].selection, '2');
  assert.ok(arb.marginPercent > 2.0);
});

test('Synthetic Equivalence: Asian Handicap +0.5 Home vs Match Odds Away', () => {
  const evA = createEvent('bookA', 'Arsenal', 'Chelsea', [
    {
      id: 'm1',
      key: 'ASIAN_HANDICAP',
      name: 'Handicap Asiatic',
      period: 'fulltime',
      selections: [
        { id: 's1', name: '1 (+0.5)', odds: 1.98, handicap: '+0.5' },
        { id: 's2', name: '2 (-0.5)', odds: 1.85, handicap: '-0.5' },
      ],
    },
  ]);

  const evB = createEvent('bookB', 'Arsenal', 'Chelsea', [
    {
      id: 'm2',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 's4', name: '1', odds: 1.80 },
        { id: 's5', name: 'X', odds: 3.40 },
        { id: 's6', name: '2', odds: 2.15 },
      ],
    },
  ]);

  const grouped = groupByEvent([evA, evB]);
  const arbs = findArbitrage(grouped, { includeSynthetic: true });
  assert.equal(arbs.length, 1);
  const arb = arbs[0];
  assert.equal(arb.syntheticType, '1X_VS_AWAY');
  assert.equal(arb.legs[0].selection, '1 (+0.5)');
  assert.equal(arb.legs[1].selection, '2');
  assert.ok(arb.marginPercent > 2.5);
});

test('Synthetic Equivalence: Asian Handicap -0.5 Home vs Double Chance X2', () => {
  const evA = createEvent('bookA', 'Liverpool', 'Everton', [
    {
      id: 'm1',
      key: 'ASIAN_HANDICAP',
      name: 'Handicap Asiatic',
      period: 'fulltime',
      selections: [
        { id: 's1', name: '1 (-0.5)', odds: 2.10, handicap: '-0.5' },
        { id: 's2', name: '2 (+0.5)', odds: 1.75, handicap: '+0.5' },
      ],
    },
  ]);

  const evB = createEvent('bookB', 'Liverpool', 'Everton', [
    {
      id: 'm2',
      key: 'DOUBLE_CHANCE',
      name: 'Double Chance',
      period: 'fulltime',
      selections: [
        { id: 's3', name: '1X', odds: 1.35 },
        { id: 's4', name: '12', odds: 1.30 },
        { id: 's5', name: 'X2', odds: 2.05 },
      ],
    },
  ]);

  const grouped = groupByEvent([evA, evB]);
  const arbs = findArbitrage(grouped, { includeSynthetic: true });
  assert.equal(arbs.length, 1);
  const arb = arbs[0];
  assert.equal(arb.syntheticType, 'X2_VS_HOME');
  assert.equal(arb.legs.find((l) => l.sourceId === 'bookA').selection, '1 (-0.5)');
  assert.equal(arb.legs.find((l) => l.sourceId === 'bookB').selection, 'X2');
  assert.ok(arb.marginPercent > 3.0);
});

test('Synthetic Equivalence: Asian Handicap 0.0 Home vs Draw No Bet Away', () => {
  const evA = createEvent('bookA', 'Real Madrid', 'Barcelona', [
    {
      id: 'm1',
      key: 'ASIAN_HANDICAP_0',
      name: 'Handicap Asiatic 0',
      period: 'fulltime',
      selections: [
        { id: 's1', name: '1 (0)', odds: 2.15, handicap: '0' },
        { id: 's2', name: '2 (0)', odds: 1.75, handicap: '0' },
      ],
    },
  ]);

  const evB = createEvent('bookB', 'Real Madrid', 'Barcelona', [
    {
      id: 'm2',
      key: 'DRAW_NO_BET',
      name: 'Draw No Bet',
      period: 'fulltime',
      selections: [
        { id: 's3', name: '1', odds: 1.70 },
        { id: 's4', name: '2', odds: 2.10 },
      ],
    },
  ]);

  const grouped = groupByEvent([evA, evB]);
  const arbs = findArbitrage(grouped, { includeSynthetic: true });
  assert.equal(arbs.length, 1);
  const arb = arbs[0];
  assert.equal(arb.syntheticType, 'DNB_AH0');
  assert.equal(arb.legs.find((l) => l.sourceId === 'bookA').selection, '1 (0)');
  assert.equal(arb.legs.find((l) => l.sourceId === 'bookB').selection, '2');
  assert.ok(arb.marginPercent > 5.0);
});

test('Synthetic Equivalence: Double Chance 12 vs Match Odds Draw', () => {
  const evA = createEvent('bookA', 'Milan', 'Inter', [
    {
      id: 'm1',
      key: 'DOUBLE_CHANCE',
      name: 'Double Chance',
      period: 'fulltime',
      selections: [
        { id: 's1', name: '1X', odds: 1.40 },
        { id: 's2', name: '12', odds: 1.45 },
        { id: 's3', name: 'X2', odds: 1.40 },
      ],
    },
  ]);

  const evB = createEvent('bookB', 'Milan', 'Inter', [
    {
      id: 'm2',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 's4', name: '1', odds: 2.60 },
        { id: 's5', name: 'X', odds: 3.50 },
        { id: 's6', name: '2', odds: 2.70 },
      ],
    },
  ]);

  const grouped = groupByEvent([evA, evB]);
  const arbs = findArbitrage(grouped, { includeSynthetic: true });
  assert.equal(arbs.length, 1);
  const arb = arbs[0];
  assert.equal(arb.syntheticType, '12_VS_DRAW');
  assert.equal(arb.legs[0].selection, '12');
  assert.equal(arb.legs[1].selection, 'X');
  assert.ok(arb.marginPercent > 2.0);
});

test('Synthetic Equivalence: Rejects same-bookmaker combinations', () => {
  const evA = createEvent('bookA', 'Arsenal', 'Chelsea', [
    {
      id: 'm1',
      key: 'DOUBLE_CHANCE',
      name: 'Double Chance',
      period: 'fulltime',
      selections: [
        { id: 's1', name: '1X', odds: 1.95 },
        { id: 's2', name: '12', odds: 1.30 },
        { id: 's3', name: 'X2', odds: 1.60 },
      ],
    },
    {
      id: 'm2',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 's4', name: '1', odds: 1.80 },
        { id: 's5', name: 'X', odds: 3.40 },
        { id: 's6', name: '2', odds: 2.15 },
      ],
    },
  ]);

  const grouped = groupByEvent([evA]);
  const arbs = findArbitrage(grouped, { includeSynthetic: true });
  assert.equal(arbs.length, 0, 'Cannot arbitrage against own bookmaker');
});

test('Synthetic Equivalence: supports H1/H2 Asian Handicap labels (H1 +0.5 vs 1X2 Away)', () => {
  const evA = createEvent('bookA', 'Arsenal', 'Chelsea', [
    {
      id: 'm1',
      key: 'ASIAN_HANDICAP',
      name: 'Handicap',
      line: '0.5',
      period: 'fulltime',
      selections: [
        { id: 's1', name: 'H1 0.5', odds: 2.05 },
        { id: 's2', name: 'H2 -0.5', odds: 1.80 },
      ],
    },
  ]);

  const evB = createEvent('bookB', 'Arsenal', 'Chelsea', [
    {
      id: 'm2',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 's4', name: '1', odds: 1.80 },
        { id: 's5', name: 'X', odds: 3.40 },
        { id: 's6', name: '2', odds: 2.10 },
      ],
    },
  ]);

  const grouped = groupByEvent([evA, evB]);
  const arbs = findArbitrage(grouped, { includeSynthetic: true });
  assert.equal(arbs.length, 1);
  const arb = arbs[0];
  assert.equal(arb.syntheticType, '1X_VS_AWAY');
  assert.equal(arb.legs.find((l) => l.sourceId === 'bookA').selection, 'H1 0.5');
  assert.equal(arb.legs.find((l) => l.sourceId === 'bookB').selection, '2');
});

test('Synthetic Equivalence: ignores proposition handicaps with non-goal subjects', () => {
  const evA = createEvent('bookA', 'Arsenal', 'Chelsea', [
    {
      id: 'm1',
      key: 'ASIAN_HANDICAP',
      name: 'Handicap Cornere',
      subject: 'corners',
      line: '0.5',
      period: 'fulltime',
      selections: [
        { id: 's1', name: '1 (+0.5)', odds: 2.05, handicap: '+0.5' },
        { id: 's2', name: '2 (-0.5)', odds: 1.80, handicap: '-0.5' },
      ],
    },
  ]);

  const evB = createEvent('bookB', 'Arsenal', 'Chelsea', [
    {
      id: 'm2',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 's4', name: '1', odds: 1.80 },
        { id: 's5', name: 'X', odds: 3.40 },
        { id: 's6', name: '2', odds: 2.10 },
      ],
    },
  ]);

  const grouped = groupByEvent([evA, evB]);
  const arbs = findArbitrage(grouped, { includeSynthetic: true });
  assert.equal(arbs.length, 0, 'Corners handicap must NOT pair with match odds 1X2 in synthetic equivalence');
});

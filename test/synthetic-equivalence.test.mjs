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

function handballHandicap(selections) {
  return createEvent('betano', 'CS Dinamo Bucuresti', 'Skanderborg Aarhus', [
    {
      id: 'm-fahc',
      key: 'FAHC',
      name: 'Handicap',
      period: 'fulltime',
      selections: selections.map((s, i) => ({ id: 's' + i, ...s })),
    },
  ]);
}

test('Synthetic Equivalence: a team-named away -0.5 handicap is not draw_or_away', () => {
  // Reproduces the 2026-10-20 board exactly: betano's away -0.5 (which pays only
  // on an away win) plus a home moneyline was published as +69.74 guaranteed.
  // The bucket key for a team-named pair used to be sign-ordered, so this
  // market received the HOME -0.5 key and its away leg was booked as
  // `draw_or_away`. 1/1.93 + 1/2.40 = 0.935 "covers" all three outcomes only
  // under that mislabelling; on a draw both legs lose.
  const betano = handballHandicap([
    { name: 'CS Dinamo Bucuresti +0.5', odds: 1.88, handicap: 0.5 },
    { name: 'Skanderborg Aarhus -0.5', odds: 1.93, handicap: -0.5 },
  ]);
  const unibet = createEvent('unibet', 'CS Dinamo Bucuresti', 'Skanderborg Aarhus', [
    {
      id: 'm-ml',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 's10', name: '1', odds: 2.40 },
        { id: 's11', name: 'X', odds: 8.00 },
        { id: 's12', name: '2', odds: 1.60 },
      ],
    },
  ]);

  const arbs = findArbitrage(groupByEvent([betano, unibet]), { includeSynthetic: true });
  assert.equal(
    arbs.filter((a) => a.syntheticType === 'X2_VS_HOME').length,
    0,
    'an away -0.5 leg pays only when the away side wins; it must never stand in for draw_or_away',
  );
});

test('Synthetic Equivalence: the same handicap pairs as 1X_VS_AWAY against an away price', () => {
  // The half this market really contains is home +0.5 = home wins or draws. It
  // has to keep pairing, or the fix would be a deletion of coverage rather than
  // a correction of it.
  const betano = handballHandicap([
    { name: 'CS Dinamo Bucuresti +0.5', odds: 1.88, handicap: 0.5 },
    { name: 'Skanderborg Aarhus -0.5', odds: 1.93, handicap: -0.5 },
  ]);
  const unibet = createEvent('unibet', 'CS Dinamo Bucuresti', 'Skanderborg Aarhus', [
    {
      id: 'm-ml',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 's10', name: '1', odds: 2.40 },
        { id: 's11', name: 'X', odds: 8.00 },
        { id: 's12', name: '2', odds: 2.25 },
      ],
    },
  ]);

  const arbs = findArbitrage(groupByEvent([betano, unibet]), { includeSynthetic: true });
  const arb = arbs.find((a) => a.syntheticType === '1X_VS_AWAY');
  assert.ok(arb, 'home +0.5 against an away moneyline is a real equivalence');
  const handicapLeg = arb.legs.find((l) => l.sourceId === 'betano');
  assert.equal(handicapLeg.selection, 'CS Dinamo Bucuresti +0.5');
  assert.equal(handicapLeg.outcome, 'home_or_draw');
  assert.equal(arb.legs.find((l) => l.sourceId === 'unibet').outcome, 'away');
  assert.equal(arbs.filter((a) => a.syntheticType === 'X2_VS_HOME').length, 0);
});

test('Synthetic Equivalence: 3-way 1X2_AH05 pairs AH -0.5 Home + Draw + 1X2 Away without duplicating plain 1X2', () => {
  // Betano prices AH -0.5 Home higher than 1X2 Home (2.35 vs 2.15), creating a
  // cross-market 3-way surebet: 1/2.35 + 1/3.70 + 1/3.60 = 0.4255 + 0.2703 + 0.2778 = 0.9736 (2.64% margin).
  const betano = createEvent('betano', 'FCSB', 'CFR Cluj', [
    {
      id: 'm-ah',
      key: 'ASIAN_HANDICAP',
      name: 'Handicap Asiatic',
      period: 'fulltime',
      selections: [
        { id: 'ah1', name: '1 (-0.5)', odds: 2.35, handicap: -0.5 },
        { id: 'ah2', name: '2 (+0.5)', odds: 1.62, handicap: 0.5 },
      ],
    },
    {
      id: 'm-1x2-a',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 'mo1', name: '1', odds: 2.15 },
        { id: 'mox', name: 'X', odds: 3.30 },
        { id: 'mo2', name: '2', odds: 3.30 },
      ],
    },
  ]);
  const unibet = createEvent('unibet', 'FCSB', 'CFR Cluj', [
    {
      id: 'm-1x2-b',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 'u1', name: '1', odds: 2.10 },
        { id: 'ux', name: 'X', odds: 3.70 },
        { id: 'u2', name: '2', odds: 3.60 },
      ],
    },
  ]);

  const arbs = findArbitrage(groupByEvent([betano, unibet]), { includeSynthetic: true });
  const synth = arbs.find((a) => a.syntheticType === '1X2_AH05');
  assert.ok(synth, 'Expected 1X2_AH05 3-way synthetic arbitrage');
  assert.equal(synth.legs.length, 3);
  assert.equal(synth.legs.find((l) => l.outcome === 'home').selection, '1 (-0.5)');
  assert.equal(synth.legs.find((l) => l.outcome === 'draw').selection, 'X');
  assert.equal(synth.legs.find((l) => l.outcome === 'away').selection, '2');
  assert.ok(synth.marginPercent > 2.5);

  // Pure MATCH_ODDS without any AH -0.5 leg must never emit a duplicate 1X2_AH05 synthetic.
  const pureA = createEvent('betano', 'Rapid', 'Dinamo', [
    {
      id: 'p1',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 'pa1', name: '1', odds: 2.40 },
        { id: 'pax', name: 'X', odds: 3.20 },
        { id: 'pa2', name: '2', odds: 3.10 },
      ],
    },
  ]);
  const pureB = createEvent('unibet', 'Rapid', 'Dinamo', [
    {
      id: 'p2',
      key: 'MATCH_ODDS',
      name: '1X2',
      period: 'fulltime',
      selections: [
        { id: 'pb1', name: '1', odds: 2.00 },
        { id: 'pbx', name: 'X', odds: 3.80 },
        { id: 'pb2', name: '2', odds: 3.65 },
      ],
    },
  ]);
  const pureArbs = findArbitrage(groupByEvent([pureA, pureB]), { includeSynthetic: true });
  assert.equal(pureArbs.filter((a) => a.syntheticType === '1X2_AH05').length, 0);
  assert.equal(pureArbs.filter((a) => a.family === 'MATCH_ODDS').length, 1);
});

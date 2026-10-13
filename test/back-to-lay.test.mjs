import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBackToLay,
  executeDepthBackToLay,
  findBackToLayArbitrage,
  DEFAULT_EXCHANGE_COMMISSION,
  SIGNAL_TYPES,
} from '../src/scanner/engine.mjs';

test('SIGNAL_TYPES includes BACK_TO_LAY', () => {
  assert.equal(SIGNAL_TYPES.BACK_TO_LAY, 'back_to_lay');
});

test('calculateBackToLay: validates input invariants', () => {
  assert.equal(calculateBackToLay({ backOdds: 1.0, layOdds: 2.0, bankroll: 100 }), null);
  assert.equal(calculateBackToLay({ backOdds: 2.0, layOdds: 1.0, bankroll: 100 }), null);
  assert.equal(calculateBackToLay({ backOdds: 2.0, layOdds: 2.0, bankroll: 0 }), null);
  assert.equal(calculateBackToLay({ backOdds: 2.0, layOdds: 2.0, bankroll: -50 }), null);
  assert.equal(calculateBackToLay({ backOdds: NaN, layOdds: 2.0 }), null);
  assert.equal(calculateBackToLay({ backOdds: 2.0, layOdds: NaN }), null);
});

test('calculateBackToLay: computes profitable arbitrage with 5% Betfair commission', () => {
  const result = calculateBackToLay({
    backOdds: 2.50,
    layOdds: 2.30,
    bankroll: 100,
    commission: 0.05,
  });

  assert.ok(result);
  assert.equal(result.isArb, true);
  assert.equal(result.commission, 0.05);

  // breakEvenBackOdds = (2.30 - 0.05) / (1 - 0.05) = 2.25 / 0.95 = 2.3684
  assert.equal(result.breakEvenBackOdds, 2.3684);

  // rating = (2.50 * 0.95) / 2.25 = 1.0556
  assert.equal(result.rating, 1.0556);
  assert.equal(result.marginPercent, 5.56);

  // Target sizing:
  // layStake = (100 * 2.50) / (2.30 - 0.05) = 250 / 2.25 = 111.11
  assert.equal(result.targetBackStake, 100);
  assert.equal(result.targetLayStake, 111.11);
  assert.equal(result.targetLiability, 144.44); // 111.11 * 1.30 = 144.44
  assert.equal(result.targetTotalCapital, 244.44);

  // Clamped (unconstrained here) stakes:
  assert.equal(result.backStake, 100);
  assert.equal(result.layStake, 111.11);
  assert.equal(result.liability, 144.44);
  assert.equal(result.totalCapital, 244.44);

  // Profits should be balanced across outcomes:
  // Win profit: (100 * 2.50 - 144.44) - 100 = 105.56 - 100 = +5.56
  // Lose profit: (111.11 * 0.95) - 100 = 105.55 - 100 = +5.55
  assert.equal(result.winProfit, 5.56);
  assert.equal(result.loseProfit, 5.55);
  assert.equal(result.guaranteedProfit, 5.55);
  assert.ok(result.roiPercent > 2.2);

  assert.equal(result.isLiquidityConstrained, false);
  assert.equal(result.fillRate, 1);
});

test('calculateBackToLay: zero commission edge matches backOdds / layOdds', () => {
  const result = calculateBackToLay({
    backOdds: 2.10,
    layOdds: 2.00,
    bankroll: 100,
    commission: 0,
  });

  assert.ok(result);
  assert.equal(result.isArb, true);
  assert.equal(result.commission, 0);
  assert.equal(result.breakEvenBackOdds, 2.0);
  assert.equal(result.rating, 1.05); // 2.10 / 2.00 = 1.05
  assert.equal(result.marginPercent, 5.0);

  // layStake = (100 * 2.10) / 2.0 = 105
  assert.equal(result.layStake, 105);
  assert.equal(result.liability, 105);
  assert.equal(result.winProfit, 5); // 210 - 105 - 100 = 5
  assert.equal(result.loseProfit, 5); // 105 - 100 = 5
  assert.equal(result.guaranteedProfit, 5);
});

test('calculateBackToLay: negative margin identifies non-arbitrage', () => {
  const result = calculateBackToLay({
    backOdds: 2.20,
    layOdds: 2.30,
    bankroll: 100,
    commission: 0.05,
  });

  assert.ok(result);
  assert.equal(result.isArb, false);
  assert.ok(result.rating < 1);
  assert.ok(result.marginPercent < 0);
  assert.ok(result.guaranteedProfit < 0);
});

test('calculateBackToLay: liquidity clamping constrains back stake and preserves hedge balance', () => {
  // Target lay stake is 111.11, but only 50 RON is available to lay on Betfair
  const result = calculateBackToLay({
    backOdds: 2.50,
    layOdds: 2.30,
    bankroll: 100,
    commission: 0.05,
    layLiquidity: 50,
  });

  assert.ok(result);
  assert.equal(result.isLiquidityConstrained, true);
  assert.equal(result.availableLiquidity, 50);

  // Clamped lay stake must exactly equal available liquidity
  assert.equal(result.layStake, 50);

  // Back stake scaled down: (50 * 2.25) / 2.50 = 45.00
  assert.equal(result.backStake, 45);

  // Liability = 50 * 1.30 = 65.00
  assert.equal(result.liability, 65);
  assert.equal(result.totalCapital, 110);

  // Profits on both sides:
  // Win profit: (45 * 2.50 - 65) - 45 = 112.50 - 65 - 45 = +2.50
  // Lose profit: (50 * 0.95) - 45 = 47.50 - 45 = +2.50
  assert.equal(result.winProfit, 2.5);
  assert.equal(result.loseProfit, 2.5);
  assert.equal(result.guaranteedProfit, 2.5);

  // Fill rate: 50 / 111.11 = 0.45
  assert.equal(result.fillRate, 0.45);
});

test('executeDepthBackToLay: multi-rung order book depth execution', () => {
  const depth = [
    { price: 2.20, size: 40 },
    { price: 2.25, size: 80 },
    { price: 2.30, size: 100 },
  ];

  const exec = executeDepthBackToLay({
    backOdds: 2.50,
    bankroll: 100,
    commission: 0.05,
    depth,
  });

  assert.ok(exec);
  assert.ok(exec.filledBackStake > 0);
  assert.ok(exec.filledLayStake > 0);
  assert.ok(exec.effectiveLayOdds >= 2.20);
  assert.ok(exec.guaranteedProfit > 0);
  assert.ok(exec.rungsUsed.length > 1);
});

test('executeDepthBackToLay: handles empty or invalid depth gracefully', () => {
  const exec = executeDepthBackToLay({
    backOdds: 2.50,
    bankroll: 100,
    depth: [],
  });

  assert.equal(exec.filledBackStake, 0);
  assert.equal(exec.filledLayStake, 0);
  assert.equal(exec.rungsUsed.length, 0);
});

test('findBackToLayArbitrage: finds cross-book opportunity between soft book and Betfair', () => {
  const instances = [
    {
      sourceId: 'superbet',
      sport: 'football',
      league: 'Premier League',
      kickoff: '2030-01-01T15:00:00Z',
      homeTeam: 'Arsenal',
      awayTeam: 'Chelsea',
      markets: [
        {
          key: '1X2',
          name: 'Rezultat Final',
          period: 'fulltime',
          selections: [
            { id: 'sb-1', name: '1', odds: 2.55 },
            { id: 'sb-X', name: 'X', odds: 3.40 },
            { id: 'sb-2', name: '2', odds: 2.90 },
          ],
        },
        {
          key: 'OVER_UNDER_2_5',
          name: 'Total Goluri 2.5',
          period: 'fulltime',
          line: 2.5,
          selections: [
            { id: 'sb-o', name: 'Over 2.5', odds: 2.10, handicap: 2.5 },
            { id: 'sb-u', name: 'Under 2.5', odds: 1.80, handicap: 2.5 },
          ],
        },
      ],
    },
    {
      sourceId: 'betfair',
      sport: 'football',
      league: 'Premier League',
      kickoff: '2030-01-01T15:00:00Z',
      homeTeam: 'Arsenal',
      awayTeam: 'Chelsea',
      markets: [
        {
          key: '1X2',
          name: 'Match Odds',
          period: 'fulltime',
          selections: [
            {
              id: 'bf-1',
              name: '1',
              odds: 2.25,
              layOdds: 2.30,
              depth: { lay: [{ price: 2.30, size: 250 }] },
              isExchange: true,
            },
            {
              id: 'bf-X',
              name: 'X',
              odds: 3.35,
              layOdds: 3.50,
              depth: { lay: [{ price: 3.50, size: 100 }] },
              isExchange: true,
            },
            {
              id: 'bf-2',
              name: '2',
              odds: 2.80,
              layOdds: 3.00,
              depth: { lay: [{ price: 3.00, size: 150 }] },
              isExchange: true,
            },
          ],
        },
        {
          key: 'OVER_UNDER_2_5',
          name: 'Over/Under 2.5 Goals',
          period: 'fulltime',
          line: 2.5,
          selections: [
            {
              id: 'bf-o',
              name: 'Over 2.5',
              odds: 1.90,
              layOdds: 1.95,
              depth: { lay: [{ price: 1.95, size: 300 }] },
              isExchange: true,
            },
            {
              id: 'bf-u',
              name: 'Under 2.5',
              odds: 1.75,
              layOdds: 1.85,
              depth: { lay: [{ price: 1.85, size: 200 }] },
              isExchange: true,
            },
          ],
        },
      ],
    },
  ];

  const grouped = new Map([['arsenal-chelsea', instances]]);
  const arbs = findBackToLayArbitrage(grouped, {
    bankroll: 100,
    commission: 0.05,
    minMarginPercent: 0,
  });

  assert.ok(arbs.length >= 2, `Expected at least 2 Back-to-Lay arbs, got ${arbs.length}`);

  const matchOddsArb = arbs.find((a) => a.family === 'MATCH_ODDS' && a.outcome === 'home');
  assert.ok(matchOddsArb);
  assert.equal(matchOddsArb.type, 'back_to_lay');
  assert.equal(matchOddsArb.backLeg.sourceId, 'superbet');
  assert.equal(matchOddsArb.backLeg.odds, 2.55);
  assert.equal(matchOddsArb.layLeg.sourceId, 'betfair');
  assert.equal(matchOddsArb.layLeg.odds, 2.30);
  assert.ok(matchOddsArb.marginPercent > 0);
  assert.ok(matchOddsArb.guaranteedProfit > 0);

  const totalsArb = arbs.find((a) => a.family === 'OVER_UNDER' && a.outcome === 'over');
  assert.ok(totalsArb);
  assert.equal(totalsArb.backLeg.odds, 2.10);
  assert.equal(totalsArb.layLeg.odds, 1.95);
  assert.ok(totalsArb.marginPercent > 0);
  assert.ok(totalsArb.guaranteedProfit > 0);
});

test('findBackToLayArbitrage: respects pairing scope (live vs prematch separation)', () => {
  const instances = [
    {
      sourceId: 'betano',
      sport: 'football',
      homeTeam: 'Real Madrid',
      awayTeam: 'Barcelona',
      markets: [
        {
          key: '1X2',
          live: true, // In-play soft book market
          selections: [{ name: '1', odds: 3.00 }],
        },
      ],
    },
    {
      sourceId: 'betfair',
      sport: 'football',
      homeTeam: 'Real Madrid',
      awayTeam: 'Barcelona',
      markets: [
        {
          key: '1X2',
          live: false, // Pre-match exchange market
          selections: [{ name: '1', odds: 2.10, layOdds: 2.15, isExchange: true }],
        },
      ],
    },
  ];

  const grouped = new Map([['rm-barca', instances]]);
  const arbs = findBackToLayArbitrage(grouped);

  // Must NOT pair live back leg with pre-match lay leg
  assert.equal(arbs.length, 0);
});

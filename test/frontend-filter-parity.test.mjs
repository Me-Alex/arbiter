/**
 * frontend-filter-parity.test.mjs — the filter panel's newer predicates.
 *
 * The board grew the controls a professional surebet desk expects: a profit
 * ceiling, an outcome count, how stale a price may be, how soon the match
 * starts, and a tournament and market scope. Every one of them reads a field the
 * opportunity model already carried, so the risk is not in the data — it is in
 * the predicate.
 *
 * Two failure modes are worth a test each, because both are invisible:
 *
 *   A window that fails open keeps a row the user asked to hide. A window that
 *   fails closed on an *unknown* setting empties the whole board. The first
 *   lies quietly; the second looks like "there is nothing to bet on". The
 *   second is the one a caller predating these fields would hit, so it is
 *   pinned explicitly below.
 *
 *   A menu built from `marketKey || marketName` and a predicate reading only
 *   `marketKey` disagree on the rows whose key is empty. That was a real defect
 *   in the first draft of this change: the option rendered, selecting it showed
 *   zero rows, and nothing went red.
 *
 * `now` is passed in rather than read from the wall clock, so a boundary is
 * asserted exactly instead of raced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FILTER_CRITERIA,
  annualizedRoiPercent,
  filterOpportunities,
  groupOpportunitiesByEvent,
  isPushCapableOpportunity,
  mergePinnedOpportunities,
} from '../frontend/src/workspace.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** One opportunity, with every field a predicate here reads. */
function opp(overrides = {}) {
  const legs = overrides.legs ?? [
    { bookmakerId: 'betano', bookmakerName: 'Betano', selection: '1', rawOdds: 2.1, effectiveOdds: 2.1, marketKey: 'MATCH_ODDS', marketName: 'Match odds' },
    { bookmakerId: 'pinnacle', bookmakerName: 'Pinnacle', selection: '2', rawOdds: 2.1, effectiveOdds: 2.1, marketKey: 'MATCH_ODDS', marketName: 'Match odds' },
  ];
  return {
    id: overrides.id ?? 'opp-1',
    type: 'surebet',
    sport: 'Football',
    league: 'Germany - Bundesliga',
    homeTeam: 'Eintracht Frankfurt',
    awayTeam: 'Hamburger SV',
    startTime: new Date(NOW + 2 * HOUR).toISOString(),
    isLive: false,
    profitPercent: 1.5,
    createdAt: NOW - 5 * MINUTE,
    lastUpdatedAt: NOW - 5 * MINUTE,
    legs,
    ruleSafety: { isCompatible: true, severity: 'safe' },
    ttlSeconds: 900,
    sourceCount: 2,
    marketKey: 'MATCH_ODDS',
    marketName: 'Match odds',
    scannedAt: NOW,
    ...overrides,
  };
}

const ids = (rows) => rows.map((r) => r.id).sort();
const withCriteria = (patch) => ({ ...DEFAULT_FILTER_CRITERIA, ...patch });

// ── defaults ────────────────────────────────────────────────────────────────

test('the default criteria filters nothing', () => {
  const rows = [opp({ id: 'a' }), opp({ id: 'b', profitPercent: 9 })];
  assert.deepEqual(ids(filterOpportunities(rows, DEFAULT_FILTER_CRITERIA, NOW)), ['a', 'b']);
});

test('every new control has a neutral default, so a reset restores the board', () => {
  assert.equal(DEFAULT_FILTER_CRITERIA.maxProfit, 0);
  assert.equal(DEFAULT_FILTER_CRITERIA.outcomeCount, 'all');
  assert.equal(DEFAULT_FILTER_CRITERIA.ageWindow, 'all');
  assert.equal(DEFAULT_FILTER_CRITERIA.eventDuring, 'all');
  assert.equal(DEFAULT_FILTER_CRITERIA.league, 'all');
  assert.equal(DEFAULT_FILTER_CRITERIA.market, 'all');
});

// ── profit ceiling ──────────────────────────────────────────────────────────

test('maxProfit caps the board and keeps a row on the boundary', () => {
  const rows = [
    opp({ id: 'low', profitPercent: 0.4 }),
    opp({ id: 'edge', profitPercent: 1.0 }),
    opp({ id: 'high', profitPercent: 4.2 }),
  ];
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ maxProfit: 1 }), NOW)), ['edge', 'low']);
});

test('maxProfit and minProfit read as one range, not two switches', () => {
  const rows = [
    opp({ id: 'below', profitPercent: 0.5 }),
    opp({ id: 'inside', profitPercent: 2.0 }),
    opp({ id: 'above', profitPercent: 6.0 }),
  ];
  assert.deepEqual(
    ids(filterOpportunities(rows, withCriteria({ minProfit: 1, maxProfit: 3 }), NOW)),
    ['inside'],
  );
});

test('a max below the min returns nothing rather than silently swapping them', () => {
  const rows = [opp({ id: 'a', profitPercent: 2 })];
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ minProfit: 5, maxProfit: 1 }), NOW)), []);
});

// ── outcome count ───────────────────────────────────────────────────────────

const threeLegs = [
  { bookmakerId: 'a', bookmakerName: 'A', selection: '1', rawOdds: 3, effectiveOdds: 3, marketKey: 'MATCH_ODDS', marketName: 'Match odds' },
  { bookmakerId: 'b', bookmakerName: 'B', selection: 'X', rawOdds: 3, effectiveOdds: 3, marketKey: 'MATCH_ODDS', marketName: 'Match odds' },
  { bookmakerId: 'c', bookmakerName: 'C', selection: '2', rawOdds: 3, effectiveOdds: 3, marketKey: 'MATCH_ODDS', marketName: 'Match odds' },
];

test('outcomeCount separates a two-leg surebet from a three-leg one', () => {
  const rows = [opp({ id: 'two' }), opp({ id: 'three', legs: threeLegs })];
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ outcomeCount: '2' }), NOW)), ['two']);
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ outcomeCount: '3' }), NOW)), ['three']);
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ outcomeCount: 'all' }), NOW)), ['three', 'two']);
});

test('the outcome count reads legs, so it cannot disagree with the rendered row', () => {
  // A row whose legs and a hypothetical counter disagreed would be filtered by
  // one number and drawn by another. There is no counter: the tuple is the fact.
  const rows = [opp({ id: 'three', legs: threeLegs })];
  assert.equal(filterOpportunities(rows, withCriteria({ outcomeCount: '2' }), NOW).length, 0);
});

// ── age window ──────────────────────────────────────────────────────────────

test('ageWindow keeps a fresh price and drops a stale one', () => {
  const rows = [
    opp({ id: 'fresh', createdAt: NOW - 3 * MINUTE }),
    opp({ id: 'stale', createdAt: NOW - 3 * HOUR }),
  ];
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ ageWindow: '10m' }), NOW)), ['fresh']);
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ ageWindow: '12h' }), NOW)), ['fresh', 'stale']);
});

test('the age boundary is inclusive, judged against the instant passed in', () => {
  const rows = [opp({ id: 'exact', createdAt: NOW - 10 * MINUTE })];
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ ageWindow: '10m' }), NOW)), ['exact']);
  // One millisecond older is outside the window. Without the injected `now`
  // this assertion would race the wall clock and flake.
  const older = [opp({ id: 'exact', createdAt: NOW - 10 * MINUTE - 1 })];
  assert.deepEqual(ids(filterOpportunities(older, withCriteria({ ageWindow: '10m' }), NOW)), []);
});

test('a row with an unreadable age is excluded once a window is set', () => {
  const rows = [opp({ id: 'unknown', createdAt: undefined })];
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ ageWindow: '10m' }), NOW)), []);
  // With no window it is still shown: the filter was not asked about age.
  assert.deepEqual(ids(filterOpportunities(rows, DEFAULT_FILTER_CRITERIA, NOW)), ['unknown']);
});

// ── event horizon ───────────────────────────────────────────────────────────

test('eventDuring keeps a match inside the horizon and drops one beyond it', () => {
  const rows = [
    opp({ id: 'soon', startTime: new Date(NOW + 2 * HOUR).toISOString() }),
    opp({ id: 'far', startTime: new Date(NOW + 5 * 24 * HOUR).toISOString() }),
  ];
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ eventDuring: '12h' }), NOW)), ['soon']);
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ eventDuring: '1w' }), NOW)), ['far', 'soon']);
});

test('an unparseable kickoff is excluded once a horizon is set', () => {
  const rows = [opp({ id: 'broken', startTime: 'not-a-date' })];
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ eventDuring: '12h' }), NOW)), []);
  assert.deepEqual(ids(filterOpportunities(rows, DEFAULT_FILTER_CRITERIA, NOW)), ['broken']);
});

test('the horizon and the timing filter answer different questions', () => {
  // A live match has already started, so it is inside every horizon; whether it
  // belongs on screen is `timing`'s decision, not this one's.
  const rows = [
    opp({ id: 'live', isLive: true, startTime: new Date(NOW - 20 * MINUTE).toISOString() }),
    opp({ id: 'pre', startTime: new Date(NOW + HOUR).toISOString() }),
  ];
  assert.deepEqual(ids(filterOpportunities(rows, withCriteria({ eventDuring: '12h' }), NOW)), ['live', 'pre']);
  assert.deepEqual(
    ids(filterOpportunities(rows, withCriteria({ eventDuring: '12h', timing: 'prematch' }), NOW)),
    ['pre'],
  );
});

// ── tournament and market ───────────────────────────────────────────────────

test('the league filter matches the published label exactly', () => {
  const rows = [
    opp({ id: 'bundesliga', league: 'Germany - Bundesliga' }),
    opp({ id: 'seriea', league: 'Italy - Serie A' }),
  ];
  assert.deepEqual(
    ids(filterOpportunities(rows, withCriteria({ league: 'Italy - Serie A' }), NOW)),
    ['seriea'],
  );
});

test('the market filter matches a row whose key is empty by falling back to its name', () => {
  // The panel builds its options from `marketKey || marketName`. A predicate
  // reading only `marketKey` renders the option and then matches nothing.
  const rows = [
    opp({ id: 'keyed', marketKey: 'MATCH_ODDS', marketName: 'Match odds' }),
    opp({ id: 'nameless', marketKey: '', marketName: 'Both teams to score' }),
  ];
  assert.deepEqual(
    ids(filterOpportunities(rows, withCriteria({ market: 'Both teams to score' }), NOW)),
    ['nameless'],
  );
});

// ── the regression that matters ─────────────────────────────────────────────

test('a criteria object predating these controls filters nothing, rather than everything out', () => {
  // Every caller written before this change passes exactly these eight keys.
  // An `!== 'all'` guard reads `undefined !== 'all'` as "filter on undefined"
  // and drops every row, which renders as an empty board and no error.
  const legacy = {
    type: 'all',
    sport: 'all',
    bookmaker: 'all',
    safety: 'all',
    timing: 'all',
    minProfit: 0,
    query: '',
    sortBy: 'recommended',
  };
  const rows = [opp({ id: 'a' }), opp({ id: 'b', profitPercent: 4 }), opp({ id: 'c', legs: threeLegs })];
  assert.deepEqual(ids(filterOpportunities(rows, legacy, NOW)), ['a', 'b', 'c']);
});

test('an unrecognised window value is treated as no window, not as a filter', () => {
  const rows = [opp({ id: 'a' })];
  const odd = withCriteria({ ageWindow: '37h', eventDuring: 'fortnight' });
  assert.deepEqual(ids(filterOpportunities(rows, odd, NOW)), ['a']);
});

// ── composition ─────────────────────────────────────────────────────────────

test('the controls compose into one pass', () => {
  const rows = [
    opp({ id: 'match', profitPercent: 2, league: 'Germany - Bundesliga', createdAt: NOW - MINUTE }),
    opp({ id: 'wrong-league', profitPercent: 2, league: 'Italy - Serie A', createdAt: NOW - MINUTE }),
    opp({ id: 'too-old', profitPercent: 2, league: 'Germany - Bundesliga', createdAt: NOW - 6 * HOUR }),
    opp({ id: 'too-rich', profitPercent: 8, league: 'Germany - Bundesliga', createdAt: NOW - MINUTE }),
    opp({ id: 'three-leg', profitPercent: 2, league: 'Germany - Bundesliga', createdAt: NOW - MINUTE, legs: threeLegs }),
  ];
  const criteria = withCriteria({
    league: 'Germany - Bundesliga',
    minProfit: 1,
    maxProfit: 3,
    ageWindow: '10m',
    outcomeCount: '2',
    eventDuring: '12h',
  });
  assert.deepEqual(ids(filterOpportunities(rows, criteria, NOW)), ['match']);
});

test('SureBet.com terminal controls: minOdds/maxOdds, noPushOnly, annualizedRoiPercent, roi_desc/age_asc, hidden rules, event grouping, and pinned snapshots', () => {
  const fastSoon = opp({
    id: 'fast-soon',
    profitPercent: 2.0,
    startTime: new Date(NOW + 4 * HOUR).toISOString(),
    createdAt: NOW - 1 * MINUTE,
    marketKey: 'OVER_UNDER_2_5',
    marketName: 'Total Goals 2.5 · FT',
    legs: [
      { bookmakerId: 'betano', bookmakerName: 'Betano', selection: 'Over 2.5', rawOdds: 2.05, effectiveOdds: 2.05, marketKey: 'OVER_UNDER_2_5', marketName: 'Total Goals 2.5' },
      { bookmakerId: 'unibet', bookmakerName: 'Unibet', selection: 'Under 2.5', rawOdds: 2.04, effectiveOdds: 2.04, marketKey: 'OVER_UNDER_2_5', marketName: 'Total Goals 2.5' },
    ],
  });
  const slowFar = opp({
    id: 'slow-far',
    profitPercent: 3.0,
    startTime: new Date(NOW + 120 * HOUR).toISOString(),
    createdAt: NOW - 30 * MINUTE,
    marketKey: 'SYNTHETIC_DNB_AH0',
    marketName: 'Draw No Bet (level) · FT',
    legs: [
      { bookmakerId: 'betano', bookmakerName: 'Betano', selection: '1 (0)', rawOdds: 1.55, effectiveOdds: 1.55, marketKey: 'ASIAN_HANDICAP_0', marketName: 'Draw No Bet' },
      { bookmakerId: 'favbet', bookmakerName: 'Favbet', selection: '2', rawOdds: 3.10, effectiveOdds: 3.10, marketKey: 'DRAW_NO_BET', marketName: 'Draw No Bet' },
    ],
  });

  // Push capability detection
  assert.equal(isPushCapableOpportunity(fastSoon), false);
  assert.equal(isPushCapableOpportunity(slowFar), true);

  // noPushOnly hides DNB / integer / quarter push lines
  assert.deepEqual(
    ids(filterOpportunities([fastSoon, slowFar], withCriteria({ noPushOnly: true }), NOW)),
    ['fast-soon'],
  );

  // minOdds / maxOdds check every leg
  assert.deepEqual(
    ids(filterOpportunities([fastSoon, slowFar], withCriteria({ minOdds: 1.8 }), NOW)),
    ['fast-soon'],
  );
  assert.deepEqual(
    ids(filterOpportunities([fastSoon, slowFar], withCriteria({ maxOdds: 2.5 }), NOW)),
    ['fast-soon'],
  );

  // Annualized ROI ranks fast-settling 2% in 4h ahead of 3% in 5 days
  const roiFast = annualizedRoiPercent(fastSoon, NOW);
  const roiSlow = annualizedRoiPercent(slowFar, NOW);
  assert.ok(roiFast !== null && roiSlow !== null && roiFast > roiSlow);
  assert.deepEqual(
    filterOpportunities([slowFar, fastSoon], withCriteria({ sortBy: 'roi_desc' }), NOW).map((r) => r.id),
    ['fast-soon', 'slow-far'],
  );
  assert.deepEqual(
    filterOpportunities([slowFar, fastSoon], withCriteria({ sortBy: 'age_asc' }), NOW).map((r) => r.id),
    ['fast-soon', 'slow-far'],
  );

  // Granular hidden rules
  const hidden = { opportunityIds: [], eventKeys: [], leagues: [], bookmakers: ['favbet'] };
  assert.deepEqual(
    ids(filterOpportunities([fastSoon, slowFar], DEFAULT_FILTER_CRITERIA, NOW, hidden)),
    ['fast-soon'],
  );

  // Group by event
  const sibling = opp({ ...fastSoon, id: 'fast-sibling', eventKey: 'ev-same', profitPercent: 1.2 });
  const primary = opp({ ...fastSoon, id: 'fast-primary', eventKey: 'ev-same', profitPercent: 2.4 });
  const groups = groupOpportunitiesByEvent([primary, sibling, slowFar]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].primary.id, 'fast-primary');
  assert.equal(groups[0].siblings.length, 1);

  // Pin to top even if disappeared from latest scan
  const goneSnap = { ...slowFar, id: 'gone-id' };
  const merged = mergePinnedOpportunities([fastSoon], ['gone-id'], { 'gone-id': goneSnap });
  assert.equal(merged.opportunities[0].id, 'gone-id');
  assert.ok(merged.stalePinnedIds.has('gone-id'));
});

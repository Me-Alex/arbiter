import test from 'node:test';
import assert from 'node:assert/strict';
import NetBetScraper from '../src/scrapers/netbet.mjs';
import { resolveContract, canonicalOutcomeFor, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

/**
 * netbet regression coverage.
 *
 * Every shape below is taken from a live Sportify all-sports inventory capture
 * taken 2026-09-29 (1,466 events / 2,761 markets / 16 market_codes). The
 * capture is not committed, so these are transcribed field-for-field: the
 * assertions that matter are the ones that failed before the fix, and each
 * test names the defect it pins.
 */

const FUTURE = '2030-01-01T12:00:00Z';

/** One raw event with the given competitors and markets. */
function rawEvent(markets, competitors) {
  return {
    id: 900001,
    is_live: false,
    is_suspended: false,
    starts_at: FUTURE,
    competition_name: 'Liga 1',
    competitors: competitors || [
      { name: 'Boston Celtics', is_home: true },
      { name: 'Detroit Pistons', is_home: false },
    ],
    markets,
  };
}

/** One raw market from the capture's field set. */
function rawMarket(marketCode, name, marketType, outcomes, extra = {}) {
  return {
    id: `m-${marketCode}`,
    market_code: marketCode,
    market_type: marketType,
    name,
    outcomes: outcomes.map((o, i) => ({
      id: `o-${marketCode}-${i}`,
      odds: o.odds ?? null,
      display_odds: o.odds ? { decimal: String(o.odds) } : null,
      kind: o.kind,
      name: o.name,
      fullname: o.fullname ?? o.name,
      order: i,
      suspended: o.suspended ?? false,
      visible: true,
      status: 'active',
      market_type: marketType,
      handicap: o.handicap ?? null,
      handicap_abs: o.handicap_abs ?? null,
    })),
    ...extra,
  };
}

/**
 * Run the real adapter over a one-event tree and return everything it emits,
 * including nothing. Used by the tests that assert an event is *refused* —
 * a helper that insisted on one survivor could not express that.
 */
function emitAll(markets, competitors) {
  const scraper = new NetBetScraper({ maxEvents: 10 });
  scraper.observedAt = '2026-09-29T12:33:00.000Z';
  const rawEvents = scraper.normalize({
    tree: [{ name: 'Baschet', competitions: [{ name: 'NBA', events: [rawEvent(markets, competitors)] }] }],
  });
  return scraper.extractEvents(rawEvents);
}

/** Run the real adapter over a one-event tree. */
function extract(markets, competitors) {
  const events = emitAll(markets, competitors);
  assert.equal(events.length, 1, 'the fixture event must survive the adapter filters');
  return events[0];
}

/** The market with the given key, plus its contract and per-leg routing. */
function contractOf(event, key) {
  const market = event.markets.find((m) => m.key === key);
  assert.ok(market, `market ${key} was dropped by the adapter`);
  const contract = resolveContract(market);
  const routed = contract
    ? market.selections.map((s) => canonicalOutcomeFor(s.name, contract, { homeTeam: event.homeTeam, awayTeam: event.awayTeam }))
    : null;
  return { market, contract, routed };
}

test('a two-way match winner priced on abbreviated team names still routes both legs', () => {
  // Basketball "Castigator Meci". The capture names the sides "B. Celtics" /
  // "D. Pistons" while the event carries "Boston Celtics" / "Detroit Pistons".
  // The adapter used to copy the display string, so both legs resolved to null
  // and the market could never be priced: 398 of these in the capture.
  const event = extract([
    rawMarket('default', 'Castigator Meci', 5498, [
      { kind: 'W1', name: 'B. Celtics', fullname: 'Boston Celtics', odds: 1.85 },
      { kind: 'W2', name: 'D. Pistons', fullname: 'Detroit Pistons', odds: 1.95 },
    ]),
  ]);
  const { market, contract, routed } = contractOf(event, 'default');
  assert.equal(contract.family, 'MATCH_ODDS');
  assert.equal(contract.outcomes.length, 2, 'a two-way result market is 2-outcome');
  assert.notEqual(contract.arbEligible, false, 'a no-draw sport result market is arbitrable');
  assert.deepEqual(routed, ['home', 'away']);
  // The side comes from `kind`, not from the abbreviated display string.
  assert.deepEqual(market.selections.map((s) => s.name), ['1', '2']);
});

test('a three-way football result keeps home/draw/away apart', () => {
  const event = extract([
    rawMarket('default', 'Rezultat Final', 5498, [
      { kind: 'W1', name: '1', fullname: 'Atletico Tucuman', odds: 1.91 },
      { kind: 'X', name: 'X', fullname: 'X', odds: 2.97 },
      { kind: 'W2', name: '2', fullname: 'Barracas Central', odds: 4.5 },
    ]),
  ], [
    { name: 'Atletico Tucuman', is_home: true },
    { name: 'Barracas Central', is_home: false },
  ]);
  const { contract, routed } = contractOf(event, 'default');
  assert.equal(contract.family, 'MATCH_ODDS');
  assert.deepEqual(contract.outcomes, ['home', 'draw', 'away']);
  assert.deepEqual(routed, ['home', 'draw', 'away']);
});

test('a spread priced on abbreviated names routes home/away and keeps the sign', () => {
  // "handicap" on basketball: market handicap 1.5, home leg -1.5, away +1.5.
  // This is the shape whose legs used to fall through: "B. Celtics (1.5)" is
  // neither "1 ..." nor "Boston Celtics", so ASIAN_HANDICAP had no way to
  // label the side. 221 markets in the capture.
  const event = extract([
    rawMarket('handicap', 'Handicap Puncte', 4477, [
      { kind: 'Home', name: 'B. Celtics (1.5)', fullname: 'Boston Celtics (1.5)', odds: 1.86, handicap: -1.5, handicap_abs: 1.5 },
      { kind: 'Away', name: 'D. Pistons (-1.5)', fullname: 'Detroit Pistons (-1.5)', odds: 1.95, handicap: 1.5, handicap_abs: 1.5 },
    ], { handicap: -1.5 }),
  ]);
  const { market, contract, routed } = contractOf(event, 'handicap');
  assert.equal(contract.family, 'ASIAN_HANDICAP');
  assert.deepEqual(routed, ['home', 'away']);
  assert.deepEqual(market.selections.map((s) => s.name), ['1 (-1.5)', '2 (1.5)']);
  assert.equal(contract.lineKey, '-1.5/1.5', 'the lineKey is ordered home/away, not by array position');
});

test('a points spread whose home leg is under the line still orders home first', () => {
  // The mirrored listing: home is the underdog, so its leg line is positive.
  // Two books that publish the same spread in opposite array order must land in
  // one bucket, which is what handicapLineKey's home/away ordering is for.
  const event = extract([
    rawMarket('goals_handicap', 'Handicap (Timp Regulamentar)', 6549, [
      { kind: 'Home', name: 'F. Panthers (0.5)', fullname: 'Florida Panthers (0.5)', odds: 1.63, handicap: 0.5, handicap_abs: 0.5 },
      { kind: 'Away', name: 'C. Hurricanes (-0.5)', fullname: 'Carolina Hurricanes (-0.5)', odds: 2.16, handicap: -0.5, handicap_abs: 0.5 },
    ], { handicap: 0.5 }),
  ], [
    { name: 'Florida Panthers', is_home: true },
    { name: 'Carolina Hurricanes', is_home: false },
  ]);
  const { market, contract, routed } = contractOf(event, 'goals_handicap');
  assert.equal(contract.family, 'ASIAN_HANDICAP');
  assert.deepEqual(routed, ['home', 'away']);
  assert.equal(contract.lineKey, '0.5/-0.5');
  assert.deepEqual(market.selections.map((s) => s.name), ['1 (0.5)', '2 (-0.5)']);
});

test('a baseball run line is a SPREAD and never a total', () => {
  // "run_line" is named "Handicap Puncte" by the feed and its two legs are
  // exact negations (1.5 / -1.5), which is a spread. The fallback in
  // classifyAndExtractLine used to test magnitude before sign, so equal
  // magnitudes read as a total: the market resolved as OVER_UNDER/1.5, the
  // same bucket a 1.5-run total would occupy, and a book quoting a real total
  // at that line would have paired with it.
  const event = extract([
    rawMarket('run_line', 'Handicap Puncte', 378, [
      { kind: 'Home', name: 'P. Phillies (1.5)', fullname: 'Philadelphia Phillies (1.5)', odds: 1.67, handicap: 1.5, handicap_abs: 1.5 },
      { kind: 'Away', name: 'A. Braves (-1.5)', fullname: 'Atlanta Braves (-1.5)', odds: 2.15, handicap: -1.5, handicap_abs: 1.5 },
    ], { handicap: 1.5 }),
  ], [
    { name: 'Philadelphia Phillies', is_home: true },
    { name: 'Atlanta Braves', is_home: false },
  ]);
  const { contract, routed } = contractOf(event, 'run_line');
  assert.equal(contract.family, 'ASIAN_HANDICAP', 'exact negations are a spread, not a total');
  assert.equal(contract.lineKey, '1.5/-1.5');
  assert.deepEqual(routed, ['home', 'away']);
});

test('a totals line is read from the provider line field and routes over/under', () => {
  const event = extract([
    rawMarket('total_goals', 'Total Goluri', 5500, [
      { kind: 'Over', name: 'Peste (2.5)', odds: 1.59, handicap: 2.5, handicap_abs: 2.5 },
      { kind: 'Under', name: 'Sub (2.5)', odds: 2.26, handicap: 2.5, handicap_abs: 2.5 },
    ], { handicap: 2.5 }),
  ]);
  const { market, contract, routed } = contractOf(event, 'total_goals');
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.lineKey, '2.5');
  assert.deepEqual(routed, ['over', 'under']);
  // Built from `kind` + `handicap`, so the Romanian display text is not load-bearing.
  assert.deepEqual(market.selections.map((s) => s.name), ['Over 2.5', 'Under 2.5']);
});

test('BTTS routes yes/no from the provider side kind', () => {
  const event = extract([
    rawMarket('btts', 'Ambele Marcheaza (GG)', 5508, [
      { kind: 'Yes', name: 'Da', odds: 2.35 },
      { kind: 'No', name: 'Nu', odds: 1.55 },
    ]),
  ]);
  const { contract, routed } = contractOf(event, 'btts');
  assert.equal(contract.family, 'BTTS');
  assert.notEqual(contract.arbEligible, false);
  assert.deepEqual(routed, ['yes', 'no']);
});

test('an unpriced or suspended leg drops the market instead of faking a price', () => {
  const event = extract([
    // one leg has no odds yet (`odds: null` is how the feed publishes an
    // unpriced market) and one is suspended.
    rawMarket('total_goals', 'Total Goluri', 5500, [
      { kind: 'Over', name: 'Peste (2.5)', odds: 1.59, handicap: 2.5 },
      { kind: 'Under', name: 'Sub (2.5)', odds: null, handicap: 2.5 },
    ], { handicap: 2.5 }),
    rawMarket('btts', 'Ambele Marcheaza (GG)', 5508, [
      { kind: 'Yes', name: 'Da', odds: 2.35 },
      { kind: 'No', name: 'Nu', odds: 1.55, suspended: true },
    ]),
    rawMarket('default', 'Rezultat Final', 5498, [
      { kind: 'W1', name: '1', fullname: 'Boston Celtics', odds: 1.85 },
      { kind: 'W2', name: '2', fullname: 'Detroit Pistons', odds: 1.95 },
    ]),
  ]);
  assert.deepEqual(
    event.markets.map((m) => m.key),
    ['default'],
    'a market left with fewer than two priced legs is dropped, the rest of the event is not',
  );
});

test('segment winners are withheld: a frame winner is not the match winner', () => {
  // netbet publishes "Frame 4 Castigator" and "Castigator Meci" on the same
  // snooker event. Both resolve off names of "1"/"2" into MATCH_ODDS/_, so
  // without a guard they share one bucket and a frame price gets offered
  // against another book's match price.
  const event = extract([
    rawMarket('current_frame_winner', 'Frame 4 Castigator', 8827, [
      { kind: 'W1', name: '1', fullname: 'Jiang Jun', odds: 1.72 },
      { kind: 'W2', name: '2', fullname: 'Zak Surety', odds: 2 },
    ]),
    rawMarket('default', 'Castigator Meci', 5498, [
      { kind: 'W1', name: '1', fullname: 'Jiang Jun', odds: 1.7 },
      { kind: 'W2', name: '2', fullname: 'Zak Surety', odds: 2.05 },
    ]),
  ], [
    { name: 'Jiang Jun', is_home: true },
    { name: 'Zak Surety', is_home: false },
  ]);
  // The adapter still emits what the feed publishes; the contract layer is what
  // withholds it, and it must do so authoritatively.
  assert.ok(event.markets.some((m) => m.key === 'current_frame_winner'), 'the adapter emits the raw market');
  const frame = contractOf(event, 'current_frame_winner');
  assert.equal(frame.contract, null, 'a frame winner resolves to nothing at all');
  const match = contractOf(event, 'default');
  assert.equal(match.contract.family, 'MATCH_ODDS');
});

test('a darts 180 count is withheld: it is not the match scoring total', () => {
  const event = extract([
    rawMarket('total_180s', 'Total 180-uri', 9335, [
      { kind: 'Over', name: 'Peste (0.5)', odds: 2.95, handicap: 0.5, handicap_abs: 0.5 },
      { kind: 'Under', name: 'Sub (0.5)', odds: 1.35, handicap: 0.5, handicap_abs: 0.5 },
    ], { handicap: 0.5 }),
  ]);
  assert.equal(contractOf(event, 'total_180s').contract, null);
});

test('a whole-line spread is withheld rather than priced as a 2-way match winner', () => {
  // "1 (-7)" / "2 (7)" is a push-capable spread: on a seven-point tie the
  // stake is refunded, so the two legs are not jointly exhaustive. It fails
  // the half-line test, and the authoritative handicap guard has to stop it
  // before the last-resort 2-way match-winner path accepts it.
  const event = extract([
    rawMarket('handicap', 'Handicap Puncte', 4477, [
      { kind: 'Home', name: '1 (-7)', odds: 1.9, handicap: -7, handicap_abs: 7 },
      { kind: 'Away', name: '2 (7)', odds: 1.9, handicap: 7, handicap_abs: 7 },
    ], { handicap: -7 }),
  ]);
  assert.equal(contractOf(event, 'handicap').contract, null);
});

test('a matchday statistics board is dropped: its two "competitors" are table columns', () => {
  // netbet serves, under the competition "UEFA Champions League. Matchday
  // Statistics", an event whose competitors are "Gazde (Goluri)" and
  // "Oaspeți (Goluri)" — the home and away columns of a round's goal table —
  // beside a goals total quoted at 30.5 / 29.5, because it counts every goal of
  // the matchday rather than of a game. Measured live on 2026-10-02 at
  // maxEvents 3000 the shape is netbet's alone: 75 football events, 2 of them
  // this, and 0 across the other 23 books.
  //
  // Published as a fixture it reached the engine as OVER_UNDER::fulltime::30.5.
  // Nothing else stopped it: two non-empty names, a real kickoff, a priced
  // market, sport "Football". It was inert only because no other book quoted
  // the same thing — a coincidence of the feed, not a property of the contract.
  const markets = [
    rawMarket('total_goals', 'Total Goluri', 5500, [
      { kind: 'Over', name: 'Peste (30.5)', odds: 1.44, handicap: 30.5, handicap_abs: 30.5 },
      { kind: 'Under', name: 'Sub (30.5)', odds: 2.55, handicap: 30.5, handicap_abs: 30.5 },
    ], { handicap: 30.5 }),
  ];

  // The counterfactual that gives the assertion its meaning: this very market
  // over two real clubs is a perfectly good 30.5-goal total. Nothing about the
  // market is the problem — only who is playing it.
  const played = extract(markets, [
    { name: 'Arsenal', is_home: true },
    { name: 'Real Madrid', is_home: false },
  ]);
  const { contract, routed } = contractOf(played, 'total_goals');
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.lineKey, '30.5');
  assert.deepEqual(routed, ['over', 'under']);

  assert.deepEqual(
    emitAll(markets, [
      { name: 'Gazde (Goluri)', is_home: true },
      { name: 'Oaspeți (Goluri)', is_home: false },
    ]),
    [],
    'a table is not a fixture and must not be published as one',
  );
});

test('the role-word guard is anchored: a club whose name merely starts with one survives', () => {
  // Home United is a real club (Nakasi, Fiji). A false positive here deletes a
  // fixture outright, and deleting fixtures is the expensive direction, so the
  // list is anchored to the whole name instead of "starts with a role word".
  const event = extract([
    rawMarket('default', 'Rezultat Final', 5498, [
      { kind: 'W1', name: '1', fullname: 'Home United', odds: 2.4 },
      { kind: 'X', name: 'X', fullname: 'X', odds: 3.3 },
      { kind: 'W2', name: '2', fullname: 'Rewa', odds: 2.9 },
    ]),
  ], [
    { name: 'Home United', is_home: true },
    { name: 'Rewa', is_home: false },
  ]);
  assert.deepEqual(contractOf(event, 'default').routed, ['home', 'draw', 'away']);
});

test('a bare "Home" / "Away" column pair is caught too, in either slot', () => {
  // The bare headers a matchday board writes, with and without the
  // parenthetical, and with the home column in either position — the guard
  // tests both competitors, so order cannot smuggle one through.
  const markets = [
    rawMarket('total_goals', 'Total Goluri', 5500, [
      { kind: 'Over', name: 'Peste (29.5)', odds: 1.4, handicap: 29.5, handicap_abs: 29.5 },
      { kind: 'Under', name: 'Sub (29.5)', odds: 2.7, handicap: 29.5, handicap_abs: 29.5 },
    ], { handicap: 29.5 }),
  ];
  for (const pair of [
    [{ name: 'Home', is_home: true }, { name: 'Away', is_home: false }],
    [{ name: 'Gazde', is_home: true }, { name: 'Oaspeti', is_home: false }],
    [{ name: 'Real Madrid', is_home: true }, { name: 'Away', is_home: false }],
  ]) {
    assert.deepEqual(
      emitAll(markets, pair),
      [],
      `a role name in either slot must be refused: ${pair.map((c) => c.name).join(' v ')}`,
    );
  }
});

test('an unknown outcome kind falls back to the display name instead of dropping the market', () => {
  const event = extract([
    rawMarket('mystery_market', 'Ceva Nou', 9999, [
      { kind: undefined, name: 'Albastru', odds: 1.8 },
      { kind: undefined, name: 'Rosu', odds: 2.1 },
    ]),
  ]);
  const { market } = contractOf(event, 'mystery_market');
  assert.deepEqual(market.selections.map((s) => s.name), ['Albastru', 'Rosu']);
});

test('the settlement window is fulltime, and a named window is read from the name', () => {
  const event = extract([
    rawMarket('default', 'Rezultat Final', 5498, [
      { kind: 'W1', name: '1', fullname: 'Boston Celtics', odds: 1.85 },
      { kind: 'W2', name: '2', fullname: 'Detroit Pistons', odds: 1.95 },
    ]),
  ]);
  assert.equal(event.markets[0].period, 'fulltime');
});

test('total_points attaches subject points and resolves to OVER_UNDER points contract', () => {
  const event = extract([
    rawMarket('total_points', 'Total Puncte', 5501, [
      { kind: 'Over', name: 'Peste (215.5)', odds: 1.88, handicap: 215.5, handicap_abs: 215.5 },
      { kind: 'Under', name: 'Sub (215.5)', odds: 1.92, handicap: 215.5, handicap_abs: 215.5 },
    ], { handicap: 215.5 }),
  ]);
  const market = event.markets.find((m) => m.key === 'total_points');
  assert.ok(market);
  assert.equal(market.subject, 'points');
  const contract = resolveContract(market, { sport: 'Basketball' });
  assert.ok(contract);
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.subject, 'points');
  assert.equal(contract.lineKey, '215.5');
});

test('total_games attaches subject games and resolves to OVER_UNDER games contract', () => {
  const scraper = new NetBetScraper({ maxEvents: 10 });
  scraper.observedAt = '2026-09-29T12:33:00.000Z';
  const tennisMarket = rawMarket('total_games', 'Total Game-uri', 5502, [
    { kind: 'Over', name: 'Peste (22.5)', odds: 1.80, handicap: 22.5, handicap_abs: 22.5 },
    { kind: 'Under', name: 'Sub (22.5)', odds: 2.05, handicap: 22.5, handicap_abs: 22.5 },
  ], { handicap: 22.5 });
  const rawEvents = scraper.normalize({
    tree: [{
      name: 'Tenis',
      competitions: [{
        name: 'ATP',
        events: [{
          id: 900002,
          is_live: false,
          is_suspended: false,
          starts_at: FUTURE,
          competition_name: 'ATP',
          competitors: [
            { name: 'Jannik Sinner', is_home: true },
            { name: 'Carlos Alcaraz', is_home: false },
          ],
          markets: [tennisMarket],
        }],
      }],
    }],
  });
  const events = scraper.extractEvents(rawEvents);
  assert.equal(events.length, 1);
  const market = events[0].markets.find((m) => m.key === 'total_games');
  assert.ok(market);
  assert.equal(market.subject, 'games');
  const contract = resolveContract(market, { sport: 'Tennis' });
  assert.ok(contract);
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.subject, 'games');
  assert.equal(contract.lineKey, '22.5');
});

test('includeLive: true admits live matches and stamps markets with live: true', () => {
  const liveMarket = rawMarket('default', 'Rezultat Final', 5498, [
    { kind: 'W1', name: '1', fullname: 'Arsenal', odds: 1.85 },
    { kind: 'X', name: 'X', fullname: 'Egal', odds: 3.40 },
    { kind: 'W2', name: '2', fullname: 'Chelsea', odds: 3.50 },
  ]);
  const liveEventRaw = {
    id: 900003,
    is_live: true,
    is_suspended: false,
    starts_at: FUTURE,
    competition_name: 'Premier League',
    competitors: [
      { name: 'Arsenal', is_home: true },
      { name: 'Chelsea', is_home: false },
    ],
    markets: [liveMarket],
  };

  const defaultScraper = new NetBetScraper({ includeLive: false });
  const norm1 = defaultScraper.normalize({
    tree: [{ name: 'Fotbal', competitions: [{ name: 'Premier League', events: [liveEventRaw] }] }],
  });
  assert.equal(defaultScraper.extractEvents(norm1).length, 0, 'live match dropped by default');

  const liveScraper = new NetBetScraper({ includeLive: true });
  const norm2 = liveScraper.normalize({
    tree: [{ name: 'Fotbal', competitions: [{ name: 'Premier League', events: [liveEventRaw] }] }],
  });
  const liveExtracted = liveScraper.extractEvents(norm2);
  assert.equal(liveExtracted.length, 1, 'live match admitted when includeLive is true');
  assert.equal(liveExtracted[0].live, true);
  assert.equal(liveExtracted[0].isLive, true);
  assert.equal(liveExtracted[0].markets[0].live, true, 'markets stamped with live: true');
});

test('NetBet: sub-window markets extract quarter and set periods with bucket isolation', () => {
  const basketballQ1Market = rawMarket('total_points', 'Total Puncte Primul Sfert', 5501, [
    { kind: 'Over', name: 'Peste (52.5)', odds: 1.85, handicap: 52.5, handicap_abs: 52.5 },
    { kind: 'Under', name: 'Sub (52.5)', odds: 1.95, handicap: 52.5, handicap_abs: 52.5 },
  ]);

  const ftPointsMarket = rawMarket('total_points', 'Total Puncte', 5501, [
    { kind: 'Over', name: 'Peste (215.5)', odds: 1.90, handicap: 215.5, handicap_abs: 215.5 },
    { kind: 'Under', name: 'Sub (215.5)', odds: 1.90, handicap: 215.5, handicap_abs: 215.5 },
  ]);

  const event = extract([basketballQ1Market, ftPointsMarket]);
  assert.equal(event.markets.length, 2);

  const q1 = event.markets.find((m) => m.period === 'q1');
  const ft = event.markets.find((m) => m.period === 'fulltime');
  assert.ok(q1, 'Primul sfert extracts with period q1');
  assert.ok(ft, 'Total puncte extracts with period fulltime');

  const cQ1 = resolveContract(q1);
  const cFt = resolveContract(ft);
  assert.ok(cQ1 && cFt);
  assert.equal(cQ1.period, 'q1');
  assert.equal(cFt.period, 'fulltime');

  const bQ1 = bucketKeyForContract(event.eventKey, cQ1);
  const bFt = bucketKeyForContract(event.eventKey, cFt);
  assert.notEqual(bQ1, bFt);
  assert.ok(bQ1.includes('::q1::'));
  assert.ok(bFt.includes('::fulltime::'));
});

test('NetBet: basketball dynamic quarters Q1-Q4 and tennis sets S1-S3 resolve to isolated buckets', () => {
  const q2Win = rawMarket('quarter_winner', 'Castigator Sfertul 2', 5498, [
    { kind: 'W1', name: '1', fullname: 'Boston Celtics', odds: 1.80 },
    { kind: 'W2', name: '2', fullname: 'Detroit Pistons', odds: 2.05 },
  ]);

  const q3Tot = rawMarket('total_points', 'Total Puncte Sfertul 3', 5501, [
    { kind: 'Over', name: 'Peste (54.5)', odds: 1.88, handicap: 54.5, handicap_abs: 54.5 },
    { kind: 'Under', name: 'Sub (54.5)', odds: 1.92, handicap: 54.5, handicap_abs: 54.5 },
  ]);

  const q4Tot = rawMarket('quarter_4_total', 'Total Puncte', 5501, [
    { kind: 'Over', name: 'Peste (51.5)', odds: 1.90, handicap: 51.5, handicap_abs: 51.5 },
    { kind: 'Under', name: 'Sub (51.5)', odds: 1.90, handicap: 51.5, handicap_abs: 51.5 },
  ]);

  const bballEvent = extract([q2Win, q3Tot, q4Tot]);
  assert.equal(bballEvent.markets.length, 3);

  const mQ2 = bballEvent.markets.find((m) => m.period === 'q2');
  const mQ3 = bballEvent.markets.find((m) => m.period === 'q3');
  const mQ4 = bballEvent.markets.find((m) => m.period === 'q4');
  assert.ok(mQ2 && mQ3 && mQ4);

  const cQ2 = resolveContract(mQ2, { sport: 'Basketball' });
  const cQ3 = resolveContract(mQ3, { sport: 'Basketball' });
  const cQ4 = resolveContract(mQ4, { sport: 'Basketball' });

  assert.equal(cQ2.family, 'MATCH_ODDS');
  assert.equal(cQ2.period, 'q2');

  assert.equal(cQ3.family, 'OVER_UNDER');
  assert.equal(cQ3.period, 'q3');
  assert.equal(cQ3.subject, 'points');
  assert.equal(cQ3.lineKey, '54.5');

  assert.equal(cQ4.family, 'OVER_UNDER');
  assert.equal(cQ4.period, 'q4');
  assert.equal(cQ4.subject, 'points');
  assert.equal(cQ4.lineKey, '51.5');

  const bKeyQ2 = bucketKeyForContract(bballEvent.eventKey, cQ2);
  const bKeyQ3 = bucketKeyForContract(bballEvent.eventKey, cQ3);
  const bKeyQ4 = bucketKeyForContract(bballEvent.eventKey, cQ4);

  assert.notEqual(bKeyQ2, bKeyQ3);
  assert.notEqual(bKeyQ3, bKeyQ4);
  assert.ok(bKeyQ2.includes('::q2::'));
  assert.ok(bKeyQ3.includes('::q3::'));
  assert.ok(bKeyQ4.includes('::q4::'));

  // Tennis sets
  const s1Win = rawMarket('set_winner', 'Castigator Primul Set', 5498, [
    { kind: 'W1', name: '1', fullname: 'Carlos Alcaraz', odds: 1.75 },
    { kind: 'W2', name: '2', fullname: 'Jannik Sinner', odds: 2.10 },
  ]);

  const s2Tot = rawMarket('set_2_total_games', 'Total Game-uri', 5502, [
    { kind: 'Over', name: 'Peste (9.5)', odds: 1.85, handicap: 9.5, handicap_abs: 9.5 },
    { kind: 'Under', name: 'Sub (9.5)', odds: 1.95, handicap: 9.5, handicap_abs: 9.5 },
  ]);

  const scraper = new NetBetScraper({ maxEvents: 10 });
  scraper.observedAt = '2026-09-29T12:33:00.000Z';
  const rawTennis = scraper.normalize({
    tree: [{
      name: 'Tenis',
      competitions: [{
        name: 'ATP',
        events: [{
          id: 900004,
          is_live: false,
          is_suspended: false,
          starts_at: FUTURE,
          competition_name: 'ATP',
          competitors: [
            { name: 'Carlos Alcaraz', is_home: true },
            { name: 'Jannik Sinner', is_home: false },
          ],
          markets: [s1Win, s2Tot],
        }],
      }],
    }],
  });

  const [tennisEvent] = scraper.extractEvents(rawTennis);
  assert.ok(tennisEvent);
  assert.equal(tennisEvent.markets.length, 2);

  const mS1 = tennisEvent.markets.find((m) => m.period === 'set1');
  const mS2 = tennisEvent.markets.find((m) => m.period === 'set2');
  assert.ok(mS1 && mS2);

  const cS1 = resolveContract(mS1, { sport: 'Tennis' });
  const cS2 = resolveContract(mS2, { sport: 'Tennis' });

  assert.equal(cS1.family, 'MATCH_ODDS');
  assert.equal(cS1.period, 'set1');

  assert.equal(cS2.family, 'OVER_UNDER');
  assert.equal(cS2.period, 'set2');
  assert.equal(cS2.subject, 'games');
  assert.equal(cS2.lineKey, '9.5');

  const bKeyS1 = bucketKeyForContract(tennisEvent.eventKey, cS1);
  const bKeyS2 = bucketKeyForContract(tennisEvent.eventKey, cS2);
  assert.notEqual(bKeyS1, bKeyS2);
  assert.ok(bKeyS1.includes('::set1::'));
  assert.ok(bKeyS2.includes('::set2::'));
});

test('NetBet: football sub-window derivatives (half1, half2) isolate from full-time markets', () => {
  const h1_1x2 = rawMarket('1st_half_1x2', '1X2 Prima Repriza', 5498, [
    { kind: 'W1', name: '1', fullname: 'Arsenal', odds: 2.25 },
    { kind: 'X', name: 'X', fullname: 'Egal', odds: 2.20 },
    { kind: 'W2', name: '2', fullname: 'Chelsea', odds: 3.90 },
  ]);

  const h2_tot = rawMarket('total_goals', 'Total Goluri A Doua Repriza', 5500, [
    { kind: 'Over', name: 'Peste (1.5)', odds: 2.05, handicap: 1.5, handicap_abs: 1.5 },
    { kind: 'Under', name: 'Sub (1.5)', odds: 1.75, handicap: 1.5, handicap_abs: 1.5 },
  ]);

  const h1_btts = rawMarket('btts', 'Ambele Marcheaza Prima Repriza', 5508, [
    { kind: 'Yes', name: 'Da', odds: 4.10 },
    { kind: 'No', name: 'Nu', odds: 1.22 },
  ]);

  const h2_dc = rawMarket('double_chance', 'Sansa Dubla A Doua Repriza', 5503, [
    { kind: '1X', name: '1X', odds: 1.35 },
    { kind: '12', name: '12', odds: 1.45 },
    { kind: 'X2', name: 'X2', odds: 1.60 },
  ]);

  const event = extract([h1_1x2, h2_tot, h1_btts, h2_dc], [
    { name: 'Arsenal', is_home: true },
    { name: 'Chelsea', is_home: false },
  ]);

  assert.equal(event.markets.length, 4);

  const mH1_1x2 = event.markets.find((m) => m.key === '1st_half_1x2');
  const mH2_tot = event.markets.find((m) => m.key === 'total_goals');
  const mH1_btts = event.markets.find((m) => m.key === 'btts');
  const mH2_dc = event.markets.find((m) => m.key === 'double_chance');

  assert.ok(mH1_1x2 && mH2_tot && mH1_btts && mH2_dc);

  const cH1_1x2 = resolveContract(mH1_1x2);
  const cH2_tot = resolveContract(mH2_tot);
  const cH1_btts = resolveContract(mH1_btts);
  const cH2_dc = resolveContract(mH2_dc);

  assert.equal(cH1_1x2.family, 'MATCH_ODDS');
  assert.equal(cH1_1x2.period, 'half1');

  assert.equal(cH2_tot.family, 'OVER_UNDER');
  assert.equal(cH2_tot.period, 'half2');
  assert.equal(cH2_tot.lineKey, '1.5');

  assert.equal(cH1_btts.family, 'BTTS');
  assert.equal(cH1_btts.period, 'half1');

  assert.equal(cH2_dc.family, 'DOUBLE_CHANCE');
  assert.equal(cH2_dc.period, 'half2');

  const bH1_1x2 = bucketKeyForContract(event.eventKey, cH1_1x2);
  const bH2_tot = bucketKeyForContract(event.eventKey, cH2_tot);
  const bH1_btts = bucketKeyForContract(event.eventKey, cH1_btts);
  const bH2_dc = bucketKeyForContract(event.eventKey, cH2_dc);

  assert.ok(bH1_1x2.includes('::half1::'));
  assert.ok(bH2_tot.includes('::half2::'));
  assert.ok(bH1_btts.includes('::half1::'));
  assert.ok(bH2_dc.includes('::half2::'));
});

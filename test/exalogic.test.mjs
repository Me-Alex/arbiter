import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import ExcelBet from '../src/scrapers/excelbet.mjs';
import WinBoss from '../src/scrapers/winboss.mjs';
import LasVegas from '../src/scrapers/las-vegas.mjs';
import MagnumBet from '../src/scrapers/magnumbet.mjs';
import { resolveContract, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';
import { groupByEvent, findArbitrage } from '../src/scanner/engine.mjs';

/**
 * The four Exalogic tenants share one adapter shape and one feed, differing
 * only in host and systemCode.
 *
 * They are siblings, not copies: the constructor assigns what `fetchRaw`
 * reads, and a sibling that skipped an assignment compiled fine, passed the
 * whole unit suite, and then requested
 * `undefined/getPalinsestoDelGiorno?systemCode=undefined` forever. It reported
 * "all day fetches returned 0 events" — a clean, empty, entirely wrong run.
 * That is what these assertions exist to prevent.
 */

const TENANTS = [
  { name: 'excelbet', Cls: ExcelBet, host: /excelbet/i, code: 'EXCELBET' },
  { name: 'winboss', Cls: WinBoss, host: /winboss/i, code: 'WINBOSS' },
  { name: 'las-vegas', Cls: LasVegas, host: /lasvegas/i, code: 'LASVEGAS' },
  { name: 'magnumbet', Cls: MagnumBet, host: /magnumbet/i, code: 'MAGNUMBET' },
];

for (const { name, Cls, host, code } of TENANTS) {
  test(`${name} is configured with the endpoint its fetch actually calls`, () => {
    const s = new Cls({ maxEvents: 10 });
    // Anything undefined here produces a request to a URL built from
    // "undefined", which resolves nowhere and yields an empty day.
    assert.ok(s.apiBase, `${name}: apiBase must be assigned`);
    assert.ok(s.systemCode, `${name}: systemCode must be assigned`);
    assert.match(s.apiBase, host, `${name}: apiBase should point at this tenant's host`);
    assert.equal(s.systemCode, code);
    assert.ok(!s.apiBase.includes('undefined'), `${name}: apiBase must not contain "undefined"`);
    assert.ok(!String(s.systemCode).includes('undefined'), `${name}: systemCode must not contain "undefined"`);
  });

  test(`${name} is configured with the values its fetch loop reads`, () => {
    const s = new Cls({ maxEvents: 10 });
    // `Array.from({ length: this.days })` with an undefined days produces a
    // zero-length array: no request is made at all, and the run reports zero
    // events without an error.
    assert.ok(Number.isInteger(s.days), `${name}: days must be a whole number`);
    assert.ok(s.days >= 1 && s.days <= 31, `${name}: days out of range`);
    assert.ok(Number.isFinite(s.timeoutMs) && s.timeoutMs > 0, `${name}: timeoutMs must be a positive number`);
  });

  test(`${name} rejects a nonsense window rather than silently fetching nothing`, () => {
    assert.throws(() => new Cls({ days: 0 }), /invalid days/, `${name}: days=0 must be rejected`);
    assert.throws(() => new Cls({ days: 99 }), /invalid days/, `${name}: days=99 must be rejected`);
  });

  test(`${name} treats a non-2xx response as a failure, not an empty day`, () => {
    // Returning [] on an HTTP error made a 500 on today plus an empty 200 on
    // tomorrow indistinguishable from a complete, quiet run.
    const source = Cls.prototype.fetchRaw.toString();
    assert.doesNotMatch(source, /!\s*response\.ok\s*\)\s*return\s*\[\]/,
      `${name}: must not swallow an HTTP error as an empty day`);
    assert.match(source, /UpstreamError/, `${name}: must raise on a non-2xx response`);
  });
}

test('MagnumBet inherits the adapter but not the parent identity', () => {
  const s = new MagnumBet({ maxEvents: 10 });
  assert.equal(s.id, 'magnumbet');
  assert.deepEqual(s.sourceIds, ['magnumbet']);
  assert.equal(s.systemCode, 'MAGNUMBET', 'it overrides the system code');
  assert.notEqual(s.systemCode, new ExcelBet({}).systemCode);
});

test('WinBoss and Las Vegas inherit the adapter, not a copy of it', () => {
  // Both used to be near-verbatim copies of excelbet.mjs. A copy fixes bugs
  // only if someone remembers to fix it in every copy, and the WinBoss copy's
  // content-type error still said "ExcelBet". Assert on the shared prototype so
  // a future divergence is a test failure rather than silent drift.
  for (const Cls of [WinBoss, LasVegas, MagnumBet]) {
    assert.equal(Cls.prototype.fetchRaw, ExcelBet.prototype.fetchRaw,
      `${Cls.name} must share the one fetchRaw implementation`);
    assert.equal(Cls.prototype.extractEvents, ExcelBet.prototype.extractEvents,
      `${Cls.name} must share the one extractEvents implementation`);
  }
  assert.notEqual(new WinBoss({}).systemCode, new LasVegas({}).systemCode);
  assert.match(new WinBoss({}).name, /WinBoss/i);
  assert.match(new LasVegas({}).name, /Las Vegas/i);
});

test('every Exalogic tenant publishes under its own sourceId, not the parent\'s', () => {
  // The misattribution this guards: extractEvents is shared, so a literal
  // sourceId would file MagnumBet/WinBoss/LasVegas prices under 'excelbet'
  // and make one feed look like four independent books.
  const raw = {
    avs: {
      avs: [{
        lv: 0, bid: 9001, ts: '20261015 16:45:00',
        dsl: { RO: 'Gazogene - Rangers' }, p: 'Liga 1',
        scs: [{ cs: 3, d: 'FINAL', eqs: [{ ce: 1, q: '315' }, { ce: 2, q: '457' }, { ce: 3, q: '149' }] }],
      }],
    },
  };
  const seen = new Set();
  for (const { name, Cls } of TENANTS) {
    const s = new Cls({ maxEvents: 10 });
    const [event] = s.extractEvents(s.normalize(raw));
    assert.ok(event, `${name}: must extract the fixture event`);
    assert.equal(event.sourceId, name, `${name}: must publish as "${name}", not "${event.sourceId}"`);
    assert.equal(event.transport, 'exalogic-xsport-public-json');
    // Four-decimal prices must survive q/100 exactly.
    assert.equal(event.markets[0].selections[0].odds, 3.15);
    seen.add(event.sourceId);
  }
  assert.equal(seen.size, 4, 'four tenants must produce four distinct sourceIds');
});

/**
 * The goals total and the goals handicap, on rows the feed actually published.
 *
 * `test/fixtures/excelbet-markets.json` is a capture, not a sketch: two
 * fixtures, every market each of them served, the `h` values and the `q/100`
 * prices exactly as the feed wrote them, taken 2026-09-29. Nothing was
 * rewritten — the adapter applies no date window, it only parses `ts`, so the
 * rows stay as they arrived and the test does not rot the way a fixture whose
 * kickoff has since passed would.
 *
 * These run on all four tenants. The reader is shared, so a green run on
 * excelbet alone would prove the mapping and nothing about the catalogue, and
 * a per-tenant regression is exactly what a single-tenant test cannot see.
 */
const MARKETS_FIXTURE = JSON.parse(await readFile(new URL('./fixtures/excelbet-markets.json', import.meta.url), 'utf8'));
const [PETERBOROUGH] = MARKETS_FIXTURE.avs.avs;

for (const { name, Cls } of TENANTS) {
  test(`${name} publishes every goals total, one market per line`, () => {
    const s = new Cls({ maxEvents: 100 });
    const events = s.extractEvents(s.normalize(MARKETS_FIXTURE));
    assert.equal(events.length, 2, `${name}: both fixture events`);

    // Peterborough carries thresholds 0.5 through 4.5, Real Bedford 1.5 through
    // 5.5 — five markets each, and the two boards do not share a single line.
    const peterborough = events[0].markets.filter((m) => m.key === 'TOTAL_GOALS');
    const bedford = events[1].markets.filter((m) => m.key === 'TOTAL_GOALS');
    assert.deepEqual(peterborough.map((m) => m.line), [0.5, 1.5, 2.5, 3.5, 4.5]);
    assert.deepEqual(bedford.map((m) => m.line), [1.5, 2.5, 3.5, 4.5, 5.5]);

    // The 0.5 line, verbatim: Over 9.40 / Under 1.03. A threshold that low is
    // almost certain to go under, and the price says so.
    const lowest = peterborough[0];
    assert.equal(lowest.providerMarketId, '7989:50');
    assert.equal(lowest.name, 'TOTAL GOALS');
    assert.equal(lowest.period, 'fulltime');
    assert.deepEqual(lowest.selections.map((x) => x.name), ['Over 0.5', 'Under 0.5']);
    assert.deepEqual(lowest.selections.map((x) => x.odds), [9.4, 1.03]);

    // And the highest, on the other event: Over 5.5 at 1.11 against Under 5.5
    // at 5.40. Both legs are priced, so both are real.
    const highest = bedford[bedford.length - 1];
    assert.equal(highest.providerMarketId, '7989:550');
    assert.deepEqual(highest.selections.map((x) => x.name), ['Over 5.5', 'Under 5.5']);
    assert.deepEqual(highest.selections.map((x) => x.odds), [1.11, 5.4]);
  });

  test(`${name} publishes every goals handicap, one market per line`, () => {
    const s = new Cls({ maxEvents: 100 });
    const events = s.extractEvents(s.normalize(MARKETS_FIXTURE));
    const peterborough = events[0].markets.filter((m) => m.key === 'ASIAN_HANDICAP');
    const bedford = events[1].markets.filter((m) => m.key === 'ASIAN_HANDICAP');
    // Sorted for comparison only: the adapter publishes the lines in the order
    // the feed listed them, and Real Bedford arrives as -150, -50, -250. Order
    // carries no meaning — the lineKey is what two books are matched on — so
    // the assertion is about the set of lines, not their sequence.
    assert.deepEqual(peterborough.map((m) => m.line).sort((a, b) => a - b), [-1.5, -0.5, 0.5]);
    assert.deepEqual(bedford.map((m) => m.line).sort((a, b) => a - b), [-2.5, -1.5, -0.5]);
    assert.deepEqual(bedford.map((m) => m.line), [-1.5, -0.5, -2.5], 'the feed\'s own order is preserved');
    for (const m of [...peterborough, ...bedford]) {
      assert.equal(m.period, 'fulltime', `${name}: ${m.providerMarketId} must be full-time`);
      assert.equal(m.selections.length, 2, `${name}: ${m.providerMarketId} must be two-legged`);
      // The two legs are exact negations, which is what the router's spread
      // branch requires; anything else resolves as a goals total instead.
      const lines = m.selections.map((x) => Number(x.name.match(/\(([-+][\d.]+)\)/)[1]));
      assert.equal(lines[0], -lines[1], `${name}: ${m.providerMarketId} legs must negate`);
    }
  });

  test(`${name} reads the handicap sign as the line, never as the side`, () => {
    // The trap this guards is visible in one fixture event. The same outcome
    // code `ce=1` is the home leg at h=-50 and again at h=+50; what changes is
    // the line, not the side. Reading the sign as the side would file the
    // home +0.5 market as "away -0.5" and mirror the fixture.
    const s = new Cls({ maxEvents: 100 });
    const [peterborough] = s.extractEvents(s.normalize(MARKETS_FIXTURE));
    const byLine = new Map(peterborough.markets.filter((m) => m.key === 'ASIAN_HANDICAP').map((m) => [m.line, m]));
    assert.deepEqual(byLine.get(-0.5).selections.map((x) => [x.name, x.odds]), [['1 (-0.5)', 1.96], ['2 (+0.5)', 1.67]]);
    assert.deepEqual(byLine.get(0.5).selections.map((x) => [x.name, x.odds]), [['1 (+0.5)', 1.31], ['2 (-0.5)', 2.85]]);
    // Both carry the home side on the "1" leg, so both are priced the same way
    // round. The h=-50 prices are the feed's own: 1.96 against 1.67 with the
    // 1X2 at 2.03 / 3.55 / 3.10, so home -0.5 is close to a coin flip on a
    // side that wins about 45% of the time. Reading the sign as the side would
    // have swapped these and still produced a plausible-looking pair.
    assert.equal(byLine.get(-0.5).selections[0].odds, 1.96);
    assert.equal(byLine.get(-0.5).selections[1].odds, 1.67);
  });

  test(`${name} refuses the whole-line spread instead of publishing it as a result`, () => {
    // cs=8 is a three-way result at a whole line, 1,993 rows on the live feed.
    // A level result pushes all three legs, so it is not an exhaustive
    // contract; and with no line of its own it would land in MATCH_ODDS::_ and
    // pair with this same fixture's plain 1X2. The fixture event carries three
    // of them, so this is a live regression, not a hypothetical.
    const s = new Cls({ maxEvents: 100 });
    const published = s.extractEvents(s.normalize(MARKETS_FIXTURE))
      .flatMap((e) => e.markets)
      .filter((m) => m.providerMarketId?.startsWith('8:'));
    assert.deepEqual(published, [], `${name}: the whole-line spread must not be published`);
    const wholeLineRows = PETERBOROUGH.scs.filter((sc) => sc.cs === 8);
    assert.equal(wholeLineRows.length, 3, 'the fixture does carry whole-line spread rows');
  });

  test(`${name} refuses the double chance codes`, () => {
    // Three markets with identical descriptions and the same ce 1/2 pair: the
    // payload cannot say which pair each one is. Mapped to the result market's
    // labels they would price a 1X leg as a full-time leg.
    const s = new Cls({ maxEvents: 100 });
    const events = s.extractEvents(s.normalize(MARKETS_FIXTURE));
    const dcRows = PETERBOROUGH.scs.filter((sc) => [15, 16, 17].includes(sc.cs));
    assert.equal(dcRows.length, 3, 'the fixture does carry three double chance rows');
    for (const e of events) {
      assert.equal(e.markets.length, 9, `${name}: 1 result + 5 totals + 3 handicaps, nothing else`);
    }
  });

  test(`${name} drops a market whose legs cannot be trusted`, () => {
    // Seven ways a leg is unusable, each of which would otherwise publish a
    // two-sided contract that is not one. The event is otherwise complete, so
    // a silent drop shows up as a missing market rather than a missing event.
    const broken = [
      { why: 'an outcome code the market does not have', sc: { cs: 7989, h: 50, eqs: [{ ce: 1, q: '200' }, { ce: 7, q: '150' }] } },
      { why: 'a repeated outcome code', sc: { cs: 7989, h: 50, eqs: [{ ce: 1, q: '200' }, { ce: 1, q: '150' }] } },
      { why: 'a missing leg', sc: { cs: 7989, h: 50, eqs: [{ ce: 1, q: '200' }] } },
      { why: 'a price at or below 1', sc: { cs: 7989, h: 50, eqs: [{ ce: 1, q: '200' }, { ce: 2, q: '100' }] } },
      { why: 'no line at all', sc: { cs: 7989, eqs: [{ ce: 1, q: '200' }, { ce: 2, q: '150' }] } },
      { why: 'a whole line, which pushes on a level result', sc: { cs: 7989, h: 200, eqs: [{ ce: 1, q: '200' }, { ce: 2, q: '150' }] } },
      { why: 'a quarter line, which pushes half', sc: { cs: 7989, h: 225, eqs: [{ ce: 1, q: '200' }, { ce: 2, q: '150' }] } },
    ];
    for (const { why, sc } of broken) {
      const s = new Cls({ maxEvents: 10 });
      const raw = { avs: { avs: [{ lv: 0, bid: 9002, ts: '20261015 16:45:00', dsl: { RO: 'Gazogene - Rangers' }, p: 'Liga 1', scs: [sc, { cs: 3, d: 'FINAL', eqs: [{ ce: 1, q: '315' }, { ce: 2, q: '457' }, { ce: 3, q: '149' }] }] }] } };
      const [event] = s.extractEvents(s.normalize(raw));
      assert.equal(event.markets.length, 1, `${name}: a total with ${why} must be dropped`);
      assert.equal(event.markets[0].key, '1x2', `${name}: only the result market may survive`);
    }
    // The same refusals on the handicap, including a negative whole line: the
    // half-line guard has to work on the negative side, where JavaScript's %
    // keeps the sign of the dividend and `-150 % 100` is -50, not 50.
    for (const h of [-100, -200, 100, 25, -25, 75, null, undefined]) {
      const s = new Cls({ maxEvents: 10 });
      const raw = { avs: { avs: [{ lv: 0, bid: 9003, ts: '20261015 16:45:00', dsl: { RO: 'Gazogene - Rangers' }, p: 'Liga 1', scs: [{ cs: 60016, h, eqs: [{ ce: 1, q: '200' }, { ce: 2, q: '150' }] }, { cs: 3, d: 'FINAL', eqs: [{ ce: 1, q: '315' }, { ce: 2, q: '457' }, { ce: 3, q: '149' }] }] }] } };
      const [event] = s.extractEvents(s.normalize(raw));
      assert.equal(event.markets.length, 1, `${name}: a handicap at h=${h} must be dropped`);
    }
  });

  test(`${name} records which market categories it read`, () => {
    // A category that quietly stops answering leaves a board that looks
    // complete and is not, so the run record names the categories and any
    // that failed instead of only reporting how many events came back.
    const s = new Cls({ maxEvents: 10 });
    s.aggregateFailures = ['aggregate 9: HTTP 500 for 20260929 aggregate 9'];
    const coverage = s._serializable([], { avs: { avs: [] } }).coverage;
    assert.equal(coverage.market, 'fulltime-1x2+tgoals+asian_handicap');
    assert.equal(coverage.aggregates, '1,8,9');
    assert.deepEqual(coverage.aggregateFailures, ['aggregate 9: HTTP 500 for 20260929 aggregate 9']);
  });
}

/**
 * The router's verdict, not a re-derivation of it: every market the adapter
 * publishes must resolve to the contract the adapter claims, on a distinct
 * lineKey, and one book's own rows must never produce an arbitrage.
 */
test('every published Exalogic market resolves through the engine, on its own line', () => {
  const s = new ExcelBet({ maxEvents: 100 });
  const events = s.extractEvents(s.normalize(MARKETS_FIXTURE));
  const buckets = new Map();
  for (const e of events) {
    for (const m of e.markets) {
      const contract = resolveContract(m);
      assert.ok(contract, `${e.homeTeam}: ${m.providerMarketId || m.key} must resolve to a contract`);
      assert.equal(contract.arbEligible, undefined, `${m.providerMarketId || m.key} must be arbitrable`);
      const key = bucketKeyForContract(e.eventKey, contract);
      assert.ok(!buckets.has(key), `${key} holds two markets from one event — lines are being merged`);
      buckets.set(key, m);
    }
  }
  // 2 results + 10 totals + 6 handicaps, each in its own bucket.
  assert.equal(buckets.size, 18);
  const families = new Map();
  for (const c of events.flatMap((e) => e.markets).map((m) => resolveContract(m))) {
    families.set(c.family, (families.get(c.family) || 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...families].sort()), { ASIAN_HANDICAP: 6, MATCH_ODDS: 2, OVER_UNDER: 10 });

  // One book cannot arbitrage against itself, on any of these contracts.
  const found = findArbitrage(groupByEvent(events), {});
  assert.deepEqual(found, [], 'a single book must never find an arbitrage against its own rows');
});

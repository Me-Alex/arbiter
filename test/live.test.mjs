import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  fegMarketIsLive, unibetEventIsLive, superbetEventIsLive, digitainEventIsLive,
  markMarketsLive, eventIsLive, liveCoverageFor, LIVE_EVIDENCE,
} from '../src/scrapers/live-status.mjs';
import { groupByEvent, findArbitrage, findMiddles, findPositiveEV, buildSelectionIndex } from '../src/scanner/engine.mjs';
import { scanWorkspace } from '../src/scanner/scanner.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';
import Fortuna from '../src/scrapers/fortuna.mjs';
import Unibet from '../src/scrapers/unibet.mjs';
import Superbet from '../src/scrapers/superbet.mjs';
import Winner from '../src/scrapers/winner.mjs';
import Egt from '../src/scrapers/egt.mjs';

/**
 * Live (in-play) collection, per bookmaker.
 *
 * The scanner has gated on `event.live` since before any adapter set it, and
 * until `winner` started, the only thing any adapter wrote was a hardcoded
 * `isLive: false` that nothing read — a field that looked like an answer and
 * was not one. These tests pin the three things that had to be built for it to
 * mean anything:
 *
 *   1. the status field is the provider's own, per feed, and fail-closed when
 *      the feed names nothing;
 *   2. a live leg and a pre-match leg can never be paired with each other,
 *      because they are different bets, not two prices for one;
 *   3. a live price only reaches the trader while it is still live — 90 seconds,
 *      after which the snapshot is stale and carries no money guidance.
 *
 * The measurements behind the field names are in src/scrapers/live-status.mjs.
 * Every negative here sits next to a positive control that passes, because a
 * test that cannot fail measures nothing.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Two books from independent feeds, so an arb between them is real. */
const BOOK_A = 'superbet';
const BOOK_B = 'unibet';

const BASE = { sport: 'Football', kickoff: '1970-01-01T00:00:00Z', homeTeam: 'Home', awayTeam: 'Away', league: 'Liga 1' };
const IDENTITY = eventIdentityKey(BASE);

/** A three-way result market, priced so two books together are an arb. */
function resultMarket(odds, { live = false } = {}) {
  return { key: 'MATCH_ODDS', period: 'fulltime', live, selections: [
    { name: '1', odds: odds[0] }, { name: 'X', odds: odds[1] }, { name: '2', odds: odds[2] },
  ] };
}

function bookEvent(sourceId, odds, opts = {}) {
  return {
    ...BASE, sourceId, eventKey: IDENTITY, live: opts.eventLive === true,
    markets: [resultMarket(odds, opts)],
  };
}

// ---------------------------------------------------------------- the fields

test('the FEG market kind is read from the provider, per market', () => {
  assert.equal(fegMarketIsLive({ kind: 'LIVE' }), true);
  assert.equal(fegMarketIsLive({ kind: 'PREMATCH' }), false);
  // A case difference is a different vocabulary, not the same one.
  assert.equal(fegMarketIsLive({ kind: 'live' }), false);
  assert.equal(fegMarketIsLive({}), false, 'a market that names no kind is not live');
  assert.equal(fegMarketIsLive(null), false);
});

test("unibet's contest status is read from the provider, per contest", () => {
  assert.equal(unibetEventIsLive({ status: 'InPlay' }), true);
  assert.equal(unibetEventIsLive({ status: 'PreGame' }), false);
  // Measured 2026-09-29: InPlay against PreGame, and nothing else. A guess
  // that also accepted 'live' or 'started' would be claiming a vocabulary no
  // download was ever shown to publish.
  assert.equal(unibetEventIsLive({ status: 'live' }), false);
  assert.equal(unibetEventIsLive({ status: undefined }), false, 'the default is not a claim');
  assert.equal(unibetEventIsLive(null), false);
});

test("superbet's in-play status is read from the provider's own block", () => {
  assert.equal(superbetEventIsLive({ inplay_stats_metadata: { status: 'NOT_STARTED' } }), false);
  assert.equal(superbetEventIsLive({ inplay_stats_metadata: { status: 'IN_PLAY' } }), true);
  assert.equal(superbetEventIsLive({}), false);
  assert.equal(superbetEventIsLive({ inplay_stats_metadata: { status: 7 } }), false, 'a non-string is not a status');
  assert.equal(superbetEventIsLive(null), false);
});

test("digitain's live clock is read, including the localised label", () => {
  // The label is localised, so a plain `=== 'live'` missed every capitalised
  // variant; the clock is the stronger signal and is accepted on its own.
  assert.equal(digitainEventIsLive({ LiveMatchShortStatus: { 42: 'Live' } }), true);
  assert.equal(digitainEventIsLive({ LiveEventTime: 37 }), true);
  assert.equal(digitainEventIsLive({ IsLiveStarted: true }), true);
  assert.equal(digitainEventIsLive({ LiveEventTime: 0, LiveMatchShortStatus: { 42: 'Finished' } }), false);
  assert.equal(digitainEventIsLive('live'), true);
  assert.equal(digitainEventIsLive('LIVE'), true);
  assert.equal(digitainEventIsLive('Finished'), false);
  assert.equal(digitainEventIsLive(null), false);
});

test('eventIsLive is a strict boolean on both the event and its markets', () => {
  assert.equal(eventIsLive({ live: true }), true);
  assert.equal(eventIsLive({ markets: [{ live: true }] }), true);
  assert.equal(eventIsLive({ markets: [{ live: false }] }), false);
  // The string "true" is what a sloppy adapter would write, and the engine's
  // pairing scope keys on `=== true`. Letting it through here would mark a
  // pre-match book live.
  assert.equal(eventIsLive({ live: 'true' }), false);
  assert.equal(eventIsLive({ markets: [{ live: 'true' }] }), false);
  assert.equal(eventIsLive({}), false);
  assert.equal(eventIsLive(null), false);
});

test('markMarketsLive stamps every market a boolean, so no leg is left behind', () => {
  const markets = [{ id: 'a' }, { id: 'b' }];
  const out = markMarketsLive(markets, (m) => m.id === 'b');
  assert.equal(out, markets, 'it writes in place rather than copying');
  assert.deepEqual(markets.map((m) => m.live), [false, true]);
  // A market the predicate misjudges is the one that pairs wrongly, so the
  // value is coerced rather than passed through.
  assert.equal(markMarketsLive([{}], () => 'yes')[0].live, false);
  assert.deepEqual(markMarketsLive(null, () => true), null);
});

test('the live registry answers for every configured book, and refuses the rest', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config/scrapers.json'), 'utf8'));
  const enabled = cfg.jobs.filter((j) => j.enabled !== false).map((j) => j.id);
  for (const id of enabled) {
    const coverage = liveCoverageFor(id);
    assert.equal(typeof coverage.live, 'boolean', `${id} has a live verdict`);
    assert.equal(typeof coverage.started, 'number', `${id} carries its measurement`);
    assert.ok(Object.hasOwn(LIVE_EVIDENCE, id), `${id} is in the registry, not defaulted`);
  }
  // An unmeasured book is refused, not assumed capable. This is the fail-closed
  // direction: a book nobody measured must not be handed live collection.
  assert.deepEqual(liveCoverageFor('a-book-that-does-not-exist'), { live: false, scope: null, field: null, started: 0 });
  // The three feeds measured publishing in-play football are the ones wired.
  for (const id of ['fortuna', 'casa-pariurilor', 'unibet']) {
    assert.equal(liveCoverageFor(id).live, true, `${id} publishes in-play`);
    assert.ok(liveCoverageFor(id).started > 0, `${id} was actually seen live`);
  }
});

// ------------------------------------------------- live cannot pair with pre

test('a live leg and a pre-match leg never pair, and two live legs still do', () => {
  // An arb: book A prices the result at 3.1, book B at 3.3. Together
  // 1/3.1 + 1/3.1 + 1/3.3 = 0.953 < 1.
  const sameScope = (aOpts, bOpts) => findArbitrage(groupByEvent([
    bookEvent(BOOK_A, [3.1, 3.1, 3.1], aOpts),
    bookEvent(BOOK_B, [3.3, 3.3, 3.3], bOpts),
  ]));

  // The control: both books pre-match, and the arb is there.
  assert.equal(sameScope({}, {}).length, 1, 'two pre-match books still pair');

  // The same two books, one side live. 1/3.1 against 3.3 is not an edge anyone
  // can place: the live leg settles on the score as it stands, the pre-match
  // leg on the final result, so they are not two prices for one bet.
  assert.equal(sameScope({ live: true }, {}).length, 0, 'a live leg must not pair with a pre-match leg');
  assert.equal(sameScope({}, { live: true }).length, 0, 'nor the other way round');

  // And the positive control for the new scope: both live, the arb is back.
  // Without this, "0 pairings" would be satisfied by a key that never matches.
  assert.equal(sameScope({ live: true }, { live: true }).length, 1, 'two live books pair with each other');
});

test("one fixture's own live and pre-match markets never price against each other", () => {
  // Measured 2026-09-29: no started FEG fixture carried both kinds, so this is
  // insurance on how the feed is built rather than a reproduced bug. The FEG
  // `kind` is on the RAW market, so a fixture carrying both is a shape the feed
  // can produce — and one book must never supply the legs of a single "arb".
  //
  // Both books carry the result in both scopes at 3.3, so each scope is a real
  // arbitrage on its own. The count is the discriminator: with the scope in the
  // bucket key there are two opportunities, one per scope; without it the scopes
  // collapse into one bucket and the engine reports a single opportunity whose
  // best legs were picked from both — two different bets priced as one.
  const dual = (sourceId) => ({
    ...BASE, sourceId, eventKey: IDENTITY, live: true,
    markets: [resultMarket([3.3, 3.3, 3.3], { live: true }), resultMarket([3.3, 3.3, 3.3], { live: false })],
  });
  const arbs = findArbitrage(groupByEvent([dual(BOOK_A), dual(BOOK_B)]));
  assert.equal(arbs.length, 2, 'one arbitrage per scope, never one that spans both');
  assert.deepEqual(arbs.map((a) => a.live).sort(), [false, true], 'and both scopes were reported');
  for (const arb of arbs) {
    const scopes = new Set(arb.legs.map((leg) => leg.live));
    assert.equal(scopes.size, 1, `every leg of an opportunity shares one scope, got ${[...scopes]}`);
    assert.equal(arb.live, arb.legs[0].live, 'and the opportunity is labelled with that scope');
    // The engine's real invariant: at least two independent books, so the legs
    // can disagree. One book legitimately supplies two of the three outcomes —
    // that is a real two-sided position, not a defect.
    const books = new Set(arb.legs.map((leg) => leg.sourceId));
    assert.ok(books.size >= 2, `at least two books, got ${[...books]}`);
    assert.deepEqual([...books].sort(), [BOOK_A, BOOK_B].sort(), 'and they are the two independent feeds');
  }
});

test('middles and positive EV isolate live from pre-match too', () => {
  // A middle needs two lines that can disagree, so the books sit on different
  // totals lines. The market key stays `TOTAL` for both on purpose: findMiddles
  // buckets on the key's first two segments while findPositiveEV keys on the
  // whole key, so encoding the line into the key would split the EV consensus
  // instead of sharing it and the control below would pass for the wrong reason.
  const LINE = { [BOOK_A]: 2.5, [BOOK_B]: 3.5 };
  const totalsEvent = (sourceId, over, under, live) => ({
    ...BASE, sourceId, eventKey: IDENTITY,
    markets: [{
      key: 'TOTAL', period: 'fulltime', live,
      selections: [
        { name: 'Over', odds: over, handicap: LINE[sourceId] },
        { name: 'Under', odds: under, handicap: LINE[sourceId] },
      ],
    }],
  });
  // Over 2.5 at A against Under 3.5 at B: 100 at 2.0 and 100 at 2.6, so both
  // sides pay, nothing can lose, and the gap is a real 1.0-goal window.
  const liveA = totalsEvent(BOOK_A, 2.0, 1.9, true);
  const liveB = totalsEvent(BOOK_B, 1.6, 2.6, true);
  const preA = totalsEvent(BOOK_A, 2.0, 1.9, false);
  const preB = totalsEvent(BOOK_B, 1.6, 2.6, false);

  const mixedScope = findMiddles(groupByEvent([liveA, preB]));
  assert.equal(mixedScope.length, 0, 'a live over cannot be a middle against a pre-match under');
  const bothLive = findMiddles(groupByEvent([liveA, liveB]));
  assert.equal(bothLive.length, 1, 'control: the same two books, both live');
  assert.deepEqual(bothLive[0].legs.map((l) => l.handicap).sort((a, b) => a - b), [2.5, 3.5],
    'and the window is the one the two lines describe');
  assert.ok(bothLive[0].legs.every((l) => l.live === true), 'both legs carry the live scope');
  const bothPre = findMiddles(groupByEvent([preA, preB]));
  assert.equal(bothPre.length, 1, 'and both pre-match still middle');
  // The UI can only badged a signal from this field, so a middle that dropped
  // it would render as a pre-match window that expires in seconds.
  assert.equal(bothLive[0].live, true, 'a live middle says so');
  assert.equal(bothPre[0].live, false, 'and a pre-match one does not');

  // Positive EV draws a consensus from the OTHER books' prices. A live price
  // priced against a pre-match consensus is a fabricated edge.
  const evMixed = findPositiveEV(groupByEvent([liveA, preB]));
  assert.equal(evMixed.length, 0, 'a live leg must not borrow a pre-match consensus');
  // Control: in one scope the two books disagree, so both the dearer Over and
  // the dearer Under are above their own consensus.
  const evLive = findPositiveEV(groupByEvent([liveA, liveB]));
  assert.equal(evLive.length, 2, 'control: two live books');
  assert.deepEqual(evLive.map((s) => s.sourceId).sort(), [BOOK_A, BOOK_B].sort(),
    'one signal from each side of the disagreement');
  assert.ok(evLive.every((s) => s.live === true), 'both inherit the live scope of their consensus');
  assert.ok(findPositiveEV(groupByEvent([preA, preB])).every((s) => s.live === false),
    'and a pre-match consensus reports pre-match');
});

test('the verification index separates a live leg from a pre-match one', () => {
  // A re-quote has to find the leg it was priced against. Indexing both scopes
  // under one key would let a live signal be "confirmed" against a pre-match
  // price that has not moved because the match has not.
  const index = buildSelectionIndex([
    bookEvent(BOOK_A, [3.1, 3.1, 3.1], { live: true }),
    bookEvent(BOOK_B, [3.3, 3.3, 3.3], { live: false }),
  ]);
  const home = [...index.keys()].find((k) => k.endsWith('::1'));
  assert.match(home, /::live::1$/, 'the live leg is indexed under the live scope');
  assert.equal(index.get(home).length, 1, 'and the pre-match leg is not filed beside it');
  const pre = [...index.keys()].filter((k) => k.includes('::prematch::'));
  assert.equal(pre.length, 3, 'the pre-match book has its own three keys');
});

// ------------------------------------------------------------- the money gate

/**
 * Two books, one fixture, priced so that the best leg per outcome sums below 1:
 * 1/3.5 + 1/3.2 + 1/3.3 = 0.9012, an 11% arbitrage. Each book on its own stays
 * above its own break-even (1.055 and 1.016), which matters because the
 * workspace loader drops a market priced under 1 as corrupt — a book pair that
 * only arb'd by being under water would test the loader, not the live gate.
 */
const ARB_PRICES = { [BOOK_A]: [3.5, 2.6, 2.6], [BOOK_B]: [2.5, 3.2, 3.3] };

async function seedLive(dir, { capturedAt, live, kickoff }) {
  await mkdir(join(dir, 'workspace'), { recursive: true });
  for (const sourceId of [BOOK_A, BOOK_B]) {
    await writeFile(join(dir, 'workspace', `${sourceId}_events.json`), JSON.stringify({
      runId: 'run-live', sourceId, sourceUrl: `https://${sourceId}.example/offer`, transport: 'test-public-feed',
      capturedAt, observedAt: capturedAt,
      events: [{
        ...BASE, id: `${sourceId}-e1`, sourceId, eventKey: IDENTITY, live, kickoff,
        markets: [resultMarket(ARB_PRICES[sourceId], { live })],
      }],
    }), 'utf8');
  }
}

test('a live price older than 90 seconds carries no money guidance', async () => {
  // The window is 90s, not the 10-minute pre-match one, because a live price
  // describes a match that is being played right now. A snapshot of one that
  // has gone stale is not a slow prematch quote — it is a price for a game that
  // has since moved on.
  const staleDir = await mkdtemp(join(tmpdir(), 'arbiter-live-'));
  try {
    await seedLive(staleDir, { capturedAt: new Date(Date.now() - 120_000).toISOString(), live: true, kickoff: BASE.kickoff });
    const scan = await scanWorkspace({ dataDir: staleDir, includeLive: true, publish: false, sport: 'Football' });
    for (const source of scan.sources) {
      assert.equal(source.dataStatus, 'stale', `${source.sourceId}: a 120s-old live snapshot is stale`);
    }
    assert.equal(scan.opportunities.length, 0, 'and it produces no arbitrage');
  } finally {
    await rm(staleDir, { recursive: true, force: true });
  }

  // The positive control: the same two books, same prices, same fixture, read
  // now. Without it, "no opportunities" would also be what a broken scan returns
  // — and the only difference between the two runs is the capture time.
  const freshDir = await mkdtemp(join(tmpdir(), 'arbiter-live-'));
  try {
    await seedLive(freshDir, { capturedAt: new Date().toISOString(), live: true, kickoff: BASE.kickoff });
    const scan = await scanWorkspace({ dataDir: freshDir, includeLive: true, publish: false, sport: 'Football' });
    for (const source of scan.sources) {
      assert.equal(source.dataStatus, 'fresh', `${source.sourceId}: a live snapshot read now is fresh`);
    }
    assert.equal(scan.opportunities.length, 1, 'so the same prices do produce the arbitrage');
    assert.equal(scan.opportunities[0].live, true, 'and it is reported as a live signal');
  } finally {
    await rm(freshDir, { recursive: true, force: true });
  }
});

test('the pre-match 10-minute window is untouched by the live one', async () => {
  // The control for the test above: 120s is stale for a LIVE snapshot and
  // perfectly fresh for a pre-match one. If both used the same window, the live
  // gate would be indistinguishable from no gate at all.
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-live-'));
  try {
    await seedLive(dir, {
      capturedAt: new Date(Date.now() - 120_000).toISOString(), live: false,
      kickoff: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const scan = await scanWorkspace({ dataDir: dir, includeLive: true, publish: false, sport: 'Football' });
    for (const source of scan.sources) {
      assert.equal(source.dataStatus, 'fresh', `${source.sourceId}: a pre-match snapshot keeps the 10-minute window`);
    }
    assert.equal(scan.opportunities.length, 1, 'so the same 120s-old capture is still actionable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('includeLive is what decides whether a live event is seen at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-live-'));
  try {
    // A live event whose kickoff is an hour past: dropped on kickoff when live
    // is off, kept when live is on. That is the whole point of the flag, and the
    // arbitrage is what proves the data was there all along rather than absent.
    await seedLive(dir, {
      capturedAt: new Date().toISOString(), live: true,
      kickoff: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const off = await scanWorkspace({ dataDir: dir, includeLive: false, publish: false, sport: 'Football' });
    const on = await scanWorkspace({ dataDir: dir, includeLive: true, publish: false, sport: 'Football' });
    assert.equal(off.eventCount, 0, 'a live event is invisible without the flag');
    assert.equal(off.opportunities.length, 0);
    assert.equal(on.eventCount, 2, 'and both books are visible with it');
    assert.equal(on.opportunities.length, 1, 'which is the arbitrage the same data would have produced');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------- the adapters wire

test('fortuna keeps its in-play markets only when the caller asked for them', () => {
  // The `kind` is on the RAW market; normalizeFegMarket reduces a market to the
  // engine's shape and the kind does not survive that, which is how a live 1X2
  // became indistinguishable from a pre-match one.
  const market = (kind) => ({
    id: 'm1', marketTypeId: 'ufo:mtyp:00-00', kind,
    outcomes: [
      { id: 'h', name: '1', odds: 2.1, handicap: null },
      { id: 'd', name: 'X', odds: 3.3, handicap: null },
      { id: 'a', name: '2', odds: 3.1, handicap: null },
    ],
  });
  const raw = () => ({
    fixtures: [{
      id: 'ufo:mtch:1wf-0ie', sportId: 'ufo:sprt:00', _tournamentSeoName: 'liga-1',
      startDatetime: '2030-01-01T12:00:00.000Z',
      participants: [{ type: 'HOME', name: 'Home' }, { type: 'AWAY', name: 'Away' }],
    }],
    marketsByFixture: new Map([['ufo:mtch:1wf-0ie', [market('LIVE')]]]),
  });

  const off = new Fortuna().extractEvents(new Fortuna().normalize(raw()));
  assert.equal(off.length, 0, 'a pre-match run does not carry in-play prices');

  const on = new Fortuna({ includeLive: true });
  const [event] = on.extractEvents(on.normalize(raw()));
  assert.equal(event.markets[0].live, true, 'the market keeps the provider verdict');
  assert.equal(event.live, true, 'and the event is marked live, so the scanner sees it');

  // The control: the same fixture with a PREMATCH market is kept either way,
  // and is not marked live.
  const pre = raw();
  pre.marketsByFixture = new Map([['ufo:mtch:1wf-0ie', [market('PREMATCH')]]]);
  const [preEvent] = new Fortuna().extractEvents(new Fortuna().normalize(pre));
  assert.equal(preEvent.live, false);
  assert.equal(preEvent.markets[0].live, false);
});

test('unibet drops an in-play contest only when the caller did not ask for one', () => {
  // The contest shape is taken from test/fixtures/unibet-lobby-capture.json, a
  // recorded `views/lobby` response.
  // The contestKey is per contest: extractEvents dedupes on it, so two contests
  // sharing one key would exercise the dedupe instead of the live gate.
  const contest = (status) => ({
    _typ: 'LobbyFixtureContest', contestKey: `aaaa1111-${status}`, contestType: 'Football', status,
    name: 'Japonia vs Ecuador', category: 'football:international',
    categoriesDetailed: [{ name: 'Meciuri Amicale' }],
    startDateTimeUtc: { unixms: 1790604000000, value: '2026-10-01T10:10:00.000Z' },
    propositions: [{
      key: `aaaa1111-${status}:1x2`, propositionKey: '1x2', propositionType: '1x2', displayName: 'Rezultat final', status: 'Active',
      options: [
        { optionType: 'T1', optionName: 'Japonia', optionDisplayName: '1', price: 2.45 },
        { optionType: 'Draw', optionName: 'Egalitate', optionDisplayName: 'X', price: 3.25 },
        { optionType: 'T2', optionName: 'Ecuador', optionDisplayName: '2', price: 2.9 },
      ],
    }],
  });
  const raw = { contests: [contest('InPlay'), contest('PreGame')] };

  const off = new Unibet().extractEvents(new Unibet().normalize(raw));
  assert.equal(off.length, 1, 'only the pre-game contest is collected');
  assert.equal(off[0].status, 'PreGame');

  const on = new Unibet({ includeLive: true });
  const live = on.extractEvents(on.normalize(raw));
  assert.equal(live.length, 2, 'the in-play contest is collected too');
  const inPlay = live.find((e) => e.status === 'InPlay');
  assert.equal(inPlay.live, true, 'and the event is marked live from the contest status');
  assert.ok(inPlay.markets.every((m) => m.live === true), 'its markets are live markets too');
  assert.equal(live.find((e) => e.status === 'PreGame').live, false);
});

/** An hour ago — a kickoff only a running or finished match can have. */
const KICKED_OFF = new Date(Date.now() - 3_600_000).toISOString();

test('superbet drops a started event only when the caller did not ask for one', () => {
  // The field is `inplay_stats_metadata.status`, which the adapter used to read
  // only to discard the event. The control is the same event with
  // NOT_STARTED, which is collected either way.
  const event = (status, utcDate) => ({
    event_id: `sb-${status}`,
    inplay_stats_metadata: { status },
    fixture: {
      offer_state_status: { 1: 1 },
      event_name: 'Japonia · Ecuador',
      utc_date: utcDate,
      sport_id: 5,
      tournament_id: 77,
    },
    markets: [{
      id: 1, name: 'Rezultat final',
      odds: [
        { uuid: 'a', price: 2.45, status: 1, display: true, metadata: { name: '1', offer_state_id: 1, market_line_uuid: 'l' } },
        { uuid: 'b', price: 3.25, status: 1, display: true, metadata: { name: 'X', offer_state_id: 1, market_line_uuid: 'l' } },
        { uuid: 'c', price: 2.9, status: 1, display: true, metadata: { name: '2', offer_state_id: 1, market_line_uuid: 'l' } },
      ],
    }],
  });

  const off = new Superbet().extractEvents([event('IN_PLAY', KICKED_OFF)]);
  assert.equal(off.length, 0, 'a started event is not collected by a pre-match run');

  const on = new Superbet({ includeLive: true });
  const [live] = on.extractEvents([event('IN_PLAY', KICKED_OFF)]);
  assert.ok(live, 'the caller asked for one');
  assert.equal(live.live, true, 'and the provider status marks it live');
  assert.ok(live.markets.every((m) => m.live === true), 'including on every market');

  // The control: a pre-match event is collected either way, and is not live.
  // A past kickoff is what makes this the control rather than a second copy of
  // the negative — without `!live` in the window check a started event would be
  // dropped here too, and the first two assertions would pass by accident.
  const [pre] = new Superbet().extractEvents([event('NOT_STARTED', new Date(Date.now() + 86_400_000).toISOString())]);
  assert.equal(pre.live, false, 'NOT_STARTED is not live');
  assert.ok(pre.markets.every((m) => m.live === false));
});

test("winner's live clock is honoured, and a started match is not dropped as past", () => {
  const event = (currentStatus, startMs) => ({
    idMatch: `dg-${startMs}`, matchDateTime: String(startMs),
    currentStatus,
    team1Name: 'Japonia', team2Name: 'Ecuador',
    sportName: 'Fotbal', tournamentName: 'Amicale',
    matchBets: [{
      idBet: 5, mbActive: true, mbDisplayName: 'Rezultat final',
      mbOutcomes: [
        { idMbo: 1, mboActive: true, mboDisplayName: '1', mboOddValue: 2.45 },
        { idMbo: 2, mboActive: true, mboDisplayName: 'X', mboOddValue: 3.25 },
        { idMbo: 3, mboActive: true, mboDisplayName: '2', mboOddValue: 2.9 },
      ],
    }],
  });
  const started = Date.parse(KICKED_OFF);
  // Digitain's own shape: a live match carries a running clock.
  const liveStatus = { LiveMatchShortStatus: { 42: 'Live' }, LiveEventTime: 37 };

  const off = new Winner().extractEvents([event(liveStatus, started)]);
  assert.equal(off.length, 0, 'a live event is not collected by a pre-match run');

  // This is the assertion that failed before the fix: the kickoff of a running
  // match is already an hour in the past, so the pre-match window threw the
  // event away even with includeLive on, and the flag collected nothing.
  const on = new Winner({ includeLive: true });
  const [live] = on.extractEvents([event(liveStatus, started)]);
  assert.ok(live, 'a started match survives its own past kickoff when the caller asked for one');
  assert.equal(live.live, true, 'and the live clock marks it live');
  assert.ok(live.markets.every((m) => m.live === true), 'including on every market');

  // The control: a pre-match event with no clock, on a future kickoff.
  const [pre] = on.extractEvents([event(null, started + 86_400_000)]);
  assert.equal(pre.live, false, 'a match with no live clock is not live');
  assert.ok(pre.markets.every((m) => m.live === false));
});

test("egt's own live boolean is honoured, and a running match is not dropped as past", () => {
  const event = (live, startTime) => ({
    key: `egt-${live ? 'l' : 'p'}`,
    sportId: 1001,
    sportEventId: `egt-${live ? 'l' : 'p'}`,
    live,
    startTime,
    homeTeam: 'Japonia', awayTeam: 'Ecuador',
    tournamentName: 'Amicale',
    markets: [{
      marketTemplateName: '1X2', marketStatus: 'Active',
      outcomes: [
        { name: '1', odds: 2.45 }, { name: 'X', odds: 3.25 }, { name: 'Egalitate', odds: 3.25 }, { name: '2', odds: 2.9 },
      ].filter((o) => o.name !== 'Egalitate'),
    }],
  });

  const off = new Egt('ultrabet').extractEvents([event(true, KICKED_OFF)]);
  assert.equal(off.length, 0, 'a live event is not collected by a pre-match run');

  const on = new Egt('ultrabet', { includeLive: true });
  const [live] = on.extractEvents([event(true, KICKED_OFF)]);
  assert.ok(live, 'a running match survives its own past kickoff when the caller asked for one');
  assert.equal(live.live, true, "and the provider's own boolean marks it live");
  assert.ok(live.markets.every((m) => m.live === true), 'including on every market');

  // The control: a pre-match event inside the window, collected either way.
  const [pre] = new Egt('ultrabet').extractEvents([event(false, new Date(Date.now() + 86_400_000).toISOString())]);
  assert.equal(pre.live, false, 'a pre-match event is not live');
  assert.ok(pre.markets.every((m) => m.live === false));
});

test('no adapter writes the dead isLive field again', () => {
  // A static tripwire, and labelled as one: it cannot tell whether an adapter
  // derives the right value, only that the hardcoded `isLive: false` — a field
  // that read like an answer and was read by nobody — has not come back. The
  // behavioural side of the same property is the four adapters above.
  const dir = join(ROOT, 'src', 'scrapers');
  const offenders = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.mjs')) continue;
    readFileSync(join(dir, file), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (/isLive\s*:\s*(false|'false'|"false")/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'no adapter may hardcode a false live answer');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Casa from '../src/scrapers/casa-pariurilor.mjs';
import Fortuna from '../src/scrapers/fortuna.mjs';
import { describeError, summariseReasons } from '../src/scrapers/feg-common.mjs';
import { canonicalSport } from '../src/shared/text.mjs';
import { resolveContract, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

for (const Adapter of [Casa, Fortuna]) {
  test(`${Adapter.name} preserves unknown settlement and provider identifiers`, () => {
    const adapter = new Adapter();
    const [event] = adapter.extractEvents([{ id: 'fixture', sport: 'Rugby', league: 'Top 14', kickoff: '2030-01-01T12:00:00Z', homeTeam: 'Clermont', awayTeam: 'Castres', markets: [{ id: 'market', marketTypeId: 'ufo:mtyp:07-0i', outcomes: [{ id: 'h', name: '1', odds: 2, handicap: 1 }, { id: 'a', name: '2', odds: 2 }] }] }]);
    assert.equal(event.markets[0].period, 'unknown');
    assert.equal(event.markets[0].id, 'market');
    assert.equal(event.markets[0].selections[0].handicap, 1);
  });
  test(`${Adapter.name} maps provider sport 07 to rugby during catalogue traversal`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => ({ ok: true, json: async () => String(url).includes('ufo:sprt:07/tournaments') ? { tournaments: [{ id: 'top14', name: 'Top 14', fixturesCount: 0 }] } : { tournaments: [] } }));
    const raw = await new Adapter().fetchRaw();
    assert.equal(raw.tournaments[0]._sportName, 'Rugby');
  });
}

/**
 * A failure count says how many; it does not say why, and the two are what a
 * run report needs. "All 13 catalogue requests failed" is the one message
 * that names none of the possible causes — a refused connection, a 403 and a
 * timeout are three different problems that all read as that line.
 *
 * These assertions are about the message, not the scraping: each forces one
 * cause and checks that it survives all the way to the error the run reports.
 */
test('describeError unwraps the cause fetch hides', () => {
  // fetch wraps everything in `TypeError: fetch failed` and puts the real
  // reason on `cause`, so reporting the message alone loses it.
  const dns = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.efortuna.ro' },
  });
  assert.match(describeError(dns), /ENOTFOUND/, 'the code is the whole story');

  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ECONNREFUSED' },
  });
  assert.match(describeError(refused), /ECONNREFUSED/);

  // An error with no cause still says something rather than nothing.
  assert.ok(describeError(new Error('boom')).includes('boom'));
  assert.ok(describeError(null).length > 0, 'a missing error is described, not blank');
});

test('summariseReasons counts each cause once and keeps the worst', () => {
  const reasons = new Map([
    ['catalogue: ENOTFOUND', 1],
    ['catalogue: HTTP 403', 13],
  ]);
  const out = summariseReasons(reasons);
  assert.match(out, /catalogue: HTTP 403 ×13/, 'a repeated cause carries its count');
  assert.doesNotMatch(out, /×1\b/, 'a single occurrence needs no count');
  assert.ok(summariseReasons(new Map()).length > 0, 'an empty map still yields a phrase');
  // The most common cause is the informative one, so a limit keeps it even
  // when it is not the first one recorded.
  assert.match(summariseReasons(reasons, 1), /HTTP 403/);
});

test('a total failure names its cause, whichever it was', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-fortuna-'));
  try {
    const causes = [
      ['ENOTFOUND', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }],
      ['HTTP 403', () => ({ ok: false, status: 403, json: async () => ({}) })],
    ];
    for (const [expected, impl] of causes) {
      const s = new Fortuna({ timeoutMs: 5_000, dataDir });
      const original = globalThis.fetch;
      globalThis.fetch = async () => impl();
      try {
        const result = await s.run();
        assert.equal(result.status, 'failed', 'a total failure is a failed run');
        assert.match(result.error.message, new RegExp(expected),
          `the message names the cause (${expected}): ${result.error.message}`);
      } finally {
        globalThis.fetch = original;
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

/**
 * The two brands are one upstream feed resold under two names, which is why
 * they are declared together in the `fortuna-bff` group in feed-groups.mjs.
 * Their adapters were near-verbatim copies that had already drifted, so these
 * assertions pin the shared contract the copies used to disagree on.
 */

const BRANDS = [
  { id: 'casa-pariurilor', Cls: Casa, transport: 'casa-catalogue-v1', host: /casapariurilor/i },
  { id: 'fortuna', Cls: Fortuna, transport: 'fortuna-catalogue-v1', host: /efortuna/i },
];

for (const { id, Cls, transport, host } of BRANDS) {
  test(`${id} is configured with the origin its fetch actually calls`, () => {
    const s = new Cls();
    // A subclass that forgot its origin would build every request from the
    // empty string, resolve nowhere, and report a clean empty day.
    assert.ok(s.apiBase, `${id}: apiBase must be assigned`);
    assert.match(s.apiBase, host, `${id}: apiBase should point at this brand's host`);
    assert.ok(!s.apiBase.includes('undefined'), `${id}: apiBase must not contain "undefined"`);
    assert.ok(s.transport, `${id}: transport must be assigned`);
  });

  test(`${id} publishes under its own sourceId, not the other brand's`, () => {
    // The misattribution this guards: fetchRaw/extractEvents are shared, so a
    // literal sourceId would file one brand's prices under the other's id.
    const s = new Cls();
    const [event] = s.extractEvents([{
      id: 'fx', sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T12:00:00Z',
      homeTeam: 'Dinamo', awayTeam: 'Rapid',
      markets: [{ id: 'm', marketTypeId: 'ufo:mtyp:01-1', outcomes: [{ id: '1', name: '1', odds: 2.1 }, { id: '2', name: '2', odds: 3.2 }] }],
    }]);
    assert.equal(event.sourceId, id, `${id}: must publish as "${id}", not "${event.sourceId}"`);
    assert.equal(event.transport, transport, `${id}: must keep its own transport label`);
  });
}

test('the two FEG brands share one traversal, not two copies that drift', () => {
  assert.equal(Casa.prototype.fetchRaw, Fortuna.prototype.fetchRaw,
    'both brands must share the one fetchRaw implementation');
  assert.equal(Casa.prototype.extractEvents, Fortuna.prototype.extractEvents,
    'both brands must share the one extractEvents implementation');
  assert.equal(Casa.prototype.normalize, Fortuna.prototype.normalize,
    'both brands must share the one normalize implementation');
});

test('the two FEG brands agree on the identity of the same fixture', () => {
  // This is the invariant the copies had lost. They are in one feed group, so
  // the same match scraped from both must resolve to one event — otherwise the
  // shared-feed check compares different events and stops recognising the pair
  // as one price source. Their sport keys disagreed before consolidation
  // ("ice-hockey" vs "ice hockey", and unmapped sports kept stray punctuation);
  // the base class additionally rewrites eventKey to eventIdentityKey(), but the
  // raw key must not contradict itself between the two brands either.
  const fixture = {
    id: 'fx', sport: 'Ice Hockey', league: 'NHL', kickoff: '2030-01-01T12:00:00Z',
    homeTeam: 'Dinamo', awayTeam: 'Rapid',
    markets: [{ id: 'm', marketTypeId: 'ufo:mtyp:01-1', outcomes: [{ id: '1', name: '1', odds: 2.1 }, { id: '2', name: '2', odds: 3.2 }] }],
  };
  const [casaEvent] = new Casa().extractEvents([fixture]);
  const [fortunaEvent] = new Fortuna().extractEvents([fixture]);
  assert.equal(casaEvent.eventKey, fortunaEvent.eventKey,
    'the same fixture must produce the same key from either brand');
  assert.notEqual(casaEvent.sourceId, fortunaEvent.sourceId,
    'but they remain two distinct sources, which is what the feed group is for');
});

test('a failure in the market phase is reported as a market failure', () => {
  // Both copies shared one counter but Casa labelled every phase "catalogue",
  // so a dead market endpoint reported as a catalogue problem. The stage in the
  // message is the only thing that says which of the three phases to look at.
  const s = new Fortuna();
  const source = Fortuna.prototype.fetchRaw.toString();
  assert.match(source, /recordFailure\('markets'/, 'the market phase must label itself');
  assert.equal(s.id, 'fortuna');
});

/**
 * A fixture's own sportId outranks the catalogue tree it was found under.
 *
 * The traversal walks one catalogue per sport and stamps every fixture with that
 * tree's label. Measured 2026-10-02 over all 890 live fixtures the two agree
 * exactly — 775/775 on football across 103 real tournaments, and the same on
 * tennis, basketball, darts, handball, ice hockey, futsal, rugby and the
 * unmapped ids 26, 27 and 35. They disagree on exactly one group.
 */
const KICKOFF = '2030-01-01T12:00:00.000Z';

/** One raw fixture, as the catalogue traversal hands it to normalize(). */
function fixture({ id, sportId, treeSport, home, away, tournament }) {
  return {
    id,
    sportId,
    sportSeoName: 'efotbal',
    _sportName: treeSport,
    _tournamentName: tournament,
    _tournamentSeoName: tournament.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    startDatetime: new Date(KICKOFF).getTime(),
    participants: [
      { type: 'HOME', name: home },
      { type: 'AWAY', name: away },
    ],
  };
}

/** A priced two-way market, enough for normalize() to keep the fixture. */
function market(id) {
  return [{ id, marketTypeId: 'ufo:mtyp:03-0c', name: 'Total goluri', period: 'FT',
    outcomes: [{ id: `${id}-o`, name: 'Over', odds: 1.91 }, { id: `${id}-u`, name: 'Under', odds: 1.91 }] }];
}

for (const { id, Cls } of BRANDS) {
  test(`${id} reads an esports battle filed under the football tree as not football`, () => {
    // "Esports Battle - Liga Campionilor (2x6 min.)", found by walking the
    // ufo:sprt:00 catalogue but carrying sportId ufo:sprt:0c — an id absent
    // from FEG_SPORT_NAMES. Stamped from the tree it was published as football,
    // and its total (which counts ROUNDS of a best-of-2-then-6 battle, not
    // goals) resolved into the engine's football OVER_UNDER buckets. That is
    // where the single-book O/U 9.5, 11.5 and 12.5 rows in the coverage report
    // came from. There is no way to filter these by name alone: the provider
    // writes the same "Esports Battle" prefix on every one of them, and the
    // player alias welded onto the club ("Juventus (Pex)") is not a safe test
    // either — real clubs carry parentheses too.
    const battle = fixture({
      id: 'fx-battle', sportId: 'ufo:sprt:0c', treeSport: 'Football',
      home: 'Juventus (Pex)', away: 'B Dortmund (ZORO)',
      tournament: 'Esports Battle - Liga Campionilor (2x6 min.)',
    });
    const real = fixture({
      id: 'fx-real', sportId: 'ufo:sprt:00', treeSport: 'Football',
      home: 'Juventus', away: 'B Dortmund',
      tournament: 'Serie A',
    });
    const adapter = new Cls();
    const marketsByFixture = new Map([['fx-battle', market('m1')], ['fx-real', market('m2')]]);
    const events = adapter.extractEvents(adapter.normalize({ fixtures: [battle, real], marketsByFixture }));
    const byId = new Map(events.map((e) => [e.id, e]));

    assert.equal(byId.get('fx-real').sport, 'Football', 'a real football fixture is still football');
    assert.notEqual(byId.get('fx-battle').sport, 'Football',
      `an esports battle must not be published as football (got ${byId.get('fx-battle').sport})`);
    assert.notEqual(canonicalSport(byId.get('fx-battle').sport), 'football',
      'and it must not survive the engine football scoping either');
    // Naming the unknown id is the existing convention for a sport this feed
    // has no name for, and it keeps the battle in its own event rather than
    // colliding with the real match it is named after.
    assert.match(byId.get('fx-battle').sport, /0c/);
    assert.notEqual(byId.get('fx-battle').eventKey, byId.get('fx-real').eventKey,
      'a battle and the real fixture it mimics must not share an event key');
  });

  test(`${id} falls back to the tree label when the fixture carries no sportId`, () => {
    // The new field is preferred, not required. A fixture that omits it must
    // still be labelled from the tree the traversal walked, exactly as before.
    const adapter = new Cls();
    const bare = fixture({
      id: 'fx-bare', treeSport: 'Handball', home: 'Dinamo', away: 'Rapid',
      tournament: 'Liga Nationala',
    });
    delete bare.sportId;
    const [event] = adapter.extractEvents(adapter.normalize({
      fixtures: [bare],
      marketsByFixture: new Map([['fx-bare', market('m')]]),
    }));
    assert.equal(event.sport, 'Handball');
  });
}

/**
 * A per-team goal total is not a match spread, and this feed publishes both.
 *
 * The football namespace `00` on the BFF catalogue holds exactly ten market
 * types with one name each. Two of them — 00-10 "Echipa 1 Total goluri <line>"
 * and 00-13 "Echipa 2 Total goluri <line>" — count ONE TEAM's goals, and their
 * legs are bare signed numbers ("+ 4.5" / "- 4.5") with no team token. That is
 * the single shape the engine's line resolver cannot decline: the markets
 * resolved as ASIAN_HANDICAP, a match spread priced off one team's goal count.
 *
 * Measured 2026-10-02 on the live feed: 3 such markets across 763 live football
 * events, every one agreeing with its id, resolving to -4.5/4.5 (twice) and
 * -2.5/2.5. The coverage report then carried this id as a provider key on four
 * handicap lines, the widest being -0.5/0.5 with 15 books and 95 pairs — the
 * shape of the risk, not a measurement of a false pair, since a book count says
 * nothing about what the other fourteen books were quoting.
 */
for (const { id, Cls } of BRANDS) {
  test(`${id} does not publish a per-team goal total as a match spread`, () => {
    // A fixture carrying a real match handicap AND a team goal total, plus a
    // second fixture carrying the away-side total on its own. The totals must
    // go; the handicap must stay.
    const realSpread = (mid) => [{ id: `${mid}-a`, marketTypeId: 'ufo:mtyp:00-0b', name: 'Handicap asiatic', period: 'FT',
      outcomes: [{ id: `${mid}-1`, name: 'Dinamo -1.5', odds: 1.95 }, { id: `${mid}-2`, name: 'Rapid +1.5', odds: 1.93 }] }];
    const teamTotal = (mid, mtype, label) => [{ id: `${mid}-t`, marketTypeId: mtype, name: label, period: 'FT',
      outcomes: [{ id: `${mid}-+`, name: '+ 4.5', odds: 1.87 }, { id: `${mid}--`, name: '- 4.5', odds: 1.91 }] }];

    const mixed = fixture({ id: 'fx-mixed', sportId: 'ufo:sprt:00', treeSport: 'Football', home: 'Dinamo', away: 'Rapid', tournament: 'Liga 1' });
    const onlyTotal = fixture({ id: 'fx-only', sportId: 'ufo:sprt:00', treeSport: 'Football', home: 'Needham', away: 'Stamfort', tournament: 'National League' });
    const shouty = fixture({ id: 'fx-shouty', sportId: 'ufo:sprt:00', treeSport: 'Football', home: 'Boreham', away: 'Kidderminster', tournament: 'National League' });
    const adapter = new Cls();
    const events = adapter.extractEvents(adapter.normalize({
      fixtures: [mixed, onlyTotal, shouty],
      marketsByFixture: new Map([
        ['fx-mixed', [...realSpread('m1'), ...teamTotal('m2', 'ufo:mtyp:00-10', 'Echipa 1 Total goluri 4.5')]],
        ['fx-only', teamTotal('m3', 'ufo:mtyp:00-13', 'Echipa 2 Total goluri 4.5')],
        // The same id shouted. The guard is a safety boundary, so it must not
        // quietly stop withholding because the feed changed its spelling.
        ['fx-shouty', teamTotal('m4', 'UFO:MTYP:00-10', 'Echipa 1 Total goluri 2.5')],
      ]),
    }));
    const byId = new Map(events.map((e) => [e.id, e]));

    assert.deepEqual(byId.get('fx-mixed').markets.map((m) => m.key), ['ufo:mtyp:00-0b'],
      'the team total is dropped and the real match handicap is kept');
    assert.equal(byId.has('fx-only'), false,
      'a fixture whose only market is a team total is not published at all');
    assert.equal(byId.has('fx-shouty'), false,
      'the guard withholds by id regardless of the feed’s spelling');
  });

  test(`${id} still publishes the match total and the match result`, () => {
    // POSITIVE CONTROL beside the refusal above: a guard that keyed on the
    // football namespace instead of on the two withheld ids would pass the test
    // above and silently delete this feed's whole priced surface.
    const fx = fixture({ id: 'fx-ok', sportId: 'ufo:sprt:00', treeSport: 'Football', home: 'Dinamo', away: 'Rapid', tournament: 'Liga 1' });
    const adapter = new Cls();
    const [event] = adapter.extractEvents(adapter.normalize({
      fixtures: [fx],
      marketsByFixture: new Map([['fx-ok', [
        { id: 'ok-1', marketTypeId: 'ufo:mtyp:00-00', name: 'Meci', period: 'FT',
          outcomes: [{ id: 'o1', name: '1', odds: 2.1 }, { id: 'ox', name: 'X', odds: 3.3 }, { id: 'o2', name: '2', odds: 3.4 }] },
        { id: 'ok-2', marketTypeId: 'ufo:mtyp:00-0u', name: 'Total goluri', period: 'FT',
          outcomes: [{ id: 'g+', name: 'Peste 2.5', odds: 1.9 }, { id: 'g-', name: 'Sub 2.5', odds: 1.9 }] },
      ]]]),
    }));
    assert.deepEqual(event.markets.map((m) => m.key), ['ufo:mtyp:00-00', 'ufo:mtyp:00-0u'],
      'the match result and the match total both survive');
  });

  test(`${id} propagates markMarketsLive and tags points/games subjects`, () => {
    const fxLive = fixture({ id: 'fx-live', sportId: 'ufo:sprt:02', treeSport: 'Basketball', home: 'Lakers', away: 'Warriors', tournament: 'NBA' });
    const adapter = new Cls({ includeLive: true });
    const [event] = adapter.extractEvents(adapter.normalize({
      fixtures: [fxLive],
      marketsByFixture: new Map([['fx-live', [
        { id: 'm-live-1', kind: 'LIVE', marketTypeId: 'ufo:mtyp:02-00', name: 'Castigator', period: 'FT',
          outcomes: [{ id: 'o1', name: '1', odds: 1.85 }, { id: 'o2', name: '2', odds: 1.95 }] },
        { id: 'm-live-2', kind: 'LIVE', marketTypeId: 'ufo:mtyp:02-0u', name: 'Total puncte', period: 'FT',
          outcomes: [{ id: 'p+', name: 'Peste 220.5', odds: 1.90 }, { id: 'p-', name: 'Sub 220.5', odds: 1.90 }] },
      ]]]),
    }));

    assert.equal(event.live, true);
    assert.equal(event.markets[0].live, true);
    assert.equal(event.markets[1].live, true);
    assert.equal(event.markets[1].subject, 'points');
  });

  test(`${id} dynamically extracts canonical periods for sub-window markets and isolates bucket keys`, () => {
    const fx = fixture({ id: 'fx-sub', sportId: 'ufo:sprt:02', treeSport: 'Basketball', home: 'Celtics', away: 'Heat', tournament: 'NBA' });
    const adapter = new Cls();
    const [event] = adapter.extractEvents(adapter.normalize({
      fixtures: [fx],
      marketsByFixture: new Map([['fx-sub', [
        { id: 'm-ft', marketTypeId: 'ufo:mtyp:02-0u', name: 'Total puncte', period: 'FT',
          outcomes: [{ id: 'p1', name: 'Peste 210.5', odds: 1.90 }, { id: 'p2', name: 'Sub 210.5', odds: 1.90 }] },
        { id: 'm-q1', marketTypeId: 'ufo:mtyp:02-0u', name: 'Total puncte sfert 1',
          outcomes: [{ id: 'q1', name: 'Peste 52.5', odds: 1.88 }, { id: 'q2', name: 'Sub 52.5', odds: 1.92 }] },
        { id: 'm-h1', marketTypeId: 'ufo:mtyp:02-0u', name: 'Total puncte repriza 1',
          outcomes: [{ id: 'h1', name: 'Peste 105.5', odds: 1.85 }, { id: 'h2', name: 'Sub 105.5', odds: 1.95 }] },
        { id: 'm-set1', marketTypeId: 'ufo:mtyp:01-0u', name: 'Total game-uri set 1',
          outcomes: [{ id: 's1', name: 'Peste 9.5', odds: 1.91 }, { id: 's2', name: 'Sub 9.5', odds: 1.91 }] },
        { id: 'm-map1', marketTypeId: 'ufo:mtyp:02-04', name: 'Harta 1. castigator',
          outcomes: [{ id: 'm1', name: '1', odds: 1.70 }, { id: 'm2', name: '2', odds: 2.10 }] },
      ]]]),
    }));

    const ftMarket = event.markets.find((m) => m.id === 'm-ft');
    const q1Market = event.markets.find((m) => m.id === 'm-q1');
    const h1Market = event.markets.find((m) => m.id === 'm-h1');
    const set1Market = event.markets.find((m) => m.id === 'm-set1');
    const map1Market = event.markets.find((m) => m.id === 'm-map1');

    assert.equal(ftMarket.period, 'FT');
    assert.equal(q1Market.period, 'q1');
    assert.equal(q1Market.subject, 'points');
    assert.equal(h1Market.period, 'half1');
    assert.equal(h1Market.subject, 'points');
    assert.equal(set1Market.period, 'set1');
    assert.equal(set1Market.subject, 'games');
    assert.equal(map1Market.period, 'set1');

    const ftContract = resolveContract(ftMarket, { sport: 'basketball' });
    const q1Contract = resolveContract(q1Market, { sport: 'basketball' });
    const h1Contract = resolveContract(h1Market, { sport: 'basketball' });

    assert.ok(ftContract);
    assert.ok(q1Contract);
    assert.ok(h1Contract);

    const ftKey = bucketKeyForContract('ev1', ftContract);
    const q1Key = bucketKeyForContract('ev1', q1Contract);
    const h1Key = bucketKeyForContract('ev1', h1Contract);

    assert.match(ftKey, /::fulltime::210\.5::/);
    assert.match(q1Key, /::q1::52\.5::/);
    assert.match(h1Key, /::half1::105\.5::/);

    assert.notEqual(ftKey, q1Key);
    assert.notEqual(ftKey, h1Key);
    assert.notEqual(q1Key, h1Key);
  });

  test(`${id} correctly normalizes Romanian PR and SR sub-window periods with bucket key isolation`, () => {
    const fx = fixture({ id: 'fx-prsr', sportId: 'ufo:sprt:00', treeSport: 'Football', home: 'FCSB', away: 'CFR Cluj', tournament: 'Liga 1' });
    const adapter = new Cls();
    const [event] = adapter.extractEvents(adapter.normalize({
      fixtures: [fx],
      marketsByFixture: new Map([['fx-prsr', [
        { id: 'm-pr-1x2', marketTypeId: 'ufo:mtyp:00-00', name: 'PR 1X2',
          outcomes: [{ id: 'pr1', name: '1', odds: 2.80 }, { id: 'prx', name: 'X', odds: 2.10 }, { id: 'pr2', name: '2', odds: 3.20 }] },
        { id: 'm-sr-1x2', marketTypeId: 'ufo:mtyp:00-00', name: 'SR 1X2',
          outcomes: [{ id: 'sr1', name: '1', odds: 2.70 }, { id: 'srx', name: 'X', odds: 2.20 }, { id: 'sr2', name: '2', odds: 3.10 }] },
        { id: 'm-ft-1x2', marketTypeId: 'ufo:mtyp:00-00', name: 'Meci', period: 'FT',
          outcomes: [{ id: 'ft1', name: '1', odds: 2.10 }, { id: 'ftx', name: 'X', odds: 3.30 }, { id: 'ft2', name: '2', odds: 3.40 }] },
        { id: 'm-pr-ou', marketTypeId: 'ufo:mtyp:00-0u', name: 'Prima rep - Total goluri',
          outcomes: [{ id: 'pro', name: 'Peste 0.5', odds: 1.45 }, { id: 'pru', name: 'Sub 0.5', odds: 2.55 }] },
      ]]]),
    }));

    const pr1x2Market = event.markets.find((m) => m.id === 'm-pr-1x2');
    const sr1x2Market = event.markets.find((m) => m.id === 'm-sr-1x2');
    const ft1x2Market = event.markets.find((m) => m.id === 'm-ft-1x2');
    const prOuMarket = event.markets.find((m) => m.id === 'm-pr-ou');

    assert.equal(pr1x2Market.period, 'half1');
    assert.equal(sr1x2Market.period, 'half2');
    assert.equal(ft1x2Market.period, 'FT');
    assert.equal(prOuMarket.period, 'half1');

    const prContract = resolveContract(pr1x2Market);
    const srContract = resolveContract(sr1x2Market);
    const ftContract = resolveContract(ft1x2Market);
    const prOuContract = resolveContract(prOuMarket);

    assert.ok(prContract);
    assert.ok(srContract);
    assert.ok(ftContract);
    assert.ok(prOuContract);

    assert.equal(prContract.period, 'half1');
    assert.equal(srContract.period, 'half2');
    assert.equal(ftContract.period, 'fulltime');
    assert.equal(prOuContract.period, 'half1');

    const prKey = bucketKeyForContract('evFCSB', prContract);
    const srKey = bucketKeyForContract('evFCSB', srContract);
    const ftKey = bucketKeyForContract('evFCSB', ftContract);
    const prOuKey = bucketKeyForContract('evFCSB', prOuContract);

    assert.equal(prKey, 'evFCSB::MATCH_ODDS::half1::_::home+draw+away::_::_');
    assert.equal(srKey, 'evFCSB::MATCH_ODDS::half2::_::home+draw+away::_::_');
    assert.equal(ftKey, 'evFCSB::MATCH_ODDS::fulltime::_::home+draw+away::_::_');
    assert.equal(prOuKey, 'evFCSB::OVER_UNDER::half1::0.5::over+under::goals::match');

    assert.notEqual(prKey, srKey);
    assert.notEqual(prKey, ftKey);
    assert.notEqual(srKey, ftKey);
  });
}

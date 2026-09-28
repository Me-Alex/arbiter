import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import Unibet, { contestsIn, leaguesIn } from '../src/scrapers/unibet.mjs';
import { resolveContract, isLiteral1x2SelectionSet } from '../src/scanner/market-contracts.mjs';

/**
 * Unibet's live feed is the Kindred sports BFF, and two of its rules are
 * invisible from a 404:
 *
 *   1. The load balancer answers 400 `InvalidRequestException` unless the
 *      request carries the tenant headers the site's own `getBFFClient` sends.
 *      Their names are plain — `locale`, `jurisdiction`, `ksp_jurisdiction`,
 *      `brand` — NOT the `X-Brand` / `X-Locale` pair the separate *betting*
 *      client uses. The rejected request looks exactly like a malformed query,
 *      which is what made this feed read as "prices moved behind MQTT".
 *   2. Contests live at `view.matches[].contestGroups[].contests[]` as
 *      `_typ: LobbyFixtureContest`. The landing page's widgets use a different
 *      type, `FixtureContest`, so matching the wrong one finds zero contests in
 *      a perfectly good response.
 *
 * These pin the parsing and the header contract against a recorded capture of
 * the real payload. They do not hit the network: the suite has to stay runnable
 * offline, and a live smoke test is a separate concern (see the `enabled` job
 * in config/scrapers.json).
 */

const CAPTURE = new URL(
  './fixtures/unibet-lobby-capture.json',
  import.meta.url,
);

/** Shape taken verbatim from a 2026-09-28 `views/lobby` response. */
function lobbyView() {
  return {
    _typ: 'LobbyPageViewResponse',
    view: {
      _typ: 'LobbyPageView',
      pageHeader: { contestType: 'Football', headerText: 'Fotbal' },
      matches: [
        {
          _typ: 'LobbyAccordionItem',
          date: '2026-10-01',
          contestGroups: [
            {
              _typ: 'LobbyContestGroup',
              contests: [
                {
                  _typ: 'LobbyFixtureContest',
                  contestKey: 'aaaa1111',
                  contestType: 'Football',
                  status: 'PreGame',
                  name: 'Japonia vs Ecuador',
                  category: 'football:international:internationalfriendlies',
                  categoriesDetailed: [
                    { _typ: 'CategoryDetailed', categoryRn: 'football:international:internationalfriendlies', name: 'Meciuri Amicale' },
                    { _typ: 'CategoryDetailed', categoryRn: 'football:international', name: 'Internațional' },
                    { _typ: 'CategoryDetailed', categoryRn: 'football', name: 'Fotbal' },
                  ],
                  startDateTimeUtc: { _typ: 'Date', unixms: 1790604000000, value: '2026-10-01T10:10:00.000Z' },
                  propositions: [
                    {
                      _typ: 'LobbyFixtureContestProposition',
                      key: 'aaaa1111:1x2',
                      propositionKey: '1x2',
                      propositionType: '1x2',
                      displayName: 'Rezultat final',
                      options: [
                        { optionType: 'T1', optionName: 'Japonia', optionDisplayName: '1', price: 2.45, bettingOpen: true, priceKey: 'aaaa1111:base:1x2:t1:plain:offering' },
                        { optionType: 'Draw', optionName: 'Egalitate', optionDisplayName: 'X', price: 3.25, bettingOpen: true, priceKey: 'aaaa1111:base:1x2:draw:plain:offering' },
                        { optionType: 'T2', optionName: 'Ecuador', optionDisplayName: '2', price: 2.90, bettingOpen: true, priceKey: 'aaaa1111:base:1x2:t2:plain:offering' },
                      ],
                    },
                    {
                      _typ: 'LobbyFixtureContestProposition',
                      key: 'aaaa1111:total',
                      propositionKey: 'total',
                      propositionType: 'total',
                      displayName: 'Total goluri',
                      options: [
                        { optionType: 'TotalOver', optionName: 'Peste', optionDisplayName: 'Peste', variantName: '9.5', variantType: 'OverUnder', price: 1.50, bettingOpen: true, priceKey: 'aaaa1111:base:total:total_over:9.5:offering' },
                        { optionType: 'TotalUnder', optionName: 'Sub', optionDisplayName: 'Sub', variantName: '9.5', variantType: 'OverUnder', price: 2.20, bettingOpen: true, priceKey: 'aaaa1111:base:total:total_under:9.5:offering' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

test('the recorded capture is present', () => {
  assert.ok(fs.existsSync(CAPTURE), 'fixtures/unibet-lobby-capture.json must exist');
  const body = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
  assert.equal(body._typ, 'LobbyPageViewResponse');
  assert.equal(body.view.matches[0].contestGroups[0].contests[0]._typ, 'LobbyFixtureContest');
});

test('contests are read from contestGroups, not from the landing-page shape', () => {
  const view = lobbyView().view;
  const found = contestsIn(view);
  assert.equal(found.size, 1, 'the nested LobbyFixtureContest must be found');
  assert.equal([...found.keys()][0], 'aaaa1111');
  assert.equal([...found.values()][0]._typ, 'LobbyFixtureContest');

  // The regression this pins. The landing page carries contests of the same
  // family but a different shape: `_typ: FixtureContest` under widget nodes
  // rather than under `contestGroups`. A collector written against that shape
  // walks a 115 KB league response and finds nothing, which is
  // indistinguishable from an empty feed.
  //
  // `featuredMatches` IS read on purpose — a real league lobby puts its
  // highlights there and nowhere else (the UEFA Nations League response had all
  // six of its contests there and none under contestGroups).
  const widgetShaped = {
    topSportsWidget: { content: { categories: [{ contests: [{ _typ: 'FixtureContest', contestKey: 'landing1' }] }] } },
    liveDataWidget: { content: { categories: [{ contests: [{ _typ: 'FixtureContest', contestKey: 'landing2' }] }] } },
  };
  assert.equal(contestsIn(widgetShaped).size, 0,
    'the landing-page widget shape is not a league lobby and must yield nothing');
  assert.equal(contestsIn({ featuredMatches: [{ contest: { _typ: 'FixtureContest', contestKey: 'f1' } }] }).size, 1,
    'featuredMatches is a real lobby node and is read');
  assert.equal(contestsIn(null).size, 0, 'a missing view yields no contests, it does not throw');
});

test('league categoryRns come from each accordion\'s children', () => {
  const view = {
    matches: [
      {
        identifier: 'Internațional',
        categoryRn: 'football:international',
        children: [
          { _typ: 'LeagueItem', categoryRn: 'football:international:uefa_nations_league', header: 'UEFA Nations League' },
          { _typ: 'LeagueItem', categoryRn: 'football:international:africa_cup_of_nations_qualification', header: 'CAF' },
        ],
      },
    ],
  };
  assert.deepEqual(leaguesIn(view), [
    'football:international:uefa_nations_league',
    'football:international:africa_cup_of_nations_qualification',
  ]);
  assert.deepEqual(leaguesIn(null), [], 'a missing view yields no leagues, it does not throw');
});

test('a recorded lobby view normalizes into one priced event', () => {
  const s = new Unibet({});
  const contests = [...contestsIn(lobbyView().view).values()];
  const events = s.extractEvents(s.normalize({ contests }));
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'aaaa1111');
  assert.equal(events[0].homeTeam, 'Japonia');
  assert.equal(events[0].awayTeam, 'Ecuador');
  assert.equal(events[0].markets.length, 2);
});

test('the tenant headers use the names the load balancer accepts', () => {
  const src = fs.readFileSync(new URL('../src/scrapers/unibet.mjs', import.meta.url), 'utf8');
  // These are the exact names getBFFClient sends. Swapping them for the
  // betting client's `X-` prefixed pair produces a 400 that reads like a bad
  // query, so the names themselves are the assertion.
  for (const h of ['locale', 'jurisdiction', 'ksp_jurisdiction', 'brand']) {
    assert.match(src, new RegExp(`\\b${h}:\\s*'`), `adapter must send the \`${h}\` header`);
  }
  assert.doesNotMatch(src, /'X-Brand'/, 'X-Brand is the betting client header and is rejected here');
  assert.doesNotMatch(src, /'X-Locale'/, 'X-Locale is the betting client header and is rejected here');
});

test('team names come from the T1/T2 options, not the 1 / X / 2 labels', () => {
  // The market's own selections are deliberately the literal 1/X/2 triple so
  // the engine can recognise a full-time result by shape. Reading the teams
  // from those labels instead of the provider's `optionName` published every
  // football event as "1 vs 2", which collapsed 660 distinct fixtures into a
  // handful of identical event keys.
  const s = new Unibet({});
  const [contest] = s.normalize({ contests: [lobbyView().view.matches[0].contestGroups[0].contests[0]] });
  assert.equal(contest.homeTeam, 'Japonia');
  assert.equal(contest.awayTeam, 'Ecuador');

  const [event] = s.extractEvents([contest]);
  assert.equal(event.homeTeam, 'Japonia');
  assert.match(event.eventKey, /japonia.*ecuador/);
});

test('the result market keeps the literal 1/X/2 selections the engine needs', () => {
  const s = new Unibet({});
  const [contest] = s.normalize({ contests: [lobbyView().view.matches[0].contestGroups[0].contests[0]] });
  const [event] = s.extractEvents([contest]);
  const result = event.markets.find((m) => m.key === '1x2');
  assert.ok(result, 'the 1x2 market must be emitted');
  assert.deepEqual(result.selections.map((x) => x.name), ['1', 'X', '2']);
  assert.ok(isLiteral1x2SelectionSet(result.selections), 'must be recognisable as a 1X2 result market');
  assert.equal(resolveContract(result).family, 'MATCH_ODDS', 'must route to MATCH_ODDS');
});

test('the totals line is carried into the selection name', () => {
  // The engine's totals resolver reads the line off the selection text, so a
  // bare "Peste" would bucket every total line on the event into one market.
  const s = new Unibet({});
  const [contest] = s.normalize({ contests: [lobbyView().view.matches[0].contestGroups[0].contests[0]] });
  const totals = contest.markets.find((m) => m.key === 'TOTAL');
  assert.deepEqual(totals.selections.map((x) => x.name), ['Peste 9.5', 'Sub 9.5']);

  const contract = resolveContract(totals);
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.lineKey, '9.5', 'the 9.5 line must survive into the engine bucket key');
  assert.deepEqual(contract.outcomes, ['over', 'under']);

  // Stripping the line does not merely collapse the buckets — it makes the
  // market unresolvable, so it is dropped at the scanner rather than compared
  // against another line's prices.
  const withoutLine = JSON.parse(JSON.stringify(totals));
  for (const sel of withoutLine.selections) sel.name = sel.name.replace(' 9.5', '');
  assert.equal(resolveContract(withoutLine), null,
    'a totals market with no readable line is not a resolvable contract');
});

test('a second 1x2 on the same contest does not double the result legs', () => {
  // Unibet lists "Rezultat final" and "Cote meci" as two 1x2 markets on some
  // events. Emitting both puts two full-time result legs in the same engine
  // bucket, so the first priced one wins.
  const raw = lobbyView().view.matches[0].contestGroups[0].contests[0];
  const alt = JSON.parse(JSON.stringify(raw.propositions[0]));
  alt.key = 'aaaa1111:1x2:alt';
  alt.displayName = 'Cote meci';
  alt.options = alt.options.map((o, i) => ({ ...o, price: o.price + 1, priceKey: `${o.priceKey}:alt${i}` }));
  const contest = { ...raw, propositions: [...raw.propositions, alt] };

  const s = new Unibet({});
  const [out] = s.normalize({ contests: [contest] });
  const resultMarkets = out.markets.filter((m) => m.key === '1x2');
  assert.equal(resultMarkets.length, 1, 'only one 1x2 may reach the engine');
  assert.equal(resultMarkets[0].name, 'Rezultat final');
});

test('a sub-1 price is withheld while the rest of the market survives', () => {
  const raw = lobbyView().view.matches[0].contestGroups[0].contests[0];
  const broken = JSON.parse(JSON.stringify(raw));
  broken.propositions[0].options[1].price = 0.9; // draw drops below 1

  const s = new Unibet({});
  const [contest] = s.normalize({ contests: [broken] });
  const result = contest.markets.find((m) => m.key === '1x2');
  assert.deepEqual(result.selections.map((x) => x.name), ['1', '2'], 'the sub-1 draw is withheld');
  assert.ok(result.selections.every((x) => x.odds > 1), 'nothing at or below 1 reaches the engine');
});

test('a side closed for betting is withheld too', () => {
  const raw = lobbyView().view.matches[0].contestGroups[0].contests[0];
  const broken = JSON.parse(JSON.stringify(raw));
  broken.propositions[0].options[1].bettingOpen = false; // draw suspended

  const s = new Unibet({});
  const [contest] = s.normalize({ contests: [broken] });
  const result = contest.markets.find((m) => m.key === '1x2');
  assert.deepEqual(result.selections.map((x) => x.name), ['1', '2'], 'the suspended draw is withheld');
});

test('a market missing more than one side is dropped entirely', () => {
  // Two of three result legs unusable leaves a one-sided market, which the
  // engine cannot invert. Publishing it as a two-way would put a single price
  // into a bucket that expects three.
  const raw = lobbyView().view.matches[0].contestGroups[0].contests[0];
  const thin = JSON.parse(JSON.stringify(raw));
  thin.propositions[0].options[1].price = 0.9;
  thin.propositions[0].options[2].bettingOpen = false;

  const s = new Unibet({});
  const [contest] = s.normalize({ contests: [thin] });
  assert.equal(contest.markets.find((m) => m.key === '1x2'), undefined,
    'a one-sided result market must not be published');
  assert.equal(contest.markets.length, 1, 'the totals market is unaffected');
});

test('a one-sided market is dropped rather than published as a two-way', () => {
  const raw = lobbyView().view.matches[0].contestGroups[0].contests[0];
  const thin = JSON.parse(JSON.stringify(raw));
  thin.propositions = [thin.propositions[0]];
  thin.propositions[0].options = [thin.propositions[0].options[0]];

  const s = new Unibet({});
  assert.deepEqual(s.normalize({ contests: [thin] }), [], 'a contest with no two-sided market is not an event');
});

test('the league label is the deepest category, and kickoff is UTC', () => {
  const s = new Unibet({});
  const [contest] = s.normalize({ contests: [lobbyView().view.matches[0].contestGroups[0].contests[0]] });
  assert.equal(contest.league, 'Meciuri Amicale');
  assert.equal(contest.kickoff, '2026-10-01T10:10:00.000Z');
  assert.equal(contest.sport, 'Football');
});

test('the job is enabled and names the recovered feed', async () => {
  const cfg = JSON.parse(await fs.promises.readFile(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
  const job = cfg.jobs.find((j) => j.id === 'unibet');
  assert.equal(job.enabled, true, 'unibet must be enabled — the feed works');
  assert.equal(job.feedStatus, 'verified');
  assert.doesNotMatch(job.validationReason, /MQTT client is needed/i,
    'the MQTT conclusion was wrong and must not be left standing in config');
});

test('the registry records the BFF as a verified kindred endpoint', async () => {
  const reg = JSON.parse(
    await fs.promises.readFile(new URL('../data/endpoints/endpoints.json', import.meta.url), 'utf8'),
  );
  const book = reg.books.unibet;
  assert.equal(book.feedStatus, 'verified');
  const urls = (book.keyEndpoints || []).map((e) => e.url).join(' ');
  assert.match(urls, /sportsbff[a-z0-9.-]*kindredext\.net/, 'the live BFF host must be recorded');
});

// ===========================================================================
// The deep market surface — v2/views/contest-page
// ===========================================================================

/**
 * The lobby ships one proposition per contest: the default `1x2`. A contest
 * object advertises the rest of its menu in `propositionCount` (36-150 in
 * practice) and `hasMorePropositions`, and `v2/views/contest-page?contestKey=`
 * is the request that returns it. These tests pin what the deep mode is allowed
 * to publish from that response, against a recorded capture.
 *
 * The failure they guard against is not a missing opportunity — it is a
 * fabricated one. Several of these markets have selection shapes the engine
 * recognises as something else entirely, so publishing them unfiltered pairs a
 * handicap price against a plain full-time result from another book and reports
 * a profit that cannot exist.
 */

const CONTEST_PAGE = new URL('./fixtures/unibet-contest-page-capture.json', import.meta.url);

/** The recorded `GetContestPage`, from a real 2026-09-28 football fixture. */
function contestPage() {
  return JSON.parse(fs.readFileSync(CONTEST_PAGE, 'utf8'));
}

function propositionOfType(type) {
  return contestPage().contest.propositions.find((p) => p.propositionType === type);
}

/** Every market the normaliser emits for the captured contest. */
function deepMarkets() {
  const s = new Unibet({ fullMarkets: true });
  const [contest] = s.normalize({ contests: [contestPage().contest] });
  return contest.markets;
}

test('the lobby preview carries only 1x2, while the detail view carries the menu', () => {
  const lobbyContest = lobbyView().view.matches[0].contestGroups[0].contests[0];
  const preview = new Unibet({}).normalize({ contests: [lobbyContest] })[0].markets;
  assert.deepEqual(
    [...new Set(preview.map((m) => m.key))],
    ['1x2', 'TOTAL'],
    'the cheap crawl yields a result market and nothing else',
  );

  const deep = deepMarkets();
  const keys = new Set(deep.map((m) => m.key));
  for (const expected of ['1x2', 'TOTAL', 'BOTH_TEAMS_SCORE', 'DOUBLE_CHANCE', 'HANDICAP']) {
    assert.ok(keys.has(expected), `deep mode must publish ${expected}`);
  }
  assert.ok(deep.length > preview.length, 'the detail view must yield strictly more markets');
});

test('every totals line becomes its own OVER_UNDER contract', () => {
  // The feed sends six totals lines as six `variants` of one proposition. If
  // they collapse into a single market, Over 0.5 gets compared against Under 5.5.
  const totals = deepMarkets().filter((m) => m.key === 'TOTAL' && m.period === 'fulltime');
  assert.equal(totals.length, 6, 'each priced full-time totals line is its own market');

  const lines = totals.map((m) => resolveContract(m).lineKey).sort();
  assert.deepEqual(lines, ['0.5', '1.5', '2.5', '3.5', '4.5', '5.5']);
  assert.equal(new Set(lines).size, lines.length, 'no two totals markets may share a line');

  for (const m of totals) {
    const contract = resolveContract(m);
    assert.equal(contract.family, 'OVER_UNDER');
    assert.deepEqual(contract.outcomes, ['over', 'under']);
    assert.ok(
      m.selections.every((s) => s.name.includes(String(m.line))),
      `the ${m.line} line must be readable from both selection names`,
    );
  }
});

test('corner totals are not folded into the goals-total buckets', () => {
  // Unibet also prices total corners. They share the "total" English word but
  // count a different quantity, so publishing them under the goals TOTAL key
  // would let a 9.5 corner line pair against a 9.5 goal line from another book.
  const allTotals = deepMarkets().filter((m) => m.key === 'TOTAL');
  for (const m of allTotals) {
    assert.doesNotMatch(m.name, /corners/i, 'a corners total must not reuse the goals bucket');
  }
});

test('both teams to score resolves as a BTTS contract', () => {
  const [btts] = deepMarkets().filter((m) => m.key === 'BOTH_TEAMS_SCORE');
  assert.ok(btts, 'BTTS must be published');
  // Unibet spells the sides "Da" / "Nu"; the resolver knows both.
  assert.deepEqual(btts.selections.map((s) => s.name), ['Da', 'Nu']);
  const contract = resolveContract(btts);
  assert.equal(contract.family, 'BTTS');
  assert.deepEqual(contract.outcomes, ['yes', 'no']);
});

test('double chance is catalogued but never treated as a surebet', () => {
  const [dc] = deepMarkets().filter((m) => m.key === 'DOUBLE_CHANCE');
  assert.deepEqual(dc.selections.map((s) => s.name), ['1X', '12', 'X2']);
  const contract = resolveContract(dc);
  assert.equal(contract.family, 'DOUBLE_CHANCE');
  assert.equal(contract.arbEligible, false,
    'the three double-chance legs overlap, so paying all three is not a surebet');
});

test('only half-line handicaps are published, and each resolves as ASIAN_HANDICAP', () => {
  // Unibet lists 13 two-way handicap lines per event. Only the half-lines are a
  // clean exclusive-exhaustive pair; a whole line pushes and a quarter line
  // splits the stake, so neither is the contract the inverse-sum assumes.
  const markets = deepMarkets().filter((m) => m.key === 'HANDICAP');
  assert.equal(markets.length, 3, 'the fixture has exactly three half-lines');

  const seen = new Set();
  for (const m of markets) {
    assert.equal(m.selections.length, 2, 'a two-way handicap publishes two sides');
    const [a, b] = m.selections.map((s) => s.name);
    assert.match(a, /^[12] [+-]/, `the ${m.line} line must be readable from both sides, got "${a}"`);
    assert.match(b, /^[12] [+-]/, `the ${m.line} line must be readable from both sides, got "${b}"`);

    const contract = resolveContract(m);
    assert.equal(contract.family, 'ASIAN_HANDICAP', `line ${m.line} must resolve as a handicap`);
    seen.add(contract.lineKey);
  }
  assert.equal(seen.size, 3, 'each handicap line gets its own bucket');
});

test('a whole-line handicap is withheld instead of posing as a match winner', () => {
  // The specific hazard: "1 -1" / "2 +1" carries no handicap keyword, so if it
  // reached the engine it would resolve through the generic two-way fallback as
  // MATCH_ODDS and be compared against another book's full-time result.
  const markets = deepMarkets();
  assert.equal(markets.filter((m) => m.line === '-1' || m.line === '1').length, 0,
    'whole-line handicaps must not be published');

  const whole = propositionOfType('2_way_handicap').variants.find((v) => v[0].variantKey === '-1');
  const s = new Unibet({ fullMarkets: true });
  const events = s.normalize({
    contests: [{ ...contestPage().contest, propositions: [whole] }],
  });
  assert.deepEqual(events, [], 'a lone whole-line handicap is not an event');
});

test('a three-way handicap is withheld, not published as a 1X2 result', () => {
  // Its selections are a literal 1/X/2 triple. Unfiltered it would be read as
  // the full-time result contract and paired against a real 1X2 from another
  // book — a guaranteed false arbitrage.
  const events = new Unibet({ fullMarkets: true }).normalize({
    contests: [{ ...contestPage().contest, propositions: [propositionOfType('3_way_handicap')] }],
  });
  assert.deepEqual(events, [], 'a 3-way handicap is not an arbitrable contract');

  const keys = new Set(deepMarkets().map((m) => m.key));
  assert.ok(!keys.has('3_way_handicap'), 'it must never be published under any key');
});

test('draw no bet is withheld: the draw refunds, so the pair is not exhaustive', () => {
  const events = new Unibet({ fullMarkets: true }).normalize({
    contests: [{ ...contestPage().contest, propositions: [propositionOfType('draw_no_bet')] }],
  });
  assert.deepEqual(events, [], 'draw-no-bet has a third outcome that returns the stake');
});

test('player props are dropped rather than published as comparable markets', () => {
  // `Participant` options name a person, so two books rarely spell the line the
  // same way — pairing them would invent an arbitrage between two different
  // bets. Excluding by option type means a new player-market type is dropped
  // automatically instead of leaking through an allowlist.
  const playerMarket = {
    propositionType: 'anytime_goalscorer_supersub',
    propositionKey: 'anytime_goalscorer_supersub',
    displayName: 'Marcator Oricând - Power Sub',
    variants: [[
      { optionDisplayName: 'Ousmane Dembele', optionType: 'Participant', price: 3.1, bettingOpen: true },
      { optionDisplayName: 'Marcus Thuram', optionType: 'Participant', price: 4.2, bettingOpen: true },
    ]],
  };
  const events = new Unibet({ fullMarkets: true }).normalize({
    contests: [{ ...contestPage().contest, propositions: [playerMarket] }],
  });
  assert.deepEqual(events, [], 'a player-prop market is not a cross-book contract');
});

test('a first-half market is kept out of the full-time buckets', () => {
  const [half] = deepMarkets().filter((m) => resolveContract(m)?.period === 'half1');
  assert.ok(half, 'the first-half totals market is published');
  assert.equal(half.key, 'TOTAL');
  assert.equal(half.period, 'half1');
  // The engine buckets on period, so a first-half 1.5 total can never be
  // compared against a full-time 1.5 total.
  assert.notEqual(half.line, null);
});

test('deep mode is opt-in and is reported honestly in the coverage block', async () => {
  const shallow = new Unibet({})._serializable([], {});
  assert.equal(shallow.coverage.allMarkets, false);
  assert.equal(shallow.coverage.markets, 'result-only');
  assert.equal(shallow.coverage.detailLimit, 0);

  const deep = new Unibet({ fullMarkets: true })._serializable([], {});
  assert.equal(deep.coverage.allMarkets, true);
  assert.equal(deep.coverage.detailLimit, deep.coverage.maxEvents);
  assert.match(deep.coverage.markets, /totals/);
});

test('the detail call replaces the preview rather than merging into it', async () => {
  // A contest whose detail call fails must keep its lobby preview, so a partial
  // market set never costs the event. And the swap must not re-derive the
  // sport/league annotations the crawl already resolved.
  const s = new Unibet({ fullMarkets: true, detailLimit: 1 });
  const contests = [
    { contestKey: 'aaa', propositions: [{ propositionType: '1x2', options: [] }], _sport: 'Football', _league: 'x' },
  ];
  const called = [];
  s._get = async (path) => {
    called.push(path);
    return { contest: { propositions: [propositionOfType('both_teams_to_score')] } };
  };
  const enriched = await s._enrichMarkets(contests, { signal: undefined, stats: { attempted: 0, failed: 0, reasons: new Map(), record() {} } });

  assert.equal(enriched, 1);
  assert.equal(called.length, 1);
  assert.match(called[0], /^v2\/views\/contest-page\?contestKey=aaa$/);
  assert.equal(contests[0]._sport, 'Football', 'the crawl annotations survive the swap');
  assert.equal(contests[0].propositions.length, 1);
});

test('a failed detail call leaves the lobby preview in place', async () => {
  const s = new Unibet({ fullMarkets: true });
  const preview = [{ propositionType: '1x2', options: [{ optionDisplayName: '1', price: 2, bettingOpen: true }] }];
  const contests = [{ contestKey: 'aaa', propositions: preview }];
  s._get = async () => null; // transient 503 exhausting its retries

  const enriched = await s._enrichMarkets(contests, {
    signal: undefined,
    stats: { attempted: 0, failed: 0, reasons: new Map(), record() {} },
  });
  assert.equal(enriched, 0);
  assert.deepEqual(contests[0].propositions, preview, 'the event keeps its 1X2 preview');
});

test('detailLimit caps how many contests pay for the extra request', async () => {
  const s = new Unibet({ fullMarkets: true, detailLimit: 2 });
  const contests = Array.from({ length: 5 }, (_, i) => ({
    contestKey: `k${i}`,
    propositions: [],
  }));
  const seen = [];
  s._get = async (path) => {
    seen.push(path);
    return { contest: { propositions: [propositionOfType('both_teams_to_score')] } };
  };
  await s._enrichMarkets(contests, {
    signal: undefined,
    stats: { attempted: 0, failed: 0, reasons: new Map(), record() {} },
  });
  assert.equal(seen.length, 2, 'the detail pass must be bounded');
});

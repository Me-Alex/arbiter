/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Favbet from '../src/scrapers/favbet.mjs';

const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/favbet.json', import.meta.url)), 'utf8'));

/**
 * favbet had no test at all, which is a poor bet for this project.
 *
 * It is the largest feed — the reason the response cap is 16 MB rather than
 * 4 MB (SCRAPER-TASKS.md:79-80) — and the one adapter documented as failing
 * closed behind a Cloudflare challenge (SCRAPER-TASKS.md:82-88). Four separate
 * defects here once survived a green suite, so a completely uncovered adapter
 * is a gap, not a neutral fact.
 *
 * The fixture is a real capture: the JSON-RPC envelope from
 * /service/lineout/frontend_api2/, pruned to the market rows the kept events
 * were built from, with real kickoff times, real prices and real ids.
 */
/**
 * The fixture is a real capture, so its kickoffs are fixed dates in the past,
 * and the adapter filters to a forward window. Run these against a pinned
 * clock, or the suite rots with the calendar: the first fixture row kicked off
 * at 2026-09-28T16:00Z, and from that moment on the window correctly dropped it
 * and three of these tests began failing with nothing changed in the adapter.
 *
 * 2026-09-27T12:00Z puts both fixture kickoffs (the 28th and the 29th) in the
 * future and inside the 72h window the tests ask for.
 */
const PINNED_NOW = '2026-09-27T12:00:00.000Z';

const raw = () => structuredClone(FIXTURE.raw);

function atPinnedNow(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(PINNED_NOW) });
  t.after(() => t.mock.timers.reset());
}

test('the real capture yields a complete full-time 1X2 for football fixtures', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));

  const real = out.filter((e) => !/^\s*Goluri/i.test(e.homeTeam) && !/^\s*Goluri/i.test(e.awayTeam));
  assert.ok(real.length >= 2, `expected real two-team fixtures, got ${real.length}`);

  for (const e of real) {
    assert.equal(e.sourceId, 'favbet');
    assert.equal(e.sport, 'Football');
    assert.ok(e.homeTeam && e.awayTeam, 'both teams named');
    assert.ok(Date.parse(e.kickoff) > Date.now() - 3600000, 'kickoff is current or future');
    assert.ok(e.league && e.league !== 'Unknown', `a named league, got "${e.league}"`);

    const match = e.markets.find((m) => m.key === 'MATCH_ODDS');
    assert.ok(match, 'the match-result market is published');
    assert.deepEqual(
      match.selections.map((s2) => s2.name).sort(),
      ['1', '2', 'X'],
      'a complete and mutually exclusive 1 / X / 2 selection set'
    );
    assert.ok(match.selections.every((s2) => Number.isFinite(s2.odds) && s2.odds > 1), 'finite decimal odds above 1');
  }
});

test('every published event carries a browseable favbet sourceUrl', (t) => {
  atPinnedNow(t);
  // The persisted envelope's sourceUrl is the JSON-RPC endpoint, and the static
  // URL contract test regexes literals inside function bodies — so it cannot
  // catch a variable-sourced URL. This is the only place it is actually checked.
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  assert.ok(out.length > 0, 'the fixture must produce events');
  for (const e of out) {
    assert.match(
      e.sourceUrl,
      /^https:\/\/www\.favbet\.ro\/ro\/sports\/event\/[^/]+\/\d+\/$/,
      `sourceUrl must be a browseable event page, got ${e.sourceUrl}`
    );
  }
});

test('the event key is stable and does not depend on market ordering', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const first = s.extractEvents(s.normalize(raw()));

  // Reordering the markets of a row must not change its identity, or the same
  // fixture lands in the workspace under two keys and cannot pair.
  const shuffled = raw();
  for (const row of shuffled.markets) {
    if (row?.markets && !Array.isArray(row.markets)) {
      const entries = Object.entries(row.markets);
      for (const [k, v] of entries.reverse()) row.markets[k] = v;
    }
  }
  const second = s.extractEvents(s.normalize(shuffled));

  const keyOf = (list) => list.filter((e) => !/^\s*Goluri/i.test(e.homeTeam))
    .map((e) => `${e.homeTeam}|${e.awayTeam}|${e.kickoff}`).sort();
  assert.deepEqual(keyOf(first), keyOf(second), 'identity survives reordering');
});

test('KNOWN DEFECT: a synthetic totals pool is published as a football fixture', (t) => {
  atPinnedNow(t);
  // favbet lists totals pools such as "Goluri Gazde (8 Meciuri) v Goluri
  // Oaspeti (8 Meciuri)" as events with a complete 1X2 market. The adapter
  // publishes them, and because they sort to the front of the feed they can
  // consume a small `maxEvents` budget before any real fixture is reached —
  // observed live: 60 events published, all of them pools, while 540 real
  // football fixtures were available in the same response.
  //
  // This test pins the CURRENT behaviour deliberately. It is a finding, not an
  // endorsement: when the filter is added, this test is what should flip to
  // assert the pools are dropped, and its presence means that change cannot
  // land silently.
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  const pools = out.filter((e) => /^\s*Goluri/i.test(e.homeTeam) || /^\s*Goluri/i.test(e.awayTeam));

  assert.ok(pools.length > 0, 'the fixture keeps a pool row; if a filter lands, assert this is 0 instead');
  for (const p of pools) {
    assert.ok(p.markets.some((m) => m.key === 'MATCH_ODDS'), 'the pool is published as a match-result market');
  }
});

test('KNOWN DEFECT: markets are emitted more than once per event', (t) => {
  atPinnedNow(t);
  // Each real event in the capture carries DOUBLE_CHANCE four times and
  // BOTH_TEAMS_SCORE four times. Duplicate market keys mean the engine sees the
  // same contract repeatedly, which inflates the leg combinations it evaluates
  // and, more importantly, means the adapter's own market list cannot be trusted
  // to be one-entry-per-contract.
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  const real = out.filter((e) => !/^\s*Goluri/i.test(e.homeTeam));
  assert.ok(real.length > 0);

  for (const e of real) {
    const keys = e.markets.map((m) => m.key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.ok(dupes.length > 0, `${e.homeTeam} v ${e.awayTeam} should currently show duplicate market keys`);
  }
});

test('only the unqualified "both teams score" market may take the BTTS key', (t) => {
  atPinnedNow(t);
  // Favbet's feed carries several markets whose names all begin "Ambele echipe"
  // but which settle on different events:
  //
  //   "Ambele Marcheaza"                               both teams score          ✔
  //   "Ambele echipe marchează mai mult de 1.5 goluri"  both score OVER 1.5       ✘
  //   "Ambele echipe să înscrie în ambele reprize"     both score in BOTH halves  ✘
  //   "Ambele echipe vor executa câte un penalty"       both teams take a penalty  ✘
  //
  // Keying them all BOTH_TEAMS_SCORE put them in one engine bucket, so a
  // qualified price got paired against another book's plain BTTS leg and
  // reported as arbitrage. Observed on the 2026-09-28 scan: 126 opportunities
  // "confirmed" with a live re-quote; tracing each leg to its exact
  // selectionId showed 126 of 128 legs came from a qualified market (94
  // over-1.5, 23 under-1.5, 8 both-halves, 1 penalty) — the headline 92% ROI
  // was a both-halves price at 8.40 against another book's plain BTTS "No".
  //
  // The guard is the market NAME, so it is checked here against the real
  // capture's own market rows rather than a hand-written list.
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  assert.ok(out.length > 0, 'the fixture must produce events');

  const bttsNames = new Set();
  for (const e of out) {
    for (const m of e.markets) {
      if (m.key !== 'BOTH_TEAMS_SCORE') continue;
      bttsNames.add(m.name);
      assert.doesNotMatch(
        m.name,
        /\d/,
        `a market with a goal threshold is not plain BTTS: "${m.name}"`,
      );
      assert.doesNotMatch(
        m.name,
        /penalty|penalt/i,
        `a penalty market is not BTTS: "${m.name}"`,
      );
      assert.doesNotMatch(
        m.name,
        /ambele\s+(?:reprize|in\s+ambele)/i,
        `a both-halves market is not plain BTTS: "${m.name}"`,
      );
    }
  }
});

test('a qualified "Ambele ..." market is withheld rather than keyed as BTTS', (t) => {
  // Direct check on the classifier: feed it the exact market names observed on
  // the live endpoint and assert only the bare one survives. Pinned for the
  // same reason the capture tests are: the synthetic kickoff is derived from
  // PINNED_NOW, and the adapter drops anything already kicked off.
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  // The classifier reads a per-event market map, so each candidate needs a
  // distinct market_id (the 1X2 is skipped by id, and duplicate ids would make
  // one candidate look like the template-1 market) plus its own outcomes.
  let nextMarketId = 100;
  const candidate = (market_name) => ({
    bet_builder: false,
    market_id: (nextMarketId += 1),
    market_name,
    market_suspend: false,
    outcomes: [
      { outcome_id: 900, outcome_name: 'Da', outcome_short_name: 'Da', outcome_tag: 'Da', outcome_coef: 8.4, outcome_visible: true },
      { outcome_id: 901, outcome_name: 'Nu', outcome_short_name: 'Nu', outcome_tag: 'Nu', outcome_coef: 1.04, outcome_visible: true },
    ],
  });

  const matchOdds = {
    bet_builder: false,
    market_id: 99,
    market_name: '1 X 2',
    market_suspend: false,
    market_template_id: 1,
    outcomes: [
      { outcome_id: 1, outcome_name: 'Gazde', outcome_short_name: '1', outcome_tag: '1', outcome_coef: 2.1, outcome_visible: true },
      { outcome_id: 2, outcome_name: 'Egal', outcome_short_name: 'X', outcome_tag: 'X', outcome_coef: 3.4, outcome_visible: true },
      { outcome_id: 3, outcome_name: 'Oaspeți', outcome_short_name: '2', outcome_tag: '2', outcome_coef: 3.2, outcome_visible: true },
    ],
  };

  const markets = {
    match_odds: matchOdds,
    plain: candidate('Ambele Marcheaza'),
    overLine: candidate('Ambele echipe marchează mai mult de 1.5 goluri'),
    underLine: candidate('Ambele echipe marchează mai puțin de 1.5 goluri'),
    bothHalves: candidate('Ambele echipe să înscrie în ambele reprize'),
    penalties: candidate('Ambele echipe vor executa cate un penalty'),
  };

  const event = {
    event_id: 1,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 86400,
    participants: [
      { participant_number: 1, participant_name: 'Gazde' },
      { participant_number: 2, participant_name: 'Oaspeți' },
    ],
    category_name: 'Fotbal',
    tournament_name: 'Test',
    tournament_id: 'fotbal',
    event_status_type: 'notstarted',
  };

  // The adapter requires a top-level `markets` array of { event, markets } rows
  // and a non-empty `events` map; anything else fails the normalize guard.
  const envelope = {
    events: new Map([['1', event]]),
    markets: [{ event, markets }],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const out = s.extractEvents(s.normalize(envelope));
  const e = out.find((x) => String(x.id) === '1');
  assert.ok(e, 'the synthetic event is published');
  const btts = (e?.markets || []).filter((m) => m.key === 'BOTH_TEAMS_SCORE');

  assert.equal(btts.length, 1, 'exactly one market may claim the BTTS key');
  assert.equal(btts[0].name, 'Ambele Marcheaza', 'and it must be the plain one');
  assert.deepEqual(
    btts[0].selections.map((x) => `${x.name}@${x.odds}`),
    ['Yes@8.4', 'No@1.04'],
    'the plain market keeps its own prices',
  );

  // The qualified names must be gone entirely, not just re-keyed somewhere the
  // BTTS assertion misses: a "both halves" or "over 1.5" price still settles
  // differently and has no honest home in the cross-book comparison.
  const published = e.markets.map((m) => m.name);
  for (const withheld of [
    'Ambele echipe marchează mai mult de 1.5 goluri',
    'Ambele echipe marchează mai puțin de 1.5 goluri',
    'Ambele echipe să înscrie în ambele reprize',
    'Ambele echipe vor executa cate un penalty',
  ]) {
    assert.ok(!published.includes(withheld), `qualified market must be withheld: "${withheld}"`);
  }
});

test('a qualified double chance (corners / cards) is withheld, not keyed as match double chance', (t) => {
  // Favbet publishes "Șansă Dublă. Cornere" (corners double chance) alongside the
  // plain "Șansă dublă" (match double chance). Both match the same "dubl" name
  // test, so the corners market was claiming the DOUBLE_CHANCE key too. It
  // settles on corners, not on the 1X2, so it is a different contract and must
  // not share the family. (The engine marks DOUBLE_CHANCE arbEligible: false,
  // so this could not produce arbitrage today — but it is the same bug class as
  // the BTTS collision and must not be left as a landmine.)
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  const combo = (market_name, market_id) => ({
    bet_builder: false,
    market_id,
    market_name,
    market_suspend: false,
    outcomes: [
      { outcome_id: 10, outcome_name: '1X', outcome_short_name: '1X', outcome_tag: '1X', outcome_coef: 1.25, outcome_visible: true },
      { outcome_id: 11, outcome_name: '12', outcome_short_name: '12', outcome_tag: '12', outcome_coef: 1.05, outcome_visible: true },
      { outcome_id: 12, outcome_name: 'X2', outcome_short_name: 'X2', outcome_tag: 'X2', outcome_coef: 2.22, outcome_visible: true },
    ],
  });

  const markets = {
    match_odds: {
      bet_builder: false, market_id: 499, market_name: '1 X 2', market_suspend: false, market_template_id: 1,
      outcomes: [
        { outcome_id: 1, outcome_name: 'Gazde', outcome_short_name: '1', outcome_tag: '1', outcome_coef: 2.1, outcome_visible: true },
        { outcome_id: 2, outcome_name: 'Egal', outcome_short_name: 'X', outcome_tag: 'X', outcome_coef: 3.4, outcome_visible: true },
        { outcome_id: 3, outcome_name: 'Oaspeți', outcome_short_name: '2', outcome_tag: '2', outcome_coef: 3.2, outcome_visible: true },
      ],
    },
    plainDC: combo('Șansă dublă', 501),
    cornersDC: combo('Șansă Dublă. Cornere', 502),
    cardsDC: combo('Șansă dublă cartonașe', 503),
  };

  const event = {
    event_id: 2,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 86400,
    participants: [
      { participant_number: 1, participant_name: 'Gazde' },
      { participant_number: 2, participant_name: 'Oaspeți' },
    ],
    category_name: 'Fotbal', tournament_name: 'Test', tournament_id: 'fotbal',
    event_status_type: 'notstarted',
  };

  const envelope = {
    events: new Map([['2', event]]),
    markets: [{ event, markets }],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const out = s.extractEvents(s.normalize(envelope));
  const e = out.find((x) => String(x.id) === '2');
  assert.ok(e, 'the synthetic event is published');
  const dc = (e.markets || []).filter((m) => m.key === 'DOUBLE_CHANCE');
  assert.equal(dc.length, 1, 'only the match double chance may hold the key');
  assert.equal(dc[0].name, 'Șansă dublă', 'and it must be the plain one');
  assert.ok(
    !e.markets.some((m) => m.name === 'Șansă Dublă. Cornere'),
    'the corners double chance must be withheld',
  );
  assert.ok(
    !e.markets.some((m) => m.name === 'Șansă dublă cartonașe'),
    'the cards double chance must be withheld — it settles on cards, not the 1X2',
  );
});

test('the same market name at three settlement windows yields three separate periods', (t) => {
  // Favbet publishes ONE unqualified name per contract and repeats it at every
  // window, with the window carried only in `result_type_name`. Event 43441222
  // on the live feed carried all three of these, named identically:
  //
  //   "Ambele Marcheaza"  Timp Regulamentar  Da 2.08  Nu 1.72
  //   "Ambele Marcheaza"  Prima repriză     Da 5.25  Nu 1.13
  //   "Ambele Marcheaza"  A doua repriză    Da 4.02  Nu 1.21
  //
  // The adapter derived the period from the market NAME, which is the same in
  // all three rows, so every one of them was stamped `fulltime` and collapsed
  // into a single bucket. The engine keeps the best price per side per source,
  // so it paired Yes 5.25 (first half) against No 1.72 (full time) — two
  // different settlement windows presented as one contract. Measured across the
  // stored captures that fabricated 174 BTTS arbitrages against other books at
  // a ~25% median ROI, 159 of them the single pair favbet+unibet.
  //
  // A name cannot disambiguate a name, so the period has to come from the
  // provider's own window field.
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  let nextId = 700;
  const window_ = (result_type_name, result_type_short_name, yesOdds, noOdds) => ({
    bet_builder: false,
    market_id: (nextId += 1),
    market_name: 'Ambele Marcheaza',
    market_suspend: false,
    market_template_id: 779,
    result_type_name,
    result_type_short_name,
    outcomes: [
      { outcome_id: nextId * 10 + 1, outcome_name: 'Da', outcome_short_name: 'Da', outcome_tag: '1', outcome_coef: yesOdds, outcome_visible: true },
      { outcome_id: nextId * 10 + 2, outcome_name: 'Nu', outcome_short_name: 'Nu', outcome_tag: '2', outcome_coef: noOdds, outcome_visible: true },
    ],
  });

  const matchOdds = {
    bet_builder: false, market_id: 699, market_name: '1 X 2', market_suspend: false, market_template_id: 1,
    outcomes: [
      { outcome_id: 1, outcome_name: 'Gazde', outcome_short_name: '1', outcome_tag: '1', outcome_coef: 2.1, outcome_visible: true },
      { outcome_id: 2, outcome_name: 'Egal', outcome_short_name: 'X', outcome_tag: 'X', outcome_coef: 3.4, outcome_visible: true },
      { outcome_id: 3, outcome_name: 'Oaspeți', outcome_short_name: '2', outcome_tag: '2', outcome_coef: 3.2, outcome_visible: true },
    ],
  };

  const event = {
    event_id: 3,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 86400,
    participants: [
      { participant_number: 1, participant_name: 'Gazde' },
      { participant_number: 2, participant_name: 'Oaspeți' },
    ],
    category_name: 'Fotbal', tournament_name: 'Test', tournament_id: 'fotbal',
    event_status_type: 'notstarted',
  };

  const markets = {
    match_odds: matchOdds,
    fulltime: window_('Timp Regulamentar', 'Tr', 2.08, 1.72),
    first: window_('Prima repriză', 'Rp1', 5.25, 1.13),
    second: window_('A doua repriză', 'Rp2', 4.02, 1.21),
  };

  const envelope = {
    events: new Map([['3', event]]),
    markets: [{ event, markets }],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const out = s.extractEvents(s.normalize(envelope));
  const e = out.find((x) => String(x.id) === '3');
  assert.ok(e, 'the synthetic event is published');
  const btts = (e.markets || []).filter((m) => m.key === 'BOTH_TEAMS_SCORE');

  assert.equal(btts.length, 3, 'all three windows are published, not collapsed into one');
  assert.deepEqual(
    btts.map((m) => m.period).sort(),
    ['fulltime', 'half1', 'half2'],
    'each window carries its own period',
  );

  // The decisive assertion: a leg may not mix windows. Each market's own Yes and
  // No must sit in the same window, which is what an inverse sum below 1 across
  // two windows would otherwise fake. The real prices are the ones above, so the
  // full-time pair (2.08/1.72) must not appear carrying a half1/half2 period.
  const byPeriod = new Map(btts.map((m) => [m.period, m]));
  assert.deepEqual(
    byPeriod.get('fulltime').selections.map((x) => `${x.name}@${x.odds}`),
    ['Yes@2.08', 'No@1.72'],
    'the full-time window keeps its own prices',
  );
  assert.deepEqual(
    byPeriod.get('half1').selections.map((x) => `${x.name}@${x.odds}`),
    ['Yes@5.25', 'No@1.13'],
    'the first-half window keeps its own prices',
  );
  assert.deepEqual(
    byPeriod.get('half2').selections.map((x) => `${x.name}@${x.odds}`),
    ['Yes@4.02', 'No@1.21'],
    'the second-half window keeps its own prices',
  );
});

test('BTTS sides are matched by outcome name, not the inconsistent outcome_tag', (t) => {
  // The provider's `outcome_tag` is an internal index, not a side name, and it
  // is not consistent across a market's windows. On the live feed template 779
  // carried tag "1"/"2" on the full-time and first-half rows but null on the
  // second-half row, where the side then came from the short name.
  //
  // Matching on `tag` therefore found a side only on whichever rows happened to
  // omit it, so favbet's first-half and full-time BTTS were silently dropped and
  // the ONLY BTTS that reached the engine was the second-half one — stamped
  // `fulltime` by the name-derived period. That is the leg behind the 174
  // fabricated arbitrages. `outcome_name` ("Da"/"Nu") is stable across windows.
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  const matchOdds = {
    bet_builder: false, market_id: 799, market_name: '1 X 2', market_suspend: false, market_template_id: 1,
    outcomes: [
      { outcome_id: 1, outcome_name: 'Gazde', outcome_short_name: '1', outcome_tag: '1', outcome_coef: 2.1, outcome_visible: true },
      { outcome_id: 2, outcome_name: 'Egal', outcome_short_name: 'X', outcome_tag: 'X', outcome_coef: 3.4, outcome_visible: true },
      { outcome_id: 3, outcome_name: 'Oaspeți', outcome_short_name: '2', outcome_tag: '2', outcome_coef: 3.2, outcome_visible: true },
    ],
  };

  // Both rows are named identically; they differ ONLY in the tag, which is the
  // numeric "1"/"2" form that a name-based matcher cannot read.
  const tagged = (id, tag, yesOdds, noOdds) => ({
    bet_builder: false, market_id: id, market_name: 'Ambele Marcheaza', market_suspend: false,
    market_template_id: 779, result_type_name: 'Timp Regulamentar', result_type_short_name: 'Tr',
    outcomes: [
      { outcome_id: id * 10 + 1, outcome_name: 'Da', outcome_short_name: 'Da', outcome_tag: tag[0], outcome_coef: yesOdds, outcome_visible: true },
      { outcome_id: id * 10 + 2, outcome_name: 'Nu', outcome_short_name: 'Nu', outcome_tag: tag[1], outcome_coef: noOdds, outcome_visible: true },
    ],
  });

  const event = {
    event_id: 4,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 86400,
    participants: [
      { participant_number: 1, participant_name: 'Gazde' },
      { participant_number: 2, participant_name: 'Oaspeți' },
    ],
    category_name: 'Fotbal', tournament_name: 'Test', tournament_id: 'fotbal',
    event_status_type: 'notstarted',
  };

  // One row with numeric tags, one with null tags — the two real shapes.
  const numericTag = tagged(801, ['1', '2'], 2.08, 1.72);
  const nullTag = tagged(802, [null, null], 4.02, 1.21);
  const markets = { match_odds: matchOdds, a: numericTag, b: nullTag };

  const envelope = {
    events: new Map([['4', event]]),
    markets: [{ event, markets }],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const out = s.extractEvents(s.normalize(envelope));
  const e = out.find((x) => String(x.id) === '4');
  assert.ok(e, 'the synthetic event is published');
  const btts = (e.markets || []).filter((m) => m.key === 'BOTH_TEAMS_SCORE');

  // A tag-keyed matcher emits only the row whose tag is null. Both must survive,
  // otherwise the feed silently loses a whole settlement window.
  assert.equal(btts.length, 2, 'both rows are published regardless of their outcome_tag');
  const prices = btts.map((m) => m.selections.map((x) => `${x.name}@${x.odds}`).join('/')).sort();
  assert.deepEqual(prices, ['Yes@2.08/No@1.72', 'Yes@4.02/No@1.21'], 'each row keeps its own sides');
});

test('the adapter reports a missing or malformed envelope rather than an empty success', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  assert.throws(() => s.normalize({ markets: [] }), /no favbet events/);
  assert.throws(() => s.normalize({ events: { size: 1 }, markets: [] }), /no favbet market payloads/);

  // A row whose 1X2 is gone publishes nothing for that row. Scoped to the
  // mutated row only: the fixture holds several events, and emptying one does
  // not empty the run, which is exactly the distinction this project cares
  // about — a row that stops yielding must drop, not degrade into a partial
  // market that could pair against a full one somewhere else.
  const broken = raw();
  const victim = broken.markets[0];
  const victimId = String(victim.event.event_id);
  victim.markets = {};
  const out = s.extractEvents(s.normalize(broken));
  assert.equal(out.length, broken.markets.length - 1, 'exactly the broken row is dropped');
  assert.ok(!out.some((e) => String(e.id) === victimId), 'the broken row is not published');
});

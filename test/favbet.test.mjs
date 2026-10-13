/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Favbet, { FAVBET_SPORT_ID_MAP, FAVBET_SPORT_NAME_TO_ID } from '../src/scrapers/favbet.mjs';
import {
  resolveContract, isFullTimeMarket, bucketKeyForContract,
} from '../src/scanner/market-contracts.mjs';
import { groupByEvent, findArbitrage } from '../src/scanner/engine.mjs';

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

test('a synthetic totals pool is no longer published as a football fixture', (t) => {
  atPinnedNow(t);
  // favbet lists totals pools such as "Goluri Gazde (8 Meciuri) v Goluri
  // Oaspeti (8 Meciuri)" as events with a complete 1X2 market. The adapter used
  // to publish them, and because they sort to the front of the feed they could
  // consume a small `maxEvents` budget before any real fixture is reached —
  // observed live: 60 events published, all of them pools, while 540 real
  // football fixtures were available in the same response.
  //
  // This test pinned that behaviour on purpose, as a finding rather than an
  // endorsement, and said which assertion should replace it once a filter
  // landed. The filter is `isMultiMatchTie`: the provider declares the aggregate
  // in the event's own 1X2 text — "Goluri Gazde (8 Meciuri)" — so this reads a
  // declaration rather than inferring one from a name. It is also the reading
  // that keeps the goals families honest, because the pool's handicap lines are
  // half lines like any other and would otherwise enter the engine as match
  // handicaps.
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  const pools = out.filter((e) => /^\s*Goluri/i.test(e.homeTeam) || /^\s*Goluri/i.test(e.awayTeam));

  assert.deepEqual(pools, [], 'the aggregate is dropped whole, not degraded');
  assert.equal(out.length, 2, 'the two real fixtures are published and nothing else');
  for (const e of out) {
    assert.ok(
      !/^\s*Goluri/i.test(e.homeTeam) && !/^\s*Goluri/i.test(e.awayTeam),
      'no published event is an aggregate',
    );
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

/**
 * The stored captures predate that guard, and the difference is measurable.
 *
 * favbet_events.json in data-market-run/workspace keys three distinct market
 * names to BOTH_TEAMS_SCORE and every one of them is a qualified form this
 * adapter now withholds. So that capture is not evidence about what the adapter
 * writes today — which matters, because a census in another file was leaning on
 * it for exactly that: the plan.family excuse in test/event-detail-payload.test.mjs
 * read the walk over that directory as covering the contract space, and every
 * plan the walk found was BTTS resting on these rows. That excuse no longer
 * claims it; this is the measurement behind the change.
 *
 * The names are the capture's own, not a list typed here, and each one goes
 * through the real `extractEvents` — so this measures the writer rather than
 * restating the guard, which is the whole reason it is a second test.
 */
test('the stored capture keys BTTS to rows this adapter now withholds', (t) => {
  atPinnedNow(t);
  const doc = JSON.parse(readFileSync(new URL('../data-market-run/workspace/favbet_events.json', import.meta.url), 'utf8'));
  const names = new Set();
  let rows = 0;
  for (const ev of doc.events || []) {
    for (const m of ev.markets || []) {
      if (m.key !== 'BOTH_TEAMS_SCORE') continue;
      rows += 1;
      names.add(m.name);
    }
  }
  assert.ok(names.size >= 2, `the capture should carry more than one BTTS name, got ${names.size} over ${rows} rows — the walk below measures nothing`);

  // 779 is the template the adapter's own docstring names for BTTS; the leg text
  // is "Da"/"Nu", which is the reading the yes/no match uses.
  const btts = (marketId, name) => ({
    market_id: marketId, market_name: name, market_suspend: false, market_template_id: 779,
    result_type_name: 'Timp Regulamentar', result_type_short_name: 'Tr',
    outcomes: [leg(marketId * 10 + 1, '1', 'Da', 1.8), leg(marketId * 10 + 2, '2', 'Nu', 2.05)],
  });

  const s = new Favbet({ windowHours: 72 });
  let eventId = 5000;
  const emitsBtts = (name) => {
    eventId += 10;
    const out = s.extractEvents(s.normalize(envelopeWith([btts(eventId, name)], { home: 'Gazde', away: 'Oaspeti', eventId })));
    return (out[0]?.markets || []).some((m) => m.key === 'BOTH_TEAMS_SCORE');
  };

  // The control, and it is the reason the assertion below can be trusted. A walk
  // that reports nothing is a walk that cannot report anything: the unqualified
  // name from the adapter's own fixture has to come out as BTTS, or "no rows
  // emitted" would be indistinguishable from a broken yes/no resolution.
  assert.ok(emitsBtts('Ambele Marcheaza'),
    'this adapter no longer emits BTTS at all, so a withheld capture row proves nothing — read the branch before believing the finding below');

  const emitted = [];
  const withheld = [];
  for (const name of names) (emitsBtts(name) ? emitted : withheld).push(name);
  assert.deepEqual(emitted, [],
    `the favbet capture holds a plain BTTS row after all (${emitted.join(' | ')}) — the captures are current again, and the excuse in event-detail-payload.test.mjs can lean on them`);
  assert.deepEqual(withheld.length, names.size,
    `${withheld.length} of ${names.size} BTTS names were withheld; re-read which one slipped through`);
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

/* ------------------------------------------------------------------------- *
 * The two goals families: template 50 "Peste / Sub" and template 190 "Handicap"
 *
 * Both were dropped whole before this, in two independent ways, and both failures
 * were silent — no error, no empty market, just a contract that never arrived.
 *
 *   1. The threshold is in the leg's own text ("peste (2.5)"), never in the
 *      market name ("Peste / Sub", no number), so the line extractor returned
 *      null and both branches bailed before pricing anything.
 *   2. The handicap's side cannot be read from `outcome_tag`. On template 190
 *      that field is populated on 672 of 4,294 full-time rows, and — this is the
 *      part that makes a tag-keyed reader look plausible — it is populated on
 *      the WHOLE lines and null on the HALF lines. So the tag resolves the
 *      markets this adapter refuses and loses the ones it is for. 80 markets
 *      were published against 1,598 once the side came from the club name.
 *
 * The prices below are the capture's own, in `test/fixtures/favbet.json`.
 * ------------------------------------------------------------------------- */

test('the real capture publishes every full-time goals total, one market per line', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));

  // The fixture holds three events, one of which is a multi-match tie and is
  // withheld by its own 1X2 text (tested separately below).
  const byId = new Map(out.map((e) => [String(e.id), e]));
  const latvia = byId.get('43432785');
  const moldova = byId.get('43432794');
  assert.ok(latvia && moldova, 'both real two-team fixtures are published');

  const totals = (e, period = 'fulltime') => (e.markets || [])
    .filter((m) => m.key === 'TOTAL_GOALS' && m.period === period);
  // Letonia v Cipru quotes 0.5 through 4.5; Moldova v Insulele Feroe the same
  // five. Whole lines (1.0, 2.0, 3.0, 4.0) are in the capture and are NOT here:
  // they push, so the pair is not exhaustive.
  assert.deepEqual(totals(latvia).map((m) => m.line), [0.5, 1.5, 2.5, 3.5, 4.5]);
  assert.deepEqual(totals(moldova).map((m) => m.line), [0.5, 1.5, 2.5, 3.5, 4.5]);
  assert.deepEqual(totals(latvia, 'half1').map((m) => m.line), [0.5, 1.5, 2.5]);

  // Verbatim, lowest line: "Peste (0.5)" 1.08 / "Sub (0.5)" 7.40.
  const lowest = totals(latvia)[0];
  assert.equal(lowest.providerMarketId, '50:0.5');
  assert.equal(lowest.name, 'Peste / Sub');
  assert.equal(lowest.period, 'fulltime');
  assert.deepEqual(lowest.selections.map((x) => x.name), ['Over 0.5', 'Under 0.5']);
  assert.deepEqual(lowest.selections.map((x) => x.odds), [1.08, 7.4]);

  // And the highest on the other event: "Peste (4.5)" 10.30 / "Sub (4.5)" 1.03.
  const highest = totals(moldova)[4];
  assert.equal(highest.providerMarketId, '50:4.5');
  assert.deepEqual(highest.selections.map((x) => x.name), ['Over 4.5', 'Under 4.5']);
  assert.deepEqual(highest.selections.map((x) => x.odds), [10.3, 1.03]);

  // The direction, asserted on the PUBLISHED output rather than on the raw
  // words. "peste" and "sub" were the two words this branch had to tell apart,
  // and a map with them the wrong way round still produces two well-formed
  // legs that pass every literal assertion above. Raising the threshold makes
  // Over longer and Under shorter, and both events' ladders do exactly that.
  for (const e of [latvia, moldova]) {
    const byLine = (m) => Object.fromEntries(
      m.selections.map((s) => [s.name.split(' ')[0], s.odds]),
    );
    const board = totals(e);
    for (let i = 0; i + 1 < board.length; i += 1) {
      const low = byLine(board[i]);
      const high = byLine(board[i + 1]);
      assert.ok(
        high.Over > low.Over,
        `Over must get longer as the line rises — line ${board[i].line} Over ${low.Over}, `
        + `line ${board[i + 1].line} Over ${high.Over}`,
      );
      assert.ok(
        high.Under < low.Under,
        `Under must get shorter as the line rises — line ${board[i].line} Under ${low.Under}, `
        + `line ${board[i + 1].line} Under ${high.Under}`,
      );
    }
  }
});

test('the real capture publishes only safe full-time match-corners totals', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  const latvia = out.find((e) => String(e.id) === '43432785');
  assert.ok(latvia, 'the captured fixture is published');

  const corners = (latvia.markets || []).filter((m) => m.key === 'CNOU');
  assert.equal(corners.length, 1, 'only the half-line match-corners total is emitted');
  const market = corners[0];
  assert.equal(market.providerMarketId, '1104:9.5');
  assert.equal(market.period, 'fulltime');
  assert.deepEqual(market.selections.map((s2) => s2.name), ['Over 9.5', 'Under 9.5']);

  const contract = resolveContract(market);
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.period, 'fulltime');
  assert.equal(contract.lineKey, '9.5');
  assert.equal(contract.subject, 'corners');
  assert.equal(contract.team, 'match');

  const cornerBucket = bucketKeyForContract('', contract);
  const goalBucket = bucketKeyForContract('', resolveContract({
    key: 'TOTAL_GOALS',
    name: 'Peste / Sub',
    period: 'fulltime',
    selections: [
      { name: 'Over 9.5', odds: 1.9 },
      { name: 'Under 9.5', odds: 1.9 },
    ],
  }));
  assert.notEqual(cornerBucket, goalBucket, 'corners never share a goals-total bucket');
  assert.ok(
    !(latvia.markets || []).some((m) => String(m.providerMarketId || '').startsWith('914:')),
    'team-corners totals remain withheld until team identity is modelled',
  );
});

test('the real capture publishes every full-time goals handicap, one market per line', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  const byId = new Map(out.map((e) => [String(e.id), e]));

  const hands = (e) => (e.markets || []).filter((m) => m.key === 'ASIAN_HANDICAP');
  // Letonia v Cipru quotes -2.5, -1.5, +1.5, +2.5; Moldova v Insulele Feroe
  // -1.5, +1.5, +2.5. The (0.0) lines in the capture are whole lines and are
  // absent; so are the (-2.0), (-1.0), (+1.0) and (+2.0) lines.
  assert.deepEqual(hands(byId.get('43432785')).map((m) => m.line), [-2.5, -1.5, 1.5, 2.5]);
  assert.deepEqual(hands(byId.get('43432794')).map((m) => m.line), [-1.5, 1.5, 2.5]);

  // Verbatim, the favourite's line: "Letonia (-2.5)" 12.70 / "Cipru (+2.5)" 1.02.
  // Letonia is side 1 and receives -2.5; a 1.02 on the outsider covers everything
  // up to a three-goal home win, and 12.70 is the far tail. Swapping the two
  // would file a 12.70 on the side that cannot lose.
  const strongest = hands(byId.get('43432785'))[0];
  assert.equal(strongest.providerMarketId, '190:-2.5');
  assert.equal(strongest.name, 'Handicap');
  assert.equal(strongest.period, 'fulltime');
  assert.deepEqual(strongest.selections.map((x) => x.name), ['1 (-2.5)', '2 (+2.5)']);
  assert.deepEqual(strongest.selections.map((x) => x.odds), [12.7, 1.02]);

  // Every published pair must be an exact negation, and the two sides must not
  // agree on a line: a market whose legs cancel to the same number is one
  // number twice, not a two-way contract.
  for (const e of out) {
    for (const m of hands(e)) {
      assert.equal(m.selections.length, 2, `${m.providerMarketId} has exactly two legs`);
      const [h, a] = m.selections;
      assert.ok(h.name.startsWith('1 ('), 'the home leg is named as side 1');
      assert.ok(a.name.startsWith('2 ('), 'the away leg is named as side 2');
      const hl = Number(h.name.slice(3, -1));
      const al = Number(a.name.slice(3, -1));
      assert.ok(Math.abs(hl + al) < 1e-9, `${m.providerMarketId} legs cancel: ${hl} / ${al}`);
      assert.notEqual(hl, al, `${m.providerMarketId} legs are not the same line twice`);
      assert.ok(Number.isInteger(Math.abs(hl) * 2) && !Number.isInteger(Math.abs(hl)),
        `${m.providerMarketId} is on the half, which is what makes it exhaustive`);
    }
  }
});

test('a handicap resolves its side with no outcome_tag at all', (t) => {
  // The regression in one fixture. Both legs carry tag null — the shape the feed
  // serves for 84% of full-time rows, and the shape every half line arrives in,
  // because the tag is filled on the whole lines. A tag-keyed reader publishes
  // nothing here; the club name inside each leg is what identifies the side.
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(envelopeWith([
    handicap(701, 'Timp Regulamentar', [
      leg(7011, null, 'Slovacia (-1.5)', 1.64),
      leg(7012, null, 'Kazakhstan (+1.5)', 2.28),
    ]),
  ], { home: 'Slovacia', away: 'Kazakhstan' })));

  const e = out[0];
  const hands = (e.markets || []).filter((m) => m.key === 'ASIAN_HANDICAP');
  assert.equal(hands.length, 1, 'the market is published without a single tag');
  assert.deepEqual(hands[0].selections.map((x) => x.name), ['1 (-1.5)', '2 (+1.5)']);
  assert.deepEqual(hands[0].selections.map((x) => x.odds), [1.64, 2.28]);
});

test('the threshold is the LAST number in a leg, not the first', (t) => {
  // Football clubs are named after years, and favbet writes the club into each
  // handicap leg: "Bayer 04 Leverkusen (+1.5)". 35 of 676 live events have a
  // club with a digit in its name — Bayer 04 Leverkusen, TSG 1899 Hoffenheim,
  // Hannover 96, Fleury 91 FC, Bohemians 1905 — and 258 of their real full-time
  // goals legs carry a number before the threshold. A reader that took the
  // first number would read 04, or 1899, or 96 as the line, call it a whole
  // number, and refuse the market: silently losing every handicap on those
  // clubs. The prices below are the test's own; the club name and the leg text
  // are the feed's, which is the part the rule is about.
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(envelopeWith([
    handicap(706, 'Timp Regulamentar', [
      leg(7061, null, 'Lech Poznan (-1.5)', 2.66),
      leg(7062, null, 'Bayer 04 Leverkusen (+1.5)', 1.49),
    ]),
  ], { home: 'Lech Poznan', away: 'Bayer 04 Leverkusen' })));

  const hands = (out[0].markets || []).filter((m) => m.key === 'ASIAN_HANDICAP');
  assert.equal(hands.length, 1, 'a club with a year in its name does not cost it the market');
  assert.equal(hands[0].line, -1.5, 'the line is the threshold, not the 04');
  assert.deepEqual(hands[0].selections.map((x) => x.name), ['1 (-1.5)', '2 (+1.5)']);
});

test('the outcome_tag is a check on the side, not the way to find it', (t) => {
  // Where the provider does fill the tag in it agreed with the club name on
  // 700 of 700 comparisons, so a tag that contradicts the name means the row
  // is not what it appears to be. Both cases are refused rather than resolved
  // in favour of either reading.
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  const agree = s.extractEvents(s.normalize(envelopeWith([
    handicap(702, 'Timp Regulamentar', [
      leg(7021, '1', 'Slovacia (-1.5)', 1.64),
      leg(7022, '2', 'Kazakhstan (+1.5)', 2.28),
    ]),
  ], { home: 'Slovacia', away: 'Kazakhstan' })));
  assert.equal(
    (agree[0].markets || []).filter((m) => m.key === 'ASIAN_HANDICAP').length,
    1,
    'a tag that agrees does not veto the market',
  );

  for (const [label, homeTag, awayTag] of [
    ['swapped', '2', '1'],
    ['both home', '1', '1'],
  ]) {
    const clash = s.extractEvents(s.normalize(envelopeWith([
      handicap(703, 'Timp Regulamentar', [
        leg(7031, homeTag, 'Slovacia (-2.5)', 2.66),
        leg(7032, awayTag, 'Kazakhstan (+2.5)', 1.49),
      ]),
    ], { home: 'Slovacia', away: 'Kazakhstan' })));
    assert.equal(
      (clash[0].markets || []).filter((m) => m.key === 'ASIAN_HANDICAP').length,
      0,
      `a ${label} tag contradicts the leg names, so the market is refused`,
    );
  }
});

test('a handicap whose two legs cannot be told apart is refused, and one club inside another is not that', (t) => {
  // "Hodd (-1.0)" against home "Hodd" / away "Odd" is the only pair in 675
  // sampled where one club's name sits inside the other's, so both names are
  // substrings of the home leg. A plain substring test reads the away club out
  // of the home leg's name and files this market with its sides swapped. The
  // match is on word boundaries, so it resolves — and this test is what says
  // which way round it must resolve, since "it published something" would pass
  // just as well with the legs exchanged.
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  const nested = s.extractEvents(s.normalize(envelopeWith([
    handicap(704, 'Timp Regulamentar', [
      leg(7041, null, 'Hodd (-1.5)', 2.66),
      leg(7042, null, 'Odd (+1.5)', 1.49),
    ]),
  ], { home: 'Hodd', away: 'Odd' })));
  const nestedHands = (nested[0].markets || []).filter((m) => m.key === 'ASIAN_HANDICAP');
  assert.equal(nestedHands.length, 1, 'the nested pair still resolves');
  assert.deepEqual(
    nestedHands[0].selections.map((x) => `${x.name}@${x.odds}`),
    ['1 (-1.5)@2.66', '2 (+1.5)@1.49'],
    'the home club keeps its own line, and the club named inside it does not steal it',
  );

  // The two shapes with no reading at all. Neither may be published: the first
  // is one club twice, which is not two sides, and the second names neither.
  const refused = [
    ['the same club on both legs', 'Hodd (-1.5)', 'Hodd (+1.5)'],
    ['neither leg names a club', 'Cote (-1.5)', 'Visiteur (+1.5)'],
  ];
  for (const [label, homeLeg, awayLeg] of refused) {
    const out = s.extractEvents(s.normalize(envelopeWith([
      handicap(705, 'Timp Regulamentar', [
        leg(7051, null, homeLeg, 2.66),
        leg(7052, null, awayLeg, 1.49),
      ]),
    ], { home: 'Hodd', away: 'Odd' })));
    assert.equal(
      (out[0].markets || []).filter((m) => m.key === 'ASIAN_HANDICAP').length,
      0,
      `refused when ${label}`,
    );
  }
});

test('the goals families refuse every non-exhaustive or undeclared shape', (t) => {
  // Each row below is refused for a different reason, and each reason is one the
  // live feed actually produces. Publishing any of them would put a push-capable
  // pair or a mixed-window pair into an exhaustive bucket, which is how an
  // inverse sum below 1 stops meaning "no risk".
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  const refused = [
    // First-half goals totals are now explicitly supported as their own period;
    // second-half contracts still await an independent counterpart.
    ['a second-half goals total', total(710, 'A doua repriză', 1.5, 3.36, 1.30), {}],
    ['a second-half handicap', handicap(711, 'A doua repriză', [
      leg(7111, null, 'Slovacia (-1.5)', 9.2), leg(7112, null, 'Kazakhstan (+1.5)', 1.03),
    ]), {}],
    // A whole line pushes both legs; a quarter line pushes half of one.
    ['a whole-number total', total(712, 'Timp Regulamentar', 2.0, 1.77, 2.09), {}],
    ['a quarter-line handicap', handicap(713, 'Timp Regulamentar', [
      leg(7131, null, 'Slovacia (-1.25)', 6.10), leg(7132, null, 'Kazakhstan (+1.25)', 1.24),
    ]), {}],
    // The window is not declared, so it is not full time.
    ['a total with no window', total(714, null, 2.5, 1.77, 2.09), {}],
    // One leg is not priced. A one-sided market is a side that always wins and
    // a side that never does.
    ['a total missing its Under leg', {
      market_id: 715, market_name: 'Peste / Sub', market_suspend: false, market_template_id: 50,
      result_type_name: 'Timp Regulamentar', result_type_short_name: 'Tr',
      outcomes: [leg(7151, '2', 'Peste (2.5)', 1.77)],
    }, {}],
    // The legs disagree about the threshold: not one market.
    ['legs quoting different lines', {
      market_id: 716, market_name: 'Peste / Sub', market_suspend: false, market_template_id: 50,
      result_type_name: 'Timp Regulamentar', result_type_short_name: 'Tr',
      outcomes: [leg(7161, '2', 'Peste (2.5)', 1.77), leg(7162, '1', 'Sub (3.5)', 1.83)],
    }, {}],
    // The two thresholds are not negations, so there is no handicap to settle.
    ['handicap legs that do not cancel', handicap(717, 'Timp Regulamentar', [
      leg(7171, null, 'Slovacia (-1.5)', 1.64), leg(7172, null, 'Kazakhstan (+1.0)', 2.28),
    ]), {}],
    // A suspended row is not a price.
    ['a suspended total', { ...total(718, 'Timp Regulamentar', 2.5, 1.77, 2.09), market_suspend: true }, {}],
  ];

  for (const [label, market] of refused) {
    const out = s.extractEvents(s.normalize(envelopeWith([
      market,
    ], { home: 'Slovacia', away: 'Kazakhstan' })));
    const e = out[0];
    assert.ok(e, 'the fixture event itself is still published');
    const goals = (e.markets || []).filter((m) => m.key === 'TOTAL_GOALS' || m.key === 'ASIAN_HANDICAP');
    assert.equal(goals.length, 0, `refused: ${label}`);
  }
});

test('the two goals families survive the real router and land in exhaustive buckets', (t) => {
  // The adapter emitting a well-formed market does not mean the engine will
  // arbitrate it. A total published as "Over 2.5" with the wrong key, or a
  // handicap whose selection names lose their signs, buckets somewhere useless
  // or nowhere at all — and the engine never complains, it just finds nothing.
  // So this drives the real resolveContract and bucketKeyForContract.
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));

  const buckets = new Map();
  for (const e of out) {
    for (const m of e.markets || []) {
      if (m.key !== 'TOTAL_GOALS' && m.key !== 'ASIAN_HANDICAP') continue;
      const c = resolveContract(m);
      assert.ok(c, `${m.providerMarketId} resolves to a contract`);
      assert.notEqual(c.arbEligible, false, `${m.providerMarketId} is arbitrable`);
      assert.ok(
        isFullTimeMarket(m) || m.period === 'half1',
        `${m.providerMarketId} is full-time or the explicitly supported first-half contract`,
      );
      const bucket = bucketKeyForContract('', c).replace(/^::/, '');
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
  }

  // Both ladders are present and every bucket names a single line pair.
  //
  // The key ends in `::goals::match` because the subject and team dimensions are
  // part of the bucket identity: this feed publishes its totals as the MATCH's
  // goals, so they file under `goals` and `match` rather than under a placeholder.
  // The ASIAN_HANDICAP rows end in `::_::_` because a handicap carries no subject
  // or team — see the note on the generic resolver about why that family was
  // deliberately left alone.
  //
  // Only the PREFIX of a key is asserted here, not the whole string, so adding a
  // dimension to the key does not silently invalidate this test again. The
  // per-bucket checks below still read index 2 for the line.
  assert.ok([...buckets.keys()].some((k) => k.startsWith('OVER_UNDER::fulltime::2.5::over+under')), 'the 2.5 total is arbitrable');
  assert.ok([...buckets.keys()].some((k) => k.startsWith('OVER_UNDER::half1::1.5::over+under')), 'the first-half 1.5 total is arbitrable in its own bucket');
  assert.ok([...buckets.keys()].some((k) => k.startsWith('OVER_UNDER::fulltime::3.5::over+under')), 'the 3.5 total is arbitrable');
  assert.ok([...buckets.keys()].some((k) => k.startsWith('ASIAN_HANDICAP::fulltime::-1.5/1.5::home+away')), 'the -1.5 handicap is arbitrable');
  assert.ok([...buckets.keys()].some((k) => k.startsWith('ASIAN_HANDICAP::fulltime::1.5/-1.5::home+away')), 'the +1.5 handicap is a separate bucket');

  // The favbet feed publishes MATCH goals totals, so the subject and team the
  // resolver chose must be exactly these — a regression that defaulted a total
  // to a per-team or non-goal reading would pass every assertion above and still
  // bucket this market against the wrong counterparty.
  for (const [bucket] of buckets) {
    if (!bucket.startsWith('OVER_UNDER::')) continue;
    assert.ok(bucket.endsWith('::goals::match'), `${bucket} is the match's goals total`);
  }

  for (const [bucket, n] of buckets) {
    assert.ok(n > 0, `${bucket} is populated`);
    if (bucket.startsWith('OVER_UNDER')) {
      const line = Number(bucket.split('::')[2]);
      assert.ok(Number.isInteger(line * 2) && !Number.isInteger(line), `${bucket} is on the half`);
    } else {
      const [home, away] = bucket.split('::')[2].split('/');
      assert.equal(Number(home), -Number(away), `${bucket} is a cancelling pair`);
    }
  }
});

test('favbet never disagrees with itself', (t) => {
  // One book cannot arbitrage against its own prices, so any "arbitrage" here is
  // a bug in grouping or bucketing — a side filed twice, or a market paired with
  // its own negation. This is the check that catches a mis-read side map: the
  // real capture would be self-arbitrage-rich if a handicap's legs were filed
  // under the wrong line.
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  const grouped = groupByEvent(out, 'favbet');
  const arbs = findArbitrage(grouped, { minMarginPercent: 0 });
  assert.deepEqual(arbs, [], 'no self-arbitrage across the capture');
  assert.ok(grouped.size > 0, 'the capture does produce grouped events');
});

test('favbet: multi-sport 2-way match winner extraction for tennis and basketball', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ sport: 'all' });

  // 1. Tennis 2-way event (sport_id: 2)
  const tennisEvent = {
    event_id: 2001,
    sport_id: 2,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 7200,
    participants: [
      { participant_number: 1, participant_name: 'Carlos Alcaraz' },
      { participant_number: 2, participant_name: 'Jannik Sinner' },
    ],
    category_name: 'Tenis',
    tournament_name: 'ATP Wimbledon',
    tournament_id: 'atp-wimbledon',
    event_status_type: 'notstarted',
  };
  const tennisMatchWinner = {
    market_id: 501,
    market_name: 'Castigator Meci',
    market_suspend: false,
    market_template_id: 1,
    outcomes: [
      leg(5011, '1', 'Carlos Alcaraz', 1.85),
      leg(5012, '2', 'Jannik Sinner', 1.95),
    ],
  };

  // 2. Basketball 2-way event (sport_id: 23)
  const basketballEvent = {
    event_id: 2002,
    sport_id: 23,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 14400,
    participants: [
      { participant_number: 1, participant_name: 'Los Angeles Lakers' },
      { participant_number: 2, participant_name: 'Boston Celtics' },
    ],
    category_name: 'Baschet',
    tournament_name: 'NBA',
    tournament_id: 'nba',
    event_status_type: 'notstarted',
  };
  const basketballMatchWinner = {
    market_id: 601,
    market_name: 'Castigator (incl. prel.)',
    market_suspend: false,
    market_template_id: 1,
    outcomes: [
      leg(6011, '1', 'Los Angeles Lakers', 2.10),
      leg(6012, '2', 'Boston Celtics', 1.75),
    ],
  };

  const payload = {
    events: new Map([
      ['2001', tennisEvent],
      ['2002', basketballEvent],
    ]),
    markets: [
      { event: tennisEvent, markets: [tennisMatchWinner] },
      { event: basketballEvent, markets: [basketballMatchWinner] },
    ],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const extracted = s.extractEvents(s.normalize(payload));
  assert.equal(extracted.length, 2);

  const tennis = extracted.find((e) => e.sport === 'Tennis');
  assert.ok(tennis);
  assert.equal(tennis.homeTeam, 'Carlos Alcaraz');
  assert.equal(tennis.awayTeam, 'Jannik Sinner');
  assert.ok(tennis.eventKey.startsWith('tennis|'));
  const tennisMarket = tennis.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(tennisMarket);
  assert.equal(tennisMarket.selections.length, 2);
  assert.equal(tennisMarket.selections[0].name, 'Carlos Alcaraz');
  assert.equal(tennisMarket.selections[1].name, 'Jannik Sinner');

  const bball = extracted.find((e) => e.sport === 'Basketball');
  assert.ok(bball);
  assert.equal(bball.homeTeam, 'Los Angeles Lakers');
  assert.equal(bball.awayTeam, 'Boston Celtics');
  assert.ok(bball.eventKey.startsWith('basketball|'));
  const bballMarket = bball.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(bballMarket);
  assert.equal(bballMarket.selections.length, 2);
  assert.equal(bballMarket.selections[0].odds, 2.10);
  assert.equal(bballMarket.selections[1].odds, 1.75);
});

test('favbet: in-play metadata extraction (live, score, minute, periodName)', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ includeLive: true });

  const liveEvent = {
    event_id: 3001,
    sport_id: 1,
    service_id: 1,
    event_status_type: 'live',
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) - 3000,
    participants: [
      { participant_number: 1, participant_name: 'FCSB' },
      { participant_number: 2, participant_name: 'CFR Cluj' },
    ],
    category_name: 'Fotbal',
    tournament_name: 'Liga 1',
    score: '1-0',
    minute: '42',
    period_name: '1H',
  };

  const liveMarket = matchOdds(3001);

  const payload = {
    events: new Map([['3001', liveEvent]]),
    markets: [{ event: liveEvent, markets: [liveMarket] }],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const extracted = s.extractEvents(s.normalize(payload));
  assert.equal(extracted.length, 1);
  const ev = extracted[0];
  assert.equal(ev.live, true);
  assert.equal(ev.score, '1-0');
  assert.equal(ev.minute, '42');
  assert.equal(ev.periodName, '1H');
  assert.equal(ev.markets[0].live, true, 'markets marked live: true when ev.live is true');
});

test('favbet: sport options mapping and registry constants', () => {
  assert.equal(FAVBET_SPORT_ID_MAP[1], 'Football');
  assert.equal(FAVBET_SPORT_ID_MAP[2], 'Tennis');
  assert.equal(FAVBET_SPORT_ID_MAP[23], 'Basketball');
  assert.equal(FAVBET_SPORT_NAME_TO_ID.football, 1);
  assert.equal(FAVBET_SPORT_NAME_TO_ID.tennis, 2);
  assert.equal(FAVBET_SPORT_NAME_TO_ID.basketball, 23);

  const all = new Favbet({ sport: 'all' });
  assert.equal(all.sport, 'all');
  assert.equal(all.sportId, null);
  assert.ok(all.sports.length > 5);

  const tennis = new Favbet({ sport: 'tennis' });
  assert.equal(tennis.sport, 'tennis');
  assert.equal(tennis.sportId, 2);

  const multi = new Favbet({ sports: ['basketball', 'tennis'] });
  assert.equal(multi.sport, 'all');
  assert.equal(multi.sportId, null);
  assert.deepEqual(multi.sports, ['basketball', 'tennis']);
});

test('favbet: basketball and tennis template 50 totals resolution to POINTS and GAMES', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72, includeLive: true });

  const bballEvent = {
    event_id: 2101,
    sport_id: 23,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 3600,
    participants: [
      { participant_number: 1, participant_name: 'Denver Nuggets' },
      { participant_number: 2, participant_name: 'Miami Heat' },
    ],
    category_name: 'Baschet',
    tournament_name: 'NBA',
    event_status_type: 'notstarted',
  };

  const bballWinner = {
    market_id: 210101,
    market_name: 'Castigator',
    market_suspend: false,
    market_template_id: 1,
    outcomes: [
      leg(2101011, '1', 'Denver Nuggets', 1.55),
      leg(2101012, '2', 'Miami Heat', 2.45),
    ],
  };

  const bballTotal = total(210102, 'Timp Regulamentar', 215.5, 1.90, 1.90);

  const tennisEvent = {
    event_id: 2102,
    sport_id: 2,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 3600,
    participants: [
      { participant_number: 1, participant_name: 'Novak Djokovic' },
      { participant_number: 2, participant_name: 'Rafael Nadal' },
    ],
    category_name: 'Tenis',
    tournament_name: 'Roland Garros',
    event_status_type: 'notstarted',
  };

  const tennisWinner = {
    market_id: 210201,
    market_name: 'Castigator',
    market_suspend: false,
    market_template_id: 1,
    outcomes: [
      leg(2102011, '1', 'Novak Djokovic', 1.80),
      leg(2102012, '2', 'Rafael Nadal', 2.05),
    ],
  };

  const tennisTotal = total(210202, 'Timp Regulamentar', 22.5, 1.85, 1.95);

  const payload = {
    events: new Map([
      ['2101', bballEvent],
      ['2102', tennisEvent],
    ]),
    markets: [
      { event: bballEvent, markets: [bballWinner, bballTotal] },
      { event: tennisEvent, markets: [tennisWinner, tennisTotal] },
    ],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const extracted = s.extractEvents(s.normalize(payload));
  assert.equal(extracted.length, 2);

  const bball = extracted.find((e) => e.sport === 'Basketball');
  assert.ok(bball);
  const bballTot = bball.markets.find((m) => m.key === 'TOTAL_POINTS');
  assert.ok(bballTot, 'Basketball template 50 yields TOTAL_POINTS');
  assert.equal(bballTot.subject, 'points');
  assert.equal(bballTot.line, 215.5);
  const bballContract = resolveContract(bballTot);
  assert.ok(bballContract);
  assert.equal(bballContract.family, 'OVER_UNDER');
  assert.equal(bballContract.subject, 'points');
  assert.equal(bballContract.lineKey, '215.5');

  const tennis = extracted.find((e) => e.sport === 'Tennis');
  assert.ok(tennis);
  const tennisTot = tennis.markets.find((m) => m.key === 'TOTAL_GAMES');
  assert.ok(tennisTot, 'Tennis template 50 yields TOTAL_GAMES');
  assert.equal(tennisTot.subject, 'games');
  assert.equal(tennisTot.line, 22.5);
  const tennisContract = resolveContract(tennisTot);
  assert.ok(tennisContract);
  assert.equal(tennisContract.family, 'OVER_UNDER');
  assert.equal(tennisContract.subject, 'games');
  assert.equal(tennisContract.lineKey, '22.5');
});

test('favbet: 2-way match winner extraction with fallback template 2 and outcome participant matching', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  const tennisEvent = {
    event_id: 2201,
    sport_id: 2,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 7200,
    participants: [
      { participant_number: 1, participant_name: 'Alexander Zverev' },
      { participant_number: 2, participant_name: 'Daniil Medvedev' },
    ],
    category_name: 'Tenis',
    tournament_name: 'ATP Masters',
    event_status_type: 'notstarted',
  };

  const template2Winner = {
    market_id: 220101,
    market_name: 'Castigator meci',
    market_suspend: false,
    market_template_id: 2,
    outcomes: [
      { outcome_id: 2201011, outcome_name: 'Alexander Zverev', outcome_tag: null, outcome_coef: 1.70, outcome_visible: true },
      { outcome_id: 2201012, outcome_name: 'Daniil Medvedev', outcome_tag: null, outcome_coef: 2.15, outcome_visible: true },
    ],
  };

  const payload = {
    events: new Map([['2201', tennisEvent]]),
    markets: [{ event: tennisEvent, markets: [template2Winner] }],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const extracted = s.extractEvents(s.normalize(payload));
  assert.equal(extracted.length, 1);
  const ev = extracted[0];
  const match = ev.markets.find((m) => m.key === 'MATCH_ODDS');
  assert.ok(match, 'match winner extracted via template 2 fallback');
  assert.equal(match.selections.length, 2);
  assert.equal(match.selections[0].name, 'Alexander Zverev');
  assert.equal(match.selections[1].name, 'Daniil Medvedev');
  assert.equal(match.selections[0].odds, 1.70);
  assert.equal(match.selections[1].odds, 2.15);
});

test('favbet: multi-sport additional totals via mapFavbetMarket with subject attribution', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  const bballEvent = {
    event_id: 2301,
    sport_id: 23,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 3600,
    participants: [
      { participant_number: 1, participant_name: 'Chicago Bulls' },
      { participant_number: 2, participant_name: 'New York Knicks' },
    ],
    category_name: 'Baschet',
    tournament_name: 'NBA',
    event_status_type: 'notstarted',
  };

  const bballWinner = matchOdds(2301);
  const bballAddTotal = {
    market_id: 230199,
    market_name: 'Total puncte 208.5',
    market_suspend: false,
    market_template_id: 888,
    result_type_name: 'Timp Regulamentar',
    outcomes: [
      leg(2301991, 'over', 'Peste', 1.85),
      leg(2301992, 'under', 'Sub', 1.95),
    ],
  };

  const payload = {
    events: new Map([['2301', bballEvent]]),
    markets: [{ event: bballEvent, markets: [bballWinner, bballAddTotal] }],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const extracted = s.extractEvents(s.normalize(payload));
  assert.equal(extracted.length, 1);
  const ev = extracted[0];
  const ptsMarket = ev.markets.find((m) => m.key === 'POINTS_OVER_UNDER_208_5');
  assert.ok(ptsMarket, 'POINTS_OVER_UNDER_208_5 emitted for basketball additional total');
  assert.equal(ptsMarket.subject, 'points');
  const contract = resolveContract(ptsMarket);
  assert.ok(contract);
  assert.equal(contract.family, 'OVER_UNDER');
  assert.equal(contract.subject, 'points');
  assert.equal(contract.lineKey, '208.5');
});

test('favbet: extracts sub-window period match odds (half1, half2, sets) with bucket isolation', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const event = {
    event_id: 5001,
    sport_id: 1,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 3600,
    participants: [
      { participant_number: 1, participant_name: 'FCSB' },
      { participant_number: 2, participant_name: 'Dinamo Bucuresti' },
    ],
    category_name: 'Fotbal',
    tournament_name: 'Romania - Liga 1',
    event_status_type: 'notstarted',
  };

  const ft1x2 = matchOdds(50011);

  const half11x2 = {
    market_id: 50012,
    market_name: '1X2 Prima repriză',
    market_suspend: false,
    result_type_name: 'Prima repriză',
    result_type_short_name: '1R',
    outcomes: [
      leg(500121, '1', '1', 2.80),
      leg(500122, 'X', 'X', 2.10),
      leg(500123, '2', '2', 3.90),
    ],
  };

  const half21x2 = {
    market_id: 50013,
    market_name: '1X2 A doua repriză',
    market_suspend: false,
    result_type_name: 'A doua repriză',
    result_type_short_name: '2R',
    outcomes: [
      leg(500131, '1', '1', 2.50),
      leg(500132, 'X', 'X', 2.30),
      leg(500133, '2', '2', 3.50),
    ],
  };

  const set1Winner = {
    market_id: 50014,
    market_name: 'Câștigător Set 1',
    market_suspend: false,
    result_type_name: 'Setul 1',
    result_type_short_name: '1S',
    outcomes: [
      leg(500141, '1', '1', 1.70),
      leg(500142, '2', '2', 2.15),
    ],
  };

  const payload = {
    events: new Map([['5001', event]]),
    markets: [{ event, markets: [ft1x2, half11x2, half21x2, set1Winner] }],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const extracted = s.extractEvents(s.normalize(payload));
  assert.equal(extracted.length, 1);
  const ev = extracted[0];

  const mFt = ev.markets.find((m) => m.period === 'fulltime' && m.key === 'MATCH_ODDS');
  const mH1 = ev.markets.find((m) => m.period === 'half1' && m.key === 'MATCH_ODDS');
  const mH2 = ev.markets.find((m) => m.period === 'half2' && m.key === 'MATCH_ODDS');
  const mS1 = ev.markets.find((m) => m.period === 'set1' && m.key === 'MATCH_ODDS');

  assert.ok(mFt, 'full-time 1X2 emitted');
  assert.ok(mH1, 'first-half 1X2 emitted');
  assert.ok(mH2, 'second-half 1X2 emitted');
  assert.ok(mS1, 'set 1 winner emitted');

  const cFt = resolveContract(mFt);
  const cH1 = resolveContract(mH1);
  const cH2 = resolveContract(mH2);
  const cS1 = resolveContract(mS1);

  assert.equal(cFt.period, 'fulltime');
  assert.equal(cH1.period, 'half1');
  assert.equal(cH2.period, 'half2');
  assert.equal(cS1.period, 'set1');

  const bFt = bucketKeyForContract('evFav', cFt);
  const bH1 = bucketKeyForContract('evFav', cH1);
  const bH2 = bucketKeyForContract('evFav', cH2);
  const bS1 = bucketKeyForContract('evFav', cS1);

  assert.equal(bFt, 'evFav::MATCH_ODDS::fulltime::_::home+draw+away::_::_');
  assert.equal(bH1, 'evFav::MATCH_ODDS::half1::_::home+draw+away::_::_');
  assert.equal(bH2, 'evFav::MATCH_ODDS::half2::_::home+draw+away::_::_');
  assert.equal(bS1, 'evFav::MATCH_ODDS::set1::_::home+away::_::_');

  assert.notEqual(bFt, bH1);
  assert.notEqual(bFt, bH2);
  assert.notEqual(bH1, bH2);
  assert.notEqual(bFt, bS1);
});

test('favbet: multi-sport sub-window derivative markets (quarters, sets, halves) isolate cleanly into distinct buckets', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });

  // 1. Basketball event with Q1-Q4 winners and totals
  const bballEvent = {
    event_id: 6001,
    sport_id: 23,
    tournament_name: 'NBA',
    event_dt: Math.floor(new Date('2026-09-28T19:00:00Z').getTime() / 1000),
    participants: [
      { participant_number: 1, participant_name: 'Boston Celtics' },
      { participant_number: 2, participant_name: 'Golden State Warriors' },
    ],
  };

  const bballMarkets = [
    // Full-time match winner
    {
      market_id: 60010,
      market_name: 'Câștigător Meci',
      market_suspend: false,
      market_template_id: 2,
      outcomes: [
        leg(600101, '1', 'Boston Celtics', 1.65),
        leg(600102, '2', 'Golden State Warriors', 2.30),
      ],
    },
    // Q1 Winner (result_type_short_name: "1Q")
    {
      market_id: 60011,
      market_name: 'Câștigător',
      market_suspend: false,
      result_type_name: 'Sfertul 1',
      result_type_short_name: '1Q',
      outcomes: [
        leg(600111, '1', 'Boston Celtics', 1.80),
        leg(600112, '2', 'Golden State Warriors', 2.05),
      ],
    },
    // Q2 Winner (result_type_short_name: "2Q")
    {
      market_id: 60012,
      market_name: 'Câștigător Sfertul 2',
      market_suspend: false,
      result_type_name: 'Sfertul 2',
      result_type_short_name: '2Q',
      outcomes: [
        leg(600121, '1', 'Boston Celtics', 1.85),
        leg(600122, '2', 'Golden State Warriors', 1.95),
      ],
    },
    // Q1 Total Points (Peste / Sub with line in legs)
    {
      market_id: 60013,
      market_name: 'Total Puncte',
      market_suspend: false,
      result_type_name: 'Sfertul 1',
      result_type_short_name: '1Q',
      outcomes: [
        leg(600131, 'over', 'Peste (54.5)', 1.90),
        leg(600132, 'under', 'Sub (54.5)', 1.90),
      ],
    },
    // Q3 Total Points
    {
      market_id: 60014,
      market_name: 'Total Puncte - Sfertul 3',
      market_suspend: false,
      result_type_name: 'Sfertul 3',
      result_type_short_name: '3Q',
      outcomes: [
        leg(600141, 'over', 'Peste (52.5)', 1.88),
        leg(600142, 'under', 'Sub (52.5)', 1.92),
      ],
    },
  ];

  // 2. Tennis event with Set 1-3 winners and totals
  const tennisEvent = {
    event_id: 7001,
    sport_id: 2,
    tournament_name: 'ATP Wimbledon',
    event_dt: Math.floor(new Date('2026-09-28T14:00:00Z').getTime() / 1000),
    participants: [
      { participant_number: 1, participant_name: 'Carlos Alcaraz' },
      { participant_number: 2, participant_name: 'Jannik Sinner' },
    ],
  };

  const tennisMarkets = [
    {
      market_id: 70010,
      market_name: 'Câștigător',
      market_suspend: false,
      market_template_id: 2,
      outcomes: [
        leg(700101, '1', 'Carlos Alcaraz', 1.85),
        leg(700102, '2', 'Jannik Sinner', 1.95),
      ],
    },
    {
      market_id: 70011,
      market_name: 'Câștigător Setul 2',
      market_suspend: false,
      result_type_name: 'Setul 2',
      result_type_short_name: '2S',
      outcomes: [
        leg(700111, '1', 'Carlos Alcaraz', 1.90),
        leg(700112, '2', 'Jannik Sinner', 1.90),
      ],
    },
    {
      market_id: 70012,
      market_name: 'Total Game-uri Set 2',
      market_suspend: false,
      result_type_name: 'Setul 2',
      result_type_short_name: '2S',
      outcomes: [
        leg(700121, 'over', 'Peste (9.5)', 1.85),
        leg(700122, 'under', 'Sub (9.5)', 1.95),
      ],
    },
  ];

  const payload = {
    events: new Map([['6001', bballEvent], ['7001', tennisEvent]]),
    markets: [
      { event: bballEvent, markets: bballMarkets },
      { event: tennisEvent, markets: tennisMarkets },
    ],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };

  const extracted = s.extractEvents(s.normalize(payload));
  assert.equal(extracted.length, 2);

  const [bballEvt, tennisEvt] = extracted;

  // Verify Basketball Q1 & Q2 Winners
  const bFtWin = bballEvt.markets.find((m) => m.period === 'fulltime' && m.key === 'MATCH_ODDS');
  const bQ1Win = bballEvt.markets.find((m) => m.period === 'q1' && m.key === 'MATCH_ODDS');
  const bQ2Win = bballEvt.markets.find((m) => m.period === 'q2' && m.key === 'MATCH_ODDS');
  assert.ok(bFtWin && bQ1Win && bQ2Win);

  const cBft = resolveContract(bFtWin);
  const cBq1 = resolveContract(bQ1Win);
  const cBq2 = resolveContract(bQ2Win);

  assert.equal(cBft.period, 'fulltime');
  assert.equal(cBq1.period, 'q1');
  assert.equal(cBq2.period, 'q2');

  const bKeyBft = bucketKeyForContract(bballEvt.eventKey, cBft);
  const bKeyBq1 = bucketKeyForContract(bballEvt.eventKey, cBq1);
  const bKeyBq2 = bucketKeyForContract(bballEvt.eventKey, cBq2);

  assert.notEqual(bKeyBft, bKeyBq1);
  assert.notEqual(bKeyBq1, bKeyBq2);
  assert.ok(bKeyBq1.includes('::q1::'));
  assert.ok(bKeyBq2.includes('::q2::'));

  // Verify Basketball Q1 & Q3 Totals Points
  const bQ1Tot = bballEvt.markets.find((m) => m.period === 'q1' && /POINTS_OVER_UNDER/i.test(m.key));
  const bQ3Tot = bballEvt.markets.find((m) => m.period === 'q3' && /POINTS_OVER_UNDER/i.test(m.key));
  assert.ok(bQ1Tot && bQ3Tot);

  const cBq1Tot = resolveContract(bQ1Tot);
  const cBq3Tot = resolveContract(bQ3Tot);

  assert.equal(cBq1Tot.family, 'OVER_UNDER');
  assert.equal(cBq1Tot.period, 'q1');
  assert.equal(cBq1Tot.subject, 'points');
  assert.equal(cBq1Tot.lineKey, '54.5');

  assert.equal(cBq3Tot.family, 'OVER_UNDER');
  assert.equal(cBq3Tot.period, 'q3');
  assert.equal(cBq3Tot.subject, 'points');
  assert.equal(cBq3Tot.lineKey, '52.5');

  const bKeyBq1Tot = bucketKeyForContract(bballEvt.eventKey, cBq1Tot);
  const bKeyBq3Tot = bucketKeyForContract(bballEvt.eventKey, cBq3Tot);
  assert.notEqual(bKeyBq1Tot, bKeyBq3Tot);
  assert.ok(bKeyBq1Tot.includes('::q1::'));
  assert.ok(bKeyBq3Tot.includes('::q3::'));

  // Verify Tennis Set 2 Winner & Total Games
  const tSet2Win = tennisEvt.markets.find((m) => m.period === 'set2' && m.key === 'MATCH_ODDS');
  const tSet2Tot = tennisEvt.markets.find((m) => m.period === 'set2' && /GAMES_OVER_UNDER/i.test(m.key));
  assert.ok(tSet2Win && tSet2Tot);

  const cTs2Win = resolveContract(tSet2Win);
  const cTs2Tot = resolveContract(tSet2Tot);

  assert.equal(cTs2Win.family, 'MATCH_ODDS');
  assert.equal(cTs2Win.period, 'set2');

  assert.equal(cTs2Tot.family, 'OVER_UNDER');
  assert.equal(cTs2Tot.period, 'set2');
  assert.equal(cTs2Tot.subject, 'games');
  assert.equal(cTs2Tot.lineKey, '9.5');

  const bKeyTs2Win = bucketKeyForContract(tennisEvt.eventKey, cTs2Win);
  const bKeyTs2Tot = bucketKeyForContract(tennisEvt.eventKey, cTs2Tot);
  assert.ok(bKeyTs2Win.includes('::set2::'));
  assert.ok(bKeyTs2Tot.includes('::set2::'));
  assert.notEqual(bKeyTs2Win, bKeyTs2Tot);
});

/* --- synthetic row builders, shaped like the capture ---------------------- */

function leg(outcomeId, tag, name, coef) {
  return {
    outcome_id: outcomeId, outcome_name: name, outcome_short_name: name,
    outcome_tag: tag, outcome_coef: coef, outcome_visible: true,
  };
}

function total(marketId, window, line, overOdds, underOdds) {
  const m = {
    market_id: marketId, market_name: 'Peste / Sub', market_suspend: false, market_template_id: 50,
    outcomes: [leg(marketId * 10 + 2, '2', `Peste (${line})`, overOdds), leg(marketId * 10 + 1, '1', `Sub (${line})`, underOdds)],
  };
  if (window) { m.result_type_name = window; m.result_type_short_name = 'Tr'; }
  return m;
}

function handicap(marketId, window, legs) {
  const m = {
    market_id: marketId, market_name: 'Handicap', market_suspend: false, market_template_id: 190,
    outcomes: legs,
  };
  if (window) { m.result_type_name = window; m.result_type_short_name = 'Tr'; }
  return m;
}

function matchOdds(marketId) {
  return {
    market_id: marketId, market_name: '1 X 2', market_suspend: false, market_template_id: 1,
    result_type_name: 'Timp Regulamentar', result_type_short_name: 'Tr',
    outcomes: [
      leg(marketId * 10 + 1, '1', 'Gazde', 2.1),
      leg(marketId * 10 + 2, 'X', 'Egal', 3.4),
      leg(marketId * 10 + 3, '2', 'Oaspeți', 3.2),
    ],
  };
}

/**
 * One event carrying the given markets, in the envelope the adapter consumes.
 *
 * The 1X2 is always present because the adapter publishes an event only if its
 * own match-result market is there; a test that omitted it would assert nothing
 * at all, since every event it built would be dropped before the goals families
 * were ever read.
 */
function envelopeWith(markets, { home, away, eventId = 5 } = {}) {
  const event = {
    event_id: eventId,
    event_dt: Math.floor(Date.parse(PINNED_NOW) / 1000) + 86400,
    participants: [
      { participant_number: 1, participant_name: home },
      { participant_number: 2, participant_name: away },
    ],
    category_name: 'Fotbal', tournament_name: 'Test', tournament_id: 'fotbal',
    event_status_type: 'notstarted',
  };
  return {
    events: new Map([[String(eventId), event]]),
    markets: [{ event, markets: { m: [matchOdds(eventId * 100), ...markets] } }],
    sourceUrl: 'https://www.favbet.ro/service/lineout/frontend_api2/',
    observedAt: PINNED_NOW,
  };
}

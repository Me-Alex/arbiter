/* global Response, structuredClone */
// Superbet's per-event detail pass. The adapter reaches the full slate through
// /v2/ro-RO/events/{id} rather than the index, so these tests pin the three
// things that pass is responsible for: which markets it claims, what it
// refuses, and what it does to the handicap legs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Superbet from '../src/scrapers/superbet.mjs';
import { resolveContract, canonicalOutcomeFor, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';

const capture = JSON.parse(await fs.readFile(new URL('./fixtures/superbet-detail.json', import.meta.url), 'utf8'));
const EVENT_ID = capture.index.events[0].event_id;
const DETAIL = capture.details[String(EVENT_ID)];
const TEAMS = capture.index.events[0].fixture.event_name.split('·').map((s) => s.trim());

/** The detail payload as the adapter sees it, with the clock moved forward. */
function rawEvents() {
  const events = structuredClone(capture.index.events);
  for (const e of events) e.fixture.utc_date = new Date(Date.now() + 3600000).toISOString();
  return events;
}

/**
 * Route one detail event through the adapter's own extraction.
 *
 * The events array is built once and reused: `_enrichMarkets` annotates the raw
 * events in place, so calling `rawEvents()` again for the extraction would hand
 * `extractEvents` a fresh set of clones with no detail markets on them.
 */
async function detailMarkets(fullMarkets = true, detailLimit = 10, overrides = {}) {
  const events = rawEvents();
  Object.assign(events[0].fixture, overrides);
  const scraper = new Superbet({ fullMarkets, detailLimit, maxEvents: 10, sport: 'football' });
  const get = async (url) => {
    if (url.endsWith('/struct')) return { data: { tournaments: [] } };
    const id = url.split('/').pop();
    assert.ok(capture.details[id], `fixture has no detail payload for ${id}`);
    return capture.details[id];
  };
  await scraper._enrichMarkets(events, get, undefined);
  const ev = scraper.extractEvents(scraper.normalize({ events }))[0];
  return ev ? ev.markets : [];
}

const oddsFor = (payload, marketId, marketName) =>
  payload.data[0].odds.filter((o) => o.marketId === marketId && o.marketName === marketName);

test('the goals total is published as one market per line, not one market', async () => {
  const markets = await detailMarkets();
  const totals = markets.filter((m) => m.key === 'sb:200734:Total goluri');
  // The detail payload groups by marketUuid — one uuid is one line. Publishing
  // a single market would put OVER 0.5 and OVER 8.5 in one contract.
  assert.equal(totals.length, 7, 'seven lines, one market each');
  const lines = totals.map((m) => resolveContract(m).lineKey).sort();
  assert.deepEqual(lines, ['0.5', '1.5', '2.5', '3.5', '4.5', '5.5', '6.5']);
  for (const m of totals) {
    const c = resolveContract(m);
    assert.equal(c.family, 'OVER_UNDER');
    assert.equal(c.period, 'fulltime');
    assert.deepEqual(m.selections.map((s) => canonicalOutcomeFor(s.name, c)), ['under', 'over']);
  }
});

test('the handicap legs carry a side token, so the line keys to a direction', async () => {
  const markets = await detailMarkets();
  const handicaps = markets.filter((m) => m.key === 'sb:200736:Handicap');
  assert.ok(handicaps.length >= 5, 'several handicap lines');
  for (const m of handicaps) {
    // "<Team> (-1.5)" becomes "1 (-1.5)" / "2 (1.5)" — the side token every
    // other adapter emits, resolved against the two teams the index gave us.
    assert.equal(m.selections.length, 2);
    for (const s of m.selections) {
      assert.match(s.name, /^[12] \(-?\d+(?:[.,]\d+)?\)$/, `side token on "${s.name}"`);
    }
    assert.notEqual(m.selections[0].name, m.selections[1].name);
    // One side gives goals and the other receives them, in that order.
    const [a, b] = m.selections.map((s) => Number(/\((.*)\)/.exec(s.name)[1]));
    assert.equal(a, -b, 'the two legs are exact negations');
    // Reversing the provider's leg order must not change the contract.
    const flipped = resolveContract({ ...m, selections: [...m.selections].reverse() });
    assert.equal(flipped.lineKey, resolveContract(m).lineKey, 'order-independent');
    assert.deepEqual(
      [...m.selections].reverse().map((s) => canonicalOutcomeFor(s.name, resolveContract(m))),
      ['away', 'home'],
    );
  }
});

test('a line and its reciprocal are two different contracts, never one bucket', async () => {
  // This is the defect the deep pass exposed. Superbet publishes BOTH
  // "Moldova (-1.5) / Feroe (1.5)" and "Moldova (1.5) / Feroe (-1.5)". Ordered
  // by sign rather than by side, both sort to "-1.5/1.5", so the bucket held
  // home -1.5 and away -1.5: two legs that both pay only when their own team
  // wins by two, which can both lose and covers nothing. Every one of the 33
  // arbitrages the first live run reported was that artifact.
  const markets = await detailMarkets();
  const keys = markets.filter((m) => m.key === 'sb:200736:Handicap').map((m) => resolveContract(m).lineKey);
  const homeNegative = keys.filter((k) => k.startsWith('-'));
  const homePositive = keys.filter((k) => !k.startsWith('-'));
  assert.ok(homeNegative.length > 0, 'at least one line where home gives goals');
  assert.ok(homePositive.length > 0, 'at least one line where home receives goals');
  for (const k of homeNegative) assert.match(k, /^-/, 'home -1.5 keys as -1.5/1.5');
  for (const k of homePositive) assert.match(k, /^[0-9]/, 'home +1.5 keys as 1.5/-1.5');
  // The decisive property: the two directions never share a key.
  const overlap = homeNegative.filter((k) => homePositive.includes(k));
  assert.deepEqual(overlap, [], 'no line key is shared by a spread and its reciprocal');
});

test('the exact-name gate admits measured first-half goals, but keeps other variants out', async () => {
  const markets = await detailMarkets();
  const keys = new Set(markets.map((m) => m.key));
  const firstHalf = markets.filter((m) => m.key === 'sb:200735:Prima repriză - Total goluri');
  assert.ok(firstHalf.length > 0, 'the measured first-half goals totals are published');
  for (const m of firstHalf) {
    const contract = resolveContract(m);
    assert.equal(m.period, 'half1');
    assert.equal(contract.family, 'OVER_UNDER');
    assert.equal(contract.period, 'half1');
  }
  // The second-half and spread variants remain different settlement contracts.
  for (const k of ['sb:200738:A doua repriză - Total goluri',
    'sb:200737:Prima repriză - Handicap', 'sb:200739:A doua repriză - Handicap']) {
    assert.equal(keys.has(k), false, `${k} must not be published`);
  }
  // 530 / 529 are published only on whole, quarter and zero lines: 0 of 198 and
  // 0 of 207 measured line pairs on a half line, so every one of them can
  // return the stake instead of settling.
  for (const k of ['sb:530:Handicap asiatic', 'sb:529:Total goluri asiatice']) {
    assert.equal(keys.has(k), false, `${k} must not be published`);
  }
  // 535 is "Total goluri <Team>" — one side's goals, not the match's, and the
  // team changes the name event to event.
  const teamTotals = DETAIL.data[0].odds.filter((o) => String(o.marketId) === '535');
  assert.ok(teamTotals.length > 0, 'the fixture really does carry a team total');
  for (const o of teamTotals) {
    assert.notEqual(o.marketName, 'Total goluri', '535 is never the plain match total');
  }
  assert.equal(keys.has('sb:535:Total goluri'), false);
  // Per-half BTTS is not full-time BTTS.
  assert.equal(keys.has('sb:200751:GG în oricare repriză'), false);
});

test('suspended legs are dropped and a half-leg market is not published', async () => {
  const body = structuredClone(capture.details[String(EVENT_ID)]);
  // The feed publishes suspended legs inline: measured `active` and `block` on
  // the same 200734 market, and the detail payload uses the string form of
  // status where the index uses a number.
  const totals = body.data[0].odds.filter((o) => String(o.marketId) === '200734');
  const blockedUuid = totals[0].marketUuid;
  for (const o of totals) if (o.marketUuid === blockedUuid) o.status = 'block';
  const events = rawEvents();
  const scraper = new Superbet({ fullMarkets: true, detailLimit: 1, maxEvents: 1, sport: 'football' });
  const get = async (url) => (url.endsWith('/struct') ? { data: { tournaments: [] } } : body);
  await scraper._enrichMarkets(events, get, undefined);
  const ev = scraper.extractEvents(scraper.normalize({ events }))[0];
  const lines = new Set((ev.markets || []).filter((m) => m.key === 'sb:200734:Total goluri').map((m) => resolveContract(m).lineKey));
  assert.equal(lines.size, 6, 'the blocked line is gone, the other six remain');
  // Only the detail markets are subject to the two-leg rule; the index 1X2
  // market that rides along is legitimately three-legged.
  for (const m of ev.markets.filter((x) => x.key.startsWith('sb:'))) {
    assert.equal(m.selections.length, 2, 'no half-leg market is published');
  }
});

test('the deep pass is off unless asked for, and never exceeds the emit cap', async () => {
  const requested = [];
  // fetchRaw drives the adapter's own `get`, which checks response.ok and the
  // content type, so the fake transport has to be a real Response.
  const fetchImpl = async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.includes('/v3/')) return Response.json({ events: rawEvents() });
    if (href.endsWith('/struct')) return Response.json({ data: { tournaments: [] } });
    return Response.json(capture.details[href.split('/').pop()]);
  };
  // Off by default. fetchRaw is the only caller of the deep pass and it is
  // guarded, so an unflagged run never issues a detail request at all.
  assert.equal(new Superbet({ maxEvents: 10, sport: 'football' }).fullMarkets, false);
  const shallow = new Superbet({ maxEvents: 10, sport: 'football', fetchImpl });
  await shallow.fetchRaw();
  assert.equal(requested.filter((u) => u.includes('/v2/ro-RO/events/')).length, 0,
    'no per-event detail read without fullMarkets');

  // On, but capped by maxEvents: 2 events emitted cannot need 50 detail reads.
  requested.length = 0;
  const on = new Superbet({ fullMarkets: true, detailLimit: 50, maxEvents: 2, sport: 'football', fetchImpl });
  await on.fetchRaw();
  const detailCalls = requested.filter((u) => u.includes('/v2/ro-RO/events/')).length;
  assert.equal(detailCalls, 2, 'detail reads are bounded by the event cap, not just by detailLimit');
});

test('an event whose teams do not match its handicap legs yields no handicap', async () => {
  // Fail closed: a spread this adapter cannot name the sides of would be
  // published under a key that merges it with its own reciprocal.
  const markets = await detailMarkets(true, 10, { event_name: 'Alpha·Beta' });
  assert.equal(markets.filter((m) => m.key === 'sb:200736:Handicap').length, 0);
  // The goals total does not name teams, so it survives untouched.
  assert.equal(markets.filter((m) => m.key === 'sb:200734:Total goluri').length, 7);
});

test('coverage reports what the run actually collected', async () => {
  const deep = new Superbet({ fullMarkets: true, detailLimit: 7, maxEvents: 3, sport: 'football' })
    ._serializable([], { events: [] }).coverage;
  assert.equal(deep.allMarkets, true);
  assert.equal(deep.market, 'fulltime-1x2+totals+handicap');
  assert.equal(deep.detailLimit, 7);

  const shallow = new Superbet({ maxEvents: 3, sport: 'football' })._serializable([], { events: [] }).coverage;
  assert.equal(shallow.allMarkets, false);
  assert.equal(shallow.market, 'fulltime-1x2');
  assert.equal(shallow.detailLimit, 0, 'no deep pass ran, so no budget is claimed');
});

test('the teams the detail legs are written against are the index teams', () => {
  assert.equal(TEAMS.length, 2);
  for (const o of oddsFor(DETAIL, '200736', 'Handicap')) {
    assert.match(o.name, /^(Belgia|Turcia) \(/,
      'the fixture legs name the two index teams, which is what sideTokenFor matches on');
  }
});

test('Superbet sub-window team totals: 2529/2531 (half1) and 201506/201507 (half2) isolate from match totals', async () => {
  const markets = await detailMarkets();
  // 1. Home 1st half goals (2529)
  const homeH1 = markets.filter((m) => m.key.startsWith('sb:2529:'));
  assert.ok(homeH1.length > 0, 'published home first-half totals (2529)');
  for (const m of homeH1) {
    assert.equal(m.period, 'half1');
    assert.equal(m.team, 'home');
    const contract = resolveContract(m);
    assert.equal(contract.family, 'OVER_UNDER');
    assert.equal(contract.period, 'half1');
    assert.equal(contract.team, 'home');
    const bucket = bucketKeyForContract('event-key', contract);
    assert.ok(bucket.includes('::half1::'));
    assert.ok(bucket.includes('::home'));
  }

  // 2. Away 1st half goals (2531)
  const awayH1 = markets.filter((m) => m.key.startsWith('sb:2531:'));
  assert.ok(awayH1.length > 0, 'published away first-half totals (2531)');
  for (const m of awayH1) {
    assert.equal(m.period, 'half1');
    assert.equal(m.team, 'away');
    const contract = resolveContract(m);
    assert.equal(contract.family, 'OVER_UNDER');
    assert.equal(contract.period, 'half1');
    assert.equal(contract.team, 'away');
    const bucket = bucketKeyForContract('event-key', contract);
    assert.ok(bucket.includes('::half1::'));
    assert.ok(bucket.includes('::away'));
  }

  // 3. Home 2nd half goals (201506)
  const homeH2 = markets.filter((m) => m.key.startsWith('sb:201506:'));
  assert.ok(homeH2.length > 0, 'published home second-half totals (201506)');
  for (const m of homeH2) {
    assert.equal(m.period, 'half2');
    assert.equal(m.team, 'home');
    const contract = resolveContract(m);
    assert.equal(contract.family, 'OVER_UNDER');
    assert.equal(contract.period, 'half2');
    assert.equal(contract.team, 'home');
    const bucket = bucketKeyForContract('event-key', contract);
    assert.ok(bucket.includes('::half2::'));
    assert.ok(bucket.includes('::home'));
  }

  // 4. Away 2nd half goals (201507)
  const awayH2 = markets.filter((m) => m.key.startsWith('sb:201507:'));
  assert.ok(awayH2.length > 0, 'published away second-half totals (201507)');
  for (const m of awayH2) {
    assert.equal(m.period, 'half2');
    assert.equal(m.team, 'away');
    const contract = resolveContract(m);
    assert.equal(contract.family, 'OVER_UNDER');
    assert.equal(contract.period, 'half2');
    assert.equal(contract.team, 'away');
    const bucket = bucketKeyForContract('event-key', contract);
    assert.ok(bucket.includes('::half2::'));
    assert.ok(bucket.includes('::away'));
  }

  // 5. Bucket key isolation check between home H1, home H2, match H1, and match FT
  const h1Contract = resolveContract(homeH1[0]);
  const h2Contract = resolveContract(homeH2[0]);
  const matchH1M = markets.find((m) => m.key === 'sb:200735:Prima repriză - Total goluri');
  const matchFtM = markets.find((m) => m.key === 'sb:200734:Total goluri');
  const matchH1Contract = resolveContract(matchH1M);
  const matchFtContract = resolveContract(matchFtM);

  const bHomeH1 = bucketKeyForContract('foot|test', h1Contract);
  const bHomeH2 = bucketKeyForContract('foot|test', h2Contract);
  const bMatchH1 = bucketKeyForContract('foot|test', matchH1Contract);
  const bMatchFt = bucketKeyForContract('foot|test', matchFtContract);

  assert.notEqual(bHomeH1, bHomeH2, 'half1 and half2 home totals never collide');
  assert.notEqual(bHomeH1, bMatchH1, 'home team total never collides with match total');
  assert.notEqual(bHomeH2, bMatchH1, 'half2 home total never collides with half1 match total');
  assert.notEqual(bMatchH1, bMatchFt, 'half1 match total never collides with fulltime match total');
});

test('Superbet index events: sub-window period extraction and bucket key isolation across sports', () => {
  const rawEvents = [
    {
      event_id: 8888,
      fixture: {
        event_name: 'FCSB · Dinamo',
        utc_date: new Date(Date.now() + 3600000).toISOString(),
        sport_id: 5,
        tournament_id: 1,
        offer_state_status: { '1': 1 },
      },
      inplay_stats_metadata: { status: 'NOT_STARTED' },
      markets: [
        {
          id: 547,
          name: 'Final',
          odds: [
            { uuid: 'o1', price: 2.10, status: 1, display: true, metadata: { name: '1', offer_state_id: 1 } },
            { uuid: 'ox', price: 3.30, status: 1, display: true, metadata: { name: 'X', offer_state_id: 1 } },
            { uuid: 'o2', price: 3.20, status: 1, display: true, metadata: { name: '2', offer_state_id: 1 } },
          ],
        },
        {
          id: 562,
          name: 'Prima repriză',
          odds: [
            { uuid: 'p1', price: 2.60, status: 1, display: true, metadata: { name: '1', offer_state_id: 1 } },
            { uuid: 'px', price: 2.10, status: 1, display: true, metadata: { name: 'X', offer_state_id: 1 } },
            { uuid: 'p2', price: 3.70, status: 1, display: true, metadata: { name: '2', offer_state_id: 1 } },
          ],
        },
        {
          id: 560,
          name: 'A doua repriză',
          odds: [
            { uuid: 's1', price: 2.40, status: 1, display: true, metadata: { name: '1', offer_state_id: 1 } },
            { uuid: 'sx', price: 2.30, status: 1, display: true, metadata: { name: 'X', offer_state_id: 1 } },
            { uuid: 's2', price: 3.50, status: 1, display: true, metadata: { name: '2', offer_state_id: 1 } },
          ],
        },
      ],
    },
    {
      event_id: 9999,
      fixture: {
        event_name: 'Lakers · Celtics',
        utc_date: new Date(Date.now() + 3600000).toISOString(),
        sport_id: 4,
        tournament_id: 2,
        offer_state_status: { '1': 1 },
      },
      inplay_stats_metadata: { status: 'NOT_STARTED' },
      markets: [
        {
          id: 4001,
          name: 'Sfertul 1 - Total puncte',
          odds: [
            { uuid: 'q1-o', price: 1.85, status: 1, display: true, metadata: { name: 'Peste 54.5', offer_state_id: 1, market_line_uuid: 'q1' } },
            { uuid: 'q1-u', price: 1.95, status: 1, display: true, metadata: { name: 'Sub 54.5', offer_state_id: 1, market_line_uuid: 'q1' } },
          ],
        },
      ],
    },
  ];

  const scraper = new Superbet();
  const events = scraper.extractEvents(rawEvents);
  assert.equal(events.length, 2);

  const fb = events.find((e) => e.sport === 'Football');
  const finalM = fb.markets.find((m) => m.name === 'Final');
  const prM = fb.markets.find((m) => m.name === 'Prima repriză');
  const srM = fb.markets.find((m) => m.name === 'A doua repriză');
  assert.equal(finalM.period, 'fulltime');
  assert.equal(prM.period, 'half1');
  assert.equal(srM.period, 'half2');

  const cFinal = resolveContract(finalM);
  const cPr = resolveContract(prM);
  const cSr = resolveContract(srM);
  assert.equal(cFinal.period, 'fulltime');
  assert.equal(cPr.period, 'half1');
  assert.equal(cSr.period, 'half2');

  const bFinal = bucketKeyForContract(fb.eventKey, cFinal);
  const bPr = bucketKeyForContract(fb.eventKey, cPr);
  const bSr = bucketKeyForContract(fb.eventKey, cSr);
  assert.notEqual(bFinal, bPr);
  assert.notEqual(bPr, bSr);
  assert.notEqual(bFinal, bSr);
  assert.ok(bPr.includes('::half1::'));
  assert.ok(bSr.includes('::half2::'));

  const bsk = events.find((e) => e.sport === 'Basketball');
  const q1M = bsk.markets.find((m) => m.name === 'Sfertul 1 - Total puncte');
  assert.equal(q1M.period, 'q1');
  assert.equal(q1M.subject, 'points');
  const cQ1 = resolveContract(q1M);
  assert.equal(cQ1.family, 'OVER_UNDER');
  assert.equal(cQ1.period, 'q1');
  assert.equal(cQ1.subject, 'points');
  const bQ1 = bucketKeyForContract(bsk.eventKey, cQ1);
  assert.ok(bQ1.includes('::q1::'));
  assert.ok(bQ1.includes('::points::'));
});

/* global structuredClone, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import A, { ALTENAR_IDS } from '../src/scrapers/altenar-public.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { loadWorkspace } from '../src/scanner/scanner.mjs';
import { resolveContract, bucketKeyForContract } from '../src/scanner/market-contracts.mjs';
const fixtures = Object.fromEntries(await Promise.all(ALTENAR_IDS.map(async (id) => [id,
  JSON.parse(await fs.readFile(new URL(`./fixtures/altenar-${id}.json`, import.meta.url)))])));
const cfg = (id) => ({ id, enabled: true, engine: 'altenar-tenancy', transport: 'altenar-sb2-widget-json',
  script: 'altenar-sites.mjs', sourceIds: [id] });
// Every event in a fixture must survive extraction, so the expectation is the
// fixture's own event count rather than a literal — a fixture grows when a real
// capture brings a family the old rows did not carry, and the number of events
// is not what any of these assertions is about.
const eventCount = (id) => fixtures[id].events.length;
function parser(id = 'million', opts = {}) {
  const a = new A(id, opts);
  a.from = Date.parse('2026-09-21T19:00:00Z');
  a.to = a.from + 86400000;
  a.observedAt = new Date().toISOString();
  return a;
}
for (const id of ALTENAR_IDS) {
  test(`${id}: actual fixture, complete fulltime market and exact route`, () => {
    const a = parser(id);
    const events = a.extractEvents(a.normalize(fixtures[id]));
    assert.equal(events.length, eventCount(id));
    assert.deepEqual(events[0].markets[0].selections.map(s => s.name), ['1', 'X', '2']);
    assert.equal(events[0].markets[0].period, 'fulltime');
    assert.equal(new Set(events[0].markets[0].selections.map(s => s.id)).size, 3);
    assert.equal(events[0].sourceId, id);
    assert.equal(new URL(events[0].sourceUrl).searchParams.get('integration'), id);
    assert.ok(instantiate(id, { jobConfig: cfg(id) }) instanceof A);
    for (const field of ['engine', 'transport', 'script', 'sourceIds']) {
      assert.throws(() => instantiate(id, { jobConfig: { ...cfg(id), [field]: 'unknown' } }), { code: 'ESCRAPERCONFIG' });
    }
  });
}
const mutations = {
  live: r => { r.events[0].status = 1; },
  past: r => { r.events[0].startDate = '2020-01-01T00:00:00Z'; },
  otherSport: r => { r.events[0].sportId = 68; },
  simulated: r => { r.categories.find(c => c.id === r.events[0].catId).iso = ''; },
  incomplete: r => { r.markets[0].oddIds.pop(); },
  repeatedOutcome: r => { r.markets[0].oddIds[2] = r.markets[0].oddIds[0]; },
  suspended: r => { r.odds[0].oddStatus = 1; },
  infinite: r => { r.odds[0].price = Infinity; },
  invalidPrice: r => { r.odds[0].price = 1; },
  half: r => { r.markets[0].name = 'First half 1x2'; },
  handicap: r => { r.markets[0].sv = '1'; },
  wrongTeam: r => { r.odds[0].competitorId = -1; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`reject ${name}`, () => {
  const r = structuredClone(fixtures.million);
  mutate(r);
  const a = parser();
  assert.ok(!a.extractEvents(a.normalize(r)).some(e => e.id === String(r.events[0].id)));
});
test('malformed schemas fail and accepted events obey caps', () => {
  const a = parser('million', { maxEvents: 1 });
  assert.equal(a.extractEvents(a.normalize(fixtures.million)).length, 1);
  assert.throws(() => a.normalize({ events: [] }));
  const raw = structuredClone(fixtures.million);
  raw.odds.push(raw.odds[0]);
  assert.throws(() => a.normalize(raw), /duplicate/);
  assert.throws(() => new A('unknown'));
  assert.throws(() => new A('don', { maxEvents: -1 }));
});
test('bounded request, abort, zero cap and HTTP failures', async () => {
  let calls = 0;
  const a = new A('million', { fetchImpl: async (url, opts) => {
    calls++;
    assert.equal(opts.redirect, 'error');
    assert.ok(opts.signal);
    assert.equal(new URL(url).searchParams.get('eventCount'), '100');
    return Response.json(fixtures.million);
  } });
  await a.fetchRaw();
  assert.ok(calls >= 1);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(a.fetchRaw({ signal: ac.signal }));
  assert.ok(calls >= 1);
  await new A('don', { maxEvents: 0, fetchImpl: () => assert.fail() }).fetchRaw();
  await assert.rejects(new A('don', { sport: 'curling' }).fetchRaw(), /no catalogue/);
  await assert.rejects(new A('don', { fetchImpl: async () => new Response('', { status: 403 }) }).fetchRaw(), /HTTP 403/);
  await assert.rejects(new A('don', { fetchImpl: async () => new Response('<html>') }).fetchRaw(), /expected JSON/);
  await assert.rejects(new A('don', { timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
    await new Promise(resolve => setTimeout(resolve, 20)); signal.throwIfAborted();
  } }).fetchRaw());
});
test('pagination reaches the rest of the board, and rows are deduplicated across pages', async () => {
  // Measured live 2026-09-29 on don and million: the widget serves `eventCount`
  // pages of exactly 100, and five pages returned 500 events with ZERO overlap,
  // running from 2026-09-29T15:27 out to 2026-10-02T23:00. Page 1 alone starts
  // at "now", so most of its hundred events are already in play and get dropped
  // — a tenant with an event cap of 3000 was publishing 37 fixtures off a
  // board of several hundred. `eventCount` above 100 is refused by the feed, so
  // paging is the only way through.
  const page = (n, opts = {}) => {
    const base = structuredClone(fixtures.don);
    base.events = base.events.map((e, i) => ({ ...e, id: n * 1000 + i }));
    return Response.json(base, opts);
  };
  const seenPages = [];
  const a = new A('don', {
    maxEvents: 5000,
    fetchImpl: async (url) => {
      const p = Number(new URL(url).searchParams.get('page'));
      seenPages.push(p);
      assert.equal(new URL(url).searchParams.get('eventCount'), '100', 'a page is 100; the feed refuses more');
      // Pages 1-3 carry fresh events; page 4 serves page 1 again, which is what
      // the end of a board looks like: no new event, so no read past it.
      return p > 3 ? page(1) : page(p);
    },
  });
  const raw = await a.fetchRaw();
  assert.deepEqual(seenPages, [1, 2, 3, 4], 'stops on the first page that adds nothing new');
  // One fixture page's worth of events per page read, disjoint by construction:
  // the three pages that carried new events. The fourth was page 1 again and
  // contributed nothing.
  assert.equal(raw.events.length, 3 * eventCount('don'));
  // champs/categories/headers repeat identically on every real page, and
  // normalize() rejects a duplicate id outright — so merging must dedup.
  for (const key of ['markets', 'odds', 'competitors', 'champs', 'categories']) {
    const ids = raw[key].map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `${key} has duplicate ids after merging pages`);
  }
  assert.doesNotThrow(() => a.normalize(raw), 'the merged payload must pass normalize');

  // A later page failing ends pagination and keeps what already succeeded; page
  // 1 failing is still fatal, because that is what the single read used to do.
  let n = 0;
  const partial = new A('don', {
    maxEvents: 5000,
    fetchImpl: async (url) => {
      n++;
      if (n === 1) return page(1);
      throw new Error('HTTP 503 from page 2');
    },
  });
  const kept = await partial.fetchRaw();
  assert.equal(kept.events.length, eventCount('don'), 'the pages that succeeded are kept');
  await assert.rejects(new A('don', { fetchImpl: async () => new Response('', { status: 500 }) }).fetchRaw(), /HTTP 500/);
});

test('scratch lifecycle snapshots load; exact duplicate offers are not independent legs', async (t) => {
  await fs.mkdir('scratch/altenar-repair', { recursive: true });
  const dir = await fs.mkdtemp('scratch/altenar-repair/offline-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const id of ['powerbet', 'winbet']) {
    const raw = structuredClone(fixtures[id]);
    for (const e of raw.events) e.startDate = new Date(Date.now() + 3600000).toISOString();
    // Equal kickoff makes duplicate identity deterministic.
    for (const e of raw.events) e.startDate = new Date(Math.ceil(Date.now() / 3600000) * 3600000 + 3600000).toISOString();
    const a = new A(id, { dataDir: dir, runId: 'offline-altenar', fetchImpl: async () => Response.json(raw) });
    const result = await a.run();
    assert.equal(result.valid, true);
    assert.equal(result.events, 2);
    const single = await loadWorkspace(dir, { expectedRunId: 'offline-altenar' });
    assert.ok(single.sources.every(s => s.dataStatus === 'fresh'));
  }
  const loaded = await loadWorkspace(dir, { expectedRunId: 'offline-altenar' });
  assert.equal(loaded.events.length, 2);
  assert.equal(loaded.sources.find(s => s.sourceId === 'winbet').duplicateFeedEvents, 2);
});

/**
 * These tenants serve goals totals and both-teams-to-score in the same payload
 * as the 1X2. Publishing only the 1X2 threw away two arbitrage-eligible
 * families for six bookmakers, so the adapter now emits them too.
 *
 * The risk these guard is the opposite one: a total whose line is lost, or a
 * BTTS market whose shape the engine cannot read, either buckets with the wrong
 * line or falls through to a two-way match result — which would invent an
 * arbitrage rather than find one.
 */

for (const id of ALTENAR_IDS) {
  test(`${id}: publishes totals and BTTS, and the engine prices both`, () => {
    const a = parser(id);
    const events = a.extractEvents(a.normalize(fixtures[id]));
    for (const e of events) {
      const families = e.markets.map((m) => resolveContract(m)?.family);
      assert.ok(families.includes('MATCH_ODDS'), `${id}: the 1X2 must still be published`);
      const totals = e.markets.filter((m) => resolveContract(m)?.family === 'OVER_UNDER');
      assert.ok(totals.length > 0, `${id}: expected at least one priced total`);
      for (const m of totals) {
        // The line must survive into the contract, and match the line the two
        // selection names carry — that pair is what OVER 2.5 not colliding with
        // OVER 3.5 depends on.
        const contract = resolveContract(m);
        assert.equal(contract.lineKey, m.line, `${id}: total line must reach the contract`);
        assert.deepEqual(m.selections.map((s) => s.name), [`Peste ${m.line}`, `Sub ${m.line}`]);
        for (const s of m.selections) assert.ok(s.odds > 1, `${id}: a priced leg needs odds > 1`);
      }
      const btts = e.markets.filter((m) => resolveContract(m)?.family === 'BTTS');
      for (const m of btts) {
        assert.deepEqual(m.selections.map((s) => s.name), ['Da', 'Nu']);
        assert.equal(m.period, 'fulltime');
      }
    }
  });

  test(`${id}: the 1X2 stays the first market`, () => {
    // The market order is part of the contract other code relies on.
    const a = parser(id);
    for (const e of a.extractEvents(a.normalize(fixtures[id]))) {
      assert.equal(resolveContract(e.markets[0]).family, 'MATCH_ODDS');
    }
  });
}

/**
 * The Altenar feed serves a goals spread under typeId 16 "Handicap Goluri" in
 * the same payload as the 1X2, and publishing only the 1X2 threw the family
 * away. don and topbet carry it; million, baumbet, powerbet and winbet serve no
 * type-16 market at all, so the tenors differ and the tests below assert the
 * presence where the feed has one and never require it.
 *
 * The mapping is exercised on BOTH tenants that have one — the reader is shared
 * code, but the catalogue is not, and a per-tenant regression is exactly the
 * failure a single-tenant test cannot see.
 */
const SPREAD_BOOKS = ['don', 'topbet'];
// The other leg's line, written the way the feed writes a line: always signed.
const negatedLine = (line) => {
  const n = -Number(line);
  return n < 0 ? String(n) : `+${n}`;
};

test('the goals spread is published one market per line, and the engine prices it', () => {
  for (const id of SPREAD_BOOKS) {
    const a = parser(id);
    const events = a.extractEvents(a.normalize(fixtures[id]));
    const spreads = events.flatMap((e) => e.markets.map((m) => [e, m]))
      .filter(([, m]) => resolveContract(m)?.family === 'ASIAN_HANDICAP');
    assert.ok(spreads.length > 0, `${id}: serves a goals spread, so one must be published`);

    for (const [e, m] of spreads) {
      const contract = resolveContract(m);
      // Both legs carry an explicit sign, the way the feed writes them: the
      // negated line of "-0.5" is "+0.5" and of "+1.5" is "-1.5".
      const negated = negatedLine(m.line);
      assert.deepEqual(m.selections.map((s) => s.name), [`1 (${m.line})`, `2 (${negated})`],
        `${id} ${e.id}: a leg must name its side and the line it prices`);
      assert.equal(m.selections.every((s) => s.odds > 1), true, 'both legs must be priced above 1');
      assert.equal(m.period, 'fulltime');
      // The bucket key is built from the numeric line and oriented by the side
      // token, so home -0.5 ("-0.5/0.5") and home +0.5 ("0.5/-0.5") are two
      // buckets. The "+" the feed writes is a display convention and is not
      // part of the key: +1.5 and 1.5 are one line, not two.
      assert.equal(contract.lineKey, `${Number(m.line)}/${-Number(m.line)}`);
      assert.deepEqual(contract.outcomes, ['home', 'away']);
      assert.notEqual(contract.arbEligible, false,
        'a goals spread is mutually exclusive and exhaustive, so it is arbitrable');
    }
  }
});

test('a home side receiving goals is published, not dropped for its "+" sign', () => {
  // The regression. `sv` is the HOME line and the feed always writes the sign:
  // "-0.5" when the home side gives goals, "+0.5" when it receives them. A
  // half-line guard that accepted only an optional minus threw away every
  // handicap whose home side is the underdog. Measured 2026-10-02 on don: 50 of
  // the 107 type-16 markets on the board carry a leading "+", so this was not a
  // rare shape — it was roughly half the family.
  //
  // The don fixture's third event is a real capture (Slough Town v Ebbsfleet,
  // 2026-10-02) quoted at "+1.5" for the home side, so the case is a real one
  // and not a hand-built one.
  const a = parser('don');
  const events = a.extractEvents(a.normalize(fixtures.don));
  const receiving = events.flatMap((e) => e.markets)
    .filter((m) => resolveContract(m)?.family === 'ASIAN_HANDICAP' && String(m.line).startsWith('+'));
  assert.ok(receiving.length > 0, 'a "+" home line must be published');
  for (const m of receiving) {
    assert.deepEqual(m.selections.map((s) => s.name), [`1 (${m.line})`, `2 (${negatedLine(m.line)})`]);
    // The direction is what keeps the two orientations apart: home +1.5 buckets
    // as "1.5/-1.5" and must never share a bucket with home -1.5. The leading
    // "+" is display only — the key is the numeric line pair.
    assert.equal(resolveContract(m).lineKey, `${Number(m.line)}/${-Number(m.line)}`);
  }
  // And the opposite orientation really is a different bucket, from the same
  // fixture, with the line simply mirrored.
  const mirror = structuredClone(fixtures.don);
  const hcap = mirror.markets.find((m) => m.typeId === 16);
  hcap.sv = '-1.5';
  hcap.sn = '-1.5';
  const b = parser('don');
  const mirrored = b.extractEvents(b.normalize(mirror))
    .flatMap((e) => e.markets)
    .find((m) => resolveContract(m)?.family === 'ASIAN_HANDICAP');
  assert.equal(resolveContract(mirrored).lineKey, '-1.5/1.5',
    'mirroring the line must move it to the other bucket, not rename it');
});

test('a spread that is not exhaustive is refused, and a whole line is refused twice', () => {
  // A whole line pushes at the level result and a quarter line pushes half, so
  // neither pair is exhaustive and an inverse sum under 1 is not a surebet. The
  // adapter refuses to publish them, and the router refuses to route them, so
  // this is asserted on both sides: an adapter that published one would be
  // caught by the router assertion, and a router that accepted one would be
  // caught here.
  for (const bad of ['-1', '-1.25', '-1.75', '0']) {
    const r = structuredClone(fixtures.don);
    const hcap = r.markets.find((m) => m.typeId === 16);
    hcap.sv = bad;
    hcap.sn = bad;
    const a = parser('don');
    const events = a.extractEvents(a.normalize(r));
    assert.equal(events.length, eventCount('don'), `${bad}: the event itself stays valid`);
    for (const e of events) {
      assert.ok(!e.markets.some((m) => resolveContract(m)?.family === 'ASIAN_HANDICAP'),
        `${bad} is not an exhaustive two-way contract and must not be published`);
      assert.ok(e.markets.some((m) => resolveContract(m)?.family === 'MATCH_ODDS'),
        'the 1X2 must still be published');
    }
    // The router is terminal on a declared ASIAN_HANDICAP, so it must also
    // refuse the same shape when handed it directly.
    assert.equal(resolveContract({ key: 'ASIAN_HANDICAP', period: 'fulltime', period_label: 'Full time',
      selections: [{ name: `1 (${bad})`, odds: 1.9 }, { name: `2 (${-Number(bad)})`, odds: 1.9 }] }), null,
    `${bad} must not route as a spread`);
  }
});

test('a spread leg that is suspended, unanchored or half-quoted is not published', () => {
  const drop = (mutate, why) => {
    const r = structuredClone(fixtures.don);
    const hcap = r.markets.find((m) => m.typeId === 16);
    mutate(r, hcap);
    const a = parser('don');
    const events = a.extractEvents(a.normalize(r));
    assert.equal(events.length, eventCount('don'), `${why}: the event itself stays valid`);
    assert.ok(!events.some((e) => e.markets.some((m) => resolveContract(m)?.family === 'ASIAN_HANDICAP')),
      `${why}: the spread must not be published`);
  };
  // The legs are labelled by competitor, so the anchor is the only thing that
  // stops a mirrored tenant being published with its two sides swapped.
  drop((r, hcap) => { r.odds.find((o) => o.id === hcap.oddIds[0]).competitorId = 999999; }, 'a leg off its competitor');
  drop((r, hcap) => { r.odds.find((o) => o.id === hcap.oddIds[0]).oddStatus = 1; }, 'a suspended leg');
  drop((r, hcap) => { r.odds.find((o) => o.id === hcap.oddIds[0]).price = 1; }, 'a leg priced at 1');
  drop((r, hcap) => { r.odds.find((o) => o.id === hcap.oddIds[0]).typeId = 1716; }, 'an unknown leg type');
  drop((r, hcap) => { hcap.oddIds.pop(); }, 'a half-quoted spread');
  drop((r, hcap) => { hcap.sv = undefined; hcap.sn = undefined; }, 'a spread with no line');
  // Two lines on one market are one contract with a duplicate leg, not two.
  drop((r, hcap) => { hcap.oddIds[1] = hcap.oddIds[0]; }, 'a repeated leg');
});

test('the other Altenar tenants serve no goals spread, and none is invented', () => {
  // million, baumbet, powerbet, winbet, frankcasino, mrbit, slotv, betinia, win2ro, swiper,
  // rabona, campobet, librabet, sportaza, greatwin, fezbet, wazamba, nomini, casinia, quickwin,
  // stake, bcgame, sportsbetio, duelbits, solcasino, betriot, spinanga
  // return no type-16 market at all
  // (measured per tenant, not inferred from don and topbet), so the mapping
  // must produce none for them rather than a line invented from the 1X2.
  const without = ALTENAR_IDS.filter((id) => !SPREAD_BOOKS.includes(id));
  assert.deepEqual(without, [
    'million', 'baumbet', 'powerbet', 'winbet', 'frankcasino', 'mrbit', 'slotv', 'betinia', 'win2ro', 'swiper',
    'rabona', 'campobet', 'librabet', 'sportaza', 'greatwin', 'fezbet', 'wazamba', 'nomini', 'casinia', 'quickwin',
    'stake', 'bcgame', 'sportsbetio', 'duelbits', 'solcasino', 'betriot', 'spinanga', 'powbet', 'sportuna', 'casinoly', 'excitewin', 'cazimbo', 'slotspalace', 'malinacasino', 'zet', 'kingmaker', 'crownplay', '5gringos', 'ohmyspins', 'boomerang', 'goldenbet', 'casombie', 'campeonbet', 'betsamigo', 'betalright', 'fairspin', 'spinight', 'goldspin', 'wildsino', 'betstro', 'evobet', 'svenbet', 'sonsofslots', 'wallacebet', 'betrebels', 'prontobet', 'betovo', 'quickslot', 'betbeast', 'slotparadise', 'joker8', 'betway',
  ], 'the two tenants that serve a spread are the ones the feed says they do');
  for (const id of without) {
    assert.ok(!fixtures[id].markets.some((m) => m.typeId === 16),
      `${id}: the capture carries no spread, so this stays true`);
    const a = parser(id);
    const events = a.extractEvents(a.normalize(fixtures[id]));
    assert.ok(!events.some((e) => e.markets.some((m) => resolveContract(m)?.family === 'ASIAN_HANDICAP')),
      `${id}: no spread may be invented where the feed has none`);
  }
});

test('the run reports the handicap it now covers', async () => {
  // Same shape as the lifecycle snapshot below: the real run writes the
  // coverage block, so that is where the string is checked rather than on a
  // hand-called prototype method.
  await fs.mkdir('scratch/altenar-repair', { recursive: true });
  const dir = await fs.mkdtemp('scratch/altenar-repair/hcap-');
  try {
    const raw = structuredClone(fixtures.don);
    for (const e of raw.events) e.startDate = new Date(Date.now() + 3600000).toISOString();
    const a = new A('don', { dataDir: dir, runId: 'hcap', fetchImpl: async () => Response.json(raw) });
    assert.equal((await a.run()).valid, true);
    const { readJson } = await import('../src/shared/atomic-write.mjs');
    const snap = await readJson(`${dir}/workspace/don_events.json`, null);
    assert.match(snap.coverage.market, /asian_handicap/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the coverage string reports only the families the run emitted', () => {
  // It was the literal 'fulltime-1x2+tgoals+asian_handicap+btts' for all six
  // tenants, which promised million, baumbet, powerbet and winbet a football
  // handicap none of them serves — measured 2026-10-02, those four send three
  // market shapes and no type-16 market at all, while don and topbet do. A
  // coverage string that overstates is the same false claim as a wrong market
  // mapping, in the one field an operator reads to judge whether a book is
  // worth keeping.
  //
  // So the string is derived from the events this run produced. Two directions
  // are asserted: a run with a handicap says so, and a run without one does not
  // — the second is the case the hardcoded string got wrong.
  const familiesOf = (id, events) => new A(id, { windowHours: 24 })
    ._serializable(events, {}).coverage.market;

  const withHandicap = parser('don');
  const hcapEvents = withHandicap.extractEvents(withHandicap.normalize(structuredClone(fixtures.don)));
  assert.ok(hcapEvents.some((e) => e.markets.some((m) => m.key === 'ASIAN_HANDICAP')),
    'the don fixture really does carry handicap markets, or this test proves nothing');
  assert.match(familiesOf('don', hcapEvents), /asian_handicap/);

  // The same events with every handicap market removed: a tenant whose board
  // stops quoting one must stop claiming it, with no code change.
  const stripped = hcapEvents.map((e) => ({
    ...e, markets: e.markets.filter((m) => m.key !== 'ASIAN_HANDICAP'),
  }));
  const market = familiesOf('million', stripped);
  assert.doesNotMatch(market, /asian_handicap/);
  assert.equal(market, 'fulltime-1x2+tgoals+btts',
    'only the handicap is withdrawn, and the families the run did emit stay');

  // An empty run claims nothing beyond the 1X2 it could not publish either.
  assert.equal(familiesOf('winbet', []), 'fulltime-1x2');
});

test('a total without a line is dropped rather than published nameless', () => {
  // No line means the two selections collapse into a contract the engine cannot
  // bucket, which is worse than not publishing it. Only the totals are stripped
  // here; the 1X2 and BTTS stay intact and the events themselves remain valid.
  const r = structuredClone(fixtures.million);
  const totals = r.markets.filter((m) => m.typeId === 18);
  for (const m of totals) { m.sv = undefined; m.sn = undefined; }
  const a = parser();
  const events = a.extractEvents(a.normalize(r));
  assert.equal(events.length, 2, 'the events themselves are still valid');
  for (const e of events) {
    assert.ok(!e.markets.some((m) => resolveContract(m)?.family === 'OVER_UNDER'),
      'an unlineable total must not be published');
    assert.ok(e.markets.some((m) => resolveContract(m)?.family === 'MATCH_ODDS'),
      'the 1X2 must still be published');
  }
});

test('a suspended or half-quoted total is skipped without losing the event', () => {
  // The extras are additive: one bad market must not take the 1X2 down with it.
  const suspend = structuredClone(fixtures.million);
  // Each event references its own type-18 market object, so suspend every
  // total to assert the "no total survives" outcome; a half-quoted total is
  // dropped regardless of which event owns it.
  for (const tm of suspend.markets.filter((m) => m.typeId === 18)) {
    suspend.odds.find((o) => o.id === tm.oddIds[0]).oddStatus = 1;
  }
  const a = parser();
  let events = a.extractEvents(a.normalize(suspend));
  assert.equal(events.length, 2);
  // Event 1 keeps its 1X2 and its independent BTTS; only the suspended total
  // is dropped. Event 2 has no BTTS in this fixture, so it keeps the 1X2 only.
  const e1 = events.find((e) => e.markets.some((m) => resolveContract(m)?.family === 'BTTS'));
  assert.ok(e1, 'the event with BTTS survives');
  assert.ok(e1.markets.some((m) => resolveContract(m)?.family === 'MATCH_ODDS'));
  for (const e of events) {
    assert.ok(!e.markets.some((m) => resolveContract(m)?.family === 'OVER_UNDER'),
      'the suspended total must be dropped, not published half-quoted');
  }

  const short = structuredClone(fixtures.million);
  const t2 = short.markets.find((m) => m.typeId === 29);
  t2.oddIds.pop();
  const b = parser();
  events = b.extractEvents(b.normalize(short));
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.ok(!e.markets.some((m) => resolveContract(m)?.family === 'BTTS'),
      'a BTTS market missing a leg must not be published');
    assert.ok(e.markets.some((m) => resolveContract(m)?.family === 'MATCH_ODDS'),
      'the 1X2 must still be published');
  }
});

test('markets the engine cannot price as a surebet are still not published', () => {
  // Double chance and draw-no-bet are in the payload and are deliberately left
  // out. Double chance is arbEligible:false, and a DNB leg does not share a
  // payoff with another book's match result — publishing it would invent an
  // arbitrage.
  const r = structuredClone(fixtures.million);
  const ids = new Set(r.markets.map((m) => m.id));
  const a = parser();
  for (const e of a.extractEvents(a.normalize(r))) {
    for (const m of e.markets) {
      assert.ok(ids.has(Number(m.providerMarketId)));
      assert.notEqual(m.key, 'DOUBLE_CHANCE');
      assert.notEqual(m.key, 'DRAW_NO_BET');
      assert.ok(!['Golul primul', 'Șansă dublă', 'Egal pariu nul'].includes(m.name),
        `unexpected market family published: ${m.name}`);
    }
  }
});

test('altenar extracts 2-way match winner for tennis/basketball events', () => {
  const raw = structuredClone(fixtures.million);
  raw._sportNames = { 68: 'Tennis' };
  // Transform first event to a tennis 2-way event
  const ev = raw.events[0];
  ev.sportId = 68; // tennis
  const [homeId, awayId] = ev.competitorIds;
  const winnerMkt = {
    id: 999901,
    typeId: 1,
    name: 'Castigator meci',
    oddIds: [999911, 999912],
  };
  raw.markets.push(winnerMkt);
  raw.odds.push(
    { id: 999911, typeId: 1, competitorId: homeId, price: 1.85, oddStatus: 0 },
    { id: 999912, typeId: 3, competitorId: awayId, price: 1.95, oddStatus: 0 }
  );
  ev.marketIds = [winnerMkt.id];
  const a = parser('million', { sports: ['tennis'] });
  const events = a.extractEvents(a.normalize(raw));
  assert.equal(events.length, 1);
  assert.equal(events[0].sport, 'Tennis');
  assert.equal(events[0].markets[0].key, 'MATCH_ODDS');
  assert.equal(events[0].markets[0].selections.length, 2);
  assert.deepEqual(events[0].markets[0].selections.map((s) => s.name), ['1', '2']);
});

test('altenar extracts 2-way moneyline with market typeId 2', () => {
  const raw = structuredClone(fixtures.million);
  raw._sportNames = { 67: 'Basketball' };
  const ev = raw.events[0];
  ev.sportId = 67; // basketball
  const [homeId, awayId] = ev.competitorIds;
  const moneylineMkt = {
    id: 999902,
    typeId: 2, // Type ID 2: Moneyline / 2-way winner
    name: 'Money Line',
    oddIds: [999921, 999922],
  };
  raw.markets.push(moneylineMkt);
  raw.odds.push(
    { id: 999921, typeId: 1, competitorId: homeId, price: 1.65, oddStatus: 0 },
    { id: 999922, typeId: 2, competitorId: awayId, price: 2.25, oddStatus: 0 }
  );
  ev.marketIds = [moneylineMkt.id];
  const a = parser('million', { sports: ['basketball'] });
  const events = a.extractEvents(a.normalize(raw));
  assert.equal(events.length, 1);
  assert.equal(events[0].sport, 'Basketball');
  assert.equal(events[0].markets[0].key, 'MATCH_ODDS');
  assert.equal(events[0].markets[0].selections.length, 2);
  assert.deepEqual(events[0].markets[0].selections.map((s) => s.name), ['1', '2']);
  assert.equal(events[0].markets[0].selections[0].odds, 1.65);
  assert.equal(events[0].markets[0].selections[1].odds, 2.25);
});

test('altenar multi-sport catalog crawling and dynamic pageCount pagination', async () => {
  const requestedSports = [];
  const requestedPages = [];
  const a = new A('don', {
    sport: 'all',
    fetchImpl: async (url) => {
      const u = new URL(url);
      const sId = Number(u.searchParams.get('sportId'));
      const p = Number(u.searchParams.get('page'));
      requestedSports.push(sId);
      requestedPages.push({ sportId: sId, page: p });
      assert.equal(u.searchParams.get('eventCount'), '100');
      const base = structuredClone(fixtures.don);
      // Give each sport unique event ids and pageCount: 2
      base.events = base.events.map((e, idx) => ({ ...e, id: sId * 10000 + p * 100 + idx, sportId: sId }));
      return Response.json({ ...base, pageCount: 2 });
    },
  });
  const raw = await a.fetchRaw();
  // Core sports: 66 (football), 67 (basketball), 68 (tennis), 70 (ice hockey)
  assert.deepEqual([...new Set(requestedSports)], [66, 67, 68, 70]);
  // Each sport should have fetched 2 pages as dictated by pageCount: 2
  for (const sId of [66, 67, 68, 70]) {
    const sportPages = requestedPages.filter((x) => x.sportId === sId).map((x) => x.page);
    assert.deepEqual(sportPages, [1, 2]);
  }
  assert.ok(raw.events.length > 0);
});

test('altenar: basketball points totals and point spread markets resolve with basketball taxonomy', () => {
  const raw = structuredClone(fixtures.don);
  const bballEvent = raw.events[0];
  bballEvent.sportId = 67; // Basketball
  // Set 2-way match winner
  const m1 = raw.markets.find((m) => m.id === bballEvent.marketIds[0]);
  m1.typeId = 2;
  m1.name = 'Match Winner';
  m1.oddIds = [99901, 99902];

  // Set basketball total
  const mTotal = raw.markets.find((m) => m.id === bballEvent.marketIds[1]);
  mTotal.typeId = 18;
  mTotal.name = 'Total Points';
  mTotal.sv = '214.5';
  mTotal.oddIds = [99911, 99912];

  // Set basketball spread
  const mSpread = {
    id: 99999,
    typeId: 16,
    name: 'Point Spread',
    sv: '-4.5',
    oddIds: [99921, 99922],
  };
  bballEvent.marketIds.push(mSpread.id);
  raw.markets.push(mSpread);

  const [homeId, awayId] = bballEvent.competitorIds;
  raw.odds.push(
    { id: 99901, typeId: 1, competitorId: homeId, oddStatus: 0, price: 1.85 },
    { id: 99902, typeId: 3, competitorId: awayId, oddStatus: 0, price: 1.95 },
    { id: 99911, typeId: 12, oddStatus: 0, price: 1.90 },
    { id: 99912, typeId: 13, oddStatus: 0, price: 1.90 },
    { id: 99921, typeId: 1714, competitorId: homeId, oddStatus: 0, price: 1.91 },
    { id: 99922, typeId: 1715, competitorId: awayId, oddStatus: 0, price: 1.89 },
  );

  const a = new A('don', { sport: 'basketball' });
  a.from = Date.parse('2026-09-21T19:00:00Z');
  a.to = a.from + 86400000;
  a.observedAt = new Date().toISOString();

  const events = a.extractEvents(a.normalize(raw));
  assert.ok(events.length >= 1);
  const ev = events.find((e) => e.id === String(bballEvent.id));
  assert.ok(ev);
  assert.equal(ev.sport, 'Basketball');

  const totalMarket = ev.markets.find((m) => m.key.startsWith('POINTS_OVER_UNDER'));
  assert.ok(totalMarket, 'points total market exists');
  assert.equal(totalMarket.key, 'POINTS_OVER_UNDER_214_5');
  assert.equal(totalMarket.subject, 'points');

  const spreadMarket = ev.markets.find((m) => m.key === 'POINT_SPREAD');
  assert.ok(spreadMarket, 'point spread market exists');
});

test('altenar: live events are admitted when includeLive is true', () => {
  const raw = structuredClone(fixtures.don);
  const liveEvent = raw.events[0];
  liveEvent.status = 1; // In-play

  // Without includeLive: dropped
  const aPre = new A('don');
  aPre.from = Date.parse('2026-09-21T19:00:00Z');
  aPre.to = aPre.from + 86400000;
  assert.equal(aPre.extractEvents(aPre.normalize(raw)).some((e) => e.id === String(liveEvent.id)), false);

  // With includeLive: admitted with live: true
  const aLive = new A('don', { includeLive: true });
  aLive.from = Date.parse('2026-09-21T19:00:00Z');
  aLive.to = aLive.from + 86400000;
  const events = aLive.extractEvents(aLive.normalize(raw));
  const ev = events.find((e) => e.id === String(liveEvent.id));
  assert.ok(ev, 'live event is collected when includeLive is true');
  assert.equal(ev.live, true);
  assert.equal(ev.isLive, true);
  assert.equal(ev.markets[0].live, true);
});

test('altenar: extracts tennis Set 1 Winner and resolves to MATCH_ODDS with period set1', () => {
  const raw = structuredClone(fixtures.million);
  raw._sportNames = { 68: 'Tennis' };
  const ev = raw.events[0];
  ev.sportId = 68; // Tennis
  const [homeId, awayId] = ev.competitorIds;

  // Match winner (fulltime)
  const matchWinner = {
    id: 998001,
    typeId: 2,
    name: 'Castigator meci',
    oddIds: [998011, 998012],
  };
  // Set 1 winner
  const set1Winner = {
    id: 998002,
    typeId: 2,
    name: 'Castigator setul 1',
    oddIds: [998021, 998022],
  };
  raw.markets.push(matchWinner, set1Winner);
  raw.odds.push(
    { id: 998011, typeId: 1, competitorId: homeId, price: 1.70, oddStatus: 0 },
    { id: 998012, typeId: 2, competitorId: awayId, price: 2.15, oddStatus: 0 },
    { id: 998021, typeId: 1, competitorId: homeId, price: 1.75, oddStatus: 0 },
    { id: 998022, typeId: 2, competitorId: awayId, price: 2.05, oddStatus: 0 },
  );
  ev.marketIds = [matchWinner.id, set1Winner.id];

  const a = parser('million', { sports: ['tennis'] });
  const events = a.extractEvents(a.normalize(raw));
  assert.equal(events.length, 1);
  const mFull = events[0].markets.find((m) => m.providerMarketId === '998001');
  const mSet1 = events[0].markets.find((m) => m.providerMarketId === '998002');
  assert.ok(mFull, 'fulltime market extracted');
  assert.ok(mSet1, 'set 1 winner extracted');
  assert.equal(mFull.period, 'fulltime');
  assert.equal(mSet1.period, 'set1');
  assert.equal(mSet1.key, 'SET_WINNER');

  const contractFull = resolveContract(mFull, { sport: 'tennis' });
  const contractSet1 = resolveContract(mSet1, { sport: 'tennis' });
  assert.equal(contractFull.family, 'MATCH_ODDS');
  assert.equal(contractFull.period, 'fulltime');
  assert.equal(contractSet1.family, 'MATCH_ODDS');
  assert.equal(contractSet1.period, 'set1');
});

test('altenar: extracts basketball Quarter 1 Winner and Q1 totals with period q1', () => {
  const raw = structuredClone(fixtures.million);
  raw._sportNames = { 67: 'Basketball' };
  const ev = raw.events[0];
  ev.sportId = 67; // Basketball
  const [homeId, awayId] = ev.competitorIds;

  // Match winner (fulltime)
  const matchWinner = {
    id: 997001,
    typeId: 2,
    name: 'Money Line',
    oddIds: [997011, 997012],
  };
  // Quarter 1 winner
  const q1Winner = {
    id: 997002,
    typeId: 2,
    name: 'Castigator Sfertul 1',
    oddIds: [997021, 997022],
  };
  // Quarter 1 points total
  const q1Total = {
    id: 997003,
    typeId: 18,
    name: 'Total puncte - Sfertul 1',
    sv: '52.5',
    oddIds: [997031, 997032],
  };
  raw.markets.push(matchWinner, q1Winner, q1Total);
  raw.odds.push(
    { id: 997011, typeId: 1, competitorId: homeId, price: 1.55, oddStatus: 0 },
    { id: 997012, typeId: 2, competitorId: awayId, price: 2.45, oddStatus: 0 },
    { id: 997021, typeId: 1, competitorId: homeId, price: 1.68, oddStatus: 0 },
    { id: 997022, typeId: 2, competitorId: awayId, price: 2.18, oddStatus: 0 },
    { id: 997031, typeId: 12, price: 1.88, oddStatus: 0 },
    { id: 997032, typeId: 13, price: 1.92, oddStatus: 0 },
  );
  ev.marketIds = [matchWinner.id, q1Winner.id, q1Total.id];

  const a = parser('million', { sports: ['basketball'] });
  const events = a.extractEvents(a.normalize(raw));
  assert.equal(events.length, 1);
  const mQ1Winner = events[0].markets.find((m) => m.providerMarketId === '997002');
  const mQ1Total = events[0].markets.find((m) => m.providerMarketId === '997003');
  assert.ok(mQ1Winner, 'Q1 winner extracted');
  assert.ok(mQ1Total, 'Q1 total extracted');
  assert.equal(mQ1Winner.period, 'q1');
  assert.equal(mQ1Winner.key, 'QUARTER_WINNER');
  assert.equal(mQ1Total.period, 'q1');

  const contractQ1Winner = resolveContract(mQ1Winner, { sport: 'basketball' });
  const contractQ1Total = resolveContract(mQ1Total, { sport: 'basketball' });
  assert.equal(contractQ1Winner.family, 'MATCH_ODDS');
  assert.equal(contractQ1Winner.period, 'q1');
  assert.equal(contractQ1Total.family, 'OVER_UNDER');
  assert.equal(contractQ1Total.period, 'q1');
  assert.equal(contractQ1Total.subject, 'points');
  assert.equal(contractQ1Total.lineKey, '52.5');
});

test('altenar: extracts football 1st Half 1x2 and period does not collide with fulltime', () => {
  const raw = structuredClone(fixtures.million);
  raw._sportNames = { 66: 'Football' };
  const ev = raw.events[0];
  const [homeId, awayId] = ev.competitorIds;

  // 1st Half 1X2
  const half1X2 = {
    id: 996001,
    typeId: 1,
    name: '1x2 - Repriza 1',
    oddIds: [996011, 996012, 996013],
  };
  raw.markets.push(half1X2);
  raw.odds.push(
    { id: 996011, typeId: 1, competitorId: homeId, price: 2.80, oddStatus: 0 },
    { id: 996012, typeId: 2, price: 2.10, oddStatus: 0 },
    { id: 996013, typeId: 3, competitorId: awayId, price: 3.40, oddStatus: 0 },
  );
  ev.marketIds.push(half1X2.id);

  const a = parser('million');
  const events = a.extractEvents(a.normalize(raw));
  const evFound = events.find((e) => e.id === String(ev.id));
  assert.ok(evFound, 'event found');
  const mFull = evFound.markets.find((m) => m.period === 'fulltime' && m.key === '1x2');
  const mHalf = evFound.markets.find((m) => m.providerMarketId === '996001');
  assert.ok(mFull, 'fulltime 1x2 found');
  assert.ok(mHalf, '1st half 1x2 found');
  assert.equal(mHalf.period, 'half1');

  const contractFull = resolveContract(mFull, { sport: 'football' });
  const contractHalf = resolveContract(mHalf, { sport: 'football' });
  assert.equal(contractFull.period, 'fulltime');
  assert.equal(contractHalf.period, 'half1');
  assert.notEqual(contractFull.period, contractHalf.period);
});

test('altenar: extracts sub-window half BTTS alongside fulltime BTTS with bucket isolation', () => {
  const raw = structuredClone(fixtures.million);
  raw._sportNames = { 66: 'Football' };
  const ev = raw.events[0];

  // 1st Half BTTS
  const half1Btts = {
    id: 997001,
    typeId: 29,
    name: 'Ambele echipe marchează - Repriza 1',
    oddIds: [997011, 997012],
  };
  raw.markets.push(half1Btts);
  raw.odds.push(
    { id: 997011, typeId: 74, price: 4.50, oddStatus: 0 },
    { id: 997012, typeId: 76, price: 1.18, oddStatus: 0 },
  );
  ev.marketIds.push(half1Btts.id);

  const a = parser('million');
  const events = a.extractEvents(a.normalize(raw));
  const evFound = events.find((e) => e.id === String(ev.id));
  assert.ok(evFound, 'event found');

  const bttsFt = evFound.markets.find((m) => m.key === 'BTTS' && m.period === 'fulltime');
  const bttsH1 = evFound.markets.find((m) => m.key === 'BTTS' && m.period === 'half1');

  assert.ok(bttsFt, 'fulltime BTTS found');
  assert.ok(bttsH1, 'half1 BTTS found');
  assert.equal(bttsH1.providerMarketId, '997001');

  const cFt = resolveContract(bttsFt, { sport: 'football' });
  const cH1 = resolveContract(bttsH1, { sport: 'football' });

  assert.ok(cFt);
  assert.ok(cH1);
  assert.equal(cFt.family, 'BTTS');
  assert.equal(cH1.family, 'BTTS');
  assert.equal(cFt.period, 'fulltime');
  assert.equal(cH1.period, 'half1');

  const bKeyFt = bucketKeyForContract('evAlt', cFt);
  const bKeyH1 = bucketKeyForContract('evAlt', cH1);

  assert.equal(bKeyFt, 'evAlt::BTTS::fulltime::_::yes+no::_::_');
  assert.equal(bKeyH1, 'evAlt::BTTS::half1::_::yes+no::_::_');
  assert.notEqual(bKeyFt, bKeyH1, 'Full-time BTTS and Half 1 BTTS must have distinct isolated buckets');
});

test('altenar: duplicate period winner, totals, BTTS, and handicap markets are deduplicated deterministically', () => {
  const raw = structuredClone(fixtures.don);
  raw._sportNames = { 68: 'Tennis' };
  const ev = raw.events[0];
  ev.sportId = 68; // Tennis
  const [homeId, awayId] = ev.competitorIds;

  // FT match winner
  const ftM = raw.markets.find((m) => m.id === ev.marketIds[0]);
  ftM.typeId = 2;
  ftM.name = 'Match Winner';
  ftM.oddIds = [99801, 99802];

  // Duplicate Set 1 winner markets
  const set1WinnerA = { id: 99810, typeId: 2, name: 'Set 1 Winner', oddIds: [99811, 99812] };
  const set1WinnerB = { id: 99820, typeId: 2, name: 'Set 1 Winner (Duplicate)', oddIds: [99821, 99822] };

  // Duplicate totals markets (same period and line)
  const totalA = { id: 99830, typeId: 18, name: 'Total Games Set 1', sv: '9.5', oddIds: [99831, 99832] };
  const totalB = { id: 99840, typeId: 18, name: 'Total Games Set 1 (Duplicate)', sv: '9.5', oddIds: [99841, 99842] };

  // Duplicate BTTS markets (same period)
  const bttsA = { id: 99850, typeId: 29, name: 'Ambele marcheaza - Repriza 1', oddIds: [99851, 99852] };
  const bttsB = { id: 99860, typeId: 29, name: 'Ambele marcheaza - Repriza 1 (Duplicate)', oddIds: [99861, 99862] };

  // Duplicate Handicap markets (same period and line)
  const hcapA = { id: 99870, typeId: 16, name: 'Handicap Set 1', sv: '-1.5', oddIds: [99871, 99872] };
  const hcapB = { id: 99880, typeId: 16, name: 'Handicap Set 1 (Duplicate)', sv: '-1.5', oddIds: [99881, 99882] };

  raw.markets.push(set1WinnerA, set1WinnerB, totalA, totalB, bttsA, bttsB, hcapA, hcapB);
  ev.marketIds.push(set1WinnerA.id, set1WinnerB.id, totalA.id, totalB.id, bttsA.id, bttsB.id, hcapA.id, hcapB.id);

  raw.odds.push(
    { id: 99801, typeId: 1, competitorId: homeId, oddStatus: 0, price: 1.70 },
    { id: 99802, typeId: 3, competitorId: awayId, oddStatus: 0, price: 2.10 },
    // Set 1 winner A
    { id: 99811, typeId: 1, competitorId: homeId, oddStatus: 0, price: 1.75 },
    { id: 99812, typeId: 3, competitorId: awayId, oddStatus: 0, price: 2.05 },
    // Set 1 winner B
    { id: 99821, typeId: 1, competitorId: homeId, oddStatus: 0, price: 1.75 },
    { id: 99822, typeId: 3, competitorId: awayId, oddStatus: 0, price: 2.05 },
    // Totals A & B
    { id: 99831, typeId: 12, oddStatus: 0, price: 1.90 },
    { id: 99832, typeId: 13, oddStatus: 0, price: 1.90 },
    { id: 99841, typeId: 12, oddStatus: 0, price: 1.90 },
    { id: 99842, typeId: 13, oddStatus: 0, price: 1.90 },
    // BTTS A & B
    { id: 99851, typeId: 74, oddStatus: 0, price: 4.00 },
    { id: 99852, typeId: 76, oddStatus: 0, price: 1.20 },
    { id: 99861, typeId: 74, oddStatus: 0, price: 4.00 },
    { id: 99862, typeId: 76, oddStatus: 0, price: 1.20 },
    // Handicap A & B
    { id: 99871, typeId: 1714, competitorId: homeId, oddStatus: 0, price: 1.85 },
    { id: 99872, typeId: 1715, competitorId: awayId, oddStatus: 0, price: 1.95 },
    { id: 99881, typeId: 1714, competitorId: homeId, oddStatus: 0, price: 1.85 },
    { id: 99882, typeId: 1715, competitorId: awayId, oddStatus: 0, price: 1.95 },
  );

  const a = new A('don', { sport: 'tennis' });
  a.from = Date.parse('2026-09-21T19:00:00Z');
  a.to = a.from + 86400000;
  a.observedAt = new Date().toISOString();

  const events = a.extractEvents(a.normalize(raw));
  assert.ok(events.length >= 1);
  const event = events.find((e) => e.id === String(ev.id));
  assert.ok(event);

  // Assert deduplication
  const set1Winners = event.markets.filter((m) => m.period === 'set1' && (m.key === 'SET_WINNER' || m.key === 'MATCH_ODDS'));
  assert.equal(set1Winners.length, 1, 'Only one Set 1 winner market must be emitted despite two upstream markets');

  const set1Totals = event.markets.filter((m) => m.period === 'set1' && m.line === '9.5');
  assert.equal(set1Totals.length, 1, 'Only one 9.5 total for Set 1 must be emitted despite two upstream markets');

  const half1Btts = event.markets.filter((m) => m.period === 'half1' && m.key === 'BTTS');
  assert.equal(half1Btts.length, 1, 'Only one half1 BTTS must be emitted despite two upstream markets');

  const set1Handicaps = event.markets.filter((m) => m.period === 'set1' && m.line === '-1.5');
  assert.equal(set1Handicaps.length, 1, 'Only one -1.5 handicap for Set 1 must be emitted despite two upstream markets');
});




/* global structuredClone, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import A, { ALTENAR_IDS } from '../src/scrapers/altenar-public.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { loadWorkspace } from '../src/scanner/scanner.mjs';
import { resolveContract } from '../src/scanner/market-contracts.mjs';
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
  assert.equal(calls, 1);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(a.fetchRaw({ signal: ac.signal }));
  assert.equal(calls, 1);
  await new A('don', { maxEvents: 0, fetchImpl: () => assert.fail() }).fetchRaw();
  await assert.rejects(new A('don', { sport: 'tennis' }).fetchRaw(), /only football/);
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

test('the other four Altenar tenants serve no goals spread, and none is invented', () => {
  // million, baumbet, powerbet and winbet return no type-16 market at all
  // (measured per tenant, not inferred from don and topbet), so the mapping
  // must produce none for them rather than a line invented from the 1X2.
  const without = ALTENAR_IDS.filter((id) => !SPREAD_BOOKS.includes(id));
  assert.deepEqual(without, ['million', 'baumbet', 'powerbet', 'winbet'],
    'the two tenants that serve a spread are the ones the feed says they do');
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

test('the run reports the markets it now covers', async () => {
  // scratch/ is gitignored, so it does not exist in a fresh clone. This used to
  // rely on the earlier lifecycle test having created the same root first, so the
  // two tests were only safe in the order they happened to be declared.
  await fs.mkdir('scratch/altenar-repair', { recursive: true });
  const dir = await fs.mkdtemp('scratch/altenar-repair/cov-');
  try {
    const raw = structuredClone(fixtures.million);
    for (const e of raw.events) e.startDate = new Date(Date.now() + 3600000).toISOString();
    const a = new A('million', { dataDir: dir, runId: 'cov', fetchImpl: async () => Response.json(raw) });
    const result = await a.run();
    assert.equal(result.valid, true);
    const { readJson } = await import('../src/shared/atomic-write.mjs');
    const snap = await readJson(`${dir}/workspace/million_events.json`, null);
    assert.ok(snap, 'the snapshot must exist');
    assert.match(snap.coverage.market, /tgoals/);
    assert.match(snap.coverage.market, /btts/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

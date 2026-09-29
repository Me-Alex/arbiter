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
    assert.equal(events.length, 2);
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

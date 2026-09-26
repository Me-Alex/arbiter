/* global structuredClone, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import A, { ALTENAR_IDS } from '../src/scrapers/altenar-public.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { loadWorkspace } from '../src/scanner/scanner.mjs';
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

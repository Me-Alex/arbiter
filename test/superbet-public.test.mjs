/* global Response, structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Superbet from '../src/scrapers/superbet.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { runScraperBatch } from '../src/scraper-service.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/superbet-public.json', import.meta.url), 'utf8'));
const config = { id: 'superbet', enabled: true, engine: 'public-offer-v3', transport: 'bookmaker-public-json', script: 'superbet.mjs' };
function payload() {
  const events = structuredClone(fixture.events);
  for (const event of events) event.fixture.utc_date = new Date(Date.now() + 3600000).toISOString();
  return { events };
}
function fakeFetch(raw, calls = []) {
  return async (url, options) => {
    options.signal.throwIfAborted();
    calls.push(url);
    return Response.json(url.endsWith('/struct') ? fixture.structure : raw);
  };
}
async function directory(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'arbiter-superbet-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('configured adapter fetches real-shape feed, caps events and writes complete provenance', async (t) => {
  const dataDir = await directory(t);
  const calls = [];
  const scraper = instantiate('superbet', { jobConfig: config, dataDir, runId: 'offline', maxEvents: 1, fetchImpl: fakeFetch(payload(), calls) });
  const result = await scraper.run();
  assert.equal(result.valid, true);
  assert.equal(result.events, 1);
  assert.equal(calls.length, 2);
  const url = new URL(calls[0]);
  assert.equal(url.pathname, '/v3/ro-RO/events');
  assert.equal(url.searchParams.get('index'), 'active-prematch');
  assert.match(url.searchParams.get('startDate'), /T\d{2}:00:00.000Z$/);
  const snapshot = JSON.parse(await fs.readFile(result.outputs[0], 'utf8'));
  assert.equal(snapshot.runId, 'offline');
  assert.equal(snapshot.sourceUrl, calls[0]);
  assert.equal(snapshot.transport, 'bookmaker-public-json');
  assert.ok(Number.isFinite(Date.parse(snapshot.observedAt)));
  assert.equal(snapshot.dataStatus, 'fresh');
  assert.deepEqual(snapshot.events[0].markets[0].selections.map((s) => s.name), ['1', 'X', '2']);
  assert.equal(snapshot.events[0].league, fixture.structure.data.tournaments[0].localNames['ro-RO']);
});

test('fetch/normalize rejects bad schema, HTML and HTTP blocks without fallback', async (t) => {
  for (const response of [Response.json({ data: {} }), new Response('<html>blocked</html>'), new Response('blocked', { status: 403 })]) {
    const scraper = new Superbet({ dataDir: await directory(t), fetchImpl: async () => response });
    const result = await scraper.run();
    assert.equal(result.valid, false);
    assert.deepEqual(result.outputs, []);
    assert.match(result.error.message, /missing events|non-JSON|HTTP 403/);
  }
});

test('rejects incomplete, inactive, invalid odds and suspended outcomes', async () => {
  const mutations = [
    (e) => { e.markets[0].odds = []; },                      // no outcomes at all
    (e) => { for (const o of e.markets[0].odds) o.status = 0; },    // all suspended
    (e) => { for (const o of e.markets[0].odds) o.display = false; }, // all hidden
    (e) => { for (const o of e.markets[0].odds) o.price = 1; },     // all price too low
    (e) => { for (const o of e.markets[0].odds) o.price = Infinity; }, // all infinite
    (e) => { for (const o of e.markets[0].odds) o.metadata.offer_state_id = 0; }, // all inactive
  ];
  for (const mutate of mutations) {
    const raw = payload();
    raw.events = raw.events.slice(0, 1);
    mutate(raw.events[0]);
    const scraper = new Superbet({ fetchImpl: fakeFetch(raw) });
    assert.deepEqual(scraper.extractEvents(scraper.normalize(await scraper.fetchRaw())), []);
  }
});

test('zero cap and pre-abort never fetch', async () => {
  const fetchImpl = () => assert.fail('unexpected network request');
  const zero = new Superbet({ maxEvents: 0, fetchImpl });
  assert.deepEqual(await zero.fetchRaw(), { events: [] });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new Superbet({ fetchImpl }).fetchRaw({ signal: controller.signal }), { name: 'AbortError' });
});

test('inflight abort and timeout stop fetch without publishing', async (t) => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    const scraper = new Superbet({ dataDir: await directory(t), timeoutMs: 30, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (cancel) controller.abort();
    }) });
    const result = await scraper.run({ signal: controller.signal });
    assert.equal(result.valid, false);
    assert.equal(result.status === 'cancelled', cancel);
    assert.deepEqual(result.outputs, []);
  }
});

test('batch forwards cap through fetch/normalize and logs unsupported routing', async (t) => {
  const dataDir = await directory(t);
  t.mock.method(globalThis, 'fetch', fakeFetch(payload()));
  // 'probe-book' declares an engine/transport no adapter implements, so the
  // registry must reject it as an unsupported source instead of silently
  // falling back to some other scraper.
  const configPath = join(dataDir, 'scrapers.json');
  await fs.writeFile(configPath, JSON.stringify({
    jobs: [
      { ...config, sourceIds: ['superbet'] },
      { id: 'probe-book', enabled: true, engine: 'probe-engine', transport: 'probe-transport', script: 'probe.mjs', sourceIds: [] },
    ],
  }));
  const { jobs } = await runScraperBatch({ dataDir, configPath, books: ['superbet', 'probe-book'], maxEvents: 1 });
  assert.equal(jobs[0].events, 1);
  assert.equal(jobs[1].valid, false);
  assert.match(jobs[1].error.message, /unsupported source/);
  assert.throws(() => instantiate('superbet', { jobConfig: { ...config, engine: 'wrong' } }), { code: 'ESCRAPERCONFIG' });
});

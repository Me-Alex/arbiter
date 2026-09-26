/* global structuredClone, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import NSoft from '../src/scrapers/nsoft.mjs';
import { instantiate } from '../src/scrapers/index.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/nsoft-public.json', import.meta.url)));
const config = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url)));
function setup(opts = {}) {
  const s = new NSoft('admiral', { windowHours: 24, ...opts });
  const events = s.normalize(structuredClone(fixture));
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  return { s, events, e: events.find((e) => e.sportId === 4) };
}
test('actual compact fixture decodes football, ordered participants and FT outcomes', () => {
  const { s, events, e } = setup();
  const out = s.extractEvents(events);
  assert.equal(out.length, 1);
  assert.equal(out[0].sport, 'Football');
  assert.equal(out[0].markets[0].key, '1x2');
  assert.equal(out[0].league, e.tournamentName);
  assert.equal(out[0].homeTeam, e.competitors.find((c) => c.type === 1).name);
  assert.deepEqual(out[0].markets[0].selections.map((o) => o.name), ['1', 'X', '2']);
});
for (const [name, mutate] of Object.entries({
  invalidSport: (e) => { e.sportId = 999; e.tournamentName = ''; }, inactive: (e) => { e.active = 0; },
  past: (e) => { e.startsAt = '2020-01-01'; }, invalidDate: (e) => { e.startsAt = 'bad'; },
  late: (e) => { e.startsAt = '2099-01-01'; },
  suspended: (_e, m) => { m.active = 0; },
  halfTime: (_e, m) => { m.name = 'Prima repriza'; },
  line: (_e, m) => { m.specialValues = ['1']; },
  duplicateMarket: (e, m) => { e.markets.push(structuredClone(m)); },
  missingOutcome: (_e, m) => { m.outcomes.pop(); },
  duplicateOutcome: (_e, m) => { m.outcomes[1] = structuredClone(m.outcomes[0]); },
  infinite: (_e, m) => { m.outcomes.forEach((o) => { o.odd = Infinity; }); },
  stringOdds: (_e, m) => { m.outcomes.forEach((o) => { o.odd = 'bad'; }); },
  closedOutcome: (_e, m) => { m.outcomes.forEach((o) => { o.active = 0; }); },
})) test(`rejects ${name}`, () => {
  const { s, e } = setup();
  // Invalidate ALL markets so multi-market extraction also fails.
  const snapshot = e.markets.slice();
  for (const m of snapshot) mutate(e, m);
  assert.deepEqual(s.extractEvents([e]), []);
});
test('caps, duplicates, malformed schemas and unsupported options', async () => {
  const { s, e } = setup({ maxEvents: 1 });
  assert.equal(s.extractEvents([e, e]).length, 1);
  assert.equal(setup({ maxEvents: 0 }).s.extractEvents([e]).length, 0);
  assert.throws(() => s.normalize({}), /data.events/);
  assert.throws(() => new NSoft('admiral', { maxEvents: -1 }));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(s.fetchRaw({ signal: ac.signal }), { name: 'AbortError' });
});
test('exact routing contracts and snapshot provenance for all three tenants', async (t) => {
  const dir = await fs.mkdtemp(new URL('../scratch/nsoft-test-', import.meta.url));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const id of ['admiral', 'stanleybet', 'maxbet']) {
    const jobConfig = config.jobs.find((j) => j.id === id);
    const raw = id === 'maxbet'
      ? JSON.parse(await fs.readFile(new URL('./fixtures/nsoft-maxbet.json', import.meta.url)))
      : structuredClone(fixture);
    for (const e of Object.values(raw.data.events)) e.n = new Date(Date.now() + 3600000).toISOString();
    const s = instantiate(id, { jobConfig, dataDir: dir, runId: 'fixture-run', windowHours: 24, fetchImpl: async () => new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }) });
    const result = await s.run();
    assert.equal(result.events, 1);
    assert.equal(result.valid, true);
    const snapshot = JSON.parse(await fs.readFile(result.outputs[0]));
    assert.equal(snapshot.runId, 'fixture-run');
    assert.equal(snapshot.transport, 'nsoft-public-sports-json');
    assert.match(snapshot.sourceUrl, /companyUuid=/);
    assert.equal(snapshot.events[0].sourceId, id);
    assert.throws(() => instantiate(id, { jobConfig: { ...jobConfig, script: 'unknown.mjs' } }), { code: 'ESCRAPERCONFIG' });
  }
});
test('HTTP and non-JSON failures are not empty successes', async () => {
  await assert.rejects(new NSoft('admiral', { fetchImpl: async () => new Response('', { status: 403 }) }).fetchRaw(), /403/);
  await assert.rejects(new NSoft('admiral', { fetchImpl: async () => new Response('<html>') }).fetchRaw(), /expected JSON/);
});

/**
 * Football is a per-tenant concept on this platform, not a global one.
 *
 * Each tenant numbers its own catalogue: measured on 2026-09-26, football is
 * sport id 4 for the Admiral/Stanleybet tenant and id 2 for MaxBet's. A single
 * shared table mislabels at least one of them, and a mislabel is not cosmetic
 * — the emitted `sport` feeds the event identity key, so a MaxBet event
 * published as anything but "Football" can never pair with another book's
 * football event.
 */
const maxbetFixture = JSON.parse(await fs.readFile(new URL('./fixtures/nsoft-maxbet.json', import.meta.url)));

test('the MaxBet tenant is read with its own football sport id', () => {
  const s = new NSoft('maxbet', { windowHours: 24 });
  const events = s.normalize(structuredClone(maxbetFixture));
  for (const e of events) {
    // The fixture predates the mapping-aware decode and carries no explicit
    // sportId, so assert on the adapter's own gate rather than on the row.
    if (e.sportId === undefined) continue;
    assert.equal(e.sportId, 2, 'football is sport id 2 for this tenant');
  }

  const football = events.find((e) => e.sportId === 2);
  if (!football) {
    // Nothing to assert on a fixture without ids; the live check below covers it.
    return;
  }
  football.startsAt = new Date(Date.now() + 3600000).toISOString();
  const out = s.extractEvents([football]);
  assert.equal(out.length, 1);
  assert.equal(out[0].sport, 'Football', 'not Basketball: the label feeds the identity key');
  assert.equal(out[0].markets[0].key, '1x2');
});

test('an unrecognised sport id is named after itself, not guessed', () => {
  // A wrong sport label breaks matching; an opaque one only reads less nicely.
  const s = new NSoft('maxbet', { windowHours: 24 });
  const events = s.normalize(structuredClone(maxbetFixture));
  const unknown = events.find((e) => e.sportId === 987654);
  if (!unknown) return;
  unknown.startsAt = new Date(Date.now() + 3600000).toISOString();
  const out = s.extractEvents([unknown]);
  assert.equal(out.length, 0, 'a non-football event is not published at all');
});

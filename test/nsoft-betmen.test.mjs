/* global structuredClone, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import NSoft, { matchesNSoftConfig } from '../src/scrapers/nsoft.mjs';
import { instantiate } from '../src/scrapers/index.mjs';

/**
 * Betmen is a fourth NSoft tenant, and it is the test that pins the lesson
 * this platform has already taught twice.
 *
 * Football is a PER-TENANT concept: 4 for Admiral/Stanleybet, 2 for MaxBet, 18
 * for Betmen. The result market is per-tenant too — marketId 6 named "Final"
 * with outcome ids 6/9/12 here, against 1/"Rezultat Final"/1-4-7 for Admiral
 * and 2/"Final"/2-5-8 for MaxBet. A shared or two-branch table wires a new
 * tenant to the wrong ids, and the symptom is an adapter that publishes
 * NOTHING while still reporting success — which is how MaxBet's football was
 * once published as "Basketball" and why four defects once survived a green
 * unit suite.
 *
 * The fixture is the live wire shape: positional single-letter event keys
 * resolved through data._mapping, price in the `odd` outcome field, `events`
 * as an object keyed by id.
 */
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/nsoft-betmen.json', import.meta.url)));
const config = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url)));

function setup(id = 'betmen', opts = {}) {
  const s = new NSoft(id, { windowHours: 24, ...opts });
  const events = s.normalize(structuredClone(fixture));
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  return { s, events };
}

test('the live betmen fixture decodes to a complete full-time 1X2', () => {
  const { s, events } = setup();
  const out = s.extractEvents(events);
  assert.equal(out.length, 2, 'both fixture events are published');
  for (const ev of out) {
    assert.equal(ev.sourceId, 'betmen');
    assert.equal(ev.sport, 'Football', 'the sport label feeds the identity key');
    assert.equal(ev.markets.length, 1, 'only the result market is published');
    const market = ev.markets[0];
    assert.equal(market.key, '1x2');
    assert.equal(market.period, 'fulltime');
    assert.deepEqual(market.selections.map((o) => o.name), ['1', 'X', '2']);
    assert.deepEqual(market.selections.map((o) => o.providerOutcomeId), [6, 9, 12]);
    assert.ok(market.selections.every((o) => Number.isFinite(o.odds) && o.odds > 1));
  }
});

test('football is sport id 18 on this tenant, not 4 or 2', () => {
  const { s, events } = setup();
  assert.ok(events.every((e) => e.sportId === 18));
  const out = s.extractEvents(events);
  assert.equal(out.length, 2);
});

test('a half-time-or-full market is never mistaken for the result market', () => {
  // The live feed carries "Pauza sau Final (PSF)" as marketId 2445 on the same
  // event as the result. Only marketId 6 may be published; the PSF market is
  // not a full-time contract and would fabricate a settlement claim.
  const { s, events } = setup();
  const event = events.find((e) => e.markets.length > 1);
  assert.ok(event, 'fixture includes an event carrying both a result and a PSF market');
  const marketIds = event.markets.map((m) => m.marketId);
  assert.ok(marketIds.includes(6) && marketIds.includes(2445));
  const out = s.extractEvents(events);
  assert.ok(out.every((ev) => ev.markets[0].providerMarketId === 6));
});

test("another tenant's contract does not leak in", () => {
  // If the per-tenant table regressed to a two-branch maxbet/admiral split,
  // betmen would be wired to marketId 1 or 2 and would publish nothing. This
  // asserts the failure is loud rather than silent.
  const { s, events } = setup();
  const out = s.extractEvents(events);
  assert.ok(out.length > 0, 'betmen must not resolve to another tenant\'s market ids');
  for (const ev of out) {
    assert.notEqual(ev.markets[0].providerMarketId, 1);
    assert.notEqual(ev.markets[0].providerMarketId, 2);
  }
});

for (const [name, mutate] of Object.entries({
  wrongMarketId: (_e, m) => { m.marketId = 2; },
  admiralOutcomeIds: (e, m) => {
    m.outcomes.forEach((o, i) => { o.outcomeId = [1, 4, 7][i]; });
  },
  maxbetOutcomeIds: (e, m) => {
    m.outcomes.forEach((o, i) => { o.outcomeId = [2, 5, 8][i]; });
  },
  wrongMarketName: (_e, m) => { m.name = 'Rezultat Final'; },
  halfTime: (_e, m) => { m.name = 'Pauza sau Final (PSF)'; },
  line: (_e, m) => { m.specialValues = ['1']; },
  suspended: (_e, m) => { m.active = 0; },
  missingOutcome: (_e, m) => { m.outcomes.pop(); },
  duplicateOutcome: (_e, m) => { m.outcomes[1] = structuredClone(m.outcomes[0]); },
  closedOutcome: (_e, m) => { m.outcomes.forEach((o) => { o.active = 0; }); },
  stringOdds: (_e, m) => { m.outcomes.forEach((o) => { o.odd = 'bad'; }); },
  infinite: (_e, m) => { m.outcomes.forEach((o) => { o.odd = Infinity; }); },
  betAtOrBelowOne: (_e, m) => { m.outcomes.forEach((o) => { o.odd = 1; }); },
  past: (e) => { e.startsAt = '2020-01-01'; },
  invalidDate: (e) => { e.startsAt = 'bad'; },
  inactive: (e) => { e.active = 0; },
})) test(`rejects ${name}`, () => {
  const { s, events } = setup();
  const snapshot = events.map((e) => e.markets.slice());
  for (const e of events) for (const m of snapshot) mutate(e, m[0]);
  assert.deepEqual(s.extractEvents(events), []);
});

test('the betmen config job routes and preserves snapshot provenance', async (t) => {
  const jobConfig = config.jobs.find((j) => j.id === 'betmen');
  assert.ok(jobConfig, 'config/scrapers.json declares a betmen job');
  assert.equal(jobConfig.enabled, true);
  assert.deepEqual(jobConfig.supportedSports, ['football']);
  assert.ok(matchesNSoftConfig('betmen', jobConfig), 'the tenant matcher accepts the configured triple');

  const dir = await fs.mkdtemp(new URL('../scratch/nsoft-betmen-', import.meta.url));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const raw = structuredClone(fixture);
  for (const e of Object.values(raw.data.events)) e.n = new Date(Date.now() + 3600000).toISOString();

  const s = instantiate('betmen', {
    jobConfig, dataDir: dir, runId: 'betmen-fixture-run', windowHours: 24,
    fetchImpl: async () => new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }),
  });
  const result = await s.run();
  assert.equal(result.events, 2);
  assert.equal(result.valid, true);

  const snapshot = JSON.parse(await fs.readFile(result.outputs[0]));
  assert.equal(snapshot.runId, 'betmen-fixture-run');
  assert.equal(snapshot.transport, 'nsoft-public-sports-json');
  assert.match(snapshot.sourceUrl, /companyUuid=7afdd6f5-f954-43d6-b696-2e0dc0ae4ee2/);
  assert.equal(snapshot.events[0].sourceId, 'betmen');
  assert.equal(snapshot.coverage.sport, 'football');
  assert.equal(snapshot.coverage.market, 'fulltime-1x2');

  // Editing any contract field must be a configuration error, never a silent
  // fall back to a hardcoded class.
  assert.throws(
    () => instantiate('betmen', { jobConfig: { ...jobConfig, script: 'unknown.mjs' } }),
    { code: 'ESCRAPERCONFIG' }
  );
});

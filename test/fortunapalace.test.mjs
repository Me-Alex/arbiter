/* global Response, structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';

const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'fortunapalace');

const capture = JSON.parse(readFileSync(
  new URL('../data/endpoints/captures/fortunapalace-odds-2026-10-11.json', import.meta.url),
  'utf8',
));

function setup(opts = {}) {
  const scraper = instantiate('fortunapalace', opts);
  scraper.from = Date.parse(capture.provenance.capturedAt);
  scraper.to = scraper.from + 168 * 3600000;
  scraper.observedAt = capture.provenance.capturedAt;
  scraper.sourceUrl = capture.provenance.sourceUrl;
  return scraper;
}

test('fortunapalace: the candidate was written disabled and unvalidated', (t) => {
  if (JOB.enabled && JOB.validationStatus === 'validated') {
    return t.skip('promoted — this check described the candidate state');
  }
  assert.equal(JOB.enabled, false, 'a candidate is never enabled');
  assert.notEqual(JOB.validationStatus, 'validated', 'a candidate is never validated');
});

test('fortunapalace: the declared contract is the one the adapter was written for', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ['egt-public-sports-api', 'egt-public-sports-json', 'fortunapalace.mjs'],
    'a promoted job must declare the exact contract this adapter implements',
  );
});

test('fortunapalace: the dispatcher routes the job when it is promoted', () => {
  const scraper = setup();
  assert.ok(scraper, 'the job must resolve to an adapter');
  assert.equal(scraper.id, 'fortunapalace');
  assert.ok(scraper instanceof ScraperBase);
});

test('fortunapalace: captured wire rows preserve prices, identity and provenance', () => {
  const scraper = setup();
  const raw = scraper.normalize(capture.raw);
  const events = scraper.validate(scraper.extractEvents(raw));
  assert.equal(events.length, 8, 'captured events cleanly extracted');

  for (const event of events) {
    assert.equal(event.sourceId, 'fortunapalace');
    assert.ok(event.sourceUrl.startsWith('https://'));
    assert.equal(event.eventKey, eventIdentityKey(event));
    assert.ok(event.providerEventKey.split('|').includes(event.kickoff));
    assert.ok(event.runId);
    assert.equal(event.observedAt, capture.provenance.capturedAt);
    assert.equal(event.live, false);
    assert.equal(event.markets.length, 1);
    const market = event.markets[0];
    assert.equal(market.period, 'fulltime');
    assert.deepEqual(market.selections.map((s) => s.name).sort(), ['1', '2', 'X']);

    const original = raw.find((row) => String(row.sportEventId ?? row.idMatch) === event.id);
    assert.ok(original);
    assert.equal(event.kickoff, new Date(original.startTime ?? original.matchDateTime).toISOString());

    const sourceMarket = original.markets.find((m) => m.marketTemplateName === '1X2');
    assert.ok(sourceMarket);
    for (const selection of market.selections) {
      const source = sourceMarket.outcomes.find((o) => o.name === selection.name);
      assert.equal(selection.odds, source.odds);
    }
  }
});

test('fortunapalace: caps and malformed schema fail closed', (t) => {
  const old = process.env.ARBITER_MAX_EVENTS_PER_BOOK;
  t.after(() => {
    if (old === undefined) delete process.env.ARBITER_MAX_EVENTS_PER_BOOK;
    else process.env.ARBITER_MAX_EVENTS_PER_BOOK = old;
  });

  process.env.ARBITER_MAX_EVENTS_PER_BOOK = '2';
  const scraper = setup();
  assert.equal(scraper.extractEvents(scraper.normalize(capture.raw)).length, 2);
  assert.equal(setup({ maxEvents: 'all' }).maxEvents, Infinity);

  delete process.env.ARBITER_MAX_EVENTS_PER_BOOK;
  assert.throws(() => scraper.normalize({}), /missing|expected/);
});

test('fortunapalace: suspended outcomes drop the market', () => {
  const scraper = setup();
  const row = structuredClone(scraper.normalize(capture.raw)[0]);
  for (const market of row.markets) {
    if (market.outcomes?.length) market.outcomes[0].isSuspended = true;
  }
  assert.deepEqual(scraper.extractEvents([row]), []);
});

test('fortunapalace: fetch uses the observed endpoint and handles cancellation', async () => {
  const calls = [];
  const scraper = setup({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      return new Response(JSON.stringify({
        containerId: 5161,
        events: capture.raw.containers[0].body.events,
      }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const caller = new AbortController();
  const raw = await scraper.fetchRaw({ signal: caller.signal });
  assert.ok(calls.length > 0);
  assert.ok(raw?.containers?.length > 0);

  caller.abort();
  await assert.rejects(scraper.fetchRaw({ signal: caller.signal }), { name: 'AbortError' });
});

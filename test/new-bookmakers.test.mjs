/* global Response, structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';
import ScraperBase from '../src/scrapers/base.mjs';
import { eventIdentityKey } from '../src/shared/text.mjs';
import { feedGroupOf, isSharedFeed } from '../src/scanner/feed-groups.mjs';

const ids = ['vipbet', 'mrplay', '888sport', 'bet7'];
const config = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url)));
const captures = Object.fromEntries(ids.map((id) => [id, JSON.parse(readFileSync(
  new URL(`../data/endpoints/captures/${id}-odds-2026-10-08.json`, import.meta.url),
))]));

function setup(id, opts = {}) {
  const scraper = instantiate(id, opts);
  const capture = captures[id];
  scraper.from = Date.parse(capture.provenance.capturedAt);
  scraper.to = scraper.from + 168 * 3600000;
  scraper.observedAt = capture.provenance.capturedAt;
  scraper.sourceUrl = capture.provenance.sourceUrl;
  return scraper;
}

for (const id of ids) {
  test(`${id}: actual captured rows preserve prices, identity and provenance`, () => {
    const scraper = setup(id);
    assert.ok(scraper instanceof ScraperBase);
    const raw = scraper.normalize(captures[id].raw);
    const events = scraper.validate(scraper.extractEvents(raw));
    assert.equal(events.length, 8, 'fixed capture clock, never invented future fixtures');
    for (const event of events) {
      assert.equal(event.sourceId, id);
      assert.ok(event.sourceUrl.startsWith('https://'));
      assert.equal(event.eventKey, eventIdentityKey(event));
      assert.ok(event.providerEventKey.split('|').includes(event.kickoff));
      assert.ok(event.runId);
      assert.equal(event.observedAt, captures[id].provenance.capturedAt);
      assert.equal(event.live, false);
      assert.equal(event.markets.length, 1);
      const market = event.markets[0];
      assert.equal(market.period, 'fulltime');
      assert.deepEqual(market.selections.map((s) => s.name).sort(), ['1', '2', 'X']);
      const original = raw.find((row) => String(row.sportEventId ?? row.idMatch) === event.id);
      assert.ok(original);
      assert.equal(event.kickoff, new Date(original.startTime ?? original.matchDateTime).toISOString());
      const sourceMarket = id === 'vipbet'
        ? original.markets.find((m) => m.marketTemplateName === '1X2')
        : original.matchBets.find((m) => String(m.idBet) === String(market.key));
      for (const selection of market.selections) {
        const source = id === 'vipbet'
          ? sourceMarket.outcomes.find((o) => o.name === selection.name)
          : sourceMarket.mbOutcomes.find((o) => scraper._localize(o.mboDisplayName) === selection.name);
        assert.equal(selection.odds, source.odds ?? source.mboOddValue);
      }
    }
  });

  test(`${id}: caps, exact registry contracts and malformed schema fail closed`, (t) => {
    const old = process.env.ARBITER_MAX_EVENTS_PER_BOOK;
    t.after(() => { if (old === undefined) delete process.env.ARBITER_MAX_EVENTS_PER_BOOK; else process.env.ARBITER_MAX_EVENTS_PER_BOOK = old; });
    process.env.ARBITER_MAX_EVENTS_PER_BOOK = '2';
    const scraper = setup(id);
    assert.equal(scraper.extractEvents(scraper.normalize(captures[id].raw)).length, 2);
    assert.equal(setup(id, { maxEvents: 'all' }).maxEvents, Infinity);
    process.env.ARBITER_MAX_EVENTS_PER_BOOK = '-2';
    assert.throws(() => setup(id), /positive integer/);
    delete process.env.ARBITER_MAX_EVENTS_PER_BOOK;
    assert.throws(() => scraper.normalize({}), /missing|expected/);
    const jobConfig = { ...config.jobs.find((job) => job.id === id), enabled: true };
    assert.ok(instantiate(id, { jobConfig }));
    for (const field of ['engine', 'transport', 'script']) {
      assert.throws(() => instantiate(id, { jobConfig: { ...jobConfig, [field]: 'wrong' } }), { code: 'ESCRAPERCONFIG' });
    }
    assert.throws(() => instantiate(id, { jobConfig: { ...jobConfig, enabled: false } }), { code: 'ESCRAPERCONFIG' });
  });

  test(`${id}: incomplete or suspended real markets are excluded`, () => {
    const scraper = setup(id);
    const row = structuredClone(scraper.normalize(captures[id].raw)[0]);
    if (id === 'vipbet') {
      for (const market of row.markets) if (market.outcomes?.length) market.outcomes[0].isSuspended = true;
    } else {
      for (const market of row.matchBets) if (market.mbOutcomes?.length) market.mbOutcomes[0].mboActive = false;
    }
    assert.deepEqual(scraper.extractEvents([row]), []);
  });

  test(`${id}: fetch uses the observed endpoint, body bound and caller cancellation`, async () => {
    const calls = [];
    const scraper = setup(id, { fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      if (id === 'vipbet') {
        const container = captures[id].raw.containers.find((c) => c.url === url);
        return new Response(container ? JSON.stringify(container.body) : '', {
          status: container ? 200 : 404, headers: { 'content-type': 'application/json' },
        });
      }
      assert.equal(options.method, 'POST');
      assert.equal(options.body, '{}');
      return new Response(JSON.stringify(captures[id].raw), { headers: { 'content-type': 'application/json' } });
    } });
    const caller = new AbortController();
    await scraper.fetchRaw({ signal: caller.signal });
    assert.ok(calls.length > 0 && calls.length <= 13);
    assert.ok(calls.every((call) => call.options.signal === calls[0].options.signal), 'one deadline bounds the entire crawl');
    caller.abort();
    assert.equal(calls[0].options.signal.aborted, true);
    const before = calls.length;
    await assert.rejects(scraper.fetchRaw({ signal: caller.signal }), { name: 'AbortError' });
    assert.equal(calls.length, before, 'aborted callers make no requests');

    const oversized = setup(id, { fetchImpl: async () => new Response(' '.repeat(id === 'vipbet' ? 4_000_001 : 20_000_001), {
      headers: { 'content-type': 'application/json' },
    }) });
    await assert.rejects(oversized.fetchRaw(), /response exceeds/);
    const gated = setup(id, { fetchImpl: async () => new Response('', { status: 403 }) });
    await assert.rejects(gated.fetchRaw(), /HTTP 403/);
  });
}

test('shared aliases never count as independent sources', () => {
  for (const a of ['winner', 'mrplay', '888sport', 'bet7']) {
    assert.equal(feedGroupOf(a), 'digitain-public');
    for (const b of ['winner', 'mrplay', '888sport', 'bet7']) if (a !== b) assert.equal(isSharedFeed(a, b), true);
  }
  for (const id of ['prowin', 'ultrabet']) assert.equal(isSharedFeed(id, 'vipbet'), true);
  assert.equal(isSharedFeed('winner', 'vipbet'), false);
});

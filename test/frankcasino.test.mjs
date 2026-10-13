/**
 * Frank Casino (frankcasino) — scaffolded by `npm run new-book` on 2026-10-11.
 *
 * These checks assert what can be asserted before anything has been measured. They
 * deliberately assert nothing about the feed:
 *
 *   1. the candidate was written disabled and unvalidated;
 *   2. the declared contract is the one the adapter was written against;
 *   3. the dispatcher resolves the job.
 *
 * 
 * Check 1 describes a state the book is meant to grow out of, so it says so and
 * steps aside (t.skip) once the book is promoted. A check that keeps firing at the
 * moment the book starts working is worse than no check: it punishes the documented
 * order in docs/adding-a-book.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate } from '../src/scrapers/index.mjs';

const JOB = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'))
  .jobs.find((entry) => entry.id === 'frankcasino');

test('frankcasino: the candidate was written disabled and unvalidated', (t) => {
  // Promotion is the point of the exercise, so a book that is enabled *and*
  // validated has left the state this check describes and it steps aside. Enabled
  // but not validated is not that state — it is the illegal one, and the whole
  // reason this check exists is to catch it, so it must not skip there.
  if (JOB.enabled && JOB.validationStatus === 'validated') {
    return t.skip('promoted — this check described the candidate state');
  }
  assert.equal(JOB.enabled, false, 'a candidate is never enabled');
  assert.notEqual(JOB.validationStatus, 'validated', 'a candidate is never validated');
});

test('frankcasino: the declared contract is the one the adapter was written for', () => {
  assert.deepEqual(
    [JOB.engine, JOB.transport, JOB.script],
    ["altenar-tenancy", "altenar-sb2-widget-json", "altenar-sites.mjs"],
    'a promoted job must declare the exact contract this adapter implements',
  );
});

test('frankcasino: the dispatcher routes the job when it is promoted', () => {
  // The disabled config is what instantiate() rejects, so the promotion is
  // simulated here — which is exactly the state a reviewer will create. A book
  // whose config cannot be routed is caught now rather than on a live run.
  const scraper = instantiate('frankcasino', { jobConfig: { ...JOB, enabled: true } });
  assert.ok(scraper, 'the platform matcher must route the job');
  assert.equal(scraper.sourceIds[0], 'frankcasino');
});

test('frankcasino: normalizes and extracts events from real capture fixture', () => {
  const scraper = instantiate('frankcasino', { jobConfig: { ...JOB, enabled: true } });
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/altenar-frankcasino.json', import.meta.url), 'utf8'));
  scraper.from = Date.parse('2026-09-01T00:00:00Z');
  scraper.to = scraper.from + 86400000 * 60;
  scraper.observedAt = new Date().toISOString();

  const normalized = scraper.normalize(fixture);
  const events = scraper.extractEvents(normalized);

  assert.ok(events.length > 0, 'must extract at least one event');
  const first = events[0];
  assert.equal(first.sourceId, 'frankcasino');
  assert.match(first.sourceUrl, /integration=frankcasino/);
  assert.ok(first.homeTeam, 'has home team');
  assert.ok(first.awayTeam, 'has away team');

  const m1x2 = first.markets.find((m) => m.key === '1x2');
  assert.ok(m1x2, 'event carries 1x2 market');
  assert.equal(m1x2.period, 'fulltime');
  const selNames = m1x2.selections.map((s) => s.name).sort();
  assert.deepEqual(selNames, ['1', '2', 'X'], '1x2 carries complete 1X2 selections');
  for (const sel of m1x2.selections) {
    assert.ok(Number.isFinite(sel.odds) && sel.odds > 1, `selection ${sel.name} has valid odds`);
  }
});




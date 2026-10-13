// A shallow-index book must not emit events it never enriched.
//
// MEASURED against data/workspace captures and data/latest-scan.json
// (reproduce with scratch/enrich-overlap.mjs and scratch/middle-shape.mjs):
//
//   * Every one of the 3,222 published middles is family TOTAL_GOALS. There is
//     not one MATCH_ODDS or ASIAN_HANDICAP middle anywhere in the scan.
//   * Superbet's lobby index carries exactly ONE market per event -- the result
//     market, key 547. Its own validationReason records that the event
//     "advertises marketCount 141 (1400 odds) on /v2/ro-RO/events/{eventId}",
//     so the goals total and handicap are reachable only via a per-event
//     detail read.
//   * Consequence: 4,113 captured superbet events, of which 86 carry a goals
//     total, against 1,147 of 1,186 for maxbet, whose feed ships totals
//     natively. 44 of superbet's enriched events overlap favbet -- the anchor
//     book in 2,962 of 3,222 middles -- against 290-325 for every other book.
//     Superbet published 2 items to maxbet's 1,941.
//   * The slice is `.slice(0, budget)` over a time-ordered list, so it is
//     deterministic run to run: rescanning re-enriches the same head of the
//     feed and never widens the set. The cap is permanent, not amortised.
//
// superbet-detail.test.mjs already proves the CEILING (budget = min(detailLimit,
// maxEvents)). Nothing asserted the FLOOR. With detailLimit 100 against
// maxEvents 500 the budget is 100, so 80% of emitted events are index-only:
// real events, correct odds, structurally incapable of producing a middle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jobs = JSON.parse(readFileSync(join(root, 'config', 'scrapers.json'), 'utf8')).jobs;
const job = (id) => jobs.find((j) => j.id === id);

// Mirrored from src/scrapers/superbet.mjs rather than imported: this asserts
// the CONFIGURED job, so a default that moves underneath must not mask it.
const DEFAULTS = { superbet: 100, unibet: 2000 };

function effective(cfg) {
  const maxEvents = Number.isInteger(cfg.maxEvents) ? cfg.maxEvents : DEFAULTS[cfg.id];
  const detailLimit = Number.isInteger(cfg.detailLimit) ? cfg.detailLimit : maxEvents;
  return { maxEvents, detailLimit, budget: Math.min(detailLimit, maxEvents) };
}

test('superbet enriches every event it emits, so every emitted event can pair', () => {
  const cfg = job('superbet');
  assert.ok(cfg, 'the superbet job is configured');
  assert.equal(cfg.enabled, true, 'superbet is an enabled book');
  assert.equal(cfg.fullMarkets, true, 'the detail pass is switched on');

  const { maxEvents, detailLimit, budget } = effective(cfg);
  assert.equal(
    budget,
    maxEvents,
    `superbet emits up to ${maxEvents} events but enriches only ${budget} ` +
    `(detailLimit ${detailLimit}). The unenriched remainder is published from ` +
    'an index carrying just the result market, and middles are only ever ' +
    'published from TOTAL_GOALS, so those events can never produce one.'
  );
});

test('no enabled shallow-index book emits materially more events than it enriches', () => {
  // superbet and unibet are the two jobs whose index ships only the default
  // proposition per event; each says so in its own validationReason. A book in
  // this class emitting far more events than it enriches is spending captures
  // on pairings it structurally cannot form.
  const shallow = ['superbet', 'unibet'];
  const report = shallow
    .map((id) => job(id))
    .filter((c) => c && c.enabled && c.fullMarkets)
    .map((c) => ({ id: c.id, ...effective(c) }));

  assert.ok(report.length > 0, 'at least one shallow-index book is configured');

  // Asserted per book so a failure names the book instead of an aggregate.
  for (const r of report) {
    assert.ok(
      r.budget / r.maxEvents >= 0.9,
      `${r.id} enriches ${r.budget} of ${r.maxEvents} emitted events ` +
      `(${(r.budget / r.maxEvents * 100).toFixed(0)}%). A shallow-index book ` +
      'must cover the events it emits, or the uncovered ones are 1x2 ' +
      'duplicates that can never produce a middle.'
    );
  }
});
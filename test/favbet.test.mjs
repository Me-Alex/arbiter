/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Favbet from '../src/scrapers/favbet.mjs';

const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/favbet.json', import.meta.url)), 'utf8'));

/**
 * favbet had no test at all, which is a poor bet for this project.
 *
 * It is the largest feed — the reason the response cap is 16 MB rather than
 * 4 MB (SCRAPER-TASKS.md:79-80) — and the one adapter documented as failing
 * closed behind a Cloudflare challenge (SCRAPER-TASKS.md:82-88). Four separate
 * defects here once survived a green suite, so a completely uncovered adapter
 * is a gap, not a neutral fact.
 *
 * The fixture is a real capture: the JSON-RPC envelope from
 * /service/lineout/frontend_api2/, pruned to the market rows the kept events
 * were built from, with real kickoff times, real prices and real ids.
 */
/**
 * The fixture is a real capture, so its kickoffs are fixed dates in the past,
 * and the adapter filters to a forward window. Run these against a pinned
 * clock, or the suite rots with the calendar: the first fixture row kicked off
 * at 2026-09-28T16:00Z, and from that moment on the window correctly dropped it
 * and three of these tests began failing with nothing changed in the adapter.
 *
 * 2026-09-27T12:00Z puts both fixture kickoffs (the 28th and the 29th) in the
 * future and inside the 72h window the tests ask for.
 */
const PINNED_NOW = '2026-09-27T12:00:00.000Z';

const raw = () => structuredClone(FIXTURE.raw);

function atPinnedNow(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(PINNED_NOW) });
  t.after(() => t.mock.timers.reset());
}

test('the real capture yields a complete full-time 1X2 for football fixtures', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));

  const real = out.filter((e) => !/^\s*Goluri/i.test(e.homeTeam) && !/^\s*Goluri/i.test(e.awayTeam));
  assert.ok(real.length >= 2, `expected real two-team fixtures, got ${real.length}`);

  for (const e of real) {
    assert.equal(e.sourceId, 'favbet');
    assert.equal(e.sport, 'Football');
    assert.ok(e.homeTeam && e.awayTeam, 'both teams named');
    assert.ok(Date.parse(e.kickoff) > Date.now() - 3600000, 'kickoff is current or future');
    assert.ok(e.league && e.league !== 'Unknown', `a named league, got "${e.league}"`);

    const match = e.markets.find((m) => m.key === 'MATCH_ODDS');
    assert.ok(match, 'the match-result market is published');
    assert.deepEqual(
      match.selections.map((s2) => s2.name).sort(),
      ['1', '2', 'X'],
      'a complete and mutually exclusive 1 / X / 2 selection set'
    );
    assert.ok(match.selections.every((s2) => Number.isFinite(s2.odds) && s2.odds > 1), 'finite decimal odds above 1');
  }
});

test('every published event carries a browseable favbet sourceUrl', () => {
  // The persisted envelope's sourceUrl is the JSON-RPC endpoint, and the static
  // URL contract test regexes literals inside function bodies — so it cannot
  // catch a variable-sourced URL. This is the only place it is actually checked.
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  assert.ok(out.length > 0, 'the fixture must produce events');
  for (const e of out) {
    assert.match(
      e.sourceUrl,
      /^https:\/\/www\.favbet\.ro\/ro\/sports\/event\/[^/]+\/\d+\/$/,
      `sourceUrl must be a browseable event page, got ${e.sourceUrl}`
    );
  }
});

test('the event key is stable and does not depend on market ordering', () => {
  const s = new Favbet({ windowHours: 72 });
  const first = s.extractEvents(s.normalize(raw()));

  // Reordering the markets of a row must not change its identity, or the same
  // fixture lands in the workspace under two keys and cannot pair.
  const shuffled = raw();
  for (const row of shuffled.markets) {
    if (row?.markets && !Array.isArray(row.markets)) {
      const entries = Object.entries(row.markets);
      for (const [k, v] of entries.reverse()) row.markets[k] = v;
    }
  }
  const second = s.extractEvents(s.normalize(shuffled));

  const keyOf = (list) => list.filter((e) => !/^\s*Goluri/i.test(e.homeTeam))
    .map((e) => `${e.homeTeam}|${e.awayTeam}|${e.kickoff}`).sort();
  assert.deepEqual(keyOf(first), keyOf(second), 'identity survives reordering');
});

test('KNOWN DEFECT: a synthetic totals pool is published as a football fixture', (t) => {
  atPinnedNow(t);
  // favbet lists totals pools such as "Goluri Gazde (8 Meciuri) v Goluri
  // Oaspeti (8 Meciuri)" as events with a complete 1X2 market. The adapter
  // publishes them, and because they sort to the front of the feed they can
  // consume a small `maxEvents` budget before any real fixture is reached —
  // observed live: 60 events published, all of them pools, while 540 real
  // football fixtures were available in the same response.
  //
  // This test pins the CURRENT behaviour deliberately. It is a finding, not an
  // endorsement: when the filter is added, this test is what should flip to
  // assert the pools are dropped, and its presence means that change cannot
  // land silently.
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  const pools = out.filter((e) => /^\s*Goluri/i.test(e.homeTeam) || /^\s*Goluri/i.test(e.awayTeam));

  assert.ok(pools.length > 0, 'the fixture keeps a pool row; if a filter lands, assert this is 0 instead');
  for (const p of pools) {
    assert.ok(p.markets.some((m) => m.key === 'MATCH_ODDS'), 'the pool is published as a match-result market');
  }
});

test('KNOWN DEFECT: markets are emitted more than once per event', (t) => {
  atPinnedNow(t);
  // Each real event in the capture carries DOUBLE_CHANCE four times and
  // BOTH_TEAMS_SCORE four times. Duplicate market keys mean the engine sees the
  // same contract repeatedly, which inflates the leg combinations it evaluates
  // and, more importantly, means the adapter's own market list cannot be trusted
  // to be one-entry-per-contract.
  const s = new Favbet({ windowHours: 72 });
  const out = s.extractEvents(s.normalize(raw()));
  const real = out.filter((e) => !/^\s*Goluri/i.test(e.homeTeam));
  assert.ok(real.length > 0);

  for (const e of real) {
    const keys = e.markets.map((m) => m.key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.ok(dupes.length > 0, `${e.homeTeam} v ${e.awayTeam} should currently show duplicate market keys`);
  }
});

test('the adapter reports a missing or malformed envelope rather than an empty success', (t) => {
  atPinnedNow(t);
  const s = new Favbet({ windowHours: 72 });
  assert.throws(() => s.normalize({ markets: [] }), /no favbet events/);
  assert.throws(() => s.normalize({ events: { size: 1 }, markets: [] }), /no favbet market payloads/);

  // A row whose 1X2 is gone publishes nothing for that row. Scoped to the
  // mutated row only: the fixture holds several events, and emptying one does
  // not empty the run, which is exactly the distinction this project cares
  // about — a row that stops yielding must drop, not degrade into a partial
  // market that could pair against a full one somewhere else.
  const broken = raw();
  const victim = broken.markets[0];
  const victimId = String(victim.event.event_id);
  victim.markets = {};
  const out = s.extractEvents(s.normalize(broken));
  assert.equal(out.length, broken.markets.length - 1, 'exactly the broken row is dropped');
  assert.ok(!out.some((e) => String(e.id) === victimId), 'the broken row is not published');
});

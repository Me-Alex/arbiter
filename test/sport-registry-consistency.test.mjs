// The registry and the config declare the same sports from two directions, and
// nothing used to check that they agree. Before this file, each side was edited
// by hand: `src/sports/registry.mjs` decides which ids the UI may offer and
// which ids a scan request may name, and `config/scrapers.json` decides which
// jobs the orchestrator will run for a given sport filter. The two failure
// modes are symmetrical and both were live once:
//
//   1. A registry id no job declares is a dropdown option that always fails.
//      This is not hypothetical history: the registry held tennis, basketball,
//      ice-hockey, volleyball and handball while every job was football-only or
//      a `sport-generic` stub with no adapter file, and picking one returned
//      "no enabled bookmaker jobs selected" (HTTP 400). The sports were removed
//      from the registry to make the UI honest.
//   2. A declaration outside the registry makes the orchestrator reject every
//      scan that names it — `getSport` returns null for an unknown id, so the
//      request fails before any job runs. A job added for a sport the registry
//      does not carry is a job that can never run.
//
// The 2026-10-08 expansion re-registered 42 sports on the strength of the
// adapters (superbet, betano, Altenar, Unibet, Winner and the FEG feed all
// collect multi-sport), which is exactly the moment a one-directional check
// becomes necessary: 43 ids and 30 jobs cannot be kept aligned by attention.
// Both directions are asserted here against the real files, not a fixture.
//
// The runnable predicate is the orchestrator's own, restated rather than
// imported: `enabled !== false && validationStatus === 'validated'`, because a
// disabled or unvalidated job declares a capability nothing will exercise, and
// requiring those to line up with the registry would fail on jobs that are
// parked on purpose (prowin, ultrabet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getSport, sportOptions } from '../src/sports/registry.mjs';
import { resolveContract } from '../src/scanner/market-contracts.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

const config = read('config/scrapers.json');
const runnable = config.jobs.filter((job) => job.enabled !== false && job.validationStatus === 'validated');

// Registry ids, derived from the shipped table rather than imported, so this
// test reads the same file the router reads instead of a copy of its shape.
const REGISTRY_IDS = [...readFileSync(new URL('../src/sports/registry.mjs', import.meta.url), 'utf8')
  .matchAll(/^\s{4}id: '([^']+)',$/gm)].map((m) => m[1]);

test('the registry ids and the sports-payload census cannot disagree', () => {
  assert.ok(REGISTRY_IDS.length > 40,
    `the id extraction pattern no longer matches the registry (found ${REGISTRY_IDS.length})`);
  assert.equal(sportOptions().length, REGISTRY_IDS.length,
    'sportOptions() does not publish every id in the table');
});

test('every registered sport is declared by at least one runnable job', () => {
  const declared = new Set(runnable.flatMap((job) => job.supportedSports || []));
  const orphans = REGISTRY_IDS.filter((id) => !declared.has(id));
  assert.deepEqual(orphans, [],
    'a registry id no runnable job declares is a dropdown option that always fails');
});

test('every sport a runnable job declares resolves in the registry', () => {
  const registered = new Set(REGISTRY_IDS);
  const unknown = [];
  for (const job of runnable) {
    for (const sport of job.supportedSports || []) {
      if (!registered.has(sport)) unknown.push(`${job.id}: ${sport}`);
      else if (!getSport(sport)) unknown.push(`${job.id}: ${sport} (getSport returned null)`);
    }
  }
  assert.deepEqual(unknown, [],
    'a declared sport outside the registry makes every scan naming it fail before any job runs');
});

test('registry ids are unique, named, and carry the markets the contract table resolves', () => {
  const seen = new Map();
  for (const id of REGISTRY_IDS) {
    const sport = getSport(id);
    assert.ok(sport, `${id} is in the table but getSport cannot resolve it`);
    assert.ok(!seen.has(id), `${id} is registered twice`);
    seen.set(id, sport);
    assert.ok(typeof sport.name === 'string' && sport.name.trim(), `${id} has no display name`);
    assert.ok(Array.isArray(sport.markets) && sport.markets.length > 0, `${id} declares no markets`);
    assert.ok(sport.markets.includes('MATCH_ODDS'), `${id} does not offer the result market every sport publishes`);
  }
});

test('hasDraw on each sport matches the result-market contract the engine pairs', () => {
  // The registry records the intent; the contract table is what the engine
  // consults. A sport whose feeds send a literal 1/X/2 that never resolves as
  // a 3-way, or a literal 1/2 that never resolves as a 2-way, has a main
  // market no book can pair no matter how many quote it — and that sentiment
  // is exactly what the failure modes below measured once each. The two keys
  // are not invented for the test: `H2HT` is the betano key the live windows
  // carry for tennis and `ufo:mtyp:14-00` is the FEG shape the tennis
  // coverage row reports (`521, HTHP, HTOH, default, ufo:mtyp:14-00`).
  const threeWay = resolveContract({
    key: '1X2', name: 'Rezultat final', period: 'fulltime',
    selections: [{ name: '1', odds: 2 }, { name: 'X', odds: 3 }, { name: '2', odds: 4 }],
  });
  assert.equal(threeWay.family, 'MATCH_ODDS');
  assert.deepEqual(threeWay.outcomes, ['home', 'draw', 'away']);
  assert.equal(threeWay.period, 'fulltime');

  for (const key of ['H2HT', 'ufo:mtyp:14-00']) {
    const twoWay = resolveContract({
      key, name: 'Castigator', period: 'fulltime',
      selections: [{ name: '1', odds: 1.8 }, { name: '2', odds: 2 }],
    });
    assert.equal(twoWay.family, 'MATCH_ODDS', `${key}: a literal 1/2 winner no longer resolves`);
    assert.deepEqual(twoWay.outcomes, ['home', 'away']);
    assert.equal(twoWay.period, 'fulltime', `${key}: the winner did not resolve at full time`);
  }

  for (const id of REGISTRY_IDS) {
    const sport = getSport(id);
    assert.equal(typeof sport.hasDraw, 'boolean', `${id} has no hasDraw declaration`);
  }
});

test('a sport outside the registry is rejected rather than defaulted', () => {
  assert.equal(getSport('chess'), null);
  assert.equal(getSport('FOOTBALL'), getSport('football'), 'lookup is case-insensitive on the id');
});

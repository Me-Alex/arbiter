// The sport control and the engine have to be reading the same field.
//
// Measured on the workspace before this was fixed: 17489 of 17489 events carry
// a `sport`, across 41 distinct values, of which only about 2335 are football.
// The engine published that sport on two of the four families. The other two
// reached the page unlabelled, and `filterBySport` defaulted a missing sport to
// 'football' — so with the single sport the registry offers selected, every
// non-football positive-EV and low-hold record was filed under football while
// the page reported the filter as applied.
//
// The counts live in the census test, which counts leaves. This file asserts
// the property itself, because a leaf count changes for any reason and says
// nothing about whether the two ends still agree.
//
// Three claims, each with the control that would fail without it:
//   1. the filter invents no sport — an unlabelled record matches none, and the
//      pass-through on an empty selection is measured rather than assumed;
//   2. every family the page filters publishes the field the filter reads, and
//      the family list is derived from the page instead of typed;
//   3. the value is the event's own — re-running the engine over the same
//      markets under a different sport moves the published value with it, which
//      is what separates "copied" from "hardcoded".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { groupByEvent, findArbitrage, findMiddles, findPositiveEV, findLowHold } from '../src/scanner/engine.mjs';
import { buildScanCsv } from '../src/scan-service.mjs';
import { codeOnly, functionSource } from './helpers/code-only.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const scannerSource = read('public/js/pages/scanner.js');

// ---------------------------------------------------------------------------
// The page's own filter, lifted rather than restated.
// ---------------------------------------------------------------------------

/**
 * `filterBySport` as the page declares it.
 *
 * Lifted from the file for the same reason the census lifts its readers: a
 * second implementation in a test is a second thing that can be right while the
 * page is wrong. A page that renames or deletes the function throws here.
 */
function filterBySport() {
  const context = {};
  vm.runInNewContext(functionSource(scannerSource, 'filterBySport').text, context);
  return context.filterBySport;
}

/**
 * The families the page runs through the filter, read out of the page.
 *
 * Derived rather than typed for the same reason the census derives its readers:
 * a typed list is a claim about the frontend that nothing re-checks, and the
 * failure it hides is a family that gained a table without joining the filter.
 */
const FILTERED = [...new Set(
  [...codeOnly(scannerSource).matchAll(/filterBySport\(\s*scan\.([A-Za-z0-9_$]+)/g)].map((m) => m[1]),
)].sort();

// ---------------------------------------------------------------------------
// The engine, driven over one workspace.
// ---------------------------------------------------------------------------

const event = (sourceId, eventKey, sport, marketKey, selections) => ({
  id: `${sourceId}-${eventKey}`,
  sourceId,
  eventKey,
  sport,
  league: 'Liga 1',
  kickoff: '2030-01-01T00:00:00.000Z',
  homeTeam: 'Home',
  awayTeam: 'Away',
  markets: [{ key: marketKey, name: marketKey, selections }],
});

const sel = (name, odds, extra = {}) => ({ name, odds, ...extra });
const mkt = (key, selections) => ({ key, selections });

/**
 * Markets that populate all four families, each under a different sport.
 *
 * The sports differ on purpose. A fixture where every event says the same thing
 * cannot tell a copied sport from a constant, so the run carries three distinct
 * values and the assertions compare the published set against the input set.
 */
const WORKSPACE = [
  // Arbitrage: two independent books whose inverse sum is under 1.
  event('alpha', 'k-arb', 'Football', 'MATCH_ODDS', [sel('Home', 2.10), sel('Draw', 4.20), sel('Away', 4.60)]),
  event('bravo', 'k-arb', 'Football', 'MATCH_ODDS', [sel('Home', 2.05), sel('Draw', 4.50), sel('Away', 5.00)]),
  // Middles: an over/under pair straddling the line.
  event('alpha', 'k-mid', 'Football', 'OVER_UNDER_25', [sel('Over', 2.00, { handicap: 2.5 }), sel('Under', 2.00, { handicap: 2.5 })]),
  event('bravo', 'k-mid', 'Football', 'OVER_UNDER_25', [sel('Over', 1.95, { handicap: 2.25 }), sel('Under', 1.95, { handicap: 2.75 })]),
  // Positive EV: one book far above the other two on the same selection.
  event('alpha', 'k-ev', 'Tennis', 'MATCH_ODDS', [sel('Home', 5.20), sel('Draw', 3.60), sel('Away', 3.40)]),
  event('bravo', 'k-ev', 'Tennis', 'MATCH_ODDS', [sel('Home', 2.10), sel('Draw', 3.60), sel('Away', 3.50)]),
  event('charlie', 'k-ev', 'Tennis', 'MATCH_ODDS', [sel('Home', 2.15), sel('Draw', 3.55), sel('Away', 3.45)]),
  // Low hold: a two-way market whose inverse sum sits just above 1.
  event('alpha', 'k-hold', 'Table Tennis', 'BOTH_TEAMS_TO_SCORE', [sel('Yes', 2.00), sel('No', 1.98)]),
];

/** The four families, as the scanner page's document names them. */
const FAMILIES = ['opportunities', 'middles', 'positiveEv', 'lowHold'];

/**
 * Run the engine over the workspace, optionally re-sporting every event.
 *
 * @param {string|null} [sport] one sport for all events, or null to keep theirs
 * @returns {{opportunities: object[], middles: object[], positiveEv: object[], lowHold: object[]}}
 */
function drive(sport = null) {
  const events = sport ? WORKSPACE.map((e) => ({ ...e, sport })) : WORKSPACE;
  const grouped = groupByEvent(events);
  return {
    opportunities: findArbitrage(grouped),
    middles: findMiddles(grouped),
    positiveEv: findPositiveEV(grouped),
    lowHold: findLowHold(grouped),
  };
}

const run = drive();

/** The population every assertion below reads, so an empty run cannot pass one. */
const everyRecord = FAMILIES.flatMap((f) => run[f]);

// ---------------------------------------------------------------------------

test('the engine published a record in each family the page filters', () => {
  assert.deepEqual(FILTERED, FAMILIES.slice().sort(),
    `the page filters [${FILTERED.join(', ')}] and the document carries [${FAMILIES.join(', ')}]: a family gained or lost its table, or one was left out of the filter`);
  for (const family of FILTERED) {
    assert.ok(run[family].length > 0,
      `${family} produced no record, so "every filtered family publishes a sport" would hold over an empty family`);
  }
  assert.ok(everyRecord.length >= FAMILIES.length, `the run is too small to mean anything: ${everyRecord.length} records`);
});

test('the filter invents no sport, and passes everything through when nothing is selected', () => {
  const bySport = filterBySport();
  const rows = [{ sport: 'Football' }, { sport: 'Tennis' }, {}];

  // The unlabelled row comes first because it is the whole defect, and the
  // counting assertions below would otherwise be the ones to fire: under the
  // fallback this replaced, the football filter returned two rows instead of
  // one, which is a true fact about the mutant but not the claim under test.
  // A record the engine could not classify belongs to no sport. Filed under
  // football instead, every non-football positive-EV and low-hold record was
  // shown as football while the page reported the filter as applied.
  assert.equal(bySport([{ }], 'football').length, 0, 'a record with no sport is filed under no sport');
  assert.equal(bySport([{ sport: null }], 'football').length, 0, 'nor is one whose sport is null');
  assert.equal(bySport([{ sport: '' }], 'football').length, 0, 'nor is one whose sport is empty');

  // Both directions on labelled rows: one that matches, one that does not. A
  // filter that returned everything would satisfy the first half alone.
  assert.equal(bySport(rows, 'football').length, 1, 'only the football row survives a football filter');
  assert.equal(bySport(rows, 'football')[0].sport, 'Football');
  assert.equal(bySport(rows, 'tennis').length, 1);
  assert.equal(bySport(rows, 'tennis')[0].sport, 'Tennis');

  // And the empty selection is a pass-through, not a filter that matches nothing.
  assert.equal(bySport(rows, '').length, 3, 'no selection selected shows every row');
  assert.equal(bySport(rows, undefined).length, 3);
});

test('every filtered family publishes the event sport, not a default', () => {
  for (const family of FILTERED) {
    for (const record of run[family]) {
      assert.equal(typeof record.sport, 'string',
        `${family} published a record whose sport is ${JSON.stringify(record.sport)}`);
      assert.notEqual(record.sport, '', `${family} published a record with an empty sport`);
    }
  }

  // The published set is the input set. An engine that filled in a default would
  // add a value here, and one that dropped the field would remove the family.
  const fromEvents = [...new Set(WORKSPACE.map((e) => e.sport))].sort();
  const fromSignals = [...new Set(everyRecord.map((r) => r.sport))].sort();
  assert.deepEqual(fromSignals, fromEvents, 'the sports the signals carry are not the sports the events had');
});

test('the sport follows the event, so the field is copied and not written out', () => {
  // The control. Same markets, same prices, one sport declared for every event:
  // if any published value were a constant or a default it would survive this.
  const allBoxing = drive('Boxing');
  const repopulated = FAMILIES.flatMap((f) => allBoxing[f]);
  assert.ok(repopulated.length >= FAMILIES.length, 'the control run collapsed, so it proves nothing');
  for (const family of FAMILIES) {
    assert.ok(allBoxing[family].length > 0, `${family} produced no record under the control run`);
  }
  const sports = [...new Set(repopulated.map((r) => r.sport))];
  assert.deepEqual(sports, ['Boxing'],
    `a signal kept its own sport under a uniform workspace: ${sports.join(', ')}`);
});

test('the export writes the same sport the page filters on', () => {
  const csv = buildScanCsv(run, FAMILIES);
  const lines = csv.split('\r\n').filter((l) => l.length > 0);
  const header = lines[0].split(',');
  const sportAt = header.indexOf('sport');
  assert.notEqual(sportAt, -1, `the header lost its sport column: ${header.join(' | ')}`);

  const written = lines.slice(1).map((line) => line.split(',')[sportAt]);
  const expected = FAMILIES.flatMap((f) => run[f]).map((r) => r.sport);
  // Arbitrage and middle rows are per leg, so the export repeats their parent's
  // sport; the comparison is on the set, and on the fact that no row is blank.
  assert.ok(written.length >= expected.length, 'the export lost rows');
  for (const value of written) assert.notEqual(value, '', 'a CSV row left the sport column empty');
  assert.deepEqual([...new Set(written)].sort(), [...new Set(expected)].sort(),
    'the export carries sports the signals did not publish');
});
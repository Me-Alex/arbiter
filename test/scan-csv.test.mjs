import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codeOnly } from './helpers/code-only.mjs';
import { buildScanCsv } from '../src/scan-service.mjs';

/**
 * The dashboard links straight at GET /api/scan/export.csv (public/index.html)
 * for the whole file, and the scanner page links it once per family table, so
 * the output has to be a valid spreadsheet file with no browser round-trip.
 */

const HEADER = 'type,sport,league,kickoff,homeTeam,awayTeam,marketKey,sourceId,selection,outcome,odds,handicap,stake,payout,profit,inverseSum,marginPercent,totalStake,worstCasePayout,guaranteedProfit,roundingRisk,riskPercent,gap,verificationStatus,verificationReason,scope';

function makeScan() {
  return {
    opportunities: [{
      type: 'arbitrage',
      eventKey: 'k1',
      marketKey: 'MATCH_ODDS',
      sport: 'Football',
      league: 'Liga 1',
      kickoff: '2030-01-01T12:00:00.000Z',
      homeTeam: 'Home',
      awayTeam: 'Away',
      inverseSum: 0.98,
      // margin, not ROI: (1 - 0.98) * 100 = 2.00 (the old ROI read 2.04).
      marginPercent: 2,
      totalStake: 1000,
      worstCasePayout: 1020,
      guaranteedProfit: 20,
      roundingRisk: 0.01,
      verification: { status: 'confirmed', reason: '' },
      legs: [
        { sourceId: 'a', selection: 'Home', outcome: 'home', odds: 2.1, handicap: null, stake: 470, payout: 987, profit: 20 },
        { sourceId: 'b', selection: 'Draw', outcome: 'draw', odds: 3.4, handicap: null, stake: 300, payout: 1020, profit: 20 },
        { sourceId: 'c', selection: 'Away', outcome: 'away', odds: 4.6, handicap: null, stake: 230, payout: 1058, profit: 20 },
      ],
    }],
    middles: [{
      type: 'middle',
      eventKey: 'k1',
      marketKey: 'AH_HOME_-1',
      sport: 'Football',
      league: 'Liga 1',
      kickoff: '2030-01-01T12:00:00.000Z',
      homeTeam: 'Home',
      awayTeam: 'Away',
      gap: 2,
      roiPercent: 10,
      riskPercent: 4,
      legs: [
        { sourceId: 'a', selection: 'Home -1', outcome: '', odds: 2.1, handicap: -1, stake: 500, payout: 1050, profit: 50 },
        { sourceId: 'b', selection: 'Away +1', outcome: '', odds: 1.9, handicap: 1, stake: 500, payout: 950, profit: -50 },
      ],
    }],
    positiveEv: [{
      type: 'positive_ev',
      eventKey: 'k1',
      marketKey: 'MATCH_ODDS',
      selection: 'Home',
      sourceId: 'a',
      odds: 2.5,
      consensusProbability: 0.49,
      evPercent: 22.5,
    }],
    lowHold: [{
      type: 'low_hold',
      eventKey: 'k1',
      marketKey: 'MATCH_ODDS',
      sourceId: 'a',
      selectionCount: 2,
      holdPercent: 2.56,
    }],
  };
}

function rows(csv) {
  return csv.split('\r\n');
}

test('buildScanCsv always emits the header, even for a missing scan', () => {
  assert.equal(buildScanCsv(null, []), HEADER);
  assert.equal(buildScanCsv(undefined, []), HEADER);
  assert.equal(buildScanCsv({}, []), HEADER);
});

test('buildScanCsv exports one row per leg, not per opportunity', () => {
  const csv = buildScanCsv(makeScan(), ['opportunities']);
  const lines = rows(csv);
  assert.equal(lines[0], HEADER);
  // 3 legs in the single opportunity
  assert.equal(lines.length - 1, 3);
  assert.equal(lines[1].split(',')[0], 'opportunity');
  assert.equal(lines[1].split(',')[7], 'a');
});

test('buildScanCsv filters by signal family', () => {
  const scan = makeScan();
  assert.equal(rows(buildScanCsv(scan, ['middles'])).length - 1, 2);          // 2 legs
  assert.equal(rows(buildScanCsv(scan, ['positiveEv'])).length - 1, 1);
  assert.equal(rows(buildScanCsv(scan, ['lowHold'])).length - 1, 1);
  // No filter exports everything: 3 + 2 + 1 + 1
  assert.equal(rows(buildScanCsv(scan, [])).length - 1, 7);
  // An unknown family yields just the header
  assert.equal(rows(buildScanCsv(scan, ['nope'])).length - 1, 0);
});

test('buildScanCsv is case-insensitive and accepts comma-joined types', () => {
  const scan = makeScan();
  assert.equal(rows(buildScanCsv(scan, ['LowHold'])).length - 1, 1);
  assert.equal(rows(buildScanCsv(scan, ['middles,lowHold'])).length - 1, 3);
});

test('buildScanCsv quotes delimiters, quotes and newlines', () => {
  const scan = {
    opportunities: [{
      legs: [{
        sourceId: 'a',
        selection: 'Over 2,5 "alt"',
        outcome: '',
        odds: 2.1,
      }],
    }],
  };
  const line = rows(buildScanCsv(scan, ['opportunities']))[1];
  assert.ok(line.includes('"Over 2,5 ""alt"""'), `expected a quoted cell, got: ${line}`);
});

test('buildScanCsv uses CRLF line endings and never a bare LF', () => {
  const csv = buildScanCsv(makeScan(), []);
  assert.ok(csv.includes('\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(csv), 'found a bare LF');
});

test('buildScanCsv renders absent numeric fields as empty, not "null"', () => {
  const line = rows(buildScanCsv({ opportunities: [{ legs: [{ sourceId: 'a' }] }] }, []))[1];
  assert.ok(!line.includes('null'), `found literal null in: ${line}`);
  assert.ok(!line.includes('undefined'), `found literal undefined in: ${line}`);
});

/**
 * Every emitted row must line up with the header, or a consumer reading the
 * file by column name gets the wrong field. The opportunity rows were two cells
 * short — the verification columns landed under `riskPercent`/`gap` — and no
 * test looked at cell counts, only at two fixed indexes, so it passed.
 */
test('every signal family emits exactly as many cells as the header', () => {
  const expected = HEADER.split(',').length;
  const lines = rows(buildScanCsv(makeScan(), []));
  assert.equal(lines[0], HEADER);
  for (const [index, line] of lines.slice(1).entries()) {
    // A quoted cell may contain a comma, so count only unquoted separators.
    const cells = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    assert.equal(
      cells.length,
      expected,
      `row ${index + 1} (${cells[0]}) has ${cells.length} cells, header has ${expected}: ${line}`,
    );
  }
});

test('opportunity rows carry the verification status in its own column', () => {
  const lines = rows(buildScanCsv(makeScan(), ['opportunities']));
  const header = lines[0].split(',');
  // Row 1 is the first leg of the first opportunity.
  const cells = lines[1].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  assert.equal(cells[header.indexOf('verificationStatus')], 'confirmed');
  assert.equal(cells[header.indexOf('riskPercent')], '', 'an opportunity has no middle risk');
  assert.equal(cells[header.indexOf('gap')], '', 'an opportunity has no middle gap');
});

/**
 * The scope of the pairing travels with the row, because a live price and a
 * pre-match price are different products: an export that cannot tell them apart
 * is a file a trader can misread, and the kickoff column cannot settle it — a
 * pre-match price whose kickoff has passed is stale, not running.
 *
 * The three states are kept distinct on purpose. A signal that carries no
 * `live` at all (findLowHold) leaves the cell empty, which says "not measured";
 * writing 'prematch' there would claim the engine measured something it did not.
 */
test('scope column distinguishes live, prematch, and not-measured', () => {
  const lines = rows(buildScanCsv({
    opportunities: [
      { marketKey: 'MATCH_ODDS', live: true, legs: [{ sourceId: 'a' }] },
      { marketKey: 'MATCH_ODDS', live: false, legs: [{ sourceId: 'b' }] },
    ],
    middles: [{ marketKey: 'AH_HOME_-1', live: true, legs: [{ sourceId: 'a' }] }],
    positiveEv: [{ marketKey: 'MATCH_ODDS', sourceId: 'a', live: true, evPercent: 22.5 }],
    lowHold: [{ marketKey: 'MATCH_ODDS', sourceId: 'a', holdPercent: 2.56, selectionCount: 2 }],
  }, []));
  const header = lines[0].split(',');
  const scopeAt = header.indexOf('scope');
  const byLine = (n) => lines[n].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const scopeByRow = lines.slice(1).map((line) => byLine(lines.indexOf(line))[scopeAt]);

  assert.equal(byLine(1)[0], 'opportunity', 'row 1 is the live opportunity');
  assert.equal(scopeByRow[0], 'live', 'an in-play opportunity is exported as live');
  assert.equal(byLine(2)[0], 'opportunity', 'row 2 is the pre-match opportunity');
  assert.equal(scopeByRow[1], 'prematch', 'a pre-match opportunity is exported as prematch');
  assert.equal(byLine(3)[0], 'middle', 'row 3 is the middle');
  assert.equal(scopeByRow[2], 'live', 'an in-play middle is exported as live');
  assert.equal(byLine(4)[0], 'positiveEv', 'row 4 is the +EV signal');
  assert.equal(scopeByRow[3], 'live', 'an in-play +EV signal is exported as live');
  assert.equal(byLine(5)[0], 'lowHold', 'row 5 is the low-hold signal');
  assert.equal(scopeByRow[4], '', 'a low-hold signal has no measured scope, so the cell stays empty');
});

// ── who can reach the ?type= filter ─────────────────────────────────────────
/**
 * The route takes `?type=` and nothing in the frontend used it: one link
 * existed (public/index.html:66) and it asked for the whole file. A documented
 * parameter (README, "optional ?type=… filter") with no way in from the UI.
 *
 * The census runs in both directions. Forward — every family the CSV can export
 * has its own link, so a family added to buildScanCsv cannot land with no way to
 * ask for it. Backward — every `?type=` in the frontend names a family the CSV
 * knows, because an unknown name is not an error: `include` matches nothing and
 * the download is a file holding only the header, which looks like "no signals
 * today" rather than "you asked for the wrong thing".
 *
 * The families come from makeScan()'s own keys instead of a second hand-written
 * list: the fixture has to carry every family already, or the row-count tests
 * above would be counting less than they claim.
 */
const pageOf = (name) => codeOnly(readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8'), false);

// Blanked inside, not only by the caller: the commented-link control below has
// to exercise the same path the pages go through, or it pins a composition
// nobody uses while a link commented out in the markup still counts as a
// consumer. `codeOnly` is idempotent, so pageOf blanking first costs nothing.
const exportHrefs = (html) => [...codeOnly(html, false)
  .matchAll(/<a\b[^>]*\bhref="\/api\/scan\/export\.csv([^"]*)"/g)].map((m) => m[1]);
const familiesIn = (query) => [...new URLSearchParams(query.replace(/^\?/, '')).getAll('type')]
  .flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase()).filter(Boolean);

test('a commented-out export link is not a consumer', () => {
  assert.deepEqual(exportHrefs('<!-- <a href="/api/scan/export.csv?type=lowHold">x</a> -->'), [],
    'a link inside a comment counted as a consumer');
});

test('every family the CSV can export has its own link on the scanner page', () => {
  const scan = makeScan();
  const families = Object.keys(scan);
  const queries = exportHrefs(pageOf('admin/scanner.html'));
  // Compared lowercased on both sides, because the route is: it lowercases the
  // `type` values and lowercases each family before matching, so `?type=lowhold`
  // resolves exactly as `?type=lowHold` does (pinned by the case-insensitivity
  // test above). The first version of this compared a lowercased link against a
  // camelCased fixture key and reported lowHold and positiveEv as families the
  // page had no link for, when both links were sitting in the markup.
  assert.deepEqual(queries.flatMap(familiesIn).sort(), families.map((f) => f.toLowerCase()).sort(),
    `the scanner page links these families: ${queries.join(' | ')} — buildScanCsv can export: ${families.join(', ')}`);
  assert.equal(queries.length, families.length,
    'one link per family table: a family gained a second link or lost its own');
  // Each link must select something, or the page is offering an empty file.
  for (const family of families) {
    assert.ok(rows(buildScanCsv(scan, [family])).length > 1,
      `?type=${family} exports no rows, so its link hands the user a header and nothing else`);
  }
});

test('every ?type= in the frontend names a family the CSV knows', () => {
  const families = Object.keys(makeScan()).map((f) => f.toLowerCase());
  const unknown = [pageOf('admin/scanner.html'), pageOf('index.html')]
    .flatMap(exportHrefs).flatMap(familiesIn).filter((f) => !families.includes(f));
  assert.deepEqual(unknown, [],
    `these links ask for families buildScanCsv does not export: ${unknown.join(', ')} — the download would be an empty file`);
  // The failure this protects against, measured rather than described.
  assert.equal(rows(buildScanCsv(makeScan(), ['opportunitiess'])).length, 1,
    'a misspelled family no longer produces a header-only file — the trap moved, so this assertion is stale');
});

test('each export link sits on the table of the family it exports', () => {
  // The set-equality above is satisfied by two links swapped between cards, and
  // a swapped link is the failure a user cannot see: the table says Arbitrage,
  // the file says Middles. So the correspondence is pinned, card by card.
  //
  // The cards are the blocks between `<div class="card`; the page nests none, so
  // each block holds exactly one family table. `alerts` is in the expected map
  // with nothing beside it on purpose: that table is fed by GET /api/alerts, not
  // by a scan family, so there is no `?type=` that could describe it.
  const cards = pageOf('admin/scanner.html').split(/<div class="card\b/);
  const beside = {};
  for (const card of cards) {
    const table = (/<table[^>]*\bid="([a-z]+)-table"/.exec(card) || [])[1];
    if (table) beside[table] = [...card.matchAll(/\?type=([A-Za-z,]+)"/g)].map((m) => m[1]);
  }
  assert.deepEqual(beside, {
    alerts: [],
    arb: ['opportunities'],
    mid: ['middles'],
    ev: ['positiveEv'],
    low: ['lowHold'],
  }, 'an export link moved to another table, or a family table gained or lost its own');
});

test('every export link carries a label translated in both languages', () => {
  // Four links whose visible text is the same two words would also be four
  // unusable links for a screen reader, so each one names its family. That only
  // works if the key behind the label exists in BOTH dictionaries — a missing
  // one renders the English fallback on the Romanian page and no test complains.
  //
  // The keys are read off the links rather than written out here, so a fifth
  // link is checked the moment it is added. Two occurrences means one per
  // language, the same check scanner-live-ui.test.mjs makes for its own keys.
  const scanner = pageOf('admin/scanner.html');
  const tags = scanner.match(/<a\b[^>]*\/api\/scan\/export\.csv[^>]*>/g) || [];
  const labels = tags.map((tag) => (tag.match(/data-i18n="(\w+)"/) || [])[1]);
  assert.equal(labels.filter(Boolean).length, tags.length,
    `only ${labels.filter(Boolean).length} of ${tags.length} export links carry a data-i18n label`);

  const i18n = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
  for (const key of labels) {
    assert.equal((i18n.match(new RegExp(`^\\s*${key}:`, 'gm')) || []).length, 2,
      `${key} is translated in both languages`);
  }
});

test('the dashboard link stays the unfiltered one', () => {
  // It is the "everything" button, and the per-family ones live where each
  // family has its own table. An empty query means all four families.
  assert.deepEqual(exportHrefs(pageOf('index.html')), [''],
    'the dashboard export must keep asking for the whole file, not one family');
});

test('the ?type= value and the CSV type column spell two families differently', () => {
  // Measured, not assumed: the parameter is plural for the first two families
  // and the column every row carries is singular, while `positiveEv` and
  // `lowHold` are spelled the same on both sides. So filtering the downloaded
  // file by its own `type` column silently drops two of the four families.
  // Reported rather than fixed here: renaming the column changes the file's
  // contract for anyone already holding one, and accepting both spellings is a
  // decision about which spelling is canonical.
  const spelled = {};
  for (const family of Object.keys(makeScan())) {
    spelled[family] = rows(buildScanCsv(makeScan(), [family]))[1].split(',')[0];
  }
  assert.deepEqual(spelled, {
    opportunities: 'opportunity',
    middles: 'middle',
    positiveEv: 'positiveEv',
    lowHold: 'lowHold',
  }, 'the spelling on either side changed — re-read the two names before editing this');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanCsv } from '../src/scan-service.mjs';

/**
 * The dashboard links straight at GET /api/scan/export.csv (public/index.html),
 * so the output has to be a valid spreadsheet file with no browser round-trip.
 */

const HEADER = 'type,sport,league,kickoff,homeTeam,awayTeam,marketKey,sourceId,selection,outcome,odds,handicap,stake,payout,profit,inverseSum,roiPercent,totalStake,worstCasePayout,guaranteedProfit,roundingRisk,riskPercent,gap,verificationStatus,verificationReason,scope';

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
      roiPercent: 2.04,
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

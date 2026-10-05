// The label a surface prints is the sport the record carries — no more, no
// less. This is the other half of the sport axis: sport-selection.test.mjs
// proves WHAT the selection keeps, and this file proves WHAT THE CHIP SAYS.
//
// Measured before this file existed, four render sites defaulted a missing
// sport to the literal 'Football':
//
//   public/js/pages/scanner.js:148   the alerts row
//   public/js/pages/scanner.js:614   the arbitrage row
//   public/js/pages/scanner.js:632   the middle row
//   public/js/pages/dashboard.js:538 -> :605  the retained card renderer
//
// None of them is reachable on today's data, which is exactly why this guard
// exists: reachability was observed, not enforced. The numbers behind the
// claim, all measured in this tree:
//
//   - data/workspace: 17489 of 17489 events carry a `sport` (24 files);
//   - data/latest-scan.json: 6/6 opportunities and 1994/1994 middles carry
//     one — the two families the alerts page draws its rows from;
//   - src/alert-engine.mjs evaluateAlerts reads ONLY scan.opportunities and
//     scan.middles, so no other family can reach the alerts table;
//   - the +EV and low-hold tables print no sport chip at all, so the two
//     families whose published document carries no sport (12415 + 250 records
//     in a scan published BEFORE the engine started copying it) claim nothing.
//
// So today the fallback fires on nothing, and a producer that one day omits
// the field would make every one of the four sites state a sport the document
// does not contain — while the CSV writes an empty cell for the same record
// and filterBySport drops it under a selection. Three surfaces, one record,
// three different claims. The fixture below carries the pair the assertions
// need: one record WITH a sport and one WITHOUT, per surface. A single sported
// record would let an invented label print exactly one chip and pass.
//
// The dashboard half lives in test/event-detail-wiring.test.mjs, where
// renderOppV2's extraction harness already is — the very harness dashboard.js
// says the retained renderer is kept alive for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './helpers/code-only.mjs';
import { page, settle } from './helpers/scanner-page.mjs';

const LABEL_SCAN = {
  dataHealth: { status: 'fresh', actionableSourceCount: 3 },
  sources: [],
  eventCount: 4,
  options: {},
  opportunities: [
    { sport: 'TENNIS', homeTeam: 'Alcaraz', awayTeam: 'Sinner', marketKey: 'MATCH_ODDS', roiPercent: 4, totalStake: 1000, guaranteedProfit: 40, legs: [{ sourceId: 'bravo', selection: 'Home', odds: 2.1, stake: 500, payout: 1050, profit: 50 }] },
    { homeTeam: 'NoSportHome', awayTeam: 'NoSportAway', marketKey: 'MATCH_ODDS', roiPercent: 2, totalStake: 1000, guaranteedProfit: 20, legs: [{ sourceId: 'charlie', selection: 'Home', odds: 2.0, stake: 500, payout: 1000, profit: 0 }] },
  ],
  middles: [
    { sport: 'TENNIS', homeTeam: 'Alcaraz', awayTeam: 'Sinner', marketKey: 'AH_HOME_-1', roiPercent: 8, legs: [{ sourceId: 'bravo' }] },
    { homeTeam: 'NoSportHome', awayTeam: 'NoSportAway', marketKey: 'AH_HOME_-1', roiPercent: 5, legs: [{ sourceId: 'charlie' }] },
  ],
  positiveEv: [],
  lowHold: [],
};

// The alert shape src/alert-engine.mjs selectFamily actually emits — the
// second alert carries `sport: ''`, which is precisely what `signal.sport ||
// ''` produces for a signal with no sport.
const LABEL_ALERTS = {
  schemaVersion: 1,
  published: true,
  scan: { scrapedAt: '2026-10-04T14:02:26.168Z', eventCount: 4 },
  preferences: {
    minRoiPercent: 1, minMiddleRoiPercent: 1, cooldownSeconds: 300, includeLive: false,
    channels: { desktop: false, sound: false },
    quietHours: { enabled: false, from: '23:00', to: '07:00' },
  },
  alerts: {
    arbitrages: [
      { key: 'arb::k1::arb', type: 'arb', eventKey: 'k1', marketKey: 'MATCH_ODDS', sport: 'TENNIS', league: 'ATP', kickoff: '2026-10-05T10:00:00.000Z', homeTeam: 'Alcaraz', awayTeam: 'Sinner', live: false, roiPercent: 4.2, totalStake: 1000, guaranteedProfit: 42, riskPercent: null, sourceIds: ['bravo'], verified: null },
      { key: 'arb::k2::arb', type: 'arb', eventKey: 'k2', marketKey: 'MATCH_ODDS', sport: '', league: '', kickoff: null, homeTeam: 'NoSportAlertHome', awayTeam: 'NoSportAlertAway', live: false, roiPercent: 2.1, totalStake: 1000, guaranteedProfit: 21, riskPercent: null, sourceIds: ['charlie'], verified: null },
    ],
    middles: [],
  },
  counts: { arbitrages: 2, middles: 0 },
  truncated: { arbitrages: 0, middles: 0 },
};

/** How many sport chips one rendered table holds. */
const chipsIn = (html) => (html.match(/class="chip chip-sport"/g) || []).length;

test('the arbitrage table labels each record with the sport it carries', async () => {
  const { select } = page({ scan: LABEL_SCAN });
  await settle();
  const html = select('#arb-table tbody').innerHTML;

  // The population the count below is read against: both records are drawn
  // under no selection, or one chip between two rows proves nothing about
  // which row is allowed to claim a sport.
  assert.ok(html.includes('NoSportHome'), 'the table dropped the record with no sport instead of drawing it without a label');
  assert.equal(chipsIn(html), 1,
    'the arbitrage table must print exactly one sport chip: TENNIS for the record that carries it, none for the record that does not');
  assert.ok(html.includes('TENNIS'),
    'the chip on the arbitrage table does not name the sport the record carries');
});

test('the middles table labels each record with the sport it carries', async () => {
  const { select } = page({ scan: LABEL_SCAN });
  await settle();
  const html = select('#mid-table tbody').innerHTML;

  assert.ok(html.includes('NoSportHome'), 'the middles table dropped the record with no sport instead of drawing it without a label');
  assert.equal(chipsIn(html), 1,
    'the middles table must print exactly one sport chip: TENNIS for the record that carries it, none for the record that does not');
  assert.ok(html.includes('TENNIS'),
    'the chip on the middles table does not name the sport the record carries');
});

test('the alerts table labels each alert with the sport it carries', async () => {
  const { select } = page({ scan: LABEL_SCAN, alertsPayload: LABEL_ALERTS });
  await settle();
  const html = select('#alerts-table tbody').innerHTML;

  assert.ok(html.includes('NoSportAlertHome'), 'the alerts table dropped the alert with no sport instead of drawing it without a label');
  assert.equal(chipsIn(html), 1,
    'the alerts table must print exactly one sport chip: TENNIS for the alert that carries it, none for the alert that does not');
  assert.ok(html.includes('TENNIS'),
    'the chip on the alerts table does not name the sport the alert carries');
});

test('no page source defaults a missing sport to a literal', () => {
  // The census over the same four sites plus any future one: the surface
  // tests above fail on the tables they render, this one fails on the source
  // regardless of which fixture reaches it — a fallback on a path no fixture
  // walks is still a label waiting to be printed.
  const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
  const files = [...walk(join(ROOT_DIR, 'public')), ...walk(join(ROOT_DIR, 'electron'))];
  // The reader declares its population before reporting a zero: a walk that
  // found no files would otherwise prove the absence of a defect it never
  // looked at.
  assert.ok(files.length > 0, `the census read ${files.length} sources; an empty read proves nothing`);

  const offenders = [];
  let chipIdiom = 0;
  for (const file of files) {
    const rel = relative(ROOT_DIR, file).replace(/\\/g, '/');
    const raw = readFileSync(file, 'utf8');
    // Offsets survive codeOnly untouched, so a line counted here is the line
    // in the file. Comments are blanked: a fallback named in prose must not
    // read as a fallback in code.
    const text = codeOnly(raw, /\.(js|mjs)$/.test(file));
    chipIdiom += (text.match(/chip-sport/g) || []).length;
    for (const m of text.matchAll(/\|\|\s*(['"])Football\1/g)) {
      const line = raw.slice(0, m.index).split(/\r?\n/).length;
      offenders.push(`${rel}:${line}`);
    }
  }
  assert.deepEqual(offenders, [],
    `page sources that default a missing sport to a literal:\n  ${offenders.join('\n  ')}`);
  assert.ok(chipIdiom > 0,
    `the census found ${chipIdiom} sport-chip sites across ${files.length} sources; without one, the empty offender list above only proves the reader is blind`);
});

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html)$/.test(name)) out.push(full);
  }
  return out;
}

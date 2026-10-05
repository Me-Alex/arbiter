// The sport selection has to reach every surface that claims to show it:
// the tables, the banner, and the file the export links download.
//
// Measured before this file existed, three of the four links in that chain
// were open:
//
//   1. `change` on the control redrew nothing. createDropdown's own listener
//      writes localStorage and that was the only listener the page had, so the
//      tables, the banner and the counts kept the previous sport until the
//      next refresh or scan-update. A probe counting reads of `activeSport`
//      read 1 before the change and 1 after.
//   2. The published scan's own sport was written into the control by the same
//      render that had already read it, so a scan run under a sport showed a
//      control claiming that sport over tables drawn unfiltered, with the
//      banner empty -- the page disagreeing with itself until the next
//      refresh, which does read the seeded value.
//   3. The four export links carried `?type=` only and nothing rewrote them:
//      the table answered for the selected sport, the file answered for all.
//
// The fourth link -- the route honouring `?sport=` -- is asserted over HTTP in
// test/router.test.mjs, where the router harness already lives. This file
// holds the page half, plus the equality that ties the builder to the page's
// own filter: the CSV under a selection must be byte-identical to the CSV of
// the same document after `filterBySport`, which is the very function the
// tables draw with. Two implementations of "which records does this sport
// keep" would be two things that can both be right while screen and file
// disagree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScanCsv } from '../src/scan-service.mjs';
import { page, settle, SHIPPED } from './helpers/scanner-page.mjs';

// Two labelled sports and one record with no sport at all, in every family.
// The second sport is spelled differently in the data (`TENNIS`) than in the
// control (`tennis`) on purpose: the registry offers lowercase ids and the
// events carry their own spelling, and a case-sensitive match on either side
// would export nothing for the only value the page can select. The registry
// offers football alone today, which is also why no test may assume the
// control's value is hardcoded anywhere -- the assertion below selects the
// sport the registry does NOT offer and expects it to travel.
const FAMILIES = ['opportunities', 'middles', 'positiveEv', 'lowHold'];

const FIXTURE = {
  dataHealth: { status: 'fresh', actionableSourceCount: 3 },
  sources: [],
  eventCount: 6,
  // No sport in the options: the seed below leaves the control alone, which is
  // the state the first test reads the control in.
  options: {},
  opportunities: [
    { sport: 'Football', homeTeam: 'FCSB', awayTeam: 'Craiova', marketKey: 'MATCH_ODDS', roiPercent: 3, totalStake: 1000, guaranteedProfit: 30, legs: [{ sourceId: 'alpha', selection: 'Home', odds: 2.1, stake: 500, payout: 1050, profit: 50 }] },
    { sport: 'TENNIS', homeTeam: 'Alcaraz', awayTeam: 'Sinner', marketKey: 'MATCH_ODDS', roiPercent: 2, totalStake: 1000, guaranteedProfit: 20, legs: [{ sourceId: 'bravo', selection: 'Home', odds: 2.05, stake: 500, payout: 1025, profit: 25 }] },
    { homeTeam: 'NoSportEvent', awayTeam: 'Nobody', marketKey: 'MATCH_ODDS', roiPercent: 1, totalStake: 1000, guaranteedProfit: 10, legs: [{ sourceId: 'charlie', selection: 'Home', odds: 2.0, stake: 500, payout: 1000, profit: 0 }] },
  ],
  middles: [
    { sport: 'Football', homeTeam: 'FCSB', awayTeam: 'Craiova', marketKey: 'AH_HOME_-1', roiPercent: 9, legs: [{ sourceId: 'alpha' }] },
    { sport: 'TENNIS', homeTeam: 'Alcaraz', awayTeam: 'Sinner', marketKey: 'AH_HOME_-1', roiPercent: 8, legs: [{ sourceId: 'bravo' }] },
  ],
  positiveEv: [
    { sport: 'Football', eventKey: 'k-ev-football', selection: 'EV-FOOTBALL', sourceId: 'a', odds: 2.5, evPercent: 12 },
    { sport: 'TENNIS', eventKey: 'k-ev-tennis', selection: 'EV-TENNIS', sourceId: 'b', odds: 3.1, evPercent: 11 },
    { eventKey: 'k-ev-none', selection: 'EV-NOSPORT', sourceId: 'c', odds: 2.2, evPercent: 10 },
  ],
  lowHold: [
    { sport: 'Football', eventKey: 'k-low-football', sourceId: 'a', selectionCount: 2, holdPercent: 1.1 },
    { sport: 'TENNIS', eventKey: 'k-low-tennis', sourceId: 'b', selectionCount: 2, holdPercent: 1.2 },
  ],
};

test('moving the sport control redraws the tables and the banner', async () => {
  const { context, get, select } = page({ scan: FIXTURE });
  await settle();
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);

  // The fixture in full, before anything is selected.
  assert.equal(get('arb-count').textContent, `3 ${t('opps')}`, 'the fixture did not reach the page as three opportunities');
  assert.equal(get('scan-sport-indicator').textContent, '', 'with no selection the banner already claims a sport');

  get('sport-filter').value = 'tennis';
  get('sport-filter').fire('change');

  assert.equal(get('arb-count').textContent, `1 ${t('opps')}`,
    'the arbitrage table still shows every sport after the control moved to tennis');
  assert.equal(get('mid-count').textContent, `1 ${t('middles')}`,
    'the middles table did not follow the selection either');
  assert.equal(get('low-count').textContent, '1',
    'the low-hold table did not follow the selection either');
  assert.equal(get('scan-sport-indicator').textContent, `${t('sport')}: Tennis`,
    'the banner does not name the sport the control is holding');
  const ev = select('#ev-table tbody').innerHTML;
  assert.ok(ev.includes('EV-TENNIS'), 'the +EV table lost the tennis row after the selection');
  assert.ok(!ev.includes('EV-FOOTBALL'), 'the +EV table still shows football rows under a tennis selection');
  assert.ok(!ev.includes('EV-NOSPORT'), 'the +EV table kept a record with no sport under a selection');

  // And back: a selection the fixture does not match empties the tables
  // instead of leaving them where the last one put them.
  get('sport-filter').value = 'handball';
  get('sport-filter').fire('change');
  assert.equal(get('arb-count').textContent, `0 ${t('opps')}`,
    'a sport no record carries still shows rows');
});

test('the published scan seeds the control before the tables read it', async () => {
  const { context, get } = page({ scan: { ...FIXTURE, options: { sport: 'tennis' } } });
  await settle();
  const t = context.arbiterI18n.t.bind(context.arbiterI18n);

  assert.equal(get('sport-filter').value, 'tennis',
    'the control was not seeded from the published scan');
  // The two claims that used to disagree with the line above: the seed ran
  // after the same render had already read the control, so the select said
  // tennis while the banner stayed hidden and the tables were drawn whole.
  assert.equal(get('scan-sport-indicator').textContent, `${t('sport')}: Tennis`,
    'the control claims a sport the banner does not show');
  assert.equal(get('arb-count').textContent, `1 ${t('opps')}`,
    'the control claims a sport the tables were not filtered by');
});

test('the export links carry the selection the tables show', async () => {
  const { get, anchors } = page({ scan: FIXTURE });
  await settle();
  const hrefs = () => anchors.map((a) => a.getAttribute('href'));

  assert.ok(SHIPPED.length > 0, 'the page ships no export link, so there is nothing to point at a selection');
  assert.deepEqual(hrefs(), SHIPPED,
    'with no selection the links are no longer the ones the markup ships');

  get('sport-filter').value = 'tennis';
  get('sport-filter').fire('change');
  assert.deepEqual(hrefs(), SHIPPED.map((h) => `${h}&sport=tennis`),
    'the selection on screen did not reach the download links');

  // A second value, because one value is what a hardcoded link would also
  // produce: the string written has to be the control's, not a constant.
  get('sport-filter').value = 'football';
  get('sport-filter').fire('change');
  assert.deepEqual(hrefs(), SHIPPED.map((h) => `${h}&sport=football`),
    'the links carry a sport that is not the one the control holds');

  get('sport-filter').value = '';
  get('sport-filter').fire('change');
  assert.deepEqual(hrefs(), SHIPPED,
    'a link kept the previous selection after it was cleared');
});

test('the export keeps exactly the rows the tables keep, per family and sport', async () => {
  const { context } = page({ scan: FIXTURE });
  await settle();
  const filterBySport = context.filterBySport;
  assert.equal(typeof filterBySport, 'function',
    'the page no longer declares its own filter, so nothing ties the file to the table');

  // The fixture separates the two sides for every selection used below, or
  // the equality would hold for a builder that ignores the sport entirely.
  assert.equal(filterBySport(FIXTURE.opportunities, '').length, 3, 'no selection shows every opportunity');
  assert.equal(filterBySport(FIXTURE.opportunities, 'tennis').length, 1, 'the tennis selection keeps one opportunity');
  assert.notEqual(
    buildScanCsv(FIXTURE, ['opportunities'], 'tennis'),
    buildScanCsv(FIXTURE, ['opportunities']),
    'filtering the file by sport changes nothing, so this test proves nothing',
  );

  for (const sport of ['', 'tennis', 'football']) {
    for (const family of FAMILIES) {
      const onScreen = { ...FIXTURE, [family]: filterBySport(FIXTURE[family], sport) };
      assert.equal(
        buildScanCsv(FIXTURE, [family], sport),
        buildScanCsv(onScreen, [family]),
        `${family} under sport="${sport}": the file and the tables disagree on which records the selection keeps`,
      );
    }
  }

  // The two decisions the equality above cannot tell apart on its own: the
  // case the data spells differently from the control, and the record with no
  // sport at all.
  const tennis = buildScanCsv(FIXTURE, ['opportunities'], 'tennis');
  assert.ok(tennis.includes('TENNIS'),
    'the record spelled TENNIS in the data is not kept for the control value "tennis"');
  assert.ok(!tennis.includes('NoSportEvent'),
    'a record with no sport rode along under a selection the tables dropped it from');
  assert.ok(buildScanCsv(FIXTURE, ['opportunities']).includes('NoSportEvent'),
    'with no selection the unlabelled record vanished from the file while the table still shows it');
});

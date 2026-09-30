// The source-health card has to account for every book the scan published.
//
// It did not. The card header counts all of them — `animateValue('src-count',
// (scan.sources || []).length)` — and the body rendered `.slice(0, 8)`, so a
// scan over 22 books announced 22 and listed 8. The cap protected nothing: the
// container is `max-height: 420px; overflow-y: auto` (dashboard.css), a panel
// built to scroll. Nothing else on the page names the other fourteen — the
// quick bar says "0/22 fresh", and the scrape page the card links to carries no
// per-book data at all. So the one question this card exists to answer, "which
// of my books is not contributing", had an answer covering the eight busiest.
//
// The sibling card in the same file is the control that this was a defect and
// not a house style: the +EV card is also capped at 8, but it is headed "Top +EV
// bets" and links "View all in scanner →". A sample that says it is a sample,
// with a way out, is a sample. This one claimed to be a list.
//
// The second half is the field census. The loader writes 17 names on a book —
// 11 on the record itself, 6 only when they apply — and the card reads 4. Each
// unread one is named below with its reason, so a field added tomorrow fails
// here instead of becoming one more thing nobody sees.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const dashboardSource = read('public/js/pages/dashboard.js');
const dashboardCss = read('public/css/dashboard.css');
const indexHtml = read('public/index.html');
const scannerSource = read('src/scanner/scanner.mjs');

/**
 * A top-level `function NAME(...) { ... }`, located by brace matching.
 *
 * The parameter list is skipped first, and not by accident: a default argument
 * like `qualityOptions = {}` opens a brace that closes again before the body
 * begins, so matching braces from the first `{` after the name returns the
 * signature, calls it the function, and hands the caller a census of zero.
 */
function extractFn(name, from) {
  const start = from.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from the file`);
  let parens = 0;
  let bodyStart = -1;
  for (let i = from.indexOf('(', start); i < from.length; i += 1) {
    if (from[i] === '(') parens += 1;
    else if (from[i] === ')') {
      parens -= 1;
      if (parens === 0) { bodyStart = from.indexOf('{', i); break; }
    }
  }
  assert.notEqual(bodyStart, -1, `${name} has no body`);
  let depth = 0;
  for (let i = bodyStart; i < from.length; i += 1) {
    if (from[i] === '{') depth += 1;
    else if (from[i] === '}') {
      depth -= 1;
      if (depth === 0) return from.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is not closed — has its shape changed?`);
}

const sourceHealthRows = (() => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(extractFn('sourceHealthRows', dashboardSource), context);
  return context.sourceHealthRows;
})();

/** The books a real capture holds, worst first. */
const books = (n) => Array.from({ length: n }, (_, i) => ({
  sourceId: `book${String(i).padStart(2, '0')}`,
  count: (n - i) * 10,
  dataStatus: 'fresh',
  ageMs: 1000,
}));

test('the card lists every book, not the busiest few', () => {
  // The number the header already showed.
  const all = books(22);
  assert.equal(all.length, 22, 'the control document really has 22 books');

  const rows = sourceHealthRows(all);
  assert.equal(rows.length, 22, 'and the card listed a subset of them');
  // The positive control, right beside the negative one: the count in the header
  // and the number of rows on screen are the same number, so the card cannot
  // announce 22 and show 8.
  assert.equal(String(rows.length), String(all.length), 'what the header counts is what the card lists');

  // And it holds past the old cap, which is where this was decided.
  for (const n of [8, 9, 22, 40, 120]) {
    assert.equal(sourceHealthRows(books(n)).length, n, `${n} books must all be listed`);
  }
});

test('the order is still largest first, and the scan is not sorted in place', () => {
  const input = [{ sourceId: 'small', count: 2 }, { sourceId: 'big', count: 90 }, { sourceId: 'none' }];
  const rows = sourceHealthRows(input);
  assert.deepEqual(rows.map((r) => r.sourceId), ['big', 'small', 'none'],
    'a book with no count sorts last, as it always did');
  assert.deepEqual(input.map((r) => r.sourceId), ['small', 'big', 'none'],
    'and sorting does not rewrite the payload the rest of the page reads');
});

test('a scan with no books, or no sources at all, is an empty list and not a throw', () => {
  // The route answers an emptyScan() on a fresh install, where `sources` is [].
  for (const input of [[], null, undefined]) {
    // Length, not deepEqual: the array is built in the vm realm, so its
    // prototype is not this realm's and a structural compare reports
    // "same structure but not reference-equal" for two empty arrays.
    assert.equal(sourceHealthRows(input).length, 0);
  }
});

test('the panel is a scroller, which is why every book fits', () => {
  // The reason the cap was unnecessary, pinned so a future cap cannot come back
  // citing a layout it never had to protect.
  const block = dashboardCss.match(/\.source-health\s*\{[^}]*\}/);
  assert.ok(block, '.source-health still has a rule');
  assert.match(block[0], /overflow-y:\s*auto/, 'the list scrolls, so it is built to hold more than fits');
  assert.match(block[0], /max-height:\s*\d/, 'and it is height-bounded rather than unbounded');

  // The card counts the total; the +EV card, which is capped on purpose, is
  // headed as a top-N and offers a way to see the rest. If either half of that
  // changes, the contrast this test rests on has to be re-examined.
  assert.match(indexHtml, /data-i18n="topEvBets"/, 'the +EV card is labelled as a top-N');
  assert.match(indexHtml, /data-i18n="viewAllInScanner"/, 'and links somewhere that has the rest');
  assert.match(dashboardSource, /animateValue\('src-count', \(scan\.sources \|\| \[\]\)\.length\)/,
    'the source-health header counts every book');
});

/**
 * The fields the loader writes on a source, lifted from the producer.
 *
 * Read out of `scanner.mjs` rather than named, so the census below is about the
 * code that runs and not about a list that can drift from it.
 *
 * Two forms, because the record is written in two forms: the keys of the object
 * literal (`capturedAt: blob.capturedAt`) and everything assigned onto the
 * object afterwards (`source.feedGroup = groupId`). An earlier version took
 * only the second and so reported capturedAt as a field the scanner no longer
 * writes. Each half is guarded below — an instrument with a hole in it is an
 * instrument whose silence means nothing.
 */
const PRODUCED = (() => {
  const body = extractFn('loadWorkspace', scannerSource);

  // The literal: from `const source = {` to its matching brace, keys at line starts.
  const literalAt = body.indexOf('const source = {');
  assert.notEqual(literalAt, -1, 'the source record is gone from the loader');
  let depth = 0;
  let literalEnd = -1;
  for (let i = body.indexOf('{', literalAt); i < body.length; i += 1) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') {
      depth -= 1;
      if (depth === 0) { literalEnd = i; break; }
    }
  }
  assert.notEqual(literalEnd, -1, 'the source record is not closed');
  // Keys at line starts, colon or shorthand: `file,` on the record's second line
  // is a property with no colon, and taking only `name:` dropped it.
  const literalKeys = [...body.slice(literalAt, literalEnd).matchAll(/^\s+(\w+)\s*[:,]/gm)].map((m) => m[1]);
  const assigned = [...body.matchAll(/\bsource\.(\w+)/g)].map((m) => m[1]);

  // Each half on its own, so neither can quietly find nothing.
  assert.ok(literalKeys.includes('capturedAt'), 'the literal half of the scan found nothing');
  assert.ok(literalKeys.includes('file'), 'the shorthand half of the literal scan found nothing');
  assert.ok(assigned.includes('feedGroup'), 'the assignment half of the scan found nothing');

  const names = new Set([...literalKeys, ...assigned]);
  // A floor, not an exact count. Equality would make a legitimately added field
  // crash the file on a bare number instead of letting the census below name it,
  // which is the one job it has. Shrinkage still fails, loudly.
  assert.ok(names.size >= 17, `the loader writes at least 17 names on a source; this scan found ${names.size}`);
  return names;
})();

/**
 * Published per book, read by no page, with the reason it is allowed.
 *
 * Removing a name means the reason stopped holding; the reason has to be fixed
 * in the same commit that removes it.
 */
const UNREAD_WITH_REASON = {
  runId: [
    'One fact written twenty-two times. Measured over the capture: runId equals',
    '"markets-1788596479049" + "-" + sourceId for 22 of 22 books, so the twenty-two values',
    'are one run. The run id itself is already shown at run level by the scrape page.',
  ].join(' '),
  sourceUrl: [
    'Not decoration, and not a lost field: a capture arriving without one is downgraded',
    'from fresh to partial (scanner.mjs:74), and that verdict is what this card shows.',
    'All 22 books of the capture carry one. The URL itself is an operator detail.',
  ].join(' '),
  dataReason: [
    'Prose authored in English by the backend ("snapshot age 2195484894ms exceeds',
    '600000ms"). The page language is ro by default and everything this repo shows is',
    'translated (scanner.js:72-78), so the sentence has no translated home. It needs a code',
    'on the payload and a message in the dictionary, which is its own change.',
  ].join(' '),
  transport: [
    'Provenance for an operator: which scraper produced the capture. Twenty-two distinct',
    'values across the twenty-two books of a real capture, which is the point — and the least',
    'useful thing to put on a card whose question is which books are fresh.',
  ].join(' '),
  feedGroup: [
    'The engine already refuses shared-feed pairings (engine.mjs:502, 590, 632, 721 through',
    'isSharedFeed), so no opportunity on screen is built from a clone of the same feed.',
    'feed-groups.mjs:114-117 does say the UI is meant to explain an absent pairing, and that',
    'is a real missing surface — but it is an absent one, not a field this card mis-renders.',
    'Sixteen of the twenty-two books are in a group, in six groups.',
  ].join(' '),
  sharedFeedWith: [
    'With feedGroup, and the nearest thing to a defect here: the peers list is measured data',
    '(admiral -> [stanleybet], winbet -> five peers) and no page shows it. Same reason, and',
    'the same missing surface the feed-groups comment already describes.',
  ].join(' '),
  duplicateFeedEvents: [
    'The runtime evidence behind sharedFeedWith: events dropped as byte-identical to another',
    "book's feed (scanner.mjs:119). Zero across the twenty-two books of this capture, and",
    'proven reachable — test/altenar-public.test.mjs:166 asserts a book at 2. Nothing on',
    'screen is built from them, for the same reason as the group it discovers.',
  ].join(' '),
  observedAt: 'The card shows the derived age next to each book; the exact instant is a log detail.',
  capturedAt: 'With observedAt, and the two differ by sixty-one milliseconds on this capture.',
  file: 'A workspace filename. No page should render it.',
  'implausibleMarginRate': [
    'Only set when a book prices 1X2 below break-even, and the scan has already dropped those',
    'markets, so the field reports work the engine did rather than work the reader must do.',
    'Absent from all 22 books here; contibet is the measured offender. Same missing',
    'translation as dataReason.',
  ].join(' '),
  'implausibleMarginCount': 'The count behind implausibleMarginRate. With it, same missing translation.',
  'implausibleMarketCount': [
    'The event-level twin of implausibleMarginCount, and a different number: markets in the',
    'blob versus events that carried at least one corrupt market. Same fate — zero across',
    'this capture, dropped markets already, same missing translation.',
  ].join(' '),
};

test('every field the scanner writes on a book is read by a page, or is named with a reason', () => {
  // Not vacuous: the four the card does read have to be found by the same search
  // that finds the rest, or the whole census is a list of absences.
  //
  // The search is scoped to reads on a source object, and has to be. Matching a
  // bare `.runId` across public/ reported the scrape page's `state.runId` and
  // `run.runId` — the run state, a different payload — and `.sourceUrl` matched
  // `ev.sourceUrl` on events. Both would have silently excused the same-named
  // fields of the source record. A name is not a field until you know its object.
  const corpus = readdirSync(join(ROOT, 'public'), { recursive: true })
    .filter((f) => f.endsWith('.js') || f.endsWith('.html'))
    .map((f) => readFileSync(join(ROOT, 'public', f), 'utf8'))
    .join('\n');
  const readByAPage = (name) => new RegExp(`\\bsources?\\w*\\.${name}\\b`).test(corpus);

  for (const name of ['sourceId', 'count', 'ageMs', 'dataStatus']) {
    assert.equal(readByAPage(name), true, `${name} is read today; the search that must find it does not`);
  }
  for (const name of [
    'file', 'runId', 'sourceUrl', 'observedAt', 'capturedAt', 'transport', 'feedGroup', 'sharedFeedWith',
    'dataReason', 'implausibleMarginCount', 'implausibleMarginRate', 'implausibleMarketCount',
    'duplicateFeedEvents',
  ]) {
    assert.equal(readByAPage(name), false, `${name} is named as unread but something reads it now`);
  }

  // The producer is the list: a field added to the record fails here.
  const unread = [...PRODUCED]
    .filter((name) => !(name in UNREAD_WITH_REASON) && !readByAPage(name))
    .sort();
  assert.deepEqual(unread, [], `the page never reads these: ${unread.join(', ')}`);

  // And the other direction: every excuse has a reason attached, so the list
  // cannot grow by accident and become a place where names go to be quiet.
  for (const [name, reason] of Object.entries(UNREAD_WITH_REASON)) {
    assert.ok(PRODUCED.has(name), `${name} is excused but the scanner no longer writes it`);
    assert.ok(reason.length > 40, `${name} needs a reason, not a word`);
  }
});

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
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const dashboardSource = read('public/js/pages/dashboard.js');
const dashboardCss = read('public/css/dashboard.css');
const indexHtml = read('public/index.html');
const scannerSource = read('src/scanner/scanner.mjs');
const dataQualitySource = read('src/shared/data-quality.mjs');
const i18nSource = read('public/js/i18n.js');

/**
 * The same two files with their comments blanked, for every list this file
 * lifts out of them.
 *
 * All four extractions here read the producer, not the page, so a comment here
 * does not make an unread field look read — it makes a *published* field appear
 * that the backend no longer writes. That direction fails loudly, which is
 * better than the reader-side one and still wrong: the census would then be
 * describing a commented-out line as a promise the code keeps, and the name on
 * that promise would be in every message below.
 *
 * `dashboardSource` stays raw on purpose — it is executed by the harness below,
 * and blanking it would hand the vm a file of whitespace where the logic is.
 */
const scannerCode = codeOnly(scannerSource, true);
const dataQualityCode = codeOnly(dataQualitySource, true);

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

/** All three page helpers in one realm, so one can call another. */
const pageFns = (() => {
  const context = {};
  vm.createContext(context);
  for (const name of ['sourceStatusLabel', 'sourceReasonText', 'sourceFeedNote']) {
    vm.runInContext(extractFn(name, dashboardSource), context);
  }
  return context;
})();

// The real dictionary, not a stand-in: the defect being pinned is a page
// rendering a raw token that the dictionary could have translated, so a fake
// dictionary would make every assertion here vacuous.
const DICT = (() => {
  const m = /const\s+dict\s*=\s*\{/.exec(i18nSource);
  assert.ok(m, 'cannot find the dictionary');
  let depth = 0;
  let i = i18nSource.indexOf('{', m.index);
  for (; i < i18nSource.length; i += 1) {
    if (i18nSource[i] === '{') depth += 1;
    else if (i18nSource[i] === '}' && --depth === 0) break;
  }
  return new Function(`${i18nSource.slice(m.index, i + 1)}; return dict;`)();
})();

/** The real lookup, including its "missing key comes back as the key" quirk. */
const translator = (lang) => (key) => (DICT[lang] && DICT[lang][key]) || DICT.en[key] || key;
const ro = translator('ro');
const en = translator('en');

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
 * The statuses the backend can put on a book, read out of the constant.
 *
 * A list typed here would rot the way the raw rendering did: the card showed
 * `dataStatus` because nobody compared it against the set of statuses that
 * exist, and the translations for two of them were never written.
 */
const STATUSES = (() => {
  const at = dataQualityCode.indexOf('export const DATA_STATUS = Object.freeze({');
  assert.notEqual(at, -1, 'DATA_STATUS is gone from data-quality.mjs');
  const block = dataQualityCode.slice(at, dataQualityCode.indexOf('});', at));
  const values = [...block.matchAll(/^\s+(\w+):\s*'([^']+)'/gm)].map((m) => m[2]);
  assert.ok(values.includes('fresh') && values.includes('cancelled'), 'the constant did not parse');
  return values;
})();

test('every status the backend can send has a Romanian label, and the card uses it', () => {
  // The defect: the badge rendered `source.dataStatus` raw, so this page showed
  // "stale" and "partial" to a Romanian reader while the dictionary held both.
  for (const state of STATUSES) {
    const label = pageFns.sourceStatusLabel(state, ro);
    assert.notEqual(label, state, `${state} renders as its own English token`);
    assert.ok(label.length > 1 && !label.startsWith('status'), `${state} has no label; got ${label}`);
  }
  // And the page is not merely capable of it — the row really calls the helper,
  // rather than still escaping the raw token beside a translated one.
  assert.match(dashboardSource, /escapeHtml\(sourceStatusLabel\(state, t\)\)/,
    'the badge renders the raw status again');
});

test('every status has a message of its own in Romanian, not an English fallback', () => {
  // Asking sourceStatusLabel for a Romanian label is not enough: t() falls back
  // to the English block, and 'Cancelled' still differs from the token
  // 'cancelled', so a status whose Romanian message was never written passes
  // every check above while a Romanian reader gets the English word. The key
  // has to exist in the block the page is actually reading.
  const missing = [];
  for (const state of STATUSES) {
    const key = 'status' + state.charAt(0).toUpperCase() + state.slice(1);
    for (const [lang, dict] of [['ro', DICT.ro], ['en', DICT.en]]) {
      if (!dict || !dict[key]) missing.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missing.sort(), [], `a status has no message of its own: ${missing.join(', ')}`);
});

test('a stale book says why, in the page language, with the limit the backend sent', () => {
  // Shaped like the real capture: 22 of its 22 books carry exactly this record.
  const source = {
    sourceId: 'admiral',
    count: 314,
    dataStatus: 'stale',
    dataReasonCode: 'tooOld',
    dataReason: 'snapshot age 2196786504ms exceeds 600000ms',
    dataReasonParams: { limit: 600000 },
    ageMs: 2196786504,
  };
  const text = pageFns.sourceReasonText(source, ro);
  assert.ok(text.length > 0, 'the reason is never rendered');
  assert.ok(!text.includes('snapshot age'), 'the English sentence reached the Romanian page');
  assert.match(text, /10/, 'the limit the backend sent is not in the sentence');
  // Same book, English page: a real translation, not one language with accents.
  assert.notEqual(pageFns.sourceReasonText(source, en), text);
});

test('a reason never quotes an English status inside a translated sentence', () => {
  const text = pageFns.sourceReasonText(
    { dataStatus: 'failed', dataReasonCode: 'statusReported', dataReason: 'snapshot is failed', dataReasonParams: { status: 'failed' } },
    ro,
  );
  assert.match(text, /Eșuat/, 'the status is not translated inside the reason');
  assert.ok(!/\bfailed\b/.test(text), 'the raw token leaked into the sentence');
});

test('a fresh book explains nothing, and an unknown code falls back to the operator sentence', () => {
  // Absent rather than empty: a fresh book has no failure to report, and the
  // row leaves the line out entirely instead of rendering an empty box.
  assert.equal(pageFns.sourceReasonText({ dataStatus: 'fresh', dataReasonCode: null }, ro), '');
  assert.equal(pageFns.sourceReasonText({}, ro), '');
  assert.equal(pageFns.sourceReasonText(null, ro), '');

  // A code added to the backend after this page shipped must not blank the card
  // or print "reasonSomethingNew" to a reader.
  const unknown = pageFns.sourceReasonText(
    { dataStatus: 'stale', dataReasonCode: 'somethingNew', dataReason: 'operator sentence' },
    ro,
  );
  assert.equal(unknown, 'operator sentence');
});

test('the row puts the reason on the card, not only into a helper', () => {
  // The defect this whole lot describes, at its smallest: a helper that computes
  // the right thing and a page that never calls it. sourceReasonText is tested
  // above directly, so nothing there would notice the row had stopped using it.
  assert.match(dashboardSource, /const reason = sourceReasonText\(source, t\)/,
    'the row no longer asks for the reason');
  assert.match(dashboardSource, /class="source-reason"/,
    'the reason has no element on the card');
  // And it is the reason that drives that element, not a constant.
  assert.match(dashboardSource, /\$\{reason \?/,
    'the element is not driven by the computed reason');
  assert.match(dashboardCss, /\.source-row \.source-reason\s*\{/, 'the reason has no style rule');
});

test('a book names the others it cannot be paired against', () => {
  // Measured over the capture: 16 of 22 books stand in six groups, and winbet
  // carries five peers. Without a name the reader cannot tell an absent pairing
  // from an absent opportunity.
  const note = pageFns.sourceFeedNote({ sourceId: 'winbet', sharedFeedWith: ['don', 'topbet', 'million', 'powerbet', 'baumbet'] }, ro);
  assert.match(note, /don/, 'the peers are not named');
  assert.equal(['don', 'topbet', 'million', 'powerbet', 'baumbet'].filter((p) => note.includes(p)).length, 5,
    'every peer is named, not a sample of them');
  assert.ok(!note.includes('altenar-tenancy'), 'the operator slug reached the reader');
  assert.notEqual(pageFns.sourceFeedNote({ sourceId: 'winbet', sharedFeedWith: ['don'] }, en), note,
    'the note is not translated');

  // The negative control beside it: a book that stands alone gets nothing. A
  // chip on every row would be wallpaper, and the census would be satisfied by
  // a note that says nothing.
  assert.equal(pageFns.sourceFeedNote({ sourceId: 'admiral2', sharedFeedWith: [] }, ro), '');
  assert.equal(pageFns.sourceFeedNote({ sourceId: 'admiral2' }, ro), '');
  assert.equal(pageFns.sourceFeedNote({}, ro), '');
  assert.equal(pageFns.sourceFeedNote(null, ro), '');
});

test('a feed caught out at runtime says so, and the two halves stay distinguishable', () => {
  // duplicateFeedEvents is the measured proof that a feed was shared, where
  // sharedFeedWith is the declared group. Zero across this capture, and proven
  // reachable — test/altenar-public.test.mjs:166 asserts a book at 2.
  const note = pageFns.sourceFeedNote(
    { sourceId: 'winbet', sharedFeedWith: ['don'], duplicateFeedEvents: 2 },
    ro,
  );
  assert.match(note, /2/, 'the dropped count is not shown');
  assert.match(note, /don/, 'and the declared peers are not shown either');
  // Zero must not print "0 events", which would be a claim about the scan.
  assert.ok(!/^0/.test(note), `a book with no clones still carries a note: ${note}`);
  assert.equal(pageFns.sourceFeedNote({ sourceId: 'x', duplicateFeedEvents: 0 }, ro), '');
});

test('the row shows the feed note, and it truncates rather than pushing the row apart', () => {
  // Same trap as the reason: a helper nobody calls. And a list five names long
  // has to degrade, since the bar and the badge sit on the same row.
  assert.match(dashboardSource, /const feedNote = sourceFeedNote\(source, t\)/,
    'the row no longer asks for the feed note');
  assert.match(dashboardSource, /class="chip source-feed"/, 'the note has no element on the card');
  assert.match(dashboardSource, /title="\$\{escapeHtml\(feedNote\)\}"/,
    'the full list is not available once the chip truncates');

  // Scoped to the rule's own body. A lazy `[\s\S]*?` past the closing brace
  // matched `text-overflow: ellipsis` belonging to two unrelated rules further
  // down the file, so the mutant that deleted it from this one still passed:
  // an assertion that can be satisfied by a stranger's declaration is not an
  // assertion about this rule.
  const rule = /\.source-row \.source-feed\s*\{([^}]*)\}/.exec(dashboardCss);
  assert.ok(rule, '.source-feed has no rule');
  assert.match(rule[1], /text-overflow:\s*ellipsis/, 'a long peer list would push the row apart instead of truncating');
  assert.match(rule[1], /min-width:\s*0/, 'a flex child without min-width cannot shrink at all');
  assert.match(rule[1], /overflow:\s*hidden/, 'and without overflow the ellipsis never appears');
});

/**
 * Every reason code the backend can put on a book, lifted from the producer.
 *
 * Both files that write one are read, in both the literal and the assignment
 * form, so a code added to either is here rather than typed in.
 */
const REASON_CODES = (() => {
  const codes = [
    ...[...dataQualityCode.matchAll(/reasonCode:\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...scannerCode.matchAll(/(?:dataReasonCode|reasonCode)\s*[:=]\s*'([^']+)'/g)].map((m) => m[1]),
  ];
  assert.ok(codes.length >= 8, `found only ${codes.length} reason codes; the scan is too narrow to believe`);
  return new Set(codes);
})();

test('every reason code the backend can write is translated in both languages', () => {
  // The gap this closes is silent: a code with no message does not throw, it
  // falls back to the English prose, and the page quietly goes back to the
  // defect this lot removed. So the code list is the backend's, not a list here.
  const missing = [];
  for (const code of REASON_CODES) {
    const key = 'reason' + code.charAt(0).toUpperCase() + code.slice(1);
    for (const [lang, dict] of [['ro', DICT.ro], ['en', DICT.en]]) {
      if (!dict || !dict[key]) missing.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missing.sort(), [], `a reason code has no message: ${missing.join(', ')}`);

  // And each one is reachable: the page renders a message, not a key name.
  for (const code of REASON_CODES) {
    const text = pageFns.sourceReasonText({ dataStatus: 'stale', dataReasonCode: code }, ro);
    assert.ok(!text.startsWith('reason'), `${code} rendered as ${text}`);
  }
});

test('every placeholder in a reason message has a declared source, and every published param is used', () => {
  const PLACEHOLDERS = {
    // The badge, translated — not the raw token.
    status: 'dataStatus',
    // The limit travels in milliseconds and the message is in minutes, the
    // same conversion freshnessLimit already uses.
    minutes: 'dataReasonParams.limit',
    count: 'dataReasonParams.count',
    checked: 'dataReasonParams.checked',
  };
  // What the backend actually publishes, in both the literal and the assignment
  // form, so the two lists below are checked against the code and not each other.
  const published = new Set([
    ...[...dataQualityCode.matchAll(/reasonParams:\s*\{([^}]*)\}/g)],
    ...[...scannerCode.matchAll(/dataReasonParams\s*=\s*\{([^}]*)\}/g)],
  ].flatMap((m) => [...m[1].matchAll(/(\w+):/g)].map((k) => k[1])));
  assert.ok(published.has('limit') && published.has('checked'), 'the param scan found nothing');

  const used = new Set();
  for (const lang of ['ro', 'en']) {
    for (const [key, value] of Object.entries(DICT[lang] || {})) {
      if (!key.startsWith('reason')) continue;
      for (const ph of String(value).matchAll(/\{(\w+)\}/g)) used.add(ph[1]);
    }
  }
  const unsourced = [...used].filter((ph) => !(ph in PLACEHOLDERS)).sort();
  assert.deepEqual(unsourced, [], `a message interpolates a placeholder nobody fills: ${unsourced.join(', ')}`);

  // The inverse: a param on the payload that no message reads is the same gap
  // this lot closed, reopened one level down.
  const unused = [...published].filter((p) => !Object.values(PLACEHOLDERS).includes(`dataReasonParams.${p}`)).sort();
  assert.deepEqual(unused, [], `the backend publishes a param no message can show: ${unused.join(', ')}`);
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
  const body = extractFn('loadWorkspace', scannerCode);

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
  transport: [
    'Provenance for an operator: which scraper produced the capture. Twenty-two distinct',
    'values across the twenty-two books of a real capture, which is the point — and the least',
    'useful thing to put on a card whose question is which books are fresh.',
  ].join(' '),
  feedGroup: [
    'The identity behind sharedFeedWith, and deliberately not rendered: its values read',
    'nsoft-company, exalogic-xsport and everymatrix-wamp, which are operator slugs — the',
    'same mistake the market key was on the catalog page. What a reader needs is which',
    'books, and sharedFeedWith is already that list, so showing the slug would add an',
    'identifier and remove nothing.',
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
  //
  // And the corpus is blanked file by file first, comments included. This is the
  // reader half of the census, and the reader half is the half that fails
  // silently: a comment naming `source.feedGroup` in any page would put the
  // field on the "read" side of the line below, with the page still not reading
  // it. The five of the ten excused names are exactly the kind of thing a
  // sentence about a field mentions by name, which is why the excuse list itself
  // is the best place for a census to be fooled.
  const corpus = readdirSync(join(ROOT, 'public'), { recursive: true })
    .filter((f) => f.endsWith('.js') || f.endsWith('.html'))
    .map((f) => codeOnly(readFileSync(join(ROOT, 'public', f), 'utf8'), f.endsWith('.js')))
    .join('\n');
  const readByAPage = (name) => new RegExp(`\\bsources?\\w*\\.${name}\\b`).test(corpus);

  // The four the card has always read, plus the three that turned a published
  // English sentence into something the page can say out loud, plus the peers a
  // reader needs to understand an absent pairing.
  for (const name of [
    'sourceId', 'count', 'ageMs', 'dataStatus', 'dataReason', 'dataReasonCode', 'dataReasonParams',
    'sharedFeedWith', 'duplicateFeedEvents',
  ]) {
    assert.equal(readByAPage(name), true, `${name} is read today; the search that must find it does not`);
  }
  for (const name of [
    'file', 'runId', 'sourceUrl', 'observedAt', 'capturedAt', 'transport', 'feedGroup',
    'implausibleMarginCount', 'implausibleMarginRate', 'implausibleMarketCount',
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

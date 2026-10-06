/**
 * analytics-page.test.mjs — the bet tracker's table against the bet the service writes.
 *
 * `normalizeBet` writes twelve fields. Before this, the table rendered eight of
 * them and the four it dropped were the ones that make a ledger a ledger: when
 * the bet was placed, when it was last touched, the operator's own note, and
 * where the record came from. `notes` is the sharp one — nothing in this app
 * writes it except the CSV import the same page offers, so a note that arrived
 * in a file had no way to be read back after the import that carried it.
 *
 * The page is loaded the way the other frontend tests load it: the real source,
 * the real escaper from common.js and the real dictionary, cut before the first
 * statement that needs a <dialog>. Nothing rendered here is re-implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildMarketCatalog } from '../src/scanner/market-catalog.mjs';
import { codeOnly, fieldReads, fieldsOn, objectEntries } from './helpers/code-only.mjs';

const analyticsSource = readFileSync(new URL('../public/js/pages/analytics.js', import.meta.url), 'utf8');
const commonSource = readFileSync(new URL('../public/js/pages/common.js', import.meta.url), 'utf8');
const i18nSource = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../src/tracker-service.mjs', import.meta.url), 'utf8');
const analyticsHtml = readFileSync(new URL('../public/admin/analytics.html', import.meta.url), 'utf8');
// The two files the `sources` exemption below names. An exemption that says
// "another page already reads this" is a claim about code that can change under
// it, so the claim is made against these sources and checked below rather than
// left as prose: a reason that names a page which stopped reading is worse than
// no reason, because it reads as coverage.
const dashboardSource = readFileSync(new URL('../public/js/pages/dashboard.js', import.meta.url), 'utf8');
const sourceCensusSource = readFileSync(new URL('./source-health-list.test.mjs', import.meta.url), 'utf8');

/**
 * The same two sources with their comments blanked.
 *
 * Every "does the page read this field" question below is answered against
 * these, not against the text as written. A regex over raw source cannot tell a
 * read from a mention, and the gap is not theoretical: `selection.group` is
 * read by nobody in the whole frontend and the only trace of it anywhere is the
 * word "group:" in a comment in dashboard.js. An instrument that counts
 * comments would have called that field read — which is exactly the claim this
 * file exists to check.
 *
 * Measured over the tree as it stands, blanking changes nothing at any of the
 * three extractions below, so nothing rides on it today. It is here because the
 * alternative is a census a one-line comment can switch off.
 */
const analyticsCode = codeOnly(analyticsSource, true);
const serviceCode = codeOnly(serviceSource, true);

/** The real dictionary, per language, loaded the way the page loads it. */
function dictionaries() {
  const out = {};
  for (const lang of ['ro', 'en']) {
    const context = vm.createContext({
      document: { addEventListener() {}, documentElement: {}, querySelectorAll: () => [] },
      localStorage: { getItem: (k) => (k === 'arbiter.lang' ? lang : null), setItem() {} },
      console,
    });
    context.window = context;
    vm.runInContext(i18nSource, context);
    assert.equal(context.arbiterI18n.lang, lang, 'the dictionary really loaded in the language under test');
    out[lang] = context.arbiterI18n;
  }
  return out;
}
const DICTS = dictionaries();

/** The markup's own id set, so a missing element is a failure, not a silent pass. */
const PAGE_IDS = new Set([...analyticsHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/**
 * Load the page the way a browser does: real source, real escaper, real
 * dictionary, cut before the first statement that needs a real DOM.
 *
 * `opts.cut` moves the cut so a test can reach the dialog wiring further down.
 * The import form lives after the default cut, and its behaviour — the toast
 * that says what the import did — was therefore never executed by anything,
 * which is exactly what a mutation run found when three mutants of the handler
 * survived untouched.
 */
function harness(lang = 'ro', opts = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const toasts = [];
  const node = (key) => {
    if (!nodes.has(key)) {
      nodes.set(key, {
        key,
        innerHTML: '',
        value: '',
        checked: false,
        dataset: {},
        className: '',
        classList: { add() {}, remove() {} },
        appendChild() {},
        showModal() {},
        close() {},
        reset() {},
        // The form's own inputs, for the one handler that reads them through a
        // FormData (analytics.js:195). Merged in rather than declared here so a
        // test names the five fields it means to submit, and the page still
        // finds the form node it is looking at.
        ...(opts.form && opts.form[key] ? opts.form[key] : {}),
        addEventListener(type, fn) {
          const at = `${key}:${type}`;
          if (!listeners.has(at)) listeners.set(at, []);
          listeners.get(at).push(fn);
        },
        querySelectorAll: () => [],
      });
    }
    return nodes.get(key);
  };
  const context = vm.createContext({
    document: {
      getElementById: (id) => {
        if (!PAGE_IDS.has(id)) throw new Error(`analytics.html has no #${id} — the page and this test have drifted`);
        return node(`#${id}`);
      },
      // The table bodies and the dropdowns the page writes into. Nothing is
      // parsed, so the markup this page produced is the only thing asserted on.
      querySelector: (selector) => node(selector),
      querySelectorAll: () => [],
      createElement: () => ({ className: '', appendChild() {}, setAttribute() {} }),
    },
    // The one call this page makes into app.js, which builds the shell the
    // sidebar-less test document does not have.
    arbiterApp: { mount() {} },
    // Only the form submit handlers reach for this, and only when a test fires
    // one. A test that never fires a form leaves it absent, so a page that
    // started calling the API at load time would fail here rather than pass.
    ...(opts.api ? { arbiterApi: opts.api } : {}),
    console,
    localStorage: { getItem: () => null, setItem() {} },
  });
  context.window = context;
  // The real escaper, cut to its own definition. Line-based, because its body
  // contains a `};` of its own on the `entities` object.
  const escaperLines = commonSource.split(/\r?\n/);
  const escaperStart = escaperLines.findIndex((line) => line.includes('window.escapeHtml = function'));
  assert.ok(escaperStart !== -1, 'common.js must still define window.escapeHtml');
  const escaperEnd = escaperLines.findIndex((line, i) => i > escaperStart && line.trim() === '};');
  assert.ok(escaperEnd !== -1, 'the escaper definition was not closed by a lone }; — has its shape changed?');
  vm.runInContext(escaperLines.slice(escaperStart, escaperEnd + 1).join('\n'), context);
  assert.equal(typeof context.escapeHtml, 'function', 'the real escaper is what the page will call');
  context.arbiterI18n = DICTS[lang];
  // The page's own toast, recorded instead of shown. It is the channel the
  // import result reaches the user through, so it is part of what is under test.
  context.showToast = (message, type) => { toasts.push({ message, type }); };

  // The add-bet handler reads its five fields with a FormData over its own form
  // (analytics.js:195). Node's FormData wants a real HTMLFormElement and this
  // document has none, so the seam answers get() from the form node's `fields`
  // — the same names analytics.html declares. get() is the only method the page
  // calls on it, and a stub that answered more would be a test of the stub.
  context.FormData = class {
    constructor(form) { this.form = form; }
    get(name) {
      const field = this.form && this.form.fields ? this.form.fields[name] : null;
      if (!field) return null;
      return field.checked === undefined ? field.value : (field.checked ? 'on' : null);
    }
  };

  const marker = opts.cut || '// — add-bet modal —';
  const cut = analyticsSource.indexOf(marker);
  assert.ok(cut !== -1, `the cut point "${marker}" is gone — has the page been restructured?`);
  vm.runInContext(analyticsSource.slice(0, cut), context);
  return {
    run: (code) => vm.runInContext(code, context),
    rows: () => node('#tracker-table tbody').innerHTML,
    text: (key) => context.arbiterI18n.t(key),
    node,
    toasts,
    /** Fire a listener the page registered, and wait for it if it is async. */
    async fire(key, type, event = { preventDefault() {} }) {
      const at = `${key}:${type}`;
      const handlers = listeners.get(at) || [];
      assert.equal(handlers.length, 1, `expected exactly one ${type} handler on ${key}, found ${handlers.length}`);
      await handlers[0](event);
    },
  };
}

const AT = '2026-04-05T08:30:00.000Z';
const when = (iso) => new Date(iso).toLocaleString();

/** What the import dialog holds in the test that fires its real handler. */
const CSV_SAMPLE = 'selection,odds,stake\nHome win,2.35,100';

/** A bet with every field the service writes, so "was it rendered" has one answer. */
const fullBet = (over = {}) => ({
  id: 'bet-1',
  createdAt: AT,
  updatedAt: '2026-04-06T09:00:00.000Z',
  eventKey: 'soccer|liga-1|kiv-x-y',
  marketKey: 'MATCH_ODDS',
  selection: 'Home win',
  sourceId: 'favbet',
  odds: 2.35,
  stake: 100,
  status: 'pending',
  notes: 'cashed at the branch, not the app',
  provenance: 'manual',
  ...over,
});

const render = (h, bets) => {
  h.run(`renderTracker({ schemaVersion: 1, updatedAt: null, items: ${JSON.stringify(bets)} })`);
  return h.rows();
};

/**
 * The fields `normalizeBet` writes, named rather than derived.
 *
 * Named, because the test below reads them back out of the service source and
 * compares — that is what makes a field added to the service fail here instead
 * of quietly becoming one more thing the page never shows.
 */
const EXPECTED_BET_FIELDS = [
  'id', 'createdAt', 'updatedAt', 'eventKey', 'marketKey', 'selection',
  'sourceId', 'odds', 'stake', 'status', 'notes', 'provenance',
];

test('every field the service writes is read by the page', () => {
  // Bounds on the raw text, body from the blanked one: blanking keeps every
  // offset, which is what makes that the same region rather than a similar one.
  const body = serviceCode.slice(
    serviceSource.indexOf('function normalizeBet'),
    serviceSource.indexOf('function allowedBetPatch'),
  );
  const written = new Set([
    // The plain keys of the returned object...
    ...[...body.matchAll(/^\s+(\w+)\s*[,:]/gm)].map((m) => m[1]),
    // ...and the one behind a conditional spread, `...(updatedAt ? { updatedAt } : {})`,
    // which is why the count is not the number of lines.
    ...[...body.matchAll(/\?\s*\{\s*(\w+)\s*\}\s*:/g)].map((m) => m[1]),
  ]);
  assert.deepEqual([...written].sort(), [...EXPECTED_BET_FIELDS].sort(),
    'the field list changed — the page has to be told about it, not left behind');

  // Nothing is exempt today. When something is, it goes here with its reason,
  // the way feedStatus went in the bookmaker chip's test.
  const EXEMPT = {};
  // One extraction for the whole page, and a receiver boundary on it. The
  // previous form asked `analyticsSource.includes('b.odds')` per field, which
  // `tb.odds` also satisfies — and `analytics.js` has a `tb`, the table body
  // element — so a field could be counted as read by an object that is not the
  // bet. `b` is now the receiver actually bound at the map in renderTracker.
  const readOnBets = fieldReads(analyticsSource, 'b');
  assert.ok(readOnBets.length > 0, 'the receiver this test reads is not bound anywhere');
  const missing = EXPECTED_BET_FIELDS.filter((field) => !(field in EXEMPT) && !readOnBets.includes(field));
  assert.deepEqual(missing, [], `the page never reads these: ${missing.join(', ')}`);
});

/**
 * The document's own envelope, as opposed to the rows inside it.
 *
 * The census above reads the bet rows through `b`, so a key the service writes
 * at the top of the document and no page ever touches was invisible to it:
 * `saveTracker` writes `schemaVersion`, `updatedAt` and `items`, and
 * `loadTracker` answers a fresh file with the same three, so all three reach
 * every consumer of `GET /api/tracker`.
 *
 * `updatedAt` is the whole-file stamp — when this tracker was last written —
 * and the count line beside the table is the only thing on the page with a
 * place for it. A page that shows per-bet stamps and not the document's own is
 * not wrong, it is uncensused: nothing here would have noticed if the service
 * stopped writing the key.
 */
test('every key the tracker document publishes is read by the page, or named with a reason', () => {
  // The envelope is the literal `saveTracker` writes, read out of the parse
  // tree rather than off the lines: a line counter over the function would also
  // have picked up `id:` and `createdAt:` from the `normalizeBet` call one
  // method further down, which is how the first version of this extraction
  // reported five keys instead of three.
  const saveAt = serviceSource.indexOf('async saveTracker');
  const entries = objectEntries(serviceSource, 'const out = {');
  assert.ok(saveAt !== -1 && serviceSource.indexOf('const out = {', saveAt) < serviceSource.indexOf('async addBet'),
    'the literal this census reads is not the one saveTracker writes');
  const published = entries.map((e) => e.key).sort();
  assert.deepEqual(published, ['items', 'schemaVersion', 'updatedAt'],
    'the tracker envelope changed — the page has to be told about it, not left behind');

  // A schema marker, not a value: there is nothing on this page to render it
  // with, and it is pinned where the document is written instead —
  // test/tracker-service.test.mjs asserts `stored.schemaVersion` is 1 on the
  // file `saveTracker` writes. Same division as the catalog's marker, exempt as
  // a marker and pinned against its builder.
  const EXEMPT = {
    schemaVersion: 'a marker the page cannot render; pinned at the write by test/tracker-service.test.mjs (`stored.schemaVersion` is 1)',
  };

  const read = fieldReads(analyticsCode, 'tracker');
  assert.ok(read.length > 0, 'the receiver this census reads is not bound anywhere');
  const missing = published.filter((k) => !(k in EXEMPT) && !read.includes(k));
  assert.deepEqual(missing, [], `the page never reads these: ${missing.join(', ')}`);
});

test('a bet shows when it was placed, and when it was last touched', () => {
  const h = harness('en');
  const rows = render(h, [fullBet()]);
  assert.match(rows, new RegExp(when(AT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the placed-at date reaches the table');
  assert.match(rows, new RegExp(`${h.text('betUpdated')} ${when('2026-04-06T09:00:00.000Z')}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'and the update is a second line under it, not the only date shown');

  // The control: `updatedAt` is written only once a row has been settled, so
  // its absence is the normal case and must not print a second line or a
  // dangling label.
  const fresh = render(h, [fullBet({ updatedAt: undefined })]);
  assert.doesNotMatch(fresh, new RegExp(h.text('betUpdated')), 'a bet that was never updated says nothing about it');
  assert.match(fresh, new RegExp(when(AT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a missing or unreadable date is an em dash, never "Invalid Date"', () => {
  const h = harness('en');
  // The service always writes createdAt, so these are the truncated-payload
  // cases. A ledger printing NaN or "Invalid Date" is worse than one that
  // admits it does not know.
  for (const value of [undefined, null, '', 'nonsense', 0]) {
    const rows = render(h, [fullBet({ createdAt: value, updatedAt: undefined })]);
    assert.doesNotMatch(rows, /Invalid Date|NaN|undefined|null/, `createdAt ${JSON.stringify(value)} leaks`);
    assert.match(rows, /—/, `createdAt ${JSON.stringify(value)} shows the em dash`);
  }
});

test('the note is shown, and the whole of it is on the title', () => {
  const h = harness('en');
  const rows = render(h, [fullBet()]);
  assert.match(rows, /cashed at the branch, not the app/, 'the note is visible, not just hoverable');
  // A 1000-character note is clamped by CSS, so the title is where the rest of
  // it has to be. The test reads the attribute the same way a screen reader
  // would, not by hoping the CSS still clamps.
  const long = 'x'.repeat(900);
  const withLong = render(h, [fullBet({ notes: long })]);
  assert.match(withLong, new RegExp(`title="${long}"`), 'a clamped note still carries its full text');

  // And a bet with no note gets no empty line.
  assert.doesNotMatch(render(h, [fullBet({ notes: '' })]), /bet-note/, 'no note, no placeholder');
  assert.doesNotMatch(render(h, [fullBet({ notes: undefined })]), /bet-note/);
});

test('a note is escaped, because it arrives from a pasted file', () => {
  const h = harness('en');
  // The one field on a bet that comes from outside this app: a CSV the user
  // pasted in. Trusted today, and a cell that breaks on a quote is a page that
  // breaks the next time somebody pastes a sheet with one.
  const hostile = '<img src=x onerror=alert(1)> and a "quote"';
  const rows = render(h, [fullBet({ notes: hostile, selection: 'Home "win"' })]);
  assert.doesNotMatch(rows, /<img/, 'markup in a note does not become markup');
  assert.ok(rows.includes('&lt;img'), 'and it is escaped instead');
  assert.doesNotMatch(rows, /title="[^"]*and a "quote/, 'the quote does not terminate the title attribute');
  assert.ok(rows.includes('&quot;quote&quot;'));
});

test('the table says where the bet came from', () => {
  // Every reachable value, in both languages, and it is the raw token: the
  // `provenance` field is a service-side enum (manual | import | scan) and the
  // table prints it the way it already prints `status` and `sourceId`.
  //
  // It used to go through a six-key dictionary lookup, and a mutation run
  // proved the lookup did nothing: `betFrom_manual` was 'manual',
  // `betFrom_import` was 'import' and `betFrom_scan` was 'scan' in BOTH
  // dictionaries, so for every value the function could receive it returned
  // the value it was given. A constant is not worth six keys and a function;
  // the keys are gone and the assertion here is the one that keeps it that way
  // — if a label is ever added that is not the value, this fails.
  for (const provenance of ['manual', 'import', 'scan']) {
    for (const lang of ['en', 'ro']) {
      const rows = render(harness(lang), [fullBet({ provenance })]);
      assert.match(rows, new RegExp(`>${provenance}<`), `${provenance} in ${lang}`);
    }
  }

  // The origin is escaped on the way out like every other cell, and one this
  // build has never heard of is shown as itself rather than as a lookup key.
  const hostile = render(harness('en'), [fullBet({ provenance: '<b>kiv</b>' })]);
  assert.doesNotMatch(hostile, /<b>kiv/, 'an unknown origin cannot smuggle markup into the cell');
  assert.ok(hostile.includes('&lt;b&gt;kiv'));
});

test('an import tells the user what it did, through the handler the page ships', async () => {
  // The summary is pure and was tested on its own, but the three things that
  // turn it into something a person sees were not: the route's answer reaching
  // the summary at all, the toast being called, and the type it was called
  // with. Every one of those survived mutation, because this handler sits
  // after the cut the other tests load to — nothing had ever run it.
  const calls = { post: [], get: 0 };
  const route = (answer) => ({
    post: async (url, body) => { calls.post.push([url, body]); return answer; },
    get: async () => { calls.get += 1; return { schemaVersion: 1, updatedAt: null, items: [fullBet()] }; },
  });
  const importer = (answer) => {
    const h = harness('en', { cut: 'arbiterSse.connect', api: route(answer) });
    h.node('#import-csv-input').value = `${CSV_SAMPLE}\n`;
    return h;
  };

  // A file that lost rows on the way in: a warning, and the loss is named.
  const partial = importer({ imported: 3, skipped: 9 });
  await partial.fire('#import-csv-form', 'submit');
  assert.deepEqual(partial.toasts, [{ message: 'Imported 3 bets, skipped 9 rows', type: 'warning' }],
    'the answer the route sent is what the user is told');
  assert.deepEqual(calls.post[0][0], '/api/tracker/import', 'and it came from the import route');
  assert.equal(calls.post[0][1].csv, CSV_SAMPLE, 'the textarea was posted as the file');
  assert.ok(calls.get >= 1, 'and the table was re-read afterwards');
  assert.match(partial.rows(), /Home win/, 'so the new row is on screen');

  // The control: a clean import is a success, and a different type is the only
  // thing that tells the two apart at a glance.
  const clean = importer({ imported: 12, skipped: 0 });
  await clean.fire('#import-csv-form', 'submit');
  assert.deepEqual(clean.toasts, [{ message: 'Imported 12 bets', type: 'success' }]);

  // And nothing at all to import is still a warning, not a success.
  const none = importer({ imported: 0, skipped: 0 });
  await none.fire('#import-csv-form', 'submit');
  assert.deepEqual(none.toasts, [{ message: 'No row could be imported', type: 'warning' }]);
});

test('an empty textarea is refused before the route is called', async () => {
  // The page's own guard. Without it the route is asked to import nothing, and
  // the answer it gives — "no row could be imported" — is a statement about the
  // file the user just chose, which is not the problem.
  const calls = { post: 0 };
  const h = harness('en', {
    cut: 'arbiterSse.connect',
    api: { post: async () => { calls.post += 1; return { imported: 0, skipped: 0 }; }, get: async () => ({ items: [] }) },
  });
  h.node('#import-csv-input').value = '   \n  ';
  await h.fire('#import-csv-form', 'submit');
  assert.equal(calls.post, 0, 'the route was not asked to import whitespace');
  assert.deepEqual(h.toasts, [], 'and nothing was toasted as a result');
  assert.equal(h.node('#import-csv-error').textContent, h.text('pasteCsvFirst'), 'the dialog says what is missing');
});

test('the table is as wide as its header, and the loading state agrees', () => {
  // The colspan of the empty state and the skeleton's width are the two numbers
  // that drift silently when a column is added: the table looks right when it
  // has rows and stretched across half the viewport while loading.
  const table = analyticsHtml.slice(analyticsHtml.indexOf('id="tracker-table"'));
  const trackerHeaders = (table.slice(0, table.indexOf('</table>')).match(/<th\b/g) || []).length;
  assert.ok(trackerHeaders >= 9, `the tracker header should have the placed-at column; found ${trackerHeaders}`);
  assert.equal(harness('en').run('TRACKER_COLS'), trackerHeaders,
    'TRACKER_COLS is the header count, so the two cannot drift apart');
  assert.match(analyticsSource, /showTableSkeleton\('tracker-table', TRACKER_COLS\)/,
    'and the loading state is drawn at that width');
});

test('an empty tracker spans the whole table', () => {
  const h = harness('en');
  const rows = render(h, []);
  assert.match(rows, new RegExp(`colspan="${h.run('TRACKER_COLS')}"`));
  assert.match(rows, /noBets|empty/i, 'and it still says there is nothing here');
});

test('the import says what it did, including what it lost', () => {
  const summarise = (lang, result) => harness(lang).run(`importSummary(${JSON.stringify(result)}, window.arbiterI18n.t.bind(window.arbiterI18n))`);

  const clean = summarise('en', { imported: 12, skipped: 0 });
  assert.equal(clean.type, 'success');
  assert.equal(clean.message, 'Imported 12 bets');

  // The case that used to be invisible: the file imported, some of it did not.
  const partial = summarise('en', { imported: 3, skipped: 9 });
  assert.equal(partial.type, 'warning', 'a partial import is a warning, not a success');
  assert.equal(partial.message, 'Imported 3 bets, skipped 9 rows');

  // And the case where nothing happened at all, which is what a file the
  // importer could not read a single row from looks like from the outside.
  const empty = summarise('en', { imported: 0, skipped: 0 });
  assert.equal(empty.type, 'warning');
  assert.equal(empty.message, 'No row could be imported');

  // Every row unusable is not the same as no rows: 0 imported with 9 skipped
  // still has to say the nine were dropped, and folding it into "nothing to
  // import" is the silent partial failure this closes.
  const allSkipped = summarise('en', { imported: 0, skipped: 9 });
  assert.equal(allSkipped.message, 'Imported 0 bets, skipped 9 rows');

  // No placeholders survive into the message, in either language.
  for (const lang of ['ro', 'en']) {
    for (const result of [{ imported: 1, skipped: 2 }, { imported: 4, skipped: 0 }]) {
      const out = summarise(lang, result);
      assert.doesNotMatch(out.message, /\{n\}|\{skipped\}/, `${lang} left a placeholder in "${out.message}"`);
    }
  }
  assert.equal(summarise('ro', { imported: 3, skipped: 9 }).message,
    '3 pariuri importate, 9 rânduri ignorate');
});

test('a malformed answer from the route does not become "success"', () => {
  const h = harness('en');
  // A payload from an older or newer server: missing keys, strings, null.
  for (const result of [undefined, null, {}, { imported: 'lots' }, { imported: null, skipped: null }]) {
    const out = h.run(`importSummary(${JSON.stringify(result)}, window.arbiterI18n.t.bind(window.arbiterI18n))`);
    assert.ok(['success', 'warning'].includes(out.type), `${JSON.stringify(result)} gave ${out.type}`);
    assert.doesNotMatch(out.message, /NaN|undefined|\{/, `${JSON.stringify(result)} leaked into "${out.message}"`);
  }
  // And the shape the route really sends.
  assert.equal(h.run("importSummary({ imported: '3', skipped: '1' }, window.arbiterI18n.t.bind(window.arbiterI18n)).message"),
    'Imported 3 bets, skipped 1 rows', 'counts arriving as strings are still counted');
});

test('every key the tracker readout uses exists in both languages', () => {
  for (const key of ['placed', 'betUpdated',
    'toastImportDone', 'toastImportPartial', 'toastImportEmpty', 'pasteCsvFirst',
    'noBets', 'markWon', 'markLost', 'delete']) {
    for (const lang of ['ro', 'en']) {
      const value = DICTS[lang].t(key);
      assert.notEqual(value, key, `${lang} is missing ${key} — t() would print the key itself`);
    }
  }
});

// ---- the add-bet form -------------------------------------------------------

/** The five inputs the form declares in analytics.html, as a FormData sees them. */
const ADD_BET_FORM = {
  selection: { value: 'Home win' },
  odds: { value: '2.35' },
  stake: { value: '100' },
  sourceId: { value: 'favbet' },
  marketKey: { value: 'MATCH_ODDS' },
};

/**
 * The page with the add-bet handler loaded and the form filled in.
 *
 * `cut: 'arbiterSse.connect'` puts the cut past the handler, which is where the
 * import test already cuts to reach the import handler. The POST is recorded
 * whether or not an override throws, so "the route was never asked" stays a
 * real assertion in the case where the page's own validation stops the submit.
 */
const addBet = (lang, { form = ADD_BET_FORM, post } = {}) => {
  const calls = { post: [], get: 0 };
  const h = harness(lang, {
    cut: 'arbiterSse.connect',
    form: { '#add-bet-form': { fields: form } },
    api: {
      post: async (url, body) => {
        calls.post.push([url, body]);
        return post ? post(url, body) : { ok: true };
      },
      get: async () => {
        calls.get += 1;
        return { schemaVersion: 1, updatedAt: null, items: [fullBet()] };
      },
    },
  });
  return { h, calls };
};

test('adding a bet says so, the way importing one does', async () => {
  // The import handler toasts what it did. The add-bet handler did not, so the
  // one action on this page with a form said nothing at all on success — the
  // only feedback was the dialog disappearing. A POST that worked and a page
  // that looked unchanged is the kind of thing people do twice.
  for (const lang of ['ro', 'en']) {
    const { h, calls } = addBet(lang);
    await h.fire('#add-bet-form', 'submit');
    assert.deepEqual(calls.post.map(([url]) => url), ['/api/tracker'], `the bet went to the tracker in ${lang}`);
    // Through JSON: the body is built inside the vm realm, so its prototype is
    // that realm's Object.prototype and deepStrictEqual would fail on the
    // prototype rather than on the fields.
    assert.deepEqual(JSON.parse(JSON.stringify(calls.post[0][1])), {
      selection: 'Home win', odds: 2.35, stake: 100, sourceId: 'favbet',
      marketKey: 'MATCH_ODDS', status: 'pending', provenance: 'manual',
    }, `and carried the fields the service normalises, in ${lang}`);
    assert.deepEqual(h.toasts, [{ message: h.text('toastBetTracked'), type: 'success' }],
      `the user is told, in ${lang}`);
    assert.ok(calls.get >= 1, `and the table was re-read so the new row is on screen, in ${lang}`);
  }
});

test('the toast is translated, not one English string on a Romanian page', async () => {
  // The channel is shared with the import, so a literal here would have shown up
  // in Romanian with no way for the reader to tell it was not a translation bug.
  const ro = addBet('ro');
  await ro.h.fire('#add-bet-form', 'submit');
  const en = addBet('en');
  await en.h.fire('#add-bet-form', 'submit');
  assert.notEqual(ro.h.toasts[0].message, en.h.toasts[0].message);
  assert.doesNotMatch(ro.h.toasts[0].message, /Bet added|toastBetTracked/);
  assert.doesNotMatch(en.h.toasts[0].message, /Pariu adăugat/);
});

test('a bet that was refused is not toasted as one', async () => {
  // A success toast on a rejected POST tells the user their bet is in the
  // ledger when it is not. This page already has that exact test for the
  // import — "a malformed answer from the route does not become success" — and
  // the toast added here has to sit on the same side of it.
  const { h } = addBet('en', { post: async () => { throw new Error('tracker refused'); } });
  await h.fire('#add-bet-form', 'submit');
  assert.deepEqual(h.toasts, [], 'a refused bet is not toasted');
  assert.match(h.node('#add-bet-error').textContent, /tracker refused/,
    'and the refusal is shown where the operator is still looking');

  // The third shape: the page's own validation stops the submit before the
  // route is asked at all. A success message here would be a bet that is not in
  // the ledger, reported as one that is.
  const blank = addBet('en', { form: { ...ADD_BET_FORM, stake: { value: '0' } } });
  await blank.h.fire('#add-bet-form', 'submit');
  assert.equal(blank.calls.post.length, 0, 'the route was never asked');
  assert.deepEqual(blank.h.toasts, [], 'and nothing was toasted');
  assert.equal(blank.h.node('#add-bet-error').textContent, blank.h.text('requiredFieldsError'),
    'the form says what is missing instead');
});

// — market catalog —

/**
 * A catalog the real builder produced, so the field lists below are the
 * producer's and not a transcription of it.
 *
 * Two books, one of them with a name the key does not spell: `BTSC` is
 * "Ambele echipe înscriu", which is the case this section is about.
 */
async function realCatalog() {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-catalog-ui-'));
  try {
    await mkdir(join(dir, 'workspace'), { recursive: true });
    const betano = {
      eventKey: 'football|liga-1|2030-01-01|fcsb|cfr',
      sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
      homeTeam: 'FCSB', awayTeam: 'CFR',
      markets: [{ key: 'BTSC', name: 'Ambele echipe înscriu', selections: [{ name: 'Da' }, { name: 'Nu' }] }],
    };
    const admiral = {
      ...betano,
      markets: [{ key: '1x2', name: 'Rezultat Final', selections: [{ name: '1' }, { name: 'X' }, { name: '2' }] }],
    };
    await writeFile(join(dir, 'workspace', 'betano_events.json'),
      JSON.stringify({ sourceId: 'betano', capturedAt: 'x', events: [betano] }));
    await writeFile(join(dir, 'workspace', 'admiral_events.json'),
      JSON.stringify({ sourceId: 'admiral', capturedAt: 'x', events: [admiral] }));
    return await buildMarketCatalog(dir, {
      scrapeRunId: 'scrape-2026-09-28T18-53-05-091Z',
      sources: [
        { sourceId: 'betano', file: 'betano_events.json', capturedAt: 'x', count: 1 },
        { sourceId: 'admiral', file: 'admiral_events.json', capturedAt: 'x', count: 1 },
      ],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What the builder writes, named rather than derived, and checked against it below. */
const CATALOG_TOP_FIELDS = ['builtAt', 'events', 'markets', 'scrapeRunId', 'schemaVersion', 'sources'];
const CATALOG_MARKET_FIELDS = ['eventCount', 'marketKey', 'marketName', 'selectionCount', 'sourceId'];
const CATALOG_EVENT_FIELDS = ['awayTeam', 'eventKey', 'homeTeam', 'kickoff', 'league', 'marketKeys', 'selectionCount', 'sources', 'sport'];

/**
 * The page's catalog unit, so `cat.` and `m.` mean one thing inside it.
 *
 * The harness cuts at the same markers, so these are the bounds the tests below
 * are actually about — found once on the raw text, and asserted once, because
 * two copies of an `indexOf` pair is how a block quietly stops being the block.
 *
 * Two regions, not one, and the seam is the point. The block above the marker is
 * the market card and the block below it is the event card; they are two cards in
 * the page now, over one document. Collapsing them back into a single region
 * would make "the market card must not reach for cat.events" impossible to state
 * — it would go false the moment the event card below it reads it. So the seam is
 * cut where the card boundary is and each side is held to what it may read.
 */
const CATALOG_BOUNDS = (() => {
  const from = analyticsSource.indexOf('// — market catalog —');
  const mid = analyticsSource.indexOf('// — event coverage —');
  const to = analyticsSource.indexOf('// — add-bet modal —');
  assert.ok(from !== -1 && mid > from && to > mid,
    'the catalog regions are gone or out of order — has the page been restructured?');
  return { from, mid, to };
})();

/** The same regions with their comments blanked, so a slice of one is that region. */
const CATALOG_CODE = analyticsCode.slice(CATALOG_BOUNDS.from, CATALOG_BOUNDS.mid);
const COVERAGE_CODE = analyticsCode.slice(CATALOG_BOUNDS.mid, CATALOG_BOUNDS.to);

/**
 * Every `<receiver>.<field>` a region reads, for a given receiver name.
 *
 * Read off the blanked region, so a field named in a comment inside it is still
 * reported as unread — which is the state the tests below assert for
 * `cat.sources` and `cat.schemaVersion`. Those are the two a comment could most
 * easily talk a census into believing, since both are named in the prose of this
 * very test file.
 *
 * Receivers are the page's own bindings: `cat` is the document, `m` a market row,
 * `ev` an event row. The boundary is what stops `mm.marketKey` from answering for
 * `m.marketKey`, and what keeps the event card's `ev.league` from being counted
 * as a market field.
 */
const readsOn = (receiver, code = CATALOG_CODE) => fieldsOn(code, receiver);

/**
 * What the two cards read off the document, which is the union of both regions.
 *
 * `cat` is the document as a whole — one fetch feeds two cards — so a top-level
 * field is read if either card reads it. The per-card statements are made
 * separately, where they mean something: see the test that splits them.
 */
const topLevelReads = [...new Set([...readsOn('cat'), ...readsOn('cat', COVERAGE_CODE)])];

/**
 * Published by the catalog, read by no page, with the reason it is allowed.
 *
 * When a name is removed from here the test says why it stopped being allowed,
 * and if the reason was the code's own docstring, the docstring is in the test.
 *
 * `events` is not on this list any more, and its absence is this lot's result. It
 * was here with a reason that said the promise was unfulfilled — buildMarketCatalog
 * writes "Browsable from /admin/analytics#catalog" and only the markets half was
 * ever built — and the decision taken on that was to build the missing half rather
 * than to stop publishing it. The event card is that half, and the absence of
 * `events` from this table is what says it arrived: put the name back here and
 * the test will demand the same reason again.
 */
const UNREAD_BY_DESIGN = {
  sources: [
    'A verbatim copy of scan.sources, which /api/scan already delivers and which',
    'dashboard.js reads on its own source-health card: dataStatus, ageMs, count,',
    'sourceId, duplicateFeedEvents, sharedFeedWith and dataReason, over the 24 books',
    'of the stored catalog. The array is 11 964 B of the 866 KB the route serves —',
    "1.4% — and the 17 names on a source are censused against that card in",
    'test/source-health-list.test.mjs, which lifts them out of the producer rather',
    'than out of a list, so the field set cannot drift past the page that draws it.',
    'This exemption is a collection, not a blank cheque: the promise is checked',
    'below, and the near-miss is recorded because it is why the old reason looked',
    'true — ai.js reads scan.dataHealth.sources, a status -> count map, and',
    'legs[].sourceId, an id on a leg. Neither is a field of what this route',
    'republishes, and the reason used to credit ai.js with both.',
  ].join(' '),
  schemaVersion: [
    'A version marker, and the only one of its kind in the tree whose value',
    'nothing pinned. Measured across the whole tree: six builders write one',
    '(src/router.mjs:294, src/alert-engine.mjs, src/tracker-service.mjs,',
    'src/scanner/scanner.mjs, src/scanner/market-catalog.mjs, src/scrapers/base.mjs)',
    'and no page reads any of them. The siblings are pinned in test/router.test.mjs:492,',
    'test/tracker-service.test.mjs:274 and test/endpoints-registry.test.mjs:24; this',
    'one was not, so the constant the builder writes was free to change with the suite green.',
    'It is pinned here instead, against the literal in the builder, so a version',
    'bump fails this file rather than a reader discovering two document shapes',
    'under one name. Exempt as a marker, not as a value: the test below asserts',
    'both halves — the number, and that no card reads it.',
  ].join(' '),
};

test('every field the catalog publishes is read by the page, or is named above with a reason', async () => {
  const cat = await realCatalog();
  // The lists are compared to what the builder really wrote, so a field added to
  // the builder fails here instead of quietly becoming one more unread thing.
  assert.deepEqual(Object.keys(cat).sort(), [...CATALOG_TOP_FIELDS].sort(),
    'the catalog document gained or lost a top-level field');
  assert.deepEqual(Object.keys(cat.markets[0]).sort(), [...CATALOG_MARKET_FIELDS].sort(),
    'a catalog row gained or lost a field');

  // Receivers named as the page binds them: `cat` is the document, `m` a row.
  // Renaming either is expected to fail here, which is the canary.
  const unreadTop = CATALOG_TOP_FIELDS
    .filter((f) => !(f in UNREAD_BY_DESIGN) && !topLevelReads.includes(f));
  assert.deepEqual(unreadTop, [], `the page never reads these: ${unreadTop.join(', ')}`);

  const unreadMarkets = CATALOG_MARKET_FIELDS.filter((f) => !readsOn('m').includes(f));
  assert.deepEqual(unreadMarkets, [], `the page never reads these off a row: ${unreadMarkets.join(', ')}`);

  // The event half, held to the same three questions: every field the builder
  // writes is read, the row receiver is really read, and no field is invented.
  // Measured on the real catalog: 2 770 rows, 842 KB, and the nine fields below
  // are the complete key set of every one of them — no row is missing any of
  // them, so a page that reads all nine is reading all the shape there is.
  const eventReads = readsOn('ev', COVERAGE_CODE);
  const unreadEvents = CATALOG_EVENT_FIELDS.filter((f) => !eventReads.includes(f));
  assert.deepEqual(unreadEvents, [], `the event card never reads these off a row: ${unreadEvents.join(', ')}`);
  const inventedEvents = eventReads.filter((f) => !CATALOG_EVENT_FIELDS.includes(f));
  assert.deepEqual(inventedEvents, [], `and it reads fields the builder does not write: ${inventedEvents.join(', ')}`);

  // And the controls, because both halves above can pass vacuously: a region
  // that reads nothing would report every field unread and every invented field
  // absent, and the real document is what the field lists are checked against.
  assert.ok(topLevelReads.length > 0 && readsOn('m').length > 0 && eventReads.length > 0,
    'both cards read something at all');
});

test('the two cards split the document between them, and neither reaches past it', async () => {
  // `events` used to be on the exempt list, which was a statement that no card
  // read it. It is read now, by the event card, so the assertion cannot stay
  // "no card reads it" — it has to become "the market card does not, the event
  // card does, and neither of them touches the other two exemptions". That is
  // only stateable because the block is cut in two; as one region this test
  // would have been unable to say which card did what.
  assert.equal(readsOn('cat').includes('events'), false,
    'the market card reads cat.events — the 845 KB index belongs to the event card alone');
  assert.equal(readsOn('cat', COVERAGE_CODE).includes('events'), true,
    'the event card does not read cat.events, and the whole point of it is that it does');

  for (const field of ['sources', 'schemaVersion']) {
    assert.equal(readsOn('cat').includes(field), false, `the market card reads cat.${field}`);
    assert.equal(readsOn('cat', COVERAGE_CODE).includes(field), false,
      `the event card reads cat.${field}; remove it from UNREAD_BY_DESIGN and say why in the same commit`);
  }
});

test('the sources exemption names a page that really reads a source record', () => {
  // "Another page already reads this" is a claim about code that lives outside
  // this file and can change under it. The reason used to name ai.js, which
  // reads `scan.dataHealth.sources` — a status -> count map — and
  // `legs[].sourceId`, an id on a leg. Neither is a field of a source record, so
  // the claim was false, and nothing above could have caught it: the census says
  // which of the two cards read what, and no card reads `cat.sources` either way.
  // A reason that credits a page with reading a field it does not read is worse
  // than no reason, because it reads as coverage.
  const dashboardCode = codeOnly(dashboardSource, true);
  const onASource = new Set([...fieldsOn(dashboardCode, 'source'), ...fieldsOn(dashboardCode, 's')]);
  for (const name of ['dataStatus', 'ageMs', 'count', 'sourceId', 'duplicateFeedEvents',
    'sharedFeedWith', 'dataReason']) {
    assert.ok(onASource.has(name),
      `the sources reason credits dashboard.js with reading ${name}, and dashboard.js does not`);
  }
  // The ai.js half is pinned the other way round, because the near-miss is the
  // reason the old sentence looked true: if that page ever starts reading a
  // source record, the reason is stale in the direction that matters.
  const aiCode = codeOnly(readFileSync(new URL('../public/js/pages/ai.js', import.meta.url), 'utf8'), true);
  assert.equal(/\bsource\.(ageMs|dataReason|sharedFeedWith)\b/.test(aiCode), false,
    'ai.js now reads source records, so the reason has to say so rather than go on crediting it');

  // And the census the reason defers to has to still be there. A promise with no
  // file behind it is a wish, and the reason points at a test by name.
  assert.match(sourceCensusSource, /names\.size >= 17/,
    'test/source-health-list.test.mjs no longer lifts the source names out of the producer');
  assert.match(sourceCensusSource, /every field the scanner writes on a book is read by a page/,
    'and it no longer censuses them against the card that draws them');
});

test('the catalog pins its schema version against the builder, so the marker cannot drift', async () => {
  // Exempt as a marker, not as a value. The alerts census says the same of its
  // own and pins ALERT_SCHEMA; the router, the tracker and the endpoints
  // registry pin theirs, which left this document the one marker in the tree
  // whose number a change could move with the suite green.
  //
  // The constant is read out of the builder rather than copied here: a copy
  // would be a second number to keep in step, which is the thing the pin is for.
  const builderCode = codeOnly(readFileSync(new URL('../src/scanner/market-catalog.mjs', import.meta.url), 'utf8'), true);
  const literals = [...builderCode.matchAll(/schemaVersion:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(literals, [1], `the builder writes one schemaVersion literal; this scan found ${literals.join(', ')}`);

  const cat = await realCatalog();
  assert.equal(cat.schemaVersion, literals[0], 'the document carries the version the builder writes');
  // "No page reads it and none should" is a preference, and it was this file's
  // reason until this lot measured one. The number is checked before the length,
  // because a measurement is the standard and the length is only the floor under
  // it — a long sentence with no number in it is still an opinion, and the old
  // reason was one at 68 characters.
  assert.match(UNREAD_BY_DESIGN.schemaVersion, /\d/,
    'the exemption carries a measurement, not a preference');
  assert.ok(UNREAD_BY_DESIGN.schemaVersion.length > 80,
    'and the exemption still says what was measured, rather than "none should"');
});

test('the catalog card reads only fields the builder actually writes', async () => {
  // The other direction, and the one a field list cannot give on its own. A page
  // that reaches past the document for a neighbouring field is asserting a shape
  // the route has never served: `scrapedAt` belongs to /api/scan, so a catalog
  // card dated by it would be reading a field that is always undefined and
  // falling through to something else — the exact failure the run stamp exists
  // to prevent, reintroduced one layer down.
  //
  // This invariant is also what makes the equivalent mutant catchable: a
  // `cat.builtAt || cat.scrapedAt` chain behaves identically on every document
  // the tests feed it, because none of them carries a `scrapedAt`. Removing the
  // surface is the fix; the field list alone would have left it in place.
  const cat = await realCatalog();
  const readTop = topLevelReads;
  const inventedTop = readTop.filter((f) => !CATALOG_TOP_FIELDS.includes(f));
  assert.deepEqual(inventedTop, [],
    `the cards read fields the catalog does not publish: ${inventedTop.join(', ')}`);

  const inventedRow = readsOn('m').filter((f) => !CATALOG_MARKET_FIELDS.includes(f));
  assert.deepEqual(inventedRow, [],
    `and market row fields the catalog does not publish: ${inventedRow.join(', ')}`);

  // Not vacuous: the two receivers really are read, and the control below is the
  // published document those reads are checked against.
  assert.ok(readTop.length > 0 && readsOn('m').length > 0, 'the block reads something at all');
  assert.ok(CATALOG_TOP_FIELDS.every((f) => f in cat), 'the control document really carries the top-level fields');
  assert.ok(CATALOG_MARKET_FIELDS.every((f) => f in cat.markets[0]), 'and the row fields');
  assert.equal(cat.scrapedAt, undefined, 'the catalog itself never carries the scan\'s stamp');
});

test('a market is shown by the name its book gives it, with the key kept', async () => {
  const cat = await realCatalog();
  const h = harness('en');
  h.run(`initCatalog(${JSON.stringify(cat)}, arbiterI18n.t.bind(arbiterI18n));`);

  const rows = h.node('#catalog-table tbody').innerHTML;
  // The key alone is what this cell used to render, and 70 of the 76 rows in a
  // real catalog carried a readable name that only the key hid.
  assert.match(rows, /Ambele echipe înscriu/, "the book's own name reaches the table");
  assert.match(rows, /BTSC/, 'and the key is still there — the filter searches it, and it is how a market is identified across books');
  assert.match(rows, /Rezultat Final/);
  assert.match(rows, /1x2/);
});

test('a row whose book gives no name falls back to the key, once', () => {
  const h = harness('en');
  // `marketName` is written as `m.name || m.key`, so a book that sends no name
  // yields the key — and a payload that lost the field entirely has to render.
  for (const row of [{ sourceId: 'x', marketKey: 'MATCH_ODDS' },
    { sourceId: 'x', marketKey: 'MATCH_ODDS', marketName: 'MATCH_ODDS' }]) {
    h.run(`renderCatalog([${JSON.stringify(row)}]);`);
    const cell = h.node('#catalog-table tbody').innerHTML;
    assert.equal(cell.match(/MATCH_ODDS/g).length, 1, `the key is not printed twice: ${cell}`);
  }
});

test('the filter finds a row by the name it displays', async () => {
  const cat = await realCatalog();
  const h = harness('en');
  h.run(`initCatalog(${JSON.stringify(cat)}, arbiterI18n.t.bind(arbiterI18n));`);
  const body = () => h.node('#catalog-table tbody').innerHTML;

  // The control: an unfiltered render has both books in it.
  assert.match(body(), /BTSC/);
  assert.match(body(), /1x2/);

  // The case that was broken: the name is on screen and the box ignores it, so
  // a user who reads "Ambele echipe înscriu" and types it gets nothing.
  await h.fire('#cat-search', 'input', { target: { value: 'ambele' } });
  assert.match(body(), /BTSC/, 'the visible name is searchable');
  assert.doesNotMatch(body(), /1x2/, 'and the other book is still filtered out');

  // The key, the book, and a query that matches nothing.
  await h.fire('#cat-search', 'input', { target: { value: 'btSC' } });
  assert.match(body(), /BTSC/, 'the key still matches, case-insensitively');
  await h.fire('#cat-search', 'input', { target: { value: 'betano' } });
  assert.match(body(), /BTSC/);
  assert.doesNotMatch(body(), /1x2/);
  await h.fire('#cat-search', 'input', { target: { value: 'nothing-here' } });
  assert.doesNotMatch(body(), /BTSC/, 'a query that matches nothing empties the table');
  assert.ok(body().includes(h.text('noMarkets')), 'into the empty state, not a blank body');
});

// — event coverage card —

/**
 * Rows in the shape buildMarketCatalog writes, for the tests that need more of
 * them than a real two-book catalog has.
 *
 * Shaped by hand, so the key set is asserted against the real builder's output
 * before anything is rendered: a helper that drifted into a shape no builder
 * produces would render happily and prove nothing.
 *
 * The index is padded because these rows are searched as substrings, and
 * "FCSB 7" is a prefix of "FCSB 70". An unpadded fixture made the first draft of
 * the truncation test ask for one row and get 111, which was the fixture talking
 * and not the page.
 *
 * The eventKey carries an `l1` league token rather than the league's own text,
 * which is deliberate and was not the first draft. Adapters build the key as
 * sport|league|... , so a fixture whose key spells out "Liga 1" makes every
 * league search match through the key instead, and the test cannot tell a search
 * that reads the league from one that does not. With the token kept distinct, a
 * term found by the league field can only be found by the league field.
 */
function eventRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    eventKey: `football|l1|2030-01-${String((i % 28) + 1).padStart(2, '0')}|fcsb-${i}|cfr-${i}`,
    sport: 'Football',
    league: 'Liga 1',
    kickoff: '2030-01-01T00:00:00.000Z',
    homeTeam: `FCSB ${String(i).padStart(4, '0')}`,
    awayTeam: `CFR ${String(i).padStart(4, '0')}`,
    sources: i % 2 === 0 ? ['betano', 'admiral'] : ['betano'],
    marketKeys: ['BTSC', '1x2'],
    selectionCount: 3,
  }));
}

test('the page asks for the catalog once, and feeds both cards from it', () => {
  // One fetch feeds two cards now, and the second card is the reason the first
  // one reads an 866 KB document at all. Two calls would download it twice, so
  // this is a statement about the source rather than a runtime count — init() is
  // cut short by the harness long before it reaches these calls, so a behavioural
  // count here would pass on a page that fetched twice.
  const calls = [...analyticsCode.matchAll(/arbiterApi\.get\(\s*'\/api\/catalog'/g)];
  assert.equal(calls.length, 1,
    `the page fetches /api/catalog ${calls.length} times; two cards, one document, one download`);
  assert.match(analyticsCode, /initCatalog\(catalog, t\)/, 'and the market card is fed that document');
  assert.match(analyticsCode, /initEventCoverage\(catalog, t\)/, 'and so is the event card');
});

test('an event row shows the fixture, the books and how widely it is covered', async () => {
  const cat = await realCatalog();
  // The shape check first, on the builder's own output: the row below is a real
  // catalog event, not a transcription of what the builder was believed to write.
  assert.deepEqual(Object.keys(cat.events[0]).sort(), CATALOG_EVENT_FIELDS,
    'the builder wrote a different event row than the page is tested against');

  const h = harness('en');
  h.run(`initEventCoverage(${JSON.stringify(cat)}, arbiterI18n.t.bind(arbiterI18n));`);
  const body = h.node('#event-coverage-table tbody').innerHTML;

  assert.match(body, /FCSB/, 'the home team is on screen');
  assert.match(body, /CFR/, 'and the away team');
  assert.match(body, /Liga 1/, 'the league is what the book called it');
  // Coverage, which is the whole reason this index exists: one event, two books,
  // two different markets. A one-book event is the finding, not the exception.
  assert.match(body, /betano, admiral/, 'which books quote it, by name');
  assert.match(body, /2<\/td>/, 'and how many');
  assert.equal(h.node('#event-coverage-count').textContent, '1', 'one event is on screen and the count says one');
});

test('the event search narrows by everything the row shows', async () => {
  const h = harness('en');
  const cat = { events: eventRows(6) };
  h.run(`initEventCoverage(${JSON.stringify(cat)}, arbiterI18n.t.bind(arbiterI18n));`);
  const body = () => h.node('#event-coverage-table tbody').innerHTML;

  // The control: unfiltered, every row is there. 0 through 5 is enough to see
  // and specific enough to be wrong about.
  assert.match(body(), /FCSB 0000/);
  assert.match(body(), /FCSB 0005/);

  await h.fire('#event-search', 'input', { target: { value: 'fcsb 0003' } });
  assert.match(body(), /FCSB 0003/, 'the home team is searchable');
  assert.doesNotMatch(body(), /FCSB 0004/, 'and the others are filtered out');
  assert.equal(h.node('#event-coverage-count').textContent, '1 / 6', 'the count says one of six');

  await h.fire('#event-search', 'input', { target: { value: 'liga' } });
  assert.match(body(), /FCSB 0005/, 'the league is searchable too — it is on the row, so the box reads it');
  assert.equal(h.node('#event-coverage-count').textContent, '6', 'all six answer it and all six fit, so the count is the total');

  // And the eventKey, which is the string the scanner buckets by, so it is what
  // a report quoting an event will carry.
  await h.fire('#event-search', 'input', { target: { value: 'cfr-2' } });
  assert.match(body(), /FCSB 0002/);
  assert.doesNotMatch(body(), /FCSB 0000/);
});

test('a list longer than the cap says it is longer', async () => {
  // 2 770 rows on a real capture and 200 on screen is a truncation, and a list
  // that does not say so is a list that lies about its own completeness.
  const h = harness('en');
  h.run(`initEventCoverage(${JSON.stringify({ events: eventRows(2770) })}, arbiterI18n.t.bind(arbiterI18n));`);

  assert.equal(h.node('#event-coverage-count').textContent, '200 / 2,770',
    'unfiltered, the count says the screen holds 200 of 2 770 — not "2,770", which is what the table does not show');
  assert.equal((h.node('#event-coverage-table tbody').innerHTML.match(/<tr>/g) || []).length, 200,
    'and the table holds the cap');

  // The case the cap hides best: a query that matches every single row. The
  // result is still 2 770 and the screen is still 200, so a count keyed on
  // "did the filter change anything" would read as the whole set here.
  await h.fire('#event-search', 'input', { target: { value: 'liga' } });
  assert.equal(h.node('#event-coverage-count').textContent, '200 / 2,770',
    'a query matching all 2 770 rows still says how many are drawn');

  // And narrowed under the cap, where the two numbers mean something different:
  // now everything that matched is on screen.
  await h.fire('#event-search', 'input', { target: { value: 'fcsb 0007' } });
  assert.equal(h.node('#event-coverage-count').textContent, '1 / 2,770',
    'one match out of the whole document says one of 2 770');
  assert.equal((h.node('#event-coverage-table tbody').innerHTML.match(/<tr>/g) || []).length, 1);
});

test('no catalog and no match are different empty states', async () => {
  // A harness per case, not one harness for both: `addEventListener` is a
  // no-op stub here, so a second init on the same context stacks a second
  // handler on the same input and the first fire() throws rather than testing
  // anything about the page.
  const empty = harness('en');
  empty.run(`initEventCoverage(${JSON.stringify({})}, arbiterI18n.t.bind(arbiterI18n));`);
  const noCatalog = empty.node('#event-coverage-table tbody').innerHTML;
  assert.ok(noCatalog.includes(empty.text('noEvents')), 'a catalog that was never built says so');
  assert.match(noCatalog, /scrape\.html/, 'and offers the scrape that would build one');

  const filtered = harness('en');
  filtered.run(`initEventCoverage(${JSON.stringify({ events: eventRows(3) })}, arbiterI18n.t.bind(arbiterI18n));`);
  await filtered.fire('#event-search', 'input', { target: { value: 'nothing-here' } });
  const noMatch = filtered.node('#event-coverage-table tbody').innerHTML;
  assert.ok(noMatch.includes(filtered.text('noEventsFound')), 'a filter that matches nothing says that instead');
  assert.doesNotMatch(noMatch, /scrape\.html/,
    'and does not offer a scrape — the catalog exists, the query is what found nothing');
});

test('a team name is text on the event rows, like every other name on the page', async () => {
  const h = harness('en');
  const rows = eventRows(1).map((r) => ({
    ...r, homeTeam: '<img src=x onerror=boom>', awayTeam: '<script>boom()</script>',
  }));
  h.run(`initEventCoverage(${JSON.stringify({ events: rows })}, arbiterI18n.t.bind(arbiterI18n));`);
  const body = h.node('#event-coverage-table tbody').innerHTML;

  assert.match(body, /&lt;img src=x onerror=boom&gt;/, 'the name is escaped text');
  assert.doesNotMatch(body, /<img/, 'no element was created from it');
  assert.doesNotMatch(body, /<script>/, 'and no script either');

  // Escaping must not cost the row its searchability, or the fix would have
  // traded a rendering bug for a filter that silently skips hostile-looking rows.
  await h.fire('#event-search', 'input', { target: { value: 'onerror=boom' } });
  const found = h.node('#event-coverage-table tbody').innerHTML;
  assert.match(found, /&lt;img src=x onerror=boom&gt;/, 'and it is still findable by the text it shows');
  assert.equal(h.node('#event-coverage-count').textContent, '1', 'as one matching row');
});

// Two runs an hour and two days apart. The catalog is a stored artifact rebuilt
// only by a scrape; the four KPI cards above the catalog are read from the live
// scan. In a real data directory those were two days apart and both rendered as
// plain fact, because `builtAt` and `scrapeRunId` were published for exactly
// this and read by nobody.
const CAT_BUILT = '2026-09-28T18:40:00.000Z';
const SCAN_AT = '2026-09-30T10:00:00.000Z';
const RUN_ID = 'scrape-2026-09-28T18-53-05-091Z';

test('the card names the run that built the catalog', () => {
  const h = harness('en');
  h.run(`initCatalog(${JSON.stringify({ builtAt: CAT_BUILT, scrapeRunId: RUN_ID, markets: [] })}, arbiterI18n.t.bind(arbiterI18n));`);
  const stamp = h.node('#catalog-run').textContent;
  assert.ok(stamp.includes(new Date(CAT_BUILT).toLocaleString()),
    `the build time is on screen, got: ${stamp}`);
  assert.ok(stamp.includes(RUN_ID), `and the run it came from, got: ${stamp}`);
});

test('the stamp follows the catalog, and ignores the scan rendered above it', () => {
  const h = harness('en');
  const at = (doc) => {
    h.run(`initCatalog(${JSON.stringify(doc)}, arbiterI18n.t.bind(arbiterI18n));`);
    return h.node('#catalog-run').textContent;
  };
  const LATER = '2026-09-29T06:15:00.000Z';

  // Both stamps are present in the document, so the assertion is about which one
  // the card chose. A page that read `scrapedAt` — the scan's own field, and one
  // the catalog has never carried — would print SCAN_AT here.
  const first = at({ builtAt: CAT_BUILT, scrapeRunId: RUN_ID, scrapedAt: SCAN_AT, markets: [] });
  assert.equal(first.includes(new Date(SCAN_AT).toLocaleString()), false,
    'the card is not dated by the scan beside it');

  // Positive control: move the catalog's own build time, the stamp must follow.
  const second = at({ builtAt: LATER, scrapeRunId: RUN_ID, scrapedAt: SCAN_AT, markets: [] });
  assert.notEqual(first, second, 'and it does follow the run that built it');
  assert.ok(second.includes(new Date(LATER).toLocaleString()), `got: ${second}`);

  // Negative control: move only the scan's stamp, the card must not notice.
  const third = at({ builtAt: LATER, scrapeRunId: RUN_ID, scrapedAt: '2026-10-05T22:00:00.000Z', markets: [] });
  assert.equal(second, third, 'a change in the scan leaves the catalog card alone');
});

test("a catalog that was never built says so, in the page's language", () => {
  // The route answers `{}` when there is nothing on disk, and a catalog document
  // from before the stamp existed has markets but no builtAt. Both are "not
  // built", and neither may print a date.
  for (const lang of ['ro', 'en']) {
    const h = harness(lang);
    for (const doc of [{}, { markets: [] }, { builtAt: 'not a date', markets: [] }, { builtAt: null }]) {
      h.run(`initCatalog(${JSON.stringify(doc)}, arbiterI18n.t.bind(arbiterI18n));`);
      const stamp = h.node('#catalog-run').textContent;
      assert.equal(stamp, h.text('neverRan'), `${lang}: ${JSON.stringify(doc)}`);
      assert.doesNotMatch(stamp, /\d{4}/, `${lang}: no invented date for ${JSON.stringify(doc)}`);
    }
  }
  assert.notEqual(harness('ro').text('neverRan'), harness('en').text('neverRan'),
    'and it is a translation, not one English string on a Romanian page');
});

test('the run stamp has an element, and the page is its only writer', () => {
  // The markup is half the wiring. The stamp must NOT carry data-i18n: i18n.apply()
  // runs on DOMContentLoaded and on every language switch and would overwrite the
  // run with whatever the dictionary holds — the defect the two spans in the h3
  // exist to avoid.
  assert.match(analyticsHtml, /id="catalog-run"/, 'the card has somewhere to write the run');
  const el = analyticsHtml.match(/<span[^>]*id="catalog-run"[^>]*>/);
  assert.ok(el, 'the stamp exists in the markup');
  assert.ok(!el[0].includes('data-i18n'), 'the page is the only writer of the stamp');
  const meta = analyticsHtml.match(/<span class="h3-meta"><span data-i18n="discoveredMarkets"/);
  assert.ok(meta, 'the translated label and the dynamic stamp are siblings, not the same element');
});

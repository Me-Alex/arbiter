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
import vm from 'node:vm';

const analyticsSource = readFileSync(new URL('../public/js/pages/analytics.js', import.meta.url), 'utf8');
const commonSource = readFileSync(new URL('../public/js/pages/common.js', import.meta.url), 'utf8');
const i18nSource = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../src/tracker-service.mjs', import.meta.url), 'utf8');
const analyticsHtml = readFileSync(new URL('../public/admin/analytics.html', import.meta.url), 'utf8');

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
  const body = serviceSource.slice(
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
  const missing = EXPECTED_BET_FIELDS.filter((field) => !(field in EXEMPT) && !analyticsSource.includes(`b.${field}`));
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

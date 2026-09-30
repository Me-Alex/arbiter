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

/**
 * The page's catalog unit, so `cat.` and `m.` mean one thing inside it.
 *
 * The harness cuts at the same marker, so this is the text the tests below are
 * actually about.
 */
const CATALOG_BLOCK = (() => {
  const from = analyticsSource.indexOf('// — market catalog —');
  const to = analyticsSource.indexOf('// — add-bet modal —');
  assert.ok(from !== -1 && to > from, 'the catalog block is gone — has the page been restructured?');
  return analyticsSource.slice(from, to);
})();

/** Every `<receiver>.<field>` the block reads, for a given receiver name. */
const readsOn = (receiver) => [...new Set([...CATALOG_BLOCK.matchAll(new RegExp(`\\b${receiver}\\.(\\w+)`, 'g'))].map((m) => m[1]))];

/**
 * Published by the catalog, read by no page, with the reason it is allowed.
 *
 * When a name is removed from here the test says why it stopped being allowed,
 * and if the reason was the code's own docstring, the docstring is in the test.
 */
const UNREAD_BY_DESIGN = {
  events: [
    'The event index: 845 KB of 866 KB in a real capture, 2 770 rows, and no page reads it.',
    'It is a coverage census of every event x book, not a signal list, so it is not the',
    '`middles` the scanner already shows. buildMarketCatalog promises it is "Browsable from',
    '/admin/analytics#catalog" and only the markets half of that promise was ever built.',
    "Shipping a UI nobody asked for is not this lot's call — so it stays published,",
    'unread, and named here. Deleting the docstring sentence above is what makes this fail.',
  ].join(' '),
  sources: [
    'A verbatim copy of scan.sources, which /api/scan already delivers to the same page',
    'and which dashboard.js and ai.js already read. Its field list belongs to the scan,',
    'not to this builder, so it is exempt as a collection and checked where the scan is',
    'rendered instead.',
  ].join(' '),
  schemaVersion: 'A version marker for the stored file. No page reads it and none should.',
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
    .filter((f) => !(f in UNREAD_BY_DESIGN) && !readsOn('cat').includes(f));
  assert.deepEqual(unreadTop, [], `the page never reads these: ${unreadTop.join(', ')}`);

  const unreadMarkets = CATALOG_MARKET_FIELDS.filter((f) => !readsOn('m').includes(f));
  assert.deepEqual(unreadMarkets, [], `the page never reads these off a row: ${unreadMarkets.join(', ')}`);
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
  const readTop = readsOn('cat');
  const inventedTop = readTop.filter((f) => !CATALOG_TOP_FIELDS.includes(f));
  assert.deepEqual(inventedTop, [],
    `the card reads fields the catalog does not publish: ${inventedTop.join(', ')}`);

  const inventedRow = readsOn('m').filter((f) => !CATALOG_MARKET_FIELDS.includes(f));
  assert.deepEqual(inventedRow, [],
    `and row fields the catalog does not publish: ${inventedRow.join(', ')}`);

  // Not vacuous: the two receivers really are read, and the control below is the
  // published document those reads are checked against.
  assert.ok(readTop.length > 0 && readsOn('m').length > 0, 'the block reads something at all');
  assert.ok(CATALOG_TOP_FIELDS.every((f) => f in cat), 'the control document really carries the top-level fields');
  assert.ok(CATALOG_MARKET_FIELDS.every((f) => f in cat.markets[0]), 'and the row fields');
  assert.equal(cat.scrapedAt, undefined, 'the catalog itself never carries the scan\'s stamp');
});

test('the card never reaches for the event index or the copied source list', () => {
  // Both are on the exempt list above, which is a statement about today, not a
  // licence: reading either is how a 845 KB download starts arriving by accident.
  for (const field of ['events', 'sources', 'schemaVersion']) {
    assert.equal(readsOn('cat').includes(field), false,
      `the card reads cat.${field}; remove it from UNREAD_BY_DESIGN and say why in the same commit`);
  }
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

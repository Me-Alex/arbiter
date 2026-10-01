/**
 * scrape-page.test.mjs — the scrape page's two readouts over a backend payload.
 *
 * `/api/scrapers` hands the page 19 fields per job and the chip rendered four.
 * `/api/scheduler` returns eight and the readout rendered four, one of them
 * wrongly. Both are the same defect: a field the backend sends, a field the
 * page drops, and no way for the reader to notice. What the page deliberately
 * leaves out is pinned too — a test that cannot fail measures nothing, and a
 * comment saying "we left feedStatus out on purpose" is not a test.
 *
 * The page is loaded the way the other frontend tests load it: the real
 * source, the real escaper from common.js and the real dictionary, cut
 * before the first line that binds an event listener. Nothing rendered here is
 * re-implemented in the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const scrapeSource = readFileSync(new URL('../public/js/pages/scrape.js', import.meta.url), 'utf8');
const commonSource = readFileSync(new URL('../public/js/pages/common.js', import.meta.url), 'utf8');
const i18nSource = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
const formatSource = readFileSync(new URL('../public/js/format.js', import.meta.url), 'utf8');

/** Each language's own table, taken out of the loaded dictionary. See dictionaries(). */
const TABLES = {};

/** The real dictionary, per language, loaded the way the page loads it. */
function dictionaries() {
  const out = {};
  // `t()` answers `(dict[lang] && dict[lang][key]) || (dict.en[key]) || key`, so
  // asking it whether a key exists in Romanian passes just as happily when the
  // Romanian string is gone and the English one answers. The fallback is right
  // for a reader and the wrong oracle for the "exists in both languages" checks
  // below, so the table is read directly — the IIFE is opened at the tail,
  // because it is the only way to reach a const the module does not export.
  const tail = '})();';
  const at = i18nSource.lastIndexOf(tail);
  assert.notEqual(at, -1, 'i18n.js must still end in an IIFE call — reading the table hangs on it');
  const opened = `${i18nSource.slice(0, at)}  globalThis.arbiterTables = dict;\n${i18nSource.slice(at)}`;
  for (const lang of ['ro', 'en']) {
    const context = vm.createContext({
      document: { addEventListener() {}, documentElement: {}, querySelectorAll: () => [] },
      // i18n.js reads the language once at load; feeding it here is closer to
      // how the page starts than calling setLang() after the fact, which would
      // also drag in apply() and its DOM sweep.
      localStorage: { getItem: (k) => (k === 'arbiter.lang' ? lang : null), setItem() {} },
      console,
    });
    context.window = context;
    vm.runInContext(opened, context);
    assert.equal(context.arbiterI18n.lang, lang, 'the dictionary really loaded in the language under test');
    assert.ok(context.arbiterTables && context.arbiterTables[lang],
      `the ${lang} table came out of the module — the key checks read it`);
    TABLES[lang] = context.arbiterTables[lang];
    out[lang] = context.arbiterI18n;
  }
  return out;
}
const DICTS = dictionaries();

/**
 * "This key exists in this language" — asked of that language's own table.
 *
 * `t()` falls back to English, so `t(key) !== key` is satisfied by the *other*
 * language answering: a deleted Romanian string would have left every "exists
 * in both languages" test in this file green, with English text quietly printed
 * and nothing reported. A table check cannot be satisfied that way. The second
 * assertion is the wiring the first one cannot see — the page's own lookup has
 * to hand back this language's string, not fall through to the other one.
 */
function assertTranslated(lang, key) {
  const own = TABLES[lang][key];
  assert.equal(typeof own, 'string',
    `${lang} is missing ${key} — t() would answer in ${lang === 'ro' ? 'English' : 'Romanian'} instead`);
  assert.ok(own.trim().length > 0, `${lang} has an empty string for ${key}`);
  assert.equal(DICTS[lang].t(key), own, `${lang} reads ${key} in its own words, not the fallback`);
}

/** The markup's own id set, so a missing element is a failure, not a silent pass. */
const scrapeHtml = readFileSync(new URL('../public/admin/scrape.html', import.meta.url), 'utf8');
const PAGE_IDS = new Set([...scrapeHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** Every class token the markup really carries, for the same job as PAGE_IDS. */
const CLASS_TOKENS = new Set(
  [...scrapeHtml.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
);

/**
 * The controls the markup really gives to a <select>, read out of the markup
 * for the same reason PAGE_IDS is: a hand-written list would keep asserting
 * select behaviour after the control stopped being a select.
 */
const SELECT_IDS = new Set(
  [...scrapeHtml.matchAll(/<select\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]),
);

function harness(lang = 'ro', { api, form } = {}) {
  const nodes = new Map();
  const make = (id) => {
    const stub = {
      id,
      innerHTML: '',
      value: '',
      checked: false,
      dataset: {},
      hidden: false,
      className: '',
      attrs: {},
      // The DOM stringifies attribute values, and the page passes a number here.
      // Storing it raw would make the stub disagree with the browser about
      // what it reads back.
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
      // `title` is an attribute, so the property and the attribute have to be two
      // views of one thing rather than two unrelated fields. `applyProfileHint`
      // writes `sel.title = …` on one path and `removeAttribute` on the other, and
      // a stub where those are independent would let a page clear a stale hint and
      // still appear to have one — or the reverse, with no way to tell which.
      get title() { return this.attrs.title || ''; },
      set title(value) { this.attrs.title = String(value); },
      appendChild() {},
      // The page toggles classes on real elements (the progress card hides
      // itself when no run is in flight). A stub without this threw on the
      // first classList use, which had been keeping renderState out of this
      // file entirely.
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      // Same story for inline styles: the progress bar writes `style.right`
      // and the ring writes `style.setProperty('--p', pct)`.
      style: { setProperty() {} },
      querySelectorAll: () => [],
      // Nothing is parsed, so a node's own descendants do not resolve. null is
      // the honest answer and the page guards every one of these.
      querySelector: () => null,
      // The form the page reads its scan options out of. Seeded from the
      // fixture rather than left blank, because `currentScanOptions()`
      // coerces with Number() and an all-empty form would compare equal to a
      // stored object of zeroes — a diff that can never fire.
      ...(form && form[id] ? form[id] : {}),
    };
    if (SELECT_IDS.has(id)) {
      // A <select> does not keep a value across a rewrite of its options:
      // writing innerHTML destroys the option children, and the value then
      // falls to the option carrying `selected`, or to the first one when none
      // does (HTML "ask for a reset" on the selectedness setter).
      //
      // This was the one behaviour the stub was missing, and its absence made
      // a test unable to fail: `renderPriceBookOptions` restores the operator's
      // book by assigning `sel.value` after the rewrite, and on a plain object
      // — where nothing ever loses a value — that assignment is unobservable,
      // so deleting it from the page left the assertion green.
      let html = '';
      Object.defineProperty(stub, 'innerHTML', {
        get: () => html,
        set(markup) {
          html = String(markup);
          const options = [...html.matchAll(/<option\b[^>]*>/g)].map((m) => m[0]).map((tag) => ({
            // The browser reads the decoded attribute; ids in this markup are
            // plain slugs, so the raw text is the decoded text.
            value: (tag.match(/\bvalue="([^"]*)"/) || [null, ''])[1],
            selected: /\bselected\b/.test(tag),
          }));
          const picked = options.find((o) => o.selected) || options[0];
          stub.value = picked ? picked.value : '';
        },
        enumerable: true,
        configurable: true,
      });
    }
    return stub;
  };
  const node = (id) => {
    if (!PAGE_IDS.has(id)) throw new Error(`scrape.html has no #${id} — the page and this test have drifted`);
    if (!nodes.has(id)) nodes.set(id, make(id));
    return nodes.get(id);
  };
  /** A node reached by selector rather than by id: memoised under the selector. */
  const selNode = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, make(selector));
    return nodes.get(selector);
  };
  const document = {
    getElementById: node,
    createElement: () => ({ className: '', appendChild() {} }),
    // After writing the chips the page re-queries them to attach the filter
    // handler. Nothing is parsed here, so an empty list is the honest answer:
    // the assertions are on the markup this function produced, which is
    // captured on `bookmaker-list` before any of this runs.
    querySelectorAll: () => [],
    // refreshLastRun writes into the table body by selector rather than by id,
    // so the seam has to resolve one. The id is checked against scrape.html,
    // which is what keeps a selector pointing at a removed element from
    // quietly returning a fresh empty node and passing.
    querySelector: (selector) => {
      const sel = String(selector);
      if (sel.startsWith('#')) return node(sel.slice(1));
      // A class selector is checked the same way, by class token rather than by
      // id: the markup's tokens are the ids for this purpose. This is not
      // defensive scaffolding — `updateProgressCard` asks for
      // `.progress[role="progressbar"]`, a class the markup does not have, and
      // the `if (progressEl)` around the write hid it. A seam that hands back a
      // node for a selector matching nothing cannot fail any assertion made
      // against it, so it would have kept passing forever.
      for (const [, cls] of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
        if (!CLASS_TOKENS.has(cls)) {
          throw new Error(`scrape.html has no element with class "${cls}" — "${sel}" matches nothing`);
        }
      }
      return selNode(sel);
    },
  };
  const context = vm.createContext({
    document,
    console,
    localStorage: { getItem: () => null, setItem() {} },
    // renderState flashes the KPI cards through setTimeout on every update
    // after the first. Stubbed to a no-op: nothing in this file asserts on the
    // flash, and a real timer would keep the test process alive.
    setTimeout() {},
    // countUp animates a KPI toward its target unless the reader has asked for
    // reduced motion, in which case it writes the value outright. Taking that
    // path keeps every number in these tests the real target rather than
    // whatever point of a 450ms animation the test happened to interrupt.
    matchMedia: (query) => ({ matches: /prefers-reduced-motion/.test(query), media: query }),
    // The real api.js is an IIFE over fetch; only the scheduler readouts are
    // under test, so the seam is the one global it installs.
    ...(api ? { arbiterApi: api } : {}),
    // A browser global the price board builds its query with. This context is
    // not a browser, so it has to be handed over explicitly — the alternative
    // would be a page that builds URLs by hand for the sake of being testable.
    URLSearchParams,
  });
  context.window = context;
  // The real escaper, cut to its own definition so common.js's DOM wiring does
  // not have to be faked. Line-based on purpose: the function body contains a
  // `};` of its own on the `entities` object, so an indexOf for the terminator
  // stops in the middle and yields a file that does not parse.
  const escaperLines = commonSource.split('\n');
  const escaperStart = escaperLines.findIndex((line) => line.includes('window.escapeHtml = function'));
  assert.ok(escaperStart !== -1, 'common.js must still define window.escapeHtml');
  const escaperEnd = escaperLines.findIndex((line, i) => i > escaperStart && line.trim() === '};');
  assert.ok(escaperEnd !== -1, 'the escaper definition was not closed by a lone }; — has its shape changed?');
  vm.runInContext(escaperLines.slice(escaperStart, escaperEnd + 1).join('\n'), context);
  assert.equal(typeof context.escapeHtml, 'function', 'the real escaper is what the page will call');
  context.arbiterI18n = DICTS[lang];
  // The real shared formatter, whole, because the price board renders odds
  // through it and a stub would make "1.95" and "1.95" indistinguishable from a
  // page that formats odds its own way. scrape.html now loads format.js for
  // this; loading it here keeps the two in step rather than trusting the
  // markup to keep telling the truth.
  vm.runInContext(formatSource, context);
  assert.equal(typeof context.arbiterFormat.fmtOdds, 'function', 'the real formatter is what the page will call');
  vm.runInContext(scrapeSource.slice(0, scrapeSource.indexOf("$('run-btn').addEventListener")), context);
  return {
    nodes,
    run: (code) => vm.runInContext(code, context),
    list: () => nodes.get('bookmaker-list').innerHTML,
    /** The node a selector resolved to, for assertions on a selector write. */
    sel: (selector) => nodes.get(selector),
  };
}

/** One job, with only the fields the test cares about spelled out. */
const job = (over = {}) => ({
  id: 'favbet',
  name: 'Favbet',
  enabled: true,
  validationStatus: 'validated',
  validationReason: 'Public JSON feed smoke-validated on 2026-09-01.',
  endpointVerifiedAt: '2026-09-01',
  feedStatus: 'verified',
  ...over,
});

const render = (h, jobs, { validated = ['favbet'], selected = [] } = {}) => {
  h.run(`scrapers = ${JSON.stringify(jobs)}; validatedIds = new Set(${JSON.stringify(validated)}); jobById = new Map(); selectedIds = new Set(${JSON.stringify(selected)}); renderBookmakerChips()`);
  return h.list();
};

const titleOf = (html, id) => {
  const label = html.split('<label').find((chunk) => chunk.includes(`value="${id}"`));
  assert.ok(label, `no chip rendered for ${id}`);
  return label.match(/title="([^"]*)"/)[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
};

test('the chip carries the date the endpoint was last verified', () => {
  const h = harness();
  const html = render(h, [job()]);
  const title = titleOf(html, 'favbet');
  assert.match(title, /2026-09-01/, 'the verification date reaches the chip');
  assert.match(title, /Public JSON feed smoke-validated/, 'and the reason it was accepted is still there');

  // The control: a book with no date at all must still render a tooltip, and
  // must not get a stray "undefined" or a dangling separator. 25 of 26 jobs
  // carry the field, so the missing case is the common one for a new book.
  const undated = titleOf(render(h, [job({ endpointVerifiedAt: undefined })]), 'favbet');
  assert.equal(undated, 'Public JSON feed smoke-validated on 2026-09-01.', 'no date, no second line, no dangling text');
  assert.doesNotMatch(undated, /undefined|null|NaN/, 'and nothing undefined leaks into the attribute');
});

test('the date is the one the job carries, not a constant', () => {
  const h = harness();
  // The reason this field earns a line: 22 of the 26 jobs read 2026-09-01 and
  // four were re-checked a month later. A tooltip that printed one fixed date
  // would be worse than none, because it would look like a per-book fact.
  const older = titleOf(render(h, [job({ endpointVerifiedAt: '2026-09-01' })]), 'favbet');
  const newer = titleOf(render(h, [job({ id: 'unibet', endpointVerifiedAt: '2026-09-28' })]), 'unibet');
  assert.match(older, /2026-09-01/);
  assert.match(newer, /2026-09-28/);
  assert.notEqual(older, newer, 'two books verified weeks apart must not read identically');
});

/**
 * The per-book live capability: which of these 26 books can quote an in-play
 * price at all, on which provider field, and whether anyone ever looked.
 *
 * The answer existed for every book and reached nothing. LIVE_EVIDENCE carries a
 * measured verdict for 24 of the 26 registered jobs, 11 adapters already spread
 * it into a `coverage` object, and that object only ever became a log string —
 * so the page drawing this very list could not tell a trader which books are
 * part of a live trade at all. GET /api/scrapers now carries it per job.
 *
 * The measured shape over the real registry: 5 books can publish in-play
 * (fortuna and casa-pariurilor off `market.kind`, unibet off `contest.status`,
 * superbet and winner off their own live clock), 19 were measured and have no
 * such field, and 2 — prowin and ultrabet, both disabled experiments — were
 * never collected at all. That last group is the one worth testing hardest: it
 * shares `live: false` with the 19, and only `measured` separates a property of
 * the feed from a gap in our own work.
 */

/** A live capability exactly as the route publishes it. */
const liveCap = (over = {}) => ({ measured: true, live: true, scope: 'event', field: 'contest.status === "InPlay"', started: 13, ...over });
const noField = (over = {}) => liveCap({ live: false, scope: null, field: null, started: 0, ...over });
const neverMeasured = () => ({ measured: false, live: false, scope: null, field: null, started: 0 });

const markerOf = (html, id) => {
  const label = html.split('<label').find((chunk) => chunk.includes(`value="${id}"`));
  assert.ok(label, `no chip rendered for ${id}`);
  const m = /<span class="muted live-cap">([^<]*)<\/span>/.exec(label);
  return m ? m[1] : null;
};

test('a book that can go live says which field proved it', () => {
  const h = harness('en');
  const html = render(h, [
    job({ id: 'unibet', name: 'Unibet', liveCapability: liveCap() }),
    job({ id: 'fortuna', name: 'Fortuna', liveCapability: liveCap({ scope: 'market', field: 'market.kind === "LIVE"', started: 14 }) }),
  ]);

  // The point of the whole line: the operator can see WHICH field of WHICH
  // provider answered, so "this book goes live" is checkable rather than a claim.
  const unibet = titleOf(html, 'unibet');
  assert.match(unibet, /contest\.status === "InPlay"/, 'the measured field is on the chip');
  assert.match(unibet, /signalled per event/, 'and so is where the provider puts the signal');

  const fortuna = titleOf(html, 'fortuna');
  assert.match(fortuna, /market\.kind === "LIVE"/);
  assert.match(fortuna, /signalled per market/, 'a per-market feed is not described as per-event');

  // Two books, two different answers. A line that printed one constant for
  // every book would pass a test that only checked that "live" appears.
  assert.notEqual(unibet, fortuna, 'two books must not read identically');

  assert.equal(markerOf(html, 'unibet'), 'live', 'a book that can go live is marked on the chip');
  assert.equal(markerOf(html, 'fortuna'), 'live', 'and so is the other one — the marker is not a one-off');
});

test('the window count is reported, and a zero is not a contradiction', () => {
  const h = harness('en');
  // Two of the five capable books measured 0 — superbet and winner published
  // 1133 future fixtures and no started one in that hour. The evidence file is
  // explicit that a zero is a fact about the window, not about the feed, so
  // "can go live" and "0 in-play events" must not be rendered as a clash.
  const html = render(h, [
    job({ id: 'fortuna', liveCapability: liveCap({ scope: 'market', field: 'market.kind === "LIVE"', started: 14 }) }),
    job({ id: 'superbet', liveCapability: liveCap({ scope: 'event', field: 'inplay_stats_metadata.status', started: 0 }) }),
  ]);
  assert.match(titleOf(html, 'fortuna'), /14 in-play events in the measurement window/, 'a book that did start in-play reports the number');
  assert.match(titleOf(html, 'superbet'), /no in-play event in the measurement window/, 'a book measured at zero reports the zero in words');
  assert.doesNotMatch(titleOf(html, 'superbet'), /0 in-play events/, 'a zero is spelled, not printed as a count');
  // Both are still marked capable — the marker is the capability, not the count.
  assert.equal(markerOf(html, 'fortuna'), 'live', 'the marker follows the capability, not the count');
  assert.equal(markerOf(html, 'superbet'), 'live', 'and a zero window does not cost the book its marker');
});

test('a book that cannot go live is not marked, and is told why', () => {
  const h = harness('en');
  const html = render(h, [job({ id: 'favbet', liveCapability: noField() })]);
  assert.equal(markerOf(html, 'favbet'), null, 'a book with no in-play field carries no live marker');
  assert.match(titleOf(html, 'favbet'), /no in-play field measured in this feed/, 'and it is told the feed was measured and the field was not found');
});

test('never measured is a different sentence from measured and found nothing', () => {
  // The distinction the whole `measured` flag exists for. Both books answer
  // `live: false`, and collapsing them would tell an operator that a disabled
  // experiment we have never collected has the same feed property as a book we
  // downloaded and searched.
  const h = harness('en');
  const html = render(h, [
    job({ id: 'favbet', liveCapability: noField() }),
    job({ id: 'prowin', validationStatus: 'experimental', liveCapability: neverMeasured() }),
  ]);
  const measured = titleOf(html, 'favbet');
  const unmeasured = titleOf(html, 'prowin');
  assert.match(measured, /no in-play field measured in this feed/);
  assert.match(unmeasured, /in-play feed never measured/);
  assert.notEqual(measured, unmeasured, 'the two must not read the same');
});

test('the live evidence line is translated, like the rest of the tooltip', () => {
  // All three branches, not just the capable one. The two sentences that answer
  // "we looked and there was nothing" and "nobody ever looked" are the ones a
  // Romanian operator would read most often — 19 of 26 books get the first — and
  // they are also the ones a hardcoded English string would sit in unnoticed.
  const books = [
    job({ id: 'unibet', liveCapability: liveCap() }),
    job({ id: 'favbet', liveCapability: noField() }),
    job({ id: 'prowin', validationStatus: 'experimental', liveCapability: neverMeasured() }),
  ];
  const ro = render(harness('ro'), books);
  const en = render(harness('en'), books);
  for (const id of ['unibet', 'favbet', 'prowin']) {
    assert.notEqual(titleOf(ro, id), titleOf(en, id), `the ${id} chip must not read as the English one`);
  }
  assert.doesNotMatch(ro, /signalled per|In-play feed|measurement window|measured in this feed/, 'no English leaked into Romanian');
  assert.doesNotMatch(en, /semnal pe|fereastra|niciun|nem[ăa]surat|Feed live/, 'nor Romanian into English');
  // The provider's own field name is data, not copy, so it survives translation.
  assert.match(titleOf(ro, 'unibet'), /contest\.status/);
});

test('a provider field cannot break out of the chip tooltip', () => {
  const h = harness('en');
  const hostile = 'x" onmouseover="boom';
  const html = render(h, [job({ id: 'evil', liveCapability: liveCap({ field: hostile }) })]);
  const label = html.split('<label').find((c) => c.includes('value="evil"'));
  const attr = label.match(/title="([^"]*)"/)[1];
  // The entity is the evidence, not a search for the payload: a reader that
  // stops at the first quote cannot see the breakout. With the escaper gone it
  // would return `...· x`, every "is onmouseover inside the title?" check would
  // pass on a label that really does carry the attribute, and the injection
  // would only show up in a browser. `&quot;` can be in the attribute value
  // only if the quote was escaped, and an escaped quote cannot end it.
  assert.match(attr, /&quot;/, 'the field is escaped inside the attribute');
  assert.match(titleOf(html, 'evil'), /x" onmouseover="boom/, 'and it still reads back as the text it was');
});

test('a payload with no liveCapability renders exactly what it did before', () => {
  // The route gained a field; an older or stubbed payload must not gain a line,
  // a marker, or a stray "undefined" — the same contract the endpointVerifiedAt
  // test pins for the line above it.
  const h = harness('en');
  const html = render(h, [job({ id: 'favbet' })]);
  assert.equal(markerOf(html, 'favbet'), null);
  // Spelled from the dictionary rather than typed here, so the claim is "the two
  // lines that were already there and nothing else" and not a string I can get
  // wrong by hand.
  assert.equal(
    titleOf(html, 'favbet'),
    `Public JSON feed smoke-validated on 2026-09-01.\n${DICTS.en.t('endpointVerified')}: 2026-09-01`,
    'the tooltip is byte-for-byte the one this page produced before the route gained a field',
  );
  assert.doesNotMatch(html, /undefined|null|NaN/, 'nothing undefined leaks into the attribute');
});

/* ── The adapter behind a book ────────────────────────────────────────────────
 * GET /api/scrapers publishes a job's `engine`, `script`, `fullMarkets`,
 * `detailLimit` and `minEvents`, and before this block no page read any of the
 * five. The values used below are transcribed from config/scrapers.json, which
 * is the document the route serves verbatim — so if the config changes shape the
 * expectations here are the ones that have to be re-measured, and they say so.
 */

test('the chip names the adapter that collects the book', () => {
  const h = harness('en');
  const html = render(h, [job({ engine: 'exelogic-xsport', script: 'excelbet.mjs' })]);
  const title = titleOf(html, 'favbet');
  assert.match(title, /exelogic-xsport/, 'the integration family reaches the chip');
  assert.match(title, /excelbet\.mjs/, 'and the file underneath it');
  // Both halves on one line, not two: the tooltip is three lines already and a
  // 26-item list pays for its density. The separator is the one the rest of the
  // page uses to join a compound value, so the assertion is on that too.
  assert.match(title, new RegExp(`${DICTS.en.t('feedAdapter')}: exelogic-xsport · excelbet\\.mjs`),
    'the two halves read as one labelled value');
});

test('the adapter line is the book\'s own, and script is the finer grain', () => {
  const h = harness('en');
  // Measured on config/scrapers.json: excelbet, winboss, las-vegas and magnumbet
  // all run on the `exalogic-xsport` engine, behind four different adapter
  // files. Printing the engine alone would call those four books the same book,
  // which is the failure this line exists to avoid.
  const four = ['excelbet', 'winboss', 'las-vegas', 'magnumbet'];
  const titles = four.map((id, i) => titleOf(render(h, [job({
    id,
    engine: 'exalogic-xsport',
    script: `${id}.mjs`,
    name: id,
  })]), id));
  const engines = new Set(titles.map((t) => /exalogic-xsport/.test(t)));
  assert.equal(engines.size, 1, 'all four really do share one engine — the control');
  assert.equal(new Set(titles).size, 4, 'and each must still be distinguishable from the others');
  assert.notEqual(titles[0], titles[1], 'two books behind one engine are not the same book');
});

test('deep mode says what it costs, and only on the books that pay it', () => {
  const h = harness('en');
  // Both jobs that set `fullMarkets` spend one detail request per event and cap
  // it; the other 24 never make the second request, so for them the line would
  // be a claim about a cost they do not have.
  const deep = titleOf(render(h, [job({ engine: 'superbet-offer', script: 'superbet.mjs', fullMarkets: true, detailLimit: 100 })]), 'favbet');
  assert.match(deep, new RegExp(DICTS.en.t('feedDeepMode')), 'the deep mode reaches the chip');
  assert.match(deep, /100/, 'and the cap, which is 100 for superbet and 700 for unibet');
  assert.notEqual(deep, titleOf(render(h, [job({
    engine: 'superbet-offer', script: 'superbet.mjs', fullMarkets: true, detailLimit: 700,
  })]), 'favbet'), 'two books with different caps must not read identically');

  const shallow = titleOf(render(h, [job({ engine: 'nsoft-public-json', script: 'nsoft.mjs' })]), 'favbet');
  assert.doesNotMatch(shallow, new RegExp(DICTS.en.t('feedDeepMode')),
    'a book that never reads detail markets gets no deep-mode line');
  assert.doesNotMatch(shallow, /undefined|null|NaN/, 'and no dangling marker in its place');
});

test('the smoke floor is the number that job declares', () => {
  const h = harness('en');
  // betmen declares 20 and scripts/smoke-live.mjs:116 overrides its global floor
  // with it, so the number on the chip is the same one the smoke script holds
  // the book to — not a copy typed into the page.
  const floored = titleOf(render(h, [job({ engine: 'nsoft-public-json', script: 'nsoft.mjs', minEvents: 20 })]), 'favbet');
  assert.match(floored, /20/, 'the declared floor reaches the chip');
  const other = titleOf(render(h, [job({ engine: 'nsoft-public-json', script: 'nsoft.mjs', minEvents: 5 })]), 'favbet');
  assert.notEqual(floored, other, 'two floors must not read identically');
  const none = titleOf(render(h, [job({ engine: 'nsoft-public-json', script: 'nsoft.mjs' })]), 'favbet');
  assert.doesNotMatch(none, new RegExp(DICTS.en.t('feedSmokeFloor')),
    'the other 25 jobs declare no floor and get no line');
});

test('a payload with none of the new fields gains nothing', () => {
  // The byte-for-byte control the liveCapability block already sets, extended to
  // the three fields added since: a payload from before this route carried them
  // must render exactly the tooltip it rendered before, with no empty line where
  // one of the new builders used to be.
  const h = harness('en');
  const title = titleOf(render(h, [job()]), 'favbet');
  assert.equal(
    title,
    `Public JSON feed smoke-validated on 2026-09-01.\n${DICTS.en.t('endpointVerified')}: 2026-09-01`,
    'the tooltip is byte-for-byte the one this page produced before the route gained these fields',
  );
  assert.equal(title.split('\n').length, 2, 'and it is still two lines, not five with three empty ones');
  assert.doesNotMatch(title, /undefined|null|NaN| {2}$/m, 'nothing empty or undefined leaks into the attribute');
});

/* ── Book price board ──────────────────────────────────────────────────────
 * GET /api/odds/:book is the only per-book price feed the backend publishes
 * and nothing under public/ called it. This block drives the panel's own
 * functions over the real route payload shape, measured over
 * data-market-run/workspace: 12 distinct market keys, selections shaped
 * {id, name, odds, group}, and a `live` boolean on both the event and the
 * market.
 */

const oddsResult = (over = {}) => ({
  eventKey: 'football|liga|2026-09-05T10:00:00.000Z|cfr cluj|csic m',
  id: 'e-1',
  sport: 'Football',
  league: 'Liga',
  kickoff: '2026-09-05T10:00:00.000Z',
  homeTeam: 'CFR Cluj',
  awayTeam: 'CSIC M',
  live: false,
  market: {
    key: 'MATCH_ODDS',
    name: 'Rezultat final',
    live: false,
    selections: [
      { id: '1', name: '1', odds: 2.63, group: 'Main' },
      { id: 'X', name: 'X', odds: 2.1, group: 'Main' },
      { id: '2', name: '2', odds: 2.12, group: 'Main' },
    ],
  },
  ...over,
});

const boardHtml = (h) => h.nodes.get('odds-rows').innerHTML;
const boardNote = (h) => h.nodes.get('odds-note').textContent;

test('the board asks the route about the book it is showing, and nothing else', async () => {
  const seen = [];
  const h = harness('en', {
    form: { 'odds-book': { value: 'winner' }, 'odds-limit': { value: '50' } },
    api: {
      get: async (url) => {
        seen.push(url);
        return { sourceId: 'winner', capturedAt: '2026-09-28T10:00:00.000Z', results: [oddsResult()] };
      },
    },
  });
  await h.run('loadPriceBoard()');
  // Not `?marketKey=&eventKey=`: the route filters on
  // `String(market.key).toUpperCase() !== marketKey`, so an empty parameter is
  // not "no filter" — it matches nothing and empties the board.
  assert.deepEqual(seen, ['/api/odds/winner?limit=50'],
    'an unset filter is left off the query, not sent blank');

  const html = boardHtml(h);
  assert.match(html, /CFR Cluj – CSIC M/, 'the two clubs are what identifies the row');
  assert.match(html, /Liga · 2026-09-05T10:00:00\.000Z/, 'and the league and kickoff travel with them');
  assert.match(html, /Rezultat final/, 'the market is labelled with the provider’s own name');
  assert.match(html, /1 @ 2\.63/, 'each selection reads as name @ odds');
  // 2.1 is not 2.1 on this page: it goes through the shared formatter, which is
  // the whole reason scrape.html now loads format.js.
  assert.match(html, /X @ 2\.10/, 'odds are formatted by the shared formatter, not by the page');
  assert.match(boardNote(h), /1 markets · Captured: 2026-09-28T10:00:00\.000Z/,
    'the note carries the row count and when the capture was taken');
});

test('the board sends both filters, and uppercases the market the way the route compares it', async () => {
  const seen = [];
  const h = harness('en', {
    form: {
      'odds-book': { value: 'casa-pariurilor' },
      'odds-market': { value: 'over_under_2_5' },
      'odds-event': { value: 'football|liga|2026-09-05|cfr cluj|csic m' },
      'odds-limit': { value: '25' },
    },
    api: { get: async (url) => { seen.push(url); return { results: [] }; } },
  });
  await h.run('loadPriceBoard()');
  assert.equal(seen.length, 1, 'one request per control change, not one per control');
  assert.match(seen[0], /^\/api\/odds\/casa-pariurilor\?/, 'the book is the path');
  const q = new URLSearchParams(seen[0].split('?')[1]);
  assert.equal(q.get('marketKey'), 'OVER_UNDER_2_5', 'the market key is uppercased before it is sent');
  assert.equal(q.get('eventKey'), 'football|liga|2026-09-05|cfr cluj|csic m', 'the event key is the route’s own token, untouched');
  assert.equal(q.get('limit'), '25', 'the limit is the one the operator chose');
  assert.match(boardHtml(h), /No market matches this filter\./, 'an empty result is a sentence, not a blank table');
});

test('a row is marked live from either the event or the market', async () => {
  const h = harness('en', {
    form: { 'odds-book': { value: 'winner' } },
    api: {
      get: async () => ({
        capturedAt: '2026-09-28T10:00:00.000Z',
        results: [
          oddsResult(),
          oddsResult({ live: true }),
          oddsResult({ market: { ...oddsResult().market, live: true } }),
        ],
      }),
    },
  });
  await h.run('loadPriceBoard()');
  // Counted on the class, not the word: the marker is the dictionary's own
  // `live`, which is capitalised in both languages and restyled by CSS, so
  // matching the text would be matching a string this test invented.
  const pills = boardHtml(h).match(/<span class="status ok">[^<]*<\/span>/g) || [];
  assert.equal(pills.length, 2, 'the event flag and the market flag each mark their own row');
  assert.ok(pills.every((p) => p.includes(`>${DICTS.en.t('live')}<`)),
    `and the marker is the translated word, ${DICTS.en.t('live')}`);
  assert.match(boardNote(h), /2 live/, 'and the note counts them');
  // The other half of the same decision: a row that is not in-play says so by
  // saying nothing. "pre-match" would be a claim about the capture, and the
  // capture is the last one the operator ran.
  assert.doesNotMatch(boardHtml(h), /pre-?match|prematch/i, 'a row that is not in-play is not labelled');
});

test('the note says when the board is cut short, and when it is not', async () => {
  const capped = harness('en', {
    form: { 'odds-book': { value: 'winner' }, 'odds-limit': { value: '2' } },
    api: { get: async () => ({ results: [oddsResult(), oddsResult()] }) },
  });
  await capped.run('loadPriceBoard()');
  assert.match(boardNote(capped), /first 2, the capture is larger/,
    'a full page of results is also the only signal that more exist');

  const whole = harness('en', {
    form: { 'odds-book': { value: 'winner' }, 'odds-limit': { value: '50' } },
    api: { get: async () => ({ results: [oddsResult()] }) },
  });
  await whole.run('loadPriceBoard()');
  assert.doesNotMatch(boardNote(whole), /the capture is larger/,
    'and a short page does not claim the board was cut');
});

test('a book with no capture gets its own sentence, not a failed request', async () => {
  // Two of the 26 registered jobs are enabled and validated and still have no
  // snapshot on disk, so this is the second thing the panel will ever show.
  const h = harness('en', {
    form: { 'odds-book': { value: 'unibet' } },
    api: {
      get: async () => {
        const err = new Error('snapshot not found');
        err.status = 404;
        throw err;
      },
    },
  });
  await h.run('loadPriceBoard()');
  assert.match(boardHtml(h), /This book has no saved capture\./, 'the 404 says what it is');
  assert.doesNotMatch(boardHtml(h), /could not be read/, 'a book with no capture is not a request to retry');
  assert.equal(boardNote(h), '', 'and the note does not add a second opinion');

  const broken = harness('en', {
    form: { 'odds-book': { value: 'winner' } },
    api: {
      get: async () => {
        const err = new Error('socket hang up');
        err.status = 500;
        throw err;
      },
    },
  });
  await broken.run('loadPriceBoard()');
  assert.match(boardHtml(broken), /The prices could not be read: socket hang up/,
    'any other failure keeps the backend’s own words');
});

test('the book selector offers every registered job and keeps the one already chosen', () => {
  const three = [
    job({ id: 'unibet', name: 'Unibet' }),
    job({ id: 'betmen', name: 'Betmen' }),
    job({ id: 'winner', name: 'Winner' }),
  ];
  const h = harness('en');
  h.run(`scrapers = ${JSON.stringify(three)}`);
  h.run('renderPriceBookOptions()');
  const html = h.nodes.get('odds-book').innerHTML;
  for (const [id, name] of [['unibet', 'Unibet'], ['betmen', 'Betmen'], ['winner', 'Winner']]) {
    assert.ok(html.includes(`value="${id}"`), `${id} is offered — no route says which books have a capture`);
    assert.ok(html.includes(name), `${name} is spelled out, not its id`);
  }
  // The jobs are re-fetched on a timer, so this rewrite happens with a book
  // already chosen. A <select> drops its value when its options are replaced,
  // which is why the page reads the value back before it rewrites.
  h.nodes.get('odds-book').value = 'betmen';
  h.run('renderPriceBookOptions()');
  assert.equal(h.nodes.get('odds-book').value, 'betmen',
    'a book the operator already chose survives a re-render of the list');

  // The other half of the same decision: a book that has left the registry
  // between two fetches is not restored. The list no longer offers it, and
  // asking a select for a value it has no option for clears the select — so
  // restoring it would leave the panel showing a book the backend has dropped.
  h.run(`scrapers = ${JSON.stringify(three.filter((s) => s.id !== 'betmen'))}`);
  h.run('renderPriceBookOptions()');
  assert.notEqual(h.nodes.get('odds-book').value, 'betmen',
    'a book the registry no longer lists is not restored into the select');
  assert.equal(h.nodes.get('odds-book').value, 'unibet',
    'and the select falls to a book the list really has');
});

test('with no book chosen the panel asks nothing at all', async () => {
  const seen = [];
  const h = harness('en', {
    form: { 'odds-book': { value: '' } },
    api: { get: async (url) => { seen.push(url); return { results: [] }; } },
  });
  await h.run('loadPriceBoard()');
  assert.deepEqual(seen, [], 'an empty source id would ask the route about a book named ""');
  assert.match(boardHtml(h), /Pick a book/, 'and it says why the table is empty');
});

test('the board is translated, note and empty row alike', async () => {
  const notes = {};
  const rows = {};
  for (const lang of ['ro', 'en']) {
    const empty = harness(lang, {
      form: { 'odds-book': { value: 'unibet' } },
      api: { get: async () => ({ results: [] }) },
    });
    await empty.run('loadPriceBoard()');
    notes[lang] = boardNote(empty);
    rows[lang] = boardHtml(empty);

    const none = harness(lang, { form: { 'odds-book': { value: '' } }, api: { get: async () => ({}) } });
    await none.run('loadPriceBoard()');
    rows[lang] += boardHtml(none);

    // The fourth sentence the panel can print: the 404. A book with no capture
    // is one of the four the selector offers, so this is a sentence an operator
    // reads on a healthy install, not an edge case.
    const missing = harness(lang, {
      form: { 'odds-book': { value: 'unibet' } },
      api: { get: async () => { const e = new Error('snapshot not found'); e.status = 404; throw e; } },
    });
    await missing.run('loadPriceBoard()');
    rows[lang] += boardHtml(missing);
  }
  assert.notEqual(notes.ro, notes.en, 'the row count is not one string in both languages');
  assert.doesNotMatch(notes.ro, /markets|Captured/, 'no English leaked into Romanian');
  assert.doesNotMatch(rows.ro, /No market matches|Pick a book|no saved capture/, 'nor into the empty rows');
  assert.doesNotMatch(rows.en, /piețe|Alege o casă|Nicio piață|captură salvată/, 'nor Romanian into English');
});

test('scrape.html loads the formatter the board renders odds through', () => {
  // The one failure this file cannot catch from the vm: remove the script tag
  // and every test above still passes, because the harness loads format.js
  // itself. Only the markup knows the page does.
  assert.ok(scrapeHtml.includes('src="/js/format.js"'),
    'scrape.html must load format.js — the board calls arbiterFormat.fmtOdds');
  assert.ok(scrapeHtml.includes('id="odds-book"') && scrapeHtml.includes('id="odds-rows"'),
    'and the controls the controller reaches for by id are still in the markup');
});

test('the tooltip falls back to a translated line, not a hardcoded English one', () => {
  // These two strings were literals in the page. The rest of the surface is
  // translated, so a Romanian operator reading a chip with no reason on the
  // job got English with no way to tell it was not a translation bug.
  const ro = harness('ro');
  const en = harness('en');
  const bare = { validationStatus: 'validated', validationReason: undefined };
  const bareExp = { validationStatus: 'experimental', validationReason: undefined };
  // The first line is the reason or its fallback; the second is the date.
  const reasonLine = (h, jobs, id, opts) => titleOf(render(h, jobs, opts), id).split('\n')[0];

  const roValidated = reasonLine(ro, [job(bare)], 'favbet');
  const enValidated = reasonLine(en, [job(bare)], 'favbet');
  assert.equal(roValidated, 'sursă validată pe date reale');
  assert.equal(enValidated, 'validated real-data source');
  assert.notEqual(roValidated, enValidated, 'the fallback is translated, not English in both languages');

  // `validatedIds` comes from the server's `validatedJobs`, which the route
  // derives from the job's own validationStatus — so the two cannot disagree
  // in a real response. The experimental case therefore has to drop the id
  // from the set as well as flip the field, or the fixture is describing an
  // impossible payload and the branch under test is never the one taken.
  assert.equal(reasonLine(ro, [job(bareExp)], 'favbet', { validated: [] }), 'sursă experimentală', 'an unvalidated job with no reason');
  assert.equal(reasonLine(en, [job(bareExp)], 'favbet', { validated: [] }), 'experimental source');

  // And the positive control for that branch being reachable at all: same job,
  // only the id's membership in the validated set changed.
  const promoted = render(ro, [job(bareExp)], { validated: ['favbet'] });
  assert.equal(titleOf(promoted, 'favbet').split('\n')[0], 'sursă validată pe date reale',
    'membership in validatedJobs is what the fallback follows');
});

test('every key the chip tooltip uses exists in both languages', () => {
  const source = scrapeSource;
  for (const key of ['sourceValidated', 'sourceExperimental', 'endpointVerified']) {
    assert.ok(source.includes(`'${key}'`), `scrape.js should ask for ${key}`);
    for (const lang of ['ro', 'en']) assertTranslated(lang, key);
  }
});

test('the tooltip escapes its content, because one job writes a quote into its reason', () => {
  const h = harness();
  // Real: superbet's validationReason is a multi-hundred-character paragraph
  // of prose written by hand into config/scrapers.json. It is trusted input
  // today, and an attribute that breaks on a quote is a page that breaks the
  // next time somebody pastes a measurement containing one.
  const html = render(h, [job({ validationReason: 'measured "0 of 198" line pairs <0.5%' })]);
  const label = html.split('<label').find((chunk) => chunk.includes('value="favbet"'));
  assert.doesNotMatch(label, /title="[^"]*measured "/, 'the raw quote must not terminate the attribute');
  assert.ok(label.includes('&quot;'), 'and it is escaped instead');
  const [firstLine] = titleOf(html, 'favbet').split('\n');
  assert.equal(firstLine, 'measured "0 of 198" line pairs <0.5%', 'the reader still gets the real text, unescaped');
});

test('feedStatus is not shown, and that is a measured decision rather than an omission', () => {
  const h = harness();
  const title = titleOf(render(h, [job({ feedStatus: 'host-down' })]), 'favbet');
  // Every one of the 26 wired jobs measures `verified` and none disagrees with
  // its own validationStatus, so today the field is a constant. If that ever
  // stops being true this assertion is the one that should fail and force the
  // decision to be made, rather than the page quietly showing a stale claim.
  assert.doesNotMatch(title, /host-down/, 'a constant field stays out of the tooltip');
  assert.doesNotMatch(title, /feedStatus|Feed status/i, 'and it is not printed under a raw field name either');
});

// ---- the scheduler readout ---------------------------------------------------

const AT = '2026-10-01T10:00:00.000Z';

const lastRunText = (h, lastRun) => h.run(
  `schedulerLastRunText({ lastRun: ${JSON.stringify(lastRun)} }, window.arbiterI18n.t.bind(window.arbiterI18n))`,
);

test('a skipped tick is not reported as a failure', () => {
  const h = harness('en');
  // The backend writes three shapes for lastRun. This one is a tick that found
  // a scrape already in flight: the work it wanted is already running, and
  // `ok: false` only records that this particular tick did not start it. Read
  // as a binary it is a failure, and a 15-minute scheduler ticking into a
  // scrape that takes longer than that would sit permanently red.
  const skipped = lastRunText(h, { at: AT, ok: false, skipped: true, reason: 'scrape already running' });
  assert.match(skipped, /skipped/, 'a skip reads as a skip');
  assert.doesNotMatch(skipped, /\bfailed\b/, 'never as a failure');
  assert.match(skipped, /scrape already running/, 'and it says why, which is the part the user needs');
  // Pinned whole, so the separator between verdict and reason cannot quietly
  // disappear: the reader has to be able to see which half is the verdict.
  assert.match(skipped, /\(skipped\) — scrape already running$/);

  // The two shapes on either side of it, so the fix is not just "always say
  // skipped": a genuine failure must still read as one.
  const failed = lastRunText(h, { at: AT, ok: false });
  assert.match(failed, /\bfailed\b/, 'a launch that threw is still a failure');
  assert.doesNotMatch(failed, /skipped/, 'and is not softened into a skip');

  const launched = lastRunText(h, { at: AT, ok: true, launched: true });
  assert.match(launched, /\bok\b/, 'a launched cycle is ok');
  assert.doesNotMatch(launched, /failed|skipped/);
});

test('the job table and the scheduler readout agree on what a skip is', () => {
  // The reason this is a defect and not a preference: the same page, the same
  // idea, the opposite answer. isFailedJob already treats a skipped job as not
  // a failure, and the scheduler readout did not follow.
  const h = harness('en');
  assert.equal(h.run("isFailedJob({ status: 'skipped' })"), false, 'the job table says a skip is not a failure');
  assert.doesNotMatch(lastRunText(h, { at: AT, ok: false, skipped: true }), /\bfailed\b/,
    'so the scheduler readout must not contradict it');
});

test('the scheduler verdict is translated', () => {
  const shape = { at: AT, ok: false, skipped: true, reason: 'scrape already running' };
  const ro = lastRunText(harness('ro'), shape);
  const en = lastRunText(harness('en'), shape);
  assert.match(ro, /sărit/, 'Romanian does not print the English word');
  assert.doesNotMatch(ro, /skipped/);
  assert.match(en, /skipped/);
});

test('a scheduler that never ran says so, and a reason-less skip has no dangling dash', () => {
  const h = harness('en');
  assert.match(h.run("schedulerLastRunText({}, window.arbiterI18n.t.bind(window.arbiterI18n))"), /never ran/);

  // A skip without a reason is still a skip; it just has nothing to append.
  // The em-dash separator must not be emitted for an absent reason, or every
  // such readout ends in punctuation that points at nothing.
  const bare = lastRunText(h, { at: AT, ok: false, skipped: true });
  assert.match(bare, /\(skipped\)$/, 'a skip without a reason still closes on the verdict');
  assert.doesNotMatch(bare, /—\s*\)/, 'no dangling separator when there is no reason');

  // And a reason on a shape that is not a skip is not shown either: on a
  // success it would be noise, and `launched: true` is not an explanation.
  const ok = lastRunText(h, { at: AT, ok: true, launched: true, reason: 'scrape already running' });
  assert.doesNotMatch(ok, /scrape already running/);
});

test('the scheduler says which books it will actually run', () => {
  const h = harness('en');
  const books = [job({ id: 'favbet', name: 'Favbet' }), job({ id: 'unibet', name: 'Unibet' })];
  const out = (s) => {
    h.run(`scrapers = ${JSON.stringify(books)}; renderSchedulerBooks(${JSON.stringify(s)})`);
    return h.nodes.get('sched-books').textContent;
  };

  const line = out({ enabled: true, bookIds: ['favbet', 'unibet'] });
  assert.match(line, /Favbet, Unibet/, 'books are named, in the scheduler\'s order, separated so two run-together names stay readable');
  assert.doesNotMatch(line, /\bfavbet\b/, 'and not shown as raw ids next to names');

  // The control for the id fallback: a book the registry does not know still
  // has to be named, or a renamed or removed book silently vanishes from the
  // list of what is about to be scraped.
  const unknown = out({ enabled: true, bookIds: ['favbet', 'some-new-book'] });
  assert.match(unknown, /some-new-book/, 'an unknown id is shown rather than dropped');
  assert.match(unknown, /Favbet/, 'alongside the ones that are known');

  // Disabled is not the same as unconfigured. The real state file on this
  // machine holds six books with `enabled: false`, and a scheduler that is
  // switched off keeps the list it will use next time — hiding it there would
  // leave the operator re-selecting books they had already chosen.
  const parked = out({ enabled: false, bookIds: ['favbet', 'unibet'] });
  assert.match(parked, /Favbet, Unibet/, 'a disabled scheduler still shows what it is set to');

  // A disabled, never-configured scheduler has nothing to say, and a
  // permanently empty line is worse than no line.
  assert.equal(out({ enabled: false, bookIds: [] }), '', 'a disabled, never-configured scheduler stays quiet');

  // The other side of that pair: switched on with nothing to run still has to
  // say so. A label with an em dash is the honest reading — the line is there
  // and it has no books — where `Scheduled books: ` with a trailing space and
  // nothing after it looks like a line that failed to render.
  assert.equal(out({ enabled: true, bookIds: [] }), 'Scheduled books: —');

  // `bookIds` is read back off a JSON file the operator can edit, so it can be
  // a string or an object. `.map` on either throws inside refreshScheduler,
  // whose catch swallows it — and the readout goes stale instead of updating.
  // The scheduler is still on, so the line says "no books" the same way an
  // enabled scheduler with an empty list does; silence there would read as
  // "off", which is the one thing it is not.
  assert.doesNotThrow(() => out({ enabled: true, bookIds: 'favbet' }),
    'a hand-edited state file cannot take the readout down');
  assert.equal(h.nodes.get('sched-books').textContent, out({ enabled: true, bookIds: [] }),
    'an unusable list reads exactly like an empty one');
});

test('a schedule restored from disk says so', () => {
  const h = harness('en');
  const books = [job({ id: 'favbet', name: 'Favbet' })];
  const out = (s) => {
    h.run(`scrapers = ${JSON.stringify(books)}; renderSchedulerBooks(${JSON.stringify(s)})`);
    return h.nodes.get('sched-books').textContent;
  };
  // This is the case the line exists for: the chips default from the
  // bookmaker registry, the scheduler's own list comes off disk, and after a
  // restart the two can describe different sets with nothing on the page
  // saying so.
  const resumed = out({ enabled: true, bookIds: ['favbet'], resumed: true });
  assert.match(resumed, /resumed at startup/);
  assert.doesNotMatch(out({ enabled: true, bookIds: ['favbet'], resumed: false }), /resumed at startup/,
    'and only a restored one is marked');
});

test('the scheduler block in the page still carries every id the script binds', () => {
  // The readout is now three lines, not one. A redesign that dropped one of
  // the ids would leave the script writing into nothing, silently, which is
  // the failure this check exists to catch.
  const bound = [...new Set([...scrapeSource.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = bound.filter((id) => !PAGE_IDS.has(id));
  assert.deepEqual(missing, [], 'the page keeps every element the script binds by id');
  for (const id of ['sched-enabled', 'sched-interval', 'sched-save', 'sched-last', 'sched-books', 'sched-scan']) {
    assert.ok(PAGE_IDS.has(id), `#${id} must be in scrape.html`);
  }
});

test('every key the scheduler and live readouts use exists in both languages', () => {
  // Both panels draw their stored-vs-form line from the same label keys, and
  // each has its own headline: `schedulerScanDiffers` and `liveScanDiffers`.
  for (const key of ['skippedShort', 'schedulerBooks', 'schedulerResumed', 'schedulerScanDiffers',
    'liveScanDiffers',
    'yesShort', 'noShort', 'okShort', 'failedShort', 'neverRan', 'lastRun']) {
    for (const lang of ['ro', 'en']) assertTranslated(lang, key);
  }
});

// ---- the stored scan options -------------------------------------------------

/**
 * `data/scheduler-state.json` on this machine, copied field for field.
 *
 * A literal rather than a read of the real file: that file changes on every
 * scheduled tick and on every save, and a test that depends on it fails the
 * next time the scheduler runs. Copied, it also documents the shape the page
 * actually receives — seven keys, no `maxEvents`, no `sport`.
 */
const STORED_SCAN = {
  bankroll: 1000, minRoiPercent: 0, minEvPercent: 2, maxMiddleRiskPercent: 15,
  minMiddleRoiPercent: 20, includeLive: false, includePast: false,
};

/** The form as profile 1 (`trusted-prematch`) leaves it — the state that agrees. */
const PROFILE_ONE_FORM = {
  bankroll: { value: '1000' }, 'min-roi': { value: '0' }, 'min-ev': { value: '2' },
  'mid-risk': { value: '15' }, 'mid-roi': { value: '20' },
  'inc-live': { checked: false }, 'inc-past': { checked: false },
  'max-events': { value: 'all' }, 'sport-filter': { value: '' },
};

/**
 * The form as profile 2 (`review-live`) leaves it, from config/scan-profiles.json.
 *
 * Six of the nine fields move. `minEvPercent` does not — that profile does not
 * carry it and `applyProfile()` has no line for it, so the input keeps whatever
 * it had — which is why it must stay put in this fixture and why the assertion
 * below that it is *not* reported is a real one.
 */
const PROFILE_TWO_FORM = {
  ...PROFILE_ONE_FORM,
  bankroll: { value: '500' }, 'min-roi': { value: '1' },
  'mid-risk': { value: '10' }, 'mid-roi': { value: '30' },
  'inc-live': { checked: true }, 'inc-past': { checked: true },
};

const scanLine = (lang, form, stored = STORED_SCAN) => {
  const h = harness(lang, { form });
  h.run(`renderSchedulerScan(${JSON.stringify(stored)})`);
  return h.nodes.get('sched-scan').textContent;
};

test('the scan payload is written in one place, not one per caller', () => {
  // It was the same nine-key literal in the run handler and in the save
  // handler. The scheduler's copy is what gets persisted and then replayed on
  // every tick, so a second copy is a second description of a configuration
  // that nothing on the page shows.
  assert.equal((scrapeSource.match(/minRoiPercent: Number/g) || []).length, 1,
    'one place reads the form into a scan payload');
  assert.equal((scrapeSource.match(/const scanOptions = currentScanOptions\(\)/g) || []).length, 2,
    'and both callers go through it');
  // `init()` needs five more routes and a real dropdown, so the profile
  // listener's registration is pinned as source rather than exercised. The
  // behaviour behind it is covered by the profile-switch test below.
  assert.match(scrapeSource, /sel\.addEventListener\('change', \(\) => onProfileChange\(\)\)/,
    'switching the profile re-runs the comparison');
});

test('currentScanOptions is the form, coerced the way the backend stores it', () => {
  // Every field gets a value that is not the one a plausible hardcode would
  // reach for: a fixture that repeats the HTML defaults passes against
  // `minEvPercent: 2` and `maxEvents: 'all'`, which are exactly the two
  // hardcodes that were worth testing for.
  const form = {
    bankroll: { value: '750.5' }, 'min-roi': { value: '1.5' }, 'min-ev': { value: '3.5' },
    'mid-risk': { value: '12.5' }, 'mid-roi': { value: '27.5' },
    'inc-live': { checked: true }, 'inc-past': { checked: false },
    'max-events': { value: '250' }, 'sport-filter': { value: 'soccer' },
  };
  const h = harness('en', { form });
  // Through JSON, because that is what the POST body is: it also pins the
  // `sport: undefined` case, which serialises to no key at all rather than to
  // a null the backend would have to special-case.
  const sent = JSON.parse(JSON.stringify(h.run('currentScanOptions()')));
  assert.deepEqual(sent, {
    bankroll: 750.5, minRoiPercent: 1.5, minEvPercent: 3.5, maxMiddleRiskPercent: 12.5,
    minMiddleRoiPercent: 27.5, includeLive: true, includePast: false, maxEvents: 250, sport: 'soccer',
  });

  // And the same fixture with an empty sport filter: the key is not sent at
  // all rather than sent as null or as an empty string.
  const all = harness('en', { form: { ...form, 'sport-filter': { value: '' } } });
  const noSport = JSON.parse(JSON.stringify(all.run('currentScanOptions()')));
  assert.equal('sport' in noSport, false, 'an empty sport filter is not sent as a value');
  assert.equal(noSport.maxEvents, 250, 'and dropping the sport filter does not disturb the rest');
});

test('the event-collection dropdown is normalised before it is stored', () => {
  // The backend stores what this returns and replays it on every tick, so the
  // "all" sentinel and the unusable values have to be decided in one place
  // rather than at each use.
  const at = (value) => {
    const h = harness('en', { form: { ...PROFILE_ONE_FORM, 'max-events': { value } } });
    return h.run('currentScanOptions().maxEvents');
  };
  assert.equal(at('all'), 'all');
  assert.equal(at('ALL'), 'all', 'the sentinel is case-insensitive, like the value it comes from a <select>');
  assert.equal(at(' 250 '), 250, 'and a number is trimmed and taken as one');
  assert.equal(at('0'), 'all', 'zero events is not a limit, it is the absence of one');
  assert.equal(at('-3'), 'all');
  assert.equal(at('12.5'), 'all', 'a fractional event count is not a count');
  assert.equal(at(''), 'all', 'an empty select is the absence of a limit');
  assert.equal(at('nonsense'), 'all');
});

test('a stored configuration that still matches the form says nothing', () => {
  // The control for the whole comparison: the line is not decoration, and a
  // comparison that always fired would teach the reader to ignore it.
  assert.equal(scanLine('en', PROFILE_ONE_FORM), '');
  assert.equal(scanLine('ro', PROFILE_ONE_FORM), '');

  // And what it does fire on, pinned whole. The real state file has no
  // maxEvents and no sport while the form has 'all' and undefined, and
  // reporting those would be a difference the operator can do nothing about.
  // The list is exactly the six fields profile 2 changes — the four numbers
  // and the two checkboxes — with the stored value first.
  assert.equal(scanLine('en', PROFILE_TWO_FORM),
    'The scheduler runs with values other than the form: Bankroll 1000 → 500, Min ROI % 0 → 1, '
    + 'Max middle risk % 15 → 10, Min middle ROI % 20 → 30, include live no → yes, include past no → yes');
  assert.equal(scanLine('ro', PROFILE_TWO_FORM),
    'Programatorul rulează cu valori diferite de formular: Bankroll 1000 → 500, ROI minim % 0 → 1, '
    + 'Risc middle maxim % 15 → 10, ROI middle minim % 20 → 30, include live nu → da, include trecut nu → da');
});

test('an unusable stored configuration is reported as no comparison at all', () => {
  // `status()` only reaches the page through JSON, but a truncated or
  // hand-edited file can still hand the page something that is not an object,
  // and `saved[field]` on a string is undefined rather than a throw.
  assert.equal(scanLine('en', PROFILE_TWO_FORM, 'not-an-object'), '');
  assert.equal(scanLine('en', PROFILE_TWO_FORM, null), '');
  // No argument at all, which is what a payload without scanOptions gives.
  const h = harness('en', { form: PROFILE_TWO_FORM });
  h.run('renderSchedulerScan()');
  assert.equal(h.nodes.get('sched-scan').textContent, '');
});

test('switching the profile is reported, with both values and a direction', () => {
  const en = scanLine('en', PROFILE_TWO_FORM);
  assert.match(en, /runs with values other than the form/, 'the line says what it is about');
  assert.match(en, /Bankroll 1000 → 500/, 'stored first, form second, so the arrow is a direction');
  assert.match(en, /Min ROI % 0 → 1/);
  assert.match(en, /include live no → yes/, 'a boolean is not printed as true/false on a translated page');
  assert.doesNotMatch(en, /Min positive EV/, 'an unchanged field is not reported');

  const ro = scanLine('ro', PROFILE_TWO_FORM);
  assert.match(ro, /include live nu → da/);
  assert.doesNotMatch(ro, /runs with values/, 'and the sentence is translated, not English in both');
});

test('the scheduler block does not read `active`, because it cannot differ from `enabled`', () => {
  // `status()` returns `active: Boolean(this._timer)` next to `enabled`. Every
  // path that sets one sets the other — enable() arms the timer, disable()
  // clears it, loadState() only arms when the file says enabled — so the pair
  // is a constant duplicate, like `feedStatus` on the chip. The invariant is
  // pinned in test/scheduler-service.test.mjs; if it ever breaks, that test
  // fails and this line stops being an omission and starts being a gap.
  assert.doesNotMatch(scrapeSource, /\bs\.active\b/, 'the scheduler payload\'s `active` is not read');
  assert.doesNotMatch(scrapeSource, /\blastScheduler\.active\b/, 'nor the cached copy of it');
});

// ---- the live poll's stored thresholds --------------------------------------

/**
 * `GET /api/live` as the page receives it: LiveService.status() forces
 * `includeLive: true` into the copy it returns, so the payload's own live flag
 * is always true whatever the state file says.
 */
const LIVE_STORED_SCAN = { ...STORED_SCAN, includeLive: true };

const liveScanLine = (lang, form, stored = LIVE_STORED_SCAN) => {
  const h = harness(lang, { form });
  h.run(`renderLiveScan({ scanOptions: ${JSON.stringify(stored)} })`);
  return h.nodes.get('live-scan').textContent;
};

test('the live poll shows the thresholds it will actually use', () => {
  // Same defect the scheduler block reports one panel up, reached by the same
  // line of code: `live-save` posts currentScanOptions() to /api/live, the
  // service stores it, and the next tick replays that stored copy. Switching the
  // scrape form to another profile rewrites those values without touching the
  // live panel, so the poll's thresholds drift away from the form silently.
  // Before this line existed, the payload's `scanOptions` had no reader on the
  // page at all: the books and the measured duration were drawn, the thresholds
  // were not.
  assert.equal(liveScanLine('en', PROFILE_ONE_FORM), '', 'a poll that agrees with the form says nothing');
  assert.equal(liveScanLine('ro', PROFILE_ONE_FORM), '');

  const en = liveScanLine('en', PROFILE_TWO_FORM);
  assert.equal(en,
    'The live poll uses values other than the form: Bankroll 1000 → 500, Min ROI % 0 → 1, '
    + 'Max middle risk % 15 → 10, Min middle ROI % 20 → 30, include past no → yes');
  const ro = liveScanLine('ro', PROFILE_TWO_FORM);
  assert.equal(ro,
    'Rularea live folosește valori diferite de formular: Bankroll 1000 → 500, ROI minim % 0 → 1, '
    + 'Risc middle maxim % 15 → 10, ROI middle minim % 20 → 30, include trecut nu → da');
  assert.doesNotMatch(en, /include live/, 'the poll forces includeLive, so the form\'s box is not a difference');
  assert.doesNotMatch(en, /Min positive EV/, 'an unchanged field is not reported');

  // The control for that suppression: the same form and the same stored numbers,
  // compared the scheduler's way, DOES report the live box — which is correct
  // there, because the scheduler really does take includeLive from the form. So
  // the difference between the two lines is the forcing and not the fixture.
  assert.match(scanLine('en', PROFILE_ONE_FORM, LIVE_STORED_SCAN), /include live yes → no/);
});

test('refreshLive writes the live scan line from one real payload', async () => {
  // The call, not the function. Every other test in this section runs
  // renderLiveScan() directly, so all of them would pass on a page where the
  // refresh never called it and the line stayed empty forever — a page that
  // draws the books and the measured duration and says nothing about the
  // thresholds. This is the wiring the field census reads as evidence, so it is
  // pinned as behaviour rather than assumed from the function existing.
  const seen = [];
  const payload = {
    enabled: true, active: true, resumed: false, intervalSeconds: 60,
    liveMaxAgeMs: 90000, bookIds: [], scanningAllBooks: true,
    scanOptions: LIVE_STORED_SCAN, pending: null,
    lastRun: { at: AT, ok: true, runId: 'r7', status: 'completed', durationMs: 42000, keepingUp: true },
    lastError: null, skippedTicks: 0, lastSkippedAt: null,
  };
  const h = harness('en', {
    form: PROFILE_TWO_FORM,
    api: { get: async (url) => { seen.push(url); return payload; } },
  });

  await h.run('refreshLive()');

  assert.deepEqual(seen, ['/api/live'], 'one route, one read');
  assert.equal(h.nodes.get('live-enabled').checked, true, 'the payload drives the checkbox');
  assert.equal(h.nodes.get('live-interval').value, 60);
  // Touched the way the page touches it, so a page that never drew into this
  // element fails on the CONTENT below rather than on a node this harness never
  // had to create.
  h.run("$('live-scan')");
  assert.equal(h.nodes.get('live-scan').textContent,
    'The live poll uses values other than the form: Bankroll 1000 → 500, Min ROI % 0 → 1, '
    + 'Max middle risk % 15 → 10, Min middle ROI % 20 → 30, include past no → yes',
    "the route's own scanOptions reached the line, compared against the form as it stands");

  // The measured duration came from the same payload, so the two lines really are
  // two drawings of one answer.
  assert.match(h.nodes.get('live-measured').textContent, /Last measured poll: /);
  assert.doesNotMatch(h.nodes.get('live-measured').textContent, /not keeping up/,
    'a poll that kept up says nothing about falling behind');
});

test('a live payload with nothing to compare leaves the line empty', () => {
  // The poll has never run: `status()` returns the empty options object, and a
  // field the stored copy does not carry is not a difference.
  assert.equal(liveScanLine('en', PROFILE_TWO_FORM, {}), '');
  assert.equal(liveScanLine('en', PROFILE_TWO_FORM, 'not-an-object'), '');
  const h = harness('en', { form: PROFILE_TWO_FORM });
  h.run('renderLiveScan()');
  assert.equal(h.nodes.get('live-scan').textContent, '', 'and no payload at all is not a configuration');
});

test('the live block does not read `active`, for the same reason the scheduler does', () => {
  assert.doesNotMatch(scrapeSource, /\bl\.active\b/, 'the live payload\'s `active` is not read');
  assert.doesNotMatch(scrapeSource, /\blastLive\.active\b/, 'nor the cached copy of it');
});

test('refreshScheduler writes all three readouts from one real payload', async () => {
  const seen = [];
  const payload = {
    enabled: true, active: true, resumed: false, intervalMinutes: 20,
    bookIds: ['favbet', 'unibet'], scanOptions: STORED_SCAN,
    lastRun: { at: AT, ok: false, skipped: true, reason: 'scrape already running' }, lastError: null,
  };
  const h = harness('en', {
    form: PROFILE_TWO_FORM,
    api: { get: async (url) => { seen.push(url); return payload; } },
  });
  h.run(`scrapers = ${JSON.stringify([job({ id: 'favbet', name: 'Favbet' }), job({ id: 'unibet', name: 'Unibet' })])}`);

  await h.run('refreshScheduler()');

  assert.deepEqual(seen, ['/api/scheduler'], 'one route, one read');
  assert.equal(h.nodes.get('sched-enabled').checked, true, 'the payload drives the checkbox');
  assert.equal(h.nodes.get('sched-interval').value, 20, 'and the interval, off the payload and not the HTML default');
  assert.match(h.nodes.get('sched-books').textContent, /Favbet, Unibet/);
  // The form here is profile 2 and the stored copy is profile 1's, so the
  // comparison has to fire. A payload that agreed with the form would leave
  // the wiring unproven: a page that never called the comparison at all would
  // render the same empty line.
  assert.equal(h.nodes.get('sched-scan').textContent,
    'The scheduler runs with values other than the form: Bankroll 1000 → 500, Min ROI % 0 → 1, '
    + 'Max middle risk % 15 → 10, Min middle ROI % 20 → 30, include live no → yes, include past no → yes',
    "the route's own scanOptions reached the line, compared against the form as it stands");
  assert.match(h.nodes.get('sched-last').textContent, /\(skipped\) — scrape already running$/);

  // The defensive half of `s.intervalMinutes || 15`. The service clamps to
  // 1..1440, so a falsy interval cannot arrive from the real route; the
  // fallback exists for a truncated payload and is asserted as such rather
  // than left as the one branch nothing reaches.
  const stub = harness('en', { form: PROFILE_ONE_FORM, api: { get: async () => ({ ...payload, intervalMinutes: undefined }) } });
  await stub.run('refreshScheduler()');
  assert.equal(stub.nodes.get('sched-interval').value, 15, 'a payload with no interval falls back to 15, not 0 or NaN');

  // The same reasoning for `!!s.enabled`, which is the one coercion standing
  // between a truncated payload and an unchecked box that was never unchecked.
  const bare = harness('en', { form: PROFILE_ONE_FORM, api: { get: async () => ({ ...payload, enabled: undefined }) } });
  await bare.run('refreshScheduler()');
  assert.equal(bare.nodes.get('sched-enabled').checked, false, 'a payload with no `enabled` reads as off, not as a truthy undefined');

  // A tick that threw, on the same line as the verdict — the page appends the
  // error after the verdict rather than in place of it, because the verdict is
  // about this tick and the error is about why.
  const failed = harness('en', {
    form: PROFILE_ONE_FORM,
    api: { get: async () => ({ ...payload, lastRun: { at: AT, ok: false }, lastError: { message: 'launch refused: no books', at: AT } }) },
  });
  await failed.run('refreshScheduler()');
  assert.match(failed.nodes.get('sched-last').textContent, /\(failed\).*last error: launch refused: no books$/,
    'the verdict comes first and the reason is appended, verbatim as the backend wrote it');
});

test('a saved scheduler is re-read, so the comparison cannot survive a stale save', async () => {
  // The save handler calls refreshScheduler() after POSTing, and the profile
  // handler re-runs the comparison — the line is not a one-shot at load.
  const h = harness('en', {
    form: PROFILE_ONE_FORM,
    api: { get: async () => ({ enabled: true, active: true, intervalMinutes: 15, bookIds: ['favbet'], scanOptions: STORED_SCAN, lastRun: null, lastError: null }) },
  });
  h.run('scrapers = []');
  await h.run('refreshScheduler()');
  assert.equal(h.nodes.get('sched-scan').textContent, '');

  // Now the operator switches the profile: applyProfile() rewrites the form
  // under the comparison, so the line has to be recomputed without a poll.
  h.run(`profiles = [{ id: 'review-live', defaults: { bankroll: 500, minRoiPercent: 1, maxMiddleRiskPercent: 10, minMiddleRoiPercent: 30, includeLive: true, includePast: true } }]`);
  h.run(`document.getElementById('profile').value = 'review-live'; onProfileChange()`);
  assert.match(h.nodes.get('sched-scan').textContent, /Bankroll 1000 → 500/,
    'the line answers about the profile on screen now, not the one it booted with');
});

// ---- the scan profile dropdown -----------------------------------------------

/**
 * config/scan-profiles.json, read rather than copied.
 *
 * Read so that a third profile — or a third scope — makes the tests below fail
 * rather than quietly go untested, which is the case the derived half of
 * profileLabel exists to handle.
 */
const PROFILES = JSON.parse(
  readFileSync(new URL('../config/scan-profiles.json', import.meta.url), 'utf8'),
).profiles;

const labelOf = (lang, profile) => harness(lang).run(
  `profileLabel(${JSON.stringify(profile)}, window.arbiterI18n.t.bind(window.arbiterI18n))`,
);

test('the profile dropdown names each profile in the reader\'s language', () => {
  // The dropdown printed `p.label` straight out of the config file, so a
  // Romanian operator was choosing between "Trusted · Prematch" and
  // "Review · Live + Past" in English. The two keys that name those modes,
  // `trusted` and `review`, were in the dictionary in both languages and
  // translated nothing.
  const [trusted, review] = PROFILES;
  assert.equal(labelOf('ro', trusted), 'De încredere · Pre-match');
  assert.equal(labelOf('en', trusted), 'Trusted · Pre-match');
  assert.equal(labelOf('ro', review), 'De revizuit · Live + istoric');
  assert.equal(labelOf('en', review), 'Review · Live + history');

  // The separator and the order are pinned whole rather than by /Pre-match/:
  // telling the two rows apart is the dropdown's whole job, and the config's
  // own string used to do that job.
  for (const p of PROFILES) {
    assert.notEqual(labelOf('ro', p), p.label,
      `${p.id}: the config's English label is no longer what the page shows`);
  }
  for (const lang of ['ro', 'en']) {
    assert.notEqual(labelOf(lang, PROFILES[0]), labelOf(lang, PROFILES[1]),
      `in ${lang} the two profiles do not collapse into one option`);
  }
});

test('the scope half is derived from the defaults, so a new scope needs no new key', () => {
  // Only the two real modes are in the dictionary. A third scope added to the
  // config would, if the scope came from a key too, produce an option reading
  // "De încredere · profileScopeFoosball" — t()'s own answer for a key it does
  // not have, which is what the mode fallback is for and what the scope must
  // not be.
  const base = PROFILES[0];
  const scopeOf = (defaults) => labelOf('ro', { ...base, defaults: { ...base.defaults, ...defaults } });
  assert.equal(scopeOf({ includeLive: false, includePast: false }), 'De încredere · Pre-match');
  assert.equal(scopeOf({ includeLive: true, includePast: false }), 'De încredere · Live + istoric');
  assert.equal(scopeOf({ includeLive: false, includePast: true }), 'De încredere · Live + istoric',
    'either flag puts the profile over a live or historical window');
  // The control for that `||`: a profile carrying no defaults at all still gets
  // a scope, and an `&&` would have reached the same answer by accident rather
  // than because the defaults say so.
  assert.equal(labelOf('en', { ...base, defaults: {} }), 'Trusted · Pre-match',
    'a profile with no defaults is pre-match because nothing widens it');
});

test('a profile the dictionary cannot name still produces a selectable option', () => {
  // Three shapes the config could grow into. Each has to produce text: an
  // <option> with an empty label is a blank row the operator cannot tell from
  // anything, and the profile is their main control over what the run will do.
  const base = PROFILES[0];

  // A mode t() has never heard of comes back as its own name. That is the right
  // answer for it — a word the operator can read — and it beats a blank.
  assert.equal(labelOf('en', { ...base, mode: 'experimental-batch' }), 'experimental-batch · Pre-match',
    'an untranslated mode is shown as itself, not as a lookup key and not blank');

  // A profile with no mode at all falls back to the string the config gave it,
  // rather than to a label with a hole where the mode was.
  assert.equal(labelOf('en', { ...base, mode: undefined }), base.label,
    'a mode-less profile keeps the config\'s own label');
  assert.equal(labelOf('en', { ...base, mode: '', label: 'Custom' }), 'Custom');

  // And the last resort: nothing to say at all stays empty rather than becoming
  // the string "undefined" — which is what a bare template literal would do.
  assert.equal(labelOf('en', { id: 'x' }), '');
  assert.equal(labelOf('en', { id: 'x', mode: null, label: null }), '');
});

test('the profile dropdown carries the sentence the config wrote about it', () => {
  // `description` is the one field of GET /api/profiles that said what a profile
  // is *for*. profileLabel builds its option text from `mode` and the defaults
  // and never looked at it, so both shipped profiles described themselves to
  // nobody — while the mode translated to a single word and the scope was two
  // booleans. The prose is read off the config rather than typed here, so a third
  // profile fails this test instead of arriving unmentioned.
  const h = harness('en');
  h.run(`profiles = ${JSON.stringify(PROFILES)}`);
  for (const p of PROFILES) {
    assert.ok(p.description, `${p.id} has no description to show`);
    h.run(`document.getElementById('profile').value = ${JSON.stringify(p.id)}; applyProfileHint()`);
    assert.equal(h.nodes.get('profile').title, p.description,
      `${p.id} carries its own sentence on the select`);
  }
});

test('the hint follows the selection and leaves nothing behind', () => {
  const h = harness('en');
  h.run(`profiles = ${JSON.stringify(PROFILES)}`);
  // Reached through the document, not through `nodes`: the harness memoises a
  // stub the first time getElementById is asked for it, so reading `nodes` first
  // would hand back undefined and the test would fail on its own setup.
  const sel = h.run("document.getElementById('profile')");

  // The control, and the reason the clear path exists: a profile with no
  // description must not inherit the previous one's sentence. Two of the two
  // shipped profiles have one, so without this the clear branch is unreachable
  // and could be deleted without a test noticing.
  h.run(`document.getElementById('profile').value = ${JSON.stringify(PROFILES[0].id)}; applyProfileHint()`);
  assert.equal(sel.title, PROFILES[0].description);
  h.run(`profiles = [${JSON.stringify({ id: PROFILES[0].id })}]; applyProfileHint()`);
  assert.equal(sel.getAttribute('title'), null, 'a profile with no description leaves no stale hint');

  // And a selection that is not in the list at all, which is what a config file
  // edited under a running page produces.
  h.run(`profiles = ${JSON.stringify(PROFILES)}; document.getElementById('profile').value = 'removed-profile'; applyProfileHint()`);
  assert.equal(sel.getAttribute('title'), null, 'a selection with no profile behind it carries no hint');
});

test('the option markup is escaped, because the mode comes off a file on disk', () => {
  // profileLabel returns a plain string; the escaping happens where the option
  // is built, and init() wants five routes and a real dropdown before it gets
  // there, so the call site is pinned as source. It is escaped there or it is
  // not escaped anywhere.
  assert.match(scrapeSource, /escapeHtml\(profileLabel\(p, t\)\)/,
    'the label goes through the escaper on its way into the option');
  // And the control, so the line above is load-bearing rather than decorative: a
  // mode really can carry a quote, because mode is a field in a JSON file that
  // anybody editing config/scan-profiles.json can set to anything.
  assert.equal(labelOf('en', { ...PROFILES[0], mode: 'a"b' }), 'a"b · Pre-match');
});

// ---- the last-run panel note -----------------------------------------------

/**
 * `GET /api/scrape-run`'s payload, copied off data/latest-scrape-run.json.
 *
 * `jobs` is left empty on purpose: the job rows are not what these tests are
 * about, and an empty list keeps the table from being twenty-four lines of
 * fixture per assertion.
 */
const RUN = {
  runId: '2026-09-30T01:08:05.940Z',
  startedAt: '2026-09-30T01:08:05.980Z',
  finishedAt: '2026-09-30T01:09:40.180Z',
  status: 'ok',
  jobs: [],
  opportunitiesCount: 0,
};

const whenLine = async (lang, run) => {
  const h = harness(lang, { api: { get: async () => run } });
  await h.run('refreshLastRun()');
  return h.nodes.get('last-run-when').textContent;
};

test('the last-run panel says which run it is showing, and when it ran', async () => {
  // runId, startedAt and finishedAt were in this payload from the start and
  // were rendered by nothing: a table under the heading "the last run" that
  // could not name the run, nor say whether it was a minute or a week old.
  const note = await whenLine('en', RUN);
  assert.match(note, /^Run ID: 2026-09-30T01:08:05\.940Z · /, 'the run is named');
  assert.match(note, / · Started: \S/, 'and when it started');
  assert.match(note, / · Finished: \S/, 'and when it ended');
  assert.equal(note.split(' · ').length, 3, 'three values and no empty part between them');
  assert.doesNotMatch(note, /undefined|NaN|Invalid Date/, 'and nothing undefined reaches the note');

  // The labels are the reader's, not the dictionary's keys: a panel note that
  // reads "runId" is the same defect as a profile reading "review".
  assert.doesNotMatch(note, /runId|startedAt|finishedAt/);
  const roNote = await whenLine('ro', RUN);
  assert.match(roNote, /^ID rulare: /);
  assert.doesNotMatch(roNote, /Run ID|Started:|Finished:/,
    'and the Romanian note is Romanian, not the English one');
});

test('a run that has not finished does not claim that it has', async () => {
  // The orchestrator writes `finishedAt: null` for the whole life of the run
  // and fills it in only at the end (src/scrape-orchestrator.mjs:170, :355).
  // The page re-reads this payload on every job-complete, so the in-flight
  // shape is what is on screen for most of a scrape — and "Finished: Invalid
  // Date" next to a run that is still going is the opposite of the truth.
  const note = await whenLine('en', { ...RUN, finishedAt: null });
  assert.match(note, /Run ID: /, 'the run is still named');
  assert.match(note, /Started: \S/, 'and still dated');
  assert.doesNotMatch(note, /Finished|Invalid Date/, 'but no finish is claimed, and no stand-in for one');
  assert.doesNotMatch(note, /·\s*$/, 'and no separator left dangling at the end');
});

test('a machine that has never scraped gets an empty note, not one full of undefined', async () => {
  // The route's own fallback (src/router.mjs:63): no run file means
  // `{ jobs: [], opportunitiesCount: 0 }` — no runId, no startedAt, no
  // finishedAt. Three unguarded template literals would print "Run ID:
  // undefined · Started: undefined · Finished: undefined" on a fresh install.
  assert.equal(await whenLine('ro', { jobs: [], opportunitiesCount: 0 }), '');
  // And the same for a payload that is not there at all, which is what
  // readLatestScrapeRun hands the route before its own fallback runs.
  assert.equal(await whenLine('ro', null), '');
});

test('the note shows the run id itself, because a Text node is not an HTML parser', async () => {
  // Measured rather than assumed. In a real browser (playwright's chromium,
  // with common.js:23's escaper copied verbatim) `textContent =
  // escapeHtml('run&7')` reads back as the six characters `run&amp;7`, while
  // `innerHTML = escapeHtml('run&7')` reads back as `run&7`: a Text node's data
  // is literal and only the parser decodes entities. Escaping on the way to a
  // textContent sink therefore puts markup in front of the reader, and this was
  // the only such call in public/js — every other escapeHtml feeds innerHTML.
  const note = await whenLine('en', { ...RUN, runId: 'run&7' });
  assert.match(note, /Run ID: run&7 · /, 'the id reaches the note as it is');
  assert.doesNotMatch(note, /&amp;|&lt;|&gt;|&quot;|&#39;/, 'and is not escaped a second time');

  // The control, so the assertion above is about the sink and not about a
  // harness that has lost the escaper: the real escaper is present and does
  // rewrite that ampersand.
  assert.equal(harness('en').run("escapeHtml('run&7')"), 'run&amp;7',
    'the escaper this page shares is live and would have escaped it');
});

// ---- the banner when the page cannot load its configuration ------------------

/**
 * `init().catch(...)`, loaded the way the page loads it.
 *
 * It sits past the point every other test in this file cuts at, and before it
 * is the SSE wiring, which wants an EventSource. So the tail is loaded on its
 * own with `init` replaced by a rejection — the real handler, the real string,
 * the real `$`.
 */
const initFailure = async (lang, message) => {
  const h = harness(lang);
  const start = scrapeSource.indexOf('init().catch(');
  assert.ok(start !== -1, 'scrape.js must still guard init() with a catch');
  h.run(`init = () => Promise.reject(new Error(${JSON.stringify(message)}));`);
  await h.run(scrapeSource.slice(start));
  return h.nodes.get('bookmaker-list');
};

test('the failure banner asks the dictionary, so it follows the language', async () => {
  // This was the one place on the page that chose its language by reading
  // arbiterI18n.lang itself instead of asking for a string — so it could not
  // follow a language switch, and it duplicated a sentence the dictionary
  // already carried. The dictionary's own failedToLoadMsg said "Eroare la
  // încărcare" and "Error loading": a shorter, different sentence, translated
  // into two languages for nothing.
  const ro = await initFailure('ro', 'load failed');
  const en = await initFailure('en', 'load failed');
  assert.equal(ro.textContent, `${DICTS.ro.t('failedToLoadMsg')} load failed`);
  assert.equal(en.textContent, `${DICTS.en.t('failedToLoadMsg')} load failed`);
  assert.notEqual(ro.textContent, en.textContent, 'the banner is not one sentence in both languages');
  assert.doesNotMatch(ro.textContent, /failedToLoadMsg|Unable to load configuration/,
    'the Romanian page does not print the English sentence');
  assert.doesNotMatch(en.textContent, /Configurarea/, 'nor the English page the Romanian one');

  // The structural half: the comparison that made this un-switchable is gone,
  // so a third language cannot fall through to English by accident.
  assert.doesNotMatch(scrapeSource, /arbiterI18n\.lang\s*===|arbiterI18n\.lang\s*!==/,
    'this page no longer compares the language itself anywhere');

  // The banner has to be announced, or a screen reader passes over the one
  // message that says the page is broken.
  assert.equal(ro.attrs.role, 'alert');
});

test('every key the new readouts use exists in both languages', () => {
  // Two kinds of key on this page, checked against two different sources: the
  // ones the script names outright, and the ones the script reaches through a
  // value the config supplies.
  const literal = ['profileScopePrematch', 'profileScopeLivePast', 'runId', 'started',
    'finishedLabel', 'failedToLoadMsg', 'livePollPending', 'livePollLastSkip', 'schedulerResumed',
    'liveCapable', 'liveCapableShort', 'liveScopeMarket', 'liveScopeEvent',
    'liveStartedCount', 'liveStartedNone', 'liveNoField', 'liveNotMeasured',
    'capturedAt', 'pricesCount', 'pricesTruncated', 'pricesLiveCount', 'pricesPickBook',
    'pricesNoneForFilter', 'pricesNoCapture', 'pricesError', 'pricesLoading',
    'feedAdapter', 'feedDeepMode', 'feedDeepLimit', 'feedSmokeFloor'];
  const inMarkup = ['scrapeProgressTrack', 'jobs', 'configuration', 'progress',
    'bookPrices', 'limit', 'marketFilterHint', 'eventFilterHint'];
  for (const key of literal) {
    assert.ok(scrapeSource.includes(`'${key}'`), `scrape.js should ask for ${key}`);
  }
  for (const key of inMarkup) {
    assert.ok(scrapeHtml.includes(`"${key}"`), `scrape.html should carry ${key}`);
  }

  // The mode half, which is the one that cannot be read off the source: the
  // script calls t(profile.mode) and the key is whatever config/scan-profiles.json
  // happens to say. Checked against the config, so a fourth mode added there
  // without a dictionary entry fails here.
  for (const p of PROFILES) {
    assert.ok(p.mode, `${p.id} has no mode — profileLabel would fall back to its label`);
  }
  for (const key of [...literal, ...inMarkup, ...PROFILES.map((p) => p.mode)]) {
    for (const lang of ['ro', 'en']) assertTranslated(lang, key);
  }
});

// ---- the live poll's own status line ---------------------------------------

/**
 * `/api/live` ships three fields the line never drew: `pending` (the poll this
 * driver launched, not yet reported terminal), `lastSkippedAt`, and `resumed`.
 *
 * `pending` is the interesting one, because it cannot be printed as it stands.
 * LiveService clears `_pending` at the top of the next tick, not when the run
 * reports terminal, so it stays set for up to a full interval after the poll
 * has finished. A line that rendered it directly would claim a poll was running
 * for a minute after it completed — in the one direction that makes the readout
 * wrong exactly when someone is watching it. So it is confirmed against the
 * orchestrator state the page already holds, and every negative below sits next
 * to a positive that differs only in that one condition.
 */
const LIVE_BASE = {
  enabled: true,
  active: true,
  resumed: false,
  intervalSeconds: 60,
  liveMaxAgeMs: 90000,
  bookIds: [],
  scanningAllBooks: true,
  scanOptions: { includeLive: true },
  pending: null,
  lastRun: null,
  lastError: null,
  skippedTicks: 0,
  lastSkippedAt: null,
};

const live = (over = {}) => ({ ...LIVE_BASE, ...over });

/** Draw the line with the real function, the real dictionary and the real node. */
const liveLine = (lang, payload, state = null) => {
  const h = harness(lang);
  h.run(`lastState = ${JSON.stringify(state)}`);
  h.run(`renderLiveMeasured(${JSON.stringify(payload)}, arbiterI18n.t.bind(arbiterI18n))`);
  return h.nodes.get('live-measured').textContent;
};

const RUNNING = { status: 'running', runId: 'r7' };
const PENDING = { runId: 'r7', startedAt: '2026-09-30T10:00:00.000Z' };

test('a poll of this driver that is running right now is named on the line', () => {
  const line = liveLine('en', live({ pending: PENDING }), RUNNING);
  assert.match(line, /Live poll in flight since \d/,
    'the start time must come from the real dictionary with {time} substituted');

  // The control for this whole section: same payload, same page, one condition
  // changed. The orchestrator says the run is over, so the poll is not running.
  const settled = liveLine('en', live({ pending: PENDING }), { status: 'completed', runId: 'r7' });
  assert.doesNotMatch(settled, /in flight/,
    'a poll awaiting settlement on the next tick has already finished — saying otherwise is the lie this guards');
  // And it must still have drawn its other halves, or the negative above would
  // pass for the wrong reason.
  assert.match(settled, /Polls every book/);
});

test('a run this driver did not launch is not reported as its poll', () => {
  // Same running status, no pending: this is somebody's own scrape, and the
  // positive above is the same line with pending restored.
  const foreign = liveLine('en', live({ pending: null }), RUNNING);
  assert.doesNotMatch(foreign, /in flight/);
  assert.match(liveLine('en', live({ pending: PENDING }), RUNNING), /in flight/,
    'the guard must be the pending field and not the running status');
});

test('a pending poll naming a different run is not reported as the run in progress', () => {
  const line = liveLine('en', live({ pending: PENDING }), { status: 'running', runId: 'r9' });
  assert.doesNotMatch(line, /in flight/,
    'two concurrent runs exist; attributing the in-flight bit to the live driver would be a guess');
  assert.match(liveLine('en', live({ pending: PENDING }), { status: 'running', runId: 'r7' }), /in flight/,
    'the same run id must still be reported, so the guard is the id and not the status');
});

test('a missing run id on either side is not treated as a mismatch', () => {
  // `lastRun.runId` is written as `state.runId ?? null`, so null is a real
  // payload, not a fiction. Comparing it for equality would report "not running"
  // for a poll that plainly is.
  const noIds = liveLine('en', live({ pending: { runId: null, startedAt: PENDING.startedAt } }), { status: 'running', runId: null });
  assert.match(noIds, /in flight/);
  const oneSide = liveLine('en', live({ pending: PENDING }), { status: 'running', runId: null });
  assert.match(oneSide, /in flight/);

  // And the same for a payload that omits the field altogether, which is a
  // different thing from null to `!==`: undefined !== null is true, so a guard
  // written on the raw value calls an absent id a mismatch and the line goes
  // quiet exactly while a poll is running.
  const absentPending = liveLine('en', live({ pending: { startedAt: PENDING.startedAt } }), RUNNING);
  assert.match(absentPending, /in flight/, 'a pending poll with no runId at all is still this driver\'s poll');
  const absentBoth = liveLine('en', live({ pending: { startedAt: PENDING.startedAt } }), { status: 'running' });
  assert.match(absentBoth, /in flight/, 'and with no runId on the run either');
  const absentState = liveLine('en', live({ pending: PENDING }), { status: 'running' });
  assert.match(absentState, /in flight/, 'a run with no runId does not contradict a pending one');
});

test('a poll with no start time cannot be placed in time and is not claimed as running', () => {
  const line = liveLine('en', live({ pending: { runId: 'r7' } }), RUNNING);
  assert.doesNotMatch(line, /in flight/,
    'without a start time the line would have to print the dash, i.e. nothing about when');
  assert.match(liveLine('en', live({ pending: { runId: 'r7', startedAt: PENDING.startedAt } }), RUNNING), /in flight/);
});

test('the skip count carries the time of the last skip', () => {
  const withTime = liveLine('en', live({ skippedTicks: 4, lastSkippedAt: '2026-09-30T09:58:00.000Z' }));
  assert.match(withTime, /4 skipped/);
  assert.match(withTime, /last at \d/);

  // The counter is still there without the timestamp; only the time is dropped.
  const withoutTime = liveLine('en', live({ skippedTicks: 4, lastSkippedAt: null }));
  assert.match(withoutTime, /4 skipped/);
  assert.doesNotMatch(withoutTime, /last at/);
  // And a live driver with no skips at all says nothing about skipping.
  assert.doesNotMatch(liveLine('en', live({ skippedTicks: 0, lastSkippedAt: '2026-09-30T09:58:00.000Z' })), /skipped|last at/);
});

test('an unparseable last-skip time falls back to the dash rather than "Invalid Date"', () => {
  const line = liveLine('en', live({ skippedTicks: 1, lastSkippedAt: 'not-a-date' }));
  assert.match(line, /1 skipped/);
  assert.doesNotMatch(line, /Invalid Date/);
  assert.match(line, /last at —/);
});

test('a driver that was armed at startup says so, as the scheduler already does', () => {
  assert.match(liveLine('en', live({ resumed: true })), /resumed at startup/);
  assert.doesNotMatch(liveLine('en', live({ resumed: false })), /resumed at startup/);
  assert.match(liveLine('ro', live({ resumed: true })), /reluat la pornire/);
});

test('the in-flight half follows the orchestrator without asking the backend again', async () => {
  // The page deliberately does not poll /api/live on every scrape update — that
  // would be a request per book per tick — and it equally deliberately skips
  // refreshLive() while a run is in progress. Neither is allowed to cost the
  // "running right now" bit, so the transition re-draws from the cached payload.
  let calls = 0;
  const api = {
    async get(path) {
      if (path === '/api/live') { calls += 1; return live({ pending: PENDING, skippedTicks: 2, lastSkippedAt: '2026-09-30T09:58:00.000Z' }); }
      throw new Error(`unexpected GET ${path}`);
    },
  };
  const h = harness('en', { api });
  await h.run('refreshLive()');
  assert.equal(calls, 1, 'one read of /api/live');
  assert.doesNotMatch(h.nodes.get('live-measured').textContent, /in flight/,
    'nothing is running yet, so nothing may claim to be');

  // The same page, the same cached payload, one scrape-update later.
  await h.run(`renderState(${JSON.stringify({ status: 'running', runId: 'r7', summary: {}, jobs: [], options: {} })})`);
  assert.equal(calls, 1, 'the transition must not have re-read /api/live');
  assert.match(h.nodes.get('live-measured').textContent, /Live poll in flight since \d/,
    'this is the whole reason the cached payload exists');

  // And it must go away again when the run ends, or it would stick.
  await h.run(`renderState(${JSON.stringify({ status: 'completed', runId: 'r7', summary: {}, jobs: [], options: {} })})`);
  assert.doesNotMatch(h.nodes.get('live-measured').textContent, /in flight/);
  assert.match(h.nodes.get('live-measured').textContent, /2 skipped/,
    'the rest of the line survives the transition');
});

test('a payload with none of the three new fields renders exactly the old line', () => {
  // The regression control for the section: a driver mid-session with nothing
  // pending, nothing skipped and nothing resumed must say no more than it did.
  const line = liveLine('en', live({ lastRun: { durationMs: 70000, ok: true, at: '2026-09-30T09:00:00.000Z' } }));
  assert.match(line, /^Polls every book · Live window: 90s · Last measured poll: /);
  assert.doesNotMatch(line, /in flight|last at|resumed/);
  // A disabled driver draws nothing at all, as before.
  assert.equal(liveLine('en', live({ enabled: false, pending: PENDING })), '');
});

test('the poll says whether it is keeping up, in the service\'s own words', () => {
  // The two warnings on this line answer different questions and the page used
  // to be able to raise only one of them. `over the live window` compares the
  // measured poll with the 90s window a price lives in; `keepingUp` is the
  // service comparing it with the poll's own interval — the question its header
  // says it exists to answer, and it was computed on every settled poll and
  // published on this route with nothing reading it.
  //
  // The case that separates them: at the 60s default, a 75s poll is over its
  // interval and still inside the window. The page's own arithmetic called that
  // fine.
  const behind = liveLine('en', live({ lastRun: { durationMs: 75000, keepingUp: false, ok: true, at: '2026-09-30T09:00:00.000Z' } }));
  assert.match(behind, /Last measured poll: /);
  assert.match(behind, /not keeping up with its interval/);
  assert.doesNotMatch(behind, /over the live window/,
    '75s is inside the 90s window, so that warning is the one that does not apply');

  // Both at once, when the poll is over both: the duration first, then the two
  // verdicts in the order the line builds them.
  const both = liveLine('en', live({ lastRun: { durationMs: 95000, keepingUp: false, ok: true, at: '2026-09-30T09:00:00.000Z' } }));
  assert.match(both, /Last measured poll: [^·]*· over the live window · not keeping up with its interval/);

  // A poll that did keep up says neither, however long the window.
  const onTime = liveLine('en', live({ intervalSeconds: 120, lastRun: { durationMs: 85000, keepingUp: true, ok: true, at: '2026-09-30T09:00:00.000Z' } }));
  assert.doesNotMatch(onTime, /keeping up|over the live window/);

  // And the string is translated, not English in both dictionaries.
  assert.match(liveLine('ro', live({ lastRun: { durationMs: 75000, keepingUp: false, ok: true, at: '2026-09-30T09:00:00.000Z' } })),
    /nu ține pasul cu intervalul/);
});

test('a null payload clears the line instead of throwing', () => {
  // renderLiveMeasured is now also reachable from a scrape transition, which can
  // land before the first /api/live answer.
  const h = harness('en');
  h.run(`renderLiveMeasured(null, arbiterI18n.t.bind(arbiterI18n))`);
  assert.equal(h.nodes.get('live-measured').textContent, '');
});

test('the two new strings interpolate in both languages', () => {
  // Each half is matched on its OWN segment, with its own clock time. Asserting
  // "the line contains a time" would be satisfied by the in-flight half alone,
  // and a dictionary that dropped `{time}` from the skip string would go
  // unnoticed — which is exactly the mutation this section exists to catch.
  const shapes = {
    ro: { pending: /Rulare live în curs din \d{1,2}:\d\d/, skip: /\d+ saltate · ultima la \d{1,2}:\d\d/ },
    en: { pending: /Live poll in flight since \d{1,2}:\d\d/, skip: /\d+ skipped · last at \d{1,2}:\d\d/ },
  };
  for (const lang of ['ro', 'en']) {
    const line = liveLine(lang, live({ pending: PENDING, skippedTicks: 3, lastSkippedAt: '2026-09-30T09:58:00.000Z', resumed: true }), RUNNING);
    assert.doesNotMatch(line, /\{(time|count)\}/, `${lang} left a placeholder unexpanded`);
    assert.doesNotMatch(line, /\b(livePoll|liveWindow|scheduler)\w*/, `${lang} printed a key name`);
    assert.match(line, shapes[lang].pending, `${lang} in-flight string lost its time`);
    assert.match(line, shapes[lang].skip, `${lang} skip string lost its time`);
  }
});

// ---- the announced progress value -----------------------------------------

/**
 * Four jobs, one finished: the page's own arithmetic gives 25%.
 */
const quarterRun = {
  status: 'running',
  runId: 'r7',
  summary: { completed: 1, failed: 0, events: 10 },
  jobs: [
    { id: 'a', status: 'ok' },
    { id: 'b', status: 'running' },
    { id: 'c', status: 'running' },
    { id: 'd', status: 'running' },
  ],
  options: {},
};

test('the progress value a screen reader is given moves while the run does', async () => {
  const h = harness('en');
  await h.run(`renderState(${JSON.stringify(quarterRun)})`);

  // The visible number and the announced one are written from the same `pct`,
  // so they are asserted together: a fix that moved one and not the other would
  // still be a fix that lies to somebody.
  assert.equal(h.nodes.get('progress-pct').textContent, '25%');
  assert.equal(h.sel('.sl-progress-track[role="progressbar"]').attrs['aria-valuenow'], '25',
    'aria-valuenow never moved off the 0 scrape.html ships, because the selector named a class the page does not have');

  // The control: the other role="progressbar" on this page is the ring, which is
  // aria-hidden and driven from its own id. If the selector were loose enough to
  // catch it, the announced track would be the wrong element.
  assert.equal(h.nodes.get('progress-ring').attrs['aria-valuenow'], undefined,
    'the ring is aria-hidden and must not receive the announced value');
  assert.equal(h.nodes.get('progress-ring-pct').textContent, '25%',
    'and the ring still shows the same number by its own route');
});

test('the announced value follows the run to the end', async () => {
  const finished = {
    ...quarterRun,
    status: 'completed',
    jobs: quarterRun.jobs.map((j) => ({ ...j, status: 'ok' })),
  };
  const h = harness('en');
  await h.run(`renderState(${JSON.stringify(quarterRun)})`);
  assert.equal(h.sel('.sl-progress-track[role="progressbar"]').attrs['aria-valuenow'], '25');
  await h.run(`renderState(${JSON.stringify(finished)})`);
  assert.equal(h.sel('.sl-progress-track[role="progressbar"]').attrs['aria-valuenow'], '100',
    'a completed run must be announced as complete, not left at a quarter');
  assert.equal(h.nodes.get('progress-pct').textContent, '100%',
    'and the visible number must agree with the announced one');
});

test('the seam refuses a selector the markup cannot match', () => {
  // The guard that caught the `.progress` selector in the first place. If this
  // ever goes quiet, the harness has stopped being able to see that class of
  // defect, and the assertion above would pass against a node nobody has.
  assert.throws(
    () => harness('en').run("document.querySelector('.progress[role=\"progressbar\"]')"),
    /no element with class "progress"/,
  );
  // And the positive beside it: the selector the page really uses resolves.
  assert.doesNotThrow(() => harness('en').run("document.querySelector('.sl-progress-track[role=\"progressbar\"]')"));
});

// ---- the promotion gate's sport clause ---------------------------------------

/**
 * A predicate lifted out of the real orchestrator source, not retyped.
 *
 * Re-typing it here would defeat the purpose: these checks exist to catch the
 * page and the orchestrator drifting apart, and a hand-written stand-in agrees
 * with the page for ever no matter what the orchestrator does. So the arrow
 * function is cut out of `src/scrape-orchestrator.mjs` and evaluated as it
 * stands, which also means an edit there breaks this file loudly instead of
 * quietly making it vacuous.
 */
function liftFromOrchestrator(name) {
  const source = readFileSync(new URL('../src/scrape-orchestrator.mjs', import.meta.url), 'utf8');
  const head = `const ${name} = `;
  const decl = source.indexOf(head);
  assert.notEqual(decl, -1, `src/scrape-orchestrator.mjs no longer declares ${name}`);
  // The value starts at the parameter list, which sits BEFORE the arrow — so
  // the slice runs from there, not from the arrow itself.
  const start = decl + head.length;
  const arrow = source.indexOf('=>', decl);
  const semi = source.indexOf(';', arrow);
  const brace = source.indexOf('{', arrow);
  // An expression-bodied predicate has no braces of its own before its `;`;
  // a block-bodied one is matched out by depth so a brace inside cannot end it.
  if (brace === -1 || brace > semi) return source.slice(start, semi).trim();
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1).trim();
    }
  }
  throw new Error(`unbalanced braces while lifting ${name} out of the orchestrator`);
}

/** Ask the page's own gate about one job, under one sport, in a fresh context. */
const pageGate = (h, jobObj, sport, validated = [jobObj.id]) => h.run(
  `scrapers = ${JSON.stringify([jobObj])};`
  + `validatedIds = new Set(${JSON.stringify(validated)});`
  + `passesPromotionGate(scrapers[0], ${JSON.stringify(sport)})`
);

test('the gate is three conditions, and removing any one of them lets a book through', () => {
  const h = harness('en');
  const ok = job({ id: 'admiral', name: 'Admiral', supportedSports: ['football'] });
  // The positive every negative below is measured against.
  assert.equal(pageGate(h, ok, 'football'), true, 'a book clearing all three runs');

  assert.equal(pageGate(h, { ...ok, enabled: false }, 'football'), false, 'a disabled book is out');
  assert.equal(pageGate(h, ok, 'football', []), false, 'a book that is not validated is out');
  assert.equal(pageGate(h, ok, 'tennis'), false, 'a book that declares another sport is out');

  // `enabled` is compared with `!== false`, so an absent flag means on — the
  // same reading the orchestrator gives it. Pinned because turning this into
  // `if (!job.enabled)` would silently disable every job that omits the key.
  assert.equal(pageGate(h, { ...ok, enabled: undefined }, 'football'), true,
    'a job that omits `enabled` is not disabled');
});

test('a book that declares no sport is not excluded, and a malformed one is not crashed on', () => {
  const h = harness('en');
  // 25 of the 26 real jobs declare `["football"]`; `unibet` declares nothing at
  // all, and it is the single job that survives every filter the orchestrator
  // applies. Absence is not a refusal, and the page has to read it the same way
  // or it would empty the selection the moment any sport is chosen.
  const undeclared = job({ id: 'unibet', name: 'Unibet' });
  assert.equal(pageGate(h, undeclared, 'tennis'), true, 'no declaration at all still runs');
  assert.equal(pageGate(h, { ...undeclared, supportedSports: [] }, 'tennis'), true,
    'an empty list is the same claim, not a refusal of everything');
  // Config written by hand can hold anything. None of these may throw, and none
  // may read as a refusal.
  assert.equal(pageGate(h, { ...undeclared, supportedSports: 'football' }, 'tennis'), true,
    'a bare string is not an array and is treated as undeclared');
  assert.equal(pageGate(h, { ...undeclared, supportedSports: null }, 'tennis'), true, 'nor is null');

  // And beside all of those, a real declaration is still honoured in both
  // directions — otherwise the four assertions above would pass just as well
  // if the clause ignored `supportedSports` completely.
  assert.equal(pageGate(h, { ...undeclared, supportedSports: ['tennis'] }, 'tennis'), true,
    'a book declaring the chosen sport runs');
  assert.equal(pageGate(h, { ...undeclared, supportedSports: ['football'] }, 'tennis'), false,
    'a book declaring only another sport does not');

  // No filter at all: the clause stands down, whatever the book declares.
  assert.equal(pageGate(h, { ...undeclared, supportedSports: ['football'] }, ''), true,
    'an empty filter runs a book that declares football');
  assert.equal(pageGate(h, { ...undeclared, supportedSports: ['football'] }, null), true,
    'and so does a null filter');
});

test('on the real registry the page and the orchestrator pick exactly the same books', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
  const jobs = cfg.jobs || [];
  assert.ok(jobs.length > 0, 'the real registry is readable — a fixture instead would not prove drift');
  const h = harness('en');
  // Both lifted predicates, renamed so the page's own `jobMatchesSport` is not
  // redeclared. The lifted body closes over `sportFilter`, which is set per
  // iteration below — exactly the binding it has in the orchestrator.
  h.run(`var orchJobMatchesSport = ${liftFromOrchestrator('jobMatchesSport')};`
    + `var orchIsValidated = ${liftFromOrchestrator('isValidated')};`);
  h.run(`scrapers = ${JSON.stringify(jobs)};`
    + `validatedIds = new Set(${JSON.stringify(jobs.filter((j) => j.validationStatus === 'validated').map((j) => j.id))});`);

  for (const sport of [null, '', 'football', 'tennis', 'basketball']) {
    h.run(`sportFilter = ${JSON.stringify(sport)};`);
    // The orchestrator's own filter line, with its own predicates in scope.
    const backend = h.run('scrapers.filter((job) => job.enabled !== false'
      + ' && orchIsValidated(job) && orchJobMatchesSport(job)).map((job) => job.id).sort().join(",")');
    const frontend = h.run('scrapers.filter((job) => passesPromotionGate(job, sportFilter))'
      + '.map((job) => job.id).sort().join(",")');
    assert.equal(frontend, backend, `the two gates agree with sport=${sport}`);
  }

  // Not vacuous: the comparison above would also pass if both sides returned
  // nothing, and it would have passed before the fix because the two predicates
  // were compared rather than the two gates. So the old two-condition filter is
  // run here and is required to DISAGREE on the sports the registry does not
  // carry — which is the defect this closes, stated as a fact about the real
  // config rather than about a fixture.
  for (const sport of ['tennis', 'basketball']) {
    h.run(`sportFilter = ${JSON.stringify(sport)};`);
    const oldCount = h.run('scrapers.filter((job) => job.enabled !== false && validatedIds.has(job.id)).length');
    const newCount = h.run('scrapers.filter((job) => passesPromotionGate(job, sportFilter)).length');
    assert.ok(oldCount > newCount,
      `with sport=${sport} the old filter really did over-select (${oldCount} -> ${newCount})`);
  }
  // The positive beside that negative: on the one sport the registry carries,
  // the old filter and the gate agree, because there is nothing to disagree about.
  h.run('sportFilter = "football";');
  assert.equal(
    h.run('scrapers.filter((job) => job.enabled !== false && validatedIds.has(job.id)).length'),
    h.run('scrapers.filter((job) => passesPromotionGate(job, sportFilter)).length'),
    'on football the gate changes nothing, which is why the defect stayed latent',
  );
});

test('the default selection is derived after the sport filter exists', () => {
  // `init()` needs five routes and a real dropdown, so — as with the profile
  // listener above — the wiring is pinned as source. What is pinned here is an
  // ORDER, and that is the part a "does the line exist" check cannot see:
  // createDropdown writes the persisted sport into the form, so a derivation
  // placed above it reads "" and pre-selects the unfiltered set whatever the
  // operator last chose. Both lines existing proves nothing about this.
  const dropdown = scrapeSource.indexOf("createDropdown('sport-filter'");
  const derivation = scrapeSource.indexOf('selectedIds = new Set(scrapers.filter((s) => passesPromotionGate(s))');
  assert.notEqual(dropdown, -1, 'the sport dropdown is still built');
  assert.notEqual(derivation, -1, 'the default selection still comes from the promotion gate');
  assert.ok(derivation > dropdown,
    'and it is derived after the dropdown has applied the persisted sport');
  // And it reads the live form rather than a sport written into the call. A
  // hardcoded '' there is the same defect as the wrong ordering — both make the
  // gate consult an empty filter — and an ordering check alone would not see it.
  assert.doesNotMatch(scrapeSource, /passesPromotionGate\(\s*s\s*,\s*['"]['"]\s*\)/,
    'the default selection is gated on the sport currently chosen');
  // The two-condition filter it replaced is gone, not merely bypassed — otherwise
  // the ordering above would be irrelevant.
  assert.equal((scrapeSource.match(/s\.enabled !== false && validatedIds\.has\(s\.id\)/g) || []).length, 0);
  assert.match(scrapeSource, /addEventListener\('change', onSportFilterChange\)/,
    'and the gate is re-applied when the operator changes the filter');
});

test('the gate and the POST body read one sport, normalised the same way', () => {
  // The orchestrator normalises whatever arrives on the wire —
  // `String(scanOptions?.sport).trim().toLowerCase()` — so a form value that
  // is not already a registry id has to be folded the same way here. The page
  // used to have two answers: the gate normalised a copy of the form value and
  // the payload shipped the raw one, so the page could gate on `football` while
  // the backend ran whatever the operator actually typed.
  const h = harness('en', { form: { 'sport-filter': { value: '  Football  ' } } });
  assert.equal(h.run('var sport = currentSport(); sport'), 'football',
    'the form value is trimmed and lowercased once');
  assert.match(h.run('JSON.stringify(currentScanOptions())'), /"sport":"football"/,
    'and the payload carries that same string rather than the raw form value');
  // The positive the two normalisation mutants would break: a book declaring
  // lowercase `football` still passes under the normalised value.
  assert.equal(h.run(
    `scrapers = ${JSON.stringify([job({ id: 'admiral', supportedSports: ['football'] })])};`
    + 'validatedIds = new Set(["admiral"]); passesPromotionGate(scrapers[0], sport)'
  ), true, 'so a book that declares football in lowercase still runs');

  // The empty case still reads as "no filter" on both paths, which is what the
  // scheduler comparison depends on.
  const g = harness('en', { form: { 'sport-filter': { value: '' } } });
  assert.equal(g.run('currentSport()'), '');
  assert.equal('sport' in JSON.parse(g.run('JSON.stringify(currentScanOptions())')), false,
    'an empty sport is absent from the payload, not sent as an empty string');
});

test('a sport change only ever removes books from the selection', () => {
  const books = [
    job({ id: 'admiral', name: 'Admiral', supportedSports: ['football'] }),
    // The one real job with no declaration: it must survive the same change
    // that drops the other two, or the page is applying a different rule than
    // the orchestrator after all.
    job({ id: 'unibet', name: 'Unibet', supportedSports: undefined }),
    job({ id: 'winbet', name: 'Winbet', supportedSports: ['football'] }),
  ];
  // `ghost` has no job behind it at all: the orchestrator would refuse it as
  // "not in the registry", so a stale id must not keep the run from starting.
  const h = harness('en', { form: { 'sport-filter': { value: 'tennis' } } });
  h.run(`scrapers = ${JSON.stringify(books)};`
    + `validatedIds = new Set(["admiral", "unibet", "winbet"]);`
    + `jobById = new Map(); selectedIds = new Set(["admiral", "unibet", "winbet", "ghost"]);`
    + `renderBookmakerChips()`);
  h.nodes.get('bookmaker-list').innerHTML = 'SENTINEL';
  h.run('onSportFilterChange()');
  const after = h.run('JSON.stringify([...selectedIds].sort())');
  assert.deepEqual(JSON.parse(after), ['unibet'],
    'the two football books and the id with no job are gone; the undeclared one stays');
  // The removal reached the screen, so this is not a set that moved under a
  // stale render. The redraw is what makes the count agree with the checkboxes.
  assert.notEqual(h.list(), 'SENTINEL', 'and the chips were redrawn');
  assert.doesNotMatch(h.list(), /data-source="admiral"\s+checked/, 'a dropped book is unticked on screen');
  assert.match(h.list(), /data-source="unibet"\s+checked/, 'and a surviving book stays ticked');
  // The stub keeps `textContent` as whatever was written, and the page writes
  // a number here, so the comparison goes through String() rather than pinning
  // a coercion the browser would have done for us.
  assert.equal(String(h.nodes.get('bm-selected').textContent), '1', 'the count follows the selection');

  // The other direction, which is the one that would destroy work: changing
  // the filter must not put a book back that the operator had unticked.
  const g = harness('en', { form: { 'sport-filter': { value: 'football' } } });
  g.run(`scrapers = ${JSON.stringify(books)};`
    + `validatedIds = new Set(["admiral", "unibet", "winbet"]);`
    + `jobById = new Map(); selectedIds = new Set(["unibet"]);`
    + `renderBookmakerChips()`);
  g.nodes.get('bookmaker-list').innerHTML = 'SENTINEL';
  const kept = g.run('onSportFilterChange(); JSON.stringify([...selectedIds].sort())');
  assert.deepEqual(JSON.parse(kept), ['unibet'],
    'every declared football book passes, and none of them is re-ticked');
  // And a change that removes nothing leaves the DOM alone: no redraw, because
  // there is nothing to redraw. The first test above is the positive for this.
  assert.equal(g.list(), 'SENTINEL', 'a filter change that removes nothing does not redraw the chips');
});

/**
 * scrape-chip-tooltip.test.mjs — what the bookmaker chip tells you about a book.
 *
 * `/api/scrapers` hands the page 19 fields per job and the chip used to render
 * four of them. This covers the two that were reachable and dropped, and the
 * one that is deliberately not shown — a test that cannot fail measures
 * nothing, and a comment saying "we left feedStatus out on purpose" is not a
 * test.
 *
 * The page is loaded the way the other frontend tests load it: the real
 * source, the real escaper from common.js and the real i18n dictionary, cut
 * before the first line that binds an event listener. Nothing about the
 * tooltip is re-implemented here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const scrapeSource = readFileSync(new URL('../public/js/pages/scrape.js', import.meta.url), 'utf8');
const commonSource = readFileSync(new URL('../public/js/pages/common.js', import.meta.url), 'utf8');
const i18nSource = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');

/** The real dictionary, per language, loaded the way the page loads it. */
function dictionaries() {
  const out = {};
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
    vm.runInContext(i18nSource, context);
    assert.equal(context.arbiterI18n.lang, lang, 'the dictionary really loaded in the language under test');
    out[lang] = context.arbiterI18n;
  }
  return out;
}
const DICTS = dictionaries();

/** The markup's own id set, so a missing element is a failure, not a silent pass. */
const scrapeHtml = readFileSync(new URL('../public/admin/scrape.html', import.meta.url), 'utf8');
const PAGE_IDS = new Set([...scrapeHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

function harness(lang = 'ro') {
  const nodes = new Map();
  const node = (id) => {
    if (!PAGE_IDS.has(id)) throw new Error(`scrape.html has no #${id} — the page and this test have drifted`);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        innerHTML: '',
        value: '',
        checked: false,
        dataset: {},
        hidden: false,
        className: '',
        appendChild() {},
        querySelectorAll: () => [],
      });
    }
    return nodes.get(id);
  };
  const document = {
    getElementById: node,
    createElement: () => ({ className: '', appendChild() {} }),
    // After writing the chips the page re-queries them to attach the filter
    // handler. Nothing is parsed here, so an empty list is the honest answer:
    // the assertions are on the markup this function produced, which is
    // captured on `bookmaker-list` before any of this runs.
    querySelectorAll: () => [],
  };
  const context = vm.createContext({ document, console, localStorage: { getItem: () => null, setItem() {} } });
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
  vm.runInContext(scrapeSource.slice(0, scrapeSource.indexOf("$('run-btn').addEventListener")), context);
  return {
    nodes,
    run: (code) => vm.runInContext(code, context),
    list: () => nodes.get('bookmaker-list').innerHTML,
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
    for (const lang of ['ro', 'en']) {
      const value = DICTS[lang].t(key);
      assert.notEqual(value, key, `${lang} is missing the ${key} key — t() would print the key itself`);
    }
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

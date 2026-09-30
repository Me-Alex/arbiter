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

function harness(lang = 'ro', { api, form } = {}) {
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
        // The form the page reads its scan options out of. Seeded from the
        // fixture rather than left blank, because `currentScanOptions()`
        // coerces with Number() and an all-empty form would compare equal to a
        // stored object of zeroes — a diff that can never fire.
        ...(form && form[id] ? form[id] : {}),
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
  const context = vm.createContext({
    document,
    console,
    localStorage: { getItem: () => null, setItem() {} },
    // The real api.js is an IIFE over fetch; only the scheduler readouts are
    // under test, so the seam is the one global it installs.
    ...(api ? { arbiterApi: api } : {}),
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

test('every key the scheduler readout uses exists in both languages', () => {
  for (const key of ['skippedShort', 'schedulerBooks', 'schedulerResumed', 'schedulerScanDiffers',
    'yesShort', 'noShort', 'okShort', 'failedShort', 'neverRan', 'lastRun']) {
    for (const lang of ['ro', 'en']) {
      const value = DICTS[lang].t(key);
      assert.notEqual(value, key, `${lang} is missing ${key} — t() would print the key itself`);
    }
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

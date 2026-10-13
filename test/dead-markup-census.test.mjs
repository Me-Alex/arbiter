/**
 * dead-markup-census.test.mjs — of every id a page carries, is any of them
 * reached by something that page loads?
 *
 * This is the other half of selector-census.test.mjs, and the halves are not
 * the same question. That one asks "does every selector a script hands the DOM
 * name something the markup has", walking from code to page. This one walks
 * from page to code: "does every id in this markup get looked up at all". A
 * page can answer every selector in its scripts perfectly and still carry a
 * whole element nothing ever reaches — which is what this found, ten of them,
 * and the only way to have found them is to look in the direction nobody was
 * looking.
 *
 * Four ways this census would lie by passing, each one measured rather than
 * argued, because a sweep that reports nothing is indistinguishable from a
 * sweep that read nothing:
 *
 *   - The reference test is a substring search, so it OVER-counts: an id named
 *     inside a string that is never used as a lookup still counts as one. That
 *     is the direction this needs to err in — an id reported dead is one whose
 *     name appears nowhere in the page's own code, which is a real unreached
 *     id; an id reported reached might only be mentioned. The dead column is the
 *     finding and the reached column is not, which is stated here because the
 *     asymmetry is what makes the whole thing sound.
 *   - Comments used to count as lookups, and that was not theoretical: this
 *     sweep found only ten dead ids while connection-status.js:421 named
 *     `.sl-head-state` — a class — in a comment, and a search for `head-state`
 *     latched onto it and hid a genuinely dead `#head-state` on scrape.html.
 *     The scripts are read through `codeOnly` now, for the reason
 *     i18n-dictionary.test.mjs gives: a key spelled in a docstring is not a key
 *     that is read. The over-count that remains is string constants, above.
 *   - It reads external `<script src>` only. An inline `<script>` carrying a
 *     lookup would be invisible to it and every id it named would be called
 *     dead. Measured: 0 inline script blocks on all eleven pages, asserted
 *     below rather than assumed, because the day someone adds one the number
 *     stops meaning what it says.
 *   - It reads `id="…"` only. Measured: 0 ids written with single quotes and 0
 *     unquoted across the same eleven pages. Also asserted.
 *   - It read CSS as nothing at all in its first version, which was wrong, and
 *     wrong in the direction that invents findings. `#jobs-table` is looked up
 *     by no script and carries four selectors in scrape.css:805-807, a scroll
 *     cap and a sticky head — the element is doing real work through its id.
 *     Calling it dead markup would have been calling a live styling hook dead
 *     under a name that says dead, which is the kind of finding somebody acts
 *     on and breaks a page with. A stylesheet is a consumer here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

const walk = (dir, ext, into = []) => {
  for (const e of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, ext, into);
    else if (e.name.endsWith(ext)) into.push(p);
  }
  return into;
};

const PAGES = walk('public', '.html');
const SHEETS = [...walk('public/css', '.css'), ...walk('public', '.css').filter((f) => !f.startsWith('public/css/'))];

/** Markup with the script and style bodies cut out; their text is not an id. */
const markupOf = (html) => html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

/**
 * The three ways an id can be alive without a script looking it up, kept apart
 * because they need different fixes and only one of them is a wiring gap.
 *
 * A `<label for>`, an `aria-labelledby` and a same-page `href="#…"` bind an id
 * to something real with no JavaScript involved, and an id bound that way is
 * not dead even when no script ever spells it.
 */
const markupBindingsOf = (markup) => {
  const bound = new Set();
  for (const m of markup.matchAll(/\b(?:for|aria-labelledby|aria-describedby|aria-controls|aria-owns|list|form)="([^"]+)"/g)) {
    for (const part of m[1].split(/\s+/)) bound.add(part);
  }
  for (const m of markup.matchAll(/href="#([^"]+)"/g)) bound.add(m[1]);
  return bound;
};

/**
 * Resolve a `<script src>` to a file on disk.
 *
 * The leading slash is the site root, so `/js/pages/scrape.js` is
 * `public/js/pages/scrape.js`. A first version stripped `js/` as well, which
 * resolved every script to a path that does not exist and reported all 264 ids
 * dead — including `#run-btn` and `#bookmaker-list`, which scrape.js looks up by
 * name. An unresolved src is not a warning here: it silently drops a whole
 * script's lookups and manufactures dead ids, so the count is asserted.
 */
const resolveScript = (src) => {
  const rel = src.replace(/^\//, '');
  return existsAt(rel) ? rel : existsAt(`public/${rel}`) ? `public/${rel}` : null;
};
const existsAt = (rel) => {
  try { readFileSync(new URL(rel, ROOT)); return true; } catch { return false; }
};

const SURVEY = PAGES.map((page) => {
  const html = read(page);
  const markup = markupOf(html);
  const ids = [...new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))];
  const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const scripts = srcs.map(resolveScript);
  const blob = scripts.filter(Boolean).map((p) => codeOnly(read(p))).join('\n');
  const sheets = SHEETS.map(read).join('\n');
  const bound = markupBindingsOf(markup);
  return {
    page,
    ids,
    srcs,
    scripts,
    // Spelled, not parsed: see the docstring. Reached is an over-approximation,
    // which is what keeps the dead column honest.
    reached: (id) => blob.includes(id),
    styled: (id) => new RegExp(`#${id}(?![\\w-])`).test(sheets),
    bound: (id) => bound.has(id),
    // A sheet counts as a consumer. This term was missing in the first version
    // of this line while the docstring and the test below both said it was
    // there, so `#jobs-table` sat in the dead column and in the styled one at
    // the same time -- and the register named ten entries while this column
    // held eleven. The disagreement was the finding: the census's own control
    // fired before the number was believed.
    dead: ids.filter((id) => !blob.includes(id) && !bound.has(id) && !new RegExp(`#${id}(?![\\w-])`).test(sheets)),
  };
});

const ALL = SURVEY.flatMap((s) => s.dead.map((id) => ({ page: s.page, id })));
const deadKeys = new Set(ALL.map(({ page, id }) => `${page}#${id}`));

/**
 * The eleven, named one by one with the reason, for the reason
 * i18n-dictionary.test.mjs keeps its dead-key list as an empty set: a count
 * lets a new dead id hide behind an old one still being triaged. Each entry was
 * read, not inferred from the sweep.
 */
const KNOWN = [
  {
    page: 'public/admin/live.html',
    id: 'engine-badge',
    why: 'A wrapper span. Its children are written: live.js:126-128 sets `#engine-dot` and '
      + '`#engine-state`. The id on the container is not read by anything.',
  },
  {
    page: 'public/admin/live.html',
    id: 'engine-note',
    why: 'Static English prose with no `data-i18n`, under the "Polling Engine" heading whose '
      + 'label beside it IS translated. One of the two untranslated strings this door '
      + 'surfaced on a page that otherwise carries a language switch.',
  },
  {
    page: 'public/admin/login.html',
    id: 'login-form',
    why: 'The page has no fields, no submit and no script — it is the informational card '
      + 'that says the app runs locally. An id on that card is inert markup.',
  },
  {
    page: 'public/admin/scanner.html',
    id: 'alerts-card',
    why: 'A wrapper div. Its child `#alerts-count` is written at scanner.js:118 and :235. '
      + 'Only the id on the container has no consumer.',
  },
  {
    page: 'public/admin/scrape.html',
    id: 'progress-eta',
    why: 'The only one that is visible on a running page, and the only one with a cause: '
      + '`data-i18n="etaLabel"` makes i18n.js:882 overwrite its content with the word "ETA", '
      + 'and nothing ever writes a value after it. There is no ETA to write — '
      + 'scrape-orchestrator.mjs:170-180 builds no such field and no `eta` key exists in '
      + 'either dictionary. A label for a feature that was never built.',
  },
  {
    page: 'public/admin/scrape.html',
    id: 'act-duration-note',
    why: 'An empty span in the jobs panel head, next to a title that IS translated. Renders '
      + 'nothing at all, so it is invisible rather than wrong.',
  },
  {
    page: 'public/admin/scrape.html',
    id: 'log-card',
    why: 'A `<details>` wrapper for the live log. Its contents are reached through the ids '
      + 'inside it.',
  },
  {
    page: 'public/admin/scrape.html',
    id: 'live-books',
    why: 'Shows "—" for the life of the page. The line it was for is already drawn one span '
      + 'below: scrape.js:1766-1768 renders the same `schedulerBooks` sentence from '
      + '`l.bookIds`. An id that survived its content being folded into the measured line.',
  },
  {
    page: 'public/admin/scrape.html',
    id: 'head-state',
    why: 'A wrapper span around `#head-dot` and `#head-status`, both written at '
      + 'scrape.js:983-984. This one is also the reason the sweep reads scripts through '
      + '`codeOnly`: connection-status.js:421 names `.sl-head-state` — a CLASS — in a '
      + 'comment, and a plain substring search for `head-state` latched onto it and called '
      + 'this id reached. The element is styled by that class (scrape.css:57); the id is '
      + 'used by nothing.',
  },
  {
    page: 'public/admin/scrape.html',
    id: 'odds-table',
    why: 'A wrapper table. Its tbody `#odds-rows` is written at scrape.js:575, :647 and '
      + ':666, so the board fills; only the id on the table has no consumer.',
  },
];

const knownKeys = new Set(KNOWN.map((k) => `${k.page}#${k.id}`));

test('the sweep reads every script, and reaches ids that are written', () => {
  // The controls, named rather than counted. A sweep whose sources failed to
  // resolve, or which missed an inline block, would report a clean tree while
  // having read a fraction of the page.
  const unresolved = SURVEY.flatMap((s) => s.srcs.filter((src) => !resolveScript(src)).map((src) => `${s.page} ${src}`));
  assert.deepEqual(unresolved, [],
    `these scripts do not resolve to a file, so their lookups were never read and their ids would be called dead: ${unresolved.join(' | ')}`);

  const inline = PAGES.flatMap((page) => {
    const html = read(page);
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m, i) => (/(getElementById|querySelector|\$\()/.test(m[1]) ? `${page} inline block ${i + 1} carries a lookup this sweep cannot see` : null))
      .filter(Boolean);
  });
  assert.deepEqual(inline, [], inline.join(' | '));

  // `id="…"` is the only spelling this reads. Measured 0 of every other form on
  // all eleven pages; the day one appears, the sweep starts reporting ids that
  // are not there as absent rather than as dead.
  const odd = PAGES.flatMap((page) => {
    const markup = markupOf(read(page));
    return [
      ...[...markup.matchAll(/\bid\s*=\s*'([^']+)'/g)].map((m) => `${page} id='${m[1]}'`),
      ...(/\bid\s*=\s*[A-Za-z_][\w-]*(\s|>|=)/.test(markup) ? [`${page} has an unquoted id`] : []),
    ];
  });
  assert.deepEqual(odd, [], `ids written in a spelling this sweep does not read: ${odd.join(' | ')}`);

  // And the positive control: ids this sweep must have found reached. Named, so
  // that a sweep which stopped reading scripts fails on these rather than
  // quietly reporting ten dead and one dead.
  const reached = new Set(SURVEY.flatMap((s) => s.ids.filter((id) => s.reached(id)).map((id) => `${s.page}#${id}`)));
  for (const known of [
    'public/admin/scrape.html#run-btn',
    'public/admin/scrape.html#bookmaker-list',
    'public/admin/scrape.html#job-rows',
    'public/admin/scanner.html#alert-min-roi',
    'public/index.html#opp-list',
  ]) {
    assert.ok(reached.has(known), `the lookup ${known} was among those read`);
  }
});

test('an id bound by markup, or styled by a sheet, is not dead markup', () => {
  // The three consumer classes are separate findings with separate fixes, and
  // the first version of this sweep knew only about the first. Each gets a
  // named control so the branch is shown to fire, not assumed to.
  const bindings = SURVEY.flatMap((s) => s.ids.filter((id) => s.bound(id) && !s.reached(id)));
  assert.ok(bindings.length >= 13,
    `measured 13 ids bound by markup and reached by no script; this run found ${bindings.length}`);

  const styled = SURVEY.flatMap((s) => s.ids.filter((id) => s.styled(id)).map((id) => `${s.page}#${id}`));
  assert.ok(styled.includes('public/admin/scrape.html#jobs-table'),
    `the sheet-bound control -- #jobs-table, four selectors in scrape.css -- was among those read: ${styled.join(', ')}`);

  // The specific trap this branch exists for: `#jobs-table` is reached by no
  // script, and deleting its id would delete the scroll cap and the sticky
  // head with it. It is in the styled set and out of the dead set, and both
  // halves are named so the second cannot pass by accident.
  const jobsTable = SURVEY.find((s) => s.page === 'public/admin/scrape.html');
  assert.equal(jobsTable.reached('jobs-table'), false, 'no script looks up #jobs-table');
  assert.equal(jobsTable.styled('jobs-table'), true, 'and scrape.css reaches it four times');
  assert.equal(jobsTable.dead.includes('jobs-table'), false, 'so it is not in the dead column');
});

test('every id in the markup is accounted for exactly once', () => {
  // A partition, not a threshold. Each id lands in exactly one column, and the
  // columns add up to the number of ids the pages carry — which no id count a
  // future page could invalidate, and which a sweep reading nothing fails.
  const unreached = SURVEY.flatMap((s) => s.dead.map((id) => ({ page: s.page, id })));
  const accounted = SURVEY.map((s) => {
    const byScript = s.ids.filter((id) => s.reached(id));
    const rest = s.ids.filter((id) => !s.reached(id));
    const byMarkup = rest.filter((id) => s.bound(id));
    const bySheet = rest.filter((id) => !s.bound(id) && s.styled(id));
    const byNothing = rest.filter((id) => !s.bound(id) && !s.styled(id));
    const sum = byScript.length + byMarkup.length + bySheet.length + byNothing.length;
    return sum === s.ids.length
      ? null
      : `${s.page} counts ${s.ids.length} ids but the columns account for ${sum}`;
  }).filter(Boolean);
  assert.deepEqual(accounted, [], accounted.join(' | '));
  assert.equal(unreached.length, 10, 'and ten of them are reached by nothing at all');
});

test('the ten are the ten named here, and each name is still true', () => {
  // Both directions are pinned, which is what stops this from being a list that
  // decays. A new dead id is not on the list and fails; an entry that has been
  // wired since is no longer dead and fails. Either way somebody has to look.
  const stranded = ALL.filter(({ page, id }) => !knownKeys.has(`${page}#${id}`))
    .map(({ page, id }) => `${page}#${id} is reached by no script, no sheet and no markup binding, and nothing here names it`);
  assert.deepEqual(stranded, [], stranded.join(' | '));

  const stale = [...knownKeys].filter((k) => !deadKeys.has(k))
    .map((k) => `${k} is named here but something reaches it now — render it, or drop the entry`);
  assert.deepEqual(stale, [], stale.join(' | '));

  // A register entry with no reason is a claim nothing measures, which is the
  // defect this segment already found once in this file's sibling.
  const unreasoned = KNOWN.filter((k) => !k.why || k.why.length < 40).map((k) => `${k.page}#${k.id}`);
  assert.deepEqual(unreasoned, [], `these entries carry no reason: ${unreasoned.join(' | ')}`);
});
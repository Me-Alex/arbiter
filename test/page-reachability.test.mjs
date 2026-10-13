/**
 * page-reachability.test.mjs — of every page under public/, can a user get
 * there?
 *
 * A page can satisfy every other test in this tree and still be unreachable.
 * Its script loads, `page-scripts.test.mjs` is green on it, its routes have
 * frontend consumers so `api-surface` calls it covered, and none of that is a
 * page anyone has ever opened. This is the page-level analogue of the defect
 * `api-surface.test.mjs` looks for on the route side — there, a capability
 * nothing asks for; here, a page nothing navigates to — and it was not measured
 * anywhere.
 *
 * Three ways a naive sweep of it invents findings, all three found by running
 * one:
 *
 *   - The sidebar is BUILT, not written. `app.js:68-94` holds a `groups` array
 *     of `{ href: '/admin/…html' }` items that `buildSidebar` renders, and not
 *     one of those nine pages is the target of a literal `href` in any markup.
 *     A sweep reading only `href="…"` in HTML reported eight unreachable pages
 *     out of eleven; nine of the eleven are reached by the very list that sweep
 *     could not see.
 *   - A link can be composed. `dashboard.js:485` builds `/event.html?${params}`
 *     at render time, so the bookmarkable detail page has no static link
 *     either. The page name still appears in a navigation expression, and a
 *     sweep that reads only static attributes calls it unreachable.
 *   - Comments are not navigation. `login.html` is named in three comments —
 *     `common.js:160`, `settings.js:9`, `settings.html:22` — all of them
 *     explaining what the page says. A substring search over source credits all
 *     three and reports the one genuinely orphaned page as linked. So the
 *     sources are read through `codeOnly`, for the reason
 *     `i18n-dictionary.test.mjs` gives: a name spelled in a comment is not a
 *     link that is followed.
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

const PAGES = walk('public', '.html').map((p) => p.replace(/\\/g, '/')).sort();
const SCRIPTS = walk('public/js', '.js').map((p) => p.replace(/\\/g, '/')).sort();
const APP = read('public/js/app.js');

/**
 * The shapes that actually move a browser, as (file, code) pairs.
 *
 * Markup links first, then the script forms. The sidebar's own `href:` keys are
 * read separately below rather than through a generic `href=` pattern, because
 * in app.js they are object properties, not markup — a pattern that wanted
 * `href="…"` would miss all nine and one that wanted `href:` would match the
 * hand-written rows `buildSidebar` emits for the same nine pages.
 */
const navSources = [
  ...PAGES.map((p) => [p, read(p)]),
  ...SCRIPTS.map((p) => [p, codeOnly(read(p))]),
  ['public/js/app.js (sidebar data)', codeOnly(APP)],
];

/**
 * What each page is called in a link.
 *
 * The dashboard is the one page never named by its file: every link to it is
 * the site root, `/`. Treating that as "index.html is unreferenced" would be a
 * false orphan on the app's front page, so the two names are both accepted for
 * it and nothing else is aliased.
 */
const namesFor = (page) => {
  const base = page.replace(/^public\//, '');
  return base === 'index.html' ? ['index.html', '/'] : [base, `/${base}`];
};

/** Every navigation expression in the tree, as the strings they can produce. */
const linkTargets = [];
for (const [file, code] of navSources) {
  for (const m of code.matchAll(/\bhref\s*=\s*(['"`])([^'"`]+)\1/g)) linkTargets.push([file, m[2]]);
  for (const m of code.matchAll(/\bhref\s*:\s*(['"`])([^'"`]+)\1/g)) linkTargets.push([file, m[2]]);
  for (const m of code.matchAll(/location\.(?:href|assign|replace)\s*=\s*(['"`])([^'"`]+)\1/g)) linkTargets.push([file, m[2]]);
  for (const m of code.matchAll(/\b(?:window\.)?open\(\s*(['"`])([^'"`]+)\1/g)) linkTargets.push([file, m[2]]);
  // A composed link: any string or template literal that starts at the site
  // root. `dashboard.js:485` writes `` `/event.html?${params}` ``, so the
  // interpolation is NOT adjacent to the file name — an earlier version of this
  // pattern required `${` straight after the path and therefore matched nothing,
  // and reported the bookmarkable detail page as unreachable. The literal is
  // taken whole and `pageOf` cuts the query, so `?`, `#` and `${` all end the
  // name the same way.
  for (const m of code.matchAll(/(['"`])\/([A-Za-z0-9._/-]*[A-Za-z0-9._-])(?:[?#][^'"`]*)?\1/g)) {
    linkTargets.push([file, `/${m[2]}`]);
  }
}

const pageOf = (target) => target.split('?')[0].split('#')[0].replace(/\/+$/, '');

const REFERENCES = new Map(PAGES.map((p) => [p, []]));
for (const page of PAGES) {
  for (const name of namesFor(page)) {
    const suffix = name.startsWith('/') ? name : `/${name}`;
    const bare = name.startsWith('/') ? name.slice(1) : name;
    for (const [file, target] of linkTargets) {
      if (file === page) continue;
      const t = pageOf(target);
      if (t === suffix || t === bare || t === `/${bare}`) REFERENCES.get(page).push(`${file} -> ${target}`);
    }
  }
}

/** Pages no link reaches: named, so an addition is visible and a removal is too. */
const ORPHANS = new Set(
  PAGES.filter((p) => REFERENCES.get(p).length === 0),
);

/**
 * The one page nothing navigates to, with the reason it is still here.
 *
 * Kept as a named entry rather than deleted, because two tests pin its
 * existence on purpose — `common-lang-toggle.test.mjs:5` and
 * `page-scripts.test.mjs:227` both hold `login.html` in a named set — and
 * deleting it would turn those into failures that look like regressions. What
 * is decided here is that its ORPHANHOOD is stated, so it is a claim rather
 * than an absence nobody looked for.
 */
const NAMED_ORPHAN = {
  page: 'public/admin/login.html',
  why: 'public/admin/login.html is the informational card that says this app has no auth. '
    + 'Nothing links to it: it is absent from the sidebar app.js:68-94 builds, it has no literal '
    + 'href anywhere in the tree, and electron/main.mjs:20 loads only /admin/arbitrage.html as the '
    + 'entry. Its three mentions are all comments (common.js:160, settings.js:9, settings.html:22). '
    + 'still has its own script — pages/login.js is the only file that ever bound the '
    + 'language toggle before common.js took that over — so the one page where that binding '
    + 'is the original is the one page no user can reach. Linking it or deleting it is a '
    + 'product decision; what is not a decision is that it is currently neither.',
};

test('the sidebar the app builds accounts for every page it claims to', () => {
  // The controls, named. A sweep of this file that read no sources at all would
  // report eleven orphans and pass the ledger below on a list of one, so both
  // halves are pinned: the sidebar really holds nine destinations, and the
  // pages it names are the files that exist.
  const sidebar = [...APP.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.equal(sidebar.length, 9, `the sidebar builds 9 destinations; this tree has ${sidebar.length}`);

  const exists = new Set(PAGES.map((p) => p.slice('public'.length)));
  const dangling = sidebar
    .map((h) => (h === '/' ? '/index.html' : h))
    .filter((h) => !exists.has(h))
    .map((h) => `the sidebar links ${h} and no such file is in public/`);
  assert.deepEqual(dangling, [], dangling.join(' | '));

  // And the composed link, which is the one a static sweep cannot see. If the
  // dashboard stops building it, `event.html` becomes a second orphan and this
  // control is what says so before the ledger does.
  assert.ok(
    [...navSources].some(([, code]) => /`\/event\.html\?\$\{/.test(code)),
    'the dashboard still builds an href to /event.html at render time',
  );
});

test('the only page nothing navigates to is the one named as such', () => {
  // Both directions. A new page nobody links to is not in the register and has
  // to be named; a page that has since been linked must leave the register, or
  // it sits there claiming something untrue — the same decay the excuse list in
  // api-surface.test.mjs exists to stop, in the other direction.
  const stranded = [...ORPHANS].filter((p) => p !== NAMED_ORPHAN.page);
  assert.deepEqual(stranded, [],
    `these pages are in public/ and no link, redirect, sidebar entry or shell entry point reaches them: ${stranded.join(' | ')}`);

  assert.equal(ORPHANS.has(NAMED_ORPHAN.page), true,
    `${NAMED_ORPHAN.page} is named here as an orphan and something now reaches it — link it from the sidebar, or drop the entry`);

  // The nine the sidebar reaches are named too, so this test fails if the
  // sidebar is rebuilt smaller rather than passing on a smaller orphan count.
  const reachedBySidebar = PAGES.filter((p) => REFERENCES.get(p).some((r) => r.startsWith('public/js/app.js')));
  assert.deepEqual(
    reachedBySidebar,
    ['public/admin/ai.html', 'public/admin/analytics.html', 'public/admin/arbitrage.html',
      'public/admin/bookies.html', 'public/admin/live.html', 'public/admin/scanner.html',
      'public/admin/scrape.html', 'public/admin/settings.html', 'public/index.html'],
    'these nine are the ones the generated sidebar reaches',
  );
});

test('an orphan entry carries the reason it is still here', () => {
  // A register entry with no reason is a claim nothing measures — the defect
  // this segment has already found twice, once in this file's sibling.
  assert.ok(NAMED_ORPHAN.why.length > 120,
    'the orphan entry must say why the page exists and who pins it');
  assert.match(NAMED_ORPHAN.why, /login\.html/,
    'and it must name the page it is about, so it cannot be copied onto another one');
});
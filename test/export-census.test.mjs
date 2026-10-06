// export-census.test.mjs — is every symbol src/ exports actually consumed?
//
// The other censuses in this tree all ask the same shape of question about data
// crossing a boundary: which key does this route publish, which frame does the
// stream send, which field does the page read. This one asks it about code, and
// it is not a duplicate of test/helpers/reachability.mjs, which answers at the
// level of the FILE: a module can be reachable from src/server.mjs and still
// carry an export no caller anywhere imports. That is backend functionality which
// reaches nobody — not a page, not a script, not the server — and it is invisible
// to eslint, whose no-unused-vars never looks at an export.
//
// Two earlier removals in this tree were exactly this and were found by reading,
// not by a control: `TOTAL_SUBJECTS` and `theoreticalProfit` in
// src/scanner/market-contracts.mjs. Nothing would have said so on the next change.
// This file is the thing that says it.
//
// What it does NOT claim, stated here because the instrument could imply it:
//
//   - A symbol called only inside its own module is reported, not failed. It is
//     live: `subjectFor` is called four times in market-contracts.mjs and its
//     result reaches a page through the scan document. Failing it would be
//     failing a working feature over the keyword on its declaration.
//
//   - A symbol used only by tests is not reported as dead. `toProgressJob` is
//     exported so a test can drive the real producer, which is a legitimate
//     shape, not an orphan. This census answers "does anything call it", and the
//     answer for those is yes.
//
//   - Reachability is not this file's job. A dead export inside a module nothing
//     can reach is still dead, and still listed.
//
// The instrument reads the tree through codeOnly, so a name in a docstring is not
// a reference, and it counts references in the DEFINING file too — an earlier
// draft excluded that file to find cross-module callers and reported `parseBody`
// as having no consumer, while router.mjs calls it on every POST.
//
// And the absence it reports is only worth reading if the instrument can produce
// one. The control below injects a symbol that is called nowhere and one that is
// called only inside itself, and both have to come back in the branch they belong
// to. An instrument that never fires and a clean tree produce the same number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = join(import.meta.dirname, '..');

/** Every file under `dir` ending in an extension we read, repo-relative. */
function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) walk(`${dir}/${entry.name}`, out);
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
  }
  return out;
}

const SRC = walk('src');

/**
 * This file is excluded from the consumer set, and it has to be.
 *
 * A symbol listed below is, by construction, named in this file — either in the
 * pinned module-internal list or in a control — and a consumer set that counts
 * this file reports every one of them as wired. The first run of this census did
 * exactly that: fourteen internal helpers came back `wired`, and the empty
 * module-internal list was the tell. test/api-surface.test.mjs already states the
 * rule from the other side ("a route named in a comment is not a consumer"); this
 * is the same rule applied to the census that names the routes' fields.
 */
const SELF = 'test/export-census.test.mjs';
const CONSUMERS = walk('scripts')
  .concat(walk('electron'), walk('test'), walk('public/js'))
  .filter((f) => f !== SELF);

const sourceOf = (file) => codeOnly(readFileSync(join(ROOT, file), 'utf8'), file.endsWith('.js'));
const SOURCES = new Map(SRC.concat(CONSUMERS).map((f) => [f, sourceOf(f)]));

/**
 * The declarations this file exports, in source order.
 *
 * A name is a declaration when it is introduced by `export function`, `export
 * const|let|var` or `export class`. The three forms are separate patterns on
 * purpose: one alternation over them cannot report WHICH form matched, and the
 * pinned count below is quoted per form, so a rename that silently changed the
 * shape would otherwise just move the total.
 *
 * `export { a, b }` and `export default` are not read here. Neither appears in
 * src/ — measured, not assumed, and asserted by the count test below, which is
 * where a re-export form would show up first as a total that stopped moving.
 */
const DECLARATIONS = [
  { form: 'function', re: /^[ \t]*export[ \t]+(?:async[ \t]+)?function[ \t]+(\w+)/gm },
  { form: 'const', re: /^[ \t]*export[ \t]+(?:const|let|var)[ \t]+(\w+)/gm },
  { form: 'class', re: /^[ \t]*export[ \t]+class[ \t]+(\w+)/gm },
];

/** Every exported name in one file, as `{ name, form }`. */
function exportedNames(src) {
  const out = [];
  for (const { form, re } of DECLARATIONS) {
    for (const m of src.matchAll(re)) out.push({ name: m[1], form });
  }
  return out;
}

/**
 * `internal` uses every reference in the defining file and subtracts the
 * declaration itself. Subtracting by LINE was wrong, and the control caught it:
 * `export function f() { return f(); }` puts the declaration and its only call on
 * one line, so a line filter discards both and a symbol that is used looks dead.
 *
 * The verdicts are four, not three, and the fourth came from a first version that
 * had three: a symbol imported by a SIBLING module in src/ was reported `dead`.
 * It is called — by market-contracts.mjs importing it, say — so `dead` was a lie
 * about it, and a census that lies about live symbols is worse than no census.
 * `module-internal` is the honest bucket: consumed inside the backend, reached by
 * no page, script or test.
 *
 * `siblings` and `others` are SOURCE TEXTS, not paths. The lookup belongs to the
 * caller, which has the map, and a classifier handed a path searches a string
 * like `public/js/pages/scrape.js` for the symbol and finds nothing in any file.
 */
function classify(name, ownSrc, siblings, others) {
  const internal = Math.max(0, [...ownSrc.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length - 1);
  const inSrc = internal > 0 || siblings.some((s) => new RegExp(`\\b${name}\\b`).test(s));
  const wired = others.some((o) => new RegExp(`\\b${name}\\b`).test(o));
  if (wired) return 'wired';
  return inSrc ? 'backend-only' : 'dead';
}

/** Every src module's text, read once: 178 symbols would otherwise re-read the tree each time. */
const SRC_SOURCES = SRC.map((f) => SOURCES.get(f));
const OTHER_SOURCES = CONSUMERS.map((f) => SOURCES.get(f));

/** The census, over the whole tree. */
function scan() {
  const rows = [];
  SRC.forEach((file, i) => {
    const own = SRC_SOURCES[i];
    const siblings = SRC_SOURCES.filter((_, j) => j !== i);
    for (const { name, form } of exportedNames(own)) {
      rows.push({
        file: relative(ROOT, join(ROOT, file)).split(sep).join('/'),
        name,
        form,
        verdict: classify(name, own, siblings, OTHER_SOURCES),
      });
    }
  });
  return rows;
}

const ROWS = scan();

test('the scan read the tree it claims to census', () => {
  // A census over an empty list reports zero dead and means nothing. The counts
  // are the floor: a walk that stopped early, or a filter that matched nothing,
  // still produces a passing "no dead exports" two lines below.
  assert.equal(SRC.length, 70, `src/ holds ${SRC.length} modules, not 70 — re-measure before quoting any count here`);
  assert.ok(SOURCES.size >= SRC.length, 'the source map is smaller than src/ itself');
  const publicJs = CONSUMERS.filter((f) => f.startsWith('public/js/'));
  assert.ok(publicJs.length > 0, 'no frontend file was read, so "no page calls it" would be vacuous');
  assert.ok(CONSUMERS.filter((f) => f.startsWith('test/')).length > 0, 'no test file was read either');
});

test('no exported symbol in src/ has no caller at all', () => {
  const dead = ROWS.filter((r) => r.verdict === 'dead');
  assert.deepEqual(dead.map((r) => `${r.file}  ${r.name}`), [],
    `these exports are referenced by nobody in src/, scripts/, electron/, test/ or public/js: ${dead.map((r) => `${r.file}->${r.name}`).join(', ')}`);
});

test('the instrument can still report a dead symbol', () => {
  // The control the whole file rests on. Without it, "zero dead" and "the probe
  // never fires" are the same output.
  const synthetic = codeOnly([
    'export function censusControlDead() { return 1; }',
    'export function censusControlInternal() { return censusControlInternal(); }',
    'export function censusControlSibling() { return 1; }',
    'export function censusControlWired() { return 1; }',
  ].join('\n'), true);
  const declared = exportedNames(synthetic).map((e) => e.name);
  assert.deepEqual(declared, ['censusControlDead', 'censusControlInternal', 'censusControlSibling', 'censusControlWired'],
    'the declaration scan missed a synthetic symbol, so the census below is measuring nothing');
  assert.equal(classify('censusControlDead', synthetic, [], OTHER_SOURCES), 'dead');
  assert.equal(classify('censusControlInternal', synthetic, [], OTHER_SOURCES), 'backend-only');
  // A symbol another src module carries is consumed, not dead. This is the
  // branch the three-verdict version got wrong, so the control states it.
  assert.equal(classify('censusControlSibling', synthetic, ['import { censusControlSibling } from "./x.mjs";'], []), 'backend-only');
  // And a name a non-src file carries is reported wired, so neither of the other
  // branches is simply the default answer.
  assert.equal(classify('censusControlWired', synthetic, [], OTHER_SOURCES.concat(['call censusControlWired();'])), 'wired');
});

test('the symbols only another src module reaches are the ones named here', () => {
  // Pinned rather than counted, so the next one is a decision instead of a
  // surprise.
  //
  // None of these is unwired functionality, and the difference matters. They are
  // consumed by a sibling module in src/ — `sportOptions` is called by router.mjs
  // and serves GET /api/sports, which three pages read; `round4` rounds the stake
  // split the scanner publishes. What the bucket records is narrower: no page,
  // script, electron file or test names them, so nothing OUTSIDE the backend
  // pins their behaviour by name. The link from them to a page runs through the
  // module that imports them, and the payload censuses are what prove that
  // link; this file cannot see it and does not claim to.
  //
  // What is left to say is that the `export` keyword is redundant on all 40 — they
  // are module-internal helpers. Dropping it is a cleanup, not a fix, and the pin
  // exists so the cleanup is a decision rather than a diff nobody reads.
  const backendOnly = ROWS.filter((r) => r.verdict === 'backend-only').map((r) => `${r.file}  ${r.name}`).sort();
  assert.deepEqual(backendOnly, [
    'src/router.mjs  parseBody',
    'src/scanner/engine.mjs  SIGNAL_TYPES',
    'src/scanner/event-arbs.mjs  DETAIL_BANKROLL',
    'src/scanner/market-contracts.mjs  isDeclaredFullTimeMarket',
    'src/scanner/market-contracts.mjs  isOpaqueMatchResultKey',
    'src/scanner/market-contracts.mjs  subjectFor',
    'src/scanner/market-contracts.mjs  teamFor',
    'src/scanner/scanner.mjs  isImplausible1x2',
    'src/scanner/scanner.mjs  scanOptionsPayload',
    'src/scanner/scanner.mjs  worstSourceStatus',
    'src/scraper-service.mjs  loadScraperJobs',
    'src/scraper-service.mjs  normalizeScrapeParallel',
    'src/scrapers/_http-helpers.mjs  buildEventKey',
    'src/scrapers/_http-helpers.mjs  flattenMarkets',
    'src/scrapers/altenar-public.mjs  matchesAltenarConfig',
    'src/scrapers/altenar-sites.mjs  createAltenarTenant',
    'src/scrapers/egt.mjs  EGT_TENANT_IDS',
    'src/scrapers/feg-common.mjs  FegCatalogueScraper',
    'src/scrapers/feg-common.mjs  isFegMarketTypeWithheld',
    'src/scrapers/live-status.mjs  FEG_MARKET_KIND',
    'src/scrapers/nsoft.mjs  NSOFT_TENANT_IDS',
    'src/scrapers/unibet.mjs  marketsFromProposition',
    'src/shared/abort.mjs  combineAbortSignals',
    'src/shared/atomic-write.mjs  tryReadJson',
    'src/shared/bounded-json.mjs  DEFAULT_MAX_BODY_BYTES',
    'src/shared/bounded-json.mjs  readBoundedJson',
    'src/shared/data-quality.mjs  sourceHealthSummary',
    'src/shared/event-limit.mjs  isUnlimited',
    'src/shared/event-limit.mjs  limitReached',
    'src/shared/event-limit.mjs  serializedMaxEvents',
    'src/shared/math.mjs  round4',
    'src/shared/text.mjs  decimalOdds',
    'src/sports/registry.mjs  getSport',
    'src/sports/registry.mjs  sportOptions',
    'src/tinyfish/browser-discovery.mjs  discoverLinksViaBrowser',
    'src/tinyfish/browser-discovery.mjs  inferTeamsFromText',
    'src/tinyfish/client.mjs  TinyfishError',
    'src/tinyfish/client.mjs  cancelRun',
    'src/tinyfish/client.mjs  getResult',
    'src/tinyfish/extract.mjs  extractOdds',
  ], 'the backend-only set moved: name the new one, or drop its `export`, in the same commit');
});

test('the census still counts what it counted', () => {
  // The total is the canary for the declaration scan itself: a re-export form
  // appearing in src/ would leave the dead test passing and show up here first,
  // as a total that stopped moving.
  assert.equal(ROWS.length, 178, `src/ now exports ${ROWS.length} names, not 178 — a declaration form this scan cannot read has probably appeared`);
  assert.equal(ROWS.filter((r) => r.verdict === 'wired').length, 138,
    'the wired count moved, so the pinned list above was re-measured on a different tree');
  // The three verdicts have to account for every row. A row that is none of them
  // is a row the census read and did not judge, which is the one state a total
  // alone would hide.
  assert.equal(
    ROWS.filter((r) => ['dead', 'backend-only', 'wired'].includes(r.verdict)).length,
    ROWS.length,
    'a verdict is not one this file knows: the three buckets have to cover the census',
  );
});

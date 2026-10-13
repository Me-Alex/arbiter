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
import { createRequire } from 'node:module';
import { codeOnly } from './helpers/code-only.mjs';

const ROOT = join(import.meta.dirname, '..');
const { parse } = createRequire(import.meta.url)('espree');

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
 * census below checks that every named declaration is accounted for.
 *
 * Default exports and export lists are outside this declaration census.
 * The coverage check below independently parses declarations so additions
 * change the measured population without requiring a fixed total.
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

/** Every src module's text, read once rather than once per exported symbol. */
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
  // Compare the walk with an independent recursive directory listing. New
  // modules join the census automatically; a missed directory still fails.
  const onDisk = readdirSync(join(ROOT, 'src'), { recursive: true })
    .map((file) => `src/${file.split(sep).join('/')}`)
    .filter((file) => /\.(mjs|js)$/.test(file) && !/(?:^|\/)(?:node_modules|\.git)\//.test(file));
  assert.ok(onDisk.length > 0, 'src/ has no modules to census');
  assert.deepEqual([...SRC].sort(), onDisk.sort(), 'the walk missed a source module');
  const consumersOnDisk = ['scripts', 'electron', 'test', 'public/js'].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true })
      .map((file) => `${dir}/${file.split(sep).join('/')}`)
      .filter((file) => /\.(mjs|js)$/.test(file)
        && !/(?:^|\/)(?:node_modules|\.git)\//.test(file) && file !== SELF));
  assert.deepEqual([...CONSUMERS].sort(), consumersOnDisk.sort(), 'the walk missed a consumer');
  for (const file of onDisk) {
    const tree = parse(readFileSync(join(ROOT, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    const declarations = tree.body.filter((node) => node.type === 'ExportNamedDeclaration' && node.declaration);
    if (declarations.length) {
      assert.ok(ROWS.some((row) => row.file === file), `${file}: the census counted zero declared exports`);
    }
  }
  assert.deepEqual([...SOURCES.keys()].sort(), [...new Set([...SRC, ...CONSUMERS])].sort(),
    'the source map must cover every discovered source and consumer');
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
  // consumed by a sibling module in src/ — `getSport` is called by router.mjs:109
  // to reject an unknown sport before a scan starts; `round4` rounds the stake
  // split the scanner publishes. What the bucket records is narrower: no page,
  // script, electron file or test names them, so nothing OUTSIDE the backend
  // pins their behaviour by name. The link from them to a page runs through the
  // module that imports them, and the payload censuses are what prove that
  // link; this file cannot see it and does not claim to.
  //
  // `sportOptions` sat here until test/sports-payload-census.test.mjs started
  // calling it, to compare the body GET /api/sports really serves against the
  // registry the route derives from. A test naming the symbol is what this
  // bucket means by wired, so the move out of it is the census doing its job on
  // a new consumer — the pin below changed in the same commit as that consumer.
  //
  // `getSport` was in this bucket for the same reason until
  // test/sport-registry-consistency.test.mjs named it, checking that every sport
  // a job declares resolves and every registered sport is declared. The router
  // still calls it at request time (src/router.mjs:109, unknown sport → 400);
  // what changed is that a test now pins the table from the other side.
  //
  // These names are reached only within src/. Some are imported by siblings,
  // so their exports are required even without an outside consumer.
  const backendOnly = ROWS.filter((r) => r.verdict === 'backend-only').map((r) => `${r.file}  ${r.name}`).sort();
  assert.deepEqual(backendOnly, [
    'src/router.mjs  parseBody',
    // SIGNAL_TYPES left backendOnly when test/back-to-lay.test.mjs
    // wired it to verify the BACK_TO_LAY signal type definition.
    'src/scanner/event-arbs.mjs  DETAIL_BANKROLL',
    // isDeclaredFullTimeMarket left backendOnly when test/market-contracts-families.test.mjs
    // wired it to verify full-time settlement assertions.
    'src/scanner/market-contracts.mjs  isOpaqueMatchResultKey',
    // subjectFor and teamFor left backendOnly when test/multibook-proposition-matching.test.mjs
    // wired them to verify proposition matching and team-side total resolution.
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
    // eventLimit left this list when scripts/add-book.mjs arrived: the scaffold
    // generates an EGT brand subclass that imports it, so it is wired by a real
    // consumer now and is no longer backend-only. Same rule the header states for
    // names mentioned in a comment — a name in generated code is a caller.
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
    'src/sports/registry.mjs  canonicalSportName',
    'src/tinyfish/browser-discovery.mjs  discoverLinksViaBrowser',
    'src/tinyfish/browser-discovery.mjs  inferTeamsFromText',
    'src/tinyfish/client.mjs  TinyfishError',
    'src/tinyfish/client.mjs  cancelRun',
    'src/tinyfish/client.mjs  getResult',
    'src/tinyfish/extract.mjs  extractOdds',
  ], 'the backend-only set moved: name the new one, or drop its `export`, in the same commit');
});

test('the census accounts for every named export and classifies every row', () => {
  assert.ok(ROWS.length > 0, 'no exported names were read');
  for (const file of SRC) {
    const tree = parse(SOURCES.get(file), { ecmaVersion: 'latest', sourceType: 'module' });
    const declared = tree.body
      .filter((node) => node.type === 'ExportNamedDeclaration' && node.declaration)
      .flatMap(({ declaration }) => declaration.type === 'VariableDeclaration'
        ? declaration.declarations.map(({ id }) => id.name)
        : [declaration.id.name]);
    assert.deepEqual(ROWS.filter((r) => r.file === file).map((r) => r.name).sort(), declared.sort(),
      `${file}: a named export form was missed by the declaration scan`);
  }
  assert.equal(new Set(ROWS.map((r) => `${r.file}  ${r.name}`)).size, ROWS.length,
    'an exported name was counted more than once');
  // The three verdicts have to account for every row. A row that is none of them
  // is a row the census read and did not judge, which is the one state a total
  // alone would hide.
  assert.equal(
    ROWS.filter((r) => ['dead', 'backend-only', 'wired'].includes(r.verdict)).length,
    ROWS.length,
    'a verdict is not one this file knows: the three buckets have to cover the census',
  );
});

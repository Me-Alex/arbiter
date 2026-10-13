/**
 * emitted-class-census.test.mjs — every class a page emits must mean
 * something: either a stylesheet defines it, or JS queries it as a hook.
 *
 * The arbedge utility census caught the same failure one layer down (Tailwind
 * tokens); this is the same question for plain classes. Real findings it grew
 * from:
 *   - `error-visible` was assigned to #error-box on every update but defined
 *     nowhere; the box's real styling was swapped from `.sl-alert` to theme.css
 *     `.alert` at the same moment. Fixed in updateErrorBox; this test now
 *     fails if the fossil comes back.
 *   - `health-error` / `health-${status}` on #health-state: defined nowhere,
 *     so a stale workspace printed in the same colour as a fresh one. Now a
 *     literal HEALTH_CLASS map with matching `.health-*` rules.
 *
 * Classes used only as JS query hooks (`arb-detail-row`, `analytics-kpis`)
 * are legitimate: they pass via the hook branch. `toast-info` is the default
 * `.toast` look and is excepted explicitly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules' && name !== '.git') walk(p, out);
    } else out.push(p);
  }
  return out;
}

const PUB = join(ROOT, 'public');
const files = walk(PUB).filter((f) => /\.(html|css|js|mjs)$/.test(f));
const html = files.filter((f) => f.endsWith('.html'));
const css = files.filter((f) => f.endsWith('.css'));
const js = files.filter((f) => /\.(js|mjs)$/.test(f));

const cssCorpus = css.map((f) => readFileSync(f, 'utf8')).join('\n');
const jsCorpus = js.map((f) => readFileSync(f, 'utf8')).join('\n');

const defined = new Set();
for (const m of cssCorpus.matchAll(/\.((?:\\[^\n]|[^\s.:{>+~,()\\])+)/g)) {
  defined.add(m[1].replace(/\\(.)/g, '$1'));
}

// A token is a query hook when it appears inside a selector-ish JS string:
// querySelector(All), closest, matches, classList.contains, or an attribute
// selector mentioning the class.
function isHook(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"\`][^'"\`]*\\.${escaped}[^'"\`]*['"\`]`).test(jsCorpus)
    || new RegExp(`classList\\.contains\\(\\s*['"]${escaped}['"]`).test(jsCorpus);
}

const emitted = new Map();
function note(token, where) {
  if (!emitted.has(token)) emitted.set(token, new Set());
  emitted.get(token).add(where);
}

for (const f of html) {
  for (const m of readFileSync(f, 'utf8').matchAll(/class="([^"$]+)"/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (token && !/\$/.test(token)) note(token, relative(ROOT, f));
    }
  }
}
for (const f of js) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/classList\.(?:add|toggle|replace|contains)\(([^)]+)\)/g)) {
    for (const mm of m[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
      for (const token of (mm[1] || mm[2]).split(/\s+/)) {
        if (token) note(token, relative(ROOT, f));
      }
    }
  }
  for (const m of src.matchAll(/className\s*=\s*['"`]([^'"`$]+)['"`]/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (token) note(token, relative(ROOT, f));
    }
  }
}

// Explicit exceptions, each justified:
//   toast-info — the type-less `.toast` base style *is* the info look.
//   complete / failed — toggled on #progress-ring, which is display:none and
//     kept only for its aria value; the toggles are vestigial.
//   toast- — prefix literal from `'toast toast-' + type`; every concrete
//     toast-* token is checked by the stylesheet branch.
const EXEMPT = new Set(['toast-info', 'complete', 'failed', 'toast-']);

test('every emitted class resolves to a rule or a query hook', () => {
  assert.ok(emitted.size > 200, 'sanity: the scan found the class vocabulary');
  const missing = [...emitted.entries()]
    .filter(([token]) => !defined.has(token) && !isHook(token) && !EXEMPT.has(token))
    .map(([token, where]) => `${token}  (${[...where].join(', ')})`);
  assert.deepEqual(missing, [], `emitted but meaningless classes:\n${missing.join('\n')}`);
});

test('the scanner health vocabulary has CSS rules', () => {
  for (const token of ['health-fresh', 'health-stale', 'health-partial', 'health-empty', 'health-failed', 'health-cancelled', 'health-unknown', 'health-error']) {
    assert.ok(defined.has(token), `.${token} is missing from the stylesheets`);
  }
});

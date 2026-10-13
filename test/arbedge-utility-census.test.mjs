import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeOnly } from './helpers/code-only.mjs';

/**
 * Every arbitrary-value utility a page uses must be one arbedge.css draws.
 *
 * The ArbEdge console keeps Tailwind's bracket syntax on purpose, with the
 * utility subset hand-written in arbedge.css. Missing a rule is invisible in
 * a diff: the markup stays, the token stays in the HTML, and the element
 * quietly renders as the plain surface — which is exactly what the
 * guaranteed-profit callout did (`bg-[var(--edge-green)]/10`,
 * `border-[var(--edge-green)]/25`, both undefined at the time).
 *
 * Comparing selectors by their plain text keeps this check honest: writing
 * only the *name* in the markup and only the *name:hover* form in CSS is the
 * pair the page actually uses, so the definition side is stripped of its
 * pseudo-class and combinators before matching.
 */
const CSS = readFileSync(new URL('../public/css/arbedge.css', import.meta.url), 'utf8');

const used = new Set();
for (const f of readdirSync(new URL('../public/admin', import.meta.url))) {
  if (!f.endsWith('.html')) continue;
  const html = readFileSync(new URL(`../public/admin/${f}`, import.meta.url), 'utf8');
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const n of m[1].split(/\s+/)) if (n.includes('[var(')) used.add(n);
  }
}
for (const f of readdirSync(new URL('../public/js/pages', import.meta.url))) {
  if (!f.endsWith('.js')) continue;
  const src = codeOnly(readFileSync(new URL(`../public/js/pages/${f}`, import.meta.url), 'utf8'), true);
  for (const m of src.matchAll(/['"`]([^'"`]+)['"`]/g)) {
    for (const n of m[1].split(/\s+/)) {
      if (!n.includes('[var(') || n.includes('${') || n.includes('(') === false) continue;
      if (/^[a-z]/.test(n) && !/[.[\]{}]/.test(n.split('[')[0].replace(/-/g, ''))) used.add(n);
    }
  }
}

const defined = new Set();
for (const m of CSS.matchAll(/^\s*\.((?:\\.|[^{,])+)\{/gm)) {
  for (const sel of m[1].split(',')) {
    const plain = sel.trim()
      .replace(/\\(.)/g, '$1')          // unescape \[, \/, \: …
      .replace(/:hover$/, '')
      .replace(/\s*>\s*\* \+ \*$/, '')
      .replace(/:focus-visible$/, '');
    if (plain.includes('[var(')) defined.add(plain);
  }
}

test('every arbitrary utility a page uses is drawn by arbedge.css', () => {
  assert.ok(used.size > 15, `extraction found only ${used.size} tokens — the sensor moved`);
  assert.ok(defined.size > 15, `arbedge.css yielded only ${defined.size} utilities — the sensor moved`);
  const missing = [...used].filter((n) => !defined.has(n)).sort();
  assert.deepEqual(missing, [],
    'a page emits an arbitrary utility with no rule in arbedge.css — it renders as the plain surface');
});

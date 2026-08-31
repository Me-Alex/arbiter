import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCsp } from '../src/shared/security.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = [
  ['public/index.html', '/js/pages/dashboard.js'],
  ['public/admin/login.html', '/js/pages/login.js'],
  ['public/admin/scrape.html', '/js/pages/scrape.js'],
  ['public/admin/scanner.html', '/js/pages/scanner.js'],
  ['public/admin/analytics.html', '/js/pages/analytics.js'],
  ['public/admin/ai.html', '/js/pages/ai.js'],
];

function scriptSources(html) {
  return [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => {
    const attrs = match[1];
    const source = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    return source ? source[1] : null;
  });
}

test('interactive pages use only local external scripts and no inline handlers', async () => {
  for (const [page, expectedPageScript] of PAGES) {
    const html = await readFile(join(ROOT, page), 'utf8');
    const sources = scriptSources(html);

    assert.ok(sources.length > 0, `${page} should load scripts`);
    assert.ok(sources.every(Boolean), `${page} must not contain inline executable scripts`);
    assert.ok(sources.every((source) => source.startsWith('/')), `${page} scripts must be same-origin`);
    assert.ok(sources.includes(expectedPageScript), `${page} should load ${expectedPageScript}`);
    assert.doesNotMatch(html, /\son[a-z][\w:-]*\s*=/i, `${page} must not use inline event handlers`);
    assert.doesNotMatch(html, /rsms\.me\/inter/i, `${page} must not depend on the remote Inter stylesheet`);

    for (const source of sources) {
      await access(join(ROOT, 'public', source));
    }
  }
});

test('synthetic design preview is not served with production assets', async () => {
  await assert.rejects(access(join(ROOT, 'public', 'preview.html')));
  await assert.rejects(access(join(ROOT, 'public', 'css', 'preview.css')));
  await assert.rejects(access(join(ROOT, 'public', 'js', 'pages', 'preview.js')));
  await access(join(ROOT, 'design-preview', 'preview.html'));
});

test('CSP keeps executable code restricted to same-origin scripts', () => {
  const csp = buildCsp();
  const scriptSrc = csp.split('; ').find((directive) => directive.startsWith('script-src'));

  assert.equal(scriptSrc, "script-src 'self'");
  assert.doesNotMatch(scriptSrc, /unsafe-inline|https?:|data:/i);
});

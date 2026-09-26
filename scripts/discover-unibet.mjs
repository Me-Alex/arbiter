/**
 * discover-unibet.mjs — find the public odds feed the site actually calls.
 *
 * The adapter targets /api/kambi/offer/v1/betoffer/list.json, which now
 * returns 404 while the site itself returns 200. Rather than guessing a
 * replacement path, this loads the sportsbook in a real browser and records
 * the requests it makes.
 *
 * It only observes. It does not click, does not submit anything, and does not
 * set or read cookies beyond what the page needs to render — the goal is the
 * request URL and shape, nothing else. Output is a report, not an adapter.
 *
 * Run:  node scripts/discover-unibet.mjs
 */

import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';

const SITE = 'https://www.unibet.ro/betting/odds';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Requests that look like odds data rather than assets or telemetry. */
function looksLikeOdds(url) {
  if (/kwp-bundle-store|\.(js|css|png|jpg|svg|woff2?|ico|webp)(\?|$)/i.test(url)) return false;
  if (/analytics|gtm|google|facebook|abtasty|hotjar|datadog|cloudflare/i.test(url)) return false;
  return /\/(api|rest|service|graph|graphql|offers?|bets?|events?|sports?)\b/i.test(url)
    || /betoffer|betslip|kambi|odds/i.test(url);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: USER_AGENT,
  locale: 'ro-RO',
  viewport: { width: 1400, height: 900 },
});
const page = await context.newPage();

const seen = [];
page.on('request', (request) => {
  const url = request.url();
  if (!looksLikeOdds(url)) return;
  const headers = request.headers();
  seen.push({
    method: request.method(),
    url,
    resourceType: request.resourceType(),
    xApplication: headers['x-application'] || null,
    contentType: headers['content-type'] || null,
  });
});

const responses = [];
page.on('response', async (response) => {
  const request = seen.find((r) => r.url === response.url());
  if (!request) return;
  const entry = responses.find((r) => r.url === response.url());
  if (entry) return;
  responses.push({
    url: response.url(),
    status: response.status(),
    contentType: response.headers()['content-type'] || null,
  });
});

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 160));
});

console.log(`loading ${SITE} …`);
try {
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // The sportsbook app is a SystemJS shell; give it time to boot and fetch.
  // Sports pages also lazy-load on scroll, so nudge down the lobby.
  await page.waitForTimeout(15000);
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(4000);
  }
} catch (err) {
  console.log('navigation failed:', err.message.split('\n')[0].slice(0, 140));
}

const title = await page.title().catch(() => '');
const finalUrl = page.url();

await browser.close();

const report = {
  capturedAt: new Date().toISOString(),
  landing: { finalUrl, title },
  requests: seen,
  responses,
  consoleErrors: consoleErrors.slice(0, 10),
};

await fs.writeFile('unibet-discovery.json', JSON.stringify(report, null, 2));

console.log(`\nlanding: ${title || '(no title)'} — ${finalUrl}`);
console.log(`odds-like requests observed: ${seen.length}`);
for (const r of seen.slice(0, 25)) {
  const res = responses.find((x) => x.url === r.url);
  const status = res ? ` -> ${res.status} ${(res.contentType || '').slice(0, 30)}` : '';
  console.log(`  ${r.method.padEnd(4)} ${r.url.slice(0, 96)}${status}`);
}
console.log('\nwritten to unibet-discovery.json');

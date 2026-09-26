/**
 * probe-unibet-feed.mjs — capture the full URL of the sports API calls the
 * site makes, then replay one without a browser to see whether the feed is
 * public.
 *
 * This is the difference between an adapter that works and one that breaks
 * again next month: if the odds endpoint answers a plain fetch with no cookies
 * and no token, it can be polled directly. If it needs a session, the honest
 * answer is that this feed is not a public one and the job stays disabled.
 *
 * Run:  node scripts/probe-unibet-feed.mjs
 */

import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';

const PAGE = 'https://www.unibet.ro/betting/odds';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FEED = /sportsbff-ams\.kindredext\.net\/sports-api/;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ userAgent: UA, locale: 'ro-RO', viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

/** Full request URL, plus whether the page had to authenticate first. */
const captured = [];
page.on('request', (request) => {
  if (!FEED.test(request.url())) return;
  const headers = request.headers();
  captured.push({
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    hasCookieHeader: Boolean(headers.cookie),
    hasAuthHeader: Object.keys(headers).some((h) => /^(authorization|x-auth|token)$/i.test(h)),
    postData: request.postData() ? request.postData().slice(0, 300) : null,
  });
});

await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(15000);
for (let i = 0; i < 3; i += 1) {
  await page.mouse.wheel(0, 2500);
  await page.waitForTimeout(4000);
}

const cookies = await context.cookies();
await browser.close();

console.log(`captured ${captured.length} sports-api calls; ${cookies.length} cookies set by the page\n`);

const seen = new Set();
const unique = captured.filter((c) => {
  if (seen.has(c.url)) return false;
  seen.add(c.url);
  return true;
});

for (const c of unique.slice(0, 12)) {
  console.log(`${c.method} ${c.url.slice(0, 130)}`);
  console.log(`   cookie header: ${c.hasCookieHeader ? 'yes' : 'no'} | auth header: ${c.hasAuthHeader ? 'yes' : 'no'}${c.postData ? ` | body: ${c.postData.slice(0, 80)}` : ''}`);
}

// Replay the odds-shaped calls with a bare fetch, no cookies.
console.log('\n--- replay without a browser session ---');
const results = [];
for (const c of unique.filter((x) => /odds|betoffer|menu|coupons|sports/i.test(x.url)).slice(0, 8)) {
  const url = new URL(c.url);
  // Strip the params that are obviously per-session, to test the public floor.
  for (const key of [...url.searchParams.keys()]) {
    if (/token|session|jwt|sid|bet|selection|coupon/i.test(key)) url.searchParams.delete(key);
  }
  try {
    const res = await fetch(url, {
      method: c.method,
      headers: { Accept: 'application/json', 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: c.method === 'POST' ? (c.postData || '{}') : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    results.push({ url: c.url, status: res.status, bytes: text.length, head: text.slice(0, 140) });
    console.log(`  ${res.status}  ${String(text.length).padStart(6)}B  ${c.url.slice(0, 90)}`);
  } catch (err) {
    console.log(`  err       ${c.url.slice(0, 90)} — ${err.message.slice(0, 40)}`);
  }
}

await fs.writeFile('unibet-probe.json', JSON.stringify({ captured: unique, cookies: cookies.map((c) => c.name), results }, null, 2));
console.log('\nwritten to unibet-probe.json');

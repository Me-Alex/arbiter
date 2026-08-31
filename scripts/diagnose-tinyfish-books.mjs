import { chromium } from 'playwright';
import { TINYFISH_BOOKS } from '../src/tinyfish/books.mjs';
import { createBrowserSession, withTinyfishSlot } from '../src/tinyfish/client.mjs';

const requested = process.argv.slice(2);
const ids = requested.length > 0 ? requested : Object.keys(TINYFISH_BOOKS);
const unknown = ids.filter((id) => !TINYFISH_BOOKS[id]);
if (unknown.length > 0) throw new Error(`Unknown TinyFish books: ${unknown.join(', ')}`);

const results = await Promise.all(ids.map((id) => inspectBook(id)));
console.log(JSON.stringify(results, null, 2));

async function inspectBook(id) {
  const book = TINYFISH_BOOKS[id];
  try {
    return await withTinyfishSlot(async () => {
      const session = await createBrowserSession({
        url: book.baseUrl,
        browserProfile: book.browserProfile,
      });
      let browser;
      try {
        browser = await chromium.connectOverCDP(session.cdpUrl);
        const context = browser.contexts()[0];
        if (!context) throw new Error('TinyFish browser returned no context');
        const page = context.pages()[0] || await context.newPage();
        await page.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => {});
        await page.waitForTimeout(12_000);
        const snapshot = await page.evaluate(() => {
          const eventCandidate = /(?:-vs-|[/](?:event|match|meci)(?:[/_-]|$))/i;
          const navigationCandidate = /(?:sport|prematch|live|fotbal|football|league|liga|competit|turneu|tournament)/i;
          const anchors = Array.from(document.querySelectorAll('a[href]'), (anchor) => ({
            href: anchor.href,
            text: anchor.textContent?.trim().replace(/\s+/g, ' ').slice(0, 160) || '',
          }));
          const seen = new Set();
          const componentCounts = new Map();
          for (const element of document.querySelectorAll('*')) {
            const tag = element.tagName.toLowerCase();
            if (tag.includes('-')) componentCounts.set(tag, (componentCounts.get(tag) || 0) + 1);
          }
          const eventCandidates = [];
          const candidates = [];
          for (const anchor of anchors) {
            if (!anchor.href || seen.has(anchor.href)) continue;
            seen.add(anchor.href);
            const searchable = `${anchor.href} ${anchor.text}`;
            if (eventCandidate.test(searchable)) eventCandidates.push(anchor);
            else if (navigationCandidate.test(searchable)) candidates.push(anchor);
          }
          return {
            finalUrl: location.href,
            title: document.title,
            bodyText: document.body?.innerText?.trim().replace(/\s+/g, ' ').slice(0, 500) || '',
            anchorCount: anchors.length,
            componentTags: [...componentCounts.entries()]
              .filter(([tag]) => /event|match|sport|league|competit|coupon|offer|outcome/i.test(tag))
              .sort((a, b) => b[1] - a[1])
              .slice(0, 30),
            eventCandidates: eventCandidates.slice(0, 20),
            candidates: candidates.slice(0, 20),
          };
        });
        return {
          id,
          configuredUrl: book.baseUrl,
          frameUrls: page.frames().map((frame) => frame.url()),
          ...snapshot,
        };
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    });
  } catch (err) {
    return { id, configuredUrl: book.baseUrl, error: err.message };
  }
}

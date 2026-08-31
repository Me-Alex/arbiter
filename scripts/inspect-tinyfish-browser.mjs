import { chromium } from 'playwright';

if (!process.env.CDP_URL) throw new Error('CDP_URL is required');

const browser = await chromium.connectOverCDP(process.env.CDP_URL);
try {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  const page = pages[0] || await contexts[0].newPage();
  await page.waitForTimeout(20_000);

  const snapshot = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 2_000) || '',
    anchors: Array.from(document.querySelectorAll('a[href]'), (anchor) => ({
      href: anchor.href,
      text: anchor.textContent?.trim().replace(/\s+/g, ' ').slice(0, 200) || '',
    })).filter((anchor) => anchor.href),
  }));

  console.log(JSON.stringify({
    ...snapshot,
    anchorCount: snapshot.anchors.length,
    anchors: snapshot.anchors.slice(0, 100),
  }, null, 2));
} finally {
  await browser.close();
}

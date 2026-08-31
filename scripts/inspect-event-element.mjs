import { chromium } from 'playwright';

if (!process.env.CDP_URL) throw new Error('CDP_URL is required');
const query = process.env.MATCH_TEXT || 'Napoli';
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
try {
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();
  await page.waitForTimeout(15_000);
  await page.locator('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll').click({ force: true }).catch(() => {});
  const locator = process.env.CSS_SELECTOR
    ? page.locator(process.env.CSS_SELECTOR).first()
    : page.getByText(query, { exact: false }).first();
  if (!await locator.isVisible().catch(() => false)) {
    throw new Error(`No visible element matching ${process.env.CSS_SELECTOR || query}`);
  }
  const details = await locator.evaluate((element) => {
    const ancestors = [];
    let current = element;
    for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
      ancestors.push({
        depth,
        tag: current.tagName,
        id: current.id,
        className: String(current.className || ''),
        role: current.getAttribute('role'),
        href: current.getAttribute('href'),
        data: Object.fromEntries(Array.from(current.attributes)
          .filter((attribute) => attribute.name.startsWith('data-'))
          .map((attribute) => [attribute.name, attribute.value])),
        html: current.outerHTML.slice(0, 1_500),
      });
    }
    return ancestors;
  });
  const beforeClick = page.url();
  if (process.env.CLICK_EVENT === '1') {
    await locator.click({ timeout: 5_000 });
    await page.waitForTimeout(5_000);
  }
  console.log(JSON.stringify({
    url: page.url(),
    beforeClick,
    query,
    matchCount: await page.getByText(query, { exact: false }).count(),
    details,
  }, null, 2));
} finally {
  await browser.close();
}

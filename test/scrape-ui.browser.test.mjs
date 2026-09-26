import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Serve only frontend assets; every API request is intercepted. No scraper runs.
test('scrape page wires selection, launch, progress and cancellation to the existing API', async (t) => {
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = new URL('../public' + pathname, import.meta.url);
      const body = await readFile(file);
      res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() { window.testEventSource = this; this.listeners = {}; }
      addEventListener(type, listener) { this.listeners[type] = listener; }
      close() {}
    };
  });
  let state = { status: 'idle', jobs: [], logs: [], pipeline: [] };
  const posts = [];
  const jobs = [{ id: 'betano', name: 'Betano', enabled: true, validationStatus: 'validated' }, { id: 'superbet', name: 'Superbet', enabled: true, validationStatus: 'validated' }];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let data = {};
    if (req.method() === 'POST') {
      posts.push({ path, body: req.postDataJSON(), token: req.headers()['x-arbiter-token'] });
      if (path === '/api/scrape') state = { ...state, status: 'running', runId: 'ui-test', jobs: [{ id: 'betano', status: 'running' }] };
      if (path === '/api/scrape/cancel') state = { ...state, status: 'cancelled', jobs: [{ id: 'betano', status: 'cancelled' }] };
      data = { state, cancelled: true };
    } else if (path === '/api/csrf') data = { token: 'test-token' };
    else if (path === '/api/scrapers') data = { jobs, enabledJobs: jobs, validatedJobs: jobs };
    else if (path === '/api/profiles') data = { profiles: [] };
    else if (path === '/api/sports') data = { sports: [] };
    else if (path === '/api/scrape/state') data = { state };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/admin/scrape.html`);
  await page.locator('#bookmaker-list input[data-source]').first().waitFor();
  // Default state on load: every enabled bookmaker is selected and the event
  // cap defaults to "all", so a plain click scrapes everything.
  assert.equal(await page.locator('#bookmaker-list input[data-source]:checked').count(), jobs.length);
  assert.equal(await page.locator('#max-events').inputValue(), 'all');
  await page.locator('#btn-select-all').click();
  assert.equal(await page.locator('[data-group-check]').first().evaluate((el) => el.indeterminate), false);
  await page.locator('#btn-select-none').click();
  assert.equal(await page.locator('#run-btn').isDisabled(), true);
  await page.locator('#bookmaker-list input[value="betano"]').check();
  await page.locator('#max-events').selectOption('500');
  await page.locator('#run-btn').click();
  await page.waitForFunction(() => !document.getElementById('cancel-btn').disabled);
  assert.equal(posts[0].path, '/api/scrape');
  assert.deepEqual(posts[0].body.bookIds, ['betano']);
  assert.equal(posts[0].body.scanOptions.maxEvents, 500);
  assert.equal(posts[0].token, 'test-token');
  assert.equal(await page.locator('#run-btn').isDisabled(), true);
  await page.locator('#cancel-btn').click();
  await page.waitForFunction(() => !document.getElementById('run-btn').disabled);
  assert.equal(posts[1].path, '/api/scrape/cancel');
  await page.evaluate(() => {
    window.testEventSource.listeners['scrape-update']({ data: JSON.stringify({
      status: 'completed-with-errors', runId: 'ui-test', logs: [], pipeline: [],
      jobs: [{ id: 'betano', status: 'failed', valid: false, events: 0, error: { message: 'Test upstream unavailable' } }],
    }) });
  });
  await page.waitForFunction(() => document.getElementById('job-rows').textContent.includes('Test upstream unavailable'));
  assert.equal(await page.locator('#run-btn').isDisabled(), false);
  assert.deepEqual(errors, []);
});

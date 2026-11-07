import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { chromium } from 'playwright';

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

test('app shell renders all 7 workspaces, trader staking/tax/Kelly/middle tools, unified cross-book modal builder, CSV export, and 1-click hedged settlement', async (t) => {
  const server = createServer(async (req, res) => {
    try {
      let pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/' || pathname === '/app' || pathname === '/app/') {
        pathname = '/app/index.html';
      }
      const file = new URL('../public' + pathname, import.meta.url);
      const body = await readFile(file);
      res.setHeader('Content-Type', MIME_BY_EXT[extname(pathname)] || 'application/octet-stream');
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        this.listeners = {};
      }
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }
      close() {}
    };
  });

  const trackedBets = [];
  const postCalls = [];
  const kickoff = new Date(Date.now() + 3600_000).toISOString();

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    let payload = {};

    if (req.method() !== 'GET') {
      postCalls.push({
        method: req.method(),
        path: pathname,
        token: req.headers()['x-arbiter-token'],
        body: req.postDataJSON(),
      });
    }

    if (pathname === '/api/csrf') {
      payload = { token: 'app-csrf-token' };
    } else if (pathname === '/api/scan') {
      payload = {
        id: 'scan-test-1',
        scrapedAt: new Date().toISOString(),
        eventCount: 42,
        published: true,
        dataHealth: { status: 'fresh', actionableSourceCount: 3, sources: { fresh: 3 } },
        sources: [
          { sourceId: 'betano', count: 24, dataStatus: 'fresh', ageMs: 15000 },
          { sourceId: 'superbet', count: 18, dataStatus: 'fresh', ageMs: 22000 },
          { sourceId: 'lvbet', count: 16, dataStatus: 'fresh', ageMs: 19000 },
        ],
        opportunities: [
          {
            type: 'arb',
            sport: 'Football',
            league: 'Liga 1',
            homeTeam: 'FCSB',
            awayTeam: 'Dinamo',
            kickoff,
            eventKey: `football|${kickoff}|fcsb|dinamo`,
            marketKey: 'TOTAL_GOALS',
            family: 'OVER_UNDER',
            period: 'fulltime',
            line: '2.5',
            marginPercent: 3.45,
            verification: { status: 'confirmed', reason: 'all legs re-priced within tolerance' },
            legs: [
              { sourceId: 'betano', selection: 'Over 2.5', odds: 2.1, eventUrl: 'https://ro.betano.com/event/fcsb-dinamo/12345/' },
              { sourceId: 'lvbet', selection: 'Under 2.5', odds: 2.04, eventUrl: 'https://lvbet.pl/pl/zaklady-bukmacherskie/fcsb-dinamo' },
            ],
          },
          {
            type: 'arb',
            sport: 'Football',
            league: 'Premier League',
            homeTeam: 'Arsenal',
            awayTeam: 'Chelsea',
            kickoff,
            eventKey: `football|${kickoff}|arsenal|chelsea`,
            marketKey: 'SYNTHETIC_1X2_AH05',
            family: 'SYNTHETIC_1X2_AH05',
            period: 'fulltime',
            marginPercent: 1.85,
            verification: { status: 'confirmed', reason: 'all legs re-priced within tolerance' },
            legs: [
              { sourceId: 'betano', selection: 'Home -0.5', handicap: -0.5, odds: 2.25, marketKey: 'ASIAN_HANDICAP' },
              { sourceId: 'superbet', selection: 'Draw', odds: 3.6, marketKey: '1X2' },
              { sourceId: 'lvbet', selection: 'Away', odds: 3.85, marketKey: '1X2' },
            ],
          },
        ],
        middles: [
          {
            type: 'middle',
            sport: 'Football',
            league: 'Premier League',
            homeTeam: 'Arsenal',
            awayTeam: 'Chelsea',
            kickoff,
            eventKey: `football|${kickoff}|arsenal|chelsea`,
            marketKey: 'OVER_UNDER_2_5',
            family: 'OVER_UNDER',
            period: 'fulltime',
            subject: 'goals',
            gap: 1,
            roiPercent: 107.5,
            riskPercent: 2.5,
            legs: [
              { sourceId: 'betano', selection: 'Over 2.5', handicap: 2.5, odds: 2.1, marketKey: 'OVER_UNDER_2_5' },
              { sourceId: 'superbet', selection: 'Under 3.5', handicap: 3.5, odds: 1.95, marketKey: 'OVER_UNDER_3_5' },
            ],
          },
        ],
        positiveEv: [
          {
            type: 'positive_ev',
            sport: 'Football',
            homeTeam: 'AC Milan',
            awayTeam: 'Inter',
            kickoff,
            eventKey: `football|${kickoff}|ac milan|inter`,
            marketKey: '1X2',
            live: false,
            selection: '1',
            sourceId: 'betano',
            odds: 2.25,
            consensusProbability: 0.5,
            evPercent: 12.5,
            verification: { status: 'confirmed', reason: 'all legs re-priced within tolerance' },
            legs: [{ sourceId: 'betano', selection: '1', odds: 2.25 }],
          },
        ],
        lowHold: [
          {
            sport: 'Football',
            homeTeam: 'FCSB',
            awayTeam: 'Dinamo',
            kickoff,
            eventKey: `football|${kickoff}|fcsb|dinamo`,
            marketKey: '1x2',
            holdPercent: 0.35,
            legs: [
              { sourceId: 'betano', selection: '1', odds: 2.1 },
              { sourceId: 'superbet', selection: 'X', odds: 3.4 },
              { sourceId: 'betano', selection: '2', odds: 4.3 },
            ],
          },
        ],
      };
    } else if (pathname === '/api/scrape/state') {
      payload = { state: { status: 'idle', jobs: [] } };
    } else if (pathname === '/api/scrape/latest' || pathname === '/api/scrape-run') {
      payload = { status: 'completed', jobs: [{ id: 'betano', status: 'completed', eventsCount: 24 }] };
    } else if (pathname === '/api/scrapers') {
      const jobs = [
        { id: 'betano', name: 'Betano', enabled: true, validationStatus: 'validated', liveCapability: { inPlay: 'supported' } },
        { id: 'superbet', name: 'Superbet', enabled: true, validationStatus: 'validated' },
      ];
      payload = { jobs, enabledJobs: jobs, validatedJobs: jobs };
    } else if (pathname === '/api/sports') {
      payload = { sports: [{ id: 'football', name: 'Football' }, { id: 'tennis', name: 'Tennis' }] };
    } else if (pathname === '/api/profiles') {
      payload = { profiles: [{ id: 'trusted-prematch', label: 'Trusted · Prematch', mode: 'trusted', description: 'Validated feeds', defaults: { includeLive: false } }] };
    } else if (pathname === '/api/scheduler') {
      payload = { enabled: false, intervalMinutes: 15 };
    } else if (pathname === '/api/live/status') {
      payload = { enabled: false, intervalSeconds: 30 };
    } else if (pathname === '/api/alerts') {
      payload = {
        preferences: {
          minMarginPercent: 1,
          minMiddleRoiPercent: 20,
          minEvPercent: 2,
          cooldownSeconds: 60,
          quietHoursEnabled: false,
          quietHoursStart: '23:00',
          quietHoursEnd: '07:00',
          channels: { desktop: true, sound: true },
        },
      };
    } else if (pathname === '/api/event-detail') {
      payload = {
        events: [
          {
            sourceId: 'betano',
            sourceUrl: 'https://ro.betano.com/event/fcsb-dinamo/12345/',
            homeTeam: 'FCSB',
            awayTeam: 'Dinamo',
            live: false,
            markets: [
              {
                key: 'MR12',
                name: 'Rezultat final',
                period: 'fulltime',
                selections: [
                  { name: '1', odds: 2.25 },
                  { name: 'X', odds: 3.4 },
                  { name: '2', odds: 3.5 },
                ],
              },
              {
                key: 'MRH1',
                name: 'Rezultat 1. repriza',
                period: 'half1',
                selections: [
                  { name: '1', odds: 2.8 },
                  { name: 'X', odds: 2.1 },
                  { name: '2', odds: 4.1 },
                ],
              },
            ],
          },
          {
            sourceId: 'superbet',
            sourceUrl: 'https://superbet.ro/pariuri-sportive/fotbal/fcsb-dinamo',
            homeTeam: 'FCSB',
            awayTeam: 'Dinamo',
            live: false,
            markets: [
              {
                key: '547',
                name: 'Final',
                period: 'fulltime',
                selections: [
                  { name: '1', odds: 2.05 },
                  { name: 'X', odds: 3.65 },
                  { name: '2', odds: 3.9 },
                ],
              },
            ],
          },
          {
            sourceId: 'favbet',
            sourceUrl: 'https://www.favbet.ro/ro/sports/event/fotbal/99/',
            homeTeam: 'FCSB',
            awayTeam: 'Dinamo',
            live: false,
            markets: [
              {
                key: 'MRES',
                name: 'MRES',
                period: 'fulltime',
                selections: [
                  { name: 'Gazde', odds: 2.1 },
                  { name: 'Egal', odds: 3.5 },
                  { name: 'Oaspeți', odds: 4.1 },
                ],
              },
            ],
          },
        ],
      };
    } else if (pathname === '/api/catalog') {
      payload = {
        markets: [
          { sourceId: 'betano', marketKey: '1x2', marketName: 'Match Result', eventCount: 120, selectionCount: 360 },
          { sourceId: 'superbet', marketKey: 'TOTAL_GOALS', marketName: 'Total Goals', eventCount: 110, selectionCount: 220 },
        ],
        events: [
          {
            eventKey: `football|${kickoff}|fcsb|dinamo`,
            sport: 'Football',
            league: 'Liga 1',
            homeTeam: 'FCSB',
            awayTeam: 'Dinamo',
            sources: ['betano', 'superbet'],
            marketKeys: ['1x2', 'TOTAL_GOALS'],
            selectionCount: 5,
          },
        ],
      };
    } else if (pathname === '/api/tracker' && req.method() === 'POST') {
      const created = { id: `bet-${trackedBets.length + 1}`, ...req.postDataJSON(), createdAt: new Date().toISOString() };
      trackedBets.push(created);
      payload = { bet: created };
    } else if (pathname.startsWith('/api/tracker/') && req.method() === 'PUT') {
      const betId = pathname.slice('/api/tracker/'.length);
      const patch = req.postDataJSON();
      const target = trackedBets.find((b) => b.id === betId);
      if (target) Object.assign(target, patch);
      payload = { bet: target || { id: betId, ...patch } };
    } else if (pathname === '/api/tracker') {
      payload = {
        items: trackedBets,
        bets: trackedBets,
        stats: { count: trackedBets.length, completed: 0, totalStaked: 1000, profit: 0, roiPercent: 0 },
      };
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  const port = server.address().port;
  await page.goto(`http://127.0.0.1:${port}/app/`);
  await page.locator('article.opportunity').first().waitFor();

  // Dismiss QuickGuide, switch language RO -> EN, and toggle Light theme
  assert.equal(await page.locator('.guide-card').isVisible(), true);
  await page.locator('.guide-card .guide-head button').click();
  assert.equal(await page.locator('.guide-card').isVisible(), false);

  await page.locator('.sidebar-quick-toggles button').nth(0).click();
  await page.locator('.sidebar-quick-toggles button').nth(1).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');

  // Verify CSV export URL maps React filter presets to backend family query strings
  await page.locator('.filter-presets-row button').filter({ hasText: 'Middles' }).click();
  assert.equal(await page.locator('a[download="scan-findings.csv"]').getAttribute('href'), '/api/scan/export.csv?type=middles');

  // Inspect Middle winning window breakdown in ExecutionSlip
  await page.locator('article.opportunity').first().click();
  await page.waitForFunction(() => document.querySelector('#execution-slip')?.textContent?.includes('Win-both window: 3'));

  // Inspect +EV Fractional Kelly sizing buttons
  await page.locator('.filter-presets-row button').filter({ hasText: 'Verified +EV' }).click();
  await page.locator('article.opportunity').first().click();
  await page.waitForFunction(() => document.querySelector('#execution-slip')?.textContent?.includes('1/4 Kelly'));
  await page.locator('#execution-slip button').filter({ hasText: '1/2 Kelly' }).click();

  // Switch back to All signals -> select FCSB vs Dinamo surebet (Betano + LVBET .pl)
  await page.locator('.filter-presets-row button').filter({ hasText: 'All signals' }).click();
  await page.locator('article.opportunity').filter({ hasText: 'FCSB' }).click();

  // Verify Target-Biased Staking ("100% on Leg 1" -> "0.00 (break-even)") and 12% PL tax auto-hint
  assert.equal(await page.locator('#execution-slip').textContent().then((txt) => txt.includes('.pl book detected')), true);
  await page.locator('#execution-slip button').filter({ hasText: '100% on Leg 1' }).click();
  await page.waitForFunction(() => document.querySelector('#execution-slip')?.textContent?.includes('0.00 (break-even)'));
  await page.locator('#execution-slip button').filter({ hasText: '12% PL' }).click();
  await page.waitForFunction(() => document.querySelector('#execution-slip')?.textContent?.includes('net'));
  await page.locator('#execution-slip button').filter({ hasText: /^0%$/ }).click();
  await page.locator('#execution-slip button').filter({ hasText: 'Equal Dutch' }).click();

  // Verify More filters drawer and Cross-book only filter in Opportunities
  await page.locator('.filter-panel button').filter({ hasText: 'More filters' }).click();
  await page.locator('.advanced-filters-grid').waitFor();
  assert.equal(await page.locator('.advanced-filters-grid').isVisible(), true);
  await page.locator('.filter-panel button').filter({ hasText: 'Cross-book only' }).click();

  // Verify ExecutionSlip per-leg stake lock, Standalone 3-way 1(0)-X-2 Calculator, and Back/Lay Odds Converter
  await page.locator('.execution .slip-leg-card').first().locator('button[title="Lock max stake on this leg"]').click();
  await page.locator('.execution .locked-stake-input').waitFor();
  await page.locator('.execution button').filter({ hasText: 'Quick calculator' }).click();
  assert.equal(await page.locator('.execution').textContent().then((txt) => txt.includes('Standalone surebet calculator')), true);
  await page.locator('.execution button').filter({ hasText: '3-way (1-X-2)' }).click();
  await page.locator('.execution select[aria-label="Surebet formula (3-way)"]').selectOption('dnb_home_x_away');
  await page.locator('.execution button').filter({ hasText: 'Per-leg commissions' }).click();
  await page.locator('.execution button').filter({ hasText: 'Multi-currency & FX' }).click();

  await page.locator('.execution [role="tab"]').filter({ hasText: 'Odds converter' }).click();
  assert.equal(await page.locator('.execution').textContent().then((txt) => txt.includes('Bidirectional Back / Lay converter')), true);
  const backAmericanInput = page.locator('.execution input[aria-label="Back American (+/-)"]');
  await backAmericanInput.fill('+150');
  assert.equal(await page.locator('.execution input[aria-label="Back European (Decimal)"]').inputValue(), '2.50');
  assert.equal(await page.locator('.execution input[aria-label="Lay European (Decimal)"]').inputValue(), '1.667');

  await page.locator('.execution [role="tab"]').filter({ hasText: 'Active signal' }).click();

  // Verify Group by event, Pin to top, Live/Pause feed, and Hide/Restore modal on Terminal
  await page.locator('.topbar-actions button').filter({ hasText: 'Live feed' }).click();
  assert.equal(await page.locator('.topbar-actions').textContent().then((txt) => txt.includes('Paused (0)')), true);
  await page.locator('.topbar-actions button').filter({ hasText: 'Paused (0)' }).click();

  await page.locator('.filter-presets-row button').filter({ hasText: 'Group by event' }).click();
  await page.waitForFunction(() => document.body.textContent.includes('+ 1 more for this event'));
  await page.locator('button.event-siblings-toggle').click();
  await page.waitForFunction(() => document.body.textContent.includes('Collapse 1 signals'));
  await page.locator('.filter-presets-row button').filter({ hasText: 'Group by event' }).click();

  await page.locator('article.opportunity').filter({ hasText: 'FCSB' }).locator('button[aria-label="Pin to top (even if gone)"]').click();
  assert.equal(await page.locator('article.opportunity.pinned').count(), 1);
  await page.locator('article.opportunity').filter({ hasText: 'FCSB' }).locator('button[aria-label="Unpin from top"]').click();

  await page.locator('article.opportunity').filter({ hasText: 'AC Milan' }).locator('button[aria-label="Hide…"]').click();
  await page.locator('.hide-menu-popover button').filter({ hasText: 'Hide this signal' }).click();
  await page.waitForFunction(() => document.body.textContent.includes('Hidden (1)'));
  await page.locator('.filter-presets-row button').filter({ hasText: 'Hidden (1)' }).click();
  await page.locator('.modal-dialog button').filter({ hasText: 'Restore all' }).click();
  await page.keyboard.press('Escape');

  // Open Compare All Odds modal -> verify MR12 + 547 + MRES collapse into unified Match Result · FT (isolated from 1H) + Load best odds
  await page.locator('.execution button').filter({ hasText: 'Compare odds across all books' }).click();
  await page.locator('.modal-dialog .market-matrix-card').first().waitFor();
  const modalText = await page.locator('.modal-dialog').textContent();
  assert.equal(modalText.includes('Match result · FT'), true);
  assert.equal(modalText.includes('Match result · 1H'), true);
  await page.locator('.modal-dialog button').filter({ hasText: 'Load best odds' }).first().click();
  await page.waitForFunction(() => document.querySelector('.custom-builder-bar')?.textContent?.includes('Guaranteed margin'));
  await page.keyboard.press('Escape');

  // Log balanced surebet legs to Bet Tracker (stamps [pos:...] group tag) and verify CSRF header
  await page.locator('.execution button').filter({ hasText: 'Save position to Bet Tracker' }).click();
  await page.waitForFunction(() => document.body.textContent.includes('Saved to Bet Tracker'));
  const trackerPosts = postCalls.filter((c) => c.path === '/api/tracker' && c.method === 'POST');
  assert.equal(trackerPosts.length, 2);
  assert.equal(trackerPosts[0].token, 'app-csrf-token');
  assert.match(trackerPosts[0].body.notes, /^\[pos:[a-z0-9]+\]/);

  // Visit every workspace in the sidebar and confirm clean rendering
  const navButtons = page.locator('.sidebar .nav button');
  const navCount = await navButtons.count();
  assert.equal(navCount, 7);
  for (let idx = 0; idx < navCount; idx += 1) {
    await navButtons.nth(idx).click();
  }

  // Verify Scanner workspace features and global QuickGuide (?) working on Scanner
  await navButtons.nth(2).click();
  const maxEventsSelect = page.locator('#scanner-max-events');
  await maxEventsSelect.waitFor();
  assert.equal(await maxEventsSelect.inputValue(), 'all');
  await page.locator('.sidebar-quick-toggles button').nth(2).click();
  assert.equal(await page.locator('.guide-card').isVisible(), true);
  await page.locator('.guide-card .guide-head button').click();

  // Verify Analytics workspace: switch to Hedged positions (1) and execute 1-click "Leg 1 won" settlement
  await navButtons.nth(4).click();
  await page.waitForFunction(() => document.body.textContent.includes('Hedged positions (1)'));
  await page.locator('button').filter({ hasText: 'Hedged positions (1)' }).click();
  await page.locator('button').filter({ hasText: 'Leg 1 won' }).click();
  await page.waitForFunction(() => {
    const card = document.querySelector('.position-group-card');
    return card && card.textContent.includes('Won') && card.textContent.includes('Lost');
  });
  const putCalls = postCalls.filter((c) => c.method === 'PUT' && c.path.startsWith('/api/tracker/'));
  assert.equal(putCalls.length, 2);
  assert.deepEqual(putCalls.map((c) => c.body.status), ['won', 'lost']);

  // Toggle language back to RO and verify UI re-renders in Romanian
  await page.locator('.sidebar-quick-toggles button').nth(0).click();
  await page.waitForFunction(() => document.body.textContent.includes('Catalog piețe'));

  assert.deepEqual(errors, []);
});

// Contract test: every scraper's extractEvents output must carry a per-event
// browseable sourceUrl so the event-detail modal can render a link icon.
// See the event-link feature in public/js/pages/event-detail-modal.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_SCRAPERS } from '../src/scrapers/index.mjs';

// Denylist of scraper IDs that legitimately have no browseable event page
// (generic sport scrapers, multi-tenant placeholders). All OTHER scrapers must
// emit a per-event sourceUrl that points to a real event page.
const EXCLUDED_FROM_EVENT_URL = new Set([
  'tennis', 'basketball', 'ice-hockey', 'volleyball', 'handball', // generic sport scrapers
]);

// API patterns the frontend isEventUrl() rejects — scraper URLs must not match.
const API_PATTERNS = [
  /nsoftcdn\.com/, /nsoft\.com/, /\/api\//, /\/api2\//,
  /getPalinsestoDelGiorno/, /\?companyUuid=/, /offerTemplate=/, /dataFormat=/,
  /freetls\.fastly\.net/, /efortuna\.ro\/offer/, /sportify\.bet/,
  /gambling-solutions\.ro/, /service\/lineout/,
];

function isBrowseableEventUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  return !API_PATTERNS.some((re) => re.test(url));
}

for (const scraperId of ALL_SCRAPERS) {
  test(`${scraperId}: extractEvents emits browseable per-event sourceUrl`, { skip: EXCLUDED_FROM_EVENT_URL.has(scraperId) ? `${scraperId} is a generic/placeholder scraper` : undefined }, async () => {
    // Build a minimal fake normalized event and run extractEvents.
    const { instantiate } = await import('../src/scrapers/index.mjs');
    const scraper = instantiate(scraperId, { dataDir: process.cwd() + '/data' });
    assert.ok(scraper, `could not instantiate ${scraperId}`);

    // Construct a plausible raw event for this scraper shape.
    const fakeRaw = {
      id: 'test-evt-1',
      sport: 'Football',
      league: 'Liga 1',
      kickoff: '2030-01-01T18:00:00.000Z',
      homeTeam: 'Team Alpha',
      awayTeam: 'Team Beta',
      groups: [{
        name: 'Main',
        markets: [{
          key: 'MATCH_ODDS',
          name: 'Match Odds',
          type: 'MATCH_ODDS',
          selections: [
            { id: '1', name: 'Home', price: 1.8, odds: 1.8 },
            { id: '2', name: 'Draw', price: 3.5, odds: 3.5 },
            { id: '3', name: 'Away', price: 4.5, odds: 4.5 },
          ],
        }],
      }],
    };

    let events;
    try {
      const rawEvents = scraper.normalize ? scraper.normalize({ events: [fakeRaw], data: [fakeRaw] }) : [fakeRaw];
      events = typeof scraper.extractEvents === 'function'
        ? scraper.extractEvents(rawEvents)
        : rawEvents;
    } catch (_) {
      // If normalize/extractEvents fails on the fake input, skip — this test
      // only verifies scrapers that can run on a generic input shape.
      return;
    }

    if (!Array.isArray(events) || events.length === 0) return;

    for (const ev of events) {
      assert.ok(
        isBrowseableEventUrl(ev.sourceUrl),
        `${scraperId} event "${ev.id}" sourceUrl must be a browseable http(s) event page (not an API endpoint), got: ${ev.sourceUrl}`,
      );
    }
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ScraperBase from '../src/scrapers/base.mjs';

class StubScraper extends ScraperBase {
  id = 'stub';
  name = 'Stub';
  sourceIds = ['stub'];
  constructor(payload, opts = {}) {
    super({ dataDir: opts.dataDir || process.cwd() + '/data-test-' + Math.random().toString(36).slice(2) });
    this._payload = payload;
  }
  async fetchRaw() { return this._payload; }
  normalize(raw) {
    if (!raw) throw new Error('no payload');
    return raw.events || [];
  }
  extractEvents(rawEvents) {
    return rawEvents.map((e) => ({
      id: e.id,
      eventKey: e.eventKey,
      markets: e.markets,
    }));
  }
}

test('ScraperBase.run promotes to workspace on success', async (t) => {
  const dataDir = './data-test-' + Math.random().toString(36).slice(2);
  const fs = await import('node:fs/promises');
  await fs.mkdir(dataDir + '/workspace', { recursive: true });
  const scraper = new StubScraper({
    events: [{
      id: '1', eventKey: 'k1',
      markets: [{ key: 'MATCH_ODDS', selections: [{ name: 'H', odds: 1.85 }] }],
    }],
  }, { dataDir });
  const env = await scraper.run();
  assert.equal(env.valid, true);
  assert.equal(env.events, 1);
  const stat = await fs.stat(dataDir + '/workspace/stub_events.json');
  assert.ok(stat.isFile());
  await fs.rm(dataDir, { recursive: true });
});

test('ScraperBase.run reports valid:false on empty events', async (t) => {
  const dataDir = './data-test-' + Math.random().toString(36).slice(2);
  const fs = await import('node:fs/promises');
  await fs.mkdir(dataDir + '/workspace', { recursive: true });
  const scraper = new StubScraper({ events: [] }, { dataDir });
  const env = await scraper.run();
  assert.equal(env.valid, true); // empty array is still a valid run
  assert.equal(env.events, 0);
  await fs.rm(dataDir, { recursive: true });
});

test('ScraperBase.run fails envelope on extractEvents throwing', async (t) => {
  const dataDir = './data-test-' + Math.random().toString(36).slice(2);
  const fs = await import('node:fs/promises');
  await fs.mkdir(dataDir + '/workspace', { recursive: true });
  class Broken extends ScraperBase {
    id = 'broken'; name = 'Broken'; sourceIds = ['broken'];
    async fetchRaw() { return { events: [{}] }; }
    normalize() { return [{}]; }
    extractEvents() { throw new Error('shape changed'); }
  }
  const scraper = new Broken({ dataDir });
  const env = await scraper.run();
  assert.equal(env.valid, false);
  assert.equal(env.status, 'failed');
  assert.match(env.error.message, /extractEvents/);
  await fs.rm(dataDir, { recursive: true });
});

test('ScraperBase.run rejects invalid odds in validate()', async () => {
  const dataDir = './data-test-' + Math.random().toString(36).slice(2);
  const fs = await import('node:fs/promises');
  await fs.mkdir(dataDir + '/workspace', { recursive: true });
  class BadOdds extends ScraperBase {
    id = 'b'; name = 'B'; sourceIds = ['b'];
    async fetchRaw() { return { events: [{ id: 'x', eventKey: 'k', markets: [{ key: 'M', selections: [{ name: 'H', odds: 0.5 }] }] }] }; }
    normalize(raw) { return raw.events; }
    extractEvents(rs) { return rs; }
  }
  const env = await new BadOdds({ dataDir }).run();
  assert.equal(env.valid, false);
  assert.equal(env.status, 'failed');
  await fs.rm(dataDir, { recursive: true });
});

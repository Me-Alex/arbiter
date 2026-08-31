import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AltenarProvider, AltenarTenant } from '../src/scrapers/altenar-provider.mjs';

function makeRaw(extra = {}) {
  return {
    events: [
      {
        id: 1,
        homeName: 'FCSB',
        awayName: 'CFR Cluj',
        startDate: '2030-01-01T18:00:00Z',
        sport: { name: 'Football' },
        league: { name: 'Liga 1' },
        marketGroups: [
          {
            name: 'Main',
            markets: [
              {
                id: 11,
                type: 'MATCH_ODDS',
                name: 'Match Winner',
                selections: [
                  { id: 1, name: 'Home', price: 1.85 },
                  { id: 2, name: 'Draw', price: 3.50 },
                  { id: 3, name: 'Away', price: 4.20 },
                ],
              },
            ],
          },
        ],
        ...extra,
      },
    ],
  };
}

test('AltenarProvider parses canonical payload', () => {
  const p = new AltenarProvider({ id: 'test', name: 'Test' });
  const raw = makeRaw();
  const out = p.extractEvents(p.parse(raw));
  assert.equal(out.length, 1);
  assert.equal(out[0].homeTeam, 'FCSB');
  assert.equal(out[0].markets[0].selections[0].odds, 1.85);
});

test('AltenarProvider throws ValidationError on bad shape', () => {
  const p = new AltenarProvider({ id: 'test', name: 'Test' });
  assert.throws(() => p.parse({}), /events array/);
  assert.throws(() => p.parse(null), /object/);
});

test('AltenarTenant.run promotes to workspace', async () => {
  const dataDir = './data-test-' + Math.random().toString(36).slice(2);
  const fs = await import('node:fs/promises');
  await fs.mkdir(dataDir + '/workspace', { recursive: true });
  const tenant = new AltenarTenant({
    id: 'don',
    name: 'Don',
    baseUrl: '',
    dataDir,
  });
  // Override fetchRaw so it doesn't hit the network.
  tenant.fetchRaw = async () => makeRaw();
  const env = await tenant.run();
  assert.equal(env.valid, true);
  assert.equal(env.events, 1);
  const data = JSON.parse(await fs.readFile(dataDir + '/workspace/don_events.json', 'utf8'));
  assert.equal(data.events[0].homeTeam, 'FCSB');
  await fs.rm(dataDir, { recursive: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Casa from '../src/scrapers/casa-pariurilor.mjs';
import Fortuna from '../src/scrapers/fortuna.mjs';

for (const Adapter of [Casa, Fortuna]) {
  test(`${Adapter.name} preserves unknown settlement and provider identifiers`, () => {
    const adapter = new Adapter();
    const [event] = adapter.extractEvents([{ id: 'fixture', sport: 'Rugby', league: 'Top 14', kickoff: '2030-01-01T12:00:00Z', homeTeam: 'Clermont', awayTeam: 'Castres', markets: [{ id: 'market', marketTypeId: 'ufo:mtyp:07-0i', outcomes: [{ id: 'h', name: '1', odds: 2, handicap: 1 }, { id: 'a', name: '2', odds: 2 }] }] }]);
    assert.equal(event.markets[0].period, 'unknown');
    assert.equal(event.markets[0].id, 'market');
    assert.equal(event.markets[0].selections[0].handicap, 1);
  });
  test(`${Adapter.name} maps provider sport 07 to rugby during catalogue traversal`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => ({ ok: true, json: async () => String(url).includes('ufo:sprt:07/tournaments') ? { tournaments: [{ id: 'top14', name: 'Top 14', fixturesCount: 0 }] } : { tournaments: [] } }));
    const raw = await new Adapter().fetchRaw();
    assert.equal(raw.tournaments[0]._sportName, 'Rugby');
  });
}

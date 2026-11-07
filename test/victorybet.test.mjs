import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { instantiate } from '../src/scrapers/index.mjs';
import VictoryBet from '../src/scrapers/victorybet.mjs';
import { resolveContract } from '../src/scanner/market-contracts.mjs';

const CFG = JSON.parse(readFileSync(new URL('../config/scrapers.json', import.meta.url), 'utf8'));
const JOB = CFG.jobs ? CFG.jobs.find((j) => j.id === 'victorybet') : CFG.find((j) => j.id === 'victorybet');
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/victorybet-swarm.json', import.meta.url), 'utf8'));

test('victorybet: job configuration in scrapers.json', () => {
  assert.ok(JOB, 'victorybet job entry must exist in scrapers.json');
  assert.equal(JOB.enabled, true);
  assert.equal(JOB.validationStatus, 'validated');
  assert.equal(JOB.engine, 'betconstruct-swarm');
  assert.equal(JOB.transport, 'betconstruct-swarm-ws');
  assert.equal(JOB.script, 'victorybet.mjs');
  assert.deepEqual(JOB.sourceIds, ['victorybet']);
  assert.equal(JOB.platform, 'betconstruct-swarm');
});

test('victorybet: instantiates with expected identity and Swarm parameters', () => {
  const scraper = instantiate('victorybet');
  assert.ok(scraper instanceof VictoryBet);
  assert.equal(scraper.id, 'victorybet');
  assert.equal(scraper.name, 'VictoryBet');
  assert.deepEqual(scraper.sourceIds, ['victorybet']);
  assert.equal(scraper.wsUrl, 'wss://eu-swarm-reverse.victorybet.ro/');
  assert.equal(scraper.siteId, 18754351);
  assert.equal(scraper.sourceUrl, 'https://www.victorybet.ro/rv/sport');
});

test('victorybet: normalizes and extracts multi-sport events from Swarm fixture', () => {
  const scraper = new VictoryBet({ maxEvents: 200, sports: ['football', 'basketball', 'tennis', 'ice-hockey'] });
  const rawGames = scraper.normalize(FIXTURE);
  assert.ok(Array.isArray(rawGames));
  assert.ok(rawGames.length >= 30, `expected >=30 games, got ${rawGames.length}`);

  const events = scraper.extractEvents(rawGames);
  assert.ok(events.length >= 30, `expected >=30 events, got ${events.length}`);

  const sportsSeen = new Set(events.map((e) => e.sport.toLowerCase()));
  assert.ok(sportsSeen.has('ice hockey') || sportsSeen.has('ice-hockey'));
  assert.ok(sportsSeen.has('football'));
  assert.ok(sportsSeen.has('basketball'));
  assert.ok(sportsSeen.has('tennis'));

  for (const ev of events) {
    assert.equal(ev.sourceId, 'victorybet');
    assert.ok(ev.id);
    assert.ok(ev.homeTeam);
    assert.ok(ev.awayTeam);
    assert.notEqual(ev.homeTeam, ev.awayTeam);
    assert.ok(ev.kickoff);
    assert.ok(Array.isArray(ev.markets));
    assert.ok(ev.markets.length > 0);

    for (const m of ev.markets) {
      assert.ok(m.key, `market key must be defined for ${m.name}`);
      assert.ok(Array.isArray(m.selections), 'market selections must be an array');
      assert.ok(m.selections.length >= 2, 'market must have at least 2 selections');

      // Verify each selection has odds > 1
      for (const s of m.selections) {
        assert.ok(Number.isFinite(s.odds) && s.odds > 1, `odds must be finite and > 1: ${s.odds}`);
      }

      // Verify contract resolution
      const contract = resolveContract(m, { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, sport: ev.sport });
      assert.ok(contract, `market ${m.key} (${m.name}) must resolve to a valid contract`);
    }
  }
});

test('victorybet: handles mock Swarm WebSocket handshake and query protocol', async () => {
  const sentMessages = [];
  class MockWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      setTimeout(() => this.emit('open'), 1);
    }
    send(data) {
      const msg = JSON.parse(data);
      sentMessages.push(msg);
      if (msg.command === 'request_session') {
        setTimeout(() => {
          this.emit('message', JSON.stringify({ rid: 'sess-1', code: 0, data: { sid: 'mock-session-1' } }));
        }, 1);
      } else if (msg.command === 'get') {
        setTimeout(() => {
          this.emit('message', JSON.stringify({ rid: 'games-1', code: 0, data: FIXTURE.data }));
        }, 1);
      }
    }
    close() {}
    terminate() {}
  }

  const scraper = new VictoryBet({ wsImpl: MockWebSocket, sports: ['football'] });
  const raw = await scraper.fetchRaw();
  assert.ok(raw);
  assert.equal(raw.code, 0);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].command, 'request_session');
  assert.equal(sentMessages[1].command, 'get');
  assert.equal(sentMessages[1].params.what.sport[0], 'id');
});

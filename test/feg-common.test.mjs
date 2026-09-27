import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Casa from '../src/scrapers/casa-pariurilor.mjs';
import Fortuna from '../src/scrapers/fortuna.mjs';
import { describeError, summariseReasons } from '../src/scrapers/feg-common.mjs';

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

/**
 * A failure count says how many; it does not say why, and the two are what a
 * run report needs. "All 13 catalogue requests failed" is the one message
 * that names none of the possible causes — a refused connection, a 403 and a
 * timeout are three different problems that all read as that line.
 *
 * These assertions are about the message, not the scraping: each forces one
 * cause and checks that it survives all the way to the error the run reports.
 */
test('describeError unwraps the cause fetch hides', () => {
  // fetch wraps everything in `TypeError: fetch failed` and puts the real
  // reason on `cause`, so reporting the message alone loses it.
  const dns = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.efortuna.ro' },
  });
  assert.match(describeError(dns), /ENOTFOUND/, 'the code is the whole story');

  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ECONNREFUSED' },
  });
  assert.match(describeError(refused), /ECONNREFUSED/);

  // An error with no cause still says something rather than nothing.
  assert.ok(describeError(new Error('boom')).includes('boom'));
  assert.ok(describeError(null).length > 0, 'a missing error is described, not blank');
});

test('summariseReasons counts each cause once and keeps the worst', () => {
  const reasons = new Map([
    ['catalogue: ENOTFOUND', 1],
    ['catalogue: HTTP 403', 13],
  ]);
  const out = summariseReasons(reasons);
  assert.match(out, /catalogue: HTTP 403 ×13/, 'a repeated cause carries its count');
  assert.doesNotMatch(out, /×1\b/, 'a single occurrence needs no count');
  assert.ok(summariseReasons(new Map()).length > 0, 'an empty map still yields a phrase');
  // The most common cause is the informative one, so a limit keeps it even
  // when it is not the first one recorded.
  assert.match(summariseReasons(reasons, 1), /HTTP 403/);
});

test('a total failure names its cause, whichever it was', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-fortuna-'));
  try {
    const causes = [
      ['ENOTFOUND', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }],
      ['HTTP 403', () => ({ ok: false, status: 403, json: async () => ({}) })],
    ];
    for (const [expected, impl] of causes) {
      const s = new Fortuna({ timeoutMs: 5_000, dataDir });
      const original = globalThis.fetch;
      globalThis.fetch = async () => impl();
      try {
        const result = await s.run();
        assert.equal(result.status, 'failed', 'a total failure is a failed run');
        assert.match(result.error.message, new RegExp(expected),
          `the message names the cause (${expected}): ${result.error.message}`);
      } finally {
        globalThis.fetch = original;
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

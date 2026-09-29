import test from 'node:test';
import assert from 'node:assert/strict';

import ExcelBet from '../src/scrapers/excelbet.mjs';
import WinBoss from '../src/scrapers/winboss.mjs';
import LasVegas from '../src/scrapers/las-vegas.mjs';
import MagnumBet from '../src/scrapers/magnumbet.mjs';

/**
 * The four Exalogic tenants share one adapter shape and one feed, differing
 * only in host and systemCode.
 *
 * They are siblings, not copies: the constructor assigns what `fetchRaw`
 * reads, and a sibling that skipped an assignment compiled fine, passed the
 * whole unit suite, and then requested
 * `undefined/getPalinsestoDelGiorno?systemCode=undefined` forever. It reported
 * "all day fetches returned 0 events" — a clean, empty, entirely wrong run.
 * That is what these assertions exist to prevent.
 */

const TENANTS = [
  { name: 'excelbet', Cls: ExcelBet, host: /excelbet/i, code: 'EXCELBET' },
  { name: 'winboss', Cls: WinBoss, host: /winboss/i, code: 'WINBOSS' },
  { name: 'las-vegas', Cls: LasVegas, host: /lasvegas/i, code: 'LASVEGAS' },
  { name: 'magnumbet', Cls: MagnumBet, host: /magnumbet/i, code: 'MAGNUMBET' },
];

for (const { name, Cls, host, code } of TENANTS) {
  test(`${name} is configured with the endpoint its fetch actually calls`, () => {
    const s = new Cls({ maxEvents: 10 });
    // Anything undefined here produces a request to a URL built from
    // "undefined", which resolves nowhere and yields an empty day.
    assert.ok(s.apiBase, `${name}: apiBase must be assigned`);
    assert.ok(s.systemCode, `${name}: systemCode must be assigned`);
    assert.match(s.apiBase, host, `${name}: apiBase should point at this tenant's host`);
    assert.equal(s.systemCode, code);
    assert.ok(!s.apiBase.includes('undefined'), `${name}: apiBase must not contain "undefined"`);
    assert.ok(!String(s.systemCode).includes('undefined'), `${name}: systemCode must not contain "undefined"`);
  });

  test(`${name} is configured with the values its fetch loop reads`, () => {
    const s = new Cls({ maxEvents: 10 });
    // `Array.from({ length: this.days })` with an undefined days produces a
    // zero-length array: no request is made at all, and the run reports zero
    // events without an error.
    assert.ok(Number.isInteger(s.days), `${name}: days must be a whole number`);
    assert.ok(s.days >= 1 && s.days <= 31, `${name}: days out of range`);
    assert.ok(Number.isFinite(s.timeoutMs) && s.timeoutMs > 0, `${name}: timeoutMs must be a positive number`);
  });

  test(`${name} rejects a nonsense window rather than silently fetching nothing`, () => {
    assert.throws(() => new Cls({ days: 0 }), /invalid days/, `${name}: days=0 must be rejected`);
    assert.throws(() => new Cls({ days: 99 }), /invalid days/, `${name}: days=99 must be rejected`);
  });

  test(`${name} treats a non-2xx response as a failure, not an empty day`, () => {
    // Returning [] on an HTTP error made a 500 on today plus an empty 200 on
    // tomorrow indistinguishable from a complete, quiet run.
    const source = Cls.prototype.fetchRaw.toString();
    assert.doesNotMatch(source, /!\s*response\.ok\s*\)\s*return\s*\[\]/,
      `${name}: must not swallow an HTTP error as an empty day`);
    assert.match(source, /UpstreamError/, `${name}: must raise on a non-2xx response`);
  });
}

test('MagnumBet inherits the adapter but not the parent identity', () => {
  const s = new MagnumBet({ maxEvents: 10 });
  assert.equal(s.id, 'magnumbet');
  assert.deepEqual(s.sourceIds, ['magnumbet']);
  assert.equal(s.systemCode, 'MAGNUMBET', 'it overrides the system code');
  assert.notEqual(s.systemCode, new ExcelBet({}).systemCode);
});

test('WinBoss and Las Vegas inherit the adapter, not a copy of it', () => {
  // Both used to be near-verbatim copies of excelbet.mjs. A copy fixes bugs
  // only if someone remembers to fix it in every copy, and the WinBoss copy's
  // content-type error still said "ExcelBet". Assert on the shared prototype so
  // a future divergence is a test failure rather than silent drift.
  for (const Cls of [WinBoss, LasVegas, MagnumBet]) {
    assert.equal(Cls.prototype.fetchRaw, ExcelBet.prototype.fetchRaw,
      `${Cls.name} must share the one fetchRaw implementation`);
    assert.equal(Cls.prototype.extractEvents, ExcelBet.prototype.extractEvents,
      `${Cls.name} must share the one extractEvents implementation`);
  }
  assert.notEqual(new WinBoss({}).systemCode, new LasVegas({}).systemCode);
  assert.match(new WinBoss({}).name, /WinBoss/i);
  assert.match(new LasVegas({}).name, /Las Vegas/i);
});

test('every Exalogic tenant publishes under its own sourceId, not the parent\'s', () => {
  // The misattribution this guards: extractEvents is shared, so a literal
  // sourceId would file MagnumBet/WinBoss/LasVegas prices under 'excelbet'
  // and make one feed look like four independent books.
  const raw = {
    avs: {
      avs: [{
        lv: 0, bid: 9001, ts: '20261015 16:45:00',
        dsl: { RO: 'Gazogene - Rangers' }, p: 'Liga 1',
        scs: [{ cs: 3, d: 'FINAL', eqs: [{ ce: 1, q: '315' }, { ce: 2, q: '457' }, { ce: 3, q: '149' }] }],
      }],
    },
  };
  const seen = new Set();
  for (const { name, Cls } of TENANTS) {
    const s = new Cls({ maxEvents: 10 });
    const [event] = s.extractEvents(s.normalize(raw));
    assert.ok(event, `${name}: must extract the fixture event`);
    assert.equal(event.sourceId, name, `${name}: must publish as "${name}", not "${event.sourceId}"`);
    assert.equal(event.transport, 'exalogic-xsport-public-json');
    // Four-decimal prices must survive q/100 exactly.
    assert.equal(event.markets[0].selections[0].odds, 3.15);
    seen.add(event.sourceId);
  }
  assert.equal(seen.size, 4, 'four tenants must produce four distinct sourceIds');
});

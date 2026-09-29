/* global structuredClone, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import NSoft from '../src/scrapers/nsoft.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { resolveContract, canonicalOutcomeFor } from '../src/scanner/market-contracts.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/nsoft-public.json', import.meta.url)));
const config = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url)));
function setup(opts = {}) {
  const s = new NSoft('admiral', { windowHours: 24, ...opts });
  const events = s.normalize(structuredClone(fixture));
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  return { s, events, e: events.find((e) => e.sportId === 4) };
}
test('actual compact fixture decodes football, ordered participants and FT outcomes', () => {
  const { s, events, e } = setup();
  const out = s.extractEvents(events);
  assert.equal(out.length, 1);
  assert.equal(out[0].sport, 'Football');
  assert.equal(out[0].markets[0].key, '1x2');
  assert.equal(out[0].league, e.tournamentName);
  assert.equal(out[0].homeTeam, e.competitors.find((c) => c.type === 1).name);
  assert.deepEqual(out[0].markets[0].selections.map((o) => o.name), ['1', 'X', '2']);
});
for (const [name, mutate] of Object.entries({
  invalidSport: (e) => { e.sportId = 999; e.tournamentName = ''; }, inactive: (e) => { e.active = 0; },
  past: (e) => { e.startsAt = '2020-01-01'; }, invalidDate: (e) => { e.startsAt = 'bad'; },
  late: (e) => { e.startsAt = '2099-01-01'; },
  suspended: (_e, m) => { m.active = 0; },
  halfTime: (_e, m) => { m.name = 'Prima repriza'; },
  line: (_e, m) => { m.specialValues = ['1']; },
  duplicateMarket: (e, m) => { e.markets.push(structuredClone(m)); },
  missingOutcome: (_e, m) => { m.outcomes.pop(); },
  duplicateOutcome: (_e, m) => { m.outcomes[1] = structuredClone(m.outcomes[0]); },
  infinite: (_e, m) => { m.outcomes.forEach((o) => { o.odd = Infinity; }); },
  stringOdds: (_e, m) => { m.outcomes.forEach((o) => { o.odd = 'bad'; }); },
  closedOutcome: (_e, m) => { m.outcomes.forEach((o) => { o.active = 0; }); },
})) test(`rejects ${name}`, () => {
  const { s, e } = setup();
  // Invalidate ALL markets so multi-market extraction also fails.
  const snapshot = e.markets.slice();
  for (const m of snapshot) mutate(e, m);
  assert.deepEqual(s.extractEvents([e]), []);
});
test('caps, duplicates, malformed schemas and unsupported options', async () => {
  const { s, e } = setup({ maxEvents: 1 });
  assert.equal(s.extractEvents([e, e]).length, 1);
  assert.equal(setup({ maxEvents: 0 }).s.extractEvents([e]).length, 0);
  assert.throws(() => s.normalize({}), /data.events/);
  assert.throws(() => new NSoft('admiral', { maxEvents: -1 }));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(s.fetchRaw({ signal: ac.signal }), { name: 'AbortError' });
});
test('exact routing contracts and snapshot provenance for all three tenants', async (t) => {
  // scratch/ is gitignored, so it does not exist in a fresh clone and mkdtemp
  // into it would fail there. Create the root before asking for a child of it.
  await fs.mkdir(new URL('../scratch/', import.meta.url), { recursive: true });
  const dir = await fs.mkdtemp(new URL('../scratch/nsoft-test-', import.meta.url));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const id of ['admiral', 'stanleybet', 'maxbet']) {
    const jobConfig = config.jobs.find((j) => j.id === id);
    const raw = id === 'maxbet'
      ? JSON.parse(await fs.readFile(new URL('./fixtures/nsoft-maxbet.json', import.meta.url)))
      : structuredClone(fixture);
    for (const e of Object.values(raw.data.events)) e.n = new Date(Date.now() + 3600000).toISOString();
    const s = instantiate(id, { jobConfig, dataDir: dir, runId: 'fixture-run', windowHours: 24, fetchImpl: async () => new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }) });
    const result = await s.run();
    assert.equal(result.events, 1);
    assert.equal(result.valid, true);
    const snapshot = JSON.parse(await fs.readFile(result.outputs[0]));
    assert.equal(snapshot.runId, 'fixture-run');
    // The snapshot transport must equal the job's CONFIGURED transport, per
    // tenant. This previously asserted a hardcoded 'nsoft-public-sports-json',
    // which passed only because the adapter also hardcoded it — so admiral,
    // whose config declares 'bookmaker-public-json', was recording a transport
    // that contradicted its own job and nothing noticed. The two hardcodings
    // cancelled out; asserting against the config is what exposes that.
    assert.equal(snapshot.transport, jobConfig.transport, `snapshot transport must match the configured transport for ${id}`);
    assert.match(snapshot.sourceUrl, /companyUuid=/);
    assert.equal(snapshot.events[0].sourceId, id);
    assert.throws(() => instantiate(id, { jobConfig: { ...jobConfig, script: 'unknown.mjs' } }), { code: 'ESCRAPERCONFIG' });
  }
});
test('HTTP and non-JSON failures are not empty successes', async () => {
  await assert.rejects(new NSoft('admiral', { fetchImpl: async () => new Response('', { status: 403 }) }).fetchRaw(), /403/);
  await assert.rejects(new NSoft('admiral', { fetchImpl: async () => new Response('<html>') }).fetchRaw(), /expected JSON/);
});

/**
 * Football is a per-tenant concept on this platform, not a global one.
 *
 * Each tenant numbers its own catalogue: measured on 2026-09-26, football is
 * sport id 4 for the Admiral/Stanleybet tenant and id 2 for MaxBet's. A single
 * shared table mislabels at least one of them, and a mislabel is not cosmetic
 * — the emitted `sport` feeds the event identity key, so a MaxBet event
 * published as anything but "Football" can never pair with another book's
 * football event.
 */
const maxbetFixture = JSON.parse(await fs.readFile(new URL('./fixtures/nsoft-maxbet.json', import.meta.url)));

test('the MaxBet tenant is read with its own football sport id', () => {
  const s = new NSoft('maxbet', { windowHours: 24 });
  const events = s.normalize(structuredClone(maxbetFixture));
  for (const e of events) {
    // The fixture predates the mapping-aware decode and carries no explicit
    // sportId, so assert on the adapter's own gate rather than on the row.
    if (e.sportId === undefined) continue;
    assert.equal(e.sportId, 2, 'football is sport id 2 for this tenant');
  }

  const football = events.find((e) => e.sportId === 2);
  if (!football) {
    // Nothing to assert on a fixture without ids; the live check below covers it.
    return;
  }
  football.startsAt = new Date(Date.now() + 3600000).toISOString();
  const out = s.extractEvents([football]);
  assert.equal(out.length, 1);
  assert.equal(out[0].sport, 'Football', 'not Basketball: the label feeds the identity key');
  assert.equal(out[0].markets[0].key, '1x2');
});

test('an unrecognised sport id is named after itself, not guessed', () => {
  // A wrong sport label breaks matching; an opaque one only reads less nicely.
  const s = new NSoft('maxbet', { windowHours: 24 });
  const events = s.normalize(structuredClone(maxbetFixture));
  const unknown = events.find((e) => e.sportId === 987654);
  if (!unknown) return;
  unknown.startsAt = new Date(Date.now() + 3600000).toISOString();
  const out = s.extractEvents([unknown]);
  assert.equal(out.length, 0, 'a non-football event is not published at all');
});

/**
 * These tenants serve goals totals and both-teams-to-score in the same response
 * as the 1X2, so publishing only the result market threw away two
 * arbitrage-eligible families for three bookmakers.
 *
 * The risks these guard are the ones that would invent an arbitrage rather than
 * find one: a total that loses its line (OVER 2.5 colliding with OVER 3.5), a
 * BTTS market published under a spelling the engine cannot read (so it silently
 * stops being compared), and a neighbouring market that settles differently —
 * a team total, a first-half total, or MaxBet's single-leg
 * "Ambele marchează sau peste 2.5" — being published as the plain contract.
 */
const extrasFixtures = {
  admiral: fixture,
  maxbet: maxbetFixture,
};

/** Read the decoded football events for a tenant, timed so they are in window. */
function extrasEvents(id) {
  const s = new NSoft(id, { windowHours: 24 });
  const events = s.normalize(structuredClone(extrasFixtures[id]));
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  return { s, events };
}

for (const id of Object.keys(extrasFixtures)) {
  test(`${id}: the feed's totals and BTTS are published and the engine prices both`, () => {
    const { s, events } = extrasEvents(id);
    const out = s.extractEvents(events);
    assert.ok(out.length > 0, `${id}: expected the football event`);
    for (const e of out) {
      // The 1X2 is still first and still the contract that makes the event
      // trustworthy; the extras are additive behind it.
      assert.equal(resolveContract(e.markets[0]).family, 'MATCH_ODDS', `${id}: 1X2 must stay first`);

      const totals = e.markets.filter((m) => m.key === 'TOTAL_GOALS');
      assert.ok(totals.length > 0, `${id}: expected at least one total`);
      const lines = new Set();
      for (const m of totals) {
        const contract = resolveContract(m);
        assert.equal(contract.family, 'OVER_UNDER', `${id}: ${m.line} must price as a total`);
        // The line is the whole point: OVER 2.5 must never bucket with 3.5.
        assert.equal(contract.lineKey, m.line, `${id}: the line must reach the contract`);
        assert.deepEqual(m.selections.map((s2) => s2.name), [`Peste ${m.line}`, `Sub ${m.line}`]);
        for (const s2 of m.selections) assert.ok(s2.odds > 1, `${id}: a priced leg needs odds > 1`);
        lines.add(m.line);
      }
      assert.equal(lines.size, totals.length, `${id}: one market per line, no duplicates`);

      for (const m of e.markets.filter((x) => x.key === 'BTTS')) {
        const contract = resolveContract(m);
        assert.equal(contract.family, 'BTTS', `${id}: the BTTS must price as BTTS`);
        // Admiral's feed says "GG"/"NGG" and MaxBet's "Da"/"Nu"; both are
        // emitted canonically because the engine's matcher cannot read "NGG",
        // which would silently drop the leg from every comparison.
        assert.deepEqual(m.selections.map((s2) => s2.name), ['Da', 'Nu']);
        assert.equal(m.period, 'fulltime');
        for (const s2 of m.selections) assert.ok(s2.odds > 1, `${id}: a priced leg needs odds > 1`);
      }
    }
  });

  test(`${id}: markets that settle differently are never published`, () => {
    const { s, events } = extrasEvents(id);
    for (const e of s.extractEvents(events)) {
      for (const m of e.markets) {
        // Team totals, first-half totals and the single-leg "both teams score
        // OR over 2.5" are different contracts under other market ids. None may
        // be republished as a plain full-time total or BTTS.
        assert.ok(!/echipa|prima\s*rep|1h/i.test(String(m.name)), `${id}: ${m.name} is a different contract`);
        assert.equal(m.period, 'fulltime', `${id}: only full-time contracts are published`);
        const contract = resolveContract(m);
        if (contract) assert.notEqual(contract.family, 'DOUBLE_CHANCE', `${id}: DC is not a surebet`);
      }
    }
  });
}

test('the totals and BTTS are additive: a bad extra never costs the event its 1X2', () => {
  // Suspend the 2.5 total and unprice the BTTS on MaxBet: both extras must
  // disappear, every other line must survive, and the 1X2 must still publish.
  const raw = structuredClone(maxbetFixture);
  for (const v of Object.values(raw.data.events)) {
    for (const m of (v.o || [])) {
      if (m.b === 1547 && String(m.g?.[0]) === '2.5') m.d = 0; // market inactive
      if (m.b === 1709) m.h[0].g = 1; // BTTS "Da" priced at 1
    }
  }
  const s = new NSoft('maxbet', { windowHours: 24 });
  const events = s.normalize(raw);
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  const out = s.extractEvents(events);
  assert.equal(out.length, 1);
  const families = out[0].markets.map((m) => resolveContract(m)?.family);
  assert.equal(families[0], 'MATCH_ODDS', 'the 1X2 still publishes');
  assert.ok(!families.includes('BTTS'), 'the unpriced BTTS is dropped');
  assert.ok(!out[0].markets.some((m) => m.line === '2.5'), 'the suspended total is dropped');
  assert.ok(out[0].markets.some((m) => m.line === '3.5'), 'the other totals survive');
});

test('the 1X2 is still required: breaking it drops the event whole', () => {
  const raw = structuredClone(maxbetFixture);
  for (const v of Object.values(raw.data.events)) {
    for (const m of (v.o || [])) if (m.b === 2) m.h[0].g = 1; // "1" priced at 1
  }
  const s = new NSoft('maxbet', { windowHours: 24 });
  const events = s.normalize(raw);
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  assert.deepEqual(s.extractEvents(events), [], 'extras never rescue an event without a valid result');
});

/**
 * The two-way Asian handicap these feeds serve alongside the totals, and the
 * third arbitrage-eligible family these tenants contribute.
 *
 * The risks guarded here are specific to handicaps, because a handicap is the
 * one market whose two legs are *meant* to disagree — the totals rule ("both
 * legs carry the market's line") rejects every real handicap — and the one
 * family the engine's auto-detector reads backwards on the provider's own
 * "H1"/"H2" names. Each test below pins one way that could invent an
 * arbitrage rather than find one.
 */
const AH_MARKETS = { admiral: 262, maxbet: 8 };

for (const [id, marketId] of Object.entries(AH_MARKETS)) {
  test(`${id}: the two-way Asian handicap is published per line and prices as a handicap`, () => {
    const { s, events } = extrasEvents(id);
    const out = s.extractEvents(events);
    assert.ok(out.length > 0, `${id}: expected the football event`);

    for (const e of out) {
      const hands = e.markets.filter((m) => m.key === 'ASIAN_HANDICAP');
      assert.ok(hands.length > 0, `${id}: expected at least one handicap`);
      const seen = new Set();
      for (const m of hands) {
        const contract = resolveContract(m);
        // The decisive assertion: "H1 -0.5"/"H2 0.5" must not be read as a
        // goals total. The auto-detector's handicap keyword only matches names
        // starting with 1/2, so without an explicit key route a 0.5 handicap
        // buckets into OVER_UNDER/0.5 alongside a 0.5 total — two contracts
        // with opposite payouts reported as one.
        assert.equal(contract.family, 'ASIAN_HANDICAP', `${id}: ${m.line} must price as a handicap`);
        assert.equal(contract.lineKey, `${m.line}/${String(-Number(m.line))}`, `${id}: both legs must reach the contract`);
        // One market per line: a -0.5 and a 0.5 handicap are different contracts.
        assert.equal(m.selections.length, 2, `${id}: a handicap is two-way`);
        // The feed's own labels are "H1 -0.5"/"H2 0.5"; they are recognised, not
        // published. canonicalOutcomeFor labels an Asian-handicap leg by a
        // leading 1/2, "home" or "away" and nothing else, so the numbered form is
        // the only one that PRICES. The provider label survives on providerName.
        assert.deepEqual(m.selections.map((s2) => s2.name), [`1 (${m.line})`, `2 (${-Number(m.line)})`]);
        assert.deepEqual(m.selections.map((s2) => s2.providerName), [`H1 ${m.line}`, `H2 ${-Number(m.line)}`],
          `${id}: the provider label is preserved verbatim`);
        // A contract that resolves is not a contract that prices. This is the
        // assertion that was missing while "H1"/"H2" shipped: 583 markets and
        // 1,166 legs across maxbet/admiral/stanleybet resolved ASIAN_HANDICAP
        // and then routed every single leg to null, so the largest block of
        // handicap markets in the engine produced no price at all.
        assert.deepEqual(
          m.selections.map((s2) => canonicalOutcomeFor(s2.name, contract, m)),
          ['home', 'away'],
          `${id}: both legs must route to a side`,
        );
        // The two legs sit at opposite values by construction. findMiddles pairs
        // any two legs in a bucket whose handicaps differ without checking they
        // are the same side, so stamping the MARKET line on both would report a
        // middle between one market's own two sides.
        assert.deepEqual(m.selections.map((s2) => Number(s2.handicap)), [Number(m.line), -Number(m.line)],
          `${id}: each leg carries its OWN line`);
        for (const s2 of m.selections) assert.ok(s2.odds > 1, `${id}: a priced leg needs odds > 1`);
        assert.equal(m.period, 'fulltime', `${id}: only full-time handicaps are published`);
        assert.equal(m.providerMarketId, marketId, `${id}: the provider id is preserved`);
        assert.ok(!seen.has(m.line), `${id}: ${m.line} published twice`);
        seen.add(m.line);
        // A half-line is the only line on which a handicap has no push.
        assert.match(m.line, /^-?\d+\.5$/, `${id}: only half lines are exhaustive`);
      }
    }
  });

  test(`${id}: a handicap never reuses a neighbouring contract`, () => {
    const { s, events } = extrasEvents(id);
    for (const e of s.extractEvents(events)) {
      for (const m of e.markets) {
        // "Handicap (incl prel)" settles including extra time, MaxBet's
        // "Handicap game-uri" handicaps goals scored rather than the result and
        // "Handicap 1X2" is three-way with an HX leg. Publishing any of them as
        // a result handicap lets a price that settles on a different event stand
        // in for another book's handicap.
        if (m.key === 'ASIAN_HANDICAP') {
          assert.equal(m.outcomes, undefined, `${id}: no stray outcomes field`);
          assert.equal(m.selections.length, 2, `${id}: never a three-way handicap`);
        }
        assert.ok(!/incl\s*prel/i.test(String(m.name)), `${id}: ${m.name} settles with extra time`);
        assert.ok(!/game-uri|1x2/i.test(String(m.name)), `${id}: ${m.name} is a different contract`);
      }
    }
  });
}

test('a whole-line handicap is refused: at a whole line the stake is returned, so it is not exhaustive', () => {
  // No tenant currently quotes a whole line, so the case is built by hand. The
  // engine would also read a whole-line "H1 -1"/"H2 1" pair as OVER_UNDER/1
  // rather than as a handicap, so publishing one would both report a
  // push-cancelled arbitrage and mislabel the contract.
  const raw = structuredClone(maxbetFixture);
  for (const v of Object.values(raw.data.events)) {
    for (const m of (v.o || [])) {
      if (m.b !== 8) continue;
      const line = String(m.g[0]).replace('.5', '');
      m.g = [line];
      m.h[0].e = `H1 ${line}`;
      m.h[1].e = `H2 ${-Number(line)}`;
    }
  }
  const s = new NSoft('maxbet', { windowHours: 24 });
  const events = s.normalize(raw);
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  const out = s.extractEvents(events);
  assert.equal(out.length, 1, 'the event still publishes');
  assert.ok(!out[0].markets.some((m) => m.key === 'ASIAN_HANDICAP'), 'no whole-line handicap is published');
  assert.equal(resolveContract(out[0].markets[0]).family, 'MATCH_ODDS', 'the 1X2 is unaffected');
});

test('a handicap whose legs do not mirror each other is refused', () => {
  const cases = [
    ['both legs at the market line', (m) => { m.h[1].e = m.h[0].e; }],
    ['a leg at a line the market does not carry', (m) => { m.h[1].e = `H2 ${-Number(m.g[0]) - 1}`; }],
    ['the home leg missing its line', (m) => { m.h[0].e = 'H1'; }],
  ];
  for (const [what, break_] of cases) {
    const raw = structuredClone(maxbetFixture);
    for (const v of Object.values(raw.data.events)) {
      for (const m of (v.o || [])) if (m.b === 8) break_(m);
    }
    const s = new NSoft('maxbet', { windowHours: 24 });
    const events = s.normalize(raw);
    for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
    const out = s.extractEvents(events);
    assert.equal(out.length, 1, `${what}: the event still publishes`);
    assert.ok(!out[0].markets.some((m) => m.key === 'ASIAN_HANDICAP'), `${what}: the handicap is refused`);
    assert.equal(resolveContract(out[0].markets[0]).family, 'MATCH_ODDS', `${what}: the 1X2 is unaffected`);
  }
});

test('an invalid handicap never costs the event its 1X2 or its other markets', () => {
  // Suspend the -0.5 handicap and unprice the -1.5 one: both must disappear
  // while the remaining lines, the totals, the BTTS and the 1X2 all survive.
  const raw = structuredClone(maxbetFixture);
  for (const v of Object.values(raw.data.events)) {
    for (const m of (v.o || [])) {
      if (m.b !== 8) continue;
      if (String(m.g?.[0]) === '-0.5') m.d = 0;
      if (String(m.g?.[0]) === '-1.5') m.h[1].g = 1;
    }
  }
  const s = new NSoft('maxbet', { windowHours: 24 });
  const events = s.normalize(raw);
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  const out = s.extractEvents(events);
  assert.equal(out.length, 1);
  const hands = out[0].markets.filter((m) => m.key === 'ASIAN_HANDICAP');
  assert.deepEqual(hands.map((m) => m.line), ['0.5'], 'only the sound line survives');
  assert.equal(resolveContract(out[0].markets[0]).family, 'MATCH_ODDS', 'the 1X2 still publishes');
  assert.ok(out[0].markets.some((m) => resolveContract(m)?.family === 'OVER_UNDER'), 'the totals survive');
  assert.ok(out[0].markets.some((m) => resolveContract(m)?.family === 'BTTS'), 'the BTTS survives');
});

test('the coverage string names only the families a tenant actually contributes', () => {
  // It used to be a hardcoded 'fulltime-1x2+tgoals+ah+btts' for any tenant with
  // an extras entry, which would have told the scanner betmen serves totals and
  // handicaps. It does not: betmen publishes BTTS and nothing else on football.
  assert.match(new NSoft('betmen', { windowHours: 24 })._serializable([], {}).coverage.market, /^fulltime-1x2\+btts$/);
  assert.match(new NSoft('admiral', { windowHours: 24 })._serializable([], {}).coverage.market, /tgoals\+ah\+btts/);
  assert.match(new NSoft('maxbet', { windowHours: 24 })._serializable([], {}).coverage.market, /tgoals\+ah\+btts/);
});

/**
 * betmen's BTTS, and the markets next to it that must stay out.
 *
 * This file previously asserted the opposite: "a tenant with no measured extras
 * still publishes its 1X2 alone", on the stated grounds that betmen's football
 * projection carried the result market and one combined market and nothing
 * else, so there was no id to look for. A capture taken 2026-09-29 over 293
 * football events falsified that — 261 of them carry "Ambele Marcheaza". The
 * tenant was contributing no BTTS at all, and a whole arbitrage family was
 * sitting unfetched behind a stale belief.
 *
 * The fixture is that capture, trimmed to one event, with the feed's own
 * `_mapping` intact so normalize() runs the production decode.
 */
const betmenFixture = JSON.parse(await fs.readFile(new URL('./fixtures/nsoft-betmen-btts.json', import.meta.url)));

test('betmen: its both-teams-to-score market is published and the engine prices it', () => {
  const s = new NSoft('betmen', { windowHours: 24 });
  const events = s.normalize(structuredClone(betmenFixture));
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  const out = s.extractEvents(events);
  assert.equal(out.length, 1, 'the football event is published');

  const btts = out[0].markets.filter((m) => m.key === 'BTTS');
  assert.equal(btts.length, 1, 'exactly one BTTS market, not one per line');
  const m = btts[0];
  // 4607 "Ambele Marcheaza" — the id and the display name are both recorded,
  // because a marketId alone is not a contract and this feed serves several
  // markets that mention GG or Total Goluri and settle differently.
  assert.equal(m.providerMarketId, 4607);
  assert.equal(m.name, 'Ambele Marcheaza');
  assert.equal(m.period, 'fulltime');
  assert.equal(m.selections.length, 2, 'BTTS is two-way');
  // betmen's own sides are GG / NG; _bttsMarket recognises both and re-emits
  // the canonical pair the engine's BTTS matcher reads.
  assert.deepEqual(m.selections.map((s2) => s2.name), ['Da', 'Nu']);
  assert.deepEqual(m.selections.map((s2) => s2.providerOutcomeId), [16676, 16679]);
  assert.ok(m.selections.every((s2) => s2.odds > 1), 'both legs are priced');

  const contract = resolveContract(m);
  assert.equal(contract.family, 'BTTS');
  assert.equal(contract.arbEligible, undefined, 'BTTS is arbitrable');
  // Resolving is not pricing. Both legs must reach a side or the market cannot
  // be compared with any other book's BTTS.
  assert.deepEqual(
    m.selections.map((s2) => canonicalOutcomeFor(s2.name, contract, {
      homeTeam: out[0].homeTeam, awayTeam: out[0].awayTeam,
    })),
    ['yes', 'no'],
  );
  assert.equal(resolveContract(out[0].markets[0]).family, 'MATCH_ODDS', 'the 1X2 stays first');
});

test('betmen: its interval totals and combination markets are not published', () => {
  // The fixture carries everything betmen quotes on this event. Only the 1X2 and
  // the BTTS may come out.
  //
  // 3960 "Total Goluri (TG)" is the trap. Its four legs are goal INTERVALS and
  // push lines — "2-4", "2-5", "2+", "3+" — in one market, with specialValues
  // empty so the line cannot even be read. There is no over leg and no under leg.
  // Reading "2-4" as one side of a goals total would invent an Over 1.5 /
  // Under 4.5 contract betmen never quoted, and it would pair with another
  // book's 2.5 total and settle on a different event.
  const s = new NSoft('betmen', { windowHours: 24 });
  const events = s.normalize(structuredClone(betmenFixture));
  for (const e of events) e.startsAt = new Date(Date.now() + 3600000).toISOString();
  const out = s.extractEvents(events);
  const keys = out[0].markets.map((m) => m.key);
  assert.deepEqual(keys, ['1x2', 'BTTS'], 'the 1X2 and the BTTS, nothing else');

  // Belt and braces: nothing that reached the engine resolves as a total, a
  // handicap or a combined contract.
  for (const m of out[0].markets) {
    const family = resolveContract(m)?.family;
    assert.ok(family === 'MATCH_ODDS' || family === 'BTTS',
      `${m.key} must not resolve as ${family}`);
  }
  // And the refused ids really were present on the feed, so this is a decision
  // rather than a fixture that happens not to carry them.
  const feedIds = new Set(events[0].markets.map((m) => m.marketId));
  for (const id of [3960, 4008, 2439, 2442, 2484, 2532, 3504, 2259, 3501, 2517, 398, 2445]) {
    assert.ok(feedIds.has(id), `fixture should carry market ${id}`);
  }
});


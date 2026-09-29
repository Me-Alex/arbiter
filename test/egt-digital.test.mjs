/* global structuredClone, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Egt, { matchesEgtConfig } from '../src/scrapers/egt.mjs';
import { instantiate } from '../src/scrapers/index.mjs';
import { isSharedFeed, feedGroupOf } from '../src/scanner/feed-groups.mjs';

/**
 * EGT Digital is a new platform, so this suite is the only thing standing
 * between a schema change and a scraper that quietly publishes nothing.
 *
 * The fixture is the live response shape: `events` is an object keyed by
 * sportEventId, `live` is a boolean, the result market is the one the provider
 * names 1X2, and the same events carry three-way lookalikes ("Golul X" with
 * 1 / Niciunul / 2) that must never be published as a match result.
 */
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/egt-digital.json', import.meta.url)));
const config = JSON.parse(await fs.readFile(new URL('../config/scrapers.json', import.meta.url)));

/** A fetchImpl that serves the fixture's containers and 404s the rest. */
function stubFetch(probed) {
  return async (url) => {
    probed.push(String(url));
    const m = /normalized\/(\d+)/.exec(String(url));
    const id = m ? Number(m[1]) : null;
    const container = fixture.containers.find((c) => c.containerId === id);
    if (!container) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ containerId: id, containerName: container.containerName, events: container.events }), {
      headers: { 'content-type': 'application/json' },
    });
  };
}

function setup(id = 'prowin', opts = {}) {
  const probed = [];
  const s = new Egt(id, { windowHours: 24, fetchImpl: stubFetch(probed), ...opts });
  return { s, probed };
}

test('the live fixture yields only prematch events with a complete 1X2', () => {
  const { s } = setup();
  const raw = s.normalize({ containers: fixture.containers.map((c) => ({ containerId: c.containerId, url: 'u', status: 200, body: { events: c.events } })) });
  const out = s.extractEvents(raw);
  assert.ok(out.length > 0, 'the fixture must produce events or this suite proves nothing');
  for (const ev of out) {
    assert.equal(ev.sourceId, 'prowin');
    assert.equal(ev.sport, 'Football');
    assert.equal(ev.isLive, false);
    assert.equal(ev.markets.length, 1);
    assert.deepEqual(ev.markets[0].selections.map((o) => o.name), ['1', 'X', '2']);
    assert.ok(ev.markets[0].selections.every((o) => Number.isFinite(o.odds) && o.odds > 1));
    assert.equal(ev.markets[0].period, 'fulltime');
    assert.ok(ev.league && ev.homeTeam && ev.awayTeam);
    assert.ok(Date.parse(ev.kickoff) > Date.now() - 3600000, 'kickoff is current or future');
  }
});

test('live events are excluded, not published', () => {
  const { s } = setup();
  const raw = s.normalize({ containers: fixture.containers.map((c) => ({ containerId: c.containerId, url: 'u', status: 200, body: { events: c.events } })) });
  const out = s.extractEvents(raw);
  // The fixture deliberately includes live=true events (container 4155).
  const liveInFixture = Object.values(fixture.containers[0].events).filter((e) => e.live === true).length;
  assert.ok(liveInFixture > 0, 'fixture must contain live events for this to mean anything');
  assert.ok(out.every((e) => e.isLive === false));
});

test('a three-way lookalike market is never published as the result', () => {
  // "Golul X" carries outcomes 1 / Niciunul / 2 — three outcomes, but not a
  // match result. A naive three-way test publishes it and invents a settlement.
  const { s } = setup();
  const raw = s.normalize({ containers: fixture.containers.map((c) => ({ containerId: c.containerId, url: 'u', status: 200, body: { events: c.events } })) });
  const out = s.extractEvents(raw);
  const goalMarketEvent = Object.values(fixture.containers[0].events)
    .find((e) => (e.markets || []).some((m) => /golul/i.test(m.marketTemplateName || m.marketTitle || '')));
  assert.ok(goalMarketEvent, 'fixture must include an event with a goals-in-X market');
  // That event either has no 1X2 market (so nothing is published for it) or has
  // one (so only that one is).
  const forEvent = out.filter((e) => String(e.id) === String(goalMarketEvent.sportEventId));
  for (const ev of forEvent) {
    assert.match(ev.markets[0].name, /^1[xX]2$/);
  }
  assert.ok(out.every((e) => e.markets[0].name === '1X2'));
});

test('the device gate headers are sent on every request', () => {
  const headersSeen = [];
  const s = new Egt('prowin', {
    windowHours: 24,
    fetchImpl: async (url, opts) => {
      headersSeen.push(opts.headers);
      return new Response('', { status: 404 });
    },
  });
  // Every container 404s, so fetchRaw must fail rather than report an empty
  // success — and every attempt must still have carried the gate headers.
  return s.fetchRaw().then(
    () => assert.fail('a run with no readable container must fail'),
    () => {
      assert.ok(headersSeen.length > 0);
      for (const h of headersSeen) {
        assert.equal(h['x-platform-device'], 'desktop');
        assert.equal(h['x-platform-lang'], 'ro');
        assert.equal(h['x-platform-tz'], '180');
      }
    }
  );
});

test('an unverified hash is not sent', () => {
  // x-platform-hash is not checked server-side, so sending a captured value
  // would be cargo-culting a secret that is not one.
  const headersSeen = [];
  const s = new Egt('prowin', {
    windowHours: 24,
    fetchImpl: async (url, opts) => { headersSeen.push(opts.headers); return new Response('', { status: 404 }); },
  });
  return s.fetchRaw().catch(() => {
    for (const h of headersSeen) assert.equal(h['x-platform-hash'], undefined);
  });
});

test('a retired container is skipped, not fatal', () => {
  const probed = [];
  const s = new Egt('prowin', { windowHours: 24, fetchImpl: stubFetch(probed) });
  return s.fetchRaw().then((raw) => {
    assert.ok(raw.containers.length > 0, 'readable containers are kept');
    assert.ok(probed.length > 10, 'every known container is probed');
    assert.ok(probed.some((u) => /normalized\//.test(u)));
  });
});

for (const [name, mutate] of Object.entries({
  nonFootball: (e) => { e.sportId = 1016; },
  liveTrue: (e) => { e.live = true; },
  past: (e) => { e.startTime = '2020-01-01T00:00:00.000Z'; },
  badDate: (e) => { e.startTime = 'not-a-date'; },
  missingTeams: (e) => { delete e.homeTeam; },
  missingLeague: (e) => { delete e.tournamentName; delete e.categoryName; },
  noId: (e) => { delete e.sportEventId; },
  resultMissing: (e) => { e.markets = (e.markets || []).filter((m) => !/^1[xX]2$/.test(m.marketTemplateName || m.marketTitle || '')); },
  resultDuplicated: (e) => {
    const r = e.markets.find((m) => /^1[xX]2$/.test(m.marketTemplateName || m.marketTitle || ''));
    e.markets.push(structuredClone(r));
  },
  twoOutcomes: (e) => {
    const r = e.markets.find((m) => /^1[xX]2$/.test(m.marketTemplateName || m.marketTitle || ''));
    r.outcomes = r.outcomes.slice(0, 2);
  },
  duplicateOutcome: (e) => {
    const r = e.markets.find((m) => /^1[xX]2$/.test(m.marketTemplateName || m.marketTitle || ''));
    r.outcomes[1] = structuredClone(r.outcomes[0]);
  },
  nonResultNames: (e) => {
    const r = e.markets.find((m) => /^1[xX]2$/.test(m.marketTemplateName || m.marketTitle || ''));
    r.outcomes[1].name = 'Niciunul';
  },
  stringOdds: (e) => {
    const r = e.markets.find((m) => /^1[xX]2$/.test(m.marketTemplateName || m.marketTitle || ''));
    r.outcomes.forEach((o) => { o.odds = 'bad'; });
  },
  oddsAtOne: (e) => {
    const r = e.markets.find((m) => /^1[xX]2$/.test(m.marketTemplateName || m.marketTitle || ''));
    r.outcomes.forEach((o) => { o.odds = 1; });
  },
  suspendedResult: (e) => {
    const r = e.markets.find((m) => /^1[xX]2$/.test(m.marketTemplateName || m.marketTitle || ''));
    r.marketStatus = 'Suspended';
  },
})) test(`rejects ${name}`, () => {
  const { s } = setup();
  // Pick a container that actually holds PREMATCH events, and assert the
  // unmutated control yields rows before mutating.
  //
  // This control is not decoration. An earlier version of this loop used
  // fixture.containers[1], which holds two events that are BOTH live — and
  // `live` is dropped before any of these guards run, so `deepEqual([], [])`
  // passed for every mutation. Deleting the adapter's completeness checks
  // entirely left 17 of these 18 tests green. A rejection loop is only
  // meaningful if the unmutated case produces events; asserting that here is
  // what stops the suite from being silently vacuous again.
  const container = structuredClone(fixture.containers.find((c) =>
    Object.values(c.events).some((e) => e.live !== true)
  ) || fixture.containers[0]);

  const build = () => s.normalize({
    containers: [{ containerId: container.containerId, url: 'u', status: 200, body: { events: container.events } }],
  });

  const control = s.extractEvents(build());
  assert.ok(control.length > 0, `the unmutated fixture must yield events, or this test proves nothing (${name})`);

  // Mutate EVERY event in the container, not just the first. A container holds
  // more than one fixture, and an unmutated sibling would still be published,
  // so mutating one event makes the assertion fail for the wrong reason.
  for (const ev of Object.values(container.events)) mutate(ev);
  assert.deepEqual(s.extractEvents(build()), [], `expected no events for ${name}`);
});

test('caps, malformed schemas and unknown tenants', () => {
  const all = () => setup().s.normalize({
    containers: fixture.containers.map((c) => ({ containerId: c.containerId, url: 'u', status: 200, body: { events: c.events } })),
  });
  const unbounded = setup().s.extractEvents(all());
  assert.ok(unbounded.length >= 2, 'the full fixture must yield enough events for the cap to bite');
  // A cap of 1 with >=2 available must yield exactly 1, not "at most 1" — the
  // earlier assertion compared `x <= 1` to `true`, which is a tautology.
  assert.equal(setup('prowin', { maxEvents: 1 }).s.extractEvents(all()).length, 1);
  assert.equal(setup('prowin', { maxEvents: 0 }).s.extractEvents(all()).length, 0);
  assert.throws(() => new Egt('not-a-tenant'), /unknown tenant/);
  assert.throws(() => new Egt('prowin', { maxEvents: -1 }));
  const { s } = setup();
  assert.throws(() => s.normalize({}), /missing containers/);
});

test('all three EGT brands are one group, on the measured producer-id evidence', () => {
  // Measured kickoff-keyed, cross-checked against the provider's own
  // feedProducerId: prowin/ultrabet 22 of 31 shared, prowin/vipbet 33 of 35,
  // ultrabet/vipbet 21 of 30 — the same upstream feed under three names. An
  // earlier measurement claimed otherwise because it keyed fixtures without a
  // kickoff; see the comment in src/scanner/feed-groups.mjs.
  assert.equal(isSharedFeed('prowin', 'ultrabet'), true);
  assert.equal(isSharedFeed('ultrabet', 'vipbet'), true);
  assert.equal(isSharedFeed('prowin', 'vipbet'), true);
  assert.equal(isSharedFeed('vipbet', 'prowin'), true);
  assert.equal(feedGroupOf('prowin'), 'egt-digital');
  assert.equal(feedGroupOf('ultrabet'), 'egt-digital');
  assert.equal(feedGroupOf('vipbet'), 'egt-digital');
  // A brand on a different platform must still be pairable.
  assert.equal(isSharedFeed('prowin', 'betmen'), false);
  assert.equal(isSharedFeed('ultrabet', 'admiral'), false);
});

test('selection ids are derived, not the provider int64 that JSON.parse rounds', () => {
  const { s } = setup();
  const raw = s.normalize({ containers: fixture.containers.map((c) => ({ containerId: c.containerId, url: 'u', status: 200, body: { events: c.events } })) });
  const out = s.extractEvents(raw);
  assert.ok(out.length > 0);
  for (const ev of out) {
    for (const sel of ev.markets[0].selections) {
      // The feed's own ids exceed Number.MAX_SAFE_INTEGER, so identity is
      // eventId:name — never a re-stringified rounded number.
      assert.match(sel.id, new RegExp(`^${ev.id}:(1|X|2)$`));
    }
    // A corrupted int64 must not be republished as provenance.
    assert.equal(ev.markets[0].providerMarketId, undefined);
  }
});

for (const id of ['prowin', 'ultrabet']) {
  test(`the ${id} tenant is configured, routed and disabled with its measured reason`, async (t) => {
    const jobConfig = config.jobs.find((j) => j.id === id);
    assert.ok(jobConfig, `config/scrapers.json declares a ${id} job`);
    assert.ok(matchesEgtConfig(id, jobConfig), 'the tenant matcher accepts the configured triple');
    assert.deepEqual(jobConfig.supportedSports, ['football']);

    // Registered but NOT enabled: one upstream feed across three brands adds no
    // independent price source, and enabling them would scrape the same feed
    // three times. The reason must say so, because a bare "disabled" tells a
    // future reader nothing about whether the adapter is sound.
    assert.equal(jobConfig.enabled, false);
    assert.equal(jobConfig.validationStatus, 'experimental');
    assert.match(jobConfig.validationReason, /one upstream|ONE upstream|independent price source/i);

    // A disabled job is a configuration error, not a silent scrape.
    assert.throws(() => instantiate(id, { jobConfig }), { code: 'ESCRAPERCONFIG', message: /job is disabled/ });

    // The adapter itself must still work when constructed directly.
    // scratch/ is gitignored and does not exist in a fresh clone.
    await fs.mkdir(new URL('../scratch/', import.meta.url), { recursive: true });
    const dir = await fs.mkdtemp(new URL('../scratch/egt-test-', import.meta.url));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const s = new Egt(id, { dataDir: dir, runId: 'egt-fixture-run', windowHours: 24, fetchImpl: stubFetch([]) });
    const result = await s.run();
    assert.equal(result.valid, true);
    assert.ok(result.events > 0, 'a run that returns nothing must not be a silent success');

    const snapshot = JSON.parse(await fs.readFile(result.outputs[0]));
    assert.equal(snapshot.runId, 'egt-fixture-run');
    assert.equal(snapshot.transport, 'egt-public-sports-json');
    assert.equal(snapshot.events[0].sourceId, id);
    assert.equal(snapshot.coverage.sport, 'football');
    assert.equal(snapshot.coverage.market, 'fulltime-1x2');
    assert.equal(snapshot.coverage.live, false);
    assert.ok(snapshot.sourceUrl.includes('egt-digital.com'));

    // Editing any contract field must stop the matcher accepting the job, so
    // the orchestrator rejects it rather than running the wrong adapter.
    for (const field of ['engine', 'transport', 'script']) {
      assert.equal(
        matchesEgtConfig(id, { ...jobConfig, [field]: 'unknown' }),
        false,
        `${field} drift must be rejected`
      );
    }
    assert.equal(matchesEgtConfig(id, jobConfig), true);
  });
}

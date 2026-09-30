// The shape of a scan is a contract, and the frontend is written against it.
//
// `emptyScan()` and the "nothing on disk yet" fallback in readLatestScan used
// to be two hand-written objects sitting next to the one scanWorkspace
// actually builds. All three drifted: the real scan had 14 keys, the empty one
// had 9, the fallback had 8, and the two hand-written copies disagreed with
// each other about `scrapeRunId`. The orchestrator publishes emptyScan on every
// failed or cancelled scrape, so a dashboard could not tell "this run found
// nothing" from "this run died" — the fields that would have said so were
// simply missing, and `options` (the settings the scan was made under) was one
// of them.
//
// Every assertion here compares what a consumer actually receives, so the
// shapes are round-tripped through JSON first. That is not pedantry: keys
// whose value is `undefined` are dropped by JSON.stringify, which is how
// `options.prematchMaxAgeMs` and `options.liveMaxAgeMs` reached a scan object
// and then never reached latest-scan.json at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanEnvelope, scanWorkspace } from '../src/scanner/scanner.mjs';
import { emptyScan, readLatestScan } from '../src/scan-service.mjs';
import { DEFAULT_LIVE_MAX_AGE_MS, DEFAULT_PREMATCH_MAX_AGE_MS, DATA_STATUS } from '../src/shared/data-quality.mjs';

/** The keys a consumer sees, which is not the same as the keys in memory. */
const wireKeys = (value) => Object.keys(JSON.parse(JSON.stringify(value))).sort();

/**
 * The published scan contract, by name.
 *
 * Order-insensitive on purpose (compared sorted) but not shape-optional: every
 * one of these has a reader. `scrapedAt` is the capture time the scanner page
 * prints, `options` is what verification re-derives the scan from, and
 * `verificationSummary` is the only place the rejected count can appear at all.
 */
const REQUIRED_KEYS = [
  'schemaVersion', 'id', 'scrapedAt', 'scanStartedAt', 'scrapeRunId',
  'dataHealth', 'options', 'sources', 'eventCount',
  'opportunities', 'middles', 'positiveEv', 'lowHold', 'verificationSummary',
];

/** Two fresh workspaces, so a cached directory can never serve the other test. */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-contract-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A workspace with one fresh snapshot, so the "real" scan has something in it. */
async function seedOneEvent(dir) {
  await mkdir(join(dir, 'workspace'), { recursive: true });
  await writeFile(join(dir, 'workspace', 'a_events.json'), JSON.stringify({
    schemaVersion: 2,
    sourceId: 'a',
    runId: 'run-contract',
    sourceUrl: 'https://a.example/offer',
    transport: 'test-public-feed',
    capturedAt: new Date().toISOString(),
    dataStatus: DATA_STATUS.FRESH,
    events: [{
      id: 'a1', sourceId: 'a', eventKey: 'k1',
      sport: 'Football', league: 'Liga 1', kickoff: '2030-01-01T00:00:00Z',
      homeTeam: 'H', awayTeam: 'A',
      markets: [{ key: 'MATCH_ODDS', selections: [{ name: 'H', odds: 2.0 }] }],
    }],
  }), 'utf8');
}

test('a published scan carries every key the frontend reads', async () => {
  // The contract, named.
  //
  // The two comparisons above are relative: they catch the hand-written copies
  // drifting apart from a real scan, but a key deleted from scanEnvelope leaves
  // all three shapes agreeing with each other and the whole file green. The
  // mutation run found exactly that — dropping `scrapedAt` from the envelope
  // cost nothing, and `scrapedAt` is the field the scanner page reads. Spelling
  // the keys out here is what makes the relative comparisons safe to lean on.
  await withTempDir(async (dir) => {
    const shapes = {
      'a real scan': await scanWorkspace({ dataDir: dir }),
      'an empty scan': emptyScan(),
      'the no-file fallback': await readLatestScan(dir),
    };
    for (const [name, shape] of Object.entries(shapes)) {
      assert.deepEqual(wireKeys(shape), [...REQUIRED_KEYS].sort(), `${name} must carry the whole contract`);
    }
  });
});

test('the nested blocks the frontend reads are themselves named', async () => {
  // The top-level list is not enough. `dataHealth`, `options` and
  // `verificationSummary` are read a level down, and a key that vanishes from
  // any of them is the same class of silent break as a key vanishing from the
  // envelope.
  await withTempDir(async (dir) => {
    for (const scan of [await scanWorkspace({ dataDir: dir }), emptyScan()]) {
      const onDisk = JSON.parse(JSON.stringify(scan));
      for (const key of ['actionableSourceCount', 'sources', 'status']) {
        assert.ok(key in onDisk.dataHealth, `dataHealth.${key} is part of the contract`);
      }
      for (const key of [
        'bankroll', 'minRoiPercent', 'minEvPercent', 'maxMiddleRiskPercent', 'minMiddleRoiPercent',
        'includeLive', 'includePast', 'sourceIds', 'sport', 'prematchMaxAgeMs', 'liveMaxAgeMs',
      ]) {
        assert.ok(key in onDisk.options, `options.${key} is part of the contract`);
      }
      for (const key of ['confirmed', 'rejected', 'expired', 'unconfirmed']) {
        assert.ok(key in onDisk.verificationSummary, `verificationSummary.${key} is part of the contract`);
      }
    }
  });
});

test('an empty scan has exactly the keys a real scan has', async () => {
  // The guard this whole file exists for. Before scanEnvelope, the empty scan
  // was missing id, options, scrapedAt, scanStartedAt and verificationSummary.
  await withTempDir(async (dir) => {
    const real = await scanWorkspace({ dataDir: dir });
    const empty = emptyScan();
    assert.deepEqual(
      wireKeys(empty),
      wireKeys(real),
      'emptyScan() must be shaped like a real scan, not a hand-written subset of it',
    );
  });
});

test('readLatestScan with nothing on disk returns the full contract', async () => {
  // The second hand-written copy. It was missing everything the first one was
  // missing, plus scrapeRunId — so the same endpoint answered two different
  // shapes depending on which branch produced the answer.
  await withTempDir(async (dir) => {
    const fallback = await readLatestScan(dir);
    const real = await scanWorkspace({ dataDir: dir });
    assert.deepEqual(wireKeys(fallback), wireKeys(real));
  });
});

test('a real scan over real snapshots is a populated object, not an empty one', async () => {
  // The positive control. Key-set equality is trivially satisfiable by two
  // objects that both have nothing in them, so the comparisons above only mean
  // something if a real scan actually differs from an empty one in its values.
  // This fails if scanWorkspace starts returning an empty envelope.
  await withTempDir(async (dir) => {
    const bare = await scanWorkspace({ dataDir: dir });
    await seedOneEvent(dir);
    const seeded = await scanWorkspace({ dataDir: dir });

    assert.equal(bare.eventCount, 0, 'an unseeded workspace yields no events');
    assert.equal(seeded.eventCount, 1, 'a seeded workspace yields its one event');
    assert.equal(bare.dataHealth.status, DATA_STATUS.EMPTY);
    assert.equal(seeded.dataHealth.status, DATA_STATUS.FRESH);
    assert.equal(seeded.dataHealth.actionableSourceCount, 1);
    assert.deepEqual(
      wireKeys(seeded), wireKeys(bare),
      'seeding a workspace must add findings, never reshape the contract',
    );
  });
});

test('a scan records the freshness windows it actually applied', async () => {
  // The JSON round-trip is the assertion. scanWorkspace destructured
  // prematchMaxAgeMs/liveMaxAgeMs as bare undefined, wrote them into
  // `options`, and JSON.stringify then dropped both keys — so the published
  // scan could never say how old a price was allowed to be, while the scanner
  // UI spelled "90s" out by hand in a translation string.
  await withTempDir(async (dir) => {
    const scan = await scanWorkspace({ dataDir: dir });
    const onDisk = JSON.parse(JSON.stringify(scan));
    assert.equal(onDisk.options.liveMaxAgeMs, DEFAULT_LIVE_MAX_AGE_MS);
    assert.equal(onDisk.options.prematchMaxAgeMs, DEFAULT_PREMATCH_MAX_AGE_MS);
  });
});

test('an explicit freshness window is recorded as given, not as the default', async () => {
  // The counterweight: resolving the window must record what the caller asked
  // for. A test that only ever checks the default proves nothing about the
  // override path.
  await withTempDir(async (dir) => {
    const scan = await scanWorkspace({ dataDir: dir, liveMaxAgeMs: 5000, prematchMaxAgeMs: 1000 });
    const onDisk = JSON.parse(JSON.stringify(scan));
    assert.equal(onDisk.options.liveMaxAgeMs, 5000);
    assert.equal(onDisk.options.prematchMaxAgeMs, 1000);
  });
});

test('dataHealth publishes the window the freshness verdict was reached with', async () => {
  await withTempDir(async (dir) => {
    const scan = await scanWorkspace({ dataDir: dir });
    const onDisk = JSON.parse(JSON.stringify(scan));
    // `stale` is a comparison against this window, and the banner is the only
    // surface that renders the verdict. Read off the same `options` object the
    // scan publishes rather than re-defaulted, so the two cannot disagree.
    assert.equal(onDisk.dataHealth.prematchMaxAgeMs, DEFAULT_PREMATCH_MAX_AGE_MS);
    assert.equal(onDisk.dataHealth.prematchMaxAgeMs, onDisk.options.prematchMaxAgeMs,
      'the health window IS the published option, not a second copy of it');
    assert.equal(onDisk.dataHealth.liveMaxAgeMs, onDisk.options.liveMaxAgeMs);
    // The JSON round-trip is part of the assertion. `undefined` keys are dropped
    // by JSON.stringify, which is how these two windows once failed to reach
    // latest-scan.json at all while the UI spelled the number out by hand.
    assert.ok('prematchMaxAgeMs' in onDisk.dataHealth, 'the key survives the round-trip to disk');
    assert.ok('liveMaxAgeMs' in onDisk.dataHealth, 'and so does its sibling');
  });
});

test('an explicit window is the one dataHealth reports', async () => {
  // The counterweight to the default case above: reading the value off `options`
  // has to follow an override, not just the default. A fixture that only ever
  // checks the default would pass against a hardcoded constant.
  await withTempDir(async (dir) => {
    const scan = await scanWorkspace({ dataDir: dir, prematchMaxAgeMs: 1000 });
    const onDisk = JSON.parse(JSON.stringify(scan));
    assert.equal(onDisk.dataHealth.prematchMaxAgeMs, 1000);
    assert.notEqual(onDisk.dataHealth.prematchMaxAgeMs, DEFAULT_PREMATCH_MAX_AGE_MS);
  });
});

test('a scan that carries no window does not get one invented for it', () => {
  // The negative beside both tests above. An envelope built with options that
  // predate the field must publish no threshold at all — the consumer renders
  // "not known" rather than the default the current build would have used. A
  // backend that filled this in would be asserting a value about a scan it
  // never measured, which is the fault this whole path exists to remove.
  const envelope = scanEnvelope({ sources: [], eventCount: 0, options: { bankroll: 1000 } });
  const onDisk = JSON.parse(JSON.stringify(envelope));
  assert.ok(!('prematchMaxAgeMs' in onDisk.dataHealth), 'no window is invented for a scan that carries none');
  assert.ok(!('liveMaxAgeMs' in onDisk.dataHealth), 'and neither is its sibling');
  // The positive beside it: the same envelope with the field present publishes
  // it, so the assertion above is about the missing value and not about the
  // key never being written.
  const withWindow = scanEnvelope({ sources: [], eventCount: 0, options: { bankroll: 1000, prematchMaxAgeMs: 1000 } });
  assert.equal(JSON.parse(JSON.stringify(withWindow)).dataHealth.prematchMaxAgeMs, 1000);
});

test('an empty scan still reports the empty banner state', async () => {
  // Filled in, not blanked out. The banner reads health.status, and a missing
  // key there is not a neutral state — it is a render path with no answer.
  const empty = JSON.parse(JSON.stringify(emptyScan()));
  assert.equal(empty.dataHealth.status, DATA_STATUS.EMPTY);
  assert.equal(empty.dataHealth.actionableSourceCount, 0);
  // Every DATA_STATUS is present at 0, so reading a key without checking it
  // first yields a number rather than undefined.
  for (const status of Object.values(DATA_STATUS)) {
    assert.equal(empty.dataHealth.sources[status], 0, `dataHealth.sources.${status} must be 0, not missing`);
  }
  assert.deepEqual(empty.sources, []);
  assert.equal(empty.eventCount, 0);
});

test('an empty scan still reports the options it stands for', async () => {
  // options is what a consumer reads to label a scan, and what verification
  // re-derives the whole scan from. An empty scan that omits it is a scan whose
  // settings cannot be recovered.
  const empty = JSON.parse(JSON.stringify(emptyScan()));
  assert.equal(empty.options.includeLive, false);
  assert.equal(empty.options.includePast, false);
  assert.equal(empty.options.bankroll, 1000);
  assert.equal(empty.options.sourceIds, null);
  assert.equal(empty.options.liveMaxAgeMs, DEFAULT_LIVE_MAX_AGE_MS);
});

test('an empty scan carries zeroed verification counters', async () => {
  // verificationSummary is the aggregate the per-row status cannot show: a
  // rejected or expired opportunity is dropped from every list, so without
  // these four numbers a trader sees only the ones that survived.
  const empty = JSON.parse(JSON.stringify(emptyScan()));
  assert.deepEqual(empty.verificationSummary, {
    confirmed: 0, rejected: 0, expired: 0, unconfirmed: 0,
  });
  // And every family is an array, because a consumer that maps over one must
  // not have to guess whether it is missing or empty.
  for (const family of ['opportunities', 'middles', 'positiveEv', 'lowHold']) {
    assert.ok(Array.isArray(empty[family]), `${family} must be an array`);
    assert.equal(empty[family].length, 0);
  }
});

test('emptyScan hands out its own containers, not shared ones', async () => {
  // The orchestrator hands a failed run's empty scan to verification, which
  // rewrites the families in place. If those arrays were a shared literal,
  // one caller's write would show up in the next caller's scan — the same
  // aliasing bug a shared frozen object would have hidden behind a throw.
  const a = emptyScan();
  const b = emptyScan();
  assert.notEqual(a.opportunities, b.opportunities, 'each call must own its arrays');
  assert.notEqual(a.verificationSummary, b.verificationSummary);

  a.opportunities.push({ eventKey: 'k' });
  a.verificationSummary.confirmed = 99;
  assert.equal(b.opportunities.length, 0, 'a write must not reach another empty scan');
  assert.equal(b.verificationSummary.confirmed, 0);
});

/**
 * scan-publication.test.mjs — whether a scan exists, as distinct from what is in it.
 *
 * `readPublishedScan` answers two questions in one read, and the second one
 * cannot be inferred from the first: `emptyScan()` mints a real-looking `id`
 * and a `scrapedAt` of now, because it is handed straight to the verification
 * pass as a real target. So "no scan has ever run" and "a scan ran and found
 * nothing" produce byte-identical documents.
 *
 * The router test stubs this function out, so without this file the real one is
 * never executed by any test at all — a mutation runner found exactly that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyScan, readLatestScan, readPublishedScan } from '../src/scan-service.mjs';

async function dataDir() {
  return await mkdtemp(join(tmpdir(), 'arbiter-publication-'));
}

test('with no file on disk, the scan is unpublished and still fully shaped', async () => {
  const dir = await dataDir();
  try {
    const { scan, published } = await readPublishedScan(dir);
    assert.equal(published, false, 'this is the whole point of the flag');
    // ...and the scan is a real one, not null: a consumer must be able to read
    // every field without first checking whether a scan ran.
    assert.equal(typeof scan, 'object');
    assert.deepEqual(Object.keys(scan).sort(), Object.keys(emptyScan()).sort());
    assert.equal(scan.opportunities.length, 0);
    assert.equal(scan.middles.length, 0);
  } finally { await rm(dir, { recursive: true }); }
});

test('a published scan is reported as published, and returned as stored', async () => {
  const dir = await dataDir();
  try {
    const stored = { ...emptyScan(), id: 'scan-42', scrapedAt: '2026-10-01T10:00:00.000Z', eventCount: 7 };
    await writeFile(join(dir, 'latest-scan.json'), JSON.stringify(stored), 'utf8');
    const { scan, published } = await readPublishedScan(dir);
    assert.equal(published, true);
    assert.equal(scan.id, 'scan-42', 'the file is returned, not re-derived');
    assert.equal(scan.eventCount, 7);
    assert.equal(scan.scrapedAt, '2026-10-01T10:00:00.000Z');
  } finally { await rm(dir, { recursive: true }); }
});

test('an empty file is still a published scan, and not a silent one', async () => {
  const dir = await dataDir();
  try {
    // What the orchestrator writes when a run finds nothing: a real document
    // with empty families. It has been run, so saying "no scan" would be a lie
    // in the other direction — the page would tell the trader nothing has ever
    // been scraped when a scan has, in fact, just failed cleanly.
    await writeFile(join(dir, 'latest-scan.json'), JSON.stringify({ ...emptyScan(), scrapeRunId: 'run-9' }), 'utf8');
    const { scan, published } = await readPublishedScan(dir);
    assert.equal(published, true);
    assert.equal(scan.scrapeRunId, 'run-9');
  } finally { await rm(dir, { recursive: true }); }
});

test('readLatestScan keeps its old contract, now derived from the same read', async () => {
  const dir = await dataDir();
  try {
    const viaOld = await readLatestScan(dir);
    const viaNew = (await readPublishedScan(dir)).scan;
    // The shape, not the values: emptyScan() mints `scan-<Date.now()>` and a
    // `scrapedAt` of now, so two reads a millisecond apart are two different
    // documents and comparing them field by field is a test that fails on a
    // slow machine for no reason at all.
    assert.deepEqual(Object.keys(viaOld).sort(), Object.keys(viaNew).sort());
    assert.deepEqual(Object.keys(viaOld).sort(), Object.keys(emptyScan()).sort());
    assert.equal(viaOld.opportunities.length, 0);

    await writeFile(join(dir, 'latest-scan.json'), JSON.stringify({ ...emptyScan(), id: 'scan-7' }), 'utf8');
    assert.equal((await readLatestScan(dir)).id, 'scan-7', 'the stored scan, not a re-derivation');
    assert.equal((await readPublishedScan(dir)).published, true);
  } finally { await rm(dir, { recursive: true }); }
});

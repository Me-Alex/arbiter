/**
 * cleanup.test.mjs — Tests for the cleanup script
 *
 * Every data-dir-scoped call passes an explicit temporary `dataDir`. Without
 * one the script falls back to the project's real data directory, so these
 * tests would delete the developer's actual workspace, staging and backups —
 * and their outcome would depend on whatever happened to be on disk, which is
 * what made `cleanupWorkspace` fail intermittently in the full suite.
 */

import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  cleanupStagingFiles,
  cleanupLogs,
  cleanupBackups,
  cleanupTempFiles,
  cleanupWorkspace,
  runCleanup,
  CLEANUP_CONFIG,
} from '../scripts/cleanup.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** A fresh empty data dir per suite, removed afterwards. */
async function makeTempDataDir(prefix) {
  return await fs.mkdtemp(join(tmpdir(), prefix));
}

describe('Cleanup Configuration', () => {
  it('should have default configuration values', () => {
    assert.strictEqual(CLEANUP_CONFIG.stagingMaxAgeHours, 24);
    assert.strictEqual(CLEANUP_CONFIG.logMaxAgeDays, 30);
    assert.strictEqual(CLEANUP_CONFIG.maxBackups, 10);
    assert.strictEqual(CLEANUP_CONFIG.backupMaxAgeDays, 90);
    assert.strictEqual(CLEANUP_CONFIG.tempMaxAgeHours, 1);
  });
});

describe('cleanupStagingFiles', () => {
  let tempDir;

  before(async () => { tempDir = await makeTempDataDir('arbiter-test-staging-'); });
  after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  it('should handle a non-existent staging directory', async () => {
    const deletedCount = await cleanupStagingFiles(tempDir);
    assert.strictEqual(deletedCount, 0);
  });

  it('should delete staging files older than the retention window', async () => {
    const staging = join(tempDir, 'staging');
    await fs.mkdir(staging, { recursive: true });

    const old = join(staging, 'old.json');
    const fresh = join(staging, 'fresh.json');
    await fs.writeFile(old, '{}');
    await fs.writeFile(fresh, '{}');
    // stagingMaxAgeHours is 24, so anything older than that must go.
    const stale = new Date(Date.now() - (CLEANUP_CONFIG.stagingMaxAgeHours + 1) * 3600 * 1000);
    await fs.utimes(old, stale, stale);

    const deletedCount = await cleanupStagingFiles(tempDir);
    assert.strictEqual(deletedCount, 1);
    await assert.rejects(() => fs.access(old), 'the stale file is gone');
    await fs.access(fresh); // the fresh one survives
  });
});

describe('cleanupLogs', () => {
  it('should handle a non-existent logs directory', async () => {
    const deletedCount = await cleanupLogs();
    assert.strictEqual(deletedCount, 0);
  });
});

describe('cleanupBackups', () => {
  it('should handle a non-existent backups directory', async () => {
    const deletedCount = await cleanupBackups();
    assert.strictEqual(deletedCount, 0);
  });
});

describe('cleanupTempFiles', () => {
  it('should handle non-existent temp directories', async () => {
    const deletedCount = await cleanupTempFiles();
    assert.strictEqual(deletedCount, 0);
  });
});

describe('cleanupWorkspace', () => {
  let tempDir;

  before(async () => { tempDir = await makeTempDataDir('arbiter-test-workspace-'); });
  after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  it('should handle a non-existent workspace directory', async () => {
    const deletedCount = await cleanupWorkspace(tempDir);
    assert.strictEqual(deletedCount, 0);
  });

  it('keeps every book snapshot and sweeps only non-snapshot leftovers', async () => {
    // `<book>_events.json` is the CURRENT capture, not a leftover: one file per
    // book, atomically overwritten by each successful scrape, and the only
    // persisted copy of what the books were quoting (data/workspace is
    // gitignored and unbacked up). The six-hourly regular cleanup deleted all
    // 24 of them on 2026-09-30 and took the last real observations with it,
    // because the guard that was supposed to spare them — `latest-*.json` — is
    // a filename that does not exist in this directory.
    //
    // Age is not the test. A snapshot two hours old is exactly what a capture
    // from the previous scrape cycle looks like, and it is still the data.
    const workspace = join(tempDir, 'workspace');
    await fs.mkdir(workspace, { recursive: true });

    const old = join(workspace, 'a_events.json');
    const fresh = join(workspace, 'b_events.json');
    const latest = join(workspace, 'latest-scan.json');
    const leftover = join(workspace, 'scratch.tmp.json');
    await fs.writeFile(old, '{}');
    await fs.writeFile(fresh, '{}');
    await fs.writeFile(latest, '{}');
    await fs.writeFile(leftover, '{}');

    const stale = new Date(Date.now() - 2 * 3600 * 1000);
    await fs.utimes(old, stale, stale);
    await fs.utimes(latest, stale, stale);
    await fs.utimes(leftover, stale, stale);

    const deletedCount = await cleanupWorkspace(tempDir);
    assert.strictEqual(deletedCount, 1, 'only the non-snapshot leftover is swept');
    await fs.access(old); // a two-hour-old capture is still the current capture
    await fs.access(fresh);
    await fs.access(latest);
    await assert.rejects(() => fs.access(leftover), 'the leftover is gone');
  });
});

describe('runCleanup', () => {
  let tempDir;

  before(async () => { tempDir = await makeTempDataDir('arbiter-test-run-'); });
  after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  it('should run all cleanup tasks against the given data dir', async () => {
    const results = await runCleanup({
      staging: true, logs: true, backups: true, temp: true, workspace: true,
      dataDir: tempDir,
    });

    assert.ok(results);
    assert.strictEqual(typeof results, 'object');
    for (const key of ['staging', 'logs', 'backups', 'temp', 'workspace']) {
      assert.ok(key in results, `expected a ${key} count`);
    }
  });

  it('should run with default options against the given data dir', async () => {
    const results = await runCleanup({ dataDir: tempDir });
    assert.ok(results);
    assert.strictEqual(typeof results, 'object');
  });

  it('should run with selective options', async () => {
    const results = await runCleanup({
      staging: true, logs: false, backups: false, temp: false, workspace: false,
      dataDir: tempDir,
    });

    assert.ok(results);
    assert.ok('staging' in results);
    assert.ok(!('logs' in results));
    assert.ok(!('backups' in results));
    assert.ok(!('temp' in results));
    assert.ok(!('workspace' in results));
  });
});

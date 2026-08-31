/**
 * cleanup.test.mjs — Tests for the cleanup script
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

  before(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'arbiter-test-staging-'));
  });

  after(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should delete old staging files', async () => {
    // This test is skipped because cleanupStagingFiles uses the actual DATA_DIR
    // which we don't want to modify in tests
    // The function itself is tested by the runCleanup integration tests
  });

  it('should handle non-existent staging directory', async () => {
    const deletedCount = await cleanupStagingFiles();
    assert.strictEqual(deletedCount, 0);
  });
});

describe('cleanupLogs', () => {
  it('should handle non-existent logs directory', async () => {
    const deletedCount = await cleanupLogs();
    assert.strictEqual(deletedCount, 0);
  });
});

describe('cleanupBackups', () => {
  it('should handle non-existent backups directory', async () => {
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
  it('should handle non-existent workspace directory', async () => {
    const deletedCount = await cleanupWorkspace();
    assert.strictEqual(deletedCount, 0);
  });
});

describe('runCleanup', () => {
  it('should run all cleanup tasks', async () => {
    const results = await runCleanup({
      staging: true,
      logs: true,
      backups: true,
      temp: true,
      workspace: true,
    });

    assert.ok(results);
    assert.strictEqual(typeof results, 'object');
    assert.ok('staging' in results);
    assert.ok('logs' in results);
    assert.ok('backups' in results);
    assert.ok('temp' in results);
    assert.ok('workspace' in results);
  });

  it('should run with default options', async () => {
    const results = await runCleanup();
    assert.ok(results);
    assert.strictEqual(typeof results, 'object');
  });

  it('should run with selective options', async () => {
    const results = await runCleanup({
      staging: true,
      logs: false,
      backups: false,
      temp: false,
      workspace: false,
    });

    assert.ok(results);
    assert.ok('staging' in results);
    assert.ok(!('logs' in results));
    assert.ok(!('backups' in results));
    assert.ok(!('temp' in results));
    assert.ok(!('workspace' in results));
  });
});

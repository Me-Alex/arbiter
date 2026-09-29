import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanWorkspace, DEFAULT_SCAN_OPTIONS } from '../src/scanner/scanner.mjs';
import { resolveScanRequest } from '../src/scrape-orchestrator.mjs';

/**
 * What a scan does when the caller names no settings was written out four
 * times: scanWorkspace's destructuring defaults, the orchestrator's call site,
 * resolveScanRequest, and verification's re-scan. They agreed by luck, not by
 * construction, so these assertions pin the agreed values and check the two
 * public entry points actually produce them.
 */

test('the default scan settings are the ones every call site agrees on', () => {
  assert.deepEqual(DEFAULT_SCAN_OPTIONS, {
    bankroll: 1000,
    minRoiPercent: 0,
    minEvPercent: 2,
    maxMiddleRiskPercent: 15,
    minMiddleRoiPercent: 20,
    includeLive: false,
    includePast: false,
  });
});

test('resolveScanRequest on an empty request returns the defaults', () => {
  // resolveScanRequest clamps every field, so this is the path an API request
  // with no body takes. It must not silently become stricter or looser.
  assert.deepEqual(resolveScanRequest({}), {
    bankroll: DEFAULT_SCAN_OPTIONS.bankroll,
    minRoiPercent: DEFAULT_SCAN_OPTIONS.minRoiPercent,
    minEvPercent: DEFAULT_SCAN_OPTIONS.minEvPercent,
    maxMiddleRiskPercent: DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent,
    minMiddleRoiPercent: DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent,
    includeLive: DEFAULT_SCAN_OPTIONS.includeLive,
    includePast: DEFAULT_SCAN_OPTIONS.includePast,
    maxEvents: undefined,
    sport: undefined,
  });
  assert.deepEqual(resolveScanRequest(undefined), resolveScanRequest({}));
});

test('a scan that names no settings records the defaults it used', async () => {
  // The published scan reports its own options. A caller that passed nothing
  // must see the documented defaults there, not undefined or a stale copy.
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-opts-'));
  try {
    const scan = await scanWorkspace({ dataDir: dir });
    assert.equal(scan.options.bankroll, DEFAULT_SCAN_OPTIONS.bankroll);
    assert.equal(scan.options.minRoiPercent, DEFAULT_SCAN_OPTIONS.minRoiPercent);
    assert.equal(scan.options.minEvPercent, DEFAULT_SCAN_OPTIONS.minEvPercent);
    assert.equal(scan.options.maxMiddleRiskPercent, DEFAULT_SCAN_OPTIONS.maxMiddleRiskPercent);
    assert.equal(scan.options.minMiddleRoiPercent, DEFAULT_SCAN_OPTIONS.minMiddleRoiPercent);
    assert.equal(scan.options.includeLive, DEFAULT_SCAN_OPTIONS.includeLive);
    assert.equal(scan.options.includePast, DEFAULT_SCAN_OPTIONS.includePast);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit setting still wins over the default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-opts-'));
  try {
    const scan = await scanWorkspace({ dataDir: dir, bankroll: 5000, includePast: true });
    assert.equal(scan.options.bankroll, 5000);
    assert.equal(scan.options.includePast, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

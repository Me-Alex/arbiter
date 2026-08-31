import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrackerService } from '../src/tracker-service.mjs';

test('tracker owns identifiers and validates manual data', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const bet = await tracker.addBet({
    id: 'spoofed', createdAt: '2000-01-01T00:00:00Z', selection: 'Home', odds: 2, stake: 20, status: 'won', extra: 'ignored',
  });
  assert.notEqual(bet.id, 'spoofed');
  assert.notEqual(bet.createdAt, '2000-01-01T00:00:00Z');
  assert.equal(bet.provenance, 'manual');
  assert.equal(bet.extra, undefined);
  await assert.rejects(tracker.addBet({ selection: '', odds: 2, stake: 1 }), (error) => error.code === 'EBADINPUT');
  await assert.rejects(tracker.addBet({ selection: 'Home', odds: 1, stake: 1 }), (error) => error.code === 'EBADINPUT');
  await rm(dataDir, { recursive: true });
});

test('tracker updates cannot overwrite immutable identifiers', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const bet = await tracker.addBet({ selection: 'Home', odds: 2.1, stake: 10 });
  const updated = await tracker.updateBet(bet.id, { id: 'other', createdAt: 'old', status: 'won' });
  assert.equal(updated.id, bet.id);
  assert.equal(updated.createdAt, bet.createdAt);
  assert.equal(updated.status, 'won');
  await rm(dataDir, { recursive: true });
});

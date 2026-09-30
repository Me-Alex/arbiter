import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrackerService } from '../src/tracker-service.mjs';
import { DEFAULT_ALERT_PREFERENCES } from '../src/alert-engine.mjs';
import { writeJsonAtomic } from '../src/shared/atomic-write.mjs';

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

// ---- alert preferences -----------------------------------------------------

test('a missing settings file reads as the documented defaults', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const stored = await tracker.loadAlerts();
  assert.equal(stored.schemaVersion, 1);
  // A complete object, every field present: the page draws its inputs from
  // this and a missing key renders an empty box that saves an empty box.
  assert.deepEqual({ ...stored.preferences }, { ...DEFAULT_ALERT_PREFERENCES });
  await rm(dataDir, { recursive: true });
});

test('a hand-edited settings file is repaired, not discarded', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  await writeJsonAtomic(join(dataDir, 'alert-preferences.json'), {
    schemaVersion: 1,
    preferences: { minRoiPercent: 6, minMiddleRoiPercent: null, cooldownSeconds: 'soon' },
  });
  const { preferences } = await tracker.loadAlerts();
  assert.equal(preferences.minRoiPercent, 6, 'the field the user set is kept');
  assert.equal(preferences.minMiddleRoiPercent, DEFAULT_ALERT_PREFERENCES.minMiddleRoiPercent);
  assert.equal(preferences.cooldownSeconds, DEFAULT_ALERT_PREFERENCES.cooldownSeconds);
  // `null` is the one value that must never become a number: Number(null) is 0,
  // so a 0% threshold would alert on everything above zero.
  assert.ok(preferences.minMiddleRoiPercent > 0);
  assert.deepEqual({ ...preferences.channels }, { ...DEFAULT_ALERT_PREFERENCES.channels });
  await rm(dataDir, { recursive: true });
});

test('settings survive the round trip through disk unchanged', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const wanted = { minRoiPercent: 8, minMiddleRoiPercent: 30, includeLive: true, channels: { desktop: false, sound: true }, quietHours: { from: '22:30', to: '06:15', enabled: true }, cooldownSeconds: 300 };
  const saved = await tracker.saveAlerts(wanted);
  assert.deepEqual({ ...saved.preferences }, { ...wanted });
  const loaded = await tracker.loadAlerts();
  assert.deepEqual({ ...loaded.preferences }, { ...wanted }, 'nothing was coerced on the way back in');
  await rm(dataDir, { recursive: true });
});

test('a partial save resets the fields it leaves out', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  await tracker.saveAlerts({ minRoiPercent: 9, channels: { desktop: true, sound: true }, quietHours: { from: '20:00', to: '08:00', enabled: true } });
  // This used to be a spread over the defaults, which kept whatever was on
  // disk. Turning a channel on and then off again was impossible: the second
  // save omitted `sound` and inherited `true`.
  const second = await tracker.saveAlerts({ minRoiPercent: 9, channels: { desktop: true } });
  assert.equal(second.preferences.channels.sound, DEFAULT_ALERT_PREFERENCES.channels.sound, 'sound went back to its default');
  assert.equal(second.preferences.quietHours.enabled, DEFAULT_ALERT_PREFERENCES.quietHours.enabled, 'a quiet window the user has since dropped is not silently kept on');
  assert.equal(second.preferences.quietHours.from, DEFAULT_ALERT_PREFERENCES.quietHours.from);
  // ...and what the call did set is still there.
  assert.equal(second.preferences.minRoiPercent, 9);
  assert.equal(second.preferences.channels.desktop, true);
  // The control that makes the reset the point: the field the caller did set is
  // honoured, so this is a reset and not a discard.
  const third = await tracker.loadAlerts();
  assert.equal(third.preferences.channels.desktop, true);
  assert.equal(third.preferences.channels.sound, DEFAULT_ALERT_PREFERENCES.channels.sound);
  await rm(dataDir, { recursive: true });
});

test('a nonsense save is stored as the defaults, not as the nonsense', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  for (const junk of [null, undefined, 'nonsense', 42, { minRoiPercent: {} }, { quietHours: 'yes' }]) {
    const saved = await tracker.saveAlerts(junk);
    assert.deepEqual({ ...saved.preferences }, { ...DEFAULT_ALERT_PREFERENCES }, `input ${JSON.stringify(junk) ?? 'undefined'}`);
  }
  await rm(dataDir, { recursive: true });
});

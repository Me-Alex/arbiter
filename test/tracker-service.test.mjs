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

// ---- CSV export and import ---------------------------------------------------

const CSV_HEADER = 'id,createdAt,eventKey,marketKey,selection,sourceId,odds,stake,status,notes';

test('a bet survives its own export and import, with the date it was placed', async () => {
  // The two directions had no test between them, which is how this went
  // unnoticed: exportCsv writes `createdAt`, importCsv calls addBet, and
  // addBet stamped `new Date()` over whatever the file said. A ledger that
  // rewrites its own history on re-import, from a file the user was looking at.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const placed = '2026-03-04T10:15:00.000Z';
  const original = await tracker.addBet({
    eventKey: 'soccer|liga-1|x-y', marketKey: 'MATCH_ODDS', selection: 'Home win',
    sourceId: 'favbet', odds: 2.35, stake: 100, status: 'pending', notes: 'cashed at the branch',
  });
  await writeJsonAtomic(join(dataDir, 'bet-tracker.json'), {
    schemaVersion: 1,
    updatedAt: null,
    items: [{ ...original, createdAt: placed }],
  });

  const csv = await tracker.exportCsv();
  assert.equal(csv.split('\n')[0], CSV_HEADER, 'the export header is the contract the importer reads');
  const result = await tracker.importCsv(csv);
  assert.deepEqual(result, { imported: 1, skipped: 0 }, 'and the one row in it came back');

  const { items } = await tracker.loadTracker();
  assert.equal(items.length, 2, 'the imported row is a new record, not an overwrite');
  const copy = items[1];
  assert.equal(copy.createdAt, placed, 'and it kept the date the file carried');
  assert.notEqual(copy.id, original.id, 'with a fresh id, so it cannot collide with the row it was copied from');
  assert.equal(copy.selection, 'Home win');
  assert.equal(copy.odds, 2.35);
  assert.equal(copy.stake, 100);
  assert.equal(copy.notes, 'cashed at the branch');
  assert.equal(copy.provenance, 'import', 'and it says where this app learned it from');
  await rm(dataDir, { recursive: true, force: true });
});

test('a bet typed into the page survives a round trip through its own file', async () => {
  // The defect this found: importCsv demanded an `eventKey`, and the add-bet
  // form on the analytics page does not send one, so `eventKey` is empty on
  // every manually entered bet. Export your own file and import it back and
  // every bet you typed in was dropped — with no count and no error, because
  // the count did not exist.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  // Exactly what the form posts: no eventKey, no notes, provenance 'manual'.
  const typed = await tracker.addBet({
    selection: 'Away win', odds: 3, stake: 50, sourceId: 'unibet',
    marketKey: 'MATCH_ODDS', status: 'pending', provenance: 'manual',
  });
  assert.equal(typed.eventKey, '', 'the stored bet really has no event key');

  const result = await tracker.importCsv(await tracker.exportCsv());
  assert.deepEqual(result, { imported: 1, skipped: 0 }, 'it is not one of the skipped rows');
  const { items } = await tracker.loadTracker();
  assert.equal(items.length, 2);
  assert.equal(items[1].selection, 'Away win');
  assert.equal(items[1].sourceId, 'unibet');
  await rm(dataDir, { recursive: true, force: true });
});

test('an unusable row is counted, not silently dropped, and the rest still land', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const csv = [
    CSV_HEADER,
    // No selection — the service rejects it, so it is counted.
    'bet-1,2026-01-01T00:00:00.000Z,liga-1|MATCH_ODDS,a-b,,favbet,2.0,10,pending,',
    // Odds below the floor: a row the service would refuse as a bet.
    'bet-2,2026-01-02T00:00:00.000Z,liga-1|MATCH_ODDS,a-b,Home,favbet,1,10,pending,',
    // A good one, with a note that carries a comma and a quote.
    'bet-3,2026-01-03T00:00:00.000Z,liga-1|MATCH_ODDS,a-b,Home,favbet,2.1,20,pending,"said ""hi"", then left"',
  ].join('\n');

  const result = await tracker.importCsv(csv);
  assert.deepEqual(result, { imported: 1, skipped: 2 }, 'both bad rows are counted, the good one is not');

  const { items } = await tracker.loadTracker();
  assert.equal(items.length, 1, 'and the count matches what is actually stored');
  assert.equal(items[0].notes, 'said "hi", then left', 'a quoted cell survives the round trip through the file');
  assert.equal(items[0].createdAt, '2026-01-03T00:00:00.000Z');

  // The control: a file where nothing is wrong imports every row, so the
  // numbers above are about the two bad rows and not about a broken counter.
  const clean = await tracker.importCsv(`${CSV_HEADER}\nbet-4,2026-01-04T00:00:00.000Z,l|MATCH_ODDS,a-b,Draw,favbet,3.0,10,pending,`);
  assert.deepEqual(clean, { imported: 1, skipped: 0 });
  assert.equal((await tracker.loadTracker()).items.length, 2);
  await rm(dataDir, { recursive: true, force: true });
});

test('an unparseable date in the file falls back to now rather than being stored as text', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const before = Date.now();
  const result = await tracker.importCsv([
    CSV_HEADER,
    'bet-1,not a date,liga-1|MATCH_ODDS,a-b,Home,favbet,2.0,10,pending,',
    // A date the service can read, to prove the two are told apart.
    'bet-2,2026-05-06T08:00:00.000Z,liga-1|MATCH_ODDS,a-b,Away,favbet,2.0,10,pending,',
  ].join('\n'));
  assert.deepEqual(result, { imported: 2, skipped: 0 }, 'a bad date does not make the row unusable');

  const { items } = await tracker.loadTracker();
  assert.ok(Date.parse(items[0].createdAt) >= before, 'the unusable one was stamped on arrival');
  assert.equal(items[1].createdAt, '2026-05-06T08:00:00.000Z', 'and the readable one was kept as written');
  await rm(dataDir, { recursive: true, force: true });
});

test('a date in any shape the service can read comes back in the shape it writes', async () => {
  // The test above only used a date that was already ISO, so storing the cell
  // verbatim was indistinguishable from normalising it. A spreadsheet does not
  // export ISO: `2026-05-06 08:00:00` and `2026-05-06` are both ordinary cells,
  // and both have to land in the field as the instant they name, in the one
  // shape every other createdAt in the file already has. A raw string there
  // would be parsed again by every reader — the page's fmtWhen, the next
  // export, a future sort — and each would have to know which of the two it is.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const cells = ['2026-05-06 08:00:00', '2026-05-06', '2026-05-06T08:00:00.000Z'];
  const csv = [
    CSV_HEADER,
    ...cells.map((cell, i) => `bet-${i},${cell},liga-1|MATCH_ODDS,a-b,Home${i},favbet,2.0,10,pending,`),
  ].join('\n');
  assert.deepEqual(await tracker.importCsv(csv), { imported: cells.length, skipped: 0 });

  const { items } = await tracker.loadTracker();
  for (const [i, cell] of cells.entries()) {
    assert.equal(items[i].createdAt, new Date(Date.parse(cell)).toISOString(),
      `"${cell}" is stored as the instant it names, normalised`);
    assert.match(items[i].createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      `"${cell}" is stored in the same shape as every other createdAt`);
  }
  await rm(dataDir, { recursive: true, force: true });
});

test('a date cell with whitespace around it is still the user\'s date', async () => {
  // parseCsvLine does not trim — it is a CSV reader, and a quoted cell is
  // allowed to hold anything. `Date.parse` on a padded ISO string is NaN, so a
  // cell that came out of a spreadsheet as " 2026-05-06T08:00:00.000Z " would
  // quietly be thrown away and replaced with the moment of the import. The
  // user cannot see that they lost the date; they can only see that their
  // ledger is full of today.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const before = Date.now();
  const result = await tracker.importCsv([
    CSV_HEADER,
    'bet-1," 2026-05-06T08:00:00.000Z ",liga-1|MATCH_ODDS,a-b,Home,favbet,2.0,10,pending,',
    // The control: a whitespace-only cell has no date in it and must fall
    // back, so the assertion above is about padding and not about leniency.
    'bet-2,"   ",liga-1|MATCH_ODDS,a-b,Away,favbet,2.0,10,pending,',
  ].join('\n'));
  assert.deepEqual(result, { imported: 2, skipped: 0 }, 'padding is not an unusable date');

  const { items } = await tracker.loadTracker();
  assert.equal(items[0].createdAt, '2026-05-06T08:00:00.000Z', 'the padded cell kept the date the user wrote');
  assert.ok(Date.parse(items[1].createdAt) >= before, 'a cell with no date in it is stamped on arrival');
  await rm(dataDir, { recursive: true, force: true });
});

test('a file that ends with a newline is not a file with a broken row in it', async () => {
  // Every text editor, every spreadsheet export and every `cat` adds one, and
  // the dialog on the analytics page is a textarea the user pastes into. The
  // blank line it produces is not a bet, so it must not be counted as one:
  // "Imported 2 bets, skipped 1 row" for a file with two perfectly good rows
  // is a warning about a defect that does not exist.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const rows = [
    'bet-1,2026-01-01T00:00:00.000Z,liga-1|MATCH_ODDS,a-b,Home,favbet,2.0,10,pending,',
    'bet-2,2026-01-02T00:00:00.000Z,liga-1|MATCH_ODDS,a-b,Away,favbet,2.1,20,pending,',
  ];
  for (const [label, csv] of [
    ['a trailing newline', [CSV_HEADER, ...rows].join('\n') + '\n'],
    ['a trailing blank line', [CSV_HEADER, ...rows, '', ''].join('\n')],
    ['CRLF line endings', [CSV_HEADER, ...rows].join('\r\n') + '\r\n'],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
    const fresh = new TrackerService({ dataDir: dir });
    assert.deepEqual(await fresh.importCsv(csv), { imported: 2, skipped: 0 }, label);
    assert.equal((await fresh.loadTracker()).items.length, 2, `${label} — both rows stored`);
    await rm(dir, { recursive: true, force: true });
  }
  await rm(dataDir, { recursive: true, force: true });
});

test('a failure that is not bad input is not a skipped row', async () => {
  // The branch that decides what an exception means. A row the service refuses
  // is a skip and a count; a disk that will not take the write is the
  // operator's problem, and reporting it as "9 rows skipped" would be a lie
  // about why the file did not land.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  tracker.addBet = async () => { throw new Error('EACCES: permission denied, open'); };
  await assert.rejects(
    tracker.importCsv(`${CSV_HEADER}\nbet-1,2026-01-01T00:00:00.000Z,liga-1|MATCH_ODDS,a-b,Home,favbet,2.0,10,pending,`),
    /EACCES/,
    'the failure reaches the caller instead of being counted as a skipped row',
  );
  await rm(dataDir, { recursive: true, force: true });
});

test('an empty file imports nothing and says so', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  // Both counts present in every answer, so the caller never has to guess
  // whether a missing key means zero or means an older server.
  assert.deepEqual(await tracker.importCsv(''), { imported: 0, skipped: 0 });
  assert.deepEqual(await tracker.importCsv(CSV_HEADER), { imported: 0, skipped: 0 });
  await rm(dataDir, { recursive: true, force: true });
});

test('a bet added over the API still cannot choose its own id or its own date', async () => {
  // addBet grew a second argument for the importer. The route does not pass
  // it, so this is the assertion that the argument stayed internal: the public
  // entry point still owns identity, and the export→import path is the only
  // thing that can place a bet in the past.
  const dataDir = await mkdtemp(join(tmpdir(), 'arbiter-tracker-'));
  const tracker = new TrackerService({ dataDir });
  const bet = await tracker.addBet({
    id: 'mine', createdAt: '2001-01-01T00:00:00.000Z',
    selection: 'Home', odds: 2, stake: 10, provenance: 'scan',
  });
  assert.notEqual(bet.id, 'mine');
  assert.notEqual(bet.createdAt, '2001-01-01T00:00:00.000Z');
  assert.equal(bet.provenance, 'scan', 'the value itself is still accepted — it is the id and the date that are owned');
  await rm(dataDir, { recursive: true, force: true });
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

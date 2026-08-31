import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic, writeJsonAtomicSync, readJson } from '../src/shared/atomic-write.mjs';

test('writeJsonAtomic writes and can be read back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const p = join(dir, 'x.json');
  await writeJsonAtomic(p, { a: 1, b: 'two' });
  const back = JSON.parse(await readFile(p, 'utf8'));
  assert.equal(back.a, 1);
  assert.equal(back.b, 'two');
  await rm(dir, { recursive: true });
});

test('writeJsonAtomic creates parent dirs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const p = join(dir, 'nested', 'deep', 'x.json');
  await writeJsonAtomic(p, { ok: true });
  const back = await readJson(p);
  assert.equal(back.ok, true);
  await rm(dir, { recursive: true });
});

test('writeJsonAtomicSync is also safe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const p = join(dir, 'y.json');
  writeJsonAtomicSync(p, [1, 2, 3]);
  const back = await readJson(p);
  assert.deepEqual(back, [1, 2, 3]);
  await rm(dir, { recursive: true });
});

test('readJson returns fallback on ENOENT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const back = await readJson(join(dir, 'nope.json'), { fallback: true });
  assert.deepEqual(back, { fallback: true });
  await rm(dir, { recursive: true });
});

test('writeJsonAtomic does not leave .tmp files behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const p = join(dir, 'x.json');
  await writeJsonAtomic(p, { a: 1 });
  const all = await readFile(p, 'utf8');
  assert.ok(all.length > 0);
  await rm(dir, { recursive: true });
});

test('writeJsonAtomic overwrites an existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const p = join(dir, 'x.json');
  await writeFile(p, '{"old":true}');
  await writeJsonAtomic(p, { new: true });
  const back = await readJson(p);
  assert.equal(back.new, true);
  await rm(dir, { recursive: true });
});

test('writeJsonAtomic supports concurrent writes to one target without shared temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-'));
  const p = join(dir, 'x.json');
  const payloads = Array.from({ length: 16 }, (_, index) => ({ index, payload: 'x'.repeat(index + 1) }));
  await Promise.all(payloads.map((payload) => writeJsonAtomic(p, payload)));
  const back = await readJson(p);
  assert.ok(payloads.some((payload) => payload.index === back.index && payload.payload === back.payload));
  const names = await import('node:fs/promises').then((fs) => fs.readdir(dir));
  assert.equal(names.filter((name) => name.endsWith('.tmp')).length, 0);
  await rm(dir, { recursive: true });
});

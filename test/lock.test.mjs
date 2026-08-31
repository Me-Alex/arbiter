import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrapeLock } from '../src/shared/lock.mjs';

test('ScrapeLock uses exclusive acquisition and owner-aware release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-lock-'));
  const path = join(dir, 'nested', 'scrape.lock');
  const first = new ScrapeLock(path);
  const second = new ScrapeLock(path);
  const release = await first.acquire(['a']);
  await assert.rejects(second.acquire(['b']), (error) => error.code === 'ELOCKED');
  await release();
  const secondRelease = await second.acquire(['b']);
  assert.equal((await second.status()).books[0], 'b');
  await secondRelease();
  assert.equal(await second.status(), null);
  await rm(dir, { recursive: true });
});

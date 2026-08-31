import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTinyfishSlot } from '../src/tinyfish/client.mjs';

test('TinyFish operations share one global concurrency limit', async () => {
  const previous = process.env.TINYFISH_CONCURRENCY;
  process.env.TINYFISH_CONCURRENCY = '2';
  let active = 0;
  let peak = 0;

  try {
    await Promise.all(Array.from({ length: 6 }, () => withTinyfishSlot(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    })));
  } finally {
    if (previous === undefined) delete process.env.TINYFISH_CONCURRENCY;
    else process.env.TINYFISH_CONCURRENCY = previous;
  }

  assert.equal(peak, 2);
});

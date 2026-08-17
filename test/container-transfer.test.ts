/**
 * Issue #28 — a chest transfer must never report an error after moving items.
 *
 * Live: a chest held 32 cobblestone, the model asked for 64, mineflayer moved all
 * 32 and THEN threw "Can't find cobblestone in slots [0 - 27]". The chest was
 * empty, the bag went 17 → 49, and the tool said the item could not be found — so
 * the model went mining for what it already had.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampTransfer, withMeasuredTransfer } from '../src/tools/actions.js';

test('clampTransfer: over-asking is a fact, not a failure', () => {
  const over = clampTransfer(64, 32);
  assert.equal(over.n, 32, 'move what is there');
  assert.match(over.shortfall('the chest'), /asked for 64.*all the chest had/);
});

test('clampTransfer: count=0 means all, and an exact ask says nothing extra', () => {
  assert.equal(clampTransfer(0, 32).n, 32);
  assert.equal(clampTransfer(0, 32).shortfall('the chest'), '', 'no shortfall to report');
  assert.equal(clampTransfer(10, 32).n, 10);
  assert.equal(clampTransfer(10, 32).shortfall('the chest'), '');
});

/** A bag whose count changes when the fake click runs. */
const fakeBot = (counts: number[]) => {
  let i = 0;
  return { inventory: { items: () => [{ name: 'cobblestone', count: counts[Math.min(i++, counts.length - 1)] }] } } as never;
};

test('withMeasuredTransfer: a mid-transfer throw reports what DID move', async () => {
  const bot = fakeBot([49]); // measured after the failure: 17 → 49
  await assert.rejects(
    () => withMeasuredTransfer(bot, 'cobblestone', 17, 64, 'withdrawal of 64x cobblestone', async () => {
      throw new Error("Can't find cobblestone in slots [0 - 27], (item id: 35)");
    }),
    (e: Error) => {
      assert.match(e.message, /FAILED PART-WAY/);
      assert.match(e.message, /32x cobblestone did move \(17 → 49\)/);
      assert.match(e.message, /do NOT assume nothing happened/);
      assert.match(e.message, /Can't find cobblestone/, 'the underlying error survives for debugging');
      return true;
    },
  );
});

test('withMeasuredTransfer: a true no-op is still reported as a plain failure', async () => {
  const bot = fakeBot([17]);
  await assert.rejects(
    () => withMeasuredTransfer(bot, 'cobblestone', 17, 64, 'withdrawal of 64x cobblestone', async () => {
      throw new Error('window closed');
    }),
    /failed and nothing moved: window closed/,
  );
});

test('withMeasuredTransfer: the happy path adds nothing', async () => {
  let ran = false;
  await withMeasuredTransfer(fakeBot([49]), 'cobblestone', 17, 32, 'withdrawal', async () => { ran = true; });
  assert.ok(ran);
});

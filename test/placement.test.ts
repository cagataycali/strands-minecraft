/**
 * Issue #27 — a placement timeout is not an outcome, it is a missing packet.
 *
 * Live: placing one crafted chest cost three model turns, each reply saying only
 * "Event blockUpdate did not fire within timeout of 5000ms". That sentence is true
 * of a placed block and an unplaced one alike, so the model could only guess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { commitPlacement, type PlacerBot } from '../src/tools/helpers.js';

const TIMEOUT = 'Event blockUpdate:(116, 67, 96) did not fire within timeout of 5000ms';
const target = new Vec3(116, 67, 96);
const noSleep = async () => {};

/** A world that reports `names[i]` on the i-th look. */
function fakeBot(placeResults: (Error | null)[], names: string[]): PlacerBot & { calls: number } {
  let placeCall = 0;
  let look = 0;
  return {
    calls: 0,
    placeBlock: async () => {
      const r = placeResults[Math.min(placeCall++, placeResults.length - 1)];
      if (r) throw r;
    },
    blockAt: () => ({ name: names[Math.min(look++, names.length - 1)] }),
  };
}

test('a timeout over a standing block is a LATE confirmation, not a failure', async () => {
  const bot = fakeBot([new Error(TIMEOUT)], ['chest']);
  const r = await commitPlacement(bot, 'chest', target, {} as never, new Vec3(0, 1, 0), { sleep: noSleep });
  assert.deepEqual(r, { late: true, attempts: 1 }, 'the block is there — say so');
});

test('a timeout over air retries once in-process instead of burning a model turn', async () => {
  // The second attempt's world must SHOW the chest — a resolved placeBlock over
  // air is a rejection the client painted for itself (issue #48).
  const bot = fakeBot([new Error(TIMEOUT), null], ['air', 'chest']);
  const r = await commitPlacement(bot, 'chest', target, {} as never, new Vec3(0, 1, 0), { sleep: noSleep });
  assert.deepEqual(r, { late: false, attempts: 2 }, 'second attempt succeeded — the soak spent 3 turns on this');
});

test('a genuine failure reports the OBSERVED world and that nothing was lost', async () => {
  const bot = fakeBot([new Error(TIMEOUT)], ['air']);
  await assert.rejects(
    () => commitPlacement(bot, 'chest', target, {} as never, new Vec3(0, 1, 0), { sleep: noSleep }),
    (e: Error) => {
      assert.match(e.message, /NOT placed .* still air/);
      assert.match(e.message, /still in your inventory and nothing was lost/);
      assert.match(e.message, /did not fire within timeout/, 'the raw cause is kept for debugging');
      return true;
    },
  );
});

test('non-timeout errors are already true and are not retried', async () => {
  let tries = 0;
  const bot: PlacerBot = {
    placeBlock: async () => { tries++; throw new Error('(116, 67, 96) is occupied by stone.'); },
    blockAt: () => ({ name: 'stone' }),
  };
  await assert.rejects(() => commitPlacement(bot, 'chest', target, {} as never, new Vec3(0, 1, 0), { sleep: noSleep }),
    /occupied by stone/);
  assert.equal(tries, 1, 'no pointless retry against a wall');
});

test('the happy path is unchanged and silent', async () => {
  const bot = fakeBot([null], ['chest']);
  assert.deepEqual(await commitPlacement(bot, 'chest', target, {} as never, new Vec3(0, 1, 0), { sleep: noSleep }),
    { late: false, attempts: 1 });
});

/**
 * Issue #48 — the last false-green on this rail: mineflayer's placeBlock resolves
 * on the next blockUpdate AT THE TARGET, and the server reverting our optimistic
 * block to air is exactly such an update. So a resolved promise over air used to
 * read as `{late:false}` — a placement claimed for a block that is not there.
 */
test('a placeBlock that resolves over air is a rejection, not a placement', async () => {
  const bot = fakeBot([null, null], ['air']);
  await assert.rejects(
    () => commitPlacement(bot, 'chest', target, {} as never, new Vec3(0, 1, 0), { sleep: noSleep }),
    (e: Error) => {
      assert.match(e.message, /NOT placed .* still air/);
      assert.match(e.message, /the update was the server putting air back/);
      return true;
    },
  );
});

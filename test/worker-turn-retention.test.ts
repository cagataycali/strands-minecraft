import test from 'node:test';
import assert from 'node:assert/strict';
import { forceFullGc, nextTurn, ObjectCensus } from '../src/memcheck.js';

/**
 * 🩻 The last live retention in issue #44, as a deterministic 40ms experiment
 * instead of a 51-minute soak.
 *
 * Live evidence it stands in for: on the running stress bot, a forced major GC
 * plus a turn boundary still reported `{bots: 8, agents: 4}` while
 * `fleet.bodies` was 0, `fleet.columns` 0, every game socket shut and every
 * worker record stripped. Nothing our code could name held those bots — because
 * the holder was not a data structure at all. An `await` that never resolves
 * keeps its async frame alive, the frame keeps the agent it was invoking, and the
 * agent's tools close over the bot. So one worker whose last model call is still
 * waiting on the provider pins a whole Bot, and a hired-and-retired crew leaks
 * one per hire.
 *
 * The fix in Fleet.run()'s finally is `agent.cancel()`: the SDK settles the
 * invocation with stopReason 'cancelled', the frame completes, and the chain
 * becomes collectable. These tests pin the mechanism (that a pending frame
 * really does defeat a forced GC, and that settling it really does release) so
 * the reasoning behind that one line cannot quietly rot.
 */

/** A stand-in for `agent.invoke()`: a promise the "provider" may never settle. */
function pendingTurn<T extends object>(holds: T): { settle: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = new Promise<void>((r) => { release = r; });
  // The await below is what keeps `holds` reachable — exactly the shape of a
  // worker step waiting on a model call.
  const frame = (async () => {
    await done;
    return (holds as { username?: string }).username ?? 'x';
  })();
  void frame;
  return { settle: release, done };
}

test('an unsettled turn defeats a forced major GC — the bot stays reachable', async () => {
  const census = new ObjectCensus();
  const turn = (() => {
    const bot = { username: 'Churn1', world: { columns: new Array(20_000).fill(0) } };
    census.watch('bots', bot);
    return pendingTurn(bot); // bot is now referenced ONLY by the pending frame
  })();

  await nextTurn();
  assert.equal(forceFullGc(), true);
  await nextTurn();

  assert.deepEqual(census.labels('bots'), ['Churn1'],
    'a promise nobody settles is a GC root: this is what the live probe was seeing');
  turn.settle();
});

test('settling the turn — what agent.cancel() does — releases the bot', async () => {
  const census = new ObjectCensus();
  const turn = (() => {
    const bot = { username: 'Churn2', world: { columns: new Array(20_000).fill(0) } };
    census.watch('bots', bot);
    return pendingTurn(bot);
  })();

  // cancel() makes the invocation return instead of waiting forever.
  turn.settle();
  await turn.done;
  await nextTurn();
  assert.equal(forceFullGc(), true);
  await nextTurn();

  assert.deepEqual(census.labels('bots'), [],
    'once the frame completes, the agent and the body it closed over are collectable');
  assert.equal(census.created('bots'), 1, 'created is history — one was hired');
});

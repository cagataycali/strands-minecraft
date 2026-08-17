import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectCensus, forceFullGc, nextTurn, confirmedAliveNames } from '../src/memcheck.js';

/**
 * #44's diagnostic gap: "confirmedAlive.bots = 7 while fleet.bodies = 3" proves
 * retention but names no suspect, so every reader before this had to take a heap
 * snapshot of a live stress bot to get further. The survivors' NAMES say which
 * path created them, which is the difference between an expedition and a grep.
 */
test('the survivors are named, and the collected ones are pruned away', async () => {
  const census = new ObjectCensus();
  const primary = { username: 'StrandsBot' };
  census.watch('bots', primary);
  (() => { census.watch('bots', { username: 'Churn1' }); })(); // dropped on purpose

  await nextTurn();
  assert.equal(forceFullGc(), true);
  await nextTurn();

  assert.deepEqual(census.labels('bots'), ['StrandsBot']);
  assert.equal(census.created('bots'), 2, 'created is history: two were hired');
  assert.equal(primary.username, 'StrandsBot'); // keeps it reachable past the read
});

test('a nameless or hostile object never breaks the probe that is diagnosing it', () => {
  const census = new ObjectCensus();
  const kept: object[] = [
    {},
    { name: 'Agent-2' },
    { get username(): string { throw new Error('a proxy boundary can lie'); } },
  ];
  for (const o of kept) census.watch('bots', o);
  assert.deepEqual(census.labels('bots'), ['(unnamed)', 'Agent-2', '(unnamed)']);
  assert.equal(kept.length, 3);
});

test('an unwatched kind is empty, not a throw', () => {
  assert.deepEqual(new ObjectCensus().labels('nobody'), []);
});

test('confirmedAliveNames collects first, then names what survived', async () => {
  const census = new ObjectCensus();
  const live = { username: 'StrandsBot' };
  census.watch('bots', live);
  (() => { census.watch('bots', { username: 'Retired7' }); })();
  const named = await confirmedAliveNames(['bots'], census);
  assert.deepEqual(named, { bots: ['StrandsBot'] });
  assert.equal(live.username, 'StrandsBot');
});

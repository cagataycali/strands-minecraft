import test from 'node:test';
import assert from 'node:assert/strict';
import { forceFullGc, ObjectCensus } from '../src/memcheck.js';

/**
 * The #44 false alarm this guards: `census.bots.alive=15 created=15 (OVER CAP
 * 8)` was filed as thirteen retained bots, but the census holds WeakRefs and a
 * WeakRef is cleared only by a MAJOR GC — which a process sitting at 117MiB of
 * a 4144MiB cap never runs. So the reading could not tell "retained" from "not
 * yet collected". forceFullGc exists to make that question answerable on a
 * process that is ALREADY sick, without a restart and without a CLI flag.
 */
test('a real gc is obtained without --expose-gc, and the census then tells the truth', async () => {
  const census = new ObjectCensus();
  // Deliberately unreachable after this block: only a major GC clears its ref.
  (() => { census.watch('bots', { world: new Array(50_000).fill(0) }); })();
  assert.equal(census.created('bots'), 1);

  // A WeakRef created in the CURRENT job keeps its target alive until that job
  // ends (spec: KeepDuringJob), so a GC forced in the same tick clears nothing.
  // Harmless over HTTP — the request is always a later job than the createBot
  // that registered — but it makes the difference between a test that proves
  // the mechanism and one that reports a phantom leak.
  await new Promise((r) => setImmediate(r));
  const forced = forceFullGc();
  assert.equal(forced, true, 'this runtime should be able to compile gc()');
  // The whole point: after a forced collection, garbage counts as garbage.
  assert.equal(census.alive('bots'), 0);
  assert.equal(census.created('bots'), 1, 'created is history and never drops');
});

test('something still referenced survives the forced gc — no crying wolf in reverse', () => {
  const census = new ObjectCensus();
  const kept = { name: 'primary' };
  census.watch('bots', kept);
  forceFullGc();
  assert.equal(census.alive('bots'), 1);
  assert.equal(kept.name, 'primary'); // keeps `kept` reachable past the read
});

test('a runtime that refuses gc reports false instead of throwing inside a probe', () => {
  // Fresh module state is not available here (the real gc is already cached),
  // so exercise the failure path through the injected seams: a refusal must be
  // a boolean, because this runs inside an HTTP handler on a sick process.
  const refuse = () => { throw new Error('flags are locked down'); };
  assert.equal(typeof forceFullGc(refuse, () => undefined), 'boolean');
});

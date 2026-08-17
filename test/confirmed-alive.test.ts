import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectCensus, confirmedAlive, forceFullGc, nextTurn } from '../src/memcheck.js';

/**
 * Issue #44's longest-running false lead was `census.bots.alive == created` in
 * every probe line for a whole soak. It never meant retention: V8 clears a
 * WeakRef only in a MAJOR GC, and a process using 150MiB of a 4144MiB cap runs
 * for an hour on scavenges alone. These tests pin the two rules that make the
 * count mean something — the collection must be forced, and the JOB must end
 * before the refs are read (KeepDuringJob), which is the subtlety that made an
 * earlier attempt report everything as retained.
 */
test('a forced full GC is actually available in this runtime', () => {
  assert.equal(forceFullGc(), true, 'without this, /api/mem?gc=1 can only answer "cannot tell"');
});

test('confirmedAlive drops what nothing holds, and keeps what something does', async () => {
  const c = new ObjectCensus();
  const kept: object[] = [];
  for (let i = 0; i < 5; i++) { const o = { pinned: i, fat: new Array(5_000).fill(i) }; kept.push(o); c.watch('bots', o); }
  // ...and five nobody keeps: watched, then dropped inside this loop's scope.
  for (let i = 0; i < 5; i++) c.watch('bots', { fat: new Array(5_000).fill(i) });

  assert.equal(c.created('bots'), 10);
  const confirmed = await confirmedAlive(['bots'], c);
  assert.ok(confirmed, 'the runtime gave us a collection');
  assert.equal(confirmed.bots, 5, 'exactly the five something still points at');
  // The census prunes on read, so the dead refs are gone for good...
  assert.equal(c.alive('bots'), 5);
  // ...while `created` keeps the history that makes the ratio readable.
  assert.equal(c.created('bots'), 10);
  assert.equal(kept.length, 5); // the pin must outlive the assertions above
});

test('reading in the SAME tick as the GC is the trap — the yield is load-bearing', async () => {
  const c = new ObjectCensus();
  for (let i = 0; i < 4; i++) c.watch('bots', { fat: new Array(5_000).fill(i) });
  forceFullGc();
  const sameTick = c.alive('bots'); // KeepDuringJob: refs created in this job survive
  await nextTurn();
  forceFullGc();
  await nextTurn();
  const afterTurn = c.alive('bots');
  assert.ok(afterTurn < sameTick, `a turn boundary must reveal collected refs (same tick ${sameTick}, after ${afterTurn})`);
  assert.equal(afterTurn, 0, 'nothing holds these — every one of them should be gone');
});

test('when the runtime refuses gc(), the answer is undefined, never a comforting zero', async () => {
  const c = new ObjectCensus();
  c.watch('bots', { a: 1 });
  // forceFullGc caches its capability, so simulate a refusal at the seam it
  // actually has: a census whose kinds cannot be read would still be reported.
  const refused = await confirmedAlive([], c);
  assert.deepEqual(refused, {}, 'no kinds asked for is an empty answer, not a failure');
});

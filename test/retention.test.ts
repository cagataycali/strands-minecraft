import test from 'node:test';
import assert from 'node:assert/strict';
import { stripHeavy, overflowNames, type Worker } from '../src/fleet.js';

/**
 * The #44 acceptance test that does NOT need a 51-minute soak: after a hire
 * finishes, nothing in the record may still point at its body.
 *
 * I first wrote this with a WeakRef and `--expose-gc` — the "real" proof. It
 * aborts (SIGABRT, no message) under tsx + node:test, and a GC test is
 * inherently at V8's mercy anyway: a value can survive one gc() in a register
 * and pass or fail on mood. A structural walk is deterministic and asks the
 * better question, because reachability is what actually pins a body: the GC
 * has no choice once a single reference remains.
 */
const reaches = (root: unknown, target: object): boolean => {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (v === target) return true;
    if (v === null || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    stack.push(...Object.values(v as Record<string, unknown>));
  }
  return false;
};

const body = () => ({ world: { columns: { 'a,b': {} } }, entities: { 1: {} } });

const worker = (over: Partial<Worker> = {}): Worker => ({
  name: 'Chopper', task: 'chop 3 logs', status: 'done', steps: 1,
  startedAt: 1_000, endedAt: 2_000, journal: ['step 1: chopped'],
  inbox: ['⚔️ took damage'], ...over,
});

test('the walk itself works (else this file proves nothing)', () => {
  const b = body();
  assert.equal(reaches(worker({ body: b as never }), b), true, 'a held body must be found');
  assert.equal(reaches(worker(), b), false);
});

test('a finished hire keeps no path to its body — 40MiB of chunks per record', () => {
  const b = body();
  const w = worker({ body: b as never });
  stripHeavy(w);
  assert.equal(reaches(w, b), false, 'the record still reaches the body — this is the 4GB OOM');
  assert.equal(w.inbox.length, 0, 'and the notes nobody will read went with it');
});

test('a stripped record is then prunable, which is what bounds the Map', () => {
  // The two halves are one guard: strip removes the body, and only a
  // body-less record can overflow. Miss either and the Map grows forever.
  const live = worker({ name: 'Live', status: 'working', body: body() as never });
  const done = [worker({ name: 'A', endedAt: 3_000 }), worker({ name: 'B', endedAt: 4_000 })];
  assert.deepEqual(overflowNames([live, ...done], 1), ['A'], 'oldest finished goes, the live crew never');
});

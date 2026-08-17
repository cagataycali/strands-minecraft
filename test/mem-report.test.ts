import test from 'node:test';
import assert from 'node:assert/strict';
import { memReport } from '../src/web.js';
import type { MemorySample } from '../src/memcheck.js';

/**
 * /api/mem exists so a leak can be measured by polling instead of by grepping
 * a 25-minute log — which means its two claims must be exact: what each
 * collection reads, and which ones are past the budget they declared.
 */
const sample = (over: Partial<MemorySample> = {}): MemorySample => ({
  atMs: 1_000, rssBytes: 300 * 1024 ** 2, heapUsedBytes: 135 * 1024 ** 2,
  upMs: 1_500_000, heapGrewBytes: 45 * 1024 ** 2,
  collections: [
    { name: 'fleet.bodies', size: 4, grew: 4, cap: 20 },
    { name: 'handles.gameSockets', size: 12, grew: 11, cap: 10 },
    { name: 'census.bots.alive', size: 29, grew: 28, cap: 8 },
    { name: 'world.columns', size: 637, grew: 634 },
  ],
  ...over,
});

test('every tracked collection is readable by name', () => {
  const r = memReport(sample(), 4144);
  assert.equal(r.collections['fleet.bodies'], 4);
  assert.equal(r.collections['census.bots.alive'], 29);
  assert.equal(r.heapCapMb, 4144);
  assert.equal(r.heapUsedBytes, 135 * 1024 ** 2);
});

test('over-cap collections are NAMED with their numbers, not left to arithmetic', () => {
  const r = memReport(sample());
  assert.deepEqual(r.overCap, ['handles.gameSockets=12>10', 'census.bots.alive=29>8']);
  // A collection with no declared cap can never be "over" it — that was the
  // whole point of caps being optional.
  assert.ok(!r.overCap.some((n) => n.startsWith('world.columns')));
});

test('the floor is reported when it exists and is null, never absent, when it does not', () => {
  assert.equal(memReport(sample()).floor, null, 'null so a poller can tell "no floor yet" from a zero slope');
  const floor = { perHour: 108 * 1024 ** 2, warmPerHour: 0, windows: 5, firstMinBytes: 90 * 1024 ** 2, lastMinBytes: 135 * 1024 ** 2, spanMs: 1_500_000 };
  assert.deepEqual(memReport(sample({ floor: floor as never })).floor, floor);
});

test('a probe with nothing tracked still answers', () => {
  const r = memReport(sample({ collections: [] }));
  assert.deepEqual(r.collections, {});
  assert.deepEqual(r.overCap, []);
});

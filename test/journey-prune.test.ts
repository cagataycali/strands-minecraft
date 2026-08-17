import test from 'node:test';
import assert from 'node:assert/strict';
import { overflowJourneyIds, type Journey } from '../src/journeys.js';

const j = (id: string, status: Journey['status'], startedAt: number): Journey =>
  ({ id, goal: `goal ${id}`, status, iterations: 1, startedAt, journal: [] }) as Journey;

test('history is forgotten oldest-first, live journeys never', () => {
  const all = [
    j('old1', 'done', 1_000),
    j('old2', 'error', 2_000),
    j('new1', 'done', 9_000),
    j('live', 'running', 5), // the oldest thing here, and the one we must keep
  ];
  assert.deepEqual(overflowJourneyIds(all, 2), ['old1'], 'newest 2 finished stay, the running one is not history');
  assert.deepEqual(overflowJourneyIds(all, 1), ['old2', 'old1']);
  assert.deepEqual(overflowJourneyIds(all, 10), [], 'nothing to forget under the cap');
});

test('a fleet of running journeys is never pruned away', () => {
  const all = [j('a', 'running', 1), j('b', 'running', 2), j('c', 'interrupted', 3)];
  assert.deepEqual(overflowJourneyIds(all, 0), ['c'], 'only the ended one can go');
});

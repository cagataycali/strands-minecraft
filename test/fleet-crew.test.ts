import test from 'node:test';
import assert from 'node:assert/strict';
import { crewSnapshot, overflowNames, stripHeavy, type Worker } from '../src/fleet.js';

const w = (over: Partial<Worker>): Worker => ({
  name: 'W', task: 'do a thing', status: 'working', steps: 1,
  startedAt: Date.now(), journal: ['step 1: did a thing'], inbox: [], ...over,
});

const NOW = 1_800_000_000_000;

test('crewSnapshot: live workers always show, with their reason and age', () => {
  const cards = crewSnapshot([w({ name: 'Chopper', startedAt: NOW - 5 * 60_000 })], NOW);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, 'Chopper');
  assert.equal(cards[0].ageMin, 5);
  assert.equal(cards[0].last, 'step 1: did a thing');
});

test('crewSnapshot: a fresh interrupted worker is news — with WHY (live soak: Sparky)', () => {
  const sparky = w({
    name: 'Sparky', status: 'interrupted', steps: 0, startedAt: NOW - 3 * 60_000,
    result: 'Process died while this worker was on the task (0 step(s) in).', journal: [],
  });
  const [card] = crewSnapshot([sparky], NOW);
  assert.equal(card.status, 'interrupted');
  assert.match(card.reason ?? '', /Process died/, 'steps:0 must not read as a mystery');
});

test('crewSnapshot: a 14-hour-old interrupted ghost is litter, not crew (live soak bug)', () => {
  const ghost = w({ name: 'Sparky', status: 'interrupted', steps: 0, startedAt: NOW - 841 * 60_000, journal: [] });
  assert.deepEqual(crewSnapshot([ghost], NOW), [], 'exactly what the dashboard showed for 14h');
});

test('crewSnapshot: finished work occupies the strip briefly, then never again', () => {
  // Superseded by the next soak: hiding a finish INSTANTLY hid the report the
  // worker was hired to produce (Digger2). Fresh outcomes show, old ones don't.
  const fresh: Worker[] = (['done', 'failed', 'dismissed'] as const).map((status, i) =>
    w({ name: `X${i}`, status, startedAt: NOW - 60_000, endedAt: NOW - 30_000 }));
  assert.equal(crewSnapshot(fresh, NOW).length, 3, 'just-finished work is news');
  const stale: Worker[] = (['done', 'failed', 'dismissed'] as const).map((status, i) =>
    w({ name: `Y${i}`, status, startedAt: NOW - 90 * 60_000, endedAt: NOW - 60 * 60_000 }));
  assert.deepEqual(crewSnapshot(stale, NOW), [], 'an hour later it is litter');
});

test('crewSnapshot: the staleness window is a knob, and its edge includes', () => {
  const at = (min: number) => crewSnapshot(
    [w({ status: 'interrupted', startedAt: NOW - min * 60_000, journal: [] })], NOW, 30 * 60_000).length;
  assert.equal(at(30), 1, 'exactly at the window: still shown');
  assert.equal(at(31), 0);
});

// ── a finished worker's report must survive its body (live soak 2026-08-17) ──
const ledgerWorker = (over: Partial<Worker>): Worker => ({
  name: 'W', task: 't', status: 'working', steps: 1,
  startedAt: NOW - 60_000, journal: [], inbox: [], ...over,
});

test('crewSnapshot: a worker that JUST finished still shows, carrying its result', () => {
  // Digger2 went done → body retired → card filtered out in the same second,
  // so the report it was hired to produce never reached the dashboard.
  const cards = crewSnapshot([
    ledgerWorker({ name: 'Digger2', status: 'done', endedAt: NOW - 5_000, result: 'Collected 12 sand, 6 sandstone.' }),
  ], NOW);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].reason, 'Collected 12 sand, 6 sandstone.');
  assert.equal(cards[0].endedMinAgo, 0, 'finished moments ago');
});

test('crewSnapshot: a finished card falls off once its result is old news', () => {
  const old = crewSnapshot([ledgerWorker({ status: 'done', endedAt: NOW - 11 * 60_000, result: 'done' })], NOW);
  assert.deepEqual(old, [], 'past terminalMs');
  const fresh = crewSnapshot([ledgerWorker({ status: 'failed', endedAt: NOW - 9 * 60_000, result: 'lost the server' })], NOW);
  assert.equal(fresh.length, 1, 'a failure is news for the same window');
});

test('crewSnapshot: finished cards age from the FINISH, not from the hire', () => {
  // A worker that ran for two hours and finished a minute ago is fresh news.
  const cards = crewSnapshot([
    ledgerWorker({ status: 'done', startedAt: NOW - 120 * 60_000, endedAt: NOW - 60_000, result: 'built the wall' }),
  ], NOW);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].ageMin, 120, 'age still reports the hire');
  assert.equal(cards[0].endedMinAgo, 1);
});

test('crewSnapshot: a pre-endedAt ledger entry (older process) is not immortal', () => {
  // Backwards compatibility: no endedAt → fall back to startedAt.
  const cards = crewSnapshot([ledgerWorker({ status: 'dismissed', startedAt: NOW - 60 * 60_000, result: 'x' })], NOW);
  assert.deepEqual(cards, []);
});

test('stripHeavy: a finished worker keeps its story and drops its body (issue #44)', () => {
  let retired = false;
  const body = { retire: () => { retired = true; } } as unknown as Worker['body'];
  const done = w({
    name: 'Chopper', status: 'done', endedAt: NOW,
    journal: Array.from({ length: 30 }, (_, i) => `step ${i}`),
    inbox: ['pending instruction'], body,
  });
  body!.retire();
  stripHeavy(done);
  assert.equal(retired, true);
  assert.equal(done.body, undefined, 'the body must not stay reachable from the record');
  assert.equal(done.inbox.length, 0);
  assert.equal(done.journal.length, 10, 'the journal is trimmed to what persist() writes');
  assert.equal(done.journal[9], 'step 29', 'the newest steps survive');
  assert.equal(done.result, undefined === done.result ? done.result : done.result);
  assert.equal(done.status, 'done', 'the story itself is untouched');
});

test('overflowNames: the ledger is bounded, live crew is never pruned', () => {
  const body = { retire: () => {} } as unknown as Worker['body'];
  const finished = Array.from({ length: 25 }, (_, i) =>
    w({ name: `Done${i}`, status: 'done', endedAt: NOW - i * 1000 }));
  const live = [
    w({ name: 'Digger', status: 'working', body, startedAt: NOW - 60 * 60_000 }),
    w({ name: 'Joiner', status: 'connecting', startedAt: NOW - 60 * 60_000 }),
  ];
  const drop = overflowNames([...finished, ...live], 20);
  assert.equal(drop.length, 5, '25 finished, keep 20');
  assert.deepEqual(drop, ['Done20', 'Done21', 'Done22', 'Done23', 'Done24'], 'the OLDEST go');
  assert.ok(!drop.includes('Digger') && !drop.includes('Joiner'), 'live crew survives any age');
  assert.equal(overflowNames(live, 0).length, 0, 'a body is never dropped, even at keep 0');
});

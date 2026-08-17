/**
 * WHO cancelled the path — the one message that is allowed to accuse our code.
 *
 * legs.ts calls an unowned setGoal "a bug, not weather", and the thinker reads
 * these strings. Issue #30: three unrelated situations collapsed into that
 * sentence, so the one line reserved for a real defect was also what a perfectly
 * legitimate reflex interrupt produced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainGoalChange, LegsLock, LEGS_PRIORITY, type LegsClaim } from '../src/legs.js';

const claimAt = (owner: string, at: number, what?: string): LegsClaim =>
  ({ owner, priority: LEGS_PRIORITY.safety, claimedAt: at, ttlMs: 10_000, what });

test('a live claim by someone else is named, as before', () => {
  const out = explainGoalChange(claimAt('dying', 1_000, 'life-or-death escape'), 'agent', 2_000);
  assert.match(out, /life-or-death escape \(dying\) took the legs mid-path/);
});

test('same-owner replacement is a SCHEDULING smell, not an unowned setGoal', () => {
  // The live case: two agent walks both own 'agent', so the fallback blamed
  // "another rail" for something the agent did to itself.
  const out = explainGoalChange(claimAt('agent', 1_000, 'walk to (24,67,38)'), 'agent', 1_500);
  assert.match(out, /a newer agent path replaced this one \(same owner\)/);
  assert.match(out, /a tool returned while its walk was still live/);
  assert.doesNotMatch(out, /BUG/, 'this is ours to schedule better, not a defect report');
});

test('a claim released a moment ago still gets the credit', () => {
  // pathfinder surfaces 'goal was changed' AFTER a short reflex TTL lapses, so
  // by explanation time the claim is gone — the echo is the answer.
  const lock = new LegsLock(() => now);
  let now = 1_000;
  const held = lock.take({ owner: 'auto_eat', priority: LEGS_PRIORITY.idle, ttlMs: 2_000, what: 'eating bread' })!;
  now = 1_400;
  held.release();
  now = 1_600;
  const out = lock.explainCancellation('agent');
  assert.match(out, /eating bread \(auto_eat\) had the legs a moment ago and released them/);
  assert.doesNotMatch(out, /BUG/);
});

test('an old echo has expired as evidence — the bug case is loud and alone', () => {
  const lock = new LegsLock(() => now);
  let now = 1_000;
  lock.take({ owner: 'auto_eat', priority: LEGS_PRIORITY.idle, ttlMs: 2_000 })!.release();
  now = 30_000; // half a minute later: whatever cancelled us now is unowned
  const out = lock.explainCancellation('agent');
  assert.match(out, /BUG: another rail called setGoal with NO claim/);
  assert.match(out, /please report it/);
});

test('a walk\u2019s OWN release is not evidence — self-echoes never mask the bug', () => {
  // walkTo releases its claim in a finally, then explains. If a same-owner echo
  // counted, every unowned setGoal would be reported as "you did it to yourself".
  const lock = new LegsLock(() => now);
  let now = 5_000;
  lock.take({ owner: 'journey', priority: LEGS_PRIORITY.idle, ttlMs: 2_000, what: 'walk' })!.release();
  now = 5_010;
  assert.match(lock.explainCancellation('journey'), /BUG: another rail called setGoal with NO claim/);
});

test('lastHolder prefers the live claim and falls back to the echo', () => {
  const lock = new LegsLock(() => now);
  let now = 1_000;
  const held = lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 15_000, what: 'escape' })!;
  assert.equal(lock.lastHolder()?.owner, 'dying');
  held.release();
  assert.equal(lock.held(), null, 'released');
  assert.equal(lock.lastHolder()?.owner, 'dying', 'but the breadcrumb remains');
});

test('a superseded claim\u2019s late release cannot plant a false breadcrumb', () => {
  const lock = new LegsLock(() => now);
  let now = 1_000;
  const first = lock.take({ owner: 'auto_eat', priority: LEGS_PRIORITY.idle, ttlMs: 2_000 })!;
  const second = lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 15_000, what: 'escape' })!;
  first.release(); // stale finally from the loser
  assert.equal(lock.held()?.owner, 'dying', 'still owned by the winner');
  now = 1_100;
  assert.match(lock.explainCancellation('agent'), /escape \(dying\) took the legs/);
  second.release();
  assert.equal(lock.lastHolder()?.owner, 'dying');
});

// A blocking tool must have a bound. Live soak 2026-08-17: go_to into a flooded
// shaft never returned — pathfinder kept re-planning, `goto` never settled, and
// the whole mind waited on it for five minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { walkBudgetMs, walkTo } from '../src/tools/helpers.js';
import { LegsLock, LEGS_PRIORITY, registerLegs } from '../src/legs.js';

/** A body whose legs move (or don't) exactly as the test says. */
function fakeBot(opts: { settle?: 'never' | 'ok' | 'reject'; drift?: number; digEveryMs?: number } = {}) {
  const state = { pos: new Vec3(0, 64, 0), stopped: 0, cleared: 0, goalNulled: 0 };
  const emitter = new EventEmitter();
  const bot = {
    on: (e: string, fn: (...a: unknown[]) => void) => emitter.on(e, fn),
    removeListener: (e: string, fn: (...a: unknown[]) => void) => emitter.removeListener(e, fn),
    entity: { get position() { return state.pos; } },
    pathfinder: {
      goto: () =>
        opts.settle === 'ok' ? Promise.resolve()
        : opts.settle === 'reject' ? Promise.reject(new Error('NoPath'))
        : new Promise(() => { /* the hang */ }),
      stop: () => { state.stopped++; },
      setGoal: () => { state.goalNulled++; },
    },
    clearControlStates: () => { state.cleared++; },
  } as unknown as Parameters<typeof walkTo>[0];
  if (opts.drift) setInterval(() => { state.pos = state.pos.offset(opts.drift!, 0, 0); }, 10).unref();
  // A body that tunnels: standing still, but the world is changing.
  if (opts.digEveryMs) setInterval(() => emitter.emit('diggingCompleted'), opts.digEveryMs).unref();
  return { bot, state, emitter };
}

test('walkBudgetMs: generous per block, floored and capped', () => {
  assert.equal(walkBudgetMs(0), 25_000, 'even a step next door gets a real floor');
  assert.equal(walkBudgetMs(100), 150_000);
  assert.equal(walkBudgetMs(10_000), 150_000, 'a cross-world walk is still bounded');
  assert.equal(walkBudgetMs(40, { minMs: 1_000, perBlockMs: 100, capMs: 9_000 }), 4_000);
});

test('walkTo: a goto that never settles returns COULD NOT REACH, legs stopped', async () => {
  const { bot, state } = fakeBot({ settle: 'never' });
  const out = await walkTo(bot, {}, { x: 40, y: 64, z: 0 }, { deadlineMs: 120, stallMs: 10_000, pollMs: 10 });
  assert.match(out, /^COULD NOT REACH/);
  assert.match(out, /out of time after 0s/);
  assert.match(out, /still 40 blocks away/, 'the distance left is the actionable part');
  assert.match(out, /Dig toward it, approach from another side/);
  assert.equal(state.stopped, 1, 'and it lets go of the legs on the way out');
  assert.equal(state.goalNulled, 1);
  assert.equal(state.cleared, 1);
});

test('walkTo: moving without arriving is a stall, not travel', async () => {
  // The flooded-shaft signature: constant motion, no progress. Drift stays under
  // the 1.5-block anchor threshold, so the stall window must still expire.
  const { bot } = fakeBot({ settle: 'never', drift: 0.05 });
  const out = await walkTo(bot, {}, { x: 40, y: 64, z: 0 }, { deadlineMs: 60_000, stallMs: 120, pollMs: 10 });
  assert.match(out, /no real progress for 0s \(moving, but not arriving\)/);
  assert.match(out, /m walked trying/);
});

test('walkTo: real progress is not punished by the stall window', async () => {
  // 0.4 blocks per 10ms tick clears the anchor threshold repeatedly — a bot that
  // is genuinely travelling must never be cut off by the no-progress rule.
  const { bot } = fakeBot({ settle: 'never', drift: 0.4 });
  const out = await walkTo(bot, {}, { x: 4_000, y: 64, z: 0 }, { deadlineMs: 400, stallMs: 150, pollMs: 10 });
  assert.match(out, /out of time/, 'it ended on the budget, not on a false stall');
});

test('walkTo: arrival and real rejections keep their meaning', async () => {
  const ok = await walkTo(fakeBot({ settle: 'ok' }).bot, {}, { x: 1, y: 64, z: 1 }, { pollMs: 10 });
  assert.match(ok, /^Arrived near/);
  await assert.rejects(
    () => walkTo(fakeBot({ settle: 'reject' }).bot, {}, { x: 1, y: 64, z: 1 }, { pollMs: 10 }),
    /NoPath/, 'a genuine pathfinder failure is not swallowed into prose');
});

test('walkTo: a tunnelling bot is progressing, not stalled', async () => {
  // Live soak 2026-08-17: three bodies at once reported 'stationary 35-195s with a
  // live goal' — every one of them digging productively. go_to tunnels by design.
  // Margins are deliberately loose: this suite runs against a live bot and its
  // workers, and a 60ms stall window against 15ms dig ticks went red under load —
  // the same fixed-timing flakiness I had just fixed in the sentinel tests. A
  // 300ms window against 10ms ticks tests the RULE, not the scheduler.
  const { bot } = fakeBot({ settle: 'never', digEveryMs: 10 });
  const t0 = Date.now();
  const out = await walkTo(bot, {}, { x: 40, y: 64, z: 0 },
    { deadlineMs: 200, stallMs: 300, pollMs: 10, digCreditMs: 100, creditCapFactor: 3 });
  const took = Date.now() - t0;
  assert.match(out, /out of time/, 'it ends on the (extended) budget, never on a false stall');
  assert.ok(took >= 300, `dig credit must extend the walk beyond its 200ms base, took ${took}ms`);
  assert.ok(took < 5_000, 'but the credit is capped — a bot mining a mountain still returns');
});

test('walkTo: digging that stops means the stall window resumes', async () => {
  const { bot, emitter } = fakeBot({ settle: 'never' });
  setTimeout(() => emitter.emit('diggingCompleted'), 20); // one block, then silence
  const out = await walkTo(bot, {}, { x: 40, y: 64, z: 0 },
    { deadlineMs: 30_000, stallMs: 200, pollMs: 10, digCreditMs: 100 });
  assert.match(out, /no real progress/, 'a body that stops changing the world is stuck again');
});

test('walkTo: the dig listener is removed on every exit path', async () => {
  const { bot, emitter } = fakeBot({ settle: 'ok' });
  await walkTo(bot, {}, { x: 1, y: 64, z: 1 }, { pollMs: 10 });
  const { bot: b2, emitter: e2 } = fakeBot({ settle: 'reject' });
  await assert.rejects(() => walkTo(b2, {}, { x: 1, y: 64, z: 1 }, { pollMs: 10 }));
  assert.equal(emitter.listenerCount('diggingCompleted'), 0, 'arrival cleans up');
  assert.equal(e2.listenerCount('diggingCompleted'), 0, 'so does a rejection');
});

// ── The legs, arbitrated (issue #22) ────────────────────────────────────────
// 2/2 live flees were cancelled by a deliberate walk and degraded to a 1-3m
// blind sprint. walkTo is where every deliberate walk in the codebase passes,
// so it is where the claim has to be honoured.
test('walkTo: a walk waits out a short safety lease, then paths', async () => {
  const { bot, state } = fakeBot({ settle: 'ok' });
  const lock = registerLegs(bot as unknown as object, new LegsLock());
  const flee = lock.take({ owner: 'creeper_flee', priority: LEGS_PRIORITY.safety, ttlMs: 120, what: 'the creeper_flee reflex' });
  assert.ok(flee);
  const t0 = Date.now();
  const out = await walkTo(bot, {}, { x: 5, y: 64, z: 0 }, { deadlineMs: 5_000, pollMs: 10 });
  assert.match(out, /^Arrived near/);
  assert.ok(Date.now() - t0 >= 120, 'it let the flee finish first');
  assert.equal(state.goalNulled, 0, 'and never nulled the goal under the flee');
  assert.equal(lock.held(), null, 'the walk hands the legs back when it ends');
});

test('walkTo: a death escape refuses the walk outright, with the reason to relay', async () => {
  const { bot, state } = fakeBot({ settle: 'ok' });
  const lock = registerLegs(bot as unknown as object, new LegsLock());
  lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 15_000, what: 'a life-or-death escape' });
  const out = await walkTo(bot, {}, { x: 5, y: 64, z: 0 }, { maxWaitMs: 200, pollMs: 10 });
  assert.match(out, /^LEGS BUSY, did not move/);
  assert.match(out, /life-or-death escape/);
  assert.equal(state.stopped, 0, 'the escape keeps its legs untouched');
  assert.equal(lock.held()?.owner, 'dying');
});

test('walkTo: a cancelled path names the rail that took the legs', async () => {
  // Pathfinder's words, and what the model used to do with them: invent a cause
  // ("likely some background disturbance") and feed it to the supervisor.
  const { bot } = fakeBot({ settle: 'reject' });
  (bot as unknown as { pathfinder: { goto: () => Promise<void> } }).pathfinder.goto =
    () => Promise.reject(new Error('The goal was changed before it could be completed!'));
  const lock = registerLegs(bot as unknown as object, new LegsLock());
  const out = await walkTo(bot, {}, { x: 5, y: 64, z: 0 }, {
    pollMs: 10,
    // Simulate the reflex claiming DURING the walk: it outranks, so it wins.
    owner: 'journey', priority: LEGS_PRIORITY.journey,
  }).then(async (r) => r, (e) => { throw e; });
  assert.match(out, /^PATH CANCELLED/);
  // Nothing claimed the legs and nothing released them recently, so this is the
  // one case the sentence was written for (issue #30) — and it says BUG out loud.
  assert.match(out, /BUG: another rail called setGoal with NO claim/, 'an unowned setGoal is named as the bug it is');
});

test('walkTo: safety takes the legs from a walk in flight and the walk says who', async () => {
  const { bot } = fakeBot({ settle: 'never' });
  const lock = registerLegs(bot as unknown as object, new LegsLock());
  let rejectGoto: ((e: Error) => void) | undefined;
  (bot as unknown as { pathfinder: { goto: () => Promise<void> } }).pathfinder.goto =
    () => new Promise<void>((_r, rej) => { rejectGoto = rej; });
  // deadline ≤ the 2s resume floor: a walk out of budget reports the
  // cancellation IMMEDIATELY instead of resuming (resume itself is covered
  // by the auto-resume tests below).
  const walking = walkTo(bot, {}, { x: 30, y: 64, z: 0 }, { deadlineMs: 1_900, pollMs: 10 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lock.held()?.owner, 'agent', 'the walk holds the legs while it walks');
  // The flee outranks, so it is allowed in — and cancels the path, as pathfinder does.
  const escape = lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 15_000, what: 'a life-or-death escape' });
  assert.ok(escape, 'safety is never made to wait');
  rejectGoto?.(new Error('The goal was changed before it could be completed!'));
  const out = await walking;
  assert.match(out, /^PATH CANCELLED/);
  assert.match(out, /life-or-death escape \(dying\) took the legs/);
  assert.match(out, /nothing you did was wrong/);
  assert.equal(lock.held()?.owner, 'dying', 'the walk release does not steal the escape claim');
});

// ── auto-resume: a preempted walk retries itself, no model round-trip ────────
// Live report: every reflex preemption ended the tool with "re-issue this
// movement", so each creeper flee cost a full agent turn before the legs tried
// again — the bot lagged toward targets it never reached.
test('walkTo: a reflex preemption is resumed toward the same target, silently', async () => {
  const { bot, state } = fakeBot();
  let calls = 0;
  (bot as unknown as { pathfinder: { goto: () => Promise<void> } }).pathfinder.goto = () => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error('The goal was changed before it could be completed!'))
      : Promise.resolve();
  };
  const out = await walkTo(bot, {}, { x: 10, y: 64, z: 0 }, { deadlineMs: 30_000, pollMs: 10 });
  assert.equal(calls, 2, 'the walk re-pathed by itself');
  assert.match(out, /^Arrived near/, 'the model never hears about the bump');
  assert.equal(state.stopped, 0, 'no deadline fired — the resume was clean');
});

test('walkTo: bumped repeatedly = contested area, reported once with the count', async () => {
  const { bot } = fakeBot();
  let calls = 0;
  (bot as unknown as { pathfinder: { goto: () => Promise<void> } }).pathfinder.goto = () => {
    calls += 1;
    return Promise.reject(new Error('The goal was changed before it could be completed!'));
  };
  const out = await walkTo(bot, {}, { x: 10, y: 64, z: 0 }, { deadlineMs: 30_000, pollMs: 10 });
  assert.equal(calls, 3, 'two resumes, then the mind is told');
  assert.match(out, /^PATH CANCELLED/);
  assert.match(out, /resumed 2x and got cancelled again/);
  assert.match(out, /contested/, 'the sentence asks for a decision, not a blind retry');
});

test('walkTo: no budget left = no resume, the cancellation reports immediately', async () => {
  const { bot } = fakeBot();
  let calls = 0;
  (bot as unknown as { pathfinder: { goto: () => Promise<void> } }).pathfinder.goto = () => {
    calls += 1;
    return new Promise((_r, rej) => setTimeout(() => rej(new Error('The goal was changed before it could be completed!')), 30));
  };
  const out = await walkTo(bot, {}, { x: 10, y: 64, z: 0 }, { deadlineMs: 25, pollMs: 5 });
  assert.equal(calls, 1, 'a walk out of time must not borrow more via resumes');
  assert.match(out, /^(PATH CANCELLED|COULD NOT REACH)/);
});

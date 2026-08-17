/**
 * A say must be able to be reported LOST (issue #41).
 *
 * The live soak held say-1 open for 1,598s while its receipt repeated "the mind
 * is busy, not lost" every escalation — because the only liveness evidence was
 * session-wide `busy()`, which on a bot with a thinker, journeys and workers is
 * never zero. So the reassuring branch was unfalsifiable, the DROPPED branch
 * (`inFlight === 0`) was dead code in production, and nothing ever stopped
 * waiting: the ask and its slot were retained for the life of the process.
 *
 * Two things make an ask's own state knowable from inside the ledger, with no
 * help from the session:
 *  1. OVERTAKE — a say sent LATER that already answered proves the mind is not
 *     blocked by a queue, so an older open ask is lost, not waiting. (In the
 *     soak: say-2, sent six minutes after say-1, answered in 47s.)
 *  2. A DEADLINE — past it the rail says it has stopped waiting instead of
 *     reassuring forever, and forgets the record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSayLedger } from '../src/web.js';

function ledger(clock: { now: number }, extra: Record<string, unknown> = {}) {
  const said: string[] = [];
  const led = createSayLedger({
    emit: (x) => said.push(x),
    now: () => clock.now,
    watchdogMs: 90_000,
    deadlineMs: 600_000,
    // the production shape: something is ALWAYS in flight
    busy: () => 3,
    ...extra,
  });
  return { led, said, feed: () => said.join('\n') };
}

test('say ledger: a later say answering proves the older one is stuck, not queued (#41)', () => {
  const clock = { now: 0 };
  const { led, feed } = ledger(clock);
  const first = led.start('go to the chest');
  clock.now = 360_000;
  const second = led.start('what is your health?');
  clock.now = 407_000;
  led.finish(second); // answered in 47s, exactly like the soak
  clock.now = 410_000;
  led.sweep();
  assert.match(feed(), /say-1 STUCK after 410s/, 'the older ask must be named lost');
  assert.match(feed(), /say-2 was sent LATER and already answered/, 'the receipt must carry the proof');
  assert.match(feed(), /Re-send it/, 'and the advice must flip: waiting is wrong here');
  assert.doesNotMatch(feed(), /the mind is busy, not lost/, 'the false reassurance is gone');
});

test('say ledger: with no overtake it claims nothing about whose turn is running (#41)', () => {
  const clock = { now: 0 };
  const { led, feed } = ledger(clock);
  led.start('build a shelter');
  clock.now = 120_000;
  led.sweep();
  assert.match(feed(), /3 turn\(s\) in flight session-wide, none of them provably this ask/);
  assert.match(feed(), /480s left before the rail gives up on it/, 'the deadline must be visible before it is spent');
});

test('say ledger: past the deadline the rail stops waiting and forgets the ask (#41)', () => {
  const clock = { now: 0 };
  const { led, said, feed } = ledger(clock);
  led.start('mine some iron');
  clock.now = 599_000;
  led.sweep();
  assert.equal(led.pending().length, 1, 'one second before the deadline it is still an open ask');
  clock.now = 600_001;
  led.sweep();
  assert.match(feed(), /say-1 ABANDONED after 600s/);
  assert.match(feed(), /past the 600s deadline/);
  assert.match(feed(), /may still be alive inside the mind; nothing here can prove it/, 'honest about what it does not know');
  assert.deepEqual(led.pending(), [], 'the record is released, not retained for the process lifetime');
  const before = said.length;
  clock.now = 900_000;
  led.sweep();
  assert.equal(said.length, before, 'an abandoned say stops talking');
});

test('say ledger: the deadline outranks the escalation schedule (#41)', () => {
  // The old sweep only spoke when a doubling backoff said it was "due"; an ask
  // that had already warned three times could sit past any deadline in silence.
  const clock = { now: 0 };
  const { led, feed } = ledger(clock, { maxWarnings: 1 });
  led.start('follow me');
  clock.now = 95_000;
  led.sweep();
  clock.now = 700_000;
  led.sweep();
  assert.match(feed(), /ABANDONED after 700s/);
});

test('say ledger: nothing in flight is still reported as a provable drop (#33 kept)', () => {
  const clock = { now: 0 };
  const { led, feed } = ledger(clock, { busy: () => 0 });
  led.start('come back');
  clock.now = 91_000;
  led.sweep();
  assert.match(feed(), /DROPPED after 91s/);
});

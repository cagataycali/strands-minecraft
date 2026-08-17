/**
 * A journey step drains the note rail.
 *
 * soak32 is the whole argument: 44 minutes, 25 "ARMED:" facts, 24 remedies
 * naming the exact craft — and 130 swings, all with fists, 25 deaths (19.8 per
 * 100 damage episodes vs 9.7 in the armed soak24). The facts were queued for a
 * rail that only a player turn or an IDLE thinker drains, and the thinker skips
 * while `session.busy > 0`. A running journey is busy almost continuously, so
 * the news aged in place (work.notes oldestAgeMs 1,569,640 = 26 minutes) while
 * the mind chose its next step without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'journey-news-'));

const { JourneyRunner } = await import('../src/journeys.js');

/** A session that records every prompt and ends the journey after one step. */
function fakeSession(reply: string) {
  const asks: string[] = [];
  return {
    asks,
    busy: 0,
    ask: async (p: string) => { asks.push(p); return reply; },
  };
}

test('a journey step carries the senses news, and takes it only once', async () => {
  const runner = new JourneyRunner();
  const session = fakeSession('dug one block down. [JOURNEY_DONE]');
  runner.bind(session as never);
  let owed = '(system) You DIED and respawned. ARMED: nothing — bare fists do 1 damage. ' +
    'MISSING 1 more stick for a stone sword; you hold 6 planks: 2 planks craft 4 sticks.';
  runner.takeNotes = () => { const n = owed; owed = ''; return n; };

  const j = runner.start('dig down to y=45 and fight everything');
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(session.asks.length >= 1, 'the step ran');
  const first = session.asks[0]!;
  assert.match(first, /You DIED and respawned/, 'the news reached the moment the mind can act');
  assert.match(first, /MISSING 1 more stick/, 'including the remedy — inert facts were the bug');
  assert.ok(first.indexOf('You DIED') < first.indexOf('Long-term goal'),
    'news outranks the errand: it may be the reason the next step changes');
  assert.match(first, /if it changes what the next step should be, ACT on it/);
  assert.equal(j.id.length > 0, true);
});

test('a step with nothing owed reads exactly as before — no empty news block', async () => {
  const runner = new JourneyRunner();
  const session = fakeSession('placed a torch. [JOURNEY_DONE]');
  runner.bind(session as never);
  runner.takeNotes = () => '   \n  ';

  runner.start('light the tunnel');
  await new Promise((r) => setTimeout(r, 300));

  const first = session.asks[0]!;
  assert.ok(first.startsWith('[journey '), 'a wordless news block would poison the ask (#39)');
  assert.doesNotMatch(first, /News from your own senses/);
});

test('a runner with no note rail wired still runs (tests and old wiring)', async () => {
  const runner = new JourneyRunner();
  const session = fakeSession('did a thing. [JOURNEY_DONE]');
  runner.bind(session as never);
  runner.start('do a thing');
  await new Promise((r) => setTimeout(r, 300));
  assert.match(session.asks[0]!, /Long-term goal/);
});

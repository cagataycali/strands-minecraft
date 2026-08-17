/**
 * The say-receipt must report the turn's REAL outcome (issue #39).
 *
 * index.ts runs every rail through one wrapper that catches its own errors —
 * it has to, or one bad turn kills the process. That made `await onSay(...)`
 * resolve normally for a turn that died, and the live soak printed
 * `say-7 answered after 1s` for a turn killed by the empty-text 400, with no
 * `out` event in the feed at all. A green receipt for a bricked mind tells the
 * operator to stop looking — the opposite of what a receipt is for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSayLedger, sayOutcome } from '../src/web.js';

test('sayOutcome: a rail that resolves WITH an error reports failure (#39)', () => {
  assert.deepEqual(sayOutcome({ error: new Error('boom') })?.error instanceof Error, true);
  assert.match(String(sayOutcome({ ok: false })?.error), /reported failure without naming it/);
});

test('sayOutcome: success and silence stay success (#39)', () => {
  assert.equal(sayOutcome({ answer: 'on my way' }), undefined);
  assert.equal(sayOutcome(undefined), undefined);
  assert.equal(sayOutcome(null), undefined);
  assert.equal(sayOutcome('done'), undefined, 'a rail that returns prose has not failed');
  assert.equal(sayOutcome({ error: undefined }), undefined);
});

test('say ledger: a swallowed failure lands as FAILED, never as answered (#39)', () => {
  const said: string[] = [];
  const led = createSayLedger({ emit: (x) => said.push(x), now: () => 1_000 });
  const id = led.start('what are you doing?');
  // exactly what run() resolves with when session.ask threw
  led.finish(id, sayOutcome({ error: new Error('messages: text content blocks must be non-empty') }));
  const feed = said.join('\n');
  assert.match(feed, /FAILED/);
  assert.match(feed, /text content blocks must be non-empty/, 'the operator needs the cause, not just a colour');
  assert.doesNotMatch(feed, /answered/);
  assert.deepEqual(led.pending(), [], 'a failed say is closed, not left to the watchdog');
});

test('say ledger: a real answer still reads as answered (#39)', () => {
  const said: string[] = [];
  const led = createSayLedger({ emit: (x) => said.push(x), now: () => 0 });
  const id = led.start('come here');
  led.finish(id, sayOutcome({ answer: 'coming' }));
  assert.match(said.join('\n'), /answered/);
});

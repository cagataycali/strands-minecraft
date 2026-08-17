/**
 * Issue #25 — an answer must name the question it answers.
 *
 * The soak observer paired feed events positionally ("the next `out` belongs to
 * the last `in`") because that was the only option, and read a journey's furnace
 * report as the reply to its own fleet ask. The counts looked perfectly healthy —
 * 12 in, 12 out, nothing dropped — and the pairing was still wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FeedEvent } from '../src/web.js';

/** The log() contract, isolated from the HTTP server around it. */
function makeLog() {
  const events: FeedEvent[] = [];
  const log = (kind: FeedEvent['kind'], who: string, text: string, replyTo?: string) => {
    events.push({ ts: Date.now(), kind, who, text: text.slice(0, 2000), ...(replyTo ? { replyTo } : {}) });
  };
  return { log, events };
}

test('a reply names its ask; self-driven narration names nothing', () => {
  const { log, events } = makeLog();
  log('in', 'you', 'hire a worker named SoakHand', 'say_1');
  log('journey', 'jmsy41wwh #4', 'Furnace is loaded with 9 raw iron…');
  log('out', 'bot', 'Furnace is loaded with 9 raw iron…');            // a rail talking to itself
  log('out', 'bot', 'Hired SoakHand — status: 1 worker running', 'say_1');

  const outs = events.filter((e) => e.kind === 'out');
  assert.equal(outs[0].replyTo, undefined, 'narration may not impersonate a reply');
  assert.equal(outs[1].replyTo, 'say_1', 'the reply names the ask');
  assert.equal(events.find((e) => e.kind === 'in')?.replyTo, 'say_1', 'the ask carries the same id');

  // What the observer did, and what it produced:
  const positional = outs[0];
  assert.notEqual(positional.replyTo, 'say_1', 'the FIRST out was never the answer');
  // What a client can do now, regardless of what else was talking:
  const answer = outs.find((e) => e.replyTo === 'say_1');
  assert.match(answer!.text, /SoakHand/);
});

test('two asks in flight at once each get their own answer back', () => {
  const { log, events } = makeLog();
  log('in', 'you', 'what is your health?', 'say_1');
  log('in', 'player', 'come to me', 'say_2');
  log('out', 'bot', 'On my way — heading to your coordinates now', 'say_2');
  log('out', 'bot', '17 of 20 hearts', 'say_1');
  const byId = (id: string) => events.find((e) => e.kind === 'out' && e.replyTo === id)?.text;
  assert.match(byId('say_1')!, /hearts/);
  assert.match(byId('say_2')!, /On my way/);
});

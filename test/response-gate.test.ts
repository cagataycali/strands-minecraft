/**
 * #40 — never fire response.create blind.
 *
 * Every ask in the realtime rail (the 2-second briefing drain, a tool result,
 * the stall nudge) used to send `response.create` unconditionally. When the
 * model was already answering, the API replied "conversation already has an
 * active response" and the briefing was silently never spoken: the item was in
 * the conversation, nothing asked for words about it.
 *
 * These tests drive a real RealtimeCall over a fake socket and assert on the
 * FRAMES it sends — the only place the bug was ever visible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeCall, type SocketLike } from '../src/realtime/realtime.js';

function fakeSocket(sent: unknown[]): SocketLike & { deliver: (msg: unknown) => void } {
  const ws: any = {
    send: (data: string) => { sent.push(JSON.parse(data)); },
    close: () => {},
    onopen: null, onmessage: null, onclose: null, onerror: null,
    deliver: (msg: unknown) => { ws.onmessage?.({ data: JSON.stringify(msg) }); },
  };
  return ws;
}

async function liveCall(sent: unknown[]) {
  const ws = fakeSocket(sent);
  const call = new RealtimeCall({
    apiKey: 'test-key',
    stallMs: 0,
    backend: null,
    micFactory: () => null,
    speakerFactory: () => ({ write: () => {}, stop: () => {} }) as never,
    socketFactory: () => ws,
  });
  const started = call.start();
  ws.onopen?.();
  await started;
  sent.length = 0; // drop the session.update frame
  return { call, ws };
}

const creates = (sent: unknown[]) => sent.filter((f) => (f as { type?: string }).type === 'response.create').length;

test('a second ask during an active response is deferred, not fired', async () => {
  const sent: unknown[] = [];
  const { call, ws } = await liveCall(sent);

  assert.equal(call.sendUserText('(briefing from sentinel) a zombie is close'), true);
  assert.equal(creates(sent), 1, 'the first ask goes out immediately');

  ws.deliver({ type: 'response.created' });
  assert.equal(call.busy, true);

  sent.length = 0;
  call.sendUserText('(briefing from journey) reached the shaft');
  assert.equal(creates(sent), 0, 'no blind response.create while one is active');
  assert.equal(
    sent.filter((f) => (f as { type?: string }).type === 'conversation.item.create').length,
    1,
    'the briefing still reaches the conversation — only the ASK waits',
  );
  assert.equal(call.deferredResponses, 1, 'the deferral is counted, not invisible');

  ws.deliver({ type: 'response.done' });
  assert.equal(creates(sent), 1, 'the deferred ask fires at the turn boundary');
  assert.equal(call.busy, false);
  call.stop();
});

test('several briefings mid-answer collapse into ONE deferred ask', async () => {
  const sent: unknown[] = [];
  const { call, ws } = await liveCall(sent);
  ws.deliver({ type: 'response.created' });
  sent.length = 0;

  call.sendUserText('one');
  call.sendUserText('two');
  call.sendUserText('three');
  assert.equal(creates(sent), 0);
  assert.equal(call.deferredResponses, 3);

  ws.deliver({ type: 'response.done' });
  assert.equal(creates(sent), 1, 'three items, one answer — not three replies');
  call.stop();
});

test("the server's own 'active response' error is recovered, not swallowed", async () => {
  const sent: unknown[] = [];
  const errors: string[] = [];
  const ws = fakeSocket(sent);
  const call = new RealtimeCall({
    apiKey: 'test-key',
    stallMs: 0,
    backend: null,
    micFactory: () => null,
    speakerFactory: () => ({ write: () => {}, stop: () => {} }) as never,
    socketFactory: () => ws,
    onEvent: (e) => { if (e.type === 'error' && !/microphone/.test(e.error)) errors.push(e.error); },
  });
  const started = call.start();
  ws.onopen?.();
  await started;
  sent.length = 0;

  // Our flag said idle, the server disagrees: remember the ask and stay quiet.
  ws.deliver({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'active response in progress' } });
  assert.deepEqual(errors, [], 'a race we recover from is not a red line for the human');
  assert.equal(call.busy, true);

  ws.deliver({ type: 'response.done' });
  assert.equal(creates(sent), 1, 'the ask we were told to hold is fired once the floor is free');
  call.stop();
});

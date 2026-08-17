// A malformed OUTGOING packet is a dead bot, not a failed tool call. Live soak
// 2026-08-18 (issue #21): mineflayer's place_entity writes `use_item` with only
// `{ hand }`, protodef cannot size the missing `rotation: vec2f`, the serializer
// stream throws, the client goes quiet and the server kicks it —
// six serialization errors, six `disconnect.timeout`, six reconnects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  patchOutgoing, trackSequence, notchianRotation, installPacketGuard,
  classifyItemUseFault, itemUseFaultAdvice,
} from '../src/protocol.js';

test('patchOutgoing: the boat packet mineflayer sends gets what the protocol needs', () => {
  // Verbatim shape from mineflayer/lib/plugins/place_entity.js:39.
  const fix = patchOutgoing('use_item', { hand: 0 }, { yaw: Math.PI, pitch: 0, lastSequence: 41 });
  assert.deepEqual(fix.patched, ['rotation', 'sequence']);
  assert.deepEqual(fix.data.rotation, { x: 0, y: 0 }, 'yaw π = looking down Notchian 0');
  assert.equal(fix.data.sequence, 42, 'the ack counter continues, it does not restart');
  assert.equal(fix.data.hand, 0, 'and the caller\'s own fields are untouched');
});

test('patchOutgoing: a complete use_item is left exactly alone', () => {
  const good = { hand: 1, sequence: 7, rotation: { x: 12.5, y: -3.25 } };
  const fix = patchOutgoing('use_item', good, { yaw: 0, pitch: 0, lastSequence: 99 });
  assert.deepEqual(fix.patched, [], 'nothing to patch — the shim never overrides a chosen value');
  assert.deepEqual(fix.data, good);
});

test('patchOutgoing: NaN is not a rotation, and a spawning body has no yaw yet', () => {
  const nan = patchOutgoing('use_item', { hand: 0, sequence: 1, rotation: { x: NaN, y: 0 } }, { lastSequence: 0 });
  assert.deepEqual(nan.patched, ['rotation'], 'NaN serializes fine and means nothing — replace it');
  const spawning = patchOutgoing('use_item', { hand: 0 }, { lastSequence: 0 });
  assert.deepEqual(spawning.data.rotation, notchianRotation(0, 0), 'no yaw → face forward, never send NaN');
});

test('patchOutgoing: packets we did not diagnose pass through untouched', () => {
  const fix = patchOutgoing('block_dig', { status: 0, location: { x: 1, y: 2, z: 3 } }, { lastSequence: 0 });
  assert.deepEqual(fix.patched, [], 'this is a targeted patch for a known library gap, not a validator');
});

test('trackSequence: the counter follows what actually left the socket', () => {
  assert.equal(trackSequence(3, { sequence: 9 }), 9);
  assert.equal(trackSequence(9, { sequence: 4 }), 9, 'never goes backwards');
  assert.equal(trackSequence(9, { hand: 0 }), 9);
  assert.equal(trackSequence(9, undefined), 9);
});

/** A client that records what would have gone on the wire. */
function fakeBot(yaw = Math.PI) {
  const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
  const bot = {
    entity: { yaw, pitch: 0 },
    _client: { write: (name: string, data: unknown) => { sent.push({ name, data: data as Record<string, unknown> }); } },
  };
  return { bot, sent };
}

test('installPacketGuard: place_entity\'s use_item reaches the socket serializable', () => {
  const { bot, sent } = fakeBot();
  const logs: string[] = [];
  assert.equal(installPacketGuard(bot, (t) => logs.push(t)), true);
  // Something with a sequence goes first, exactly as a real session does.
  bot._client.write('block_dig', { sequence: 17 });
  bot._client.write('use_item', { hand: 0 }); // the boat
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.data, { hand: 0, rotation: { x: 0, y: 0 }, sequence: 18 });
  assert.equal(logs.length, 1, 'one line per packet shape — a kick loop is loud enough');
  assert.match(logs[0]!, /supplied rotation \+ sequence/);
  // Second boat: same shape, no second log line.
  bot._client.write('use_item', { hand: 0 });
  assert.equal(logs.length, 1);
  assert.equal((sent[2]!.data as { sequence: number }).sequence, 19, 'and the counter keeps climbing');
});

test('installPacketGuard: idempotent per connection, so a reconnect cannot double-wrap', () => {
  const { bot } = fakeBot();
  assert.equal(installPacketGuard(bot), true);
  assert.equal(installPacketGuard(bot), false);
  // A body with no socket yet is simply not guarded — never a crash.
  assert.equal(installPacketGuard({}), false);
  assert.equal(installPacketGuard(undefined), false);
});

test('classifyItemUseFault: a protocol bug is not a broken shield', () => {
  const real = new Error('Serialization error for play.toServer : SizeOf error for undefined : Cannot read properties of undefined (reading \'x\')');
  assert.equal(classifyItemUseFault(real), 'protocol');
  assert.match(itemUseFaultAdvice(real), /client\/protocol bug, not something you did wrong/);
  assert.match(itemUseFaultAdvice(real), /do not retry in a loop/);
  assert.equal(classifyItemUseFault(new Error('no item to use')), 'nothing-to-use');
  assert.equal(classifyItemUseFault(new Error('Cannot read properties of null')), 'other');
});

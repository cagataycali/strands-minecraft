import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { releaseBot } from '../src/body.js';
import type { Bot } from 'mineflayer';

/**
 * The crash this pins: `♻️ retired body released 81 chunk column(s)` and one
 * line later `TypeError: Cannot read properties of undefined (reading 'id')`
 * thrown out of an EventEmitter, process dead. A released body was still
 * receiving packets, and mineflayer resolves them against the table we emptied.
 */
const hollowBot = () => {
  const client = new EventEmitter() as EventEmitter & { socket: { destroyed: boolean; destroy: () => void } };
  let destroyed = false;
  client.socket = { get destroyed() { return destroyed; }, destroy: () => { destroyed = true; } } as never;
  const bot = new EventEmitter() as unknown as Bot & { _client: typeof client };
  (bot as unknown as { _client: unknown })._client = client;
  (bot as unknown as { entities: Record<string, unknown> }).entities = { 1: { id: 1 }, 2: { id: 2 } };
  (bot as unknown as { world: unknown }).world = { async: { columns: { 'a,b': {}, 'c,d': {} } } };
  return { bot, client };
};

test('a released body stops receiving: the transport is destroyed', () => {
  const { bot, client } = hollowBot();
  const freed = releaseBot(bot as Bot);
  assert.deepEqual(freed, { columns: 2, entities: 2 }, 'the heavy state is gone');
  assert.equal(client.socket.destroyed, true, 'and no further packet can be handled against it');
});

test('release survives a client with no socket at all', () => {
  const bot = new EventEmitter() as unknown as Bot;
  (bot as unknown as { _client: unknown })._client = new EventEmitter();
  (bot as unknown as { entities: Record<string, unknown> }).entities = {};
  assert.doesNotThrow(() => releaseBot(bot));
});

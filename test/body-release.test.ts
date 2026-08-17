import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { releaseBot as release } from '../src/body.js';

/** A body loose enough to be shaped by hand — `Bot & {…}` can't, because Bot already types world/entities/_client. */
type Corpse = EventEmitter & { world?: unknown; entities?: unknown; _client?: unknown };
const releaseBot = (b: Corpse) => release(b as unknown as Bot);

/** A corpse shaped like the real thing: async column store, entity table, a client. */
function deadBot(columns = 600, entities = 40, ended = true) {
  const client = Object.assign(new EventEmitter(), { ended });
  client.on('packet', () => {});
  const bot = new EventEmitter() as Corpse;
  bot.world = { async: { columns: Object.fromEntries(Array.from({ length: columns }, (_, i) => [`${i},0`, { sections: [{ data: new Uint32Array(1024) }] }])) } };
  bot.entities = Object.fromEntries(Array.from({ length: entities }, (_, i) => [i, { id: i }]));
  bot._client = client;
  bot.on('physicsTick', () => {});
  bot.on('chat', () => {});
  return bot;
}

test('releaseBot: a retired body gives up its whole world (issue #44)', () => {
  const bot = deadBot();
  const store = (bot.world as { async: { columns: Record<string, unknown> } }).async.columns;
  const freed = releaseBot(bot);
  assert.equal(freed.columns, 600, 'it reports what it actually released, not an intention');
  assert.equal(freed.entities, 40);
  assert.equal(Object.keys(store).length, 0, 'the SAME store object is emptied — no swapped-reference trick');
  assert.equal(Object.keys(bot.entities as object).length, 0);
  assert.equal(bot.listenerCount('physicsTick'), 0, 'listeners are the edges that kept it reachable');
  assert.equal(bot.listenerCount('chat'), 0);
  assert.equal((bot._client as EventEmitter).listenerCount('packet'), 0);
});

test('releaseBot: reads the sync column store too, and survives a stub with neither', () => {
  const bot = new EventEmitter() as Corpse;
  bot.world = { columns: { 'a': {}, 'b': {} } };
  assert.equal(releaseBot(bot).columns, 2);

  const bare = new EventEmitter() as Corpse;
  assert.deepEqual(releaseBot(bare), { columns: 0, entities: 0 }, 'a body with no world is not an error');
});

test('releaseBot: a client that throws on teardown does not take the process down', () => {
  const bot = new EventEmitter() as Corpse;
  bot._client = { ended: true, removeAllListeners: () => { throw new Error('socket already gone'); } };
  assert.doesNotThrow(() => releaseBot(bot));
});

test('releaseBot: listeners survive until the socket ENDS — keepalive must keep its cleanup', () => {
  // The regression that killed a live soak six minutes in: keepalive.js holds a
  // pending 30s timeout and clears it in `client.on('end', clearTimeout)`.
  // Strip that listener early and the timer fires into an emitter with no error
  // listener — process dead.
  const bot = deadBot(120, 5, false);
  const client = bot._client as EventEmitter & { ended: boolean };
  let timerCleared = false;
  client.on('end', () => { timerCleared = true; });

  const freed = releaseBot(bot);
  assert.equal(freed.columns, 120, 'the memory is freed immediately — that is the whole point');
  assert.ok(client.listenerCount('end') > 0, 'a live socket keeps its cleanup listeners');
  assert.ok(bot.listenerCount('chat') > 0, 'and the bot keeps its own until then');

  client.ended = true;
  client.emit('end');
  assert.equal(timerCleared, true, "the plugin's own cleanup ran because we waited for it");
  assert.equal(bot.listenerCount('chat'), 0, 'only then is everything stripped');
  assert.equal(client.listenerCount('end'), 0);
});

test('releaseBot: a late error on a stripped corpse is swallowed, not fatal', () => {
  const bot = deadBot(10, 1);
  const client = bot._client as EventEmitter;
  assert.equal(client.listenerCount('error'), 0, 'no sink of its own — an unheard error is how node kills a process');
  releaseBot(bot);
  assert.ok(client.listenerCount('error') > 0, 'releaseBot installs one');
  assert.doesNotThrow(() => client.emit('error', new Error('client timed out after 30000 milliseconds')));
  assert.doesNotThrow(() => (bot as unknown as EventEmitter).emit('error', new Error('late')));
  assert.equal(client.listenerCount('error'), 1, 'exactly one sink, never a growing pile');
  releaseBot(bot);
  assert.equal(client.listenerCount('error'), 1);
});

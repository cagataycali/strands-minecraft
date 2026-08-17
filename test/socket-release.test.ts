import test from 'node:test';
import assert from 'node:assert/strict';
import { socketIsOpen } from '../src/fleet.js';

/**
 * The #44 lesson this guards: `retire()` closes a socket through
 * `bot._client?.socket?.destroy?.()`, where EVERY link may legitimately be
 * absent — so a renamed accessor frees nothing, throws nothing, logs nothing,
 * and each survivor roots a whole prismarine world in libuv (plus a player slot
 * on the server, which is what the server_full hires were). A predecessor loop
 * already burned a soak on exactly this class of bug (bot.world vs
 * bot.world.async.columns), so the "is it really closed?" question gets a test
 * of its own rather than a comment.
 */
test('an open socket is reported open — the leak must be detectable at all', () => {
  assert.equal(socketIsOpen({ _client: { socket: { destroyed: false, readyState: 'open' } } }), true);
  // Half-closed still holds the handle: FIN sent, nothing freed.
  assert.equal(socketIsOpen({ _client: { socket: { destroyed: false, readyState: 'readOnly' } } }), true);
  assert.equal(socketIsOpen({ _client: { socket: { destroyed: false, readyState: 'writeOnly' } } }), true);
});

test('a genuinely closed socket is not reported as a leak (no crying wolf every retire)', () => {
  assert.equal(socketIsOpen({ _client: { socket: { destroyed: true } } }), false);
  assert.equal(socketIsOpen({ _client: { socket: { destroyed: false, readyState: 'closed' } } }), false);
});

test('a missing link anywhere in the chain holds nothing open, and never throws', () => {
  // These are the shapes that made the original bug silent — each must be a
  // clean "nothing to close", not an exception inside a teardown.
  assert.equal(socketIsOpen(undefined), false);
  assert.equal(socketIsOpen({}), false);
  assert.equal(socketIsOpen({ _client: {} }), false);
  assert.equal(socketIsOpen({ _client: { socket: undefined } }), false);
  // Unknown shape, socket present: assume it IS holding something. A leak
  // reported for a shape we do not recognise is a warning; a leak missed is
  // 4GB and an OOM.
  assert.equal(socketIsOpen({ _client: { socket: {} } }), true);
  assert.equal(socketIsOpen({ _client: { socket: { readyState: 3 } } } as never), true);
});

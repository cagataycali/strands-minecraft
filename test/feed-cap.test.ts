import test from 'node:test';
import assert from 'node:assert/strict';
import { capFeed } from '../src/web.js';
import { forceFullGc, nextTurn } from '../src/memcheck.js';

/**
 * Suspect 4 of issue #44: `web.feed=300` sat exactly at its cap in every probe
 * line, which is what both a working cap and a leak look like from outside.
 * `length` is the number a leak would happily satisfy, so this asserts on
 * REACHABILITY: the evicted events must actually be collectable.
 */
test('the cap frees the payloads it drops, not just the view of them', async () => {
  const feed: object[] = [];
  const refs: WeakRef<object>[] = [];
  for (let i = 0; i < 10; i++) {
    const ev = { text: `event ${i}`, blob: new Array(5_000).fill(i) };
    feed.push(ev);
    refs.push(new WeakRef(ev));
    capFeed(feed, 4);
  }

  assert.equal(feed.length, 4, 'the window holds the cap');
  assert.deepEqual((feed as { text: string }[]).map((e) => e.text),
    ['event 6', 'event 7', 'event 8', 'event 9'], 'newest kept, oldest dropped');

  await nextTurn();
  assert.equal(forceFullGc(), true);
  await nextTurn();

  const survivors = refs.filter((r) => r.deref() !== undefined).length;
  assert.equal(survivors, 4, 'exactly the six evicted events were collected');
  assert.equal(feed.length, 4); // keeps the window reachable past the reading
});

test('a feed under its cap is untouched', () => {
  const feed = [1, 2, 3];
  assert.deepEqual(capFeed(feed, 10), [1, 2, 3]);
});

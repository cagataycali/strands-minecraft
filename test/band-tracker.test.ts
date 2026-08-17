/**
 * The duplicate radar note from the live soak (mc-soak4.log):
 *
 *     👂 radar: enderman closed to 16 blocks (120, 45, 104)
 *     👂 radar: enderman closed to 16 blocks (120, 45, 104)
 *
 * Same mob, same block, twice — a threat parked at the edge of the outer band
 * crossing it on our own walking jitter, with every exit erasing its memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BandTracker } from '../src/sentinel.js';

test('boundary jitter announces ONCE, not once per poll', () => {
  const t = new BandTracker([4, 8, 16], 15_000);
  let announced = 0;
  // The enderman stands still; we walk. 1s polls, distance crossing 16 either way.
  const jitter = [15.9, 16.2, 15.8, 16.4, 15.7, 16.1, 15.9];
  jitter.forEach((d, i) => { if (t.update(7, d, i * 1_000) !== null) announced++; });
  assert.equal(announced, 1, 'a still mob at the edge is one piece of news');
});

test('absence from one poll is not proof of a despawn', () => {
  const t = new BandTracker([4, 8, 16], 15_000);
  assert.equal(t.update(7, 15, 0)?.band, 16);
  t.sweep(new Set(), 1_000);            // dropped out of hostilesNear this tick
  assert.equal(t.update(7, 15, 2_000), null, 'back in the list — still old news');
});

test('a mob that really leaves and returns later IS news again', () => {
  const t = new BandTracker([4, 8, 16], 15_000);
  assert.equal(t.update(7, 15, 0)?.band, 16);
  t.sweep(new Set(), 1_000);
  t.sweep(new Set(), 20_000);           // gone for 19s — the grace has run out
  assert.equal(t.update(7, 15, 21_000)?.band, 16, 'a genuine return re-announces');
});

test('out of range for longer than the grace re-arms too', () => {
  const t = new BandTracker([4, 8, 16], 15_000);
  assert.equal(t.update(7, 3, 0)?.band, 4);
  assert.equal(t.update(7, 40, 1_000), null, 'left range: nothing to say');
  assert.equal(t.update(7, 40, 30_000), null);
  assert.equal(t.update(7, 3, 31_000)?.band, 4, 'a fresh charge is news');
});

test('closing in announces every band, and only on the way in', () => {
  const t = new BandTracker([4, 8, 16], 15_000);
  assert.equal(t.update(9, 15, 0)?.band, 16);
  assert.equal(t.update(9, 12, 1_000), null, 'same band');
  assert.equal(t.update(9, 7, 2_000)?.band, 8);
  assert.equal(t.update(9, 3, 3_000)?.band, 4);
  assert.equal(t.update(9, 3.5, 4_000), null, 'still in the innermost band');
  assert.equal(t.update(9, 7, 5_000), null, 'retreat is silent…');
  assert.equal(t.update(9, 3, 6_000)?.band, 4, '…but the second charge is news');
});

test('entities are tracked apart', () => {
  const t = new BandTracker([4, 8, 16], 15_000);
  assert.equal(t.update(1, 15, 0)?.band, 16);
  assert.equal(t.update(2, 15, 0)?.band, 16, 'a second mob is its own news');
  t.forget(1);
  assert.equal(t.update(1, 15, 100)?.band, 16);
  assert.equal(t.update(2, 15, 100), null);
});

// ── issue #31: throttling must DELAY a note, never eat it ──────────────────
test('a swallowed approach is still owed once the floor passes', () => {
  const t = new BandTracker([4, 8, 16], 15_000, 3_000);
  assert.equal(t.update(20, 7, 0)?.band, 8, 'first sight');
  assert.equal(t.update(20, 12, 1_000), null, 'clear of the 8 band — silent');
  assert.equal(t.update(20, 7, 2_000), null, 'second approach, inside the floor');
  // The mob is STILL at 7 blocks. Going quiet about that because a timer said so
  // would be the throttle lying by omission.
  const owed = t.update(20, 6.5, 5_000);
  assert.equal(owed?.band, 8);
  assert.equal(owed?.dist, 6.5, 're-measured, not the stale distance');
  assert.equal(t.update(20, 6.5, 6_000), null, 'and then it is old news again');
});

test('a swallowed note expires when it stops being true', () => {
  const t = new BandTracker([4, 8, 16], 15_000, 3_000);
  assert.equal(t.update(21, 7, 0)?.band, 8);
  assert.equal(t.update(21, 12, 1_000), null);
  assert.equal(t.update(21, 7, 2_000), null, 'owed');
  // It left again before the floor passed: there is nothing to announce anymore.
  assert.equal(t.update(21, 13, 3_000), null);
  assert.equal(t.update(21, 13, 9_000), null, 'the stale note never fires');
});

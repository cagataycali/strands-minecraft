import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCameraSessionError, shouldRebuildCamera, FLAT_FRAME_BYTES } from '../src/tools/vision.js';

// 2026-10-04: two ways the camera died for good until a bot restart —
// (1) Chrome killed under the page: page.isClosed() stayed false, every shot
//     threw "Protocol error (Page.captureScreenshot): Session closed";
// (2) after a body reconnect the viewer kept a dead world: solid-sky 4 KB
//     frames with X-Camera: live. Both are now detected and rebuilt.

test('session errors are recognised; ordinary failures are not', () => {
  assert.ok(isCameraSessionError('Protocol error (Page.captureScreenshot): Session closed. Most likely the page has been closed.'));
  assert.ok(isCameraSessionError('Target closed'));
  assert.ok(isCameraSessionError('Navigating frame was detached'));
  assert.ok(!isCameraSessionError('net::ERR_CONNECTION_REFUSED at http://localhost:3007'));
  assert.ok(!isCameraSessionError('No Chrome/Chromium found for headless rendering.'));
});

test('flat frames rebuild after ~30 s, at most once a minute', () => {
  const now = 1_000_000;
  assert.equal(shouldRebuildCamera({ flatFrames: 89, lastRebuildAt: 0, now }), false, 'not yet');
  assert.equal(shouldRebuildCamera({ flatFrames: 90, lastRebuildAt: 0, now }), true, '90 frames ≈ 30 s at 3 fps');
  assert.equal(shouldRebuildCamera({ flatFrames: 500, lastRebuildAt: now - 30_000, now }), false, 'rebuilt 30 s ago — a bot staring at the sky must not thrash Chrome');
  assert.equal(shouldRebuildCamera({ flatFrames: 90, lastRebuildAt: now - 60_000, now }), true);
});

test('the flat threshold sits between a sky-only frame and a rendered one', () => {
  // measured: solid sky 960×540 q60 = 4 022 B; a spruce camp = 25–60 KB
  assert.ok(FLAT_FRAME_BYTES > 4_100 && FLAT_FRAME_BYTES < 15_000);
});

import { observeScene, sceneIsStale, type StaleScene } from '../src/tools/vision.js';
import { listedWorkers, DEAD_WORKER_GRACE_MS } from '../src/web/crew.js';

// 2026-10-04 (owner, phone): the size-based detector rebuilt Nova's camera for
// dark-cave frames and froze every worker stream. Staleness now = identical
// picture while the BODY moved.
test('a dark cave (small but changing/standing-still frames) is NOT stale; identical frames while moving IS', () => {
  const dark = (seed: number) => new Uint8Array(4000).map((_, i) => (i * 7 + seed) & 255);
  let s: StaleScene = { identical: 0, runStart: null, lastSig: null };
  const here = { x: 10, y: 12, z: 10 };
  for (let i = 0; i < 120; i++) s = observeScene(s, dark(i), here);           // changing frames
  assert.equal(sceneIsStale(s, here), false, 'changing frames never stale');
  s = { identical: 0, runStart: null, lastSig: null };
  const same = dark(1);
  for (let i = 0; i < 120; i++) s = observeScene(s, same, here);              // frozen, standing still
  assert.equal(sceneIsStale(s, here), false, 'standing still with a frozen picture is not proof');
  s = { identical: 0, runStart: null, lastSig: null };
  for (let i = 0; i < 120; i++) s = observeScene(s, same, { x: 10 + i * 0.1, y: 12, z: 10 }); // frozen while walking 12 blocks
  assert.equal(sceneIsStale(s, { x: 22, y: 12, z: 10 }), true, 'frozen picture + moving body = stale scene');
});

test('/api/workers lists the living and the recently dead only', () => {
  const now = 1_000_000;
  const rows = [
    { status: 'working', endedAt: undefined },
    { status: 'done', endedAt: now - 30_000 },                 // finished 30 s ago → still shown (outcome veil)
    { status: 'failed', endedAt: now - DEAD_WORKER_GRACE_MS - 1 }, // too old
    { status: 'interrupted', endedAt: undefined },              // ghost from a previous process
  ] as any[];
  const kept = listedWorkers(rows, now);
  assert.deepEqual(kept.map((w) => w.status), ['working', 'done']);
});

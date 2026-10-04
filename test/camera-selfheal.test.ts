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

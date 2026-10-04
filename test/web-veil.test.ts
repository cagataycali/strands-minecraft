import { test } from 'node:test';
import assert from 'node:assert/strict';
import { veilFor } from '../src/web/veil.js';
import { PAGE_HTML } from '../src/web/page.js';

test('unreachable dashboard beats everything', () => {
  const v = veilFor({ unreachable: true, connected: false, camera: 'broken: x' });
  assert.equal(v.tone, 'bad');
  assert.match(v.text, /unreachable/);
});

test('a kicked bot is named, not disguised as a stream hiccup', () => {
  const v = veilFor({ connected: false, camera: 'streaming to 1 watcher(s), 40 frames sent', stalled: true });
  assert.match(v.text, /not in the world/);
  assert.equal(v.tone, 'bad');
});

test('warming shows the age and the expectation', () => {
  const v = veilFor({ connected: true, camera: 'warming up (12s) — headless Chrome + viewer page' });
  assert.ok(v.show && v.spin);
  assert.match(v.text, /warming up · 12s/);
  assert.match(v.text, /~30 s/);
});

test('broken camera is reported verbatim and does not spin', () => {
  const v = veilFor({ connected: true, camera: 'broken: Navigation timeout' });
  assert.equal(v.spin, false);
  assert.match(v.text, /camera broken: Navigation timeout/);
});

test('a frozen frame counter is a stall; a healthy stream shows no veil', () => {
  assert.match(veilFor({ connected: true, camera: 'streaming to 1 watcher(s), 9 frames sent', stalled: true }).text, /stalled/);
  assert.equal(veilFor({ connected: true, camera: 'streaming to 1 watcher(s), 9 frames sent' }).show, false);
  assert.equal(veilFor({ connected: true, camera: 'idle (never started — no watcher has connected yet)' }).show, false);
});

test('no frame yet is a quiet spinner, not a stall', () => {
  const v = veilFor({ connected: true, camera: 'idle (never started — no watcher has connected yet)', noFrameYet: true });
  assert.equal(v.tone, 'quiet');
  assert.match(v.text, /connecting to the camera/);
  // but a moving counter wins over a stale noFrameYet
  assert.equal(veilFor({ connected: true, camera: 'streaming to 1 watcher(s), 3 frames sent' }).show, false);
});

test('the served page carries the same function and a connected flag', () => {
  assert.ok(PAGE_HTML.includes('function veilFor('), 'veilFor is inlined');
  assert.ok(PAGE_HTML.includes('s.connected'), 'page reads connected from /api/state');
  assert.ok(!PAGE_HTML.includes('>reconnecting…<'), 'the one-sentence veil is gone');
});

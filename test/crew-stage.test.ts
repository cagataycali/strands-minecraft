/**
 * 👷🎬 Crew cards are BODIES on the dashboard (CREW.md lane B): a live
 * thumbnail, a per-worker STOP and tap-to-swap the stage. The pure helpers are
 * what the page inlines; the page test proves they are wired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageModel, workerStageState, thumbPlan } from '../src/web/hud.js';
import { PAGE_HTML as page } from '../src/web/page.js';

test('stageModel: the bot by default; a worker swaps the stream AND the STOP route together', () => {
  assert.deepEqual(stageModel(null, 'StrandsBot'), {
    src: '/stream.mjpeg', stopPath: '/api/stop', label: 'StrandsBot', worker: false,
    stopAria: 'Stop the bot: halt movement, digging and the journey',
  });
  assert.deepEqual(stageModel({ id: null }, 'Nova').label, 'Nova');
  const w = stageModel({ id: 'w-2', name: 'Chopper' }, 'StrandsBot');
  assert.equal(w.src, '/api/workers/w-2/stream.mjpeg');
  assert.equal(w.stopPath, '/api/workers/w-2/stop');
  assert.equal(w.label, 'Chopper (worker)');
  assert.equal(w.worker, true);
  assert.match(w.stopAria, /Stop Chopper/);
  assert.equal(stageModel({ id: 'w-3' }, 'x').label, 'w-3 (worker)', 'no name yet → the id');
});

test('workerStageState: a row stands in for /api/state; no row = gone; a dead row reads offline', () => {
  assert.deepEqual(workerStageState(undefined), { gone: true, connected: false, camera: '', frames: 0 });
  assert.deepEqual(workerStageState({ alive: true, camera: { why: 'warming up (3s) — viewer page', frames: 0 } }), { gone: false, connected: true, camera: 'warming up (3s) — viewer page', frames: 0 });
  assert.deepEqual(workerStageState({ alive: false, camera: { why: 'worker has left the world — no camera', frames: 40 } }), { gone: false, connected: false, camera: 'worker has left the world — no camera', frames: 40 });
  assert.equal(workerStageState({}).connected, true, 'alive unknown is not offline');
});

test('thumbPlan: live worker cards only, and nothing while the tab is hidden', () => {
  const cards = [
    { id: 'w-1', kind: 'worker' },
    { id: 'w-2', kind: 'worker', terminal: true },
    { id: null, kind: 'worker' },
    { id: 'j1', kind: 'journey' },
  ];
  assert.deepEqual(thumbPlan(cards, true), ['w-1']);
  assert.deepEqual(thumbPlan(cards, false), []);
});

test('the page wires the crew bodies: thumbnails, per-card STOP, tap-to-swap, back-to-bot', () => {
  assert.match(page, /\/camera\/snapshot\?t=/, 'thumbnails come from the worker snapshot route');
  assert.match(page, /\/api\/workers\/' \+ encodeURIComponent\(c\.id\) \+ '\/stop'/, 'per-card STOP hits the worker stop route');
  assert.match(page, /function swapStage/, 'tap swaps the stage');
  assert.match(page, /id="stageback"/, 'a way back to the bot');
  assert.match(page, /stageModel\(stage, ''\)\.stopPath/, 'the stage STOP aims at whatever is on stage');
  assert.match(page, /setInterval\(refreshThumbs, 1000\)/, '1 fps thumbnails');
  assert.match(page, /thumbPlan\(\[\.\.\.crew\.values\(\)\], document\.visibilityState === 'visible'\)/, 'hidden tab → no screenshots');
  assert.match(page, /ev\.workerId/, 'SSE worker events are keyed by id');
  assert.match(page, /w\.status, w\.task, w\.id\)/, '/api/state seeds the id');
});

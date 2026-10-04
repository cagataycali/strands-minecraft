import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopReceipt } from '../src/web/hud.js';
import { PAGE_HTML as page } from '../src/web/page.js';
import { stageModel } from '../src/web/hud.js';

test('stop receipt names what was halted and what it cannot halt', () => {
  assert.match(stopReceipt({ ok: true, stopped: ['pathfinder', 'controls', 'journey'] }), /stopped pathfinder, controls, journey/);
  assert.match(stopReceipt({ ok: true, stopped: ['pathfinder'] }), /mid-thought finishes its step/);
  assert.match(stopReceipt({ ok: true, stopped: [] }), /nothing was moving/);
  assert.equal(stopReceipt({ ok: false, error: '401' }), 'stop failed: 401');
  assert.equal(stopReceipt(null), 'stop failed');
});

test('the page has a reflex STOP on the stage that posts /api/stop, not a model-turn chip', () => {
  assert.match(page, /<button id="stopBtn"[^>]*aria-label="Stop/);
  // The stage STOP aims at whatever is on stage: the bot's /api/stop by default,
  // a worker's /api/workers/:id/stop once a crew card was tapped (CREW.md).
  assert.ok(page.includes("post(stageModel(stage, '').stopPath)"), 'STOP hits the body-level route of the staged body');
  assert.equal(stageModel(null, 'StrandsBot').stopPath, '/api/stop', 'the default stage is the bot');
  assert.ok(page.includes('e.stopPropagation()'), 'STOP never toggles fullscreen');
  const chips = page.match(/const CHIPS = \[([^\]]*)\]/)?.[1] ?? '';
  assert.ok(!/'stop'/.test(chips), 'no "stop" chip that buys a model turn');
  // the HUD is pointer-events:none so taps fall through to the stage — the
  // button must opt back in or it is unclickable
  assert.match(page, /#stopBtn\s*\{[^}]*pointer-events:auto/);
  assert.match(page, /#stopBtn\s*\{[^}]*height:44px/, '44px thumb target');
});

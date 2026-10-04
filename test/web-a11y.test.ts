import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemTone } from '../src/web/hud.js';
import { PAGE_HTML as page } from '../src/web/page.js';

test('system rows are quiet unless they carry an alarm word', () => {
  assert.equal(systemTone('watching 29 collections (heap cap 4144MB…)'), 'quiet');
  assert.equal(systemTone('camera ready in 8.3s after 9 placeholder frame(s)'), 'quiet');
  assert.equal(systemTone('STOP from tiny: pathfinder, controls'), 'alert');
  assert.equal(systemTone('⛔ kicked: duplicate_login'), 'alert');
  assert.equal(systemTone('say failed: throttled'), 'alert');
  assert.equal(systemTone(''), 'quiet');
});

test('landmarks and names: main, h1, log feed with keyboard access, labelled controls', () => {
  assert.match(page, /<main id="side">/);
  assert.match(page, /<h1 class="sr">/);
  assert.match(page, /<div id="feed" role="log"[^>]*tabindex="0"/);
  assert.match(page, /<button id="callBtn"[^>]*aria-label="voice call"/);
  assert.match(page, /<input id="msg"[^>]*aria-label=/);
  assert.ok(page.includes("b.setAttribute('aria-pressed'"), 'filter pills expose pressed state');
  assert.match(page, /<div id="stage" role="region" aria-label=/);
});

test('no text is painted in the 3.6:1 grey that failed axe', () => {
  // #66707c on #0b0e14 is 3.6:1 — below AA for small text. Borders may keep it.
  const styles = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
  const uses = styles.split('\n').filter((l) => /color:#66707c/.test(l));
  assert.deepEqual(uses, [], 'no color:#66707c text left: ' + uses.join(' | '));
});

test('every horizontal scroller is keyboard reachable (axe scrollable-region-focusable)', () => {
  for (const id of ['vchips', 'crew', 'filters', 'chips']) assert.match(page, new RegExp(`<div id="${id}"[^>]*tabindex="0"`), id);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayText, systemTone } from '../src/web/hud.js';
import { PAGE_HTML as page } from '../src/web/page.js';

test('web-dashboard input echo loses its rail prefix', () => {
  assert.equal(displayText({ kind: 'in', who: 'you', text: '(from CagatayCali via the web dashboard) status?' }, true), 'status?');
});

test('a game-chat echo is dropped while the chat row is shown, named when it is not', () => {
  const ev = { kind: 'in', who: 'player', text: 'StrandsBot says in game chat: "Still night — holding in bed"' };
  assert.equal(displayText(ev, true), null);
  assert.equal(displayText(ev, false), 'StrandsBot: Still night — holding in bed');
});

test('everything else is verbatim', () => {
  assert.equal(displayText({ kind: 'out', text: '(from X via the web dashboard) not an in' }, true), '(from X via the web dashboard) not an in');
  assert.equal(displayText({ kind: 'in', who: 'you', text: 'plain' }, true), 'plain');
});

test('say receipts that mean trouble are alerts', () => {
  assert.equal(systemTone('s_12 STUCK after 40s — re-send it'), 'alert');
  assert.equal(systemTone('s_12 DROPPED after 60s'), 'alert');
  assert.equal(systemTone('s_12 answered 3.1s'), 'quiet');
});

test('the composer echoes optimistically and the server in-event settles it', () => {
  assert.ok(page.includes("pending: true"), 'local pending bubble');
  assert.ok(page.includes("if (ev.kind === 'in' && ev.replyTo) settlePending(ev.replyTo);"), 'SSE in settles by say id');
  assert.ok(page.includes('function displayText('));
});

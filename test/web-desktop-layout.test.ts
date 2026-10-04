import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_HTML as page } from '../src/web/page.js';

// Regression: the page was phone-only. At 1440×900 the 16:9 #stage measured
// 1440×810 and the feed got the remaining 20px; filter pills were 8px tall.
// Desktop is a two-column grid — stage left, the conversation right.

const desktop = page.match(/@media \(min-width: 900px\)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? '';

test('desktop breakpoint turns body into a two-column grid', () => {
  assert.ok(desktop, 'a ≥900px media query exists');
  assert.match(desktop, /body\s*\{[^}]*display:grid/);
  assert.match(desktop, /grid-template-columns:minmax\(0,1fr\) clamp\(/, 'stage column flexes, side column is phone-width');
  assert.match(desktop, /#video\s*\{[^}]*object-fit:contain/, 'the world is letterboxed, never cropped');
});

test('the conversation column wraps feed, filters, chips and the composer', () => {
  const side = page.match(/<div id="side">([\s\S]*?)<\/div>\n<div id="toast">/)?.[1] ?? '';
  for (const id of ['crew', 'filters', 'feed', 'jump', 'chips', 'composer']) {
    assert.ok(side.includes(`id="${id}"`), `#side contains #${id}`);
  }
  // On the phone the wrapper must not change layout: body's flex children stay
  // its flex children.
  assert.match(page, /#side\s*\{\s*display:contents;\s*\}/);
  assert.match(desktop, /#side\s*\{[^}]*display:flex;\s*flex-direction:column/);
});

/**
 * The four false "tool broke" alarms from the live soak (issue #23): diamond
 * pickaxe, wooden sword, iron pickaxe, stone sword — all still in the bag when
 * the bot was asked seconds later.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeToolBreak, toolIsAnywhere } from '../src/sentinel.js';

const healthy = { name: 'diamond_pickaxe', durabilityUsed: 12, maxDurability: 1561 };

test('a tool still in the bag after settling did not break — it moved', () => {
  const v = judgeToolBreak({ prev: healthy, next: 'wooden_sword', present: true });
  assert.equal(v.broke, false);
  assert.match(v.why, /equip moves an item through the cursor/);
});

test('durability is an alibi: 1549 uses left cannot be a break, whatever the inventory says', () => {
  // The exact soak case — the view was transient, the item was mid-cursor.
  const v = judgeToolBreak({ prev: healthy, next: 'wooden_sword', present: false, sinceWired: 600_000 });
  assert.equal(v.broke, false);
  assert.match(v.why, /had 1549 uses left/);
  assert.match(v.why, /a move, not a break/);
});

test('a genuine break: gone, and it was on its last use', () => {
  const v = judgeToolBreak({
    prev: { name: 'wooden_pickaxe', durabilityUsed: 59, maxDurability: 59 },
    next: undefined, present: false, sinceWired: 600_000,
  });
  assert.equal(v.broke, true);
  assert.match(v.why, /last use \(0 left\)/);
});

test('one use left counts as about-to-break — the break IS the last use', () => {
  const v = judgeToolBreak({
    prev: { name: 'stone_axe', durabilityUsed: 130, maxDurability: 131 },
    next: undefined, present: false, sinceWired: 600_000,
  });
  assert.equal(v.broke, true);
});

test('no durability data: the settled absence alone is allowed to speak', () => {
  const v = judgeToolBreak({ prev: { name: 'shears' }, next: undefined, present: false, sinceWired: 600_000 });
  assert.equal(v.broke, true);
  assert.match(v.why, /durability unknown/);
});

test('a fresh (re)connect is not evidence: the inventory is still arriving', () => {
  const v = judgeToolBreak({ prev: { name: 'shears' }, next: undefined, present: false, sinceWired: 900 });
  assert.equal(v.broke, false);
  assert.match(v.why, /still arriving after a \(re\)connect/);
});

test('non-tools and same-item events are never breaks', () => {
  assert.equal(judgeToolBreak({ prev: { name: 'cobblestone' }, present: false, sinceWired: 1e6 }).broke, false);
  assert.equal(judgeToolBreak({ prev: healthy, next: 'diamond_pickaxe', present: false }).broke, false);
  assert.equal(judgeToolBreak({ present: false }).broke, false, 'nothing was held');
});

test('toolIsAnywhere looks in every place a swapped item hides', () => {
  assert.equal(toolIsAnywhere('iron_pickaxe', { items: [{ name: 'dirt' }] }), false);
  assert.equal(toolIsAnywhere('iron_pickaxe', { items: [{ name: 'iron_pickaxe' }] }), true);
  // The cursor lives in the raw slot array, which items() does not report.
  assert.equal(toolIsAnywhere('iron_pickaxe', { items: [], slots: [null, { name: 'iron_pickaxe' }] }), true);
  // Mid-deposit, the item is in the open chest's slot list.
  assert.equal(toolIsAnywhere('iron_pickaxe', { items: [], windowSlots: [{ name: 'iron_pickaxe' }] }), true);
  assert.equal(toolIsAnywhere('iron_pickaxe', {}), false, 'no view at all is not presence');
});

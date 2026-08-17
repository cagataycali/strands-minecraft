/**
 * countCarried — one truthful count of what the bot is carrying.
 *
 * Two live-soak lies motivate it: phantom '-23 torch / +23 torch' Δ swings from an
 * offhand stack items() cannot see, and the cursor hole behind issue #23's four
 * false tool breaks — an item in flight during an equip reads as an item lost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { countCarried, CARRIED_EXTRA_SLOTS } from '../src/tools/helpers.js';

test('stacks of the same item add up across every place it can sit', () => {
  const inv = countCarried({
    items: [{ name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 12 }, { name: 'stick', count: 3 }],
    extraSlots: [{ name: 'torch', count: 23 }, null, undefined],
    cursor: { name: 'cobblestone', count: 5 },
  });
  assert.deepEqual(inv, { cobblestone: 81, stick: 3, torch: 23 });
});

test('the cursor counts: an item in flight is carried, not lost', () => {
  // The exact shape of the moment bot.equip() is mid-click.
  const mid = countCarried({ items: [{ name: 'dirt', count: 1 }], cursor: { name: 'diamond_pickaxe', count: 1 } });
  const after = countCarried({ items: [{ name: 'dirt', count: 1 }, { name: 'diamond_pickaxe', count: 1 }] });
  assert.deepEqual(mid, after, 'a swap must produce NO delta at all');
});

test('offhand and armor are counted — items() cannot see them', () => {
  assert.deepEqual(CARRIED_EXTRA_SLOTS, [45, 5, 6, 7, 8], 'offhand, then the four armor slots');
  const inv = countCarried({ items: [], extraSlots: [{ name: 'shield', count: 1 }, { name: 'iron_helmet', count: 1 }] });
  assert.deepEqual(inv, { shield: 1, iron_helmet: 1 });
});

test('an empty bot carries nothing, and no view at all does not throw', () => {
  assert.deepEqual(countCarried({}), {});
  assert.deepEqual(countCarried({ items: [], extraSlots: [null], cursor: null }), {});
});

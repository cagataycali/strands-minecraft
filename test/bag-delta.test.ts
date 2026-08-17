/**
 * An action tool must report what the BAG says, not what the action intended.
 * Live journal 2026-08-17: 'Mined 2 iron ore from the first vein at (47,61,68)'
 * with [Δ +4 dirt] and no iron anywhere — dig_vein had said 'Walked over 2
 * drop(s)', and walking over a drop is not holding it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bagCounts, bagDelta } from '../src/tools/helpers.js';

const bag = (items: Array<[string, number]>) =>
  bagCounts({ inventory: { items: () => items.map(([name, count]) => ({ name, count })) } } as never);

test('bagCounts: stacks of the same item are summed', () => {
  const m = bag([['raw_iron', 3], ['dirt', 64], ['raw_iron', 2]]);
  assert.equal(m.get('raw_iron'), 5, 'two partial stacks are one holding');
  assert.equal(m.get('dirt'), 64);
});

test('bagCounts: a body with no inventory yet is empty, not a crash', () => {
  assert.equal(bagCounts({} as never).size, 0);
});

test('bagDelta: the mining line that started this', () => {
  const before = bag([['dirt', 4], ['stick', 3]]);
  const after = bag([['dirt', 8], ['stick', 2]]);
  assert.equal(bagDelta(before, after), '+4 dirt, -1 stick', 'biggest movement first, signs explicit');
});

test('bagDelta: an unpicked drop reads as nothing — the whole point', () => {
  const same = bag([['dirt', 4]]);
  assert.equal(bagDelta(same, bag([['dirt', 4]])), 'nothing');
});

test('bagDelta: new and vanished items both show', () => {
  assert.equal(bagDelta(bag([['wooden_pickaxe', 1]]), bag([['raw_iron', 2]])), '+2 raw_iron, -1 wooden_pickaxe');
});

test('bagDelta: a big haul is truncated, not dumped', () => {
  const after = bag([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5], ['f', 6], ['g', 7], ['h', 8]]);
  const out = bagDelta(bag([]), after, 3);
  assert.equal(out, '+8 h, +7 g, +6 f, …+5 more');
});

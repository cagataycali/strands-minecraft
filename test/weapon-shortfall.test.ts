import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meleeShortfall, armedFact, craftableMelee } from '../src/tools/helpers.js';

/**
 * SOAK29, the session this test exists for: 33 bare-fisted swings, 4 deaths,
 * and the mind's own words twelve times over — "bare-fisted (no sword/axe
 * available, no logs nearby to craft one)". The armed fact FIRED. It simply had
 * nothing to say about the remedy, because `craftableMelee` answers only "can I
 * pay in full right now?" and returns undefined otherwise.
 *
 * So every test below models the case the four previous fixes skipped: the bag
 * that CANNOT pay. An absent remedy must still be a stated arithmetic gap.
 */

test('shortfall — one stick short of a stone sword is news, not silence', () => {
  const counts = { cobblestone: 30 };
  // The old rail's verdict on this bag: nothing at all.
  assert.equal(craftableMelee(counts), undefined);
  const gap = meleeShortfall(counts);
  assert.ok(gap, 'a bag holding 30 cobblestone is one stick from a weapon');
  assert.equal(gap.item, 'stone_sword');
  assert.match(gap.missing, /1 more stick/);
  assert.match(gap.line, /costs 2 cobblestone \+ 1 stick/);
  assert.match(gap.line, /you hold 30 cobblestone and 0 stick/);
  // The handle's supply chain, because "no logs nearby" was the wrong conclusion
  // to reach while holding the stone half of the recipe.
  assert.match(gap.line, /handle has to come from a tree/);
});

test('shortfall — a bag with logs is told the log→plank→stick chain', () => {
  const gap = meleeShortfall({ cobblestone: 4, oak_log: 3 });
  assert.ok(gap);
  assert.match(gap.line, /3 log\(s\)/);
  assert.match(gap.line, /1 log crafts 4 planks, 2 planks craft 4 sticks/);
});

test('shortfall — planks are named as the nearer stick source', () => {
  const gap = meleeShortfall({ cobblestone: 8, birch_planks: 6 });
  assert.ok(gap);
  assert.match(gap.line, /6 planks: 2 planks craft 4 sticks/);
});

test('shortfall — a tie in units is broken by the CHEAPEST tier, never the best weapon', () => {
  // Two sticks, no material: wooden/stone/iron/diamond swords all miss exactly
  // 2 items. "2 more diamonds" and "2 more planks" are not the same errand, and
  // a bill the bot cannot plausibly settle is as useless as silence — which is
  // exactly the trap the first version of this rail fell into.
  const gap = meleeShortfall({ stick: 2 });
  assert.ok(gap);
  assert.equal(gap.item, 'wooden_sword');
  assert.doesNotMatch(gap.item, /diamond|iron/);
  assert.match(gap.line, /costs 2 planks \+ 1 stick/);
});

test('shortfall — a payable bag belongs to craftableMelee, not here', () => {
  const counts = { cobblestone: 4, stick: 2 };
  assert.ok(craftableMelee(counts), 'this bag can pay in full');
  const gap = meleeShortfall(counts);
  // Whatever it names must be a genuinely unpayable upgrade, never the sword
  // the bag can already make.
  if (gap) assert.notEqual(gap.item, 'stone_sword');
});

test('shortfall — an empty bag still gets the cheapest bill, not a shrug', () => {
  const gap = meleeShortfall({});
  assert.ok(gap, 'an empty bag is the exact case that went unreported all session');
  assert.match(gap.line, /MISSING/);
  assert.match(gap.line, /No stick, plank or log in the bag/);
  assert.equal(gap.item, 'wooden_sword', 'the cheapest real weapon, not the strongest');
});

test('armedFact — the unarmed fact carries the shortfall when nothing is payable', () => {
  const fact = armedFact({ held: undefined, inventory: ['cobblestone'], counts: { cobblestone: 30 } });
  assert.equal(fact.armed, false);
  assert.equal(fact.nearest, 'stone_sword');
  assert.match(fact.line, /NO sword, axe or trident anywhere/);
  assert.match(fact.line, /NEAREST WEAPON: a stone_sword/);
  assert.match(fact.line, /MISSING 1 more stick/);
});

test('armedFact — a bot that OWNS a weapon gets no shopping list', () => {
  const fact = armedFact({ held: undefined, inventory: ['iron_sword'], counts: { iron_sword: 1, cobblestone: 30 } });
  assert.equal(fact.armed, false, 'a weapon in the bag but not in the hand is still unarmed');
  assert.equal(fact.nearest, undefined, 'the remedy is to draw the sword, not to shop');
  assert.doesNotMatch(fact.line, /NEAREST WEAPON/);
  assert.match(fact.line, /IS in your inventory but is not in your hand/);
});

test('armedFact — the craftable remedy still wins over the shortfall', () => {
  const fact = armedFact({ held: undefined, inventory: ['cobblestone', 'stick'], counts: { cobblestone: 4, stick: 2 } });
  assert.match(fact.line, /CRAFTABLE: a stone_sword/);
  assert.doesNotMatch(fact.line, /NEAREST WEAPON/, 'do not bill a bag that can already pay');
});

test('armedFact — no counts means no invented arithmetic', () => {
  const fact = armedFact({ held: undefined, inventory: [] });
  assert.doesNotMatch(fact.line, /NEAREST WEAPON/);
  assert.equal(fact.nearest, undefined);
});

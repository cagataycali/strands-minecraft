import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bestMeleeWeapon, meleeScore, isMeleeWeapon, meleeKind, chargeMultiplier, handNow,
} from '../src/tools/helpers.js';

/**
 * THE DIRT BUG: a soak line read `swung 1x at the phantom 3.9m away with dirt`.
 * Weapon choice must be a SCORE over real melee damage — never "whatever is in
 * slot 0", never a block, and a fist when the bag holds nothing better.
 */
test('weapon choice — a block or a torch is not a weapon and does not beat a fist', () => {
  assert.equal(meleeKind('dirt'), undefined);
  assert.equal(meleeKind('torch'), undefined);
  assert.equal(isMeleeWeapon('dirt'), false);
  assert.equal(meleeScore('dirt'), meleeScore(undefined));
  assert.equal(bestMeleeWeapon(['dirt', 'torch', 'bread', 'oak_planks']), undefined);
});

test('weapon choice — picks the one real weapon out of a mixed bag', () => {
  assert.equal(bestMeleeWeapon(['dirt', 'wooden_sword', 'torch']), 'wooden_sword');
  assert.equal(isMeleeWeapon('wooden_sword'), true);
});

test('weapon choice — between two weapons it takes the higher EXPECTED damage on the cadence', () => {
  // iron_axe: 9 damage but 0.9 attacks/s → 43% charge at 600ms = 3.9
  // wooden_sword: 4 damage at 1.6 attacks/s → 94% charge = 3.75
  assert.equal(bestMeleeWeapon(['iron_axe', 'wooden_sword']), 'iron_axe');
  // ...and at a full-charge cadence the axe's raw damage wins outright.
  assert.equal(bestMeleeWeapon(['iron_axe', 'wooden_sword'], 2000), 'iron_axe');
  // The same rule sends the iron SWORD out ahead of the iron axe at 600ms,
  // because a 1111ms cooldown cannot be paid on a 600ms loop.
  assert.equal(bestMeleeWeapon(['iron_axe', 'iron_sword']), 'iron_sword');
  assert.equal(bestMeleeWeapon(['iron_axe', 'iron_sword'], 2000), 'iron_axe');
});

test('weapon choice — ranks tiers and families the way the game does', () => {
  assert.equal(bestMeleeWeapon(['stone_sword', 'diamond_sword']), 'diamond_sword');
  assert.equal(bestMeleeWeapon(['netherite_sword', 'diamond_sword']), 'netherite_sword');
  assert.equal(bestMeleeWeapon(['wooden_pickaxe', 'stone_shovel']), 'stone_shovel');
  // trident: 9 damage but a 909ms cooldown → 4.93 expected at 600ms, under the
  // iron sword's 5.62. Give it the charge time it needs and it wins.
  assert.equal(bestMeleeWeapon(['trident', 'iron_sword']), 'iron_sword');
  assert.equal(bestMeleeWeapon(['trident', 'iron_sword'], 2000), 'trident');
  assert.equal(bestMeleeWeapon(['mace']), 'mace');
});

test('weapon choice — a hoe does a fist\'s damage, so it is never worth drawing', () => {
  assert.equal(bestMeleeWeapon(['iron_hoe']), undefined);
  assert.equal(isMeleeWeapon('iron_hoe'), false);
});

test('weapon choice — a shovel or pickaxe IS better than a fist (the digging bot is not helpless)', () => {
  assert.equal(bestMeleeWeapon(['iron_shovel']), 'iron_shovel');
  assert.equal(bestMeleeWeapon(['stone_pickaxe']), 'stone_pickaxe');
});

test('weapon choice — unknown names resolve by structure, not by an enum', () => {
  assert.deepEqual(meleeKind('netherite_axe'), { family: 'axe', tier: 4 });
  assert.equal(meleeKind('copper_sword'), undefined); // no such tier in the game
  assert.equal(bestMeleeWeapon(['some_gibberish_item']), undefined);
});

test('weapon choice — charge is the game\'s curve: early swings land a fraction', () => {
  assert.equal(chargeMultiplier(2000, 1.6), 1);
  assert.ok(Math.abs((chargeMultiplier(0, 1.6)) - (0.2)) < 0.01);
  assert.ok(Math.abs((chargeMultiplier(625, 1.6)) - (1)) < 0.01);
});

test('weapon choice — names the hand honestly for a narration', () => {
  assert.equal(handNow({ heldItem: null }), 'fists');
  assert.equal(handNow({ heldItem: { name: 'diamond_sword' } }), 'diamond_sword');
  assert.equal(handNow({ heldItem: { name: 'dirt' } }),
    'dirt (NOT a weapon — 1 damage, same as a bare fist)');
});

/**
 * A tool is worth DRAWING and is still not a WEAPON. Score decides the hand
 * (an iron pickaxe's 4 damage beats a fist's 1); #46's armed fact decides the
 * sentence, and must not let the mind believe it is equipped while it mines.
 */
test('weapon choice — a repurposed tool arms the hand but never the sentence', async () => {
  const { bestMeleeWeapon, isMeleeWeapon, isProperWeapon, bestProperWeapon, armedFact } =
    await import('../src/tools/helpers.js');
  assert.equal(bestMeleeWeapon(['iron_pickaxe']), 'iron_pickaxe', 'draw it: 4 damage > 1');
  assert.equal(isMeleeWeapon('iron_pickaxe'), true);
  assert.equal(isProperWeapon('iron_pickaxe'), false);
  assert.equal(isProperWeapon('wooden_sword'), true);
  assert.equal(isProperWeapon('trident'), true);
  assert.equal(isProperWeapon('dirt'), false);
  assert.equal(bestProperWeapon(['iron_pickaxe', 'iron_shovel']), undefined);
  assert.equal(bestProperWeapon(['iron_pickaxe', 'stone_sword']), 'stone_sword');

  const f = armedFact({ held: 'iron_pickaxe', inventory: ['iron_pickaxe'] });
  assert.equal(f.armed, false);
  assert.match(f.line, /NO sword, axe or trident/);
});

/**
 * ISSUE #45 — the gate did not leak, the SENTENCE did (and the gate leaked in a
 * second, subtler way). A 93-minute soak logged `swung 2x at the phantom 4.0m
 * away`, which is beyond the server's 3.0m attack range, so the packets were
 * dropped — yet the numbers said the fight was working.
 */
test('#45 swing gate — three verdicts, and nothing swings past the server range', async () => {
  const { swingVerdict } = await import('../src/tools/helpers.js');
  const reach = { swingReach: 3.0, answerReach: 4 };
  assert.equal(swingVerdict(0.9, reach), 'swing');
  assert.equal(swingVerdict(3.0, reach), 'swing', 'exactly at reach is inside it');
  assert.equal(swingVerdict(3.1, reach), 'hold');
  assert.equal(swingVerdict(3.9, reach), 'hold', 'the 3.9m soak swings were never legal');
  assert.equal(swingVerdict(4.1, reach), 'break');
  assert.equal(swingVerdict(Infinity, reach), 'break', 'an entity with no position ends the burst');
  assert.equal(swingVerdict(NaN, reach), 'break');
});

test('#45 narration — reports the range swings were thrown from, not the first sighting', async () => {
  const { swingRange } = await import('../src/tools/helpers.js');
  assert.equal(swingRange([]), '', 'no swings, no swing distance to claim');
  assert.equal(swingRange([2.56]), '2.6m');
  assert.equal(swingRange([2.9, 1.2, 2.4]), '1.2-2.9m');
  assert.equal(swingRange([2.04, 2.03]), '2.0m', 'one number when they round the same');
});

/**
 * ISSUE #47 — the bot fought a 93-minute night bare-handed while carrying
 * 13 iron_ingot and sticks, at a crafting table it had built itself, having
 * already spent iron on a helmet. The armed fact stated the problem dozens of
 * times and never once its remedy.
 */
test('#47 craftable remedy — prices weapons from the family/tier model, best payable wins', async () => {
  const { craftableMelee } = await import('../src/tools/helpers.js');
  // the soak25 bag, verbatim in kind
  const soak = craftableMelee({ iron_ingot: 13, stick: 13, iron_pickaxe: 1, coal: 21 });
  assert.equal(soak?.item, 'iron_sword');
  assert.match(soak!.cost, /2 iron_ingot \+ 1 stick \(you hold 13 and 13\)/);

  // no sticks, no recipe — the fact must not promise what the bag cannot pay
  assert.equal(craftableMelee({ iron_ingot: 64 }), undefined);
  assert.equal(craftableMelee({ stick: 64 }), undefined);
  // any species of plank pays the wooden tier, and stacks of different species add up
  assert.equal(craftableMelee({ birch_planks: 1, spruce_planks: 1, stick: 1 })?.item, 'wooden_sword');
  // stone is cobblestone-family; a sword needs 2
  assert.equal(craftableMelee({ cobblestone: 1, stick: 4 }), undefined);
  assert.equal(craftableMelee({ cobbled_deepslate: 2, stick: 4 })?.item, 'stone_sword');
  // netherite is a smithing upgrade, never a crafting-table promise
  assert.equal(craftableMelee({ netherite_ingot: 9, stick: 9 }), undefined);
  // at a slow enough cadence the axe's raw damage is payable and it wins
  assert.equal(craftableMelee({ iron_ingot: 13, stick: 13 }, 2000)?.item, 'iron_axe');
});

test('#47 the armed fact carries the remedy — and stays quiet when it is not one', async () => {
  const { armedFact, readArmed } = await import('../src/tools/helpers.js');
  const bare = armedFact({ inventory: ['iron_pickaxe', 'coal'], counts: { iron_ingot: 13, stick: 13 } });
  assert.equal(bare.armed, false);
  assert.equal(bare.craftable, 'iron_sword');
  assert.match(bare.line, /CRAFTABLE: a iron_sword \(2 iron_ingot \+ 1 stick \(you hold 13 and 13\)\) at any crafting table\./);

  // Already holding better than the bag can craft: no advice, no noise.
  const armed = armedFact({ held: 'diamond_sword', inventory: ['diamond_sword'], counts: { iron_ingot: 64, stick: 64 } });
  assert.equal(armed.craftable, undefined);
  assert.doesNotMatch(armed.line, /CRAFTABLE/);

  // No counts at all (a caller that only has names) — silence, never a guess.
  assert.doesNotMatch(armedFact({ inventory: ['iron_ingot', 'stick'] }).line, /CRAFTABLE/);

  // Off a live body, amounts come from the STACKS, not the number of stacks.
  const f = readArmed({
    heldItem: null,
    inventory: {
      items: () => [{ name: 'iron_ingot', count: 7 }, { name: 'iron_ingot', count: 6 }, { name: 'stick', count: 4 }],
      slots: [],
    },
  } as never);
  assert.match(f.line, /you hold 13 and 4/);
});

/**
 * The live bot caught this one itself, mid-soak: `list_inventory` claimed
 * `Armour: spruce_log`. Inventory slots 5-8 are where armour LIVES; that is not
 * proof that what sits there IS armour, and an invented helmet is the same class
 * of false fact #46 was opened to kill.
 */
test('armour is claimed by structure, never by which slot it sat in', async () => {
  const { isArmorPiece, armedFact, readArmed } = await import('../src/tools/helpers.js');
  assert.equal(isArmorPiece('iron_helmet'), true);
  assert.equal(isArmorPiece('turtle_helmet'), true);
  assert.equal(isArmorPiece('elytra'), true);
  assert.equal(isArmorPiece('netherite_chestplate'), true);
  assert.equal(isArmorPiece('spruce_log'), false);
  assert.equal(isArmorPiece('shield'), false, 'a shield is held, not worn');
  assert.equal(isArmorPiece(undefined), false);

  assert.match(armedFact({ inventory: [], armorPieces: ['spruce_log'] }).line, /Armour: NONE/);
  const mixed = armedFact({ inventory: [], armorPieces: ['spruce_log', 'iron_boots'] });
  assert.match(mixed.line, /Armour: iron_boots\./);

  const f = readArmed({
    heldItem: { name: 'stone_sword' },
    inventory: {
      items: () => [{ name: 'stone_sword', count: 1 }],
      slots: [null, null, null, null, null, { name: 'spruce_log' }, null, null, { name: 'iron_boots' }],
    },
  } as never);
  assert.match(f.line, /Armour: iron_boots\./);
});

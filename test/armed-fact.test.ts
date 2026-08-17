import { test } from 'node:test';
import assert from 'node:assert';

// Issue #46: 120/120 swings with fists and nothing ever told the mind. These
// assertions are about VISIBILITY — the fact must name the fist, the weapon
// sitting unused in the bag, and the emptiness of the bag when it is empty.
test('armedFact: bare fists with nothing in the bag says so, with the arithmetic', async () => {
  const { armedFact } = await import('../src/tools/helpers.js');
  const f = armedFact({ inventory: ['dirt', 'bread'] });
  assert.equal(f.armed, false);
  assert.equal(f.held, 'fists');
  assert.equal(f.best, undefined);
  assert.equal(f.inBag, false);
  assert.match(f.line, /FISTS/);
  assert.match(f.line, /NO sword, axe or trident/);
  assert.match(f.line, /1 damage/);
  assert.match(f.line, /Armour: NONE/);
});

test('armedFact: a weapon in the bag but not in hand is the loudest case', async () => {
  const { armedFact } = await import('../src/tools/helpers.js');
  const f = armedFact({ held: undefined, inventory: ['stone_axe', 'dirt'] });
  assert.equal(f.armed, false);
  assert.equal(f.best, 'stone_axe');
  assert.equal(f.inBag, true);
  assert.match(f.line, /stone_axe IS in your inventory but is not in your hand/);
});

test('armedFact: holding a weapon reads as armed, and names a better one', async () => {
  const { armedFact } = await import('../src/tools/helpers.js');
  const armed = armedFact({ held: 'iron_sword', inventory: ['iron_sword'], armorPieces: ['iron_helmet'] });
  assert.equal(armed.armed, true);
  assert.match(armed.line, /ARMED: iron_sword\./);
  assert.match(armed.line, /Armour: iron_helmet/);

  const upgradable = armedFact({ held: 'wooden_sword', inventory: ['wooden_sword', 'diamond_axe'] });
  assert.equal(upgradable.armed, true);
  assert.equal(upgradable.inBag, true);
  assert.match(upgradable.line, /diamond_axe in your bag hits harder/);
});

test('armedFact: a pickaxe in hand is not a weapon', async () => {
  const { armedFact } = await import('../src/tools/helpers.js');
  const f = armedFact({ held: 'iron_pickaxe', inventory: ['iron_pickaxe'] });
  assert.equal(f.armed, false);
  assert.match(f.line, /iron_pickaxe \(not a weapon\)/);
  assert.match(f.line, /NO sword, axe or trident/);
});

test('readArmed: reads the hand, the bag and the four armour slots off a live body', async () => {
  const { readArmed } = await import('../src/tools/helpers.js');
  const bot = {
    heldItem: { name: 'iron_pickaxe' },
    inventory: {
      items: () => [{ name: 'iron_pickaxe' }, { name: 'stone_sword' }],
      // 0-4 are crafting/offhand-ish, 5-8 are helmet/chest/legs/boots
      slots: [null, null, null, null, null, { name: 'leather_helmet' }, null, null, { name: 'iron_boots' }],
    },
  };
  const f = readArmed(bot as never);
  assert.equal(f.armed, false, 'a pickaxe is not a weapon');
  assert.equal(f.best, 'stone_sword');
  assert.match(f.line, /stone_sword IS in your inventory but is not in your hand/);
  assert.match(f.line, /Armour: leather_helmet, iron_boots/);

  // A body with nothing at all (the state every respawn starts in)
  const bare = readArmed({ inventory: { items: () => [] } } as never);
  assert.match(bare.line, /ARMED: FISTS/);
  assert.match(bare.line, /Armour: NONE/);
});

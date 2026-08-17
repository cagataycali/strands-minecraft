/**
 * The tools that move items now report the BAG, not the packet.
 *
 * Each of these once returned a sentence that was equally true when the server had
 * ignored the click — the same defect as #27/#28, in the four tools that hand
 * things to players, take armor off, feed the bot, and shear sheep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWorld, fakeBot, invoke } from './fake-bot.js';
import { inventoryTools } from '../src/tools/inventory.js';

const NAMES = ['equip_item', 'toss_item', 'craft_item', 'eat', 'use_item', 'unequip', 'write_book', 'creative_inventory'];
const toolOf = (bot: unknown, name: string) =>
  (inventoryTools(bot as never) as unknown[])[NAMES.indexOf(name)];

const world = () => new FakeWorld();

test('toss_item counts what actually left the bag, and says it is not received yet', async () => {
  const { bot } = fakeBot(world(), { inventory: { iron_ingot: 10 } });
  const out = String(await invoke(toolOf(bot, 'toss_item'), { item: 'iron_ingot', count: 4 }));
  assert.match(out, /Tossed 4x iron_ingot/);
  assert.match(out, /You still hold 6/);
  assert.match(out, /ITEMS ON THE GROUND until someone walks over them/, 'a toss is not a delivery');
});

test('toss_item refuses to claim a delivery the server ignored', async () => {
  const { bot } = fakeBot(world(), { inventory: { iron_ingot: 10 }, deaf: ['toss'] });
  await assert.rejects(() => invoke(toolOf(bot, 'toss_item'), { item: 'iron_ingot', count: 4 }) as Promise<unknown>,
    /Nothing left your inventory — you still hold 10x iron_ingot/);
});

test('unequip names what came off, and rejects armor that is still worn', async () => {
  const { bot } = fakeBot(world(), { inventory: { iron_leggings: 1 } });
  await invoke(toolOf(bot, 'equip_item'), { item: 'iron_leggings', destination: 'legs' });
  assert.match(String(await invoke(toolOf(bot, 'unequip'), { destination: 'legs' })),
    /Took iron_leggings off your legs slot/);

  const stuck = fakeBot(world(), { inventory: { iron_boots: 1 } });
  stuck.bot.inventory.slots[8] = { name: 'iron_boots' };
  (stuck.bot as unknown as { unequip: () => Promise<void> }).unequip = async () => {}; // server ignores it
  await assert.rejects(() => invoke(toolOf(stuck.bot, 'unequip'), { destination: 'feet' }) as Promise<unknown>,
    /feet still holds iron_boots/);
});

test('unequip on an empty slot is a plain answer, not an error', async () => {
  const { bot } = fakeBot(world(), { inventory: {} });
  assert.match(String(await invoke(toolOf(bot, 'unequip'), { destination: 'head' })), /Nothing was in your head slot/);
});

test('equip_item confirms the slot before claiming the armor is on', async () => {
  const ok = fakeBot(world(), { inventory: { iron_leggings: 1 } });
  assert.match(String(await invoke(toolOf(ok.bot, 'equip_item'), { item: 'iron_leggings', destination: 'legs' })),
    /Equipped iron_leggings to legs, confirmed in the slot/);

  const dropped = fakeBot(world(), { inventory: { iron_leggings: 1 }, deaf: ['legs'] });
  await assert.rejects(
    () => invoke(toolOf(dropped.bot, 'equip_item'), { item: 'iron_leggings', destination: 'legs' }) as Promise<unknown>,
    /iron_leggings is NOT in your legs slot/,
  );
});

test('eat waits for the food value the server owns', async () => {
  const { bot } = fakeBot(world(), { inventory: { bread: 3 }, food: 10 });
  assert.match(String(await invoke(toolOf(bot, 'eat'), { item: 'bread' })), /Food is now 15\/20 \(was 10\)/);
});

test('eat admits when no food update arrived instead of printing the old number', async () => {
  const { bot } = fakeBot(world(), { inventory: { bread: 3 }, food: 10, deaf: ['consume'] });
  const out = String(await invoke(toolOf(bot, 'eat'), { item: 'bread' }));
  assert.match(out, /has not sent a food update yet — it was 10\/20/);
  assert.doesNotMatch(out, /Food is now/, 'never state a hunger level that was never confirmed');
});

test('use_item on an entity reports the yield — shearing that produced no wool says so', async () => {
  const shears = fakeBot(world(), { inventory: { shears: 1 }, itemNames: ['white_wool'], useOnYield: { white_wool: 2 } });
  shears.bot.entities['7'] = { id: 7, name: 'sheep', position: shears.bot.entity.position };
  await invoke(toolOf(shears.bot, 'equip_item'), { item: 'shears', destination: 'hand' });
  assert.match(String(await invoke(toolOf(shears.bot, 'use_item'), { entity: 'sheep' })),
    /Inventory change: \+2 white_wool/);

  const dud = fakeBot(world(), { inventory: { shears: 1 } });
  dud.bot.entities['7'] = { id: 7, name: 'sheep', position: dud.bot.entity.position };
  const out = String(await invoke(toolOf(dud.bot, 'use_item'), { entity: 'sheep' }));
  assert.match(out, /Inventory change: nothing/);
  assert.match(out, /or the click did nothing at all/);
});

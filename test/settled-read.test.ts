/**
 * Issue #48 — a tool may only report a number the SERVER agreed to.
 *
 * The live bot found this itself (soak26): `toss` returned success and
 * volunteered "you still hold 0" about a stone_sword that never left slot 42.
 * The bag WAS re-read — one frame after the click, while mineflayer's optimistic
 * local mirror still showed the sword gone and the server's rejection was still
 * in flight. A read-back that can read your own intent is not a read-back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledRead } from '../src/tools/helpers.js';
import { FakeWorld, fakeBot, invoke } from './fake-bot.js';
import { inventoryTools } from '../src/tools/inventory.js';

const tossTool = (bot: unknown) => (inventoryTools(bot as never) as unknown[])[1];

test('settledRead: a change that survives the hold is real', async () => {
  let n = 10;
  const r = await settledRead(() => n, 10, { budgetMs: 50, holdMs: 50, stepMs: 10 });
  assert.equal(r.changed, false, 'nothing moved at all');

  n = 6;
  const ok = await settledRead(() => n, 10, { budgetMs: 50, holdMs: 50, stepMs: 10 });
  assert.deepEqual([ok.after, ok.changed, ok.rolledBack], [6, true, false]);
});

test('settledRead: a rollback inside the hold window is caught and named', async () => {
  let n = 10;
  setTimeout(() => { n = 0; }, 10).unref?.();
  setTimeout(() => { n = 10; }, 40).unref?.();
  const r = await settledRead(() => n, 10, { budgetMs: 100, holdMs: 150, stepMs: 10 });
  assert.equal(r.after, 10, 'the last word is the server\'s');
  assert.equal(r.changed, false, 'so nothing changed');
  assert.equal(r.rolledBack, true, 'and we know a false success was averted');
  assert.equal(r.peak, 0, 'the client mirror really did show 0 — that is the trap');
});

test('#48: toss refuses to claim a drop the server rolled back', async () => {
  const { bot } = fakeBot(new FakeWorld(), { inventory: { stone_sword: 1 }, rollback: ['toss'], rollbackMs: 120 });
  await assert.rejects(
    () => invoke(tossTool(bot), { item: 'stone_sword' }) as Promise<unknown>,
    /server did not accept the toss — you still hold 1x stone_sword/,
    'no invented "you still hold 0"',
  );
  assert.equal(bot.inventory.items().find((i) => i.name === 'stone_sword')?.count, 1, 'and the sword is still in the bag');
});

/**
 * The same trap one layer down: every container transaction (chest deposit and
 * withdrawal, furnace load, take_output) went through `awaitInventoryDelta`,
 * whose "cheap happy path: usually true on the first poll" WAS the bug — the
 * first poll happens before the server has answered.
 */
test('#48 awaitInventoryDelta: a withdrawal the server takes back is not a withdrawal', async () => {
  const { awaitInventoryDelta } = await import('../src/tools/craft-verify.js');
  let n = 17;
  const bot = { inventory: { items: () => [{ name: 'cobblestone', count: n }] } };

  n = 49; // the optimistic mirror, one frame after the click
  let rolledBackFrom: number | null = null;
  setTimeout(() => { n = 17; }, 120).unref?.(); // …and the server's rejection
  assert.equal(
    await awaitInventoryDelta(bot as never, 'cobblestone', 17, 32, 400, {
      settleMs: 300,
      onRollback: (peek) => { rolledBackFrom = peek; },
    }),
    false,
    'a delta that does not survive the hold never landed',
  );
  assert.equal(rolledBackFrom, 49, 'and the false number is kept as evidence, not narrated');
});

test('#48 awaitInventoryDelta: a real delta still lands, just settled', async () => {
  const { awaitInventoryDelta } = await import('../src/tools/craft-verify.js');
  const bot = { inventory: { items: () => [{ name: 'iron_ingot', count: 3 }] } };
  assert.equal(await awaitInventoryDelta(bot as never, 'iron_ingot', 0, 3, 400, { settleMs: 200 }), true);
});

/**
 * The slot rails, same trap: "the slot holds the helmet" is also what a REJECTED
 * click looks like for one round-trip — and a bot that believes it is armoured
 * fights differently (f37c26c's lesson, one layer up).
 */
test('#48 verifyEquip: a slot that only briefly held the item is not equipped', async () => {
  const { verifyEquip } = await import('../src/tools/helpers.js');
  let inSlot: string | null = 'iron_helmet'; // the optimistic mirror
  let ticks = 0;
  const bot = {
    getEquipmentDestSlot: () => 5,
    get inventory() { return { slots: [null, null, null, null, null, inSlot ? { name: inSlot } : null] }; },
    heldItem: null,
  };
  const sleep = async () => { if (++ticks >= 2) inSlot = null; }; // the server puts it back
  await assert.rejects(
    () => verifyEquip(bot as never, 'iron_helmet', 'head', { tries: 3, settleMs: 1, holdMs: 3, sleep }),
    /is NOT in your head slot[\s\S]*did show iron_helmet for a moment/,
  );
});

test('#48 verifyEquip: a slot that keeps the item still passes', async () => {
  const { verifyEquip } = await import('../src/tools/helpers.js');
  const bot = {
    getEquipmentDestSlot: () => 5,
    inventory: { slots: [null, null, null, null, null, { name: 'iron_helmet' }] },
    heldItem: null,
  };
  assert.deepEqual(await verifyEquip(bot as never, 'iron_helmet', 'head', { settleMs: 1, holdMs: 2 }), { late: false });
});

test('#48 unequip: armour the server puts back on is still worn', async () => {
  const { bot } = fakeBot(new FakeWorld(), { inventory: { iron_boots: 1 } });
  const NAMES = ['equip_item', 'toss_item', 'craft_item', 'eat', 'use_item', 'unequip'];
  const tools = inventoryTools(bot as never) as unknown[];
  await invoke(tools[NAMES.indexOf('equip_item')], { item: 'iron_boots', destination: 'feet' });
  const slot = bot.getEquipmentDestSlot('feet');
  (bot as unknown as { unequip: (d: string) => Promise<void> }).unequip = async () => {
    bot.inventory.slots[slot] = null;                                   // our own click
    const t = setTimeout(() => { bot.inventory.slots[slot] = { name: 'iron_boots' }; }, 120);
    t.unref?.();                                                        // the server's refusal
  };
  await assert.rejects(
    () => invoke(tools[NAMES.indexOf('unequip')], { destination: 'feet' }) as Promise<unknown>,
    /feet still holds iron_boots[\s\S]*did read empty for a moment/,
    'no "took your boots off" for boots that are still on',
  );
});

/**
 * The block rails. `bot.dig` and `bot.placeBlock` both resolve on a blockUpdate
 * AT THE TARGET — and the server undoing our optimistic change is such an update.
 * So the promise resolving is the one thing both a success and a refusal do.
 */
test('#48 confirmBroken: a dig the server undid did not break anything', async () => {
  const { confirmBroken } = await import('../src/tools/helpers.js');
  const { Vec3 } = await import('vec3');
  const at = new Vec3(1, 2, 3);

  const standing = { blockAt: () => ({ name: 'iron_ore' }) };
  assert.equal(await confirmBroken(standing as never, at, 'iron_ore', { sleep: async () => {} }), false,
    'the ore is still in the wall — nothing was mined');

  let looks = 0;
  const late = { blockAt: () => ({ name: looks++ === 0 ? 'iron_ore' : 'air' }) };
  assert.equal(await confirmBroken(late as never, at, 'iron_ore', { sleep: async () => {} }), true,
    'a late server confirmation is still a broken block');

  const broken = { blockAt: () => ({ name: 'air' }) };
  assert.equal(await confirmBroken(broken as never, at, 'iron_ore', { sleep: async () => {} }), true);
});

test('#48 awaitCraftDelta: the verifier for the craft desync no longer trusts one frame', async () => {
  const { awaitCraftDelta } = await import('../src/tools/craft-verify.js');
  let n = 1; // the crafted pickaxe, painted in locally
  const bot = { inventory: { items: () => [{ name: 'wooden_pickaxe', count: n }] } };
  let peeked: number | null = null;
  setTimeout(() => { n = 0; }, 120).unref?.(); // …and the 1.21.5+ window desync taking it back
  assert.equal(await awaitCraftDelta(bot as never, 'wooden_pickaxe', 0, 1, {
    settleMs: 300, onRollback: (p) => { peeked = p; },
  }), false, 'a craft that unwinds inside the hold never landed');
  assert.equal(peeked, 1);
});

/**
 * Equipping is a window click, so "Equipped X" was a claim about intent.
 *
 * The evidence was in the soak's own journey goal, written by the operator:
 * "…craft an iron_leggings and equip it (verify list_inventory armor.legs no longer
 * 'empty')". A human hand-rolling verification is a tool that cannot be believed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equippedName, verifyEquip, waitFor, type EquipReader } from '../src/tools/helpers.js';

const SLOTS: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8 };
/** `worn` is read fresh each look, so a test can let the server "catch up". */
const reader = (worn: () => Record<number, string | undefined>, held?: () => string | undefined): EquipReader => ({
  getEquipmentDestSlot: (d: string) => SLOTS[d],
  inventory: { slots: new Proxy([] as ({ name?: string } | null)[], {
    get: (_t, k) => (typeof k === 'string' && /^\d+$/.test(k) ? (worn()[Number(k)] ? { name: worn()[Number(k)] } : null) : undefined),
  }) },
  get heldItem() { return held?.() ? { name: held?.() } : null; },
});
const noSleep = async () => {};

test('equippedName reads armor slots and the hand', () => {
  const bot = reader(() => ({ 7: 'iron_leggings' }), () => 'iron_pickaxe');
  assert.equal(equippedName(bot, 'legs'), 'iron_leggings');
  assert.equal(equippedName(bot, 'head'), null);
  assert.equal(equippedName(bot, 'hand'), 'iron_pickaxe');
});

test('a confirmed equip is not "late"', async () => {
  const bot = reader(() => ({ 7: 'iron_leggings' }));
  assert.deepEqual(await verifyEquip(bot, 'iron_leggings', 'legs', { sleep: noSleep }), { late: false });
});

test('a slow server is waited out, and reported as late rather than failed', async () => {
  let looks = 0;
  const bot = reader(() => (++looks > 2 ? { 7: 'iron_leggings' } : {}));
  assert.deepEqual(await verifyEquip(bot, 'iron_leggings', 'legs', { sleep: noSleep }), { late: true });
});

test('a dropped click is named as such — and says the item is not lost', async () => {
  const bot = reader(() => ({ 7: undefined }));
  await assert.rejects(() => verifyEquip(bot, 'iron_leggings', 'legs', { sleep: noSleep, tries: 2 }), (e: Error) => {
    assert.match(e.message, /NOT in your legs slot — it still holds nothing/);
    assert.match(e.message, /still in your inventory, unlost/);
    return true;
  });
});

test('the wrong item in the slot is reported by name, not as an empty slot', async () => {
  const bot = reader(() => ({ 7: 'leather_pants' }));
  await assert.rejects(() => verifyEquip(bot, 'iron_leggings', 'legs', { sleep: noSleep, tries: 1 }),
    /it still holds leather_pants/);
});

test('waitFor answers rather than throwing — a non-event is often the report', async () => {
  let n = 0;
  assert.equal(await waitFor(() => ++n > 3, 1000, { sleep: noSleep }), true);
  assert.equal(await waitFor(() => false, 0, { sleep: noSleep }), false, 'no budget = one honest look');
});

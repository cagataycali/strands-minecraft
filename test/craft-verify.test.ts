/**
 * Tests for craft-verify — the 1.21.5+ silent-craft-desync guard
 * (mineflayer#3906). Pure logic plus a fake-client exercise of
 * resyncInventory's packet dance: stale no-op click out, corrective
 * window_items back, listener cleanup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  countOf,
  craftLanded,
  resyncInventory,
  awaitCraftDelta,
  verifyCraftStep,
  deltaLanded,
  awaitInventoryDelta,
  verifyInventoryDelta,
} from '../src/tools/craft-verify.js';

test('countOf sums across split stacks and ignores others', () => {
  const items = [
    { name: 'oak_planks', count: 12 },
    { name: 'stick', count: 4 },
    { name: 'oak_planks', count: 3 },
  ];
  assert.equal(countOf(items, 'oak_planks'), 15);
  assert.equal(countOf(items, 'stick'), 4);
  assert.equal(countOf(items, 'diamond'), 0);
  assert.equal(countOf([], 'stick'), 0);
});

test('craftLanded: at-least semantics (concurrent pickups only add)', () => {
  assert.equal(craftLanded(0, 4, 4), true); // exact
  assert.equal(craftLanded(0, 5, 4), true); // pickup mid-craft
  assert.equal(craftLanded(0, 3, 4), false); // shortfall = the bug
  assert.equal(craftLanded(10, 10, 1), false); // nothing arrived
  assert.equal(craftLanded(10, 11, 1), true);
});

/** Minimal fake bot: enough surface for resync/verify. */
function fakeCraftBot(opts: { correctingItems?: Array<{ name: string; count: number }> | null }) {
  const client = new EventEmitter() as EventEmitter & { write: (name: string, params: Record<string, unknown>) => void; writes: Array<{ name: string; params: Record<string, unknown> }> };
  client.writes = [];
  let items: Array<{ name: string; count: number }> = [];
  client.write = (name, params) => {
    client.writes.push({ name, params });
    if (name === 'window_click' && opts.correctingItems !== null) {
      // the server's authoritative reply to a stale-sid click, next tick
      setImmediate(() => {
        if (opts.correctingItems) items = opts.correctingItems;
        client.emit('window_items', { windowId: 0, stateId: 99, items: [] });
      });
    }
  };
  const bot = {
    _client: client,
    currentWindow: null as { id: number } | null,
    closeWindow() {
      this.currentWindow = null;
    },
    inventory: { items: () => items },
    setItems(next: Array<{ name: string; count: number }>) {
      items = next;
    },
  };
  return bot;
}

test('resyncInventory: stale no-op click provokes correction, resolves true', async () => {
  const bot = fakeCraftBot({ correctingItems: [{ name: 'oak_planks', count: 20 }] });
  const ok = await resyncInventory(bot as never);
  assert.equal(ok, true);
  const click = bot._client.writes.find((w) => w.name === 'window_click');
  assert.ok(click, 'sent a window_click');
  assert.equal(click!.params.windowId, 0);
  assert.equal(click!.params.stateId, 0, 'deliberately stale stateId');
  assert.equal(click!.params.slot, 0, 'no-op craft-result slot');
  assert.deepEqual(click!.params.changedSlots, []);
  assert.equal(bot._client.listenerCount('window_items'), 0, 'listener removed');
});

test('resyncInventory: closes a lingering window first', async () => {
  const bot = fakeCraftBot({ correctingItems: [] });
  bot.currentWindow = { id: 3 };
  const ok = await resyncInventory(bot as never);
  assert.equal(ok, true);
  assert.equal(bot.currentWindow, null);
});

test('verifyCraftStep: happy path is silent', async () => {
  const bot = fakeCraftBot({ correctingItems: null });
  bot.setItems([{ name: 'stick', count: 4 }]);
  const note = await verifyCraftStep(bot as never, 'stick', 0, 4);
  assert.equal(note, '');
  assert.equal(bot._client.writes.length, 0, 'no resync needed');
});

test('verifyCraftStep: local model lied, server truth confirms — heals and reports', async () => {
  // local model shows nothing; the corrective window_items reveals the
  // craft actually landed server-side
  const bot = fakeCraftBot({ correctingItems: [{ name: 'crafting_table', count: 1 }] });
  bot.setItems([]);
  const note = await verifyCraftStep(bot as never, 'crafting_table', 0, 1);
  assert.match(note, /resynced from server, craft confirmed/);
});

test('verifyCraftStep: genuine silent rejection throws the truth', async () => {
  // resync works but the item is genuinely absent server-side
  const bot = fakeCraftBot({ correctingItems: [{ name: 'oak_planks', count: 8 }] });
  bot.setItems([]);
  await assert.rejects(
    () => verifyCraftStep(bot as never, 'wooden_pickaxe', 0, 1),
    (e: Error) => {
      assert.match(e.message, /silently rejected/);
      assert.match(e.message, /mineflayer#3906/);
      assert.match(e.message, /NOT actually lost/);
      assert.match(e.message, /Do NOT re-gather/);
      return true;
    },
  );
});

test('awaitCraftDelta: sees a delta that arrives during the window', async () => {
  const bot = fakeCraftBot({ correctingItems: null });
  bot.setItems([]);
  setTimeout(() => bot.setItems([{ name: 'chest', count: 1 }]), 150);
  assert.equal(await awaitCraftDelta(bot as never, 'chest', 0, 1), true);
});

// ── The same guarantee for chests and furnaces (issue #17) ──────────────────
// The craft path was hardened after #15; deposits, withdrawals and furnace
// loads still reported success straight from the LOCAL model — the one thing
// the desync corrupts. The soak shows the price: the bot could not tell a
// vanished chicken from a dropped click, invented a cause, and spent six model
// turns on a food journey.

test('deltaLanded: signed — arrivals are "at least", departures are "at most"', () => {
  // Withdraw 5: a concurrent pickup may only add.
  assert.equal(deltaLanded(10, 15, 5), true);
  assert.equal(deltaLanded(10, 16, 5), true, 'picked something up mid-transaction');
  assert.equal(deltaLanded(10, 14, 5), false, 'shortfall = the dropped click');
  // Deposit 32: the bag must have LOST them.
  assert.equal(deltaLanded(144, 112, -32), true);
  assert.equal(deltaLanded(144, 111, -32), true, 'lost a bit more (ate one) — still gone');
  assert.equal(deltaLanded(144, 144, -32), false, 'never left the bag = the chest never got them');
  assert.equal(deltaLanded(144, 130, -32), false, 'partial deposit is a failed deposit');
});

test('verifyInventoryDelta: a deposit the server dropped says the items are NOT lost', async () => {
  // Local model never loses the stack, and no resync corrects it: the click died.
  const bot = fakeCraftBot({ correctingItems: [{ name: 'cobblestone', count: 144 }] });
  bot.setItems([{ name: 'cobblestone', count: 144 }]);
  await assert.rejects(
    () => verifyInventoryDelta(bot as never, 'cobblestone', 144, -32, {
      verb: 'deposit of 32x cobblestone',
      intact: 'still in your inventory — the chest never received them',
    }),
    (err: Error) => {
      assert.match(err.message, /deposit of 32x cobblestone was NOT accepted by the server/);
      assert.match(err.message, /144 before, 144 after, expected -32/, 'the numbers, not a vibe');
      assert.match(err.message, /still in your inventory/);
      assert.match(err.message, /Do NOT re-gather or re-plan around a loss/,
        'this is the sentence that stops the phantom recovery journey');
      assert.match(err.message, /resynced from the server/);
      return true;
    },
  );
});

test('verifyInventoryDelta: a withdrawal that only the local model missed heals quietly', async () => {
  // Server truth (delivered by the resync) DOES have the 5 iron: local lied.
  const bot = fakeCraftBot({ correctingItems: [{ name: 'iron_ingot', count: 5 }] });
  bot.setItems([]);
  const note = await verifyInventoryDelta(bot as never, 'iron_ingot', 0, 5, {
    verb: 'withdrawal of 5x iron_ingot',
    intact: 'still in the container, not lost',
  });
  assert.match(note, /local inventory had desynced; resynced from server, withdrawal of 5x iron_ingot confirmed/);
});

test('verifyInventoryDelta: the ordinary case is silent and costs no resync', async () => {
  const bot = fakeCraftBot({ correctingItems: null }); // any resync would be visible
  bot.setItems([{ name: 'cooked_chicken', count: 5 }]);
  assert.equal(await verifyInventoryDelta(bot as never, 'cooked_chicken', 0, 5, { verb: 'x', intact: 'y' }), '');
  assert.equal(bot._client.writes.length, 0, 'no packets on the happy path');
});

test('awaitInventoryDelta: waits for a slow furnace take, then gives up', async () => {
  const bot = fakeCraftBot({ correctingItems: null });
  bot.setItems([]);
  setTimeout(() => bot.setItems([{ name: 'iron_ingot', count: 3 }]), 150);
  assert.equal(await awaitInventoryDelta(bot as never, 'iron_ingot', 0, 3, 1_000), true);
  assert.equal(await awaitInventoryDelta(bot as never, 'diamond', 0, 1, 250), false);
});

/**
 * Craft verification + inventory resync — the antidote to the 1.21.5+ silent
 * craft desync (PrismarineJS/mineflayer#3906 family).
 *
 * What actually breaks, established by packet-level probes against a vanilla
 * 1.21.11 server (see the issue this module closes):
 *
 * - Since 1.21.5 the server validates every container_click against a
 *   PER-WINDOW stateId; mineflayer keeps ONE GLOBAL stateId fed by any
 *   window_items/set_slot regardless of windowId (inventory.js:33), so a
 *   click can echo a foreign window's counter.
 * - A STALE stateId click is rejected but self-heals: the server answers
 *   with an authoritative window_items. That reply is our resync primitive.
 * - A WRONG windowId click is dropped with NO correction — and mineflayer
 *   equally drops incoming set_slot/window_items whose windowId doesn't
 *   match its current window. Either way the local model and the server
 *   diverge PERMANENTLY and silently.
 * - bot.craft() resolves from prismarine-windows' LOCAL acceptClick
 *   mutations — it never confirms the result server-side. So a rejected
 *   craft looks exactly like a successful one, minus the item: ingredients
 *   vanish from the local model while the server still has them.
 *
 * Workaround shipped here, used by craft_item after every chain step:
 *  1. VERIFY: wait for the local inventory to actually show the crafted
 *     delta (the happy path costs one poll).
 *  2. RESYNC on doubt: send a deliberately STALE no-op click (raw write —
 *     no local mutation), which provokes the server's authoritative
 *     window_items for the player inventory; the local model snaps back to
 *     truth in ~50ms.
 *  3. RE-VERIFY against the resynced (= server-true) inventory and tell the
 *     agent the truth: either the craft landed after all, or it was
 *     silently rejected and the ingredients were NEVER lost.
 */
import type { Bot } from 'mineflayer';

/** Sum of an item across inventory slots, by registry name. */
export function countOf(items: Array<{ name: string; count: number }>, name: string): number {
  let n = 0;
  for (const i of items) if (i.name === name) n += i.count;
  return n;
}

/**
 * Did the craft land? Pure check: the after-count must have grown by at
 * least `expected` over the before-count. (At least, not exactly: a
 * concurrent pickup can only add, and a shortfall is what we're hunting.)
 */
export function craftLanded(before: number, after: number, expected: number): boolean {
  return after - before >= expected;
}

/** Milliseconds to wait for the crafted item to appear locally. */
export const VERIFY_WINDOW_MS = 1500;
/** Milliseconds to wait for the server's corrective window_items. */
export const RESYNC_WINDOW_MS = 2000;
/**
 * 🪤 Issue #48 — how long a landing must HOLD before it counts as landed.
 *
 * A window click is applied to mineflayer's local mirror the moment it is sent,
 * so `deltaLanded` is true on the first poll of a transaction the server has not
 * even answered yet: the cheap happy path was reading our own click. A rejection
 * arrives one round-trip later and puts the slot back, which is how `toss` came
 * to report success and volunteer "you still hold 0" for a sword that never left
 * slot 42. Nothing here is craft-specific — every window transaction has it.
 */
export const SETTLE_WINDOW_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Force the server to re-send the authoritative player inventory.
 *
 * Closes any open window first (its updates would ride a different
 * windowId), then raw-writes a no-op container_click carrying a stateId the
 * server has already surpassed. Vanilla 1.21.5+ rejects the click and
 * replies with window_items for windowId 0 — proven behavior, ~50ms round
 * trip. The write bypasses bot.clickWindow on purpose: nothing may mutate
 * the local model, we want the server's version to overwrite it.
 *
 * Returns true when the corrective window_items arrived (local model is now
 * server truth), false on timeout (treat local model as untrusted).
 */
export async function resyncInventory(bot: Bot): Promise<boolean> {
  if (bot.currentWindow) {
    try {
      bot.closeWindow(bot.currentWindow);
    } catch {
      /* already closing — fine */
    }
    await sleep(150);
  }

  let corrected = false;
  const client = bot._client as unknown as {
    on(name: string, fn: (data: Record<string, unknown>) => void): void;
    removeListener(name: string, fn: (data: Record<string, unknown>) => void): void;
    write(name: string, params: Record<string, unknown>): void;
  };
  const onItems = (data: Record<string, unknown>) => {
    if (data.windowId === 0) corrected = true;
  };
  client.on('window_items', onItems);
  try {
    // stateId 0 is stale the moment the server has sent any inventory update;
    // slot 0 (2x2 craft result) with an empty cursor makes the click a no-op
    // even in the pathological case where the server accepts it.
    client.write('window_click', {
      windowId: 0,
      stateId: 0,
      slot: 0,
      mouseButton: 0,
      mode: 0,
      changedSlots: [],
      cursorItem: undefined,
    });
    const t0 = Date.now();
    while (!corrected && Date.now() - t0 < RESYNC_WINDOW_MS) await sleep(50);
  } finally {
    client.removeListener('window_items', onItems);
  }
  return corrected;
}

/**
 * Wait up to VERIFY_WINDOW_MS for the local inventory to show `expected`
 * more of `itemName` than `before` — and to STILL show it SETTLE_WINDOW_MS
 * later (issue #48). The old "cheap happy path: usually true on the first
 * poll" was the whole bug: a craft click is painted into mineflayer's local
 * inventory before the server answers, so the first poll can only tell us what
 * we asked for. This is the desync #15 was filed for, being used to verify
 * itself.
 */
export async function awaitCraftDelta(
  bot: Bot,
  itemName: string,
  before: number,
  expected: number,
  o: { settleMs?: number; onRollback?: (peek: number) => void } = {},
): Promise<boolean> {
  const settleMs = o.settleMs ?? SETTLE_WINDOW_MS;
  const count = () => countOf(bot.inventory.items(), itemName);
  const t0 = Date.now();
  for (;;) {
    if (craftLanded(before, count(), expected)) {
      const optimistic = count();
      for (let waited = 0; waited < settleMs; waited += 100) await sleep(100);
      if (craftLanded(before, count(), expected)) return true;
      o.onRollback?.(optimistic);
    }
    if (Date.now() - t0 >= VERIFY_WINDOW_MS) return false;
    await sleep(100);
  }
}

/**
 * The full guarded craft step: verify, resync on doubt, tell the truth.
 * Returns a note to append to the tool's report ('' when everything was
 * ordinary). Throws when the craft was silently rejected server-side.
 */
export async function verifyCraftStep(bot: Bot, itemName: string, before: number, expected: number): Promise<string> {
  let rolledBackFrom: number | null = null;
  if (await awaitCraftDelta(bot, itemName, before, expected, {
    onRollback: (peek) => { rolledBackFrom = peek; },
  })) return '';

  // Local model says the item never arrived. Local model is also the thing
  // this bug corrupts — get the server's truth before concluding anything.
  const synced = await resyncInventory(bot);
  const after = countOf(bot.inventory.items(), itemName);

  if (craftLanded(before, after, expected)) {
    // The craft DID land; only the local model had lied. Healed now.
    return ' (local inventory had desynced; resynced from server, craft confirmed)';
  }
  throw new Error(
    `Crafting ${itemName}: the server silently rejected the craft — known mineflayer 1.21.5+ container-click desync (mineflayer#3906). ` +
      (rolledBackFrom !== null
        ? `This client's bag briefly showed ${rolledBackFrom}x — our own click, not the server's answer. `
        : '') +
      `Ingredients were NOT actually lost${synced ? '; inventory has been resynced from the server' : '; resync timed out, re-check inventory before trusting counts'}. ` +
      `Do NOT re-gather materials. Retry the craft once; if it fails again, move to the crafting table and retry there.`,
  );
}

/**
 * 📦 The same guarantee for every OTHER window transaction (issue #17).
 *
 * `verifyCraftStep` was written for one symptom, but nothing about the
 * underlying bug is specific to crafting: on 1.21.5+ every container click is
 * validated against a per-window `stateId`, mineflayer keeps ONE global one, and
 * a wrong-`wid` click is dropped with no server correction — while mineflayer
 * symmetrically discards mismatched `set_slot`/`window_items`, so the local model
 * never self-heals. Chest deposits, chest withdrawals and furnace loads all ran
 * unverified: they reported success from the LOCAL model, which is precisely the
 * thing the bug corrupts.
 *
 * The cost of that gap is not a wrong string. The live soak has the bot noticing
 * an inventory change it could not explain ("my raw chicken vanished"), inventing
 * a cause, and starting a food journey that was still burning a full model turn
 * per 1-3 blocks of staircase six steps later. A transaction that cannot be
 * verified must SAY so, so the model corrects instead of telling itself a story.
 *
 * `expected` is signed: +n for items arriving in the bag (withdraw, take_output),
 * −n for items leaving it (deposit, load_input, load_fuel).
 */
export function deltaLanded(before: number, after: number, expected: number): boolean {
  // Signed, and one-sided in the direction we care about: a concurrent pickup
  // may only add, so an arrival is "at least", a departure is "at most". The
  // shortfall — or the item that never left — is what we are hunting.
  return expected >= 0 ? after - before >= expected : after - before <= expected;
}

export async function awaitInventoryDelta(
  bot: Bot,
  itemName: string,
  before: number,
  expected: number,
  windowMs = VERIFY_WINDOW_MS,
  o: { settleMs?: number; onRollback?: (peek: number) => void } = {},
): Promise<boolean> {
  const settleMs = o.settleMs ?? SETTLE_WINDOW_MS;
  const count = () => countOf(bot.inventory.items(), itemName);
  const t0 = Date.now();
  for (;;) {
    if (deltaLanded(before, count(), expected)) {
      // It LOOKS landed — which is exactly what a rejected click looks like for
      // one round-trip (issue #48). Hold, then ask again; only a delta that
      // survives the hold is the server's answer rather than our own.
      const optimistic = count();
      for (let waited = 0; waited < settleMs; waited += 100) await sleep(100);
      if (deltaLanded(before, count(), expected)) return true;
      o.onRollback?.(optimistic);
    }
    if (Date.now() - t0 >= windowMs) return false;
    await sleep(100);
  }
}

/**
 * Verify one window transaction and return a note for the tool's report:
 * '' when it landed normally, a healed-desync note when only the local model
 * had lied. Throws — with the truth and what NOT to do about it — when the
 * server dropped the click.
 *
 * `verb` is what was attempted ('deposit of 32 cobblestone'), `intact` is where
 * the items provably still are ('still in your inventory'). Both are the caller's
 * words because only the caller knows which side of the window it was on, and a
 * vague warning is how an agent ends up re-gathering things it never lost.
 */
export async function verifyInventoryDelta(
  bot: Bot,
  itemName: string,
  before: number,
  expected: number,
  o: { verb: string; intact: string },
): Promise<string> {
  let rolledBackFrom: number | null = null;
  if (await awaitInventoryDelta(bot, itemName, before, expected, VERIFY_WINDOW_MS, {
    onRollback: (peek) => { rolledBackFrom = peek; },
  })) return '';

  const synced = await resyncInventory(bot);
  const after = countOf(bot.inventory.items(), itemName);
  if (deltaLanded(before, after, expected)) {
    return ` (local inventory had desynced; resynced from server, ${o.verb} confirmed)`;
  }
  throw new Error(
    `${o.verb} was NOT accepted by the server — known mineflayer 1.21.5+ window-click desync (mineflayer#3906). ` +
      `Counted ${itemName}: ${before} before, ${after} after, expected ${expected > 0 ? '+' : ''}${expected}. ` +
      (rolledBackFrom !== null
        ? `This client's bag briefly showed ${rolledBackFrom}x — our own click, not the server's answer; it was put straight back. `
        : '') +
      `The items are ${o.intact}${synced ? '; inventory has been resynced from the server' : '; the resync timed out, so re-check your inventory before trusting any count'}. ` +
      `Do NOT re-gather or re-plan around a loss — retry the transaction once, and if it fails again walk away and come back to reopen the container.`,
  );
}

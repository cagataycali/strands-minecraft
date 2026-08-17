import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { resolveEntity, inventoryItem, vec, fmtPos, approach, approachEntity, bestMeleeWeapon, waitFor, bagCounts, bagDelta } from './helpers.js';
import { legsFor, LEGS_PRIORITY } from '../legs.js';
import { itemUseFaultAdvice } from '../protocol.js';
import { countOf, verifyInventoryDelta } from './craft-verify.js';

export function combatTools(bot: Bot) {
  const attack = tool({
    name: 'attack_entity',
    description:
      "Attack a mob or player. Default is one swing (call repeatedly to fight manually). until='dead' fights the whole duel in one call: chases the target between swings, respects the ~0.6s attack cooldown (spam-clicking does less damage), raises a shield in the off-hand between swings if one is equipped, and STOPS EARLY if your health drops below minHealth — read the result, it says whether the target died or you had to retreat. Auto-equips your strongest melee weapon first (pass autoEquip=false to fight with whatever is in hand).",
    inputSchema: z.object({
      entity: z.string().describe("Target: entity name ('zombie', 'skeleton'), username, or id"),
      until: z.enum(['once', 'dead']).default('once').describe("'once' = one swing; 'dead' = keep fighting until it dies, escapes, or you get low"),
      minHealth: z.number().default(8).describe("until='dead': stop fighting below this health (of 20) — 8 = four hearts"),
      timeoutSec: z.number().default(30).describe("until='dead': give up after this long"),
      autoEquip: z.boolean().default(true).describe('equip your strongest melee weapon before the first swing'),
      giveUpRange: z.number().default(24).describe("until='dead': stop chasing when the target gets this many blocks away (raise it to hunt something fleeing, lower it to hold ground)"),
    }),
    callback: async ({ entity, until, minHealth, timeoutSec, autoEquip, giveUpRange }) => {
      const target = resolveEntity(bot, entity);
      // Do not fight what the body is currently FLEEING (issue #22). The sentinel
      // briefing says "fight or flee NOW" and the live soak had both happen at
      // once: creeper_flee pathed away while the model chased the same creeper,
      // each cancelling the other, and the flee degraded to a 1m blind sprint.
      // The reflex is the one holding a claim, so the reflex wins the tie — and
      // saying so beats a silent no-op.
      const fleeing = legsFor(bot as unknown as object).held();
      if (fleeing && fleeing.priority >= LEGS_PRIORITY.safety) {
        return `Did NOT attack ${entity}: your body is already handling this — ${fleeing.what ?? `the ${fleeing.owner} reflex`} is running. Chasing now would cancel the escape (that is how the bot ended up at 2 HP). Wait for the reflex report, then decide to re-engage or keep retreating.`;
      }
      // Arm up BEFORE the first swing — under the damage reflex every extra
      // round-trip is another hit taken, so the equip decision shouldn't
      // cost a model turn. Skipped when the best weapon is already in hand,
      // when nothing in the bag beats a fist, or on autoEquip=false (punching
      // a boat to break it, sweeping with a specific enchanted item, …).
      let armed = '';
      if (autoEquip) {
        const best = bestMeleeWeapon(bot.inventory.items().map((i) => i.name));
        if (best && bot.heldItem?.name !== best) {
          try {
            await bot.equip(inventoryItem(bot, best), 'hand');
            armed = ` (equipped ${best})`;
          } catch { /* equip raced a pickup — fight with what's in hand */ }
        }
      }
      const chase = () => approachEntity(bot, target);
      const hp = () => (target as unknown as { health?: number }).health;

      if (until === 'once') {
        await chase();
        await bot.attack(target);
        const h = hp();
        return `Attacked ${entity}${armed}${h !== undefined ? ` (health now ~${h})` : ''}.`;
      }

      // until='dead' — the whole duel. A shield in the off-hand is raised
      // between swings (activateItem(true) = off-hand use) and dropped right
      // before each attack, because a raised shield blocks your own swing.
      const hasShield = bot.inventory.slots[45]?.name === 'shield';
      // A shield that cannot be raised is worth SAYING (issue #21): the old
      // `catch { /* shield broke */ }` also swallowed the serialization fault
      // that was killing the connection, so the model fought on believing it had
      // a shield up. First fault only — a duel should not narrate 30 of them.
      let shieldFault = '';
      const shield = (raise: boolean) => {
        if (!hasShield) return;
        try { if (raise) bot.activateItem(true); else bot.deactivateItem(); }
        catch (err) { if (!shieldFault) shieldFault = itemUseFaultAdvice(err); }
      };
      const deadline = Date.now() + timeoutSec * 1000;
      let swings = 0;
      // Shield ownership (issue #6.3): the loop lowers it before each swing,
      // the finally below lowers it exactly once on the way out — stop() only
      // words the report, so no path drops the shield twice.
      const stop = (why: string) => {
        const h = hp();
        return `Fought ${entity}${armed} for ${swings} swing(s): ${why}${h !== undefined && h > 0 ? ` Target health ~${h}.` : ''} Your health: ${bot.health?.toFixed(0)}/20.${shieldFault ? ` NOTE: you fought WITHOUT a shield — ${shieldFault}.` : ''}`;
      };
      try {
        while (true) {
          // Death shows as despawn (gone from bot.entities) or health hitting 0.
          // health is OFTEN undefined for other entities — undefined must mean
          // "unknown, keep fighting", never "dead".
          const h = hp();
          if (!bot.entities[target.id] || (h !== undefined && h <= 0))
            return stop(`${entity} is dead.${swings ? ' Drops are on the ground — collect_ground_items.' : ''}`);
          if ((bot.health ?? 20) < minHealth)
            return stop(`RETREATED — your health fell below ${minHealth}. Eat, or run.`);
          if (Date.now() > deadline)
            return stop(`gave up after ${timeoutSec}s (target still alive — it may be fleeing or unreachable).`);
          if (bot.entity.position.distanceTo(target.position) > giveUpRange)
            return stop(`${entity} escaped beyond ${giveUpRange} blocks (giveUpRange).`);
          shield(false);
          try {
            await chase();
            await bot.attack(target);
            swings++;
          } catch (err) {
            // One failed chase/swing isn't defeat (target hopped a ledge);
            // the loop's own exit conditions decide when it IS.
            if (Date.now() > deadline) return stop(`gave up: ${err instanceof Error ? err.message : err}`);
          }
          shield(true);
          // Attack cooldown: swinging faster than ~0.6s does reduced damage.
          await new Promise((r) => setTimeout(r, 650));
        }
      } finally {
        shield(false);
      }
    },
  });

  return [attack];
}

/**
 * How many to actually move, plus a sentence for the shortfall.
 *
 * `count=0` means "all". Asking for more than exists is a perfectly reasonable
 * thing for a model to do ("withdraw 64 cobblestone" from a chest holding 32),
 * and it must not become an error — it is a fact about the world worth stating,
 * so the model neither re-plans around a phantom failure nor believes it got 64.
 */
export function clampTransfer(count: number, available: number): { n: number; shortfall: (holder: string) => string } {
  const wanted = count || available;
  const n = Math.min(wanted, available);
  return {
    n,
    shortfall: (holder: string) =>
      n < wanted ? ` You asked for ${wanted}, but that was all ${holder} had.` : '',
  };
}

/**
 * Run a container click and, if it throws, say what MOVED before it did.
 *
 * mineflayer's transfer helpers are not atomic: they walk slots, and a throw
 * halfway through leaves the earlier slots already transferred. Re-raising the
 * raw exception ("Can't find cobblestone in slots [0 - 27]") tells the model
 * nothing happened, which is exactly the lie craft-verify.ts exists to kill. So
 * measure the bag around the failure and put the measured truth in the error.
 */
export async function withMeasuredTransfer(
  bot: Bot,
  name: string,
  before: number,
  expected: number,
  verb: string,
  click: () => Promise<void>,
): Promise<void> {
  try {
    await click();
  } catch (err) {
    const after = countOf(bot.inventory.items(), name);
    const moved = after - before;
    const msg = err instanceof Error ? err.message : String(err);
    if (moved === 0) throw new Error(`${verb} failed and nothing moved: ${msg}`);
    throw new Error(
      `${verb} FAILED PART-WAY — ${Math.abs(moved)}x ${name} did move (${before} → ${after}), so do NOT assume nothing happened: ` +
        `re-check with a 'list' before retrying, or you will double-count. Underlying error: ${msg}`,
    );
  }
}

export function interactionTools(bot: Bot) {
  let fishing = false; // one cast at a time — see the fish tool
  const openContainer = tool({
    name: 'container_transact',
    description:
      "Open a chest/barrel/shulker at coordinates and deposit or withdraw items in one transaction. E.g. withdraw 5 iron_ingot, deposit all cobblestone (count=0 means 'all').",
    inputSchema: z.object({
      x: z.number(), y: z.number(), z: z.number(),
      action: z.enum(['deposit', 'withdraw', 'list']),
      item: z.string().optional().describe('Item name (required for deposit/withdraw)'),
      count: z.number().default(0).describe('How many; 0 = all available'),
    }),
    callback: async ({ x, y, z, action, item, count }) => {
      const block = bot.blockAt(vec({ x, y, z }));
      if (!block) throw new Error(`No block at ${fmtPos({ x, y, z })}`);
      await approach(bot, block.position);
      const container = await bot.openContainer(block);
      try {
        if (action === 'list') {
          const items = container.containerItems().map((i) => ({ name: i.name, count: i.count }));
          return { contents: items.length ? items : 'empty' };
        }
        if (!item) throw new Error(`'${action}' needs an item name.`);
        const registry = bot.registry.itemsByName[item.toLowerCase()];
        if (!registry) throw new Error(`Unknown item '${item}'`);
        const name = item.toLowerCase();
        // Every count below is taken BEFORE the click, because the click is what
        // may silently not happen (issue #17).
        const inBagBefore = countOf(bot.inventory.items(), name);
        if (action === 'withdraw') {
          const available = container.containerItems().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
          if (available === 0) throw new Error(`No ${item} in this container.`);
          // Ask for no more than the chest holds. Over-asking is not refused by
          // mineflayer: it moves everything it can find and THEN throws
          // "Can't find <item> in slots [0 - 27]" — a partial success wearing an
          // error's clothes. The soak drained a 32-cobblestone chest that way and
          // was told the item could not be found, so the model went mining
          // (issue #28). Clamping makes the over-ask a plain, honest fact.
          const { n, shortfall } = clampTransfer(count, available);
          await withMeasuredTransfer(bot, name, inBagBefore, n, `withdrawal of ${n}x ${item}`, () =>
            container.withdraw(registry.id, null, n));
          const note = await verifyInventoryDelta(bot, name, inBagBefore, n, {
            verb: `withdrawal of ${n}x ${item}`,
            intact: 'still in the container, not lost',
          });
          return `Withdrew ${n}x ${item}.${shortfall(`the chest`)}${note}`;
        }
        if (inBagBefore === 0) throw new Error(`You have no ${item} to deposit.`);
        const { n, shortfall } = clampTransfer(count, inBagBefore);
        await withMeasuredTransfer(bot, name, inBagBefore, -n, `deposit of ${n}x ${item}`, () =>
          container.deposit(registry.id, null, n));
        const note = await verifyInventoryDelta(bot, name, inBagBefore, -n, {
          verb: `deposit of ${n}x ${item}`,
          intact: 'still in your inventory — the chest never received them',
        });
        return `Deposited ${n}x ${item}.${shortfall('you')}${note}`;
      } finally {
        container.close();
      }
    },
  });

  const furnaceTransact = tool({
    name: 'furnace_transact',
    description:
      "Operate a furnace/blast_furnace/smoker at coordinates: check status (fuel %, smelt progress, what's in the 3 slots), load input ore/food, load fuel (coal, planks…), or take the finished output. Smelting takes ~10s per item — load it, do something else, come back for the output.",
    inputSchema: z.object({
      x: z.number(), y: z.number(), z: z.number(),
      action: z.enum(['status', 'load_input', 'load_fuel', 'take_output', 'take_all']),
      item: z.string().optional().describe('Item name (required for load_input/load_fuel)'),
      count: z.number().default(0).describe('How many; 0 = all you hold'),
    }),
    callback: async ({ x, y, z, action, item, count }) => {
      const block = bot.blockAt(vec({ x, y, z }));
      if (!block) throw new Error(`No block at ${fmtPos({ x, y, z })}`);
      if (!/furnace|smoker/.test(block.name)) throw new Error(`Block at ${fmtPos({ x, y, z })} is ${block.name}, not a furnace/blast_furnace/smoker.`);
      await approach(bot, block.position);
      const furnace = await bot.openFurnace(block);
      try {
        const slot = (i: ReturnType<typeof furnace.inputItem>) => (i ? `${i.count}x ${i.name}` : 'empty');
        if (action === 'status') {
          return {
            input: slot(furnace.inputItem()),
            fuel: slot(furnace.fuelItem()),
            output: slot(furnace.outputItem()),
            fuelRemaining: `${Math.round((furnace.fuel ?? 0) * 100)}%`,
            smeltProgress: `${Math.round((furnace.progress ?? 0) * 100)}%`,
          };
        }
        if (action === 'take_output' || action === 'take_all') {
          const taken: string[] = [];
          const notes: string[] = [];
          // Each take is verified against the bag, in the same breath as the
          // click: a dropped furnace click is as silent as a dropped chest one.
          const take = async (
            slotItem: ReturnType<typeof furnace.inputItem>,
            pull: () => Promise<{ count: number; name: string }>,
            label: string,
          ) => {
            if (!slotItem) return;
            const before = countOf(bot.inventory.items(), slotItem.name);
            const it = await pull();
            taken.push(`${it.count}x ${it.name} (${label})`);
            notes.push(await verifyInventoryDelta(bot, it.name, before, it.count, {
              verb: `taking ${it.count}x ${it.name} from the furnace ${label} slot`,
              intact: `still in the furnace ${label} slot`,
            }));
          };
          await take(furnace.outputItem(), () => furnace.takeOutput(), 'output');
          if (action === 'take_all') {
            await take(furnace.inputItem(), () => furnace.takeInput(), 'input');
            await take(furnace.fuelItem(), () => furnace.takeFuel(), 'fuel');
          }
          return taken.length
            ? `Took ${taken.join(', ')}.${notes.join('')}`
            : 'Nothing to take — output is empty (still smelting? check status).';
        }
        if (!item) throw new Error(`'${action}' needs an item name.`);
        const registry = bot.registry.itemsByName[item.toLowerCase()];
        if (!registry) throw new Error(`Unknown item '${item}'`);
        const name = item.toLowerCase();
        const held = countOf(bot.inventory.items(), name);
        if (held === 0) throw new Error(`You have no ${item} to load.`);
        const n = count || held;
        const slotName = action === 'load_input' ? 'input' : 'fuel';
        if (action === 'load_input') await furnace.putInput(registry.id, null, n);
        else await furnace.putFuel(registry.id, null, n);
        const loadNote = await verifyInventoryDelta(bot, name, held, -n, {
          verb: `loading ${n}x ${item} into the furnace ${slotName} slot`,
          intact: 'still in your inventory — the furnace never received them, so nothing is smelting',
        });
        return `Loaded ${n}x ${item} into the ${slotName} slot. Smelting runs while you do other things — take_output later.${loadNote}`;
      } finally {
        furnace.close();
      }
    },
  });

  const tradeVillager = tool({
    name: 'trade_with_villager',
    description:
      "Trade with a villager or wandering trader. action='list' shows every trade (index, what it costs, what it gives, uses left) — always list first. action='trade' executes one by index. Walks to the villager automatically.",
    inputSchema: z.object({
      entity: z.string().default('villager').describe("Villager entity name or id ('villager', 'wandering_trader', or numeric id)"),
      action: z.enum(['list', 'trade']),
      tradeIndex: z.number().optional().describe('Which trade to execute (from list)'),
      times: z.number().default(1).describe('How many times to run the trade'),
    }),
    callback: async ({ entity, action, tradeIndex, times }) => {
      const target = resolveEntity(bot, entity);
      await approachEntity(bot, target);
      const villager = await bot.openVillager(target);
      try {
        const describe = (t: (typeof villager.trades)[number], i: number) => ({
          index: i,
          cost: `${t.inputItem1.count}x ${t.inputItem1.name}${t.hasItem2 && t.inputItem2 ? ` + ${t.inputItem2.count}x ${t.inputItem2.name}` : ''}`,
          gives: `${t.outputItem.count}x ${t.outputItem.name}`,
          disabled: t.tradeDisabled,
          usesLeft: t.maximumNbTradeUses - t.nbTradeUses,
        });
        if (action === 'list') {
          if (villager.trades.length === 0) return 'This villager has no trades (unemployed or baby).';
          return { trades: villager.trades.map(describe) };
        }
        if (tradeIndex === undefined) throw new Error("action='trade' needs tradeIndex — call with action='list' first.");
        const t = villager.trades[tradeIndex];
        if (!t) throw new Error(`No trade at index ${tradeIndex} — this villager has ${villager.trades.length} trades.`);
        if (t.tradeDisabled) throw new Error(`Trade ${tradeIndex} (${t.inputItem1.name} → ${t.outputItem.name}) is locked — trade something else or wait for restock.`);
        const have = bot.inventory.items().filter((i) => i.name === t.inputItem1.name).reduce((s, i) => s + i.count, 0);
        if (have < t.inputItem1.count * times) {
          throw new Error(`Need ${t.inputItem1.count * times}x ${t.inputItem1.name} but only have ${have}.`);
        }
        const promised = `${t.inputItem1.count * times}x ${t.inputItem1.name}${t.hasItem2 && t.inputItem2 ? ` + ${t.inputItem2.count * times}x ${t.inputItem2.name}` : ''} for ${t.outputItem.count * times}x ${t.outputItem.name}`;
        const before = bagCounts(bot);
        await bot.trade(villager, tradeIndex, times);
        // The old report was the trade OFFER read back as if it had happened. A
        // villager can restock-lock, run out of uses, or refuse mid-batch, and an
        // emerald economy the model believes in but does not have poisons every plan
        // built on it. Report the bag.
        await waitFor(() => bagDelta(before, bagCounts(bot)) !== 'nothing', 1500);
        const changed = bagDelta(before, bagCounts(bot));
        const got = countOf(bot.inventory.items(), t.outputItem.name) - (before.get(t.outputItem.name) ?? 0);
        if (changed === 'nothing')
          throw new Error(
            `The trade did NOT go through — your inventory is unchanged, so you still hold your ${t.inputItem1.name} ` +
              `and received no ${t.outputItem.name}. The villager may have locked the trade or run out of uses; ` +
              `list again to see usesLeft.`,
          );
        return `Traded for ${promised}. Inventory change: ${changed}.` +
          (got < t.outputItem.count * times
            ? ` You received ${got}x ${t.outputItem.name}, FEWER than the ${t.outputItem.count * times} offered — the villager ran out partway; list again before planning on more.`
            : '');
      } finally {
        villager.close();
      }
    },
  });

  const sleep = tool({
    name: 'sleep_in_bed',
    description: 'Find the nearest bed, walk to it, and sleep. Only works at night or during thunderstorms.',
    inputSchema: z.object({
      range: z.number().default(16).describe('how far to search for a bed, in blocks'),
    }),
    callback: async ({ range }) => {
      const bedIds = Object.values(bot.registry.blocksByName)
        .filter((b) => b.name.endsWith('_bed'))
        .map((b) => b.id);
      const bed = bot.findBlock({ matching: bedIds, maxDistance: range });
      if (!bed) return `No bed within ${range} blocks.`;
      await approach(bot, bed.position, { range: 2 });
      await bot.sleep(bed);
      return 'Sleeping. 😴 (wake_up to get up early)';
    },
  });

  const wake = tool({
    name: 'wake_up',
    description: 'Get out of bed.',
    callback: async () => {
      await bot.wake();
      return 'Awake.';
    },
  });

  const fish = tool({
    name: 'fish',
    description:
      'Cast the fishing rod and wait for a catch (one full cast, typically 5–30 s — the caught item lands in inventory or right next to you). Needs a fishing_rod in inventory and water nearby; walks to the water edge and aims automatically. Call repeatedly to keep fishing.',
    inputSchema: z.object({
      maxDistance: z.number().default(16).describe('How far to search for water (default 16)'),
    }),
    callback: async ({ maxDistance }) => {
      // One cast at a time, and the guard comes FIRST — before the legs move.
      // mineflayer's fish() cancels an in-flight cast when called again, and a
      // cast also dies if the body walks or re-aims, so the old guard (placed
      // after approach/equip/lookAt) still let a second call sabotage the first:
      // live journal, 2026-08-17 — 'Cast attempts keep cancelling each other
      // (fish() collision) … no fish caught yet this step'. Concurrent forks are
      // normal in this bot, so the second caller must bounce off a closed door,
      // not tiptoe through it.
      if (fishing) throw new Error('Already mid-cast — one fish call at a time. A second cast MOVES and re-aims the body, which cancels the bobber already in the water; wait for the current cast to report its catch.');
      fishing = true;
      let timer: NodeJS.Timeout | undefined;
      const before = new Map<string, number>();
      try {
        const rod = bot.inventory.items().find((i) => i.name === 'fishing_rod');
        if (!rod) throw new Error('No fishing_rod in inventory — craft one (3 sticks + 2 string).');

        const water = bot.findBlock({ matching: bot.registry.blocksByName.water.id, maxDistance });
        if (!water) throw new Error(`No water within ${maxDistance} blocks — walk to a lake or river first.`);

        // Stand at the edge, not in the water: aim for a spot ~2 blocks back from the surface block.
        if (bot.entity.position.distanceTo(water.position) > 4) {
          await approach(bot, { x: water.position.x, y: water.position.y + 1, z: water.position.z });
        }
        await bot.equip(rod, 'hand');
        await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true);

        for (const i of bot.inventory.items()) before.set(i.name, (before.get(i.name) ?? 0) + i.count);
        // A bobber that hooks nothing (lily pad, shallow edge) never resolves — bound the wait.
        await Promise.race([
          bot.fish(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              bot.activateItem(); // reel in the dead cast so the next one is clean
              reject(new Error('No bite after 60s — reeled in. The bobber may have landed on a block; face open, deep water and cast again.'));
            }, 60_000);
          }),
        ]);
      } finally {
        fishing = false;
        clearTimeout(timer);
      }
      // Diff inventory so the agent learns WHAT bit, not just that the cast ended.
      const after = new Map<string, number>();
      for (const i of bot.inventory.items()) after.set(i.name, (after.get(i.name) ?? 0) + i.count);
      const gained: string[] = [];
      for (const [name, count] of after) {
        const delta = count - (before.get(name) ?? 0);
        if (delta > 0 && name !== 'fishing_rod') gained.push(`${delta}x ${name}`);
      }
      return gained.length
        ? `Caught ${gained.join(', ')}! 🎣`
        : 'Cast ended with nothing in inventory — the catch may have dropped nearby (collect_ground_items), or the hook was pulled early.';
    },
  });

  const enchantItem = tool({
    name: 'enchant_item',
    description:
      "Enchant an item at a nearby enchanting table. Needs lapis_lazuli + XP levels. Without 'choice': places the item and returns the 3 enchantment options (choice index + XP level cost). With 'choice' (0-2): performs that enchantment and returns the item to inventory.",
    inputSchema: z.object({
      item: z.string().describe("Inventory item to enchant, e.g. 'diamond_sword', 'book'"),
      choice: z.number().optional().describe('Option index 0-2 from a previous list call; omit to list options'),
      range: z.number().default(16).describe('how far to search for the enchanting table, in blocks'),
    }),
    callback: async ({ item, choice, range }) => {
      const invItem = inventoryItem(bot, item);
      const tableBlock = bot.findBlock({ matching: bot.registry.blocksByName.enchanting_table.id, maxDistance: range });
      if (!tableBlock) throw new Error(`No enchanting_table within ${range} blocks.`);
      const lapis = bot.inventory.items().find((i) => i.name === 'lapis_lazuli');
      if (!lapis && bot.game.gameMode !== 'creative') throw new Error('No lapis_lazuli in inventory — enchanting needs 1-3 lapis.');
      await approach(bot, tableBlock.position);
      const table = await bot.openEnchantmentTable(tableBlock);
      try {
        await table.putTargetItem(invItem);
        if (lapis) await table.putLapis(lapis);
        // Options stream in via window-property packets after the item lands.
        if (!table.enchantments.some((e) => e.level > 0)) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5000);
            table.once('ready', () => { clearTimeout(t); resolve(); });
          });
        }
        const options = table.enchantments.map((e, i) => ({ choice: i, xpLevelCost: e.level, available: e.level > 0 }));
        if (choice === undefined) {
          await table.takeTargetItem();
          return { options, note: `Your XP level: ${bot.experience.level}. Call again with choice=N to enchant.` };
        }
        const opt = table.enchantments[choice];
        if (!opt || opt.level <= 0) throw new Error(`Choice ${choice} not available. Options: ${JSON.stringify(options)}`);
        if (bot.experience.level < opt.level) throw new Error(`Need XP level ${opt.level}, you have ${bot.experience.level}.`);
        const result = await table.enchant(choice);
        await table.takeTargetItem();
        return `Enchanted ${item} (cost: level ${opt.level}). Got: ${result.name}${result.enchants?.length ? ` with ${result.enchants.map((e: { name: string; lvl: number }) => `${e.name} ${e.lvl}`).join(', ')}` : ''}.`;
      } finally {
        table.close();
      }
    },
  });

  const anvilCombine = tool({
    name: 'anvil_use',
    description:
      "Use a nearby anvil to combine two items (weapon + enchanted_book, or two damaged tools to merge enchants/repair) or rename one item. Costs XP levels.",
    inputSchema: z.object({
      action: z.enum(['combine', 'rename']),
      item: z.string().describe('First item (the one being improved/renamed)'),
      withItem: z.string().optional().describe("Second item to sacrifice (required for 'combine')"),
      name: z.string().optional().describe('New display name (required for rename, optional for combine)'),
      range: z.number().default(16).describe('how far to search for the anvil, in blocks'),
    }),
    callback: async ({ action, item, withItem, name, range }) => {
      const first = inventoryItem(bot, item);
      const anvilBlock = bot.findBlock({
        matching: ['anvil', 'chipped_anvil', 'damaged_anvil'].map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined),
        maxDistance: range,
      });
      if (!anvilBlock) throw new Error(`No anvil within ${range} blocks.`);
      await approach(bot, anvilBlock.position);
      const anvil = await bot.openAnvil(anvilBlock);
      try {
        if (action === 'combine') {
          if (!withItem) throw new Error("'combine' needs withItem (e.g. an enchanted_book).");
          const second = inventoryItem(bot, withItem);
          const xpBefore = bot.experience.level;
          await anvil.combine(first, second, name);
          // An anvil that refuses ("Too Expensive!", not enough levels, incompatible
          // items) leaves both items in the bag and takes nothing — and the old line
          // read as success. XP spent is the receipt.
          const spent = xpBefore - bot.experience.level;
          if (spent <= 0)
            throw new Error(
              `The anvil took no XP (still level ${bot.experience.level}), so nothing was combined — usually ` +
                `"Too Expensive!" (39+ level cost), incompatible items, or a full result slot. Both ${item} and ` +
                `${withItem} are still yours, undamaged.`,
            );
          return `Combined ${item} + ${withItem}${name ? ` as '${name}'` : ''}, confirmed by ${spent} XP level(s) spent (now ${bot.experience.level}).`;
        }
        if (!name) throw new Error("'rename' needs a name.");
        await anvil.rename(first, name);
        return `Renamed ${item} to '${name}'. XP level now ${bot.experience.level}.`;
      } finally {
        const w = bot.currentWindow;
        if (w) bot.closeWindow(w);
      }
    },
  });

  const respawn = tool({
    name: 'respawn',
    description:
      'Come back after dying (check get_status: dead=true, or actions failing with weird errors). Respawns at bed/world spawn — your items stayed where you died, go collect them fast.',
    callback: async () => {
      if ((bot.health ?? 20) > 0) return `Not dead (health ${bot.health}) — no respawn needed.`;
      const deathPos = bot.entity.position.clone();
      await bot.respawn();
      // Believing you are alive while the server still has you dead is the worst
      // version of this bug: every following action fails with an unrelated error
      // and the model debugs the wrong thing. Wait for health to come back.
      const alive = await waitFor(() => (bot.health ?? 0) > 0, 3000);
      if (!alive)
        throw new Error(
          `Still dead — the respawn was not acknowledged (health ${bot.health}). Every other action will fail with ` +
            `confusing errors until this succeeds: call respawn again.`,
        );
      return `Respawned at ${fmtPos(bot.entity.position)} with ${bot.health}/20 health. Died at ${fmtPos(deathPos)} — ` +
        `dropped items despawn in ~5 minutes.`;
    },
  });

  const activateEntity = tool({
    name: 'activate_entity',
    description:
      "Right-click an entity with an EMPTY interaction (not using an item): open a villager's trade UI manually, sit a dog, take a leash point… For using a held ITEM on an entity (name_tag, saddle, shears, breeding food) use use_item with entity= instead.",
    inputSchema: z.object({
      entity: z.string().describe('Entity name or id nearby'),
    }),
    callback: async ({ entity }) => {
      const target = resolveEntity(bot, entity);
      await approach(bot, target.position, { within: 4 });
      const before = bagCounts(bot);
      await bot.activateEntity(target);
      const changed = bagDelta(before, bagCounts(bot));
      return `Activated ${entity}.` +
        (changed === 'nothing'
          ? ' Nothing moved in your bag — expected for sitting a dog or opening a UI, but it is also what a click ' +
            'that did nothing looks like: confirm with look_around rather than repeating it.'
          : ` Inventory change: ${changed}.`);
    },
  });

  return [openContainer, furnaceTransact, tradeVillager, fish, enchantItem, anvilCombine, respawn, activateEntity, sleep, wake];
}

export function chatTools(bot: Bot) {
  const say = tool({
    name: 'say_in_chat',
    description: 'Say something in the public game chat. Everyone on the server sees it.',
    inputSchema: z.object({ message: z.string().max(256) }),
    callback: ({ message }) => {
      bot.chat(message);
      return 'Sent.';
    },
  });

  const whisper = tool({
    name: 'whisper',
    description: 'Send a private message to one player.',
    inputSchema: z.object({ username: z.string(), message: z.string().max(256) }),
    callback: ({ username, message }) => {
      bot.whisper(username, message);
      return `Whispered to ${username}.`;
    },
  });

  return [say, whisper];
}

import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { itemByName, inventoryItem, resolveEntity, vec, fmtPos, approach, bestFood, describeMissing, verifyEquip, waitFor, settledRead, equippedName, bagCounts, bagDelta } from './helpers.js';
import { countOf, verifyCraftStep } from './craft-verify.js';
import { cfg } from '../config.js';
import prismarineItem, { Item as PrismarineItemClass } from 'prismarine-item';
// CJS module.exports IS the loader; NodeNext types the default import as the namespace.
const itemLoader = prismarineItem as unknown as (registry: unknown) => typeof PrismarineItemClass;

export function inventoryTools(bot: Bot) {
  const equipItem = tool({
    name: 'equip_item',
    description:
      "Equip an inventory item: to 'hand' (tools/weapons/blocks), 'off-hand', or armor slots 'head'/'torso'/'legs'/'feet'.",
    inputSchema: z.object({
      item: z.string().describe("Item name, e.g. 'iron_pickaxe', 'diamond_helmet'"),
      destination: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']).default('hand'),
    }),
    callback: async ({ item, destination }) => {
      const invItem = inventoryItem(bot, item);
      await bot.equip(invItem, destination);
      // Look at the slot before claiming it (see verifyEquip): a dropped window
      // click is silent, and a bot that believes it is armored fights differently.
      const { late } = await verifyEquip(bot, invItem.name, destination);
      return `Equipped ${invItem.name} to ${destination}, confirmed in the slot.` +
        (late ? ' (The server was slow to confirm; verified by re-reading the slot.)' : '');
    },
  });

  const tossItem = tool({
    name: 'toss_item',
    description: 'Throw items from inventory onto the ground (e.g. to give to a player standing nearby).',
    inputSchema: z.object({
      item: z.string(),
      count: z.number().optional().describe('How many (default: whole stack)'),
    }),
    callback: async ({ item, count }) => {
      const invItem = inventoryItem(bot, item);
      const asked = count ?? invItem.count;
      const count0 = () => countOf(bot.inventory.items(), invItem.name);
      const before = count0();
      if (count) await bot.toss(invItem.type, null, count);
      else await bot.tossStack(invItem);
      // Tossing is a packet like any other, and "gave the player 32 iron" is a
      // claim worth checking before a trade is considered settled: count the bag.
      // But count it SETTLED (issue #48) — mineflayer's window click mutates the
      // local mirror immediately, so the count one frame later can be our own
      // intent, with the server's rejection still in flight.
      const { after: left, rolledBack } = await settledRead(count0, before, {
        budgetMs: cfg.tools.confirmMs,
        holdMs: cfg.tools.settleMs,
      });
      const gone = before - left;
      if (gone <= 0)
        throw new Error(
          rolledBack
            ? `The server did not accept the toss — you still hold ${left}x ${invItem.name}; it was put straight ` +
              `back. (This client's bag briefly showed it gone, but that was our own click, not the server's answer.) ` +
              `Nothing was lost. Retry once; if it fails again, open and close a container to force an inventory resync.`
            : `Nothing left your inventory — you still hold ${left}x ${invItem.name}, so the toss was not accepted. ` +
              `Nothing was lost; retry, and if it fails again move a step and retry.`,
        );
      return `Tossed ${gone}x ${invItem.name} onto the ground` +
        (gone < asked ? ` (asked for ${asked}; that was what left the bag)` : '') +
        `. You still hold ${left}. They are ITEMS ON THE GROUND until someone walks over them — ` +
        `not received by anyone yet.`;
    },
  });

  const craftItem = tool({
    name: 'craft_item',
    description:
      "Craft an item by name, CHAINING intermediate recipes automatically: asking for 'wooden_pickaxe' with only logs crafts planks → sticks → pickaxe in one call. Uses a nearby crafting table when a recipe needs one (within 4 blocks — walk to one first for 3x3 recipes). If materials are missing it names EXACTLY what to gather and how many, so gather then re-call.",
    inputSchema: z.object({
      item: z.string().describe("What to craft, e.g. 'crafting_table', 'wooden_pickaxe', 'torch'"),
      count: z.number().default(1),
    }),
    callback: async ({ item, count }) => {
      const itemType = itemByName(bot, item);
      const tableBlock = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table?.id, maxDistance: 4 });
      // When the plan fails for want of a table, the error states WHERE the
      // nearest one actually is (a fact) instead of ordering a remedy — the
      // model may walk there, craft a new one, or change plans (HARDCODING c3).
      const tableFact = () => {
        const far = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table?.id, maxDistance: 32 });
        return far
          ? `; no crafting table in reach (needs <=4 blocks) — nearest is at ${fmtPos(far.position)}, ${bot.entity.position.distanceTo(far.position).toFixed(0)} blocks away; 3x3 recipes are invisible without one`
          : '; no crafting table within 32 blocks; 3x3 recipes are invisible without one';
      };
      const nameOf = (id: number) => (bot.registry as unknown as { items: Record<number, { name: string }> }).items[id]?.name ?? `item#${id}`;

      // Virtual inventory: what we'd hold as the chain progresses.
      const have = new Map<string, number>();
      for (const i of bot.inventory.items()) have.set(i.name, (have.get(i.name) ?? 0) + i.count);

      type Recipe = ReturnType<Bot['recipesAll']>[number];
      type Step = { recipe: Recipe; times: number; makes: string };
      const missing = new Map<string, number>();
      const ingredientsOf = (r: Recipe): Map<number, number> => {
        const need = new Map<number, number>();
        const d = r.delta ?? [];
        for (const { id, count: c } of d) if (c < 0) need.set(id, (need.get(id) ?? 0) - c);
        return need;
      };

      /** Plan to obtain `qty` of `name`, consuming the virtual inventory,
       *  recursing into sub-recipes, recording true leaves as missing.
       *  Returns steps deepest-first (dependencies before dependents). */
      const plan = (name: string, qty: number, depth: number): Step[] => {
        const inStock = have.get(name) ?? 0;
        const take = Math.min(inStock, qty);
        if (take > 0) have.set(name, inStock - take);
        const short = qty - take;
        if (short <= 0) return [];
        if (depth > 4) { missing.set(name, (missing.get(name) ?? 0) + short); return []; }

        const type = (bot.registry as unknown as { itemsByName: Record<string, { id: number }> }).itemsByName[name];
        const recipes = type ? bot.recipesAll(type.id, null, tableBlock) : [];
        if (recipes.length === 0) { // a true leaf — logs, ore, string… go gather it
          missing.set(name, (missing.get(name) ?? 0) + short);
          return [];
        }
        // Recipes come in variants (a pickaxe: oak/birch/… planks) — sometimes
        // MANY: crafting_table lists 11 plank variants, and minecraft-data's
        // ordering is arbitrary (cherry first, oak near the end). Never cap the
        // list — an arbitrary slice(0, 8) once hid the birch path entirely and
        // reported 'gather cherry_log' to a bot holding a stack of birch logs.
        // Instead, SORT by satisfiability: score each variant by what fraction
        // of its direct ingredients the virtual inventory already covers, and
        // try the best-scoring first. That both finds the right wood
        // immediately and cuts wasted recursion into hopeless variants.
        const score = (r: Recipe): number => {
          let covered = 0, wanted = 0;
          for (const [ingId, per] of ingredientsOf(r)) {
            wanted += per;
            covered += Math.min(have.get(nameOf(ingId)) ?? 0, per);
          }
          return wanted === 0 ? 0 : covered / wanted;
        };
        const ordered = recipes
          .map((r, i) => ({ r, i, s: score(r) }))
          .sort((a, b) => b.s - a.s || a.i - b.i) // stable: registry order breaks ties
          .map((x) => x.r);
        // Try each against a SNAPSHOT of the virtual inventory and keep the
        // first that plans with nothing missing. If every variant falls short,
        // keep the first attempt (now the best-covered one) for honest reporting.
        const missTotal = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
        let fallback: { steps: Step[]; have: Map<string, number>; missing: Map<string, number> } | null = null;
        for (const recipe of ordered) {
          const haveSnap = new Map(have);
          const missSnap = new Map(missing);
          const perCraft = recipe.result.count;
          const times = Math.ceil(short / perCraft);
          const steps: Step[] = [];
          for (const [ingId, per] of ingredientsOf(recipe))
            steps.push(...plan(nameOf(ingId), per * times, depth + 1));
          steps.push({ recipe, times, makes: name });
          const surplus = times * perCraft - short;
          if (surplus > 0) have.set(name, (have.get(name) ?? 0) + surplus);
          if (missTotal(missing) === missTotal(missSnap)) return steps; // planned clean
          if (!fallback) fallback = { steps, have: new Map(have), missing: new Map(missing) };
          // roll back and try the next variant
          have.clear(); for (const [k, v] of haveSnap) have.set(k, v);
          missing.clear(); for (const [k, v] of missSnap) missing.set(k, v);
        }
        have.clear(); for (const [k, v] of fallback!.have) have.set(k, v);
        missing.clear(); for (const [k, v] of fallback!.missing) missing.set(k, v);
        return fallback!.steps;
      };

      const steps = plan(itemType.name, count, 0);
      if (missing.size > 0) {
        // Species-specific names become family advice: 'gather 1x cherry_log'
        // sent a bot on a cherry pilgrimage through a birch forest once.
        const list = describeMissing(missing).join('; ');
        throw new Error(`Cannot craft ${count}x ${item} — gather first: ${list}. (Chain considered: ${steps.length ? steps.map((s) => s.makes).join(' → ') : 'no craftable path'}${tableBlock ? '' : tableFact()})`);
      }

      const crafted: string[] = [];
      for (const step of steps) {
        // Re-resolve against the LIVE inventory: the virtual plan said this is
        // possible, but bot.craft needs the recipe instance that matches now.
        // recipesFor returns every craftable-now variant — [0] may be a
        // DIFFERENT wood than the plan chose, so prefer the planned recipe if
        // it's in the live list, else the live variant whose ingredients are
        // all in stock (they all are, by recipesFor's contract — keep [0]).
        const stepType = (bot.registry as unknown as { itemsByName: Record<string, { id: number }> }).itemsByName[step.makes];
        const live = bot.recipesFor(stepType.id, null, 1, tableBlock);
        const planned = live.find((r) => {
          const want = ingredientsOf(step.recipe);
          const got = ingredientsOf(r);
          if (want.size !== got.size) return false;
          for (const [id, c] of want) if (got.get(id) !== c) return false;
          return true;
        });
        const useRecipe = planned ?? live[0] ?? step.recipe;
        // 1.21.5+ servers can silently reject the craft's container clicks
        // while the LOCAL model still consumes the ingredients (#3906 —
        // per-window stateId vs mineflayer's global one; dropped foreign-wid
        // packets both directions). Never trust bot.craft's resolution:
        // verify the delta landed, resync from the server on doubt, and
        // throw the truth instead of letting the agent believe planks
        // evaporated. verifyCraftStep throws on a genuine rejection.
        const beforeCount = countOf(bot.inventory.items(), step.makes);
        const expectedDelta = step.times * useRecipe.result.count;
        await bot.craft(useRecipe, step.times, tableBlock ?? undefined);
        const note = await verifyCraftStep(bot, step.makes, beforeCount, expectedDelta);
        crafted.push(`${step.times * step.recipe.result.count}x ${step.makes}${note}`);
      }
      if (crafted.length === 0) return `Already had ${count}x ${item} — nothing to craft.`;
      return `Crafted ${crafted.join(' → ')}${tableBlock ? ' using the crafting table' : ''}${crafted.length > 1 ? ' (chained intermediates automatically)' : ''}.`;
    },
  });

  const eat = tool({
    name: 'eat',
    description:
      'Eat food from inventory to restore hunger. With no item named, picks the best fit itself: the biggest meal that does not overshoot your missing hunger — and never auto-picks risky food (rotten flesh, raw chicken, pufferfish) or precious food (golden apples, chorus fruit); name those explicitly when you mean it.',
    inputSchema: z.object({
      item: z.string().optional().describe("Food item name — omit to auto-pick the best fit from your inventory"),
    }),
    callback: async ({ item }) => {
      if ((bot.food ?? 20) >= 20 && !item) return 'Food is already 20/20 — eating now would waste the meal.';
      let chosen = item;
      if (!chosen) {
        chosen = bestFood(bot.inventory.items().map((i) => i.name), 20 - (bot.food ?? 20));
        if (!chosen) {
          const edible = bot.inventory.items().map((i) => i.name)
            .filter((n) => ['rotten_flesh', 'chicken', 'spider_eye', 'poisonous_potato', 'pufferfish', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'suspicious_stew'].includes(n));
          throw new Error(
            edible.length
              ? `No safe ordinary food in inventory. You DO carry: ${[...new Set(edible)].join(', ')} — risky or precious; eat one BY NAME if the situation justifies it.`
              : 'No food in inventory at all. Hunt, fish, harvest, or ask a player.'
          );
        }
      }
      const invItem = inventoryItem(bot, chosen);
      const foodBefore = bot.food;
      await bot.equip(invItem, 'hand');
      await bot.consume();
      // bot.food is the server's last word, and that word arrives AFTER consume
      // resolves — reading it immediately reports the hunger you had before the
      // meal, which is how a bot talks itself into eating twice. Wait for the
      // update, and if it never comes, say that instead of inventing a number.
      const fed = await waitFor(() => bot.food > foodBefore, 1500);
      return `Ate ${chosen}${item ? '' : ' (auto-picked for fit)'}. ` +
        (fed
          ? `Food is now ${bot.food}/20 (was ${foodBefore}).`
          : `The server has not sent a food update yet — it was ${foodBefore}/20 before eating; re-check with get_status rather than eating again.`);
    },
  });

  /**
   * ONE right-click verb (HARDCODING.md c5). This was three tools —
   * use_held_item / use_item_on_block / use_item_on_entity — which made the
   * model pick a variant before it thought about the act. Same verb, same
   * packet family; the TARGET is a parameter, not a tool name.
   */
  const useItem = tool({
    name: 'use_item',
    description:
      "Right-click ('use') an item — one verb, any target. " +
      "NO target: use the held item in place, holding the button for holdMs (full bow draw ~1000ms, crossbow load ~1250ms, shield/eating = hold, snowball/ender pearl = instant); pass aimAt to aim at an entity first (shoot a skeleton). " +
      "WITH x,y,z: use the item on that block (fill/empty a bucket, flint_and_steel, bone_meal a crop, put out a campfire) — equips it, walks into range, looks at it, right-clicks. " +
      "WITH entity: touch-use on that entity (shear a sheep, breed animals with food, saddle a horse) — reports the inventory delta, which is where the interaction's effect shows.",
    inputSchema: z.object({
      item: z.string().optional().describe("Item to equip first, e.g. 'water_bucket', 'flint_and_steel', 'shears'. Omit = use whatever is held"),
      entity: z.string().optional().describe('Use ON this entity by touch (shear, breed, saddle…) — not for aiming, see aimAt'),
      x: z.number().optional().describe('Use ON the block at x,y,z (all three required together)'),
      y: z.number().optional(),
      z: z.number().optional(),
      holdMs: z.number().default(1200).describe('No-target use only: how long to hold the use button (ms). 1000+ = full bow charge; 0 = instant click'),
      aimAt: z.string().optional().describe('No-target use only: entity/player to aim at before using (bows, snowballs, pearls)'),
      offHand: z.boolean().default(false).describe('No-target use only: activate the off-hand item'),
    }),
    callback: async ({ item, entity, x, y, z: zc, holdMs, aimAt, offHand }) => {
      // ---- on a BLOCK --------------------------------------------------------
      const coords = [x, y, zc].filter((c) => c !== undefined).length;
      if (coords > 0 && coords < 3) throw new Error('A block target needs all three of x, y, z.');
      if (coords === 3) {
        const block = bot.blockAt(vec({ x: x!, y: y!, z: zc! }));
        if (!block) throw new Error(`No block loaded at ${fmtPos({ x: x!, y: y!, z: zc! })}`);
        if (item) await bot.equip(inventoryItem(bot, item), 'hand');
        const using = item ?? bot.heldItem?.name ?? 'empty hand';
        await approach(bot, block.position);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        // Liquids are not right-clickable blocks — bucket interactions go through item activation.
        if (/bucket/.test(using) || block.name === 'water' || block.name === 'lava') {
          bot.activateItem();
          await new Promise((r) => setTimeout(r, 300));
          bot.deactivateItem();
        } else {
          await bot.activateBlock(block);
        }
        const nowHeld = bot.heldItem?.name ?? 'empty hand';
        return `Used ${using} on ${block.name} at ${fmtPos({ x: x!, y: y!, z: zc! })}. Now holding: ${nowHeld}.`;
      }
      // ---- on an ENTITY ------------------------------------------------------
      if (entity) {
        const target = resolveEntity(bot, entity);
        if (item) await bot.equip(inventoryItem(bot, item), 'hand');
        const held = bot.heldItem?.name ?? 'empty hand';
        const before = bagCounts(bot);
        await bot.useOn(target);
        // Shearing yields wool, breeding consumes the food, saddling consumes the
        // saddle — the interaction's whole point shows up in the bag, so measure it
        // rather than reporting that a packet was sent (issues #27/#28's rule).
        await waitFor(() => bagDelta(before, bagCounts(bot)) !== 'nothing', 1200);
        const changed = bagDelta(before, bagCounts(bot));
        return `Used ${held} on ${entity}. Inventory change: ${changed}.` +
          (changed === 'nothing'
            ? ' Nothing moved in your bag: either the interaction had no item effect (taming, love mode, mounting) ' +
              'or the click did nothing at all — check the entity with look_around before repeating it.'
            : '');
      }
      // ---- held, no target ---------------------------------------------------
      if (item) await bot.equip(inventoryItem(bot, item), 'hand');
      if (aimAt) {
        const target = resolveEntity(bot, aimAt);
        // Aim slightly above center mass — bow arrows drop over distance.
        const dist = bot.entity.position.distanceTo(target.position);
        await bot.lookAt(target.position.offset(0, (target.height ?? 1.6) * 0.8 + dist * 0.01, 0), true);
      }
      bot.activateItem(offHand);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 10000)));
      bot.deactivateItem();
      return `Used ${bot.heldItem?.name ?? 'held item'} (held ${holdMs}ms${aimAt ? `, aimed at ${aimAt}` : ''}).`;
    },
  });

  const unequip = tool({
    name: 'unequip',
    description: "Remove equipment from a slot (take off armor, empty the hand/off-hand) back into inventory.",
    inputSchema: z.object({
      destination: z.enum(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']),
    }),
    callback: async ({ destination }) => {
      const was = equippedName(bot, destination);
      if (!was) return `Nothing was in your ${destination} slot — nothing to take off.`;
      await bot.unequip(destination);
      // Armor that is still worn after "Unequipped" is how a bot walks into lava
      // wearing the boots it thinks it took off. Read the slot back.
      // …and read it back SETTLED (issue #48): an empty slot one frame after the
      // click is our own click, with the server's refusal still in flight.
      const empty = () => (equippedName(bot, destination) === null ? 0 : 1);
      const { after, rolledBack } = await settledRead(empty, 1, {
        budgetMs: cfg.tools.confirmMs,
        holdMs: cfg.tools.settleMs,
      });
      if (after !== 0)
        throw new Error(
          `${destination} still holds ${equippedName(bot, destination)} — the unequip click was not accepted ` +
            `(1.21.5+ window desync). ` +
            (rolledBack ? `The slot did read empty for a moment; that was our own click, not the server's answer. ` : '') +
            `Nothing was lost. Retry once, or open and close a container to force a resync.`,
        );
      return `Took ${was} off your ${destination} slot; it is back in your inventory.`;
    },
  });

  const writeBook = tool({
    name: 'write_book',
    description:
      "Write pages into a writable_book (book and quill) in inventory. Each page holds ~256 chars. To sign it permanently you'd need the book edit GUI — this writes draft content.",
    inputSchema: z.object({
      pages: z.array(z.string()).max(50).describe('Page texts, one string per page'),
    }),
    callback: async ({ pages }) => {
      const book = bot.inventory.items().find((i) => i.name === 'writable_book');
      if (!book) throw new Error('No writable_book in inventory — craft one (book + ink_sac + feather).');
      await bot.writeBook(book.slot, pages);
      return `Wrote ${pages.length} page(s) into the book.`;
    },
  });

  const creativeInventory = tool({
    name: 'creative_inventory',
    description:
      "Creative-mode inventory magic: 'give' spawns any item into the first free hotbar slot, 'clear' empties the whole inventory. Fails outside creative mode.",
    inputSchema: z.object({
      action: z.enum(['give', 'clear']),
      item: z.string().optional().describe("Item to give, e.g. 'diamond_pickaxe' (required for 'give')"),
      count: z.number().default(1),
    }),
    callback: async ({ action, item, count }) => {
      if (bot.game.gameMode !== 'creative') {
        throw new Error(`creative_inventory needs creative mode (currently ${bot.game.gameMode}).`);
      }
      if (action === 'clear') {
        await bot.creative.clearInventory();
        return 'Inventory cleared.';
      }
      if (!item) throw new Error("'give' needs an item name.");
      const def = itemByName(bot, item);
      // Hotbar = window slots 36-44; pick the first empty one.
      let slot = -1;
      for (let s = 36; s <= 44; s++) if (!bot.inventory.slots[s]) { slot = s; break; }
      if (slot === -1) throw new Error('Hotbar is full — toss_item or creative_inventory clear first.');
      const Item = itemLoader(bot.registry);
      await bot.creative.setInventorySlot(slot, new Item(def.id, Math.min(count, def.stackSize ?? 64)));
      return `Gave ${count}x ${item} (hotbar slot ${slot - 36}).`;
    },
  });

  return [equipItem, tossItem, craftItem, eat, useItem, unequip, writeBook, creativeInventory];
}

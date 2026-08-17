import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { Vec3 } from 'vec3';
import { blockByName, inventoryItem, vec, fmtPos, placeAt, approach, digHazards, walkTo, bagCounts, bagDelta, confirmBroken } from './helpers.js';
import { draftStructure, blockSatisfies, type PlanBlock } from './blueprints.js';

export function worldTools(bot: Bot) {
  /** Bound hazard probe both dig tools share. */
  const hazardsAt = (p: { x: number; y: number; z: number }) =>
    digHazards(p, (hx, hy, hz) => bot.blockAt(new Vec3(hx, hy, hz))?.name, bot.entity?.position);

  const digBlock = tool({
    name: 'dig_block',
    description:
      'Dig (mine) the block at exact coordinates. Walks into range first if needed. Equip the right tool first for speed (see equip_item). ' +
      'Refuses digs that would hurt you (adjacent lava/water, gravel column overhead, mining your own support over a drop) — pass force=true after handling or accepting the hazard.',
    inputSchema: z.object({
      x: z.number(), y: z.number(), z: z.number(),
      force: z.boolean().optional().describe('dig despite detected hazards'),
    }),
    callback: async ({ x, y, z, force }) => {
      const block = bot.blockAt(vec({ x, y, z }));
      if (!block) throw new Error(`No block loaded at ${fmtPos({ x, y, z })}`);
      if (!force) {
        const hazards = hazardsAt({ x, y, z });
        if (hazards.length) throw new Error(
          `Refusing to dig ${block.name} at ${fmtPos({ x, y, z })}:\n- ${hazards.join('\n- ')}\n` +
          `Handle it first (place a block against the liquid, step aside, clear the column top-down) or pass force=true to accept the risk.`
        );
      }
      if (!bot.canDigBlock(block)) {
        // Bounded walk; if it fails, the canDigBlock re-check below reports the
        // honest 'unreachable' instead of the tool hanging on a doomed route.
        await walkTo(bot, new goals.GoalNear(x, y, z, 3), { x, y, z });
      }
      const target = bot.blockAt(vec({ x, y, z }));
      if (!target || !bot.canDigBlock(target)) throw new Error(`Cannot dig ${block.name} at ${fmtPos({ x, y, z })} — unreachable or protected.`);
      const bagBefore = bagCounts(bot);
      await bot.dig(target);
      // A resolved dig is not a broken block (issue #48) — see confirmBroken.
      if (!(await confirmBroken(bot, vec({ x, y, z }), target.name)))
        throw new Error(
          `${target.name} at ${fmtPos({ x, y, z })} is STILL THERE — the dig call resolved, but mineflayer resolves on ` +
            `any block update at the target and the update was the server putting the block back. Nothing was mined and ` +
            `nothing was lost. Usually a protected area, a tool the server does not accept for this block, or a stale ` +
            `window: try a different block, or a proper tool, and do not plan around a drop that does not exist.`,
        );
      const gained = bagDelta(bagBefore, bagCounts(bot));
      return `Dug ${block.name} at ${fmtPos({ x, y, z })}. Inventory change: ${gained}.` +
        (gained === 'nothing' ? ' The drop is on the ground (or there was none) — walk over it / collect_ground_items before counting it as yours.' : '');
    },
  });

  const collectNearby = tool({
    name: 'collect_ground_items',
    description: 'Walk over nearby dropped items on the ground to pick them up (within radius).',
    inputSchema: z.object({ radius: z.number().default(8) }),
    callback: async ({ radius }) => {
      const drops = Object.values(bot.entities)
        .filter((e) => e.name === 'item' && !!e.position && bot.entity.position.distanceTo(e.position) <= radius)
        .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
      if (drops.length === 0) return 'No dropped items nearby.';
      const bagBefore = bagCounts(bot);
      let collected = 0;
      for (const drop of drops.slice(0, 10)) {
        try {
          // Drops are close and cheap; one that cannot be walked to in 8s of
          // no-progress is not worth the mind's time — move to the next drop.
          const p = drop.position;
          const r = await walkTo(bot, new goals.GoalNear(p.x, p.y, p.z, 0.5), p, { stallMs: 8_000, deadlineMs: 30_000 });
          if (!r.startsWith('COULD NOT REACH')) collected++;
        } catch {
          /* item may despawn or be unreachable — keep going */
        }
      }
      // 'Walked over' is a route; the bag is the result.
      const gained = bagDelta(bagBefore, bagCounts(bot));
      return `Walked over ${collected}/${drops.length} item drops. Inventory change: ${gained}.` +
        (gained === 'nothing' ? ' Nothing was picked up — a full inventory, a drop out of reach, or it despawned.' : '');
    },
  });

  const digVein = tool({
    name: 'dig_vein',
    description:
      "Mine an ENTIRE connected vein/trunk in one call — the companion to find_blocks clusters. Start it at any block of the vein (find_blocks gives the position); it digs that block, then keeps digging every connected block of the same kind as digging reveals them, walking as needed. Use for ore veins, tree trunks, gravel/sand patches. Returns how many it dug and what stopped it. Equip the right tool first for speed; drops are collected at the end.",
    inputSchema: z.object({
      x: z.number(), y: z.number(), z: z.number(),
      also: z.string().optional().describe("Extra block names that count as the same vein, comma-separated — e.g. 'deepslate_coal_ore' when starting on coal_ore"),
      maxBlocks: z.number().default(32).describe('Safety cap (default 32) — a tree is ~6, most veins < 20'),
      timeoutSec: z.number().default(90).describe('Give up after this long (default 90s)'),
    }),
    callback: async ({ x, y, z, also, maxBlocks, timeoutSec }) => {
      const bagBefore = bagCounts(bot);
      const start = bot.blockAt(vec({ x, y, z }));
      if (!start) throw new Error(`No block loaded at ${fmtPos({ x, y, z })}`);
      if (start.boundingBox === 'empty') throw new Error(`Nothing to dig at ${fmtPos({ x, y, z })} — it is ${start.name}. find_blocks gives fresh positions.`);
      const match = new Set([start.name, ...(also ?? '').split(',').map((s) => s.trim()).filter(Boolean)]);

      const deadline = Date.now() + timeoutSec * 1000;
      const queue: Vec3[] = [start.position];
      const queued = new Set([start.position.toString()]);
      let dug = 0;
      let failures = 0;
      let why = 'vein exhausted';
      let unbroken = 0;
      const skippedHazard: string[] = [];

      while (queue.length) {
        if (dug >= maxBlocks) { why = `hit the ${maxBlocks}-block cap (vein continues — call again to keep going)`; break; }
        if (Date.now() > deadline) { why = `timed out after ${timeoutSec}s`; break; }
        const pos = queue.shift()!;
        const block = bot.blockAt(pos);
        if (!block || !match.has(block.name)) continue; // already dug, or was never ours
        // Veins meet lava constantly (diamonds live at lava level) — skip the
        // hazardous block, keep eating the safe side, and say what was left.
        const hazards = hazardsAt(pos);
        if (hazards.length) { skippedHazard.push(`${fmtPos(pos)}: ${hazards[0]}`); continue; }
        try {
          if (!bot.canDigBlock(block)) await approach(bot, pos, { within: 4.5 });
          const target = bot.blockAt(pos);
          if (!target || !match.has(target.name)) continue;
          if (!bot.canDigBlock(target)) { failures++; continue; } // unreachable corner — skip, keep the vein going
          await bot.dig(target);
          // Count only blocks the world agrees are gone (issue #48): a refused
          // dig resolves exactly like an accepted one, and an inflated `dug`
          // becomes "mined 6 iron" in the journal for ore still in the wall.
          if (!(await confirmBroken(bot, pos, target.name))) {
            unbroken++;
            if (++failures >= 3) { why = 'three digs in a row resolved without breaking the block — the server is refusing them'; break; }
            continue;
          }
          dug++;
          failures = 0;
        } catch {
          if (++failures >= 3) { why = 'three digs in a row failed — vein unreachable from here'; break; }
          continue;
        }
        // Digging opened new faces — enqueue matching neighbors we can now see.
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          const np = pos.offset(dx, dy, dz);
          const nk = np.toString();
          if (queued.has(nk)) continue;
          const nb = bot.blockAt(np);
          if (nb && match.has(nb.name)) { queued.add(nk); queue.push(np); }
        }
      }

      // Sweep the drops the way collect_ground_items does, without a second call.
      let collected = 0;
      const drops = Object.values(bot.entities)
        .filter((e) => e.name === 'item' && !!e.position && bot.entity.position.distanceTo(e.position) <= 8)
        .slice(0, 10);
      for (const drop of drops) {
        try {
          // Drops are close and cheap; one that cannot be walked to in 8s of
          // no-progress is not worth the mind's time — move to the next drop.
          const p = drop.position;
          const r = await walkTo(bot, new goals.GoalNear(p.x, p.y, p.z, 0.5), p, { stallMs: 8_000, deadlineMs: 30_000 });
          if (!r.startsWith('COULD NOT REACH')) collected++;
        } catch { /* despawned or unreachable */ }
      }

      // What the BAG says, not what the digging intended: 'walked over 2 drops'
      // is how a journal line came to claim 2 iron ore that was never picked up.
      const gained = bagDelta(bagBefore, bagCounts(bot));
      return `Dug ${dug} block(s) of ${[...match].join('/')} (${why}). Walked over ${collected} drop(s). ` +
        `Inventory change: ${gained}.${gained === 'nothing' && dug > 0 ? ' The drops are still on the ground — collect_ground_items, or check a full inventory.' : ''}` +
        (unbroken ? ` ${unbroken} dig(s) RESOLVED WITHOUT BREAKING the block (the server put it back) — those are not mined and not counted above.` : '') +
        (skippedHazard.length ? ` Skipped ${skippedHazard.length} hazardous: ${skippedHazard.slice(0, 4).join('; ')}${skippedHazard.length > 4 ? '; …' : ''} — handle the hazard, then dig_block those with force if wanted.` : '') +
        `${dug === 0 && !skippedHazard.length ? ' Nothing dug — is the position right?' : ''}`;
    },
  });

  const placeBlock = tool({
    name: 'place_block',
    description:
      "Place a block from your inventory at coordinates. The target position must be adjacent to an existing solid block. E.g. place 'cobblestone' at (10, 64, 10).",
    inputSchema: z.object({
      item: z.string().describe("Inventory item to place, e.g. 'dirt', 'oak_planks'"),
      x: z.number(),
      y: z.number(),
      z: z.number(),
    }),
    callback: async ({ item, x, y, z }) => {
      const r = await placeAt(bot, item, { x, y, z });
      // Say what was observed, not what was awaited (issue #27): a late packet is
      // a placed block, and the model should not treat it as a reason to retry.
      return `Placed ${item} at ${fmtPos({ x, y, z })}.` +
        (r.late ? ' (The server confirmation was late, so this was verified by looking at the block.)' : '') +
        (r.attempts > 1 ? ` Took ${r.attempts} attempts under lag.` : '');
    },
  });

  const buildBlueprint = tool({
    name: 'build_blueprint',
    description:
      'Build a multi-block structure from a plan in ONE call instead of dozens of place_block calls. ' +
      'Pass an anchor (world position of the plan\'s 0,0,0) and blocks as [{dx,dy,dz,item},…] with offsets ' +
      'relative to the anchor (dy up). Materials are checked up front (fails fast listing what\'s missing), ' +
      'placement runs bottom-up in passes so supports exist before what leans on them, and the report names ' +
      'every block that could not be placed and why. Design plans so each block touches ground or an ' +
      'earlier-placed block. Example 3-block pillar: blocks=[{dx:0,dy:0,dz:0,item:"cobblestone"},{dx:0,dy:1,dz:0,item:"cobblestone"},{dx:0,dy:2,dz:0,item:"torch"}].',
    inputSchema: z.object({
      anchor: z.object({ x: z.number(), y: z.number(), z: z.number() })
        .describe("World position the plan's (0,0,0) maps to — usually on the ground"),
      blocks: z.array(z.object({
        dx: z.number().int(), dy: z.number().int(), dz: z.number().int(),
        item: z.string().describe("Block item to place, e.g. 'oak_planks'"),
      })).min(1).max(256).describe('The plan: offsets from anchor + block name each'),
    }),
    callback: ({ anchor, blocks }) => executePlan(anchor, blocks),
  });

  /** Shared executor: build_blueprint (hand-authored art) and build_structure
   *  (drafted shells) differ only in where the plan comes from. */
  async function executePlan(anchor: { x: number; y: number; z: number }, blocks: PlanBlock[]): Promise<string> {
    {
      // Every item name must be real before anything is placed.
      for (const b of blocks) blockByName(bot, b.item);

      // Materials up front: a build that dies at block 30 of 60 leaves ruins.
      const need = new Map<string, number>();
      for (const b of blocks) need.set(b.item, (need.get(b.item) ?? 0) + 1);
      const missing: string[] = [];
      for (const [item, count] of need) {
        const have = bot.inventory.items().filter((i) => i.name === item).reduce((s, i) => s + i.count, 0);
        if (have < count) missing.push(`${item}: need ${count}, have ${have}`);
      }
      if (missing.length) throw new Error(`Missing materials — gather these first:\n${missing.join('\n')}`);

      // Duplicate offsets are a plan bug, not a runtime surprise.
      const seen = new Set<string>();
      for (const b of blocks) {
        const key = `${b.dx},${b.dy},${b.dz}`;
        if (seen.has(key)) throw new Error(`Plan places two blocks at the same offset (${key}).`);
        seen.add(key);
      }

      // Bottom-up in passes: sort by height, attempt each; a block whose
      // support isn't placed yet ('no solid neighbor') is retried next pass —
      // by then its neighbor may exist. Passes end when one changes nothing.
      type Placement = { dx: number; dy: number; dz: number; item: string };
      let pending: Placement[] = [...blocks].sort((a, b) => a.dy - b.dy || a.dx - b.dx || a.dz - b.dz);
      const failures: string[] = [];
      let placed = 0, skipped = 0;
      for (let pass = 1; pass <= 3 && pending.length; pass++) {
        const retry: Placement[] = [];
        for (const b of pending) {
          const pos = { x: anchor.x + b.dx, y: anchor.y + b.dy, z: anchor.z + b.dz };
          const existing = bot.blockAt(vec(pos));
          if (existing && blockSatisfies(b.item, existing.name)) { skipped++; continue; } // already there — resumable
          try {
            await placeAt(bot, b.item, pos);
            placed++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (pass < 3 && msg.includes('No solid neighbor')) retry.push(b);
            else failures.push(`${b.item} at ${fmtPos(pos)} (offset ${b.dx},${b.dy},${b.dz}): ${msg}`);
          }
        }
        if (retry.length === pending.length) {
          // A full pass placed nothing new — more passes won't either.
          for (const b of retry) failures.push(`${b.item} at offset ${b.dx},${b.dy},${b.dz}: no support ever appeared (floating in the plan?)`);
          pending = [];
        } else pending = retry;
      }
      // World-truth sweep: the loop above reports what placeAt CLAIMED; the
      // world can disagree by the end of the build — gravel falls, a torch
      // lands as wall_torch on the wrong face, water washes something off, a
      // creeper edits the wall while you place the roof. Re-read every plan
      // position (bot.blockAt is local chunk data — free) so 'Structure
      // complete' is a statement about the WORLD, not about our bookkeeping.
      const mismatches: string[] = [];
      for (const b of blocks) {
        const pos = { x: anchor.x + b.dx, y: anchor.y + b.dy, z: anchor.z + b.dz };
        const actual = bot.blockAt(vec(pos));
        if (!blockSatisfies(b.item, actual?.name)) {
          mismatches.push(`expected ${b.item} at ${fmtPos(pos)}, found ${actual?.name ?? 'unloaded chunk'}`);
        }
      }
      const verified = blocks.length - mismatches.length;
      const summary = `Blueprint: placed ${placed}/${blocks.length}` +
        (skipped ? `, ${skipped} already in place` : '') +
        (failures.length ? `. FAILED ${failures.length}:\n${failures.join('\n')}` : '') +
        `. World check: ${verified}/${blocks.length} positions verified` +
        (mismatches.length
          ? ` — ${mismatches.length} wrong:\n${mismatches.slice(0, 8).join('\n')}${mismatches.length > 8 ? `\n…and ${mismatches.length - 8} more` : ''}\nFix: re-run the same call (verified blocks are skipped), or dig out wrong blocks first.`
          : failures.length ? '' : '. Structure complete.');
      return summary;
    }
  }

  const buildStructure = tool({
    name: 'build_structure',
    description:
      "Draft AND build a common shell parametrically — never hand-author dozens of blueprint offsets for a basic shape. Shapes: 'box' (hollow room: walls + flat roof by default, optional floor, 1×2 doorway carved on the 'door' face), 'wall' (width×height along x), 'floor' (width×depth slab), 'pillar' (height). Anchor = world position of the plan's lowest corner (0,0,0); build faces are relative to it (south = +z). dryRun=true returns the material bill and block count WITHOUT placing — check it before gathering. Custom/artistic builds still belong to build_blueprint.",
    inputSchema: z.object({
      shape: z.enum(['box', 'wall', 'floor', 'pillar']),
      item: z.string().describe("Block to build with, e.g. 'cobblestone', 'oak_planks'"),
      anchor: z.object({ x: z.number(), y: z.number(), z: z.number() }).describe('World position of the plan origin — usually on the ground'),
      width: z.number().int().optional().describe('x-size (box/wall/floor)'),
      depth: z.number().int().optional().describe('z-size (box/floor)'),
      height: z.number().int().optional().describe('y-size (box/wall/pillar)'),
      door: z.enum(['north', 'south', 'east', 'west', 'none']).optional().describe("box: doorway face (default 'south' = +z side)"),
      roof: z.boolean().optional().describe('box: flat roof layer (default true)'),
      floor: z.boolean().optional().describe('box: floor layer (default false — usually the ground is the floor)'),
      dryRun: z.boolean().optional().describe('true = report the material bill only, place nothing'),
    }),
    callback: async ({ shape, item, anchor, width, depth, height, door, roof, floor, dryRun }) => {
      const { blocks, bill } = draftStructure({ shape, item, width, depth, height, door, roof, floor });
      const billLine = Object.entries(bill).map(([i, n]) => `${i} ×${n}`).join(', ');
      if (dryRun) return `Draft: ${blocks.length} blocks (${billLine}). Nothing placed — call again without dryRun to build.`;
      const result = await executePlan(anchor, blocks);
      return `${result} (drafted ${shape}: ${billLine})`;
    },
  });

  const activateBlock = tool({
    name: 'activate_block',
    description:
      'Right-click a block: open a door, press a button, flip a lever, open a chest/furnace UI, use a crafting table, etc.',
    inputSchema: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    callback: async ({ x, y, z }) => {
      const block = bot.blockAt(vec({ x, y, z }));
      if (!block) throw new Error(`No block at ${fmtPos({ x, y, z })}`);
      await approach(bot, block.position);
      await bot.activateBlock(block);
      return `Activated ${block.name} at ${fmtPos({ x, y, z })}.`;
    },
  });

  const placeEntity = tool({
    name: 'place_entity',
    description:
      "Place an entity item from inventory into the world: a boat on water, a minecart on rails, an armor stand, a spawn egg… Give the item name and the block position to place ON TOP of (e.g. the water surface block for a boat).",
    inputSchema: z.object({
      item: z.string().describe("Inventory item, e.g. 'oak_boat', 'minecart', 'armor_stand'"),
      x: z.number(), y: z.number(), z: z.number(),
    }),
    callback: async ({ item, x, y, z }) => {
      const invItem = inventoryItem(bot, item);
      const ref = bot.blockAt(vec({ x, y, z }));
      if (!ref) throw new Error(`No block loaded at ${fmtPos({ x, y, z })}`);
      if (ref.name === 'air') throw new Error(`${fmtPos({ x, y, z })} is air — give the surface block the entity should sit on (water for boats, rail for minecarts).`);
      await approach(bot, ref.position);
      await bot.equip(invItem, 'hand');
      const entity = await bot.placeEntity(ref, new Vec3(0, 1, 0));
      return `Placed ${item} at ${fmtPos(entity.position)} (entity id ${entity.id}). mount_entity to ride it.`;
    },
  });

  const writeSign = tool({
    name: 'write_sign',
    description:
      "Write text on a sign that's already placed (place_block a sign first). Up to 4 lines, ~15 chars each — separate lines with \\n. Read signs with inspect_block.",
    inputSchema: z.object({
      x: z.number(), y: z.number(), z: z.number(),
      text: z.string().describe('Sign text; \\n separates the (max 4) lines'),
      back: z.boolean().default(false).describe('Write the back face instead (free-standing signs only)'),
    }),
    callback: async ({ x, y, z, text, back }) => {
      const block = bot.blockAt(vec({ x, y, z }));
      if (!block) throw new Error(`No block loaded at ${fmtPos({ x, y, z })}`);
      if (!block.name.includes('sign')) throw new Error(`Block at ${fmtPos({ x, y, z })} is ${block.name}, not a sign.`);
      const lines = text.split('\n');
      if (lines.length > 4) throw new Error(`Signs hold 4 lines, got ${lines.length}.`);
      await approach(bot, block.position);
      bot.updateSign(block, text, back);
      return `Wrote ${lines.length} line(s) on the ${back ? 'back' : 'front'} of the sign at ${fmtPos({ x, y, z })}.`;
    },
  });

  return [digBlock, digVein, collectNearby, placeBlock, buildBlueprint, buildStructure, activateBlock, placeEntity, writeSign];
}

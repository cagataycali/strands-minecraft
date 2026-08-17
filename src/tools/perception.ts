import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { deathSiteDigest } from './memory.js';
import { describeBlock, describeEntity, blockByName, vec, fmtPos, darknessSurvey, oxygenReading, readArmed } from './helpers.js';

export function perceptionTools(bot: Bot) {
  const getStatus = tool({
    name: 'get_status',
    description:
      'Your vital signs and situation: position, health, food, oxygen, XP, held item, time of day, weather, dimension, game mode.',
    callback: () => {
      // Active potion effects live on the entity keyed by numeric id; the registry names them.
      const effects = Object.values(bot.entity.effects ?? {}).map((ef) => {
        const reg = (bot.registry as unknown as { effectsById?: Record<number, { displayName?: string }> }).effectsById?.[ef.id];
        return { effect: reg?.displayName ?? `effect#${ef.id}`, amplifier: ef.amplifier, secondsLeft: Math.round(ef.duration / 20) };
      });
      return {
        position: { x: +bot.entity.position.x.toFixed(1), y: +bot.entity.position.y.toFixed(1), z: +bot.entity.position.z.toFixed(1) },
        yaw: +bot.entity.yaw.toFixed(2),
        pitch: +bot.entity.pitch.toFixed(2),
        health: bot.health,
        dead: (bot.health ?? 20) <= 0,
        food: bot.food,
        // Bubbles, of 20 — raw oxygenLevel is 0/-1 on land and 0-300 underwater.
        oxygen: oxygenReading(bot.oxygenLevel)?.units ?? 'full',
        xpLevel: bot.experience.level,
        heldItem: bot.heldItem ? `${bot.heldItem.name} x${bot.heldItem.count}` : 'empty hand',
        // Issue #46: `heldItem: 'empty hand'` was already here and read as
        // nothing — the bot fought a whole night bare-fisted with this field
        // in front of it. This one states the CONSEQUENCE, and whether a
        // weapon is sitting unused in the bag.
        armed: readArmed(bot).line,
        effects: effects.length ? effects : 'none',
        timeOfDay: bot.time.timeOfDay,
        isDay: bot.time.isDay,
        moonPhase: bot.time.moonPhase,
        isRaining: bot.isRaining,
        dimension: bot.game.dimension,
        gameMode: bot.game.gameMode,
        isSleeping: bot.isSleeping,
        // #35: the mind can only avoid a grave it knows about. Present ONLY
        // when a place has killed us more than once — a field that is always
        // there is a field that is never read (the armed lesson above).
        ...(() => { const d = deathSiteDigest(); return d ? { deathSites: d } : {}; })(),
      };
    },
  });

  const lookAround = tool({
    name: 'look_around',
    description:
      'Survey the surroundings: nearby entities (players, mobs, animals, items on ground) within radius, sorted by distance, plus the block you are standing on and what is at your cursor.',
    inputSchema: z.object({
      radius: z.number().default(16).describe('Scan radius in blocks (default 16)'),
    }),
    callback: ({ radius }) => {
      const entities = Object.values(bot.entities)
        .filter((e) => !!e?.position && e.id !== bot.entity.id && bot.entity.position.distanceTo(e.position) <= radius)
        .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
        .slice(0, 25)
        .map((e) => describeEntity(bot, e));
      const standingOn = bot.blockAt(bot.entity.position.offset(0, -1, 0));
      const cursor = bot.blockAtCursor(6);
      return {
        entities,
        standingOn: standingOn ? standingOn.name : 'unknown',
        blockAtCursor: cursor ? describeBlock(cursor) : null,
        players: Object.keys(bot.players),
      };
    },
  });

  const findBlocks = tool({
    name: 'find_blocks',
    description:
      "Locate blocks by name near you. Accepts several names comma-separated ('oak_log,birch_log,spruce_log' finds ANY tree). Contiguous matches are grouped into one vein/cluster entry with its size (a tree shows once, not as 8 log results; an ore vein reports how many blocks it holds), sorted by distance. exposed=true means at least one block of the vein touches air/water — reachable without digging blind; exposed=false means it is buried, bring a tool and expect to tunnel.",
    inputSchema: z.object({
      name: z.string().describe("Block name(s), comma-separated for alternatives: 'oak_log' or 'coal_ore,deepslate_coal_ore'"),
      maxDistance: z.number().default(64).describe('Search radius (default 64)'),
      count: z.number().default(8).describe('Max veins/clusters returned (default 8)'),
    }),
    callback: ({ name, maxDistance, count }) => {
      const names = name.split(',').map((s) => s.trim()).filter(Boolean);
      const ids = names.map((n) => blockByName(bot, n).id);
      // Over-fetch raw positions: many will collapse into one cluster.
      const positions = bot.findBlocks({ matching: ids, maxDistance, count: Math.max(count * 16, 128) });
      if (positions.length === 0) return `No '${names.join("' / '")}' found within ${maxDistance} blocks.`;

      // Group contiguous finds (26-neighborhood — ore veins touch diagonally).
      const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
      const found = new Map(positions.map((p) => [key(p), p]));
      const isExposed = (p: { x: number; y: number; z: number }) => {
        for (const [dx, dy, dz] of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const) {
          const b = bot.blockAt(vec({ x: p.x + dx, y: p.y + dy, z: p.z + dz }));
          if (b && b.boundingBox === 'empty') return true;
        }
        return false;
      };
      const seen = new Set<string>();
      const clusters: Array<{ position: { x: number; y: number; z: number }; distance: number; veinSize: number; exposed: boolean; block: string }> = [];
      for (const start of positions) {
        if (seen.has(key(start))) continue;
        seen.add(key(start));
        const members = [start];
        for (let i = 0; i < members.length; i++) {
          const m = members[i];
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dy && !dz) continue;
            const nk = `${m.x + dx},${m.y + dy},${m.z + dz}`;
            const n = found.get(nk);
            if (n && !seen.has(nk)) { seen.add(nk); members.push(n); }
          }
        }
        const closest = members.reduce((a, b) =>
          bot.entity.position.distanceTo(vec(a)) <= bot.entity.position.distanceTo(vec(b)) ? a : b);
        clusters.push({
          position: { x: closest.x, y: closest.y, z: closest.z },
          distance: +bot.entity.position.distanceTo(vec(closest)).toFixed(1),
          veinSize: members.length,
          exposed: members.some(isExposed),
          block: bot.blockAt(vec(closest))?.name ?? names[0],
        });
      }
      clusters.sort((a, b) => a.distance - b.distance);
      return clusters.slice(0, count);
    },
  });

  const inspectBlock = tool({
    name: 'inspect_block',
    description: 'Examine the block at exact coordinates: what it is, whether you can dig it, how long digging takes. Signs also return their text.',
    inputSchema: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    callback: ({ x, y, z }) => {
      const block = bot.blockAt(vec({ x, y, z }));
      if (!block) return `No block loaded at ${fmtPos({ x, y, z })} (chunk not loaded?)`;
      const result: Record<string, unknown> = {
        ...describeBlock(block),
        canDig: bot.canDigBlock(block),
        digTimeMs: bot.digTime(block),
        canSee: bot.canSeeBlock(block),
      };
      if (block.name.includes('sign')) {
        const [front, back] = block.getSignText();
        result.signText = { front: front || '(blank)', back: back || '(blank)' };
      }
      return result;
    },
  });

  const listInventory = tool({
    name: 'list_inventory',
    description: 'Everything you are carrying: item names, counts, and which slot. Also shows equipped armor and held item.',
    callback: () => {
      const items = bot.inventory.items().map((i) => ({ name: i.name, count: i.count, slot: i.slot }));
      const armor = ['head', 'torso', 'legs', 'feet'].map((part) => {
        const slot = bot.getEquipmentDestSlot(part as 'head');
        const item = bot.inventory.slots[slot];
        return { part, item: item ? item.name : 'empty' };
      });
      return {
        items,
        armor,
        heldItem: bot.heldItem ? `${bot.heldItem.name} x${bot.heldItem.count}` : 'empty hand',
        armed: readArmed(bot).line, // #46: the verdict on that item list, not another copy of it
        emptySlots: bot.inventory.emptySlotCount(),
      };
    },
  });

  const findPlayer = tool({
    name: 'find_player',
    description:
      "Where is a player right now? Returns their exact coordinates and distance from you — never ask players for their own coordinates, use this. Omit username to locate ALL online players.",
    inputSchema: z.object({
      username: z.string().optional().describe('Player username; omit for everyone online'),
    }),
    callback: ({ username }) => {
      const locate = (name: string) => {
        const p = bot.players[name];
        if (!p) return { username: name, online: false };
        if (!p.entity) {
          return {
            username: name,
            online: true,
            position: null,
            note: 'Beyond my view distance — I cannot see them. Ask them to walk toward me, or explore to find them.',
          };
        }
        return {
          username: name,
          online: true,
          position: {
            x: +p.entity.position.x.toFixed(1),
            y: +p.entity.position.y.toFixed(1),
            z: +p.entity.position.z.toFixed(1),
          },
          distance: +bot.entity.position.distanceTo(p.entity.position).toFixed(1),
        };
      };
      if (username) {
        const known = Object.keys(bot.players);
        if (!bot.players[username]) {
          const match = known.find((n) => n.toLowerCase() === username.toLowerCase());
          if (match) return locate(match);
          return { username, online: false, onlinePlayers: known.filter((n) => n !== bot.username) };
        }
        return locate(username);
      }
      return Object.keys(bot.players)
        .filter((n) => n !== bot.username)
        .map(locate);
    },
  });

  const readHud = tool({
    name: 'read_hud',
    description:
      'Read server-driven HUD state: scoreboards (sidebar objectives + scores), boss bars (e.g. ender dragon or server event bars), and teams. Useful on minigame/adventure servers.',
    callback: () => {
      const scoreboards = Object.entries(bot.scoreboards ?? {}).map(([name, sb]) => ({
        name,
        title: sb.title,
        scores: Object.values(sb.itemsMap ?? {}).map((it) => ({ name: it.name, value: it.value })),
      }));
      const bossBars = ((bot as unknown as { bossBars?: Array<{ title: unknown; health: number; color: string }> }).bossBars ?? []).map((b) => ({
        title: typeof b.title === 'object' && b.title !== null ? String((b.title as { toString(): string }).toString()) : String(b.title ?? ''),
        health: b.health,
        color: b.color,
      }));
      const teams = Object.keys(bot.teams ?? {});
      return {
        scoreboards: scoreboards.length ? scoreboards : 'none',
        bossBars: bossBars.length ? bossBars : 'none',
        teams: teams.length ? teams : 'none',
      };
    },
  });

  const checkDarkness = tool({
    name: 'check_darkness',
    description:
      'Survey for hostile-spawnable darkness around you (or given coords): spots with standing room, a solid floor and block-light 0 — where mobs CAN appear at night or underground. ' +
      'Returns the dark spots AND a minimal torch plan (greedy cover): place a torch at each planned position (place_block) to spawn-proof the area. ' +
      'Use before settling in for the night, after building, or when a base keeps getting surprise visitors.',
    inputSchema: z.object({
      x: z.number().optional().describe('center (default: where you stand)'),
      y: z.number().optional(),
      z: z.number().optional(),
      radius: z.number().default(12).describe('horizontal scan radius (default 12, max 24)'),
    }),
    callback: async ({ x, y, z, radius }) => {
      const me = bot.entity.position;
      const center = { x: x ?? me.x, y: y ?? me.y, z: z ?? me.z };
      const r = Math.min(Math.max(1, radius), 24);
      // breathe = setImmediate between scan chunks and greedy picks, so the
      // 300ms reflex tick / sentinel / MJPEG loop never starve mid-survey.
      const { spots, torches, capped, lights, coveredByExisting, lightDataSuspect } = await darknessSurvey(
        center,
        r,
        (px, py, pz) => {
          const b = bot.blockAt(vec({ x: px, y: py, z: pz }));
          if (!b) return undefined; // unloaded — never report on chunks we can't see
          return {
            empty: b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava',
            solid: b.boundingBox === 'block',
            blockLight: b.light ?? 0,
            // The block's OWN emitted light, from the registry — prismarine
            // Block instances don't carry emitLight, and b.light (the level
            // the server computed) is exactly the field that lies on some
            // servers. A torch standing here is a fact; a light level is a
            // packet we may never have received.
            luminance: bot.registry.blocksByName[b.name]?.emitLight ?? 0,
          };
        },
        4,
        { breathe: () => new Promise((resolve) => setImmediate(resolve)) },
      );
      // Honesty about the evidence. On servers where block-light never
      // reaches the client, this tool used to hand back the same ~182 spots
      // and the same plan forever, so the bot re-placed torches it was
      // standing next to (live soak, 2026-08-17). Say what the survey is
      // actually based on, and always credit the lights we can see.
      const lit = `${lights.length} light source(s) already burning here` +
        (coveredByExisting ? `, covering ${coveredByExisting} spot(s) that no longer need a torch` : '');
      const caveat = lightDataSuspect
        ? ` ⚠ This server is not sending me block-light levels (every cell reads 0 even next to ${lights.length} light source(s)), so darkness here is ESTIMATED from geometry and the lights I can see — not measured. Trust your own torches: if you already lit this area, believe that over this list.`
        : '';
      if (!spots.length) {
        return `No spawnable darkness within ${r} blocks — ${lights.length ? `${lit}; the area is covered.` : 'the area is safe as lit.'}${caveat}`;
      }
      return {
        summary: `${spots.length} spawnable dark spot(s) within ${r} blocks. ${torches.length} torch(es) cover them all.${capped ? ' (Survey capped — the area is darker than one pass covers.)' : ''}`,
        alreadyLit: lights.length ? lit : 'no light sources seen in range',
        lightData: lightDataSuspect ? 'UNRELIABLE — estimated, see note' : 'measured from server light levels',
        torchPlan: torches.map((t) => ({ x: t.x, y: t.y, z: t.z })),
        note: 'Place a torch AT each torchPlan position (place_block item=torch). Positions already holding a light source are excluded, so nothing here is a torch you have already placed. Re-run after placing to verify — walls eat light, so a few spots may need one more.' +
          (capped ? ' Survey stopped at the spot cap: light this plan FIRST, then re-run to find what remains.' : '') + caveat,
        sampleSpots: spots.slice(0, 10).map(fmtPos),
      };
    },
  });

  return [getStatus, lookAround, findBlocks, inspectBlock, listInventory, findPlayer, readHud, checkDarkness];
}

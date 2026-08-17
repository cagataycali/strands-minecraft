import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { resolveEntity, vec, fmtPos, approachEntity, walkTo, waitFor } from './helpers.js';
import { legsFor, LEGS_PRIORITY } from '../legs.js';


export function movementTools(bot: Bot) {
  // The live claim behind a follow goal — released by stop_moving or by the next
  // follow, because the goal itself has no end.
  let followRelease: (() => void) | undefined;

  /**
   * ONE walk verb (HARDCODING.md c5): go_to_entity was go_to with a lookup in
   * front — a destination is a destination, coordinates or something's name.
   */
  const goTo = tool({
    name: 'go_to',
    description:
      "Walk somewhere using pathfinding (digs through obstacles if needed): x,y,z coordinates, OR an entity/player by name. Blocks until arrival or failure — long trips take several seconds. Gives up with a COULD NOT REACH report rather than hanging when the route is unsolvable. For continuous tracking of a moving target use follow_entity.",
    inputSchema: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      entity: z.string().optional().describe("Alternative destination: username, entity name, or numeric id (e.g. 'cagatay', 'cow')"),
      range: z.number().optional().describe('How close to get — default 1 block for coordinates, 2 for an entity'),
    }),
    callback: async ({ x, y, z, entity, range }) => {
      if (entity) {
        const target = resolveEntity(bot, entity);
        const p = target.position;
        // A moving target's goal tracks it; the walk deadline does not care.
        return walkTo(bot, new goals.GoalNear(p.x, p.y, p.z, range ?? 2), p, { desc: entity });
      }
      if (x === undefined || y === undefined || z === undefined) throw new Error('Provide x,y,z or entity');
      return walkTo(bot, new goals.GoalNear(x, y, z, range ?? 1), { x, y, z });
    },
  });

  const follow = tool({
    name: 'follow_entity',
    description: 'Continuously follow a player or mob (non-blocking — keeps following until stop_moving is called).',
    inputSchema: z.object({
      entity: z.string().describe('Username or entity name to follow'),
      distance: z.number().default(3).describe('Follow distance (default 3)'),
    }),
    callback: ({ entity, distance }) => {
      const target = resolveEntity(bot, entity);
      // A follow goal is the one goal that OUTLIVES its tool call, so it is the
      // worst possible thing to set on top of a flee: it re-plans every tick and
      // cancelled both paths of the live creeper_flee (issue #22). It cannot
      // await — the tool returns immediately by contract — so it refuses instead.
      const lock = legsFor(bot as unknown as object);
      const refusal = lock.deferMessage({ owner: 'follow_entity', priority: LEGS_PRIORITY.agent });
      if (refusal) return `Not following ${entity} — ${refusal}. A follow goal re-paths every tick and would cancel that. Try again once it clears.`;
      const held = lock.take({
        owner: 'follow_entity', priority: LEGS_PRIORITY.agent,
        // Long lease: the goal persists until stop_moving, and so does the claim.
        ttlMs: 120_000, what: `following ${entity}`,
      });
      followRelease?.();
      followRelease = held?.release;
      bot.pathfinder.setGoal(new goals.GoalFollow(target, distance), true);
      return `Now following ${entity}. Call stop_moving to stop.`;
    },
  });

  const stopMoving = tool({
    name: 'stop_moving',
    description: 'Stop all movement immediately: cancels pathfinding, following, and any held control states.',
    callback: () => {
      bot.pathfinder.stop();
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      // Stopping hands the legs back: a follow that ran until here held a claim.
      followRelease?.();
      followRelease = undefined;
      return 'Stopped.';
    },
  });

  const turn = tool({
    name: 'turn',
    description:
      "Turn your view by a relative amount: 'left'/'right' rotate yaw by degrees, 'up'/'down' tilt pitch. E.g. turn right 90.",
    inputSchema: z.object({
      direction: z.enum(['left', 'right', 'up', 'down']),
      degrees: z.number().default(90).describe('How many degrees (default 90)'),
    }),
    callback: async ({ direction, degrees }) => {
      const rad = (degrees * Math.PI) / 180;
      let { yaw, pitch } = bot.entity;
      if (direction === 'left') yaw += rad;
      if (direction === 'right') yaw -= rad;
      if (direction === 'up') pitch = Math.min(Math.PI / 2, pitch + rad);
      if (direction === 'down') pitch = Math.max(-Math.PI / 2, pitch - rad);
      await bot.look(yaw, pitch, true);
      return `Turned ${direction} ${degrees}°. Now yaw=${bot.entity.yaw.toFixed(2)} pitch=${bot.entity.pitch.toFixed(2)}`;
    },
  });

  const lookAt = tool({
    name: 'look_at',
    description: 'Point your head at exact coordinates, or at an entity by name.',
    inputSchema: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      entity: z.string().optional().describe('Alternative: look at this entity/player'),
    }),
    callback: async ({ x, y, z, entity }) => {
      if (entity) {
        const target = resolveEntity(bot, entity);
        await bot.lookAt(target.position.offset(0, target.height ?? 1.6, 0), true);
        return `Looking at ${entity}`;
      }
      if (x === undefined || y === undefined || z === undefined) throw new Error('Provide x,y,z or entity');
      await bot.lookAt(vec({ x, y, z }), true);
      return `Looking at ${fmtPos({ x, y, z })}`;
    },
  });

  const move = tool({
    name: 'move',
    description:
      "Raw movement control for a duration: walk 'forward'/'back'/'left'/'right', 'jump', 'sprint', or 'sneak'. Good for small adjustments; use go_to for real navigation.",
    inputSchema: z.object({
      action: z.enum(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']),
      durationMs: z.number().default(1000).describe('How long to hold it (default 1000ms)'),
    }),
    callback: async ({ action, durationMs }) => {
      bot.setControlState(action, true);
      await new Promise((r) => setTimeout(r, Math.min(durationMs, 10000)));
      bot.setControlState(action, false);
      return `Held '${action}' for ${durationMs}ms. Now at ${fmtPos(bot.entity.position)}`;
    },
  });

  const teleport = tool({
    name: 'teleport',
    description:
      'Instantly teleport (server /tp — needs cheats enabled, as in an Open-to-LAN world with cheats). Target is coordinates OR an entity/player name. Much faster than walking for long distances; falls back with a clear error if commands are not allowed, in which case use go_to.',
    inputSchema: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      to: z.string().optional().describe("Player/entity name to teleport to (e.g. 'cagatay') — alternative to x/y/z"),
    }),
    callback: async ({ x, y, z, to }) => {
      const before = bot.entity.position.clone();
      if (to) {
        bot.chat(`/tp ${bot.username} ${to}`);
      } else if (x !== undefined && y !== undefined && z !== undefined) {
        bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`);
      } else {
        throw new Error('Give either x+y+z or to=<player/entity name>.');
      }
      // /tp is silent on success from the bot's side — verify by watching position
      await new Promise((r) => setTimeout(r, 1200));
      const after = bot.entity.position;
      const moved = after.distanceTo(before) >= 0.5;
      const targetEntity = to ? bot.players[to]?.entity : undefined;
      const nearTarget = targetEntity ? after.distanceTo(targetEntity.position) < 4 : false;
      if (!moved && !nearTarget) {
        throw new Error(
          `Teleport did not move me (still at ${fmtPos(after)}). The server probably has cheats disabled — use go_to to walk instead.`
        );
      }
      return `Teleported ${fmtPos(before)} → ${fmtPos(after)}.`;
    },
  });

  const mountEntity = tool({
    name: 'mount_entity',
    description:
      "Climb into/onto a rideable entity: boat, minecart, horse (must be tamed), camel, strider… Walks to it first. Use steer_vehicle to drive boats/pigs/striders, dismount to get off.",
    inputSchema: z.object({
      entity: z.string().describe("Vehicle entity name or id, e.g. 'boat', 'minecart', 'horse'"),
    }),
    callback: async ({ entity }) => {
      const target = resolveEntity(bot, entity);
      await approachEntity(bot, target);
      await bot.mount(target);
      // bot.mount sends a packet and returns; the server decides. An untamed horse
      // rejects the rider, a boat 4 blocks away never hears it — and a bot that
      // believes it is riding will steer_vehicle at nothing for the rest of the
      // errand while its legs stay disabled. Read bot.entity.vehicle back.
      const riding = await waitFor(() => !!(bot.entity as unknown as { vehicle?: unknown }).vehicle, 1500);
      if (!riding)
        throw new Error(
          `You are NOT riding the ${entity} — the server refused the mount. Usual causes: the animal is untamed ` +
            `(ride-and-be-thrown until it stops bucking), a horse without a saddle, the seat is occupied, or you ` +
            `are still too far. You are standing on your own legs, so walking still works.`,
        );
      const seat = (bot.entity as unknown as { vehicle?: { name?: string } }).vehicle?.name ?? entity;
      return `Mounted ${seat}, confirmed — you are riding it and your own legs are disabled until dismount. ` +
        `Use steer_vehicle to move.`;
    },
  });

  const dismount = tool({
    name: 'dismount',
    description: 'Get off the vehicle/mount you are currently riding.',
    callback: async () => {
      const riding = (bot.entity as unknown as { vehicle?: { name?: string } }).vehicle;
      if (!riding) return 'Not riding anything.';
      await bot.dismount();
      // Still in the seat after "Dismounted" means every later walk_to silently
      // does nothing: the pathfinder cannot move a passenger.
      const off = await waitFor(() => !(bot.entity as unknown as { vehicle?: unknown }).vehicle, 1500);
      if (!off)
        throw new Error(
          `Still riding the ${riding.name ?? 'vehicle'} — the dismount was not accepted. Walking will do nothing ` +
            `until you are out of the seat: retry, or steer somewhere else first.`,
        );
      return `Dismounted from ${riding.name ?? 'the vehicle'}; back on your own legs at ${fmtPos(bot.entity.position)}.`;
    },
  });

  const steerVehicle = tool({
    name: 'steer_vehicle',
    description:
      "Drive the vehicle you are riding (boat, pig with carrot-on-stick, strider) for a duration. Directions are relative to where you look — use look_at/turn to point first, then steer 'forward'.",
    inputSchema: z.object({
      direction: z.enum(['forward', 'back', 'left', 'right']),
      durationMs: z.number().default(2000).describe('How long to steer (default 2000ms, max 10000)'),
    }),
    callback: async ({ direction, durationMs }) => {
      if (!(bot.entity as unknown as { vehicle?: unknown }).vehicle) {
        throw new Error('Not riding a vehicle — mount_entity first.');
      }
      const left = direction === 'left' ? 1 : direction === 'right' ? -1 : 0;
      const forward = direction === 'forward' ? 1 : direction === 'back' ? -1 : 0;
      const from = bot.entity.position.clone();
      bot.moveVehicle(left, forward);
      await new Promise((r) => setTimeout(r, Math.min(durationMs, 10000)));
      bot.moveVehicle(0, 0);
      // Distance travelled is the only honest report here: a boat on land, a pig
      // without a carrot-on-stick and a strider off lava all accept steering input
      // and go nowhere, and "Steered forward for 2000ms" reads like progress.
      const moved = bot.entity.position.distanceTo(from);
      return `Steered ${direction} for ${durationMs}ms and moved ${moved.toFixed(1)} blocks, now at ${fmtPos(bot.entity.position)}.` +
        (moved < 0.5
          ? ` That is going NOWHERE: a boat needs water, a pig needs a carrot_on_a_stick held, a strider needs lava ` +
            `and a warped_fungus_on_a_stick. Do not repeat the same steer — fix the reason or dismount and walk.`
          : '');
    },
  });

  const elytraFly = tool({
    name: 'elytra_fly',
    description:
      "Start gliding with an elytra: auto-equips it to the torso, jumps if on the ground, activates flight, optionally fires firework rockets for boost. Steer while gliding with look_at (you glide where you look); land by gliding into the ground.",
    inputSchema: z.object({
      boostRockets: z.number().default(0).describe('Firework rockets to fire for forward boost (needs firework_rocket in inventory)'),
      x: z.number().optional().describe('Optional: look toward this position before gliding'),
      y: z.number().optional(),
      z: z.number().optional(),
    }),
    callback: async ({ boostRockets, x, y, z }) => {
      const elytra = bot.inventory.items().find((i) => i.name === 'elytra');
      const wearing = bot.inventory.slots[6]?.name === 'elytra';
      if (!elytra && !wearing) throw new Error('No elytra in inventory or on back.');
      if (!wearing && elytra) await bot.equip(elytra, 'torso');
      if (x !== undefined && y !== undefined && z !== undefined) {
        await bot.lookAt(vec({ x, y, z }), true);
      }
      // elytraFly only engages mid-air — hop first if standing.
      if (bot.entity.onGround) {
        bot.setControlState('jump', true);
        await new Promise((r) => setTimeout(r, 150));
        bot.setControlState('jump', false);
        await new Promise((r) => setTimeout(r, 150));
      }
      await bot.elytraFly();
      let boosted = 0;
      if (boostRockets > 0) {
        const rockets = bot.inventory.items().find((i) => i.name === 'firework_rocket');
        if (!rockets) return 'Gliding — but no firework_rocket in inventory for boost.';
        await bot.equip(rockets, 'hand');
        for (let i = 0; i < Math.min(boostRockets, 5); i++) {
          bot.activateItem();
          boosted++;
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
      await new Promise((r) => setTimeout(r, 500));
      return `Gliding at ${fmtPos(bot.entity.position)}${boosted ? ` (boosted with ${boosted} rocket(s))` : ''}. Steer with look_at; call again with boostRockets to keep altitude.`;
    },
  });

  const creativeFly = tool({
    name: 'creative_fly',
    description:
      'Creative-mode flight in a straight line to exact coordinates (hovers, ignores gravity). Fails outside creative mode — use go_to for walking. The path must be unobstructed.',
    inputSchema: z.object({
      x: z.number(), y: z.number(), z: z.number(),
      hover: z.boolean().default(false).describe('true = just start hovering here (no destination move)'),
    }),
    callback: async ({ x, y, z, hover }) => {
      if (bot.game.gameMode !== 'creative') {
        throw new Error(`creative_fly needs creative mode (currently ${bot.game.gameMode}). Ask a player to /gamemode creative the bot, or use go_to.`);
      }
      if (hover) {
        bot.creative.startFlying();
        return `Hovering at ${fmtPos(bot.entity.position)}. creative_fly to a target to move, or land with stop hover.`;
      }
      await bot.creative.flyTo(vec({ x: x + 0.5, y, z: z + 0.5 }));
      bot.creative.stopFlying();
      return `Flew to ${fmtPos(bot.entity.position)} and resumed normal physics.`;
    },
  });

  return [goTo, follow, stopMoving, turn, lookAt, move, teleport, mountEntity, dismount, steerVehicle, elytraFly, creativeFly];
}

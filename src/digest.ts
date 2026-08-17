/**
 * 📋 World digest — the compact status block every self-prompt starts from.
 *
 * The thinker and journey steps used to open with "perceive first if unsure",
 * which bought a get_status/look_around tool round-trip per cycle and still
 * left the model guessing about threats and supplies. The digest injects the
 * answer instead: one ~8-line block assembled from state the process already
 * holds — vitals, clock, the sentinel's threat table, bag highlights, the
 * running journey, live workers, the last reflex action. Pure formatting over
 * a plain snapshot struct so tests can pin the exact output; the collector
 * (worldDigest) is the only part that touches the bot.
 *
 * Budget: ≤600 chars. This rides EVERY thinker cycle and journey step all
 * night — a fat digest is a token furnace, and a model that gets a novel is
 * worse at spotting the one line that matters.
 */
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { carriedView, countCarried, bestFood, oxygenReading, standingHazards } from './tools/helpers.js';
import { Vec3 } from 'vec3';

export interface DigestSnapshot {
  health?: number;
  food?: number;
  oxygen?: number;
  pos?: { x: number; y: number; z: number };
  dimension?: string;
  gamemode?: string;
  night?: boolean;
  fullMoon?: boolean;
  raining?: boolean;
  threats: string[]; // sentinel's table, nearest first
  foodPortions: number;
  torches: number;
  tools: string[];
  weapons: string[];
  buildingBlocks: number;
  journey?: { id: string; goal: string; step: number; last?: string };
  workers: string[]; // "name(status #steps)"
  reflexLines: string[]; // behavior-log tail
}

/** Bag highlights, pure over {name,count} pairs so tests hand it inventories. */
export function inventoryHighlights(items: Array<{ name: string; count: number }>): {
  foodPortions: number; torches: number; tools: string[]; weapons: string[]; buildingBlocks: number;
} {
  let foodPortions = 0, torches = 0, buildingBlocks = 0;
  const tools = new Set<string>(), weapons = new Set<string>();
  for (const { name, count } of items) {
    if (bestFood([name], 20) === name) foodPortions += count; // the eat-picker's own table decides what counts as a meal
    else if (name === 'torch') torches += count;
    else if (/(_pickaxe|_shovel|_hoe)$/.test(name) || name === 'shears' || name === 'fishing_rod') tools.add(name);
    else if (/_axe$/.test(name)) { tools.add(name); } // an axe is both — listed once, as a tool
    else if (/_sword$/.test(name) || ['bow', 'crossbow', 'trident'].includes(name)) weapons.add(name);
    else if (/(cobblestone|^dirt$|_planks$|^stone$|deepslate|netherrack|_log$)/.test(name)) buildingBlocks += count;
  }
  return { foodPortions, torches, tools: [...tools].slice(0, 4), weapons: [...weapons].slice(0, 3), buildingBlocks };
}

/** Pure: snapshot in, ≤600-char block out. */
/** Is the head block water? World truth, the only honest drowning test. */
function submerged(bot: Bot): boolean {
  const me = bot.entity?.position;
  if (!me) return false;
  return standingHazards(me, (x, y, z) => bot.blockAt?.(new Vec3(x, y, z))?.name).some(
    (h) => h.kind === 'water_over_head',
  );
}

export function formatDigest(s: DigestSnapshot): string {
  const lines: string[] = [];
  const p = s.pos ? `(${Math.floor(s.pos.x)}, ${Math.floor(s.pos.y)}, ${Math.floor(s.pos.z)})` : '(?)';
  lines.push(
    `HP ${s.health ?? '?'}/20 food ${s.food ?? '?'}/20${typeof s.oxygen === 'number' && s.oxygen < 20 ? ` O2 ${s.oxygen}/20` : ''} · ${p} ${s.dimension ?? '?'}${s.gamemode ? `, ${s.gamemode}` : ''}`,
  );
  // The rule the bot kept getting wrong, live: at 3.5 HP with food 5 it sealed
  // itself in a box and decided to "wait for morning" — but Java regenerates
  // health only at food >= 18 (and starves at 0). Waiting there is waiting to
  // stay hurt, so the digest states the rule instead of hoping the model recalls
  // it. Only when it matters: hurt, and not fed enough to heal.
  if (typeof s.health === 'number' && s.health < 16 && typeof s.food === 'number' && s.food < 18)
    lines.push(
      s.foodPortions > 0
        ? `HEALING: none until food >= 18 (food ${s.food}) — EAT, resting does not heal`
        : `HEALING: none until food >= 18 (food ${s.food}) and the bag has NO food — getting food IS the emergency`,
    );
  lines.push(`time: ${s.night === undefined ? '?' : s.night ? `NIGHT${s.fullMoon ? ' (full moon)' : ''}` : 'day'}${s.raining ? ', raining' : ''}`);
  lines.push(s.threats.length ? `threats: ${s.threats.slice(0, 3).join('; ')}` : 'threats: none in radar range');
  lines.push(
    `bag: ${s.foodPortions} meal(s), ${s.torches} torch(es), ${s.buildingBlocks} building block(s)` +
    `${s.tools.length ? ` | tools: ${s.tools.join(', ')}` : ' | NO tools'}${s.weapons.length ? ` | weapons: ${s.weapons.join(', ')}` : ''}`,
  );
  if (s.journey) lines.push(`journey: ${s.journey.id} "${s.journey.goal.slice(0, 60)}" step ${s.journey.step}${s.journey.last ? ` — last: ${s.journey.last.slice(0, 80)}` : ''}`);
  if (s.workers.length) lines.push(`workers: ${s.workers.slice(0, 4).join(', ')}`);
  if (s.reflexLines.length) lines.push(`body acted on its own: ${s.reflexLines[s.reflexLines.length - 1]}`);
  return lines.join('\n').slice(0, 600);
}

/** Everything the digest needs beyond the bot itself — all optional. */
export interface DigestSources {
  threats?: () => string[];
  reflexRecent?: (n?: number) => string[];
  journey?: () => { id: string; goal: string; step: number; last?: string } | undefined;
  workers?: () => string[];
}

/**
 * THE hostile radar — the single implementation every rail shares (issue #6.4:
 * four hand-rolled copies drifted until one threw, see #5). Guards: entities
 * may lack a position (just-spawned / torn down), own-entity compare is by id
 * (object identity lies across the LiveBody proxy), and the reconnect beat
 * where bot.entity is briefly undefined returns empty. Nearest first.
 */
export function hostilesNear(bot: Bot, range = Infinity): Array<{ e: Entity; dist: number }> {
  const me = bot.entity?.position;
  if (!me) return [];
  return (Object.values(bot.entities ?? {}) as Array<Entity | null | undefined>)
    .filter((e): e is Entity => !!e?.position && e.id !== bot.entity.id
      && ((e as { kind?: string }).kind === 'Hostile mobs' || e.type === 'hostile'))
    .map((e) => ({ e, dist: me.distanceTo(e.position) }))
    .filter((h) => h.dist <= range)
    .sort((a, z) => a.dist - z.dist);
}

/**
 * A radar for bots that don't carry a sentinel (fleet workers): hostiles
 * within `range`, nearest first, same line shape the sentinel produces.
 */
export function nearbyThreats(bot: Bot, range = 16): string[] {
  return hostilesNear(bot, range)
    .slice(0, 3)
    .map(({ e, dist }) => `${e.name} ${Math.round(dist)}m (${Math.floor(e.position.x)}, ${Math.floor(e.position.y)}, ${Math.floor(e.position.z)})`);
}

/** The collector: reads live bot state, defers the rest to the rails that own it. */
export function worldDigest(bot: Bot, sources: DigestSources = {}): string {
  // The same truthful count the Δ critic uses: an item in flight through the
  // cursor must not read as an item lost (issue #23's failure, on this rail).
  const items = Object.entries(countCarried(carriedView(bot))).map(([name, count]) => ({ name, count }));
  return formatDigest({
    health: typeof bot.health === 'number' ? Math.round(bot.health) : undefined,
    food: bot.food,
    // The air gauge reads 0/-1 on dry land, and `O2 0/20` in every digest told
    // the mind it was suffocating on cobblestone. Report air only when the head
    // is actually under water — normalized to bubbles, never raw ticks.
    oxygen: submerged(bot) ? oxygenReading(bot.oxygenLevel)?.units : undefined,
    pos: bot.entity?.position,
    dimension: bot.game?.dimension,
    gamemode: bot.game?.gameMode,
    night: bot.time ? !bot.time.isDay : undefined,
    fullMoon: bot.time?.moonPhase === 0,
    raining: bot.isRaining,
    threats: sources.threats?.() ?? [],
    ...inventoryHighlights(items),
    journey: sources.journey?.(),
    workers: sources.workers?.() ?? [],
    reflexLines: sources.reflexRecent?.(1) ?? [],
  });
}

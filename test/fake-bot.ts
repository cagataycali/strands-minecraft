/**
 * A fake mineflayer bot over a Map-based voxel world — just enough surface
 * for the tool layer's PURE logic (placement ordering, material accounting,
 * range math, memory) to run without a Minecraft server. Real Vec3, so all
 * position arithmetic is the production code path.
 */
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';

export interface FakeBlock {
  name: string;
  boundingBox: 'block' | 'empty';
  position: Vec3;
}

export class FakeWorld {
  private blocks = new Map<string, string>(); // "x,y,z" -> block name

  set(x: number, y: number, z: number, name: string) {
    this.blocks.set(`${x},${y},${z}`, name);
  }

  /** All positions holding one of `names` within maxDistance of `from`. */
  find(names: Set<string>, from: Vec3, maxDistance: number): Vec3[] {
    const out: Vec3[] = [];
    for (const [k, name] of this.blocks) {
      if (!names.has(name)) continue;
      const [x, y, z] = k.split(',').map(Number);
      const p = new Vec3(x, y, z);
      if (from.distanceTo(p) <= maxDistance) out.push(p);
    }
    return out;
  }

  get(pos: { x: number; y: number; z: number }): FakeBlock {
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    const name = this.blocks.get(`${x},${y},${z}`) ?? 'air';
    return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: new Vec3(x, y, z) };
  }
}

export interface FakeRecipe {
  makes: string;
  count: number; // per craft
  needs: Record<string, number>;
  table?: boolean;
}

export interface FakeBotOptions {
  position?: [number, number, number];
  inventory?: Record<string, number>; // name -> count
  blockNames?: string[]; // what the registry admits exists
  itemNames?: string[]; // registry items beyond what's held (recipe targets/ingredients)
  recipes?: FakeRecipe[];
  food?: number;
  /** What using the held item on an entity puts in the bag (shearing → wool). */
  useOnYield?: Record<string, number>;
  /** Actions the fake server silently ignores: 'toss', 'consume', 'mount', a slot name. */
  deaf?: string[];
  /**
   * Issue #48's REAL failure: the client applies the window click to its own
   * mirror at once, the server rejects it, and the old slot comes back a
   * round-trip later. Listed actions ('toss') behave exactly like that — they
   * look accepted for `rollbackMs`, then undo themselves.
   */
  rollback?: string[];
  rollbackMs?: number;
  /** false = steering input is accepted but the vehicle does not move (boat on land). */
  vehicleMoves?: boolean;
  xpLevel?: number;
  health?: number;
  /** Villager offers; `stock` caps how many times it really executes. */
  trades?: Array<{ costs: string; costCount: number; gives: string; givesCount: number; disabled?: boolean; maxUses?: number; used?: number; stock?: number }>;
}

/** Build the fake bot + handles to inspect what the tools did to it. */
export function fakeBot(world: FakeWorld, opts: FakeBotOptions = {}) {
  const inv = new Map(Object.entries(opts.inventory ?? {}));
  const deaf = new Set(opts.deaf ?? []);
  const rollback = new Set(opts.rollback ?? []);
  const rollbackMs = opts.rollbackMs ?? 150;
  /** Apply optimistically, then let the server put it back (issue #48). */
  const optimistic = (undo: () => void) => {
    const t = setTimeout(undo, rollbackMs);
    if (typeof t.unref === 'function') t.unref();
  };
  const log = { gotoCalls: 0, equipped: [] as string[], placed: [] as string[], dug: [] as string[], crafted: [] as string[] };
  let held = '';

  // The real Bot IS an EventEmitter — a fake without on/emit let a listener-using
  // helper (walkTo's dig credit) pass its own tests and break five others.
  const events = new EventEmitter();
  const bot = {
    on: (e: string, fn: (...a: unknown[]) => void) => events.on(e, fn),
    once: (e: string, fn: (...a: unknown[]) => void) => events.once(e, fn),
    removeListener: (e: string, fn: (...a: unknown[]) => void) => events.removeListener(e, fn),
    emit: (e: string, ...a: unknown[]) => events.emit(e, ...a),
    username: 'FakeBot',
    entity: { position: new Vec3(...(opts.position ?? [0, 0, 0])), vehicle: undefined as unknown },
    registry: {
      blocksByName: Object.fromEntries((opts.blockNames ?? [...inv.keys()]).map((n, i) => [n, { name: n, id: i + 1 }])),
      itemsByName: Object.fromEntries(
        [...new Set([...inv.keys(), ...(opts.itemNames ?? [])])].map((n, i) => [n, { name: n, id: i + 1 }]),
      ) as Record<string, { name: string; id: number }>,
      items: {} as Record<number, { name: string }>,
    },
    inventory: {
      // Real Item carries its registry type — toss/deposit are BY TYPE, so a fake
      // without it silently tosses whatever was in hand instead.
      items: () => [...inv.entries()].filter(([, c]) => c > 0)
        .map(([name, count]) => ({ name, count, type: itemId(name) })),
      slots: [] as ({ name: string } | null)[],
    },
    entities: {} as Record<string, unknown>,
    blockAt: (pos: Vec3) => world.get(pos),
    canDigBlock: (block: FakeBlock) =>
      block.boundingBox !== 'empty' && bot.entity.position.distanceTo(block.position) <= 5,
    dig: async (block: FakeBlock) => {
      world.set(block.position.x, block.position.y, block.position.z, 'air');
      log.dug.push(`${block.name}@${block.position.x},${block.position.y},${block.position.z}`);
    },
    findBlock: ({ matching, maxDistance }: { matching?: number; maxDistance: number }) => {
      if (matching === undefined) return null;
      const byId = Object.values(bot.registry.blocksByName) as Array<{ name: string; id: number }>;
      const names = new Set(byId.filter((b) => b.id === matching).map((b) => b.name));
      const hits = world.find(names, bot.entity.position, maxDistance);
      return hits.length ? world.get(hits[0]) : null;
    },
    recipesAll: (id: number, _meta: unknown, table: unknown) =>
      recipes.filter((r) => r.result.id === id && (!r.requiresTable || table)),
    recipesFor: (id: number, _meta: unknown, _min: unknown, table: unknown) =>
      recipes.filter((r) =>
        r.result.id === id && (!r.requiresTable || table) &&
        r.delta.every((d) => d.count >= 0 || (inv.get(idToName.get(d.id)!) ?? 0) >= -d.count),
      ),
    craft: async (recipe: (typeof recipes)[number], times: number) => {
      for (const d of recipe.delta) {
        const name = idToName.get(d.id)!;
        const next = (inv.get(name) ?? 0) + d.count * times;
        if (next < 0) throw new Error(`fake craft: not enough ${name}`);
        inv.set(name, next);
      }
      log.crafted.push(`${recipe.result.count * times}x ${idToName.get(recipe.result.id)}`);
    },
    findBlocks: ({ matching, maxDistance }: { matching: number | number[]; maxDistance: number }) => {
      const ids = Array.isArray(matching) ? matching : [matching];
      const byId = Object.values(bot.registry.blocksByName) as Array<{ name: string; id: number }>;
      const names = new Set(byId.filter((b) => ids.includes(b.id)).map((b) => b.name));
      return world.find(names, bot.entity.position, maxDistance);
    },
    pathfinder: {
      // Teleport-style pathfinder: lands exactly at the goal, counts calls.
      goto: async (goal: { x: number; y: number; z: number }) => {
        log.gotoCalls++;
        bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
      },
    },
    // Equipment slots are real here (5-8 armor, 45 off-hand) because the tools
    // that verify an equip READ them back — a fake that only logs the intent
    // would agree with the bug those tools exist to catch.
    getEquipmentDestSlot: (dest: string) =>
      ({ head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45, hand: 36 })[dest] ?? 36,
    get heldItem() {
      return held ? { name: held, count: inv.get(held) ?? 1, type: itemId(held) } : null;
    },
    food: opts.food ?? 20,
    equip: async (item: { name: string }, dest?: string) => {
      log.equipped.push(item.name);
      if (dest && dest !== 'hand') {
        if (!deaf.has(dest)) bot.inventory.slots[bot.getEquipmentDestSlot(dest)] = { name: item.name };
      } else held = item.name;
    },
    unequip: async (dest: string) => {
      if (deaf.has(dest)) return; // a dropped click: the server never heard it
      if (dest === 'hand') held = '';
      else bot.inventory.slots[bot.getEquipmentDestSlot(dest)] = null;
    },
    toss: async (type: number, _meta: unknown, count: number) => {
      if (deaf.has('toss')) return;
      const name = idToName.get(type) ?? held; // real toss is by item type, not by hand
      const n = Math.min(count, inv.get(name) ?? 0);
      const was = inv.get(name) ?? 0;
      inv.set(name, was - n);
      if (rollback.has('toss')) optimistic(() => inv.set(name, was));
    },
    tossStack: async (item: { name: string }) => {
      if (deaf.has('toss')) return;
      const was = inv.get(item.name) ?? 0;
      inv.set(item.name, 0);
      if (rollback.has('toss')) optimistic(() => inv.set(item.name, was));
    },
    useOn: async (_e: unknown) => {
      for (const [name, n] of Object.entries(opts.useOnYield ?? {})) inv.set(name, (inv.get(name) ?? 0) + n);
    },
    consume: async () => { if (!deaf.has('consume')) bot.food = Math.min(20, bot.food + 5); },
    // Riding is server-decided: 'mount'/'dismount' in `deaf` models the untamed
    // horse and the seat that will not let go.
    mount: async (e: { name?: string }) => {
      if (!deaf.has('mount')) (bot.entity as { vehicle?: unknown }).vehicle = { name: e.name ?? 'vehicle' };
    },
    dismount: async () => { if (!deaf.has('dismount')) (bot.entity as { vehicle?: unknown }).vehicle = undefined; },
    moveVehicle: (_l: number, f: number) => {
      if (opts.vehicleMoves === false) return; // a boat on land accepts input and goes nowhere
      bot.entity.position = bot.entity.position.offset(0, 0, f);
    },
    lookAt: async () => {},
    experience: { level: opts.xpLevel ?? 30, points: 0, progress: 0 },
    health: opts.health ?? 20,
    game: { gameMode: 'survival' },
    activateEntity: async () => {},
    respawn: async () => { if (!deaf.has('respawn')) bot.health = 20; },
    // A villager whose trade can be made to fail the way a real one does: locked,
    // out of uses, or accepted-then-nothing-happens.
    openVillager: async () => ({
      trades: (opts.trades ?? []).map((t) => ({
        inputItem1: { name: t.gives ? t.costs : t.costs, count: t.costCount, type: itemId(t.costs) },
        hasItem2: false,
        inputItem2: null,
        outputItem: { name: t.gives, count: t.givesCount, type: itemId(t.gives) },
        tradeDisabled: !!t.disabled,
        maximumNbTradeUses: t.maxUses ?? 12,
        nbTradeUses: t.used ?? 0,
      })),
      close: () => {},
    }),
    trade: async (_v: unknown, index: number, times: number) => {
      const t = (opts.trades ?? [])[index];
      if (!t || deaf.has('trade')) return; // accepted the packet, changed nothing
      const runs = Math.min(times, t.stock ?? times);
      inv.set(t.costs, (inv.get(t.costs) ?? 0) - t.costCount * runs);
      inv.set(t.gives, (inv.get(t.gives) ?? 0) + t.givesCount * runs);
    },
    setControlState: () => {},
    placeBlock: async (ref: FakeBlock, face: Vec3) => {
      const p = ref.position.plus(face);
      world.set(p.x, p.y, p.z, held);
      const left = (inv.get(held) ?? 0) - 1;
      inv.set(held, left);
      log.placed.push(`${held}@${p.x},${p.y},${p.z}`);
    },
  };
  const idToName = new Map(
    Object.entries(bot.registry.itemsByName as Record<string, { id: number }>).map(([n, v]) => [v.id, n]),
  );
  for (const [id, name] of idToName) (bot.registry.items as Record<number, { name: string }>)[id] = { name };
  const itemId = (n: string) => {
    const e = (bot.registry.itemsByName as Record<string, { id: number }>)[n];
    if (!e) throw new Error(`fake recipe references unknown item '${n}' — add it to itemNames`);
    return e.id;
  };
  const recipes = (opts.recipes ?? []).map((r) => ({
    result: { id: itemId(r.makes), count: r.count },
    requiresTable: !!r.table,
    delta: [
      ...Object.entries(r.needs).map(([n, c]) => ({ id: itemId(n), count: -c })),
      { id: itemId(r.makes), count: r.count },
    ],
  }));

  return { bot, log, inv };
}

/**
 * The fake's own shape, kept assignable to mineflayer's `Bot` at call sites
 * via the `as never` idiom the tool factories use — while letting a test
 * mutate the fake's real fields (`bot.inventory.slots`, `bot.entities`) with
 * types instead of `never`. A test that needs to pass it where a `Bot` is
 * required still writes `bot as never`.
 */
export type FakeBot = ReturnType<typeof fakeBot>['bot'];

/** Invoke a Strands tool the way the agent would, returning its result. */
export async function invoke(tool: unknown, args: Record<string, unknown>): Promise<unknown> {
  return (tool as { invoke: (a: unknown, c: unknown) => Promise<unknown> }).invoke(args, {});
}

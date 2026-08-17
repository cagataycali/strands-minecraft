/**
 * Issue #34 follow-on A2 — THE WALL THAT KILLED A BODY NO REFLEX COULD SEE.
 *
 * /tmp/mc-soak43.log, line 87: `StrandsBot suffocated in a wall`. Four lines
 * earlier, the `dying` reflex at 5/20 hp: `standing down instead of escaping: no
 * hostile in sight and no hazard underfoot — the damage is coming from the world
 * (hunger, suffocation, a fall), and no direction is safer than another`. It
 * NAMED suffocation as a suspect and then held still, because suffocation was
 * not a hazard anything reported: `standingHazards` only ever asked "is the
 * block at head height water", and rock is not water.
 *
 * Two things are pinned here: the hazard exists, and it has a PAID remedy — the
 * same priced dig as the drowning one, which out of the water is ~25x cheaper
 * (no ×5 underwater, no ×5 off-ground).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { standingHazards } from '../src/tools/helpers.js';

process.env.HAZARD_COOLDOWN_MS = '20';
process.env.REFLEX_MODES_OFF = 'dying,creeper_flee,fight_back,unstuck,auto_eat,starving,auto_armor,item_magnet,elbow_room,idle_staring';
const { startReflexes } = await import('../src/reflexes.js');

test('a head inside rock is a hazard; head-high grass is not (solidity from the game)', () => {
  const rock = standingHazards({ x: 0, y: 64, z: 0 }, (_x, y) => (y === 63 ? 'stone' : y === 65 ? 'sandstone' : 'air'), (_x, y) => y === 65);
  assert.deepEqual(rock.map((h) => h.kind), ['head_in_block']);
  assert.match(rock[0]!.detail, /head inside sandstone — SUFFOCATING/);
  // The 1a99f01 trap: a name list would send a body digging out of a meadow.
  const meadow = standingHazards({ x: 0, y: 64, z: 0 }, (_x, y) => (y === 65 ? 'tall_grass' : 'air'), () => false);
  assert.deepEqual(meadow, []);
  // Water over the head is still DROWNING, not suffocating — one remedy each.
  const lake = standingHazards({ x: 0, y: 64, z: 0 }, () => 'water', () => true);
  assert.deepEqual(lake.map((h) => h.kind), ['water_over_head']);
});

/** A body standing on stone with its head inside stone, dry. */
const harness = (o: { pack?: string[]; handDigMs?: number; toolDigMs?: number; digThrows?: boolean } = {}) => {
  const notes: string[] = [];
  const log: string[] = [];
  const equipped: string[] = [];
  const dug: string[] = [];
  const bot = new EventEmitter() as unknown as Record<string, unknown> & EventEmitter;
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 64, 0), height: 1.8, onGround: true },
    entities: {},
    health: 8,
    food: 20,
    oxygenLevel: 20,
    inventory: { items: () => (o.pack ?? []).map((name, i) => ({ name, slot: 9 + i, count: 1, type: 200 + i })) },
    blockAt: (p: Vec3) => ({
      name: 'stone',
      position: p,
      boundingBox: 'block',
      type: 1,
      digTime: (t: number | null) => (t === null ? (o.handDigMs ?? 7_500) : (o.toolDigMs ?? 600)),
    }),
    equip: async (item: { name: string }) => { equipped.push(item.name); },
    dig: async (b: { name: string }) => { if (o.digThrows) throw new Error('Digging aborted'); dug.push(b.name); },
    digTime: () => o.handDigMs ?? 7_500,
    heldItem: undefined,
    lookAt: async () => {},
    setControlState: () => {},
    clearControlStates: () => {},
    placeBlock: async () => {},
    pathfinder: { setGoal: () => {}, stop: () => {}, goto: async () => {} },
  });
  const handle = startReflexes(
    { bot, onEachBot: (fn: (b: unknown) => void) => fn(bot) } as never,
    { deliberateBusy: () => false, note: (t: string) => notes.push(t), log: (_w: string, t: string) => log.push(t) },
    { idleModes: false, tickMs: 10 },
  );
  assert.ok(handle);
  return { notes, log, equipped, dug, stop: () => handle!.stop() };
};

const until = async (pred: () => boolean, ms = 4_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return pred();
};

test('soak43: a suffocating body DIGS its way out instead of standing down', async () => {
  const h = harness({ pack: ['stone_pickaxe'] });
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('SUFFOCATING'))), `the wall must be reported: ${h.log.join(' | ')}`);
    const line = h.log.find((l) => l.includes('SUFFOCATING'))!;
    assert.match(line, /head inside stone — SUFFOCATING/);
    assert.match(line, /DUG UP through stone at head height/);
    assert.match(line, /equipped stone pickaxe first/);
    assert.match(line, /0\.6s with stone pickaxe/);
    // dry, so the whole air bar is the budget — 7.5s bare-handed is payable too.
    // 18.8s, not 17.0s: with no sideways column and nothing placeable this dig
    // is the only exit, so the 4 hp reserve gives way to the survival floor
    // (soak47's deadlock — the reserve used to forbid the only way out).
    assert.match(line, /I can pay 18\.8s/);
    assert.deepEqual(h.equipped, ['stone_pickaxe']);
    assert.ok(h.dug.length >= 1, 'a block must actually be dug');
  } finally { h.stop(); }
});

test('a dig that aborts is reported as failed, never as an escape', async () => {
  const h = harness({ pack: ['stone_pickaxe'], digThrows: true });
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('could not dig the stone at head height'))),
      `a throwing dig must be narrated: ${h.log.join(' | ')}`);
    assert.ok(!h.log.some((l) => l.includes('DUG UP')));
  } finally { h.stop(); }
});

test('an unpayable suffocation dig reaches the mind instead of timing out silently', async () => {
  // Obsidian-grade: nothing in the bag can pay for it inside the budget.
  const h = harness({ handDigMs: 250_000 });
  try {
    assert.ok(await until(() => h.notes.some((n) => /I am SUFFOCATING/.test(n))), `the mind must be told: ${h.notes.join(' | ')} :: ${h.log.join(' | ')}`);
    assert.ok(h.notes.some((n) => /Anything that moves this body out of this block, now/.test(n)));
    assert.ok(h.log.some((l) => /UNPAYABLE: the stone .* costs 250\.0s/.test(l)), h.log.join(' | '));
    assert.equal(h.dug.length, 0);
  } finally { h.stop(); }
});

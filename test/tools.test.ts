/**
 * Tests for the tool layer's pure logic — everything that can be proven
 * without a Minecraft server: blueprint ordering/accounting, waypoint
 * memory, walk-into-range math. Run: npm test (tsx --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';
import { FakeWorld, fakeBot, invoke, type FakeBot, type FakeRecipe } from './fake-bot.js';
import { interactionTools } from '../src/tools/actions.js';

// memory.ts resolves MEMORY_DIR at module load — point it at a temp dir
// BEFORE the module is imported (dynamic imports below keep the order).
process.env.MEMORY_DIR = mkdtempSync(join(tmpdir(), 'sm-test-'));

const { memoryTools } = await import('../src/tools/memory.js');
const { worldTools } = await import('../src/tools/world.js');
const { approach, approachEntity } = await import('../src/tools/helpers.js');

function groundedWorld(size = 6): FakeWorld {
  const w = new FakeWorld();
  for (let x = -size; x <= size; x++)
    for (let z = -size; z <= size; z++) w.set(x, -1, z, 'grass_block');
  return w;
}

function blueprintTool(bot: FakeBot) {
  const t = worldTools(bot as never).find((x) => (x as { toolSpec?: { name?: string } }).toolSpec?.name === 'build_blueprint');
  assert.ok(t, 'build_blueprint tool exists');
  return t;
}

// ── build_blueprint ─────────────────────────────────────────────────────────

test('blueprint: missing materials fail fast, nothing placed', async () => {
  const world = groundedWorld();
  const { bot, log } = fakeBot(world, { inventory: { cobblestone: 2 } });
  await assert.rejects(
    invoke(blueprintTool(bot), {
      anchor: { x: 0, y: 0, z: 0 },
      blocks: [0, 1, 2].map((dy) => ({ dx: 0, dy, dz: 0, item: 'cobblestone' })),
    }),
    /need 3, have 2/,
  );
  assert.equal(log.placed.length, 0, 'fails BEFORE the first block, not at block 3');
});

test('blueprint: shuffled plan still builds bottom-up (support before leaner)', async () => {
  const world = groundedWorld();
  const { bot, log } = fakeBot(world, { inventory: { cobblestone: 3 } });
  const result = await invoke(blueprintTool(bot), {
    anchor: { x: 2, y: 0, z: 2 },
    // Deliberately top-first: the tool must reorder or retry.
    blocks: [
      { dx: 0, dy: 2, dz: 0, item: 'cobblestone' },
      { dx: 0, dy: 0, dz: 0, item: 'cobblestone' },
      { dx: 0, dy: 1, dz: 0, item: 'cobblestone' },
    ],
  });
  assert.match(String(result), /placed 3\/3/);
  assert.match(String(result), /Structure complete/);
  assert.deepEqual(log.placed, ['cobblestone@2,0,2', 'cobblestone@2,1,2', 'cobblestone@2,2,2']);
  assert.equal(world.get({ x: 2, y: 2, z: 2 }).name, 'cobblestone');
});

test('blueprint: a floating block is reported, the rest still lands', async () => {
  const world = groundedWorld();
  const { bot } = fakeBot(world, { inventory: { oak_planks: 2 } });
  const result = String(await invoke(blueprintTool(bot), {
    anchor: { x: 0, y: 0, z: 0 },
    blocks: [
      { dx: 0, dy: 0, dz: 0, item: 'oak_planks' },
      { dx: 3, dy: 3, dz: 3, item: 'oak_planks' }, // touches nothing, ever
    ],
  }));
  assert.match(result, /placed 1\/2/);
  assert.match(result, /FAILED 1/);
  assert.match(result, /floating in the plan\?|no support ever appeared|No solid neighbor/i);
  assert.equal(world.get({ x: 0, y: 0, z: 0 }).name, 'oak_planks');
  assert.equal(world.get({ x: 3, y: 3, z: 3 }).name, 'air');
});

test('blueprint: resumable — blocks already matching the plan are skipped', async () => {
  const world = groundedWorld();
  world.set(1, 0, 1, 'cobblestone'); // half-built already
  const { bot, log } = fakeBot(world, { inventory: { cobblestone: 2 } });
  const result = String(await invoke(blueprintTool(bot), {
    anchor: { x: 1, y: 0, z: 1 },
    blocks: [
      { dx: 0, dy: 0, dz: 0, item: 'cobblestone' },
      { dx: 0, dy: 1, dz: 0, item: 'cobblestone' },
    ],
  }));
  assert.match(result, /placed 1\/2/);
  assert.match(result, /1 already in place/);
  assert.equal(log.placed.length, 1);
});

test('blueprint: duplicate offsets are a plan bug, refused up front', async () => {
  const world = groundedWorld();
  const { bot, log } = fakeBot(world, { inventory: { cobblestone: 4 } });
  await assert.rejects(
    invoke(blueprintTool(bot), {
      anchor: { x: 0, y: 0, z: 0 },
      blocks: [
        { dx: 0, dy: 0, dz: 0, item: 'cobblestone' },
        { dx: 0, dy: 0, dz: 0, item: 'cobblestone' },
      ],
    }),
    /same offset/,
  );
  assert.equal(log.placed.length, 0);
});

test('blueprint: unknown block name refused with close matches', async () => {
  const world = groundedWorld();
  const { bot } = fakeBot(world, {
    inventory: { cobblestone: 1 },
    blockNames: ['cobblestone', 'cobblestone_stairs'],
  });
  await assert.rejects(
    invoke(blueprintTool(bot), {
      anchor: { x: 0, y: 0, z: 0 },
      blocks: [{ dx: 0, dy: 0, dz: 0, item: 'cobble' }],
    }),
    /Unknown block 'cobble'.*cobblestone/,
  );
});

// ── memory ──────────────────────────────────────────────────────────────────

test('memory: remember → filtered recall → forget round trip', async () => {
  const world = groundedWorld();
  const { bot } = fakeBot(world, { position: [10, 64, -3] });
  const [remember, recall, forget] = memoryTools(bot as never);

  await invoke(remember, { name: 'Home', note: 'spawn chest' });
  await invoke(remember, { name: 'mine', x: 100, y: 12, z: 100 });

  const hits = (await invoke(recall, { query: 'chest' })) as Array<Record<string, unknown>>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'home'); // normalized lowercase
  assert.deepEqual(hits[0].position, { x: 10, y: 64, z: -3 });

  // name reuse updates in place, no duplicate
  await invoke(remember, { name: 'home', x: 0, y: 0, z: 0 });
  const all = (await invoke(recall, {})) as Array<Record<string, unknown>>;
  assert.equal(all.filter((p) => p.name === 'home').length, 1);
  assert.deepEqual(all.find((p) => p.name === 'home')!.position, { x: 0, y: 0, z: 0 });

  assert.match(String(await invoke(forget, { name: ' HOME ' })), /Forgot 'home'/);
  await assert.rejects(invoke(forget, { name: 'nope' }), /Saved: mine/);
});

test('memory: hand-corrupted file degrades to empty, never crashes', async () => {
  writeFileSync(join(process.env.MEMORY_DIR!, 'memory.json'), '{not json');
  const { bot } = fakeBot(groundedWorld(), { position: [0, 0, 0] });
  const [remember, recall] = memoryTools(bot as never);
  assert.match(String(await invoke(recall, {})), /No places saved yet/);
  await invoke(remember, { name: 'fresh' }); // and writing works again
  const file = readFileSync(join(process.env.MEMORY_DIR!, 'memory.json'), 'utf8');
  assert.match(file, /"fresh"/);
});

// ── approach ────────────────────────────────────────────────────────────────

test('approach: already in reach → the pathfinder is never asked', async () => {
  const { bot, log } = fakeBot(groundedWorld(), { position: [0, 0, 0] });
  await approach(bot as never, { x: 2, y: 0, z: 0 }); // 2 < 4.5
  assert.equal(log.gotoCalls, 0);
});

test('approach: out of reach → walks, stopping short of the target', async () => {
  const { bot, log } = fakeBot(groundedWorld(), { position: [0, 0, 0] });
  await approach(bot as never, { x: 20, y: 0, z: 0 });
  assert.equal(log.gotoCalls, 1);
});

test('approachEntity: entity reach is 3, not the block 4.5', async () => {
  const { bot, log } = fakeBot(groundedWorld(), { position: [0, 0, 0] });
  const entity = { position: new Vec3(4, 0, 0) };
  await approachEntity(bot as never, entity as never); // 4 > 3 → must walk
  assert.equal(log.gotoCalls, 1);
});

// ── find_blocks ─────────────────────────────────────────────────────────────

const { perceptionTools } = await import('../src/tools/perception.js');

function findTool(bot: FakeBot) {
  const t = perceptionTools(bot as never).find((x) => (x as { toolSpec?: { name?: string } }).toolSpec?.name === 'find_blocks');
  assert.ok(t, 'find_blocks tool exists');
  return t;
}

test('find_blocks: a tree is ONE cluster with its size, not eight rows', async () => {
  const world = groundedWorld();
  for (let y = 0; y < 5; y++) world.set(3, y, 3, 'oak_log'); // trunk of 5
  world.set(-4, 0, -4, 'oak_log'); // a lone stump elsewhere
  const { bot } = fakeBot(world, { position: [0, 0, 0], blockNames: ['oak_log'], inventory: {} });
  const result = (await invoke(findTool(bot), { name: 'oak_log' })) as Array<Record<string, unknown>>;
  assert.equal(result.length, 2, 'trunk collapses to one cluster + the stump');
  const trunk = result.find((c) => (c.veinSize as number) === 5);
  assert.ok(trunk, 'trunk reported with veinSize 5');
  assert.deepEqual(trunk!.position, { x: 3, y: 0, z: 3 }, 'cluster anchored at its closest block');
  assert.ok((result[0].distance as number) <= (result[1].distance as number), 'sorted by distance');
});

test('find_blocks: comma alternatives find ANY of the names', async () => {
  const world = groundedWorld();
  world.set(2, 0, 0, 'coal_ore');
  world.set(0, 0, 4, 'deepslate_coal_ore');
  const { bot } = fakeBot(world, { position: [0, 0, 0], blockNames: ['coal_ore', 'deepslate_coal_ore'], inventory: {} });
  const result = (await invoke(findTool(bot), { name: 'coal_ore, deepslate_coal_ore' })) as Array<Record<string, unknown>>;
  assert.equal(result.length, 2);
  assert.deepEqual(new Set(result.map((c) => c.block)), new Set(['coal_ore', 'deepslate_coal_ore']));
});

test('find_blocks: buried vein says exposed=false, surface says true', async () => {
  const world = groundedWorld();
  // Bury a vein: iron at y=-3, sealed in stone on all six sides.
  world.set(0, -3, 0, 'iron_ore');
  for (const [dx, dy, dz] of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]])
    world.set(dx, -3 + dy, dz, 'stone');
  world.set(5, 0, 5, 'iron_ore'); // sitting in the open air
  const { bot } = fakeBot(world, { position: [0, 0, 0], blockNames: ['iron_ore', 'stone'], inventory: {} });
  const result = (await invoke(findTool(bot), { name: 'iron_ore' })) as Array<Record<string, unknown>>;
  const buried = result.find((c) => (c.position as { y: number }).y === -3)!;
  const surface = result.find((c) => (c.position as { y: number }).y === 0)!;
  assert.equal(buried.exposed, false, 'sealed vein is not exposed');
  assert.equal(surface.exposed, true, 'open-air ore is exposed');
});

test('find_blocks: nothing nearby stays a friendly message', async () => {
  const { bot } = fakeBot(groundedWorld(), { position: [0, 0, 0], blockNames: ['diamond_ore'], inventory: {} });
  const result = await invoke(findTool(bot), { name: 'diamond_ore' });
  assert.match(String(result), /No 'diamond_ore' found within 64 blocks/);
});

// ── dig_vein ────────────────────────────────────────────────────────────────

function veinTool(bot: FakeBot) {
  const t = worldTools(bot as never).find((x) => (x as { toolSpec?: { name?: string } }).toolSpec?.name === 'dig_vein');
  assert.ok(t, 'dig_vein tool exists');
  return t;
}

test('dig_vein: one call fells the whole trunk', async () => {
  const world = groundedWorld();
  for (let y = 0; y < 5; y++) world.set(2, y, 2, 'oak_log');
  const { bot, log } = fakeBot(world, { position: [0, 0, 0], blockNames: ['oak_log'], inventory: {} });
  const result = String(await invoke(veinTool(bot), { x: 2, y: 0, z: 2 }));
  assert.match(result, /Dug 5 block\(s\) of oak_log \(vein exhausted\)/);
  assert.equal(log.dug.length, 5);
  assert.equal(world.get({ x: 2, y: 4, z: 2 }).name, 'air', 'top of the trunk is gone');
  assert.equal(world.get({ x: 2, y: -1, z: 2 }).name, 'grass_block', 'the ground survives — only matching blocks dug');
});

test('dig_vein: also= treats deepslate variant as the same vein', async () => {
  const world = groundedWorld();
  world.set(1, 0, 0, 'coal_ore');
  world.set(1, -1, 0, 'deepslate_coal_ore'); // diagonal-adjacent continuation
  const { bot, log } = fakeBot(world, { position: [0, 0, 0], blockNames: ['coal_ore', 'deepslate_coal_ore'], inventory: {} });
  const result = String(await invoke(veinTool(bot), { x: 1, y: 0, z: 0, also: 'deepslate_coal_ore' }));
  assert.match(result, /Dug 2 block\(s\)/);
  assert.equal(log.dug.length, 2);
});

test('dig_vein: maxBlocks cap stops honestly and says the vein continues', async () => {
  const world = groundedWorld();
  for (let x = 0; x < 10; x++) world.set(x, 0, 1, 'stone');
  const { bot, log } = fakeBot(world, { position: [0, 0, 0], blockNames: ['stone'], inventory: {} });
  const result = String(await invoke(veinTool(bot), { x: 0, y: 0, z: 1, maxBlocks: 4 }));
  assert.match(result, /Dug 4 block\(s\)/);
  assert.match(result, /cap.*call again/);
  assert.equal(log.dug.length, 4);
});

test('dig_vein: starting on air refuses with a pointer to find_blocks', async () => {
  const { bot } = fakeBot(groundedWorld(), { position: [0, 0, 0], blockNames: ['stone'], inventory: {} });
  await assert.rejects(invoke(veinTool(bot), { x: 0, y: 3, z: 0 }), /Nothing to dig.*find_blocks/);
});

// ── craft_item chaining ─────────────────────────────────────────────────────

const { inventoryTools } = await import('../src/tools/inventory.js');

const WOOD_RECIPES: FakeRecipe[] = [
  { makes: 'oak_planks', count: 4, needs: { oak_log: 1 } },
  { makes: 'stick', count: 4, needs: { oak_planks: 2 } },
  { makes: 'wooden_pickaxe', count: 1, needs: { oak_planks: 3, stick: 2 }, table: true },
];
const WOOD_ITEMS = ['oak_log', 'oak_planks', 'stick', 'wooden_pickaxe'];

function craftTool(bot: FakeBot) {
  const t = inventoryTools(bot as never).find((x) => (x as { toolSpec?: { name?: string } }).toolSpec?.name === 'craft_item');
  assert.ok(t, 'craft_item tool exists');
  return t;
}

function tableWorld(): FakeWorld {
  const w = groundedWorld();
  w.set(1, 0, 1, 'crafting_table');
  return w;
}

test('craft_item: logs → planks → sticks → pickaxe, one call', async () => {
  const { bot, inv, log } = fakeBot(tableWorld(), {
    position: [0, 0, 0],
    inventory: { oak_log: 2 },
    blockNames: ['crafting_table'],
    itemNames: WOOD_ITEMS,
    recipes: WOOD_RECIPES,
  });
  const result = String(await invoke(craftTool(bot), { item: 'wooden_pickaxe' }));
  assert.match(result, /wooden_pickaxe/);
  assert.match(result, /chained intermediates/);
  assert.equal(inv.get('wooden_pickaxe'), 1);
  assert.equal(inv.get('oak_log'), 0, 'both logs consumed');
  assert.ok(log.crafted.some((c) => c.includes('oak_planks')), 'planks crafted as an intermediate');
});

test('craft_item: missing materials named exactly, nothing crafted', async () => {
  const { bot, log } = fakeBot(tableWorld(), {
    position: [0, 0, 0],
    inventory: {},
    blockNames: ['crafting_table'],
    itemNames: WOOD_ITEMS,
    recipes: WOOD_RECIPES,
  });
  await assert.rejects(
    invoke(craftTool(bot), { item: 'wooden_pickaxe' }),
    /gather first: .*oak_log/,
  );
  assert.equal(log.crafted.length, 0);
});

test('craft_item: recipe variants backtrack to the wood we actually hold', async () => {
  const { bot, inv } = fakeBot(tableWorld(), {
    position: [0, 0, 0],
    inventory: { birch_planks: 2 },
    blockNames: ['crafting_table'],
    itemNames: ['oak_planks', 'birch_planks', 'stick'],
    recipes: [
      { makes: 'stick', count: 4, needs: { oak_planks: 2 } }, // listed first, we hold none
      { makes: 'stick', count: 4, needs: { birch_planks: 2 } },
    ],
  });
  const result = String(await invoke(craftTool(bot), { item: 'stick' }));
  assert.match(result, /stick/);
  assert.equal(inv.get('stick'), 4);
  assert.equal(inv.get('birch_planks'), 0, 'the birch variant was chosen');
});

test('craft_item: 11 plank variants cherry-first, holding only birch logs — birch path found (no variant cap)', async () => {
  // Regression for the live bug: minecraft-data lists crafting_table's plank
  // variants cherry-first with oak/birch/spruce at indices 8-10; a slice(0, 8)
  // cap never tried the birch variant and reported 'gather cherry_log'.
  const woods = ['cherry', 'mangrove', 'acacia', 'jungle', 'dark_oak', 'crimson', 'warped', 'bamboo', 'oak', 'spruce', 'birch'];
  const items = woods.flatMap((w) => [`${w}_log`, `${w}_planks`]).concat(['crafting_table']);
  const recipes: FakeRecipe[] = [
    // crafting_table variants in minecraft-data's cherry-first order (birch at index 10)
    ...woods.map((w) => ({ makes: 'crafting_table', count: 1, needs: { [`${w}_planks`]: 4 } })),
    // planks from logs, same hostile ordering
    ...woods.map((w) => ({ makes: `${w}_planks`, count: 4, needs: { [`${w}_log`]: 1 } })),
  ];
  const { bot, inv, log } = fakeBot(groundedWorld(), {
    position: [0, 0, 0],
    inventory: { birch_log: 3 },
    blockNames: ['crafting_table'],
    itemNames: items,
    recipes,
  });
  const result = String(await invoke(craftTool(bot), { item: 'crafting_table' }));
  assert.match(result, /crafting_table/);
  assert.equal(inv.get('crafting_table'), 1);
  assert.equal(inv.get('birch_log'), 2, 'exactly one birch log consumed');
  assert.ok(log.crafted.some((c) => c.includes('birch_planks')), 'birch planks crafted, not cherry');
  assert.ok(!log.crafted.some((c) => c.includes('cherry')), 'cherry path never executed');
});

test('craft_item: already holding enough is a no-op, said plainly', async () => {
  const { bot, log } = fakeBot(tableWorld(), {
    position: [0, 0, 0],
    inventory: { stick: 6 },
    blockNames: ['crafting_table'],
    itemNames: ['oak_planks', 'stick'],
    recipes: [{ makes: 'stick', count: 4, needs: { oak_planks: 2 } }],
  });
  assert.match(String(await invoke(craftTool(bot), { item: 'stick', count: 4 })), /Already had/);
  assert.equal(log.crafted.length, 0);
});

test('craft_item: table recipe with no table nearby states the fact, not an order', async () => {
  const { bot } = fakeBot(groundedWorld(), { // NO crafting table in the world
    position: [0, 0, 0],
    inventory: { oak_log: 5 },
    blockNames: ['crafting_table'],
    itemNames: WOOD_ITEMS,
    recipes: WOOD_RECIPES,
  });
  await assert.rejects(
    invoke(craftTool(bot), { item: 'wooden_pickaxe' }),
    /no crafting table within 32 blocks/,
  );
});

// ── death forensics: writePlace ─────────────────────────────────────────────

const { writePlace } = await import('../src/tools/memory.js');

test('writePlace: death rail writes a floored, recallable, replaceable waypoint', async () => {
  const saved = writePlace('Last_Death', { x: 10.7, y: 64.2, z: -3.9 }, 'died here (overworld)', 'StrandsBot');
  assert.equal(saved.name, 'last_death', 'name normalized like remember_place does');
  assert.deepEqual([saved.x, saved.y, saved.z], [10, 64, -4], 'coords floored (Math.floor, not truncation — -3.9 → -4)');

  const { bot } = fakeBot(groundedWorld(), { position: [0, 0, 0], inventory: {} });
  const recall = memoryTools(bot as never).find((t) => (t as { toolSpec?: { name?: string } }).toolSpec?.name === 'recall_places')!;
  const places = (await invoke(recall, { query: 'death' })) as Array<Record<string, unknown>>;
  assert.equal(places.length, 1);
  assert.deepEqual(places[0].position, { x: 10, y: 64, z: -4 });

  writePlace('last_death', { x: 1, y: 2, z: 3 }, 'died again', 'StrandsBot');
  const after = (await invoke(recall, { query: 'death' })) as Array<Record<string, unknown>>;
  assert.equal(after.length, 1, 'same name replaces — no waypoint pileup across deaths');
  assert.deepEqual(after[0].position, { x: 1, y: 2, z: 3 });
});

// ── journey persistence ─────────────────────────────────────────────────────

const jfile = join(process.env.MEMORY_DIR!, 'journeys.json');

test('journeys: a running journey from a dead process loads as interrupted', async () => {
  // startedAt must be recent: `interrupted` now triages by age, and this test is
  // about the load-time verdict, not the staleness policy (asserted below).
  writeFileSync(jfile, JSON.stringify({ journeys: [
    { id: 'j1', goal: 'mine 64 iron', status: 'running', iterations: 7, startedAt: Date.now() - 60_000, journal: ['dug a shaft'] },
    { id: 'j0', goal: 'old done one', status: 'done', iterations: 2, startedAt: 0, journal: [], result: 'ok' },
  ] }));
  const { JourneyRunner } = await import('../src/journeys.js');
  const runner = new JourneyRunner();
  assert.equal(runner.interrupted.length, 1);
  assert.equal(runner.interrupted[0].id, 'j1');
  assert.match(runner.interrupted[0].result!, /died mid-journey after 7 step/);
  assert.equal(runner.get('j0')!.status, 'done', 'finished journeys load untouched');
  const onDisk = JSON.parse(readFileSync(jfile, 'utf8')).journeys;
  assert.equal(onDisk.find((j: { id: string }) => j.id === 'j1').status, 'interrupted', 'interruption is persisted back');
});

test('journeys: an ancient interrupted errand is abandoned, not re-offered', async () => {
  // The live soak accumulated FOUR pending errands over restarts, the oldest 100
  // minutes and zero steps deep. Boot must not hand those to the agent again.
  writeFileSync(jfile, JSON.stringify({ journeys: [
    { id: 'ancient', goal: 'recover my gear after death', status: 'running', iterations: 3, startedAt: Date.now() - 100 * 60_000, journal: ['walked west'] },
    { id: 'recent', goal: 'stock the pantry', status: 'running', iterations: 1, startedAt: Date.now() - 60_000, journal: ['no fish yet'] },
  ] }));
  const { JourneyRunner } = await import('../src/journeys.js');
  const runner = new JourneyRunner();
  assert.deepEqual(runner.interrupted.map((j) => j.id), ['recent']);
  assert.equal(runner.get('ancient')!.status, 'abandoned');
  assert.equal(runner.get('ancient')!.endedBy, 'stale');
  const onDisk = JSON.parse(readFileSync(jfile, 'utf8')).journeys;
  assert.equal(onDisk.find((j: { id: string }) => j.id === 'ancient').status, 'abandoned', 'and it stays abandoned across boots');
});

test('journeys: lifecycle writes land on disk (start → step → done)', async () => {
  writeFileSync(jfile, JSON.stringify({ journeys: [] }));
  const { JourneyRunner } = await import('../src/journeys.js');
  const runner = new JourneyRunner();
  runner.bind({ busy: 0, ask: async () => 'gathered the iron [JOURNEY_DONE]' } as never);
  const j = runner.start('gather iron');
  assert.equal(JSON.parse(readFileSync(jfile, 'utf8')).journeys[0].status, 'running', 'start persists immediately');
  for (let i = 0; i < 100 && runner.get(j.id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
  const done = JSON.parse(readFileSync(jfile, 'utf8')).journeys.find((x: { id: string }) => x.id === j.id);
  assert.equal(done.status, 'done');
  assert.match(done.result, /gathered the iron/);
  assert.equal(done.journal.length, 1);
});

test('journeys: corrupt file starts clean instead of crashing', async () => {
  writeFileSync(jfile, '{not json');
  const { JourneyRunner } = await import('../src/journeys.js');
  const runner = new JourneyRunner();
  assert.equal(runner.list().length, 0);
});

// ── fleet persistence ───────────────────────────────────────────────────────

const ffile = join(process.env.MEMORY_DIR!, 'fleet.json');
// The re-hire test spawns a REAL connection attempt (hire → run → createLiveBody,
// which reads MC_HOST/MC_PORT at connect time). Point it at an instantly-refused
// port so tests can never join whatever server happens to be running locally.
process.env.MC_HOST = '127.0.0.1';
process.env.MC_PORT = '1';

test('fleet: hires from a dead process load as interrupted, bodies/inboxes reset', async () => {
  writeFileSync(ffile, JSON.stringify({ workers: [
    { name: 'Chopper', task: 'fell trees', status: 'working', steps: 4, startedAt: 2, journal: ['felled 2 oaks'], inbox: ['stale instruction'] },
    { name: 'Digger', task: 'clear plot', status: 'done', steps: 9, startedAt: 1, journal: [], result: 'plot cleared' },
  ] }));
  const { Fleet } = await import('../src/fleet.js');
  const fleet = new Fleet();
  assert.equal(fleet.interrupted.length, 1);
  const chopper = fleet.interrupted[0];
  assert.equal(chopper.name, 'Chopper');
  assert.match(chopper.result!, /Process died while this worker was on the task \(4 step/);
  assert.deepEqual(chopper.inbox, [], 'stale instructions do not survive into a new process');
  assert.equal(chopper.body, undefined, 'a socket does not survive a process');
  assert.equal(fleet.list().find((w) => w.name === 'Digger')!.status, 'done', 'finished hires load untouched');
  assert.equal(JSON.parse(readFileSync(ffile, 'utf8')).workers.find((w: { name: string }) => w.name === 'Chopper').status, 'interrupted', 'interruption persisted back');
  assert.equal(fleet.active, 0, 'interrupted hires do not count as active headcount');
});

test('fleet: an interrupted name is re-hirable (guard only blocks live workers)', async () => {
  const { Fleet } = await import('../src/fleet.js');
  const fleet = new Fleet(); // Chopper is interrupted from the previous test's file
  assert.doesNotThrow(() => {
    // hire() flips state + persists BEFORE run() touches the network; the
    // connection attempt fails later, asynchronously — not under this assert.
    const w = fleet.hire('Chopper', 'finish felling');
    assert.equal(w.status, 'connecting');
  });
  assert.equal(JSON.parse(readFileSync(ffile, 'utf8')).workers.find((w: { name: string }) => w.name === 'Chopper').task, 'finish felling');
  fleet.retireAll(); // don't leave the failed-connect loop running into other tests
  // The connect attempt fails ASYNC and persists a terminal state when it
  // does — wait for it, or that write races the next test's fixture file
  // (observed flake: corrupt-ledger test found a valid ledger instead).
  for (let i = 0; i < 50; i++) {
    const w = fleet.list().find((x) => x.name === 'Chopper')!;
    if (w.status !== 'connecting' && w.status !== 'working') break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('fleet: corrupt ledger starts clean instead of crashing', async () => {
  // Import FIRST, then corrupt, then construct — all in one tick. The `await`
  // used to sit between the write and the read, and the previous test's worker
  // persisted a VALID ledger into exactly that gap (flaked at 2 !== 0 the moment
  // an unrelated new test shifted the timing). A hermetic test does not race.
  const { Fleet } = await import('../src/fleet.js');
  writeFileSync(ffile, '{not json');
  assert.equal(new Fleet().list().length, 0);
});

// ── parametric blueprints ───────────────────────────────────────────────────

const { draftStructure } = await import('../src/tools/blueprints.js');

test('draftStructure: box shell — hollow, roofed, door carved, corners not double-counted', () => {
  const { blocks, bill } = draftStructure({ shape: 'box', item: 'cobblestone', width: 5, depth: 4, height: 3 });
  // shell per layer: 2*5 + 2*4 - 4 corners = 14; two wall layers + full roof (5*4=20), minus 1×2 doorway
  assert.equal(bill.cobblestone, 14 * 3 + (20 - 14) - 2);
  const at = (x: number, y: number, z: number) => blocks.some((b) => b.dx === x && b.dy === y && b.dz === z);
  assert.ok(!at(1, 0, 1) && !at(2, 1, 2), 'interior is hollow');
  assert.ok(at(1, 2, 1), 'roof covers the interior');
  assert.ok(!at(2, 0, 3) && !at(2, 1, 3), 'south doorway: 1×2 carved at footprint center');
  assert.ok(at(2, 2, 3), 'lintel above the doorway stays');
  const keys = new Set(blocks.map((b) => `${b.dx},${b.dy},${b.dz}`));
  assert.equal(keys.size, blocks.length, 'no duplicate offsets — executor would reject them');
});

test('draftStructure: floor option raises the doorway so it never carves the floor', () => {
  const { blocks } = draftStructure({ shape: 'box', item: 'oak_planks', width: 3, depth: 3, height: 4, floor: true, door: 'north' });
  const at = (x: number, y: number, z: number) => blocks.some((b) => b.dx === x && b.dy === y && b.dz === z);
  assert.ok(at(1, 0, 0), 'floor-level block on the door face survives');
  assert.ok(!at(1, 1, 0) && !at(1, 2, 0), 'doorway carved at dy=1..2 instead');
});

test('draftStructure: wall/pillar/floor shapes and the executor-order support property', () => {
  assert.equal(draftStructure({ shape: 'wall', item: 'stone', width: 6, height: 2 }).blocks.length, 12);
  assert.equal(draftStructure({ shape: 'pillar', item: 'stone', height: 5 }).blocks.length, 5);
  assert.equal(draftStructure({ shape: 'floor', item: 'stone', width: 4, depth: 4 }).blocks.length, 16);

  // The placement-order invariant the executor relies on: sorted by dy,dx,dz,
  // every non-ground block touches the ground, a lower block, or an EARLIER
  // block in the same layer (in-pass horizontal propagation for roofs).
  const { blocks } = draftStructure({ shape: 'box', item: 'stone', width: 7, depth: 7, height: 4 });
  const sorted = [...blocks].sort((a, b) => a.dy - b.dy || a.dx - b.dx || a.dz - b.dz);
  const placed = new Set<string>();
  for (const b of sorted) {
    if (b.dy > 0) {
      const supports = [
        `${b.dx},${b.dy - 1},${b.dz}`,
        `${b.dx - 1},${b.dy},${b.dz}`, `${b.dx + 1},${b.dy},${b.dz}`,
        `${b.dx},${b.dy},${b.dz - 1}`, `${b.dx},${b.dy},${b.dz + 1}`,
      ];
      assert.ok(supports.some((k) => placed.has(k)), `block at ${b.dx},${b.dy},${b.dz} would float when reached in order`);
    }
    placed.add(`${b.dx},${b.dy},${b.dz}`);
  }
});

test('draftStructure: nonsense dimensions refused with the limit named', () => {
  assert.throws(() => draftStructure({ shape: 'box', item: 'stone', width: 2 }), /width must be an integer 3–32/);
  assert.throws(() => draftStructure({ shape: 'pillar', item: 'stone', height: 0 }), /height must be an integer 1–64/);
  assert.throws(() => draftStructure({ shape: 'wall', item: 'stone', width: 5.5 }), /width must be an integer/);
});

// ── thinker fleet supervision ───────────────────────────────────────────────

test('thinker: live workers appear in both modes with growth tracking; empty fleet adds nothing', async () => {
  const { Thinker } = await import('../src/thinker.js');
  const asked: string[] = [];
  const session = { busy: 0, ask: async (p: string) => { asked.push(p); return 'ok'; } };
  const worker = { name: 'Chopper', status: 'working', steps: 3, task: 'fell trees', journal: ['felled an oak'] };
  const journeys = { running: undefined as unknown };
  const fleet = { list: () => [worker, { name: 'Done1', status: 'done', steps: 9, task: 'x', journal: [] }] };
  const thinker = new Thinker(session as never, journeys as never, fleet as never);
  thinker.intervalMs = -1; // idle gate always open
  const cycle = () => (thinker as unknown as { maybeCycle: () => Promise<void> }).maybeCycle();

  await cycle(); // idle mode
  assert.match(asked[0], /idle thinker/);
  assert.match(asked[0], /Chopper \(working, step 3, 1 step\(s\) since your last look/, 'first look counts the whole journal as growth');
  assert.ok(!asked[0].includes('Done1'), 'finished workers are not supervised');

  journeys.running = { id: 'j1', goal: 'g', iterations: 1, journal: ['step'] };
  await cycle(); // supervisor mode, journal unchanged since last look
  assert.match(asked[1], /journey supervisor/);
  assert.match(asked[1], /Chopper \(working, step 3, 0 step\(s\) since your last look/, 'no growth twice = the stall signal the prompt teaches');

  const quiet = new Thinker(session as never, { running: undefined } as never, { list: () => [] } as never);
  quiet.intervalMs = -1;
  await (quiet as unknown as { maybeCycle: () => Promise<void> }).maybeCycle();
  assert.ok(!asked[2].includes('hired workers'), 'no live workers → no fleet section');
});

// ── world-truth block equivalence ───────────────────────────────────────────

test('blockSatisfies: exact names, wall variants, and no fuzzy forgiveness', async () => {
  const { blockSatisfies } = await import('../src/tools/blueprints.js');
  assert.ok(blockSatisfies('oak_planks', 'oak_planks'));
  assert.ok(blockSatisfies('torch', 'wall_torch'), 'torch placed on a wall');
  assert.ok(blockSatisfies('soul_torch', 'soul_wall_torch'), 'wall_ inserts into the family name');
  assert.ok(blockSatisfies('oak_sign', 'oak_wall_sign'));
  assert.ok(blockSatisfies('red_banner', 'red_wall_banner'));
  assert.ok(blockSatisfies('skeleton_skull', 'skeleton_wall_skull'));
  assert.ok(!blockSatisfies('oak_planks', 'oak_plank_stairs'), 'similar-name damage is still damage');
  assert.ok(!blockSatisfies('torch', 'redstone_wall_torch'), 'a different torch is the wrong torch');
  assert.ok(!blockSatisfies('cobblestone', 'air'), 'a hole is a hole');
  assert.ok(!blockSatisfies('cobblestone', undefined), 'unloaded chunk is not a match');
});

// ── dig hazard sense ────────────────────────────────────────────────────────

test('digHazards: lava/water pour-in, falling columns counted, self-support over a drop', async () => {
  const { digHazards } = await import('../src/tools/helpers.js');
  const world = (blocks: Record<string, string>) => (x: number, y: number, z: number) => blocks[`${x},${y},${z}`] ?? 'stone';

  // safe stone pocket
  assert.deepEqual(digHazards({ x: 0, y: 10, z: 0 }, world({})), []);

  // lava behind a side face — fatal wording, and it outranks water
  const lavaSide = digHazards({ x: 0, y: 10, z: 0 }, world({ '1,10,0': 'lava', '0,10,1': 'water' }));
  assert.equal(lavaSide.length, 1);
  assert.match(lavaSide[0], /LAVA.*fatal/);

  // water side alone — flood warning, not fatal
  assert.match(digHazards({ x: 0, y: 10, z: 0 }, world({ '0,10,-1': 'flowing_water' }))[0], /wash drops away/);

  // water directly BELOW is just a wet floor — not a hazard; lava below is
  assert.deepEqual(digHazards({ x: 0, y: 10, z: 0 }, world({ '0,9,0': 'water' })), []);
  assert.match(digHazards({ x: 0, y: 10, z: 0 }, world({ '0,9,0': 'lava' }))[0], /LAVA/);

  // gravel column counted to convey severity
  const col = digHazards({ x: 0, y: 10, z: 0 }, world({ '0,11,0': 'gravel', '0,12,0': 'gravel', '0,13,0': 'sand' }));
  assert.match(col[0], /3 falling block\(s\)/);

  // standing on the target over air = fall warning; over solid ground = fine
  const feet = { x: 0.4, y: 11, z: 0.6 }; // floor(0.4)=0, floor(11)-1=10
  assert.match(digHazards({ x: 0, y: 10, z: 0 }, world({ '0,9,0': 'air' }), feet)[0], /STANDING.*fall with it/);
  assert.deepEqual(digHazards({ x: 0, y: 10, z: 0 }, world({}), feet), []);
  // standing elsewhere: digging over air is not OUR problem
  assert.deepEqual(digHazards({ x: 0, y: 10, z: 0 }, world({ '0,9,0': 'air' }), { x: 5, y: 11, z: 5 }), []);
});

// ── darkness survey ─────────────────────────────────────────────────────────

test('darknessSurvey: finds spawnable spots, greedy torch plan covers them all', async () => {
  const { darknessSurvey } = await import('../src/tools/helpers.js');
  // Fake world: flat solid floor at y=9, air above, block light 0 everywhere
  // except a lit strip at x>2. Liquids and no-floor columns must not count.
  const probe = (x: number, y: number, z: number) => {
    if (x === 0 && z === 2) return { empty: false, solid: false, blockLight: 0 }; // water column stand-in
    if (x === 1 && z === 2 && y === 9) return { empty: true, solid: false, blockLight: 0 }; // hole: no solid floor
    if (y === 9) return { empty: false, solid: true, blockLight: 0 }; // floor
    if (y === 10 || y === 11) return { empty: true, solid: false, blockLight: x > 2 ? 14 : 0 }; // standing space
    return { empty: false, solid: true, blockLight: 0 }; // bedrock everywhere else
  };
  const { spots, torches } = await darknessSurvey({ x: 0, y: 10.5, z: 0 }, 2, probe);
  assert.ok(spots.length > 0, 'dark floor found');
  assert.ok(spots.every((s) => s.y === 10), 'spawn spots sit ON the floor');
  assert.ok(!spots.some((s) => s.x === 0 && s.z === 2), 'non-empty column excluded');
  assert.ok(!spots.some((s) => s.x === 1 && s.z === 2), 'floorless spot excluded');
  assert.ok(!spots.some((s) => s.x > 2), 'lit spots excluded');
  assert.ok(torches.length >= 1 && torches.length < spots.length, 'greedy cover beats one-torch-per-spot');
  // every spot within Manhattan 5 of some planned torch
  for (const s of spots) {
    assert.ok(torches.some((t) => Math.abs(s.x - t.x) + Math.abs(s.y - t.y) + Math.abs(s.z - t.z) <= 5), `covered: ${s.x},${s.y},${s.z}`);
  }
  // fully lit world = clean bill
  const lit = await darknessSurvey({ x: 0, y: 10, z: 0 }, 2, (x, y) => probe(x, y, 99) && { empty: y === 10 || y === 11, solid: y === 9, blockLight: 14 });
  assert.equal(lit.spots.length, 0);
});

test('darknessSurvey: a huge dark field respects the spot cap, breathes, and finishes fast (issue #4)', async () => {
  const { darknessSurvey } = await import('../src/tools/helpers.js');
  // Worst case: EVERY column at max radius is spawnable darkness — the shape
  // that used to run an O(n²)-per-pick greedy over ~16k spots synchronously.
  const probe = (_x: number, y: number, _z: number) => {
    if (y === 9) return { empty: false, solid: true, blockLight: 0 }; // floor everywhere
    if (y >= 10) return { empty: true, solid: false, blockLight: 0 }; // dark air above
    return { empty: false, solid: true, blockLight: 0 };
  };
  let breaths = 0;
  const started = Date.now();
  const { spots, torches, capped } = await darknessSurvey(
    { x: 0, y: 10, z: 0 }, 24, probe, 4,
    { breathe: async () => { breaths++; await new Promise((r) => setImmediate(r)); } },
  );
  const elapsed = Date.now() - started;
  assert.equal(capped, true, 'survey reports it hit the cap');
  assert.ok(spots.length <= 600, `spot cap respected (got ${spots.length})`);
  assert.ok(breaths > 0, 'yielded to the event loop mid-survey');
  assert.ok(elapsed < 2000, `bounded work finishes fast (took ${elapsed}ms)`);
  // the plan still covers everything it reported
  for (const s of spots) {
    assert.ok(torches.some((t) => Math.abs(s.x - t.x) + Math.abs(s.y - t.y) + Math.abs(s.z - t.z) <= 5), 'reported spots all covered');
  }
});

test('darknessSurvey: uncapped small survey reports capped=false', async () => {
  const { darknessSurvey } = await import('../src/tools/helpers.js');
  const probe = (_x: number, y: number) => {
    if (y === 9) return { empty: false, solid: true, blockLight: 0 };
    if (y === 10 || y === 11) return { empty: true, solid: false, blockLight: 0 };
    return { empty: false, solid: true, blockLight: 0 };
  };
  const { capped, spots } = await darknessSurvey({ x: 0, y: 10, z: 0 }, 2, probe);
  assert.equal(capped, false);
  assert.ok(spots.length > 0 && spots.length < 600);
});

// ── thinker idle rotation ───────────────────────────────────────────────────

test('pickFocus: rotates through every focus, never repeats adjacent, names only real tools', async () => {
  const { IDLE_FOCI, pickFocus } = await import('../src/thinker.js');
  // every cycle gets a focus, the whole list is visited, adjacent cycles differ
  const seen = new Set<string>();
  for (let c = 0; c < IDLE_FOCI.length * 2; c++) {
    const f = pickFocus(c);
    assert.ok(IDLE_FOCI.includes(f));
    if (IDLE_FOCI.length > 1) assert.notEqual(f, pickFocus(c + 1), 'adjacent cycles rotate');
    seen.add(f);
  }
  assert.equal(seen.size, IDLE_FOCI.length, 'rotation visits every focus');

  // Prompts that name tools must name REAL tools — a focus telling the agent
  // to call save_waypoint when the tool is remember_place sends it hunting.
  // Tool factories need a live bot, so harvest declared names statically.
  const real = new Set<string>();
  const src = readFileSync(new URL('../src/tools/perception.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/tools/memory.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/tools/world.ts', import.meta.url), 'utf8');
  for (const m of src.matchAll(/name: '([a-z_]+)'/g)) real.add(m[1]);
  for (const focus of IDLE_FOCI) {
    for (const m of focus.matchAll(/\b(check_darkness|place_block|list_inventory|remember_place|save_waypoint|recall_places)\b/g)) {
      assert.ok(real.has(m[1]), `focus references real tool: ${m[1]}`);
    }
  }
});

// ── auto-arm ────────────────────────────────────────────────────────────────

test('bestMeleeWeapon: picks by EXPECTED damage on the swing cadence, fist beats junk', async () => {
  const { bestMeleeWeapon } = await import('../src/tools/helpers.js');
  // Superseded the raw per-hit table on purpose: an axe's damage is only real if
  // its cooldown is paid, and the body swings on cfg.combat.swingIntervalMs
  // (600ms). At that cadence a stone_axe lands 43% of its 9 (=3.9) while an
  // iron_sword lands 94% of its 6 (=5.6) — the old table drew the weaker weapon
  // and called it the stronger one. See test/weapon-score.test.ts.
  assert.equal(bestMeleeWeapon(['iron_sword', 'stone_axe', 'bread']), 'iron_sword');
  assert.equal(bestMeleeWeapon(['iron_sword', 'stone_axe', 'bread'], 2000), 'stone_axe', 'given the charge time, raw damage wins');
  assert.equal(bestMeleeWeapon(['netherite_sword', 'diamond_axe']), 'netherite_sword');
  assert.equal(bestMeleeWeapon(['netherite_sword', 'diamond_axe'], 2000), 'diamond_axe');
  assert.equal(bestMeleeWeapon(['wooden_sword']), 'wooden_sword');
  assert.equal(bestMeleeWeapon(['cobblestone', 'bread', 'torch']), undefined, 'nothing beats a fist — skip the equip');
  assert.equal(bestMeleeWeapon([]), undefined);
  assert.equal(bestMeleeWeapon(['netherite_axe', 'trident', 'diamond_sword']), 'diamond_sword');
  assert.equal(bestMeleeWeapon(['netherite_axe', 'trident', 'diamond_sword'], 2000), 'netherite_axe');
});

// ── food picker ─────────────────────────────────────────────────────────────

test('bestFood: fit beats size, overshoot minimized, risky/precious never auto-picked', async () => {
  const { bestFood } = await import('../src/tools/helpers.js');
  const bag = ['cooked_beef', 'bread', 'cookie', 'rotten_flesh', 'golden_apple', 'torch'];
  assert.equal(bestFood(bag, 2), 'cookie', 'at food 18 the cookie fits, the steak wastes 6');
  assert.equal(bestFood(bag, 8), 'cooked_beef', 'at food 12 the steak fits exactly');
  assert.equal(bestFood(bag, 20), 'cooked_beef', 'starving: biggest meal');
  assert.equal(bestFood(['cookie', 'bread'], 3), 'bread', 'slight overfill beats leaving hunger unfixed');
  assert.equal(bestFood(['cooked_beef', 'rabbit_stew'], 9), 'rabbit_stew', 'restoring all 9 (1 wasted) beats restoring 8 and staying hungry');
  assert.equal(bestFood(['cooked_beef', 'rabbit_stew'], 8), 'cooked_beef', 'equal restore: the meal with no waste wins');
  assert.equal(bestFood(['rotten_flesh', 'pufferfish', 'chicken', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'suspicious_stew'], 20), undefined, 'risky and precious are the agent\'s call, by name only');
  assert.equal(bestFood(['torch', 'cobblestone'], 10), undefined);
});

// ── describeMissing: species-specific shortages become family advice ────────
test('describeMissing collapses wood species into gatherable families', async () => {
  const { describeMissing } = await import('../src/tools/helpers.js');
  // The live bug: planner reported 'gather 1x cherry_log' to a bot in a birch
  // forest. Any log works — the advice must say so.
  const woody = describeMissing(new Map([['cherry_log', 1]]));
  assert.equal(woody.length, 1);
  assert.match(woody[0], /ANY tree/i, 'a log shortage names the family, not one species');
  assert.match(woody[0], /birch_log/, 'and hands the agent a ready find_blocks list');

  const mixed = describeMissing(new Map([['cherry_planks', 4], ['warped_stem', 2], ['iron_ingot', 3]]));
  assert.equal(mixed.length, 3);
  assert.match(mixed[0], /4x planks — ANY wood/, 'planks collapse to the family');
  assert.match(mixed[1], /2x logs — ANY tree/, 'stems count as logs');
  assert.equal(mixed[2], '3x iron_ingot', 'non-wood shortages pass through untouched — those really are specific');

  assert.deepEqual(describeMissing(new Map()), [], 'nothing missing, nothing said');
});

// ── the stale-light bug (live soak, 2026-08-17) ─────────────────────────────
// The survey kept reporting the same ~182 dark spots with a torch plan the bot
// had already executed, because block.light stayed 0 on that server: a placed
// torch changed nothing, and the torch's own cell (empty boundingBox, light 0)
// even qualified as spawnable darkness. Reproduced here with a world whose
// light data is dead but whose torches are real.

/** A room with a solid floor, air above, block-light permanently 0 (broken
 *  light data), and torches at the given positions. */
function brokenLightWorld(torchAt: Array<{ x: number; y: number; z: number }>) {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const torches = new Set(torchAt.map((t) => key(t.x, t.y, t.z)));
  return (x: number, y: number, z: number) => {
    if (torches.has(key(x, y, z))) {
      return { empty: true, solid: false, blockLight: 0, luminance: 14 }; // a torch: emits, reads 0
    }
    if (y === 9) return { empty: false, solid: true, blockLight: 0, luminance: 0 }; // floor
    if (y === 10 || y === 11) return { empty: true, solid: false, blockLight: 0, luminance: 0 };
    return { empty: false, solid: true, blockLight: 0, luminance: 0 };
  };
}

test('darknessSurvey: a torch that already exists is never a dark spot or a plan target', async () => {
  const { darknessSurvey } = await import('../src/tools/helpers.js');
  const probe = brokenLightWorld([{ x: 0, y: 10, z: 0 }]);
  const { spots, torches, lights, coveredByExisting, lightDataSuspect } = await darknessSurvey({ x: 0, y: 10, z: 0 }, 3, probe);
  assert.equal(lights.length, 1, 'the torch is SEEN even though the light level says nothing');
  assert.ok(!spots.some((s) => s.x === 0 && s.y === 10 && s.z === 0), "the torch's own cell is not spawnable darkness");
  assert.ok(!torches.some((t) => t.x === 0 && t.y === 10 && t.z === 0), 'the plan never aims at a burning torch');
  assert.ok(coveredByExisting > 0, 'spots around the torch are credited as lit');
  assert.equal(lightDataSuspect, true, 'lights present + every cell reads 0 = the light data is not to be trusted');
});

test('darknessSurvey: an already-executed torch plan comes back empty, not identical (the soak loop)', async () => {
  const { darknessSurvey } = await import('../src/tools/helpers.js');
  const center = { x: 0, y: 10, z: 0 };
  // Pass 1: dark room, get a plan.
  const first = await darknessSurvey(center, 4, brokenLightWorld([]));
  assert.ok(first.spots.length > 20 && first.torches.length > 0);
  assert.equal(first.lightDataSuspect, false, 'no lights seen yet — nothing to be suspicious about');
  // Pass 2: the bot placed exactly that plan. The old code returned the same
  // spots and the same plan forever; now the room reads as covered.
  const second = await darknessSurvey(center, 4, brokenLightWorld(first.torches));
  assert.equal(second.lights.length, first.torches.length, 'every placed torch is seen');
  assert.equal(second.spots.length, 0, `plan executed → no darkness left, got ${second.spots.length}`);
  assert.equal(second.torches.length, 0, 'and nothing to place again');
  // Every former spot is accounted for: the cells the torches now occupy are
  // no longer scanned as spots at all, the rest are credited as lit.
  assert.equal(second.coveredByExisting + second.lights.length, first.spots.length, 'all previous spots accounted for');
  assert.equal(second.lightDataSuspect, true);
});

test('darknessSurvey: with working light data the report claims no unreliability', async () => {
  const { darknessSurvey } = await import('../src/tools/helpers.js');
  // Same room, but this server actually computes light: the torch's
  // neighbourhood reads lit, so the survey has real evidence.
  const probe = (x: number, y: number, z: number) => {
    const dist = Math.abs(x) + Math.abs(y - 10) + Math.abs(z);
    if (x === 0 && y === 10 && z === 0) return { empty: true, solid: false, blockLight: 14, luminance: 14 };
    if (y === 9) return { empty: false, solid: true, blockLight: Math.max(0, 14 - dist), luminance: 0 };
    if (y === 10 || y === 11) return { empty: true, solid: false, blockLight: Math.max(0, 14 - dist), luminance: 0 };
    return { empty: false, solid: true, blockLight: 0, luminance: 0 };
  };
  const { lights, lightDataSuspect, spots } = await darknessSurvey({ x: 0, y: 10, z: 0 }, 3, probe);
  assert.equal(lights.length, 1);
  assert.equal(lightDataSuspect, false, 'measured light present → no caveat');
  assert.equal(spots.length, 0, 'everything within 3 blocks of a torch is lit');
});

test('darknessSurvey: a dim light source only credits its own small reach', async () => {
  const { darknessSurvey } = await import('../src/tools/helpers.js');
  // luminance 3 (e.g. a magma-ish faint source): reach = luminance-1 = 2,
  // so it must NOT be credited with a torch's 5-block cover.
  const probe = (x: number, y: number, z: number) => {
    if (x === 0 && y === 10 && z === 0) return { empty: true, solid: false, blockLight: 0, luminance: 3 };
    if (y === 9) return { empty: false, solid: true, blockLight: 0, luminance: 0 };
    if (y === 10 || y === 11) return { empty: true, solid: false, blockLight: 0, luminance: 0 };
    return { empty: false, solid: true, blockLight: 0, luminance: 0 };
  };
  const { spots } = await darknessSurvey({ x: 0, y: 10, z: 0 }, 4, probe);
  assert.ok(spots.some((s) => Math.abs(s.x) + Math.abs(s.z) === 3), 'a spot 3 away from a luminance-3 source is still dark');
  assert.ok(!spots.some((s) => Math.abs(s.x) + Math.abs(s.z) <= 2), 'but its own 2-block reach is credited');
});

test('check_darkness tool: says the light data is unreliable instead of replanning placed torches', async () => {
  const { perceptionTools } = await import('../src/tools/perception.js');
  const world = new FakeWorld();
  // A 9×9 stone floor at y=9 with air above; FakeBlock carries no `light`
  // field, so this world reproduces the soak server exactly: block-light
  // reads 0 everywhere, forever.
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) world.set(x, 9, z, 'stone');
  world.set(0, 10, 0, 'torch'); // the torch the bot already placed
  const { bot } = fakeBot(world, { position: [0, 10, 0], blockNames: ['stone', 'torch', 'air'] });
  // Registry truth: a torch emits 14. (The fake registry keeps only ids.)
  (bot.registry.blocksByName as Record<string, { name: string; id: number; emitLight?: number }>).torch.emitLight = 14;
  const checkDarkness = perceptionTools(bot as never).find((t) => (t as { toolSpec: { name: string } }).toolSpec.name === 'check_darkness');
  const out = await invoke(checkDarkness, { radius: 3 });
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  assert.match(text, /not sending me block-light levels/, 'the tool admits its evidence is broken');
  assert.match(text, /1 light source/, 'and credits the torch that is already burning');
  if (typeof out !== 'string') {
    const plan = (out as { torchPlan: Array<{ x: number; y: number; z: number }> }).torchPlan;
    assert.ok(!plan.some((p) => p.x === 0 && p.y === 10 && p.z === 0), 'never plans a torch where one stands');
  }
});

// ── one cast at a time, and the door closes BEFORE the legs move ─────────
test('fish: a concurrent second cast bounces without touching the body', async () => {
  // Live journal 2026-08-17: 'Cast attempts keep cancelling each other (fish()
  // collision)' — the guard used to sit after approach/equip/lookAt, so the
  // second call walked and re-aimed the bot, which kills the bobber in flight.
  const world = new FakeWorld();
  world.set(8, 64, 0, 'water');
  const { bot, log } = fakeBot(world, {
    position: [0, 64, 0], inventory: { fishing_rod: 1 }, blockNames: ['water', 'fishing_rod'],
  });
  let casts = 0, resolveCast: (() => void) | undefined;
  const b = bot as unknown as Record<string, unknown>;
  b.findBlock = () => world.get(new Vec3(8, 64, 0));
  b.lookAt = async () => { (log as unknown as Record<string, number>).looks = ((log as unknown as Record<string, number>).looks ?? 0) + 1; };
  b.fish = () => { casts += 1; return new Promise<void>((r) => { resolveCast = r; }); };
  b.activateItem = () => {};

  const tools = interactionTools(bot as never);
  const fish = tools.find((t) => (t as { toolSpec: { name: string } }).toolSpec.name === 'fish');
  const first = invoke(fish, { maxDistance: 16 });
  await new Promise((r) => setTimeout(r, 30)); // let the first cast reach bot.fish()
  const gotoBefore = log.gotoCalls, looksBefore = (log as unknown as Record<string, number>).looks ?? 0;

  await assert.rejects(invoke(fish, { maxDistance: 16 }), /Already mid-cast/);
  assert.equal(log.gotoCalls, gotoBefore, 'the second call must not walk the body');
  assert.equal((log as unknown as Record<string, number>).looks ?? 0, looksBefore, 'nor re-aim it');
  assert.equal(casts, 1, 'and never call bot.fish() again — that cancels the bobber');

  resolveCast!();
  await first;
  // Door reopens once the cast is done.
  const second = invoke(fish, { maxDistance: 16 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(casts, 2, 'a sequential cast is allowed');
  resolveCast!();
  await second;
});

/**
 * Issue #46 — the mind's own planning read. `heldItem: 'empty hand'` was
 * already in get_status while the bot fought 120 bare-fisted swings, so the
 * field existed and meant nothing. The armed VERDICT has to be in the same
 * snapshot the model reads before it decides to go fight.
 */
test('#46 get_status and list_inventory carry the armed verdict, not just the held item', async () => {
  const { perceptionTools } = await import('../src/tools/perception.js');
  const world = new FakeWorld();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) world.set(x, 9, z, 'stone');
  const { bot } = fakeBot(world, { position: [0, 10, 0], blockNames: ['stone', 'air'] });
  // get_status reads vitals the pure-logic fake does not bother with.
  Object.assign(bot.entity as object, { yaw: 0, pitch: 0 });
  Object.assign(bot as object, {
    health: 20, food: 20, oxygenLevel: 20, experience: { level: 3 },
    entityEffects: [], time: { timeOfDay: 1000, isDay: true, moonPhase: 3 },
    isRaining: false, game: { dimension: 'overworld', gameMode: 'survival' }, isSleeping: false,
    getEquipmentDestSlot: (part: string) => ({ head: 5, torso: 6, legs: 7, feet: 8 }[part] ?? 5),
  });
  Object.assign(bot.inventory as object, {
    slots: [], emptySlotCount: () => 35,
  });
  const tools = perceptionTools(bot as never);
  const byName = (n: string) => tools.find((t) => (t as { toolSpec: { name: string } }).toolSpec.name === n);

  const bare = JSON.stringify(await invoke(byName('get_status'), {}));
  assert.match(bare, /empty hand/);
  assert.match(bare, /ARMED: FISTS/);
  assert.match(bare, /NO sword, axe or trident anywhere in your inventory/);

  // Same body, now with a weapon in the bag but not in the hand — the case
  // that costs a fight silently.
  (bot.inventory as unknown as { items: () => Array<{ name: string; count: number; slot: number }> }).items =
    () => [{ name: 'stone_axe', count: 1, slot: 36 }];
  const withAxe = JSON.stringify(await invoke(byName('list_inventory'), {}));
  assert.match(withAxe, /stone_axe IS in your inventory but is not in your hand/);
});

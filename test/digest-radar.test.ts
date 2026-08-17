/**
 * The radar and the collector — the first gap the coverage audit named.
 *
 * `hostilesNear` is the single implementation reflexes, sentinel and
 * `nearbyThreats` all delegate to, so every guard in it protects three rails at
 * once: a position-less entity (just spawned / torn down), the reconnect beat
 * where `bot.entity` is briefly undefined, and self-compare by id rather than
 * object identity (identity lies across the LiveBody proxy). `worldDigest` is
 * the text every self-prompt is fed, and it must survive a half-built bot.
 *
 * Real Vec3, hand-built bots cast as never — no server, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { hostilesNear, nearbyThreats, worldDigest } from '../src/digest.js';

type Ent = { id: number; name?: string; type?: string; kind?: string; position?: Vec3 };

/** A bot that is nothing but a position and an entity table. */
function radarBot(entities: Ent[], self: Ent | null = { id: 1, position: new Vec3(0, 64, 0) }) {
  const table: Record<string, Ent> = {};
  for (const e of entities) table[String(e.id)] = e;
  if (self) table[String(self.id)] = self;
  return { entity: self ?? undefined, entities: table } as never;
}

const hostile = (id: number, x: number, name = 'zombie'): Ent =>
  ({ id, name, type: 'hostile', position: new Vec3(x, 64, 0) });

// ---------------------------------------------------------------------------
// hostilesNear
// ---------------------------------------------------------------------------

test('hostilesNear: hostiles only, nearest first', () => {
  const bot = radarBot([
    hostile(2, 30, 'skeleton'),
    hostile(3, 5, 'creeper'),
    { id: 4, name: 'cow', type: 'mob', position: new Vec3(1, 64, 0) },
    { id: 5, name: 'Cagatay', type: 'player', position: new Vec3(2, 64, 0) },
  ]);
  const hits = hostilesNear(bot);
  assert.deepEqual(hits.map((h) => h.e.name), ['creeper', 'skeleton']);
  assert.equal(Math.round(hits[0].dist), 5);
});

test('hostilesNear: the minecraft-data category counts as hostile too', () => {
  // Real mobs arrive with kind='Hostile mobs' and type='mob' on some versions.
  const bot = radarBot([{ id: 2, name: 'husk', type: 'mob', kind: 'Hostile mobs', position: new Vec3(3, 64, 0) }]);
  assert.deepEqual(hostilesNear(bot).map((h) => h.e.name), ['husk']);
});

test('hostilesNear: range gate is inclusive of the boundary', () => {
  const bot = radarBot([hostile(2, 16), hostile(3, 17)]);
  assert.equal(hostilesNear(bot, 16).length, 1, 'exactly 16m is in range, 17m is out');
});

test('hostilesNear: entities without a position never throw (issue #5)', () => {
  const bot = radarBot([{ id: 2, name: 'zombie', type: 'hostile' }, hostile(3, 4)]);
  const hits = hostilesNear(bot);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].e.id, 3);
});

test('hostilesNear: self is excluded by id, not by object identity', () => {
  // A proxy hands out a DIFFERENT object for the same entity, so `!==` would
  // report the bot as its own threat. Same id, different object here.
  const self = { id: 1, name: 'StrandsBot', type: 'hostile' as const, position: new Vec3(0, 64, 0) };
  const bot = radarBot([{ ...self }], self);
  assert.deepEqual(hostilesNear(bot), []);
});

test('hostilesNear: mid-reconnect (no bot.entity) returns empty, not a throw', () => {
  assert.deepEqual(hostilesNear(radarBot([hostile(2, 3)], null)), []);
  assert.deepEqual(hostilesNear({ entity: { position: new Vec3(0, 0, 0), id: 1 } } as never), [],
    'a bot with no entities table is empty too');
});

test('hostilesNear: null holes in the entities table are skipped', () => {
  const bot = { entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: null, 3: undefined, 4: hostile(4, 6) } } as never;
  assert.equal(hostilesNear(bot).length, 1);
});

// ---------------------------------------------------------------------------
// nearbyThreats
// ---------------------------------------------------------------------------

test('nearbyThreats: at most three lines, nearest first, name + rounded distance + floored pos', () => {
  const bot = radarBot([hostile(2, 4, 'creeper'), hostile(3, 6.6, 'zombie'), hostile(4, 9, 'spider'), hostile(5, 12, 'witch')]);
  const lines = nearbyThreats(bot);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'creeper 4m (4, 64, 0)');
  assert.match(lines[1], /^zombie 7m \(6, 64, 0\)$/);
});

test('nearbyThreats: default range is 16m', () => {
  assert.deepEqual(nearbyThreats(radarBot([hostile(2, 20)])), []);
  assert.equal(nearbyThreats(radarBot([hostile(2, 20)]), 32).length, 1);
});

// ---------------------------------------------------------------------------
// worldDigest
// ---------------------------------------------------------------------------

function digestBot(over: Record<string, unknown> = {}) {
  return {
    health: 16.4,
    food: 11,
    oxygenLevel: 20,
    entity: { id: 1, position: new Vec3(12.7, 64.2, -8.9) },
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { isDay: false, moonPhase: 0 },
    isRaining: false,
    inventory: { items: () => [{ name: 'bread', count: 3 }, { name: 'torch', count: 8 }] },
    ...over,
  } as never;
}

test('worldDigest: reads vitals, rounds health, folds inventory into lanes', () => {
  const d = worldDigest(digestBot());
  assert.match(d, /HP 16\/20/, 'health is rounded, not 16.4');
  assert.match(d, /3 meal\(s\), 8 torch\(es\)/);
  assert.match(d, /12, 64, -9|12, 64, -8/, 'position is present');
});

test('worldDigest: never exceeds the 600-char self-prompt budget', () => {
  const d = worldDigest(digestBot({ inventory: { items: () => Array.from({ length: 60 }, (_, i) => ({ name: `iron_pickaxe_${i}`, count: 1 })) } }), {
    threats: () => Array.from({ length: 12 }, (_, i) => `zombie ${i}m (0, 64, 0)`),
    workers: () => ['a #1', 'b #2', 'c #3', 'd #4', 'e #5'],
    journey: () => ({ id: 'j1', goal: 'x'.repeat(200), step: 4, last: 'y'.repeat(200) }),
    reflexRecent: () => ['fled a creeper'],
  });
  assert.ok(d.length <= 600, `digest was ${d.length} chars`);
});

test('worldDigest: sources are optional and each one is asked exactly once', () => {
  let threats = 0;
  const d = worldDigest(digestBot(), { threats: () => { threats++; return ['creeper 3m (1, 64, 1)']; } });
  assert.equal(threats, 1);
  assert.match(d, /creeper 3m/);
  assert.doesNotThrow(() => worldDigest(digestBot()), 'no sources at all is legal');
});

test('worldDigest: reflexRecent is asked for exactly the last line', () => {
  const asked: Array<number | undefined> = [];
  worldDigest(digestBot(), { reflexRecent: (n) => { asked.push(n); return ['ate bread']; } });
  assert.deepEqual(asked, [1]);
});

test('worldDigest: a half-built bot (no entity, no inventory, no game) still produces text', () => {
  const d = worldDigest({ health: undefined, entity: undefined, inventory: undefined, game: undefined, time: undefined } as never);
  assert.ok(d.length > 0, 'digest is never empty');
  assert.match(d, /NO tools/, 'an empty bag reports no tools');
});

test('worldDigest: journey and workers land in the text when the rails supply them', () => {
  const d = worldDigest(digestBot(), {
    journey: () => ({ id: 'j7', goal: 'build a cabin', step: 3, last: 'chopped 4 logs' }),
    workers: () => ['miner #2'],
  });
  assert.match(d, /journey: j7 "build a cabin" step 3/);
  assert.match(d, /chopped 4 logs/);
  assert.match(d, /workers: miner #2/);
});

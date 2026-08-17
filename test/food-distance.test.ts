/**
 * Issue #34 — THE STARVING REMEDY'S ARITHMETIC.
 *
 * The suspicion off soak42 was that this line lied:
 *
 *   [starving] ... FORAGE: sweet berry bush 3 blocks away at (54,71,85) — a walk, no fight
 *
 * It did NOT: four lines earlier the same log has `wedge at (53, 70, 82)`, so
 * the bush really was ~3 blocks away. The line was true — and it was true only
 * because there happens to be exactly one producer of a `FoodSighting`
 * (`probeFoodWorld`), which measures the distance and the coordinate in the same
 * breath. That is an accident of there being one caller, not a property.
 *
 * So the property gets built instead: given a position, the distance in the
 * sentence is DERIVED from the coordinate in the sentence. A remembered
 * sighting reprices itself against where the body is now, and a sighting with
 * no coordinate is named as remembered rather than quoted as a fresh reading.
 * The same test pins the noun-stutter regression ("water water 15 blocks away").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foodRemedy, probeFoodWorld } from '../src/tools/helpers.js';

const starving = { food: 16, health: 12, counts: {} as Record<string, number> };

test('#34 a stale distance cannot survive next to a fresh coordinate', () => {
  // The line the supervisor feared: distance measured 90 blocks ago, coordinate
  // from the sighting. Priced from where the body IS, it tells the truth.
  const r = foodRemedy({
    ...starving,
    world: { probed: true, crop: { name: 'sweet_berry_bush', distance: 3, pos: { x: 54, y: 71, z: 85 } } },
    at: { x: -30, y: 60, z: 10 },
  });
  assert.match(r.line, /FORAGE: sweet berry bush \d+ blocks away at \(54,71,85\)/);
  const said = Number(/(\d+) blocks away at \(54,71,85\)/.exec(r.line)![1]);
  assert.ok(said > 80 && said < 130, `the distance must follow the coordinate, not the memory: ${said}`);
});

test('#34 the same sighting read from beside it is 3 blocks away, as soak42 said', () => {
  const r = foodRemedy({
    ...starving,
    world: { probed: true, crop: { name: 'sweet_berry_bush', distance: 3, pos: { x: 54, y: 71, z: 85 } } },
    at: { x: 53.5, y: 70, z: 82.4 },
  });
  assert.match(r.line, /sweet berry bush 3 blocks away at \(54,71,85\)/);
});

test('#34 a sighting with no coordinate is named as remembered, not priced as fresh', () => {
  const r = foodRemedy({
    ...starving,
    world: { probed: true, animal: { name: 'cow', distance: 12 } },
  });
  assert.match(r.line, /HUNT: cow 12 blocks away as last measured \(no coordinate to check it against\)/);
});

test('#34 the water is named once — no "water water 15 blocks away" stutter', () => {
  const r = foodRemedy({
    ...starving,
    counts: { fishing_rod: 1 },
    world: { probed: true, at: { x: 0, y: 64, z: 0 }, water: { name: 'water', distance: 15, pos: { x: 9, y: 62, z: 12 } } },
  });
  assert.equal(r.act, 'fish');
  assert.ok(!/water water/.test(r.line), r.line);
  assert.match(r.line, /water is 15 blocks away at \(9,62,12\)/);
});

test('#34 the unpayable-rod branch does not stutter either', () => {
  const r = foodRemedy({
    ...starving,
    world: { probed: true, at: { x: 0, y: 64, z: 0 }, water: { name: 'water', distance: 16, pos: { x: 0, y: 57, z: 16 } } },
  });
  assert.ok(!/water water/.test(r.line), r.line);
  // The unpayable rod is now a FOOTNOTE, not the lead (see food-payable.test.ts).
  assert.match(r.line, /NOT UNTIL I have .*string/);
});

test('#34 probeFoodWorld carries the position it measured FROM, and its numbers agree', () => {
  const me = { x: 10.4, y: 65, z: -3.2 };
  const bot = {
    entity: { position: me },
    registry: { blocksByName: { water: { id: 1 }, sweet_berry_bush: { id: 2 } } },
    findBlock: ({ matching }: { matching: number[]; maxDistance: number }) =>
      matching.includes(1)
        ? { name: 'water', position: { x: 14, y: 64, z: 0 } }
        : { name: 'sweet_berry_bush', position: { x: 12, y: 66, z: -1 } },
    entities: {},
  };
  const w = probeFoodWorld(bot as never, 48);
  assert.deepEqual(w.at, me, 'the probe must record where it stood');
  // Every sighting's own distance already agrees with its own coordinate...
  for (const s of [w.water, w.crop]) {
    assert.ok(s?.pos, 'a probed sighting has a coordinate');
    const d = Math.sqrt((s!.pos!.x - me.x) ** 2 + (s!.pos!.y - me.y) ** 2 + (s!.pos!.z - me.z) ** 2);
    assert.ok(Math.abs(d - s!.distance) < 1.5, `${s!.name}: ${s!.distance} vs ${d}`);
  }
  // ...and the sentence derives its number from the coordinate it prints.
  const line = foodRemedy({ ...starving, world: w }).line;
  const said = Number(/(\d+) blocks away at \(12,66,-1\)/.exec(line)![1]);
  assert.equal(said, Math.round(Math.sqrt((12 - me.x) ** 2 + (66 - me.y) ** 2 + (-1 - me.z) ** 2)));
});

test('#34 an unprobed world invents no distance at all', () => {
  const bot = { entity: {}, registry: {}, entities: {} };
  const w = probeFoodWorld(bot as never);
  assert.equal(w.probed, false);
  assert.equal(w.at, undefined);
  const r = foodRemedy({ ...starving, world: w });
  assert.equal(r.act, 'none');
  assert.ok(!/blocks away/.test(r.line), r.line);
  assert.match(r.line, /the honest plan is to TRAVEL/);
});

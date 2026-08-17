/**
 * Issue #34, second half — THE ESCAPE THAT WAS HONEST AND STILL IMPOSSIBLE.
 *
 * soak42, on the tip with the grading already truthful:
 *
 *   [self_preservation] EVACUATING water at 10/20 air, 6 hp — swam 10.0m upward
 *   (no shore within 16): STILL SUBMERGED — head underwater 10.0m later
 *   (attempt 1) → swimming again on the next tick
 *
 * Ten metres of swimming under a roof, graded correctly as a failure, and the
 * remedy was to do it again. `waterColumn` is the missing question (is UP even
 * a direction here?) and `lateralAirColumn` is the usual answer (the open
 * column at the edge of the overhang). A blocked column must beat the attempt
 * budget: repeating an impossible direction is not an attempt, it is ~5s of
 * drowning damage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waterColumn, lateralAirColumn, gradeEvacuation } from '../src/tools/helpers.js';

/** A world from a function of (x,y,z) → block name. */
const world = (f: (x: number, y: number, z: number) => string | undefined) => f;

test('#34 an open column names the distance to breathable air', () => {
  // feet at y=60, water to 64, air at 65
  const col = waterColumn({ x: 0.5, y: 60.2, z: 0.5 }, world((_x, y) => (y >= 65 ? 'air' : 'water')));
  assert.equal(col.kind, 'open');
  assert.equal(col.kind === 'open' && col.toAir, 5);
});

test('#34 a ceiling is named with its block and its y — not reported as open water', () => {
  const col = waterColumn({ x: 0.5, y: 60.2, z: 0.5 }, world((_x, y) => (y >= 63 ? 'stone' : 'water')));
  assert.equal(col.kind, 'blocked');
  assert.equal(col.kind === 'blocked' && col.block, 'stone');
  assert.equal(col.kind === 'blocked' && col.y, 63);
});

test('#34 water past the search is DEEP, not a fake ceiling and not 0 blocks to air', () => {
  const col = waterColumn({ x: 0, y: 40, z: 0 }, world(() => 'water'), 12);
  assert.equal(col.kind, 'deep');
  assert.equal(col.kind === 'deep' && col.searched, 12);
});

test('#34 an unloaded chunk overhead reads as open, and says it was a guess', () => {
  const col = waterColumn({ x: 0, y: 60, z: 0 }, world((_x, y) => (y > 61 ? undefined : 'water')));
  assert.equal(col.kind, 'open');
  assert.equal(col.kind === 'open' && col.unknown, true);
});

test('#34 the lateral exit is the nearest column that actually reaches air', () => {
  // A roof of stone at y>=63 everywhere EXCEPT a shaft at x=3 (a 1-block hole).
  const w = world((x, y) => {
    if (y >= 63) return x === 3 ? 'air' : 'stone';
    return 'water';
  });
  const exit = lateralAirColumn({ x: 0.5, y: 60.5, z: 0.5 }, w, 8);
  assert.ok(exit, 'the shaft must be found');
  assert.equal(exit!.x, 3);
  assert.equal(exit!.toAir, 3);
  assert.ok(exit!.dist >= 2 && exit!.dist <= 4, `nearest, not arbitrary: ${exit!.dist}`);
});

test('#34 an air pocket behind masonry is NOT a lateral exit (the shoreDirection lesson)', () => {
  // Open column at x=4, but a wall of stone at x=2 blocks the swim to it.
  const w = world((x, y) => {
    if (x === 2 && y < 63) return 'stone';           // the wall, at swimming height
    if (y >= 63) return x === 4 ? 'air' : 'stone';
    return 'water';
  });
  assert.equal(lateralAirColumn({ x: 0.5, y: 60.5, z: 0.5 }, w, 8), undefined);
});

test('#34 a sealed roof with no exit anywhere gives no lateral exit at all', () => {
  const w = world((_x, y) => (y >= 63 ? 'stone' : 'water'));
  assert.equal(lateralAirColumn({ x: 0.5, y: 60.5, z: 0.5 }, w, 6), undefined);
});

test('#34 a blocked column beats the attempt budget: attempt 1 does NOT swim again', () => {
  const v = gradeEvacuation({
    headClear: false, feetInWater: true, standingOnSolid: false, movedBlocks: 10, attempt: 1,
    column: { kind: 'blocked', block: 'stone', y: 63 },
    lateralExit: true,
  });
  assert.equal(v.escaped, false);
  assert.equal(v.next, 'swim_lateral', 'the direction was wrong, so the next thing is a DIFFERENT direction');
  assert.match(v.grade, /UP IS SEALED: stone at y=63/);
});

test('#34 sealed with nowhere to swim sideways digs through the ceiling on attempt 1', () => {
  const v = gradeEvacuation({
    headClear: false, feetInWater: true, standingOnSolid: false, movedBlocks: 0.4, attempt: 1,
    column: { kind: 'blocked', block: 'deepslate', y: 41 },
    lateralExit: false,
  });
  assert.equal(v.next, 'dig_up');
});

test('#34 an OPEN column keeps the old behaviour: swimming up is worth a second try', () => {
  const v = gradeEvacuation({
    headClear: false, feetInWater: true, standingOnSolid: false, movedBlocks: 3, attempt: 1,
    column: { kind: 'open', toAir: 4 },
  });
  assert.equal(v.next, 'swim_again');
});

test('#34 deep water says so in the verdict instead of implying a ceiling', () => {
  const v = gradeEvacuation({
    headClear: false, feetInWater: true, standingOnSolid: false, movedBlocks: 9, attempt: 2,
    column: { kind: 'deep', searched: 24 },
  });
  assert.match(v.grade, /water all the way up past 24 blocks/);
  assert.equal(v.next, 'dig_up');
});

test('#34 a head inside rock is SUFFOCATING, not treading water (live probe finding)', () => {
  const v = gradeEvacuation({
    headClear: true,            // !isWater is true of sandstone — the old trap
    headBlock: 'sandstone', headSealed: true,
    feetInWater: true, standingOnSolid: false, movedBlocks: 0.2, attempt: 1,
    column: { kind: 'blocked', block: 'sandstone', y: 61 },
  });
  assert.equal(v.escaped, false);
  assert.match(v.grade, /head is inside sandstone: this body is SUFFOCATING in a pocket, not treading water/);
  assert.equal(v.next, 'dig_up', 'the remedy is the block at head height, not a surface');
});

test('#34 head-high tall grass is NOT a wall: the old treading-water verdict stands', () => {
  const v = gradeEvacuation({
    headClear: true, headBlock: 'tall_grass', headSealed: false,
    feetInWater: true, standingOnSolid: false, movedBlocks: 4, attempt: 1,
  });
  assert.match(v.grade, /treading water/);
  assert.equal(v.next, 'swim_again');
});

test('#34 a submerged head still reads as underwater, not as suffocation', () => {
  const v = gradeEvacuation({
    headClear: false, headBlock: 'water', headSealed: false,
    feetInWater: true, standingOnSolid: false, movedBlocks: 10, attempt: 1,
    column: { kind: 'blocked', block: 'stone', y: 63 }, lateralExit: false,
  });
  assert.match(v.grade, /head underwater/);
  assert.equal(v.next, 'dig_up');
});

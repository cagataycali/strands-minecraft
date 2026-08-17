import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  woodSourceFact, isWoodSource, probeWoodSource, meleeShortfall, readArmed, WOOD_SCAN_RADIUS,
} from '../src/tools/helpers.js';

/**
 * SOAK34 is the whole reason this file exists. The armed fact fired 9 times in
 * 10 minutes and said the SAME sentence every time — "the handle has to come
 * from a tree" — while the nearest tree was 60 blocks away through a phantom
 * swarm. The mind believed it, planned the errand ("chop the spruce cluster at
 * -18,71,69, craft a wooden sword"), advanced ONE journey step (28m), died 10
 * times and re-planned the identical trip from spawn.
 *
 * So the tests below are about PRICE, not wording: a remedy is only actionable
 * when its cost in blocks is stated, and "no tree in reach" must be sayable.
 */

test('wood fact — a reachable tree is priced in blocks and located', () => {
  const line = woodSourceFact({ name: 'spruce_log', distance: 7.4, pos: { x: -18, y: 71, z: 69 } }, 64);
  assert.match(line, /nearest spruce_log is 7 blocks away at \(-18, 71, 69\)/);
  assert.match(line, /1 log crafts 4 planks/);
});

test('wood fact — the 60-block errand states the 60 blocks (soak34)', () => {
  const line = woodSourceFact({ name: 'spruce_log', distance: 60.4, pos: { x: -18, y: 71, z: 69 } }, 64);
  assert.match(line, /60 blocks away/, 'the distance IS the news');
});

test('wood fact — no tree in reach is a fact, not an implied errand', () => {
  const line = woodSourceFact(undefined, 64);
  assert.match(line, /NO tree within 64 blocks/);
  assert.match(line, /nothing in reach can pay for a handle/);
  assert.doesNotMatch(line, /has to come from a tree/, 'do not imply a trip that does not exist');
});

test('wood source — decided by structure, so an unseen species still resolves', () => {
  for (const n of ['spruce_log', 'cherry_log', 'oak_planks', 'warped_stem', 'crimson_hyphae', 'birch_wood', 'bamboo_block'])
    assert.equal(isWoodSource(n), true, n);
  for (const n of ['dirt', 'stone', 'iron_ingot', 'logbook', undefined]) assert.equal(isWoodSource(n as string), false, String(n));
});

test('probe — reads the real distance off the found block', () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByName: { spruce_log: { id: 11 }, dirt: { id: 1 } } },
    findBlock: (opts: { matching: number[]; maxDistance: number }) => {
      assert.deepEqual(opts.matching, [11], 'only wood ids are scanned');
      assert.equal(opts.maxDistance, WOOD_SCAN_RADIUS);
      return { name: 'spruce_log', position: { x: 3, y: 64, z: 4 } };
    },
  };
  const got = probeWoodSource(bot);
  assert.equal(got?.name, 'spruce_log');
  assert.equal(Math.round(got!.distance), 5);
  assert.deepEqual(got?.pos, { x: 3, y: 64, z: 4 });
});

test('probe — a throwing or empty world answers undefined, never a guess', () => {
  assert.equal(probeWoodSource({}), undefined);
  assert.equal(probeWoodSource({
    entity: { position: { x: 0, y: 0, z: 0 } },
    registry: { blocksByName: { oak_log: { id: 4 } } },
    findBlock: () => { throw new Error('chunk not loaded'); },
  }), undefined);
  assert.equal(probeWoodSource({
    entity: { position: { x: 0, y: 0, z: 0 } },
    registry: { blocksByName: { oak_log: { id: 4 } } },
    findBlock: () => null,
  }), undefined, 'no wood found is undefined, and the fact says so itself');
});

test('shortfall — bag-only stays bag-only: an unprobed world invents no distance', () => {
  const gap = meleeShortfall({ cobblestone: 30 });
  assert.match(gap!.line, /handle has to come from a tree\./);
  assert.doesNotMatch(gap!.line, /blocks away/);
});

test('shortfall — a probed world puts the distance in the remedy', () => {
  const gap = meleeShortfall({ cobblestone: 30 }, 600, {
    nearest: { name: 'spruce_log', distance: 61.2, pos: { x: -18, y: 71, z: 69 } }, radius: 64, probed: true,
  });
  assert.match(gap!.line, /MISSING 1 more stick/);
  assert.match(gap!.line, /nearest spruce_log is 61 blocks away/);
});

test('shortfall — a probed world with no tree says nothing in reach pays', () => {
  const gap = meleeShortfall({ cobblestone: 30 }, 600, { radius: 64, probed: true });
  assert.match(gap!.line, /NO tree within 64 blocks/);
});

test('shortfall — a bag that owns the handle never asks the world', () => {
  const gap = meleeShortfall({ cobblestone: 4, oak_log: 3 }, 600, {
    nearest: { name: 'spruce_log', distance: 61.2 }, radius: 64, probed: true,
  });
  assert.match(gap!.line, /You hold 3 log\(s\)/);
  assert.doesNotMatch(gap!.line, /blocks away/, 'the nearer answer wins');
});

test('readArmed — a live body prices the handle itself (the soak34 line, fixed)', () => {
  const bot = {
    heldItem: null,
    inventory: { items: () => [{ name: 'dirt', count: 3 }, { name: 'cobblestone', count: 30 }], slots: [] },
    entity: { position: { x: 1, y: 67, z: 30 } },
    registry: { blocksByName: { spruce_log: { id: 11 } } },
    findBlock: () => ({ name: 'spruce_log', position: { x: -18, y: 71, z: 69 } }),
  };
  const fact = readArmed(bot);
  assert.equal(fact.armed, false);
  assert.match(fact.line, /ARMED: FISTS/);
  assert.match(fact.line, /nearest spruce_log is 4[0-9] blocks away at \(-18, 71, 69\)/);
});

test('readArmed — a bodiless reader keeps the old sentence (no false "no tree")', () => {
  const fact = readArmed({
    heldItem: null,
    inventory: { items: () => [{ name: 'cobblestone', count: 30 }], slots: [] },
  });
  assert.match(fact.line, /handle has to come from a tree\./);
  assert.doesNotMatch(fact.line, /NO tree within/);
});

/**
 * Found by the live probe, not by reading the code: an empty-handed body in the
 * soak world was told "the handle has to come from a tree: the nearest
 * spruce_planks is 8 blocks away" — and a placed plank is not a tree. Mining it
 * returns the plank, so the log→plank step is already paid, and pricing that
 * errand as a logging trip overstates it by one step.
 */
test('wood fact — a placed plank block is a shorter errand than a tree', () => {
  const line = woodSourceFact({ name: 'spruce_planks', distance: 7.9, pos: { x: -25, y: 68, z: 15 } }, 64);
  assert.match(line, /a placed spruce_planks block is 8 blocks away at \(-25, 68, 15\)/);
  assert.match(line, /mining it returns the plank itself, and 2 planks craft 4 sticks/);
  assert.doesNotMatch(line, /come from a tree/, 'a plank is already a plank');
});

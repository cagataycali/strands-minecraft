/**
 * Issue #34 follow-on B — THE REMEDY THAT NAMED A PRICE THE BAG COULD NOT PAY.
 *
 * soak43, verbatim, at 1.3 hp:
 *   `[starving] STARVING with nothing edible in the bag — Food 16/20; health
 *   regenerates only at 18+ … At 1.3 hp the SAFEST remedy wins, not the best
 *   one. FISH would be safest (water 8 blocks away at (-39,62,1)) but the rod is
 *   unpayable: MISSING 3 more sticks and 2 more string (kill a spider)`
 * Every number was true. The body then held perfectly still for TEN consecutive
 * journey steps and whispered to the human for a food drop, because the route
 * the remedy LED with was the one route it could not take.
 *
 * The contract these tests pin: payability outranks safety and distance. An
 * unpayable route is a footnote ("NOT UNTIL I have X"). If nothing is payable
 * the honest lead is TRAVEL, not waiting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foodRemedy } from '../src/tools/helpers.js';

const soak43 = { food: 16, health: 1.3, counts: {} as Record<string, number> };
const water = { name: 'water', distance: 8, pos: { x: -39, y: 62, z: 1 } };

test('soak43: an unpayable rod is the ONLY route — so the lead is travel, not the rod', () => {
  const r = foodRemedy({ ...soak43, at: { x: -33, y: 60, z: 5 }, world: { probed: true, radius: 48, at: { x: -33, y: 60, z: 5 }, water } });
  assert.equal(r.act, 'none');
  assert.match(r.line, /NOT UNTIL I have 3 more sticks and 2 more string/);
  assert.match(r.line, /the honest plan is to TRAVEL/);
  assert.match(r.line, /nobody is coming/);
  assert.ok(!/SAFEST remedy wins/.test(r.line), 'no ranking talk when nothing is rankable');
});

test('a payable animal beats an unpayable rod even at 1.3 hp, and says why fists suffice', () => {
  const r = foodRemedy({ ...soak43, world: { probed: true, at: { x: 0, y: 64, z: 0 }, water, animal: { name: 'cow', distance: 12, pos: { x: 6, y: 64, z: 10 } } } });
  assert.equal(r.act, 'hunt');
  assert.match(r.line, /PAYABLE NOW: HUNT: cow/);
  assert.match(r.line, /bare fists is enough for it/);
  // the rod still gets named — as a price, at the end
  assert.match(r.line, /Not until I have what they cost: FISH \(water/);
  assert.ok(r.line.indexOf('PAYABLE NOW') < r.line.indexOf('NOT UNTIL'), r.line);
});

test('a crop outranks a hunt when both are payable and the body is dying', () => {
  const r = foodRemedy({ ...soak43, world: { probed: true, at: { x: 0, y: 64, z: 0 }, crop: { name: 'sweet_berry_bush', distance: 9, pos: { x: 5, y: 64, z: 7 } }, animal: { name: 'cow', distance: 4, pos: { x: 2, y: 64, z: 3 } } } });
  assert.equal(r.act, 'forage');
  assert.match(r.line, /PAYABLE NOW: FORAGE: sweet berry bush/);
  assert.match(r.line, /otherwise: HUNT: cow/);
});

test('a rod in the bag makes fishing payable and it leads at low hp', () => {
  const r = foodRemedy({ ...soak43, counts: { fishing_rod: 1 }, world: { probed: true, at: { x: 0, y: 64, z: 0 }, water, animal: { name: 'cow', distance: 3, pos: { x: 1, y: 64, z: 2 } } } });
  assert.equal(r.act, 'fish');
  assert.match(r.line, /PAYABLE NOW: FISH: water is/);
  assert.ok(!/Not until I have/.test(r.line), 'nothing is blocked, so nothing is footnoted');
});

test('food already edible in the bag short-circuits every errand', () => {
  const r = foodRemedy({ ...soak43, counts: { bread: 2 }, world: { probed: true, water } });
  assert.equal(r.act, 'eat');
  assert.match(r.line, /PAYABLE NOW: eat the bread already in my bag/);
});

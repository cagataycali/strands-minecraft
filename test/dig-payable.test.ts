/**
 * Issue #34 follow-on A — THE DIG THAT COULD NOT BE PAID FOR.
 *
 * soak43, verbatim: `EVACUATING water at 3/20 air, 18 hp — swam 1.2m upward
 * against stone at y=42 … UP IS SEALED … → could not dig the stone overhead:
 * dig timeout`. The grading was right; the remedy was arithmetic nobody had
 * done. A live probe against prismarine-block's own `digTime` (probe-digprice.mjs,
 * 1.21.4) prices stone for a body that is underwater and NOT standing on ground:
 *
 *   fist            dry  7.50s   underwater+offground 187.50s
 *   wooden_pickaxe  dry  1.15s   underwater+offground  28.15s
 *   stone_pickaxe   dry  0.60s   underwater+offground  14.10s
 *   iron_pickaxe    dry  0.40s   underwater+offground   9.40s
 *
 * A FULL air bar is 15s. So that dig was never payable at any tool tier — and
 * the ×5 underwater and ×5 off-ground penalties are why. The numbers below are
 * the probe's, not invented ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digPlan, airBudgetMs, bestDigTool, digHpCost, AIR_MS_PER_UNIT, DIG_SURVIVAL_FLOOR_HP } from '../src/tools/helpers.js';

test('the air budget is the bubbles left plus the drowning a body can survive', () => {
  // soak43's exact body: 3/20 air, 18 hp.
  const b = airBudgetMs({ airUnits: 3, health: 18 });
  assert.equal(b.ms, 3 * AIR_MS_PER_UNIT + ((18 - 4) / 2) * 1000); // 2.25s + 7s
  assert.match(b.why, /2\.3s of air left/);
  assert.match(b.why, /7\.0s of drowning I can survive down to 4 hp/);
  // At or under the reserve there is NO drowning to spend, and it says so.
  const dying = airBudgetMs({ airUnits: 2, health: 3, soleExit: false });
  assert.equal(dying.ms, 1500);
  assert.match(dying.why, /NO drowning to spend \(3\.0 hp is at or under the 4 hp reserve\)/);
});

test('soak43 verbatim: a bare-handed stone ceiling underwater is UNPAYABLE at any hand', () => {
  const plan = digPlan({
    block: 'stone',
    // the probe's real prices for a floating, submerged body
    candidates: [{ digMs: 187_500 }, { name: 'iron_pickaxe', digMs: 9_400 }],
    airUnits: 3,
    health: 18,
    canPillar: true,
  });
  assert.equal(plan.payable, false);
  assert.equal(plan.tool, 'iron_pickaxe', 'the cheapest hand is still named — the refusal is priced, not lazy');
  assert.match(plan.line, /UNPAYABLE: the stone overhead costs 9\.4s with iron pickaxe/);
  assert.match(plan.line, /a bare fist would cost 187\.5s/);
  assert.match(plan.line, /I can only pay 9\.3s/);
  assert.equal(plan.fallback, 'pillar');
  assert.match(plan.line, /placing a block to stand on instead/);
});

test('a sideways exit outranks a placed block as the thing the air buys', () => {
  const plan = digPlan({ block: 'stone', candidates: [{ digMs: 187_500 }], airUnits: 3, health: 18, lateralExit: true, canPillar: true });
  assert.equal(plan.fallback, 'swim_lateral');
  assert.match(plan.line, /swimming SIDEWAYS to the open column instead/);
});

test('nothing sideways and nothing placeable = the mind is handed the second', () => {
  const plan = digPlan({ block: 'deepslate', candidates: [{ digMs: 60_000 }], airUnits: 1, health: 4 });
  assert.equal(plan.fallback, 'ask');
  assert.match(plan.line, /mind's call, right now/);
});

test('a dig inside the budget is PAYABLE and names the hand it needs', () => {
  // A body STANDING on the bottom, air nearly full: stone with a stone pickaxe.
  const plan = digPlan({ block: 'stone', candidates: [{ digMs: 37_500 }, { name: 'stone_pickaxe', digMs: 3_000 }], airUnits: 18, health: 20 });
  assert.equal(plan.payable, true);
  assert.equal(plan.tool, 'stone_pickaxe');
  assert.match(plan.line, /PAYABLE: digging the stone overhead costs 3\.0s with stone pickaxe/);
  // 13.5s of air + drowning down to the 0.5 hp SURVIVAL floor, because with no
  // sideways column and nothing placeable this dig is the only exit there is.
  assert.match(plan.line, /and I can pay 23\.3s/);
  assert.match(plan.line, /this dig spends NO hp/);
  // The same body WITH a block to stand on keeps the comfortable 4 hp reserve.
  const spare = digPlan({ block: 'stone', candidates: [{ digMs: 37_500 }, { name: 'stone_pickaxe', digMs: 3_000 }], airUnits: 18, health: 20, canPillar: true });
  assert.match(spare.line, /and I can pay 21\.5s/);
});

test('the cheapest hand wins, and a tie keeps the hand already held (no pointless swap)', () => {
  assert.equal(bestDigTool([{ digMs: 900 }, { name: 'iron_pickaxe', digMs: 400 }, { name: 'diamond_pickaxe', digMs: 200 }])?.name, 'diamond_pickaxe');
  assert.equal(bestDigTool([{ name: 'a_pickaxe', digMs: 400 }, { name: 'b_pickaxe', digMs: 400 }], 'b_pickaxe')?.name, 'b_pickaxe');
  // A hand that cannot dig the block at all (Infinity) is not a hand.
  assert.equal(bestDigTool([{ digMs: Infinity }]), undefined);
  const none = digPlan({ block: 'obsidian', candidates: [{ digMs: Infinity }], airUnits: 5, health: 20 });
  assert.equal(none.payable, false);
  assert.match(none.line, /obsidian overhead cannot be dug by anything I hold/);
});

test('the block is named where it actually IS — one namer, one noun (caught live, not by a test)', () => {
  // soak46's boot print, verbatim: "the stone UNDERFOOT at y=59 … PAYABLE:
  // digging the stone OVERHEAD costs 7.5s with a bare fist". Two rails each
  // chose a noun; the sentence contradicted itself in nine words.
  const under = digPlan({ block: 'stone', where: 'underfoot', candidates: [{ digMs: 7_500 }], airUnits: 20, health: 20 });
  assert.match(under.line, /digging the stone underfoot costs 7\.5s/);
  assert.ok(!/overhead/.test(under.line), under.line);
  const nope = digPlan({ block: 'bedrock', where: 'underfoot', candidates: [{ digMs: Infinity }], airUnits: 20, health: 20 });
  assert.match(nope.line, /bedrock underfoot cannot be dug by anything I hold/);
  // and the default is still the overhead case every caller had before
  assert.match(digPlan({ block: 'stone', candidates: [{ digMs: 7_500 }], airUnits: 20, health: 20 }).line, /stone overhead/);
});


/**
 * soak47, THE RESERVE DEADLOCK, line 89 verbatim:
 *
 *   `[self_preservation] SUFFOCATING — head inside sand — 0 hp: could not dig
 *    the sand at head height … PAYABLE: digging the sand at head height costs
 *    0.8s with a bare fist and I can pay 15.0s — 15.0s of air left and NO
 *    drowning to spend (0.3 hp is at or under the 4 hp reserve)`
 *
 * The WRONG BELIEF: that an hp reserve applies to a dig at all. A reserve exists
 * to stop a dig that SPENDS hp; a 0.8s dig covered by the air bar spends none,
 * and the sentence still recited the reserve at a body with one exit and 0.3 hp.
 * The reserve now guards the hp the dig itself will drown — and when the dig is
 * the ONLY exit it gives way to a survival floor, because a reserve that forbids
 * the only exit is the reserve killing the body it protects.
 */
test('soak47: the dig that costs no hp is never a reserve\'s business (0.8s of sand at 0.3 hp)', () => {
  assert.equal(digHpCost({ digMs: 800, airUnits: 20 }), 0);
  const plan = digPlan({ block: 'sand', where: 'at head height', candidates: [{ digMs: 800 }], airUnits: 20, health: 0.3, hpReserve: 4 });
  assert.equal(plan.payable, true, plan.line);
  assert.match(plan.line, /PAYABLE: digging the sand at head height costs 0\.8s with a bare fist/);
  assert.match(plan.line, /this dig spends NO hp/);
  assert.match(plan.line, /the 4 hp reserve has nothing to protect/);
  // and it must NOT recite the reserve as a refusal any more
  assert.ok(!/NO drowning to spend/.test(plan.line), plan.line);
});

test('soak47: the only exit outranks the reserve, but never the survival floor', () => {
  // 1.5s of drowning past an empty bar = 3 hp. At 4 hp that is survivable and
  // it is the only way out, so it goes ahead — the old rule refused outright.
  const only = digPlan({ block: 'sand', candidates: [{ digMs: 1_500 }], airUnits: 0, health: 4, hpReserve: 4 });
  assert.equal(digHpCost({ digMs: 1_500, airUnits: 0 }), 3);
  assert.equal(only.payable, true, only.line);
  assert.match(only.line, /ONLY exit, so the 4 hp reserve gives way down to 0\.5 hp/);
  // The same dig with a sideways column in reach keeps the reserve: there is a
  // cheaper exit, so no hp needs spending here at all.
  const spare = digPlan({ block: 'sand', candidates: [{ digMs: 1_500 }], airUnits: 0, health: 4, hpReserve: 4, lateralExit: true });
  assert.equal(spare.payable, false, spare.line);
  assert.equal(spare.fallback, 'swim_lateral');
  // And the floor still bites: 4.0s of drowning is 8 hp, more than this body has.
  const fatal = digPlan({ block: 'stone', candidates: [{ digMs: 4_000 }], airUnits: 0, health: 4, hpReserve: 4 });
  assert.equal(fatal.payable, false, fatal.line);
  assert.equal(DIG_SURVIVAL_FLOOR_HP, 0.5);
});

test('soak43 stays refused: 28s of underwater stone at 3 hp is not survivable at any floor', () => {
  // The other end of the rule — the reserve giving way must not become a licence.
  const plan = digPlan({ block: 'stone', candidates: [{ name: 'wooden_pickaxe', digMs: 28_150 }], airUnits: 3, health: 3 });
  assert.equal(plan.payable, false, plan.line);
  assert.match(plan.line, /UNPAYABLE: the stone overhead costs 28\.1s/);
  assert.match(plan.line, /would drown 51\.8 hp out of the 3\.0 hp I hold/);
});

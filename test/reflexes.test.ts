/**
 * Reflex-layer pure-logic tests — the survival math the 300ms tick trusts.
 * A wrong hazard read burns the bot alive; a wrong armor rank strips it
 * naked; a wrong flee vector runs INTO the creeper. No server needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayTakeLegs, claimIsLive, claimRemainingMs, LegsLock, LEGS_PRIORITY, legsRankOf, legsTtlOf, legsWaitPlan, isGoalChangedError, explainGoalChange } from '../src/legs.js';
import { drowningUrgency, shoreDirection, type StuckSignals, stuckVerdict, oxygenReading, drowningEscape, standingHazards, bestArmorUpgrades, awayFrom, creeperVerdict } from '../src/tools/helpers.js';

// A tiny probe: world is a map of "x,y,z" -> name, everything else air.
const probe = (blocks: Record<string, string>) =>
  (x: number, y: number, z: number) => blocks[`${x},${y},${z}`] ?? 'air';

test('standingHazards: lava at the feet is burning, urgently', () => {
  const h = standingHazards({ x: 0.5, y: 64, z: 0.5 }, probe({ '0,64,0': 'lava' }));
  assert.equal(h.length, 1);
  assert.equal(h[0].kind, 'burning');
  assert.match(h[0].detail, /LAVA/);
});

test('standingHazards: fire under the feet counts (campfire walk)', () => {
  const h = standingHazards({ x: 0, y: 64, z: 0 }, probe({ '0,63,0': 'magma_block' }));
  assert.equal(h[0]?.kind, 'burning');
});

test('standingHazards: lava one step away is a warning, not "in lava"', () => {
  const h = standingHazards({ x: 0, y: 64, z: 0 }, probe({ '1,64,0': 'flowing_lava' }));
  assert.equal(h.length, 1);
  assert.equal(h[0].detail, 'lava one step away');
});

test('standingHazards: water over the head reported (caller pairs with oxygen)', () => {
  const h = standingHazards({ x: 0, y: 64, z: 0 }, probe({ '0,65,0': 'water' }));
  assert.deepEqual(h.map((x) => x.kind), ['water_over_head']);
});

test('standingHazards: gravel over the head block', () => {
  const h = standingHazards({ x: 0, y: 64, z: 0 }, probe({ '0,66,0': 'gravel' }));
  assert.deepEqual(h.map((x) => x.kind), ['falling_above']);
});

test('standingHazards: safe ground is silent', () => {
  const h = standingHazards({ x: 0, y: 64, z: 0 }, probe({ '0,63,0': 'stone', '5,64,0': 'lava' }));
  assert.deepEqual(h, []);
});

test('standingHazards: float positions floor to the right voxel', () => {
  const h = standingHazards({ x: -0.2, y: 64.9, z: -0.2 }, probe({ '-1,64,-1': 'lava' }));
  assert.equal(h[0]?.kind, 'burning');
});

test('bestArmorUpgrades: anything beats bare skin', () => {
  const up = bestArmorUpgrades(['leather_helmet'], {});
  assert.deepEqual(up, [{ slot: 'head', item: 'leather_helmet' }]);
});

test('bestArmorUpgrades: strictly better only — same tier stays put', () => {
  assert.deepEqual(bestArmorUpgrades(['iron_chestplate'], { torso: 'iron_chestplate' }), []);
  assert.deepEqual(bestArmorUpgrades(['golden_boots'], { feet: 'iron_boots' }), []);
});

test('bestArmorUpgrades: the full ladder holds', () => {
  const up = bestArmorUpgrades(
    ['leather_leggings', 'chainmail_leggings', 'diamond_leggings', 'netherite_leggings'],
    { legs: 'iron_leggings' },
  );
  assert.deepEqual(up, [{ slot: 'legs', item: 'netherite_leggings' }]);
});

test('bestArmorUpgrades: multi-slot pass, elytra never suggested', () => {
  const up = bestArmorUpgrades(
    ['iron_helmet', 'diamond_boots', 'elytra', 'bread'],
    { head: 'leather_helmet' },
  );
  assert.deepEqual(
    up.sort((a, b) => a.slot.localeCompare(b.slot)),
    [{ slot: 'feet', item: 'diamond_boots' }, { slot: 'head', item: 'iron_helmet' }],
  );
});

test('bestArmorUpgrades: turtle helmet sits between chainmail and iron', () => {
  assert.deepEqual(bestArmorUpgrades(['turtle_helmet'], { head: 'chainmail_helmet' }), [{ slot: 'head', item: 'turtle_helmet' }]);
  assert.deepEqual(bestArmorUpgrades(['turtle_helmet'], { head: 'iron_helmet' }), []);
});

test('awayFrom: runs directly opposite the threat, horizontally', () => {
  const to = awayFrom({ x: 0, y: 64, z: 0 }, { x: -3, y: 64, z: 0 }, 12);
  assert.equal(Math.round(to.x), 12);
  assert.equal(to.y, 64);
  assert.equal(Math.round(to.z), 0);
});

test('awayFrom: diagonal threat normalizes to the requested distance', () => {
  const to = awayFrom({ x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 4 }, 10);
  const dist = Math.hypot(to.x, to.z);
  assert.ok(Math.abs(dist - 10) < 0.01, `expected 10 blocks, got ${dist}`);
  assert.ok(to.x < 0 && to.z < 0, 'flees the opposite quadrant');
});

test('awayFrom: threat exactly underfoot still produces a direction', () => {
  const to = awayFrom({ x: 5, y: 64, z: 5 }, { x: 5, y: 60, z: 5 }, 8);
  assert.equal(to.x, 13);
  assert.equal(to.z, 5);
});

// ── stuckVerdict: issue #8, the staircase incident replayed ─────────────────

const base = {
  frozenMs: 60_000, hasGoal: true, digging: false, windowOpen: false,
  usingItem: false, progressMs: 60_000, noPathMs: Infinity, deliberateBusy: false,
};

test('stuckVerdict: digging a shaft for 60s with a goal is WORK, not stuck (issue #8)', () => {
  // The incident: journey digging a staircase, frozen >20s, goal set → the
  // old reflex jogged the bot off its own mineshaft. Any deliberate-
  // stationary signal must suppress the verdict entirely.
  assert.equal(stuckVerdict({ ...base, digging: true }), 'none');
  assert.equal(stuckVerdict({ ...base, windowOpen: true }), 'none', 'furnace/chest UI open');
  assert.equal(stuckVerdict({ ...base, usingItem: true }), 'none', 'eating / drawing a bow');
});

test('stuckVerdict: recent progress proves the stillness is productive', () => {
  assert.equal(stuckVerdict({ ...base, progressMs: 5_000 }), 'none', 'a dig just completed');
});

test('stuckVerdict: genuinely wedged while the mind is busy → note, never yank', () => {
  assert.equal(stuckVerdict({ ...base, deliberateBusy: true }), 'note');
  assert.equal(stuckVerdict({ ...base, deliberateBusy: true, noPathMs: 3_000, frozenMs: 21_000 }), 'note');
});

test('stuckVerdict: pathfinder said noPath and nobody deliberate owns the legs → shake', () => {
  assert.equal(stuckVerdict({ ...base, noPathMs: 3_000 }), 'shake');
  assert.equal(stuckVerdict(base), 'shake', 'frozen a full window with zero progress also counts');
});

test('stuckVerdict: fresh anchor after a flee + stale noPath is NOT stuck (live soak)', () => {
  // A dying/creeper flee resets the position anchor while a noPath from the
  // interrupted goal is seconds old — the bot is sprinting, not wedged.
  assert.equal(stuckVerdict({ ...base, frozenMs: 0, noPathMs: 3_000, deliberateBusy: true }), 'none');
  assert.equal(stuckVerdict({ ...base, frozenMs: 2_000, noPathMs: 3_000 }), 'none');
  assert.equal(stuckVerdict({ ...base, frozenMs: 6_000, noPathMs: 3_000 }), 'shake', 'still ≥5s with fresh noPath → real');
});

test('stuckVerdict: no goal, or not frozen long enough → none', () => {
  assert.equal(stuckVerdict({ ...base, hasGoal: false }), 'none');
  assert.equal(stuckVerdict({ ...base, frozenMs: 10_000, progressMs: 10_000 }), 'none', 'under the window with no noPath evidence');
});

// ── stuckNoteDue: the 22-note storm from the live soak (2026-08-17) ─────────
import { stuckNoteDue, stuckAdvice } from '../src/tools/helpers.js';

test('stuckNoteDue: first note of an episode always fires', () => {
  assert.equal(stuckNoteDue({ now: 1_000_000, lastNotedAt: 0, notesInEpisode: 0 }), true);
});

test('stuckNoteDue: a repeat 20s later is spam, not news', () => {
  // Exactly the storm: reflex cooldown is 20s and the wedge persists, so
  // stuckVerdict keeps saying 'note'. Only the gate stops 22 copies.
  const t0 = 1_000_000;
  assert.equal(stuckNoteDue({ now: t0 + 20_000, lastNotedAt: t0, notesInEpisode: 1 }), false);
  // Replay the storm: 22 cooldown ticks over 7.3 minutes of one wedge.
  let notes = 1;
  let lastNotedAt = t0;
  for (let i = 1; i <= 22; i++) {
    const now = t0 + i * 20_000;
    if (stuckNoteDue({ now, lastNotedAt, notesInEpisode: notes })) { notes++; lastNotedAt = now; }
  }
  assert.equal(notes, 3, '22 ticks of the same wedge yield 3 notes (t0, +2min, +6min), not 22');
});

test('stuckNoteDue: still stuck after the backoff → one escalating repeat', () => {
  const t0 = 1_000_000;
  assert.equal(stuckNoteDue({ now: t0 + 120_000, lastNotedAt: t0, notesInEpisode: 1 }), true);
  // and the next wait is twice as long
  assert.equal(stuckNoteDue({ now: t0 + 120_000, lastNotedAt: t0, notesInEpisode: 2 }), false);
  assert.equal(stuckNoteDue({ now: t0 + 240_000, lastNotedAt: t0, notesInEpisode: 2 }), true);
});

test('stuckNoteDue: backoff is capped so a permanent wedge still speaks up', () => {
  const t0 = 1_000_000;
  assert.equal(stuckNoteDue({ now: t0 + 600_000, lastNotedAt: t0, notesInEpisode: 12 }), true);
});

// ── escapeLadder: the flee races from the live soak (2026-08-17) ─────────────
import { escapeLadder, escapeRetry, classifyEscapeFailure } from '../src/tools/helpers.js';

test('escapeLadder: a 20-block panic flee degrades far → near → blind → fight', () => {
  const kinds = escapeLadder({ distance: 20, threatDist: 2, allowFight: true }).map((r) => r.kind);
  assert.deepEqual(kinds, ['path', 'path', 'blind', 'fight', 'give_up']);
  const [far, near] = escapeLadder({ distance: 20, threatDist: 2, allowFight: true }) as Array<
    { kind: 'path'; distance: number; tolerance: number; timeoutMs: number }
  >;
  assert.equal(far.distance, 20);
  assert.ok(near.distance < far.distance, 'the retry asks for LESS distance');
  assert.ok(near.tolerance > far.tolerance, 'and accepts a sloppier arrival');
  assert.ok(near.timeoutMs < far.timeoutMs, 'and gives up faster, because dying is on the clock');
});

test('escapeLadder: creepers never get a fight rung (punching a primed creeper is the death)', () => {
  const kinds = escapeLadder({ distance: 12, threatDist: 1.5, allowFight: false }).map((r) => r.kind);
  assert.deepEqual(kinds, ['path', 'path', 'blind', 'give_up']);
});

test('escapeLadder: no fight rung when nothing is in melee range', () => {
  const kinds = escapeLadder({ distance: 20, threatDist: 12, allowFight: true }).map((r) => r.kind);
  assert.ok(!kinds.includes('fight'));
  assert.deepEqual(kinds, ['path', 'path', 'blind', 'give_up']);
});

test('escapeLadder: a short hop has no pointless nearer-retry, but always a blind rung', () => {
  const kinds = escapeLadder({ distance: 2, threatDist: Infinity, allowFight: false }).map((r) => r.kind);
  assert.deepEqual(kinds, ['path', 'blind', 'give_up'], 'nearer retry would be the same goal');
});

test('escapeLadder: every ladder ends in give_up so the caller always reports something', () => {
  for (const d of [1, 6, 12, 20, 64]) {
    const ladder = escapeLadder({ distance: d, threatDist: 3, allowFight: true });
    assert.equal(ladder[ladder.length - 1].kind, 'give_up');
  }
});

test('stuckNoteDue: a NEW episode still respects the 60s floor (progress-flicker spam)', () => {
  // Live regression right after the episode gate shipped: the bot inched
  // forward, re-wedged, and produced two '1x this episode' notes 20s apart.
  const t0 = 2_000_000;
  assert.equal(stuckNoteDue({ now: t0 + 20_000, lastNotedAt: t0, notesInEpisode: 0 }), false);
  assert.equal(stuckNoteDue({ now: t0 + 60_000, lastNotedAt: t0, notesInEpisode: 0 }), true);
  // and a bot that has never been noted is never floored
  assert.equal(stuckNoteDue({ now: t0, lastNotedAt: 0, notesInEpisode: 0 }), true);
});

// ── drowning: the gauge, not the gesture (live soak 2026-08-17) ──────────
test('drowningEscape: open water overhead → swimming up is the escape', () => {
  const world = (x: number, y: number, z: number) => (y >= 66 ? 'air' : 'water');
  assert.deepEqual(drowningEscape({ x: 0.5, y: 64, z: 0.5 }, world), { how: 'swim' });
});

test('drowningEscape: a ceiling makes jump a no-op — dig through it', () => {
  // The observed case: 'swam up for 3s' three times while HP went 17 → 3,
  // because the bot was in a flooded pocket under stone.
  const world = (x: number, y: number, z: number) => (y === 66 ? 'stone' : 'water');
  const plan = drowningEscape({ x: 0.5, y: 64, z: 0.5 }, world);
  assert.deepEqual(plan, { how: 'dig', at: { x: 0, y: 66, z: 0 }, block: 'stone' });
});

test('drowningEscape: bedrock/obsidian overhead is trapped, not a dig plan', () => {
  for (const rock of ['bedrock', 'obsidian', 'barrier']) {
    const plan = drowningEscape({ x: 0.5, y: 64, z: 0.5 }, (x, y) => (y === 66 ? rock : 'water'));
    assert.equal(plan.how, 'trapped', rock);
    assert.match((plan as { why: string }).why, new RegExp(rock));
  }
});

test('drowningEscape: unloaded chunk overhead reads as passable, not as a dig', () => {
  // undefined is "we do not know" — swimming is the safe default; chewing an
  // imaginary block is not.
  assert.deepEqual(drowningEscape({ x: 0.5, y: 64, z: 0.5 }, () => undefined), { how: 'swim' });
});

test('drowningEscape: bubble columns and flowing water count as swimmable', () => {
  assert.deepEqual(drowningEscape({ x: 0.5, y: 64, z: 0.5 }, (x, y) => (y === 66 ? 'bubble_column' : 'water')), { how: 'swim' });
  assert.deepEqual(drowningEscape({ x: 0.5, y: 64, z: 0.5 }, (x, y) => (y === 66 ? 'flowing_water' : 'water')), { how: 'swim' });
});

// ── treading water is not work (live soak 2026-08-17) ────────────────────
const wedged = (over: Partial<StuckSignals> = {}): StuckSignals => ({
  frozenMs: 25_000, hasGoal: true, digging: false, windowOpen: false, usingItem: false,
  progressMs: 25_000, noPathMs: Infinity, deliberateBusy: true, ...over,
});

test('stuckVerdict: frozen underwater shakes even while the mind is busy', () => {
  // The live wedge: 3.5 HP, pathfinder goal across a lake, five minutes of
  // treading water while the drowning reflex bailed it out every few seconds.
  assert.equal(stuckVerdict(wedged({ drowning: true })), 'shake');
  assert.equal(stuckVerdict(wedged({ drowning: false })), 'note', 'on land, the mind still owns the legs');
});

test('stuckVerdict: underwater DIGGING is real work, not a wedge', () => {
  assert.equal(stuckVerdict(wedged({ drowning: true, digging: true })), 'none');
});

test('stuckVerdict: a drowning bot still needs a goal and a moment of stillness', () => {
  assert.equal(stuckVerdict(wedged({ drowning: true, hasGoal: false })), 'none');
  assert.equal(stuckVerdict(wedged({ drowning: true, frozenMs: 1_000 })), 'none', 'one dip is not a wedge');
});

// ── the oxygen gauge's two scales ────────────────────────────────────────
test('oxygenReading: raw air ticks map onto the bubble bar', () => {
  // Printed live as 'oxygen 7→398/20'.
  assert.deepEqual(oxygenReading(398), { units: 20, outOf: 20, ticks: true });
  assert.deepEqual(oxygenReading(300), { units: 20, outOf: 20, ticks: true });
  assert.equal(oxygenReading(150)!.units, 10);
});

test('oxygenReading: bar-scale values pass through, negatives bottom out at 0', () => {
  assert.deepEqual(oxygenReading(7), { units: 7, outOf: 20, ticks: false });
  assert.equal(oxygenReading(-1)!.units, 0, 'negative air = drowning damage landing');
  assert.equal(oxygenReading(undefined), undefined);
  assert.equal(oxygenReading(NaN), undefined);
});

// ── the way out of a lake is not a walk (live soak 2026-08-17) ───────────
test('shoreDirection: finds the nearest standable, breathable column', () => {
  // Water everywhere except a beach at x >= 4.
  const world = (x: number, y: number, z: number) =>
    x >= 4 ? (y <= 63 ? 'sand' : 'air') : (y <= 66 ? 'water' : 'air');
  const shore = shoreDirection({ x: 0.5, y: 62, z: 0.5 }, world);
  assert.ok(shore, 'a beach four blocks east is findable');
  assert.equal(shore!.x, 4);
  assert.equal(shore!.y, 64, 'stands on the sand at y=63, head clear above');
});

test('shoreDirection: open ocean has no answer, and says so', () => {
  assert.equal(shoreDirection({ x: 0.5, y: 62, z: 0.5 }, (x, y) => (y <= 66 ? 'water' : 'air')), undefined);
});

test('shoreDirection: a one-block ledge under water is not shore', () => {
  // Solid ground but the space above it is still water — swimming there drowns.
  const world = (x: number, y: number, z: number) => (x >= 4 && y <= 63 ? 'stone' : y <= 66 ? 'water' : 'air');
  assert.equal(shoreDirection({ x: 0.5, y: 62, z: 0.5 }, world, 6), undefined);
});

test('shoreDirection: rings mean the nearest shore wins over a closer-indexed far one', () => {
  const world = (x: number, y: number, z: number) => {
    // Two beaches, both breathable above the sand: one 2 west, one 9 east.
    if (x === -2 || x === 9) return y <= 63 ? 'sand' : 'air';
    return y <= 66 ? 'water' : 'air';
  };
  assert.equal(shoreDirection({ x: 0.5, y: 62, z: 0.5 }, world)!.x, -2);
});

// ── the water that actually killed it (live death 2026-08-17) ────────────
test('drowningUrgency: a critically hurt bot evacuates on the first mouthful', () => {
  // 3.5 HP in a flooded shaft: one drowning tick is 2 damage. Waiting for
  // oxygen < 8 is what killed it.
  assert.equal(drowningUrgency({ oxygenUnits: 19, health: 3.5 }), 'evacuate');
  assert.equal(drowningUrgency({ oxygenUnits: 2, health: 20 }), 'evacuate', 'almost no air is an emergency at any health');
});

test('drowningUrgency: a hurt-but-not-critical bot surfaces early', () => {
  assert.equal(drowningUrgency({ oxygenUnits: 12, health: 8 }), 'surface');
  assert.equal(drowningUrgency({ oxygenUnits: 12, health: 20 }), 'none', 'a healthy bot mid-dip is not the reflex\'s business');
});

test('drowningUrgency: the old constant threshold still holds for healthy bots', () => {
  assert.equal(drowningUrgency({ oxygenUnits: 7, health: 20 }), 'surface');
  assert.equal(drowningUrgency({ oxygenUnits: 20, health: 20 }), 'none');
});

test('drowningUrgency: unknown air is never an emergency, unknown health never blocks one', () => {
  assert.equal(drowningUrgency({ health: 3 }), 'none', 'no reading = no claim');
  assert.equal(drowningUrgency({ oxygenUnits: 2 }), 'evacuate');
});

// ── a wall is not a shore (live soak 2026-08-17, one fix later) ──────────
test('shoreDirection: an air pocket behind stone is not shore', () => {
  // The flooded-mineshaft case: real standable air 4 blocks away, solid rock
  // between. The bot 'swam 0.5m toward shore' twice and drowned nowhere nearer.
  const world = (x: number, y: number, z: number) => {
    if (x >= 4) return y <= 63 ? 'sand' : 'air';  // beach to the east…
    if (x === 2) return 'stone';                  // …behind a wall
    return y <= 66 ? 'water' : 'air';
  };
  assert.equal(shoreDirection({ x: 0.5, y: 62, z: 0.5 }, world, 8), undefined);
});

test('shoreDirection: the same beach IS shore once the wall is gone', () => {
  const world = (x: number, y: number, z: number) => (x >= 4 ? (y <= 63 ? 'sand' : 'air') : y <= 66 ? 'water' : 'air');
  assert.equal(shoreDirection({ x: 0.5, y: 62, z: 0.5 }, world, 8)!.x, 4);
});

test('shoreDirection: prefers a reachable far shore over a walled-off near one', () => {
  const world = (x: number, y: number, z: number) => {
    if (x === -2) return y <= 63 ? 'sand' : 'air';        // 2 west, walled off
    if (x === -1) return 'obsidian';                      // the wall
    if (x === 7) return y <= 63 ? 'sand' : 'air';         // 7 east, open water
    return y <= 66 ? 'water' : 'air';
  };
  assert.equal(shoreDirection({ x: 0.5, y: 62, z: 0.5 }, world)!.x, 7);
});

// ---------------------------------------------------------------------------
// The legs lock (issue #16): one body, many goal-setters. A life-or-death
// escape must not be re-pathed out from under itself.
// ---------------------------------------------------------------------------

test('mayTakeLegs: free legs go to anyone', () => {
  const v = mayTakeLegs(null, { owner: 'go_to', priority: LEGS_PRIORITY.agent }, 1_000);
  assert.equal(v.allowed, true);
});

test('mayTakeLegs: an in-flight death escape refuses the agent, the journey and idle theatre', () => {
  const claim = { owner: 'dying', priority: LEGS_PRIORITY.dying, claimedAt: 1_000, ttlMs: 15_000, what: 'a life-or-death escape' };
  for (const req of [
    { owner: 'go_to', priority: LEGS_PRIORITY.agent },
    { owner: 'journey', priority: LEGS_PRIORITY.journey },
    { owner: 'item_magnet', priority: LEGS_PRIORITY.idle },
  ]) {
    const v = mayTakeLegs(claim, req, 3_000);
    assert.equal(v.allowed, false, `${req.owner} must defer`);
    if (!v.allowed) {
      assert.equal(v.heldBy, 'dying');
      assert.match(v.reason, /life-or-death escape/);
      assert.match(v.reason, /13\.0s/); // truthful about the remaining time box
    }
  }
});

test('mayTakeLegs: a same-rank safety reflex defers instead of re-pathing (canceller #2)', () => {
  const claim = { owner: 'dying', priority: LEGS_PRIORITY.dying, claimedAt: 0, ttlMs: 15_000 };
  const v = mayTakeLegs(claim, { owner: 'self_preservation', priority: LEGS_PRIORITY.safety }, 3_000);
  assert.equal(v.allowed, false);
  // ...but dying DOES outrank a running self_preservation: pain order holds.
  const other = { owner: 'self_preservation', priority: LEGS_PRIORITY.safety, claimedAt: 0, ttlMs: 10_000 };
  assert.equal(mayTakeLegs(other, { owner: 'dying', priority: LEGS_PRIORITY.dying }, 3_000).allowed, true);
});

test('mayTakeLegs: the claim is time-boxed — a wedged escape cannot own the legs forever', () => {
  const claim = { owner: 'dying', priority: LEGS_PRIORITY.dying, claimedAt: 0, ttlMs: 15_000 };
  assert.equal(mayTakeLegs(claim, { owner: 'go_to', priority: LEGS_PRIORITY.agent }, 14_999).allowed, false);
  assert.equal(mayTakeLegs(claim, { owner: 'go_to', priority: LEGS_PRIORITY.agent }, 15_000).allowed, true);
  assert.equal(claimRemainingMs(claim, 20_000), 0);
  assert.equal(claimIsLive(claim, 20_000), false);
});

test('mayTakeLegs: the holder is re-entrant — a ladder rung may re-path its own escape', () => {
  const claim = { owner: 'dying', priority: LEGS_PRIORITY.dying, claimedAt: 0, ttlMs: 15_000 };
  assert.equal(mayTakeLegs(claim, { owner: 'dying', priority: LEGS_PRIORITY.dying }, 5_000).allowed, true);
});

test('legsRankOf/legsTtlOf: dying outranks and outlasts the other safety modes', () => {
  assert.equal(legsRankOf({ name: 'dying', safety: true }), LEGS_PRIORITY.dying);
  assert.equal(legsRankOf({ name: 'creeper_flee', safety: true }), LEGS_PRIORITY.safety);
  assert.equal(legsRankOf({ name: 'elbow_room', safety: false }), LEGS_PRIORITY.idle);
  assert.ok(legsTtlOf({ name: 'dying', safety: true }) > legsTtlOf({ name: 'creeper_flee', safety: true }));
  // Theatre holds the legs for a blink, not for seconds.
  assert.ok(legsTtlOf({ name: 'idle_staring', safety: false }) <= 2_000);
});

test('LegsLock: take/refuse/release, and a stale release cannot free someone else', () => {
  let now = 0;
  const lock = new LegsLock(() => now);
  const escape = lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 15_000, what: 'a life-or-death escape' })!;
  assert.ok(escape);
  assert.equal(lock.take({ owner: 'go_to', priority: LEGS_PRIORITY.agent, ttlMs: 5_000 }), null);
  assert.match(lock.deferMessage({ owner: 'go_to', priority: LEGS_PRIORITY.agent })!, /deferred:/);

  // The escape ends, the agent may move again.
  escape.release();
  assert.equal(lock.held(), null);
  assert.equal(lock.deferMessage({ owner: 'go_to', priority: LEGS_PRIORITY.agent }), null);
  const walk = lock.take({ owner: 'go_to', priority: LEGS_PRIORITY.agent, ttlMs: 5_000 })!;
  escape.release();                       // a late finally from the old claim
  assert.equal(lock.held()?.owner, 'go_to'); // must NOT hand away the new one
  walk.release();
});

test('LegsLock: an expired claim is not a claim (the bot always gets its legs back)', () => {
  let now = 0;
  const lock = new LegsLock(() => now);
  lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 15_000 });
  now = 16_000;
  assert.equal(lock.held(), null);
  assert.ok(lock.take({ owner: 'go_to', priority: LEGS_PRIORITY.agent, ttlMs: 5_000 }));
});

// Issue #22: the claim has to BIND the other side. A deliberate caller that
// never asks is how 2/2 live flees died as "goal was changed" and degraded to a
// 1m blind sprint with a creeper at 5.4 blocks.
test('legsWaitPlan: a short safety lease is waited out, not clobbered', () => {
  const claim = { owner: 'creeper_flee', priority: LEGS_PRIORITY.safety, claimedAt: 0, ttlMs: 10_000, what: 'the creeper_flee reflex' };
  const v = mayTakeLegs(claim, { owner: 'agent', priority: LEGS_PRIORITY.agent }, 8_000);
  const plan = legsWaitPlan(v, 4_000);
  assert.equal(plan.action, 'wait');
  assert.ok(plan.action === 'wait' && plan.ms >= 2_000 && plan.ms <= 2_100, `waits out the lease, got ${JSON.stringify(plan)}`);
});

test('legsWaitPlan: a lease longer than the patience becomes a truthful refusal', () => {
  const claim = { owner: 'dying', priority: LEGS_PRIORITY.dying, claimedAt: 0, ttlMs: 15_000, what: 'a life-or-death escape' };
  const plan = legsWaitPlan(mayTakeLegs(claim, { owner: 'journey', priority: LEGS_PRIORITY.journey }, 1_000), 4_000);
  assert.equal(plan.action, 'refuse');
  assert.match((plan as { reason: string }).reason, /life-or-death escape/);
  assert.match((plan as { reason: string }).reason, /Do not re-issue movement yet/);
});

test('legsWaitPlan: free legs go straight through', () => {
  assert.deepEqual(legsWaitPlan(mayTakeLegs(null, { owner: 'agent', priority: LEGS_PRIORITY.agent }, 0)), { action: 'go' });
});

test('isGoalChangedError / explainGoalChange: cancellation gets a NAME, never weather', () => {
  assert.equal(isGoalChangedError(new Error('The goal was changed before it could be completed!')), true);
  assert.equal(isGoalChangedError(new Error('flee timeout')), false);
  const claim = { owner: 'dying', priority: LEGS_PRIORITY.dying, claimedAt: 0, ttlMs: 15_000, what: 'a life-or-death escape' };
  assert.match(explainGoalChange(claim, 'agent', 1_000), /life-or-death escape \(dying\) took the legs/);
  // Its own claim, or an expired one, means somebody set a goal unowned — a bug
  // worth naming rather than "likely some background disturbance".
  // Same owner, live claim: the agent replaced its own path (issue #30) — a
  // scheduling smell with its own sentence, not the unowned-setGoal bug.
  assert.match(explainGoalChange(claim, 'dying', 1_000), /a newer dying path replaced this one/);
  assert.match(explainGoalChange(claim, 'agent', 99_000), /BUG: another rail called setGoal with NO claim/);
});

test('LegsLock.acquire: a deliberate walk yields to a live flee, then gets the legs', async () => {
  let now = 0;
  const lock = new LegsLock(() => now);
  const flee = lock.take({ owner: 'creeper_flee', priority: LEGS_PRIORITY.safety, ttlMs: 3_000, what: 'the creeper_flee reflex' });
  assert.ok(flee);
  const slept: number[] = [];
  const held = await lock.acquire(
    { owner: 'agent', priority: LEGS_PRIORITY.agent, ttlMs: 5_000, maxWaitMs: 4_000 },
    async (ms) => { slept.push(ms); now += ms; },
  );
  assert.ok(held, 'the walk eventually gets the legs');
  assert.deepEqual(slept, [3_050], 'it waited exactly the lease out — one sleep, no clobber');
  assert.equal(lock.held()?.owner, 'agent');
});

test('LegsLock.acquire: a 15s death escape refuses a journey step with a quotable reason', async () => {
  let now = 0;
  const lock = new LegsLock(() => now);
  lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 15_000, what: 'a life-or-death escape' });
  const held = await lock.acquire(
    { owner: 'journey', priority: LEGS_PRIORITY.journey, ttlMs: 5_000, maxWaitMs: 4_000 },
    async (ms) => { now += ms; },
  );
  assert.equal(held, null);
  assert.match(lock.lastRefusal ?? '', /life-or-death escape/);
  assert.equal(lock.held()?.owner, 'dying', 'the escape still owns the legs');
});

test('LegsLock.acquire: safety outranks a walk in flight and takes it immediately', async () => {
  let now = 0;
  const lock = new LegsLock(() => now);
  const walk = lock.take({ owner: 'agent', priority: LEGS_PRIORITY.agent, ttlMs: 60_000, what: 'go_to' });
  const held = await lock.acquire(
    { owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 15_000, what: 'a life-or-death escape' },
    async () => { throw new Error('safety must never wait'); },
  );
  assert.ok(held);
  assert.equal(lock.held()?.owner, 'dying');
  // The superseded walk's own `finally` must not hand the legs away.
  walk!.release();
  assert.equal(lock.held()?.owner, 'dying');
  assert.match(lock.explainCancellation('agent'), /life-or-death escape \(dying\) took the legs/);
});

// Degradation must be EVIDENCE-driven (issue #22): a timeout is terrain, a
// cancellation is another rail. Treating them alike is what turned a flee from
// a creeper at 5.4 blocks into a 1m blind sprint inside the blast radius.
test('classifyEscapeFailure: pathfinder words, sorted by what they prove', () => {
  assert.equal(classifyEscapeFailure(new Error('The goal was changed before it could be completed!')), 'cancelled');
  assert.equal(classifyEscapeFailure(new Error('flee timeout')), 'timeout');
  assert.equal(classifyEscapeFailure(new Error('NoPath')), 'other');
  assert.equal(classifyEscapeFailure(undefined), 'other');
});

test('escapeRetry: a cancelled path gets one more turn; terrain failures degrade at once', () => {
  assert.equal(escapeRetry({ failure: 'cancelled', retriesUsed: 0 }), true);
  // Twice cancelled means someone OUTRANKING us owns the legs — re-pathing
  // under that is the bug this whole arbitration exists to stop.
  assert.equal(escapeRetry({ failure: 'cancelled', retriesUsed: 1 }), false);
  assert.equal(escapeRetry({ failure: 'timeout', retriesUsed: 0 }), false, 'a timeout IS evidence: blind sprint next');
  assert.equal(escapeRetry({ failure: 'other', retriesUsed: 0 }), false);
});

test('escapeRetry: the retry never replaces the ladder, it delays it by one rung', () => {
  // Walk the whole ladder the way escape() does, with every path cancelled.
  const ladder = escapeLadder({ distance: 20, threatDist: 3, allowFight: true });
  const taken: string[] = [];
  let retries = 0;
  for (let i = 0; i < ladder.length; i += 1) {
    const rung = ladder[i]!;
    taken.push(rung.kind === 'path' ? `path${rung.distance}` : rung.kind);
    if (rung.kind === 'path' && escapeRetry({ failure: 'cancelled', retriesUsed: retries })) { retries += 1; i -= 1; }
    if (rung.kind === 'blind' || rung.kind === 'fight') break;
  }
  assert.deepEqual(taken, ['path20', 'path20', 'path7', 'blind'], 'one retry, then the ladder resumes — never a loop');
});

// ── The 27-note storm (issue #19, live soak 2026-08-18) ─────────────────────
// Durations climbed 20s → 286s while every single note claimed "(1x this
// episode)", and 22 of the 27 went to workers that finished their task.
test('stuckNoteDue: a repeat must carry news — half again as long, not ten more seconds', () => {
  const base = { now: 1_000_000, lastNotedAt: 1_000_000 - 130_000, notesInEpisode: 1 };
  // Backoff satisfied, but the wedge is barely longer than when we last spoke.
  assert.equal(stuckNoteDue({ ...base, frozenMs: 200_000, lastNotedFrozenMs: 190_000 }), false,
    'nothing new to say');
  assert.equal(stuckNoteDue({ ...base, frozenMs: 290_000, lastNotedFrozenMs: 190_000 }), true,
    'half again as long IS news');
  // Growth alone never overrides the backoff.
  assert.equal(stuckNoteDue({ now: 1_000_000, lastNotedAt: 1_000_000 - 30_000, notesInEpisode: 1, frozenMs: 999_000, lastNotedFrozenMs: 1_000 }), false);
  // Callers that do not track duration keep the old behaviour exactly.
  assert.equal(stuckNoteDue({ ...base }), true);
});

test('stuckAdvice: the fifth telling does not repeat the first telling', () => {
  const first = stuckAdvice(0, 20);
  assert.match(first, /stationary 20s/);
  assert.match(first, /Re-issue your movement/, 'the first time, re-issuing is sound advice');
  const second = stuckAdvice(1, 105);
  assert.match(second, /2nd warning/);
  assert.match(second, /stop_moving/);
  const fifth = stuckAdvice(4, 286);
  assert.match(fifth, /5th warning/);
  assert.match(fifth, /Re-issuing the same movement is not working/,
    'by now re-issuing is the thing that has been failing — say so');
  assert.match(fifth, /stop the journey/, 'and name who to stop if it keeps happening');
  assert.notEqual(fifth, first);
  // Every version states the duration: it is the only measured fact in the note.
  for (const [n, s] of [[0, 20], [1, 105], [4, 286]] as const) {
    assert.match(stuckAdvice(n, s), new RegExp(`${s}s`));
  }
});

test('stuckAdvice + stuckNoteDue together: one wedge escalates, it does not loop', () => {
  // Walk 10 minutes of a single 286s-and-growing wedge the way the reflex does.
  let notes = 0;
  let lastNotedAt = 0;
  let lastNotedFrozenMs = 0;
  const said: string[] = [];
  const anchorAt = 0;
  for (let now = 20_000; now <= 620_000; now += 20_000) { // the 20s cooldown
    const frozenMs = now - anchorAt;
    if (!stuckNoteDue({ now, lastNotedAt, notesInEpisode: notes, frozenMs, lastNotedFrozenMs })) continue;
    said.push(stuckAdvice(notes, Math.round(frozenMs / 1_000)));
    notes += 1;
    lastNotedAt = now;
    lastNotedFrozenMs = frozenMs;
  }
  // The old code produced one note per cooldown: 31 of them, all identical.
  assert.ok(said.length <= 4, `a ten-minute wedge is at most a handful of notes, got ${said.length}`);
  assert.equal(new Set(said).size, said.length, 'and no two of them are the same paragraph');
  assert.match(said[0]!, /Re-issue your movement/);
  assert.match(said[said.length - 1]!, /warning in one wedge/);
});

// ── creeperVerdict: the chest-room livelock, replayed ───────────────────────
test('creeperVerdict breaks the flee livelock without ever gambling a life', () => {
  // The report: a creeper near the chests preempted every walk, forever.
  // Behind a wall at 5 blocks → inert. Distance alone is not danger.
  assert.deepEqual(
    creeperVerdict({ dist: 5.2, lineOfSight: false, recentFlees: 0 }).act,
    'ignore', 'a creeper that cannot see you cannot swell');
  // Point blank we flee even blind — a raycast losing to a corner costs a life.
  assert.equal(
    creeperVerdict({ dist: 2.8, lineOfSight: false, recentFlees: 0 }).act,
    'flee', 'inside CREEPER_POINT_BLANK the raycast is not trusted');
  // Visible and close: the reflex does its job.
  assert.equal(creeperVerdict({ dist: 4, lineOfSight: true, recentFlees: 0 }).act, 'flee');
  assert.equal(creeperVerdict({ dist: 4, lineOfSight: true, recentFlees: 1 }).act, 'flee', 'one failed flee earns one more try');
  // Two flees have not shaken it → the standoff belongs to the mind, and the
  // legs go back to the errand it was starving.
  const v = creeperVerdict({ dist: 4, lineOfSight: true, recentFlees: 2 });
  assert.equal(v.act, 'escalate');
  assert.match((v as { why: string }).why, /camping or following/);
  // Point-blank camping still escalates — allowFight belongs to the mind, and
  // a third identical flee at 3 blocks is the same death, slower.
  assert.equal(creeperVerdict({ dist: 3, lineOfSight: true, recentFlees: 5 }).act, 'escalate');
});

// ── issue #34: the escape ran the rungs that matter with the legs FREE ───────
import { escapeBudgetMs } from '../src/tools/helpers.js';

test('escapeBudgetMs: the ladder costs MORE than the claim that was protecting it (soak41)', () => {
  const ladder = escapeLadder({ distance: 20, threatDist: 2, allowFight: true });
  const budget = escapeBudgetMs(ladder, { retries: 1 });
  // 8s far + 8s retry + 4s near + 1.5s blind + 2.5s fight
  assert.equal(budget, 24_000);
  // THE regression: the old hand-picked TTL cannot cover it, which is exactly
  // why soak41's rungs 2-4 were cancelled by rails that were legally allowed to.
  assert.ok(budget > legsTtlOf({ name: 'dying', safety: true }));
});

test('escapeBudgetMs: a ladder with no fight rung is priced without a fight', () => {
  const ladder = escapeLadder({ distance: 20, threatDist: 12, allowFight: true });
  assert.equal(escapeBudgetMs(ladder, { retries: 0 }), 8_000 + 4_000 + 1_500);
});

test('escapeRetry: a cancelled path is NOT retried once the legs are gone (the no-op path)', () => {
  assert.equal(escapeRetry({ failure: 'cancelled', retriesUsed: 0, holdsLegs: true }), true);
  assert.equal(escapeRetry({ failure: 'cancelled', retriesUsed: 0, holdsLegs: false }), false);
  // absent = old callers keep the old meaning, so this is safe to roll out
  assert.equal(escapeRetry({ failure: 'cancelled', retriesUsed: 0 }), true);
  assert.equal(escapeRetry({ failure: 'timeout', retriesUsed: 0, holdsLegs: true }), false);
});

test('a renewed same-owner claim keeps the legs past the original time box', () => {
  let now = 0;
  const lock = new LegsLock(() => now);
  const first = lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 15_000, what: 'an escape (dying)' });
  assert.ok(first);
  now = 14_000;
  // rung three renews: same owner is re-entrant, and the claim's clock restarts
  assert.ok(lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 12_000, what: 'an escape (dying)' }));
  now = 20_000; // past the ORIGINAL 15s box — the old code had no claim here
  assert.equal(lock.held()?.owner, 'dying');
  // and a journey walk is refused instead of cancelling a dying body's path
  assert.equal(lock.may({ owner: 'agent', priority: LEGS_PRIORITY.journey }).allowed, false);
});

test('the escape stops rather than pathing under a rail that outranks it', () => {
  let now = 0;
  const lock = new LegsLock(() => now);
  // something at dying rank is already escaping (a fleet sibling's rail, a
  // second episode) — a self_preservation escape must NOT re-path beneath it
  assert.ok(lock.take({ owner: 'dying', priority: LEGS_PRIORITY.dying, ttlMs: 10_000, what: 'an escape (dying)' }));
  assert.equal(lock.take({ owner: 'self_preservation', priority: LEGS_PRIORITY.safety, ttlMs: 5_000 }), null);
  assert.equal(lock.held()?.owner, 'dying');
});

// ── issue #34: the verb follows the killer, and hunger carries an errand ─────
import { dyingPlan } from '../src/reflexes.js';
import { foodRemedy, rodShortfall, probeFoodWorld, REGEN_FOOD } from '../src/tools/helpers.js';

test('dyingPlan: a flyer in reach is fought, a ground mob is fled', () => {
  assert.equal(dyingPlan({ threat: { name: 'phantom', dist: 2 } }).act, 'fight');
  assert.equal(dyingPlan({ threat: { name: 'zombie', dist: 2 } }).act, 'flee');
});

test('dyingPlan: water over the head is EVACUATED, not fled (soak41)', () => {
  const plan = dyingPlan({ hazards: [{ kind: 'water_over_head', detail: 'head underwater' }] });
  assert.equal(plan.act, 'evacuate');
  assert.match(plan.why, /not 20m of pathfinding/);
});

test('dyingPlan: lava outranks the water it is standing next to', () => {
  const plan = dyingPlan({ hazards: [{ kind: 'water_over_head', detail: 'head underwater' }, { kind: 'burning', detail: 'IN LAVA' }] });
  assert.equal(plan.act, 'evacuate');
  assert.equal(plan.act === 'evacuate' && plan.hazard.detail, 'IN LAVA');
});

test('dyingPlan: nothing chasing and nothing underfoot = STAND DOWN, no invented direction', () => {
  // THE soak41 line: "NO escape worked (…) — still at (2,61,-53), hostiles: none visible"
  const plan = dyingPlan({});
  assert.equal(plan.act, 'stand_down');
  assert.match(plan.why, /no direction is safer than another/);
});

test('dyingPlan: a mob out of reach is still worth walking away from', () => {
  assert.equal(dyingPlan({ threat: { name: 'zombie', dist: 12 } }).act, 'flee');
});

test('foodRemedy: food in the bag is the remedy, and it is free', () => {
  const r = foodRemedy({ food: 10, health: 3, counts: { bread: 2 } });
  assert.equal(r.act, 'eat');
  assert.match(r.line, /eat the bread/);
});

test('foodRemedy: at 0.16 hp the SAFEST option leads, not the nearest one', () => {
  const r = foodRemedy({
    food: 13, health: 0.166, counts: { fishing_rod: 1 },
    world: { probed: true, water: { name: 'water', distance: 6 }, animal: { name: 'cow', distance: 3 } },
  });
  assert.equal(r.act, 'fish');
  assert.match(r.line, /no contact with anything that hits back/);
  assert.match(r.line, /otherwise:.*HUNT/s); // the hunt is still named, just not led with
});

test('foodRemedy: healthy and hungry prefers the walk-and-pick option', () => {
  const r = foodRemedy({
    food: 12, health: 20, counts: {},
    world: { probed: true, water: { name: 'water', distance: 6 }, crop: { name: 'sweet_berry_bush', distance: 20 } },
  });
  assert.equal(r.act, 'forage');
});

test('foodRemedy: an UNPAYABLE rod is a footnote, never the lead (soak43 dead end)', () => {
  const r = foodRemedy({ food: 13, health: 1, counts: {}, world: { probed: true, water: { name: 'water', distance: 4 } } });
  assert.match(r.line, /NOT UNTIL I have 3 more sticks and 2 more string/);
  // soak43 LED with this route and the body then stood still for ten journey
  // steps at 1.3 hp: a route the bag cannot buy cannot be the advice.
  assert.equal(r.act, 'none');
  assert.match(r.line, /no errand here I can afford/);
  assert.ok(!/PAYABLE NOW/.test(r.line), r.line);
});

test('foodRemedy: a rod one plank-pair away is payable', () => {
  const r = foodRemedy({ food: 13, health: 1, counts: { oak_planks: 2, string: 2 }, world: { probed: true, water: { name: 'water', distance: 4 } } });
  assert.match(r.line, /rod is craftable/);
});

test('foodRemedy: NOTHING reachable is the no-op path — travel, and stop waiting on a human', () => {
  const r = foodRemedy({ food: 13, health: 0.2, counts: {}, world: { probed: true, radius: 48 } });
  assert.equal(r.act, 'none');
  assert.match(r.line, /Nothing I can pay for within 48 blocks/);
  assert.match(r.line, /nobody is coming/);
  assert.match(r.line, new RegExp(`regenerates only at ${REGEN_FOOD}`));
});

test('foodRemedy: an unprobed world invents no distances', () => {
  const r = foodRemedy({ food: 13, health: 5, counts: {} });
  assert.equal(r.act, 'none');
  assert.ok(!/blocks away/.test(r.line));
  assert.ok(!/Nothing edible within/.test(r.line)); // never claims a scan it did not run
});

test('foodRemedy: rotten flesh in the bag IS the payable route, and it leads', () => {
  // It used to be a trailing aside on a 'none' verdict — but poison in the bag
  // is the one meal that needs no errand, so at 4 hp it outranks every walk.
  const r = foodRemedy({ food: 6, health: 4, counts: { rotten_flesh: 3 }, world: { probed: true } });
  assert.equal(r.act, 'eat');
  assert.match(r.line, /PAYABLE NOW: EAT THE ROTTEN FLESH IN MY BAG/);
  assert.match(r.line, /the poison costs hp, an errand costs minutes/);
});

test('rodShortfall: planks count as sticks, and a full bag is no shortfall', () => {
  assert.equal(rodShortfall({ stick: 3, string: 2 }), undefined);
  assert.equal(rodShortfall({ oak_planks: 2, string: 2 }), undefined); // 2 planks → 4 sticks
  assert.match(rodShortfall({ stick: 3 })!.missing, /2 more string \(kill a spider\)/);
});

test('probeFoodWorld: a bodiless probe reports NOT probed rather than an empty world', () => {
  assert.equal(probeFoodWorld({}).probed, false);
});

// ── issue #34: an evacuation graded on ground truth, and air TREND ───────────
import { gradeEvacuation, pillarBlock } from '../src/tools/helpers.js';

test('gradeEvacuation: OUT means head clear, feet clear AND solid underfoot', () => {
  const v = gradeEvacuation({ headClear: true, feetInWater: false, standingOnSolid: true, movedBlocks: 9.6, attempt: 1 });
  assert.equal(v.escaped, true);
  assert.equal(v.next, 'nothing');
});

test('gradeEvacuation: the soak41 lie — head clear, body still in the lake — is NOT an escape', () => {
  const v = gradeEvacuation({ headClear: true, feetInWater: true, standingOnSolid: false, movedBlocks: 9.6, attempt: 1 });
  assert.equal(v.escaped, false);
  assert.match(v.grade, /one frame of air is not an escape/);
  assert.equal(v.next, 'swim_again');
});

test('gradeEvacuation: a second failed swim escalates to PILLAR, not a third swim', () => {
  const v = gradeEvacuation({ headClear: true, feetInWater: true, standingOnSolid: false, movedBlocks: 2.9, attempt: 2 });
  assert.equal(v.next, 'pillar');
});

test('gradeEvacuation: still submerged twice escalates to DIG UP', () => {
  assert.equal(gradeEvacuation({ headClear: false, feetInWater: true, standingOnSolid: false, movedBlocks: 1.3, attempt: 1 }).next, 'swim_again');
  const v = gradeEvacuation({ headClear: false, feetInWater: true, standingOnSolid: false, movedBlocks: 1.3, attempt: 3 });
  assert.equal(v.next, 'dig_up');
  assert.match(v.grade, /STILL SUBMERGED/);
});

test('gradeEvacuation: air on the face while floating over a void is not solid ground', () => {
  const v = gradeEvacuation({ headClear: true, feetInWater: false, standingOnSolid: false, movedBlocks: 4, attempt: 1 });
  assert.equal(v.escaped, false);
  assert.match(v.grade, /nothing solid underfoot/);
});

test('drowningUrgency: 19/20 air at 0 hp is NOT a drowning emergency (soak41 x16)', () => {
  assert.equal(drowningUrgency({ oxygenUnits: 19, health: 0.166, airFalling: false }), 'none');
  // ...but the same reading while the bar is FALLING still is one
  assert.equal(drowningUrgency({ oxygenUnits: 19, health: 0.166, airFalling: true }), 'evacuate');
  // and no trend information keeps the old paranoid behaviour
  assert.equal(drowningUrgency({ oxygenUnits: 19, health: 0.166 }), 'evacuate');
});

test('drowningUrgency: air really gone is an emergency whatever the trend says', () => {
  assert.equal(drowningUrgency({ oxygenUnits: 3, health: 20, airFalling: false }), 'evacuate');
  assert.equal(drowningUrgency({ oxygenUnits: 10, health: 20, airFalling: false }), 'none');
  assert.equal(drowningUrgency({ oxygenUnits: 7, health: 20, airFalling: true }), 'surface');
});

test('pillarBlock: cheapest first, and structure catches an unlisted variant', () => {
  assert.equal(pillarBlock({ diamond_sword: 1, dirt: 3, stone: 64 }), 'dirt');
  assert.equal(pillarBlock({ cherry_planks: 2 }), 'cherry_planks');
  assert.equal(pillarBlock({ bread: 2, string: 4 }), undefined); // the no-op path: nothing to stand on
});

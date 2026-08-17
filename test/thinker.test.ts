// 💭 The thinker's focus choice — pure, so it is tested without a world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFocus, IDLE_FOCI, SURVIVAL_OVERRIDE } from '../src/thinker.js';

// ── the focus a starving bot gets (live soak 2026-08-17) ─────────────────
test('pickFocus: hurt with an empty bag overrides the rotation', () => {
  // The live case: 3.5 HP, food 5, no meals — it chose a torch patrol lane and
  // told itself dawn would heal it.
  const f = pickFocus(1, { health: 3.5, food: 5, foodPortions: 0 });
  assert.equal(f, SURVIVAL_OVERRIDE);
  assert.match(f, /health only regenerates at food >= 18/);
  assert.match(f, /Do NOT idle waiting for a player/);
});

test('pickFocus: starving overrides even at full health', () => {
  assert.equal(pickFocus(2, { health: 20, food: 0, foodPortions: 0 }), SURVIVAL_OVERRIDE);
});

test('pickFocus: food in the bag is not a crisis — auto_eat handles it', () => {
  assert.notEqual(pickFocus(1, { health: 3.5, food: 5, foodPortions: 2 }), SURVIVAL_OVERRIDE);
});

test('pickFocus: hurt but fed, or missing numbers, keeps the rotation', () => {
  assert.notEqual(pickFocus(1, { health: 14, food: 19, foodPortions: 0 }), SURVIVAL_OVERRIDE);
  assert.notEqual(pickFocus(1, {}), SURVIVAL_OVERRIDE, 'unknown vitals must not hijack the cycle');
  assert.equal(pickFocus(3), IDLE_FOCI[3], 'no vitals at all: pure rotation, unchanged');
});

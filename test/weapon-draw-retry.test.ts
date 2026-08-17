import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawPlan, handsSummary, handTheft } from '../src/tools/helpers.js';

/**
 * ISSUE #50 — a REFUSED weapon draw was never retried. /tmp/mc-soak30.log, on
 * code that already narrated the failure honestly (#49):
 *
 *   swung 1x at the phantom 2.5m away with stick (NOT a weapon — 1 damage, same
 *   as a bare fist) (the wooden_sword draw was REFUSED — the hand still holds
 *   stick and the wooden_sword is still in the bag)
 *
 * and its twin, `the hand could not be emptied — it still holds spruce_planks`.
 * 7 of 65 swings landed with junk. The body SAW the wrong hand and swung anyway,
 * because the draw was one window click fired before the burst.
 *
 * These tests pin the plan, not the prose: which MECHANISM the next attempt uses.
 */

const bag = (...pairs: [string, number][]) => pairs.map(([name, slot]) => ({ name, slot }));

test('#50 a weapon on the hotbar is drawn by SWITCHING SLOTS — a click the server cannot silently drop', () => {
  // 36-44 is the hotbar; a HeldItemChange needs no container window.
  const step = drawPlan({ held: 'dirt', want: 'wooden_sword', items: bag(['dirt', 36], ['wooden_sword', 39]) });
  assert.deepEqual(step, { kind: 'quickbar', slot: 3, item: 'wooden_sword' });
});

test('#50 a refused draw is RE-PLANNED, not remembered as done: the hand still disagrees, so there is still a step', () => {
  // Second call after a refusal: the bag and hand are unchanged, so the plan
  // must again say "draw the sword" — this is what makes the retry possible.
  const state = { held: 'stick', want: 'wooden_sword', items: bag(['stick', 36], ['wooden_sword', 20]) };
  assert.deepEqual(drawPlan(state), { kind: 'window', item: 'wooden_sword' });
  assert.deepEqual(drawPlan(state), { kind: 'window', item: 'wooden_sword' });
});

test('#50 the draw stops the moment the hand AGREES — a drawn weapon is never re-clicked', () => {
  assert.deepEqual(
    drawPlan({ held: 'iron_sword', want: 'iron_sword', items: bag(['iron_sword', 36]) }),
    { kind: 'none' },
  );
});

test('#50 retry exhausted with no weapon: a FIST beats junk, and an empty hotbar slot is a fist', () => {
  // want=undefined means nothing in the bag beats a fist. The old code asked the
  // server to unequip and believed the answer; an empty slot needs no answer.
  const step = drawPlan({ held: 'spruce_planks', want: undefined, items: bag(['spruce_planks', 36], ['dirt', 37]) });
  assert.deepEqual(step, { kind: 'quickbar', slot: 2 });
});

test('#50 unequip is the LAST resort — only when all nine hotbar slots are full', () => {
  const full = bag(...Array.from({ length: 9 }, (_, i) => ['dirt', 36 + i] as [string, number]));
  assert.deepEqual(
    drawPlan({ held: 'dirt', want: undefined, items: full }),
    { kind: 'unequip', item: 'dirt' },
  );
});

test('#50 junk is decided by SCORE, not by a block list: a real weapon in hand is left alone', () => {
  // A trident scores above a fist, so even with want=undefined (it IS the best,
  // hence already drawn) nothing is disturbed.
  assert.deepEqual(drawPlan({ held: 'trident', want: undefined, items: bag(['trident', 36]) }), { kind: 'none' });
  // phantom_membrane / rotten_flesh are not blocks and not on any list — they
  // score exactly a fist, so they must still be dropped.
  assert.deepEqual(
    drawPlan({ held: 'phantom_membrane', want: undefined, items: bag(['phantom_membrane', 36]) }),
    { kind: 'quickbar', slot: 1 },
  );
});

test('#50 an empty hand with nothing to draw is already correct', () => {
  assert.deepEqual(drawPlan({ held: undefined, want: undefined, items: [] }), { kind: 'none' });
});

test('#50 a weapon that left the bag mid-burst still plans a window click, and the caller reports the miss', () => {
  // The bag no longer holds the sword (dropped on death); the plan says window,
  // and fightBurst's own lookup then names it: "left the bag before it could be
  // drawn" — an honest failure instead of a silent one.
  assert.deepEqual(
    drawPlan({ held: 'dirt', want: 'wooden_sword', items: bag(['dirt', 36]) }),
    { kind: 'window', item: 'wooden_sword' },
  );
});

/**
 * #50, second half — soak31 (the first live run of the retry) showed the fix
 * WORKING and the sentence still wrong:
 *
 *   swung 2x at the phantom 1.9-2.7m away with cobblestone (the wooden_sword draw
 *   was REFUSED …) (draw attempted 2x: held slot 1 selected for the wooden_sword…)
 *
 * The hotbar switch had landed — `heldItem` is a getter over the selected slot,
 * so it cannot silently fail — and the MINING rail then selected cobblestone
 * again after the swings. The refusal sentence blamed the server for this
 * process's own doing, and the mind acted on that.
 */
test('#50 the swings are described by the hand at EACH swing, not by the hand at the end', () => {
  assert.equal(handsSummary(['wooden_sword', 'wooden_sword']), 'wooden_sword x2');
  assert.equal(handsSummary([undefined]), 'fists');
  const mixed = handsSummary(['iron_sword', 'cobblestone']);
  assert.match(mixed, /iron_sword x1/);
  assert.match(mixed, /cobblestone \(NOT a weapon/, 'junk swings are still named as junk');
  assert.equal(handsSummary([]), '', 'no swings, nothing to describe');
});

test('#50 a hand STOLEN back after the swings is not a refused draw', () => {
  // Drawn, swung with, then another rail selected cobblestone.
  const theft = handTheft(['wooden_sword', 'wooden_sword'], 'wooden_sword', 'cobblestone');
  assert.match(theft, /WAS drawn and then taken back out of the hand by another rail/);
  assert.match(theft, /it holds cobblestone now/);
});

test('#50 a draw that never landed is NOT reported as a theft — that is the refusal case', () => {
  assert.equal(handTheft(['cobblestone', 'cobblestone'], 'wooden_sword', 'cobblestone'), '');
});

test('#50 a weapon still in hand at the end is silence, not a theft', () => {
  assert.equal(handTheft(['iron_sword'], 'iron_sword', 'iron_sword'), '');
  assert.equal(handTheft([], 'iron_sword', 'iron_sword'), '');
});

test('#50 re-taking a stolen hand is free: the plan says draw again every time the hand disagrees', () => {
  // The budget (cfg.combat.drawAttempts) exists for a world that REFUSES; a hand
  // taken back by our own walk rail must be re-taken on every swing, or three
  // scaffolding placements would spend the whole budget and the rest of the burst
  // would go out with cobblestone — which is exactly what soak31 showed.
  const state = { held: 'cobblestone', want: 'wooden_sword', items: bag(['cobblestone', 36], ['wooden_sword', 37]) };
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(drawPlan(state), { kind: 'quickbar', slot: 1, item: 'wooden_sword' });
  }
});

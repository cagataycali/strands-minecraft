/**
 * Issue #48 on the reflex rail: a resolved bot.equip() is not a drawn weapon.
 *
 * soak26 (post-21bab3d) fought four bursts `with dirt (NOT a weapon — 1 damage,
 * same as a bare fist)` while carrying a stone_sword, and never once said the
 * draw had been refused. The narration read the hand back and was true; what was
 * missing is that a BETTER hand had been asked for and the server said no.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawVerdict } from '../src/tools/helpers.js';

const holding = (name?: string) => ({ heldItem: name ? { name } : null });

test('a refused draw is named, with where the weapon still is', () => {
  assert.match(
    drawVerdict(holding('dirt'), 'stone_sword'),
    /stone_sword draw was REFUSED — the hand still holds dirt and the stone_sword is still in the bag/,
  );
});

test('a draw that landed says nothing at all', () => {
  assert.equal(drawVerdict(holding('stone_sword'), 'stone_sword'), '', 'silence is the happy path');
  assert.equal(drawVerdict(holding(), undefined), '', 'an empty hand was the intent when nothing beats a fist');
});

test('an empty-the-hand that failed is also a refusal, not a choice', () => {
  assert.match(drawVerdict(holding('dirt'), undefined), /could not be emptied — it still holds dirt/);
  assert.equal(drawVerdict(holding('wooden_sword'), undefined), '',
    'a real weapon in the hand is never "should have been emptied"');
});

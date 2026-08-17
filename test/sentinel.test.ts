/**
 * Sentinel pure-logic tests — the parts that must be right or the senses
 * either spam the model (debounce/band bugs) or go silent (re-arm bugs).
 * No server needed: BandTracker, Debouncer, tool/sound classifiers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BandTracker, BreakAggregator, breakNote, Debouncer, bandFor, isBreakableTool, normalizeSound, trustedPlayers, isTrustedName, DrowningGate, type BreakEpisode } from '../src/sentinel.js';

test('bandFor picks the innermost band', () => {
  assert.equal(bandFor(3.2), 4);
  assert.equal(bandFor(4), 4);
  assert.equal(bandFor(4.1), 8);
  assert.equal(bandFor(8.1), 16);
  assert.equal(bandFor(16), 16);
  assert.equal(bandFor(16.1), null);
  assert.equal(bandFor(999), null);
});

test('BandTracker announces each band once while a threat closes in', () => {
  const t = new BandTracker([4, 8, 16]);
  // Closing in always passes the rate limit — escalation cannot be throttled.
  assert.equal(t.update(1, 15)?.band, 16); // entered outer band
  assert.equal(t.update(1, 14), null); // still 16-band — no repeat
  assert.equal(t.update(1, 7.5)?.band, 8); // crossed inward
  assert.equal(t.update(1, 7.9), null);
  const melee = t.update(1, 3);
  assert.equal(melee?.band, 4);
  assert.equal(melee?.dist, 3, 'the TRUE distance rides along, not just the band (issue #31)');
  assert.equal(melee?.direction, 'in');
  assert.equal(t.update(1, 3.5), null);
});

test('BandTracker skips bands on a fast approach (announces the innermost reached)', () => {
  const t = new BandTracker([4, 8, 16]);
  assert.equal(t.update(2, 3)?.band, 4); // spawned right on top of us — one announcement, the urgent one
  assert.equal(t.update(2, 3), null);
});

test('BandTracker re-arms a band after the threat retreats past it', () => {
  const t = new BandTracker([4, 8, 16]);
  assert.equal(t.update(3, 7, 0)?.band, 8);
  // Retreating out of the 8 band is silent unless it was a MELEE problem.
  assert.equal(t.update(3, 12, 1_000), null);
  // …and the second approach is news again, once the per-entity floor has passed.
  assert.equal(t.update(3, 7, 2_000), null, 'not one second later — that is the storm');
  assert.equal(t.update(3, 7, 5_000)?.band, 8);
});

test('BandTracker re-arms when the threat leaves range — after the grace, not instantly', () => {
  // This test used to assert the bug: an immediate re-arm meant a mob crossing
  // the outer band on our own walking jitter was brand-new every time, and the
  // soak logged the same motionless enderman twice (see band-tracker.test.ts).
  const t = new BandTracker([4, 8, 16], 15_000);
  assert.equal(t.update(4, 5, 0)?.band, 8);
  assert.equal(t.update(4, 30, 1_000), null); // out of range — provisionally
  assert.equal(t.update(4, 15, 2_000), null, 'straight back: not news');
  assert.equal(t.update(4, 30, 3_000), null);
  assert.equal(t.update(4, 15, 40_000)?.band, 16, 'gone long enough — the return IS news');
});

test('BandTracker oscillation at a boundary is ONE note, not one per crossing', () => {
  const t = new BandTracker([4, 8, 16]);
  assert.equal(t.update(5, 8.0, 0)?.band, 8);
  // Hovering across the 8-block line used to re-announce on every re-entry.
  // A phantom circles by design, so the soak logged 'closed to 8' three times in
  // five seconds while it flew AWAY (issue #31). A band now only widens once the
  // mob is genuinely clear of it — 8.1 is not clear of 8.
  assert.equal(t.update(5, 8.1, 1_000), null);
  assert.equal(t.update(5, 7.9, 2_000), null, 'still the same approach');
  assert.equal(t.update(5, 8.1, 3_000), null);
  // Genuinely out (past the margin) and back in later: news again.
  assert.equal(t.update(5, 11, 4_000), null, 'leaving the 8 band is not melee news');
  assert.equal(t.update(5, 7.5, 8_000)?.band, 8, 'a real second approach');
});

test('BandTracker: a mob leaving MELEE range is news — disengagement is a decision too', () => {
  const t = new BandTracker([4, 8, 16]);
  assert.equal(t.update(11, 2.5, 0)?.band, 4);
  const out = t.update(11, 6, 4_000);
  assert.equal(out?.direction, 'out', 'it stopped being a melee problem');
  assert.equal(out?.band, 8);
  assert.equal(out?.dist, 6, 'and the real distance says how far');
  // But only once, and only from melee: further retreat is silent.
  assert.equal(t.update(11, 12, 8_000), null);
});

test('BandTracker: the per-entity floor throttles chatter but never escalation', () => {
  const t = new BandTracker([4, 8, 16], 15_000, 3_000);
  assert.equal(t.update(12, 15, 0)?.band, 16);
  // Closing in 200ms later: a mob reaching melee cannot be rate-limited.
  assert.equal(t.update(12, 3.4, 200)?.band, 4, 'escalation is exempt from the floor');
  const back = t.update(12, 7, 400);
  assert.equal(back, null, 'a same-second bounce out of melee is throttled');
  assert.equal(t.update(12, 3.4, 600), null, 're-entering the band it never left');
});

test('BandTracker.phrase says the band as a band and the distance as a distance', () => {
  // The two soak lines that disagreed in the SAME millisecond: 'closed to 4
  // blocks' (the band) and 'is 1.2 blocks away' (the truth).
  assert.equal(
    BandTracker.phrase('phantom', { band: 4, dist: 1.234, direction: 'in' }),
    'phantom inside 4 blocks — 1.2 away');
  assert.equal(
    BandTracker.phrase('phantom', { band: 8, dist: 8.62, direction: 'out', prevBand: 4 }),
    'phantom pulled back to 8 blocks — 8.6 away',
    'and it never says "closed to" while the mob retreats');
});

test('BandTracker sweep forgets despawned entities — once absence is established', () => {
  const t = new BandTracker([4, 8, 16], 15_000);
  assert.equal(t.update(6, 5, 0)?.band, 8);
  t.sweep(new Set([99]), 1_000); // 6 missing from this poll's list
  assert.equal(t.update(6, 5, 2_000), null, 'one missed poll is not a despawn');
  t.sweep(new Set([99]), 3_000);
  t.sweep(new Set([99]), 30_000); // still gone 27s later
  assert.equal(t.update(6, 5, 31_000)?.band, 8, 'a real respawn is a fresh threat');
});

test('Debouncer passes once per window per key', () => {
  const d = new Debouncer(30_000);
  const t0 = 1_000_000;
  assert.equal(d.hit('chest:1,2,3', t0), true);
  assert.equal(d.hit('chest:1,2,3', t0 + 1_000), false);
  assert.equal(d.hit('chest:9,9,9', t0 + 1_000), true); // different key unaffected
  assert.equal(d.hit('chest:1,2,3', t0 + 30_000), true); // window elapsed
});

test('isBreakableTool knows tools from blocks and food', () => {
  for (const yes of ['iron_pickaxe', 'stone_axe', 'diamond_sword', 'wooden_shovel', 'netherite_hoe', 'shears', 'fishing_rod', 'bow', 'shield', 'elytra']) {
    assert.equal(isBreakableTool(yes), true, yes);
  }
  for (const no of ['cobblestone', 'bread', 'torch', 'oak_log', 'arrow', 'stick']) {
    assert.equal(isBreakableTool(no), false, no);
  }
});

test('normalizeSound strips the minecraft: namespace', () => {
  assert.equal(normalizeSound('minecraft:entity.creeper.primed'), 'entity.creeper.primed');
  assert.equal(normalizeSound('entity.creeper.primed'), 'entity.creeper.primed');
});

// ---------------------------------------------------------------------------
// base security: one note per digger per base, and the owner is not a griefer
// (issue #9 — 14 of 15 briefings were Cagatay mining his own tunnel)
// ---------------------------------------------------------------------------

test('trustedPlayers parses the allowlist case-insensitively and tolerates junk', () => {
  const t = trustedPlayers(' CagatayCali , Friend2,, ');
  assert.ok(t.has('cagataycali'));
  assert.ok(t.has('friend2'));
  assert.equal(t.size, 2);
  assert.equal(trustedPlayers(undefined).size, 0);
  assert.equal(trustedPlayers('').size, 0);
});

test('BreakAggregator: 20 blocks at 20 positions in 30s produce ONE note, with a count', () => {
  // The exact live shape: a tunnel is a NEW position every block, which is why
  // the old `break:${position}` debounce suppressed nothing.
  let now = 1_000_000;
  const notes: BreakEpisode[] = [];
  const agg = new BreakAggregator((_k, e) => notes.push(e), 4_000, 90_000, () => now);
  for (let i = 0; i < 20; i++) {
    agg.hit('Griefer\u0000birch_camp', i % 2 ? 'dirt' : 'stone', { x: -44 - i, y: 59, z: 73 });
    now += 1_500; // 30s of steady mining
  }
  // the settle timer is real time, not the injected clock — flush it by hand
  // the way the timer would, then assert one aggregated note
  assert.equal(notes.length, 0, 'nothing fires before the settle');
  (agg as unknown as { flush: (k: string) => void }).flush('Griefer\u0000birch_camp');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].count, 20);
  assert.deepEqual(notes[0].kinds.sort(), ['dirt', 'stone']);
  assert.deepEqual(notes[0].at, { x: -63, y: 59, z: 73 }, 'the note points at the LATEST block');
  assert.equal(notes[0].escalated, false);
  agg.stop();
});

test('BreakAggregator: a spree that outlives the quiet window earns ONE escalation', () => {
  let now = 0;
  const notes: BreakEpisode[] = [];
  const agg = new BreakAggregator((_k, e) => notes.push(e), 4_000, 90_000, () => now);
  const key = 'Griefer\u0000iron_mine';
  agg.hit(key, 'stone', { x: 0, y: 60, z: 0 });
  (agg as unknown as { flush: (k: string) => void }).flush(key); // first note
  assert.equal(notes.length, 1);

  // inside the window: counted, silent
  for (let i = 0; i < 10; i++) { now += 5_000; agg.hit(key, 'stone', { x: i, y: 60, z: 0 }); }
  assert.equal(notes.length, 1, 'no second note inside the quiet window');

  // past the window: exactly one escalation, carrying the blocks since the note
  now += 45_000;
  agg.hit(key, 'deepslate', { x: 11, y: 60, z: 0 });
  assert.equal(notes.length, 2);
  assert.equal(notes[1].escalated, true);
  assert.equal(notes[1].count, 11);
  // and it quiets down again
  now += 1_000;
  agg.hit(key, 'stone', { x: 12, y: 60, z: 0 });
  assert.equal(notes.length, 2);
  agg.stop();
});

test('BreakAggregator: different diggers and different bases are separate episodes', () => {
  let now = 0;
  const keys: string[] = [];
  const agg = new BreakAggregator((k) => keys.push(k), 4_000, 90_000, () => now);
  const flush = (k: string) => (agg as unknown as { flush: (k: string) => void }).flush(k);
  agg.hit('A\u0000camp', 'dirt', { x: 0, y: 0, z: 0 });
  agg.hit('B\u0000camp', 'dirt', { x: 1, y: 0, z: 0 });
  agg.hit('A\u0000mine', 'dirt', { x: 2, y: 0, z: 0 });
  ['A\u0000camp', 'B\u0000camp', 'A\u0000mine'].forEach(flush);
  assert.deepEqual(keys, ['A\u0000camp', 'B\u0000camp', 'A\u0000mine']);
  agg.stop();
});

test('BreakAggregator: sweep forgets idle episodes but keeps live ones', () => {
  let now = 0;
  const agg = new BreakAggregator(() => {}, 4_000, 90_000, () => now);
  agg.hit('A\u0000camp', 'dirt', { x: 0, y: 0, z: 0 });
  (agg as unknown as { flush: (k: string) => void }).flush('A\u0000camp');
  const size = () => (agg as unknown as { episodes: Map<string, unknown> }).episodes.size;
  assert.equal(size(), 1);
  now += 100_000;
  agg.sweep(300_000);
  assert.equal(size(), 1, 'still recent enough to remember');
  now += 400_000;
  agg.sweep(300_000);
  assert.equal(size(), 0);
  agg.stop();
});

test('breakNote: counts blocks, names kinds, and escalation sounds different', () => {
  const first = breakNote('Griefer', 'birch_camp', {
    count: 7, kinds: ['stone', 'dirt'], at: { x: -44, y: 59, z: 73 }, escalated: false, ageMs: 4_000,
  });
  assert.match(first, /Griefer is BREAKING stone\/dirt near your waypoint 'birch_camp'/);
  assert.match(first, /7 blocks so far, latest at \(-44, 59, 73\)/);
  assert.ok(!/1 blocks/.test(breakNote('G', 'b', { count: 1, kinds: [], at: { x: 0, y: 0, z: 0 }, escalated: false, ageMs: 1 })), 'singular block');

  const again = breakNote('Griefer', 'birch_camp', {
    count: 12, kinds: ['deepslate'], at: { x: -60, y: 40, z: 70 }, escalated: true, ageMs: 95_000,
  });
  assert.match(again, /STILL digging/);
  assert.match(again, /12 blocks more \(deepslate\)/);
  assert.match(again, /95s into it/);
});

// ── own workers are not intruders (live soak 2026-08-17: 'Digger') ───────────
test('isTrustedName: a hired worker digging is fleet business, not a break-in', () => {
  const env = trustedPlayers('CagatayCali');
  assert.equal(isTrustedName('Digger', env, ['Digger']), true, "the bot's own hire");
  assert.equal(isTrustedName('digger', env, ['Digger']), true, 'case-insensitive both ways');
  assert.equal(isTrustedName('CagatayCali', env, []), true, 'env list still works alone');
});

test('isTrustedName: a stranger with a worker-ish name is still a stranger', () => {
  const env = trustedPlayers('');
  assert.equal(isTrustedName('Griefer', env, ['Digger', 'Chopper']), false);
  assert.equal(isTrustedName(undefined, env, ['Digger']), false, 'unnamed events never trusted');
});

test('isTrustedName: trust follows the CURRENT roster — a dismissed worker loses it', () => {
  const env = trustedPlayers('');
  const roster: string[] = ['Digger'];
  assert.equal(isTrustedName('Digger', env, roster), true);
  roster.length = 0; // dismissed / finished
  assert.equal(isTrustedName('Digger', env, roster), false, 'evaluated per event, not per session');
});

test('trusted breaks are quiet but not invisible: one line per (digger, base) per window', () => {
  // blockBreakProgressObserved fires per dig STAGE, so the live soak logged
  // '(trusted) Digger2 broke sand near loot_chest' six times for ONE block.
  const d = new Debouncer(30_000);
  const key = (who: string, base: string) => `trustbreak:${who.toLowerCase()}:${base}`;
  assert.equal(d.hit(key('Digger2', 'loot_chest')), true, 'first stage speaks');
  for (let i = 0; i < 5; i++)
    assert.equal(d.hit(key('Digger2', 'loot_chest')), false, 'the other stages do not');
  assert.equal(d.hit(key('Digger2', 'spawn_base')), true, 'a different base is different news');
  assert.equal(d.hit(key('Chopper', 'loot_chest')), true, 'a different worker too');
});

// ── the air gauge lies on land (live soak 2026-08-17, 255 false alarms) ────
test('DrowningGate: dry land at 0/-1/undefined air says nothing', () => {
  const g = new DrowningGate();
  for (const raw of [0, -1, undefined, 0, -20, 3]) {
    assert.equal(g.check(raw, false), null);
  }
});

test('DrowningGate: one submersion escalates exactly once', () => {
  const g = new DrowningGate();
  assert.equal(g.check(20, true), null); // full lungs, no news
  assert.equal(g.check(7, true), null); // above the threshold
  assert.equal(g.check(5, true), 5); // the one escalation
  assert.equal(g.check(4, true), null); // still under — not news again
  assert.equal(g.check(0, true), null);
  assert.equal(g.check(-1, true), null); // drowning damage, same submersion
});

test('DrowningGate: surfacing re-arms, and only surfacing does', () => {
  const g = new DrowningGate();
  assert.equal(g.check(2, true), 2);
  assert.equal(g.check(18, true), null); // gauge climbing while still under = not a re-arm
  assert.equal(g.check(1, true), null);
  assert.equal(g.check(19, false), null); // out of the water
  assert.equal(g.check(1, true), 1); // a second real dunk is news
});

test('DrowningGate: the 300-tick scale is normalized before comparing', () => {
  const g = new DrowningGate();
  assert.equal(g.check(300, true), null); // full air on the tick scale is not 300 < 6
  assert.equal(g.check(60, true), 4); // 60 ticks = 4 bubbles, escalated in bubbles not ticks
});

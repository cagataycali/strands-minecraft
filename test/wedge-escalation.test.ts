/**
 * A wedge must survive a twitch.
 *
 * /tmp/mc-soak36.log: 13 `[unstuck]` lines, ELEVEN of them verbatim "warning 1
 * of this wedge, legs untouched" — one at "stationary 184s" on a bot at 9/20 HP.
 * The frozen durations went 66s → 46s → 47s → 184s → 57s → 134s → 49s → 65s:
 * a monotonic clock cannot go backwards, so the episode (and its warning count)
 * was being RESTARTED between notes. The 2-block anchor circle was the wedge's
 * whole identity, so a mob shove or a re-issued walk that moved 3 blocks and
 * re-jammed opened a brand-new "first warning" forever, escalation was dead
 * code, and the legs were never freed.
 *
 * These tests replay that shape against the site-scoped memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wedgeSiteKey, wedgeSee, wedgeEscalation, wedgeAge, wedgeSiteFact, stuckNoteDue, stuckAdvice,
  type WedgeMemory,
} from '../src/tools/helpers.js';

const ESC = { actAfterWarnings: 3, actAfterMs: 120_000, actGapMs: 60_000 };

test('a coarse cell is the wedge identity: a 3-block twitch stays the same wedge', () => {
  const a = wedgeSiteKey({ x: 1.4, y: 67, z: 30.2 });
  assert.equal(wedgeSiteKey({ x: 3.1, y: 67, z: 31.9 }), a, 'a shove inside the cell is the same place');
  assert.notEqual(wedgeSiteKey({ x: 14, y: 67, z: 30 }), a, 'a real route change is a different place');
  assert.equal(wedgeSiteKey({ x: -2.5, y: -1, z: -0.5 }), '-1,-1,-1', 'negative coordinates floor, they do not truncate toward zero');
});

test('soak36 replayed: a 3-minute wedge that twitches reaches warning 2, 3 and then ACTS', () => {
  // Ticks are (frozenMs, twitched?) exactly in the shape of the live log: the
  // freeze clock keeps restarting, the place never changes.
  const t0 = 1_000_000;
  let w: WedgeMemory | undefined;
  const key = wedgeSiteKey({ x: 1, y: 67, z: 30 });
  let lastNotedAt = 0;
  let lastNotedFrozenMs = 0;
  const warnings: string[] = [];
  let acts = 0;

  for (let i = 0; i <= 18; i += 1) {
    const now = t0 + i * 10_000;            // a tick every 10s for 3 minutes
    const twitched = i === 7 || i === 13;    // moved >2 blocks, still in the cell
    const frozenMs = twitched ? 0 : (i - (i > 13 ? 13 : i > 7 ? 7 : 0)) * 10_000;
    if (twitched) { lastNotedFrozenMs = 0; continue; } // caller resets the episode clock
    if (frozenMs < 20_000) continue;         // UNSTUCK_AFTER_MS
    w = wedgeSee(w, { now, key, frozenMs, newEpisode: lastNotedFrozenMs === 0 && frozenMs === 20_000 });
    if (wedgeEscalation(w, { now, frozenMs }, ESC) === 'act') {
      acts += 1;
      w.acts += 1;
      w.lastActAt = now;
      continue;
    }
    if (!stuckNoteDue({ now, lastNotedAt, notesInEpisode: w.warnings, frozenMs, lastNotedFrozenMs }, 20_000, 600_000, 20_000)) continue;
    w.warnings += 1;
    lastNotedAt = now;
    lastNotedFrozenMs = frozenMs;
    warnings.push(`warning ${w.warnings} of this wedge at ${wedgeAge(w, now)}`);
  }

  assert.ok(w, 'the wedge exists');
  assert.ok(warnings.length >= 2, `escalation must be reachable, got ${JSON.stringify(warnings)}`);
  assert.ok(/warning 2/.test(warnings.join(' ')), `the count must climb, got ${JSON.stringify(warnings)}`);
  assert.ok(acts >= 1, 'a 3-minute wedge must eventually earn the legs');
  assert.ok(w!.episodes >= 1 && w!.warnings >= 2, 'warnings survive the twitches that ended the episodes');
});

test('leaving the cell forgets the wedge; coming back inside the window does not', () => {
  const t = 5_000_000;
  let w = wedgeSee(undefined, { now: t, key: 'a', frozenMs: 30_000 });
  w.warnings = 2;
  const same = wedgeSee(w, { now: t + 60_000, key: 'a', frozenMs: 25_000, newEpisode: true });
  assert.equal(same.warnings, 2, 'same place, warnings intact');
  assert.equal(same.episodes, 2, 'a new freeze is a new attempt to leave');
  const elsewhere = wedgeSee(w, { now: t + 60_000, key: 'b', frozenMs: 25_000 });
  assert.equal(elsewhere.warnings, 0, 'a different place is a different wedge');
  const stale = wedgeSee(w, { now: t + 400_000, key: 'a', frozenMs: 25_000 }, 300_000);
  assert.equal(stale.warnings, 0, 'past the rejoin window the place is news again');
});

test('escalation needs either the warnings or the time — and never twice in a row', () => {
  const t = 9_000_000;
  const fresh = wedgeSee(undefined, { now: t, key: 'a', frozenMs: 25_000 });
  assert.equal(wedgeEscalation(fresh, { now: t, frozenMs: 25_000 }, ESC), 'note', 'a young wedge is only news, not a takeover');
  const twice = { ...fresh, warnings: 2 };
  assert.equal(wedgeEscalation(twice, { now: t, frozenMs: 25_000 }, ESC), 'act', 'the third telling is an action');
  const old = wedgeSee(undefined, { now: t, key: 'a', frozenMs: 150_000 });
  assert.equal(wedgeEscalation(old, { now: t, frozenMs: 150_000 }, ESC), 'act', '150s frozen acts without waiting for a 3rd warning');
  const justActed = { ...old, acts: 1, lastActAt: t - 10_000 };
  assert.equal(wedgeEscalation(justActed, { now: t, frozenMs: 150_000 }, ESC), 'note', 'a takeover has a gap: the body is not a pinball');
  assert.equal(
    wedgeEscalation({ ...old, acts: 1, lastActAt: t - 70_000 }, { now: t, frozenMs: 150_000 }, ESC), 'act',
    'past the gap a still-wedged body may act again',
  );
});

test('the sentence carries a consequence and never repeats identically', () => {
  const t = 11_000_000;
  const w: WedgeMemory = {
    key: 'a', firstAt: t - 252_000, lastAt: t, warnings: 2, episodes: 3, acts: 1, lastActAt: t - 90_000,
    worstFrozenMs: 184_000,
  };
  assert.equal(wedgeAge(w, t), '4m12s');
  const fact = wedgeSiteFact(w, t, '(1, 67, 30)');
  assert.match(fact, /same wedge/);
  assert.match(fact, /4m12s/);
  assert.match(fact, /3 attempts/);
  assert.match(fact, /1x/, 'a takeover that already happened is part of the news');
  assert.match(fact, /route, not the effort/, 'a fact must name the consequence, not just the count');
  // First telling of a brand-new wedge adds no site history — nothing to repeat.
  assert.equal(wedgeSiteFact({ ...w, warnings: 0, acts: 0 }, t, '(1, 67, 30)'), '');
  // Each telling differs: the advice escalates AND the site line grows.
  const lines = new Set([
    `${stuckAdvice(0, 30)} ${wedgeSiteFact({ ...w, warnings: 0, acts: 0, episodes: 1 }, t, 'x')}`.trim(),
    `${stuckAdvice(1, 90)} ${wedgeSiteFact({ ...w, warnings: 1, acts: 0, episodes: 2 }, t, 'x')}`.trim(),
    `${stuckAdvice(2, 184)} ${wedgeSiteFact(w, t, 'x')}`.trim(),
  ]);
  assert.equal(lines.size, 3, 'three tellings, three different sentences');
});

/**
 * 💀 Death-site memory (#35).
 *
 * soak36's four deaths: (1,67,30), (1,67,30), (1,67,30), (-2,66,30) — one room,
 * four identical notes, no count anywhere. These tests model that exact session
 * and assert the mind is told the NUMBER, the interval, and the consequence.
 *
 * MEMORY_DIR is redirected before importing memory.js so the store under test is
 * a temp file, never the live bot's ~/.strands-minecraft/memory.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deathSiteRepeat,
  deathSiteFact,
  spanWords,
  DROP_DESPAWN_MS,
  type DeathRecord,
} from '../src/tools/helpers.js';

const DIR = mkdtempSync(join(tmpdir(), 'sm-death-'));
process.env.MEMORY_DIR = DIR;
const { recordDeath, loadDeaths, deathSiteDigest } = await import('../src/tools/memory.js');

const T0 = Date.UTC(2026, 7, 18, 20, 0, 0);
const at = (min: number) => T0 + min * 60_000;

test('a first death at a place says nothing about repeats — silence is the honest report', () => {
  const first: DeathRecord = { x: 1, y: 67, z: 30, at: T0 };
  assert.equal(deathSiteRepeat([], first), undefined);
  assert.equal(deathSiteFact(undefined), '');
});

test('soak36 replayed: the 3rd death at (1,67,30) is announced as the 3rd, with the interval', () => {
  const history: DeathRecord[] = [
    { x: 1, y: 67, z: 30, at: at(0) },
    { x: 1, y: 67, z: 30, at: at(6) },
  ];
  const third: DeathRecord = { x: 1, y: 67, z: 30, at: at(12) };
  const r = deathSiteRepeat(history, third)!;
  assert.equal(r.count, 3);
  assert.equal(r.spanMs, 12 * 60_000);
  assert.deepEqual(r.centre, { x: 1, y: 67, z: 30 });
  const line = deathSiteFact(r);
  assert.match(line, /3rd death within 6 blocks of \(1, 67, 30\) in 12 min/);
  assert.match(line, /~6 min/, 'a life here is worth ~6 minutes — the consequence, not the count');
  assert.match(line, /despawned/, 'the earlier gear is gone; a corpse-run recovers one life at most');
});

test('the 4th death 5 blocks away is the SAME site, not a new one', () => {
  const history: DeathRecord[] = [
    { x: 1, y: 67, z: 30, at: at(0) },
    { x: 1, y: 67, z: 30, at: at(6) },
    { x: 1, y: 67, z: 30, at: at(12) },
  ];
  const r = deathSiteRepeat(history, { x: -2, y: 66, z: 30, at: at(15) })!;
  assert.equal(r.count, 4, 'a 3-block step sideways is the same grave');
  assert.deepEqual(r.centre, { x: 1, y: 67, z: 30 }, 'the centre is the spot that started killing us');
  // …and a genuinely different place is a different place.
  assert.equal(deathSiteRepeat(history, { x: 60, y: 67, z: 30, at: at(16) }), undefined);
});

test('a death older than the window is history, not a pattern', () => {
  const old: DeathRecord[] = [{ x: 1, y: 67, z: 30, at: at(0) }];
  assert.equal(deathSiteRepeat(old, { x: 1, y: 67, z: 30, at: at(200) }, { windowMs: 45 * 60_000 }), undefined);
  assert.ok(deathSiteRepeat(old, { x: 1, y: 67, z: 30, at: at(40) }, { windowMs: 45 * 60_000 }));
});

test('a pile that has NOT despawned yet is reported as still there, separately from the gone ones', () => {
  const justNow = DROP_DESPAWN_MS - 60_000;
  const r = deathSiteRepeat(
    [{ x: 1, y: 67, z: 30, at: T0 }, { x: 1, y: 67, z: 30, at: T0 + justNow }],
    { x: 1, y: 67, z: 30, at: T0 + DROP_DESPAWN_MS + 60_000 },
  )!;
  const line = deathSiteFact(r);
  assert.match(line, /may still be on the ground/);
  assert.match(line, /1 earlier death here has already despawned|the earlier death here has already despawned/);
});

test('a cause is carried only when the server named one — never invented', () => {
  const r = deathSiteRepeat(
    [{ x: 1, y: 67, z: 30, at: at(0), cause: 'StrandsBot was shot by a skeleton' }],
    { x: 1, y: 67, z: 30, at: at(5), cause: 'StrandsBot was shot by a skeleton' },
  )!;
  assert.deepEqual(r.causes, ['StrandsBot was shot by a skeleton']);
  assert.match(deathSiteFact(r), /every one of them: StrandsBot was shot by a skeleton/);
  const quiet = deathSiteRepeat(
    [{ x: 1, y: 67, z: 30, at: at(0) }],
    { x: 1, y: 67, z: 30, at: at(5) },
  )!;
  assert.deepEqual(quiet.causes, []);
  assert.doesNotMatch(deathSiteFact(quiet), /cause/i, 'no cause is no sentence about causes');
});

test('a note never repeats itself: the sentence changes on every death at the site', () => {
  const lines = new Set<string>();
  const history: DeathRecord[] = [];
  for (let i = 0; i < 4; i += 1) {
    const d: DeathRecord = { x: 1, y: 67, z: 30, at: at(i * 6) };
    const r = deathSiteRepeat(history, d);
    lines.add(deathSiteFact(r));
    history.push(d);
  }
  assert.equal(lines.size, 4, `each death says something new, got ${[...lines].length}`);
});

test('the store survives, counts from the FILE, and the digest names the site', () => {
  recordDeath({ x: 1.4, y: 67.9, z: 30.2 }, { at: at(0), dimension: 'overworld' });
  recordDeath({ x: 1.1, y: 67.0, z: 30.7 }, { at: at(6), dimension: 'overworld' });
  const third = recordDeath({ x: 1, y: 67, z: 30 }, { at: at(12), dimension: 'overworld' });
  assert.equal(third.repeat?.count, 3, 'the count is the store’s, not the handler’s');
  assert.match(third.fact, /3rd death within 6 blocks/);
  assert.equal(loadDeaths().length, 3, 'deaths accumulate — unlike the last_death waypoint they replaced');
  assert.equal(third.kept, 3);
  const digest = deathSiteDigest(at(13));
  assert.match(digest, /3 deaths within 6 blocks of \(1, 67, 30\)/);
  assert.match(digest, /1 min ago|60s ago/);
  // A different dimension is a different world: same coords, no repeat claimed.
  const nether = recordDeath({ x: 1, y: 67, z: 30 }, { at: at(14), dimension: 'the_nether' });
  assert.equal(nether.repeat, undefined);
});

test('spanWords keeps a note readable at every scale', () => {
  assert.equal(spanWords(45_000), '45s');
  assert.equal(spanWords(12 * 60_000), '12 min');
  assert.equal(spanWords(2 * 3600_000), '2.0h');
});

test('two deaths with the same coordinate AND the same clock tick still count as two', () => {
  // Caught by replaying the live soak36 log: deaths 2 and 3 both landed at
  // (1,67,30) inside one 30s bucket, and a value-based "which row is mine?"
  // filter deleted the earlier one — so the third death called itself the
  // second. The appended row is identified by POSITION now.
  const t = at(30);
  const a = recordDeath({ x: 9, y: 70, z: 9 }, { at: t });
  const b = recordDeath({ x: 9, y: 70, z: 9 }, { at: t });
  const c = recordDeath({ x: 9, y: 70, z: 9 }, { at: t });
  assert.equal(a.repeat, undefined);
  assert.equal(b.repeat?.count, 2);
  assert.equal(c.repeat?.count, 3, 'an identity another row can satisfy is not an identity');
});

test('soak37 replayed: the waypoint write must not erase the death history', async () => {
  // THE bug that kept #35's rail silent in the world. index.ts's death handler
  // runs recordDeath and then writePlace('last_death') — and writePlace used to
  // rewrite the file as {places}, deleting `deaths` every time. Live proof:
  // soak37 logged 20 deaths in 17 minutes (three at the identical block
  // -12,64,4) and ~/.strands-minecraft/memory.json still had ONE key, `places`.
  const { writePlace, loadPlaces } = await import('../src/tools/memory.js');
  const before = loadDeaths().length;
  const spiral = [
    { x: -10, y: 64, z: 4 }, { x: -12, y: 64, z: 4 }, { x: -12, y: 64, z: 4 },
  ];
  const facts = spiral.map((p, i) => {
    const site = recordDeath(p, { at: at(100 + i * 2) });
    // exactly what the live handler does on the very next line
    writePlace('last_death', p, 'died here (overworld)', 'bot');
    return site.fact;
  });
  assert.equal(facts[0], '', 'first death of the spiral: no repeat to claim');
  assert.match(facts[1], /2nd death within 6 blocks/);
  assert.match(facts[2], /3rd death within 6 blocks of \(-10, 64, 4\)/);
  assert.equal(loadDeaths().length, before + 3, 'the store keeps every death across waypoint writes');
  assert.ok(loadPlaces().some((p) => p.name === 'last_death'), 'and the waypoint still lands');
});

test('the remedy half: a cluster names what its deaths SHARE, not just how many', async () => {
  const { sharedConditions } = await import('../src/tools/helpers.js');
  // soak37's real spiral, with the conditions the live handler now records.
  const spiral: DeathRecord[] = [
    { x: -10, y: 64, z: 4, at: at(200), cause: 'zombie', armour: 0, night: true, doing: 'mine iron at y 60' },
    { x: -12, y: 64, z: 4, at: at(202), cause: 'zombie', armour: 0, night: true, doing: 'mine iron at y 60' },
    { x: -12, y: 64, z: 4, at: at(205), cause: 'zombie', armour: 0, night: true, doing: 'mine iron at y 60' },
  ];
  const shared = sharedConditions(spiral);
  assert.ok(shared.includes('not one armour piece worn'), shared.join(' | '));
  assert.ok(shared.includes('every one after dark'));
  assert.ok(shared.some((s) => /y 64/.test(s)));
  assert.ok(shared.some((s) => /same job: "mine iron at y 60"/.test(s)));
  const fact = deathSiteFact(deathSiteRepeat(spiral.slice(0, 2), spiral[2], {}));
  assert.match(fact, /3rd death within 6 blocks/);
  assert.match(fact, /every one of them: zombie/);
  assert.match(fact, /What every one of these deaths had in common: not one armour piece worn/);
});

test('a condition that only SOME deaths shared is never named as a cause', async () => {
  const { sharedConditions } = await import('../src/tools/helpers.js');
  const mixed: DeathRecord[] = [
    { x: 0, y: 64, z: 0, at: at(300), armour: 0, night: true },
    { x: 1, y: 64, z: 0, at: at(302), armour: 4, night: false },
  ];
  const shared = sharedConditions(mixed);
  assert.ok(!shared.some((s) => /armour piece worn/.test(s)), 'one of them WAS armoured');
  assert.ok(!shared.some((s) => /after dark/.test(s)));
  assert.ok(!shared.some((s) => /daylight/.test(s)));
});

test('a field nobody recorded abstains — it never reads as false', async () => {
  const { sharedConditions } = await import('../src/tools/helpers.js');
  // Rows written before the fields existed: silence about armour, not "0 worn".
  const old: DeathRecord[] = [
    { x: 0, y: 70, z: 0, at: at(400) },
    { x: 2, y: 70, z: 0, at: at(402) },
  ];
  const shared = sharedConditions(old);
  assert.ok(!shared.some((s) => /armour|dark|daylight|job/.test(s)), shared.join(' | '));
  assert.ok(shared.some((s) => /y 70/.test(s)), 'the y-level is in the record itself, so it still counts');
});

test('deathContext reads the body and never invents a killer that went stale', async () => {
  const { deathContext, noteDamageSource } = await import('../src/tools/memory.js');
  const bot = {
    inventory: { slots: [...Array(5).fill(null), { name: 'iron_helmet' }, null, null, { name: 'leather_boots' }] },
    time: { isDay: false },
  };
  const t = at(500);
  noteDamageSource('creeper', t - 2_000);
  const fresh = deathContext(bot, { doing: 'raid the vault', now: t });
  assert.equal(fresh.cause, 'creeper');
  assert.equal(fresh.armour, 2, 'a log in slot 7 is not a helmet — armour is counted by structure');
  assert.equal(fresh.night, true);
  assert.equal(fresh.doing, 'raid the vault');
  // 2 minutes later that zombie is not the killer of this fall into lava.
  noteDamageSource('zombie', t - 120_000);
  assert.equal(deathContext(bot, { now: t }).cause, undefined);
  // A body whose inventory could not be read says nothing about armour.
  assert.equal(deathContext({ time: {} }, { now: t }).armour, undefined);
});

test('silence is not agreement: one named killer among four deaths is not "every one of them"', () => {
  // The exact shape a live probe hit against real soak38 rows: three deaths
  // written before the cause field existed, then one that named a zombie.
  const silent: DeathRecord[] = [
    { x: -10, y: 64, z: 3, at: at(600) },
    { x: -10, y: 64, z: 3, at: at(601) },
    { x: -10, y: 64, z: 3, at: at(602) },
  ];
  const r = deathSiteRepeat(silent, { x: -10, y: 64, z: 4, at: at(603), cause: 'zombie' }, {})!;
  assert.equal(r.count, 4);
  assert.equal(r.attributed, 1);
  const fact = deathSiteFact(r);
  assert.ok(!/every one of them: zombie/.test(fact), fact);
  assert.match(fact, /the one death we identified of them: zombie \(the other 3 named nothing\)/);
  // And when they all named it, the strong sentence is still allowed.
  const all = silent.map((d) => ({ ...d, cause: 'zombie' }));
  const r2 = deathSiteRepeat(all, { x: -10, y: 64, z: 4, at: at(603), cause: 'zombie' }, {})!;
  assert.equal(r2.attributed, 4);
  assert.match(deathSiteFact(r2), /every one of them: zombie/);
  // Mixed causes report their coverage instead of implying full attribution.
  const mixed = deathSiteRepeat(
    [{ x: 0, y: 64, z: 0, at: at(700), cause: 'creeper' }, { x: 0, y: 64, z: 1, at: at(701) }],
    { x: 0, y: 64, z: 2, at: at(702), cause: 'zombie' }, {},
  )!;
  assert.match(deathSiteFact(mixed), /causes named for 2 of 3: zombie; creeper/);
});

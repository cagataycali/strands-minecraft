/**
 * Phase-3 mind tests: the digest the self-prompts trust, the Δ critic that
 * keeps journeys honest, and the goal ledgers that stop the thinker from
 * re-proposing failures. All pure or file-backed — no server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDigest, inventoryHighlights, type DigestSnapshot } from '../src/digest.js';
import type { BodySnapshot } from '../src/journeys.js';

// journeys.ts resolves MEMORY_DIR at module load — point it at a temp dir
// BEFORE the module is imported (same discipline as tools.test.ts). thinker.ts
// now imports journeys.ts too, so it must ALSO be loaded dynamically: a static
// import of thinker.js would pull journeys.js in during hoisting, before this
// env line runs, and the tests would read the LIVE bot's ~/.strands-minecraft.
const DIR = mkdtempSync(join(tmpdir(), 'sm-digest-'));
process.env.MEMORY_DIR = DIR;
const { stepDelta, JourneyRunner, progressVerdict, MAX_CONSECUTIVE_WAITS } = await import('../src/journeys.js');
const { pickFocus, IDLE_FOCI } = await import('../src/thinker.js');

// ---------------------------------------------------------------------------
// inventoryHighlights
// ---------------------------------------------------------------------------

test('inventoryHighlights: counts meals by the eat-picker table, not by vibes', () => {
  const h = inventoryHighlights([
    { name: 'bread', count: 3 },
    { name: 'cooked_beef', count: 2 },
    { name: 'rotten_flesh', count: 10 }, // risky — not a meal
    { name: 'golden_apple', count: 1 }, // precious — not a meal
  ]);
  assert.equal(h.foodPortions, 5);
});

test('inventoryHighlights: tools, weapons, torches, blocks sorted into lanes', () => {
  const h = inventoryHighlights([
    { name: 'iron_pickaxe', count: 1 },
    { name: 'stone_axe', count: 1 },
    { name: 'iron_sword', count: 1 },
    { name: 'bow', count: 1 },
    { name: 'torch', count: 17 },
    { name: 'cobblestone', count: 64 },
    { name: 'oak_planks', count: 32 },
    { name: 'diamond', count: 3 }, // treasure is neither tool nor block
  ]);
  assert.deepEqual(h.tools.sort(), ['iron_pickaxe', 'stone_axe']);
  assert.deepEqual(h.weapons.sort(), ['bow', 'iron_sword']);
  assert.equal(h.torches, 17);
  assert.equal(h.buildingBlocks, 96);
});

// ---------------------------------------------------------------------------
// formatDigest
// ---------------------------------------------------------------------------

const baseSnap: DigestSnapshot = {
  health: 17, food: 12, pos: { x: 12.7, y: 64.2, z: -8.9 }, dimension: 'overworld', gamemode: 'survival',
  night: true, fullMoon: true, raining: false,
  threats: ['zombie 9m (14, 64, -3)', 'skeleton 15m (2, 65, -20)'],
  foodPortions: 5, torches: 12, tools: ['iron_pickaxe'], weapons: ['stone_sword'], buildingBlocks: 96,
  journey: { id: 'j1', goal: 'collect 64 iron', step: 14, last: 'mined 3 iron [Δ +3 raw_iron]' },
  workers: ['Chopper(working #4)'],
  reflexLines: ['[auto_eat] food was 12/20 — ate a bread (now 17/20)'],
};

test('formatDigest: everything present, under budget, floored coordinates', () => {
  const d = formatDigest(baseSnap);
  assert.ok(d.length <= 600, `${d.length} chars`);
  assert.ok(d.split('\n').length <= 8, 'at most 8 lines');
  assert.match(d, /HP 17\/20 food 12\/20/);
  assert.match(d, /\(12, 64, -9\) overworld, survival/);
  assert.match(d, /NIGHT \(full moon\)/);
  assert.match(d, /zombie 9m/);
  assert.match(d, /5 meal\(s\), 12 torch\(es\), 96 building block\(s\)/);
  assert.match(d, /journey: j1 "collect 64 iron" step 14/);
  assert.match(d, /Chopper\(working #4\)/);
  assert.match(d, /body acted on its own: \[auto_eat\]/);
});

test('formatDigest: quiet day is short and says so', () => {
  const d = formatDigest({
    ...baseSnap, night: false, fullMoon: false, threats: [], journey: undefined, workers: [], reflexLines: [],
  });
  assert.match(d, /time: day/);
  assert.match(d, /threats: none in radar range/);
  assert.ok(!d.includes('journey:'));
  assert.ok(!d.includes('workers:'));
  assert.ok(d.split('\n').length <= 4);
});

test('formatDigest: empty bag warns NO tools; oxygen only when diving', () => {
  const d = formatDigest({ ...baseSnap, tools: [], weapons: [], oxygen: 7 });
  assert.match(d, /NO tools/);
  assert.match(d, /O2 7\/20/);
  const dry = formatDigest({ ...baseSnap, oxygen: 20 });
  assert.ok(!dry.includes('O2'));
});

// ---------------------------------------------------------------------------
// stepDelta — the Δ critic
// ---------------------------------------------------------------------------

const body = (over: Partial<BodySnapshot> = {}): BodySnapshot => ({
  pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inv: {}, ...over,
});

test('stepDelta: gains, losses, vitals and movement in one line', () => {
  const d = stepDelta(
    body({ inv: { cobblestone: 5, bread: 3 }, health: 20, food: 18 }),
    body({ inv: { cobblestone: 17, bread: 2 }, health: 18, food: 20, pos: { x: 30, y: 64, z: 16 } }),
  );
  assert.match(d, /\+12 cobblestone/);
  assert.match(d, /-1 bread/);
  assert.match(d, /-2 hp/);
  assert.match(d, /\+2 food/);
  assert.match(d, /moved 34m/);
});

test('stepDelta: a stalled step reads exactly "Δ nothing"', () => {
  assert.equal(stepDelta(body(), body()), 'Δ nothing');
  // sub-2m drift is jitter, not progress
  assert.equal(stepDelta(body(), body({ pos: { x: 1, y: 64, z: 0.5 } })), 'Δ nothing');
});

test('stepDelta: new item appearing counts from zero', () => {
  assert.match(stepDelta(body(), body({ inv: { wooden_pickaxe: 1 } })), /\+1 wooden_pickaxe/);
});

// ---------------------------------------------------------------------------
// ledgers persist through a JourneyRunner restart
// ---------------------------------------------------------------------------

test('ledger: too_hard and completed survive a process restart', () => {
  writeFileSync(join(DIR, 'journeys.json'), JSON.stringify({
    journeys: [
      { id: 'j1', goal: 'swim to the moon', status: 'error', iterations: 3, startedAt: 1, journal: [], result: 'nope' },
    ],
    completed: ['craft a wooden pickaxe'],
    too_hard: ['swim to the moon'],
  }));
  const runner = new JourneyRunner();
  const ledger = runner.ledger();
  assert.deepEqual(ledger.completed, ['craft a wooden pickaxe']);
  assert.deepEqual(ledger.tooHard, ['swim to the moon']);
  // the file wasn't clobbered by construction
  const onDisk = JSON.parse(readFileSync(join(DIR, 'journeys.json'), 'utf8'));
  assert.deepEqual(onDisk.too_hard, ['swim to the moon']);
});

// ---------------------------------------------------------------------------
// thinker curriculum
// ---------------------------------------------------------------------------

test('progression focus is in the idle rotation and preaches the ledger', () => {
  const progression = IDLE_FOCI.find((f) => f.startsWith('Progression'));
  assert.ok(progression, 'progression focus exists');
  assert.match(progression!, /tech-tree/);
  assert.match(progression!, /VERIFIABLE/);
  assert.match(progression!, /too-hard/);
  // rotation reaches it
  const picked = new Set(Array.from({ length: IDLE_FOCI.length }, (_, i) => pickFocus(i)));
  assert.equal(picked.size, IDLE_FOCI.length);
});

// ── nearbyThreats: the shared radar (issue #5) ──────────────────────────────
// The fleet's entityHurt handler once hand-rolled this filter and threw a
// TypeError out of the EventEmitter on a position-less entity. nearbyThreats
// is now the single implementation — it must guard positions, compare by id
// (object identity lies across the LiveBody proxy), and never throw.

test('nearbyThreats: position-less and self entities are skipped, never thrown on', async () => {
  const { nearbyThreats } = await import('../src/digest.js');
  const at = (x: number, y: number, z: number) => ({
    x, y, z,
    distanceTo: (o: { x: number; y: number; z: number }) => Math.hypot(o.x - x, o.y - y, o.z - z),
  });
  const bot = {
    entity: { id: 1, position: at(0, 64, 0) },
    entities: {
      1: { id: 1, position: at(0, 64, 0), kind: 'Hostile mobs', name: 'self-as-hostile?' }, // self — id compare must drop it
      2: { id: 2, position: undefined, kind: 'Hostile mobs', name: 'ghost' }, // just-spawned, no position yet — the old crash
      3: { id: 3, position: at(3, 64, 0), kind: 'Hostile mobs', name: 'zombie' },
      4: { id: 4, position: at(5, 64, 0), type: 'hostile', name: 'creeper' }, // kind missing, type fallback
      5: { id: 5, position: at(4, 64, 0), kind: 'Passive mobs', name: 'cow' },
      6: null, // torn-down slot
      7: { id: 7, position: at(50, 64, 0), kind: 'Hostile mobs', name: 'far-zombie' }, // out of range
    },
  };
  let out: string[] = [];
  assert.doesNotThrow(() => { out = nearbyThreats(bot as never, 8); });
  assert.equal(out.length, 2, `zombie + creeper only, got: ${out.join(' | ')}`);
  assert.match(out[0], /zombie 3m/); // nearest first
  assert.match(out[1], /creeper 5m/);
  assert.ok(!out.some((l) => l.includes('cow') || l.includes('ghost') || l.includes('far')), 'passive/ghost/far excluded');
});

test('nearbyThreats: no own entity yet (reconnect beat) → empty, no throw', async () => {
  const { nearbyThreats } = await import('../src/digest.js');
  assert.deepEqual(nearbyThreats({ entity: undefined, entities: { 9: { id: 9 } } } as never), []);
  assert.deepEqual(nearbyThreats({ entity: { id: 1, position: undefined }, entities: {} } as never), []);
});

// ---------------------------------------------------------------------------
// issue #6.2: ledgers classify by the explicit endedBy field, never by
// regexing the result text — "Hit the vein at (…) [JOURNEY_DONE]" is a WIN.
// ---------------------------------------------------------------------------

test('ledger: a goal whose final answer starts with "Hit the" still lands in completed', async () => {
  writeFileSync(join(DIR, 'journeys.json'), JSON.stringify({ journeys: [] }));
  const runner = new JourneyRunner();
  runner.bind({ busy: 0, ask: async () => 'Hit the iron vein at (12, -40, 88) and mined 9 ore [JOURNEY_DONE]' } as never);
  const j = runner.start('find iron');
  for (let i = 0; i < 100 && runner.get(j.id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
  const done = runner.get(j.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.endedBy, 'goal');
  assert.ok(runner.ledger().completed.includes('find iron'), 'the old regex misfiled this as a cap-hit');
});

test('ledger: a stopped-not-doomed journey is endedBy=stopped and ledgered neither way', async () => {
  writeFileSync(join(DIR, 'journeys.json'), JSON.stringify({ journeys: [] }));
  const runner = new JourneyRunner();
  runner.bind({ busy: 0, ask: async () => 'still digging' } as never);
  const j = runner.start('dig forever');
  await new Promise((r) => setTimeout(r, 100));
  runner.stop(j.id);
  for (let i = 0; i < 100 && runner.get(j.id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
  const s = runner.get(j.id)!;
  assert.equal(s.status, 'stopped');
  assert.equal(s.endedBy, 'stopped');
  assert.ok(!runner.ledger().completed.includes('dig forever'), 'stopped-not-doomed is ledgered neither way');
  assert.ok(!runner.ledger().tooHard.includes('dig forever'));
});

// ---------------------------------------------------------------------------
// progressVerdict — chosen patience vs wedged (issue #12)
// ---------------------------------------------------------------------------

test('progressVerdict: a declared furnace wait is patience, not a stall', () => {
  // The live journal shape: the bot loaded a furnace, then correctly did
  // nothing while it smelted. Three "Δ nothing" lines used to read as STALLED
  // and the supervisor stopped a healthy journey.
  const journal = [
    'Loaded 8 raw iron and coal into the furnace at (12,64,-3). [Δ -8 raw_iron, -2 coal]',
    'Standing by while the furnace works. [Δ nothing] [waiting: 8 iron smelting, ~80s left]',
    'Still smelting. [Δ nothing] [waiting: 8 iron smelting, ~50s left]',
    'Still smelting. [Δ nothing] [waiting: 8 iron smelting, ~20s left]',
  ];
  const v = progressVerdict(journal);
  assert.equal(v.verdict, 'patient');
  assert.equal(v.waits, 3);
  assert.equal(v.blanks, 3);
  assert.match(v.reason, /deliberate waiting/);
});

test('progressVerdict: an UNDECLARED no-change streak is still a stall', () => {
  const journal = [
    'Heading to the spruce. [Δ moved 12m]',
    'Trying to chop the spruce. [Δ nothing]',
    'Trying to chop the spruce. [Δ nothing]',
    'Trying to chop the spruce. [Δ nothing]',
  ];
  const v = progressVerdict(journal);
  assert.equal(v.verdict, 'stalled');
  assert.equal(v.waits, 0);
  assert.match(v.reason, /no declared wait/);
});

test('progressVerdict: waiting is bounded — past the cap patience becomes a stall', () => {
  const journal = Array.from({ length: MAX_CONSECUTIVE_WAITS + 1 }, () =>
    'Waiting on the furnace. [Δ nothing] [waiting: iron smelting]');
  const v = progressVerdict(journal);
  assert.equal(v.verdict, 'stalled');
  assert.match(v.reason, /patience exhausted/);
  // one under the cap is still patience
  assert.equal(progressVerdict(journal.slice(0, MAX_CONSECUTIVE_WAITS)).verdict, 'patient');
});

test('progressVerdict: errors count as no-change, and a wait cannot mask them', () => {
  const stalled = progressVerdict([
    'error: Bedrock is unable to process your request',
    'error: no path to (12,64,-3)',
    'error: no path to (12,64,-3)',
  ]);
  assert.equal(stalled.verdict, 'stalled');
  // A single declared wait among three blanks does not buy patience: two of
  // them are still unexplained.
  const mixed = progressVerdict([
    'Nothing happened. [Δ nothing]',
    'Nothing happened. [Δ nothing]',
    'Nothing happened. [Δ nothing]',
    'Waiting on the furnace. [Δ nothing] [waiting: iron smelting]',
  ]);
  assert.equal(mixed.verdict, 'stalled');
  assert.equal(mixed.waits, 1);
});

test('progressVerdict: real change, or too little evidence, is not a stall', () => {
  assert.equal(progressVerdict(['Mined out the vein. [Δ +12 cobblestone, moved 8m]']).verdict, 'progressing');
  assert.equal(progressVerdict([]).verdict, 'progressing');
  const early = progressVerdict(['Opened the chest. [Δ nothing]', 'Read the sign. [Δ nothing]']);
  assert.equal(early.verdict, 'progressing');
  assert.match(early.reason, /too early/);
});

test('a step that declares [WAITING: …] journals patience, and the cap marks it exhausted', async () => {
  // Drive a real JourneyRunner with a scripted session: every step declares a
  // furnace wait and nothing in the body changes — the exact shape that used
  // to read as a stall. The waiting cooldown is 15s, so the journey is
  // stopped after the first few steps instead of waiting them out.
  const runner = new JourneyRunner();
  const body: BodySnapshot = { pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inv: { raw_iron: 8 } };
  runner.snapshot = () => ({ ...body, inv: { ...body.inv } });
  let asked = 0;
  const lines: string[] = [];
  runner.onProgress = (_j, step) => lines.push(step);
  runner.bind({
    busy: 0,
    ask: async () => {
      asked++;
      return `Standing by while the furnace works. [WAITING: 8 iron smelting, ~${90 - asked * 20}s left]`;
    },
  } as never);
  const j = runner.start('smelt 8 iron');
  // one step, then stop: the 15s waiting cooldown means step 2 never lands
  await new Promise((r) => setTimeout(r, 300));
  runner.stop(j.id);
  assert.equal(j.journal.length, 1, 'exactly one step ran before the long wait cooldown');
  assert.match(j.journal[0], /\[waiting: 8 iron smelting/);
  assert.ok(!j.journal[0].includes('[WAITING:'), 'the marker itself is stripped from the narration');
  assert.match(j.journal[0], /Δ nothing/, 'the Δ critic still tells the truth about the body');
  assert.equal(progressVerdict(j.journal).verdict, 'patient');

  // And the cap: a journal already at MAX waits gets the exhausted flag on the
  // next wait, which flips the computed verdict for the supervisor.
  const long = Array.from({ length: MAX_CONSECUTIVE_WAITS + 1 }, () => 'wait. [Δ nothing] [waiting: iron smelting ⚠ patience exhausted]');
  assert.equal(progressVerdict(long).verdict, 'stalled');
});

test('the supervisor prompt hands the model a computed progress signal, not just prose', async () => {
  // Journey shape: patient. The prompt must SAY patient and must forbid
  // stopping a healthy wait (issue #12: it stopped one).
  const { Thinker } = await import('../src/thinker.js');
  const journey = {
    id: 'j1', goal: 'smelt 8 iron', status: 'running' as const, iterations: 4, startedAt: Date.now(),
    journal: [
      'Loaded the furnace. [Δ -8 raw_iron]',
      'Standing by. [Δ nothing] [waiting: 8 iron smelting, ~50s]',
      'Standing by. [Δ nothing] [waiting: 8 iron smelting, ~20s]',
    ],
  };
  const thinker = new Thinker(
    { busy: 0, ask: async () => 'ok' } as never,
    { running: journey, ledger: () => ({ completed: [], tooHard: [] }) } as never,
  );
  const prompt = (thinker as unknown as { supervisorPrompt: (j: unknown) => string }).supervisorPrompt(journey);
  assert.match(prompt, /Measured progress signal: PATIENT/);
  assert.match(prompt, /LEAVE IT ALONE/);
  assert.match(prompt, /DECLARED itself deliberate patience/);
  thinker.stop();
});

// ── the regen rule, stated (live soak 2026-08-17) ────────────────────────
const hurtSnap = (health: number, food: number, foodPortions = 0) =>
  formatDigest({ ...baseSnap, health, food, foodPortions });

test('digest: hurt and underfed says regen is impossible, and why it matters', () => {
  // The live deadlock: 3.5 HP, food 5, sealed in a box, "waiting for morning".
  const d = hurtSnap(3.5, 5);
  assert.match(d, /HEALING: none until food >= 18 \(food 5\)/);
  assert.match(d, /NO food — getting food IS the emergency/);
});

test('digest: with food in the bag the advice is EAT, not go hunting', () => {
  assert.match(hurtSnap(6, 9, 3), /EAT, resting does not heal/);
});

test('digest: healthy or well-fed bots are not lectured', () => {
  assert.doesNotMatch(hurtSnap(20, 5), /HEALING/, 'full health: not the issue');
  assert.doesNotMatch(hurtSnap(4, 19), /HEALING/, 'food 19: regen is already running');
});

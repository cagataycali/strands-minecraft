/**
 * Issue #34 — THE EVACUATION THAT NEVER STICKS.
 *
 * /tmp/mc-soak41.log has sixteen `[self_preservation] EVACUATING water … 0 hp —
 * swam 9.6m … head is OUT of the water` lines, several seconds apart, and the
 * bot died in that lake. Every one of them was reported as a SUCCESS, because
 * success was "no water over the head" sampled on the frame the swim stopped —
 * which is when a swimming body's head is out.
 *
 * This is a BODY harness: it drives the real reflex tick over a fake bot whose
 * water never lets go, and asserts the three things the log lacked — a verdict
 * graded on ground truth, an ESCALATION to a different mechanism, and an honest
 * impossibility when the bag cannot pay for one. The no-op path is the point
 * (issue #48's lesson: every test modelled success, so the false green lived).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';

process.env.EVAC_SWIM_MS = '20';
process.env.EVAC_GRACE_MS = '5';
process.env.HAZARD_COOLDOWN_MS = '20';
process.env.REFLEX_MODES_OFF = 'dying,creeper_flee,fight_back,unstuck,auto_eat,starving,auto_armor,item_magnet,elbow_room,idle_staring';

const { startReflexes } = await import('../src/reflexes.js');

/** A body in open water: head and feet wet, nothing solid under it, forever. */
const harness = (o: { pack?: string[]; placeThrows?: boolean; submerged?: boolean; ceiling?: boolean; sideExit?: boolean; handDigMs?: number; toolDigMs?: number } = {}) => {
  const notes: string[] = [];
  const log: string[] = [];
  const placed: string[] = [];
  // THE BOB, modelled: soak41's body had its head under water when the check
  // ran and above it the instant the swim stopped — which is exactly why a
  // single frame of air was mistaken for an escape sixteen times. So the head
  // comes up when the swim ends (clearControlStates) and goes back under when
  // the next swim starts (jump). The feet never leave the lake either way.
  let headOut = false;
  const bot = new EventEmitter() as unknown as Record<string, unknown> & EventEmitter;
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 62, 0), height: 1.8 },
    entities: {},
    health: 4,          // critical: the evacuate branch, not the surface one
    food: 20,
    oxygenLevel: 40,    // ~2 units: air is nearly gone whatever the trend
    inventory: { items: () => (o.pack ?? []).map((name, i) => ({ name, slot: 9 + i, count: 3, type: 100 + i })) },
    // Open water: feet wet, nothing solid below. `submerged` also puts the head
    // under, which is the OTHER failure shape (dig out, not pillar).
    blockAt: (p: Vec3) => {
      // A shaft through the roof three blocks east: the LATERAL exit, which is
      // what soak42's ten metres of swimming should have aimed at.
      if (o.sideExit && p.x >= 3 && p.y >= 64) return { name: 'air', position: p };
      // Real blocks price themselves (prismarine-block.digTime) — a fake one
      // that does not is how an unpayable dig hid behind a flat 5s timeout.
      if (o.ceiling && p.y >= 64) return { name: 'stone', position: p, boundingBox: 'block', type: 1, digTime: (t: number | null) => (t === null ? (o.handDigMs ?? 400) : (o.toolDigMs ?? 200)) };
      const head = p.y >= 63;
      return { name: head && headOut && !o.submerged ? 'air' : 'water', position: p };
    },
    equip: async () => {},
    placeBlock: async (_ref: unknown, _face: unknown) => {
      if (o.placeThrows) throw new Error('Must be holding a block to place it');
      placed.push('placed');
    },
    dig: async () => {},
    digTime: () => o.handDigMs ?? 400,
    heldItem: undefined,
    lookAt: async () => {},
    setControlState: (name: string) => { if (name === 'jump') headOut = false; },
    // The head breaks the surface for a moment and then the body sinks back —
    // 40ms here stands for the second or two it lasted in the lake.
    clearControlStates: () => { headOut = true; setTimeout(() => { headOut = false; }, 40).unref?.(); },
    pathfinder: { setGoal: () => {}, stop: () => {}, goto: async () => {} },
  });
  const handle = startReflexes(
    { bot, onEachBot: (fn: (b: unknown) => void) => fn(bot) } as never,
    { deliberateBusy: () => false, note: (t: string) => notes.push(t), log: (_w: string, t: string) => log.push(t) },
    { idleModes: false, tickMs: 10 },
  );
  assert.ok(handle, 'reflexes must start');
  return { bot, notes, log, placed, stop: () => handle!.stop() };
};

const until = async (pred: () => boolean, ms = 4_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
};

test('#34 an evacuation that leaves the body in the water is NOT reported as a success', async () => {
  const h = harness();
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('EVACUATING water'))), 'the reflex must fire');
    const line = h.log.find((l) => l.includes('EVACUATING water'))!;
    assert.ok(!/head is OUT of the water/.test(line), `soak41's false success must be gone: ${line}`);
    assert.match(line, /NOT OUT — treading water/);
    assert.match(line, /one frame of air is not an escape/);
  } finally { h.stop(); }
});

test('#34 a repeat failure ESCALATES to a different mechanism, not a third identical swim', async () => {
  const h = harness({ pack: ['dirt'] });
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('PILLARED') || l.includes('did not hold')), 6_000),
      `escalation must reach the pillar: ${h.log.join(' | ')}`);
    // the attempts before it are named as attempts, not as successes
    assert.ok(h.log.filter((l) => l.includes('EVACUATING')).length >= 2);
    assert.ok(h.placed.length >= 1, 'a block must actually be placed under the feet');
  } finally { h.stop(); }
});

test('#34 nothing placeable = an honest impossibility handed to the mind (the no-op path)', async () => {
  const h = harness({ pack: ['bread'] }); // edible, not placeable
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('ESCALATION IMPOSSIBLE')), 6_000),
      `the impossibility must be stated: ${h.log.join(' | ')}`);
    assert.ok(h.notes.some((n) => /NOTHING placeable to stand on/.test(n)), 'and it must reach the mind');
    assert.equal(h.placed.length, 0);
  } finally { h.stop(); }
});

test('#34 a refused placement is reported as refused, never as an escape', async () => {
  const h = harness({ pack: ['dirt'], placeThrows: true });
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('could not place dirt')), 6_000),
      `a throwing placeBlock must be narrated: ${h.log.join(' | ')}`);
    assert.ok(!h.log.some((l) => l.includes('PILLARED OUT')));
  } finally { h.stop(); }
});

test('#34 submerged under a ceiling escalates to DIGGING, not to pillaring', async () => {
  const h = harness({ submerged: true, ceiling: true, pack: ['dirt'] });
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('DUG UP through stone')), 6_000),
      `the ceiling must be dug: ${h.log.join(' | ')}`);
    assert.equal(h.placed.length, 0, 'a body with a roof over it does not need a floor');
  } finally { h.stop(); }
});

test('#34 a sealed roof with an open column nearby swims SIDEWAYS, not up again', async () => {
  const h = harness({ submerged: true, ceiling: true, sideExit: true, pack: ['dirt'] });
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('open column')), 6_000),
      `the lateral exit must be chosen: ${h.log.join(' | ')}`);
    const line = h.log.find((l) => l.includes('open column'))!;
    assert.match(line, /UP IS SEALED: stone at y=64/);
    assert.ok(!/swimming again on the next tick/.test(line), `soak42's answer must be gone: ${line}`);
    assert.equal(h.placed.length, 0, 'a body under a roof does not need a floor');
  } finally { h.stop(); }
});

test('#34 a sealed roof with NO way sideways skips the wasted second swim and digs', async () => {
  const h = harness({ submerged: true, ceiling: true });
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('DUG UP through stone')), 6_000),
      `the ceiling must be dug: ${h.log.join(' | ')}`);
    const first = h.log.find((l) => l.includes('EVACUATING'))!;
    assert.match(first, /attempt 1/, 'the FIRST attempt already escalates: up is impossible, not unlucky');
    assert.ok(!/swimming again/.test(first), first);
  } finally { h.stop(); }
});

test('#34/A an unpayable dig is REFUSED out loud and the air buys something else', async () => {
  // soak43: three bubbles of air, a bare fist, and stone overhead — the game
  // prices that dig at ~10s underwater. The old code raced a flat 5s timeout
  // and reported `dig timeout` after spending the air it did not have.
  const h = harness({ submerged: true, ceiling: true, handDigMs: 10_000, pack: ['dirt'] });
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('UNPAYABLE')), 6_000),
      `the dig must be priced and refused: ${h.log.join(' | ')}`);
    const line = h.log.find((l) => l.includes('UNPAYABLE'))!;
    assert.match(line, /costs 10\.0s with a bare fist/);
    assert.match(line, /I can only pay/);
    assert.ok(!/DUG UP/.test(line), `a refused dig must not claim to have dug: ${line}`);
    // and the seconds go to a mechanism that can actually pay
    assert.ok(await until(() => h.log.some((l) => /placing a block to stand on|PILLARED|did not hold/.test(l)), 6_000),
      `the fallback must run: ${h.log.join(' | ')}`);
  } finally { h.stop(); }
});

test('#34/A a payable dig EQUIPS the cheapest hand first and says which', async () => {
  const h = harness({ submerged: true, ceiling: true, handDigMs: 10_000, toolDigMs: 900, pack: ['stone_pickaxe'] });
  try {
    assert.ok(await until(() => h.log.some((l) => l.includes('DUG UP through stone')), 6_000),
      `the pickaxe must make the dig payable: ${h.log.join(' | ')}`);
    const line = h.log.find((l) => l.includes('DUG UP through stone'))!;
    assert.match(line, /PAYABLE/);
    assert.match(line, /0\.9s with stone pickaxe/);
    assert.match(line, /a bare fist would cost 10\.0s/);
    assert.match(line, /equipped stone pickaxe first/);
  } finally { h.stop(); }
});

test('#34/A nothing to dig with and nothing to place = the mind is told, not a silent timeout', async () => {
  const h = harness({ submerged: true, ceiling: true, handDigMs: 10_000 });
  try {
    assert.ok(await until(() => h.notes.some((n) => /CANNOT dig out in time/.test(n)), 6_000),
      `the impossibility must reach the mind: ${h.notes.join(' | ')} :: ${h.log.join(' | ')}`);
    assert.ok(h.log.some((l) => /mind's call, right now/.test(l)));
  } finally { h.stop(); }
});

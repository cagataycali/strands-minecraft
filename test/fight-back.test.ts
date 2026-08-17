/**
 * Issue #38 — the body must SWING.
 *
 * The soak that motivated this (/tmp/mc-soak21.log, 2026-08-18 09:01 EDT) shows
 * StrandsBot going 20 → 1 hp while sentinel queued
 * `briefing[2] ... melee range, its first swing lands within seconds` five
 * times behind a turn in flight. Zero swings were made, because the only
 * combat the body could do was the last rung of escape()'s ladder.
 *
 * This is a BODY harness, not pure logic: it drives the real reflex tick over a
 * fake mineflayer bot and asserts on the mechanism the mind cannot supply in
 * time — swings land while the mind is busy, a FLYER is never answered with a
 * ground path, the burst stops the instant the mob dies or breaks off, and the
 * arms never touch the legs' claim (a swing is arms; the walk it defends keeps
 * its claim, issue #30/#16).
 *
 * The cadence knobs are turned down via env BEFORE importing, which is also the
 * proof that every threshold this reflex uses is a knob in the one registry and
 * not a literal (HARDCODING.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { LegsLock, LEGS_PRIORITY } from '../src/legs.js';

process.env.MELEE_SWING_MS = '5';
process.env.MELEE_BURST_MS = '40';
process.env.MELEE_ANSWER_COOLDOWN_MS = '5';
process.env.MELEE_NOTE_MS = '1';
// Only the mode under test may fire, so a hazard read or a hunger pang cannot
// be mistaken for the swing (one mode per tick).
process.env.REFLEX_MODES_OFF = 'self_preservation,dying,creeper_flee,unstuck,auto_eat,auto_armor,item_magnet,elbow_room,idle_staring';

const { startReflexes, dyingAnswer, meleeAnswerTarget, isFlyingHostile } = await import('../src/reflexes.js');

interface FakeMob { id: number; name: string; type: string; position: Vec3; isValid: boolean; height: number }

const mob = (id: number, name: string, at: Vec3): FakeMob =>
  ({ id, name, type: 'hostile', position: at, isValid: true, height: 1.95 });

/** A body just real enough for the tick: arms, eyes, legs and a mob list. */
const harness = (mobs: FakeMob[], o: { busy?: boolean; walking?: boolean; health?: number; inv?: string[]; pack?: string[]; held?: string } = {}) => {
  const attacks: FakeMob[] = [];
  const legMoves: string[] = [];
  const notes: string[] = [];
  const bot = new EventEmitter() as unknown as Record<string, unknown> & EventEmitter;
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 64, 0), height: 1.8 },
    entities: Object.fromEntries(mobs.map((m) => [m.id, m])),
    health: o.health ?? 20,
    food: 20,
    oxygenLevel: 20,
    heldItem: o.held ? { name: o.held } : undefined,
    inventory: {
      items: () => [
        ...(o.inv ?? []).map((name, i) => ({ name, slot: 36 + i })),
        ...(o.pack ?? []).map((name, i) => ({ name, slot: 9 + i })),
      ],
      slots: [],
    },
    equip: async () => {},
    // #50: the real client's hotbar switch — a HeldItemChange packet, so the hand
    // simply becomes whatever sits in that slot. The stub used to omit this
    // entirely, which quietly asserted that a sword already on the hotbar could
    // only be reached through a window click the server may refuse.
    quickBarSlot: 0,
    setQuickBarSlot: (n: number) => {
      Object.assign(bot, { quickBarSlot: n });
      const inSlot = (bot.inventory as { items: () => { name: string; slot: number }[] })
        .items().find((i) => i.slot === 36 + n);
      Object.assign(bot, { heldItem: inSlot ? { name: inSlot.name } : undefined });
    },
    blockAt: () => ({ name: 'air' }),
    attack: (e: FakeMob) => { attacks.push(e); },
    lookAt: async () => {},
    setControlState: () => {},
    pathfinder: {
      goal: o.walking ? { id: 'walk-to-chest' } : null,
      isMoving: () => !!o.walking,
      setGoal: (g: unknown) => { legMoves.push(`setGoal(${g === null ? 'null' : 'goal'})`); },
      stop: () => { legMoves.push('stop'); },
      goto: async () => { legMoves.push('goto'); },
    },
  });
  const legs = new LegsLock();
  const handle = startReflexes(
    { bot, onEachBot: (fn: (b: unknown) => void) => fn(bot) } as never,
    { deliberateBusy: () => !!o.busy, note: (t: string) => notes.push(t), legs },
    { idleModes: false, tickMs: 10 },
  );
  assert.ok(handle, 'reflexes must start');
  return { bot, attacks, legMoves, notes, legs, handle: handle!, stop: () => handle!.stop() };
};

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a condition instead of for a clock. The tick is 10ms here, but this
 * suite shares a machine with a live bot: a fixed sleep makes a real assertion
 * into a flaky one, and a flaky test about combat is worse than no test.
 */
const until = async (pred: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await settle(10);
  }
  return pred();
};

test('#38 a hostile inside reach is swung at even while the mind is mid-turn', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.6, 64, 0));
  const h = harness([zombie], { busy: true, walking: true });
  const swung = await until(() => h.attacks.length >= 1);
  // The narration lands when the burst finishes, so wait for the behaviour line
  // rather than for a clock (the burst budget is a knob, not a constant).
  const logged = await until(() => /\[fight_back\] swung \d+x at the zombie/.test(h.handle.recent(5).join(' ')));
  h.stop();
  assert.ok(swung, `expected swings, got ${h.attacks.length}`);
  assert.ok(h.attacks.every((a) => a.id === 2), 'the swings must land on the mob in reach');
  // The whole point: the mind was busy the entire time. It hears facts after.
  assert.ok(logged, `expected a fight_back line, got: ${h.handle.recent(5).join(' ')}`);
});

test('#38 the note to the mind is FACTS with the decision left open', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.2, 64, 0));
  const h = harness([zombie, mob(3, 'zombie', new Vec3(6, 64, 2))], { busy: true });
  await until(() => h.notes.some((n) => /swung/.test(n)));
  h.stop();
  const note = h.notes.find((n) => /swung/.test(n));
  assert.ok(note, `expected a fight note, got: ${h.notes.join(' | ')}`);
  assert.match(note!, /hp 20\.0\/20/);
  assert.match(note!, /hostiles within 8 blocks: zombie 1\.2m, zombie 6\.\dm/);
  assert.match(note!, /What to DO about it is yours/); // policy stays with the mind
  assert.doesNotMatch(note!, /you (must|should)\b/i); // no orders
});

test('#38/#34 a FLYER in reach is answered with swings, never a ground path', async () => {
  const phantom = mob(2, 'phantom', new Vec3(1.1, 65, 0));
  const h = harness([phantom], { busy: true, health: 3 });
  await until(() => h.attacks.length >= 1 && h.notes.some((n) => /FLIES/.test(n)));
  h.stop();
  assert.ok(h.attacks.length >= 1, 'the phantom must be swung at');
  assert.deepEqual(h.legMoves, [], `the legs must not be used against a flyer: ${h.legMoves.join(', ')}`);
  const note = h.notes.find((n) => /FLIES/.test(n));
  assert.ok(note, 'the mind must be told why the body did not run');
  // And the policy helper agrees at death's door: fight a flyer, flee a ground mob.
  assert.equal(dyingAnswer({ threat: { name: 'phantom', dist: 1.1 } }), 'fight');
  assert.equal(dyingAnswer({ threat: { name: 'zombie', dist: 1.1 } }), 'flee');
  assert.equal(isFlyingHostile('phantom'), true);
});

test('#38 the burst stops the moment the target dies', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.5, 64, 0));
  const h = harness([zombie]);
  await until(() => h.attacks.length >= 1);
  zombie.isValid = false;
  const swungWhileAlive = h.attacks.length;
  await until(() => /it is DOWN/.test(h.handle.recent(5).join(' ')));
  h.stop();
  assert.ok(swungWhileAlive >= 1, 'it must swing while the mob is alive');
  assert.equal(h.attacks.length, swungWhileAlive, 'a dead mob must not be swung at again');
  assert.match(h.handle.recent(5).join(' '), /it is DOWN/);
});

test('#38 the burst stops when the target leaves reach', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.5, 64, 0));
  const h = harness([zombie]);
  await until(() => h.attacks.length >= 1);
  zombie.position = new Vec3(20, 64, 0); // it broke off
  const before = h.attacks.length;
  await settle(150);
  h.stop();
  assert.ok(before >= 1);
  assert.equal(h.attacks.length, before, 'a mob 20m away must not be swung at');
  // Out of reach is out of the target set entirely — mechanism, not tactics.
  assert.equal(meleeAnswerTarget([{ name: 'zombie', dist: 20 }]), null);
});

test('#38/#30 swinging takes no claim on the legs, and never erases the walk\'s claim', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.4, 64, 0));
  const h = harness([zombie], { busy: true, walking: true });
  const walk = h.legs.take({ owner: 'go_to', priority: LEGS_PRIORITY.agent, ttlMs: 60_000, what: 'a walk to the chest' });
  assert.ok(walk, 'the walk holds the legs first');
  await until(() => h.attacks.length >= 1);
  h.stop();
  assert.ok(h.attacks.length >= 1, 'the swing must not be blocked by the walk own claim');
  const held = h.legs.held();
  assert.equal(held?.owner, 'go_to', `the walk must still own the legs, not ${held?.owner ?? 'nobody'}`);
});

test('#38 a creeper in reach is never punched — the dodge stays the answer', async () => {
  const creeper = mob(2, 'creeper', new Vec3(1.2, 64, 0));
  const h = harness([creeper], { busy: true });
  await settle(200);
  h.stop();
  assert.deepEqual(h.attacks, [], 'punching a primed creeper is the death creeper_flee avoids');
});

/**
 * Issue #45 — a swing thrown from beyond the server's 3.0-block attack range is
 * a dropped packet, and the live soak spent 71 of 120 swings that way (0 kills,
 * while every kill came from inside 2m). The body must HOLD its swing at that
 * distance instead of burning the cadence slot, and keep facing the target so
 * the pass where the flyer dives is the pass that lands.
 */
test('#45 a hostile inside the trigger radius but beyond striking distance is faced, not swung at', async () => {
  const phantom = mob(2, 'phantom', new Vec3(3.6, 64, 0)); // < answerReach 4, > swingReach 3
  const h = harness([phantom], { busy: true });
  const lookedAt: string[] = [];
  (h.bot as unknown as { lookAt: (p: Vec3) => Promise<void> }).lookAt = async (p: Vec3) => {
    lookedAt.push(`${p.x.toFixed(1)}`);
  };
  await until(() => lookedAt.length >= 2);
  await settle(150);
  assert.equal(h.attacks.length, 0, `a mob at 3.6m is outside the 3.0m attack range — the server drops that swing; got ${h.attacks.length}`);
  assert.ok(lookedAt.length >= 2, 'the body must keep facing it while it waits for the dive');

  // It dives: the very next pass of the same budget must strike.
  phantom.position = new Vec3(1.8, 64, 0);
  const struck = await until(() => h.attacks.length >= 1);
  h.stop();
  assert.ok(struck, 'once inside striking distance the held swing must land');
});

test('#45 the outcome line distinguishes "never inside striking distance" from "broke off"', async () => {
  const phantom = mob(2, 'phantom', new Vec3(3.5, 64, 0));
  const h = harness([phantom], { busy: true });
  // Give the burst its whole budget with the mob hovering out of striking range,
  // then let it leave the trigger radius entirely.
  await settle(200);
  phantom.position = new Vec3(9, 64, 0);
  await settle(120);
  h.stop();
  const log = h.handle.recent(10).join(' · ');
  assert.ok(
    !/broke off/.test(log),
    `a mob that was never inside striking distance must not be reported as having broken off: ${log}`,
  );
});

/**
 * Issue #46 — the bot fought a WHOLE NIGHT bare-fisted (120/120 swings "with
 * fists", 4 kills, 5 deaths) and nothing in the system ever said so. The body
 * already equips the best weapon it owns; what was missing is the observation,
 * so these assert that being unarmed is VISIBLE, stated once per disarmament,
 * and never turned into an order.
 */
test('#46 fighting bare-handed escalates ONCE, naming the empty bag', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.2, 64, 0));
  const h = harness([zombie], { busy: true, inv: ['dirt', 'bread'] });
  await until(() => h.notes.some((n) => /BARE-HANDED/.test(n)));
  await until(() => h.attacks.length >= 3); // keep fighting: more bursts, no more alarms
  h.stop();
  // Precise: a legs-handover note quotes the behaviour log (which now carries
  // the same line), so match the ALARM itself, not any mention of it.
  const alarms = h.notes.filter((n) => n.startsWith('(reflex) The body just fought BARE-HANDED'));
  assert.equal(alarms.length, 1, `one alarm per disarmament, got ${alarms.length}`);
  assert.match(alarms[0], /ARMED: FISTS/);
  assert.match(alarms[0], /NO sword, axe or trident anywhere in your inventory/);
  assert.match(alarms[0], /1 damage/);
  assert.doesNotMatch(alarms[0], /craft a sword/i); // the remedy is the mind's
});

test('#46 a weapon in the bag but not in hand is named in the alarm', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.2, 64, 0));
  // #50: in the PACK and the click refused — on the hotbar the body would simply
  // draw it now, and there would be nothing to raise an alarm about.
  const h = harness([zombie], { busy: true, pack: ['stone_axe'] });
  (h.bot as unknown as { equip: () => Promise<void> }).equip = () =>
    Promise.reject(new Error('inventory window is open'));
  await until(() => h.notes.some((n) => /BARE-HANDED/.test(n)));
  h.stop();
  const alarm = h.notes.find((n) => /BARE-HANDED/.test(n))!;
  assert.match(alarm, /stone_axe IS in your inventory but is not in your hand/);
});

test('#46 an armed body raises no alarm, and the fight note states the weapon', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.2, 64, 0));
  const h = harness([zombie], { busy: true, inv: ['iron_sword'], held: 'iron_sword' });
  await until(() => h.notes.some((n) => /swung/.test(n)));
  h.stop();
  assert.equal(h.notes.filter((n) => /BARE-HANDED/.test(n)).length, 0, 'an armed bot is not news');
  assert.match(h.notes.find((n) => /swung/.test(n))!, /ARMED: iron_sword/);
});

/**
 * #46 — the draw is not guaranteed. `bot.equip(...).catch(() => {})` swallowed
 * every refusal, and the narration then credited a sword the hand never got:
 * the mind read "swung 6x with iron_sword", saw the mob survive, and had no way
 * to learn that six fist-hits went out instead.
 */
test('#46 a failed weapon draw is named, and the hand is reported as it actually is', async () => {
  // The sword is in the PACK, not on the hotbar, so the draw genuinely needs the
  // window click that this server refuses (#50: on the hotbar it would not).
  const h = harness([mob(2, 'zombie', new Vec3(1.2, 64, 0))], { pack: ['iron_sword'] });
  (h.bot as unknown as { equip: () => Promise<void> }).equip = () =>
    Promise.reject(new Error('inventory window is open'));
  try {
    await until(() => /swung \d+x/.test(h.handle.recent(5).join(' ')));
    const log = h.handle.recent(5).join(' ');
    assert.match(log, /could NOT draw the iron_sword: inventory window is open/);
    assert.match(log, /with fists/, 'the hand is reported empty, because it is');
    assert.doesNotMatch(log, /away with iron_sword/, 'never credit a weapon the body never held');
  } finally { h.handle.stop(); }
});

test('#46 a successful draw is credited to the hand that holds it', async () => {
  const h = harness([mob(2, 'zombie', new Vec3(1.2, 64, 0))], { inv: ['iron_sword'] });
  (h.bot as unknown as { equip: (i: { name: string }) => Promise<void> }).equip = async (i) => {
    (h.bot as unknown as { heldItem: { name: string } }).heldItem = { name: i.name };
  };
  try {
    await until(() => /swung \d+x/.test(h.handle.recent(5).join(' ')));
    const log = h.handle.recent(5).join(' ');
    assert.match(log, /with iron_sword/);
    assert.doesNotMatch(log, /could NOT draw/);
  } finally { h.handle.stop(); }
});

/**
 * ISSUE #50 — the fix, at body level. A server that refuses every window click
 * used to cost the whole burst: soak30 landed 7 of 65 swings with a stick, dirt,
 * planks or a phantom_membrane while the sword sat in the bag. A weapon on the
 * hotbar needs no click at all, and that path must be taken even when clicking
 * is broken.
 */
test('#50 a window click that always fails does not stop a hotbar weapon from being drawn', async () => {
  const h = harness([mob(2, 'zombie', new Vec3(1.2, 64, 0))], { inv: ['iron_sword'], held: 'dirt' });
  (h.bot as unknown as { equip: () => Promise<void> }).equip = () =>
    Promise.reject(new Error('inventory window is open'));
  try {
    await until(() => /swung \d+x/.test(h.handle.recent(5).join(' ')));
    const log = h.handle.recent(5).join(' ');
    assert.match(log, /with iron_sword/, 'the hotbar switch got the sword into the hand');
    assert.doesNotMatch(log, /with dirt/, 'the junk it started with never reached a swing');
    assert.doesNotMatch(log, /REFUSED/);
  } finally { h.handle.stop(); }
});

test('#50 nothing better than a fist: the hand is emptied by SELECTING an empty slot, not by asking', async () => {
  // dirt in hotbar slot 36, nothing else — slot 37 is empty, so a fist is one
  // packet away and needs no permission. unequip is not even called.
  let unequips = 0;
  const h = harness([mob(2, 'zombie', new Vec3(1.2, 64, 0))], { inv: ['dirt'], held: 'dirt' });
  (h.bot as unknown as { unequip: () => Promise<void> }).unequip = () => {
    unequips += 1;
    return Promise.reject(new Error('the server refused it'));
  };
  try {
    await until(() => /swung \d+x/.test(h.handle.recent(5).join(' ')));
    const log = h.handle.recent(5).join(' ');
    assert.match(log, /with fists/, 'a fist, not a block');
    assert.doesNotMatch(log, /with dirt/);
    assert.equal(unequips, 0, 'the empty-slot switch made the refusable call unnecessary');
  } finally { h.handle.stop(); }
});

/**
 * #46 — the escalation used to exist only as a note, which travels to the mind
 * and nowhere else: a whole live soak fought bare-fisted after a death dropped
 * its trident and the log could not say whether the alarm had fired at all.
 */
test('#46 the bare-handed escalation is auditable from outside, not just noted', async () => {
  const h = harness([mob(2, 'zombie', new Vec3(1.2, 64, 0))], { inv: ['dirt'] });
  try {
    await until(() => /BARE-HANDED/.test(h.handle.recent(8).join(' ')));
    const log = h.handle.recent(8).join(' ');
    assert.match(log, /🥊 The body just fought BARE-HANDED/);
    assert.ok(h.notes.some((n) => /BARE-HANDED/.test(n)), 'the mind still gets the note');
  } finally { h.handle.stop(); }
});

test('#49 a draw that RESOLVED but never landed is named REFUSED, not narrated as a choice', async () => {
  // The harness's equip() resolves and the hand never changes — precisely what
  // the server does when it refuses the swap one round trip after the promise.
  // Live: four bursts swung dirt with a stone_sword in the bag and not one line
  // said the draw had failed, so the mind read "dirt" as its own decision.
  const zombie = mob(2, 'zombie', new Vec3(1.4, 64, 0));
  // #50 keeps this scenario reachable only through the window click: the sword is
  // in the pack (slot 9+), the click resolves, and the hand never changes.
  const h = harness([zombie], { pack: ['stone_sword'], inv: ['dirt'], held: 'dirt' });
  const logged = await until(() => /\[fight_back\] swung \d+x at the zombie/.test(h.handle.recent(5).join(' ')));
  h.stop();
  assert.ok(logged, `expected a fight_back line, got: ${h.handle.recent(5).join(' ')}`);
  const line = h.handle.recent(5).find((l) => /fight_back\] swung/.test(l))!;
  assert.match(line, /with dirt \(NOT a weapon/, 'the hand is still read back honestly');
  assert.match(line, /the stone_sword draw was REFUSED/, 'the refusal itself must be news (#49)');
  assert.match(line, /still in the bag/, 'and it must say where the weapon actually is');
});

test('#49 a draw that landed says nothing about drawing at all', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.4, 64, 0));
  // held === the best weapon in the bag: no equip is attempted, nothing to report.
  const h = harness([zombie], { inv: ['stone_sword'], held: 'stone_sword' });
  await until(() => /\[fight_back\] swung \d+x at the zombie/.test(h.handle.recent(5).join(' ')));
  h.stop();
  const line = h.handle.recent(5).find((l) => /fight_back\] swung/.test(l))!;
  assert.match(line, /with stone_sword/);
  assert.doesNotMatch(line, /REFUSED|could NOT draw/, 'silence is the happy path');
});

/**
 * soak29: 163 bare-fisted swings, 4 deaths, and exactly ONE bare-handed alarm
 * in twenty minutes. The alarm is once-per-disarmament by design (#46, so a
 * two-minute fight cannot flood the note rail) — but a DEATH is a new
 * disarmament: everything droppable is at the corpse, so the shortfall
 * arithmetic the mind was last handed is stale. The latch has to re-arm.
 */
test('#46 a death re-arms the bare-handed alarm — the bag it described is on the ground', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.2, 64, 0));
  const h = harness([zombie], { busy: true }); // no inv, no held: fists
  // The escalation NOTE itself — not the behaviour-log digest that quotes it
  // ("the fight_back reflex briefly took the legs — Log: 🥊 …"), which is a
  // second sighting of one alarm, not a second alarm.
  const bare = (n: string) => n.startsWith('(reflex) The body just fought BARE-HANDED');
  try {
    await until(() => h.notes.some(bare));
    const first = h.notes.filter(bare).length;
    assert.equal(first, 1, `the alarm speaks once per episode, got ${first} of: ${h.notes.join(' | ')}`);
    // Still unarmed: the latch must hold, or the note rail floods.
    await settle(80);
    assert.equal(h.notes.filter(bare).length, 1, 'a latched alarm must stay quiet while nothing changes');
    // The bot dies. Same fists, entirely different bag.
    h.bot.emit('death');
    const again = await until(() => h.notes.filter(bare).length >= 2);
    assert.ok(again, `a death must let the fact be stated again, got ${h.notes.filter(bare).length}`);
  } finally { h.stop(); } // a reflex left ticking keeps the whole test process alive
});

/**
 * The remedy half (f701da8): an unarmed body whose bag CANNOT pay for a weapon
 * must still be told the arithmetic. This is the case that went unreported for
 * a whole session — a refused/absent equip, not a happy path.
 */
test('#46/#47 the bare-handed alarm carries the shortfall when the bag cannot pay', async () => {
  const zombie = mob(2, 'zombie', new Vec3(1.2, 64, 0));
  // Cobblestone and no stick: one item short of a stone sword, and the old rail
  // said nothing at all about it.
  const h = harness([zombie], { busy: true, inv: ['cobblestone', 'cobblestone'] });
  try {
    await until(() => h.notes.some((n) => n.startsWith('(reflex) The body just fought BARE-HANDED')));
    const note = h.notes.find((n) => n.startsWith('(reflex) The body just fought BARE-HANDED'));
    assert.ok(note, `expected the bare-handed alarm, got: ${h.notes.join(' | ')}`);
    assert.match(note!, /NEAREST WEAPON: a stone_sword/);
    assert.match(note!, /MISSING 1 more stick/);
    assert.match(note!, /handle has to come from a tree/);
    assert.doesNotMatch(note!, /you (must|should) (go|mine|craft)/i); // facts, never orders
  } finally { h.stop(); }
});

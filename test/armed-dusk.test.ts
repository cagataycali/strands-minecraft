/**
 * Issue #46 — dusk is when the mind PLANS the night. The bot that threw 120
 * bare-fisted swings under a full moon was never told, at any planning moment,
 * that its hotbar was empty; the only note that named the weapon arrived
 * mid-fight and rate-limited.
 *
 * Its own file because the time poll's cadence must be turned down BEFORE the
 * sentinel module is imported (two polls are needed: one to take the day/night
 * baseline, one to see the flip).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';

process.env.SENTINEL_TIME_POLL_MS = '15';
const { startSentinel } = await import('../src/sentinel.js');

test('#46 the dusk briefing states the armed state as a fact', async () => {
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    players: {}, username: 'StrandsBot', registry: {},
    time: { isDay: true, moonPhase: 0 },
    inventory: { items: () => [], slots: [] },
  });
  const notes: string[] = [];
  const handle = startSentinel(
    { bot, onEachBot: (fn: (b: unknown) => void) => fn(bot) } as never,
    { note: (t: string) => notes.push(t), reflex: () => {}, log: () => {} },
  );
  assert.ok(handle, 'sentinel started');
  try {
    // Let the first poll take the DAY baseline — flipping before it lands means
    // the sentinel never sees an edge, only a world that was always night.
    await new Promise((r) => setTimeout(r, 60));
    const deadline = Date.now() + 3_000;
    (bot as unknown as { time: unknown }).time = { isDay: false, moonPhase: 0 };
    while (!notes.some((n) => /NIGHT FALLS/.test(n)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const dusk = notes.find((n) => /NIGHT FALLS/.test(n));
    assert.ok(dusk, `expected a dusk note, got: ${notes.join(' | ')}`);
    assert.match(dusk!, /FULL MOON/);
    assert.match(dusk!, /ARMED: FISTS — NO sword, axe or trident anywhere in your inventory/);
    assert.match(dusk!, /Armour: NONE/);
    assert.doesNotMatch(dusk!, /you must/i); // facts and options, never orders
  } finally {
    handle!.stop();
  }
});

/**
 * #46 — the melee alarm is the highest-leverage pre-fight moment there is, and
 * it is SPOKEN, so the armed clause appears only when it is bad news: an armed
 * bot does not need its own sword read back to it inside a 2-second warning.
 */
const meleeAlarm = (inv: string[], held?: string) => {
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    players: {}, username: 'StrandsBot', registry: {}, health: 20,
    time: { isDay: true, moonPhase: 3 },
    heldItem: held ? { name: held } : undefined,
    inventory: { items: () => inv.map((name) => ({ name })), slots: [] },
    entities: { 2: { id: 2, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', position: new Vec3(1.2, 64, 0), isValid: true } },
  });
  const alarms: string[] = [];
  const handle = startSentinel(
    { bot, onEachBot: (fn: (b: unknown) => void) => fn(bot) } as never,
    { note: () => {}, reflex: (_k: string, t: string) => alarms.push(t), log: () => {} },
  );
  return { handle, alarms };
};

test('#46 the melee alarm names the empty hand, and stays terse when armed', async () => {
  const bare = meleeAlarm(['dirt']);
  const armed = meleeAlarm(['iron_sword'], 'iron_sword');
  try {
    const deadline = Date.now() + 3_000;
    while (!(bare.alarms.length && armed.alarms.length) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const b = bare.alarms.find((a) => /melee range/.test(a));
    assert.ok(b, `expected a melee alarm, got: ${bare.alarms.join(' | ')}`);
    assert.match(b!, /ARMED: FISTS — NO sword, axe or trident/);
    const a = armed.alarms.find((x) => /melee range/.test(x));
    assert.ok(a, 'the armed bot must still be warned about the zombie');
    assert.doesNotMatch(a!, /ARMED:/); // spoken alarms stay short when the news is fine
  } finally {
    bare.handle!.stop(); armed.handle!.stop();
  }
});

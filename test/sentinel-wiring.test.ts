/**
 * Base security through the REAL handler (issue #9): the bug was in the wiring,
 * not in the pure helpers — a per-position debounce that could never fire, and
 * no notion of a trusted player. Own file because it must set MEMORY_DIR and
 * TRUSTED_PLAYERS BEFORE sentinel.ts (and memory.ts under it) are loaded; a
 * static import would hoist above the env lines and read the live bot's store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vec3 } from 'vec3';

const dir = mkdtempSync(join(tmpdir(), 'sm-sentinel-'));
process.env.MEMORY_DIR = dir;
writeFileSync(join(dir, 'memory.json'), JSON.stringify({
  places: [{ name: 'birch_camp', x: -44, y: 59, z: 73 }],
}));
process.env.TRUSTED_PLAYERS = 'CagatayCali';
process.env.SECURITY_SETTLE_MS = '30';    // milliseconds, not seconds
process.env.SECURITY_QUIET_MS = '400';
const { startSentinel } = await import('../src/sentinel.js');


/**
 * Wait for a condition instead of guessing a duration.
 *
 * These tests set SECURITY_SETTLE_MS=30 / QUIET_MS=400 and used fixed sleeps just
 * past them — fine on an idle laptop, flaky the moment the machine is busy (this
 * soak runs a live bot plus workers plus eight test processes, and the suite went
 * red once on exactly that). A soak harness that cries wolf is worse than no
 * harness: the next iteration cannot tell a regression from load.
 */
/** For NEGATIVE assertions ('and then nothing happens'), where there is no event
 *  to await — the only honest tool is a pause, so make it generous. */
const SETTLE = 250;
const until = async (what: string, cond: () => boolean, budgetMs = 5_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > budgetMs) throw new Error(`timed out waiting for ${what} (${budgetMs}ms)`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const fakeBot = () => {
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(-44, 59, 73) },
    players: {}, username: 'StrandsBot', time: { isDay: true },
    inventory: { items: () => [] }, registry: {},
  });
  return bot as EventEmitter & { emit: (e: string, ...a: unknown[]) => boolean };
};

test('a trusted digger is logged and never noted; a stranger gets ONE aggregated note', async () => {
  const bot = fakeBot();
  const notes: string[] = [];
  const logs: string[] = [];
  const handle = startSentinel(
    { bot, onEachBot: (fn: (b: unknown) => void) => fn(bot) } as never,
    { note: (t) => notes.push(t), reflex: () => {}, log: (_w, t) => logs.push(t) },
  );
  assert.ok(handle, 'sentinel started');
  try {
    const dig = (who: string, i: number) =>
      bot.emit('blockBreakProgressObserved',
        { position: new Vec3(-44 - i, 59, 73), name: 'dirt' }, 5,
        { id: 99, type: 'player', username: who });

    // The live case: the operator mining his own tunnel produced 14 of the
    // bot's 15 briefings, each importance 2, each read aloud.
    for (let i = 0; i < 14; i++) dig('CagatayCali', i);
    await until('the trusted log line', () => logs.some((l) => l.startsWith('(trusted)')));
    assert.deepEqual(notes, [], 'trusted hands never reach the model or the voice rail');
    // Visible, but once: the same 14 breaks used to print 14 identical lines
    // (and a single block prints one per dig STAGE — the live soak logged 102
    // lines for one small hole). Quiet, not invisible.
    const trustedLines = logs.filter((l) => l.startsWith('(trusted)'));
    assert.equal(trustedLines.length, 1, 'one line per (digger, base) per window');
    assert.match(trustedLines[0], /CagatayCali is working near 'birch_camp'/);

    // A stranger doing exactly the same thing: one note, carrying the count.
    for (let i = 0; i < 14; i++) dig('Griefer', i);
    await until('the aggregated break-in note', () => notes.length > 0);
    assert.equal(notes.length, 1, 'one aggregated note, not fourteen');
    assert.match(notes[0], /Griefer is BREAKING dirt near your waypoint 'birch_camp' — 14 blocks so far/);
    assert.match(notes[0], /latest at \(-57, 59, 73\)/);

    // Our own digging is still ignored entirely (entity id === bot's).
    bot.emit('blockBreakProgressObserved', { position: new Vec3(-45, 59, 73), name: 'stone' }, 5,
      { id: 1, type: 'player', username: 'StrandsBot' });
    await new Promise((r) => setTimeout(r, SETTLE));
    assert.equal(notes.length, 1);

    // A spree outliving the quiet window earns exactly one escalation.
    // (positions stay inside SECURITY_RANGE of the waypoint — 30 blocks out
    // is simply not a base event, as the second test shows)
    for (let i = 15; i < 20; i++) dig('Griefer', i);
    // The quiet window is a passage of TIME, not an event — nothing to await, and
    // the escalation is produced by the first dig AFTER it expires.
    await new Promise((r) => setTimeout(r, 450));
    dig('Griefer', 21);
    await until('the second escalation past the quiet window', () => notes.length > 1);
    assert.equal(notes.length, 2);
    assert.match(notes[1], /STILL digging/);
  } finally {
    handle!.stop(); // intervals must die or the test runner hangs
  }
});

test('a break far from every waypoint is not a security event at all', async () => {
  const bot = fakeBot();
  const notes: string[] = [];
  const handle = startSentinel(
    { bot, onEachBot: (fn: (b: unknown) => void) => fn(bot) } as never,
    { note: (t) => notes.push(t), reflex: () => {} },
  );
  try {
    bot.emit('blockBreakProgressObserved', { position: new Vec3(900, 59, 900), name: 'dirt' }, 5,
      { id: 99, type: 'player', username: 'Griefer' });
    await new Promise((r) => setTimeout(r, SETTLE));
    assert.deepEqual(notes, []);
  } finally {
    handle!.stop();
  }
});

test('own crew arriving and retiring is logged, never briefed', async () => {
  // Live soak 2026-08-17: 'Sparky JOINED the world. If it's your operator, a short
  // greeting is welcome' — about a worker the bot itself hired 90 seconds earlier,
  // and one that is deaf to chat by design.
  const bot = fakeBot();
  const notes: string[] = [];
  const logs: string[] = [];
  const handle = startSentinel(
    { bot, onEachBot: (fn: (b: unknown) => void) => fn(bot) } as never,
    { note: (t) => notes.push(t), reflex: () => {}, log: (_w, t) => logs.push(t), ownWorkers: () => ['Sparky', 'Stairwell'] },
  );
  try {
    bot.emit('playerJoined', { username: 'Sparky', gamemode: 0 });
    bot.emit('playerLeft', { username: 'Stairwell' });
    assert.deepEqual(notes, [], 'the crew is not company');
    assert.ok(logs.some((l) => l.includes('player joined: Sparky')), 'but the operator still sees them arrive');
    assert.ok(logs.some((l) => l.includes('player left: Stairwell')));

    // A human is still news — that distinction is the whole point.
    bot.emit('playerJoined', { username: 'CagatayCali', gamemode: 0 });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /CagatayCali JOINED/);

    // Nor does a worker's gamemode flip deserve a bulletin, while a player's does.
    bot.emit('playerUpdated', { username: 'Sparky', gamemode: 1 });
    assert.equal(notes.length, 1, 'crew gamemode is the bot\'s own business');
    bot.emit('playerUpdated', { username: 'CagatayCali', gamemode: 1 });
    assert.match(notes[1] ?? '', /gamemode changed to creative/);
  } finally { handle?.stop(); }
});

test('isOwnCrew: case-insensitive, and trusted humans are NOT crew', async () => {
  const { isOwnCrew } = await import('../src/sentinel.js');
  assert.ok(isOwnCrew('sparky', ['Sparky']));
  assert.ok(!isOwnCrew('CagatayCali', ['Sparky']));
  assert.ok(!isOwnCrew(undefined, ['Sparky']));
  assert.ok(!isOwnCrew('Sparky', []), 'a retired roster leaves nobody trusted by omission');
});

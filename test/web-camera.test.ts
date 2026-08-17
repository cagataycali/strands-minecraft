import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCamera } from '../src/web.js';

const NOW = 1_800_000_000_000;

test('describeCamera: the ambiguous frames:0/watchers:0 case now says which one it is', () => {
  // The live soak's entire diagnosis used to be `frames: 0, watchers: 0`,
  // which fits both "nobody is watching" and "broken for hours".
  assert.match(describeCamera({ frames: 0, watchers: 0, now: NOW }), /never started/);
  assert.match(describeCamera({ frames: 900, watchers: 0, now: NOW }), /idle .*900 frames/);
});

test('describeCamera: a watcher with no frames is called out as the fault it is', () => {
  const s = describeCamera({ frames: 0, watchers: 1, now: NOW });
  assert.match(s, /NO frames yet/);
});

test('describeCamera: warm-up is a state, with its age (Chrome cold start measured 31s)', () => {
  const s = describeCamera({ frames: 0, watchers: 1, warmingSince: NOW - 12_000, now: NOW });
  assert.match(s, /warming up \(12s\)/);
});

test('describeCamera: a failure wins over everything and names the error', () => {
  const s = describeCamera({
    frames: 0, watchers: 1, warmingSince: NOW - 5_000,
    error: 'Navigation timeout of 30000 ms exceeded', now: NOW,
  });
  assert.match(s, /^broken: Navigation timeout/);
});

test('describeCamera: healthy streaming reports both numbers', () => {
  assert.match(describeCamera({ frames: 42, watchers: 2, now: NOW }), /streaming to 2 watcher\(s\), 42 frames/);
});

// ── Say receipts (issue #20) ────────────────────────────────────────────────
// Two of four /api/say messages vanished in the live soak: 202 {"ok":true}, then
// never answered, never refused, no error line anywhere. They were invisible
// rather than merely slow because log() reaches only attached SSE clients, and
// nobody was attached — the catch around onSay wrote into a ring nobody read.
import { createSayLedger } from '../src/web.js';

function ledgerAt(t: { now: number }, watchdogMs = 90_000, extra: Parameters<typeof createSayLedger>[0] | object = {}) {
  const said: string[] = [];
  const led = createSayLedger({ emit: (x) => said.push(x), watchdogMs, now: () => t.now, ...extra });
  return { said, led };
}

test('say ledger: queued → answered, with the time it actually took', () => {
  const t = { now: 1_000_000 };
  const { said, led } = ledgerAt(t);
  const id = led.start('craft a chest, place it, deposit exactly 10 cobblestone, then withdraw 5 back');
  assert.equal(id, 'say-1');
  assert.match(said[0]!, /say-1 queued: "craft a chest.*…"/, 'the text is quoted, and trimmed');
  t.now += 145_000; // the real latency of the soak's successful say
  led.finish(id);
  assert.match(said[1]!, /say-1 answered after 145s/);
  assert.deepEqual(led.pending(), [], 'and it is no longer in flight');
});

test('say ledger: a thrown turn is REPORTED — the case the old catch swallowed', () => {
  const t = { now: 5_000 };
  const { said, led } = ledgerAt(t);
  const id = led.start('mount a boat');
  t.now += 3_000;
  led.finish(id, { error: new Error('ValidationException: two consecutive user messages') });
  assert.match(said[1]!, /say-1 FAILED after 3s: ValidationException/);
});

test('say ledger: a LIVE turn is never accused of being lost, however long it takes', () => {
  // The soak's say-7: declared "the drop case, re-send" at 398s while the bot was
  // visibly walking and taking phantom damage — and it answered, correctly and in
  // full, at 619s (issue #33). Following that advice would have forked a duplicate
  // turn onto a mind that was already working.
  const t = { now: 0 };
  const { said, led } = ledgerAt(t, 90_000, { busy: () => 1 });
  led.start('Go to the loot_chest at (-6,64,12), report its contents, withdraw 5 cobblestone');
  t.now = 60_000;
  led.sweep();
  assert.equal(said.length, 1, 'a minute in is not yet news — a turn may legitimately take that long');
  t.now = 106_000;
  led.sweep();
  assert.match(said[1]!, /unanswered after 106s.*1 turn\(s\) in flight session-wide/);
  assert.doesNotMatch(said[1]!, /the mind is busy, not lost/, 'busy() proves the session works, never that THIS ask does (#41)');
  t.now = 398_000;
  led.sweep();
  assert.match(said[2]!, /unanswered after 398s/);
  assert.doesNotMatch(said[2]!, /drop|DROPPED/, 'the exact line that was false in the soak');
  // Past the deadline the rail stops waiting — the #33 lesson (never accuse a
  // working mind) holds INSIDE the deadline; #41's lesson is that "however long
  // it takes" cannot mean forever. 900s is beyond the 600s default.
  t.now = 900_000;
  led.sweep();
  assert.match(said[3]!, /ABANDONED after 900s/, 'proof of life keeps coming, then an honest end (#41)');
  t.now = 619_000 + 900_000;
  led.finish('say-1');
  assert.match(said[said.length - 1]!, /answered after/);
});

test('say ledger: a DROP is provable, and needs no timer to prove it', () => {
  const t = { now: 0 };
  const { said, led } = ledgerAt(t, 90_000, { busy: () => 0 });
  led.start('run the vehicle test');
  t.now = 60_000;
  led.sweep();
  assert.equal(said.length, 1, 'still inside the watchdog window');
  t.now = 95_000;
  led.sweep();
  // Nothing is running and nothing answered: that IS the drop, on the FIRST
  // qualifying sweep — the old code needed three warnings to reach a guess.
  assert.match(said[1]!, /DROPPED after 95s — nothing is running and nothing answered "run the vehicle test"/);
  assert.match(said[1]!, /re-send it/, 'and here re-sending is the right advice');
});

test('say ledger: a turn that goes idle mid-wait flips from running to dropped', () => {
  const t = { now: 0 };
  let inFlight = 1;
  const { said, led } = ledgerAt(t, 90_000, { busy: () => inFlight });
  led.start('deposit the cobblestone');
  t.now = 95_000;
  led.sweep();
  assert.match(said[1]!, /unanswered after 95s/);
  inFlight = 0; // the turn ended without ever answering this say
  t.now = 300_000;
  led.sweep();
  assert.match(said[2]!, /DROPPED after 300s/, 'the drop case is real, and this is what it looks like');
});

test('say ledger: says WHY it is slow when something knows', () => {
  const t = { now: 0 };
  const { said, led } = ledgerAt(t, 90_000, {
    busy: () => 2,
    why: (sinceMs) => `3 reflex interrupt(s) (dying, creeper_flee) in the last ${Math.round(sinceMs / 1_000)}s`,
  });
  led.start('walk to the base');
  t.now = 95_000;
  led.sweep();
  assert.match(said[1]!, /unanswered after 95s — 3 reflex interrupt\(s\) \(dying, creeper_flee\) in the last 95s — 2 turn\(s\) in flight/);
});

test('say ledger: with no liveness source it reports the wait and claims NOTHING', () => {
  const t = { now: 0 };
  const { said, led } = ledgerAt(t); // no busy() wired — a stub rail, or an old caller
  led.start('run the vehicle test');
  t.now = 95_000;
  led.sweep();
  assert.match(said[1]!, /still unanswered after 95s — cannot tell a slow turn from a dropped one/);
  t.now = 300_000;
  led.sweep();
  t.now = 900_000;
  led.sweep();
  assert.equal(said.length, 4);
  t.now = 3_600_000;
  led.sweep();
  assert.equal(said.length, 4, 'unproven suspicion stops talking after three warnings');
  assert.doesNotMatch(said.join('\n'), /this is the drop case/, 'certainty it cannot have');
});

test('say ledger: two says in flight are tracked apart', () => {
  const t = { now: 0 };
  const { said, led } = ledgerAt(t);
  const a = led.start('sign test');
  t.now = 1_000;
  const b = led.start('chest test');
  assert.deepEqual(led.pending().map((p) => p.id), ['say-1', 'say-2']);
  t.now = 4_000;
  led.finish(a);
  assert.match(said[2]!, /say-1 answered after 4s/);
  assert.deepEqual(led.pending().map((p) => p.id), ['say-2'], 'the other is still in flight');
  assert.equal(led.pending()[0]!.ageMs, 3_000);
});

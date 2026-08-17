/**
 * The note rail's shelf life (issue #32).
 *
 * Live measurement: during ONE 8-minute human ask, a circling phantom queued 94
 * near-identical sightings, dedupe defeated by the coordinates in each line, and
 * the operator's next sentence would have arrived behind all of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoteQueue, classifyNote, renderNote } from '../src/notes.js';

const radar = (mob: string, d: number, pos: string) =>
  `(sentinel) A ${mob} closed to ${d} blocks (inside 8), at ${pos}, heading toward you.`;

test('classifyNote: sightings perish, consequences do not', () => {
  assert.deepEqual(classifyNote(radar('phantom', 6.2, '(-24, 73, 14)')), { cls: 'perishable', subject: 'mob:phantom' });
  assert.deepEqual(
    classifyNote('(sentinel) The phantom pulled back to 8.6 blocks, at (-26, 71, 19) — it is out of melee range for now.'),
    { cls: 'perishable', subject: 'mob:phantom' });
  // The expensive ones to lose: all durable, all unsubjected (never collapsed).
  for (const t of [
    '(system) You DIED and respawned. Your items are on the ground at (1, 2, 3)…',
    '(system) Your connection dropped ("chat_validation_failed") and you reconnected.',
    '(system) Your worker Lumber is done after 12 step(s).',
    '(system) You are HUNGRY — food 6/20.',
  ]) assert.deepEqual(classifyNote(t), { cls: 'durable' }, t.slice(0, 30));
  // Security repeats collapse per person, but are never dropped for age: someone
  // at your chests is still worth knowing about a minute later.
  assert.deepEqual(
    classifyNote("(trusted) CagatayCali just OPENED a chest near 'loot_chest'"),
    { cls: 'durable', subject: 'security:cagataycali' });
});

test('one phantom is ONE note with a count, not 94', () => {
  let now = 0;
  const q = new NoteQueue(40, 30_000, () => now);
  // The exact live pattern: same mob, same band, coordinates always different.
  for (let i = 0; i < 94; i++) { now = i * 250; q.push(radar('phantom', 6 + (i % 3) * 0.4, `(-2${i % 9}, 7${i % 4}, 14)`)); }
  assert.equal(q.stats().pending, 1, 'the queue holds one fact about one phantom');
  assert.equal(q.stats().collapsed, 93);
  const out = q.take();
  assert.equal(out.split('\n').length, 1);
  assert.match(out, /latest of 94 reports over 23s, last 0s ago/, 'and it says the mob is PERSISTENT — which no single sighting can');
  assert.match(out, /\(-2\d, 7\d, 14\)/, 'the newest wording wins: the position is current');
});

test('a sighting nobody collected is not delivered as if it were fresh', () => {
  let now = 0;
  const q = new NoteQueue(40, 30_000, () => now, 120_000);
  q.push(radar('phantom', 6, '(1, 2, 3)'));
  q.push('(system) You DIED and respawned. Your items are on the ground at (1, 2, 3).');
  now = 45_000; // the human took 45s to say anything
  const out = q.take();
  // 45s is past the fresh window and inside the usable one: still delivered,
  // but it may no longer be TRUE and the line has to say so itself.
  assert.match(out, /phantom/, 'a 45s-old sighting can still inform a decision');
  assert.match(out, /seen 45s ago — was true then, may not hold now/, 'hedged, never present tense');
  assert.match(out, /You DIED/, 'the death still stands: it is true until acted on');
  assert.doesNotMatch(out.split('\n').find((l) => /DIED/.test(l))!, /may not hold now/,
    'a durable fact is not hedged — only aged');
});

test('past the usable window a sighting never reaches the mind, and the rail names the rot', () => {
  let now = 0;
  const q = new NoteQueue(40, 30_000, () => now, 120_000);
  q.push(radar('phantom', 6, '(1, 2, 3)'));
  q.push('(system) You DIED and respawned at (1, 2, 3).');
  now = 121_000;
  const drain = q.takeAudited();
  assert.doesNotMatch(drain.text, /phantom/, 'a 2-minute-old mob position is not news in any tense');
  assert.match(drain.text, /You DIED/);
  assert.equal(q.stats().perished, 1, 'the lifetime total stays in stats for /api/state');
  assert.deepEqual({ perished: drain.perished, sources: drain.sources }, { perished: 1, sources: { sentinel: 1 } },
    'WHICH rail rotted, not just how many');
  assert.equal(q.takeAudited().perished, 0, 'the receipt belongs to the drain, not to the process');
});

test('the 26-minute note that started this: a durable fact carries its age (#43 on the mind rail)', () => {
  let now = 0;
  const q = new NoteQueue(40, 30_000, () => now, 120_000);
  q.push('(system) Your worker Lumber is done after 12 step(s).');
  now = 1_569_640; // the live oldestAgeMs when this was measured
  const out = q.take();
  assert.match(out, /worker Lumber/, 'never dropped: it is still true');
  assert.match(out, /\(noted 26m ago\)/, 'and it is 26 minutes old, which the mind must be told');
});

test('a fresh note is untouched — the stamp is for what the tense would lie about', () => {
  let now = 0;
  const q = new NoteQueue(40, 30_000, () => now, 120_000);
  q.push(radar('creeper', 3, '(1, 2, 3)'));
  now = 4_000;
  const out = q.take();
  assert.doesNotMatch(out, /ago/, 'inside the fresh window the sink keeps its own words');
});

test('a usable window shorter than the fresh one is a misconfiguration, not a behaviour', () => {
  let now = 0;
  const q = new NoteQueue(40, 30_000, () => now, 5_000);
  q.push(radar('zombie', 5, '(1, 2, 3)'));
  now = 10_000;
  assert.match(q.take(), /zombie/, 'stamp-then-instantly-drop would deliver nothing at all');
  assert.equal(q.stats().usableMs, 30_000);
});

test('hasPending() does not report a queue full of expired sightings', () => {
  let now = 0;
  const q = new NoteQueue(40, 30_000, () => now);
  q.push(radar('zombie', 5, '(1, 2, 3)'));
  assert.equal(q.hasPending(), true);
  now = 121_000;
  assert.equal(q.hasPending(), false, 'the thinker must not wake up to deliver nothing');
  assert.equal(q.take(), '');
});

test('the cap evicts sightings, never consequences', () => {
  let now = 0;
  const q = new NoteQueue(5, 30_000, () => now);
  q.push('(system) You DIED and respawned at (1, 2, 3).');
  q.push('(system) Your worker Lumber is done after 12 step(s).');
  const mobs = ['zombie', 'skeleton', 'creeper', 'spider', 'husk', 'drowned', 'phantom', 'enderman',
    'witch', 'slime', 'blaze', 'stray', 'pillager', 'vindicator', 'ravager', 'silverfish',
    'cave_spider', 'zombie_villager', 'magma_cube', 'guardian'];
  for (const m of mobs) { now += 100; q.push(radar(m, 5, '(1, 2, 3)')); }
  const out = q.take();
  assert.match(out, /You DIED/, 'a death is never evicted to make room for a mob position');
  assert.match(out, /worker Lumber/);
  assert.ok(out.split('\n').length <= 5, `capped, got ${out.split('\n').length}`);
  assert.ok(q.stats().evicted >= 15);
  // The sightings that survived are the NEWEST ones — oldest perishable goes first.
  assert.match(out, /guardian/);
  assert.doesNotMatch(out, /zombie closed/, 'the first sighting of the storm is long gone');
});

test('a queue of nothing but durable notes still obeys the cap, and says so', () => {
  const q = new NoteQueue(3, 30_000, () => 0);
  for (let i = 0; i < 6; i++) q.push(`(system) Your worker W${i} is done after ${i} step(s).`);
  const st = q.stats();
  assert.equal(st.pending, 3);
  assert.equal(st.evicted, 3, 'dropping a durable note is counted, not silent');
  assert.match(q.take(), /W5/, 'and the newest survive');
});

test('identical text still collapses when there is no subject', () => {
  const q = new NoteQueue(40, 30_000, () => 0);
  q.push('(system) Your connection dropped and you reconnected.');
  assert.equal(q.push('(system) Your connection dropped and you reconnected.'), false);
  assert.equal(q.stats().pending, 1, 'the same sentence twice is one fact — the old behaviour, kept');
});

test('two different mobs are two facts', () => {
  let now = 0;
  const q = new NoteQueue(40, 30_000, () => now);
  q.push(radar('phantom', 6, '(1, 2, 3)'));
  now = 500;
  q.push(radar('enderman', 7, '(9, 9, 9)'));
  assert.equal(q.stats().pending, 2);
  assert.equal(q.stats().perishable, 2);
});

test('renderNote leaves a single report exactly as the sink wrote it', () => {
  const text = radar('creeper', 3, '(1, 2, 3)');
  assert.equal(renderNote({ text, cls: 'perishable', firstAt: 0, lastAt: 0, count: 1 }, 5_000), text);
});

test('stats mirror the voice bridge, so /api/state can show both queues', () => {
  let now = 0;
  const q = new NoteQueue(10, 30_000, () => now);
  q.push(radar('phantom', 6, '(1, 2, 3)'));
  q.push('(system) You DIED and respawned at (1, 2, 3).');
  now = 4_000;
  const st = q.stats();
  assert.deepEqual(
    { pending: st.pending, perishable: st.perishable, cap: st.cap, oldestAgeMs: st.oldestAgeMs,
      freshMs: st.freshMs, perished: st.perished },
    { pending: 2, perishable: 1, cap: 10, oldestAgeMs: 4_000, freshMs: 30_000, perished: 0 });
});

test('NoteQueue: a wordless note is refused — it would poison the next ask (#39)', () => {
  const q = new NoteQueue();
  assert.equal(q.push(''), false);
  assert.equal(q.push('   \n\t '), false);
  assert.equal(q.hasPending(), false, 'an empty text block refuses the whole history on every rail');
  assert.equal(q.push('a creeper is 3 blocks away'), true);
});

test('takeAudited: the two windows are falsifiable from outside the process', () => {
  let now = 0;
  const q = new NoteQueue(40, 30_000, () => now, 120_000);
  q.push(radar('phantom', 6, '(1, 2, 3)'));          // will perish
  q.push('(system) Your worker Lumber is done after 12 step(s).'); // will be stamped
  now = 121_000;
  q.push('(system) You DIED and respawned at (1, 2, 3).');         // fresh
  const r = q.takeAudited();
  assert.equal(r.delivered, 2, 'the perished sighting was never handed over');
  assert.equal(r.stamped, 1, 'the 2-minute-old worker report carries its age');
  assert.equal(r.perished, 1);
  assert.deepEqual(r.sources, { sentinel: 1 }, 'the rail that rotted is named');
  assert.match(r.text, /noted 2m ago/);
  assert.doesNotMatch(r.text.split('\n').find((l) => /DIED/.test(l))!, /ago/, 'the fresh one is untouched');
  assert.deepEqual(q.takeAudited(), { text: '', delivered: 0, stamped: 0, perished: 0, sources: {} },
    'a receipt is per drain, not a running total');
});

/**
 * A METRIC THAT LIES IS THE #48 FALSE-GREEN CLASS WEARING A NUMBER.
 *
 * SOAK34 reported `work.notes.oldestAgeMs 266147` against `usableMs 120000`
 * with 4 pending and 398 collapsed — read twice by a supervisor as a rail that
 * had stopped shedding. It had not: `oldestAgeMs` measured from `firstAt` while
 * every rot rule measures from `lastAt`, so one subject re-sighted every few
 * seconds (exactly what a collapsing rail produces) reported a four-minute-old
 * queue that held nothing older than a second.
 */
test('stats — the reported age is the age the windows judge (lastAt), settled on read', () => {
  let now = 1_000_000;
  const q = new NoteQueue(40, 30_000, () => now, 120_000);
  q.push('(sentinel) A zombie is 2.0 blocks away', { subject: 'zombie' });
  now += 200_000; // four minutes later, the SAME subject is seen again
  q.push('(sentinel) A zombie is 1.4 blocks away', { subject: 'zombie' });
  const s = q.stats();
  assert.equal(s.pending, 1, 'one subject, one note');
  assert.ok(s.oldestAgeMs !== null && s.oldestAgeMs < 1_000, `fresh again: ${s.oldestAgeMs}`);
  assert.ok(s.oldestFirstSeenMs !== null && s.oldestFirstSeenMs >= 200_000, 'first sighting is still reported, separately');
  assert.equal(s.unusable, 0);
});

test('stats — reading settles rot instead of describing an unsettled queue', () => {
  let now = 5_000_000;
  const q = new NoteQueue(40, 30_000, () => now, 120_000);
  q.push('(sentinel) A phantom is 6 blocks away', { subject: 'phantom' });
  q.push('(system) I just DIED at (1, 67, 30)');
  now += 130_000; // past usableMs, and NOTHING has drained in between
  const s = q.stats();
  assert.equal(s.unusable, 0, 'the perishable one is gone, not merely described');
  assert.equal(s.pending, 1, 'the durable death notice is kept');
  assert.equal(s.perished, 1);
  assert.deepEqual(s.perishedSources, { sentinel: 1 });
  assert.ok(s.oldestAgeMs !== null && s.oldestAgeMs >= 130_000, 'a durable fact reports its true age');
});

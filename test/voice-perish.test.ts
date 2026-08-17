/**
 * #43 — a briefing is a PERISHABLE claim.
 *
 * The live rail spoke sentinel lines as present-tense facts up to 101 seconds
 * after they were true ("a zombie is 0.6 blocks away", about a zombie long
 * gone), and a headless bot with zero watchers held ~5 minutes of urgent news
 * nobody could ever hear. These tests pin both halves: past the speakable
 * window a briefing must be provably UNSPEAKABLE, and between fresh and
 * speakable it must go out stamped with its age instead of as a fact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceBridge, briefingLine, FRESH_MS, SPEAKABLE_MS } from '../src/voicebridge.js';

test('drainSpeakable: a perished briefing never reaches the ear, and is counted', () => {
  const b = new VoiceBridge();
  const t0 = 1_000_000;
  b.push('sentinel', 'a zombie is 0.6 blocks away', 2, t0);
  b.push('sentinel', 'a creeper is hissing', 2, t0 + 1_000);
  b.push('journey', 'reached the shaft', 1, t0 + SPEAKABLE_MS);

  const { spoken, perished } = b.drainSpeakable(5, t0 + SPEAKABLE_MS + 2_000);
  assert.deepEqual(perished.map((x) => x.source), ['sentinel', 'sentinel']);
  assert.deepEqual(spoken.map((x) => x.text), ['reached the shaft']);
  assert.equal(b.pending(), 0);
  assert.equal(b.stats().perished, 2, 'the loss is visible from outside the process');
});

test('drainSpeakable: importance never buys immortality — an urgent line perishes too', () => {
  const b = new VoiceBridge();
  const t0 = 5_000;
  b.push('sentinel', 'FIGHT NOW: a zombie is inside melee range', 2, t0);
  const { spoken, perished } = b.drainSpeakable(3, t0 + SPEAKABLE_MS + 1);
  assert.equal(spoken.length, 0);
  assert.equal(perished.length, 1, 'a five-minute-old "fight NOW" is a lie, not news');
});

test('drainSpeakable: honours the limit and leaves the rest queued', () => {
  const b = new VoiceBridge();
  const t0 = 10;
  for (let i = 0; i < 5; i++) b.push('journey', `step ${i}`, 1, t0);
  const { spoken } = b.drainSpeakable(2, t0 + 1);
  assert.equal(spoken.length, 2);
  assert.equal(b.pending(), 3);
});

test('briefingLine: fresh speaks plainly, stale-but-speakable carries its age', () => {
  const b = new VoiceBridge();
  const t0 = 100_000;
  const id = b.push('sentinel', 'a zombie is 0.6 blocks away', 2, t0);
  assert.ok(id > 0);
  const fresh = briefingLine({ id, source: 'sentinel', text: 'a zombie is 0.6 blocks away', importance: 2, createdAt: t0 }, t0 + FRESH_MS);
  assert.equal(fresh, '(briefing from sentinel) a zombie is 0.6 blocks away');

  const late = briefingLine({ id, source: 'sentinel', text: 'a zombie is 0.6 blocks away', importance: 2, createdAt: t0 }, t0 + 101_000);
  assert.match(late, /101s ago/);
  assert.match(late, /may not hold now/);
  assert.ok(late.endsWith('a zombie is 0.6 blocks away'), 'the claim itself is never rewritten');
});

test('the auto-sweep sheds on a schedule, not on a listener', () => {
  const b = new VoiceBridge();
  const t0 = 0;
  b.push('sentinel', 'old danger', 2, t0);
  // No call has ever been live; nothing drains. The sweep must still empty it.
  const dropped = b.flushStale(SPEAKABLE_MS, t0 + SPEAKABLE_MS + 1);
  assert.equal(dropped, 1);
  assert.equal(b.pending(), 0, 'a queue nobody can hear must not grow to five minutes of news');
  assert.equal(b.stats().staleDropped, 1);
});

test('stats publishes the two windows so /api/state can be read honestly', () => {
  const s = new VoiceBridge().stats();
  assert.equal(s.freshMs, FRESH_MS);
  assert.equal(s.speakableMs, SPEAKABLE_MS);
  assert.ok(SPEAKABLE_MS > FRESH_MS);
});

/**
 * The rail's own decision (#43/#40): what the drain says out loud and what it
 * writes to the log, given a drain result. This is the code path the live bot
 * runs every two seconds while a call is up.
 */
import { briefingDispatch } from '../src/web.js';

const brief = (source: string, text: string, importance: number, createdAt: number) => ({ source, text, importance, createdAt });

test('#43 dispatch: perished briefings are logged by source and never spoken', () => {
  const now = 1_000_000;
  const out = briefingDispatch(
    { spoken: [brief('journey', 'reached the shaft', 1, now)], perished: [brief('sentinel', 'a zombie is 0.6 blocks away', 2, now - 200_000), brief('thinker', 'old verdict', 1, now - 300_000)] },
    { now, freshMs: FRESH_MS },
  );
  assert.equal(out.logs.length, 1);
  assert.match(out.logs[0], /2 briefing\(s\) perished unheard/);
  assert.match(out.logs[0], /sentinel, thinker/);
  assert.ok(out.text && !out.text.includes('0.6 blocks away'), 'a perished claim must be unspeakable');
});

test('#43 dispatch: a stale-but-speakable line carries its age, a fresh one does not', () => {
  const now = 500_000;
  const out = briefingDispatch(
    { spoken: [brief('sentinel', 'a creeper is hissing', 2, now - 1_000), brief('sentinel', 'a zombie is 2 blocks away', 2, now - 90_000)], perished: [] },
    { now, freshMs: FRESH_MS },
  );
  assert.match(out.text!, /\(briefing from sentinel\) a creeper is hissing/);
  assert.match(out.text!, /90s ago — was true then, may not hold now\) a zombie is 2 blocks away/);
  assert.deepEqual(out.logs, [], 'nothing was lost, so nothing to report');
});

test('#40 dispatch: a hand-over during an active response is logged as deferred', () => {
  const now = 42;
  const busy = briefingDispatch({ spoken: [brief('journey', 'done', 1, now)], perished: [] }, { now, freshMs: FRESH_MS, busy: true });
  assert.ok(busy.text, 'the briefing still reaches the conversation');
  assert.equal(busy.logs.length, 1);
  assert.match(busy.logs[0], /response was in flight — answer deferred/);

  const idle = briefingDispatch({ spoken: [brief('journey', 'done', 1, now)], perished: [] }, { now, freshMs: FRESH_MS });
  assert.deepEqual(idle.logs, [], 'an idle call is the normal case and says nothing');
});

test('dispatch: importance 0 is log-only and never buys a response', () => {
  const now = 7;
  const out = briefingDispatch({ spoken: [brief('thinker', 'trivial', 0, now)], perished: [] }, { now, freshMs: FRESH_MS });
  assert.equal(out.text, null);
  assert.deepEqual(out.logs, []);
});

/**
 * Voice-bridge queue semantics: push/dedupe/drain/flushStale, and the
 * voice_say tool the model uses to reach the player's ears deliberately.
 * All pure — no server, no audio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceBridge, voiceBridgeTools, STALE_MS } from '../src/voicebridge.js';
import { invoke } from './fake-bot.js';

test('push: returns increasing ids, rejects empty text', () => {
  const b = new VoiceBridge();
  const a = b.push('sentinel', 'a creeper hissed');
  const c = b.push('journey', 'journey done');
  assert.ok(a > 0 && c > a);
  assert.equal(b.push('x', ''), 0);
  assert.equal(b.push('x', '   '), 0);
  assert.equal(b.pending(), 2);
});

test('push: identical pending texts dedupe into one briefing', () => {
  const b = new VoiceBridge();
  const first = b.push('sentinel', 'zombie at the door', 1);
  const again = b.push('sentinel', 'zombie at the door', 1);
  assert.equal(again, first);
  assert.equal(b.pending(), 1);
});

test('push: dedupe upgrades importance in place, never downgrades', () => {
  const b = new VoiceBridge();
  b.push('sentinel', 'chest opened', 1);
  b.push('sentinel', 'chest opened', 2); // louder repeat upgrades
  assert.equal(b.pendingUrgent(), true);
  b.push('sentinel', 'chest opened', 0); // quiet repeat does NOT downgrade
  assert.equal(b.pendingUrgent(), true);
});

test('push: same text is fresh news again after a drain', () => {
  const b = new VoiceBridge();
  const first = b.push('worker', 'Miner_1 finished');
  b.drain();
  const second = b.push('worker', 'Miner_1 finished');
  assert.ok(second > first, 'post-drain repeat is a new briefing');
  assert.equal(b.pending(), 1);
});

test('drain: oldest first, respects limit, removes what it returns', () => {
  const b = new VoiceBridge();
  b.push('a', 'one');
  b.push('b', 'two');
  b.push('c', 'three');
  const got = b.drain(2);
  assert.deepEqual(got.map((x) => x.text), ['one', 'two']);
  assert.equal(b.pending(), 1);
  assert.deepEqual(b.drain().map((x) => x.text), ['three']);
  assert.deepEqual(b.drain(), []);
});

test('flushStale: drops only briefings older than the window', () => {
  const b = new VoiceBridge();
  const now = 1_000_000_000;
  b.push('old', 'yesterday', 1, now - STALE_MS - 1);
  b.push('edge', 'exactly at the edge', 1, now - STALE_MS);
  b.push('new', 'just now', 1, now);
  const dropped = b.flushStale(STALE_MS, now);
  assert.equal(dropped, 1);
  assert.deepEqual(b.drain(10).map((x) => x.text), ['exactly at the edge', 'just now']);
});

test('onPush: fires once per accepted push, never for dedupes or empties', () => {
  const b = new VoiceBridge();
  const seen: string[] = [];
  b.onPush = (x) => seen.push(`${x.source}:${x.text}`);
  b.push('a', 'hello');
  b.push('a', 'hello'); // dedupe — no event
  b.push('a', '');      // empty — no event
  b.push('b', 'world', 2);
  assert.deepEqual(seen, ['a:hello', 'b:world']);
});

test('voice_say tool: pushes to the bridge with urgency mapped to importance', async () => {
  const b = new VoiceBridge();
  const [voiceSay] = voiceBridgeTools(b);
  const r1 = String(await invoke(voiceSay, { text: 'I found the village!' }));
  assert.match(r1, /Queued for voice/);
  const r2 = String(await invoke(voiceSay, { text: 'Creeper right behind you!', urgent: true }));
  assert.match(r2, /Queued for voice/);
  const drained = b.drain(10);
  assert.equal(drained.length, 2);
  assert.equal(drained[0].importance, 1);
  assert.equal(drained[0].source, 'agent');
  assert.equal(drained[1].importance, 2);
  const r3 = String(await invoke(voiceSay, { text: '  ' }));
  assert.match(r3, /Nothing to say/);
});

test('voice_config tool: lists the roster, switches for the NEXT call, rejects unknowns', async () => {
  const prev = process.env.VOICE_NAME;
  try {
    delete process.env.VOICE_NAME;
    const [, voiceConfig] = voiceBridgeTools(new VoiceBridge());
    const list = String(await invoke(voiceConfig, {}));
    assert.match(list, /Current voice: marin/);
    assert.match(list, /cedar/);
    const set = String(await invoke(voiceConfig, { voice: 'Cedar' })); // case-insensitive
    assert.match(set, /Voice set to cedar/);
    assert.match(set, /next call/);
    assert.equal(process.env.VOICE_NAME, 'cedar');
    const bad = String(await invoke(voiceConfig, { voice: 'darthvader' }));
    assert.match(bad, /No voice named "darthvader"/);
    assert.equal(process.env.VOICE_NAME, 'cedar', 'a rejected switch changes nothing');
  } finally {
    if (prev === undefined) delete process.env.VOICE_NAME; else process.env.VOICE_NAME = prev;
  }
});

// ── the cap (issue #10) ───────────────────────────────────────────────────
// Rails push at reflex speed while nobody is on a call; the queue has to be
// bounded in SIZE and in AGE without a session ever happening.

test('cap: the queue never exceeds it, and the oldest least-important go first', () => {
  const b = new VoiceBridge(4);
  b.push('a', 'low-1', 0);
  b.push('b', 'normal-1', 1);
  b.push('c', 'low-2', 0);
  b.push('d', 'normal-2', 1);
  assert.equal(b.pending(), 4);
  b.push('e', 'normal-3', 1); // over cap → evicts oldest importance-0
  assert.equal(b.pending(), 4);
  let texts = b.drain(10).map((x) => x.text);
  assert.deepEqual(texts, ['normal-1', 'low-2', 'normal-2', 'normal-3'], 'low-1 (oldest, least important) left');

  const c = new VoiceBridge(3);
  c.push('a', 'n1', 1); c.push('b', 'n2', 1); c.push('c', 'n3', 1);
  c.push('d', 'n4', 1);
  texts = c.drain(10).map((x) => x.text);
  assert.deepEqual(texts, ['n2', 'n3', 'n4'], 'same importance → plain FIFO eviction');
});

test('cap: importance 2 is never evicted, even past the cap', () => {
  const b = new VoiceBridge(2);
  b.push('sentinel', 'you died', 2);
  b.push('sentinel', 'creeper primed at 4 blocks', 2);
  b.push('sentinel', 'someone broke your wall', 2);
  assert.equal(b.pending(), 3, 'an all-urgent queue is allowed over the cap');
  b.push('journey', 'chopped some wood', 1); // fills, then must evict itself
  const kept = b.drain(10);
  assert.equal(kept.length, 3);
  assert.ok(kept.every((x) => x.importance === 2), 'urgent survived, the chatty line went');
});

test('cap: eviction is observable (onEvict + stats.evicted)', () => {
  const b = new VoiceBridge(1);
  const lost: string[] = [];
  b.onEvict = (x) => lost.push(x.text);
  b.push('a', 'first', 1);
  b.push('b', 'second', 1);
  assert.deepEqual(lost, ['first']);
  assert.equal(b.stats().evicted, 1);
  assert.equal(b.stats().cap, 1);
  assert.equal(b.stats().pending, 1);
});

test('stats: pending/urgent/oldestAgeMs describe the queue for /api/state', () => {
  const b = new VoiceBridge();
  assert.deepEqual(b.stats().oldestAgeMs, null, 'empty queue has no age');
  const now = Date.now();
  b.push('sentinel', 'hostile close', 2, now - 30_000);
  b.push('journey', 'step done', 1, now - 1_000);
  const s = b.stats();
  assert.equal(s.pending, 2);
  assert.equal(s.urgent, 1);
  assert.ok((s.oldestAgeMs ?? 0) >= 29_000, `oldest age looked wrong: ${s.oldestAgeMs}`);
  assert.equal(s.staleDropped, 0);
});

test('startAutoFlush: the bridge sweeps its own stale queue, shutdown stops it', async () => {
  const b = new VoiceBridge();
  b.push('sentinel', 'ancient news', 1, Date.now() - 10 * STALE_MS);
  b.push('sentinel', 'fresh news', 1);
  b.startAutoFlush(1_000, STALE_MS); // floor is 1s
  b.startAutoFlush(1_000, STALE_MS); // idempotent — a second call is not a second timer
  await new Promise((r) => setTimeout(r, 1_200));
  assert.equal(b.pending(), 1, 'the timer dropped the stale one with no session involved');
  assert.equal(b.drain(5)[0].text, 'fresh news');
  assert.equal(b.stats().staleDropped, 1);
  b.shutdown();
  b.shutdown(); // safe twice
  b.push('sentinel', 'older than time', 1, Date.now() - 10 * STALE_MS);
  await new Promise((r) => setTimeout(r, 1_200));
  assert.equal(b.pending(), 1, 'after shutdown nothing sweeps');
});

/**
 * The #44 half nobody had capped: importance 2 is never evicted to make room for
 * lesser news, which is right — and made the queue UNBOUNDED whenever urgent
 * pushes outran the 5-minute stale sweep. Live evidence: a headless bot with
 * zero watchers holding 72 pending briefings, and an earlier soak where 26 of 27
 * pending were urgent during a death spiral (18 deaths in 28 minutes).
 */
test('past the ceiling the queue drops its OLDEST urgent, and says so in a counter', () => {
  const bridge = new VoiceBridge(2, 4); // soft cap 2, hard ceiling 4
  const lost: string[] = [];
  bridge.onEvict = (b) => lost.push(b.text);
  for (const n of [1, 2, 3, 4, 5, 6]) bridge.push('sentinel', `urgent ${n}`, 2);

  const s = bridge.stats();
  assert.equal(s.pending, 4, 'the ceiling, not the soft cap, bounds an all-urgent queue');
  assert.equal(s.urgentDropped, 2, 'a lost danger line is never silent');
  assert.equal(s.evicted, 0, 'ordinary eviction did not happen — nothing lesser was waiting');
  // Oldest first: a five-minute-old "fight NOW" is already a lie (#43), the
  // newest urgent news is the one worth speaking.
  assert.deepEqual(lost, ['urgent 1', 'urgent 2']);
  assert.deepEqual(bridge.drain(10).map((b) => b.text), ['urgent 3', 'urgent 4', 'urgent 5', 'urgent 6']);
});

test('below the ceiling an urgent queue is still allowed past the soft cap', () => {
  const bridge = new VoiceBridge(1, 10);
  for (const n of [1, 2, 3]) bridge.push('sentinel', `danger ${n}`, 2);
  const s = bridge.stats();
  assert.equal(s.pending, 3, 'deaths and creepers are not traded away for chatter');
  assert.equal(s.urgentDropped, 0);
});

test('chatter is still evicted before any urgent line is touched', () => {
  const bridge = new VoiceBridge(2, 4);
  bridge.push('thinker', 'chatter', 0);
  bridge.push('sentinel', 'a creeper is priming', 2);
  bridge.push('journey', 'step done', 1);
  assert.deepEqual(bridge.drain(10).map((b) => b.text), ['a creeper is priming', 'step done']);
  assert.equal(bridge.stats().urgentDropped, 0);
});

/**
 * The same audit for the voice rail, which sheds on a TIMER rather than on read:
 * an age up to one sweep interval past `speakableMs` is the design. Live
 * `oldestAgeMs 167922` vs `speakableMs 120000` was read as a broken rail when
 * the next 60s sweep was simply due — so the stats now carry the interval, and
 * `unspeakable` says exactly what that sweep will shed.
 */
test('stats: the queue says what the next sweep will shed, and that it sweeps', () => {
  const b = new VoiceBridge();
  b.push('sentinel', 'a phantom is 2 blocks away', 2);
  const idle = b.stats();
  assert.equal(idle.unspeakable, 0);
  assert.equal(idle.sweeping, 0, 'no timer until it is started');
  assert.ok(idle.sweepIntervalMs > 0, 'the interval is stated, so an age past the window is checkable');
  b.startAutoFlush(60_000);
  assert.equal(b.stats().sweeping, 1);
  b.shutdown();
  assert.equal(b.stats().sweeping, 0);
});

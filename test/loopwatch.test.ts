/**
 * Tests for loopwatch — the "camera warm-up got the bot kicked" watchdog
 * (issue #18). The sampler runs on injected timers and an injected clock, so a
 * 20-second stall is tested in microseconds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLag, startLoopWatch, KEEPALIVE_RISK_MS, LAG_NOTICE_MS } from '../src/loopwatch.js';

test('classifyLag: a busy process is not news, a starved one is', () => {
  assert.equal(classifyLag(0).report, false);
  assert.equal(classifyLag(LAG_NOTICE_MS - 1).level, 'quiet');
  const notice = classifyLag(1_400);
  assert.equal(notice.level, 'notice');
  assert.match(notice.text, /lag 1\.4s/);
  assert.match(notice.text, /reflexes and the keep-alive share this loop/);
});

test('classifyLag: past the keep-alive threshold it names the consequence, not a number', () => {
  const v = classifyLag(6_200, { culprit: 'the camera warms up' });
  assert.equal(v.level, 'risk');
  assert.match(v.text, /stalled 6\.2s \(while the camera warms up\)/, 'accuse something specific');
  assert.match(v.text, /disconnect\.timeout/, 'this is the kick the soak actually saw');
  assert.match(v.text, /must yield/);
  assert.ok(KEEPALIVE_RISK_MS < 30_000, 'we warn well before vanilla gives up on us');
});

/** A hand-cranked timer wheel: fire() decides how much time "really" passed. */
function fakeTimers() {
  let clock = 1_000;
  let pending: { fn: () => void; ms: number } | null = null;
  return {
    now: () => clock,
    schedule: (fn: () => void, ms: number) => {
      pending = { fn, ms };
      return { cancel: () => { pending = null; } };
    },
    /** Advance the clock by `actualMs` and run the timer that was due. */
    fire(actualMs: number) {
      const p = pending;
      pending = null;
      clock += actualMs;
      p?.fn();
    },
    armed: () => pending !== null,
  };
}

test('loopwatch: lag is measured from the ARMING deadline, not from the late callback', () => {
  const t = fakeTimers();
  const seen: string[] = [];
  const w = startLoopWatch({ emit: (v) => seen.push(v.text), sampleMs: 500, now: t.now, schedule: t.schedule });
  t.fire(500); // on time
  assert.deepEqual(seen, [], 'a punctual sample says nothing');
  t.fire(7_000); // the warm-up stall
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /stalled 6\.5s/, '7000ms late for a 500ms timer = 6.5s of lag');
  assert.equal(w.worst()?.lagMs, 6_500, 'and it is remembered for /api/state');
  w.stop();
  assert.equal(t.armed(), false, 'stop() disarms — no timer keeps the process alive');
});

test('loopwatch: one line per episode, not one per late sample', () => {
  const t = fakeTimers();
  const seen: string[] = [];
  startLoopWatch({ emit: (v) => seen.push(v.text), sampleMs: 500, now: t.now, schedule: t.schedule });
  t.fire(9_000);
  t.fire(2_000); // still catching up, same episode
  t.fire(1_800);
  assert.equal(seen.length, 1, 'a 20s stall must not print twenty times');
  t.fire(500); t.fire(500); t.fire(500); t.fire(500); // calm returns
  t.fire(6_000); // a NEW episode does get its own line
  assert.equal(seen.length, 2);
});

test('loopwatch: the culprit hook is read at report time, so it names what was running', () => {
  const t = fakeTimers();
  const seen: string[] = [];
  let doing: string | undefined;
  startLoopWatch({ emit: (v) => seen.push(v.text), sampleMs: 500, culprit: () => doing, now: t.now, schedule: t.schedule });
  doing = 'the camera warms up (headless Chrome + viewer page)';
  t.fire(8_000);
  assert.match(seen[0]!, /while the camera warms up \(headless Chrome \+ viewer page\)/);
});

test('loopwatch: worst() survives a quiet spell — a stall nobody watched still counts', () => {
  const t = fakeTimers();
  const w = startLoopWatch({ emit: () => {}, sampleMs: 500, now: t.now, schedule: t.schedule });
  t.fire(3_000);
  t.fire(500);
  t.fire(500);
  assert.equal(w.worst()?.lagMs, 2_500);
});

// The other half of #18: the camera must not outrank the connection.
import { nicenChrome } from '../src/tools/vision.js';

test('nicenChrome: renices the browser so the keep-alive outranks the picture', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const ok = await nicenChrome({ process: () => ({ pid: 4242 }) }, async (cmd, args) => { calls.push({ cmd, args }); });
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ cmd: 'renice', args: ['-n', '10', '-p', '4242'] }]);
});

test('nicenChrome: a platform without renice is a nuisance, not a crash', async () => {
  const ok = await nicenChrome({ process: () => ({ pid: 7 }) }, async () => { throw new Error('spawn renice ENOENT'); });
  assert.equal(ok, false, 'swallowed: a greedy camera beats a crashed bot');
});

test('nicenChrome: no browser process, nothing to renice', async () => {
  assert.equal(await nicenChrome({ process: () => null }, async () => { throw new Error('must not run'); }), false);
});

test('a lag line carries the heap, and blames GC when the heap is nearly full', () => {
  const MB = 1024 ** 2;
  // The real numbers from the OOM: a 4,338ms stall at 4,050MB of a 4,144MB cap.
  const fatal = classifyLag(4_338, { heapUsedBytes: 4_050 * MB, heapCapMb: 4_144, culprit: 'four workers run reflex ticks' });
  // 4.3s is below the keep-alive risk line, so this reported as a mere 'notice'
  // — the heap is the only part of that line that was ever going to save us.
  assert.equal(fatal.level, 'notice');
  assert.match(fatal.text, /heap 4050MB of 4144MB cap/);
  assert.match(fatal.text, /most likely a stop-the-world GC rather than load/);
  // The same stall on a healthy heap keeps the original accusation and adds no story.
  const busy = classifyLag(4_338, { heapUsedBytes: 300 * MB, heapCapMb: 4_144 });
  assert.match(busy.text, /heap 300MB of 4144MB cap$/);
  assert.doesNotMatch(busy.text, /stop-the-world/);
  // A notice-level lag reports the heap too — that is where a slow leak shows up.
  assert.match(classifyLag(1_500, { heapUsedBytes: 900 * MB, heapCapMb: 4_144 }).text, /lag 1\.5s.*heap 900MB/);
  // No heap reading available: the line is exactly what it was before.
  assert.doesNotMatch(classifyLag(1_500).text, /heap/);
});

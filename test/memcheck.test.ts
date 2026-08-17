/**
 * Memory preflight (issue #13): the heap-cap-below-container-limit reasoning
 * only holds while the container limit is below memory that exists. These
 * replay the real numbers from the machine that found it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryVerdict, readContainerLimit, readHeapCapMb, HeapFloor, formatFullTable } from '../src/memcheck.js';

const GB = 1024 ** 3;

test('a mem_limit larger than the VM is called fiction, with the fix', () => {
  // The reported machine: bot capped at 3GiB inside a 3.813GiB colima VM,
  // sharing it with a 2G server JVM.
  // `docker stats` read: strands-bot 609.1MiB / 3GiB, mhs_victim 1.194GiB /
  // 3.813GiB — so ~2.6GiB was ever reachable, less than its own 3GiB cap.
  const v = memoryVerdict({
    containerLimitBytes: 3 * GB,
    totalBytes: 3.813 * GB,
    availableBytes: 2.6 * GB,
    heapCapMb: 2048,
  });
  assert.equal(v.level, 'warn');
  assert.match(v.text, /fiction/);
  assert.match(v.text, /limit 3\.00GiB but only 2\.60GiB is actually available/);
  assert.match(v.text, /≥6GB for server\+bot, ≥8GB with fleet workers/);
});

test('a heap cap that is not BELOW the container limit defeats the whole design', () => {
  const v = memoryVerdict({ containerLimitBytes: 2 * GB, totalBytes: 16 * GB, heapCapMb: 2048 });
  assert.equal(v.level, 'warn');
  assert.match(v.text, /heap cap 2048MB is not below the container limit/);
  assert.match(v.text, /⅔ of mem_limit/);
});

test('a real but tight limit is a note, not a warning', () => {
  // Reachable right now (nothing else running), but nothing left for the JVM.
  const v = memoryVerdict({ containerLimitBytes: 3 * GB, totalBytes: 4 * GB, availableBytes: 3.5 * GB, heapCapMb: 2048 });
  assert.equal(v.level, 'note');
  assert.match(v.text, /memory is tight/);
  assert.match(v.text, /grow the VM before hiring a fleet/);
});

test('the intended shipping shape is silent', () => {
  // 3g limit inside a 8GB VM, heap 2048 — what the README asks for.
  const v = memoryVerdict({ containerLimitBytes: 3 * GB, totalBytes: 8 * GB, availableBytes: 6 * GB, heapCapMb: 2048 });
  assert.equal(v.level, 'ok');
  assert.match(v.text, /memory ok: limit 3\.00GiB of 8\.00GiB total, heap cap 2048MB/);
});

test('bare metal: no container limit, but an oversized heap cap still warns', () => {
  const bare = memoryVerdict({ totalBytes: 16 * GB, heapCapMb: 2048 });
  assert.equal(bare.level, 'ok');
  assert.match(bare.text, /no container limit/);
  const silly = memoryVerdict({ totalBytes: 4 * GB, heapCapMb: 8192 });
  assert.equal(silly.level, 'warn');
  assert.match(silly.text, /nearly all of the machine/);
});

test('readContainerLimit: cgroup v2, then v1, and both flavours of unlimited', () => {
  const v2 = readContainerLimit((p) => {
    if (p === '/sys/fs/cgroup/memory.max') return '3221225472\n';
    throw new Error('nope');
  });
  assert.equal(v2, 3 * GB);

  const v1 = readContainerLimit((p) => {
    if (p === '/sys/fs/cgroup/memory.max') throw new Error('no v2 here');
    return '2147483648\n';
  });
  assert.equal(v1, 2 * GB);

  // 'max' (v2) and the near-2^63 sentinel (v1) both mean unlimited
  assert.equal(readContainerLimit(() => 'max\n'), undefined);
  assert.equal(readContainerLimit((p) => (p.includes('memory.max') ? (() => { throw new Error('x'); })() : '9223372036854771712')), undefined);
  // not containerized at all: every read throws
  assert.equal(readContainerLimit(() => { throw new Error('ENOENT'); }), undefined);
});

test('readHeapCapMb: NODE_OPTIONS or the live process flags, either syntax', () => {
  assert.equal(readHeapCapMb('--max-old-space-size=2048', []), 2048);
  assert.equal(readHeapCapMb('--enable-source-maps --max-old-space-size 1536', []), 1536);
  assert.equal(readHeapCapMb('', ['--max-old-space-size=768']), 768);
  assert.equal(readHeapCapMb('', []), undefined);
});

test('a limit that fits the total but not what is FREE is still fiction', () => {
  // The subtle shape: 2GiB cap in a 16GiB machine looks fine — until three
  // sibling containers already hold 15GiB of it.
  const v = memoryVerdict({ containerLimitBytes: 2 * GB, totalBytes: 16 * GB, availableBytes: 1 * GB, heapCapMb: 1024 });
  assert.equal(v.level, 'warn');
  assert.match(v.text, /only 1\.00GiB is actually available \(of 16\.00GiB total\)/);
});

/* ── the growth probe (issue #44) ─────────────────────────────────────────── */

import { MemoryProbe, formatSample, growthPerHour, minutesToCap, countHandles, countGameSockets, activeHandles } from '../src/memcheck.js';

const MB = 1024 ** 2;
const usage = (heapMb: number, rssMb = heapMb + 100) =>
  ({ heapUsed: heapMb * MB, rss: rssMb * MB, heapTotal: 0, external: 0, arrayBuffers: 0 });

test('the rate is measured over the whole run, and projects the real crash', () => {
  // The numbers from the death: ~4050MB reached in 51 minutes.
  const perHour = growthPerHour(4050 * MB, 51 * 60_000);
  assert.equal(Math.round(perHour / MB), 4765);
  // From 1GB used at that rate, the 4096MB cap is ~38 minutes away.
  assert.equal(Math.round(minutesToCap(1024 * MB, perHour, 4096)!), 39);
  // A flat curve has no ETA at all — that is what a plateau looks like.
  assert.equal(minutesToCap(1024 * MB, 0, 4096), undefined);
  // No cap set: nothing to project against (the local run, before the fix).
  assert.equal(minutesToCap(1024 * MB, perHour, undefined), undefined);
  // Already past the cap: zero, not a negative time.
  assert.equal(minutesToCap(5000 * MB, perHour, 4096), 0);
  assert.equal(growthPerHour(100 * MB, 0), 0);
});

test('a sample measures growth from boot, per collection, by name', () => {
  const probe = new MemoryProbe();
  let entities = 10, notes = 3;
  probe.track('radar.entities', () => entities);
  probe.track('notes.queue', () => notes);
  assert.deepEqual(probe.tracked, ['radar.entities', 'notes.queue']);

  const first = probe.sample(1_000, usage(100));
  assert.equal(first.upMs, 0);
  assert.equal(first.heapGrewBytes, 0);
  assert.deepEqual(first.collections.map((c) => c.grew), [0, 0]);

  entities = 4213; notes = 2;
  const later = probe.sample(1_000 + 21 * 60_000, usage(512));
  assert.equal(later.upMs, 21 * 60_000);
  assert.equal(later.heapGrewBytes, 412 * MB);
  assert.deepEqual(
    later.collections.map((c) => [c.name, c.size, c.grew]),
    [['radar.entities', 4213, 4203], ['notes.queue', 2, -1]],
  );
});

test('re-registering a name replaces it, so a reconnect cannot double-count', () => {
  const probe = new MemoryProbe();
  probe.track('fleet.workers', () => 1);
  probe.track('fleet.workers', () => 7);
  assert.deepEqual(probe.tracked, ['fleet.workers']);
  assert.equal(probe.sample(0, usage(10)).collections[0].size, 7);
});

test('a probe that throws mid-teardown reads 0 instead of killing the sampler', () => {
  const probe = new MemoryProbe();
  probe.track('web.says', () => { throw new Error('rail is gone'); });
  probe.track('notes.queue', () => 5);
  const s = probe.sample(0, usage(10));
  assert.deepEqual(s.collections.map((c) => c.size), [0, 5]);
});

test('the line names the growing collection and the projection', () => {
  const probe = new MemoryProbe();
  let entities = 13, notes = 2, flat = 4;
  probe.track('radar.entities', () => entities);
  probe.track('notes.queue', () => notes);
  probe.track('journeys.live', () => flat);
  probe.sample(0, usage(100));
  entities = 4213; notes = 3;
  const line = formatSample(probe.sample(21 * 60_000, usage(512)), 4096);
  assert.match(line, /^mem rss 612MiB · heap 512MiB \+412MiB in 21m \(\+1177MiB\/h → cap in 183m\)/);
  // growth order, and the flat one is absent: a flat row hides the steep one
  assert.match(line, /radar\.entities 4213 \+4200 · notes\.queue 3 \+1/);
  assert.doesNotMatch(line, /journeys\.live/);
});

test('under a minute there is no rate yet, and a flat run says so out loud', () => {
  const probe = new MemoryProbe();
  probe.track('notes.queue', () => 2);
  probe.sample(0, usage(100));
  const early = formatSample(probe.sample(20_000, usage(140)), 4096);
  assert.equal(early, 'mem rss 240MiB · heap 140MiB · no tracked collection grew');
});

test('a cap crossing is announced once, by name', () => {
  const probe = new MemoryProbe();
  let says = 5;
  probe.track('web.says', () => says, 50);
  probe.sample(0, usage(100));
  assert.deepEqual(probe.newOverflows(probe.sample(1_000, usage(100))), []);
  says = 61;
  const first = probe.newOverflows(probe.sample(2_000, usage(100)));
  assert.equal(first.length, 1);
  assert.match(first[0], /web\.says is over its cap: 61 > 50/);
  says = 900;
  assert.deepEqual(probe.newOverflows(probe.sample(3_000, usage(100))), []);
  // and it stays visible in the line while it is over
  assert.match(formatSample(probe.sample(4_000, usage(100)), 4096), /web\.says 900 \+895 OVER CAP 50/);
});

test('the census counts what the collector did NOT take, and prunes itself', async () => {
  const { ObjectCensus } = await import('../src/memcheck.js');
  const c = new ObjectCensus();
  const kept: object[] = [];
  for (let i = 0; i < 3; i++) { const o = { i }; kept.push(o); c.watch('bots', o); }
  c.watch('bots', { throwaway: true });
  assert.equal(c.created('bots'), 4);
  // Everything still referenced counts; nothing is claimed to be dead early.
  assert.ok(c.alive('bots') >= 3);
  assert.deepEqual(c.kinds(), ['bots']);
  assert.equal(c.alive('agents'), 0);
  assert.equal(c.created('agents'), 0);
  if (global.gc) {
    global.gc();
    // the unreferenced one is gone, the three we hold are not
    assert.equal(c.alive('bots'), 3);
    assert.equal(c.created('bots'), 4); // created never shrinks — that's the point
  }
});

test('the boot line names every watched collection and where it starts', () => {
  const probe = new MemoryProbe();
  probe.track('world.columns', () => 441);
  probe.track('web.feed', () => 0);
  const line = probe.baselineLine(probe.sample(0, usage(100)), 4096);
  // A zero must be VISIBLE at boot: that is how a wrong accessor is caught.
  assert.match(line, /watching 2 collections \(heap cap 4096MB, rss 200MiB, heap 100MiB\): world\.columns=441 web\.feed=0/);
});

test('the floor ignores the sawtooth and only two complete windows count', () => {
  const MB = 1024 ** 2;
  const W = 300_000;
  const floor = new HeapFloor(W);
  // Window 0: heap saws 500 → 900 → 520MB. The FLOOR is 500.
  floor.add(0, 500 * MB); floor.add(60_000, 900 * MB); floor.add(120_000, 520 * MB);
  // Only one complete window exists while we are still inside window 1.
  assert.equal(floor.slope(W + 1_000), undefined);
  // Window 1 floors at 700MB, and we ask from inside window 2.
  floor.add(W + 10_000, 1_100 * MB); floor.add(W + 200_000, 700 * MB);
  const s = floor.slope(2 * W + 1_000)!;
  assert.equal(s.windows, 2);
  assert.equal(s.fromBytes, 500 * MB);
  assert.equal(s.toBytes, 700 * MB);
  // +200MB across one 5-minute window = +2400MB/h, regardless of the 1,100MB peak.
  assert.equal(Math.round(s.perHour / MB), 2_400);
});

test('a heap that returns to the same floor is not a leak, however high it peaks', () => {
  const MB = 1024 ** 2;
  const floor = new HeapFloor(300_000);
  for (let w = 0; w < 4; w++) {
    floor.add(w * 300_000 + 1_000, 3_000 * MB); // a scary peak every window
    floor.add(w * 300_000 + 200_000, 400 * MB); // and the same floor after GC
  }
  const s = floor.slope(4 * 300_000)!;
  assert.equal(s.perHour, 0);
  const line = formatSample({ atMs: 0, rssBytes: 3_100 * MB, heapUsedBytes: 3_000 * MB, upMs: 20 * 60_000, heapGrewBytes: 2_600 * MB, collections: [], floor: s }, 4_144);
  // The ceiling reading screams; the floor line is what a human should believe.
  assert.match(line, /floor 400MiB→400MiB→400MiB→400MiB over 15m \(\+0MiB\/h warm — flat after GC, no leak\)/);
  assert.doesNotMatch(line, /cap in/); // no ETA: the floor is not moving
});

test('the full table lists every collection, high-and-flat ones included', () => {
  const probe = new MemoryProbe();
  probe.track('fleet.workers', () => 24, 50);
  probe.track('world.columns', () => 3_100, 2_000);
  const line = formatFullTable(probe.sample(0, usage(100)));
  assert.match(line, /fleet\.workers=24 world\.columns=3100\(OVER 2000\)/);
});

test('boot is not a leak: the warm slope drops the first window (live #44 numbers)', () => {
  const MB = 1024 ** 2;
  const floor = new HeapFloor(300_000);
  // Exactly what the acceptance soak printed: a cold first window, then a heap
  // that returns to the same place every time. The boot-anchored slope called
  // this +216MiB/h and predicted a cap; the warm windows are flat.
  const mins = [90, 125, 126, 126];
  mins.forEach((mb, w) => {
    floor.add(w * 300_000 + 1_000, (mb + 60) * MB);
    floor.add(w * 300_000 + 200_000, mb * MB);
  });
  const s = floor.slope(4 * 300_000)!;
  assert.deepEqual(s.floors.map((b) => Math.round(b / MB)), mins);
  assert.ok(s.perHour > 140 * MB, `the boot-anchored slope is the alarming one, got ${s.perHour / MB}MiB/h`);
  assert.ok(Math.abs(s.warmPerHour!) < 7 * MB, `warm slope should be ~flat, got ${s.warmPerHour! / MB}MiB/h`);
  const line = formatSample({ atMs: 0, rssBytes: 400 * MB, heapUsedBytes: 150 * MB, upMs: 20 * 60_000, heapGrewBytes: 60 * MB, collections: [], floor: s }, 4_144);
  assert.match(line, /floor 90MiB→125MiB→126MiB→126MiB/, 'show the curve, not two endpoints');
  assert.match(line, /warm/);
  assert.doesNotMatch(line, /cap in/, 'a flat warm floor must not predict a cap');
});

test('two windows only: no warm slope to report yet, and the raw one still prints', () => {
  const MB = 1024 ** 2;
  const floor = new HeapFloor(300_000);
  floor.add(1_000, 90 * MB);
  floor.add(300_000 + 1_000, 125 * MB);
  const s = floor.slope(2 * 300_000)!;
  assert.equal(s.warmPerHour, undefined);
  const line = formatSample({ atMs: 0, rssBytes: 400 * MB, heapUsedBytes: 150 * MB, upMs: 10 * 60_000, heapGrewBytes: 60 * MB, collections: [], floor: s }, 4_144);
  assert.match(line, /floor 90MiB→125MiB over 5m \(\+420MiB\/h/);
  assert.doesNotMatch(line, /warm/);
});

test('an ETA is only printed when someone could act on it', () => {
  const MB = 1024 ** 2;
  const floor = new HeapFloor(300_000);
  // 1MiB per window of jitter draws a line that hits 4GB in ~28 days.
  [100, 101, 102, 103].forEach((mb, w) => floor.add(w * 300_000 + 1_000, mb * MB));
  const noise = formatSample({ atMs: 0, rssBytes: 400 * MB, heapUsedBytes: 150 * MB, upMs: 20 * 60_000, heapGrewBytes: 3 * MB, collections: [], floor: floor.slope(4 * 300_000)! }, 4_144);
  assert.doesNotMatch(noise, /cap in/);
  assert.match(noise, /flat after GC, no leak/, 'noise reads as flat, not as a slow leak');

  const real = new HeapFloor(300_000);
  // The shape that actually killed the process: ~+800MiB/h on the floor.
  [400, 466, 533, 600].forEach((mb, w) => real.add(w * 300_000 + 1_000, mb * MB));
  const line = formatSample({ atMs: 0, rssBytes: 900 * MB, heapUsedBytes: 600 * MB, upMs: 20 * 60_000, heapGrewBytes: 200 * MB, collections: [], floor: real.slope(4 * 300_000)! }, 4_144);
  assert.match(line, /cap in \d+m/, 'a real leak keeps its deadline');
  assert.doesNotMatch(line, /no leak/);
});

test('open handles are counted apart from timers — a socket is a GC root our walk cannot see', () => {
  // The real strings Node hands back, mixed as a live bot process reports them:
  // the listening dashboard, four worker connections, the Bedrock TLS socket,
  // stdin, and the reflex/keep-alive timers.
  const live = [
    'TCPSERVERWRAP', 'TCPWRAP', 'TCPWRAP', 'TCPWRAP', 'TCPWRAP',
    'TLSWRAP', 'PipeWrap', 'Timeout', 'Timeout', 'Immediate', 'FSReqCallback',
  ];
  const h = countHandles(live);
  assert.equal(h.sockets, 6, 'four worker connections + the TLS call + the pipe');
  assert.equal(h.timers, 3);
  assert.equal(h.total, live.length, 'total stays the raw truth, unclassified included');
  // The listening server must never be mistaken for a leaked connection, or
  // every process reads as one socket over its true count forever.
  assert.equal(countHandles(['TCPSERVERWRAP']).sockets, 0);
  assert.deepEqual(countHandles([]), { sockets: 0, timers: 0, total: 0 });
});

test('the process really answers this call (the probe is not measuring nothing)', () => {
  const h = countHandles(process.getActiveResourcesInfo());
  assert.equal(typeof h.sockets, 'number');
  assert.ok(h.total > 0, 'a running node process always holds something open');
});

test('game connections are counted apart from Bedrock TLS and the dashboard', () => {
  // The mix a live stress soak holds: one primary + two worker connections to
  // 25565, three Bedrock TLS sockets on 443, a dashboard client on 3008, and
  // a timer (no remotePort at all).
  const handles = [
    { remotePort: 25565 }, { remotePort: 25565 }, { remotePort: 25565 },
    { remotePort: 443 }, { remotePort: 443 }, { remotePort: 443 },
    { remotePort: 3008 }, {}, { _idleTimeout: 300 },
  ];
  assert.equal(countGameSockets(handles, 25565), 3, 'only the game port counts');
  assert.equal(countGameSockets(handles, 25566), 0, 'a different world, no false positives');
  // A socket already destroyed no longer roots anything — counting it would
  // report a leak during every normal retire.
  assert.equal(countGameSockets([{ remotePort: 25565, destroyed: true }], 25565), 0);
  assert.equal(countGameSockets([], 25565), 0);
  // Hostile shapes must not throw inside a probe that runs every minute.
  assert.equal(countGameSockets([null, undefined, 7, 'x', { remotePort: '25565' }], 25565), 0);
});

test('the undocumented handle list is really there (or the probe says so)', () => {
  const h = activeHandles();
  assert.ok(h === undefined || Array.isArray(h), 'either a list or an honest undefined');
  assert.ok(Array.isArray(h), 'node 22 has _getActiveHandles — if this fails the probe reports -1, not 0');
});

/**
 * 👷 Workers as bodies — THE CONTRACT (CREW.md, lane B).
 *
 *   GET  /api/workers                      {ok, bot, workers:[row…]}
 *   GET  /api/workers/:id/telemetry        shapeTelemetry of that worker's bot (+ worker row)
 *   GET  /api/workers/:id/camera/snapshot  JPEG, X-Camera live|warming|broken, never 404 while alive
 *   GET  /api/workers/:id/stream.mjpeg     MJPEG (?token= from an <img>)
 *   POST /api/workers/:id/stop             reflex stop, {ok, stopped}
 *   POST /api/workers {goal,name?} · DELETE /api/workers/:id
 *   telemetry.crew rows gain id+goal · SSE worker events gain workerId · health.workers
 *
 * Pure pieces first (ids, state, row, route matcher, hire body), then the live
 * server against a FAKE crew rail — no Minecraft, no Chrome. The camera routes
 * are exercised up to the honest placeholder (a worker whose body is a stub
 * has no viewer; the contract says that is `X-Camera: broken: …`, not a 404).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';

process.env.WEB_PORT = '0';
process.env.TINY_TOKEN = 'c'.repeat(40);
process.env.WEB_AUTH_STORE = join(mkdtempSync(join(tmpdir(), 'sm-crew-')), 'web_auth.json');
process.env.CAMERA_DISABLED = 'true'; // the camera must fail HONESTLY — never a viewer server, never Chrome
process.env.VIEWER_PORT = '0';
delete process.env.WEB_AUTH_DISABLED;

const crew = await import('../src/web/crew.js');
const { startWeb } = await import('../src/web.js');
type Worker = import('../src/fleet.js').Worker;

const TOKEN = process.env.TINY_TOKEN!;
const NOW = 1_800_000_000_000;

// ── pure: ids ────────────────────────────────────────────────────────────────

test('workerId / isWorkerId / nextWorkerCounter: stable, URL-safe, never re-used after a restart', () => {
  assert.equal(crew.workerId(1), 'w-1');
  assert.equal(crew.workerId(7.9), 'w-7');
  assert.equal(crew.workerId(0), 'w-1', 'never w-0');
  assert.equal(crew.isWorkerId('w-12'), true);
  assert.equal(crew.isWorkerId('Chopper_2'), true, 'a fleet id of its own shape is fine');
  assert.equal(crew.isWorkerId('../etc'), false);
  assert.equal(crew.isWorkerId(''), false);
  assert.equal(crew.isWorkerId(3), false);
  assert.equal(crew.nextWorkerCounter([]), 1);
  assert.equal(crew.nextWorkerCounter(['w-3', undefined, 'w-11', 'legacy']), 12, 'one past the highest ever assigned');
});

// ── pure: state + row ────────────────────────────────────────────────────────

const w = (over: Partial<Worker> = {}): Worker => ({
  id: 'w-1', name: 'Chopper', task: 'fell 6 oak logs', status: 'working', steps: 3,
  startedAt: NOW - 90_000, progressAt: NOW - 5_000, journal: ['walked to the oak', 'chopped 2'], inbox: [], ...over,
});

test('workerState: connecting→idle, fresh working→working, silent working→stalled, terminal→dead', () => {
  assert.equal(crew.workerState(w({ status: 'connecting' }), NOW), 'idle');
  assert.equal(crew.workerState(w(), NOW), 'working');
  assert.equal(crew.workerState(w({ progressAt: NOW - crew.STALL_MS - 1 }), NOW), 'stalled');
  assert.equal(crew.workerState(w({ progressAt: undefined, startedAt: NOW - crew.STALL_MS - 1 }), NOW), 'stalled', 'no step ever: measured from the hire');
  for (const status of ['done', 'failed', 'dismissed', 'interrupted'] as const) assert.equal(crew.workerState(w({ status }), NOW), 'dead', status);
});

test('workerRow: the contract shape, read off the body; a body-less worker nulls its readings', () => {
  const body = { bot: { entity: { position: new Vec3(10.26, 64, -3.74) }, health: 17.3, food: 9 }, epoch: () => 1 } as unknown as Worker['body'];
  const cam = { ok: true, why: 'idle' };
  const row = crew.workerRow(w({ body }), cam, NOW);
  assert.deepEqual(row, {
    id: 'w-1', name: 'Chopper', goal: 'fell 6 oak logs', state: 'working', alive: true,
    pos: { x: 10.3, y: 64, z: -3.7 }, health: 17.3, food: 9, since_s: 90, steps: 3, camera: cam,
    status: 'working', last: 'chopped 2',
  });
  const dead = crew.workerRow(w({ status: 'done', result: 'got 6 logs', endedAt: NOW }), { ok: false, why: 'gone' }, NOW);
  assert.equal(dead.state, 'dead');
  assert.equal(dead.alive, false);
  assert.equal(dead.pos, null);
  assert.equal(dead.health, null);
  assert.equal(dead.last, 'got 6 logs', 'the result beats the last journal line');
  assert.equal(crew.workerRow(w({ status: 'connecting' }), cam, NOW).pos, null, 'mid-connect has no entity');
});

test('workersHealth: alive = connecting + working; max is the advisory knob', () => {
  const list = [w(), w({ status: 'connecting' }), w({ status: 'done' }), w({ status: 'failed' })];
  assert.deepEqual(crew.workersHealth(list, 6), { alive: 2, max: 6 });
  assert.deepEqual(crew.workersHealth([], 3), { alive: 0, max: 3 });
});

test('describeWorkerCamera: every case in one sentence, near-field honesty included', () => {
  const base = { alive: true, frames: 0, watchers: 0, now: NOW };
  assert.match(crew.describeWorkerCamera({ ...base, alive: false }).why, /left the world/);
  assert.equal(crew.describeWorkerCamera({ ...base, alive: false }).ok, false);
  assert.match(crew.describeWorkerCamera({ ...base, error: 'Session closed' }).why, /^broken: Session closed/);
  assert.match(crew.describeWorkerCamera({ ...base, warmingSince: NOW - 4_000 }).why, /warming up \(4s\)/);
  assert.match(crew.describeWorkerCamera(base).why, /never started.*viewDistance 3/);
  assert.match(crew.describeWorkerCamera({ ...base, frames: 12 }).why, /idle \(no watchers; 12 frames/);
  assert.match(crew.describeWorkerCamera({ ...base, watchers: 1 }).why, /NO frames yet/);
  assert.match(crew.describeWorkerCamera({ ...base, watchers: 2, frames: 40 }).why, /streaming to 2 watcher\(s\), 40 frames/);
});

test('allocateViewerPort: VIEWER_PORT+1+n, skipping the dashboard port and held ports', () => {
  // The common install: VIEWER_PORT 3007, WEB_PORT 3008 — the first worker must NOT land on the dashboard.
  assert.equal(crew.allocateViewerPort(3007, [], [3007, 3008]), 3009);
  assert.equal(crew.allocateViewerPort(3007, [3009], [3007, 3008]), 3010);
  assert.equal(crew.allocateViewerPort(3007, [3009, 3010, 3011], [3008]), 3012);
  assert.equal(crew.allocateViewerPort(3107, [], [3108]), 3109, 'Nova-style second instance');
});

// ── pure: route matcher + hire body ──────────────────────────────────────────

test('matchWorkerRoute: the whole family, nothing else', () => {
  assert.deepEqual(crew.matchWorkerRoute('GET', '/api/workers'), { kind: 'list' });
  assert.deepEqual(crew.matchWorkerRoute('GET', '/api/workers/'), { kind: 'list' });
  assert.deepEqual(crew.matchWorkerRoute('POST', '/api/workers'), { kind: 'hire' });
  assert.deepEqual(crew.matchWorkerRoute('DELETE', '/api/workers/w-2'), { kind: 'retire', id: 'w-2' });
  assert.deepEqual(crew.matchWorkerRoute('GET', '/api/workers/w-2/telemetry'), { kind: 'telemetry', id: 'w-2' });
  assert.deepEqual(crew.matchWorkerRoute('GET', '/api/workers/w-2/camera/snapshot'), { kind: 'snapshot', id: 'w-2' });
  assert.deepEqual(crew.matchWorkerRoute('GET', '/api/workers/w-2/stream.mjpeg'), { kind: 'stream', id: 'w-2' });
  assert.deepEqual(crew.matchWorkerRoute('POST', '/api/workers/w-2/stop'), { kind: 'stop', id: 'w-2' });
  assert.equal(crew.matchWorkerRoute('GET', '/api/workers/w-2'), null, 'no bare GET of one worker (the list carries the row)');
  assert.equal(crew.matchWorkerRoute('GET', '/api/workers/w-2/stop'), null, 'stop is a write');
  assert.equal(crew.matchWorkerRoute('POST', '/api/workers/w-2/telemetry'), null);
  assert.equal(crew.matchWorkerRoute('GET', '/api/workers/..%2F..%2Fetc/telemetry'), null, 'ids are URL-safe or nothing');
  assert.equal(crew.matchWorkerRoute('GET', '/api/telemetry'), null);
  assert.equal(crew.matchWorkerRoute('GET', '/api/workersx'), null);
});

test('hireRequest: goal (or task) required, bounded; name sanitised like fleet.hire', () => {
  assert.deepEqual(crew.hireRequest({ goal: '  fell 6 logs ' }), { goal: 'fell 6 logs' });
  assert.deepEqual(crew.hireRequest({ task: 'dig a pit', name: ' Dig-ger! ' }), { goal: 'dig a pit', name: 'Digger' });
  assert.deepEqual(crew.hireRequest({}), { error: 'goal required' });
  assert.deepEqual(crew.hireRequest(null), { error: 'goal required' });
  assert.deepEqual(crew.hireRequest({ goal: 'x', name: '!!!' }), { error: 'name must be letters/digits/underscore' });
  assert.equal((crew.hireRequest({ goal: 'g'.repeat(5_000) }) as { goal: string }).goal.length, 1_000);
});

test('headerSafe: a camera reason with an em dash or emoji becomes a legal header value', () => {
  assert.equal(crew.headerSafe('broken: worker dismissed — no body'), 'broken: worker dismissed - no body');
  assert.equal(crew.headerSafe('live'), 'live');
  assert.equal(crew.headerSafe('🛑 stop'), '-- stop');
});

test('defaultWorkerName: Crew<n>, skipping names already on the roster (case-insensitive)', () => {
  assert.equal(crew.defaultWorkerName(1, []), 'Crew1');
  assert.equal(crew.defaultWorkerName(2, ['crew2', 'Crew3']), 'Crew4');
});

// ── the live server against a fake crew rail ─────────────────────────────────

function fakeBot(username = 'StrandsBot', inWorld = true) {
  const bot = new EventEmitter() as any;
  bot.username = username;
  bot.health = 20;
  bot.food = 20;
  bot.oxygenLevel = 20;
  bot.game = { dimension: 'overworld', gameMode: 'survival' };
  bot.inventory = { items: () => [{ name: 'oak_log', count: 4 }] };
  bot.heldItem = { name: 'stone_axe', count: 1 };
  bot.player = inWorld ? { username } : undefined;
  bot.entity = inWorld ? { position: new Vec3(12.2, 70, -4.6), yaw: 0, pitch: 0 } : undefined;
  bot.entities = inWorld ? { 1: bot.entity } : {};
  bot.time = { age: 0, timeOfDay: 1000, isDay: true };
  bot.blockAt = () => ({ biome: { name: 'plains' } });
  bot.pathfinder = { stop: () => bot.calls.push('pathfinder.stop'), setGoal: () => bot.calls.push('setGoal') };
  bot.clearControlStates = () => bot.calls.push('clearControlStates');
  bot.calls = [] as string[];
  return bot;
}

function fakeCrew() {
  const workers = new Map<string, Worker>();
  let n = 0;
  const released: Array<(w: Worker) => void> = [];
  const log: string[] = [];
  const rail = {
    list: () => [...workers.values()],
    byId: (id: string) => [...workers.values()].find((x) => x.id === id),
    hire: (goal: string, name?: string) => {
      const clean = name ?? `Crew${n + 1}`;
      if ([...workers.values()].some((x) => x.name === clean && (x.status === 'working' || x.status === 'connecting'))) throw new Error(`Worker ${clean} is already working`);
      const bot = fakeBot(clean);
      const worker: Worker = {
        id: `w-${++n}`, name: clean, task: goal, status: 'working', steps: 0, startedAt: Date.now(), progressAt: Date.now(),
        journal: [], inbox: [], body: { bot, epoch: () => 0, onEachBot: () => {}, retire: () => {} } as unknown as Worker['body'],
      };
      workers.set(clean, worker);
      log.push(`hire ${clean}`);
      return worker;
    },
    retire: (id: string) => {
      const x = rail.byId(id);
      if (!x) return false;
      if (x.status === 'working') { x.status = 'dismissed'; x.endedAt = Date.now(); x.result = 'dismissed'; for (const f of released) f(x); x.body = undefined; }
      log.push(`retire ${x.name}`);
      return true;
    },
    stop: (id: string) => {
      const x = rail.byId(id);
      if (!x) return undefined;
      if (!x.body) return [];
      const b = x.body.bot as any;
      b.pathfinder.stop(); b.pathfinder.setGoal(null); b.clearControlStates();
      return ['pathfinder', 'controls'];
    },
    max: 6,
    onReleased: (fn: (w: Worker) => void) => { released.push(fn); },
  };
  return { rail, workers, log };
}

test('crew routes end to end: list · hire · telemetry · stop · snapshot · stream · retire · health · SSE workerId · telemetry.crew', async (t) => {
  const bot = fakeBot();
  const { rail: crewRail, log } = fakeCrew();
  const rail = startWeb(
    bot,
    async () => ({ answer: 'ok' }),
    () => ({ workers: [] }),
    undefined,
    { busy: () => 0 },
    {
      mc: () => ({ host: 'mc', port: 25565, version: '1.21', connected: true, epoch: 0 }),
      telemetry: () => ({
        crew: crewRail.list().map((x) => ({ id: x.id, name: x.name, job: x.task, goal: x.task, alive: x.status === 'working' })),
      }),
      stop: () => [],
      crew: crewRail,
    },
  );
  t.after(() => rail.close());
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${rail.port()}`;
  const remote = { 'x-forwarded-for': '203.0.113.7' };
  const bearer = { ...remote, Authorization: `Bearer ${TOKEN}` };
  const jsonOf = async (r: Response) => (await r.json()) as any;
  // The token bucket is 5 writes/s and this test writes ~9 times: let it refill
  // rather than asserting through a 429 (the limiter has its own test).
  const breathe = () => new Promise((r) => setTimeout(r, 450));

  // the family is gated like every tiny route
  for (const [m, p] of [['GET', '/api/workers'], ['POST', '/api/workers'], ['GET', '/api/workers/w-1/telemetry'], ['POST', '/api/workers/w-1/stop'], ['DELETE', '/api/workers/w-1']] as const) {
    const r = await fetch(`${base}${p}`, { method: m, headers: remote, ...(m === 'POST' ? { body: '{}' } : {}) });
    assert.equal(r.status, 401, `${m} ${p} without a credential`);
  }

  // health: workers additive, zero before any hire
  let h = await jsonOf(await fetch(`${base}/api/health`, { headers: remote }));
  assert.deepEqual(h.workers, { alive: 0, max: 6 });

  // empty list
  let list = await jsonOf(await fetch(`${base}/api/workers`, { headers: bearer }));
  assert.deepEqual(list, { ok: true, bot: 'StrandsBot', workers: [] });

  // hire: 400 without a goal, 201 with one, the row comes back
  assert.equal((await fetch(`${base}/api/workers`, { method: 'POST', headers: bearer, body: '{}' })).status, 400);
  const hired = await fetch(`${base}/api/workers`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'fell 6 oak logs', name: 'Chopper' }) });
  assert.equal(hired.status, 201);
  const hj = await jsonOf(hired);
  assert.equal(hj.ok, true);
  assert.equal(hj.worker.id, 'w-1');
  assert.equal(hj.worker.name, 'Chopper');
  assert.equal(hj.worker.goal, 'fell 6 oak logs');
  assert.equal(hj.worker.state, 'working');
  assert.equal(hj.worker.alive, true);
  assert.deepEqual(hj.worker.pos, { x: 12.2, y: 70, z: -4.6 });
  assert.equal(hj.worker.camera.ok, true);
  assert.match(hj.worker.camera.why, /never started/);
  // a duplicate live name is a 409 with the fleet's own sentence
  const dup = await fetch(`${base}/api/workers`, { method: 'POST', headers: bearer, body: JSON.stringify({ goal: 'again', name: 'Chopper' }) });
  assert.equal(dup.status, 409);
  assert.match((await jsonOf(dup)).error, /already working/);
  // a second hire with no name gets a default
  const h2 = await jsonOf(await fetch(`${base}/api/workers`, { method: 'POST', headers: bearer, body: JSON.stringify({ goal: 'dig a pit' }) }));
  assert.equal(h2.worker.id, 'w-2');
  assert.equal(h2.worker.name, 'Crew2');

  // list + health + telemetry.crew agree
  list = await jsonOf(await fetch(`${base}/api/workers`, { headers: bearer }));
  assert.deepEqual(list.workers.map((x: any) => x.id), ['w-1', 'w-2']);
  h = await jsonOf(await fetch(`${base}/api/health`, { headers: remote }));
  assert.deepEqual(h.workers, { alive: 2, max: 6 });
  const tele = await jsonOf(await fetch(`${base}/api/telemetry`, { headers: bearer }));
  assert.deepEqual(tele.crew[0], { id: 'w-1', name: 'Chopper', job: 'fell 6 oak logs', goal: 'fell 6 oak logs', alive: true }, 'crew rows keep name/job/alive and gain id/goal');

  // per-worker telemetry = shapeTelemetry of THAT body
  const wt = await fetch(`${base}/api/workers/w-1/telemetry`, { headers: bearer });
  assert.equal(wt.status, 200);
  const wtj = await jsonOf(wt);
  assert.equal(wtj.name, 'Chopper');
  assert.deepEqual(wtj.pos, { x: 12.2, y: 70, z: -4.6 });
  assert.deepEqual(wtj.inventory, [{ name: 'oak_log', count: 4 }]);
  assert.equal(wtj.held, 'stone_axe x1');
  assert.deepEqual(wtj.task, { kind: 'fleet', text: 'fell 6 oak logs', since_s: wtj.worker.since_s });
  assert.equal(wtj.worker.id, 'w-1');
  assert.equal((await fetch(`${base}/api/workers/w-9/telemetry`, { headers: bearer })).status, 404);

  // stop: reflex-level, names what it stopped, no model turn
  await breathe();
  const st = await fetch(`${base}/api/workers/w-1/stop`, { method: 'POST', headers: bearer });
  assert.equal(st.status, 200);
  const stj = await jsonOf(st);
  assert.deepEqual(stj.stopped, ['pathfinder', 'controls']);
  assert.equal(stj.id, 'w-1');
  const chopper = crewRail.byId('w-1')!;
  assert.deepEqual((chopper.body!.bot as any).calls, ['pathfinder.stop', 'setGoal', 'clearControlStates']);
  await breathe();
  assert.equal((await fetch(`${base}/api/workers/w-9/stop`, { method: 'POST', headers: bearer })).status, 404);

  // snapshot: never a 404 while alive — here Chrome is unreachable, so the
  // placeholder with an honest header is the right answer
  const snap = await fetch(`${base}/api/workers/w-1/camera/snapshot?token=${TOKEN}`, { headers: remote });
  assert.equal(snap.status, 200);
  assert.equal(snap.headers.get('content-type'), 'image/jpeg');
  assert.match(snap.headers.get('x-camera') ?? '', /^(warming|broken: )/);
  const bytes = new Uint8Array(await snap.arrayBuffer());
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8, 'a decodable JPEG, not an error body');

  // stream: headers + the warming pulse arrive even though no frame ever will
  const ac = new AbortController();
  const stream = await fetch(`${base}/api/workers/w-1/stream.mjpeg?token=${TOKEN}`, { headers: remote, signal: ac.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /multipart\/x-mixed-replace/);
  const reader = stream.body!.getReader();
  const first = await reader.read();
  assert.ok(first.value && first.value.length > 0, 'bytes flow during warm-up (placeholder pulse)');
  assert.match(Buffer.from(first.value!).toString('latin1'), /--frame/);
  ac.abort();
  await new Promise((r) => setTimeout(r, 50));
  list = await jsonOf(await fetch(`${base}/api/workers`, { headers: bearer }));
  const row1 = list.workers.find((x: any) => x.id === 'w-1');
  assert.equal(row1.camera.ok, false, 'a camera that could not open Chrome says so on the row');
  assert.match(row1.camera.why, /^broken: /);

  // SSE: worker events carry workerId
  rail.log('worker', 'Chopper #1', 'walked to the oak', undefined, { workerId: 'w-1' });
  const ev = await fetch(`${base}/api/events`, { headers: bearer, signal: AbortSignal.timeout(2_000) });
  const text = Buffer.from((await ev.body!.getReader().read()).value!).toString();
  const line = text.split('\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, ''))).find((e: any) => e.kind === 'worker');
  assert.equal(line.workerId, 'w-1');
  assert.equal(line.who, 'Chopper #1');

  // retire: the row flips to dead and stays addressable; the camera hook fired
  await breathe();
  const del = await fetch(`${base}/api/workers/w-2`, { method: 'DELETE', headers: bearer });
  assert.equal(del.status, 200);
  const dj = await jsonOf(del);
  assert.equal(dj.worker.state, 'dead');
  assert.equal(dj.worker.status, 'dismissed');
  assert.equal(dj.worker.alive, false);
  assert.deepEqual(log, ['hire Chopper', 'hire Crew2', 'retire Crew2']);
  h = await jsonOf(await fetch(`${base}/api/health`, { headers: remote }));
  assert.deepEqual(h.workers, { alive: 1, max: 6 });
  // a dead worker's snapshot is still 200 with an honest header; its stream is 410
  const deadSnap = await fetch(`${base}/api/workers/w-2/camera/snapshot`, { headers: bearer });
  assert.equal(deadSnap.status, 200, await deadSnap.clone().text());
  assert.match(deadSnap.headers.get('x-camera') ?? '', /^broken: worker dismissed/);
  assert.equal((await fetch(`${base}/api/workers/w-2/stream.mjpeg`, { headers: bearer })).status, 410);
  assert.equal((await fetch(`${base}/api/workers/w-9`, { method: 'DELETE', headers: bearer })).status, 404);

  // the memory probe sees the camera collections by name (MEMORY.md rule 3)
  const sizes = rail.sizes();
  assert.equal(typeof sizes['web.workerCams'], 'number');
  assert.equal(typeof sizes['web.workerWatchers'], 'number');
  assert.equal(typeof sizes['camera.workerPages'], 'number');
  assert.equal(sizes['web.workerWatchers'], 0, 'the aborted watcher was dropped');
});

test('crew routes without a fleet on the rail answer 503, not 404 (a stub rail is not a missing worker)', async (t) => {
  const rail = startWeb(fakeBot(), async () => ({ answer: 'ok' }), () => ({ workers: [] }), undefined, { busy: () => 0 }, {});
  t.after(() => rail.close());
  await new Promise((r) => setTimeout(r, 50));
  const r = await fetch(`http://127.0.0.1:${rail.port()}/api/workers`, { headers: { 'x-forwarded-for': '203.0.113.7', Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 503);
});

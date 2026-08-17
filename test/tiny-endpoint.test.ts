/**
 * 🔥 The tiny endpoint — token gate, rate limit, telemetry shape, chat/stop
 * routes. The bot is a device on tiny.technology: the relay POSTs /api/chat
 * {prompt} with a bearer, the phone reads /api/telemetry with the same bearer.
 * A remote caller with no credential must get 401 on EVERY tiny route; a
 * caller with the token must never be able to burn more than 5 turns/s.
 * Run: npm test (tsx --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';

// Module-load config: a free port, a real-length token, an isolated passkey
// store, and auth NOT disabled — a remote caller must hit the gate.
process.env.WEB_PORT = '0';
process.env.TINY_TOKEN = 't'.repeat(40);
process.env.WEB_AUTH_STORE = join(mkdtempSync(join(tmpdir(), 'sm-tiny-')), 'web_auth.json');
delete process.env.WEB_AUTH_DISABLED;

const tiny = await import('../src/web/tiny.js');
const { startWeb } = await import('../src/web.js');

const TOKEN = process.env.TINY_TOKEN!;

// ── pure pieces ──────────────────────────────────────────────────────────────

test('tinyToken: missing or short tokens are refused (fail closed)', () => {
  assert.equal(tiny.tinyToken({}), undefined);
  assert.equal(tiny.tinyToken({ TINY_TOKEN: 'short' }), undefined);
  assert.equal(tiny.tinyToken({ TINY_TOKEN: 'x'.repeat(32) }), 'x'.repeat(32));
  assert.match(tiny.tinyTokenProblem({}) ?? '', /not set/);
  assert.match(tiny.tinyTokenProblem({ TINY_TOKEN: 'abc' }) ?? '', /too short/);
});

test('presentedToken: bearer header wins, ?token= is the <img> fallback', () => {
  const u = new URL('http://x/api/stream.mjpeg?token=fromquery');
  assert.equal(tiny.presentedToken({ authorization: 'Bearer abc' }, u), 'abc');
  assert.equal(tiny.presentedToken({ authorization: 'bearer   abc  ' }, u), 'abc');
  assert.equal(tiny.presentedToken({}, u), 'fromquery');
  assert.equal(tiny.presentedToken({ authorization: 'Basic zzz' }, new URL('http://x/')), undefined);
});

test('tokenMatches: constant-time, never throws on unequal lengths, never matches undefined', () => {
  assert.equal(tiny.tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tiny.tokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.equal(tiny.tokenMatches('', TOKEN), false);
  assert.equal(tiny.tokenMatches(TOKEN, undefined), false);
  assert.equal(tiny.tokenMatches(undefined, undefined), false);
});

test('rate limiter: 5 per second per key, refills, prunes idle buckets', () => {
  const rl = tiny.createRateLimiter({ perSecond: 5 });
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(rl.take('k', t0), true, `take ${i}`);
  assert.equal(rl.take('k', t0), false, '6th in the same instant is refused');
  assert.equal(rl.take('other', t0), true, 'another token has its own bucket');
  assert.equal(rl.take('k', t0 + 200), true, '200 ms later one token refilled');
  assert.equal(rl.take('k', t0 + 200), false);
  assert.equal(rl.size(), 2);
  assert.equal(rl.prune(t0 + 61_000), 2, 'idle buckets are dropped — the map is bounded');
  assert.equal(rl.size(), 0);
});

test('chatWaitMs: default 20 s, clamp 0..40 s, garbage → default', () => {
  assert.equal(tiny.chatWaitMs(undefined), 20_000);
  assert.equal(tiny.chatWaitMs('abc'), 20_000);
  assert.equal(tiny.chatWaitMs(5), 5_000);
  assert.equal(tiny.chatWaitMs(400), 40_000);
  assert.equal(tiny.chatWaitMs(-3), 0);
});

test('chatPrompt: prompt (relay) beats text (SPA); trimmed and bounded', () => {
  assert.equal(tiny.chatPrompt({ prompt: ' cut a tree ' }), 'cut a tree');
  assert.equal(tiny.chatPrompt({ text: 'hi' }), 'hi');
  assert.equal(tiny.chatPrompt({ prompt: '', text: 'fallback' }), 'fallback');
  assert.equal(tiny.chatPrompt(null), '');
  assert.equal(tiny.chatPrompt({ prompt: 'x'.repeat(5_000) }).length, 2_000);
});

// ── a fake bot with just enough surface for telemetry + stop ─────────────────

function fakeBot(o: { inWorld?: boolean } = {}) {
  const inWorld = o.inWorld ?? true;
  const bot = new EventEmitter() as any;
  bot.username = 'StrandsBot';
  bot.health = 17.73;
  bot.food = 14;
  bot.oxygenLevel = 0;
  bot.experience = { level: 3 };
  bot.time = { age: 24_000 * 12 + 6_000, timeOfDay: 6_000, isDay: true };
  bot.isRaining = false;
  bot.thunderState = 0;
  bot.game = { dimension: 'overworld', gameMode: 'survival' };
  bot.heldItem = { name: 'wooden_axe', count: 1 };
  bot.inventory = { items: () => [{ name: 'mangrove_log', count: 5 }, { name: 'mangrove_log', count: 3 }, { name: 'stick', count: 4 }] };
  bot.player = inWorld ? { username: 'StrandsBot' } : undefined;
  bot.entity = inWorld ? { position: new Vec3(199.4999, 75, -92.3275), yaw: 1.5708, pitch: 0 } : undefined;
  bot.entities = inWorld ? {
    1: bot.entity,
    2: { type: 'player', username: 'CagatayCali', position: new Vec3(205, 75, -90) },
    3: { type: 'hostile', name: 'creeper', position: new Vec3(210, 75, -92) },
    4: { type: 'hostile', name: 'zombie', position: new Vec3(400, 75, -92) }, // beyond 48 → dropped
    5: { type: 'animal', name: 'cow', position: new Vec3(201, 75, -92) },
  } : {};
  bot.blockAt = () => ({ biome: { name: 'mangrove_swamp' } });
  const calls: string[] = [];
  bot.pathfinder = { stop: () => calls.push('pathfinder.stop'), setGoal: (g: unknown) => calls.push(`setGoal(${g})`) };
  bot.clearControlStates = () => calls.push('clearControlStates');
  bot.targetDigBlock = { name: 'mangrove_log' };
  bot.stopDigging = () => calls.push('stopDigging');
  bot.__calls = calls;
  return bot;
}

test('shapeTelemetry: the fixture shape from a live bot (inventory summed, nearby split + ranged)', () => {
  const t = tiny.shapeTelemetry(fakeBot(), {
    task: { kind: 'journey', text: 'gather mangrove logs', since_s: 120 },
    thinker: { enabled: true, next_in_s: 45 },
    connection: { connected: true, epoch: 2, reconnects: 1 },
  }, 1_700_000_000_000);
  assert.equal(t.name, 'StrandsBot');
  assert.equal(t.gamemode, 'survival');
  assert.deepEqual(t.pos, { x: 199.5, y: 75, z: -92.3 });
  assert.equal(t.health, 17.7);
  assert.equal(t.food, 14);
  assert.equal(t.air, 20);
  assert.equal(t.xp, 3);
  assert.deepEqual(t.time, { day: 12, ticks: 6_000, isDay: true });
  assert.equal(t.weather, 'clear');
  assert.equal(t.biome, 'mangrove_swamp');
  assert.equal(t.held, 'wooden_axe x1');
  assert.deepEqual(t.inventory, [{ name: 'mangrove_log', count: 8 }, { name: 'stick', count: 4 }]);
  assert.deepEqual(t.nearby.players, [{ name: 'CagatayCali', dist: 6 }]);
  assert.deepEqual(t.nearby.hostiles, [{ name: 'creeper', dist: 10.5 }]);
  assert.equal(t.task?.kind, 'journey');
  assert.equal(t.connection?.epoch, 2);
  assert.equal(t.ts, 1_700_000_000_000);
});

test('shapeTelemetry: a bot that is not in the world nulls its readings instead of throwing', () => {
  const t = tiny.shapeTelemetry(fakeBot({ inWorld: false }));
  assert.equal(t.pos, null);
  assert.equal(t.health, null);
  assert.equal(t.air, null);
  assert.deepEqual(t.nearby, { players: [], hostiles: [] });
  assert.equal(t.connection?.connected, false);
});

// ── the live server: gate, routes, chat race, stop ───────────────────────────

test('web rail: the tiny routes end to end', async (t) => {
  const bot = fakeBot();
  const says: Array<{ text: string; sayId: string }> = [];
  let stopCalls = 0;
  const rail = startWeb(
    bot,
    async (text, ctx) => {
      says.push({ text, sayId: ctx.sayId });
      if (text.startsWith('slow')) await new Promise((r) => setTimeout(r, 1_500));
      if (text.startsWith('fail')) throw new Error('the turn died');
      rail.log('out', 'StrandsBot', `I see ${text}`, ctx.sayId);
      return { answer: `I see ${text}` };
    },
    () => ({ workers: [] }),
    undefined,
    { busy: () => 0 },
    {
      mc: () => ({ host: 'minecraft', port: 25565, version: '1.21.11', connected: true, epoch: 0 }),
      telemetry: () => ({ task: { kind: 'journey', text: 'gather logs', since_s: 9 }, thinker: { enabled: true, next_in_s: 30 } }),
      stop: () => { stopCalls++; return ['pathfinder', 'controls', 'journey j1']; },
    },
  );
  t.after(() => rail.close());
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${rail.port()}`;
  // Remote caller: a forwarded-for header marks every request as tunneled, so
  // the loopback dev bypass can never apply even if the env flips later.
  const remote = { 'x-forwarded-for': '203.0.113.7' };
  const bearer = { ...remote, Authorization: `Bearer ${TOKEN}` };

  // public health
  const h = await fetch(`${base}/api/health`, { headers: remote });
  assert.equal(h.status, 200);
  const hj = await h.json() as any;
  assert.equal(hj.ok, true);
  assert.equal(hj.body, 'strands-minecraft');
  assert.equal(hj.name, 'StrandsBot');
  assert.deepEqual(hj.mc, { host: 'minecraft', port: 25565, version: '1.21.11', connected: true, epoch: 0 });
  assert.equal(hj.auth.tiny_token, true);
  assert.equal(hj.auth.passkeys, false);
  assert.equal(typeof hj.uptime_s, 'number');
  assert.equal(hj.camera.ok, true);

  // every gated route is 401 without a credential — JSON, ok:false
  for (const [m, p] of [['GET', '/api/telemetry'], ['GET', '/api/camera/snapshot'], ['GET', '/api/events'], ['GET', '/api/stream.mjpeg'], ['POST', '/api/chat'], ['POST', '/api/stop'], ['GET', '/api/state']] as const) {
    const r = await fetch(`${base}${p}`, { method: m, headers: remote, ...(m === 'POST' ? { body: '{}' } : {}) });
    assert.equal(r.status, 401, `${m} ${p} without a token`);
    assert.deepEqual(await r.json(), { ok: false, error: 'authentication required' });
  }
  // a wrong token is the same 401
  const bad = await fetch(`${base}/api/telemetry`, { headers: { ...remote, Authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);

  // telemetry with the bearer
  const tel = await fetch(`${base}/api/telemetry`, { headers: bearer });
  assert.equal(tel.status, 200);
  const tj = await tel.json() as any;
  assert.equal(tj.name, 'StrandsBot');
  assert.deepEqual(tj.task, { kind: 'journey', text: 'gather logs', since_s: 9 });
  assert.deepEqual(tj.pos, { x: 199.5, y: 75, z: -92.3 });

  // ?token= works too (the <img> path)
  const q = await fetch(`${base}/api/telemetry?token=${TOKEN}`, { headers: remote });
  assert.equal(q.status, 200);

  // chat: a quick turn answers done:true with the reply and its turn id
  const c1 = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'what do you see?' }) });
  assert.equal(c1.status, 200);
  const c1j = await c1.json() as any;
  assert.equal(c1j.ok, true);
  assert.equal(c1j.done, true);
  assert.equal(c1j.reply, 'I see what do you see?');
  assert.match(c1j.turn_id, /^say-\d+$/);
  assert.equal(says[0].text, 'what do you see?');
  assert.equal(says[0].sayId, c1j.turn_id);

  // chat: a long turn answers within wait_s with done:false and keeps running
  const t0 = Date.now();
  const c2 = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'slow: cut a tree', wait_s: 0.3 }) });
  const c2j = await c2.json() as any;
  assert.ok(Date.now() - t0 < 1_200, 'answered at wait_s, not at the end of the turn');
  assert.equal(c2j.ok, true);
  assert.equal(c2j.done, false);
  assert.match(c2j.reply, /On it/);
  assert.match(c2j.reply, new RegExp(c2j.turn_id));
  assert.equal(c2j.task.kind, 'journey');

  // chat: a failed turn is ok:false, not a 500 and not a green reply
  const c3 = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'fail please' }) });
  const c3j = await c3.json() as any;
  assert.equal(c3j.ok, false);
  assert.equal(c3j.done, true);
  assert.match(c3j.error, /the turn died/);

  // chat: empty prompt is a 400
  const c4 = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(c4.status, 400);

  // events alias replays the feed; the 'out' of the first chat is tagged with its turn id
  const ac = new AbortController();
  const ev = await fetch(`${base}/api/events`, { headers: bearer, signal: ac.signal });
  assert.equal(ev.status, 200);
  assert.match(ev.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = ev.body!.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /"kind":"out"/);
  assert.match(chunk, new RegExp(`"replyTo":"${c1j.turn_id}"`));
  ac.abort();

  // stop
  const st = await fetch(`${base}/api/stop`, { method: 'POST', headers: bearer });
  const sj = await st.json() as any;
  assert.equal(sj.ok, true);
  assert.deepEqual(sj.stopped, ['pathfinder', 'controls', 'journey j1']);
  assert.equal(stopCalls, 1);
  stopCalls = 0;

  // the slow turn from c2 finishes and gets its receipt — wait it out so the
  // server closes cleanly
  await new Promise((r) => setTimeout(r, 1_400));

  // rate limit: a burst of WRITES past 5/s on one token is 429 with Retry-After;
  // reads are never limited (the phone polls snapshot at 3 fps + telemetry)
  const reads = await Promise.all(Array.from({ length: 12 }, () => fetch(`${base}/api/telemetry`, { headers: bearer })));
  assert.deepEqual([...new Set(reads.map((r) => r.status))], [200], 'reads are not rate limited');
  const burst = await Promise.all(Array.from({ length: 12 }, () => fetch(`${base}/api/stop`, { method: 'POST', headers: bearer })));
  const codes = burst.map((r) => r.status);
  assert.ok(codes.includes(429), `expected a 429 in ${codes.join(',')}`);
  const limited = burst.find((r) => r.status === 429)!;
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal(((await limited.json()) as any).ok, false);
});

test('stopBody: the three movement calls plus stopDigging when a dig is in flight', async () => {
  const { stopBody } = await import('../src/web.js');
  const bot = fakeBot();
  assert.deepEqual(stopBody(bot), ['pathfinder', 'controls', 'digging']);
  assert.deepEqual(bot.__calls, ['pathfinder.stop', 'setGoal(null)', 'clearControlStates', 'stopDigging']);
  bot.targetDigBlock = null;
  bot.__calls.length = 0;
  assert.deepEqual(stopBody(bot), ['pathfinder', 'controls']);
});

test('chromeGlArgs: SwiftShader in a Linux container (no GPU → no WebGL → white frames), GPU ANGLE on a Mac, CHROME_ARGS wins', async () => {
  const { chromeGlArgs } = await import('../src/tools/vision.js');
  assert.deepEqual(chromeGlArgs({}, 'darwin'), ['--use-gl=angle']);
  assert.ok(chromeGlArgs({}, 'linux').includes('--use-angle=swiftshader'));
  assert.ok(chromeGlArgs({}, 'linux').includes('--enable-unsafe-swiftshader'));
  assert.deepEqual(chromeGlArgs({ CHROME_ARGS: '--use-gl=egl  --foo' }, 'linux'), ['--use-gl=egl', '--foo']);
});

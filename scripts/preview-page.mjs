#!/usr/bin/env node
/**
 * 🖼 Preview harness for the phone/desktop page — no Minecraft, no Chrome, no bot.
 *
 *   npx tsx scripts/preview-page.mjs                 # http://127.0.0.1:3077/
 *   SCENARIO=warming npx tsx scripts/preview-page.mjs
 *   PORT=3078 SCENARIO=dead npx tsx scripts/preview-page.mjs
 *
 * Serves PAGE_HTML exactly as web.ts would, plus fixtures for every route the
 * page touches: /auth/status (gate skipped; ?gate=1 on the page shows it),
 * /api/state, /api/telemetry, /api/workers (+ /camera/snapshot, /stream.mjpeg,
 * /stop), /events (a hand-written feed replayed, then a line every few seconds),
 * /stream.mjpeg (the two docs/img posters alternating at ~3 fps), /api/say,
 * /api/stop, /fonts/*. Telemetry comes from tinyai-id's wire fixture
 * (tests/fixtures/minecraft-body.json — the same truth the tests read).
 *
 * SCENARIO picks the honest state the design has to carry:
 *   live (default) · warming · stale · dead (bot not in the world) ·
 *   unreachable (/api/state 503) · idle (no task, empty crew) · dark-cave (tiny frames)
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { PAGE_HTML } = await import(path.join(root, 'src/web/page.ts'));
let serveStatic = null;
try { ({ serveStatic } = await import(path.join(root, 'src/web/assets.ts'))); } catch { /* before step 3 lands */ }

const SCENARIO = process.env.SCENARIO || 'live';
const PORT = Number(process.env.PORT || 3077);
const t0 = Date.now();

const fixturePath = path.join(process.env.HOME, 'tinyai-id/tests/fixtures/minecraft-body.json');
const fixture = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null;
const telemetryLive = fixture?.cases.telemetryLive.body ?? {
  name: 'StrandsBot', dimension: 'overworld', gamemode: 'survival', pos: { x: 11.5, y: 75, z: 4.3 }, health: 20, food: 20, air: 20, xp: 7,
  time: { day: 1, ticks: 7399, isDay: true }, weather: 'clear', biome: 'plains', held: 'torch x64',
  inventory: [{ name: 'torch', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cooked_beef', count: 16 }, { name: 'diamond_pickaxe', count: 1 }],
  nearby: { players: [{ name: 'CagatayCali', dist: 13.1 }], hostiles: [] }, task: { kind: 'turn', text: '1 turn(s) in flight', since_s: 0 },
  connection: { connected: true, epoch: 0, reconnects: 0 },
};
const telemetryDisconnected = fixture?.cases.telemetryDisconnected.body ?? { ...telemetryLive, connection: { connected: false }, inventory: [], health: null, food: null };
const workersFixture = fixture?.cases.workers.body.workers ?? [];

const posters = ['docs/img/demo-creeper-poster.jpg', 'docs/img/demo-dig-place-poster.jpg']
  .map((p) => path.join(root, p)).filter(existsSync).map((p) => readFileSync(p));
if (!posters.length) console.warn('no posters in docs/img — the stream will be empty');

// ── the world, per scenario ────────────────────────────────────────────────
const sinceS = () => Math.round((Date.now() - t0) / 1000);
const workers = () => workersFixture.map((w, i) => ({
  ...w,
  name: ['Nova', 'Frend'][i] || w.name,
  state: SCENARIO === 'idle' ? 'idle' : i === 0 ? 'working' : 'stalled',
  alive: SCENARIO !== 'dead',
  steps: w.steps + Math.floor(sinceS() / 20),
  since_s: w.since_s + sinceS(),
  camera: { ...w.camera, frames: w.camera.frames + Math.floor(sinceS() * 3) },
}));

function state() {
  const connected = SCENARIO !== 'dead';
  const warming = SCENARIO === 'warming';
  const frames = warming ? 0 : SCENARIO === 'stale' ? 120 : 120 + Math.floor(sinceS() * 3);
  const camera = warming ? `warming up (${Math.min(29, sinceS())}s) — headless Chrome + viewer page`
    : SCENARIO === 'stale' ? 'streaming to 1 watcher(s), 120 frames sent · scene stale: byte-identical frames while the body moved 7 blocks'
    : `streaming to 1 watcher(s), ${frames} frames sent`;
  const telemetry = SCENARIO === 'dead' ? telemetryDisconnected : telemetryLive;
  return {
    username: 'StrandsBot', connected,
    health: SCENARIO === 'dead' ? null : 17, food: SCENARIO === 'dead' ? null : 14,
    position: connected ? { x: 11.5, y: 75, z: 4.3 } : undefined,
    watchers: 1, frames, camera, placeholderFrames: warming ? sinceS() : 0,
    work: SCENARIO === 'idle' ? { workers: [] } : {
      journey: { id: 'j8kq2m', goal: 'build a spruce cabin by the lake with a door, four windows and a lit interior', status: 'running', step: 4 + Math.floor(sinceS() / 30), last: 'placed the second wall; 38 spruce planks left' },
      workers: workers().map((w) => ({ name: w.name, status: w.status, steps: w.steps, task: w.goal, last: w.last, id: w.id })),
    },
    says: [], voice: { call: 'idle', briefings: null },
    _telemetry: telemetry,
  };
}

// ── the feed ───────────────────────────────────────────────────────────────
const now = Date.now();
const FEED = [
  { ts: now - 3_400_000, kind: 'system', who: 'system', text: 'StrandsBot joined the server (1.21.11) · camera ready in 8.3s after 9 placeholder frame(s)' },
  { ts: now - 3_000_000, kind: 'in', who: 'CagatayCali', text: '(from CagatayCali via the web dashboard) status?' },
  { ts: now - 2_990_000, kind: 'out', who: 'StrandsBot', text: 'Standing on the hill above the lake at 11 75 4, full health, torch in hand. Daylight, clear sky. Nova and Frend are on watch.' , replyTo: 'say-1' },
  { ts: now - 1_800_000, kind: 'chat', who: 'CagatayCali', text: 'build me a spruce cabin by the lake' },
  { ts: now - 1_790_000, kind: 'in', who: 'CagatayCali', text: 'CagatayCali says in game chat: "build me a spruce cabin by the lake"' },
  { ts: now - 1_700_000, kind: 'journey', who: 'j8kq2m #1', text: 'started: build a spruce cabin by the lake — gathering 64 spruce logs first' },
  { ts: now - 1_200_000, kind: 'thought', who: 'StrandsBot', text: 'the lake shore at z=-12 is flat enough; foundation 7×5' },
  { ts: now - 900_000, kind: 'worker', who: 'Nova #1', text: 'joined the server', workerId: 'w-1' },
  { ts: now - 880_000, kind: 'worker', who: 'Frend #1', text: 'joined the server', workerId: 'w-2' },
  { ts: now - 600_000, kind: 'journey', who: 'j8kq2m #3', text: 'foundation laid (7×5 spruce planks), door frame on the south side' },
  { ts: now - 400_000, kind: 'system', who: 'system', text: 'STOP from tiny: pathfinder, controls' },
  { ts: now - 300_000, kind: 'voice', who: 'call', text: 'call ended · 2m14s' },
  { ts: now - 120_000, kind: 'out', who: 'StrandsBot', text: 'Second wall is up. 38 planks left — enough for the third wall, then I need another 20 logs.' },
  { ts: now - 60_000, kind: 'journey', who: 'j8kq2m #4', text: 'placed the second wall; 38 spruce planks left' },
];
const LIVE_LINES = [
  { kind: 'worker', who: 'Nova #%n', text: 'standing watch at (-8, 70, 5): night, no hostiles in range', workerId: 'w-1' },
  { kind: 'chat', who: 'CagatayCali', text: 'nice, keep going' },
  { kind: 'journey', who: 'j8kq2m #%n', text: 'third wall rising — 12 planks left' },
  { kind: 'thought', who: 'StrandsBot', text: 'windows at y+2, glass from the sand I smelted yesterday' },
];
const sseClients = new Set();
function broadcast(ev) { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const r of sseClients) r.write(line); }
let n = 5;
setInterval(() => {
  if (SCENARIO === 'idle' || SCENARIO === 'dead') return;
  const l = LIVE_LINES[n % LIVE_LINES.length];
  broadcast({ ...l, who: l.who.replace('%n', String(n)), ts: Date.now() });
  n += 1;
}, 6000);

// ── MJPEG ──────────────────────────────────────────────────────────────────
const DARK = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////////////////////wgALCAAJABABAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z', 'base64');
function mjpeg(req, res, why) {
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'close' });
  let i = 0;
  const tick = () => {
    if (res.destroyed) return clearInterval(timer);
    const jpg = SCENARIO === 'warming' || why === 'warming' ? DARK : SCENARIO === 'stale' ? posters[0] : posters[i++ % posters.length];
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`);
    res.write(jpg); res.write('\r\n');
  };
  tick();
  const timer = setInterval(tick, SCENARIO === 'warming' ? 1000 : 350);
  req.on('close', () => clearInterval(timer));
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE_HTML); }
  if (serveStatic && serveStatic(url.pathname, res)) return;
  if (route === 'GET /favicon.ico') { res.writeHead(204); return res.end(); }
  if (route === 'GET /manifest.webmanifest') return json(res, 200, { name: 'StrandsBot' });
  if (route === 'GET /auth/status') return json(res, 200, url.searchParams.has('gate') ? { enabled: true, enrolled: true, authed: false } : { enabled: false, enrolled: true, authed: true });
  if (route.startsWith('POST /auth/')) return json(res, 200, { key: 'k', options: { challenge: 'AAAA', allowCredentials: [], user: { id: 'AAAA' } } });
  if (SCENARIO === 'unreachable' && url.pathname.startsWith('/api/')) { res.writeHead(503); return res.end(); }
  if (route === 'GET /api/state') { const s = state(); delete s._telemetry; return json(res, 200, s); }
  if (route === 'GET /api/telemetry') return json(res, 200, { ...state()._telemetry, health: SCENARIO === 'dead' ? null : 17, food: SCENARIO === 'dead' ? null : 14, xp: 7, biome: 'plains', task: SCENARIO === 'idle' ? { kind: 'idle', text: '', since_s: 0 } : { kind: 'journey', text: 'build a spruce cabin by the lake', since_s: 1700 + sinceS() }, ts: SCENARIO === 'stale' ? Date.now() - 60_000 : Date.now() });
  if (route === 'GET /api/workers') return json(res, 200, { ok: true, bot: 'StrandsBot', workers: SCENARIO === 'idle' ? [] : workers() });
  const wm = /^\/api\/workers\/([^/]+)\/(camera\/snapshot|stream\.mjpeg|stop)$/.exec(url.pathname);
  if (wm) {
    if (wm[2] === 'stop') return json(res, 200, { ok: true, id: wm[1], stopped: ['pathfinder', 'controls'] });
    if (wm[2] === 'stream.mjpeg') return mjpeg(req, res);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Camera': 'live' });
    return res.end(posters[wm[1] === 'w-1' ? 1 : 0] || DARK);
  }
  if (route === 'GET /stream.mjpeg' || route === 'GET /api/stream.mjpeg') return mjpeg(req, res);
  if (route === 'GET /events' || route === 'GET /api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    for (const ev of FEED) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (route === 'POST /api/say') {
    let data = ''; req.on('data', (c) => data += c);
    req.on('end', () => {
      const text = (JSON.parse(data || '{}').text || '').trim();
      const id = 'say-' + (++n);
      json(res, 202, { ok: true, id });
      setTimeout(() => broadcast({ ts: Date.now(), kind: 'in', who: 'you', text: '(from you via the web dashboard) ' + text, replyTo: id }), 250);
      setTimeout(() => broadcast({ ts: Date.now(), kind: 'out', who: 'StrandsBot', text: 'On it — "' + text.slice(0, 40) + '" is running as turn ' + id + '.', replyTo: id }), 2200);
    });
    return;
  }
  if (route === 'POST /api/stop') return json(res, 200, { ok: true, stopped: ['pathfinder', 'controls'], note: 'preview' });
  res.writeHead(404); res.end('not found: ' + route);
}).listen(PORT, '127.0.0.1', () => console.log(`preview (${SCENARIO}) → http://127.0.0.1:${PORT}/   add ?gate=1 for the passkey gate`));

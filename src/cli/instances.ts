/**
 * `npx strands-minecraft add <Name> | ls | rm <Name>` — the glue around
 * src/cli/plan.ts: disk, listening ports, cloudflared, a detached `tsx
 * src/index.ts`, the health wait and `tiny-tech enroll`. Runs with cwd = the
 * checkout (where `.env` lives), like the bot itself.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allocatePorts, claimedPorts, enrollArgv, envFileFor, hostOf, insertIngress, instanceFromEnv, lsRow, memoryDirFor,
  parseArgs, parseEnv, planPeerBots, removeIngress, renderInstanceEnv, restartAdvice, rowName, usage, TOKEN_HEX_LEN,
  type AddArgs, type Instance,
} from './plan.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cwd = process.cwd();
const home = homedir();
const say = (s: string) => console.log(s);

// ── instances on disk ───────────────────────────────────────────────────────

function readInstances(): Array<Instance & { text: string }> {
  const out: Array<Instance & { text: string }> = [];
  const mainPath = join(cwd, '.env');
  const mainText = existsSync(mainPath) ? readFileSync(mainPath, 'utf8') : '';
  out.push({ ...instanceFromEnv('.env', parseEnv(mainText), true), text: mainText });
  const dir = join(cwd, 'instances');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.env')).sort()) {
      const text = readFileSync(join(dir, f), 'utf8');
      out.push({ ...instanceFromEnv(`instances/${f}`, parseEnv(text), false), text });
    }
  }
  return out;
}

/** port → pid for every TCP listener on this box (lsof; empty map when lsof is missing). */
function listeners(): Map<number, number> {
  const m = new Map<number, number>();
  const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return m;
  let pid = 0;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) { const port = Number(line.slice(1).split(':').pop()); if (Number.isFinite(port) && pid) m.set(port, pid); }
  }
  return m;
}

async function health(port: number): Promise<{ connected: boolean; name?: string } | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return { connected: !!j?.mc?.connected, name: j?.name };
  } catch { return null; }
}

/** tiny device rows (kind endpoint) by name — only when ~/.tiny/credentials.json has a session. */
async function tinyEndpointRows(): Promise<Map<string, { id: string; url: string }> | null> {
  try {
    const c = JSON.parse(readFileSync(join(home, '.tiny', 'credentials.json'), 'utf8'));
    if (!c?.token) return null;
    const res = await fetch(`${c.apiUrl || 'https://tiny.technology'}/api/devices`, { headers: { authorization: `Bearer ${c.token}` } });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    const m = new Map<string, { id: string; url: string }>();
    for (const d of j?.devices || []) if (d.kind === 'endpoint') m.set(String(d.name), { id: String(d.id), url: String(d.url || '') });
    return m;
  } catch { return null; }
}

// ── commands ────────────────────────────────────────────────────────────────

async function ls(json: boolean): Promise<number> {
  const instances = readInstances();
  const ports = listeners();
  const rows = await tinyEndpointRows();
  const out = [];
  for (const i of instances) {
    const pid = ports.get(i.webPort) ?? null;
    const h = pid ? await health(i.webPort) : null;
    const row = rows ? rows.get(rowName(i.name)) : undefined;
    out.push({ ...i, text: undefined, pid, connected: h ? h.connected : pid ? false : null, enrolled: rows ? !!row : null, deviceId: row?.id });
  }
  if (json) say(JSON.stringify(out.map(({ text: _t, ...r }) => r), null, 2));
  else {
    for (const r of out) say(lsRow(r));
    if (!rows) say('(enrolled? unknown — no tiny session in ~/.tiny/credentials.json; `npx tiny-tech login`)');
  }
  return 0;
}

async function add(a: AddArgs & { name: string }): Promise<number> {
  const instances = readInstances();
  if (instances.some((i) => i.name.toLowerCase() === a.name.toLowerCase())) { console.error(`✗ ${a.name} already exists (${instances.find((i) => i.name.toLowerCase() === a.name.toLowerCase())!.envPath}) — \`npx strands-minecraft rm ${a.name}\` first`); return 2; }
  const ports = listeners();
  const busy = new Set<number>([...claimedPorts(instances), ...ports.keys()]);
  const { webPort, viewerPort } = allocatePorts(a.ports, busy);
  const memoryDir = memoryDirFor(home, a.name);
  const token = randomBytes(TOKEN_HEX_LEN / 2).toString('hex');
  const peerBots = instances.map((i) => i.name);
  const spec = { name: a.name, webPort, viewerPort, memoryDir, token, peerBots, publicUrl: a.publicUrl, server: a.server };
  const envPath = envFileFor(a.name);
  const envText = renderInstanceEnv(spec);

  // 2. PEER_BOTS everywhere (the new file included, so one planner owns the rule)
  const peerPlan = planPeerBots([...instances.map((i) => ({ envPath: i.envPath, name: i.name, text: i.text })), { envPath, name: a.name, text: envText }]);
  const finalEnvText = peerPlan.find((p) => p.envPath === envPath)?.text ?? envText;
  const running = new Map<string, number>();
  for (const i of instances) { const pid = ports.get(i.webPort); if (pid) running.set(i.name, pid); }
  const others = peerPlan.filter((p) => p.envPath !== envPath);
  const advice = restartAdvice(others, running);

  // 3. tunnel ingress
  let ingress: { path: string; text: string; why: string } | null = null;
  let ingressNote = '';
  if (a.tunnel && a.publicUrl) {
    const path = join(home, '.cloudflared', `${a.tunnel}.yml`);
    if (!existsSync(path)) { console.error(`✗ ${path} not found — \`cloudflared tunnel create ${a.tunnel}\` and write its config first`); return 2; }
    const r = insertIngress(readFileSync(path, 'utf8'), hostOf(a.publicUrl), webPort);
    if (!r.changed && !/already routed/.test(r.why)) { console.error(`✗ ${path}: ${r.why}`); return 2; }
    if (r.changed) ingress = { path, text: r.text, why: r.why };
    ingressNote = r.why;
  }

  say(`plan     ${a.name} → ${envPath}  :${webPort}/:${viewerPort}  memory ${memoryDir}${a.publicUrl ? `  public ${a.publicUrl}` : ''}`);
  say(`peers    ${a.name} ignores [${peerBots.join(',') || '—'}]; ${others.length} other env file(s) gain ${a.name}`);
  if (a.tunnel) say(`tunnel   ${ingressNote}`);
  if (a.dryRun) {
    say('--- ' + envPath + ' (dry run, not written) ---');
    say(finalEnvText.replace(/TINY_TOKEN=.*/, 'TINY_TOKEN=<64 hex>'));
    for (const l of advice) say(`note     ${l}`);
    say('dry run — nothing written, nothing started');
    return 0;
  }

  // 1. write
  mkdirSync(join(cwd, 'instances'), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(cwd, envPath), finalEnvText, { mode: 0o600 });
  for (const p of others) writeFileSync(join(cwd, p.envPath), p.text);
  say(`✓ wrote  ${envPath} (0600) + ${others.length} PEER_BOTS update(s): ${others.map((p) => `${p.envPath}=[${p.peerBots.join(',')}]`).join(' ') || '—'}`);
  say(finalEnvText.replace(/TINY_TOKEN=(.{6}).*/, 'TINY_TOKEN=$1… (64 hex, in the file)').trimEnd());
  for (const l of advice) say(`⚠ ${l}`);

  if (ingress) {
    writeFileSync(ingress.path, ingress.text);
    say(`✓ tunnel ${ingress.path}: ${ingress.why}`);
    const host = hostOf(a.publicUrl!);
    const dns = spawnSync('cloudflared', ['tunnel', 'route', 'dns', a.tunnel!, host], { encoding: 'utf8' });
    const dnsOut = ((dns.stdout || '') + (dns.stderr || '')).trim().split('\n').pop() || '';
    say(`${dns.status === 0 || /already exists/i.test(dnsOut) ? '✓' : '✗'} dns    cloudflared tunnel route dns ${a.tunnel} ${host} — ${dnsOut || `exit ${dns.status}`}`);
    const label = `technology.tiny.cloudflared-${a.tunnel}`;
    const agent = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    if (existsSync(agent)) {
      const uid = process.getuid?.() ?? 501;
      const k = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { encoding: 'utf8' });
      say(`${k.status === 0 ? '✓' : '✗'} agent  launchctl kickstart -k gui/${uid}/${label}${k.status === 0 ? ' (cloudflared restarted with the new ingress)' : ` — ${(k.stderr || '').trim()}`}`);
    } else {
      say(`note   no LaunchAgent for ${a.tunnel} — restart it yourself: cloudflared tunnel --config ${ingress.path} run ${a.tunnel}`);
    }
  }

  // 4. start
  if (a.start) {
    const pid = startInstance(a.name, finalEnvText);
    say(`✓ start  pid ${pid} → logs/${a.name}.log  (npm start with ${envPath} on top of .env)`);
    const ok = await waitHealthy(webPort, 60_000, a.name);
    if (!ok) { console.error(`✗ ${a.name} did not report mc.connected within 60 s — tail logs/${a.name}.log`); return 1; }
    say(`✓ world  http://localhost:${webPort}/api/health says mc.connected (dashboard http://localhost:${webPort})`);
  } else say(`skip   --no-start: run it with  npx strands-minecraft start ${a.name}  (or: set -a; . ${envPath}; set +a; npm start)`);

  // 5. enroll
  if (a.enroll && a.publicUrl) {
    const argv = enrollArgv(a.publicUrl, a.name, token);
    say(`enroll   ${argv.map((x) => (x === token ? '<token>' : x)).join(' ')}`);
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: process.env });
    const text = (r.stdout || '') + (r.stderr || '');
    process.stdout.write(text.replace(new RegExp(token, 'g'), '<token>'));
    const m = /(?:enrolled|re-pointed)\s+\S+\s+\(([0-9a-f]{8})/.exec(text);
    if (r.status !== 0) { console.error(`✗ enroll exit ${r.status}`); return 1; }
    say(`✓ tiny   ${rowName(a.name)} is a device${m ? ` (${m[1]}…)` : ''} — it appears under Devices in the apps once ${a.publicUrl}/api/health answers through the tunnel`);
  } else if (a.publicUrl) say(`next   npx tiny-tech enroll --endpoint ${a.publicUrl} --body strands-the-miner --name ${rowName(a.name)} --secret <TINY_TOKEN from ${envPath}>`);
  return 0;
}

/** Detached `tsx src/index.ts` with the instance env on top of the shell's; logs/<Name>.log. */
export function startInstance(name: string, envText: string): number {
  mkdirSync(join(cwd, 'logs'), { recursive: true });
  const log = openSync(join(cwd, 'logs', `${name}.log`), 'a');
  const tsx = join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsx, join(pkgRoot, 'src', 'index.ts')], {
    cwd,
    env: { ...process.env, ...parseEnv(envText) },
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  if (!child.pid) throw new Error('spawn failed');
  writeFileSync(join(cwd, 'instances', `${name}.pid`), String(child.pid));
  return child.pid;
}

async function waitHealthy(port: number, ms: number, name: string): Promise<boolean> {
  const t0 = Date.now();
  let dots = 0;
  while (Date.now() - t0 < ms) {
    const h = await health(port);
    if (h?.connected) return true;
    if (++dots % 10 === 0) say(`…        waiting for ${name} (${Math.round((Date.now() - t0) / 1000)} s)${h ? ' — dashboard up, not in the world yet' : ''}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function rm(a: AddArgs & { name: string }): Promise<number> {
  const instances = readInstances();
  const inst = instances.find((i) => i.name.toLowerCase() === a.name.toLowerCase());
  if (!inst) { console.error(`✗ no instance named ${a.name} (${instances.map((i) => i.name).join(', ')})`); return 2; }
  if (inst.envPath === '.env') { console.error(`✗ ${inst.name} is the main bot (.env) — rm manages instances/*.env only`); return 2; }
  const ports = listeners();
  const pid = ports.get(inst.webPort);
  if (a.dryRun) { say(`would stop pid ${pid ?? '—'}, delete ${inst.envPath}${inst.publicUrl ? `, drop the ${hostOf(inst.publicUrl)} ingress` : ''}, rewrite PEER_BOTS${a.purge ? `, rm -rf ${inst.memoryDir}` : ''}`); return 0; }
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) { await new Promise((r) => setTimeout(r, 100)); try { process.kill(pid, 0); } catch { alive = false; } }
    if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } say(`✓ stop   pid ${pid} (SIGKILL — the bot ignores SIGTERM while the REPL owns stdin)`); }
    else say(`✓ stop   pid ${pid}`);
  } else say(`-  stop   ${inst.name} was not running`);
  unlinkSync(join(cwd, inst.envPath));
  const pidFile = join(cwd, 'instances', `${inst.name}.pid`);
  if (existsSync(pidFile)) unlinkSync(pidFile);
  say(`✓ rm     ${inst.envPath}`);
  const rest = instances.filter((i) => i !== inst);
  const peerPlan = planPeerBots(rest.map((i) => ({ envPath: i.envPath, name: i.name, text: i.text })));
  for (const p of peerPlan) writeFileSync(join(cwd, p.envPath), p.text);
  if (peerPlan.length) say(`✓ peers  ${peerPlan.map((p) => `${p.envPath}=[${p.peerBots.join(',')}]`).join(' ')}`);
  const running = new Map<string, number>();
  for (const i of rest) { const p = ports.get(i.webPort); if (p) running.set(i.name, p); }
  for (const l of restartAdvice(peerPlan, running)) say(`note   ${l.replace('ignores the new bot', 'forgets the removed bot')}`);
  if (inst.publicUrl) {
    const host = hostOf(inst.publicUrl);
    const dir = join(home, '.cloudflared');
    const ymls = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yml')) : [];
    for (const f of ymls) {
      const path = join(dir, f);
      const r = removeIngress(readFileSync(path, 'utf8'), host);
      if (r.changed) {
        writeFileSync(path, r.text);
        const tunnel = f.replace(/\.yml$/, '');
        const label = `technology.tiny.cloudflared-${tunnel}`;
        const uid = process.getuid?.() ?? 501;
        const k = existsSync(join(home, 'Library', 'LaunchAgents', `${label}.plist`)) ? spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]) : null;
        say(`✓ tunnel ${path}: ${host} rule removed${k ? (k.status === 0 ? ', cloudflared restarted' : ', restart cloudflared yourself') : ''}`);
        say(`note   the DNS CNAME ${host} stays (cloudflared has no \`route dns\` delete) — Cloudflare dashboard › DNS if you want it gone`);
      }
    }
  }
  if (a.purge && inst.memoryDir) { rmSync(inst.memoryDir, { recursive: true, force: true }); say(`✓ purge  ${inst.memoryDir}`); }
  else if (inst.memoryDir) say(`keep   ${inst.memoryDir} (waypoints, passkeys, token) — --purge deletes it`);
  if (inst.hasToken) say(`next   tiny › Devices › ${rowName(inst.name)} › Forget — the row keeps probing ${inst.publicUrl || 'its url'} until you do (or: npx tiny-tech devices forget ${rowName(inst.name)})`);
  return 0;
}

async function start(name: string): Promise<number> {
  const inst = readInstances().find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (!inst) { console.error(`✗ no instance named ${name}`); return 2; }
  if (inst.envPath === '.env') { console.error(`✗ ${inst.name} is the main bot — \`npm start\` runs it`); return 2; }
  const pid = listeners().get(inst.webPort);
  if (pid) { console.error(`✗ :${inst.webPort} is already served by pid ${pid}`); return 2; }
  const p = startInstance(inst.name, inst.text);
  say(`✓ start  pid ${p} → logs/${inst.name}.log`);
  const ok = await waitHealthy(inst.webPort, 60_000, inst.name);
  if (!ok) { console.error(`✗ ${inst.name} did not report mc.connected within 60 s — tail logs/${inst.name}.log`); return 1; }
  say(`✓ world  http://localhost:${inst.webPort}/api/health says mc.connected`);
  return 0;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  if ('error' in a) { console.error(`✗ ${a.error}\n`); process.stderr.write(usage()); return 2; }
  if (a.cmd === 'help') { process.stdout.write(usage()); return 0; }
  if (a.cmd === 'ls') return ls(a.json);
  if (a.cmd === 'add') return add(a as any);
  if (a.cmd === 'rm') return rm(a as any);
  if (a.cmd === 'start') return start(a.name!);
  return 2;
}

main().then((code) => process.exit(code), (e) => { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exit(1); });

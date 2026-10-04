/**
 * `npx strands-minecraft add | ls | rm` planners (src/cli/plan.ts) — every
 * decision the spawn command makes, without a disk, a port or cloudflared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocatePorts, claimedPorts, enrollArgv, hostOf, insertIngress, instanceFromEnv, lsRow, memoryDirFor, parseArgs,
  parseEnv, planPeerBots, removeIngress, renderInstanceEnv, restartAdvice, rowName, setEnvKey, validateName,
} from '../src/cli/plan.js';

test('parseArgs: the documented command line, and nothing else', () => {
  const a = parseArgs(['add', 'Ivy', '--public', 'https://ivy.example.com', '--tunnel', 'minecraft', '--enroll', '--ports', '3208']);
  assert.ok(!('error' in a));
  assert.deepEqual({ cmd: a.cmd, name: a.name, publicUrl: a.publicUrl, tunnel: a.tunnel, enroll: a.enroll, ports: a.ports, start: a.start }, { cmd: 'add', name: 'Ivy', publicUrl: 'https://ivy.example.com', tunnel: 'minecraft', enroll: true, ports: 3208, start: true });
  assert.equal((parseArgs([]) as any).cmd, 'help');
  assert.equal((parseArgs(['ls', '--json']) as any).json, true);
  assert.equal((parseArgs(['rm', 'Ivy', '--purge']) as any).purge, true);
  assert.equal((parseArgs(['add', 'Ivy', '--no-start']) as any).start, false);
  assert.match((parseArgs(['add']) as any).error, /needs a <Name>/);
  assert.match((parseArgs(['add', 'Ivy', '--enroll']) as any).error, /--enroll needs --public/);
  assert.match((parseArgs(['add', 'Ivy', '--tunnel', 'x']) as any).error, /--tunnel needs --public/);
  assert.match((parseArgs(['add', 'Ivy', '--public', 'http://ivy.example.com']) as any).error, /https origin/);
  assert.match((parseArgs(['add', 'Ivy', '--ports']) as any).error, /needs a value/);
  assert.match((parseArgs(['add', 'Ivy', '--ports', '80']) as any).error, /1024/);
  assert.match((parseArgs(['add', 'Ivy', '--wat']) as any).error, /unknown flag/);
  assert.match((parseArgs(['fly']) as any).error, /unknown command/);
  assert.match((parseArgs(['add', 'Iv']) as any).error, /Minecraft username/);
  assert.match((parseArgs(['add', 'Ivy', 'Kai']) as any).error, /two names/);
});

test('names: Minecraft usernames in, tiny row names out', () => {
  assert.equal(validateName('Strands_Bot9'), null);
  assert.match(validateName('a b')!, /username/);
  assert.match(validateName('seventeen_chars__')!, /username/);
  assert.equal(rowName('Strands_Bot'), 'strands-bot');
  assert.equal(rowName('Ivy'), 'ivy');
  assert.equal(memoryDirFor('/Users/c', 'Ivy'), '/Users/c/.strands-minecraft-ivy');
  assert.equal(hostOf('https://ivy.example.com'), 'ivy.example.com');
});

test('parseEnv / setEnvKey: quotes, comment tails, placeholders, append', () => {
  const text = `# server\nMC_USERNAME=StrandsBot\nMC_AUTH=offline            # offline | microsoft\nX="quoted # not a comment"\n# PEER_BOTS=Ivy,Kai        # crew names\n`;
  const env = parseEnv(text);
  assert.equal(env.MC_AUTH, 'offline');
  assert.equal(env.X, 'quoted # not a comment');
  assert.equal(env.PEER_BOTS, undefined, 'a commented placeholder is not a value');
  const a = setEnvKey(text, 'PEER_BOTS', 'Nova');
  assert.match(a, /^PEER_BOTS=Nova$/m, 'the placeholder line is replaced in place');
  assert.doesNotMatch(a, /^# PEER_BOTS=/m);
  assert.equal(setEnvKey(a, 'PEER_BOTS', 'Nova'), a, 'no change → same text');
  const b = setEnvKey(a, 'PEER_BOTS', 'Nova,Ivy');
  assert.equal(parseEnv(b).PEER_BOTS, 'Nova,Ivy');
  assert.equal(b.split('\n').length, a.split('\n').length, 'replace, do not append');
  const c = setEnvKey('A=1', 'B=2'.split('=')[0], '2');
  assert.equal(c, 'A=1\nB=2\n', 'appends with a newline between');
  assert.equal(setEnvKey('', 'B', '2'), 'B=2\n');
});

test('allocatePorts: first free family ≥ from, viewer = web − 1, busy ports skipped', () => {
  assert.deepEqual(allocatePorts(3208, new Set()), { webPort: 3208, viewerPort: 3207 });
  assert.deepEqual(allocatePorts(3208, new Set([3208])), { webPort: 3308, viewerPort: 3307 }, 'web busy → next family');
  assert.deepEqual(allocatePorts(3208, new Set([3307])), { webPort: 3208, viewerPort: 3207 });
  assert.deepEqual(allocatePorts(3208, new Set([3207, 3308])), { webPort: 3408, viewerPort: 3407 }, 'viewer busy counts too');
  assert.throws(() => allocatePorts(65500, new Set([65500])), /no free port pair/);
  const main = instanceFromEnv('.env', { MC_USERNAME: 'StrandsBot' }, true);
  const nova = instanceFromEnv('instances/Nova.env', { MC_USERNAME: 'Nova', WEB_PORT: '3108', VIEWER_PORT: '3107' }, false);
  assert.deepEqual([...claimedPorts([main, nova])].sort(), [3007, 3008, 3107, 3108]);
});

test('instanceFromEnv: main .env defaults, instance files are explicit', () => {
  const main = instanceFromEnv('.env', { PEER_BOTS: 'Nova', MINECRAFT_PUBLIC_URL: 'https://mc.example.com', TINY_TOKEN: 'x'.repeat(64) }, true);
  assert.equal(main.name, 'StrandsBot');
  assert.equal(main.webPort, 3008);
  assert.equal(main.viewerPort, 3007);
  assert.deepEqual(main.peerBots, ['Nova']);
  assert.equal(main.hasToken, true);
  const short = instanceFromEnv('instances/Ivy.env', { MC_USERNAME: 'Ivy', WEB_PORT: '3208', VIEWER_PORT: '3207', TINY_TOKEN: 'short' }, false);
  assert.equal(short.hasToken, false, '<32 chars is not a bearer the bot accepts');
  const nameless = instanceFromEnv('instances/Kai.env', { WEB_PORT: '3308', VIEWER_PORT: '3307' }, false);
  assert.equal(nameless.name, 'Kai', 'file name is the fallback username');
});

test('renderInstanceEnv: every variable src/ reads, server override optional', () => {
  const t = renderInstanceEnv({ name: 'Ivy', webPort: 3208, viewerPort: 3207, memoryDir: '/h/.strands-minecraft-ivy', token: 'a'.repeat(64), peerBots: ['StrandsBot', 'Nova'], publicUrl: 'https://ivy.example.com' }, new Date(0));
  const env = parseEnv(t);
  assert.deepEqual(env, {
    MC_USERNAME: 'Ivy', WEB_PORT: '3208', VIEWER_PORT: '3207', MEMORY_DIR: '/h/.strands-minecraft-ivy',
    WEB_AUTH_STORE: '/h/.strands-minecraft-ivy/.web_auth.json', TINY_TOKEN: 'a'.repeat(64), PEER_BOTS: 'StrandsBot,Nova', MINECRAFT_PUBLIC_URL: 'https://ivy.example.com',
  });
  assert.match(t, /^# Ivy — written by/, 'says who wrote it');
  const s = parseEnv(renderInstanceEnv({ name: 'Ivy', webPort: 3208, viewerPort: 3207, memoryDir: '/m', token: 't'.repeat(64), peerBots: [], server: 'mc.example.com:25566' }));
  assert.equal(s.MC_HOST, 'mc.example.com');
  assert.equal(s.MC_PORT, '25566');
  assert.equal(s.PEER_BOTS, '', 'an empty crew is written, not omitted');
  assert.equal(s.MINECRAFT_PUBLIC_URL, undefined);
});

test('planPeerBots: every file lists every OTHER bot; unchanged files are not rewritten', () => {
  const files = [
    { envPath: '.env', name: 'StrandsBot', text: 'MC_USERNAME=StrandsBot\nPEER_BOTS=Nova\n' },
    { envPath: 'instances/Nova.env', name: 'Nova', text: 'MC_USERNAME=Nova\nPEER_BOTS=StrandsBot\n' },
    { envPath: 'instances/Ivy.env', name: 'Ivy', text: 'MC_USERNAME=Ivy\nPEER_BOTS=StrandsBot,Nova\n' },
  ];
  const plan = planPeerBots(files);
  assert.deepEqual(plan.map((p) => [p.envPath, p.peerBots]), [['.env', ['Nova', 'Ivy']], ['instances/Nova.env', ['StrandsBot', 'Ivy']]], 'Ivy already lists both → untouched');
  assert.equal(parseEnv(plan[0].text).PEER_BOTS, 'Nova,Ivy');
  assert.equal(parseEnv(plan[0].text).MC_USERNAME, 'StrandsBot', 'other keys survive');
  // removal: drop Ivy → the two others shrink back
  const after = planPeerBots(plan.map((p) => ({ envPath: p.envPath, name: p.name, text: p.text })));
  assert.deepEqual(after.map((p) => [p.envPath, p.peerBots]), [['.env', ['Nova']], ['instances/Nova.env', ['StrandsBot']]]);
  assert.deepEqual(planPeerBots([files[0]]).map((p) => p.peerBots), [[]], 'the last bot standing ignores nobody');
});

test('restartAdvice: only running instances whose file changed', () => {
  const changed = [{ name: 'StrandsBot', envPath: '.env' }, { name: 'Nova', envPath: 'instances/Nova.env' }];
  const advice = restartAdvice(changed, new Map([['StrandsBot', 16968]]));
  assert.equal(advice.length, 1);
  assert.match(advice[0], /StrandsBot \(pid 16968\).*restart it when convenient/);
  assert.deepEqual(restartAdvice(changed, new Map()), []);
});

const YML = `tunnel: 24cf4b5b
credentials-file: /Users/c/.cloudflared/24cf4b5b.json
ingress:
  # StrandsBot web rail
  - hostname: minecraft.example.com
    service: http://localhost:3008
  - hostname: nova.example.com
    service: http://localhost:3108
  - service: http_status:404
`;

test('insertIngress: before the catch-all, idempotent, re-points a moved port', () => {
  const r = insertIngress(YML, 'ivy.example.com', 3208);
  assert.equal(r.changed, true);
  const lines = r.text.split('\n');
  const ivy = lines.indexOf('  - hostname: ivy.example.com');
  assert.ok(ivy > 0);
  assert.equal(lines[ivy + 1], '    service: http://localhost:3208');
  assert.equal(lines[ivy + 2], '  - service: http_status:404', 'catch-all stays last');
  assert.equal(lines.filter((l) => /hostname: nova/.test(l)).length, 1, 'other rules untouched');
  const again = insertIngress(r.text, 'ivy.example.com', 3208);
  assert.equal(again.changed, false);
  assert.match(again.why, /already routed/);
  assert.equal(again.text, r.text);
  const moved = insertIngress(r.text, 'ivy.example.com', 3308);
  assert.equal(moved.changed, true);
  assert.match(moved.why, /re-pointed/);
  assert.match(moved.text, /hostname: ivy\.example\.com\n    service: http:\/\/localhost:3308\n/);
  assert.equal(moved.text.split('\n').length, r.text.split('\n').length, 'no duplicate rule');
  const noCatch = insertIngress('ingress:\n  - hostname: a.example.com\n    service: http://localhost:1\n', 'b.example.com', 2);
  assert.equal(noCatch.changed, false);
  assert.match(noCatch.why, /catch-all/);
});

test('removeIngress: drops the rule and its service line only', () => {
  const r = removeIngress(insertIngress(YML, 'ivy.example.com', 3208).text, 'ivy.example.com');
  assert.equal(r.changed, true);
  assert.equal(r.text, YML);
  assert.equal(removeIngress(YML, 'ivy.example.com').changed, false);
});

test('enrollArgv: the tiny-tech line the README promises, row name lower-case', () => {
  assert.deepEqual(enrollArgv('https://ivy.example.com', 'Ivy', 'tok'), ['npx', '-y', 'tiny-tech@latest', 'enroll', '--endpoint', 'https://ivy.example.com', '--body', 'strands-the-miner', '--name', 'ivy', '--secret', 'tok']);
});

test('lsRow: one honest line per instance', () => {
  const i = { ...instanceFromEnv('instances/Nova.env', { MC_USERNAME: 'Nova', WEB_PORT: '3108', VIEWER_PORT: '3107', PEER_BOTS: 'StrandsBot', MINECRAFT_PUBLIC_URL: 'https://nova.example.com' }, false), pid: 16944, connected: true, enrolled: true };
  assert.equal(lsRow(i), 'Nova             :3108/:3107  pid 16944 · in world · https://nova.example.com · enrolled  peers=[StrandsBot]  instances/Nova.env');
  assert.match(lsRow({ ...i, pid: null, connected: null, enrolled: null }), /stopped · https:\/\/nova\.example\.com  peers/);
  assert.match(lsRow({ ...i, connected: false }), /NOT connected/);
});

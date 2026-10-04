/**
 * Pure planners behind `npx strands-minecraft add | ls | rm` — every decision
 * the spawn command makes is a function of its inputs, so each one has a node
 * test and the runnable (instances.ts) is only the glue that touches disk,
 * ports, cloudflared and processes.
 *
 * An INSTANCE is one more bot from the same checkout: its own Minecraft
 * username, dashboard + viewer ports, waypoint memory dir, passkey store and
 * tiny bearer, written to `instances/<Name>.env` (gitignored). The main `.env`
 * is instance #0 (MC_USERNAME, WEB_PORT 3008, VIEWER_PORT 3007). Instances
 * inherit everything else (server, model, keys) from `.env` at start — dotenv
 * never overrides a variable that is already in the environment.
 */

export interface AddArgs {
  cmd: 'add' | 'ls' | 'rm' | 'start' | 'help';
  name?: string;
  /** Public https origin of this instance's dashboard (the tunnel hostname). */
  publicUrl?: string;
  /** cloudflared tunnel NAME whose ~/.cloudflared/<name>.yml gains an ingress rule. */
  tunnel?: string;
  enroll: boolean;
  /** First WEB_PORT to try (viewer = web − 1). */
  ports: number;
  /** host:port of the Minecraft server, when not the checkout's .env one. */
  server?: string;
  start: boolean;
  dryRun: boolean;
  json: boolean;
  /** rm: also delete the memory dir. */
  purge: boolean;
}

export const DEFAULT_PORTS = 3208;

const USAGE = `strands-minecraft — one bot per command

  npx strands-minecraft                      run the bot in this checkout (.env)
  npx strands-minecraft add <Name> [opts]    one more bot from the same checkout
      --public https://<host>                its dashboard's public origin (tunnel hostname)
      --tunnel <cloudflared tunnel name>     add the ingress rule + route dns for --public
      --enroll                               tiny-tech enroll it as a device (needs --public)
      --ports <web>                          first WEB_PORT to try (viewer = web−1); default ${DEFAULT_PORTS}
      --server <host:port>                   a different Minecraft server than .env
      --no-start                             write the env, do not start the process
      --dry-run                              print the plan, touch nothing
  npx strands-minecraft ls [--json]          every instance: ports, pid, public url, enrolled?
  npx strands-minecraft start <Name>         start an instance written with --no-start (or stopped)
  npx strands-minecraft rm <Name> [--purge]  stop it, drop its env + ingress; --purge also deletes memory
`;

export function usage(): string { return USAGE; }

/** argv after the node + script entries. Unknown flags are an error, not a surprise. */
export function parseArgs(argv: readonly string[]): AddArgs | { error: string } {
  const out: AddArgs = { cmd: 'help', enroll: false, ports: DEFAULT_PORTS, start: true, dryRun: false, json: false, purge: false };
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return out;
  if (cmd !== 'add' && cmd !== 'ls' && cmd !== 'rm' && cmd !== 'start') return { error: `unknown command "${cmd}"` };
  out.cmd = cmd;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (!a.startsWith('--')) {
        if (out.name) return { error: `two names given: ${out.name}, ${a}` };
        out.name = a;
      } else if (a === '--public') out.publicUrl = next();
      else if (a === '--tunnel') out.tunnel = next();
      else if (a === '--enroll') out.enroll = true;
      else if (a === '--ports') { out.ports = Number(next()); if (!Number.isInteger(out.ports) || out.ports < 1024 || out.ports > 65534) return { error: '--ports must be an integer in 1024..65534' }; }
      else if (a === '--server') out.server = next();
      else if (a === '--no-start') out.start = false;
      else if (a === '--dry-run') out.dryRun = true;
      else if (a === '--json') out.json = true;
      else if (a === '--purge') out.purge = true;
      else return { error: `unknown flag ${a}` };
    } catch (e) { return { error: (e as Error).message }; }
  }
  if ((cmd === 'add' || cmd === 'rm' || cmd === 'start') && !out.name) return { error: `${cmd} needs a <Name>` };
  if (out.name) {
    const bad = validateName(out.name);
    if (bad) return { error: bad };
  }
  if (out.publicUrl) {
    const bad = validatePublicUrl(out.publicUrl);
    if (bad) return { error: bad };
  }
  if (out.enroll && !out.publicUrl) return { error: '--enroll needs --public https://<host> (tiny dials OUT to the dashboard)' };
  if (out.tunnel && !out.publicUrl) return { error: '--tunnel needs --public https://<host> (the hostname to route)' };
  if (out.server && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(out.server)) return { error: '--server must be host or host:port' };
  return out;
}

/** A Minecraft username (Java edition): 3–16 chars of [A-Za-z0-9_]. */
export function validateName(name: string): string | null {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return `"${name}" is not a Minecraft username (3–16 chars, letters/digits/underscore)`;
  return null;
}

export function validatePublicUrl(u: string): string | null {
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z0-9-]+$/i.test(u)) return `--public must be an https origin like https://ivy.example.com (got ${JSON.stringify(u)})`;
  return null;
}

/** The lower-case form tiny uses for the device row (`--name`). */
export const rowName = (name: string): string => name.toLowerCase().replace(/_/g, '-');

/** Instance file name: `instances/<Name>.env` keeps the username's case. */
export const envFileFor = (name: string): string => `instances/${name}.env`;

/** The memory dir convention Nova established: ~/.strands-minecraft-<lowercase>. */
export const memoryDirFor = (home: string, name: string): string => `${home}/.strands-minecraft-${name.toLowerCase()}`;

// ── dotenv text ─────────────────────────────────────────────────────────────

/** KEY=value lines → map (quotes stripped, `# comment` tails dropped, no interpolation). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/**
 * Set ONE key in dotenv text, preserving every other byte: an existing line
 * (even a commented-out `# KEY=…` placeholder) is replaced in place, else the
 * key is appended. Returns the same text when nothing changes.
 */
export function setEnvKey(text: string, key: string, value: string): string {
  const lines = text.split('\n');
  const live = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const placeholder = new RegExp(`^\\s*#\\s*${key}\\s*=`);
  const idx = lines.findIndex((l) => live.test(l));
  const rendered = `${key}=${value}`;
  if (idx >= 0) {
    if (lines[idx] === rendered) return text;
    lines[idx] = rendered;
    return lines.join('\n');
  }
  const ph = lines.findIndex((l) => placeholder.test(l));
  if (ph >= 0) { lines[ph] = rendered; return lines.join('\n'); }
  const trimmed = text.endsWith('\n') || text === '' ? text : text + '\n';
  return `${trimmed}${rendered}\n`;
}

// ── instances ───────────────────────────────────────────────────────────────

export interface Instance {
  name: string;
  /** '.env' for the main bot, 'instances/<Name>.env' otherwise. */
  envPath: string;
  webPort: number;
  viewerPort: number;
  memoryDir?: string;
  publicUrl?: string;
  hasToken: boolean;
  peerBots: string[];
}

/** Read one instance from its env map. The main `.env` carries the defaults. */
export function instanceFromEnv(envPath: string, env: Record<string, string>, main: boolean): Instance {
  const webPort = Number(env.WEB_PORT || (main ? 3008 : NaN));
  const viewerPort = Number(env.VIEWER_PORT || (main ? 3007 : NaN));
  return {
    name: env.MC_USERNAME || (main ? 'StrandsBot' : envPath.replace(/^.*\//, '').replace(/\.env$/, '')),
    envPath,
    webPort,
    viewerPort,
    memoryDir: env.MEMORY_DIR || undefined,
    publicUrl: env.MINECRAFT_PUBLIC_URL || undefined,
    hasToken: (env.TINY_TOKEN || '').trim().length >= 32,
    peerBots: (env.PEER_BOTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * First free (web, viewer=web−1) pair at or above `from`, stepping by 100 so
 * instances read as families (3008/3007, 3108/3107, 3208/3207…). `busy` is
 * every port already listening or claimed by an instance env.
 */
export function allocatePorts(from: number, busy: ReadonlySet<number>, step = 100): { webPort: number; viewerPort: number } {
  for (let web = from; web < 65535; web += step) {
    const viewer = web - 1;
    if (!busy.has(web) && !busy.has(viewer)) return { webPort: web, viewerPort: viewer };
  }
  throw new Error(`no free port pair at or above ${from}`);
}

/** Every port an instance list claims (web + viewer), for allocatePorts. */
export function claimedPorts(instances: readonly Instance[]): Set<number> {
  const s = new Set<number>();
  for (const i of instances) { if (Number.isFinite(i.webPort)) s.add(i.webPort); if (Number.isFinite(i.viewerPort)) s.add(i.viewerPort); }
  return s;
}

export interface NewInstanceSpec {
  name: string;
  webPort: number;
  viewerPort: number;
  memoryDir: string;
  token: string;
  peerBots: string[];
  publicUrl?: string;
  server?: string;
}

/** The `instances/<Name>.env` text — every line is a variable src/ reads. */
export function renderInstanceEnv(s: NewInstanceSpec, now = new Date()): string {
  const lines = [
    `# ${s.name} — written by \`npx strands-minecraft add\` on ${now.toISOString()}`,
    `# Everything not set here comes from the checkout's .env at start (server, model, keys).`,
    `MC_USERNAME=${s.name}`,
  ];
  if (s.server) {
    const [host, port] = s.server.split(':');
    lines.push(`MC_HOST=${host}`);
    if (port) lines.push(`MC_PORT=${port}`);
  }
  lines.push(
    `WEB_PORT=${s.webPort}`,
    `VIEWER_PORT=${s.viewerPort}`,
    `MEMORY_DIR=${s.memoryDir}`,
    `WEB_AUTH_STORE=${s.memoryDir}/.web_auth.json`,
    `TINY_TOKEN=${s.token}`,
    `PEER_BOTS=${s.peerBots.join(',')}`,
  );
  if (s.publicUrl) lines.push(`MINECRAFT_PUBLIC_URL=${s.publicUrl}`);
  return lines.join('\n') + '\n';
}

/**
 * PEER_BOTS on EVERY instance = every OTHER instance's username. Returns the
 * env files whose text actually changes (path → new text) so the caller can
 * write them and tell the owner which running bots need a restart.
 */
export function planPeerBots(files: ReadonlyArray<{ envPath: string; name: string; text: string }>): Array<{ envPath: string; name: string; text: string; peerBots: string[] }> {
  const names = files.map((f) => f.name);
  const out: Array<{ envPath: string; name: string; text: string; peerBots: string[] }> = [];
  for (const f of files) {
    const peers = names.filter((n) => n !== f.name);
    const next = setEnvKey(f.text, 'PEER_BOTS', peers.join(','));
    if (next !== f.text) out.push({ envPath: f.envPath, name: f.name, text: next, peerBots: peers });
  }
  return out;
}

/** The token every instance gets: 64 hex chars (`openssl rand -hex 32`). */
export const TOKEN_HEX_LEN = 64;
export const isToken = (t: string): boolean => /^[0-9a-f]{64}$/.test(t);

// ── cloudflared ingress ─────────────────────────────────────────────────────

/** `https://ivy.example.com` → `ivy.example.com`. */
export const hostOf = (publicUrl: string): string => publicUrl.replace(/^https:\/\//i, '').replace(/\/.*$/, '');

/**
 * Insert `- hostname: <host>\n  service: http://localhost:<port>` into a
 * cloudflared config BEFORE the `http_status:404` catch-all (which cloudflared
 * requires to be last). Idempotent: a rule for the host already pointing at the
 * port leaves the text alone; a rule pointing elsewhere is re-pointed.
 */
export function insertIngress(yaml: string, host: string, port: number): { text: string; changed: boolean; why: string } {
  const lines = yaml.split('\n');
  const service = `http://localhost:${port}`;
  const hostIdx = lines.findIndex((l) => new RegExp(`^\\s*-\\s*hostname:\\s*${host.replace(/\./g, '\\.')}\\s*$`).test(l));
  if (hostIdx >= 0) {
    const svcIdx = lines.findIndex((l, i) => i > hostIdx && /^\s*service:/.test(l));
    if (svcIdx < 0 || (svcIdx > hostIdx + 1 && lines.slice(hostIdx + 1, svcIdx).some((l) => /^\s*-/.test(l)))) return { text: yaml, changed: false, why: `rule for ${host} exists but has no service line — fix it by hand` };
    const indent = /^(\s*)/.exec(lines[svcIdx])![1];
    if (lines[svcIdx].trim() === `service: ${service}`) return { text: yaml, changed: false, why: `${host} → ${service} already routed` };
    const was = lines[svcIdx].trim();
    lines[svcIdx] = `${indent}service: ${service}`;
    return { text: lines.join('\n'), changed: true, why: `${host} re-pointed (${was} → ${service})` };
  }
  const catchIdx = lines.findIndex((l) => /^\s*-\s*service:\s*http_status:\d+\s*$/.test(l));
  if (catchIdx < 0) return { text: yaml, changed: false, why: 'no `- service: http_status:404` catch-all found — add one, cloudflared requires it last' };
  const indent = /^(\s*)/.exec(lines[catchIdx])![1];
  lines.splice(catchIdx, 0, `${indent}- hostname: ${host}`, `${indent}  service: ${service}`);
  return { text: lines.join('\n'), changed: true, why: `${host} → ${service} inserted before the catch-all` };
}

/** Drop the `- hostname: <host>` rule (and its service line). */
export function removeIngress(yaml: string, host: string): { text: string; changed: boolean } {
  const lines = yaml.split('\n');
  const hostIdx = lines.findIndex((l) => new RegExp(`^\\s*-\\s*hostname:\\s*${host.replace(/\./g, '\\.')}\\s*$`).test(l));
  if (hostIdx < 0) return { text: yaml, changed: false };
  let end = hostIdx + 1;
  while (end < lines.length && !/^\s*-/.test(lines[end]) && lines[end].trim() !== '') end++;
  lines.splice(hostIdx, end - hostIdx);
  return { text: lines.join('\n'), changed: true };
}

/** Which running instances must restart to see a PEER_BOTS change — never done for them. */
export function restartAdvice(changed: ReadonlyArray<{ name: string; envPath: string }>, running: ReadonlyMap<string, number>): string[] {
  const out: string[] = [];
  for (const c of changed) {
    const pid = running.get(c.name);
    if (pid) out.push(`${c.name} (pid ${pid}) is running with the OLD PEER_BOTS — restart it when convenient so it ignores the new bot's chat`);
  }
  return out;
}

/** The `tiny-tech enroll` argv — the secret rides argv on purpose: it is the bot's own bearer, local to this box. */
export function enrollArgv(publicUrl: string, name: string, token: string): string[] {
  return ['npx', '-y', 'tiny-tech@latest', 'enroll', '--endpoint', publicUrl, '--body', 'strands-the-miner', '--name', rowName(name), '--secret', token];
}

/** One row of `ls`, as text. */
export function lsRow(i: Instance & { pid?: number | null; connected?: boolean | null; enrolled?: boolean | null }): string {
  const pid = i.pid ? `pid ${i.pid}` : 'stopped';
  const mc = i.connected === true ? ' · in world' : i.connected === false ? ' · NOT connected' : '';
  const pub = i.publicUrl ? ` · ${i.publicUrl}` : '';
  const enrolled = i.enrolled === true ? ' · enrolled' : i.enrolled === false ? ' · not enrolled' : '';
  return `${i.name.padEnd(16)} :${i.webPort}/:${i.viewerPort}  ${pid}${mc}${pub}${enrolled}  peers=[${i.peerBots.join(',')}]  ${i.envPath}`;
}

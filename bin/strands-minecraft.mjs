#!/usr/bin/env node
// `npx strands-minecraft` — runs the bot from wherever you are: `.env`,
// `.web_auth.json` (passkeys) and waypoints resolve against YOUR cwd, the
// TypeScript runs straight from this package through tsx (no build step —
// the same way `npm start` and the Docker image run it).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
// Sub-commands manage INSTANCES (one more bot from this checkout); anything
// else is the bot itself. `npx strands-minecraft add Ivy --public https://…`
const SUB = new Set(['add', 'ls', 'rm', 'start', 'help', '--help', '-h']);
const entry = SUB.has(process.argv[2]) ? join(pkgRoot, 'src', 'cli', 'instances.ts') : join(pkgRoot, 'src', 'index.ts');
const child = spawn(process.execPath, [tsx, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

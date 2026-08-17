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
const child = spawn(process.execPath, [tsx, join(pkgRoot, 'src', 'index.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

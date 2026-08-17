#!/usr/bin/env node
// Every number on the landing page (docs/) and in the README comes from HERE —
// computed from the tree, never typed. Run: `node scripts/site-numbers.mjs`
// → writes docs/numbers.json (and prints it). `--check` exits 1 if the file
// on disk differs from what the tree says (CI / README pin).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
const read = (p) => readFileSync(join(root, p), 'utf8');

// --- tools: the same grep the release contract used ---------------------------
// `name: '<snake_case>'` in every tool file + the three modules that register
// tools outside src/tools/ (journeys, fleet, voicebridge).
const toolFiles = [
  ...sh('git ls-files src/tools').split('\n').filter((f) => f.endsWith('.ts')),
  'src/journeys.ts',
  'src/fleet.ts',
  'src/voicebridge.ts',
];
const DOMAIN_OF_FILE = {
  'src/tools/perception.ts': 'perception',
  'src/tools/movement.ts': 'movement',
  'src/tools/world.ts': 'world',
  'src/tools/inventory.ts': 'inventory',
  'src/tools/actions.ts': 'actions', // split below into combat / interaction / chat
  'src/tools/vision.ts': 'vision',
  'src/tools/memory.ts': 'memory',
  'src/tools/helpers.ts': 'world',
  'src/journeys.ts': 'journeys',
  'src/fleet.ts': 'fleet',
  'src/voicebridge.ts': 'voice',
};
// actions.ts exports combatTools / interactionTools / chatTools — read which
// export block each name sits in so the chips group honestly.
function actionsDomains(src) {
  const out = {};
  const blocks = [...src.matchAll(/export function (combat|interaction|chat)Tools[\s\S]*?(?=export function |$)/g)];
  for (const m of blocks) {
    for (const n of m[0].matchAll(/name: '([a-z_]+)'/g)) out[n[1]] = m[1];
  }
  return out;
}
// A tool is `name: '<snake_case>'` FOLLOWED by its `description:` — the shape of every
// `tool({ … })` call. A bare `name:` elsewhere (e.g. helpers.ts look_around's
// `out.water = { name: 'water', … }` result object) is data, not a tool.
// The description's first sentence is kept for the landing's chip hovers, with
// template placeholders (`${MAX_STEPS}`) removed — nothing invented.
function readString(src, i) {
  const q = src[i];
  if (!["'", '"', '`'].includes(q)) return '';
  let j = i + 1, out = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { out += src[j + 1]; j += 2; continue; }
    if (c === q) break;
    out += c; j++;
  }
  return out;
}
const firstSentence = (s) => {
  const t = s.replace(/\$\{[^}]+\}/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).trim();
};
const tools = [];
const seen = new Set();
for (const f of toolFiles) {
  const src = read(f);
  const actions = f.endsWith('actions.ts') ? actionsDomains(src) : null;
  for (const m of src.matchAll(/name: '([a-z_]+)',\s*description:\s*/g)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const domain = actions ? actions[name] ?? 'actions' : DOMAIN_OF_FILE[f] ?? 'other';
    const line = src.slice(0, m.index).split('\n').length;
    tools.push({ name, domain, file: f, line, description: firstSentence(readString(src, m.index + m[0].length)) });
  }
}
tools.sort((a, b) => a.name.localeCompare(b.name));

// --- tests --------------------------------------------------------------------
const testFiles = sh('git ls-files test').split('\n').filter((f) => /\.test\.ts$/.test(f));
let testCases = 0;
for (const f of testFiles) testCases += (read(f).match(/^\s*(test|it)\(/gm) ?? []).length;

// --- lines of code ------------------------------------------------------------
const srcFiles = sh('git ls-files src').split('\n').filter(Boolean);
const loc = srcFiles.reduce((n, f) => n + read(f).split('\n').length - 1, 0);

// --- routes: the `route === 'GET /api/…'` table in src/web.ts ---------------------
const webSrc = read('src/web.ts');
const routes = [...webSrc.matchAll(/route === '((?:GET|POST) \/api\/[a-z./_-]+)'/g)].map((m) => m[1]);
const PUBLIC = new Set(['GET /api/health']);
const TINY = new Set([
  'GET /api/health', 'GET /api/telemetry', 'GET /api/camera/snapshot', 'GET /api/stream.mjpeg',
  'GET /api/events', 'POST /api/chat', 'POST /api/stop',
]);
const routeTable = routes
  .filter((r) => TINY.has(r))
  .map((r) => ({ route: r, gate: PUBLIC.has(r) ? 'public' : 'token' }));

// --- rails: README's rail table (7 rows) — counted, not typed ----------------------
const readme = read('README.md');
const railsBlock = readme.split('| Rail | How | What happens |')[1]?.split('\n\n')[0] ?? '';
const rails = railsBlock.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('|---')).length;

// --- docs: the "Read deeper" cards — title = the file's H1, hook = the first sentence of its
// first prose paragraph (no headings, no tables, no blockquote markers), reading time at 200 wpm.
const WPM = 200;
const words = (t) => (t.match(/\S+/g) ?? []).length;
function docCard(path) {
  const src = read(path);
  const title = src.match(/^# (.+)$/m)?.[1].trim() ?? path;
  const paras = src.split(/\n\s*\n/).map((x) => x.replace(/^>\s?/gm, '').trim())
    .filter((x) => x && !/^#/.test(x) && !/^\|/.test(x) && !/^[-*] /.test(x) && !/^```/.test(x));
  const first = (paras[0] ?? '').replace(/\s+/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '');
  // one sentence, or two when the first is a stub like "Issue #44."
  const sentences = first.split(/(?<=[.!?])\s+/);
  let hook = ''; for (const x of sentences) { hook = `${hook} ${x}`.trim(); if (hook.length >= 60) break; }
  return { path, title, hook, words: words(src), minutes: Math.max(1, Math.round(words(src) / WPM)) };
}
const DOC_CARDS = ['COVERAGE.md', 'HARDCODING.md', 'MEMORY.md', 'SECURITY.md', 'AGENTS.md'].filter((f) => existsSync(join(root, f)));
const docs = DOC_CARDS.map(docCard);
const findingFiles = sh('git ls-files docs/findings').split('\n').filter((f) => f.endsWith('.md'));
const findings = {
  count: findingFiles.length,
  words: findingFiles.reduce((n, f) => n + words(read(f)), 0),
  minutes: Math.max(1, Math.round(findingFiles.reduce((n, f) => n + words(read(f)), 0) / WPM)),
  titles: findingFiles.map((f) => read(f).match(/^# (.+)$/m)?.[1].trim() ?? f),
};

// --- package facts ------------------------------------------------------------------
const pkg = JSON.parse(read('package.json'));
const reflexTick = Number(read('src/reflexes.ts').match(/REFLEX_TICK_MS \?\? (\d+)/)?.[1] ?? 0);
const coverage = /Status: 100%/.test(read('COVERAGE.md')) ? 100 : null;

const numbers = {
  generated_by: 'scripts/site-numbers.mjs',
  commit: sh('git rev-parse --short HEAD'),
  version: pkg.version,
  node: pkg.engines?.node ?? '>=22',
  license: pkg.license,
  strands: pkg.dependencies['@strands-agents/sdk'],
  mineflayer: pkg.dependencies['mineflayer'],
  tools: tools.length,
  toolNames: tools.map((t) => t.name),
  toolDomains: Object.fromEntries(tools.map((t) => [t.name, t.domain])),
  toolDescriptions: Object.fromEntries(tools.map((t) => [t.name, t.description])),
  toolSources: Object.fromEntries(tools.map((t) => [t.name, `${t.file}:${t.line}`])),
  testFiles: testFiles.length,
  testCases,
  loc,
  srcFiles: srcFiles.length,
  rails,
  routes: routeTable,
  reflexTickMs: reflexTick,
  docs,
  findings,
  mineflayerCoverage: coverage,
};

const out = join(root, 'docs/numbers.json');
const json = JSON.stringify(numbers, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const cur = existsSync(out) ? readFileSync(out, 'utf8') : '';
  const strip = (s) => s.replace(/"commit": "[0-9a-f]+",\n/, '');
  if (strip(cur) !== strip(json)) {
    console.error('docs/numbers.json is stale — run `node scripts/site-numbers.mjs`');
    process.exit(1);
  }
  console.log('docs/numbers.json matches the tree');
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(json);
}

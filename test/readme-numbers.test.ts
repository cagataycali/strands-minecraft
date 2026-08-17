/**
 * The README's numbers are not typed — they are the tree's numbers, computed by
 * scripts/site-numbers.mjs into docs/numbers.json (which CI checks for
 * staleness). This test pins the README to that JSON: change the code, re-run
 * the script, and the prose follows; type a number by hand and this fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const numbers = JSON.parse(readFileSync(new URL('../docs/numbers.json', import.meta.url), 'utf8')) as {
  tools: number; toolNames: string[]; testFiles: number; testCases: number; rails: number; routes: Array<{ route: string; gate: string }>;
};
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

test('README states the generated tool count everywhere it states one', () => {
  // "The tools — 61, covering", "tools-61%20", "61 game tools"
  const stated = [...readme.matchAll(/The tools — (\d+), covering|tools-(\d+)%20|(\d+) game tools/g)].map((m) => Number(m[1] ?? m[2] ?? m[3]));
  assert.ok(stated.length >= 2, `expected the tool count in the heading, the badge and the repo map; found ${stated.length}`);
  for (const n of stated) assert.equal(n, numbers.tools, `README says ${n} tools; the tree has ${numbers.tools}`);
  assert.match(readme, new RegExp(`tools-${numbers.tools}%20`), 'the tools badge carries the count');
});

test('README lists every tool by its registered name — no ghost tools, none missing', () => {
  const start = readme.indexOf('## The tools');
  // The section ends at the next heading of any level (README cycle 3 grouped the
  // dashboard under "Talk to it", so the old '## The dashboard' marker moved).
  const end = readme.indexOf('\n#', start + 1);
  assert.ok(start > 0 && end > start, 'the tools section exists and is followed by another heading');
  const section = readme.slice(start, end);
  const missing = numbers.toolNames.filter((t) => !section.includes(t));
  assert.deepEqual(missing, [], 'tools registered in src but absent from the README table');
  const snake = new Set([...section.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((m) => m[1]));
  const ghosts = [...snake].filter((w) => !numbers.toolNames.includes(w));
  assert.deepEqual(ghosts, [], 'snake_case names in the tools table that are not registered tools');
});

test('README badge and repo map carry the generated test counts; rails table has the counted rows', () => {
  assert.match(readme, new RegExp(`tests-${numbers.testCases}-`), `tests badge should say ${numbers.testCases}`);
  assert.match(readme, new RegExp(`${numbers.testFiles} node:test files`), `the Layout line should say ${numbers.testFiles} test files`);
  const rows = readme.split('\n').filter((l) => /^\| (💬|⌨️|🎤|📞|📱|🗣|🔥) /.test(l));
  assert.equal(rows.length, numbers.rails, `the rails table has ${rows.length} rows, numbers.json counted ${numbers.rails}`);
  // README cycle 3: the rails live under "## Talk to it — seven rails, one history" (verifiable-promise H2s).
  assert.match(readme, /## Talk to it — seven rails, one history/);
  assert.equal(numbers.rails, 7, 'the heading spells the number; if rails change, change the heading');
});

test('README documents every tiny endpoint route the script found', () => {
  for (const { route } of numbers.routes) assert.ok(readme.includes(route), `route ${route} missing from the README`);
});

test('AGENTS.md agrees on the tool and test-file counts', () => {
  assert.match(agents, new RegExp(`\\b${numbers.tools} tools\\b`), 'AGENTS.md tools row');
  assert.match(agents, new RegExp(`\\b${numbers.testFiles} test files\\b`), 'AGENTS.md test-file count');
});

test('README stays a stranger\'s read — under 450 lines, no owner-only hostnames', () => {
  assert.ok(readme.split('\n').length <= 450, `README is ${readme.split('\n').length} lines`);
  assert.doesNotMatch(readme, /cagatay\.my/, 'owner tunnel hostname');
  assert.doesNotMatch(readme, /\bsk-[A-Za-z0-9]{8,}/, 'a key-shaped string');
});

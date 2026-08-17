// Journey bookkeeping that is pure enough to test without a world.
// MEMORY_DIR must be set BEFORE importing journeys.js — the module resolves its
// store directory at load time, and a test that forgets writes into the live one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
process.env.MEMORY_DIR = mkdtempSync(`${tmpdir()}/journeys-test-`);
const { recentStepsBlock, triageInterrupted } = await import('../src/journeys.js');
type Journey = import('../src/journeys.js').Journey;

// ── the Δ critic was write-only (live journal 2026-08-17) ────────────────
test('recentStepsBlock: replays the last steps with their measured brackets', () => {
  // The real drift: narration and measurement contradicting each other on ONE line.
  const journal = [
    'Lit the east side. [Δ -12 torch, moved 40m]',
    'Ran the darkness scan — my 23 spare torches stay in the bag for future use. [Δ -23 torch, -1 hp]',
  ];
  const block = recentStepsBlock(journal);
  assert.match(block, /last: Ran the darkness scan/);
  assert.match(block, /2 ago: Lit the east side/, 'older step is labelled by age');
  assert.match(block, /\[Δ -23 torch, -1 hp\]/, 'the bracket must survive into the prompt');
  assert.ok(block.indexOf('Lit the east side') < block.indexOf('Ran the darkness'), 'newest last, closest to the instruction');
  assert.match(block, /the bracket is right and your memory is wrong/);
});

test('recentStepsBlock: nothing to replay on step 1', () => {
  assert.equal(recentStepsBlock([]), '');
  assert.equal(recentStepsBlock(['error: Bedrock throttled']), '', 'errors are not steps the model should imitate');
});

test('recentStepsBlock: long steps are clipped, waits kept visible', () => {
  const long = `Mined a lot. ${'x'.repeat(400)} [Δ +64 cobblestone] [waiting: furnace, ends when 8 iron_ingot appear]`;
  const block = recentStepsBlock([long], 2, 60);
  assert.ok(block.includes('…'), 'clipped');
  assert.ok(block.length < 400, 'and genuinely shorter than the raw line');
  assert.match(recentStepsBlock(['Smelting. [Δ nothing] [waiting: furnace, ends when 8 iron_ingot appear]']), /\[waiting: furnace/);
});

// ── stale errands (live soak 2026-08-17: four pending, one 100 min old) ──
const errand = (id: string, ageMin: number, iterations: number): Journey =>
  ({ id, goal: `g-${id}`, status: 'interrupted', iterations, startedAt: Date.now() - ageMin * 60_000, journal: [] });

test('triageInterrupted: archaeology is retired, not announced', () => {
  const { announce, retire } = triageInterrupted([errand('old', 100, 3), errand('fresh', 5, 2)], Date.now());
  assert.deepEqual(announce.map((j) => j.id), ['fresh']);
  assert.deepEqual(retire.map((j) => j.id), ['old']);
});

test('triageInterrupted: a zero-step errand has nothing to resume', () => {
  // The note promises 'progress is already in your inventory' — false for 0 steps.
  const { announce, retire } = triageInterrupted([errand('empty', 12, 0), errand('empty-but-new', 2, 0)], Date.now());
  assert.deepEqual(announce.map((j) => j.id), ['empty-but-new'], 'a minute-old empty errand is still live work');
  assert.deepEqual(retire.map((j) => j.id), ['empty']);
});

test('triageInterrupted: at most two errands, freshest first, rest retired', () => {
  const { announce, retire } = triageInterrupted(
    [errand('a', 30, 1), errand('b', 3, 1), errand('c', 20, 1), errand('d', 1, 1)], Date.now());
  assert.deepEqual(announce.map((j) => j.id), ['d', 'b'], 'freshest two, newest first');
  assert.deepEqual(retire.map((j) => j.id).sort(), ['a', 'c'], 'the rest are not left to re-offer next boot');
});

test('triageInterrupted: nothing pending is not a special case', () => {
  assert.deepEqual(triageInterrupted([], Date.now()), { announce: [], retire: [] });
});

// ── sham waits (live journal 2026-08-17: '[waiting: none, continuing next vein]') ──
test('declaredWait: a marker with no subject is not a wait', async () => {
  const { declaredWait } = await import('../src/journeys.js');
  for (const sham of ['[WAITING: none, continuing next vein]', '[WAITING: nothing]', '[WAITING: N/A]',
                      '[WAITING: no]', '[WAITING: -]', '[WAITING: not waiting on anything]', '[WAITING:   ]']) {
    assert.equal(declaredWait(`did stuff ${sham}`), undefined, sham);
  }
});

test('declaredWait: a real wait keeps its subject verbatim', async () => {
  const { declaredWait } = await import('../src/journeys.js');
  assert.equal(declaredWait('smelting [WAITING: 8 iron in the furnace at (12,64,-3), ~90s left]'),
    '8 iron in the furnace at (12,64,-3), ~90s left');
  assert.equal(declaredWait('[waiting: crops to grow overnight]'), 'crops to grow overnight');
  assert.equal(declaredWait('no marker at all'), undefined);
  // 'nonetheless' must not be read as 'none' — the check is word-anchored.
  assert.equal(declaredWait('[WAITING: nonetheless the furnace needs 40s]'), 'nonetheless the furnace needs 40s');
});

// ── issue #29: a crash in OUR process is not a lesson about the world ────
const { failureOwner, ledgerVerdict } = await import('../src/journeys.js');

test('failureOwner: our own defects, throttles and malformed history are crashes, not refusals', () => {
  // The live one: a plain object pushed into agent.messages by the voice rail.
  assert.equal(failureOwner(new TypeError('msg.clone is not a function')).endedBy, 'crash');
  assert.equal(failureOwner(Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' })).endedBy, 'crash');
  assert.equal(failureOwner(Object.assign(new Error('bad toolResult'), { name: 'ValidationException' })).endedBy, 'crash');
  assert.equal(failureOwner(Object.assign(new Error('socket hang up'), { name: 'ECONNRESET' })).endedBy, 'crash');
});

test('failureOwner: a world that refuses IS evidence', () => {
  // Tool errors are plain Errors carrying world facts — those are the real lessons.
  assert.equal(failureOwner(new Error('No iron_ore within 64 blocks.')).endedBy, 'error');
  assert.equal(failureOwner(new Error('Need 3x oak_planks but only have 1.')).endedBy, 'error');
});

test('ledgerVerdict: only refusals and doomed stops can call a goal too hard', () => {
  assert.equal(ledgerVerdict('goal'), 'completed');
  assert.equal(ledgerVerdict('error'), 'too_hard');
  assert.equal(ledgerVerdict('stopped', true), 'too_hard', 'the supervisor called it doomed');
  assert.equal(ledgerVerdict('stopped'), 'none', 'a plain stop is a change of mind');
  assert.equal(ledgerVerdict('crash'), 'none', 'issue #29: our bug must not blacklist the goal');
  assert.equal(ledgerVerdict('cap'), 'none', 'endurance is not achievement');
  assert.equal(ledgerVerdict('wall'), 'none');
  assert.equal(ledgerVerdict('process-death'), 'none');
  assert.equal(ledgerVerdict('stale'), 'none');
  assert.equal(ledgerVerdict(undefined), 'none');
});

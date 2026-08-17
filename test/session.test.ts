/**
 * Session sliding-window tests — the "no valid trim point" bug (issue #1).
 *
 * Agentic histories are long runs of toolUse/toolResult pairs; a clean
 * plain-user-text boundary often does not exist inside the window. The old
 * trim walked forward, found nothing, and silently kept EVERYTHING —
 * unbounded growth. chooseCut must be TOTAL: forward boundary, else backward
 * boundary, else a pair-safe cut with a synthesized user anchor.
 * Run: npm test (tsx --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Message, TextBlock } from '@strands-agents/sdk';
import { chooseCut, Session, type ForkFactory } from '../src/session.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const userText = (t = 'hi') => new Message({ role: 'user', content: [new TextBlock(t)] });
const assistantText = (t = 'ok') => new Message({ role: 'assistant', content: [new TextBlock(t)] });
const toolUse = (id: string) =>
  new Message({
    role: 'assistant',
    content: [{ type: 'toolUseBlock', toolUseId: id, name: 'look_around', input: {} } as never],
  });
const toolResult = (id: string) =>
  new Message({
    role: 'user',
    content: [{ type: 'toolResultBlock', toolUseId: id, status: 'success', content: [] } as never],
  });

/** n toolUse/toolResult pairs — the shape a long agentic turn leaves behind. */
function pairRun(n: number, prefix = 't'): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) out.push(toolUse(`${prefix}${i}`), toolResult(`${prefix}${i}`));
  return out;
}

const hasToolResult = (m: Message) => m.content?.some((c) => (c as { type?: string }).type === 'toolResultBlock');

/** The transcript invariants a provider enforces. */
function assertSane(msgs: Message[]) {
  assert.ok(msgs.length > 0, 'history not empty');
  assert.equal(msgs[0].role, 'user', 'head is a user message');
  assert.ok(!hasToolResult(msgs[0]), 'head carries no orphaned toolResult');
  // every toolResult's toolUse must be present earlier
  const uses = new Set<string>();
  for (const m of msgs) {
    for (const c of m.content ?? []) {
      const b = c as { type?: string; toolUseId?: string };
      if (b.type === 'toolUseBlock' && b.toolUseId) uses.add(b.toolUseId);
      if (b.type === 'toolResultBlock' && b.toolUseId)
        assert.ok(uses.has(b.toolUseId), `toolResult ${b.toolUseId} has its toolUse in-history`);
    }
  }
}

// ── chooseCut: pure boundary logic ──────────────────────────────────────────

test('chooseCut: under the window is a no-op', () => {
  const msgs = [userText(), assistantText()];
  assert.deepEqual(chooseCut(msgs, 10), { cut: 0, needsAnchor: false });
});

test('chooseCut: forward walk reuses a natural user boundary', () => {
  // [u, a, u, a, u, a] window 3 → ideal 3, msgs[4] is the next clean user
  const msgs = [userText(), assistantText(), userText(), assistantText(), userText(), assistantText()];
  const { cut, needsAnchor } = chooseCut(msgs, 3);
  assert.equal(needsAnchor, false);
  assert.equal(msgs[cut].role, 'user');
  assert.ok(cut >= 3, 'forward from the ideal cut');
});

test('chooseCut: no boundary ahead → backward walk trims less, never nothing', () => {
  // one clean user at index 1, then pure pairs to the end
  const msgs = [userText('a'), userText('b'), ...pairRun(20)];
  const { cut, needsAnchor } = chooseCut(msgs, 10);
  assert.equal(needsAnchor, false);
  assert.equal(cut, 1, 'falls back to the clean user boundary behind the ideal cut');
});

test('chooseCut: pairs spanning the WHOLE window → pair-safe cut + synthesized anchor', () => {
  // the exact live shape: window full of toolUse/toolResult, head user long gone
  const msgs = [userText(), ...pairRun(80)]; // 161 msgs
  const { cut, needsAnchor } = chooseCut(msgs, 40);
  assert.ok(cut > 0, 'MUST reduce — the old code returned nothing here');
  assert.equal(needsAnchor, true, 'no natural boundary → anchor required');
  const head = msgs[cut];
  assert.ok(!hasToolResult(head), 'never cuts between a toolUse and its toolResult');
  const kept = msgs.slice(cut);
  assert.ok(kept.length <= 41, 'reduced to roughly the window');
});

test('chooseCut: cut lands ON a toolResult head → advances past the orphan', () => {
  const msgs = [userText(), ...pairRun(50)];
  // pick a window that puts the ideal cut on a toolResult (odd offset)
  const win = 41; // ideal = 101 - 41 = 60 → msgs[60] is a toolResult (pairs start at 1)
  const { cut } = chooseCut(msgs, win);
  assert.ok(!hasToolResult(msgs[cut]), 'head after cut is not an orphaned toolResult');
});

// ── Session.trim end to end (fake agents) ───────────────────────────────────

type FakeAgent = { messages: Message[]; invoke: (t: string) => Promise<string> };

function makeSession(rootMessages: Message[], rootDelayMs = 0) {
  const root: FakeAgent = {
    messages: rootMessages,
    invoke: async (t: string) => {
      await new Promise((r) => setTimeout(r, rootDelayMs));
      root.messages.push(userText(t), assistantText(`root: ${t}`));
      return `root: ${t}`;
    },
  };
  const forks: FakeAgent[] = [];
  const forkFactory: ForkFactory = ((seed: Message[]) => {
    const fork: FakeAgent = {
      messages: [...seed],
      invoke: async (t: string) => {
        fork.messages.push(userText(t), ...pairRun(3, `f${forks.length}-`), assistantText(`fork: ${t}`));
        return `fork: ${t}`;
      },
    };
    forks.push(fork);
    return fork;
  }) as unknown as ForkFactory;
  return { session: new Session(root as never, forkFactory), root, forks };
}

test('Session: fold-back over a pair-saturated history trims AND stays provider-sane', async () => {
  // history already over-window with pure pairs — the old trim gave up here
  const { session, root } = makeSession([userText('start'), ...pairRun(100)], 30);
  const before = root.messages.length; // 201 > 120
  // concurrent asks: first takes root (slow), second forks and folds back
  const [a, b] = await Promise.all([session.ask('one'), session.ask('two')]);
  assert.match(a, /root/);
  assert.match(b, /fork/);
  assert.ok(root.messages.length < before, `history reduced (${before} → ${root.messages.length})`);
  assert.ok(root.messages.length <= 121 + 8, 'bounded near the window');
  assertSane(root.messages);
});

test('Session: repeated folds never grow unbounded', async () => {
  const { session, root } = makeSession([userText('start'), ...pairRun(70)], 15);
  for (let round = 0; round < 5; round++) {
    await Promise.all([session.ask(`r${round}-a`), session.ask(`r${round}-b`)]);
  }
  assert.ok(root.messages.length <= 130, `stays bounded, got ${root.messages.length}`);
  assertSane(root.messages);
});

// ── issue #2: fold-back must not land inside the root's in-flight turn ──────

test('Session: fork completing mid-root-turn queues its fold until the seam closes', async () => {
  // Root turn opens a toolUse, WAITS (tool executing), then appends the
  // toolResult — the exact window where an eager fold used to splice foreign
  // messages between the pair and corrupt the transcript for the provider.
  const messages: Message[] = [userText('start')];
  let releaseTool!: () => void;
  const toolDone = new Promise<void>((r) => (releaseTool = r));
  const root = {
    messages,
    invoke: async (t: string) => {
      messages.push(userText(t), toolUse('root-1'));
      await toolDone; // tool "runs" — the seam is open
      messages.push(toolResult('root-1'), assistantText(`root: ${t}`));
      return `root: ${t}`;
    },
  };
  const forkFactory = ((seed: Message[]) => {
    const fork = {
      messages: [...seed],
      invoke: async (t: string) => {
        fork.messages.push(userText(t), assistantText(`fork: ${t}`));
        return `fork: ${t}`;
      },
    };
    return fork;
  }) as unknown as ForkFactory;
  const session = new Session(root as never, forkFactory);

  const rootTurn = session.ask('slow');
  await new Promise((r) => setTimeout(r, 10)); // let the root open its seam
  const forkResult = await session.ask('fast'); // completes while seam is OPEN
  assert.equal(forkResult, 'fork: fast', 'fork answers immediately');

  // The fold must NOT have landed yet — the seam is still open.
  assert.ok(
    !messages.some((m) => m.content?.some((c) => (c as { type?: string; text?: string }).text === 'fork: fast')),
    'fold is parked while the root turn is in flight',
  );
  const seamIndex = messages.findIndex((m) =>
    m.content?.some((c) => (c as { type?: string }).type === 'toolUseBlock'),
  );
  assert.ok(seamIndex >= 0);

  releaseTool();
  await rootTurn;

  // Now the fold has landed — AFTER the root's completed turn, seam intact.
  const idx = (pred: (m: Message) => boolean) => messages.findIndex(pred);
  const resultIdx = idx((m) => m.content?.some((c) => (c as { type?: string }).type === 'toolResultBlock') ?? false);
  const foldIdx = idx((m) => m.content?.some((c) => (c as { text?: string }).text === 'fork: fast') ?? false);
  assert.equal(resultIdx, seamIndex + 1, 'toolResult immediately follows its toolUse — nothing spliced between');
  assert.ok(foldIdx > resultIdx, 'fold landed after the root turn finished');
  assertSane(messages);
});

test('Session: multiple forks parked mid-turn flush in completion order, then trim', async () => {
  const base = [userText('start'), ...pairRun(65)]; // over-window after folds
  let releaseTool!: () => void;
  const toolDone = new Promise<void>((r) => (releaseTool = r));
  const root = {
    messages: base,
    invoke: async (t: string) => {
      base.push(userText(t), toolUse('r1'));
      await toolDone;
      base.push(toolResult('r1'), assistantText('root done'));
      return 'root done';
    },
  };
  let n = 0;
  const forkFactory = ((seed: Message[]) => {
    const id = n++;
    const fork = {
      messages: [...seed],
      invoke: async (t: string) => {
        await new Promise((r) => setTimeout(r, id === 0 ? 25 : 5)); // fork 1 beats fork 0
        fork.messages.push(userText(t), assistantText(`fork${id}: ${t}`));
        return `fork${id}: ${t}`;
      },
    };
    return fork;
  }) as unknown as ForkFactory;
  const session = new Session(root as never, forkFactory);

  const rootTurn = session.ask('slow');
  await new Promise((r) => setTimeout(r, 5));
  const forks = Promise.all([session.ask('a'), session.ask('b')]);
  await forks;
  releaseTool();
  await rootTurn;

  const text = (m: Message) => (m.content?.[0] as { text?: string })?.text ?? '';
  const i0 = base.findIndex((m) => text(m) === 'fork0: a');
  const i1 = base.findIndex((m) => text(m) === 'fork1: b');
  assert.ok(i0 > 0 && i1 > 0, 'both folds landed');
  assert.ok(i1 < i0, 'completion order preserved (fork1 finished first)');
  assert.ok(base.length <= 121, `flush trims once after landing (got ${base.length})`);
  assertSane(base);
});

// ── provider failures: named, dumped, and retried when it is not our fault ──
// (issue #14: one `Bedrock is unable to process your request.` during a
// concurrent fold, with no error class in the log to accuse or exonerate us)

/** An agent whose invoke fails the first n times with `err`. */
function flakyAgent(err: unknown, failures: number) {
  const agent = {
    messages: [userText('start')] as Message[],
    calls: [] as (string | undefined)[],
    invoke: async (t?: string) => {
      agent.calls.push(t);
      // the SDK appends the user message BEFORE the model call, and does NOT
      // roll it back on failure — reproduce that, it's what makes a naive
      // retry dangerous
      if (t !== undefined) agent.messages.push(userText(t));
      if (agent.calls.length <= failures) throw err;
      agent.messages.push(assistantText(`ok: ${t ?? '(resumed)'}`));
      return `ok: ${t ?? '(resumed)'}`;
    },
  };
  return agent;
}

test('Session: a throttle buys ONE retry, and the retry does not re-ask (no double user message)', async () => {
  const throttle = Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' });
  const agent = flakyAgent(throttle, 1);
  const session = new Session(agent as never, (() => { throw new Error('no fork expected'); }) as never);
  const reports: string[] = [];
  session.onDiagnosis = (r) => reports.push(r);
  process.env.THROTTLE_RETRY_MS = '0';

  const answer = await session.ask('build a base');
  assert.equal(answer, 'ok: (resumed)');
  assert.deepEqual(agent.calls, ['build a base', undefined], 'the retry resumes from history instead of re-appending the text');
  assertSane(agent.messages);
  assert.equal(agent.messages.filter((m) => m.role === 'user').length, 2, 'start + our one ask — not two asks');
  assert.match(reports[0], /ThrottlingException kind=throttling retryable=true/);
  assert.match(reports[0], /history is well-formed — this was the provider/);
  assert.match(reports[1], /retrying once after throttling .*resuming from history/);
  delete process.env.THROTTLE_RETRY_MS;
});

test('Session: a ValidationException is NOT retried — it throws, with the shape in the report', async () => {
  const invalid = Object.assign(new Error('messages malformed'), { name: 'ValidationException' });
  const agent = flakyAgent(invalid, 99);
  // a history with a split pair, exactly what such an error accuses us of
  agent.messages = [userText('start'), toolUse('t1'), assistantText('narrating')];
  const session = new Session(agent as never, (() => { throw new Error('no fork'); }) as never);
  const reports: string[] = [];
  session.onDiagnosis = (r) => reports.push(r);

  await assert.rejects(() => session.ask('dig down'), /messages malformed/);
  assert.equal(agent.calls.length, 1, 'resending a corrupt history would just fail again');
  assert.match(reports[0], /ValidationException kind=validation retryable=false/);
  assert.match(reports[0], /history is MALFORMED: toolUse t1 .* has NO toolResult \(split pair\)/);
  assert.match(reports[0], /shape: u\+t a\[use:t1 look_around\]/);
});

test('Session: the bare Bedrock sentence is reported verbatim and left unretried', async () => {
  // The live line. No class ⇒ no verdict ⇒ no blind retry, but the shape is
  // dumped so the next occurrence can be judged instead of guessed.
  const bare = new Error('Bedrock is unable to process your request.');
  const agent = flakyAgent(bare, 99);
  const session = new Session(agent as never, (() => { throw new Error('no fork'); }) as never);
  const reports: string[] = [];
  session.onDiagnosis = (r) => reports.push(r);
  await assert.rejects(() => session.ask('hey'), /unable to process/);
  assert.equal(agent.calls.length, 1);
  assert.match(reports[0], /kind=unknown retryable=false/);
  assert.match(reports[0], /shape: u\+t u\+t/);
});

test('Session: HISTORY_AUDIT catches a fold that splits a pair', async () => {
  process.env.HISTORY_AUDIT = 'true'; // read per call, so no fresh module needed
  const root = {
    messages: [userText('start')] as Message[],
    invoke: async (t: string) => { await new Promise((r) => setTimeout(r, 20)); root.messages.push(userText(t), assistantText('root')); return 'root'; },
  };
  // a fork that returns a toolUse with no matching result — the exact corruption
  const forkFactory = ((seed: Message[]) => {
    const fork = {
      messages: [...seed] as Message[],
      invoke: async (t: string) => { fork.messages.push(userText(t), toolUse('use_orphan')); return 'fork'; },
    };
    return fork;
  }) as never;
  const session = new Session(root as never, forkFactory);
  const reports: string[] = [];
  session.onDiagnosis = (r) => reports.push(r);

  const rootTurn = session.ask('root work');
  await new Promise((r) => setTimeout(r, 5));
  await session.ask('chat while busy');   // forks, folds after the root's seam
  await rootTurn;
  assert.ok(reports.some((r) => /HISTORY AUDIT FAILED after (fold|flush)/.test(r)), `no audit failure in ${reports.length} report(s)`);
  assert.ok(reports.some((r) => /toolUse orphan .* has NO toolResult/.test(r)));
  delete process.env.HISTORY_AUDIT;
});

// ── issue #25: a fork must not inherit another rail's pending question ───────

test('Session: a fork seeded during a root turn cannot see the root question', async () => {
  // The live shape: a journey step is the root turn, a web ask arrives mid-step.
  const root: FakeAgent = {
    messages: [userText('history')],
    invoke: async (t: string) => {
      root.messages.push(userText(t));            // the SDK appends before the model call
      await new Promise((r) => setTimeout(r, 30)); // …the model is thinking…
      root.messages.push(assistantText(`root: ${t}`));
      return `root: ${t}`;
    },
  };
  const seeds: Message[][] = [];
  const forkFactory: ForkFactory = ((seed: Message[]) => {
    seeds.push(seed);
    const fork: FakeAgent = {
      messages: [...seed],
      invoke: async (t: string) => {
        fork.messages.push(userText(t), assistantText(`fork: ${t}`));
        return `fork: ${t}`;
      },
    };
    return fork;
  }) as unknown as ForkFactory;
  const session = new Session(root as never, forkFactory);

  const journey = session.ask('[journey] take the NEXT step toward the furnace');
  await new Promise((r) => setTimeout(r, 5)); // the root's user message has landed
  const web = await session.ask('hire a worker named SoakHand');
  const j = await journey;

  assert.equal(web, 'fork: hire a worker named SoakHand', 'the asker gets THEIR answer');
  assert.equal(j, 'root: [journey] take the NEXT step toward the furnace');
  const texts = seeds[0].flatMap((m) => (m.content ?? []).map((c) => (c as { text?: string }).text ?? ''));
  assert.ok(!texts.some((t) => t.includes('[journey]')), 'the journey prompt is NOT in the seed');
  assert.deepEqual(texts, ['history'], 'seed is the history as of the turn boundary');
});

test('Session: with the root idle, a fork still seeds from the whole history', async () => {
  const { session, forks } = makeSession([userText('start'), assistantText('ok')]);
  await session.ask('first');                       // root path — lands in history
  const a = session.ask('second');                  // root path again
  const b = await session.ask('third');             // forks off a complete history
  await a;
  assert.equal(b, 'fork: third');
  const seedTexts = forks[0].messages.slice(0, 4).flatMap((m) =>
    (m.content ?? []).map((c) => (c as { text?: string }).text ?? ''));
  assert.ok(seedTexts.includes('root: first'), 'the completed root turn IS inherited');
  assert.ok(!seedTexts.includes('second'), 'the in-flight one is not');
});

// ── healHistory: the msg.clone landmine, defused ────────────────────────────
test('healHistory rehydrates plain-object messages in place (the ouch bug)', async () => {
  const { healHistory } = await import('../src/history-doctor.js');
  const { Message, TextBlock } = await import('@strands-agents/sdk');
  const real = new Message({ role: 'user', content: [new TextBlock('hi')] });
  const msgs: unknown[] = [
    real,
    { role: 'user', content: [{ text: '(voice) status?' }] }, // the literal a rail once pushed
    { role: 'assistant', content: [{ toolUse: { toolUseId: 'x1', name: 'dig_block', input: {} } }] },
  ];
  const healed = healHistory(msgs);
  assert.deepEqual(healed, [1, 2], 'names the exact indices so the guilty rail is findable');
  assert.equal(msgs[0], real, 'healthy instances are untouched');
  for (const m of msgs) {
    const c = (m as { clone: () => unknown }).clone(); // this exact call bricked every turn
    assert.ok(c, 'every message survives the SDK per-call clone');
  }
  assert.deepEqual(healHistory(msgs), [], 'second pass finds nothing — healing converges');
});

// ── issue #39: the empty-text brick heals in place, instead of costing every
// future turn on every rail until the window slides past it ─────────────────
test('Session: an empty-text refusal is healed and the turn retried (#39)', async () => {
  const brick = Object.assign(
    new Error('The model returned the following errors: messages: text content blocks must be non-empty'),
    { statusCode: 400 },
  );
  const agent = flakyAgent(brick, 1);
  // what a wordless voice turn left behind, sitting early in the history
  agent.messages = [userText('start'), assistantText(''), userText('mid')];
  const session = new Session(agent as never, (() => { throw new Error('no fork'); }) as never);
  const reports: string[] = [];
  session.onDiagnosis = (r) => reports.push(r);

  const answer = await session.ask('go mine iron');
  assert.equal(answer, 'ok: (resumed)', 'the same turn completes — no rail should die of this');
  assert.deepEqual(agent.calls, ['go mine iron', undefined], 'resumed from history, never re-asked');
  assert.equal(
    agent.messages.filter((m) => m.content.some((b) => (b as { text?: string }).text?.trim() === '')).length,
    0,
    'the wordless block is gone from the history, not merely reported',
  );
  assert.match(reports[0], /kind=history-empty-text/);
  assert.doesNotMatch(reports[0], /this was the provider, not our transcript/);
  assert.match(reports[1], /healed empty text/);
});

test('Session: an empty-text refusal with nothing to heal says so, and still throws (#39)', async () => {
  const brick = Object.assign(new Error('messages: text content blocks must be non-empty'), { statusCode: 400 });
  const agent = flakyAgent(brick, 99);
  const session = new Session(agent as never, (() => { throw new Error('no fork'); }) as never);
  const reports: string[] = [];
  session.onDiagnosis = (r) => reports.push(r);

  await assert.rejects(() => session.ask('hello'), /non-empty/);
  assert.match(reports.join('\n'), /no empty block in this history/, 'no blind retry into the same refusal');
  assert.equal(agent.calls.length, 1);
});

test('Session: an empty prompt is refused at the door, never sent (#39)', async () => {
  const agent = flakyAgent(new Error('unused'), 0);
  const session = new Session(agent as never, (() => { throw new Error('no fork'); }) as never);
  await assert.rejects(() => session.ask('   \n '), /refusing an empty prompt/);
  assert.equal(agent.calls.length, 0, 'the provider must never see a wordless user block');
});

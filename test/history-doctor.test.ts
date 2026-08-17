/**
 * The history doctor (issue #14): `Bedrock is unable to process your request.`
 * is one sentence worn by a malformed transcript, a throttle and a service
 * blip. These tests pin the three apart, and pin the shape dump to ids only —
 * a log line about a corrupt history must not leak the conversation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditHistory, classifyProviderError, diagnose, healEmptyText, historyShape, isEmptyTextBlock, textMessage } from '../src/history-doctor.js';

const u = (extra: object[] = []) => ({ role: 'user', content: [{ type: 'textBlock', text: 'hi' }, ...extra] });
const a = (extra: object[] = []) => ({ role: 'assistant', content: [{ type: 'textBlock', text: 'ok' }, ...extra] });
const use = (id: string, name = 'dig_block') => ({ role: 'assistant', content: [{ type: 'toolUseBlock', toolUseId: id, name, input: {} }] });
const res = (id: string) => ({ role: 'user', content: [{ type: 'toolResultBlock', toolUseId: id, status: 'success', content: [] }] });

// ── error classification ────────────────────────────────────────────────────

test('ValidationException accuses our history; ThrottlingException exonerates it', () => {
  const v = classifyProviderError(Object.assign(new Error('The messages array is malformed'), { name: 'ValidationException' }));
  assert.equal(v.kind, 'validation');
  assert.equal(v.name, 'ValidationException');
  assert.equal(v.retryable, false, 'resending a corrupt history just fails again');

  const t = classifyProviderError(Object.assign(new Error('Too many requests'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }));
  assert.equal(t.kind, 'throttling');
  assert.equal(t.status, 429);
  assert.equal(t.retryable, true);
});

test('transient service errors and socket deaths are retryable', () => {
  for (const e of [
    Object.assign(new Error('Service is unavailable'), { name: 'ServiceUnavailableException' }),
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } }),
  ]) {
    const p = classifyProviderError(e);
    assert.equal(p.kind, 'transient', p.message);
    assert.equal(p.retryable, true);
  }
});

test('a stream that died mid-message is transient and retryable', () => {
  // The exact string from the live 4-bot soak. Bedrock's ConverseStream ended
  // before messageStop — nothing about our history caused it, and resending the
  // same turn usually completes. It was falling through to unknown/non-retryable,
  // so every occurrence became an in-game 'ouch' and killed journeys.
  for (const e of [
    new Error('Stream ended without completing a message'),
    Object.assign(new Error('stream interrupted'), { name: 'ModelStreamErrorException' }),
  ]) {
    const p = classifyProviderError(e);
    assert.equal(p.kind, 'transient', p.message);
    assert.equal(p.retryable, true);
  }
});

test('the bare Bedrock sentence stays UNKNOWN instead of inventing a verdict', () => {
  // This is the exact string from the live log. It names no class, so the
  // honest answer is "unknown" — and unknown must not be retried blindly.
  const p = classifyProviderError(new Error('Bedrock is unable to process your request.'));
  assert.equal(p.kind, 'unknown');
  assert.equal(p.retryable, false);
  assert.equal(p.name, 'Error');
});

test('a class hidden on cause or __type is still found', () => {
  const wrapped = Object.assign(new Error('model call failed'), {
    cause: Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' }),
  });
  const p = classifyProviderError(wrapped);
  assert.equal(p.name, 'ThrottlingException');
  assert.equal(p.kind, 'throttling');
  assert.equal(classifyProviderError({ __type: 'ValidationException', message: 'nope' }).kind, 'validation');
  // never throws on junk
  assert.equal(classifyProviderError(undefined).kind, 'unknown');
  assert.equal(classifyProviderError('a string').kind, 'unknown');
});

// ── shape: ids only, no content ─────────────────────────────────────────────

test('historyShape renders roles and tool pairs, and leaks nothing else', () => {
  const shape = historyShape([
    u(), use('tooluse_abc123456', 'dig_block'), res('tooluse_abc123456'), a(),
  ]);
  assert.equal(shape, 'u+t a[use:123456 dig_block] u[res:123456] a+t');
  // the guarantee: tool NAMES are useful and safe, message text and full ids are not
  assert.ok(!shape.includes('hi') && !shape.includes('ok'), 'no message text');
  assert.ok(!shape.includes('tooluse_abc123456'), 'ids are truncated');
  const withSecrets = historyShape([{ role: 'user', content: [{ type: 'textBlock', text: 'my password is hunter2' }] }]);
  assert.equal(withSecrets, 'u+t', 'text content never appears');
});

// ── the audit: every way a provider says no ─────────────────────────────────

test('a well-formed agentic history passes', () => {
  const audit = auditHistory([u(), use('t1'), res('t1'), a(), u(), use('t2'), res('t2'), a()]);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.problems, []);
  assert.deepEqual(audit.counts, { messages: 8, toolUses: 2, toolResults: 2 });
});

test('a toolUse whose result was dropped is named — the fold/trim casualty', () => {
  const audit = auditHistory([u(), use('t1'), a()]);
  assert.equal(audit.ok, false);
  assert.match(audit.problems[0], /toolUse t1 at message 1 has NO toolResult \(split pair\)/);
});

test('an orphan toolResult is named — a trim that cut through a pair', () => {
  const audit = auditHistory([res('t1'), a()]);
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => /orphan toolResult t1/.test(p)));
  assert.ok(audit.problems.some((p) => /starts with 'user'/.test(p)) === false, 'a user-role head is fine even carrying a result');
});

test('a result BEFORE its use is named — an out-of-order fold', () => {
  const audit = auditHistory([u(), res('t1'), use('t1')]);
  assert.equal(audit.ok, false);
  assert.match(audit.problems.join(' '), /toolResult t1 at message 1 precedes its toolUse at 2 \(out-of-order fold\)/);
});

test('a history folded twice is named — duplicate ids', () => {
  const audit = auditHistory([u(), use('t1'), res('t1'), use('t1'), res('t1')]);
  assert.equal(audit.ok, false);
  assert.match(audit.problems.join(' '), /duplicate toolUse t1 \(messages 1 and 3\)/);
  assert.match(audit.problems.join(' '), /duplicate toolResult t1 \(messages 2 and 4\)/);
});

test('an assistant-first history is named — providers want a user message first', () => {
  const audit = auditHistory([a(), u()]);
  assert.equal(audit.ok, false);
  assert.match(audit.problems.join(' '), /starts with 'assistant'/);
  assert.equal(auditHistory([]).ok, true, 'empty is not malformed');
});

// ── the report ──────────────────────────────────────────────────────────────

test('diagnose separates "our fault" from "their fault" in one block', () => {
  const throttle = Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' });
  const good = diagnose(throttle, [u(), use('t1'), res('t1'), a()]);
  assert.match(good, /ThrottlingException kind=throttling retryable=true/);
  assert.match(good, /history is well-formed — this was the provider, not our transcript/);
  assert.match(good, /shape: u\+t a\[use:t1 dig_block\] u\[res:t1\] a\+t/);

  const bad = diagnose(new Error('Bedrock is unable to process your request.'), [u(), use('t1'), a()]);
  assert.match(bad, /history is MALFORMED: toolUse t1 .* has NO toolResult/);

  // the ambiguous case worth calling out loud: provider says invalid, we look fine
  const puzzling = diagnose(Object.assign(new Error('bad request'), { name: 'ValidationException' }), [u(), a()]);
  assert.match(puzzling, /history looks WELL-FORMED yet the provider called it invalid/);
});

// ── the soak's bricked mind: our defect, wearing the provider's clothes ──────

test('a TypeError is OUR defect — it never crossed the wire', () => {
  const p = classifyProviderError(new TypeError('msg.clone is not a function'));
  assert.equal(p.kind, 'local');
  assert.equal(p.retryable, false, 'retrying our own crash just crashes again');
  const report = diagnose(new TypeError('msg.clone is not a function'), [
    { role: 'user', content: [{ type: 'textBlock', text: 'hi' }] },
  ]);
  assert.match(report, /OUR defect/);
  assert.doesNotMatch(report, /this was the provider/, 'the line that misled the soak for a whole session');
});

test('a thrown-in-process TypeError is not confused with a service error', () => {
  // The wire-crossing ones keep their classes.
  assert.equal(classifyProviderError({ name: 'ThrottlingException', message: 'slow down' }).kind, 'throttling');
  assert.equal(classifyProviderError({ name: 'TypeError', message: 'x', $metadata: { httpStatusCode: 500 } }).kind,
    'transient', 'a TypeError with HTTP metadata came from the SDK layer, not our code');
});

test('audit names a plain-object message before the SDK trips over it', () => {
  const real = { role: 'user', content: [{ type: 'textBlock', text: 'hi' }], clone: () => real };
  const plain = { role: 'assistant', content: [{ text: 'pushed by hand' }] }; // no clone()
  const a = auditHistory([real, plain] as never, { requireInstances: true });
  assert.equal(a.ok, false);
  assert.match(a.problems.join(' '), /message\(s\) 1 are not Message instances/);
  assert.ok(auditHistory([real] as never, { requireInstances: true }).ok, 'real Messages pass');
  const plainUser = { role: 'user', content: [{ type: 'textBlock', text: 'hi' }] };
  assert.ok(auditHistory([plainUser] as never).ok, 'and a shape fixture is plain by design — opt-in only');
  assert.equal(auditHistory([plainUser] as never, { requireInstances: true }).ok, false);
});

// ── issue #39: the empty text block, made visible and healable ─────────────
const EMPTY_400 = Object.assign(new Error('The model returned the following errors: messages: text content blocks must be non-empty'), { statusCode: 400 });
const empty = (role: 'user' | 'assistant', extra: object[] = []) => ({ role, content: [{ type: 'textBlock', text: '' }, ...extra] });

test('classifyProviderError: the empty-text 400 is OUR transcript, named (#39)', () => {
  const p = classifyProviderError(EMPTY_400);
  assert.equal(p.kind, 'history-empty-text', 'the live soak filed 14 of these as kind=unknown');
  assert.equal(p.status, 400);
  assert.equal(p.retryable, false, 'a blind retry re-sends the same poisoned history — heal first');
});

test('historyShape: an empty text block prints +∅, never +t (#39)', () => {
  assert.equal(historyShape([u(), empty('assistant')]), 'u+t a+∅');
  assert.equal(historyShape([{ role: 'assistant', content: [{ type: 'textBlock', text: 'ok' }, { type: 'textBlock', text: '  ' }] }]), 'a+t+∅');
});

test('auditHistory: names the message carrying the empty block (#39)', () => {
  const audit = auditHistory([u(), empty('assistant')]);
  assert.equal(audit.ok, false);
  assert.match(audit.problems.join(' '), /message\(s\) 1 carry an EMPTY text block/);
});

test('diagnose: never blames the provider for an error quoting our messages (#39)', () => {
  const out = diagnose(EMPTY_400, [u(), empty('assistant')]);
  assert.doesNotMatch(out, /this was the provider, not our transcript/);
  assert.match(out, /OUR transcript carries an empty text block/);
  // and when the window already slid past it, it still owns the defect
  assert.match(diagnose(EMPTY_400, [u(), a()]), /rejected OUR transcript/);
});

test('healEmptyText: strips the block, drops a blockless message, keeps the rest (#39)', () => {
  const msgs: unknown[] = [
    u(),
    { role: 'assistant', content: [{ type: 'textBlock', text: '' }, { type: 'toolUseBlock', toolUseId: 'abc123', name: 'dig_block', input: {} }] },
    empty('user'),
    a(),
  ];
  const r = healEmptyText(msgs);
  assert.deepEqual(r.stripped, [1], 'a turn that also called a tool keeps its toolUse');
  assert.deepEqual(r.removed, [2], 'nothing left to say = the message goes, no placeholder');
  assert.equal(msgs.length, 3);
  assert.equal(auditHistory(msgs as never).problems.filter((p) => /EMPTY text/.test(p)).length, 0);
});

test('textMessage: the one door into history refuses wordless text (#39)', () => {
  assert.equal(textMessage('assistant', ''), null);
  assert.equal(textMessage('assistant', '  \n '), null);
  const m = textMessage('user', ' hello ');
  assert.equal(typeof (m as { clone?: unknown })?.clone, 'function', 'must be a real Message — the SDK clones every one');
  assert.equal(isEmptyTextBlock({ text: '' }), true);
  assert.equal(isEmptyTextBlock({ type: 'toolUseBlock', toolUseId: 'x' }), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTurnScope, markSilent, isSilent, chatDisposition } from '../src/silence.js';

// 2026-10-04: "nothing to add — staying silent" was itself a chat line. A
// turn that calls stay_silent keeps its words off game chat.

test('stay_silent inside a turn marks THAT turn, through awaits', async () => {
  const r = await withTurnScope(async () => {
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(isSilent(), false);
    assert.equal(markSilent('peer small talk'), true);
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(isSilent(), true);
    return 'Nothing to add — staying quiet.';
  });
  assert.equal(r.silent, true);
  assert.equal(r.reason, 'peer small talk');
  assert.equal(r.result, 'Nothing to add — staying quiet.');
});

test('concurrent turns do not silence each other', async () => {
  const [a, b] = await Promise.all([
    withTurnScope(async () => { await new Promise((res) => setTimeout(res, 10)); markSilent(); return 'a'; }),
    withTurnScope(async () => { await new Promise((res) => setTimeout(res, 20)); return 'b'; }),
  ]);
  assert.equal(a.silent, true);
  assert.equal(b.silent, false);
});

test('outside any turn, markSilent is an honest no-op', () => {
  assert.equal(markSilent(), false);
  assert.equal(isSilent(), false);
});

test('disposition: silent turns log, never say; empty answers never say', () => {
  assert.deepEqual(chatDisposition('ok then', true), { say: false, log: '🤫 (silent) ok then' });
  assert.deepEqual(chatDisposition('ok then', false), { say: true, log: '🤖 ok then' });
  assert.equal(chatDisposition('   ', false).say, false);
});

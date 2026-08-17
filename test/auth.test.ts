/**
 * web/auth token tests — issue #3: a malformed cookie must be a quiet "not
 * authenticated" (→ 401 at the route layer), never a thrown RangeError from
 * timingSafeEqual's unequal-length precondition (which the catch-all turned
 * into a 400 + stack noise on a PUBLIC tunnel route).
 * Run: npm test (tsx --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

// auth.ts resolves its store path and AUTH_DISABLED at module load — isolate
// BEFORE the dynamic import, and make sure auth is NOT disabled for these.
process.env.WEB_AUTH_STORE = join(mkdtempSync(join(tmpdir(), 'sm-auth-')), 'web_auth.json');
delete process.env.WEB_AUTH_DISABLED;

const { issueToken, verifyToken } = await import('../src/web/auth.js');

test('verifyToken: a freshly issued token verifies', () => {
  assert.equal(verifyToken(issueToken()), true);
});

test('verifyToken: malformed cookies return false, never throw', () => {
  const cases = [
    undefined,
    '',
    'no-dot-at-all',
    'payload.',
    '.signature',
    'a.b', // wrong-length sig — the old timingSafeEqual RangeError case
    'garbage.tooshort',
    `${'x'.repeat(500)}.${'y'.repeat(3)}`, // grossly unequal lengths
    'AAAA.!!!not-base64url!!!',
    '\u0000\u0001.\u0002', // control garbage
    issueToken() + 'tampered', // valid token + suffix breaks the sig length
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => verifyToken(c), `did not throw for ${JSON.stringify(c)}`);
    assert.equal(verifyToken(c), false, `rejected ${JSON.stringify(c)}`);
  }
});

test('verifyToken: right-length but wrong signature is rejected', () => {
  const [payload, sig] = issueToken().split('.');
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1); // same length, wrong value
  assert.equal(verifyToken(`${payload}.${flipped}`), false);
});

test('verifyToken: tampered payload with the original signature is rejected', () => {
  const [, sig] = issueToken().split('.');
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 10 * 60_000 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`), false);
});

test('verifyToken: expired token signed with the REAL secret is rejected', () => {
  // The store file holds the signing secret — forge a correctly-signed but
  // expired token to prove expiry is enforced after the signature passes.
  const { secret } = JSON.parse(readFileSync(process.env.WEB_AUTH_STORE!, 'utf8')) as { secret: string };
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  assert.equal(verifyToken(`${payload}.${sig}`), false);
});

// ── dev mode trusts the machine, never the tunnel ───────────────────────────
test('WEB_AUTH_DISABLED bypasses only local, untunneled requests', async () => {
  process.env.WEB_AUTH_DISABLED = 'true';
  const { authBypassed } = await import('../src/web/auth.js');
  const req = (ip: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: ip }, headers });
  assert.equal(authBypassed(req('127.0.0.1')), true, 'a localhost curl sails through');
  assert.equal(authBypassed(req('::1')), true);
  assert.equal(authBypassed(req('::ffff:127.0.0.1')), true);
  // cloudflared connects FROM loopback but stamps the real client — gate it.
  assert.equal(authBypassed(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })), false, 'tunneled = remote, needs a passkey');
  assert.equal(authBypassed(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false);
  assert.equal(authBypassed(req('192.168.1.50')), false, 'LAN neighbors are not this machine');
});

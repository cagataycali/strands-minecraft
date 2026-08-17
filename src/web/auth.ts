/**
 * 🔐 Passkey gate — the neon-the-g1 auth model, ported to Node.
 *
 * The bot is about to get a public URL (minecraft.yourdomain.com); without a gate,
 * anyone who finds it can drive the bot and read the player's world. Same fix
 * as the rover: WebAuthn passkeys. The private key never leaves the phone's
 * secure enclave — enrolling once means Face ID forever after, nothing to
 * phish, nothing to leak.
 *
 * Flow (identical to neon):
 *   1. FIRST RUN — no credentials → the page shows "Create passkey". First
 *      enrollment is open (or gated by WEB_BOOTSTRAP_TOKEN if set); every
 *      enrollment after the first requires an authenticated session.
 *   2. LOGIN — challenge → sign with passkey → HttpOnly session cookie (HMAC
 *      token, 24h). A cookie rather than a Bearer header because the two
 *      streams that matter — <img src=/stream.mjpeg> and EventSource — can't
 *      set headers on iOS.
 *   3. GUARD — everything except / and /auth/* requires the cookie.
 *
 * Storage: credentials + signing secret in one chmod-600 JSON file,
 * .web_auth.json — self-contained, no DB. WEB_AUTH_DISABLED=true for LAN dev.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const STORE_PATH = process.env.WEB_AUTH_STORE ?? path.join(process.cwd(), '.web_auth.json');
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const AUTH_DISABLED = process.env.WEB_AUTH_DISABLED === 'true';

interface StoredCredential {
  id: string; // base64url
  publicKey: string; // base64
  counter: number;
  transports?: string[];
  label: string;
}

interface Store {
  secret: string;
  credentials: StoredCredential[];
}

function loadStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Store;
  } catch {
    const fresh: Store = { secret: crypto.randomBytes(32).toString('base64url'), credentials: [] };
    saveStore(fresh);
    return fresh;
  }
}

function saveStore(s: Store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

const store = loadStore();

/** Resetting auth is `rm .web_auth.json` — no restart, no admin endpoint to
 *  secure. Before any decision that depends on credentials or the signing
 *  secret, notice the file changed (or vanished) and re-read it. A vanished
 *  file regenerates a fresh secret, which atomically invalidates every
 *  outstanding session cookie — exactly what "reset" should mean. */
function freshenStore() {
  let mtime = 0;
  try { mtime = fs.statSync(STORE_PATH).mtimeMs; } catch { /* deleted */ }
  if (mtime !== storeMtime) {
    const next = loadStore();
    store.secret = next.secret;
    store.credentials = next.credentials;
    try { storeMtime = fs.statSync(STORE_PATH).mtimeMs; } catch { storeMtime = 0; }
  }
}
let storeMtime = 0;
try { storeMtime = fs.statSync(STORE_PATH).mtimeMs; } catch { /* fresh */ }
/** Pending WebAuthn challenges, keyed by a short-lived random id the browser
 *  echoes back — in memory on purpose (a restart mid-ceremony just means
 *  tapping the button again). */
const challenges = new Map<string, { challenge: string; expires: number }>();

function stashChallenge(challenge: string): string {
  const key = crypto.randomBytes(16).toString('base64url');
  challenges.set(key, { challenge, expires: Date.now() + 5 * 60_000 });
  for (const [k, v] of challenges) if (v.expires < Date.now()) challenges.delete(k);
  return key;
}

function takeChallenge(key: string): string {
  const c = challenges.get(key);
  challenges.delete(key);
  if (!c || c.expires < Date.now()) throw new Error('Challenge expired — try again.');
  return c.challenge;
}

// ── session tokens: base64url(payload).hmac — small enough not to need JWT ──
export function issueToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', store.secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Does THIS request bypass auth? (dev mode + genuinely local, untunneled) */
export function authBypassed(req?: { socket?: { remoteAddress?: string }; headers?: Record<string, string | string[] | undefined> }): boolean {
  // Read live (not the import-time const): tests and hot config both flip it.
  if (process.env.WEB_AUTH_DISABLED !== 'true') return false;
  if (!req) return true;
  const ip = req.socket?.remoteAddress ?? '';
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const proxied = !!(req.headers?.['cf-connecting-ip'] || req.headers?.['x-forwarded-for']);
  return local && !proxied;
}

export function verifyToken(token: string | undefined, req?: { socket?: { remoteAddress?: string }; headers?: Record<string, string | string[] | undefined> }): boolean {
  // WEB_AUTH_DISABLED trusts only THIS MACHINE, not the internet: the
  // cloudflare tunnel ALSO connects from loopback, so a bare remoteAddress
  // check would wave the whole world through. Tunneled/proxied requests
  // always carry cf-connecting-ip / x-forwarded-for — their presence means
  // the caller is remote, and remote callers need a passkey session even in
  // dev mode. (A soak loop curling localhost:3008 stays frictionless; the
  // same URL through minecraft.yourdomain.com still asks for Face ID.)
  if (authBypassed(req)) return true;
  if (!token) return false;
  freshenStore();
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expect = crypto.createHmac('sha256', store.secret).update(payload).digest('base64url');
    // timingSafeEqual THROWS on unequal lengths — a malformed cookie must be
    // a quiet 401, not a RangeError that the catch-all turns into a 500/400.
    // Comparing HMACs of both sides keeps the comparison constant-time even
    // when lengths differ (length-checking first would leak the sig length,
    // harmless here, but this way there is no early exit at all).
    const a = crypto.createHmac('sha256', store.secret).update(sig).digest();
    const b = crypto.createHmac('sha256', store.secret).update(expect).digest();
    if (!crypto.timingSafeEqual(a, b)) return false;
    return (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number }).exp > Date.now();
  } catch {
    return false; // any parse/shape error is just "not authenticated"
  }
}

export function hasCredentials(): boolean {
  freshenStore();
  return store.credentials.length > 0;
}

// ── ceremonies ──────────────────────────────────────────────────────────────
export async function registerBegin(rpID: string, bootstrapToken?: string) {
  freshenStore();
  if (!hasCredentials() && process.env.WEB_BOOTSTRAP_TOKEN && bootstrapToken !== process.env.WEB_BOOTSTRAP_TOKEN) {
    throw new Error('Bootstrap token required for first enrollment.');
  }
  const options = await generateRegistrationOptions({
    rpName: 'StrandsBot · Minecraft',
    rpID,
    userName: 'admin',
    userID: Buffer.from('strandsbot-admin'),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    excludeCredentials: store.credentials.map((c) => ({ id: c.id })),
  });
  return { key: stashChallenge(options.challenge), options };
}

export async function registerFinish(rpID: string, origin: string, key: string, response: unknown, label: string) {
  const verification = await verifyRegistrationResponse({
    response: response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
    expectedChallenge: takeChallenge(key),
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
  if (!verification.verified || !verification.registrationInfo) throw new Error('Passkey verification failed.');
  const { credential } = verification.registrationInfo;
  store.credentials.push({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64'),
    counter: credential.counter,
    transports: credential.transports,
    label,
  });
  saveStore(store);
  return issueToken();
}

export async function loginBegin(rpID: string) {
  freshenStore();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: store.credentials.map((c) => ({
      id: c.id,
      transports: c.transports as never,
    })),
  });
  return { key: stashChallenge(options.challenge), options };
}

export async function loginFinish(rpID: string, origin: string, key: string, response: unknown) {
  const resp = response as Parameters<typeof verifyAuthenticationResponse>[0]['response'];
  const cred = store.credentials.find((c) => c.id === resp.id);
  if (!cred) throw new Error('Unknown passkey.');
  const verification = await verifyAuthenticationResponse({
    response: resp,
    expectedChallenge: takeChallenge(key),
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: cred.id,
      publicKey: Buffer.from(cred.publicKey, 'base64'),
      counter: cred.counter,
      transports: cred.transports as never,
    },
  });
  if (!verification.verified) throw new Error('Login verification failed.');
  cred.counter = verification.authenticationInfo.newCounter;
  saveStore(store);
  return issueToken();
}

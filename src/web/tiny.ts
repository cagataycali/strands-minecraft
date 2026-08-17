/**
 * 🔥 The tiny endpoint — the bot as a device on tiny.technology.
 *
 * tiny (the owner's personal AI) enrols this bot as an `endpoint` device and
 * dials OUT to the dashboard: the platform's relay POSTs `/api/chat {prompt}`
 * with a stored bearer, the iOS app reads `/api/telemetry` and
 * `/api/camera/snapshot` with the same bearer (chatgpt-plugin-tinyai
 * ENDPOINT_ACTIONS: chat · telemetry · snapshot). None of those callers can
 * hold a passkey — so next to the WebAuthn cookie there is ONE service token,
 * `TINY_TOKEN`, accepted three ways:
 *
 *   Authorization: Bearer <token>   the relay and the phone
 *   ?token=<token>                  an <img src=/api/stream.mjpeg> cannot set headers
 *   the mc_session cookie           the browser SPA, unchanged
 *
 * Fail closed: no TINY_TOKEN configured → every tiny route is 401 for a remote
 * caller (the loopback dev bypass in auth.ts still applies, and still refuses
 * anything that came through the tunnel — see auth.ts authBypassed).
 *
 * Everything here is PURE or nearly so: the gate, the limiter and the
 * telemetry shaper take plain objects so the tests never need a bot.
 */
import crypto from 'node:crypto';
import type { Bot } from 'mineflayer';

export const TINY_TOKEN_MIN = 32;

/** The configured token, or undefined when it is missing or too short to be one. */
export function tinyToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = (env.TINY_TOKEN ?? '').trim();
  return t.length >= TINY_TOKEN_MIN ? t : undefined;
}

/** Why the token is unusable — for /api/health's `auth.tiny_token` and the boot line. */
export function tinyTokenProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = (env.TINY_TOKEN ?? '').trim();
  if (!t) return 'TINY_TOKEN not set';
  if (t.length < TINY_TOKEN_MIN) return `TINY_TOKEN too short (${t.length} < ${TINY_TOKEN_MIN}) — openssl rand -hex 32`;
  return undefined;
}

/** Pull a presented token out of a request: bearer header first, then ?token=. */
export function presentedToken(
  headers: Record<string, string | string[] | undefined>,
  url: URL,
): string | undefined {
  const h = headers['authorization'];
  const auth = Array.isArray(h) ? h[0] : h;
  if (auth && /^bearer\s+/i.test(auth)) {
    const v = auth.replace(/^bearer\s+/i, '').trim();
    if (v) return v;
  }
  const q = url.searchParams.get('token');
  return q ? q : undefined;
}

/** Constant-time compare; unequal lengths compare HMACs so there is no early exit. */
export function tokenMatches(presented: string | undefined, want: string | undefined): boolean {
  if (!presented || !want) return false;
  const key = crypto.randomBytes(16);
  const a = crypto.createHmac('sha256', key).update(presented).digest();
  const b = crypto.createHmac('sha256', key).update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * 🚦 5 req/s per token (Scout's rule) — a token bucket keyed by the presented
 * token's hash, so a leaked token can burn at most 5 model turns a second and
 * the map can never hold more than the handful of tokens that were ever
 * presented (bounded by prune(): idle buckets are dropped by the sweep timer
 * web.ts already runs — MEMORY.md's rule that every collection has a cap).
 */
export interface RateLimiter {
  /** true = allowed, false = 429 */
  take: (key: string, now?: number) => boolean;
  prune: (now?: number) => number;
  size: () => number;
}

export function createRateLimiter(o: { perSecond?: number; burst?: number } = {}): RateLimiter {
  const rate = o.perSecond ?? 5;
  const burst = o.burst ?? rate;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take: (key, now = Date.now()) => {
      const k = crypto.createHash('sha256').update(key).digest('base64url').slice(0, 16);
      const b = buckets.get(k) ?? { tokens: burst, at: now };
      b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1_000) * rate);
      b.at = now;
      if (b.tokens < 1) { buckets.set(k, b); return false; }
      b.tokens -= 1;
      buckets.set(k, b);
      return true;
    },
    prune: (now = Date.now()) => {
      let n = 0;
      for (const [k, b] of buckets) if (now - b.at > 60_000) { buckets.delete(k); n++; }
      return n;
    },
    size: () => buckets.size,
  };
}

// ── telemetry ───────────────────────────────────────────────────────────────

export interface TelemetryExtras {
  /** What the mind is doing — from the same work() snapshot /api/state shows. */
  task?: { kind: 'idle' | 'turn' | 'journey' | 'fleet'; text: string; since_s: number };
  thinker?: { enabled: boolean; next_in_s: number | null };
  crew?: Array<{ name: string; job: string; alive: boolean }>;
  connection?: { connected: boolean; epoch: number; reconnects: number };
  mem?: { heapMb: number; limitMb: number | null };
}

export interface Telemetry {
  name: string;
  dimension: string | null;
  gamemode: string | null;
  pos: { x: number; y: number; z: number } | null;
  yaw: number | null;
  pitch: number | null;
  health: number | null;
  food: number | null;
  air: number | null;
  xp: number | null;
  time: { day: number; ticks: number; isDay: boolean } | null;
  weather: 'clear' | 'rain' | 'thunder' | null;
  biome: string | null;
  held: string | null;
  inventory: Array<{ name: string; count: number }>;
  nearby: { players: Array<{ name: string; dist: number }>; hostiles: Array<{ name: string; dist: number }> };
  task: TelemetryExtras['task'];
  thinker: TelemetryExtras['thinker'];
  crew: NonNullable<TelemetryExtras['crew']>;
  connection: TelemetryExtras['connection'];
  mem: TelemetryExtras['mem'];
  ts: number;
}

/** mineflayer's hostile set — the names the reflexes treat as threats. */
export const HOSTILE_KINDS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'drowned', 'husk',
  'stray', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'zombie_villager', 'silverfish', 'endermite',
  'blaze', 'ghast', 'magma_cube', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'warden', 'guardian',
  'elder_guardian', 'shulker', 'vex', 'bogged', 'breeze',
]);

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Shape the live bot into the fixture's telemetry — one place, so the web rail,
 * the tests and tinyai-id's decoders agree on every field. Tolerates a bot that
 * is mid-reconnect (entity undefined) by nulling what it cannot read: a phone
 * must still be able to render "not in the world" rather than get a 500.
 */
export function shapeTelemetry(bot: Partial<Bot> & { username?: string }, extra: TelemetryExtras = {}, now = Date.now()): Telemetry {
  const ent = bot.entity;
  const pos = ent?.position ? { x: r1(ent.position.x), y: r1(ent.position.y), z: r1(ent.position.z) } : null;
  const inv = new Map<string, number>();
  for (const it of (bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>) {
    inv.set(it.name, (inv.get(it.name) ?? 0) + it.count);
  }
  const inventory = [...inv].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 40);

  const players: Array<{ name: string; dist: number }> = [];
  const hostiles: Array<{ name: string; dist: number }> = [];
  if (ent?.position) {
    for (const e of Object.values((bot.entities ?? {}) as Record<string, { type?: string; name?: string; username?: string; position?: { distanceTo: (p: unknown) => number } }>)) {
      if (!e?.position || e === (ent as unknown)) continue;
      const dist = r1(e.position.distanceTo(ent.position));
      if (dist > 48) continue;
      if (e.type === 'player' && e.username && e.username !== bot.username) players.push({ name: e.username, dist });
      else if (e.name && HOSTILE_KINDS.has(e.name)) hostiles.push({ name: e.name, dist });
    }
    players.sort((a, b) => a.dist - b.dist);
    hostiles.sort((a, b) => a.dist - b.dist);
  }

  const time = bot.time
    ? { day: Math.floor((bot.time.age ?? 0) / 24_000), ticks: bot.time.timeOfDay ?? 0, isDay: !!bot.time.isDay }
    : null;
  const weather = bot.time ? (bot.thunderState ? 'thunder' : bot.isRaining ? 'rain' : 'clear') : null;
  let biome: string | null = null;
  try {
    const b = ent?.position && bot.blockAt ? bot.blockAt(ent.position) : null;
    biome = (b as unknown as { biome?: { name?: string } } | null)?.biome?.name ?? null;
  } catch { biome = null; }
  // oxygenLevel: 0/-1 on land (full), 0-300 underwater → bubbles of 20 like get_status.
  const o2 = bot.oxygenLevel;
  const air = ent ? (o2 === undefined || o2 <= 0 ? 20 : Math.round((o2 / 300) * 20)) : null;

  return {
    name: bot.username ?? 'StrandsBot',
    dimension: bot.game?.dimension ?? null,
    gamemode: bot.game?.gameMode ?? null,
    pos,
    yaw: ent ? +ent.yaw.toFixed(2) : null,
    pitch: ent ? +ent.pitch.toFixed(2) : null,
    health: ent && typeof bot.health === 'number' ? r1(bot.health) : null,
    food: ent && typeof bot.food === 'number' ? bot.food : null,
    air,
    xp: bot.experience?.level ?? null,
    time,
    weather,
    biome,
    held: bot.heldItem ? `${bot.heldItem.name} x${bot.heldItem.count}` : ent ? null : null,
    inventory,
    nearby: { players: players.slice(0, 10), hostiles: hostiles.slice(0, 10) },
    task: extra.task ?? { kind: 'idle', text: '', since_s: 0 },
    thinker: extra.thinker ?? { enabled: false, next_in_s: null },
    crew: extra.crew ?? [],
    connection: extra.connection ?? { connected: !!ent, epoch: 0, reconnects: 0 },
    mem: extra.mem ?? { heapMb: Math.round(process.memoryUsage().heapUsed / 1048576), limitMb: null },
    ts: now,
  };
}

/** Clamp a caller's wait_s to the contract: default 20, max 40, never negative. */
export function chatWaitMs(wait_s: unknown, o: { defaultS?: number; maxS?: number } = {}): number {
  const d = o.defaultS ?? 20;
  const max = o.maxS ?? 40;
  const n = Number(wait_s);
  if (!Number.isFinite(n)) return d * 1_000;
  return Math.max(0, Math.min(max, n)) * 1_000;
}

/** The prompt of a chat body: `prompt` (the relay) or `text` (the SPA / curl), trimmed and bounded. */
export function chatPrompt(body: unknown): string {
  const b = (body ?? {}) as { prompt?: unknown; text?: unknown };
  const raw = typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt : typeof b.text === 'string' ? b.text : '';
  return raw.trim().slice(0, 2_000);
}

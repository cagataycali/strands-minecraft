/**
 * 👷 Workers as BODIES — the pure half of the crew contract.
 *
 * tiny shows a Minecraft bot as a card with a camera; `manage_bots` workers
 * are bots too, so each one is a page inside its boss's card: a row on
 * `GET /api/workers`, its own telemetry, its own snapshot/stream, its own STOP.
 * Everything here takes plain objects and returns plain objects, so the whole
 * contract shape is pinned by tests that never need a server or a bot.
 *
 * THE CONTRACT (CREW.md): worker ids are stable for the life of the worker
 * and URL-safe (`w-<n>`); `state` is one of working|idle|stalled|dead; a
 * worker row never 404s while the worker is alive.
 */
import type { Worker } from '../fleet.js';
import type { Bot } from 'mineflayer';

export type WorkerState = 'working' | 'idle' | 'stalled' | 'dead';

export interface WorkerRow {
  id: string;
  name: string;
  goal: string;
  state: WorkerState;
  alive: boolean;
  pos: { x: number; y: number; z: number } | null;
  health: number | null;
  food: number | null;
  since_s: number;
  steps: number;
  /** `frames`/`watchers` are additive: the dashboard's stall detector reads the counter like it reads /api/state.frames. */
  camera: { ok: boolean; why: string; frames?: number; watchers?: number };
  /** The ledger's own word for it — kept next to `state` so a card can say "failed" rather than "dead". */
  status: Worker['status'];
  /** last journal line / result, for the card's one-liner */
  last?: string;
}

/** A worker with no step for this long while "working" is stalled (a model call wedged, a path that never ends). */
export const STALL_MS = 3 * 60_000;

/** URL-safe id for the n-th hire of this process: `w-1`, `w-2`, … */
export function workerId(n: number): string {
  return `w-${Math.max(1, Math.floor(n))}`;
}

/** Is this an id the routes accept? Keeps a stray `../` or a name out of the Map lookup. */
export function isWorkerId(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);
}

/**
 * The next counter for a ledger loaded from disk: one past the highest `w-<n>`
 * ever assigned, so a restart cannot hand a fresh hire a retired worker's id
 * (a phone still polling `w-3` would otherwise see a different bot answer).
 */
export function nextWorkerCounter(ids: Iterable<string | undefined>): number {
  let max = 0;
  for (const id of ids) {
    const m = /^w-(\d+)$/.exec(id ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function isAlive(status: Worker['status']): boolean {
  return status === 'working' || status === 'connecting';
}

/**
 * working | idle | stalled | dead — the four words a card paints a colour by.
 *  - connecting → idle (a body on its way is not yet doing anything)
 *  - working with recent progress → working; no step for STALL_MS → stalled
 *  - every terminal status → dead
 */
export function workerState(
  w: Pick<Worker, 'status' | 'startedAt'> & { progressAt?: number },
  now = Date.now(),
  stallMs = STALL_MS,
): WorkerState {
  if (w.status === 'connecting') return 'idle';
  if (w.status === 'working') return now - (w.progressAt ?? w.startedAt) > stallMs ? 'stalled' : 'working';
  return 'dead';
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * One row of `GET /api/workers`. Reads what the body can give right now and
 * nulls what it cannot (a worker mid-connect has no entity) — a phone renders
 * "joining…" instead of getting a 500.
 */
export function workerRow(
  w: Worker & { id: string; progressAt?: number },
  camera: WorkerRow['camera'],
  now = Date.now(),
): WorkerRow {
  const bot = w.body?.bot as Partial<Bot> | undefined;
  const ent = bot?.entity;
  return {
    id: w.id,
    name: w.name,
    goal: w.task,
    state: workerState(w, now),
    alive: isAlive(w.status),
    pos: ent?.position ? { x: r1(ent.position.x), y: r1(ent.position.y), z: r1(ent.position.z) } : null,
    health: ent && typeof bot?.health === 'number' ? r1(bot.health) : null,
    food: ent && typeof bot?.food === 'number' ? bot.food : null,
    since_s: Math.max(0, Math.round((now - w.startedAt) / 1_000)),
    steps: w.steps,
    camera,
    status: w.status,
    last: w.result ?? w.journal[w.journal.length - 1],
  };
}

/**
 * Which workers `GET /api/workers` lists. The fleet ledger keeps every worker
 * it ever hired (47-day-old corpses included — the owner saw 18 dead rows next
 * to 3 live ones on his phone). A card only needs a dead worker long enough to
 * show its outcome, so: every alive worker, plus the dead for `graceMs`
 * (default 90 s) after they ended. A dead worker with no `endedAt` is a ghost
 * from a previous process → never listed.
 */
export const DEAD_WORKER_GRACE_MS = 90_000;
export function listedWorkers<W extends Pick<Worker, 'status' | 'endedAt'>>(workers: W[], now = Date.now(), graceMs = DEAD_WORKER_GRACE_MS): W[] {
  return workers.filter((w) => isAlive(w.status) || (typeof w.endedAt === 'number' && now - w.endedAt <= graceMs));
}

/**
 * `/api/health.workers` — how many bodies the crew holds and how many it may.
 * There is no hard headcount cap in the fleet (every worker is its own
 * connection and model budget); `max` is the advisory FLEET_MAX_WORKERS the
 * dashboard's "hire" chip greys out at.
 */
export function workersHealth(workers: Array<Pick<Worker, 'status'>>, max: number): { alive: number; max: number } {
  return { alive: workers.filter((w) => isAlive(w.status)).length, max };
}

/**
 * The camera line of a worker row, before any frame exists. A worker body is
 * hired at viewDistance 3 (MEMORY.md — chunks are the heap), so its picture is
 * near-field by design; the veil says so instead of looking broken.
 */
export function describeWorkerCamera(s: {
  alive: boolean;
  /** still joining the server — a body on its way, not a body that left */
  connecting?: boolean;
  frames: number;
  watchers: number;
  error?: string;
  warmingSince?: number;
  now: number;
}): { ok: boolean; why: string } {
  if (s.connecting) return { ok: true, why: 'joining the world — camera opens once the body is in' };
  if (!s.alive) return { ok: false, why: 'worker has left the world — no camera' };
  if (s.error) return { ok: false, why: `broken: ${s.error}` };
  if (s.warmingSince) return { ok: true, why: `warming up (${Math.round((s.now - s.warmingSince) / 1000)}s) — viewer page for this worker` };
  if (!s.watchers) return { ok: true, why: s.frames ? `idle (no watchers; ${s.frames} frames served so far) · near-field view (viewDistance 3)` : 'idle (never started — opens on first watcher) · near-field view (viewDistance 3)' };
  return { ok: true, why: s.frames ? `streaming to ${s.watchers} watcher(s), ${s.frames} frames sent · near-field view (viewDistance 3)` : 'watcher connected but NO frames yet' };
}

/**
 * Viewer port for the n-th worker camera: VIEWER_PORT+1+n, skipping the
 * dashboard's own ports and anything `taken` (a port a previous worker still
 * holds while its viewer closes).
 */
export function allocateViewerPort(base: number, taken: Iterable<number>, avoid: Iterable<number> = []): number {
  const used = new Set<number>([...taken, ...avoid]);
  let p = base + 1;
  while (used.has(p)) p++;
  return p;
}

/**
 * Route matching for the worker family, pure: `METHOD /api/workers[/:id[/leaf]]`.
 * Returns null for anything that is not a worker route so web.ts's string
 * matches keep handling the rest.
 */
export type WorkerRoute =
  | { kind: 'list' }
  | { kind: 'hire' }
  | { kind: 'retire'; id: string }
  | { kind: 'telemetry'; id: string }
  | { kind: 'snapshot'; id: string }
  | { kind: 'stream'; id: string }
  | { kind: 'stop'; id: string };

export function matchWorkerRoute(method: string, pathname: string): WorkerRoute | null {
  if (pathname === '/api/workers' || pathname === '/api/workers/') {
    if (method === 'GET') return { kind: 'list' };
    if (method === 'POST') return { kind: 'hire' };
    return null;
  }
  const m = /^\/api\/workers\/([^/]+)(?:\/(telemetry|camera\/snapshot|stream\.mjpeg|stop))?\/?$/.exec(pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (!isWorkerId(id)) return null;
  const leaf = m[2];
  if (!leaf) return method === 'DELETE' ? { kind: 'retire', id } : null;
  if (leaf === 'telemetry' && method === 'GET') return { kind: 'telemetry', id };
  if (leaf === 'camera/snapshot' && method === 'GET') return { kind: 'snapshot', id };
  if (leaf === 'stream.mjpeg' && method === 'GET') return { kind: 'stream', id };
  if (leaf === 'stop' && method === 'POST') return { kind: 'stop', id };
  return null;
}

/** The hire body of `POST /api/workers {goal, name?}` — trimmed, bounded, or a reason it is unusable. */
export function hireRequest(body: unknown): { goal: string; name?: string } | { error: string } {
  const b = (body ?? {}) as { goal?: unknown; task?: unknown; name?: unknown };
  const raw = typeof b.goal === 'string' ? b.goal : typeof b.task === 'string' ? b.task : '';
  const goal = raw.trim().slice(0, 1_000);
  if (!goal) return { error: 'goal required' };
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) : undefined;
  if (typeof b.name === 'string' && b.name.trim() && !name) return { error: 'name must be letters/digits/underscore' };
  return name ? { goal, name } : { goal };
}

/** A worker name when the caller gave none: `Crew<n>` keeps Minecraft's 16-char rule and never collides with the counter. */
export function defaultWorkerName(n: number, taken: Iterable<string>): string {
  const used = new Set([...taken].map((s) => s.toLowerCase()));
  let i = n;
  let name = `Crew${i}`;
  while (used.has(name.toLowerCase())) name = `Crew${++i}`;
  return name;
}

/**
 * A header value Node will accept: HTTP headers are Latin-1, and a camera reason
 * with an em dash (or an emoji from a worker's result) turned a 200 JPEG into a
 * 400 `Invalid character in header content`. Everything outside printable ASCII
 * becomes '-'.
 */
export function headerSafe(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, '-');
}

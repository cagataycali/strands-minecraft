/**
 * 🧮 Is the memory ceiling real, or fiction?
 *
 * The stack is deliberately layered: V8's heap cap sits BELOW the container's
 * `mem_limit`, so the garbage collector works hard before the kernel kills the
 * process blind. That reasoning is only true while the container limit sits
 * below memory that actually EXISTS — and on Docker Desktop / colima / Rancher
 * the VM defaults to ~4 GB for everything. `mem_limit: 3g` next to a 2 GB
 * server JVM inside a 3.8 GB VM is a ceiling the container can never reach:
 * the OOM killer arrives first, which is precisely the blind death the heap
 * cap exists to prevent (issue #13, seen on a real machine — `docker stats`
 * read `609MiB / 3GiB` for the bot while the whole VM was `3.813GiB`).
 *
 * So the bot checks its own headroom at boot and says so in one line. Pure
 * verdict over three numbers, so tests pin every shape; the reading of cgroup
 * files is the only impure part.
 */
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

export interface MemoryFacts {
  /** The container's memory limit in bytes, or undefined when unlimited/not containerized. */
  containerLimitBytes?: number;
  /** Memory the kernel we run on actually has — inside a VM, the VM's size. */
  totalBytes: number;
  /** What this process could actually grow into right now: free memory plus
   *  what it already holds. The limit is fiction if it exceeds THIS, even when
   *  it looks fine against the total — the co-tenants (a 2G server JVM, a
   *  second bot) are exactly what the reported machine had. */
  availableBytes?: number;
  /** V8's --max-old-space-size, in MB, if set. */
  heapCapMb?: number;
}

export interface MemoryVerdict {
  level: 'ok' | 'note' | 'warn';
  /** One line, ready to print. */
  text: string;
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)}GiB`;

/**
 * The three failure shapes worth a line at boot:
 *  - warn: the container limit exceeds what the machine has, so the limit
 *    never throttles anything — the kernel decides instead. Fleet workers
 *    (each its own connection + agent) are what find this.
 *  - warn: the heap cap is at or above the container limit, so V8 will happily
 *    grow into an OOM kill instead of GCing.
 *  - note: the limit is real but tight (little room for the JVM/other
 *    containers), worth knowing before hiring a fleet.
 */
export function memoryVerdict({ containerLimitBytes, totalBytes, availableBytes, heapCapMb }: MemoryFacts): MemoryVerdict {
  const heapBytes = heapCapMb ? heapCapMb * 1024 * 1024 : undefined;
  const unreachable = containerLimitBytes && (
    containerLimitBytes > totalBytes * 0.95 ||
    (availableBytes !== undefined && containerLimitBytes > availableBytes)
  );
  if (containerLimitBytes && unreachable) {
    const against = availableBytes !== undefined && containerLimitBytes > availableBytes
      ? `only ${gb(availableBytes)} is actually available (of ${gb(totalBytes)} total)`
      : `machine memory ${gb(totalBytes)}`;
    return {
      level: 'warn',
      text:
        `memory ceiling is fiction: container limit ${gb(containerLimitBytes)} but ${against}. ` +
        `The kernel's OOM killer will land before the limit throttles anything. ` +
        `Grow the Docker VM (≥6GB for server+bot, ≥8GB with fleet workers), or lower mem_limit AND --max-old-space-size together.`,
    };
  }
  if (containerLimitBytes && heapBytes && heapBytes >= containerLimitBytes * 0.95) {
    return {
      level: 'warn',
      text:
        `heap cap ${heapCapMb}MB is not below the container limit ${gb(containerLimitBytes)}: ` +
        `V8 will grow into an OOM kill instead of collecting. Set --max-old-space-size to ~⅔ of mem_limit.`,
    };
  }
  if (containerLimitBytes && containerLimitBytes > totalBytes * 0.7) {
    return {
      level: 'note',
      text:
        `memory is tight: container limit ${gb(containerLimitBytes)} of ${gb(totalBytes)} total — ` +
        `little room left for the server JVM or a second bot. Fine for one bot; grow the VM before hiring a fleet.`,
    };
  }
  if (heapBytes && heapBytes > totalBytes * 0.8) {
    return {
      level: 'warn',
      text:
        `heap cap ${heapCapMb}MB is nearly all of the machine's ${gb(totalBytes)}: ` +
        `V8 will not GC before the machine runs out. Lower --max-old-space-size.`,
    };
  }
  return {
    level: 'ok',
    text: containerLimitBytes
      ? `memory ok: limit ${gb(containerLimitBytes)} of ${gb(totalBytes)} total${heapCapMb ? `, heap cap ${heapCapMb}MB` : ''}.`
      : `memory ok: ${gb(totalBytes)} total, no container limit${heapCapMb ? `, heap cap ${heapCapMb}MB` : ''}.`,
  };
}

/** cgroup v2 then v1; 'max' (or an absurd sentinel) means unlimited. */
export function readContainerLimit(read: (p: string) => string = (p) => readFileSync(p, 'utf8')): number | undefined {
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = read(path).trim();
      if (raw === 'max') return undefined;
      const n = Number(raw);
      // v1 reports a near-2^63 sentinel when unlimited; anything ≥1PiB is that.
      if (Number.isFinite(n) && n > 0 && n < 1024 ** 5) return n;
    } catch {
      // not this cgroup layout (or not containerized at all) — try the next
    }
  }
  return undefined;
}

/**
 * The heap ceiling V8 is ACTUALLY enforcing, in MB — flag or no flag.
 *
 * readHeapCapMb() answers "what did the operator ask for?", which is undefined
 * on the local run (`npm start` with no NODE_OPTIONS) — and that is why the
 * boot audit stayed silent all the way to the OOM in issue #44. V8 always has a
 * limit; it just wasn't ours. Ask V8.
 */
export function heapLimitMb(stats = getHeapStatistics()): number {
  return Math.round(stats.heap_size_limit / 1024 ** 2);
}

/** --max-old-space-size from NODE_OPTIONS or the live process flags. */
export function readHeapCapMb(nodeOptions = process.env.NODE_OPTIONS ?? '', execArgv = process.execArgv): number | undefined {
  const from = (s: string) => /--max-old-space-size[= ](\d+)/.exec(s)?.[1];
  const hit = from(nodeOptions) ?? from(execArgv.join(' '));
  return hit ? Number(hit) : undefined;
}

/** The boot line. Returns the verdict so callers can log it their own way. */
export function checkMemory(): MemoryVerdict {
  return memoryVerdict({
    containerLimitBytes: readContainerLimit(),
    totalBytes: totalmem(),
    // free + what we already hold = the ceiling we could really reach
    availableBytes: freemem() + process.memoryUsage().rss,
    heapCapMb: readHeapCapMb(),
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 📈 The growth probe (issue #44)
 *
 * The boot verdict above answers "is the ceiling real?". It cannot answer the
 * question that actually killed us: the bot ran 51 minutes, climbed to V8's
 * 4GB default cap and died with a 4.3s scavenge that reclaimed 5MB of 4050MB.
 * A scavenge that expensive reclaiming that little is RETENTION — something
 * holds references — and every soak we had ever run was shorter than the leak.
 *
 * A log that proves "something grows" is useless at 3am. So the probe makes
 * every long-lived collection register its own size under its own NAME, and
 * prints them sorted by GROWTH SINCE BOOT next to rss/heapUsed and a projection
 * to the heap cap. The line names the winner instead of describing the crime.
 *
 * Pure by construction: the sampler takes the clock and the usage reading as
 * arguments, so tests pin the arithmetic without waiting 30 seconds.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A live collection that must not grow forever, and how big it is right now. */
export interface CollectionProbe {
  /** Dotted, stable, greppable: 'radar.entities', 'web.says', 'fleet.workers'. */
  name: string;
  size: () => number;
  /** The size at which this collection is misbehaving — announced ONCE, by name. */
  cap?: number;
}

export interface CollectionReading {
  name: string;
  size: number;
  /** Growth since the first sample — the column that finds the leak. */
  grew: number;
  cap?: number;
}

export interface MemorySample {
  atMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  /** Elapsed since the first sample of this process. */
  upMs: number;
  /** heapUsed growth since the first sample. */
  heapGrewBytes: number;
  collections: CollectionReading[];
  /** The post-GC floor's slope, once two windows are complete. */
  floor?: FloorSlope;
}

/** Past this the ETA is noise drawn to infinity — see formatSample. */
const ETA_WORTH_SAYING_MIN = 12 * 60;

const mib = (bytes: number) => `${Math.round(bytes / 1024 ** 2)}MiB`;
const mins = (ms: number) => `${Math.round(ms / 60_000)}m`;

/** Bytes/hour, from the whole run rather than the last tick: one 200ms GC must
 *  not read as a plateau, and one allocation spike must not read as a leak. */
export function growthPerHour(heapGrewBytes: number, upMs: number): number {
  if (upMs <= 0) return 0;
  return (heapGrewBytes / upMs) * 3_600_000;
}

/** When does this curve reach the cap? undefined = never (flat or shrinking) —
 *  which is precisely the answer we are soaking for. */
export function minutesToCap(heapUsedBytes: number, perHour: number, heapCapMb?: number): number | undefined {
  if (!heapCapMb || perHour <= 0) return undefined;
  const capBytes = heapCapMb * 1024 * 1024;
  const left = capBytes - heapUsedBytes;
  if (left <= 0) return 0;
  return (left / perHour) * 60;
}

export interface FloorSlope {
  /** Bytes/hour the FLOOR is rising — the number that decides "leak or not". */
  perHour: number;
  fromBytes: number;
  toBytes: number;
  spanMs: number;
  /** How many complete windows the slope is drawn through. */
  windows: number;
  /** Every complete window's floor, oldest first — the curve, not a summary. */
  floors: number[];
  /**
   * The slope with the FIRST window dropped. A process fills caches, lazy
   * modules and one history for the first few minutes; measured live, boot's
   * floor was 90MiB and every warm window after it sat at 125-126MiB, so the
   * boot-anchored slope screamed +216MiB/h about a heap that was flat.
   * undefined until three windows are complete.
   */
  warmPerHour?: number;
}

/**
 * The post-GC FLOOR of the heap, bucketed into windows.
 *
 * Live measurement taught this the hard way: the same soak reported
 * +1332MiB/h, then +722, then +433 over three consecutive minutes while the
 * heap sawed 169 → 155 → 130MiB. Nothing had been fixed in between; GC simply
 * ran. A ceiling reading swings with every collection, so it can neither
 * accuse nor exonerate.
 *
 * A leak is a rising FLOOR: the lowest point the heap returns to after a
 * collection, climbing window over window. That is the only curve that ends at
 * "FATAL ERROR: Reached heap limit", and it is what the fix has to flatten.
 */
export class HeapFloor {
  private mins = new Map<number, number>();

  constructor(readonly windowMs = 300_000, readonly keep = 48) {}

  add(atMs: number, heapUsedBytes: number): void {
    const bucket = Math.floor(atMs / this.windowMs);
    const seen = this.mins.get(bucket);
    if (seen === undefined || heapUsedBytes < seen) this.mins.set(bucket, heapUsedBytes);
    while (this.mins.size > this.keep) {
      let oldest = Infinity;
      for (const b of this.mins.keys()) if (b < oldest) oldest = b;
      this.mins.delete(oldest);
    }
  }

  /**
   * Slope across COMPLETE windows only. The current window is still collecting
   * its minimum, so counting it would read one fresh allocation spike — a
   * model turn holding a big response — as a rising floor.
   */
  slope(nowMs: number): FloorSlope | undefined {
    const current = Math.floor(nowMs / this.windowMs);
    const done = [...this.mins.entries()].filter(([b]) => b < current).sort((a, b) => a[0] - b[0]);
    if (done.length < 2) return undefined;
    const [firstBucket, fromBytes] = done[0];
    const [lastBucket, toBytes] = done[done.length - 1];
    const spanMs = (lastBucket - firstBucket) * this.windowMs;
    const floors = done.map(([, v]) => v);
    const warm = done.slice(1);
    const warmPerHour = warm.length >= 2
      ? ((warm[warm.length - 1][1] - warm[0][1]) / ((warm[warm.length - 1][0] - warm[0][0]) * this.windowMs)) * 3_600_000
      : undefined;
    return {
      perHour: ((toBytes - fromBytes) / spanMs) * 3_600_000,
      fromBytes, toBytes, spanMs, windows: done.length, floors,
      ...(warmPerHour !== undefined ? { warmPerHour } : {}),
    };
  }
}

/**
 * One line, ready to print. Shape:
 *   🧮 mem rss 812MiB · heap 604MiB +412MiB in 21m (+1177MiB/h → cap in 178m)
 *      · radar.entities 4213 +4200 · web.says 61 +61 · notes.queue 3 +1
 * Only collections that GREW are listed (plus any over cap): a flat structure
 * in the list is noise that hides the one that is not flat.
 */
export function formatSample(s: MemorySample, heapCapMb?: number): string {
  const perHour = growthPerHour(s.heapGrewBytes, s.upMs);
  // The ETA follows the FLOOR when there is one: a ceiling slope predicts the
  // cap on a heap that is merely between collections, and cries leak all night.
  // Warm slope first when we have one: boot is not a leak, and the boot-anchored
  // number is what turns a flat heap into a fire alarm (measured: floors
  // 90 · 125 · 126MiB read as "+216MiB/h" while the warm windows were flat).
  const trend = s.floor ? (s.floor.warmPerHour ?? s.floor.perHour) : perHour;
  const etaRaw = minutesToCap(s.heapUsedBytes, trend, heapCapMb);
  // A cap half a day out is not news, it is measurement noise: one megabyte per
  // window of jitter is enough to draw a line that eventually hits 4GB. Only a
  // deadline someone could actually meet gets printed.
  const eta = etaRaw !== undefined && etaRaw <= ETA_WORTH_SAYING_MIN ? etaRaw : undefined;
  const quiet = etaRaw === undefined || etaRaw > ETA_WORTH_SAYING_MIN;
  const floor = s.floor
    ? ` · floor ${s.floor.floors.map(mib).join('→')} over ${mins(s.floor.spanMs)}` +
      ` (${trend >= 0 ? '+' : '-'}${mib(Math.abs(trend))}/h` +
      `${s.floor.warmPerHour !== undefined ? ' warm' : ''}` +
      `${quiet ? ' — flat after GC, no leak' : ''})`
    : '';
  const rate = s.upMs >= 60_000
    ? ` ${s.heapGrewBytes >= 0 ? '+' : '-'}${mib(Math.abs(s.heapGrewBytes))} in ${mins(s.upMs)}` +
      ` (${perHour >= 0 ? '+' : '-'}${mib(Math.abs(perHour))}/h${eta === undefined ? '' : ` → cap in ${Math.round(eta)}m`})`
    : '';
  const movers = s.collections
    .filter((c) => c.grew !== 0 || (c.cap !== undefined && c.size > c.cap))
    .sort((a, b) => b.grew - a.grew)
    .slice(0, 8)
    .map((c) => `${c.name} ${c.size}${c.grew ? ` ${c.grew > 0 ? '+' : ''}${c.grew}` : ''}${c.cap !== undefined && c.size > c.cap ? ` OVER CAP ${c.cap}` : ''}`);
  const tail = movers.length ? ` · ${movers.join(' · ')}` : ' · no tracked collection grew';
  return `mem rss ${mib(s.rssBytes)} · heap ${mib(s.heapUsedBytes)}${rate}${floor}${tail}`;
}

/**
 * The WHOLE table, every so often. The periodic line prints only movers, which
 * is right for reading a leak in progress and wrong for answering "what was the
 * fleet holding at 03:12?" after the process is gone. One full line every N
 * samples keeps that answer in the log, cheaply, for the post-mortem — and it
 * is the line that shows a collection sitting HIGH without moving, which a
 * movers-only feed hides completely.
 */
export function formatFullTable(s: MemorySample): string {
  const cols = s.collections
    .map((c) => `${c.name}=${c.size}${c.cap !== undefined && c.size > c.cap ? `(OVER ${c.cap})` : ''}`)
    .join(' ');
  return `mem full rss ${mib(s.rssBytes)} heap ${mib(s.heapUsedBytes)} up ${mins(s.upMs)}: ${cols}`;
}

/**
 * The registry every rail registers with. Owns the baseline (first sample) so
 * growth is measured from boot, and remembers which caps it already announced
 * so a leak is loud ONCE per collection instead of every 30 seconds.
 */
export class MemoryProbe {
  private probes: CollectionProbe[] = [];
  private baseline?: { heapUsedBytes: number; atMs: number; sizes: Map<string, number> };
  private readonly heapFloor = new HeapFloor();
  private announced = new Set<string>();
  private timer?: NodeJS.Timeout;

  /** Register a long-lived collection by name. Re-registering a name replaces
   *  it, so a reconnect (new bot, new listeners) cannot double-count. */
  track(name: string, size: () => number, cap?: number): void {
    this.probes = this.probes.filter((p) => p.name !== name);
    this.probes.push({ name, size, cap });
  }

  get tracked(): string[] {
    return this.probes.map((p) => p.name);
  }

  /** Read everything now. A probe that throws (a rail mid-teardown) reads 0
   *  rather than killing the sampler that is trying to explain a crash. */
  sample(atMs = Date.now(), usage = process.memoryUsage()): MemorySample {
    const sizes = new Map<string, number>();
    for (const p of this.probes) {
      let n = 0;
      try { n = p.size(); } catch { n = 0; }
      sizes.set(p.name, Number.isFinite(n) ? n : 0);
    }
    if (!this.baseline) this.baseline = { heapUsedBytes: usage.heapUsed, atMs, sizes: new Map(sizes) };
    this.heapFloor.add(atMs, usage.heapUsed);
    return {
      atMs,
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      upMs: atMs - this.baseline.atMs,
      heapGrewBytes: usage.heapUsed - this.baseline.heapUsedBytes,
      floor: this.heapFloor.slope(atMs),
      collections: this.probes.map((p) => ({
        name: p.name,
        size: sizes.get(p.name) ?? 0,
        grew: (sizes.get(p.name) ?? 0) - (this.baseline?.sizes.get(p.name) ?? 0),
        cap: p.cap,
      })),
    };
  }

  /** Caps crossed since the last check, named, once each. */
  newOverflows(s: MemorySample): string[] {
    const out: string[] = [];
    for (const c of s.collections) {
      if (c.cap === undefined || c.size <= c.cap) continue;
      if (this.announced.has(c.name)) continue;
      this.announced.add(c.name);
      out.push(`${c.name} is over its cap: ${c.size} > ${c.cap} — this collection is the leak, not the messenger.`);
    }
    return out;
  }

  /**
   * The baseline line, once at boot: every tracked collection and where it
   * STARTS. The periodic line prints only what moved (a flat row hides the
   * steep one), which leaves no way to tell "flat" from "my accessor reads the
   * wrong property and returns 0 forever" — a mistake I made on the chunk
   * column store, the most expensive structure of the lot.
   */
  baselineLine(s: MemorySample, heapCapMb?: number): string {
    const cols = s.collections.map((c) => `${c.name}=${c.size}`).join(' ');
    return `watching ${s.collections.length} collections (heap cap ${heapCapMb ?? '?'}MB, rss ${mib(s.rssBytes)}, heap ${mib(s.heapUsedBytes)}): ${cols}`;
  }

  /** Start the cadence. Unref'd: a probe must never hold the process alive. */
  start(log: (line: string, level: 'note' | 'warn') => void, intervalMs: number, heapCapMb?: number): () => void {
    this.stop();
    log(this.baselineLine(this.sample(), heapCapMb), 'note');
    let ticks = 0;
    this.timer = setInterval(() => {
      const s = this.sample();
      log(formatSample(s, heapCapMb), 'note');
      // Every tenth line, the whole table: a structure sitting HIGH without
      // moving is invisible in a movers-only feed, and after a crash the log is
      // all the evidence there is.
      if (++ticks % 10 === 0) log(formatFullTable(s), 'note');
      for (const line of this.newOverflows(s)) log(line, 'warn');
    }, intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The one probe the whole process shares — rails register at wiring time. */
export const memoryProbe = new MemoryProbe();

/**
 * 🔌 The retainers our own probes structurally CANNOT see.
 *
 * Every collection probe answers "what do WE still point at?" — and the #44
 * evidence made that question insufficient: `census.bots.alive` sat at
 * created − 1 for a whole soak (30 created, 29 reachable) while the fleet
 * records provably held no body at all (the 40ms reachability guard in
 * test/retention.test.ts passes). Something outside our object graph was
 * pinning those bots.
 *
 * An OPEN HANDLE is that something. A live socket or an armed timer is a GC
 * ROOT in libuv, not an edge in the heap: while a worker's TCP connection or
 * its keep-alive interval is still active, its mineflayer client — and through
 * it the whole prismarine world — cannot be collected no matter how clean our
 * records are. That is also the only story that explains the
 * `multiplayer.disconnect.server_full` worker rejections: the server counts
 * connections, not our intentions.
 *
 * So count what the process itself is holding open, next to the bots we think
 * we retired. `handles.sockets` climbing with `census.bots.created` names a
 * quit() that never closed a socket; sockets flat while `alive` climbs sends
 * the hunt back into the heap. Node gives the counts for free —
 * getActiveResourcesInfo() is a string per live resource.
 */
export function countHandles(kinds: readonly string[]): Record<string, number> {
  let sockets = 0;
  let timers = 0;
  for (const k of kinds) {
    // TCPSERVERWRAP is the dashboard LISTENING — one forever, not a leak.
    if (/^(TCPWRAP|TCPSocketWrap|TLSWRAP|PipeWrap)$/i.test(k)) sockets++;
    else if (/^(Timeout|Immediate)$/i.test(k)) timers++;
  }
  return { sockets, timers, total: kinds.length };
}

/**
 * ...and which of those sockets is a BOT.
 *
 * `handles.sockets` read 11 on a bot with 5 bodies, which proves nothing on its
 * own: every agent's Bedrock call is a TLS socket too, and a keep-alive pool
 * makes that count sawtooth for reasons that have nothing to do with #44. The
 * question worth asking is narrower — how many connections to the GAME PORT is
 * this process holding? That number has one legitimate value: one per live
 * body. Anything above `fleet.bodies + 1` is a retired worker whose socket is
 * still open, which pins its client (and world) past every record we cleared
 * AND spends one of the server's player slots — the
 * `multiplayer.disconnect.server_full` rejections, explained.
 *
 * `remotePort` is what distinguishes them, and only the live handle objects
 * carry it (getActiveResourcesInfo returns bare type names). Hence
 * process._getActiveHandles(), which is undocumented: the caller passes the
 * array in so this stays a pure function, and the probe below treats its
 * absence as "cannot tell" (-1) rather than a reassuring zero.
 */
export interface HandleLike { remotePort?: unknown; destroyed?: unknown }

export function countGameSockets(handles: readonly unknown[], gamePort: number): number {
  let n = 0;
  for (const h of handles) {
    const s = h as HandleLike;
    if (typeof s?.remotePort !== 'number') continue; // not a connected socket
    if (s.remotePort !== gamePort) continue;         // Bedrock/TLS, the dashboard, DNS
    if (s.destroyed === true) continue;              // closing, already unrooted
    n++;
  }
  return n;
}

export function activeHandles(): readonly unknown[] | undefined {
  const get = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  try { return typeof get === 'function' ? get.call(process) : undefined; } catch { return undefined; }
}

// Registered here rather than at the call site: these are facts about the
// PROCESS, true of every deployment, and nothing needs wiring to read them.
// Caps are "scream at a regression", not steady state: one primary + a few
// workers + the dashboard + a Bedrock connection lives comfortably under 20.
memoryProbe.track('handles.sockets', () => countHandles(process.getActiveResourcesInfo()).sockets, 20);
memoryProbe.track('handles.timers', () => countHandles(process.getActiveResourcesInfo()).timers, 200);
// The cap is the fleet cap plus the primary plus slack for one mid-connect
// hire: a bot process has no honest reason to hold ten game connections.
memoryProbe.track('handles.gameSockets', () => {
  const h = activeHandles();
  return h ? countGameSockets(h, Number(process.env.MC_PORT ?? 25565)) : -1;
}, 10);

/**
 * 🪦 Who is still alive that should be dead?
 *
 * Counting entries misses the shape of THIS bot's worst case: a single retained
 * reference to a Bot pins a whole prismarine world (thousands of chunk columns,
 * every entity, the protocol client's buffers) — hundreds of MB per object. Ten
 * such objects are 4GB, and no size-of-collection probe would ever show more
 * than "10".
 *
 * So the census holds WeakRefs to the expensive objects we create — bots,
 * agents, workers — and counts how many the collector has NOT taken. Dead refs
 * are pruned on read, so the census itself is bounded no matter how many bots a
 * night of reconnects creates. `alive` far above what is in service is the
 * proof, not a story.
 */
/**
 * The name an expensive object answers to: a mineflayer Bot knows its
 * `username`, an agent may carry a `name`. Anything else reads '(unnamed)'
 * rather than a stringified object — a probe line must stay one line.
 */
function defaultLabel(o: object): string | undefined {
  const c = o as { username?: unknown; name?: unknown };
  if (typeof c.username === 'string') return c.username;
  if (typeof c.name === 'string') return c.name;
  return undefined;
}

export class ObjectCensus {
  private groups = new Map<string, WeakRef<object>[]>();
  private born = new Map<string, number>();

  watch(kind: string, obj: object): void {
    const refs = this.groups.get(kind) ?? [];
    refs.push(new WeakRef(obj));
    this.groups.set(kind, refs);
    this.born.set(kind, (this.born.get(kind) ?? 0) + 1);
  }

  /** How many of that kind are still reachable (pruning what has been collected). */
  alive(kind: string): number {
    const refs = this.groups.get(kind);
    if (!refs) return 0;
    const live = refs.filter((r) => r.deref() !== undefined);
    this.groups.set(kind, live);
    return live.length;
  }

  /** How many were ever created — 'alive 9 of 9 created' is the leak's signature. */
  created(kind: string): number {
    return this.born.get(kind) ?? 0;
  }

  /**
   * WHO is still alive, by name — the step from "something leaks" to a suspect.
   *
   * A count sends the next reader on a heap-snapshot expedition; a list of
   * usernames can be diffed against the live crew in one glance, and the
   * survivors' names say which code path created them (a long-retired worker
   * points at the fleet, a reconnect twin at body.ts). The census already holds
   * the object, so the label costs nothing and retains nothing extra: the name
   * is copied out and the reference dropped again.
   *
   * Shape-tolerant on purpose — this runs on a sick process, and a probe that
   * throws while being asked what is wrong is worth less than no probe.
   */
  labels(kind: string, name: (o: object) => string | undefined = defaultLabel): string[] {
    const refs = this.groups.get(kind);
    if (!refs) return [];
    const live: WeakRef<object>[] = [];
    const out: string[] = [];
    for (const r of refs) {
      const o = r.deref();
      if (o === undefined) continue; // collected: prune, exactly like alive()
      live.push(r);
      let label: string | undefined;
      try { label = name(o); } catch { label = undefined; }
      out.push(label && label.trim() ? label : '(unnamed)');
    }
    this.groups.set(kind, live);
    return out;
  }

  kinds(): string[] {
    return [...this.groups.keys()];
  }
}

/**
 * Let the current job END before believing a WeakRef.
 *
 * The spec's KeepDuringJob rule: a WeakRef target stays alive for the rest of
 * the job in which it was deref'd or created, whatever the collector did. So a
 * census read in the same tick as forceFullGc() reports the OLD counts, and an
 * earlier attempt at this diagnosis concluded "everything is retained" from
 * exactly that — the honest sequence is collect, yield, then count.
 */
export const nextTurn = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

/**
 * The only census reading worth acting on: collect, yield, then count what
 * SURVIVED. `alive` on its own answers "how many are not collected yet", which
 * on a roomy heap is simply "all of them" (see forceFullGc below); this answers
 * "how many are actually retained" — the question #44 asks. `undefined` when
 * the runtime refuses to hand over gc(), because a number nobody can verify is
 * worse than no number.
 */
export async function confirmedAlive(
  kinds: readonly string[],
  c: { alive: (k: string) => number } = census,
): Promise<Record<string, number> | undefined> {
  if (!forceFullGc()) return undefined;
  // Collect, YIELD, collect again. The second pass is not superstition: the
  // refs registered during the caller's own job are kept alive through the
  // first collection by KeepDuringJob, so only a pass that runs after the job
  // boundary can clear them. Without it a bot retired seconds ago still counts
  // as alive, which is the false positive this function exists to remove.
  await nextTurn();
  forceFullGc();
  await nextTurn();
  return Object.fromEntries(kinds.map((k) => [k, c.alive(k)]));
}

/**
 * The same reading, NAMED — post-GC survivors per kind, as the names they answer
 * to. This is the line that ends an argument: `bots: ["StrandsBot","Load3"]`
 * with Load3 long retired points at the worker path and gives the next reader a
 * grep target, where `bots: 7` only justifies another heap snapshot.
 */
export async function confirmedAliveNames(
  kinds: readonly string[],
  c: { labels: (k: string) => string[] } = census,
): Promise<Record<string, string[]> | undefined> {
  await nextTurn();
  if (!forceFullGc()) return undefined; // nothing to report beats something false
  await nextTurn();
  return Object.fromEntries(kinds.map((k) => [k, c.labels(k)]));
}

/** The process-wide census — createBot/hire register, the probe reads. */
export const census = new ObjectCensus();

/**
 * 🗑️ Ask V8 for a REAL major collection, without a command-line flag.
 *
 * Why this exists, in numbers from the live stress soak: the probe read
 * `census.bots.alive=15 (OVER CAP 8) census.bots.created=15` while
 * `fleet.bodies=1` and `handles.gameSockets=2` — read naively, thirteen dead
 * bots still reachable, and two supervisor checks filed it as a leak. But the
 * census holds WEAKREFS, and a WeakRef is cleared only by a major GC. Heap was
 * 117MiB against a 4144MiB cap, so V8 had no reason to run one: `alive ==
 * created` is the EXPECTED reading for a young, roomy process, whether or not
 * anything leaks. The alarm could not distinguish "retained" from "not yet
 * collected", which is the difference between a bug and a Tuesday.
 *
 * `--expose-gc` was never on the local command line (only docker-compose sets
 * NODE_OPTIONS), and a diagnosis that requires restarting the process destroys
 * the state being diagnosed — the leak lives in the 51st minute. Setting the
 * flag at runtime and compiling `gc` in a fresh context gets the same function
 * on a process that is already sick.
 *
 * Deliberately NOT called on the probe's cadence: a full GC stops the world
 * (a measured 4.3s scavenge already masquerades as event-loop load in #37), so
 * forcing one on a timer would corrupt the very numbers this file exists to
 * report. It runs only when someone ASKS — `GET /api/mem?gc=1`.
 */
let gcFn: (() => void) | null | undefined;

export function forceFullGc(
  setFlags: (f: string) => void = (f) => { void setFlagsFromString(f); },
  compile: (src: string) => unknown = (src) => runInNewContext(src),
): boolean {
  if (gcFn === undefined) {
    try {
      // globalThis.gc when the flag was passed properly; otherwise compile it.
      const already = (globalThis as { gc?: () => void }).gc;
      if (already) gcFn = already;
      else {
        setFlags('--expose-gc');
        const fn = compile('gc');
        gcFn = typeof fn === 'function' ? (fn as () => void) : null;
        // Leave the flag as we found it: --expose-gc puts gc() on every new
        // context, and this diagnostic should not change what the rest of the
        // process can reach.
        try { setFlags('--no-expose-gc'); } catch { /* best effort */ }
      }
    } catch {
      gcFn = null; // a hardened runtime may refuse; a refusal is not a crash
    }
  }
  if (!gcFn) return false;
  try {
    // Twice: the first pass clears the WeakRefs, the second collects what
    // those cleared refs were the last thing holding.
    gcFn();
    gcFn();
    return true;
  } catch {
    return false;
  }
}

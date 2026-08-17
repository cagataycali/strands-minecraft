/**
 * 👥 Fleet — parallel sub-agents, except the agents have BODIES.
 *
 * manage_bots lets the primary agent hire workers on the fly: each worker is a
 * FULL bot — its own mineflayer connection (own legs: no pathfinder contention
 * with the primary, ever), its own reconnecting body, its own agent with the
 * same 50-tool kit (minus capture_view — the prismarine-viewer is a one-port
 * singleton owned by the primary), and a journey-style task loop that iterates
 * until the worker says [TASK_DONE] or hits its caps.
 *
 * Scale story: "build the cabin" stops being one bot doing four errands in
 * sequence and becomes Chopper felling trees while Digger clears the plot and
 * the primary keeps talking to the player. Workers are DISPOSABLE — they exist
 * for the task, report a final result into their journal, and get dismissed.
 * No headcount cap: every worker is its own connection + agent, so the real
 * limits are the server's and the model provider's, not ours — hire what the
 * job needs (each active worker does cost tokens per step, though).
 *
 * Deliberate non-features: workers don't hear player chat (one conversational
 * bot is enough; they'd all answer at once), don't fork the primary's session
 * (a task brief is their whole world — cheap, focused context), and can't hire
 * their own workers (depth 1 — a hierarchy of
 * managers hiring managers helps nobody).
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLiveBody, type LiveBody } from './body.js';
import { createMinecraftAgent, TURN_ECONOMY } from './agent.js';
import type { Model } from '@strands-agents/sdk';
import { writePlace } from './tools/memory.js';
import { startReflexes, type ReflexHandle } from './reflexes.js';
import { LegsLock, registerLegs } from './legs.js';
import { worldDigest, nearbyThreats } from './digest.js';
import { cfg } from './config.js';
import { memoryProbe } from './memcheck.js';

const MAX_STEPS = cfg.fleet.maxSteps;
const MAX_WALL_MS = cfg.fleet.maxWallMs;
const COOLDOWN_MS = cfg.fleet.cooldownMs;
const DONE = '[TASK_DONE]';

const WORKER_PROMPT = `You are "{username}", a worker bot hired by StrandsBot for ONE task in a live
Minecraft world via mineflayer. You have the same tools as any bot: perception,
movement, digging, building, crafting, containers, furnaces, combat, chat.

Worker discipline:
- Your task brief is your whole world. Work it step by step; perceive first.
- ACT, don't narrate. Report each step's outcome in 1-2 sentences.
- Stay near your task site unless the task itself moves.
- Chat is for coordination only: one short line when a player blocks/unblocks
  your work — never small talk (the primary bot does the talking).
- If the task is impossible, say why and give up cleanly.

${TURN_ECONOMY}`;

export interface Worker {
  name: string;
  task: string;
  status: 'connecting' | 'working' | 'done' | 'failed' | 'dismissed' | 'interrupted';
  steps: number;
  startedAt: number;
  /** when it stopped working (any terminal status) — the clock the crew strip
   *  ages a finished card by, so a fresh result is visible and a stale one isn't. */
  endedAt?: number;
  journal: string[];
  result?: string;
  /** Instructions queued by the primary agent, delivered before the next step. */
  inbox: string[];
  body?: LiveBody;
}

/**
 * The fleet ledger survives the process — same discipline as journeys.json:
 * a restart mid-"Chopper is felling trees" used to erase even the fact that
 * a worker existed, let alone what it had done. Bodies are NOT persisted
 * (a socket doesn't survive a process); the record of the hire is.
 */
const DIR = process.env.MEMORY_DIR ?? join(homedir(), '.strands-minecraft');
const FILE = join(DIR, 'fleet.json');
const KEEP = cfg.fleet.keep;
/** Steps kept on a finished record — the same slice persist() writes. */
const JOURNAL_KEEP = 10;

function loadFile(): Worker[] {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(data.workers) ? data.workers : [];
  } catch {
    return [];
  }
}

/**
 * A socket that is neither destroyed nor ended is still rooting its bot — and
 * `destroyed` alone is not the question: a socket can be half-closed and still
 * hold the handle. Shape-tolerant on purpose: this runs against whatever
 * mineflayer's client happens to expose, and a probe that throws inside a
 * teardown is worse than no probe.
 */
export interface SocketBearing {
  _client?: { socket?: { destroyed?: unknown; readyState?: unknown; destroy?: () => void } };
}

export function socketIsOpen(bot: SocketBearing | undefined): boolean {
  const s = bot?._client?.socket;
  if (!s) return false; // nothing to hold anything open
  if (s.destroyed === true) return false;
  // node reports 'closed' once the handle is gone; anything else ('open',
  // 'readOnly', 'writeOnly') is a live handle.
  if (typeof s.readyState === 'string') return s.readyState !== 'closed';
  return true;
}

/** How long a destroy() gets before we call it a leak. */
const RELEASE_CHECK_MS = 1_000;

export class Fleet {
  private workers = new Map<string, Worker>();
  /** Surfaces worker progress (console line). */
  onProgress?: (w: Worker, line: string) => void;
  /** The primary's Model — every hire drives the same provider/quota (set by main(); tests leave it unset → Bedrock default). */
  model?: Model;

  constructor() {
    // Cap 0: any retirement that left a socket open is over budget by
    // definition, so it shows up in the probe line AND in /api/mem's overCap
    // without anyone remembering to look. Registered here, not at the wiring
    // site, so the guard travels with the code that can break it — and guarded
    // against a second Fleet (tests construct several) adding a stale reading.
    if (!memoryProbe.tracked.includes('fleet.unclosed')) {
      memoryProbe.track('fleet.unclosed', () => this.unclosed, 0);
    }
    // Hires the previous process died holding become INTERRUPTED — their
    // bodies are gone (kicked when the socket died), but the record of who
    // was doing what lets the boss re-hire with the journal as a head start.
    for (const w of loadFile()) {
      if (w.status === 'connecting' || w.status === 'working') {
        w.status = 'interrupted';
        w.result = w.result ?? `Process died while this worker was on the task (${w.steps} step(s) in).`;
      }
      this.workers.set(w.name, { ...w, inbox: [], body: undefined });
    }
    this.prune();
    if (this.interrupted.length) this.persist();
  }

  /**
   * Retirements that left a socket open — the count that turns "the teardown
   * looks right" into a fact. Zero is the only acceptable value; anything else
   * is issue #44 alive again, and the name of the worker is in the log.
   */
  unclosed = 0;

  /**
   * How many records still hold a BODY — the live crew. Read next to
   * `census.bots.alive` it names an issue-#44 regression on sight: alive
   * should be `bodies + 1` (the primary), and anything above that is a dead
   * bot still reachable, pinning its whole prismarine world.
   */
  get bodies(): number {
    return [...this.workers.values()].filter((w) => w.body).length;
  }

  /**
   * Chunk columns held by the whole crew — the number that decides whether
   * this process fits in a heap. A worker hired at FLEET_WORKER_VIEW_DISTANCE
   * should hold a fraction of the primary's ~637, so this reads as roughly
   * `bodies × 80` rather than `bodies × 637` (issue #44). Print it next to
   * world.columns and the per-body budget is either working or it isn't.
   */
  get columns(): number {
    let total = 0;
    for (const w of this.workers.values()) {
      const world = (w.body?.bot as unknown as {
        world?: { async?: { columns?: object }; columns?: object };
      } | undefined)?.world;
      total += Object.keys(world?.async?.columns ?? world?.columns ?? {}).length;
    }
    return total;
  }

  get interrupted(): Worker[] {
    return [...this.workers.values()].filter((w) => w.status === 'interrupted');
  }

  private persist() {
    try {
      mkdirSync(DIR, { recursive: true });
      const workers = [...this.workers.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, KEEP)
        .map(({ body: _body, inbox: _inbox, ...w }) => ({ ...w, journal: w.journal.slice(-10) }));
      const tmp = `${FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify({ workers }, null, 2));
      renameSync(tmp, FILE);
    } catch {
      /* a full disk must not kill the worker itself */
    }
  }

  /**
   * Answers "is this username already walking around the server?" — wired to
   * the primary bot's tab list. Joining with a name a REAL player holds
   * doesn't fail cleanly: on an offline-mode server it kicks the person, on
   * an online-mode one the login is refused after the socket dance. Refusing
   * up front turns both into one clear error the agent can rename around.
   */
  isNameTaken?: (name: string) => boolean;

  list(): Worker[] {
    return [...this.workers.values()];
  }

  get active(): number {
    return this.list().filter((w) => w.status === 'connecting' || w.status === 'working').length;
  }

  hire(name: string, task: string): Worker {
    const clean = name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
    if (!clean) throw new Error('Worker name must have letters/digits/underscore.');
    // Case-insensitive: Minecraft usernames are case-preserving but the
    // server treats "chopper" and "Chopper" as the same login.
    const existing = this.list().find((w) => w.name.toLowerCase() === clean.toLowerCase());
    if (existing && (existing.status === 'connecting' || existing.status === 'working')) {
      throw new Error(`Worker ${existing.name} is already ${existing.status} ("${existing.task}") — dismiss it or pick another name.`);
    }
    if (this.isNameTaken?.(clean)) {
      throw new Error(`"${clean}" is already on the server (a player or the primary bot) — hiring would collide with their login. Pick a different name.`);
    }
    const w: Worker = { name: clean, task, status: 'connecting', steps: 0, startedAt: Date.now(), journal: [], inbox: [] };
    this.workers.set(clean, w);
    this.persist();
    // Not `void`: an unhandled rejection kills the process in Node 22, and the
    // one thing worse than a failed hire is a dead bot. run() owns its cleanup.
    this.run(w).catch((err) => {
      w.status = 'failed';
      w.endedAt = Date.now();
      w.result = `Crashed before starting: ${err instanceof Error ? err.message : err}`;
      this.onProgress?.(w, w.result);
    });
    return w;
  }

  instruct(name: string, instruction: string): boolean {
    const w = this.workers.get(name);
    if (!w || (w.status !== 'working' && w.status !== 'connecting')) return false;
    w.inbox.push(instruction);
    return true;
  }

  dismiss(name: string): boolean {
    const w = this.workers.get(name);
    if (!w) return false;
    if (w.status === 'working' || w.status === 'connecting') {
      w.status = 'dismissed';
      w.endedAt = Date.now();
      w.result = w.result ?? w.journal[w.journal.length - 1] ?? '(dismissed before first step)';
      this.persist();
      this.release(w);
    }
    return true;
  }

  /** Clean shutdown: every worker leaves the server. */
  retireAll() {
    for (const w of this.workers.values()) this.dismiss(w.name);
  }

  /**
   * A finished worker keeps its STORY, never its body (issue #44). `retire()`
   * closes the socket but the record went on holding the LiveBody, and a body
   * pins its bot — every loaded chunk column, the entity table, the protocol
   * buffers. A heap snapshot of one stress soak found 3,343 ChunkColumns and
   * 204MiB of ArrayBufferData live across bodies that had already left the
   * server. The boss reads the record; only the body costs ~30MiB.
   */
  private release(w: Worker) {
    const bot = w.body?.bot as unknown as SocketBearing | undefined;
    try { w.body?.retire(); } catch { /* already gone */ }
    // Then make the PLUGINS let go. A heap snapshot of a live probe finally
    // named this issue's last retainer, and it was not one of our collections:
    //
    //   Probe1 <-- .username -- EventEmitter(bot) <-- context.bot -- doPhysics
    //   <closure> <-- Timeout._onTimeout <-- TimersList <-- node timers map
    //
    // mineflayer's physics plugin runs `setInterval(doPhysics, 50)` and clears it
    // in a `bot.on('end')` handler (physics.js:490). On a retired worker that
    // handler never ran, so the interval stayed scheduled — which retains the
    // whole Bot through its closure AND keeps ticking physics against a hollow
    // world twenty times a second, forever, per retired hire. That is both halves
    // of what we have been chasing: the census that would not drop (8 bots alive
    // with 0 bodies after a FORCED major GC) and plausibly some of #37's event
    // loop lag, since eight dead workers means eight phantom physics loops.
    //
    // Emitting 'end' ourselves runs every plugin's cleanup, mineflayer's included.
    // It must come AFTER retire(): retire sets the retired flag first, so our own
    // reconnect handler treats this 'end' as expected instead of dialling back in.
    // Idempotent by construction — the plugin nulls its handle before clearing.
    try {
      (w.body?.bot as unknown as { emit?: (ev: string, reason?: string) => void })
        ?.emit?.('end', 'retired');
    } catch { /* an emitter that refuses is already past caring */ }
    stripHeavy(w);
    this.prune();
    // ...and then CHECK, because this is the third time a teardown looked
    // right and wasn't. retire() destroys the socket through an optional chain
    // (`bot._client?.socket?.destroy?.()`): every link is allowed to be
    // missing, so a renamed accessor frees nothing, throws nothing and logs
    // nothing — the exact shape of the wrong-accessor bug that already cost
    // this issue a soak (bot.world vs bot.world.async.columns). A live socket
    // is a GC ROOT in libuv, so one survivor pins its client, its world and
    // ~30MiB past every record we just cleared, AND holds a player slot on the
    // server (the multiplayer.disconnect.server_full hires). The check is a
    // second late and unref'd: destroy() completes on the next loop turn, and
    // a bookkeeping timer must never keep the process alive.
    if (!bot) return;
    const t = setTimeout(() => {
      if (socketIsOpen(bot)) {
        this.unclosed++;
        console.warn(`♻️ ${w.name}'s body was retired but its game socket is still OPEN — it pins a whole world and a player slot (issue #44). Total: ${this.unclosed}.`);
        // Say it plainly, then close it anyway: a named leak that keeps
        // leaking teaches nothing the next soak can use.
        try { bot._client?.socket?.destroy?.(); } catch { /* already gone */ }
      }
    }, RELEASE_CHECK_MS);
    t.unref?.();
  }

  /**
   * The in-memory ledger is bounded exactly like the file it persists to:
   * KEEP newest finished hires. Before this the Map only ever grew — a soak
   * with worker churn reported `fleet.workers 24` while five bots were alive.
   * A worker still holding a body is never pruned: it is the live crew.
   */
  private prune() {
    for (const name of overflowNames([...this.workers.values()], KEEP)) this.workers.delete(name);
  }

  private async run(w: Worker) {
    try {
      // A worker loads a fraction of the world the primary does — chunks are
      // this process's biggest cost and an errand-runner does not need a
      // horizon (issue #44).
      w.body = await createLiveBody({ username: w.name, viewDistance: cfg.fleet.workerViewDistance as number });
    } catch (err) {
      w.status = 'failed';
      w.endedAt = Date.now();
      w.result = `Could not join the server: ${err instanceof Error ? err.message : err}`;
      this.persist();
      this.release(w);
      this.onProgress?.(w, w.result);
      return;
    }
    if (w.status === 'dismissed') { this.release(w); return; } // dismissed mid-connect
    // A body that exhausted its reconnect attempts is a corpse — without this
    // the step loop below would keep invoking an agent whose every tool call
    // rejects, burning steps (and tokens) until the cap. Fail fast instead.
    w.body.onGaveUp = (cause) => {
      if (w.status === 'working' || w.status === 'connecting') {
        w.status = 'failed';
        w.endedAt = Date.now();
        w.result = `Lost the server and could not reconnect (${cause}).`;
      }
    };
    // Worker reflex — same instinct as the primary's reflex rail, but cheaper:
    // no separate session or fork, the pain report rides the existing inbox
    // and lands in front of the NEXT step prompt. A worker mid-errand under
    // zombie attack hears about it exactly when it can act on it. Debounced:
    // one pending note at a time (three hits ≠ three notes).
    w.body.onEachBot((b) => {
      b.on('entityHurt', (entity) => {
        // mineflayer emits this with `undefined` whenever the damaged entity
        // is not in bot.entities — a normal race (damage for an entity out of
        // view, or one already removed), certain on a released body. Reading
        // `.id` off it threw a TypeError out of the EventEmitter and killed the
        // process, so the guard comes before the identity test, not after.
        if (!entity || !b.entity || entity.id !== b.entity.id) return;
        if (w.inbox.some((n) => n.startsWith('⚔️'))) return;
        const hp = b.health?.toFixed(0) ?? '?';
        // nearbyThreats guards e.position / uses id-compare (a proxy boundary
        // makes object identity lie) — a hand-rolled filter here once threw
        // TypeError out of the EventEmitter on a position-less entity (#5).
        const hostiles = nearbyThreats(b, 8);
        w.inbox.push(`⚔️ You just took damage (health now ${hp}/20${hostiles.length ? `; nearby hostiles: ${hostiles.join(', ')}` : '; attacker unclear'}). Defend yourself or retreat FIRST, then resume the task.`);
      });
      b.on('death', () => {
        // Same forensics as the primary: the spot is gone after respawn, and
        // the task materials are lying on it. Waypoint is per-worker so two
        // dying workers don't overwrite each other's corpse-run.
        const p = b.entity?.position;
        const where = p
          ? `at (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}) — saved as waypoint '${writePlace(`${w.name.toLowerCase()}_death`, p, `worker died here mid-task: ${w.task.slice(0, 60)}`, w.name).name}'`
          : 'position unknown';
        w.inbox.push(`💀 You DIED and respawned. Your items (task materials included) are on the ground ${where}, despawning in ~5 minutes. Recover them first if the task needs them, then resume.`);
      });
    });
    const { agent } = createMinecraftAgent(w.body.bot, {
      model: this.model,
      systemPrompt: WORKER_PROMPT,
      excludeTools: ['capture_view'],
      // Workers get kicked too, and a wedged worker step burns its whole
      // 30-minute wall clock waiting on an emitter that is never firing again.
      epoch: w.body.epoch,
    });
    // Workers get the same spinal cord as the primary, minus the theatre:
    // safety modes + auto_eat only (idleModes:false — a worker is always on
    // task; loot-lunging and gazing would fight the task for the legs).
    // Reflex reports ride the inbox like pain does, landing before the next
    // step. A worker mid-step counts as deliberately busy.
    let stepInFlight = false;
    // This worker's OWN legs (issue #22): its tools look the lock up by body, so
    // its reflexes must claim the same one — and never the primary's.
    const workerLegs = registerLegs(w.body, new LegsLock());
    const reflexes: ReflexHandle | null = startReflexes(w.body, {
      legs: workerLegs,
      deliberateBusy: () => stepInFlight,
      note: (text) => { if (!w.inbox.some((n) => n.startsWith('⚡'))) w.inbox.push(`⚡ ${text}`); },
      log: (_who, text) => this.onProgress?.(w, `⚡ ${text}`),
    }, { idleModes: false });
    w.status = 'working';
    this.onProgress?.(w, `joined the server, starting: "${w.task}"`);

    // try/FINALLY, not a tidy tail: everything above this line created something
    // that OUTLIVES the call — a 300ms reflex interval and an agent, both
    // closing over w.body. While the cleanup was merely the last statements of
    // the function, ANY throw in between (a rejected await outside the step's
    // own catch, persist(), an emitter handler) skipped stop()+release() and
    // left that interval ticking forever against a body nobody could reach: a
    // leaked libuv handle that is ALSO a GC root for a whole prismarine world,
    // which is issue #44 exactly. It matches the live probe's shape too —
    // handles.timers climbing 8 -> 28 -> 38 across one soak while fleet.bodies
    // read 1, i.e. the records were clean and something else held the bots.
    try {
      while (w.status === 'working') {
        if (w.steps >= MAX_STEPS) { w.status = 'done'; w.endedAt = Date.now(); w.result = `Hit the ${MAX_STEPS}-step cap.`; break; }
        if (Date.now() - w.startedAt > MAX_WALL_MS) { w.status = 'done'; w.endedAt = Date.now(); w.result = 'Hit the 30min wall-clock cap.'; break; }
        w.steps++;
        // Reflex notes (⚔️/⚡) are the body speaking, not the boss — label them so.
        const notes = w.inbox.splice(0).map((n) =>
          n.startsWith('⚔️') || n.startsWith('⚡') ? `\n${n}` : `\nNEW INSTRUCTION from StrandsBot: ${n}`).join('');
        try {
          // Same digest the primary's self-prompts get, with a local radar in
          // place of the sentinel — state instead of a perceive round-trip.
          const digest = worldDigest(w.body.bot, {
            threats: () => nearbyThreats(w.body!.bot),
            reflexRecent: (n) => reflexes?.recent(n) ?? [],
          });
          stepInFlight = true;
          const answer = String(await agent.invoke(
            `[task step ${w.steps}/${MAX_STEPS}] Your task: "${w.task}".${notes}\n` +
            `Your status right now:\n${digest}\n` +
            `Take the NEXT concrete step now. Report in 1-2 sentences. ` +
            `When the task is fully done — or impossible — end your reply with ${DONE}.`
          ));
          stepInFlight = false;
          const line = answer.replace(DONE, '').trim().slice(0, 300);
          w.journal.push(line);
          this.persist(); // each step lands on disk — a crash loses nothing
          this.onProgress?.(w, line);
          if (answer.includes(DONE)) {
            w.status = 'done';
            w.endedAt = Date.now();
            w.result = line;
            break;
          }
        } catch (err) {
          stepInFlight = false; // a thrown step must not leave the reflexes thinking we are busy
          const msg = err instanceof Error ? err.message : String(err);
          w.journal.push(`error: ${msg}`);
          // Same rule as journeys: one bad step is a hiccup, two in a row is fate.
          const last2 = w.journal.slice(-2);
          if (last2.length === 2 && last2.every((l) => l.startsWith('error:'))) {
            w.status = 'failed';
            w.endedAt = Date.now();
            w.result = msg;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));
      }
    } catch (err) {
      // An error that escaped the step loop ends the hire honestly instead of
      // becoming an unhandled rejection — which in Node 22 takes the whole
      // process down, bot and dashboard with it.
      w.status = 'failed';
      w.endedAt = Date.now();
      w.result = `Crashed mid-errand: ${err instanceof Error ? err.message : err}`;
    } finally {
      if (!w.result) w.result = w.journal[w.journal.length - 1] ?? '(no steps)';
      this.persist();
      this.onProgress?.(w, `${w.status}: ${w.result}`);
      // Cancel the TURN before anything else. This is the last live #44
      // retention: a model call that never settles keeps its own async frame,
      // the frame keeps the agent, the agent's tools close over the bot — so a
      // worker that ends while its step is still waiting on the provider leaves
      // a whole Bot reachable no matter how clean the record is. Measured on the
      // live stress bot: `confirmedAlive {bots: 8, agents: 4}` after a FORCED
      // major GC while fleet.bodies was 0, every column store empty and every
      // game socket shut. cancel() makes the invocation return with stopReason
      // 'cancelled', which settles the frame and lets all of it go; if the agent
      // is idle it is a documented no-op, so this is safe on every exit path.
      try { agent.cancel(); } catch { /* an idle or already-cancelled agent */ }
      // Then the spinal cord stops with the body, which leaves the world instead
      // of idling around the player as a ghost. Order matters: stop the tick
      // BEFORE releasing, or a tick can fire against a body whose tables were
      // just emptied (the crash of 8fe2342).
      reflexes?.stop();
      this.release(w);
    }
  }
}

/**
 * Drop everything heavy from a finished record, keeping the story. Pure so a
 * test can prove it: after this the record holds NO body, so nothing pins the
 * bot's chunk columns (issue #44 — 204MiB of ArrayBufferData was reachable
 * through bodies that had already left the server).
 */
export function stripHeavy(w: Worker): Worker {
  w.body = undefined;
  w.inbox.length = 0;
  if (w.journal.length > JOURNAL_KEEP) w.journal = w.journal.slice(-JOURNAL_KEEP);
  return w;
}

/**
 * Names to forget: finished hires beyond the newest `keep`. A worker holding a
 * body — or still connecting/working — is live crew and never overflows, no
 * matter how old, so a long job cannot be pruned out from under itself.
 */
export function overflowNames(workers: Worker[], keep: number): string[] {
  return workers
    .filter((w) => !w.body && w.status !== 'working' && w.status !== 'connecting')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
    .slice(keep)
    .map((w) => w.name);
}

/** The agent-facing tool: the primary bot manages its own workforce. */
export function fleetTools(fleet: Fleet) {
  const manageBots = tool({
    name: 'manage_bots',
    description:
      `Hire and manage worker bots — real second bodies that join the server and work a task autonomously in parallel with you (their own legs, no interference with yours). Use when a job splits into independent errands: hire "Chopper" to fell trees while you keep building. Actions: hire (name + task), status (all workers + journals), instruct (send a mid-task correction), dismiss (stop + disconnect). No headcount limit — hire as many as the job needs (each worker spends tokens per step, so dismiss idle ones); each caps at ${MAX_STEPS} steps / 30min. Workers cannot see chat — relay player wishes via instruct.`,
    inputSchema: z.object({
      action: z.enum(['hire', 'status', 'instruct', 'dismiss']),
      name: z.string().optional().describe('Worker username, e.g. "Chopper" (hire/instruct/dismiss)'),
      task: z.string().optional().describe('The task brief, concrete and checkable (hire)'),
      instruction: z.string().optional().describe('Mid-task correction/addition (instruct)'),
    }),
    callback: ({ action, name, task, instruction }) => {
      if (action === 'status') {
        const list = fleet.list();
        if (!list.length) return 'No workers hired yet.';
        return list.map((w) => ({
          name: w.name, status: w.status, task: w.task, steps: w.steps,
          recentSteps: w.journal.slice(-3), result: w.result,
        }));
      }
      if (!name) throw new Error(`'${action}' needs a worker name.`);
      if (action === 'hire') {
        if (!task) throw new Error("'hire' needs a task.");
        const w = fleet.hire(name, task);
        return `Hired ${w.name} — connecting now, will work autonomously: "${task}". Check on it with manage_bots status.`;
      }
      if (action === 'instruct') {
        if (!instruction) throw new Error("'instruct' needs an instruction.");
        return fleet.instruct(name, instruction)
          ? `Instruction queued for ${name} — it lands before their next step.`
          : `No active worker "${name}".`;
      }
      return fleet.dismiss(name) ? `${name} dismissed — leaving the server.` : `No worker "${name}".`;
    },
  });

  return [manageBots];
}

/**
 * 👷 The crew strip's data, honestly.
 *
 * Live soak 2026-08-17: `/api/state` showed a worker `Sparky` as
 * `{status:'interrupted', steps:0}` with no explanation — and it had been
 * showing it for FOURTEEN HOURS. Two separate defects, both visible only from
 * outside:
 *  - `interrupted` is a ledger verdict written at STARTUP for hires the last
 *    process died holding. It is news for a few minutes after a restart ("re-hire
 *    Sparky, here's its journal"), and litter forever after — the dashboard
 *    listed a ghost that no longer had a body, a task, or a chance.
 *  - the reason was already recorded in `w.result` ("Process died while this
 *    worker was on the task (0 step(s) in)") and simply never surfaced, so
 *    `steps: 0` read as a mysterious instant failure instead of a plain
 *    my-process-died.
 *
 * So: working/connecting workers always show; an interrupted one shows only
 * while it is still actionable (default 30min), and every card carries its
 * reason and its age. Pure so a test can age the ledger without a clock.
 *
 * Follow-up from the next soak (same day): a worker's whole visible life was
 * "appears while digging, disappears the instant it finishes". `Digger2` was
 * hired to report what it collected; the moment it succeeded — `briefing[1]
 * fleet: Worker Digger2 done after 1 step(s)`, body retired, `Digger2 left the
 * game` — its card was filtered out, so the REPORT never reached the dashboard
 * at all. An outcome is news precisely because it just happened, so terminal
 * statuses now linger for `terminalMs` (10min) carrying their result, and only
 * then fall off.
 */
export interface CrewCard {
  name: string;
  status: Worker['status'];
  steps: number;
  task: string;
  last?: string;
  /** why it ended / what happened — w.result, finally visible */
  reason?: string;
  ageMin: number;
  /** how long ago it finished — undefined while still on the job */
  endedMinAgo?: number;
}

export function crewSnapshot(
  workers: Worker[],
  now = Date.now(),
  staleMs = 30 * 60_000,
  terminalMs = 10 * 60_000,
): CrewCard[] {
  return workers
    .filter((w) => {
      if (w.status === 'working' || w.status === 'connecting') return true;
      // Ghosts are measured from the hire (a 14-hour-old 'interrupted' is
      // litter); a finished worker is measured from when it FINISHED, which is
      // the only moment its result is fresh.
      if (w.status === 'interrupted') return now - w.startedAt <= staleMs;
      return now - (w.endedAt ?? w.startedAt) <= terminalMs;
    })
    .map((w) => ({
      name: w.name,
      status: w.status,
      steps: w.steps,
      task: w.task,
      last: w.journal[w.journal.length - 1],
      reason: w.result,
      ageMin: Math.round((now - w.startedAt) / 60_000),
      endedMinAgo: w.endedAt === undefined ? undefined : Math.round((now - w.endedAt) / 60_000),
    }));
}

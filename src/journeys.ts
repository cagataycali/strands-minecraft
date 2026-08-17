/**
 * 🧭 Journeys — long-term goals that outlive a conversation turn. A journey
 * ITERATES: one persistent forked agent takes a step toward a goal, cools
 * down, takes the next — until it says [JOURNEY_DONE], someone stops it, or
 * it hits its caps. The right shape for goals that have no single answer,
 * only progress ("get a full set of iron tools", "build a house by the
 * lake", "explore until you find a village").
 *
 * The journey agent is a fork (Session.ask), so it shares the session history —
 * the typed/voice/chat surfaces SEE what the journey did, and the journey knows
 * what was said. One journey at a time by default: one body, one long-term
 * errand. The agent itself starts/checks/stops journeys via the journey tools,
 * so a player can just say "keep mining until you have 64 iron" and walk away.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session } from './session.js';
import { classifyProviderError } from './history-doctor.js';

import { cfg } from './config.js';

const MAX_ITERATIONS = cfg.journey.maxIterations;
const MAX_WALL_MS = cfg.journey.maxWallMs;
const COOLDOWN_MS = cfg.journey.cooldownMs;
const YIELD_MAX_MS = cfg.journey.yieldMaxMs; // max time a step waits for live turns to clear
const DONE = '[JOURNEY_DONE]';
/** How the model declares that this step is DELIBERATE waiting, not a stall:
 *  `[WAITING: 8 iron smelting in the furnace at (12,64,-3), ~90s left]`.
 *  Same rail as [JOURNEY_DONE] — a marker in its own reply, so no extra tool
 *  call and no state the model has to keep. */
const WAIT = /\[WAITING:\s*([^\]]{1,160})\]/i;
/** Patience is finite. Six waits in a row (≈2 minutes of clock at the waiting
 *  cooldown, or longer) is where "the furnace is smelting" stops explaining
 *  itself and someone should look. */
export const MAX_CONSECUTIVE_WAITS = cfg.journey.maxConsecutiveWaits;
/** A step that chose to wait shouldn't buy another model call three seconds
 *  later — smelting takes ~10s per item. Waiting steps cool down longer. */
const WAIT_COOLDOWN_MS = cfg.journey.waitCooldownMs;

/**
 * WHOSE fault ended this step — the difference between a lesson and a smear.
 *
 * A TypeError from our own code, a throttle, a dead socket or a transcript we
 * malformed say NOTHING about whether the goal is achievable. The soak
 * blacklisted "smelt iron, craft leggings" — a thing it had already done in that
 * world — because `msg.clone is not a function` crashed every model call for a
 * session (issue #29). Only a world that refuses is evidence about the world.
 */
export function failureOwner(err: unknown): { endedBy: 'crash' | 'error'; kind: string } {
  const kind = classifyProviderError(err).kind;
  return { endedBy: kind === 'unknown' ? 'error' : 'crash', kind };
}

/** Which ledger an ended journey belongs in — nothing is also an answer. */
export function ledgerVerdict(endedBy: Journey['endedBy'], doomed = false): 'completed' | 'too_hard' | 'none' {
  if (endedBy === 'goal') return 'completed';
  if (endedBy === 'error') return 'too_hard';
  if (endedBy === 'stopped') return doomed ? 'too_hard' : 'none';
  // cap/wall prove endurance, not achievement; crash/process-death/stale are ours.
  return 'none';
}

export interface Journey {
  id: string;
  goal: string;
  status: 'running' | 'done' | 'stopped' | 'error' | 'interrupted' | 'abandoned';
  /** WHY it ended — explicit, so the ledgers never classify by regexing free
   *  text (issue #6.2: a result that happened to start with 'Hit the ' was
   *  misfiled as a cap-hit and the finished goal never entered `completed`). */
  endedBy?: 'goal' | 'cap' | 'wall' | 'stopped' | 'error' | 'crash' | 'process-death' | 'stale';
  iterations: number;
  startedAt: number;
  journal: string[]; // one line per iteration
  result?: string;
}

/**
 * 🧾 The step critic's raw material: what the body looked like before a step.
 * Position, vitals, and the bag as name→count. Cheap to take, cheap to diff.
 */
export interface BodySnapshot {
  pos: { x: number; y: number; z: number };
  health: number;
  food: number;
  inv: Record<string, number>;
}

/**
 * One-line delta between two snapshots — the critic that keeps a journey
 * honest. The model REPORTS what it did; the diff shows what actually
 * changed ('Δ +12 cobblestone, -2 hp, moved 34m'). A journal whose deltas
 * read 'Δ nothing' three steps running is a stall no narration can hide —
 * exactly what the supervisor thinker greps for. Pure, so tests pin it.
 */
export function stepDelta(before: BodySnapshot, after: BodySnapshot): string {
  const parts: string[] = [];
  const names = new Set([...Object.keys(before.inv), ...Object.keys(after.inv)]);
  const gains: string[] = [], losses: string[] = [];
  for (const n of names) {
    const d = (after.inv[n] ?? 0) - (before.inv[n] ?? 0);
    if (d > 0) gains.push(`+${d} ${n}`);
    else if (d < 0) losses.push(`${d} ${n}`);
  }
  parts.push(...gains.slice(0, 4), ...losses.slice(0, 3));
  const hp = Math.round(after.health - before.health);
  if (hp !== 0) parts.push(`${hp > 0 ? '+' : ''}${hp} hp`);
  const food = after.food - before.food;
  if (food !== 0) parts.push(`${food > 0 ? '+' : ''}${food} food`);
  const moved = Math.hypot(after.pos.x - before.pos.x, after.pos.y - before.pos.y, after.pos.z - before.pos.z);
  if (moved >= 2) parts.push(`moved ${Math.round(moved)}m`);
  return parts.length ? `Δ ${parts.join(', ')}` : 'Δ nothing';
}

/**
 * 📏 The last steps, replayed to the model WITH their measured deltas.
 *
 * The Δ critic was write-only: it measured what actually changed, appended that
 * to the journal — and the model never saw it, so nothing could correct a wrong
 * belief. Live journal, 2026-08-17: a step reported "my 23 spare torches stay in
 * the bag for future use" and carried `[Δ -23 torch]` on the very same line. The
 * bot then planned its next step around torches it no longer had.
 *
 * So each step now opens with its predecessors and their brackets, framed as
 * what they are: measurement beats memory. Two lines is enough to catch drift
 * without spending the window on history the digest already covers; each is
 * clipped, and the newest comes last so it sits closest to the instruction.
 * Pure over journal lines so tests replay real journals.
 */
export function recentStepsBlock(journal: string[], keep = 2, clip = 220): string {
  const lines = journal.filter((l) => !l.startsWith('error:')).slice(-keep);
  if (!lines.length) return '';
  const body = lines
    .map((l, i) => `  ${lines.length - i === 1 ? 'last' : `${lines.length - i} ago`}: ${l.length > clip ? `${l.slice(0, clip)}…` : l}`)
    .join('\n');
  return `Your own last step(s), each ending in what the world MEASURED:\n${body}\n` +
    `The [Δ …] bracket is measured from your body and inventory, not from your account of it — where the two disagree, the bracket is right and your memory is wrong.\n`;
}

/**
 * 🧹 Which interrupted errands still deserve the agent's attention.
 *
 * On startup every interrupted journey queues a system note ("resume this if it
 * still makes sense"). That list was unbounded, and restarts accumulate: this
 * soak reached FOUR pending errands — including a 100-minute-old one with zero
 * steps done, whose goal ("recover my gear after death") the bot had already
 * outlived by dying again — and every one of them would ride in front of the next
 * turn. Fleet learned this with its ghost filter (a 14-hour 'interrupted' worker
 * is not news); journeys had not.
 *
 * Age is the whole signal, because a Minecraft world does not wait:
 *  - past `staleMs` (45 min) an errand is archaeology — retire it silently;
 *  - a ZERO-step errand past `emptyMs` (10 min) is worse than stale, it is
 *    empty: the note's promise that "progress is already in your inventory" is
 *    simply false, so there is nothing to resume;
 *  - of what remains, announce the freshest `maxAnnounce` (2). A mind handed
 *    four errands picks none well, and the older ones will age out on their own.
 * Retired means retired: status 'abandoned', so no later boot re-offers it.
 * Pure so the thresholds are tested without restarting anything.
 */
export function triageInterrupted(
  list: Journey[],
  now: number,
  opts: { staleMs?: number; emptyMs?: number; maxAnnounce?: number } = {},
): { announce: Journey[]; retire: Journey[] } {
  const staleMs = opts.staleMs ?? 45 * 60_000;
  const emptyMs = opts.emptyMs ?? 10 * 60_000;
  const maxAnnounce = opts.maxAnnounce ?? 2;
  const retire: Journey[] = [];
  const live: Journey[] = [];
  for (const j of list) {
    const age = now - j.startedAt;
    if (age > staleMs || (j.iterations === 0 && age > emptyMs)) retire.push(j);
    else live.push(j);
  }
  live.sort((a, b) => b.startedAt - a.startedAt); // freshest first
  return { announce: live.slice(0, maxAnnounce), retire: [...retire, ...live.slice(maxAnnounce)] };
}

/**
 * 🕰 A declared wait, but only if it names something to wait FOR.
 *
 * Live journal 2026-08-17: `Mined 2 iron ore from the first vein at (47,61,68);
 * pressing on to the next vein [Δ +4 dirt, +4 hp, -3 food, moved 11m] [waiting:
 * none, continuing next vein]`. The model treated the marker as a field to fill
 * in rather than an option to omit — and a sham wait is not free: it credits the
 * step as deliberate patience, so `trailingWaits` counts it, the cooldown
 * stretches to the waiting interval, and six of them in a row hand the supervisor
 * a 'patience exhausted' STALLED verdict about a bot that was mining the whole
 * time. Worse, it launders the one signal the Δ critic exists to deliver: this
 * very step gained dirt while claiming iron, and 'waiting' would have excused it.
 *
 * So the marker must carry a subject. 'none', 'nothing', 'n/a' and friends are
 * the model declining to wait, which is exactly what an absent marker means.
 */
export function declaredWait(answer: string): string | undefined {
  const raw = WAIT.exec(answer)?.[1]?.trim();
  if (!raw) return undefined;
  const bare = raw.toLowerCase().replace(/^[\s:'"-]+/, '').replace(/[.!,;\s]+$/, '');
  if (bare.length < 3) return undefined;
  if (/^(none|nothing|nope|no|not waiting|n\/?a|na|null|undefined|-+)\b/.test(bare)) return undefined;
  return raw;
}

/** Trailing journal lines that declared themselves waits. */
function trailingWaits(journal: string[]): number {
  let n = 0;
  for (let i = journal.length - 1; i >= 0 && journal[i].includes('[waiting:'); i--) n++;
  return n;
}

/**
 * 🕰 Chosen patience vs wedged — the signal the supervisor thinker judges on.
 *
 * `Δ nothing` used to be the whole stall test, so a bot standing at a furnace
 * doing exactly the right thing (nothing, correctly, for 40 seconds) looked
 * identical to a bot going in circles, and the supervisor stopped healthy
 * journeys (issue #12). A wait the model DECLARED is progress of a different
 * shape: it names what it waits for and what ends the wait.
 *
 * Patience is credited but bounded — past MAX_CONSECUTIVE_WAITS the verdict
 * flips to stalled on its own, so "the furnace is still going" can't hold a
 * journey open forever, and an undeclared no-change streak is still a stall.
 * Pure over journal lines so tests replay real journals.
 */
export type ProgressVerdict = 'progressing' | 'patient' | 'stalled';
export function progressVerdict(
  journal: string[],
  maxWaits = MAX_CONSECUTIVE_WAITS,
): { verdict: ProgressVerdict; blanks: number; waits: number; reason: string } {
  let blanks = 0;
  for (let i = journal.length - 1; i >= 0; i--) {
    const l = journal[i];
    if (l.includes('Δ nothing') || l.startsWith('error:')) blanks++;
    else break;
  }
  const waits = trailingWaits(journal);
  if (waits > maxWaits) {
    return { verdict: 'stalled', blanks, waits, reason: `${waits} waiting steps in a row — patience exhausted, the wait's own condition should have ended by now` };
  }
  if (blanks === 0) return { verdict: 'progressing', blanks, waits, reason: 'the last step changed something measurable' };
  const undeclared = blanks - waits;
  if (undeclared >= 3) {
    return { verdict: 'stalled', blanks, waits, reason: `${undeclared} consecutive steps with no measured change and no declared wait` };
  }
  if (waits > 0) {
    return { verdict: 'patient', blanks, waits, reason: `${waits} consecutive step(s) declared as deliberate waiting — nothing changing is the CORRECT outcome of waiting` };
  }
  return { verdict: 'progressing', blanks, waits, reason: `only ${blanks} no-change step(s) — too early to call a stall` };
}

/**
 * Journeys survive the process. The body survives a signed-chat kick, but a
 * crash or restart used to erase "keep mining until you have 64 iron" without
 * a trace — the player walked away trusting the errand, and nobody was left
 * holding it. Same file discipline as memory.ts: one human-readable JSON,
 * write-then-rename, read fresh at construction.
 */
const DIR = process.env.MEMORY_DIR ?? join(homedir(), '.strands-minecraft');
const FILE = join(DIR, 'journeys.json');
const KEEP = cfg.journey.keep; // newest journeys worth keeping on disk
/** In-memory journal lines per journey — the file keeps 20, the prompt reads the tail. */
const JOURNAL_MEMORY_KEEP = 60;

function loadFile(): { journeys: Journey[]; completed: string[]; tooHard: string[] } {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      journeys: Array.isArray(data.journeys) ? data.journeys : [],
      completed: Array.isArray(data.completed) ? data.completed : [],
      tooHard: Array.isArray(data.too_hard) ? data.too_hard : [],
    };
  } catch {
    return { journeys: [], completed: [], tooHard: [] };
  }
}

/**
 * Which journey ids to forget (issue #44). An unfinished journey is never
 * forgotten no matter how old — it is live state, and the ledger reads from
 * memory. Everything else is history, and history is what grows without bound:
 * an hour of churn ran dozens of journeys and the Map kept every one, journal
 * and all, because only the DISK write was ever capped.
 */
export function overflowJourneyIds(journeys: Journey[], keep: number): string[] {
  const finished = journeys
    .filter((j) => j.status !== 'running')
    .sort((a, b) => b.startedAt - a.startedAt);
  return finished.slice(keep).map((j) => j.id);
}

export class JourneyRunner {
  private session: Session | null = null;
  private journeys = new Map<string, Journey>();
  private stopFlags = new Set<string>();
  private doomedFlags = new Set<string>();
  /**
   * The goal ledgers: what worked and what didn't, surviving restarts. The
   * idle thinker reads them so it never re-proposes a goal that already
   * failed — and knows what the bot has genuinely achieved when picking the
   * next tech-tree step.
   */
  private completed: string[] = [];
  private tooHard: string[] = [];
  /** Called after each iteration — surfaces progress (console, game chat). */
  onProgress?: (j: Journey, step: string) => void;
  /** Wired by index.ts: body state before/after each step feeds the Δ critic. */
  snapshot?: () => BodySnapshot | undefined;
  /** Wired by index.ts: the world digest injected into every step prompt. */
  digest?: () => string;
  /**
   * Wired by index.ts to the SAME note queue a player turn drains.
   *
   * Measured 2026-08-18, soak32: a 44-minute journey, 25 "ARMED:" lines and 24
   * remedies naming exactly what to craft — and 130 swings, every one with a
   * FIST, 25 deaths at 19.8 per 100 damage episodes (the armed soak24 did 9.7).
   * The armed-fact rails (#46/#47) were honest and INERT, and this was why:
   * notes were drained by a player turn (index.run) and by the idle thinker,
   * and the thinker skips while `session.busy > 0`. During a 41-step journey a
   * step is nearly always in flight, so news the senses queued sat in the
   * queue — work.notes oldestAgeMs 1,569,640 — while the mind kept digging.
   *
   * A journey step is the one moment this bot both HAS the news and can act on
   * it. So the step drains the rail like any other turn. No policy is added:
   * "you died bare-handed, a stone sword costs 2 cobblestone + 1 stick" simply
   * arrives while the model is choosing what to do next, instead of after.
   */
  takeNotes?: () => string;

  constructor() {
    // A journey that was 'running' when the previous process died is now
    // INTERRUPTED — loaded so the agent can see it and decide whether the
    // errand still makes sense (never auto-resumed: the world, the player,
    // and the inventory may all have moved on).
    const file = loadFile();
    this.completed = file.completed;
    this.tooHard = file.tooHard;
    for (const j of file.journeys) {
      if (j.status === 'running') {
        j.status = 'interrupted';
        j.endedBy = 'process-death';
        j.result = j.result ?? `Process died mid-journey after ${j.iterations} step(s).`;
      }
      this.journeys.set(j.id, j);
    }
    if (this.interrupted.length) this.persist();
  }

  /**
   * Errands the last process died holding — but only the ones still worth
   * announcing. See `triageInterrupted`: the rest are retired here, once, so no
   * later boot re-offers them.
   */
  get interrupted(): Journey[] {
    const all = [...this.journeys.values()].filter((j) => j.status === 'interrupted');
    const { announce, retire } = triageInterrupted(all, Date.now());
    for (const j of retire) { j.status = 'abandoned'; j.endedBy = 'stale'; }
    if (retire.length) this.persist();
    return announce;
  }

  /** The ledgers, read-only — for thinker prompts and the status tool. */
  ledger(): { completed: string[]; tooHard: string[] } {
    return { completed: [...this.completed], tooHard: [...this.tooHard] };
  }

  private ledgerize(j: Journey) {
    // Explicit endedBy, never text-matching the result (issue #6.2). Cap and
    // wall endings prove endurance, not achievement — ledger neither way.
    const verdict = ledgerVerdict(j.endedBy, this.doomedFlags.has(j.id));
    if (verdict === 'completed') {
      this.completed.push(j.goal);
      // An entry in too_hard is a hypothesis, not a law: doing the thing refutes it.
      this.tooHard = this.tooHard.filter((g) => g !== j.goal);
    } else if (verdict === 'too_hard') this.tooHard.push(j.goal);
    this.doomedFlags.delete(j.id); // whatever happened, this journey is over
    this.completed = this.completed.slice(-20);
    this.tooHard = this.tooHard.slice(-20);
  }

  /**
   * Forget history the file already caps (issue #44). Two collections used to
   * grow for the life of the process: the journeys Map — with every journal
   * line of every journey ever run — and the stop/doomed flag Sets, which kept
   * an id long after the journey holding it was over.
   */
  private prune() {
    for (const id of overflowJourneyIds([...this.journeys.values()], KEEP)) {
      this.journeys.delete(id);
      this.stopFlags.delete(id);
      this.doomedFlags.delete(id);
    }
    // The journal of a LIVE journey is unbounded too: one long journey is a
    // step every few seconds for an hour. Keep more than the file does — the
    // prompt reads the tail, the critic reads the last line.
    for (const j of this.journeys.values()) {
      if (j.journal.length > JOURNAL_MEMORY_KEEP) j.journal = j.journal.slice(-JOURNAL_MEMORY_KEEP);
    }
  }

  private persist() {
    this.prune();
    try {
      mkdirSync(DIR, { recursive: true });
      const journeys = [...this.journeys.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, KEEP)
        .map((j) => ({ ...j, journal: j.journal.slice(-20) }));
      const tmp = `${FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify({ journeys, completed: this.completed, too_hard: this.tooHard }, null, 2));
      renameSync(tmp, FILE);
    } catch {
      /* a full disk must not kill the journey itself */
    }
  }

  /** Late-bound: the journey tools mount on the agent, the agent goes into the
   *  Session, and only then does the runner get its session — bind() breaks
   *  that construction cycle. */
  bind(session: Session) {
    this.session = session;
  }

  get running(): Journey | undefined {
    return [...this.journeys.values()].find((j) => j.status === 'running');
  }

  list(): Journey[] {
    return [...this.journeys.values()];
  }

  get(id: string): Journey | undefined {
    return this.journeys.get(id);
  }

  stop(id: string, opts: { doomed?: boolean } = {}): boolean {
    const j = this.journeys.get(id);
    if (!j || j.status !== 'running') return false;
    this.stopFlags.add(id);
    if (opts.doomed) this.doomedFlags.add(id);
    return true;
  }

  start(goal: string): Journey {
    if (!this.session) throw new Error('Journey runner not bound to a session yet.');
    if (this.running) throw new Error(`Already on a journey (${this.running.id}: "${this.running.goal}") — stop it first or wait.`);
    const id = `j${Date.now().toString(36)}`;
    const j: Journey = { id, goal, status: 'running', iterations: 0, startedAt: Date.now(), journal: [] };
    this.journeys.set(id, j);
    this.persist();
    void this.run(j);
    return j;
  }

  private async run(j: Journey) {
    while (j.status === 'running') {
      if (this.stopFlags.delete(j.id)) { j.status = 'stopped'; j.endedBy = 'stopped'; break; }
      if (j.iterations >= MAX_ITERATIONS) { j.status = 'done'; j.endedBy = 'cap'; j.result = `Hit the ${MAX_ITERATIONS}-iteration cap.`; break; }
      if (Date.now() - j.startedAt > MAX_WALL_MS) { j.status = 'done'; j.endedBy = 'wall'; j.result = 'Hit the 2h wall-clock cap.'; break; }
      // ONE body, one pair of legs: while a live turn (chat/voice/CLI) is in
      // flight, the journey waits its turn instead of yanking the pathfinder
      // out from under it (game-log.md: "pathfinding keeps getting yanked
      // around by my background task"). Humans preempt errands, never the
      // other way around.
      const yieldStart = Date.now();
      while (this.session!.busy > 0 && Date.now() - yieldStart < YIELD_MAX_MS) {
        await new Promise((r) => setTimeout(r, 500));
        if (this.stopFlags.has(j.id)) break;
      }
      if (this.stopFlags.delete(j.id)) { j.status = 'stopped'; j.endedBy = 'stopped'; break; }
      j.iterations++;
      const before = this.snapshot?.();
      try {
        const digest = this.digest?.();
        // News FIRST, before the goal: the senses' account of what happened
        // since the last step outranks the errand — it may be the reason the
        // next step should be something else entirely.
        const news = (this.takeNotes?.() ?? '').trim();
        const answer = await this.session!.ask(
          (news
            ? `News from your own senses since your last step — each line carries when it was true; ` +
              `if it changes what the next step should be, ACT on it and say so, otherwise carry on:\n${news}\n\n`
            : '') +
          `[journey ${j.id}, step ${j.iterations}/${MAX_ITERATIONS}] Long-term goal: "${j.goal}".` +
          (digest ? `\nYour status right now:\n${digest}\n` : ' ') +
          recentStepsBlock(j.journal) +
          `Take the NEXT concrete step toward it now. Report in 1-2 sentences what you did. ` +
          // Chosen patience has to be SAYABLE, or the Δ critic reads a furnace
          // wait as a stall and the supervisor kills a healthy journey
          // (issue #12). Waiting is a legitimate step — but only when named,
          // with the condition that ends it.
          `If this step is deliberate WAITING on something outside your control (a furnace smelting, crops growing, ` +
          `a player fetching something), say so with a marker: [WAITING: what you await and what ends the wait]. ` +
          `Never use it to pad a step you don't know how to take. ` +
          // The wait BUDGET is visible before it is blown, not only in the
          // post-mortem: the model can choose its last wait knowingly.
          (trailingWaits(j.journal) > 0
            ? `You have waited ${trailingWaits(j.journal)} step(s) in a row; past ${MAX_CONSECUTIVE_WAITS} consecutive waits the supervisor reads this journey as STALLED. ` : '') +
          `If the goal is fully achieved, end your reply with ${DONE}. If it is impossible, explain why and end with ${DONE}.`
        );
        // The Δ critic: what ACTUALLY changed, appended to the model's own
        // account. A 'Δ nothing' streak is a stall no narration can hide —
        // UNLESS the step declared itself a wait, which is recorded in the
        // same line so the supervisor reads chosen patience as patience.
        const after = this.snapshot?.();
        const delta = before && after ? ` [${stepDelta(before, after)}]` : '';
        const waited = declaredWait(answer);
        // Patience is credited, then bounded: past the cap the tail says so,
        // so the supervisor's own rule flips to STALLED without new prose.
        const waitsBefore = trailingWaits(j.journal);
        const waitTail = waited
          ? ` [waiting: ${waited.slice(0, 120)}${waitsBefore + 1 > MAX_CONSECUTIVE_WAITS ? ' ⚠ patience exhausted' : ''}]`
          : '';
        const line = (answer.replace(DONE, '').replace(WAIT, '').trim().slice(0, 300) + delta + waitTail).trim();
        j.journal.push(line);
        this.persist(); // each step lands on disk — an interrupt loses nothing
        this.onProgress?.(j, line);
        if (answer.includes(DONE)) {
          j.status = 'done';
          j.endedBy = 'goal';
          j.result = line;
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        j.journal.push(`error: ${msg}`);
        // One failed step doesn't kill an errand (a died bot mid-respawn, a
        // model hiccup) — but two in a row does.
        const last2 = j.journal.slice(-2);
        if (last2.length === 2 && last2.every((l) => l.startsWith('error:'))) {
          // WHOSE fault decides what the bot LEARNS (issue #29). A TypeError from
          // our own code, a throttle, a dead socket or a history we malformed say
          // nothing about the goal — the soak blacklisted a goal it had already
          // achieved because `msg.clone is not a function` crashed every model
          // call for a session. Only a world that refuses is evidence.
          const { endedBy, kind } = failureOwner(err);
          const ours = endedBy === 'crash';
          j.status = 'error';
          j.endedBy = endedBy;
          j.result = ours
            ? `Stopped by a fault in OUR stack (${kind}), not by the world: ${msg}. The goal is untested — retry it.`
            : msg;
          break;
        }
      }
      // A declared wait sleeps longer: 6 model calls in 20s cannot make iron
      // smelt faster, and the shorter tick is what turned patience into a
      // burst of identical no-change steps in the first place.
      const waiting = (j.journal[j.journal.length - 1] ?? '').includes('[waiting:');
      await new Promise((r) => setTimeout(r, waiting ? WAIT_COOLDOWN_MS : COOLDOWN_MS));
    }
    if (!j.result) j.result = j.journal[j.journal.length - 1] ?? '(no steps)';
    this.ledgerize(j);
    this.persist();
    this.onProgress?.(j, `journey ${j.status}: ${j.result ?? ''}`);
  }
}

/** The agent-facing tools: the bot manages its own journeys. */
export function journeyTools(runner: JourneyRunner) {
  const startJourney = tool({
    name: 'start_journey',
    description:
      'Begin a long-term background goal that outlives this conversation turn — you will automatically take a step toward it every few seconds until it is done ("collect 64 iron", "build a cobblestone tower", "explore north until you find a village"). Use for anything a player asks that takes many steps over minutes. Returns the journey id immediately; tell the player you started and will report progress.',
    inputSchema: z.object({
      goal: z.string().describe('The long-term goal, concrete and checkable'),
    }),
    callback: ({ goal }) => {
      const j = runner.start(goal);
      return `Journey ${j.id} started: "${goal}". Progress will be reported as steps complete.`;
    },
  });

  const journeyStatus = tool({
    name: 'journey_status',
    description: 'Check your journeys — current one and past ones, with their step-by-step journal.',
    inputSchema: z.object({
      id: z.string().optional().describe('A journey id; omit for all'),
    }),
    callback: ({ id }) => {
      const list = id ? [runner.get(id)].filter(Boolean) : runner.list();
      const ledger = runner.ledger();
      if (!list.length) return { journeys: 'none yet', ...ledger };
      return {
        journeys: list.map((j) => ({
          id: j!.id, goal: j!.goal, status: j!.status, iterations: j!.iterations,
          recentSteps: j!.journal.slice(-5), result: j!.result,
        })),
        completedGoals: ledger.completed.slice(-5),
        tooHardGoals: ledger.tooHard.slice(-5),
      };
    },
  });

  const stopJourney = tool({
    name: 'stop_journey',
    description: 'Stop the running journey after its current step lands. Mark doomed:true when the goal is impossible/misconceived (wrong game mode, unreachable, needs a player) — doomed goals land in the too-hard ledger and will not be re-proposed.',
    inputSchema: z.object({
      id: z.string().describe('The journey id'),
      doomed: z.boolean().optional().describe('true = impossible as stated, remember never to retry it as-is'),
    }),
    callback: ({ id, doomed }) => (runner.stop(id, { doomed }) ? `Journey ${id} will stop after the current step${doomed ? ' (ledgered as too hard)' : ''}.` : `No running journey ${id}.`),
  });

  return [startJourney, journeyStatus, stopJourney];
}

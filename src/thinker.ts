/**
 * 🧠 Thinker — the bot's inner monologue.
 *
 * When nobody has prompted the bot for a while, it prompts ITSELF: perceive,
 * reflect, optionally act. Three anti-goals keep it likeable:
 *  - Don't spam: only speak in chat when there's a clear reason (a player is
 *    near, danger, something notable). Silence is a fine outcome.
 *  - Stay safe: no reckless mining/fighting while unsupervised — survival
 *    housekeeping (eat, get to light, gather nearby resources) is the lane.
 *  - Yield instantly: any real request (chat/CLI/voice/journey) pauses idling —
 *    the thinker only runs when the session is quiet.
 *
 * TWO MODES (game-log.md lesson — "pathfinding keeps getting yanked around by
 * my background task"):
 *  - IDLE: no journey running → housekeeping as above, may move, may start a
 *    journey if something deserves one.
 *  - SUPERVISOR: a journey IS running → the legs belong to the journey. The
 *    thinker must NOT move; it reads the journey's journal, judges whether the
 *    errand is progressing or stalled (same step repeating, errors, drops it
 *    can't reach), and manages loops: stop a doomed journey, restart it with a
 *    sharper goal, or queue advice. Observation and judgement only.
 *
 * The thinker asks through the Session rather than a throwaway agent, so its
 * reflections land in the shared history: ask the bot "what did you do while
 * I was away?" and it actually knows.
 */
import type { Session } from './session.js';
import type { JourneyRunner } from './journeys.js';
import { progressVerdict } from './journeys.js';
import type { Fleet } from './fleet.js';

import { cfg } from './config.js';

/**
 * Idle cycles rotate through focus areas instead of repeating one generic
 * 'housekeeping' brief. One focus per cycle keeps each prompt small (this
 * runs every ~90s all night — prompt bloat here is a token furnace), while
 * the rotation guarantees the slow-burn duties actually come up: darkness
 * patrol was added to the toolset and then never once suggested to the
 * agent that idles past it. Vitals are ALWAYS in the brief; the focus is
 * what to do with the idle time once vitals are fine. Exported for tests.
 */
export const IDLE_FOCI: readonly string[] = [
  // survival basics — the original lane. A focus is a TOPIC, not a script:
  // the model owns what (if anything) each one is worth this cycle.
  'Survival basics: nearby drops, exposure for the hour it is, food if a meal is in reach — whatever cheap thing keeps you alive.',
  // base security — prevention, not reaction
  'Security patrol: is where you are settled lit and safe against spawns? check_darkness maps the dark spots and drafts a torch plan; what to do about it — and whether now — is your call.',
  // logistics — stock and waypoints
  'Logistics: take stock — short on food, torches, tools, or blocks? Fix what is cheap now, journey what is not. Tend waypoints: name the spot you keep returning to if it has no name yet.',
  // progression — the curriculum RULE (novel + verifiable + honor the ledgers).
  // The tech tree itself is the model's own knowledge, not ours to hardcode.
  'Progression: read your status digest and the goal ledgers above. What is the next tech-tree step your bag actually supports? Propose ONE novel task VERIFIABLE from your own state (inventory counts, a placed block, a crafted item) and start a journey for it. Never re-propose a too-hard goal; never re-do a completed one.',
];

/**
 * The one focus that is not a rotation: a bot that cannot heal.
 *
 * Live soak 2026-08-17: at 3.5 HP with an empty bag the bot whispered the
 * player for food and then wrote `I'll hold position until food arrives or
 * dawn regen kicks in` — there is no dawn regen in this game, and its food
 * gauge kept ticking down while it waited on a human who was asleep. Stating
 * the rule in the digest was not enough; the CYCLE has to stop offering it
 * torch patrols and tech-tree homework while it starves.
 */
export const SURVIVAL_OVERRIDE =
  'SURVIVAL OVERRIDE — you are badly hurt and cannot heal: health only regenerates at food >= 18, and nothing else heals you. '
  + 'Not waiting, not dawn, not a bed (a bed skips night, it does not feed you), not standing in a sealed box. '
  + 'Do NOT idle waiting for a player to bring food — ask once, then feed yourself. '
  + 'THIS cycle: get food by whatever route your own state supports; if it is more than a few steps away, start_journey for exactly that. '
  + 'If hostiles make that suicidal at this health, get safe first — but the goal stays food.';

/** Which focus this cycle gets — pure so the rotation is testable. */
export function pickFocus(cycle: number, vitals?: { health?: number; food?: number; foodPortions?: number }): string {
  // Starving, or hurt with nothing to eat: the rotation can wait.
  if (vitals && (vitals.foodPortions ?? 0) === 0
    && ((typeof vitals.health === 'number' && vitals.health < 10) || vitals.food === 0)) return SURVIVAL_OVERRIDE;
  return IDLE_FOCI[((cycle % IDLE_FOCI.length) + IDLE_FOCI.length) % IDLE_FOCI.length];
}

export class Thinker {
  private session: Session;
  private journeys: JourneyRunner;
  private fleet: Fleet | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivity = Date.now();
  private cycling = false;
  /** Journal length at the last supervisor look — stall = no growth since. */
  private lastJournalSeen = new Map<string, number>();
  /** Same, per worker: a worker whose journal stopped growing is stuck. */
  private lastWorkerSeen = new Map<string, number>();
  cycles = 0;
  enabled = process.env.THINKER_DISABLED !== 'true';
  intervalMs = cfg.thinker.intervalMs;
  /** Surfaces the reflection (console line, maybe chat). */
  onThought?: (thought: string) => void;
  /** Wired by index.ts: the world digest — injected into every self-prompt so
   *  the model reasons from state instead of opening with a perceive call. */
  digest?: () => string;
  /** Wired by index.ts alongside `digest`: the few numbers that can override
   *  the focus rotation outright (a starving bot has one job). */
  vitals?: () => { health?: number; food?: number; foodPortions?: number };

  constructor(session: Session, journeys: JourneyRunner, fleet: Fleet | null = null) {
    this.session = session;
    this.journeys = journeys;
    this.fleet = fleet;
  }

  /**
   * The fleet section of a thinking prompt — present in BOTH modes whenever
   * workers are live. Journeys own the primary's legs; workers own their OWN,
   * so fleet supervision never forbids movement — it forbids neglect. Without
   * this, a worker looping on a doomed task burns tokens for its full 30min
   * cap with nobody judging it between its terminal notes (iter11 only made
   * ENDINGS audible; this watches the middle).
   */
  private fleetBrief(): string {
    const live = this.fleet?.list().filter((w) => w.status === 'working' || w.status === 'connecting') ?? [];
    if (!live.length) return '';
    const lines = live.map((w) => {
      const seen = this.lastWorkerSeen.get(w.name) ?? 0;
      const grewBy = w.journal.length - seen;
      this.lastWorkerSeen.set(w.name, w.journal.length);
      return `  - ${w.name} (${w.status}, step ${w.steps}, ${grewBy} step(s) since your last look, task "${w.task}"): ${w.journal[w.journal.length - 1] ?? '(no steps yet)'}`;
    }).join('\n');
    return (
      `\nYour hired workers right now:\n${lines}\n` +
      `Judge each: progressing → leave it alone. Stuck (0 growth twice in a row, same line repeating, ` +
      `chasing something unreachable) → manage_bots instruct with ONE concrete correction, or dismiss and ` +
      `re-hire with a sharper brief. Worker legs are their own — managing them never conflicts with anything else you do.`
    );
  }

  /** Seconds until the next idle cycle could fire (null while disabled) — for /api/telemetry. */
  nextInS(now = Date.now()): number | null {
    if (!this.enabled || !this.timer) return null;
    return Math.max(0, Math.round((this.lastActivity + this.intervalMs - now) / 1_000));
  }

  /** Any human-initiated activity resets the idle clock. */
  touch() {
    this.lastActivity = Date.now();
  }

  start() {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => void this.maybeCycle(), Math.max(15_000, this.intervalMs / 3));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wired by index.ts to the system-note queue (worker reports, deaths,
   *  reconnects). Undelivered notes make an idle cycle fire IMMEDIATELY —
   *  news like "your worker failed" shouldn't wait out the idle window —
   *  and ride in front of the self-prompt, same as they ride a player turn. */
  takeNotes?: () => string;
  hasNotes?: () => boolean;

  private async maybeCycle() {
    if (this.cycling) return;
    const urgent = this.hasNotes?.() ?? false;
    if (!urgent && Date.now() - this.lastActivity < this.intervalMs) return; // someone's around
    if (this.session.busy > 0) return; // a real turn is running
    const journey = this.journeys.running;
    this.cycling = true;
    this.cycles++;
    try {
      const notes = this.takeNotes?.() ?? '';
      const base = journey ? this.supervisorPrompt(journey) : this.idlePrompt();
      const thought = await this.session.ask(notes ? `${notes}\n\n${base}` : base);
      this.onThought?.(String(thought).slice(0, 300));
    } catch {
      /* an idle cycle failing is not an event */
    } finally {
      this.cycling = false;
      // Idle work doesn't count as player activity — reset to now so cycles
      // repeat every intervalMs while the world stays quiet.
      this.lastActivity = Date.now();
    }
  }

  private idlePrompt(): string {
    const digest = this.digest?.();
    // ledger?.() — tests hand the thinker a stub journeys object; a missing
    // ledger must degrade to "no history", not kill the idle cycle.
    const ledger = this.journeys.ledger?.() ?? { completed: [], tooHard: [] };
    const ledgerLines =
      (ledger.tooHard.length ? `\nToo-hard ledger (goals that FAILED — never re-propose as-is): ${ledger.tooHard.slice(-5).map((g) => `"${g.slice(0, 60)}"`).join(', ')}.` : '') +
      (ledger.completed.length ? `\nCompleted goals: ${ledger.completed.slice(-5).map((g) => `"${g.slice(0, 60)}"`).join(', ')}.` : '');
    return (
      `[idle thinker, cycle ${this.cycles} — no player prompt for a while] ` +
      (digest ? `Your status digest (no need to perceive first — act on it):\n${digest}\n` : `Check on yourself first: get_status. `) +
      `Vitals beat everything below: eat if hungry, flee if in danger.` +
      ledgerLines +
      `\nThis cycle's focus — ${pickFocus(this.cycles, this.vitals?.())} ` +
      `If something deserves a longer errand, start a journey for it — one NOVEL task, verifiable from your own state; never a too-hard goal. ` +
      `If a player is nearby and something is worth saying, say ONE short line in chat — otherwise stay silent. ` +
      `If it is worth the player HEARING over voice (danger to them, a finished goal), voice_say one spoken sentence instead. ` +
      `Reply with one sentence about what you observed/did.` +
      this.fleetBrief()
    );
  }

  private supervisorPrompt(journey: NonNullable<JourneyRunner['running']>): string {
    const seen = this.lastJournalSeen.get(journey.id) ?? 0;
    const grewBy = journey.journal.length - seen;
    this.lastJournalSeen.set(journey.id, journey.journal.length);
    const recent = journey.journal.slice(-4).map((l, i) => `  ${i + 1}. ${l}`).join('\n');
    const digest = this.digest?.();
    // The stall test is COMPUTED, not left to the model's reading of a
    // journal: a furnace wait the step declared is patience, not a stall
    // (issue #12), and patience past its cap flips to stalled on its own.
    const prog = progressVerdict(journey.journal);
    return (
      `[journey supervisor, cycle ${this.cycles}] Journey ${journey.id} is running ` +
      `("${journey.goal}", step ${journey.iterations}, ${grewBy} step(s) since your last look). Recent journal:\n${recent}\n` +
      (digest ? `Status digest:\n${digest}\n` : '') +
      `The journey OWNS the body right now — you MUST NOT move, dig, place or pathfind in this turn. ` +
      `Your job is judgement, not labor. The [Δ …] tail on each journal line is measured truth (inventory/health/position diffs) — ` +
      `trust it over the narration. A [waiting: …] tail means the step DECLARED itself deliberate patience ` +
      `(a furnace smelting, crops growing): nothing changing is then the CORRECT outcome, not a stall.\n` +
      `Measured progress signal: ${prog.verdict.toUpperCase()} — ${prog.reason}. Start from this, not from the prose.\n` +
      `Read the journal and decide:\n` +
      `- PROGRESSING (steps differ, deltas show real change) → do nothing, reply one sentence.\n` +
      `- PATIENT (signal above says PATIENT: waiting on a named condition, still within its patience budget) → ` +
      `LEAVE IT ALONE, reply one sentence. Stopping a healthy wait wastes the smelt/growth already invested.\n` +
      `- STALLED (the signal says STALLED, or the same step repeats 3+, errors, wrong game mode, missing tool) → ` +
      `intervene: stop_journey and start_journey with a SHARPER goal that routes around the blocker ` +
      `(e.g. "craft a wooden axe first, then fell the spruce at (-16,31)"), or if only a player can unblock it ` +
      `(game mode, /give), say ONE short chat line asking.\n` +
      `- DOOMED (impossible as stated) → stop_journey with doomed:true and say one chat line explaining.\n` +
      `Never start a second journey while one runs unless you stopped it first. ` +
      `A STALLED or DOOMED verdict is worth the player hearing: voice_say one spoken sentence about it (what stalled and what you did). ` +
      `Reply with one sentence: your verdict and what you did.` +
      this.fleetBrief()
    );
  }
}

/**
 * Concurrent conversations over ONE shared history — fork and fold.
 *
 * The SDK forbids concurrent invoke on one Agent (ConcurrentInvocationError),
 * and that rule is right: two turns interleaving toolUse/toolResult pairs in
 * one messages array is a corrupt transcript. The answer is not a queue — it
 * is a FORK. A second request stands up a fresh Agent seeded with a SNAPSHOT
 * of the history (so it knows what came before), runs concurrently, and its
 * finished exchange is folded back in COMPLETION order.
 *
 * Two invariants, each of which was once a live bug:
 *  - Fork boundaries are IDENTITY-based (trackingId sets), never positional:
 *    a slice index goes stale the moment the parent history moves while the
 *    fork runs. `newMessages()` filters by inherited ids, trim/reorder-proof.
 *  - A fork must NOT manage its own history: the SDK's default sliding window
 *    splices messages in place when the fork's turn ENDS — before absorb() —
 *    so a long turn would eat its own output on the way home.
 *    NullConversationManager, and the session trims once, after folding.
 *
 * Mineflayer note: the shared physical body (one bot) is the real serializer —
 * two forks can THINK at once, but both moving the same legs is a fight. The
 * caller decides which requests may act (see index.ts: chat forks act, they
 * just refuse to double-book pathfinding — mineflayer cancels the older goal).
 */
import { Agent, Message, NullConversationManager, TextBlock } from '@strands-agents/sdk';
import { auditHistory, classifyProviderError, diagnose, healEmptyText, healHistory } from './history-doctor.js';

// Tunable like every other budget in the repo (THINKER_INTERVAL_MS,
// REFLEX_TICK_MS, WEB_FRAME_MS…). Floor of 8: below that a single agentic
// exchange cannot fit and the trimmer would thrash.
const SESSION_WINDOW = (() => {
  const n = Number(process.env.SESSION_WINDOW);
  return Number.isFinite(n) && n >= 8 ? Math.floor(n) : 120;
})();

/** Assert pair-integrity after every fold/trim, not just when it explodes.
 *  Off by default (it walks the whole history); on when hunting issue #14.
 *  Read per call, not at module load, so it can be flipped mid-session (and so
 *  a test doesn't need a fresh module graph to turn it on). */
const auditEnabled = () => process.env.HISTORY_AUDIT === 'true';
/** A throttle on a shared quota costs a turn otherwise — one retry, then out. */
const THROTTLE_RETRY_MS = (() => {
  const n = Number(process.env.THROTTLE_RETRY_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2_000;
})();

/**
 * Choose a cut for a sliding window over `msgs` that is TOTAL — it always
 * returns a valid reduction when the window is exceeded, instead of finding
 * "no valid trim point" and silently letting the history grow unbounded
 * (agentic histories are long runs of toolUse/toolResult pairs; a clean
 * plain-user-text boundary often simply does not exist in the last N).
 *
 * Strategy, in order:
 *  1. Walk FORWARD from the ideal cut to the next plain user-text message
 *     (no toolResult) — the classic boundary, trims a little extra.
 *  2. None ahead? Walk BACKWARD (trim less but trim SOMETHING).
 *  3. Still none (no clean boundary anywhere)? Cut at the ideal point but
 *     never between a toolUse and its toolResult: advance past a message
 *     whose head carries a toolResult (its toolUse is behind the cut), then
 *     mark the head for a synthesized user anchor so the transcript still
 *     starts user-first for the provider.
 *
 * Returns { cut, needsAnchor }: splice(0, cut), and when needsAnchor, unshift
 * a synthetic plain-user message. Exported for tests — pure, no Agent needed.
 */
export function chooseCut(
  msgs: ReadonlyArray<Pick<Message, 'role' | 'content'>>,
  window: number,
): { cut: number; needsAnchor: boolean } {
  if (msgs.length <= window) return { cut: 0, needsAnchor: false };
  const ideal = msgs.length - window;
  const hasToolResult = (m: Pick<Message, 'content'>) =>
    m.content?.some((c) => (c as { type?: string }).type === 'toolResultBlock') ?? false;
  const isCleanUser = (m: Pick<Message, 'role' | 'content'>) => m.role === 'user' && !hasToolResult(m);

  for (let i = ideal; i < msgs.length; i++) if (isCleanUser(msgs[i])) return { cut: i, needsAnchor: false };
  for (let i = ideal - 1; i > 0; i--) if (isCleanUser(msgs[i])) return { cut: i, needsAnchor: false };

  // No clean boundary anywhere. Pair-safe cut at the ideal point: a head
  // message carrying a toolResult belongs to a toolUse behind the cut —
  // advance until the head is not an orphaned result.
  let cut = ideal;
  while (cut < msgs.length && hasToolResult(msgs[cut])) cut++;
  if (cut >= msgs.length) return { cut: 0, needsAnchor: false }; // degenerate: keep all, warn upstream
  return { cut, needsAnchor: true };
}

/** Builds a fork: same model/prompt/tools, seeded history, no self-managing
 *  conversation window (the Session trims once, after folding). */
export type ForkFactory = (seed: Message[], conversationManager: NullConversationManager) => Agent;

export class Session {
  private agent: Agent;
  private forkFactory: ForkFactory;
  private active = 0;
  /** True exactly while the ROOT agent runs a turn (direct path). Folds that
   *  complete in that span would splice foreign messages between the root's
   *  in-flight toolUse and its toolResult — they queue here instead. */
  private rootBusy = false;
  /** Length of the shared history when the root's in-flight turn began, or null
   *  when no root turn is running. The seed boundary for concurrent forks. */
  private rootTurnStart: number | null = null;
  private pendingFolds: Message[][] = [];

  constructor(agent: Agent, forkFactory: ForkFactory) {
    this.agent = agent;
    this.forkFactory = forkFactory;
  }

  get messages(): Message[] {
    return this.agent.messages;
  }

  get busy(): number {
    return this.active;
  }

  /** Reported on every provider failure — what failed, and the shape we sent.
   *  Defaults to console; index.ts points it at the dashboard too. */
  onDiagnosis: (report: string) => void = (report) => console.warn(report);

  /**
   * One invoke, with the failure made legible (issue #14): the exception CLASS
   * is named, the message-role + tool-pair shape at the moment of failure is
   * dumped (ids only, never content), and a throttle — which is nobody's bug —
   * buys exactly one retry instead of costing the turn. A `ValidationException`
   * still throws: that one is ours, and it must stay loud.
   */
  private async invokeWatched(agent: Agent, text: string, history: () => Message[]): Promise<string> {
    const beforeIds = new Set(history().map((m) => m.trackingId));
    try {
      return String(await agent.invoke(text));
    } catch (err) {
      // Did OUR text already land? By IDENTITY, not by length: a heal can REMOVE
      // a message (a blockless one), and a shrunk history read as "nothing
      // landed" makes the retry re-ask — the double-user-message corruption this
      // whole method exists to avoid. Computed here, before any healing.
      const landed = history().some((m) => !beforeIds.has(m.trackingId));
      const resumeOrAsk = () => {
        const a = agent as unknown as { invoke: (arg?: unknown) => Promise<unknown> };
        return landed ? a.invoke(undefined) : a.invoke(text);
      };
      const p = classifyProviderError(err);
      this.onDiagnosis(diagnose(err, history()));
      // The clone crash is OUR defect but fully healable: rehydrate the plain
      // objects and retry this same turn instead of failing every turn until
      // someone restarts the process (in-game this looked like the bot
      // replying 'msg.clone is not a function' to everything).
      if (p.kind === 'local' && /clone is not a function/.test(p.message)) {
        const healed = healHistory(this.agent.messages as unknown[]);
        if (healed.length > 0) {
          this.onDiagnosis(`[session] healed ${healed.length} plain-object message(s) at ${healed.join(', ')} — retrying the turn`);
          return String(await resumeOrAsk());
        }
      }
      // The empty-text brick (issue #39): the provider quoted our own message
      // list, so the cure is local. Strip the wordless block(s) and retry this
      // same turn — otherwise EVERY later turn on EVERY rail is refused with
      // the same 400 until the window slides past it (the live soak lost the
      // mind for 4 minutes and 3 deaths that way).
      if (p.kind === 'history-empty-text') {
        const { stripped, removed } = healEmptyText(this.agent.messages as unknown[]);
        if (stripped.length + removed.length > 0) {
          this.onDiagnosis(`[session] healed empty text: stripped block(s) in message(s) ${stripped.join(', ') || 'none'}, dropped blockless message(s) ${removed.join(', ') || 'none'} — retrying the turn (a rail wrote a wordless message; the indices name the turn)`);
          return String(await resumeOrAsk());
        }
        // Nothing found: the block is in a FORK's history, or the window already
        // cut past it. Say so rather than retrying blindly into the same refusal.
        this.onDiagnosis('[session] empty-text refusal but no empty block in this history — it is upstream of this agent (fork seed) or already trimmed away');
      }
      if (!p.retryable) throw err;
      // The SDK appends the user message BEFORE calling the model and does not
      // roll it back when the call fails (deferred-append covers the assistant
      // side only). So passing `text` again would leave two consecutive user
      // messages — which is a ValidationException in its own right, i.e. the
      // retry would manufacture exactly the corruption we are hunting. When
      // our text already landed, resume from the history instead.
      // Jittered backoff, not a fixed pause: several agents sharing one model's
      // throughput hit the same throttle/stream-cut at once, so a constant
      // THROTTLE_RETRY_MS makes them all retry in lockstep and re-collide. A
      // random 0.5×–1.5× spread breaks the thundering herd (the 4-bot soak).
      const jittered = Math.round(THROTTLE_RETRY_MS * (0.5 + Math.random()));
      await new Promise((r) => setTimeout(r, jittered));
      this.onDiagnosis(`[session] retrying once after ${p.kind} (${p.name})${landed ? ' — resuming from history, not re-asking' : ''}`);
      return String(await resumeOrAsk());
    }
  }

  /** After a fold or a trim: is the shared history still something a provider
   *  will accept? Turns an intermittent 4xx into a local, named defect — and
   *  HEALS the one defect that bricks every subsequent turn: a plain object
   *  in the history (the SDK clones each message per call; `msg.clone is not
   *  a function` presented in-game as a bot that answers everything with the
   *  same error until restart). Rehydration is lossless via the SDK's own
   *  contentBlockFromData, so repair-and-report beats detect-and-crash. */
  private audit(where: string) {
    // Healing is UNCONDITIONAL — one typeof per message, and the defect it
    // repairs bricks every turn that follows. The audit's deeper shape checks
    // stay opt-in (HISTORY_AUDIT=true).
    // Both bricking defects are healed UNCONDITIONALLY here, because each one
    // costs every FUTURE turn on every rail, not just the turn that wrote it.
    const empty = healEmptyText(this.agent.messages as unknown[]);
    if (empty.stripped.length + empty.removed.length > 0) {
      this.onDiagnosis(`[session] HEALED empty text after ${where}: stripped block(s) in message(s) ${empty.stripped.join(', ') || 'none'}, dropped blockless message(s) ${empty.removed.join(', ') || 'none'} — one wordless block refuses the WHOLE history on every rail (issue #39)`);
    }
    const healed = healHistory(this.agent.messages as unknown[]);
    if (healed.length > 0) {
      this.onDiagnosis(`[session] HEALED ${healed.length} plain-object message(s) at index ${healed.join(', ')} after ${where} — a rail pushed literals into the history (find it: the indices name the turn)`);
    }
    if (!auditEnabled()) return;
    // requireInstances: this history is handed to the SDK, which clones every
    // message — a plain object here is a crash on the next turn (voice rail scar).
    const a = auditHistory(this.agent.messages, { requireInstances: true });
    if (a.ok) return;
    this.onDiagnosis(`[session] HISTORY AUDIT FAILED after ${where}: ${a.problems.join('; ')}\n[session] shape: ${a.shape}`);
  }

  /**
   * Ask the agent something. Always safe to call concurrently: the first
   * caller uses the session agent directly; while that runs, later callers
   * get a fork seeded from the current history, folded back on completion.
   */
  async ask(text: string): Promise<string> {
    // The last gate before the provider: a wordless prompt becomes an empty
    // user text block, and ONE of those makes the provider refuse the entire
    // history on every rail until it is removed (issue #39). Loud refusal
    // here is cheap; the alternative was a bricked mind and a 4-minute hunt.
    if (!(text ?? '').trim()) {
      throw new Error('session.ask: refusing an empty prompt — an empty text block poisons the whole history (issue #39). The rail that called this has nothing to say; it should not have asked.');
    }
    if (this.active === 0) {
      this.active++;
      this.rootBusy = true;
      // Where the root's turn BEGINS — the last point at which this history was
      // complete. Forks seed from here while the turn runs (see below).
      this.rootTurnStart = this.agent.messages.length;
      try {
        return await this.invokeWatched(this.agent, text, () => this.agent.messages);
      } finally {
        this.rootBusy = false;
        this.rootTurnStart = null;
        this.flushFolds(); // folds parked while the root turn ran land NOW — after the seam closed
        this.audit('root turn');
        this.active--;
      }
    }

    // Fork: snapshot the history as of the last point it was COMPLETE.
    //
    // Not simply "now": when the root is mid-turn, `now` includes its user
    // message and whatever tool traffic has landed so far, but NOT its answer.
    // A fork seeded there inherits an unanswered question, and the model does
    // what anyone would — it answers the question it can see. The live soak
    // caught exactly that (issue #25): a web ask to hire a worker forked off a
    // running journey step, hired the worker correctly, and then replied to the
    // CALLER with the journey's furnace narration. The asker was told about
    // smelting iron; their own answer was never spoken. Seeding from the turn
    // boundary makes that impossible by construction rather than by ordering
    // luck — a fork can no longer see another rail's pending prompt at all.
    //
    // Message instances are shared — their trackingIds are the boundary; the
    // array copy is what protects the seam. The root's own turn folds nothing:
    // its messages stay in its history, which the next seed will include.
    this.active++;
    const seed = this.rootTurnStart === null
      ? [...this.agent.messages]
      : this.agent.messages.slice(0, this.rootTurnStart);
    const seedIds = new Set(seed.map((m: Message) => m.trackingId));
    const fork = this.forkFactory(seed, new NullConversationManager());
    try {
      const r = await this.invokeWatched(fork, text, () => fork.messages);
      // Fold back in completion order; identity filter is trim/reorder-proof.
      const add = fork.messages.filter((m) => !seedIds.has(m.trackingId));
      if (this.rootBusy) {
        // The root agent is MID-TURN: pushing now can land between its
        // toolUse and the toolResult it is about to append. Park the fold;
        // the direct path's finally flushes it the moment the turn ends.
        this.pendingFolds.push(add);
      } else {
        this.agent.messages.push(...add);
        this.trim();
        this.audit('fold');
      }
      return String(r);
    } finally {
      this.active--;
    }
  }

  /** Land parked folds after the root turn's seam has closed. */
  private flushFolds() {
    if (this.pendingFolds.length === 0) return;
    const folds = this.pendingFolds.splice(0);
    for (const add of folds) this.agent.messages.push(...add);
    this.trim();
    this.audit(`flush of ${folds.length} parked fold(s)`);
  }

  /** Bound the shared history — only ever here, after a turn folds in.
   *  Total: always reduces an over-window history (see chooseCut), and the
   *  surviving head is guaranteed to be a clean user message — synthesized
   *  when the transcript had no natural boundary to reuse. */
  private trim() {
    const msgs = this.agent.messages;
    if (msgs.length <= SESSION_WINDOW) return;
    const { cut, needsAnchor } = chooseCut(msgs, SESSION_WINDOW);
    if (cut <= 0) {
      console.warn(`[session] window ${SESSION_WINDOW} exceeded (${msgs.length}) but no safe cut exists — keeping all`);
      return;
    }
    msgs.splice(0, cut);
    if (needsAnchor || msgs[0]?.role !== 'user') {
      msgs.unshift(new Message({ role: 'user', content: [new TextBlock('[earlier conversation trimmed]')] }));
    }
  }
}

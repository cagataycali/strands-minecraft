/**
 * ONE pair of legs, many callers — who gets the pathfinder right now?
 *
 * Arbitration used to be one-directional: a safety reflex could yank the
 * pathfinder off deliberate work, and the interrupted work recovered via the
 * journey 2-consecutive-error rule. The reverse had no rule at all, so an
 * agent turn (or an idle errand) was free to re-path over an in-flight FLEE.
 * The live soak caught exactly that at 3 HP (issue #16): both pathfinder
 * attempts inside one `dying` episode died with "The goal was changed before
 * it could be completed!" — the escape the body wanted never happened.
 *
 * So the escape takes a short-lived CLAIM on the legs. Two properties matter
 * more than the mechanism:
 *  - a claim is TIME-BOXED (ttlMs). A wedged escape must not freeze the bot's
 *    legs forever, so an expired claim is simply not a claim.
 *  - a refusal is TRUTHFUL and quotable: `deferMessage()` says what is running
 *    and for how long, so a deferred tool narrates reality instead of letting
 *    the model invent a cause for legs that moved under it (issue #8).
 *
 * Strictly-higher priority wins: a second safety reflex at the same rank
 * defers rather than re-pathing on top of the first, which is the #2 candidate
 * canceller from the issue. Same owner is re-entrant (a ladder rung retries).
 */

/** Rank of anything that may call `pathfinder.setGoal`. Higher wins. */
export const LEGS_PRIORITY = {
  /** About to die — one hit ends it. */
  dying: 100,
  /** Standing in lava/drowning/creeper in blast radius. */
  safety: 90,
  /** A human asked for it, right now. */
  agent: 50,
  /** A journey step: deliberate, but resumable. */
  journey: 40,
  /** Theatre and errands: item_magnet, elbow_room, idle_staring. */
  idle: 10,
} as const;

export interface LegsClaim {
  owner: string;
  priority: number;
  claimedAt: number;
  ttlMs: number;
  /** Short human phrase for the refusal message. */
  what?: string;
}

/** Who held the legs a moment ago — a claim's echo, kept so a rejection that
 *  lands after the release can still be attributed (issue #30). */
export interface LegsEcho {
  owner: string;
  what?: string;
  releasedAt: number;
}

export interface LegsRequest {
  owner: string;
  priority: number;
}

export type LegsVerdict =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string; heldBy: string; expiresInMs: number };

/** True when the claim is still inside its time box. */
export function claimIsLive(claim: LegsClaim | null | undefined, now: number): claim is LegsClaim {
  if (!claim) return false;
  return now - claim.claimedAt < claim.ttlMs;
}

/** Milliseconds until the claim self-expires (0 once it has). */
export function claimRemainingMs(claim: LegsClaim | null | undefined, now: number): number {
  if (!claim) return 0;
  return Math.max(0, claim.claimedAt + claim.ttlMs - now);
}

/**
 * THE decision, pure: may `req` take the legs while `claim` is held?
 *
 * No clock, no state, no bot — every rule in this file is testable from a
 * table, because at 3 HP is the wrong time to find out it isn't.
 */
export function mayTakeLegs(claim: LegsClaim | null | undefined, req: LegsRequest, now: number): LegsVerdict {
  if (!claimIsLive(claim, now)) return { allowed: true, reason: 'legs are free' };
  if (claim.owner === req.owner) return { allowed: true, reason: `${req.owner} already holds the legs` };
  if (req.priority > claim.priority) {
    return { allowed: true, reason: `${req.owner} (${req.priority}) outranks ${claim.owner} (${claim.priority})` };
  }
  const expiresInMs = claimRemainingMs(claim, now);
  return {
    allowed: false,
    reason: `deferred: ${claim.what ?? `the ${claim.owner} reflex`} has the legs for another ${(expiresInMs / 1000).toFixed(1)}s`,
    heldBy: claim.owner,
    expiresInMs,
  };
}

/**
 * What a DELIBERATE caller should do about a refusal, pure (issue #22).
 *
 * The claim used to be advisory: the reflex took it, and nothing on the other
 * side ever asked. `attack_entity`'s chase loop re-issued a follow goal every
 * swing while `creeper_flee` was pathing away from that same creeper, so both
 * paths of the flee died as "The goal was changed before it could be
 * completed!" and the escape degraded to a 1m blind sprint at melee range.
 *
 * A refusal is therefore not an error but a WAIT: safety leases are seconds
 * long, and a walk that starts 2s late still arrives. Only a lease longer than
 * the caller's patience becomes a truthful refusal the model can act on.
 */
export type LegsPlan =
  | { action: 'go' }
  | { action: 'wait'; ms: number; reason: string }
  | { action: 'refuse'; reason: string };

export function legsWaitPlan(verdict: LegsVerdict, maxWaitMs = 4_000): LegsPlan {
  if (verdict.allowed) return { action: 'go' };
  if (verdict.expiresInMs <= maxWaitMs) {
    // +50ms so the retry lands after expiry, not exactly on it.
    return { action: 'wait', ms: Math.max(0, verdict.expiresInMs) + 50, reason: verdict.reason };
  }
  return {
    action: 'refuse',
    reason: `${verdict.reason} — the body is handling something that outranks this. Do not re-issue movement yet; ask again after it clears.`,
  };
}

/** Pathfinder's own words for "someone else called setGoal under me". */
export function isGoalChangedError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err ?? '');
  return /goal was changed/i.test(m);
}

/**
 * Turn a "goal was changed" into a NAMED cause, pure.
 *
 * Anonymous cancellation is what let the thinker write false causes into the
 * journal ("likely some background disturbance", "moving between spots too
 * fast") and feed them to the supervisor. Whoever holds the legs at the moment
 * of the rejection is the answer, and when nobody does, that is worth saying
 * too — an unowned setGoal is a bug, not weather.
 */
export function explainGoalChange(
  claim: LegsClaim | null | undefined,
  myOwner: string,
  now: number,
  echo?: LegsEcho | null,
  echoWindowMs = 2_000,
): string {
  const live = claimIsLive(claim, now) ? claim : null;
  if (live && live.owner !== myOwner) {
    return `${live.what ?? `the ${live.owner} reflex`} (${live.owner}) took the legs mid-path`;
  }
  if (live && live.owner === myOwner) {
    // Two paths, one owner: the previous walk was still live when the next one
    // started. The world is fine and a retry works, but the SCHEDULING is not —
    // a tool returned while its legs were still moving.
    return `a newer ${myOwner} path replaced this one (same owner) — a tool returned while its walk was still live`;
  }
  // The rejection can outlive the claim: a reflex's TTL is short, and pathfinder
  // surfaces 'goal was changed' after the release. A recent echo is the answer.
  if (echo && echo.owner !== myOwner && now - echo.releasedAt <= echoWindowMs) {
    return `${echo.what ?? `the ${echo.owner} reflex`} (${echo.owner}) had the legs a moment ago and released them mid-path`;
  }
  // A same-owner echo is almost always the cancelled walk's OWN release firing in
  // its finally before we explain — crediting that would hide every genuine
  // unowned setGoal behind a self-accusation.
  // Everything accounted for and still cancelled: this one really is a code bug,
  // and it is the only case this sentence was ever meant to describe.
  return 'BUG: another rail called setGoal with NO claim on the legs — unowned movement, please report it';
}

/**
 * The rank a reflex mode claims/requests. `dying` sits above the other safety
 * modes on purpose: a re-firing `self_preservation` (3s cooldown) must not
 * re-path on top of an in-flight death escape — candidate canceller #2.
 */
export function legsRankOf(mode: { name: string; safety: boolean }): number {
  if (mode.name === 'dying') return LEGS_PRIORITY.dying;
  return mode.safety ? LEGS_PRIORITY.safety : LEGS_PRIORITY.idle;
}

/**
 * How long a mode may hold the legs. Generous enough for the escape ladder
 * (path ≤8s, then a blind sprint, then a 2.5s swing-back), short enough that a
 * wedged reflex costs the bot a few seconds rather than its legs.
 */
export function legsTtlOf(mode: { name: string; safety: boolean }): number {
  if (mode.name === 'dying') return 15_000;
  return mode.safety ? 10_000 : 2_000;
}

/**
 * The tiny stateful shell around that decision. Module-level singleton because
 * the legs are: every rail in the process shares one body.
 */
export class LegsLock {
  private claim: LegsClaim | null = null;
  private echo: LegsEcho | null = null;
  private seq = 0;
  private token = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  /** Non-committal question — used by tools and by lower-priority reflexes. */
  may(req: LegsRequest): LegsVerdict {
    return mayTakeLegs(this.claim, req, this.clock());
  }

  /**
   * Take the legs if allowed. Returns a release handle, or null when refused —
   * so `const held = lock.take(...); if (!held) return;` is the whole protocol.
   */
  take(req: LegsRequest & { ttlMs: number; what?: string }): { release: () => void; verdict: LegsVerdict } | null {
    const verdict = this.may(req);
    if (!verdict.allowed) return null;
    const token = ++this.seq;
    this.token = token;
    this.claim = { owner: req.owner, priority: req.priority, claimedAt: this.clock(), ttlMs: req.ttlMs, what: req.what };
    return {
      verdict,
      // Only the holder may release: a late `finally` from a superseded claim
      // must not hand away legs someone else now owns.
      release: () => {
        if (this.token !== token) return;
        // Leave a breadcrumb: a 'goal was changed' rejection often lands after
        // this, and an unattributed cancellation is what produced false journal
        // causes in the first place (issues #22, #30).
        this.echo = { owner: req.owner, what: req.what, releasedAt: this.clock() };
        this.claim = null;
      },
    };
  }

  /**
   * Take the legs, WAITING for a short lease to lapse instead of clobbering it.
   *
   * This is what deliberate rails call (issue #22): a walk that starts after a
   * 2s creeper flee still arrives, whereas a walk that starts *during* it kills
   * the flee and both callers lose. Returns null only when the holder outranks
   * the caller for longer than it is willing to wait — and then `lastRefusal`
   * carries the sentence to hand to the model.
   */
  async acquire(
    req: LegsRequest & { ttlMs: number; what?: string; maxWaitMs?: number },
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<{ release: () => void; verdict: LegsVerdict } | null> {
    const maxWaitMs = req.maxWaitMs ?? 4_000;
    const until = this.clock() + maxWaitMs;
    for (;;) {
      const plan = legsWaitPlan(this.may(req), Math.max(0, until - this.clock()));
      if (plan.action === 'refuse') { this.lastRefusal = plan.reason; return null; }
      if (plan.action === 'wait') { await sleep(plan.ms); continue; }
      const held = this.take(req);
      if (held) { this.lastRefusal = null; return held; }
      // Lost a race to another caller between plan and take — re-plan.
      if (this.clock() >= until) {
        this.lastRefusal = legsWaitPlan(this.may(req), 0).action === 'refuse'
          ? (this.deferMessage(req) ?? 'the legs are busy')
          : 'the legs are busy';
        return null;
      }
    }
  }

  /** Why the last `acquire` gave up — the sentence a tool should return. */
  lastRefusal: string | null = null;

  /** Name the rail that cancelled a path, instead of letting the model guess. */
  explainCancellation(myOwner: string): string {
    return explainGoalChange(this.claim, myOwner, this.clock(), this.echo);
  }

  /** Who held the legs most recently, live claim or fresh echo — for diagnostics. */
  lastHolder(): LegsClaim | LegsEcho | null {
    return this.held() ?? this.echo;
  }

  /** Who has the legs right now (null once the time box lapses). */
  held(): LegsClaim | null {
    return claimIsLive(this.claim, this.clock()) ? this.claim : null;
  }

  /**
   * The sentence a deferred caller should return to the model, or null when
   * nothing is holding the legs.
   */
  deferMessage(req: LegsRequest): string | null {
    const v = this.may(req);
    return v.allowed ? null : v.reason;
  }
}

/** The process-wide lock: one body, one pair of legs. */
export const legs = new LegsLock();

/**
 * WHICH pair of legs — one lock per BODY, not per process (issue #22).
 *
 * The primary and every hired worker set goals on different sockets, so a
 * process-wide lock would make a worker's flee refuse the primary's walk. Tools
 * are built once per body and closed over their bot, so the body object is the
 * natural key; `body.ts` hands out a stable Proxy whose identity survives a
 * reconnect, which is exactly what a WeakMap key needs.
 */
const perBody = new WeakMap<object, LegsLock>();

/** Bind a body to a lock (the primary passes the shared `legs` singleton). */
export function registerLegs(body: object, lock: LegsLock): LegsLock {
  perBody.set(body, lock);
  return lock;
}

/**
 * The lock for this body, created on first ask. A body nobody registered still
 * gets consistent arbitration — an unregistered stub in a test must not make
 * two callers think they both own the legs.
 */
export function legsFor(body: object): LegsLock {
  const found = perBody.get(body);
  if (found) return found;
  const fresh = new LegsLock();
  perBody.set(body, fresh);
  return fresh;
}

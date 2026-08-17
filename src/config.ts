/**
 * Every tunable in ONE registry — see HARDCODING.md.
 *
 * These are class-(b) knobs: values a deployment may reasonably want to turn
 * (budgets, ranges, cadences) but that are NOT judgment calls the model should
 * be making per-situation. Each has an env override and a one-line "why this
 * default". Values are read once at module load, same as the constants they
 * replaced — set env before import (tests already follow this discipline for
 * MEMORY_DIR).
 *
 * What does NOT belong here: protocol/physics constants (class (a) — they live
 * next to the code that speaks the protocol, deliberately hard to reach), and
 * per-situation decisions (class (c) — those move into tool parameters and
 * prompts so the MODEL owns them).
 */

/** Env number with fallback — empty/garbage env falls back rather than NaN-ing a timer. */
const str = (name: string, fallback: string): string => {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
};

/** A chunk count, or one of mineflayer's names ('far' | 'normal' | 'short' | 'tiny'). */
const viewDistance = (name: string, fallback: number): number | string => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
};

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A comma-separated env list (mob names, mode names). Empty entries are
 * dropped, so `FLYING_HOSTILES=` reads as "use the default" and
 * `NEVER_PUNCH=creeper,` is not a set containing "".
 */
const list = (name: string, fallback: readonly string[]): readonly string[] => {
  const raw = process.env[name];
  if (raw === undefined || !raw.trim()) return fallback;
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.length ? parts : fallback;
};

export const cfg = {
  journey: {
    /** JOURNEY_MAX_ITERATIONS — runaway guard; 500 steps ≈ a very long expedition, hit only when lost. */
    maxIterations: num('JOURNEY_MAX_ITERATIONS', 500),
    /** JOURNEY_MAX_WALL_MS — 2h: longer than any legitimate errand, short enough to notice a zombie loop. */
    maxWallMs: num('JOURNEY_MAX_WALL_MS', 2 * 60 * 60 * 1000),
    /** JOURNEY_COOLDOWN_MS — 3s between steps: keeps a journey from monopolizing the model. */
    cooldownMs: num('JOURNEY_COOLDOWN_MS', 3_000),
    /** JOURNEY_YIELD_MAX_MS — 60s max a step defers to live human turns before proceeding anyway. */
    yieldMaxMs: num('JOURNEY_YIELD_MAX_MS', 60_000),
    /** JOURNEY_MAX_WAITS — 6 consecutive [WAITING:] steps (~2min) before patience reads as a stall. */
    maxConsecutiveWaits: num('JOURNEY_MAX_WAITS', 6),
    /** JOURNEY_WAIT_COOLDOWN_MS — 15s: a step that chose to wait shouldn't buy a model call in 3s (smelting ≈10s/item). */
    waitCooldownMs: num('JOURNEY_WAIT_COOLDOWN_MS', 15_000),
    /** JOURNEY_KEEP — newest journeys worth keeping on disk. */
    keep: num('JOURNEY_KEEP', 10),
  },
  fleet: {
    /** FLEET_MAX_STEPS — 60 model turns per hire: a task bigger than that should be split or journeyed. */
    maxSteps: num('FLEET_MAX_STEPS', 60),
    /** FLEET_MAX_WALL_MS — 30min per hire: workers are errand-runners, not residents. */
    maxWallMs: num('FLEET_MAX_WALL_MS', 30 * 60 * 1000),
    /** FLEET_COOLDOWN_MS — 2s between worker steps. */
    cooldownMs: num('FLEET_COOLDOWN_MS', 2_000),
    /** FLEET_KEEP — finished-worker records kept on disk. */
    keep: num('FLEET_KEEP', 20),
    /**
     * FLEET_WORKER_VIEW_DISTANCE — how much WORLD a worker is allowed to load,
     * in chunks (a mineflayer name like 'tiny' or 'short' also works).
     *
     * Chunks are the biggest thing in this process (issue #44). Measured on a
     * real server, one bot standing still:
     *
     *   mineflayer default  637 columns
     *   'short'             329  (−48%)
     *   'tiny'              213  (−67%)
     *   3                    81  (−87%)
     *   2                    56  (−91%)
     *
     * 3 is the pick because it is also enough to travel: a worker at 3 walked
     * 60 blocks in 15s and its column count never moved off 81 — the world
     * unloads behind it as fast as it loads ahead. An errand-runner needs a
     * path, not a horizon; raise this for one sent prospecting.
     */
    workerViewDistance: viewDistance('FLEET_WORKER_VIEW_DISTANCE', 3),
  },
  thinker: {
    /** THINKER_INTERVAL_MS — 90s idle-reflection cadence: cheap enough to run all day, alive enough to matter. */
    intervalMs: num('THINKER_INTERVAL_MS', 90_000),
  },
  sentinel: {
    /** RADAR_POLL_MS — 1s hostile scan; cheaper than entityMoved (dozens/sec), fast enough for a walking mob. */
    radarPollMs: num('RADAR_POLL_MS', 1_000),
    /** RADAR_RANGE — 16 blocks: mob aggro range, so the radar sees what can already see us. */
    radarRange: num('RADAR_RANGE', 16),
    /** SECURITY_RANGE — 24 blocks around saved waypoints counts as "near my base". */
    securityRange: num('SECURITY_RANGE', 24),
    /** OXYGEN_REFLEX_AT — 6 bubbles (of 20): late enough to allow diving, early enough to surface alive. */
    oxygenReflexAt: num('OXYGEN_REFLEX_AT', 6),
  },
  voice: {
    /** VOICE_STALE_MS — 5min: a briefing older than this is history, not news; dropped, not spoken. */
    staleMs: num('VOICE_STALE_MS', 300_000),
    /** VOICE_QUEUE_CAP — 120 pending briefings; beyond it the least important oldest are evicted. */
    queueCap: num('VOICE_QUEUE_CAP', 120),
    /**
     * VOICE_URGENT_CEILING — 360: the hard stop that exists because importance-2
     * briefings were never evicted at all. A death spiral (18 deaths in 28
     * minutes, one soak where 26 of 27 pending were urgent) or a phantom swarm
     * makes that unbounded, and a headless bot with nobody listening keeps every
     * payload until the 5-minute stale sweep. Set well above queueCap so ordinary
     * danger still never loses a line: crossing it means the queue stopped being
     * news and became a backlog, and the OLDEST urgent goes first — a 5-minute-old
     * "fight NOW" is already the wrong thing to say out loud (#43).
     */
    urgentCeiling: num('VOICE_URGENT_CEILING', 360),
    /** VOICE_FLUSH_MS — 60s sweep for stale briefings so the queue can't rot between calls. */
    flushIntervalMs: num('VOICE_FLUSH_MS', 60_000),
    /**
     * VOICE_FRESH_MS — 30s: how long a briefing may still be spoken as a
     * PRESENT-TENSE fact. "A zombie is 2 blocks away" was true when it was
     * written; said 90s later it is a claim about a world that has moved (#43).
     * Inside this window the line goes out verbatim; outside it, it is stamped
     * with its age and framed as past news so the model can judge it.
     */
    freshMs: num('VOICE_FRESH_MS', 30_000),
    /**
     * VOICE_SPEAKABLE_MS — 120s: past this a briefing is not news in any tense
     * and is dropped (counted as perished), listener or not. This is why a
     * headless bot used to hold ~5 minutes of unhearable urgent lines: the only
     * shed rule was staleMs, so the queue kept everything nobody could hear.
     */
    speakableMs: num('VOICE_SPEAKABLE_MS', 120_000),
  },
  notes: {
    /** NOTES_CAP — 40 pending notes for the MIND rail; beyond it sightings are evicted before consequences. */
    cap: num('NOTES_CAP', 40),
    /**
     * NOTES_FRESH_MS — 30s, the mind rail's twin of VOICE_FRESH_MS: inside it a
     * note rides in front of the next turn verbatim, because it is still now.
     * Outside it the note is STAMPED with its age — a note is the model's
     * freshest-looking input, so an unstamped old one is read as the present.
     */
    freshMs: num('NOTES_FRESH_MS', 30_000),
    /**
     * NOTES_USABLE_MS — 120s: how long a PERISHABLE note (a mob sighting, the
     * clock, a reflex digest) can still inform a decision once hedged. Past it
     * the note never reaches the mind and is counted as perished with its
     * source. Durable facts (a death, a worker's result, a reconnect) have no
     * such window: they stay true until acted on, and only get the age stamp.
     * Measured live before this existed: work.notes oldestAgeMs 1,569,640 —
     * a 26-minute-old note still queued as present-tense news (#43's class).
     */
    usableMs: num('NOTES_USABLE_MS', 120_000),
  },
  web: {
    /** WEB_FEED_CAP — 300 feed events kept for late-joining dashboard clients. */
    feedCap: num('WEB_FEED_CAP', 300),
    /** SAY_WATCHDOG_MS — 90s before an unanswered say earns its first proof-of-life line. */
    sayWatchdogMs: num('SAY_WATCHDOG_MS', 90_000),
    /**
     * SAY_DEADLINE_MS — 10 minutes, after which the web rail stops waiting for
     * an ask and says so. Issue #41 caught a say open 1,598s while its receipt
     * insisted "the mind is busy, not lost"; a rail with no deadline can only
     * ever reassure. Generous on purpose: the slowest honest answer measured in
     * a soak was 619s, so anything past this is a lost ask, not a slow one.
     */
    sayDeadlineMs: num('SAY_DEADLINE_MS', 600_000),
  },
  reflex: {
    /** UNSTUCK_AFTER_MS — 20s of no movement with a goal before the unstuck mode may consider acting. */
    unstuckAfterMs: num('UNSTUCK_AFTER_MS', 20_000),
    /**
     * UNSTUCK_ACT_AFTER_WARNINGS / _MS / _GAP_MS — when a wedge earns the right
     * to free itself even though the mind holds the legs. soak36: eleven
     * "warning 1 of this wedge" lines, one of them at 184s stationary on 9/20
     * HP, because 'note' was the wedge's whole life while the mind stayed busy.
     */
    unstuckActAfterWarnings: num('UNSTUCK_ACT_AFTER_WARNINGS', 3),
    unstuckActAfterMs: num('UNSTUCK_ACT_AFTER_MS', 120_000),
    unstuckActGapMs: num('UNSTUCK_ACT_GAP_MS', 60_000),
    /** WEDGE_REJOIN_MS — 5 minutes: come back to the same 6-block cell inside this and it is the SAME wedge, warning count intact. */
    wedgeRejoinMs: num('WEDGE_REJOIN_MS', 300_000),
    /** CREEPER_EPISODE_MS — 90s of peace before a creeper's flee-count episode resets (ids never recur after death). */
    creeperEpisodeMs: num('CREEPER_EPISODE_MS', 90_000),
    /** FLEE_TIMEOUT_MS — 8s pathfinder budget per flee attempt before the escape ladder degrades. */
    fleeTimeoutMs: num('FLEE_TIMEOUT_MS', 8_000),
    /** FIGHT_BACK_MS — 2.5s cornered fight-back window when every escape rung failed. */
    fightBackMs: num('FIGHT_BACK_MS', 2_500),
    /** BLIND_SPRINT_MS — 1.5s pathfinder-free sprint+jump when pathing itself is what is failing. */
    blindSprintMs: num('BLIND_SPRINT_MS', 1_500),
    /** BURN_ESCAPE_DISTANCE — 6 blocks out of fire/lava: past splash range, cheap to path while burning. */
    burnEscapeDistance: num('BURN_ESCAPE_DISTANCE', 6),
    /** SIDESTEP_DISTANCE — 2 blocks clears the one column a falling block occupies, with margin. */
    sidestepDistance: num('SIDESTEP_DISTANCE', 2),
    /** DYING_ESCAPE_DISTANCE — 20 blocks at <5hp: outside aggro-follow for most mobs. */
    dyingEscapeDistance: num('DYING_ESCAPE_DISTANCE', 20),
    /** HAZARD_COOLDOWN_MS — gap between two self_preservation hazard actions. */
    hazardCooldownMs: num('HAZARD_COOLDOWN_MS', 3_000),
    /** EVAC_SWIM_MS — how long one evacuation swim gets before it is graded. */
    evacSwimMs: num('EVAC_SWIM_MS', 4_000),
    /** EVAC_GRACE_MS — settle time before an evacuation is graded on ground
     *  truth. soak41 graded on the frame the swim stopped, which is exactly
     *  when a swimming body's head is out of the water. */
    evacGraceMs: num('EVAC_GRACE_MS', 1_200),
    /** EVAC_LATERAL_RADIUS — how far sideways an evacuation looks for an open
     *  water column when the roof overhead seals the way up (soak42 swam 10m
     *  straight into a ceiling and was told to swim again). 8 blocks is a
     *  couple of seconds of swimming at 6 hp — further than that, digging
     *  through the ceiling is the cheaper answer. */
    evacLateralRadius: num('EVAC_LATERAL_RADIUS', 8),
    /** DIG_HP_RESERVE — hp an underwater dig refuses to spend on drowning.
     *  A dig longer than (air left + survivable drowning down to this) is
     *  UNPAYABLE and must not be started: soak43 put its last 3 bubbles into a
     *  bare-handed stone dig that the game prices at ~10s underwater. 4 hp is
     *  one zombie hit plus a short fall, which still has to be survivable when
     *  the body finally surfaces. */
    digHpReserve: num('DIG_HP_RESERVE', 4),
  },
  /**
   * Issue #38 — the body's answer to something already hitting it. A hostile
   * inside melee reach is the creeper-dodge class of problem: its next swing
   * lands in under a second, so no model round-trip can be part of the answer.
   * The BODY swings; the mind hears facts afterwards and owns the tactics.
   */
  combat: {
    /**
     * MELEE_ANSWER_REACH — how close something has to be before the body wakes
     * up and answers it. A TRIGGER radius, deliberately wider than striking
     * distance: a diving phantom crosses it in a fraction of a second, and
     * waking early costs nothing because `swingReach` still governs the swing.
     */
    answerReach: num('MELEE_ANSWER_REACH', 4),
    /**
     * The distance a swing can actually LAND — mechanism, not preference, so it
     * takes no env knob (HARDCODING.md rule 1): a survival player's attack_range
     * attribute is 3.0 blocks, and `bot.attack()` does not range-check, it just
     * sends the interact packet the server then silently drops.
     *
     * Issue #45 measured the cost of conflating this with the trigger radius:
     * 71 of 120 swings in one soak opened at 3-4m and killed nothing, while all
     * 4 kills came from inside 2m. Each of those was a no-op that still burned a
     * swingIntervalMs slot of the burst — and made the outcome line claim the
     * mob "broke off to 4.4m" when it had never been inside striking distance.
     */
    swingReach: 3.0,
    /**
     * How many times ONE burst may try to get the right thing into the hand —
     * mechanism, so no env knob (HARDCODING.md rule 1). Issue #50: the draw used
     * to be a single window click fired before the burst, and a click the server
     * silently dropped left the body swinging dirt for the whole burst. Retrying
     * is free when it succeeds (the plan collapses to `none` once the hand
     * agrees) and must be bounded when it does not, or a refusing server would
     * spend every swing slot on clicks instead of on the mob.
     */
    drawAttempts: 3,
    /** MELEE_SWING_MS — 600ms between swings ≈ the 1.6-attack/s cadence of a stone/iron sword; faster only wastes cooldown. */
    swingIntervalMs: num('MELEE_SWING_MS', 600),
    /** MELEE_BURST_MS — 1.6s of swinging per reflex firing: long enough for 3 hits, short enough that `dying` can preempt on the next tick. */
    burstMs: num('MELEE_BURST_MS', 1_600),
    /** MELEE_ANSWER_COOLDOWN_MS — 400ms between burst firings; the mob is still in reach, so this is a cadence, not a rate limit. */
    answerCooldownMs: num('MELEE_ANSWER_COOLDOWN_MS', 400),
    /** MELEE_NOTE_MS — at most one facts note per 12s, so a long fight cannot flood the note rail (issue #32). */
    noteIntervalMs: num('MELEE_NOTE_MS', 12_000),
    /**
     * FLYING_HOSTILES — mobs a ground path CANNOT outrun (issue #34: the
     * `dying` escape kept pathing 20m away from a phantom that flies at 1.2
     * blocks off your face). For these, standing and swinging is the only
     * winnable answer; the mind may still choose to shelter.
     */
    flyers: list('FLYING_HOSTILES', ['phantom', 'ghast', 'blaze', 'vex', 'wither', 'ender_dragon', 'breeze', 'bee']),
    /**
     * NEVER_PUNCH — hostiles the body must not answer with a swing. Punching a
     * primed creeper is the death `creeper_flee` exists to avoid.
     */
    neverPunch: list('NEVER_PUNCH', ['creeper']),
  },
  /**
   * 🪤 Issue #48 — how long a mutating tool waits before it believes its own
   * read-back. Mechanism, not preference (HARDCODING.md rule 1): these are
   * properties of the protocol, not tastes. A window click is applied to the
   * LOCAL inventory mirror the instant it is sent, and a server rejection
   * arrives one round-trip later — so a tool that reads the bag immediately is
   * reading its own intent. `confirmMs` is how long we wait for a change to
   * show up at all; `settleMs` is the hold after it, during which a rollback
   * would land and unmask a false success.
   */
  tools: {
    confirmMs: 1_000,
    settleMs: 600,
  },

  deaths: {
    /**
     * A death SITE, not a coordinate: 6 blocks is a room, and soak36's four
     * deaths landed at (1,67,30) x3 and (-2,66,30) — five blocks apart and
     * obviously the same grave. Mechanism, not policy: these are the numbers
     * that decide whether two deaths are the same news, so they live in source
     * (no env knob) like cfg.tools.settleMs.
     */
    sameSiteRadius: 6,
    /** 45 min — past it a place that killed you is history, not a pattern. */
    windowMs: 45 * 60_000,
    /** how many deaths the store keeps; a night of soaking is ~30 */
    keep: 60,
    /**
     * How recently something must have hit us for it to be named as the killer.
     * mineflayer's 'death' event carries no cause, so the last damage source IS
     * the evidence — but only while it is fresh: a zombie that scratched us two
     * minutes before a fall into lava did not kill us, and a confidently wrong
     * killer is worse for the mind's reasoning than no killer at all (#48).
     */
    causeFreshMs: 10_000,
  },

  memcheck: {
    /** MEM_PROBE_MS — 30s heap+collection sample. Slow enough to be free for a
     *  whole night, fast enough that a 51-minute leak (issue #44) shows a slope
     *  within the first few minutes instead of only in the crash dump. */
    probeIntervalMs: num('MEM_PROBE_MS', 30_000),
  },
} as const;

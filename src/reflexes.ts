/**
 * ⚡ Reflexes — the spinal cord. Priority-ordered survival behaviors on a
 * ~300ms tick, ZERO model calls. A creeper detonates in ~1.5s and a lava
 * pocket kills in ~3; a language model round-trip loses that race every
 * time, so the code acts first and the model hears about it afterwards.
 *
 * The contract with the mind:
 *  - One mode fires per tick (first match in priority order), and only one
 *    reflex ACTION runs at a time — one body, one choke-point.
 *  - SAFETY modes (1-4) may yank the pathfinder from under a journey step or
 *    a live turn. That is the point: pain beats plans. The interrupted work
 *    recovers on its own — pathfinder.goto rejects, the tool reports the
 *    error, the step re-plans. No LLM call is spent on resuming.
 *  - IDLE modes (5-9) run only when nothing deliberate is happening
 *    (no session turn in flight, no pathfinder goal) — housekeeping must
 *    never fight the mind for the legs.
 *  - Every execution lands in a behavior log ring; when a safety reflex
 *    interrupted deliberate work, ONE digest note is queued (edge-triggered,
 *    rate-limited) so the model learns "your mining was interrupted by
 *    creeper_flee, here's what the body did" instead of guessing.
 *
 * Knobs: REFLEX_MODES_DISABLED=true kills the tick; REFLEX_MODES_OFF is a
 * comma list of mode names to disable individually; REFLEX_TICK_MS retunes.
 */
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import pkg from 'mineflayer-pathfinder';
import type { LiveBody } from './body.js';
import { hostilesNear } from './digest.js';
import { LegsLock, legsRankOf, legsTtlOf, LEGS_PRIORITY } from './legs.js';
import { standingHazards, drowningEscape, oxygenReading, shoreDirection, drowningUrgency, bestArmorUpgrades, awayFrom, bestFood, stuckVerdict, stuckNoteDue, stuckAdvice, wedgeSiteKey, wedgeSee, wedgeEscalation, wedgeAge, wedgeSiteFact, type WedgeMemory, escapeLadder, escapeRetry, escapeBudgetMs, classifyEscapeFailure, bestMeleeWeapon, isMeleeWeapon, handNow, handsSummary, handTheft, drawVerdict, drawPlan, swingVerdict, swingRange, readArmed, creeperVerdict, foodRemedy, probeFoodWorld, gradeEvacuation, waterColumn, lateralAirColumn, pillarBlock, digPlan, type DigCandidate, type DigPlan, type EvacNext, type StandingHazard, type ArmorSlot } from './tools/helpers.js';
import { cfg } from './config.js';

const { goals } = pkg;

export interface ReflexDeps {
  /** Is the mind mid-turn (live request or journey step)? Gates idle modes + digest wording. */
  deliberateBusy: () => boolean;
  /** Queue an edge-triggered digest for the model (pendingNotes rail). */
  note: (text: string) => void;
  /** Dashboard/console visibility. */
  log?: (who: string, text: string) => void;
  /**
   * Which pair of legs to arbitrate. The primary body passes the process-wide
   * singleton so the agent's movement tools share it; a fleet worker has its
   * OWN connection, so it gets its own lock and never blocks the primary.
   */
  legs?: LegsLock;
}

export interface ReflexOptions {
  /** Workers get safety+eat but no theatre (they're always on task). */
  idleModes?: boolean;
  tickMs?: number;
}

export interface ReflexHandle {
  stop: () => void;
  /** Last few behavior-log lines — food for the world digest. */
  recent: (n?: number) => string[];
  /** Sizes of the reflex memories, by name, for the memory probe (issue #44). */
  sizes: () => Record<string, number>;
}

interface Mode {
  name: string;
  safety: boolean; // may interrupt deliberate work
  cooldownMs: number;
  /**
   * Does this mode MOVE the body? Default true. `fight_back` swings in place —
   * it is arms, not legs — so it must not claim (and therefore must not
   * supersede) a walk's claim on the pathfinder: a claim taken for something
   * that never calls setGoal is exactly the false "no claim on the legs"
   * diagnosis of issue #30, and destroying a live walk's claim record makes the
   * walk's own cancellation unexplainable.
   */
  needsLegs?: boolean;
  /** Return a narration-producing action to run this tick, or null. */
  check: () => (() => Promise<string>) | null;
}

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;

export interface MeleeCandidate { name?: string; dist: number }

/** Is this mob one a ground path cannot outrun? (cfg.combat.flyers) */
export function isFlyingHostile(name: string | undefined, flyers: readonly string[] = cfg.combat.flyers): boolean {
  return !!name && flyers.includes(name.toLowerCase());
}

/**
 * WHICH hostile the body answers with a swing, purely: the nearest one inside
 * reach that is not on the never-punch list. Everything else (there are four
 * more phantoms at 8 blocks, we are at 3 hp, the cave is that way) is the
 * mind's business — this function exists so the tick cannot accidentally
 * develop tactics.
 */
export function meleeAnswerTarget<T extends MeleeCandidate>(
  candidates: readonly T[],
  opts: { reach?: number; neverPunch?: readonly string[] } = {},
): T | null {
  const reach = opts.reach ?? cfg.combat.answerReach;
  const neverPunch = opts.neverPunch ?? cfg.combat.neverPunch;
  return candidates
    .filter((c) => c.dist <= reach && !neverPunch.includes((c.name ?? '').toLowerCase()))
    .sort((a, z) => a.dist - z.dist)[0] ?? null;
}

/**
 * At <5 hp with something on top of you: run, or turn and fight?
 *
 * Issue #34's whole death log is one answer repeated — `path 20m` away from a
 * PHANTOM, which flies, follows, and hits you in the back the entire way (and
 * whose path gets cancelled by the next reflex anyway). A ground escape from a
 * flyer inside reach is not a plan, it is a slower death, so the body fights.
 * Ground mobs can genuinely be walked away from, so those still flee.
 */
export function dyingAnswer(
  o: { threat?: MeleeCandidate; reach?: number; flyers?: readonly string[]; neverPunch?: readonly string[] },
): 'fight' | 'flee' {
  const reach = o.reach ?? cfg.combat.answerReach;
  const neverPunch = o.neverPunch ?? cfg.combat.neverPunch;
  const t = o.threat;
  if (!t || t.dist > reach) return 'flee';
  if (neverPunch.includes((t.name ?? '').toLowerCase())) return 'flee';
  return isFlyingHostile(t.name, o.flyers ?? cfg.combat.flyers) ? 'fight' : 'flee';
}

/**
 * 🩸 At <5 hp: what is actually killing us, and is running an answer at all?
 *
 * soak41, verbatim: `[dying] health 0/20 after a 2-damage hit — disengaging the
 * AREA: NO escape worked (…) — still at (2, 61, -53), hostiles: none visible`.
 * With no hostile within 16 blocks the old code fled from
 * `position.offset(1, 0, 0)`, i.e. `awayFrom()` returned a point 20 blocks along
 * −x: an arbitrary compass direction chosen by an off-by-one placeholder. The
 * bot was drowning and starving on a sandbar. Twenty blocks of −x is not an
 * escape from either, and paying for it costs the one thing that was still
 * working — the legs, and the claim protecting them.
 *
 * So the verb follows the KILLER, pure and table-testable:
 *  - a flyer in reach is fought (that was #34's original finding),
 *  - a ground mob is fled,
 *  - a standing hazard (lava, water over the head) is EVACUATED — a 20m path
 *    through the thing that is drowning you is the bug, not the cure,
 *  - and when nothing is visible and nothing is underfoot, the body stands down
 *    and says so, because the damage came from the world (hunger, suffocation,
 *    a fall) and no direction is safer than another.
 */
export type DyingPlan =
  | { act: 'fight'; why: string }
  | { act: 'flee'; why: string }
  | { act: 'evacuate'; why: string; hazard: StandingHazard }
  | { act: 'stand_down'; why: string };

export function dyingPlan(o: {
  threat?: MeleeCandidate & { dist: number };
  hazards?: readonly StandingHazard[];
  reach?: number;
  flyers?: readonly string[];
  neverPunch?: readonly string[];
}): DyingPlan {
  const reach = o.reach ?? cfg.combat.answerReach;
  const hazards = o.hazards ?? [];
  const t = o.threat;
  // Something on top of us outranks the terrain: it hits for 2-3 hp a second.
  if (t && t.dist <= reach) {
    const answer = dyingAnswer({ threat: t, reach, flyers: o.flyers, neverPunch: o.neverPunch });
    return answer === 'fight'
      ? { act: 'fight', why: `the ${t.name ?? 'threat'} is ${t.dist.toFixed(1)}m away and flies — running is not an escape` }
      : { act: 'flee', why: `the ${t.name ?? 'threat'} is ${t.dist.toFixed(1)}m away and can be walked away from` };
  }
  const hazard = hazards.find((h) => h.kind === 'burning') ?? hazards.find((h) => h.kind === 'water_over_head');
  if (hazard) {
    return { act: 'evacuate', why: `nothing is chasing us — ${hazard.detail} is what is doing the damage, so the answer is OUT of this block, not 20m of pathfinding`, hazard };
  }
  if (t) return { act: 'flee', why: `the ${t.name ?? 'threat'} is ${t.dist.toFixed(1)}m away — putting distance between us is still worth the legs` };
  return {
    act: 'stand_down',
    why: 'no hostile in sight and no hazard underfoot — the damage is coming from the world (hunger, suffocation, a fall), and no direction is safer than another',
  };
}

export function startReflexes(body: LiveBody, deps: ReflexDeps, opts: ReflexOptions = {}): ReflexHandle | null {
  if (process.env.REFLEX_MODES_DISABLED === 'true') return null;
  const off = new Set((process.env.REFLEX_MODES_OFF ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const tickMs = opts.tickMs ?? Number(process.env.REFLEX_TICK_MS ?? 300);
  const bot = body.bot; // reconnect-surviving proxy
  const lock = deps.legs ?? new LegsLock();

  const behaviorLog: string[] = [];
  const remember = (line: string) => {
    behaviorLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (behaviorLog.length > 50) behaviorLog.shift();
    deps.log?.('reflex', line);
  };

  // ---- shared body-state trackers (fed by events, read by checks) ---------
  let lastDamageAt = 0;
  let lastDamageAmount = 0;
  let starvationAlarmed = false;
  // Air TREND, not just air level (soak41: 16 evacuations at 19/20 air while
  // starvation did the killing). Sampled on the reflex tick, which is the same
  // clock the urgency decision runs on.
  let prevOxygen: number | undefined;
  let oxygenFallingAt = 0;
  let evacAttempts = 0;
  let lastEvacAt = 0;
  let prevHealth: number | undefined;
  body.onEachBot((b) => {
    b.on('health', () => {
      const h = b.health;
      if (typeof h !== 'number') return;
      if (prevHealth !== undefined && h < prevHealth - 0.5) {
        lastDamageAt = Date.now();
        lastDamageAmount = prevHealth - h;
      }
      prevHealth = h;
    });
    b.on('death', () => {
      prevHealth = undefined; lastDamageAt = 0;
      // A death is a NEW disarmament: everything droppable is on the ground at
      // the corpse, so the shortfall arithmetic the mind was last given is
      // stale. soak29 died 4 times inside one unarmed episode and the alarm,
      // latched since the first fist, never spoke again.
      rearmUnarmedAlarm();
      starvationAlarmed = false; // the corpse holds the food arithmetic too
    });
  });

  const blockNameAt = (x: number, y: number, z: number) => bot.blockAt?.(new Vec3(x, y, z))?.name;
  /**
   * The hunger fact WITH its payable remedy (issue #34). soak41 ended with the
   * bot at 0.166 hp asking a human 63 blocks away for food; the arithmetic was
   * never the problem, the errand was. Only called from a body, so the
   * distances are the world's, never invented.
   */
  /**
   * Am I actually OUT of the water? Three facts, not one: head clear, feet
   * clear, and something solid underfoot (issue #34 — 'head is OUT' was true
   * sixteen times while the body floated in a lake at 0 hp).
   */
  const groundTruth = (fallback: Vec3): { headClear: boolean; feetInWater: boolean; standingOnSolid: boolean; headBlock?: string; headSealed?: boolean } => {
    const p = bot.entity?.position ?? fallback;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const isWater = (n?: string) => n === 'water' || n === 'flowing_water' || n === 'bubble_column';
    const below = blockNameAt(fx, fy - 1, fz);
    const solid = !!below && !isWater(below) && below !== 'air' && below !== 'cave_air' && below !== 'lava' && below !== 'flowing_lava';
    // WHAT IS AT HEAD HEIGHT, from the registry rather than a name list: the
    // live #34 probe found a body in a 1-block water pocket with SANDSTONE at
    // head height being told "the head is clear", because !isWater is true of
    // rock. That body is suffocating, not treading water — a different remedy.
    // boundingBox is the game's own answer, so tall grass and vines (head-high
    // and harmless) never get mistaken for a wall.
    const headBlk = bot.blockAt?.(new Vec3(fx, fy + 1, fz)) as { name?: string; boundingBox?: string } | undefined;
    return {
      headClear: !isWater(headBlk?.name),
      feetInWater: isWater(blockNameAt(fx, fy, fz)),
      standingOnSolid: solid,
      headBlock: headBlk?.name,
      headSealed: headBlk?.boundingBox === 'block',
    };
  };

  /**
   * A failed evacuation must try something DIFFERENT. Swimming again is what
   * soak41 did sixteen times; the mechanisms that actually leave open water are
   * placing a block under your own feet and digging through the ceiling.
   */
  /**
   * ⛏️ PAY FOR A DIG, OR SAY IT CANNOT BE PAID FOR.
   *
   * The one mechanism both dig-outs share (drowning under a ceiling and
   * suffocating inside a wall). soak43 lost its last three bubbles to
   * `bot.dig` raced against a flat 5s timeout with a fist in the hand, and the
   * game prices bare-handed stone at 187.5s for a floating, submerged body —
   * ~7.5s dry, ×5 underwater, ×5 again off the ground. So: price every hand,
   * compare against the air, EQUIP the cheapest hand, let go of the legs
   * (movement cancels digging), and size the timeout to the price.
   */
  /**
   * The pricing half of `payDig`, on its own so the number can be PRINTED
   * without digging anything. soak38's lesson, applied here: a rail that
   * computes something and never logs it is indistinguishable from a rail that
   * does nothing — so the body says what a dig-out would cost at boot, against
   * the real registry and the real block over its head, before any emergency
   * needs the answer to be right.
   */
  const priceDig = (
    target: { name?: string; type?: number; digTime?: (t: number | null, c: boolean, w: boolean, g: boolean) => number },
    opts: { lateralExit?: boolean; canPillar?: boolean; where?: string } = {},
  ): DigPlan => {
    const p = bot.entity?.position;
    const inWater = p ? (blockNameAt(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z)) ?? '').includes('water') : false;
    const offGround = bot.entity?.onGround === false;
    const priceWith = (type: number | null): number => {
      try {
        // The game's own arithmetic, penalties included — not an estimate.
        if (typeof target.digTime === 'function') return target.digTime(type, false, inWater, offGround);
      } catch { /* fall through to the bot's own reading */ }
      try { return bot.digTime?.(target as never) ?? Infinity; } catch { return Infinity; }
    };
    const tools = (bot.inventory?.items() ?? []).filter((i) => /_(pickaxe|shovel|axe|hoe|shears)$/.test(i.name));
    const candidates: DigCandidate[] = [{ digMs: priceWith(null) }, ...tools.map((i) => ({ name: i.name, digMs: priceWith(i.type) }))];
    return digPlan({
      block: target.name ?? 'the block',
      candidates,
      // Out of the water there is no bubble bar to spend: what limits a dry dig
      // is the hp the wall or a mob is taking, so the air reads full.
      airUnits: inWater ? (oxygenReading(bot.oxygenLevel)?.units ?? 0) : 20,
      health: bot.health ?? 0,
      hpReserve: cfg.reflex.digHpReserve,
      held: bot.heldItem?.name,
      where: opts.where,
      lateralExit: opts.lateralExit,
      canPillar: opts.canPillar,
    });
  };

  const payDig = async (
    target: { name?: string; type?: number; digTime?: (t: number | null, c: boolean, w: boolean, g: boolean) => number },
    opts: { lateralExit?: boolean; canPillar?: boolean; where?: string } = {},
  ): Promise<{ plan: DigPlan; line: string }> => {
    const name = target.name ?? 'the block';
    const where = opts.where ?? 'overhead';
    const plan = priceDig(target, { ...opts, where });
    if (!plan.payable) return { plan, line: plan.line };
    try {
      bot.clearControlStates();
      bot.pathfinder?.setGoal(null);
      if (plan.tool) {
        const item = bot.inventory?.items().find((i) => i.name === plan.tool);
        if (item) await bot.equip(item, 'hand');
      }
      await Promise.race([
        bot.dig(target as never),
        // The timeout is the PRICE plus slack, capped by what the body can pay:
        // a flat 5s was both too long for 3 bubbles and too short for stone.
        new Promise((_r, rej) => setTimeout(() => rej(new Error('dig timeout')), Math.min(plan.budgetMs, plan.digMs * 1.5 + 1_000))),
      ]);
      return { plan, line: `DUG UP through ${name} ${where} — ${plan.line}${plan.tool ? ` (equipped ${plan.tool.replace(/_/g, ' ')} first)` : ' (bare fist was the fastest hand I hold)'}` };
    } catch (err) {
      return { plan, line: `could not dig the ${name} ${where}: ${err instanceof Error ? err.message : String(err)} — ${plan.line}` };
    }
  };

  const escalateEvacuation = async (
    next: EvacNext,
    exit?: { x: number; y: number; z: number; dist: number; toAir: number },
  ): Promise<string> => {
    if (next === 'nothing') return 'nothing more needed';
    if (next === 'swim_again') return 'swimming again on the next tick (attempt budget not spent yet)';
    if (next === 'swim_lateral') {
      // UP is sealed and there IS an open column nearby: the mechanism is a
      // SIDEWAYS swim, held for the same budget, then read back on the ground.
      if (!exit) return 'wanted to swim sideways to an open column but none was in reach';
      const from = bot.entity?.position?.clone();
      bot.pathfinder?.setGoal(null);
      try {
        await bot.lookAt(new Vec3(exit.x + 0.5, exit.y + 0.5, exit.z + 0.5), true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        await new Promise((r) => setTimeout(r, cfg.reflex.evacSwimMs));
        bot.clearControlStates();
        await new Promise((r) => setTimeout(r, cfg.reflex.evacGraceMs));
      } catch { bot.clearControlStates(); }
      const p2 = bot.entity?.position;
      const moved = from && p2 ? from.distanceTo(p2) : 0;
      const after = p2 ? waterColumn(p2, blockNameAt) : undefined;
      const truth = groundTruth(from ?? new Vec3(exit.x, exit.y, exit.z));
      if (truth.headClear && !truth.feetInWater && truth.standingOnSolid) {
        return `SWAM SIDEWAYS ${moved.toFixed(1)}m to the open column at ${fmt(new Vec3(exit.x, exit.y, exit.z))} and I am OUT, standing on solid ground`;
      }
      return after?.kind === 'blocked'
        ? `swam sideways ${moved.toFixed(1)}m toward the open column at ${fmt(new Vec3(exit.x, exit.y, exit.z))} and there is STILL ${after.block} overhead at y=${after.y} — digging up is the only mechanism left`
        : `swam sideways ${moved.toFixed(1)}m toward the open column at ${fmt(new Vec3(exit.x, exit.y, exit.z))}: the way up is open now (${after?.kind === 'open' ? `${after.toAir} blocks of water to air` : 'water above'}), surfacing on the next tick`;
    }
    const counts: Record<string, number> = {};
    for (const i of bot.inventory?.items() ?? []) counts[i.name] = (counts[i.name] ?? 0) + i.count;
    if (next === 'pillar') {
      const block = pillarBlock(counts);
      if (!block) {
        deps.note('(reflex) I cannot get OUT of this water: swimming has failed twice, there is no shore in reach, and the bag holds NOTHING placeable to stand on. A block of anything (dirt, sand, cobblestone, planks) is the whole remedy — mine one, or pick a direction and swim to real land, because treading water is not survival.');
        return 'ESCALATION IMPOSSIBLE: nothing placeable in the bag to stand on — handed to the mind';
      }
      const item = bot.inventory?.items().find((i) => i.name === block);
      const p = bot.entity?.position;
      if (!item || !p) return `wanted to pillar with ${block} but the body could not be read`;
      try {
        await bot.equip(item, 'hand');
        const ref = bot.blockAt?.(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
        bot.setControlState('jump', true);
        await new Promise((r) => setTimeout(r, 350));
        if (ref) await bot.placeBlock(ref as never, new Vec3(0, 1, 0));
        bot.setControlState('jump', false);
        const after = groundTruth(p);
        return after.standingOnSolid && !after.feetInWater
          ? `PILLARED OUT: placed ${block} under my feet and I am standing on it`
          : `placed (or tried to place) ${block} under my feet and I am STILL in the water — the placement did not hold`;
      } catch (err) {
        bot.setControlState('jump', false);
        return `could not place ${block} under my feet: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // dig_up: submerged with a ceiling — the only way out is through it. The
    // ceiling is whichever block is lowest: the one AT head height if that is
    // what seals the body in, else the one above it.
    const p = bot.entity?.position;
    const at = (dy: number) => (p ? bot.blockAt?.(new Vec3(Math.floor(p.x), Math.floor(p.y) + dy, Math.floor(p.z))) : undefined);
    const head = at(1) as { name?: string; boundingBox?: string } | undefined;
    const above = head?.boundingBox === 'block' ? head : at(2);
    if (!above || above.name === 'water' || above.name === 'air') return 'nothing solid overhead to dig through — the water column is open, so swimming up is the only mechanism left';
    const lateralNow = p ? lateralAirColumn(p, blockNameAt, cfg.reflex.evacLateralRadius) : undefined;
    const outcome = await payDig(above as never, { lateralExit: !!lateralNow, canPillar: !!pillarBlock(counts) });
    if (!outcome.plan.payable) {
      // REFUSED OUT LOUD, then the seconds go somewhere they can buy something.
      if (outcome.plan.fallback === 'swim_lateral' && lateralNow) return `${outcome.line} → ${await escalateEvacuation('swim_lateral', lateralNow)}`;
      if (outcome.plan.fallback === 'pillar') return `${outcome.line} → ${await escalateEvacuation('pillar')}`;
      deps.note(`(reflex) I am sealed under ${above.name} and CANNOT dig out in time: ${outcome.line}`);
    }
    return outcome.line;
  };

  const starvationFact = (): string | undefined => {
    const food = bot.food;
    if (typeof food !== 'number' || food >= 18) return undefined;
    const counts: Record<string, number> = {};
    for (const i of bot.inventory?.items() ?? []) counts[i.name] = (counts[i.name] ?? 0) + i.count;
    const remedy = foodRemedy({
      food,
      health: bot.health ?? 20,
      counts,
      world: probeFoodWorld(bot as never),
      // Priced from where the body is at the moment the fact is spoken.
      at: bot.entity?.position,
    });
    return remedy.line;
  };
  // ONE radar for the whole codebase (issue #6.4) — hostilesNear guards
  // positions and compares ids; this closure just fixes the bot argument.
  const hostiles = (range: number): Array<{ e: Entity; dist: number }> => hostilesNear(bot, range);
  const idle = () => !deps.deliberateBusy() && !bot.pathfinder?.goal && !bot.pathfinder?.isMoving?.();
  const flee = async (
    from: { x: number; y: number; z: number },
    distance: number,
    opts: { tolerance?: number; timeoutMs?: number } = {},
  ) => {
    const me = bot.entity.position;
    const to = awayFrom(me, from, distance);
    bot.pathfinder.stop();
    bot.pathfinder.setGoal(null);
    bot.setControlState('sprint', true);
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(to.x, me.y, to.z, opts.tolerance ?? 2)),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('flee timeout')), opts.timeoutMs ?? cfg.reflex.fleeTimeoutMs)),
      ]);
    } finally {
      bot.setControlState('sprint', false);
    }
    return to;
  };

  /**
   * Flee, and when fleeing fails, keep degrading instead of reporting.
   *
   * The pathfinder loses races in a real fight — `flee timeout` in water, `The
   * goal was changed before it could be completed!` when the next reflex or a
   * journey step grabs the legs. Both used to surface as one `[dying] failed:`
   * line while the body stood still and died. Now every rung of
   * `escapeLadder()` gets a turn: a nearer/cheaper path, then a pathfinder-free
   * sprint (the case where PATHING is what's broken), then — only if fighting
   * is allowed and something is still in melee range — swinging back.
   * Returns the narration of whichever rung worked.
   */
  const escape = async (
    from: { x: number; y: number; z: number },
    distance: number,
    opts: { allowFight?: boolean; owner?: string } = {},
  ): Promise<string> => {
    const threat = hostiles(6)[0];
    const ladder = escapeLadder({
      distance,
      threatDist: threat?.dist ?? Infinity,
      allowFight: opts.allowFight ?? false,
    });
    const tried: string[] = [];
    // A cancelled path is not proof that pathing is broken — see escapeRetry.
    // The rung gets one more turn before the ladder degrades.
    let retries = 0;
    // 🦵 THE CLAIM MUST OUTLIVE THE LADDER (soak41, issue #34). The tick takes
    // one claim before the ladder starts, and legsTtlOf('dying') is 15s while
    // escapeBudgetMs() prices this ladder at up to 24s — so the rungs that
    // matter most used to run with the legs formally FREE, and any rail could
    // legally setGoal under a dying body. Every rung now RENEWS the claim
    // (same owner is re-entrant) for what is still left to spend, and a live
    // claim owned by somebody else ends the ladder honestly instead of pathing
    // beneath them.
    const owner = opts.owner ?? 'dying';
    const priority = owner === 'dying' ? LEGS_PRIORITY.dying : LEGS_PRIORITY.safety;
    let renewal: { release: () => void } | null = null;
    const spentAt = Date.now();
    const budgetMs = escapeBudgetMs(ladder, { retries: 1 });
    const holdLegs = (): { ok: true } | { ok: false; heldBy: string } => {
      const left = Math.max(1_000, budgetMs - (Date.now() - spentAt));
      const held = lock.take({ owner, priority, ttlMs: left + 2_000, what: `an escape (${owner})` });
      if (held) { renewal = held; return { ok: true }; }
      const who = lock.held();
      return { ok: false, heldBy: who ? `${who.what ?? who.owner} (${who.owner})` : 'something' };
    };
    try {
    for (let i = 0; i < ladder.length; i += 1) {
      const rung = ladder[i]!;
      if (rung.kind === 'path' || rung.kind === 'blind') {
        const hold = holdLegs();
        if (!hold.ok) {
          tried.push(`${rung.kind} (the legs now belong to ${hold.heldBy})`);
          return `escape ABANDONED at the ${rung.kind} rung — ${hold.heldBy} outranks this escape and owns the legs (${tried.join(', ')}); still at ${fmt(bot.entity.position)}`;
        }
      }
      try {
        if (rung.kind === 'path') {
          const to = await flee(from, rung.distance, { tolerance: rung.tolerance, timeoutMs: rung.timeoutMs });
          return tried.length ? `escaped to ${fmt(to)} after ${tried.join(', ')} failed` : `fled to ${fmt(to)}`;
        }
        if (rung.kind === 'blind') {
          // No pathfinder: face away and run. Jump clears the fence/ledge that
          // pathing was refusing to solve, and swimming up is the same input.
          const me = bot.entity.position;
          const away = awayFrom(me, from, 8);
          bot.pathfinder.setGoal(null);
          bot.clearControlStates();
          await bot.lookAt(new Vec3(away.x, me.y + 1, away.z), true);
          bot.setControlState('forward', true);
          bot.setControlState('sprint', true);
          bot.setControlState('jump', true);
          await new Promise((r) => setTimeout(r, rung.ms));
          bot.clearControlStates();
          const moved = bot.entity.position.distanceTo(new Vec3(me.x, me.y, me.z));
          if (moved < 1) { tried.push('blind sprint (went nowhere)'); continue; }
          return `${tried.join(', ')} failed — blind-sprinted ${moved.toFixed(0)}m to ${fmt(bot.entity.position)}`;
        }
        if (rung.kind === 'fight') {
          const target = hostiles(4.5)[0];
          if (!target) { tried.push('fight (threat gone)'); continue; }
          const weapon = bestMeleeWeapon(bot.inventory?.items().map((i) => i.name) ?? []);
          const item = weapon ? bot.inventory.items().find((i) => i.name === weapon) : undefined;
          if (item) await bot.equip(item, 'hand').catch(() => {});
          const deadline = Date.now() + cfg.reflex.fightBackMs;
          let swings = 0;
          while (Date.now() < deadline && target.e.isValid) {
            await bot.lookAt(target.e.position.offset(0, 1.4, 0), true);
            bot.attack(target.e);
            swings += 1;
            await new Promise((r) => setTimeout(r, 600));
          }
          return `could not escape (${tried.join(', ')}) — turned and fought the ${target.e.name ?? 'threat'} with ${weapon ?? 'fists'}, ${swings} swing(s), it is ${target.e.isValid ? 'still up' : 'down'}`;
        }
        return `NO escape worked (${tried.join(', ')}) — still at ${fmt(bot.entity.position)}, hostiles: ${hostiles(8).map((h) => h.e.name).join(', ') || 'none visible'}`;
      } catch (err) {
        const failure = classifyEscapeFailure(err);
        // A cancellation gets a NAME, not a shrug: the lock knows who took the
        // legs (or that nobody did, which is a bug worth reporting).
        const because = failure === 'cancelled' ? ` — ${lock.explainCancellation(owner)}` : '';
        tried.push(`${rung.kind}${rung.kind === 'path' ? ` ${rung.distance}m` : ''} (${err instanceof Error ? err.message : String(err)}${because})`);
        const holdsLegs = lock.held()?.owner === owner;
        if (rung.kind === 'path' && escapeRetry({ failure, retriesUsed: retries, holdsLegs })) {
          retries += 1;
          tried.push('retrying the same path — cancellation is not a terrain problem');
          i -= 1; // same rung again, and the renewal above re-arms the claim
        }
      }
    }
    return `NO escape worked (${tried.join(', ')})`;
    } finally {
      (renewal as { release: () => void } | null)?.release();
    }
  };

  /**
   * Issue #38 — THE swing. A hostile inside reach hits for 1-3 hp roughly every
   * second; the soak that motivated this took StrandsBot 20→1 hp with ZERO
   * swings while `briefing[2] ... its first swing lands within seconds` queued
   * behind a turn in flight. So the arms answer on the reflex tick, exactly like
   * the creeper dodge: equip the best melee weapon, face the mob, swing on the
   * weapon's cadence, and STOP the moment it dies or leaves reach.
   *
   * Mechanism only — no tactics. It does not choose to fight; the caller does,
   * and it never touches the pathfinder, so a walk it interrupts is not
   * interrupted at all (the 2116db1 self-resume needs nothing here).
   */
  const fightBurst = async (
    target: Entity,
    opts: { budgetMs?: number } = {},
  ): Promise<{ swings: number; narration: string; still: boolean }> => {
    const name = target.name ?? 'hostile';
    const weapon = bestMeleeWeapon(
      bot.inventory?.items().map((i) => i.name) ?? [],
      cfg.combat.swingIntervalMs,
    );
    // #50: the draw is a LOOP, not an opening move. Before this, one
    // `bot.equip` fired here and was never looked at again — so a refused click
    // (mineflayer paints it locally, the server's "no" lands a round trip later)
    // meant the WHOLE burst swung whatever the last dig had left in the hand:
    // 7 of 65 soak swings landed with a stick, dirt, planks or a membrane while
    // a wooden_sword sat in the bag, each line dutifully saying so. `drawPlan`
    // picks the mechanism (a hotbar switch cannot be refused; a window click
    // can) and this retries it on the next swing slot, bounded, until the hand
    // and the intent agree.
    let drawFailed: string | undefined;
    let draws = 0;        // attempts made
    let refusedDraws = 0; // …of which the world did not accept — the only ones the budget counts
    const drawSteps: string[] = [];
    const draw = async (): Promise<void> => {
      if (refusedDraws >= cfg.combat.drawAttempts) return;
      const step = drawPlan(
        {
          held: bot.heldItem?.name ?? undefined,
          want: weapon,
          items: bot.inventory?.items().map((i) => ({ name: i.name, slot: i.slot })) ?? [],
        },
        cfg.combat.swingIntervalMs,
      );
      if (step.kind === 'none') { drawFailed = undefined; return; }
      draws += 1;
      // #50: the BUDGET is for refusals, not for work. A hotbar switch that
      // lands and is then stolen back by another rail costs one packet, so
      // re-taking the hand every swing must stay free — otherwise a scaffolding
      // walk exhausts the budget in three passes and the rest of the burst goes
      // out with cobblestone. `refusedDraws` is what cfg.combat.drawAttempts
      // actually bounds; see the landed check below.

      const why = (e: unknown) => String((e as { message?: string })?.message ?? e) || 'the server refused it';
      if (step.kind === 'quickbar') {
        try {
          bot.setQuickBarSlot?.(step.slot);
          // No await, no settle: mineflayer's `heldItem` is a GETTER over
          // inventory.slots[36 + quickBarSlot], so the hand has already changed
          // if the switch was real. Reading it here — rather than at the end of
          // the burst — is what tells a refused draw apart from a hand another
          // rail steals back two swings later (#50).
          const now = bot.heldItem?.name;
          const landed = step.item ? now === step.item : !now;
          drawSteps.push(`${landed ? 'held slot' : 'held slot (NO effect)'} ${step.slot} selected${
            step.item ? ` for the ${step.item}` : ' — empty, so a fist instead of a block'}`);
          if (landed) drawFailed = undefined;
          else {
            refusedDraws += 1;
            drawFailed = `the hotbar switch to slot ${step.slot} left ${now ?? 'nothing'} in the hand`;
          }
        } catch (e) {
          drawFailed = `the hotbar switch to slot ${step.slot} failed: ${why(e)}`;
        }
        return;
      }
      if (step.kind === 'window') {
        const item = bot.inventory?.items().find((i) => i.name === step.item);
        if (!item) { drawFailed = `the ${step.item} left the bag before it could be drawn`; return; }
        drawSteps.push(`window click for the ${step.item} (it is not on the hotbar)`);
        drawFailed = await bot.equip(item, 'hand').then(() => undefined, (e: unknown) => why(e));
        if (drawFailed || bot.heldItem?.name !== step.item) refusedDraws += 1;
        return;
      }
      drawSteps.push('unequip (every hotbar slot is full)');
      drawFailed = await bot.unequip('hand').then(
        () => undefined,
        (e: unknown) => `could not drop the ${step.item} from the hand: ${why(e)}`,
      );
      if (drawFailed || bot.heldItem) refusedDraws += 1;
    };
    await draw();
    const deadline = Date.now() + (opts.budgetMs ?? cfg.combat.burstMs);
    const distTo = () => {
      const me = bot.entity?.position;
      return me && target.position ? me.distanceTo(target.position) : Infinity;
    };
    const startDist = distTo();
    let swings = 0;
    const swingDists: number[] = [];
    const swingHands: (string | undefined)[] = []; // #50: the hand at each swing, not at the end
    let waited = 0; // passes spent inside the trigger radius but outside striking distance
    let ended: string | undefined;
    while (Date.now() < deadline) {
      if (target.isValid === false) { ended = 'it is DOWN'; break; }
      if (distTo() > cfg.combat.answerReach) { ended = `it broke off to ${distTo().toFixed(1)}m`; break; }
      // #50: the RETRY. A refused draw gets another slot here — and because
      // `drawPlan` returns `none` the moment the hand agrees with the intent,
      // the happy path costs one comparison and never re-clicks a weapon that
      // is already drawn. The bound lives in cfg.combat.drawAttempts so a
      // server that refuses everything cannot spend a whole burst on clicks.
      await draw();
      // Facing matters: the server rejects a swing at a mob behind your head.
      if (target.position) {
        await bot.lookAt?.(target.position.offset(0, (target.height ?? 1.8) * 0.5, 0), true).catch(() => {});
      }
      // #45's remaining leak: the gate used to test the distance read BEFORE the
      // await above. `lookAt(..., true)` waits for the rotation to be sent, and a
      // diving phantom crosses the 3-4m band inside that window — so the swing
      // was decided on a reading that was already history and the server dropped
      // the packet while our log counted it. Re-measure HERE, one statement
      // before the attack, and let nothing await in between.
      const dist = distTo();
      const verdict = swingVerdict(dist, cfg.combat);
      if (verdict === 'break') { ended = `it broke off to ${dist.toFixed(1)}m`; break; }
      if (verdict === 'hold') {
        waited += 1;
        // Poll fast while waiting: the sword cooldown only applies to a swing we
        // actually threw, so sleeping a full interval here would miss the pass
        // where the flyer is briefly inside reach.
        await new Promise((r) => setTimeout(r, Math.min(150, cfg.combat.swingIntervalMs)));
        continue;
      }
      try {
        bot.attack(target);
        swings += 1;
        swingDists.push(dist); // the range the swing was REALLY thrown from
        // #50: and what it went out WITH, read at the moment it went out. The
        // end-of-burst read blamed the server for a hand the mining rail took
        // back after the swings had already landed with the sword.
        swingHands.push(bot.heldItem?.name);
      } catch { /* entity vanished between look and swing */ }
      await new Promise((r) => setTimeout(r, cfg.combat.swingIntervalMs));
    }
    const dead = target.isValid === false;
    const endDist = distTo();
    const still = !dead && endDist <= cfg.combat.answerReach;
    // The outcome is READ at the end, never inferred from which line broke the
    // loop: a mob that died on the last swing of the budget used to be reported
    // as "it is out of reach" (true only in the sense that corpses are far from
    // everything). The mind decides whether to disengage from this sentence, so
    // it has to say what actually happened.
    const outcome = dead
      ? 'it is DOWN'
      : ended ?? (still
        // "It broke off" was the old sentence for a mob that had never been
        // inside striking distance at all (issue #45) — a false cause the mind
        // acted on. Say which of the two situations this actually is.
        ? (swings === 0 ? `it hovered at ${endDist.toFixed(1)}m, never inside striking distance` : 'it is still in reach')
        : `it is ${endDist.toFixed(1)}m away, out of reach`);
    const held = waited && swings ? ` (${waited} pass(es) held while it hung beyond striking distance)` : '';
    // #49: the draw that RESOLVED and still did not happen. `drawFailed` only
    // exists when the equip promise REJECTED; a server refusal lands one round
    // trip after the promise, so four bursts once swung dirt with a stone_sword
    // in the bag and not one line said the draw had failed. Compare intent
    // against the hand at the END of the burst — by then the refusal has had
    // the whole burst to arrive — and let the verdict speak for itself.
    const refused = drawVerdict(bot, weapon, cfg.combat.swingIntervalMs);
    // #50: a draw that worked and was then undone by another rail is NOT a
    // refusal, and saying so was making the mind distrust the server for its own
    // process's doing. When the swings did go out with the weapon, that is the
    // sentence — the refusal line is for when they never did.
    const stolen = handTheft(swingHands, weapon, bot.heldItem?.name ?? undefined);
    return {
      swings,
      still,
      // What the hand ACTUALLY held, read back — not the weapon we meant to draw.
      // What the hand ACTUALLY held, read back — and whether that thing is a
      // weapon at all. `with dirt` used to read like a choice; it was a leftover.
      narration: `swung ${swings}x at the ${name} ${
        // #45: the distance the swings LANDED at, not the one measured once when
        // the burst opened — that stale number is what made a gated fight read
        // as `swung 2x at the phantom 4.0m away`, beyond the server's 3.0m.
        swings ? `${swingRange(swingDists)} away` : `${startDist.toFixed(1)}m away at first sight`} with ${
        // #50: what the SWINGS held, sampled as each one left. `handNow` is only
        // right when nothing was thrown at all.
        swings ? handsSummary(swingHands, cfg.combat.swingIntervalMs) : handNow(bot, cfg.combat.swingIntervalMs)}${
        drawFailed ? ` (${weapon ? `could NOT draw the ${weapon}: ${drawFailed}` : drawFailed})` : ''}${
        stolen ? ` (${stolen})` : ''}${
        !drawFailed && !stolen && refused ? ` (${refused})` : ''}${
        // #50: how hard the body tried to get the right thing into the hand.
        // Silent when the first attempt worked — a retry is only news when it
        // happened, and the steps name the MECHANISM each attempt used.
        draws > 1 ? ` (draw attempted ${draws}x: ${drawSteps.join('; ') || 'no mechanism available'})` : ''}${held} — ${outcome}`,
    };
  };

  /**
   * What the mind is told after the body swings: FACTS, no orders (HARDCODING.md
   * rule 2). Rate-limited by cfg.combat.noteIntervalMs so a two-minute fight
   * cannot flood the note rail the way issue #32's radar lines did.
   */
  let lastFightNoteAt = 0;
  /**
   * Issue #46 — the armed state as the body sees it RIGHT NOW. Reads the hand
   * and the bag off the live body, so it cannot disagree with what fightBurst
   * just swung with.
   */
  const armedNow = () => readArmed(bot);
  /**
   * Issue #46 — the bot threw 120/120 swings bare-fisted across a whole night
   * and nothing ever said so: the fight note carries the fact, but it is
   * rate-limited and lands mid-fight. So the FIRST bare-fisted swing of an
   * unarmed episode escalates once, past that rate limit, and the episode only
   * re-arms when the body is holding a weapon again. Facts, not orders — the
   * mind picks the remedy (craft, retreat, shelter, flee).
   */
  let unarmedEscalated = false;
  /**
   * Re-arm the once-per-disarmament alarm. Hoisted (a `function`, not a const)
   * because the death handler above is wired before this point in the file.
   */
  function rearmUnarmedAlarm() { unarmedEscalated = false; }
  const noteUnarmedOnce = (fact: ReturnType<typeof armedNow>) => {
    if (fact.armed) { unarmedEscalated = false; return; } // re-arm the alarm for the next disarmament
    if (unarmedEscalated) return;
    unarmedEscalated = true;
    const line = `The body just fought BARE-HANDED. ${fact.line} It will keep answering anything inside ${cfg.combat.answerReach} blocks with whatever is in its hand — that is a fist until you change it.`;
    deps.note(`(reflex) ${line}`);
    // A note travels to the MIND and nowhere else, so this rail was unprovable
    // from outside: soak24 shows four bare-fisted bursts after a death that
    // dropped the trident, and zero evidence the escalation ever fired. An
    // alarm nobody can audit is an alarm nobody can trust.
    remember(`🥊 ${line}`);
  };
  const noteFightFacts = (headline: string, target: Entity) => {
    if (Date.now() - lastFightNoteAt < cfg.combat.noteIntervalMs) return;
    lastFightNoteAt = Date.now();
    const hp = typeof bot.health === 'number' ? bot.health.toFixed(1) : '?';
    const around = hostiles(8);
    const roster = around.length
      ? around.slice(0, 4).map((h) => `${h.e.name} ${h.dist.toFixed(1)}m`).join(', ')
      : 'none';
    const flies = isFlyingHostile(target.name)
      ? ` The ${target.name} FLIES: a ground path does not outrun it (that is why the body did not run).`
      : '';
    deps.note(`(reflex) ${headline} Facts: hp ${hp}/20, food ${bot.food ?? '?'}/20, at ${fmt(bot.entity?.position ?? new Vec3(0, 0, 0))}; hostiles within 8 blocks: ${roster}. ${armedNow().line}${flies} The body will keep answering anything inside ${cfg.combat.answerReach} blocks by itself. What to DO about it is yours: keep fighting, disengage, wall up, shelter until day, or eat.`);
  };

  // ---- unstuck bookkeeping -------------------------------------------------
  // Progress signals: a dig completing or an item landing in the bag proves
  // the stillness is WORK (staircase shaft, furnace run), not wedgedness —
  // issue #8: the old position-only heuristic jogged the bot off its own
  // mineshaft every 20s and the journal blamed the journey loop.
  let anchor: Vec3 | undefined;
  let anchorAt = Date.now();
  let lastProgressAt = Date.now();
  let lastNoPathAt = 0;
  // One stuck EPISODE = one freeze. One WEDGE = one PLACE that keeps freezing
  // the body: the warning count lives on the wedge (wedgeSee), because soak36
  // proved a count scoped to the freeze can never reach 2 — a twitch out of the
  // 2-block anchor circle zeroed it eleven times in one session.
  let wedge: WedgeMemory | undefined;
  let wedgeNewEpisode = false;
  let stuckNotedAt = 0;
  /** how long the body had been frozen when the last note went out */
  let stuckNotedFrozenMs = 0;
  /** the goal object the last note was about — a NEW goal is a new attempt */
  let stuckNotedGoal: unknown;
  const UNSTUCK_AFTER_MS = cfg.reflex.unstuckAfterMs;
  /**
   * Taking the legs from a busy mind is allowed — doing it QUIETLY is not.
   * A walk whose goal was cancelled under it looks, from inside the mind, like
   * a walk still in flight, so the note states what was done, why asking was
   * abandoned, and reads the goal BACK rather than claiming a cancellation it
   * did not verify (the false-green class, #48).
   */
  const announceTakeover = (
    narration: string,
    here: Vec3,
    takeover: boolean,
    w: WedgeMemory | undefined,
  ): string => {
    if (!w) return narration;
    w.acts += 1;
    w.lastActAt = Date.now();
    if (!takeover) return narration;
    const goalGone = !bot.pathfinder?.goal;
    const standing = bot.entity?.position;
    deps.note(`(reflex) ESCALATED — ${w.warnings} warning(s) about the wedge at ${fmt(here)} changed nothing (${wedgeAge(w, Date.now())} inside one 6-block cell, ${w.episodes} attempt(s) to leave), so the unstuck reflex took the legs itself while you were mid-turn: ${narration}. ${goalGone ? 'Your pathfinder goal is CANCELLED — read back as empty, nothing will resume it.' : 'Your pathfinder goal SURVIVED the stop — that walk is still live.'}${standing ? ` The body now stands at ${fmt(standing)}.` : ''} Re-issuing the same route is the one thing already proven not to work here: dig through, path a different way, or drop this target.`);
    return `${narration} — ESCALATED after ${w.warnings} unheeded warning(s), legs TAKEN from a busy mind (act ${w.acts} at this site)`;
  };
  body.onEachBot((b) => {
    b.on('diggingCompleted', () => { lastProgressAt = Date.now(); });
    // Building is work too, and it leaves no dig behind: 22 of the 27 note-storm
    // warnings in the live soak went to workers PLACING a staircase, one of which
    // finished its task while being told it was possibly wedged (issue #19).
    // ('blockPlaced' is emitted by mineflayer/lib/plugins/place_block.js:28 but
    // missing from its BotEvents typings, hence the cast.)
    (b as unknown as { on: (e: string, fn: () => void) => void })
      .on('blockPlaced', () => { lastProgressAt = Date.now(); });
    b.on('playerCollect', (collector) => {
      if (b.entity && collector?.id === b.entity.id) lastProgressAt = Date.now();
    });
    // Any inventory slot change is deliberate activity too: placing torches,
    // crafting, eating — all consume/produce items while the body stands
    // still. Without this the torch-patrol read as 'possibly wedged' every
    // ~30s (live soak: 6 false notes in one thinker patrol).
    (b.inventory as unknown as { on?: (ev: string, cb: () => void) => void })
      ?.on?.('updateSlot', () => { lastProgressAt = Date.now(); });
    // The pathfinder's own truth — 'this goal cannot be reached' is the case
    // the unstuck reflex was actually written for.
    (b as Bot & { on(e: 'path_update', cb: (r: { status: string }) => void): void })
      .on('path_update', (r) => {
        if (r.status === 'noPath' || r.status === 'timeout') lastNoPathAt = Date.now();
      });
  });

  // ---- item magnet / staring bookkeeping -----------------------------------
  const itemFirstSeen = new Map<number, number>();
  const itemAttempted = new Set<number>();
  let nextGazeAt = 0;
  // ---- creeper standoff bookkeeping -----------------------------------------
  // One episode per creeper: how many flees it has cost, and whether the mind
  // has already been told fleeing stopped working. An episode expires when the
  // creeper has left everyone alone for a while (or died — ids never recur).
  const creeperEpisodes = new Map<number, { flees: number; lastAt: number; escalated: boolean }>();
  const CREEPER_EPISODE_MS = cfg.reflex.creeperEpisodeMs;
  const creeperEpisode = (id: number) => {
    const now = Date.now();
    for (const [k, v] of creeperEpisodes) { if (now - v.lastAt > CREEPER_EPISODE_MS) creeperEpisodes.delete(k); }
    const ep = creeperEpisodes.get(id) ?? { flees: 0, lastAt: now, escalated: false };
    ep.lastAt = now;
    creeperEpisodes.set(id, ep);
    return ep;
  };
  /**
   * Eye-to-eye raycast — can this entity actually see the bot? Vanilla mobs
   * target through canSee(), so an opaque wall between eyes means no swell.
   * Any failure (mid-reconnect body, missing world) reports TRUE: fleeing
   * needlessly costs 2 seconds, trusting a broken raycast costs a life.
   */
  const canSeeEntity = (e: Entity): boolean => {
    try {
      const eye = bot.entity.position.offset(0, 1.62, 0);
      const theirEye = e.position.offset(0, (e as { height?: number }).height ?? 1.2, 0);
      const dir = theirEye.minus(eye);
      const dist = dir.norm();
      if (dist < 0.5) return true;
      const world = (bot as unknown as { world?: { raycast?: (from: Vec3, dir: Vec3, range: number) => unknown } }).world;
      if (typeof world?.raycast !== 'function') return true;
      return !world.raycast(eye, dir.scaled(1 / dist), dist);
    } catch { return true; }
  };
  // ---- auto-armor bookkeeping: only rescan when the bag actually changed ---
  let invSignature = '';

  const modes: Mode[] = [
    {
      // 1. Standing in something lethal beats every other consideration.
      name: 'self_preservation',
      safety: true,
      cooldownMs: cfg.reflex.hazardCooldownMs,
      check: () => {
        const me = bot.entity?.position;
        if (!me) return null;
        const hazards = standingHazards(me, blockNameAt, (x, y, z) => {
          // Solidity from the game, not from a name list (1a99f01): tall grass
          // at head height is not a wall, and sandstone is.
          const b = bot.blockAt?.(new Vec3(x, y, z)) as { boundingBox?: string; name?: string } | undefined;
          return b?.boundingBox === 'block' && b.name !== 'water';
        });
        const burning = hazards.find((h) => h.kind === 'burning');
        if (burning) {
          return async () => {
            const here = me.clone();
            // Water bucket first: it kills fire AND turns lava walkable.
            const bucket = bot.inventory?.items().find((i) => i.name === 'water_bucket');
            if (bucket && burning.detail !== 'lava one step away') {
              await bot.equip(bucket, 'hand');
              await bot.lookAt(here.offset(0, -0.5, 0), true);
              bot.activateItem();
              return `${burning.detail} — dumped a water bucket at my feet ${fmt(here)}`;
            }
            // Ladder, not one shot: standing in lava is the worst possible
            // place to accept 'flee timeout' as an answer.
            const how = await escape(here, cfg.reflex.burnEscapeDistance, { owner: 'self_preservation' });
            return `${burning.detail} at ${fmt(here)} — ${how}`;
          };
        }
        // A HEAD INSIDE A WALL IS A HAZARD WITH A REMEDY (soak43 died of this
        // one): `StrandsBot suffocated in a wall` with the dying reflex saying
        // 'no direction is safer than another'. Out of the water the same dig is
        // ~25x cheaper than the drowning one (no water, no off-ground penalty),
        // so it is nearly always payable — and now it is priced out loud either way.
        const sealed = hazards.find((h) => h.kind === 'head_in_block');
        if (sealed) {
          return async () => {
            const here = me.clone();
            const fx = Math.floor(here.x), fy = Math.floor(here.y), fz = Math.floor(here.z);
            const headBlk = bot.blockAt?.(new Vec3(fx, fy + 1, fz));
            if (!headBlk) return `${sealed.detail} at ${fmt(here)} and I cannot even read the block my head is in`;
            const counts: Record<string, number> = {};
            for (const i of bot.inventory?.items() ?? []) counts[i.name] = (counts[i.name] ?? 0) + i.count;
            const out = await payDig(headBlk as never, { canPillar: !!pillarBlock(counts), where: 'at head height' });
            if (!out.plan.payable) {
              deps.note(`(reflex) I am SUFFOCATING: ${sealed.detail} at ${fmt(here)} and the block cannot be dug in time — ${out.plan.line}. Anything that moves this body out of this block, now.`);
            }
            return `SUFFOCATING — ${sealed.detail} at ${fmt(here)}, ${Math.round(bot.health ?? 0)} hp: ${out.line}`;
          };
        }
        const drowning = hazards.find((h) => h.kind === 'water_over_head');
        const airNow = oxygenReading(bot.oxygenLevel)?.units;
        if (typeof airNow === 'number') {
          if (prevOxygen !== undefined && airNow < prevOxygen) oxygenFallingAt = Date.now();
          prevOxygen = airNow;
        }
        // Falling counts for 2s after the last drop: the bar ticks about once a
        // second, so sampling a single tick would read 'not falling' half the time.
        const airFalling = Date.now() - oxygenFallingAt < 2_000;
        const urgency = drowning
          ? drowningUrgency({ oxygenUnits: airNow, health: bot.health, airFalling })
          : 'none';
        if (urgency === 'evacuate') {
          // Air or health is nearly gone: the surface is not far enough. Get the
          // whole body out of the water — this is the case that killed the bot.
          return async () => {
            const here = me.clone();
            const air = airNow ?? 0;
            const shore = shoreDirection(here, blockNameAt, 16);
            // A NEW episode only if we have been out of the water for a while:
            // otherwise this is attempt N of the same failing evacuation, and
            // the count is what makes escalation possible (soak41 escalated
            // nothing across sixteen identical 'head is OUT' successes).
            if (Date.now() - lastEvacAt > 15_000) evacAttempts = 0;
            lastEvacAt = Date.now();
            evacAttempts += 1;
            bot.pathfinder?.setGoal(null);
            // BEFORE spending the legs: is UP even a direction here? soak42 swam
            // 10m into a roof and the remedy was to swim again.
            const col = waterColumn(here, blockNameAt);
            const exit = !shore && col.kind === 'blocked'
              ? lateralAirColumn(here, blockNameAt, cfg.reflex.evacLateralRadius)
              : undefined;
            const aim = shore ?? exit;
            if (aim) await bot.lookAt(new Vec3(aim.x + 0.5, aim.y + 0.5, aim.z + 0.5), true);
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            await new Promise((r) => setTimeout(r, cfg.reflex.evacSwimMs));
            bot.clearControlStates();
            // GROUND TRUTH, after a grace window: swimming stops, the body
            // settles, THEN we look. One frame of air proved nothing.
            await new Promise((r) => setTimeout(r, cfg.reflex.evacGraceMs));
            // READ-BACK at the body's CURRENT column, not at the one it left:
            // the verdict's next step is only as good as where the head is now.
            const nowAt = bot.entity?.position ?? here;
            const colAfter = waterColumn(nowAt, blockNameAt);
            const exitAfter = colAfter.kind === 'blocked'
              ? lateralAirColumn(nowAt, blockNameAt, cfg.reflex.evacLateralRadius)
              : undefined;
            const verdict = gradeEvacuation({
              ...groundTruth(here),
              movedBlocks: here.distanceTo(nowAt),
              attempt: evacAttempts,
              column: colAfter,
              lateralExit: !!exitAfter,
            });
            const heading = shore
              ? `toward shore ${fmt(new Vec3(shore.x, shore.y, shore.z))}`
              : exit
                ? `sideways toward the open column ${fmt(new Vec3(exit.x, exit.y, exit.z))} ${exit.dist.toFixed(0)} blocks away (${col.kind === 'blocked' ? `${col.block} seals the way up at y=${col.y}` : 'no shore within 16'})`
                : col.kind === 'blocked'
                  ? `upward against ${col.block} at y=${col.y} — no shore within 16 and no open column within ${cfg.reflex.evacLateralRadius}`
                  : 'upward (no shore within 16)';
            const swam = `EVACUATING water at ${air}/20 air, ${Math.round(bot.health ?? 0)} hp — swam ${here.distanceTo(nowAt).toFixed(1)}m ${heading}`;
            if (verdict.escaped) { evacAttempts = 0; return `${swam}: ${verdict.grade}`; }
            const escalation = await escalateEvacuation(verdict.next, exitAfter);
            return `${swam}: ${verdict.grade} → ${escalation}`;
          };
        }
        if (urgency === 'surface') {
          return async () => {
            const before = oxygenReading(bot.oxygenLevel);
            const plan = drowningEscape(me, blockNameAt);
            if (plan.how === 'dig') {
              // Under a ceiling, jump is a no-op — the only way to air is through
              // the block above. Break it, THEN swim.
              const target = bot.blockAt(new Vec3(plan.at.x, plan.at.y, plan.at.z));
              if (target) {
                try {
                  await Promise.race([
                    bot.dig(target),
                    new Promise((_r, rej) => setTimeout(() => rej(new Error('dig timeout')), 4_000)),
                  ]);
                } catch { /* fall through to the swim: even a partial gap helps */ }
              }
            } else if (plan.how === 'trapped') {
              // Truth beats a comforting log line: this needs the model (or a
              // human) to do something clever, and it needs it this second.
              bot.setControlState('jump', true);
              await new Promise((r) => setTimeout(r, 1_500));
              bot.setControlState('jump', false);
              return `DROWNING at oxygen ${before?.units ?? '?'}/20 and the body cannot escape upward: ${plan.why} — the body is out of moves; anything that reaches air or removes the water, NOW`;
            }
            bot.setControlState('jump', true);
            await new Promise((r) => setTimeout(r, 3_000));
            bot.setControlState('jump', false);
            const after = oxygenReading(bot.oxygenLevel);
            const verb = plan.how === 'dig' ? `dug through ${plan.block} overhead and swam up` : 'swam up for 3s';
            // Reporting "swam up" while the air keeps falling is how a bot bleeds
            // 17 HP to 3 without anyone noticing. Say which way the gauge moved —
            // on the bubble bar's scale, whichever scale the field arrived on.
            const gauge = `oxygen ${before?.units ?? '?'}→${after?.units ?? '?'}/20`;
            return after && before && after.units <= before.units
              ? `${gauge} — ${verb}, STILL not breathing`
              : `${gauge} — ${verb}`;
          };
        }
        const falling = hazards.find((h) => h.kind === 'falling_above');
        if (falling) {
          return async () => {
            const here = me.clone();
            const to = await flee(here, cfg.reflex.sidestepDistance);
            return `${falling.detail} — stepped aside to ${fmt(to)}`;
          };
        }
        return null;
      },
    },
    {
      // 2. About to die: one more hit ends it — disengage NOW.
      name: 'dying',
      safety: true,
      cooldownMs: 10_000,
      check: () => {
        const h = bot.health;
        if (typeof h !== 'number' || Date.now() - lastDamageAt > 3_000) return null;
        if (!(h < 5 || lastDamageAmount >= h)) return null;
        return async () => {
          const near = hostiles(16)[0];
          const me = bot.entity.position.clone();
          // Run, fight, climb out, or stand still? The verb follows the KILLER
          // (soak41: four rungs of escape from a threat that did not exist).
          const plan = dyingPlan({
            threat: near ? { name: near.e.name, dist: near.dist } : undefined,
            hazards: standingHazards(me, blockNameAt),
          });
          if (plan.act === 'evacuate') {
            // Not our ladder: self_preservation owns getting a body out of a
            // block, and it fires on the very next tick with the same rank.
            // Saying so beats spending a dying body's legs on 20m of −x.
            deps.note(`(reflex) At ${h.toFixed(0)}/20 hp the damage is the TERRAIN, not a mob: ${plan.hazard.detail} at ${fmt(me)}. Nothing is chasing me. Getting out of this block (dig, place a block to stand on, pillar up) is the only thing that stops the bleeding — a walk somewhere else does not.`);
            return `health ${h.toFixed(0)}/20 — NOT fleeing: ${plan.why}. Handing this to the hazard rail (${plan.hazard.kind}).`;
          }
          if (plan.act === 'stand_down') {
            deps.note(`(reflex) At ${h.toFixed(0)}/20 hp I took a ${lastDamageAmount.toFixed(0)}-damage hit with NO hostile within 16 blocks and no hazard underfoot. ${starvationFact() ?? 'Check hunger, suffocation and fall damage — running is not the answer to any of them.'}`);
            return `health ${h.toFixed(0)}/20 after a ${lastDamageAmount.toFixed(0)}-damage hit — standing down instead of escaping: ${plan.why}`;
          }
          const from = near?.e.position ?? me.offset(1, 0, 0);
          if (plan.act === 'fight' && near) {
            const burst = await fightBurst(near.e, { budgetMs: cfg.reflex.fightBackMs });
            noteUnarmedOnce(armedNow());
            noteFightFacts(`At ${h.toFixed(0)}/20 hp the body stood and fought instead of running: ${burst.narration}.`, near.e);
            return `health ${h.toFixed(0)}/20 after a ${lastDamageAmount.toFixed(0)}-damage hit — the ${near.e.name} flies, so running is not an escape: ${burst.narration}`;
          }
          // Fighting is on the ladder here: at <5 hp with a mob in melee,
          // walking away while it hits you is how the soak's deaths happened.
          const how = await escape(from, cfg.reflex.dyingEscapeDistance, { allowFight: true, owner: 'dying' });
          return `health ${h.toFixed(0)}/20 after a ${lastDamageAmount.toFixed(0)}-damage hit — disengaging ${near ? `the ${near.e.name}` : 'the area'}: ${how}`;
        };
      },
    },
    {
      // 3. Creeper in blast radius. It detonates at ~3 blocks after ~1.5s —
      // no model round-trip survives that arithmetic. But distance alone is
      // not danger (live report: a creeper loitering near the chest room
      // preempted every walk there, forever): a creeper with no line of
      // sight cannot swell, and a creeper two flees have not shaken is the
      // MIND's problem — see creeperVerdict.
      name: 'creeper_flee',
      safety: true,
      cooldownMs: 5_000,
      check: () => {
        const me = bot.entity?.position;
        if (!me) return null;
        const creeper = Object.values(bot.entities ?? {})
          .filter((e): e is Entity => !!e?.position && e.name === 'creeper')
          .map((e) => ({ e, dist: me.distanceTo(e.position) }))
          .filter((c) => c.dist <= 6)
          .sort((a, z) => a.dist - z.dist)[0];
        if (!creeper) return null;
        const ep = creeperEpisode(creeper.e.id);
        const verdict = creeperVerdict({
          dist: creeper.dist,
          lineOfSight: canSeeEntity(creeper.e),
          recentFlees: ep.flees,
        });
        if (verdict.act === 'ignore') return null; // inert behind its wall — not even news
        if (verdict.act === 'escalate') {
          // Once per episode: hand the standoff to the mind instead of
          // burning the legs on a third identical flee.
          if (!ep.escalated) {
            ep.escalated = true;
            deps.note(`(reflex) A creeper at ${creeper.dist.toFixed(1)} blocks keeps triggering flees and is NOT shaken off — I have stopped auto-fleeing it. Deal with it deliberately: attack_entity it, wall it off, lure it away, or route around ${fmt(creeper.e.position)}. Your walks will work again once it is handled or leaves.`);
          }
          return null;
        }
        return async () => {
          ep.flees += 1;
          // allowFight stays FALSE: punching a primed creeper is the death
          // this reflex exists to avoid.
          const how = await escape(creeper.e.position, 12, { owner: 'creeper_flee' });
          return `creeper at ${creeper.dist.toFixed(1)} blocks — ${how}`;
        };
      },
    },
    {
      // 4. Something is INSIDE melee reach and hitting us. Issue #38: the
      // sentinel's `briefing[2] ... its first swing lands within seconds`
      // reached the mind five times while it was mid-turn, so the bot went
      // 20→1 hp without a single swing. A 1.5-block hostile is the creeper-dodge
      // class of problem — the answer must come from the BODY.
      //
      // It runs AFTER creeper_flee on purpose (a creeper is on neverPunch, so
      // this mode ignores it and the dodge stays the answer) and claims NO legs:
      // swinging is arms, so a walk in flight keeps walking and there is nothing
      // to resume. The mind gets facts afterwards and keeps every decision.
      name: 'fight_back',
      safety: true,
      needsLegs: false,
      cooldownMs: cfg.combat.answerCooldownMs,
      check: () => {
        if (!bot.entity?.position) return null;
        const target = meleeAnswerTarget(
          hostiles(cfg.combat.answerReach).map((h) => ({ name: h.e.name, dist: h.dist, e: h.e })),
        );
        if (!target) return null;
        return async () => {
          const burst = await fightBurst(target.e);
          if (!burst.swings) return '';
          noteUnarmedOnce(armedNow()); // #46: a fist is news exactly once per disarmament
          noteFightFacts(`Something reached melee range and the body answered it on the reflex tick: ${burst.narration}.`, target.e);
          return burst.narration;
        };
      },
    },
    {
      // 5. Genuinely wedged — the pathfinder said noPath/timeout, or the body
      // froze a full window with ZERO progress signals. Deliberately
      // stationary work (digging, container windows, eating) is exempt, and
      // when the mind is mid-turn the reflex only NOTES — standing still is
      // not lethal, so nothing is lost by asking first (issue #8: the old
      // version jogged the bot off its own staircase shaft every 20s).
      name: 'unstuck',
      safety: true,
      cooldownMs: 20_000,
      check: () => {
        const me = bot.entity?.position;
        if (!me) return null;
        if (!anchor || me.distanceTo(anchor) > 2) {
          anchor = me.clone();
          anchorAt = Date.now();
          // Moved for real → this FREEZE is over. The WEDGE is not, and zeroing
          // the count here is exactly what hid a 3-minute jam behind eleven
          // "warning 1" lines (soak36). Only leaving the cell — or the rejoin
          // window expiring — forgets a wedge; a twitch just starts attempt N+1.
          stuckNotedFrozenMs = 0;
          stuckNotedGoal = undefined;
          if (wedge && wedge.key === wedgeSiteKey(me)) wedgeNewEpisode = true;
          return null;
        }
        const now = Date.now();
        // The model re-issued movement and the body still has not budged: that is
        // a fresh attempt, so the "has it got meaningfully worse" clock restarts —
        // but the WARNING COUNT does not, because it is the same wedge and the
        // escalation ("stop re-issuing, change approach") is exactly the news.
        if (stuckNotedGoal && bot.pathfinder?.goal !== stuckNotedGoal) {
          stuckNotedFrozenMs = 0;
          stuckNotedGoal = bot.pathfinder?.goal;
        }
        const verdict = stuckVerdict({
          frozenMs: now - anchorAt,
          hasGoal: !!bot.pathfinder?.goal,
          digging: !!(bot as Bot & { targetDigBlock?: unknown }).targetDigBlock,
          windowOpen: !!bot.currentWindow,
          usingItem: !!(bot as Bot & { usingHeldItem?: boolean }).usingHeldItem,
          progressMs: now - lastProgressAt,
          noPathMs: lastNoPathAt ? now - lastNoPathAt : Infinity,
          deliberateBusy: deps.deliberateBusy(),
          drowning: standingHazards(me, blockNameAt).some((h) => h.kind === 'water_over_head'),
        }, UNSTUCK_AFTER_MS);
        if (verdict === 'none') return null;
        const wedgeFrozenMs = now - anchorAt;
        wedge = wedgeSee(
          wedge,
          { now, key: wedgeSiteKey(me), frozenMs: wedgeFrozenMs, newEpisode: wedgeNewEpisode },
          cfg.reflex.wedgeRejoinMs,
        );
        wedgeNewEpisode = false;
        // A wedge that has outlived N warnings (or M seconds at one place) has
        // earned the legs even mid-turn: asking politely was the whole failure.
        const escalated = verdict === 'note' && wedgeEscalation(wedge, { now, frozenMs: wedgeFrozenMs }, {
          actAfterWarnings: cfg.reflex.unstuckActAfterWarnings,
          actAfterMs: cfg.reflex.unstuckActAfterMs,
          actGapMs: cfg.reflex.unstuckActGapMs,
        }) === 'act';
        if (verdict === 'note' && !escalated) {
          // Non-destructive: the mind owns the legs right now. ONE note per
          // stuck episode, then exponential backoff — the old version reset
          // the anchor here, which re-armed the same episode instantly and
          // produced 22 identical notes in one turn (live soak 2026-08-17).
          // Real progress (a dig, an item, a slot change) ends the episode.
          // The counter used to be zeroed here whenever ANY progress had landed
          // since the last note — so slow-but-real work (one dig every 30s) made
          // every warning claim to be the first, the escalation branch was dead
          // code, and the model got the identical paragraph every cooldown while
          // the duration climbed to 286s (issue #19). Progress recent enough to
          // matter already ends this in stuckVerdict ('none'), so the episode now
          // ends where it should: when the body actually MOVES (anchor reset).
          const frozenMs = wedgeFrozenMs;
          const w = wedge;
          if (!stuckNoteDue({
            now, lastNotedAt: stuckNotedAt, notesInEpisode: w.warnings,
            frozenMs, lastNotedFrozenMs: stuckNotedFrozenMs,
          })) return null;
          const frozenS = Math.round(frozenMs / 1000);
          return async () => {
            w.warnings += 1;
            stuckNotedAt = Date.now();
            stuckNotedFrozenMs = frozenMs;
            stuckNotedGoal = bot.pathfinder?.goal;
            const at = fmt(anchor ?? me);
            const site = wedgeSiteFact(w, now, at);
            deps.note(`${stuckAdvice(w.warnings - 1, frozenS)}${site ? ` ${site}` : ''}`);
            return `stationary ${frozenS}s with a live goal while the mind is busy — warning ${w.warnings} of this wedge at ${at} (${wedgeAge(w, now)} here, ${w.episodes} attempt(s)), legs untouched`;
          };
        }
        const inWater = standingHazards(me, blockNameAt).some((h) => h.kind === 'water_over_head');
        const takeover = escalated; // the mind holds the legs and the wedge outlived asking
        const wedgeNow = wedge;
        return async () => {
          const here = me.clone();
          bot.clearControlStates();
          bot.pathfinder.stop();
          bot.pathfinder.setGoal(null);
          if (inWater) {
            // No walk exists out of a lake — the pathfinder answered 'No path to
            // the goal!' to exactly this (live soak 2026-08-17). Swim it by hand.
            const shore = shoreDirection(here, blockNameAt);
            if (shore) await bot.lookAt(new Vec3(shore.x + 0.5, shore.y + 0.5, shore.z + 0.5), true);
            bot.setControlState('jump', true);   // rise / stay at the surface
            // Without a swimmable shore, holding 'forward' only presses the body
            // into whatever wall it is already against (live: 0.5m of progress,
            // twice, inside a flooded shaft). Rise instead, and say so.
            if (shore) bot.setControlState('forward', true);
            await new Promise((r) => setTimeout(r, 3_500));
            bot.clearControlStates();
            anchor = undefined;
            const moved = bot.entity?.position ? here.distanceTo(bot.entity.position) : 0;
            return announceTakeover(shore
              ? `wedged treading water at ${fmt(here)} — swam ${moved.toFixed(1)}m toward shore ${fmt(new Vec3(shore.x, shore.y, shore.z))}`
              : `wedged in water at ${fmt(here)} with NO swimmable shore within 12 blocks (walled in?) — rose ${moved.toFixed(1)}m straight up; dig out if this repeats`,
              here, takeover, wedgeNow);
          }
          const to = await flee(here.offset((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2), 5);
          anchor = undefined;
          const narration = takeover
            ? `wedged at ${fmt(here)} — cleared controls, jogged to ${fmt(to)}`
            : `wedged at ${fmt(here)} (no deliberate work in flight) — cleared controls, jogged to ${fmt(to)}`;
          return announceTakeover(narration, here, takeover, wedgeNow);
        };
      },
    },
    {
      // 5. Hunger housekeeping: eat before sprint dies at 6, not after.
      name: 'auto_eat',
      safety: false,
      cooldownMs: 5_000,
      check: () => {
        const food = bot.food;
        if (typeof food !== 'number' || food > 14) return null;
        if (hostiles(12).length) return null; // eating locks the hands for 1.6s
        const pick = bestFood(bot.inventory?.items().map((i) => i.name) ?? [], 20 - food);
        if (!pick) return null;
        return async () => {
          const item = bot.inventory.items().find((i) => i.name === pick);
          if (!item) return `went to eat ${pick} but it vanished from the bag`;
          await bot.equip(item, 'hand');
          await bot.consume();
          return `food was ${food}/20 — ate a ${pick.replace(/_/g, ' ')} (now ${bot.food}/20)`;
        };
      },
    },
    {
      // 5b. STARVING with no food: the fact, once, with its payable remedy.
      // soak41 died on a sandbar at 0.166 hp having asked a human for food —
      // #46/#47's lesson is that a true fact only changes behaviour when it
      // names an errand the body can actually pay for, so this one prices the
      // world's options and, below 5 hp, leads with the SAFEST rather than the
      // best. Latched: spoken once per starvation episode, re-armed by eating
      // or by a death (the corpse holds whatever the arithmetic assumed).
      name: 'starving',
      safety: false,
      needsLegs: false,
      cooldownMs: 15_000,
      check: () => {
        const food = bot.food;
        if (typeof food !== 'number') return null;
        if (food >= 18) { starvationAlarmed = false; return null; }
        if (starvationAlarmed) return null;
        const counts: Record<string, number> = {};
        for (const i of bot.inventory?.items() ?? []) counts[i.name] = (counts[i.name] ?? 0) + i.count;
        // Something edible in the bag is auto_eat's job, not an alarm.
        if (bestFood(Object.keys(counts), Math.max(1, 20 - food))) return null;
        return async () => {
          const fact = starvationFact();
          if (!fact) return '';
          starvationAlarmed = true;
          deps.note(`(reflex) ${fact}`);
          return `STARVING with nothing edible in the bag — ${fact}`;
        };
      },
    },
    {
      // 6. Strictly-better armor in the bag? Wear it. Rescan only when the
      // inventory actually changed — signature check is ~free.
      name: 'auto_armor',
      safety: false,
      cooldownMs: 2_000,
      check: () => {
        const items = bot.inventory?.items();
        if (!items) return null;
        const sig = items.map((i) => `${i.name}:${i.count}`).join(',');
        if (sig === invSignature) return null;
        invSignature = sig;
        const slotIndex: Record<ArmorSlot, number> = { head: 5, torso: 6, legs: 7, feet: 8 };
        const equipped: Partial<Record<ArmorSlot, string>> = {};
        for (const [slot, idx] of Object.entries(slotIndex)) {
          const worn = bot.inventory.slots[idx] as { name?: string } | null;
          if (worn?.name) equipped[slot as ArmorSlot] = worn.name;
        }
        const upgrades = bestArmorUpgrades(items.map((i) => i.name), equipped);
        if (!upgrades.length) return null;
        return async () => {
          const done: string[] = [];
          for (const u of upgrades) {
            const item = bot.inventory.items().find((i) => i.name === u.item);
            if (!item) continue;
            await bot.equip(item, u.slot);
            done.push(`${u.item.replace(/_/g, ' ')} → ${u.slot}`);
          }
          return `upgraded armor: ${done.join(', ')}`;
        };
      },
    },
    {
      // 7. Free loot within reach while idle. 2s notice-delay so we don't
      // lunge at items mid-drop; one attempt per entity id.
      name: 'item_magnet',
      safety: false,
      cooldownMs: 3_000,
      check: () => {
        const me = bot.entity?.position;
        if (!me) return null;
        const now = Date.now();
        const drops = Object.values(bot.entities ?? {})
          .filter((e): e is Entity => !!e?.position && (e.name === 'item' || e.name === 'Item')
            && me.distanceTo(e.position) <= 8);
        for (const id of itemFirstSeen.keys()) if (!drops.some((d) => d.id === id)) { itemFirstSeen.delete(id); itemAttempted.delete(id); }
        for (const d of drops) if (!itemFirstSeen.has(d.id)) itemFirstSeen.set(d.id, now);
        const ripe = drops
          .filter((d) => now - (itemFirstSeen.get(d.id) ?? now) > 2_000 && !itemAttempted.has(d.id))
          .sort((a, z) => me.distanceTo(a.position) - me.distanceTo(z.position))[0];
        if (!ripe) return null;
        return async () => {
          itemAttempted.add(ripe.id);
          const p = ripe.position;
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 0.5)),
            new Promise((_r, rej) => setTimeout(() => rej(new Error('magnet timeout')), 10_000)),
          ]);
          return `collected a dropped item at ${fmt(p)}`;
        };
      },
    },
    {
      // 8. Personal space: standing inside a player's hitbox blocks their
      // building, their view, and their patience. Step back one block.
      name: 'elbow_room',
      safety: false,
      cooldownMs: 5_000,
      check: () => {
        const me = bot.entity?.position;
        if (!me) return null;
        const crowder = Object.values(bot.entities ?? {})
          .filter((e): e is Entity => !!e?.position && e.id !== bot.entity.id && e.type === 'player'
            && me.distanceTo(e.position) < 1.2)[0];
        if (!crowder) return null;
        return async () => {
          const to = awayFrom(me, crowder.position, 2);
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(to.x, me.y, to.z, 1)),
            new Promise((_r, rej) => setTimeout(() => rej(new Error('elbow_room timeout')), 5_000)),
          ]);
          return ''; // courtesy, not news — no behavior-log line
        };
      },
    },
    {
      // 9. Look alive: face whoever is nearby (never endermen — eye contact
      // is aggression to them). Pure theatre for players and the dashboard.
      name: 'idle_staring',
      safety: false,
      cooldownMs: 0,
      check: () => {
        const me = bot.entity?.position;
        if (!me || Date.now() < nextGazeAt) return null;
        const target = Object.values(bot.entities ?? {})
          .filter((e): e is Entity => !!e?.position && e.id !== bot.entity.id && e.name !== 'enderman'
            && (e.type === 'player' || e.type === 'mob' || e.type === 'hostile'
              || ((e as { kind?: string }).kind ?? '').includes('mobs'))
            && me.distanceTo(e.position) <= 8)
          .sort((a, z) => me.distanceTo(a.position) - me.distanceTo(z.position))[0];
        if (!target) return null;
        return async () => {
          nextGazeAt = Date.now() + 2_000 + Math.random() * 10_000;
          const h = (target as { height?: number }).height ?? 1.6;
          await bot.lookAt(target.position.offset(0, h * 0.9, 0));
          return ''; // theatre — not worth a behavior-log line
        };
      },
    },
  ];

  const active = modes.filter((m) => !off.has(m.name) && (opts.idleModes !== false || m.safety || m.name === 'auto_eat'));

  // ---- the tick -------------------------------------------------------------
  let acting = false;
  const lastFired = new Map<string, number>();
  let lastDigestAt = 0;

  const tick = () => {
    if (acting || !bot.entity) return;
    const now = Date.now();
    for (const mode of active) {
      if (now - (lastFired.get(mode.name) ?? 0) < mode.cooldownMs) continue;
      if (!mode.safety && !idle()) continue;
      let action: (() => Promise<string>) | null;
      try { action = mode.check(); } catch { continue; } // a check must never kill the tick
      if (!action) continue;
      // Edge-triggered, and honest: unstuck is excluded because it no longer
      // destroys deliberate work (its 'note' branch speaks for itself), and
      // its has-a-goal precondition made this flag unconditionally true —
      // which burned the 15s digest budget on non-events and SUPPRESSED the
      // note that would have named the real cause (issue #8).
      const interrupted = mode.safety && mode.name !== 'unstuck' && (deps.deliberateBusy() || !!bot.pathfinder?.goal);
      // A claim on the legs, not just a flag: while an escape is in flight,
      // nobody below its rank may setGoal (issue #16 — both pathfinder attempts
      // of one `dying` episode died as "goal was changed" at 3 HP). Refused
      // modes leave `lastFired` untouched so they retry the moment it clears.
      // A mode that never calls setGoal takes no claim (see Mode.needsLegs):
      // swinging in place must not supersede — and thereby erase — the claim of
      // the walk it is defending, and must not be blocked by one either.
      const held = mode.needsLegs === false ? undefined : lock.take({
        owner: mode.name,
        priority: legsRankOf(mode),
        ttlMs: legsTtlOf(mode),
        what: mode.name === 'dying' ? 'a life-or-death escape' : `the ${mode.name} reflex`,
      });
      if (mode.needsLegs !== false && !held) continue;
      lastFired.set(mode.name, now);
      acting = true;
      // Idle modes re-verify at execution time: check() and the deliberate
      // side race on the pathfinder (issue #8's item_magnet noise) — a goal
      // set in the beat between check and act means the errand yields.
      const run = mode.safety ? action : async () => (idle() ? action!() : '');
      void run()
        .then((narration) => {
          if (!narration) return;
          remember(`[${mode.name}] ${narration}`);
          if (interrupted && Date.now() - lastDigestAt > 15_000) {
            lastDigestAt = Date.now();
            deps.note(`(reflex) The ${mode.name} reflex briefly took the legs — the body acted without you. Log: ${behaviorLog.slice(-3).join(' · ')}. Do NOT re-issue movement: an in-flight walk waits the reflex out and resumes toward its own target by itself. Act only if a tool RETURNS a cancellation.`);
          }
        })
        .catch((err) => remember(`[${mode.name}] failed: ${err instanceof Error ? err.message : err}`))
        .finally(() => { held?.release(); acting = false; });
      return; // one mode per tick
    }
  };

  const timer = setInterval(tick, tickMs);
  deps.log?.('reflex', `spinal cord online: ${active.map((m) => m.name).join(', ')} (tick ${tickMs}ms)`);
  // PRINT THE FACT YOU QUEUE: price a real dig-out once, out loud, so the rail
  // that decides whether the last three bubbles of air can buy a hole is
  // visible in the log BEFORE it is load-bearing.
  const bootPrice = setTimeout(() => {
    const p = bot.entity?.position;
    if (!p) return;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    for (const dy of [1, 2, -1]) {
      const b = bot.blockAt?.(new Vec3(fx, fy + dy, fz)) as { name?: string; boundingBox?: string } | undefined;
      if (!b || b.boundingBox !== 'block') continue;
      const where = dy > 0 ? 'overhead' : 'underfoot';
      const plan = priceDig(b as never, { canPillar: true, where });
      deps.log?.('reflex', `[dig_budget] the ${b.name} ${where} at y=${fy + dy}, if this body ever has to dig out through it: ${plan.line}`);
      return;
    }
    deps.log?.('reflex', '[dig_budget] nothing solid over or under this body to price a dig-out against');
  }, 15_000);
  bootPrice.unref?.();
  return {
    stop: () => { clearInterval(timer); clearTimeout(bootPrice); },
    recent: (n = 5) => behaviorLog.slice(-n),
    /** For the memory probe (issue #44): these are keyed by ENTITY id, and an
     *  entity id dies with its entity — 27 of them died in one soak. */
    sizes: (): Record<string, number> => ({
      'reflex.itemFirstSeen': itemFirstSeen.size,
      'reflex.itemAttempted': itemAttempted.size,
      'reflex.creeperEpisodes': creeperEpisodes.size,
      'reflex.behaviorLog': behaviorLog.length,
    }),
  };
}

/**
 * 👂 The senses — event-driven awareness, zero LLM cost until something matters.
 *
 * The agent's world used to be pull-based: it only learned about creepers,
 * nightfall or chest thieves when a tool call happened to look. The sentinel
 * inverts that for the handful of events that deserve it — and ONLY those.
 * Everything here is pure code; the model hears edge-triggered digests via
 * the pendingNotes queue (a note rides in front of the NEXT turn, never into
 * a possibly-mid-turn history) or, for can't-wait dangers, a reflex prompt.
 *
 * Hard-won rules encoded below:
 * - WHITELIST sounds; the raw stream is dozens/second of footsteps.
 * - NEVER subscribe to entityMoved for tracking (6 packet types, dozens/sec);
 *   a 1s poll over bot.entities is plenty for "is it getting closer?".
 * - Hysteresis everywhere: notify once per episode, re-arm only after the
 *   condition genuinely clears (a zombie hovering at 7.9/8.1 blocks must not
 *   buy a note per oscillation).
 * - Wire listeners via body.onEachBot so senses survive the signed-chat
 *   reconnect; keep episode STATE outside the wire function so a reconnect
 *   doesn't re-announce the same hunger/night/threat.
 */
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { LiveBody } from './body.js';
import { hostilesNear } from './digest.js';
import { loadPlaces } from './tools/memory.js';
import { oxygenReading, readArmed, standingHazards } from './tools/helpers.js';
import { cfg } from './config.js';

// ---------------------------------------------------------------------------
// Pure, testable pieces
// ---------------------------------------------------------------------------

/** Innermost distance band a threat is inside, or null when out of range. */
export function bandFor(dist: number, bands: number[] = [4, 8, 16]): number | null {
  for (const b of bands) if (dist <= b) return b;
  return null;
}

/**
 * Per-entity distance-band crossings with re-arming: announce each band once
 * while a threat closes in; if it retreats past a band, that band re-arms so a
 * second approach is news again.
 *
 * The subtlety is FORGETTING, and the live soak showed why (mc-soak4.log):
 *
 *     👂 radar: enderman closed to 16 blocks (120, 45, 104)
 *     👂 radar: enderman closed to 16 blocks (120, 45, 104)
 *
 * Same mob, same block, twice — because a threat sitting at the edge of the
 * outermost band crosses it back and forth on nothing but our own walking
 * jitter. Each exit deleted the entity's memory ("left range — full re-arm"),
 * and each return was therefore brand new. It gets worse than a duplicate log
 * line: an entity that drops out of hostilesNear() entirely is swept, and a mob
 * flickering at the boundary can then bill a model turn every second, forever,
 * while standing still.
 *
 * So leaving is now provisional. An entity out of range keeps its band for
 * `rearmAfterMs` and only then re-arms; the same grace covers absence from the
 * sweep, since "not in this poll's list" and "gone from the world" look
 * identical from here. A mob that genuinely leaves and comes back minutes later
 * is still news — that is what the grace period is measuring.
 */
export interface RadarEvent {
  /** The band it is inside — a rank, not a measurement. */
  band: number;
  /** How far away it ACTUALLY is. This is the number a human would say. */
  dist: number;
  /** 'in' = closer than before (or newly seen); 'out' = it disengaged. */
  direction: 'in' | 'out';
  /** The band it was in before, when there was one. */
  prevBand?: number;
}

export class BandTracker {
  /** How many entity ids this tracker still remembers (memory probe, issue #44). */
  get size(): number { return this.last.size; }

  /** id -> innermost band announced, plus when we stopped seeing it there. */
  private last = new Map<number, {
    band: number; missingSince?: number; saidAt?: number; saidBand?: number;
    /** News the floor swallowed — held so throttling delays a note instead of
     *  eating it, which would make the bot go quiet about a real approach. */
    pending?: RadarEvent;
  }>();

  constructor(
    private bands: number[] = [4, 8, 16],
    private rearmAfterMs = 15_000,
    /** Per-entity floor between notes. A phantom circles by design: without this
     *  it crosses a boundary every second or two and out-talks the fight it is
     *  part of (issue #31). Escalation is exempt — getting CLOSER is always news. */
    private minGapMs = 3_000,
    /** Hysteresis on the way out: a band only widens once the mob is genuinely
     *  clear of it, so 7→9→7 is one approach and not three. */
    private rearmMargin = 1.5,
  ) {}

  /** What to announce about this entity, or null (nothing new). */
  update(id: number, dist: number, now = Date.now()): RadarEvent | null {
    const band = bandFor(dist, this.bands);
    const prev = this.last.get(id);
    if (band === null) {
      // Out of range: start (or keep) the clock, and forget only once it has run
      // out. Deleting here is what made boundary jitter re-announce.
      if (prev) {
        prev.missingSince ??= now;
        if (now - prev.missingSince >= this.rearmAfterMs) this.last.delete(id);
      }
      return null;
    }
    if (prev === undefined) {
      this.last.set(id, { band, saidAt: now, saidBand: band });
      return { band, dist, direction: 'in' };
    }
    if (prev.missingSince !== undefined && now - prev.missingSince >= this.rearmAfterMs) {
      // The grace expired while nobody was polling this entity — a threat can be
      // absent from hostilesNear() entirely, so expiry must also be judged on the
      // way back IN, not only by whoever happens to call update() or sweep().
      this.last.set(id, { band, saidAt: now, saidBand: band });
      return { band, dist, direction: 'in' };
    }
    prev.missingSince = undefined; // seen in range again
    const prevBand = prev.band;
    if (band < prevBand) { // closed in
      prev.band = band;
      return this.gate(prev, { band, dist, direction: 'in', prevBand }, now);
    }
    if (band > prevBand && dist >= prevBand + this.rearmMargin) {
      // Genuinely clear of the old band, not jittering across its edge. Worth
      // saying only when it stops being a melee problem: during a fight, "it
      // disengaged" and "it is on me" are opposite decisions, and the old code
      // could only ever say the second one.
      prev.band = band;
      if (prevBand <= this.bands[0]!) return this.gate(prev, { band, dist, direction: 'out', prevBand }, now);
      return null;
    }
    // Nothing crossed — but a note the floor swallowed is still owed, as long as
    // it is still TRUE (same band). Re-measured, so the distance is current.
    if (prev.pending && prev.pending.band === band) {
      return this.gate(prev, { ...prev.pending, dist }, now);
    }
    return null;
  }

  /** The per-entity floor. Escalation (a deeper band than we last announced)
   *  always passes: a mob reaching melee range cannot be rate-limited. */
  private gate(
    st: { saidAt?: number; saidBand?: number; pending?: RadarEvent },
    ev: RadarEvent,
    now: number,
  ): RadarEvent | null {
    const escalating = st.saidBand === undefined || ev.band < st.saidBand;
    if (!escalating && st.saidAt !== undefined && now - st.saidAt < this.minGapMs) {
      st.pending = ev; // owed, not cancelled
      return null;
    }
    st.saidAt = now;
    st.saidBand = ev.band;
    st.pending = undefined;
    return ev;
  }

  /** How a radar event reads in a log line — band as a band, distance as a distance. */
  static phrase(name: string, ev: RadarEvent): string {
    const verb = ev.direction === 'in' ? 'inside' : 'pulled back to';
    return `${name} ${verb} ${ev.band} blocks — ${ev.dist.toFixed(1)} away`;
  }

  forget(id: number) { this.last.delete(id); }

  /** Drop every entity not in `alive` — but only after the same grace period,
   *  because one poll's filter is not proof of a despawn. */
  sweep(alive: Set<number>, now = Date.now()) {
    for (const [id, st] of this.last) {
      if (alive.has(id)) { st.missingSince = undefined; continue; }
      st.missingSince ??= now;
      if (now - st.missingSince >= this.rearmAfterMs) this.last.delete(id);
    }
  }
}

/** Once-per-window-per-key gate. Returns true when the hit is allowed through. */
export class Debouncer {
  private seen = new Map<string, number>();

  /** How many keys are still remembered (memory probe, issue #44). */
  get size(): number { return this.seen.size; }

  constructor(private windowMs: number) {}

  hit(key: string, now = Date.now()): boolean {
    const prev = this.seen.get(key);
    if (prev !== undefined && now - prev < this.windowMs) return false;
    this.seen.set(key, now);
    // Bounded: old keys expire naturally, but don't let a grief-spree grow the map forever.
    if (this.seen.size > 500) {
      for (const [k, t] of this.seen) if (now - t >= this.windowMs) this.seen.delete(k);
    }
    return true;
  }
}

/** Does losing this item from the inventory mean "my tool broke"? */
export function isBreakableTool(name: string): boolean {
  return /(_pickaxe|_axe|_shovel|_sword|_hoe)$/.test(name)
    || ['shears', 'fishing_rod', 'flint_and_steel', 'bow', 'crossbow', 'trident', 'shield', 'elytra'].includes(name);
}

/** What we knew about a tool at the moment it left the hand. */
export interface HeldTool {
  name: string;
  /** prismarine-item: uses spent, and the total this material allows. */
  durabilityUsed?: number;
  maxDurability?: number;
}

/**
 * Did that tool BREAK, or did it just move?
 *
 * The live soak caught four false alarms in three minutes — diamond pickaxe,
 * wooden sword, iron pickaxe, stone sword — every one of them still in the bag
 * when asked (issue #23). The old test was "the tool I was holding is not in
 * inventory.items() right now", evaluated synchronously inside heldItemChanged.
 * But a swap is not atomic: bot.equip() walks the item through the CURSOR slot,
 * and on 1.21.x the server then replies with authoritative set_slot/window_items.
 * For those few milliseconds the item is genuinely nowhere — it is in flight —
 * and heldItemChanged fires in the middle of that window. So every equip that
 * moved a tool read as a break.
 *
 * Two independent facts have to agree before we accuse:
 *
 *  1. It is still missing AFTER things settle, looking everywhere an item can
 *     hide — inventory, raw slots, an open window, the cursor.
 *  2. It was actually about to break. A tool breaks on its LAST use, so
 *     durability is a hard alibi: a pickaxe with 800 uses left cannot have
 *     broken, no matter what the inventory view says mid-click.
 *
 * Pure so the tests can state the four soak cases outright.
 */
export function judgeToolBreak(o: {
  prev?: HeldTool;
  next?: string;
  /** Present anywhere after settling (see toolIsAnywhere). */
  present: boolean;
  /** ms since the connection was (re)wired — a fresh window is a lying window. */
  sinceWired?: number;
  /** How many uses may remain and still count as "about to break". */
  usesLeftAllowed?: number;
}): { broke: boolean; why: string } {
  const prev = o.prev;
  if (!prev) return { broke: false, why: 'nothing was held before' };
  if (prev.name === o.next) return { broke: false, why: 'same item' };
  if (!isBreakableTool(prev.name)) return { broke: false, why: 'not a breakable tool' };
  if (o.present) return { broke: false, why: 'still in the bag — an equip moves an item through the cursor' };
  if ((o.sinceWired ?? Infinity) < 3_000) {
    // Right after a reconnect the inventory view is being rebuilt from scratch;
    // absence there means "not told yet", not "gone".
    return { broke: false, why: 'inventory still arriving after a (re)connect' };
  }
  const max = prev.maxDurability;
  const used = prev.durabilityUsed;
  if (typeof max === 'number' && typeof used === 'number') {
    const left = max - used;
    if (left > (o.usesLeftAllowed ?? 1)) {
      return { broke: false, why: `it had ${left} uses left — a tool breaks on its last use, so this was a move, not a break` };
    }
    return { broke: true, why: `it was on its last use (${left} left) and is gone` };
  }
  // Durability unknown (older data, or an item we never saw fully): fall back to
  // the settled absence alone — one fact, but a fact that waited.
  return { broke: true, why: 'gone after settling, durability unknown' };
}

/** Everywhere an item can legitimately be during a swap: the bag, the raw slot
 *  array (holds the cursor), and any open container's slots. */
export function toolIsAnywhere(name: string, view: {
  items?: Array<{ name: string } | null>;
  slots?: Array<{ name: string } | null>;
  windowSlots?: Array<{ name: string } | null>;
}): boolean {
  const hit = (arr?: Array<{ name: string } | null>) => (arr ?? []).some((i) => i?.name === name);
  return hit(view.items) || hit(view.slots) || hit(view.windowSlots);
}

/** 'minecraft:entity.creeper.primed' and 'entity.creeper.primed' are the same sound. */
export function normalizeSound(name: string): string {
  return name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name;
}

/**
 * 👥 Who is allowed to touch the base without being reported.
 *
 * Base security was written for griefers and then aimed at the operator: in one
 * live half-hour it produced 14 of the bot's 15 briefings, every one about
 * Cagatay mining his own tunnel, each at importance 2 and each read aloud
 * (issue #9). Anyone who BUILDS with the bot trips it constantly. So trust is
 * explicit — TRUSTED_PLAYERS, comma-separated, case-insensitive — and a
 * trusted player's digging/chest-opening stays a log line and never becomes a
 * note, a briefing or a prompt.
 */
export function trustedPlayers(env = process.env.TRUSTED_PLAYERS): Set<string> {
  return new Set((env ?? '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean));
}

/**
 * 👷 …and the crew is not company, either.
 *
 * Same live soak, next hour: the primary hired `Sparky` and `Stairwell`, and its
 * own social rail briefed it — *"Sparky JOINED the world. If it's your operator,
 * a short greeting + a one-line progress report in chat is welcome."* It hired
 * that body ninety seconds earlier. Worse than wasted: workers are deaf to chat
 * by design, so the greeting is spoken to nobody, and the matching `playerLeft`
 * ("no need to keep chatting at them") arrives every time a worker retires
 * normally — a supervisor reading that has been told a colleague walked out.
 *
 * Crew is NOT the same set as trusted: a trusted human joining is real news that
 * deserves a greeting. Only the fleet roster is filtered here, and only from the
 * briefings — the log lines stay, because seeing crew arrive is how an operator
 * watches the fleet work.
 */
export function isOwnCrew(who: string | undefined, ownWorkers: readonly string[] = []): boolean {
  if (!who) return false;
  const name = who.toLowerCase();
  return ownWorkers.some((w) => w.toLowerCase() === name);
}

/**
 * 👷 The bot's own hired workers are not burglars.
 *
 * Live soak 2026-08-17: the primary hired `Digger` to cut a staircase, and 20
 * seconds later its own sentinel raised an importance-2 briefing — *"Digger is
 * BREAKING spruce_log near your waypoint 'loot_chest' — 13 blocks so far"* —
 * i.e. the exact issue-#9 spam, but now about a body the bot itself paid for and
 * whose task literally says "dig". `TRUSTED_PLAYERS` cannot fix this: worker
 * names are invented at hire time, so no operator can pre-list them.
 *
 * Trust is therefore the union of the explicit env list and the CURRENT fleet
 * roster, evaluated per event (workers come and go mid-session). A worker
 * misbehaving is a fleet problem — the journal and `manage_bots` own it — not a
 * security alert.
 */
export function isTrustedName(
  who: string | undefined,
  trusted: ReadonlySet<string>,
  ownWorkers: readonly string[] = [],
): boolean {
  if (!who) return false;
  const name = who.toLowerCase();
  return trusted.has(name) || ownWorkers.some((w) => w.toLowerCase() === name);
}

/**
 * ⛏ One note per digger per base, with a count — not one per block.
 *
 * The old gate was `Debouncer(30s).hit('break:' + block.position)`, which can
 * only suppress the same block twice. But the signal it guards means a NEW
 * position every block, so it suppressed nothing and the case it did suppress
 * never happens (issue #9). What the note is actually about is the PERSON and
 * the PLACE, so that is the key.
 *
 * Shape: the first hit opens an episode and settles for `settleMs` (so the note
 * can say "7 blocks" instead of "a block"), one note fires, and further blocks
 * are counted in silence until `windowMs` passes — at which point a still-live
 * spree earns exactly one escalation note. Pure over an injected clock.
 */
export interface BreakEpisode {
  /** Blocks broken since the last note (including the ones in the settle). */
  count: number;
  /** Distinct block names seen, most recent first, capped for prose. */
  kinds: string[];
  /** Where the latest block was. */
  at: { x: number; y: number; z: number };
  /** Is this an escalation (a spree that outlived the window) or the first note? */
  escalated: boolean;
  /** How long this episode has been running, ms. */
  ageMs: number;
}

export class BreakAggregator {
  /** How many break episodes are still open (memory probe, issue #44). */
  get size(): number { return this.episodes.size; }

  private episodes = new Map<string, {
    count: number; kinds: string[]; at: { x: number; y: number; z: number };
    startedAt: number; notedAt?: number; timer?: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private emit: (key: string, e: BreakEpisode) => void,
    private settleMs = 4_000,
    private windowMs = 90_000,
    private now: () => number = Date.now,
  ) {}

  /** Record one observed break. Returns nothing — notes arrive via `emit`. */
  hit(key: string, blockName: string, at: { x: number; y: number; z: number }) {
    const t = this.now();
    let ep = this.episodes.get(key);
    if (!ep) {
      ep = { count: 0, kinds: [], at, startedAt: t };
      this.episodes.set(key, ep);
      // settle first, so the very first note carries a real count
      ep.timer = setTimeout(() => this.flush(key), this.settleMs);
      ep.timer.unref?.();
    }
    ep.count++;
    ep.at = at;
    if (blockName && !ep.kinds.includes(blockName)) ep.kinds.unshift(blockName);
    // A spree that outlives the quiet window gets ONE escalation, then quiets again.
    if (ep.notedAt !== undefined && t - ep.notedAt >= this.windowMs) this.flush(key);
  }

  private flush(key: string) {
    const ep = this.episodes.get(key);
    if (!ep || ep.count === 0) return;
    if (ep.timer) { clearTimeout(ep.timer); ep.timer = undefined; }
    const escalated = ep.notedAt !== undefined;
    this.emit(key, {
      count: ep.count,
      kinds: ep.kinds.slice(0, 3),
      at: ep.at,
      escalated,
      ageMs: this.now() - ep.startedAt,
    });
    ep.count = 0;
    ep.notedAt = this.now();
  }

  /** Forget episodes nobody has touched in a while (bounded memory). */
  sweep(idleMs = 300_000) {
    const t = this.now();
    for (const [k, ep] of this.episodes) {
      if (ep.count === 0 && t - (ep.notedAt ?? ep.startedAt) > idleMs) {
        if (ep.timer) clearTimeout(ep.timer);
        this.episodes.delete(k);
      }
    }
  }

  stop() {
    for (const ep of this.episodes.values()) if (ep.timer) clearTimeout(ep.timer);
    this.episodes.clear();
  }
}

/** The note text for one aggregated digging episode — pure, so tests read it. */
export function breakNote(who: string, base: string, e: BreakEpisode): string {
  const what = e.kinds.length ? e.kinds.join('/') : 'blocks';
  const secs = Math.max(1, Math.round(e.ageMs / 1000));
  const blocks = `${e.count} block${e.count === 1 ? '' : 's'}`;
  return e.escalated
    ? `(sentinel) ${who} is STILL digging near your waypoint '${base}' — ${blocks} more (${what}), latest at ${fmt(e.at)}, ${secs}s into it. If you haven't dealt with this yet, deal with it.`
    : `(sentinel) ${who} is BREAKING ${what} near your waypoint '${base}' — ${blocks} so far, latest at ${fmt(e.at)}. If that's your build, go look — politely or otherwise.`;
}

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;

// ---------------------------------------------------------------------------
// The sentinel
// ---------------------------------------------------------------------------

export interface SentinelSink {
  /** Queue an edge-triggered digest for the model (pendingNotes rail). */
  note: (text: string) => void;
  /** Can't-wait danger: an urgent model turn, subject to the caller's cooldown. */
  reflex: (name: string, prompt: string) => void;
  /** Dashboard/console visibility that the senses are alive. */
  log?: (who: string, text: string) => void;
  /** Names of the bot's OWN hired workers, right now — they are never intruders. */
  ownWorkers?: () => string[];
}

export interface SentinelHandle {
  stop: () => void;
  /** Current tracked hostiles, nearest first — food for the world digest. */
  threats: () => string[];
  /** Sizes of the senses' memories, by name, for the memory probe (issue #44). */
  sizes: () => Record<string, number>;
}

const RADAR_POLL_MS = cfg.sentinel.radarPollMs;
// Env-tunable for the same reason as the security windows below: a test can run
// the day/night edge detector in milliseconds instead of waiting two polls.
const TIME_POLL_MS = Number(process.env.SENTINEL_TIME_POLL_MS ?? 5_000);
const RADAR_RANGE = cfg.sentinel.radarRange;
const SECURITY_RANGE = cfg.sentinel.securityRange; // "near my base" radius around saved waypoints
const OXYGEN_REFLEX_AT = cfg.sentinel.oxygenReflexAt; // bubbles, of 20

/**
 * 🫧 The air gauge is not a hazard detector.
 *
 * Live soak 2026-08-17: 255 × `drowning: oxygen 0/20` (and `-1/20`) while the
 * bot stood on dry cobblestone with sky overhead — the agent itself wrote "no
 * water anywhere around me, this is a false reading", after every one of those
 * notes had already bought a real model turn. `bot.oxygenLevel` reads 0, -1 or
 * undefined on land: two scales (units out of 20, ticks out of 300) and no
 * metadata at all until the first submersion, so a LOW NUMBER MEANS NOTHING BY
 * ITSELF. World truth decides drowning: the head block must be water.
 *
 * Verified live while fixing: the soak process still running from before this
 * commit had logged 330 of these on land (up from 255 an hour earlier) — the
 * old rail keeps firing until that process is restarted, which is proof of the
 * storm, not of the fix. The fix is proven by the tests below it.
 *
 * And surfacing is the only re-arm. Keying re-arm on the gauge climbing back
 * turned one submersion into a firing storm, because on land the gauge flickers
 * across any threshold you pick.
 */
export class DrowningGate {
  private armed = true;
  /** Bubbles to escalate at, or null for silence. */
  check(raw: number | undefined, submerged: boolean): number | null {
    if (!submerged) {
      this.armed = true; // out of the water — the next real dunk is news
      return null;
    }
    const units = oxygenReading(raw)?.units;
    if (units === undefined) return null;
    if (!this.armed || units >= OXYGEN_REFLEX_AT) return null;
    this.armed = false;
    return units;
  }
}

/** Sound whitelist: everything else in the stream is noise. */
const SOUNDS: Record<string, { reflex?: string; text: (pos: Vec3, me?: Vec3) => string }> = {
  'entity.creeper.primed': {
    reflex: 'blast_flee',
    text: (pos, me) => `A CREEPER just HISSED at ${fmt(pos)}${me ? ` — ${me.distanceTo(pos).toFixed(1)} blocks from you` : ''}. ~1.5s fuse; the blast wounds out to ~7 blocks and solid cover blocks it. URGENT — act inside that clock.`,
  },
  'entity.tnt.primed': {
    reflex: 'blast_flee',
    text: (pos, me) => `TNT was just PRIMED at ${fmt(pos)}${me ? ` — ${me.distanceTo(pos).toFixed(1)} blocks from you` : ''}. ~4s fuse; the blast wounds out to ~7 blocks and solid cover blocks it. URGENT.`,
  },
  'entity.zombie.break_wooden_door': {
    text: (pos) => `(sentinel) A zombie is BREAKING A DOOR at ${fmt(pos)} — on hard difficulty wooden doors DO fail; it gets through if nothing changes.`,
  },
  'entity.ghast.warn': {
    text: (pos) => `(sentinel) A ghast is winding up a fireball near ${fmt(pos)} — it needs line of sight to aim, and its fireball can be hit back at it.`,
  },
};

export function startSentinel(body: LiveBody, sink: SentinelSink): SentinelHandle | null {
  if (process.env.SENTINEL_DISABLED === 'true') return null;
  const bot = body.bot; // the reconnect-surviving proxy — safe to poll forever

  const log = (text: string) => sink.log?.('sentinel', text);

  // -- episode state: OUTSIDE onEachBot so reconnects don't re-announce -----
  const soundDebounce = new Debouncer(5_000);
  const securityDebounce = new Debouncer(30_000);
  // Trusted hands are quiet, not invisible — but `blockBreakProgressObserved`
  // fires once per DIG STAGE, so the live soak printed the same line six times
  // for one block of sand ('(trusted) Digger2 broke sand near loot_chest').
  // One line per (digger, base) per window is the whole intent.
  const trustedLogDebounce = new Debouncer(30_000);
  const trustedBreakKey = (who: string, base: string) => `trustbreak:${who.toLowerCase()}:${base}`;
  // Explicit trust, read once per episode: the operator is not an intruder.
  const trusted = trustedPlayers();
  if (trusted.size) log(`trusted players: ${[...trusted].join(', ')}`);
  // Union with the live fleet roster: our own hired diggers dig by definition.
  const isTrusted = (who?: string) => isTrustedName(who, trusted, sink.ownWorkers?.() ?? []);
  const isCrew = (who?: string) => isOwnCrew(who, sink.ownWorkers?.() ?? []);
  // Diggers are aggregated per (person, base) — see BreakAggregator. The two
  // timings are env-tunable so a test can run them in milliseconds (and so an
  // operator on a busy server can widen the quiet window).
  const settleMs = Number(process.env.SECURITY_SETTLE_MS ?? 4_000);
  const quietMs = Number(process.env.SECURITY_QUIET_MS ?? 90_000);
  const breaks = new BreakAggregator((key, e) => {
    const [who, base] = key.split('\u0000');
    log(`block break near '${base}': ${who} — ${e.count} block(s), latest ${fmt(e.at)}${e.escalated ? ' (still going)' : ''}`);
    sink.note(breakNote(who, base, e));
  }, settleMs, quietMs);
  const effectDebounce = new Debouncer(30_000);
  const forcedMoveDebounce = new Debouncer(10_000);
  const toolBreakDebounce = new Debouncer(10_000);
  // Long enough for the equip click sequence AND the server's authoritative
  // set_slot/window_items reply to land — the window in which a moving tool
  // looks like a missing one.
  const TOOL_BREAK_SETTLE_MS = Number(process.env.TOOL_BREAK_SETTLE_MS ?? 700);
  // 15s grace before a threat is forgotten: long enough that walking jitter at
  // the 16-block edge cannot re-announce a motionless mob (soak: the same
  // enderman twice), short enough that a mob which truly left and came back is
  // still news. RADAR_REARM_MS if a world disagrees.
  const radar = new BandTracker(
    [4, 8, 16],
    Number(process.env.RADAR_REARM_MS ?? 15_000),
    Number(process.env.RADAR_MIN_GAP_MS ?? 3_000),
  );
  const gamemodes = new Map<string, string>(); // player -> last seen gamemode
  let ownGamemode: string | undefined;
  let wasDay: boolean | undefined;
  const drowning = new DrowningGate();
  let prevHeld: HeldTool | undefined;
  let wiredAt = 0; // forcedMove fires on spawn — ignore the first seconds
  const threatLines: string[] = []; // latest radar snapshot, nearest first

  // ---- (b) hostile radar: 1s poll, band crossings, no entityMoved ---------
  const pollRadar = () => {
    if (!bot.entity?.position) return;
    const hostiles = hostilesNear(bot); // the shared radar (issue #6.4)
    radar.sweep(new Set(hostiles.map((h) => h.e.id))); // graced: one poll's filter is not a despawn
    threatLines.length = 0;
    for (const { e, dist } of hostiles.slice(0, 5)) {
      if (dist <= RADAR_RANGE) threatLines.push(`${e.name ?? '?'} ${dist.toFixed(0)}m ${fmt(e.position)}`);
      const ev = radar.update(e.id, dist);
      if (ev === null) continue;
      const name = e.name ?? 'hostile mob';
      log(`radar: ${BandTracker.phrase(name, ev)} ${fmt(e.position)}`);
      if (ev.direction === 'out') {
        sink.note(`(sentinel) The ${name} pulled back to ${ev.dist.toFixed(1)} blocks, at ${fmt(e.position)} — out of melee range for now.`);
      } else if (ev.band <= 4) {
        // #46: the one clause that changes the answer. Only when it is BAD news —
        // an armed bot does not need its own sword read back to it inside a
        // 2-second alarm, and this line is spoken aloud.
        const armed = readArmed(bot);
        const bare = armed.armed ? '' : ` ${armed.line}`;
        sink.reflex('hostile_close', `A ${name} is ${dist.toFixed(1)} blocks away at ${fmt(e.position)} — melee range, its first swing lands within seconds. You are at ${typeof bot.health === 'number' ? bot.health.toFixed(0) : '?'}/20 hp.${bare} URGENT — your move, but make it now.`);
      } else {
        sink.note(`(sentinel) A ${name} closed to ${ev.dist.toFixed(1)} blocks (inside ${ev.band}), at ${fmt(e.position)}, heading ${ev.direction === 'in' ? 'toward you' : 'away'}.`);
      }
    }
  };

  // ---- (c) time: edge-detect day/night flips, not the per-tick event ------
  const pollTime = () => {
    const t = bot.time;
    if (!t || typeof t.isDay !== 'boolean') return;
    if (wasDay === undefined) { wasDay = t.isDay; return; }
    if (t.isDay === wasDay) return;
    wasDay = t.isDay;
    if (t.isDay) {
      log('dawn');
      sink.note('(sentinel) DAWN — undead outside are starting to burn. Good window to move, harvest, or resume outdoor work.');
    } else {
      const fullMoon = t.moonPhase === 0;
      log(`dusk${fullMoon ? ' (full moon)' : ''}`);
      // Issue #46: the bot walked into a full-moon phantom swarm with an empty
      // hotbar and fought 120 swings bare-fisted. Dusk is the moment the mind
      // plans the night, so the armed state is a fact it gets BEFORE the fight,
      // not a note that arrives while the fight is being lost.
      sink.note(`(sentinel) NIGHT FALLS${fullMoon ? ' — FULL MOON, maximum hostile spawns' : ''} — hostiles spawn in the dark. ${readArmed(bot).line} Consider shelter, torches around your worksite, or a bed to skip it.`);
    }
  };

  const radarTimer = setInterval(pollRadar, RADAR_POLL_MS);
  const timeTimer = setInterval(pollTime, TIME_POLL_MS);
  // Digging episodes are per (person, base) — a long session across many bases
  // would otherwise keep every key forever.
  const sweepTimer = setInterval(() => breaks.sweep(), 60_000);
  sweepTimer.unref?.();

  body.onEachBot((b) => {
    wiredAt = Date.now();

    // ---- (a) hearing: whitelist only — the raw stream is spam -------------
    b.on('soundEffectHeard', (soundName, position) => {
      const entry = SOUNDS[normalizeSound(soundName)];
      if (!entry || !position) return;
      if (!soundDebounce.hit(normalizeSound(soundName))) return;
      log(`heard ${normalizeSound(soundName)} at ${fmt(position)}`);
      if (entry.reflex) sink.reflex(entry.reflex, `(reflex) ${entry.text(position, b.entity?.position)}`);
      else sink.note(entry.text(position, b.entity?.position));
    });

    // ---- (b) spawn arm: a hostile appearing nearby shouldn't wait 1s ------
    b.on('entitySpawn', (e) => {
      if (!e?.position || !b.entity?.position) return;
      const kind = (e as { kind?: string }).kind;
      if (kind !== 'Hostile mobs' && e.type !== 'hostile') return;
      if (b.entity.position.distanceTo(e.position) > RADAR_RANGE) return;
      pollRadar(); // radar announces via band logic — no duplicate paths
    });

    // ---- (d) social: presence + gamemode flips -----------------------------
    b.on('playerJoined', (player) => {
      if (!player.username || player.username === b.username) return;
      gamemodes.set(player.username, String((player as { gamemode?: number }).gamemode ?? ''));
      log(`player joined: ${player.username}`);
      if (isCrew(player.username)) return; // own hire arriving: visible, not news
      sink.note(`(sentinel) ${player.username} JOINED the world. If it's your operator, a short greeting + a one-line progress report in chat is welcome.`);
    });
    b.on('playerLeft', (player) => {
      if (!player.username || player.username === b.username) return;
      gamemodes.delete(player.username);
      log(`player left: ${player.username}`);
      // A retiring worker is fleet bookkeeping (manage_bots reports it), not a
      // departure to stop chatting at.
      if (isCrew(player.username)) return;
      sink.note(`(sentinel) ${player.username} LEFT the world. No need to keep chatting at them; carry on autonomously.`);
    });
    b.on('playerUpdated', (player) => {
      if (!player.username || player.username === b.username) return;
      const gm = String((player as { gamemode?: number }).gamemode ?? '');
      const prev = gamemodes.get(player.username);
      gamemodes.set(player.username, gm);
      if (prev === undefined || prev === gm || gm === '') return;
      if (isCrew(player.username)) return; // a worker's own gamemode is the bot's business, not a bulletin
      const names: Record<string, string> = { '0': 'survival', '1': 'creative', '2': 'adventure', '3': 'spectator' };
      sink.note(`(sentinel) ${player.username}'s gamemode changed to ${names[gm] ?? gm}. This changes what drops/works: creative players' broken blocks drop NOTHING.`);
    });
    b.on('game', () => {
      const gm = b.game?.gameMode;
      if (!gm) return;
      if (ownGamemode !== undefined && gm !== ownGamemode) {
        sink.note(`(sentinel) YOUR gamemode is now ${gm}. ${gm === 'creative' ? 'Blocks you break drop nothing; you can creative_fly and use creative_inventory.' : 'Survival rules apply: hunger, fall damage, and drops are back.'}`);
        log(`own gamemode -> ${gm}`);
      }
      ownGamemode = gm;
    });

    // ---- (e) base security: eyes on the waypoints --------------------------
    const nearBase = (pos: Vec3): string | null => {
      for (const p of loadPlaces()) {
        const d = Math.hypot(pos.x - p.x, pos.y - p.y, pos.z - p.z);
        if (d <= SECURITY_RANGE) return p.name;
      }
      return null;
    };
    b.on('chestLidMove', (block, isOpen) => {
      if (isOpen <= 0 || !block?.position) return;
      if (b.currentWindow) return; // that's us, doing inventory work
      const pos = block.position.clone();
      // The lid packet outruns the openWindow response when WE are the opener
      // (live soak: the bot restocking its own loot_chest got reported as an
      // intruder). Defer the verdict a beat and re-check who has a window up.
      setTimeout(() => {
        if (b.currentWindow) return; // it was us after all
        const base = nearBase(pos);
        if (!base) return;
        if (!securityDebounce.hit(`chest:${pos}`)) return;
        const me = b.entity?.position;
        const suspect = Object.values(b.players ?? {})
          .filter((p) => p.username !== b.username && p.entity?.position
            && p.entity.position.distanceTo(pos) < 6)
          .map((p) => p.username)[0];
        if (!suspect && me && me.distanceTo(pos) <= 5) return; // adjacent, alone: almost certainly our own hands
        if (isTrusted(suspect)) {
          log(`(trusted) ${suspect} opened a chest near '${base}' ${fmt(pos)}`);
          return;
        }
        log(`chest opened near '${base}' ${fmt(pos)}${suspect ? ` by ${suspect}` : ''}`);
        sink.note(`(sentinel) A chest at ${fmt(pos)} near your waypoint '${base}' was just OPENED${suspect ? ` — ${suspect} is standing right there` : ' — nobody visible nearby'}.${me && me.distanceTo(pos) > 8 ? ' You are not close enough to have done it.' : ''} Worth checking if anything went missing.`);
      }, 300);
    });
    // The typings say (block, stage); newer servers also pass the perpetrator.
    (b as unknown as { on: (ev: string, fn: (...a: unknown[]) => void) => void }).on(
      'blockBreakProgressObserved',
      (...args: unknown[]) => {
        const block = args[0] as { position?: Vec3; name?: string } | undefined;
        const entity = args[2] as Entity | undefined;
        if (!block?.position) return;
        if (entity && b.entity && entity.id === b.entity.id) return; // our own digging
        const base = nearBase(block.position);
        if (!base) return;
        const who = entity?.type === 'player' ? (entity.username ?? 'a player') : (entity?.name ?? 'someone');
        // Building WITH the bot is not a break-in (issue #9): trusted hands
        // stay a log line and never reach the model or the voice rail.
        if (isTrusted(who)) {
          if (trustedLogDebounce.hit(trustedBreakKey(who, base)))
            log(`(trusted) ${who} is working near '${base}' — broke ${block.name ?? 'a block'} ${fmt(block.position)}`);
          return;
        }
        // One note per digger per base, carrying a count — a tunnel is a new
        // position every block, so per-position debouncing suppressed nothing.
        breaks.hit(`${who}\u0000${base}`, block.name ?? '', block.position.clone());
      },
    );

    // ---- (f) vitals+ --------------------------------------------------------
    b.on('breath', () => {
      const me = b.entity?.position;
      const submerged =
        !!me &&
        standingHazards(me, (x, y, z) => b.blockAt?.(new Vec3(x, y, z))?.name).some(
          (h) => h.kind === 'water_over_head',
        );
      const units = drowning.check(b.oxygenLevel, submerged);
      if (units === null) return;
      log(`drowning: oxygen ${units}/20 with water overhead`);
      sink.reflex('drowning', `(reflex) You are DROWNING — oxygen ${units}/20 and falling, head underwater. Only air refills it; nothing else matters until you breathe.`);
    });
    b.on('entityEffect', (entity, effect) => {
      if (!b.entity || entity.id !== b.entity.id) return;
      const name = (b.registry as unknown as { effectsById?: Record<number, { name?: string }> })
        .effectsById?.[(effect as { id: number }).id]?.name ?? `effect ${(effect as { id: number }).id}`;
      if (!/poison|wither/i.test(name)) return;
      if (!effectDebounce.hit(name)) return;
      log(`afflicted: ${name}`);
      sink.note(`(sentinel) You are ${name.toUpperCase()}ED — health is draining over time. ${/wither/i.test(name) ? 'Wither CAN kill you outright' : 'Poison stops at half a heart'}; milk cures it, and regen needs food ≥ 18.`);
    });
    b.on('heldItemChanged', (newItem) => {
      const item = newItem as unknown as (HeldTool | null);
      const prev = prevHeld;
      prevHeld = item ? { name: item.name, durabilityUsed: item.durabilityUsed, maxDurability: item.maxDurability } : undefined;
      if (!prev || prev.name === item?.name || !isBreakableTool(prev.name)) return;
      // LOOK LATER, not now: the item is in flight through the cursor while this
      // event fires, so an immediate check accuses every equip (issue #23).
      setTimeout(() => {
        const inv = b.inventory as unknown as { items?: () => Array<{ name: string }>; slots?: Array<{ name: string } | null> } | undefined;
        const present = toolIsAnywhere(prev.name, {
          items: inv?.items?.(),
          slots: inv?.slots,
          windowSlots: (b.currentWindow as unknown as { slots?: Array<{ name: string } | null> } | null)?.slots,
        });
        const v = judgeToolBreak({ prev, next: item?.name, present, sinceWired: Date.now() - wiredAt });
        if (!v.broke) return;
        if (!toolBreakDebounce.hit(prev.name)) return; // one break = one note (the event can echo)
        log(`tool broke: ${prev.name} (${v.why})`);
        sink.note(`(sentinel) Your ${prev.name.replace(/_/g, ' ')} just BROKE — ${v.why}. Craft or fetch a replacement before continuing that work — bare hands are slow and drop nothing from ores.`);
      }, TOOL_BREAK_SETTLE_MS).unref?.();
    });
    let lastKnownPos: Vec3 | undefined;
    b.on('move', () => { if (b.entity?.position) lastKnownPos = b.entity.position.clone(); });
    b.on('forcedMove', () => {
      if (Date.now() - wiredAt < 5_000) return; // spawn/respawn positioning, not news
      const p = b.entity?.position;
      // Rubber-banding: the server snaps a lagging client back to (almost)
      // where it already was — live soak logged 9 'forced move' notes to the
      // SAME block while the bot idled at a furnace. A real /tp changes the
      // position meaningfully; only that is worth interrupting the mind for.
      if (p && lastKnownPos && p.distanceTo(lastKnownPos) < 4) return;
      if (!forcedMoveDebounce.hit('tp')) return;
      log(`forced move -> ${p ? fmt(p) : '?'}`);
      sink.note(`(sentinel) You were MOVED by the server — now at ${p ? fmt(p) : 'an unknown position'}. If you didn't just use the teleport tool, someone /tp'd you; reassess where you are before resuming.`);
    });
  });

  log('senses online: hearing, radar, clock, social, base security, vitals');
  return {
    stop: () => { clearInterval(radarTimer); clearInterval(timeTimer); clearInterval(sweepTimer); breaks.stop(); },
    threats: () => [...threatLines],
    /** Sizes of what the senses REMEMBER, for the memory probe (issue #44):
     *  every one of these is keyed by something the world destroys (entity ids
     *  die, players leave), so each is a candidate retainer. */
    sizes: (): Record<string, number> => ({
      'sentinel.radar': radar.size,
      'sentinel.breaks': breaks.size,
      'sentinel.gamemodes': gamemodes.size,
      'sentinel.threatLines': threatLines.length,
    }),
  };
}

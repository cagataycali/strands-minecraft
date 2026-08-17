import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import { cfg } from '../config.js';
import { legsFor, LEGS_PRIORITY, isGoalChangedError } from '../legs.js';

export function vec(pos: { x: number; y: number; z: number }): Vec3 {
  return new Vec3(pos.x, pos.y, pos.z);
}

export function fmtPos(p: { x: number; y: number; z: number }): string {
  return `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
}

export function describeBlock(b: Block): Record<string, unknown> {
  return {
    name: b.name,
    displayName: b.displayName,
    position: { x: b.position.x, y: b.position.y, z: b.position.z },
    hardness: b.hardness,
    diggable: b.diggable,
  };
}

export function describeEntity(bot: Bot, e: Entity): Record<string, unknown> {
  return {
    id: e.id,
    type: e.type,
    name: e.name ?? e.username ?? 'unknown',
    username: e.username,
    position: { x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1) },
    distance: +bot.entity.position.distanceTo(e.position).toFixed(1),
    health: (e as unknown as { health?: number }).health,
  };
}

/** Find a block type id by name, throws with suggestions if unknown. */
export function blockByName(bot: Bot, name: string) {
  const block = bot.registry.blocksByName[name.toLowerCase()];
  if (!block) {
    const close = Object.keys(bot.registry.blocksByName)
      .filter((n) => n.includes(name.toLowerCase()))
      .slice(0, 8);
    throw new Error(`Unknown block '${name}'. Close matches: ${close.join(', ') || 'none'}`);
  }
  return block;
}

/** Find an item type by name, throws with suggestions if unknown. */
export function itemByName(bot: Bot, name: string) {
  const item = bot.registry.itemsByName[name.toLowerCase()];
  if (!item) {
    const close = Object.keys(bot.registry.itemsByName)
      .filter((n) => n.includes(name.toLowerCase()))
      .slice(0, 8);
    throw new Error(`Unknown item '${name}'. Close matches: ${close.join(', ') || 'none'}`);
  }
  return item;
}

/** Find an inventory item by name, throws listing what IS held if missing. */
export function inventoryItem(bot: Bot, name: string) {
  const item = bot.inventory.items().find((i) => i.name === name.toLowerCase());
  if (!item) {
    const held = bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', ');
    throw new Error(`No '${name}' in inventory. Holding: ${held || 'nothing'}`);
  }
  return item;
}

/**
 * Walk into interaction range of a position if not already there.
 * The pattern behind nearly every tool: blocks are right-clickable within
 * ~4.5 blocks, entities within ~3 — pathfind only when outside that, and stop
 * a little short (`range`) so the bot doesn't stand IN the target.
 */
export async function approach(
  bot: Bot,
  pos: { x: number; y: number; z: number },
  opts: { within?: number; range?: number } = {},
): Promise<void> {
  const within = opts.within ?? 4.5;
  const range = opts.range ?? 3;
  if (bot.entity.position.distanceTo(vec(pos)) > within) {
    // Bounded, like every other walk: an unreachable chest used to hang the mind
    // for as long as the pathfinder felt like re-planning. The refusal becomes
    // this caller's error, so the tool says 'could not reach' instead of nothing.
    const r = await walkTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), pos);
    // Every non-arrival is this caller's error — including the two arbitration
    // outcomes (issue #22). A tool that interacts anyway would be reaching for a
    // chest it never walked to.
    if (/^(COULD NOT REACH|LEGS BUSY|PATH CANCELLED)/.test(r)) throw new Error(r);
  }
}

/** approach() tuned for entities: melee/interact reach is ~3, stop at 2. */
export function approachEntity(bot: Bot, e: Entity): Promise<void> {
  return approach(bot, e.position, { within: 3, range: 2 });
}

/**
 * Place `item` at an exact position: finds a solid neighbor to click against,
 * walks into range, equips, places. The one placement path shared by
 * place_block and build_blueprint — a placement bug gets fixed once.
 * Throws with a reason ('occupied by X', 'no solid neighbor', …).
 */
export async function placeAt(bot: Bot, item: string, pos: { x: number; y: number; z: number }): Promise<{ late: boolean; attempts: number }> {
  const invItem = inventoryItem(bot, item);
  const targetPos = vec(pos);
  const existing = bot.blockAt(targetPos);
  if (existing && existing.name !== 'air' && existing.name !== 'water' && existing.name !== 'lava')
    throw new Error(`${fmtPos(pos)} is occupied by ${existing.name}.`);

  // find an adjacent solid block to click against
  const faces = [
    new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
  ];
  let ref: Block | null = null; let face: Vec3 | null = null;
  for (const f of faces) {
    const b = bot.blockAt(targetPos.plus(f));
    if (b && b.boundingBox === 'block') { ref = b; face = f.scaled(-1); break; }
  }
  if (!ref || !face) throw new Error(`No solid neighbor to place against at ${fmtPos(pos)}.`);

  await approach(bot, pos);
  await bot.equip(invItem, 'hand');
  return commitPlacement(bot, item, targetPos, ref, face);
}

/** The minimum a placement needs from a bot — so the commit is testable. */
export interface PlacerBot {
  placeBlock: (ref: Block, face: Vec3) => Promise<void>;
  blockAt: (p: Vec3) => { name: string } | null;
}

/**
 * Click the block into the world, then LOOK at the world before speaking.
 *
 * `bot.placeBlock` resolves on a `blockUpdate` packet and throws "Event
 * blockUpdate did not fire within timeout of 5000ms" when it is late — which says
 * nothing about whether the block is there. Under night-mob server lag the soak
 * spent three model turns placing one chest (issue #27), each failure indicating
 * only that a packet had not arrived. Sometimes the block IS placed and the
 * timeout is a lie in the other direction.
 *
 * So: on a timeout, look. If the block is standing, the placement worked and the
 * confirmation was merely late. If the target is still air, retry once in-process
 * — a wasted round trip to the model costs far more than a second here — and only
 * then report failure, in terms of what was OBSERVED rather than what was awaited.
 * Errors that are not timeouts (occupied, out of range) are the truth already and
 * are re-thrown untouched.
 */
export async function commitPlacement(
  bot: PlacerBot,
  item: string,
  target: Vec3,
  ref: Block,
  face: Vec3,
  o: { attempts?: number; settleMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ late: boolean; attempts: number }> {
  const attempts = o.attempts ?? 2;
  const settleMs = o.settleMs ?? 300;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const standing = () => {
    const b = bot.blockAt(target);
    return !!b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air';
  };

  let last: Error | undefined;
  let phantom = false;
  for (let i = 1; i <= attempts; i++) {
    try {
      await bot.placeBlock(ref, face);
      // A RESOLVED placeBlock is not a placed block (issue #48): mineflayer
      // resolves on the next blockUpdate at the target, and the server reverting
      // our optimistic block to air IS a blockUpdate at the target. So look.
      if (standing()) return { late: false, attempts: i };
      await sleep(settleMs);
      if (standing()) return { late: true, attempts: i };
      phantom = true;
      last = new Error('the server confirmed an update at the target, and the update was air');
      continue;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!/did not fire within timeout|Event blockUpdate/i.test(e.message)) throw e;
      last = e;
      await sleep(settleMs);
      if (standing()) return { late: true, attempts: i };
    }
  }
  const observed = bot.blockAt(target)?.name ?? 'unloaded';
  throw new Error(
    `${item} was NOT placed at ${fmtPos(target)} after ${attempts} attempts — the target is still ${observed}, ` +
      `so the ${item} is still in your inventory and nothing was lost. ` +
      (phantom
        ? `The place call RESOLVED — mineflayer waits for any block update at the target, and the update was the `
          + `server putting air back, so "placed" would have been this client's own click. `
        : `The server never confirmed the placement (${last?.message ?? 'timeout'}), which under lag usually means `
          + `the click was rejected. `) +
      `Check the spot is reachable and has a solid neighbor, or place somewhere else.`,
  );
}

/**
 * ⛏️ Issue #48 — did the block actually break?
 *
 * `bot.dig` resolves on a blockUpdate at the target, and the server refusing the
 * break (wrong tool progress, protected region, a stale window) produces a
 * blockUpdate at the target too: the block reappearing. `dug++` on a resolved
 * promise therefore counts breaks that never happened, and a bag delta of
 * 'nothing' then reads as "the drop is on the ground" — an invented cause for a
 * block that is still standing. So look, hold, look again.
 */
export async function confirmBroken(
  bot: { blockAt: (p: Vec3) => { name: string } | null },
  target: Vec3,
  was: string,
  o: { settleMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gone = () => bot.blockAt(target)?.name !== was;
  if (gone()) return true;
  await sleep(o.settleMs ?? 300);
  return gone();
}

/**
 * Poll a predicate until it holds or the budget runs out. Returns whether it
 * became true — never throws, because "it did not happen" is often the answer a
 * tool needs to REPORT rather than raise.
 */
export async function waitFor(
  cond: () => boolean,
  budgetMs: number,
  o: { stepMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const stepMs = o.stepMs ?? 100;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

/**
 * 🪤 Issue #48 — a settled read-back: the number the SERVER agreed to, not the
 * one the client drew for itself.
 *
 * `bot.toss` / window clicks are OPTIMISTIC in mineflayer: the click mutates the
 * local `bot.inventory` mirror the instant it is sent, then the server may reject
 * it and push the old slot straight back. So re-reading the bag right after the
 * await is NOT a read-back at all — it reads our own intent, one frame later.
 * That is how `toss` reported success AND volunteered "you still hold 0" for a
 * stone_sword that sat in slot 42 the whole time (soak26): the fix of 2026-08-18
 * counted the bag, but counted it before the rollback arrived.
 *
 * So: wait for the change to appear (up to `budgetMs`), then HOLD — keep reading
 * across `holdMs` and take the LAST value. A rollback lands inside that window
 * and turns a false success into an honest failure. Returns what was measured;
 * the caller decides what to say, and never volunteers a number this did not
 * produce.
 */
export async function settledRead(
  read: () => number,
  before: number,
  o: { budgetMs?: number; holdMs?: number; stepMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ after: number; changed: boolean; rolledBack: boolean; peak: number }> {
  const stepMs = o.stepMs ?? 100;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await waitFor(() => read() !== before, o.budgetMs ?? 1_000, { stepMs, sleep });
  let peak = read();
  const holdMs = o.holdMs ?? 600;
  for (let waited = 0; waited < holdMs; waited += stepMs) {
    await sleep(stepMs);
    const now = read();
    if (Math.abs(now - before) > Math.abs(peak - before)) peak = now;
  }
  const after = read();
  return { after, changed: after !== before, rolledBack: after === before && peak !== before, peak };
}

/** What is actually IN an equipment slot right now, by the server's last word. */
export interface EquipReader {
  getEquipmentDestSlot: (dest: string) => number;
  inventory: { slots: ({ name?: string } | null)[] };
  heldItem: { name?: string } | null;
}

export function equippedName(bot: EquipReader, destination: string): string | null {
  if (destination === 'hand') return bot.heldItem?.name ?? null;
  const slot = bot.getEquipmentDestSlot(destination);
  return bot.inventory.slots[slot]?.name ?? null;
}

/**
 * Confirm an equip by LOOKING at the slot, because equipping is a window click.
 *
 * On 1.21.5+ a click can be dropped without a word (mineflayer#3906 — the same
 * family craft-verify.ts handles), and `bot.equip` resolves on the local model, so
 * "Equipped iron_leggings to legs" is a claim about intent, not about the bot. The
 * tell was in the soak's own journey goal: the operator had written
 * "…and equip it (verify list_inventory armor.legs no longer 'empty')" — a human
 * working around a tool that could not be believed.
 *
 * Armor also has a rule of its own: the server moves a helmet to the head slot when
 * you click it, so a wrong-slot request looks like nothing happening at all.
 */
export async function verifyEquip(
  bot: EquipReader,
  item: string,
  destination: string,
  o: { tries?: number; settleMs?: number; holdMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ late: boolean }> {
  const tries = o.tries ?? 4;
  const settleMs = o.settleMs ?? 200;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const want = item.toLowerCase();
  // Issue #48: the slot showing the item is ALSO what a rejected click looks
  // like for one round-trip, so a match has to survive a hold before it is a
  // fact. `slipped` remembers that we nearly claimed it — the honest failure
  // below then explains why the bot "saw" the armour it is not wearing.
  const holdSlot = async () => {
    for (let waited = 0; waited < (o.holdMs ?? 600); waited += settleMs) await sleep(settleMs);
    return equippedName(bot, destination) === want;
  };
  let slipped = false;

  for (let i = 0; i < tries; i++) {
    if (equippedName(bot, destination) === want) {
      if (await holdSlot()) return { late: i > 0 };
      slipped = true;
    }
    await sleep(settleMs);
  }
  const now = equippedName(bot, destination);
  throw new Error(
    `${item} is NOT in your ${destination} slot — it still holds ${now ?? 'nothing'}. The click was not accepted ` +
      `(known 1.21.5+ window desync), so the ${item} is still in your inventory, unlost. ` +
      (slipped
        ? `The slot did show ${item} for a moment — that was this client's own click, and the server put it back. `
        : '') +
      `Retry once; if it fails again, open and close a container to force an inventory resync, then retry.`,
  );
}

/** Resolve an entity by numeric id, username, or entity-type name (nearest wins). */
export function resolveEntity(bot: Bot, ref: string): Entity {
  const asId = Number(ref);
  if (!Number.isNaN(asId) && bot.entities[asId]) return bot.entities[asId];

  const byUser = Object.values(bot.entities).find((e) => e.username === ref);
  if (byUser) return byUser;

  const matches = Object.values(bot.entities)
    .filter((e) => !!e?.position && e.id !== bot.entity.id && (e.name === ref.toLowerCase() || e.username === ref))
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
  if (matches[0]) return matches[0];

  const nearby = Object.values(bot.entities)
    .filter((e) => !!e?.position && e.id !== bot.entity.id && bot.entity.position.distanceTo(e.position) < 32)
    .map((e) => e.name ?? e.username)
    .filter(Boolean);
  throw new Error(`No entity '${ref}' nearby. Visible: ${[...new Set(nearby)].join(', ') || 'none'}`);
}

/**
 * ⚠️ What goes wrong if this block disappears? The classic bot deaths are
 * self-inflicted: dig into lava and swim in it, release a gravel column onto
 * your own head, mine the block you stand on over a drop. Pure function over
 * a block-lookup so tests can hand it a fake world; dig tools call it and
 * REFUSE with the hazard named — force:true overrides, so the agent decides
 * with information instead of dying without it.
 *
 * Checks (world truth, all local chunk reads):
 *  - LIQUID BEHIND: any horizontal neighbor or the block above is lava/water
 *    → it pours into the freed space (lava = death, water = drops washed away).
 *    The block BELOW being liquid is only flagged for lava: a water floor is
 *    usually just wet feet.
 *  - FALLING COLUMN: gravel/sand/concrete_powder directly above → it lands on
 *    your head (suffocation for a tall column, at best a wasted dig).
 *  - SELF-SUPPORT: the target is the block under the digger's own feet, and
 *    what's under IT is air/liquid → you fall with the block.
 */
export function digHazards(
  target: { x: number; y: number; z: number },
  blockNameAt: (x: number, y: number, z: number) => string | undefined,
  feet?: { x: number; y: number; z: number },
): string[] {
  const hazards: string[] = [];
  const lava = (n?: string) => n === 'lava' || n === 'flowing_lava';
  const water = (n?: string) => n === 'water' || n === 'flowing_water';
  const falling = (n?: string) => !!n && (n === 'gravel' || n === 'sand' || n === 'red_sand' || n.endsWith('concrete_powder'));

  const above = blockNameAt(target.x, target.y + 1, target.z);
  const below = blockNameAt(target.x, target.y - 1, target.z);
  const sides = [
    blockNameAt(target.x + 1, target.y, target.z), blockNameAt(target.x - 1, target.y, target.z),
    blockNameAt(target.x, target.y, target.z + 1), blockNameAt(target.x, target.y, target.z - 1),
  ];
  if ([above, ...sides].some(lava) || lava(below)) hazards.push('LAVA is adjacent — it will pour into the hole (fatal)');
  else if ([above, ...sides].some(water)) hazards.push('water is adjacent — it will flood the hole and wash drops away');
  if (falling(above)) {
    // Count the column so the message conveys how bad it is.
    let n = 0;
    while (n < 30 && falling(blockNameAt(target.x, target.y + 1 + n, target.z))) n++;
    hazards.push(`${n} falling block(s) (${above}) directly above — they drop when this block goes`);
  }
  if (feet && Math.floor(feet.x) === target.x && Math.floor(feet.z) === target.z && Math.floor(feet.y) - 1 === target.y) {
    const under = blockNameAt(target.x, target.y - 1, target.z);
    if (!under || under === 'air' || under === 'cave_air' || lava(under) || water(under))
      hazards.push(`you are STANDING on this block with ${under ?? 'unloaded chunk'} below it — you fall with it`);
  }
  return hazards;
}

/**
 * 🔦 Where can hostiles spawn near here? Pure survey over a block probe so
 * tests hand it a fake world. A spot is dark-spawnable when: the block and
 * the one above it are empty (standing room, not liquid), the block below
 * has a solid top to stand on, and BLOCK light is 0 — the modern (1.18+)
 * hostile-spawn rule; sky light doesn't save you at night, so block light
 * is the only number worth patrolling.
 *
 * Also plans the fix: a greedy torch cover — repeatedly take the dark spot
 * whose torch would darken-proof the most other spots within Manhattan
 * distance 5 (a torch emits 14 and spawns need 0, but walls eat light, so
 * 5 is deliberately conservative), until every spot is covered.
 */
/** What one probed cell tells the survey. `luminance` is the block's OWN
 *  emitted light from the registry (torch 14, lantern/glowstone 15, campfire
 *  15, lava 15) — registry truth, not a light packet, which is the only
 *  light fact we can rely on (see darknessSurveyImpl). */
export interface DarkCell { empty: boolean; solid: boolean; blockLight: number; luminance?: number }

export interface DarknessReport {
  spots: Array<{ x: number; y: number; z: number }>;
  torches: Array<{ x: number; y: number; z: number }>;
  capped: boolean;
  /** Light sources actually SEEN in the volume (registry luminance > 0). */
  lights: Array<{ x: number; y: number; z: number; luminance: number }>;
  /** Spots dropped because a light source we can see already covers them. */
  coveredByExisting: number;
  /** True when light sources exist but every cell still reads blockLight 0 —
   *  the server's light data is not reaching us and `spots` is an estimate. */
  lightDataSuspect: boolean;
}

export function darknessSurvey(
  center: { x: number; y: number; z: number },
  radius: number,
  probe: (x: number, y: number, z: number) => DarkCell | undefined,
  yRange = 4,
  opts: { maxSpots?: number; breathe?: () => Promise<void> } = {},
): Promise<DarknessReport> {
  return darknessSurveyImpl(center, radius, probe, yRange, opts);
}

/** Work bound + event-loop fairness (issue #4): the old greedy cover
 *  re-filtered EVERY remaining spot per pick — O(n²) per torch over up to
 *  ~16k spots (radius 24 × yRange 4), ~1e8 synchronous ops that starved the
 *  300ms reflex tick (lava/creeper safety goes deaf) and the MJPEG loop.
 *  Now: (1) the scan stops at maxSpots (default 600) and says so via
 *  `capped`; (2) neighbor sets come from a spatial hash (cell = cover
 *  radius), computed once — greedy picks touch only actual neighbors;
 *  (3) `breathe` (the tool passes setImmediate) is awaited between scan
 *  chunks and greedy picks, so reflexes keep their tick even mid-survey.
 *
 *  TRUTH problem (live soak, 2026-08-17): the survey reported the SAME ~182
 *  dark spots run after run with a torch plan the bot had already executed,
 *  so it kept re-placing torches that were standing right there. Cause: the
 *  only darkness evidence was `block.light`, and on this server that field
 *  stays 0 — a placed torch never changes it, and a torch's OWN cell (empty
 *  boundingBox, light 0) even qualified as a spawnable dark spot, so the plan
 *  literally aimed at existing torches.
 *
 *  So light sources are now believed over light levels: a cell whose block
 *  EMITS light (registry luminance) is never a dark spot, spots within a
 *  seen light's reach are dropped as already covered, and when lights exist
 *  while every cell still reads 0 the report says `lightDataSuspect` instead
 *  of pretending the numbers mean something. */
async function darknessSurveyImpl(
  center: { x: number; y: number; z: number },
  radius: number,
  probe: (x: number, y: number, z: number) => DarkCell | undefined,
  yRange: number,
  { maxSpots = 600, breathe }: { maxSpots?: number; breathe?: () => Promise<void> },
): Promise<DarknessReport> {
  const COVER = 5; // torch cover radius (Manhattan) — see doc block above
  const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
  const raw: Array<{ x: number; y: number; z: number }> = [];
  const lights: Array<{ x: number; y: number; z: number; luminance: number }> = [];
  let maxBlockLight = 0;
  let capped = false;
  let columns = 0;
  scan: for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (dx * dx + dz * dz > radius * radius) continue; // circular scan, not square corners
    if (breathe && ++columns % 64 === 0) await breathe();
    for (let dy = -yRange; dy <= yRange; dy++) {
      const x = cx + dx, y = cy + dy, z = cz + dz;
      const at = probe(x, y, z);
      if (!at) continue;
      if (at.blockLight > maxBlockLight) maxBlockLight = at.blockLight;
      // A block that emits light is a fact about the world, unlike the light
      // level: record it, and never call its own cell dark.
      if (at.luminance && at.luminance > 0) {
        lights.push({ x, y, z, luminance: at.luminance });
        continue;
      }
      if (!at.empty || at.blockLight > 0) continue;
      const head = probe(x, y + 1, z);
      const floor = probe(x, y - 1, z);
      if (head?.empty && floor?.solid) {
        raw.push({ x, y, z });
        if (raw.length >= maxSpots) { capped = true; break scan; }
      }
    }
  }

  // Credit the torches that already exist. A light of luminance L is given
  // the same reach the planner assumes for the torches it proposes (capped at
  // COVER), so "already lit" and "will be lit by my plan" mean the same thing
  // — the alternative is a plan that re-places what is already burning.
  const reachOf = (l: { luminance: number }) => Math.max(0, Math.min(COVER, l.luminance - 1));
  const spots = lights.length
    ? raw.filter((s) => !lights.some((l) =>
      Math.abs(l.x - s.x) + Math.abs(l.y - s.y) + Math.abs(l.z - s.z) <= reachOf(l)))
    : raw;
  const coveredByExisting = raw.length - spots.length;
  // Lights standing in the volume but not one lit cell anywhere: the server's
  // light data is not reaching this client, so `spots` is an estimate from
  // geometry alone and the tool must say so rather than sound certain.
  const lightDataSuspect = lights.length > 0 && maxBlockLight === 0;

  // Greedy cover over precomputed neighbor lists. Spatial hash with cell
  // size = COVER: all Manhattan-≤COVER neighbors live in the 27 cells around
  // a spot, so building the lists is O(n·k) instead of O(n²) filters.
  const cellOf = (s: { x: number; y: number; z: number }) =>
    `${Math.floor(s.x / COVER)},${Math.floor(s.y / COVER)},${Math.floor(s.z / COVER)}`;
  const cells = new Map<string, number[]>();
  spots.forEach((s, i) => {
    const k = cellOf(s);
    const arr = cells.get(k);
    if (arr) arr.push(i); else cells.set(k, [i]);
  });
  const nbr: number[][] = spots.map((s, i) => {
    const out: number[] = [];
    const bx = Math.floor(s.x / COVER), by = Math.floor(s.y / COVER), bz = Math.floor(s.z / COVER);
    for (let ax = bx - 1; ax <= bx + 1; ax++) for (let ay = by - 1; ay <= by + 1; ay++) for (let az = bz - 1; az <= bz + 1; az++) {
      for (const j of cells.get(`${ax},${ay},${az}`) ?? []) {
        const o = spots[j];
        if (Math.abs(o.x - s.x) + Math.abs(o.y - s.y) + Math.abs(o.z - s.z) <= COVER) out.push(j);
      }
    }
    return out; // includes i itself — a torch covers its own spot
  });

  const torches: Array<{ x: number; y: number; z: number }> = [];
  const alive = new Array<boolean>(spots.length).fill(true);
  let remaining = spots.length;
  let picks = 0;
  while (remaining > 0) {
    if (breathe && ++picks % 8 === 0) await breathe();
    let best = -1, bestCount = -1;
    for (let i = 0; i < spots.length; i++) {
      if (!alive[i]) continue;
      let count = 0;
      for (const j of nbr[i]) if (alive[j]) count++;
      if (count > bestCount) { best = i; bestCount = count; }
    }
    torches.push(spots[best]);
    for (const j of nbr[best]) if (alive[j]) { alive[j] = false; remaining--; }
  }
  return { spots, torches, capped, lights, coveredByExisting, lightDataSuspect };
}

/**
 * 🧱 Is the bot actually STUCK — or just standing still doing useful work?
 *
 * "No position change for 20s with a goal set" is the normal signature of
 * productive stationary work: digging a 1×1 staircase shaft, working a
 * furnace/container window, eating. The unstuck reflex once treated that as
 * wedged and jogged the bot 5 blocks off its own mineshaft every 20s — and
 * the journal blamed 'the journey loop', poisoning the supervisor's verdict
 * (issue #8). Pure over signals so tests replay the incident exactly.
 *
 * Verdict ladder:
 *  - 'none'  — not stuck: no goal, or deliberately stationary (digging /
 *              window open / using an item), or something concrete was
 *              accomplished recently (a dig completed, an item collected).
 *  - 'note'  — genuinely wedged, but the MIND is mid-turn: standing still is
 *              not lethal, so nothing is lost by asking first. Tell the
 *              model; never yank its pathfinder.
 *  - 'shake' — genuinely wedged with no deliberate work in flight (a stale
 *              or reflex-owned goal): safe to clear controls and jog loose
 *              without a model call. Genuine = the pathfinder itself said
 *              noPath/timeout recently, or the body has been frozen a full
 *              window with zero progress signals.
 */
export type StuckAction = 'none' | 'note' | 'shake';
export interface StuckSignals {
  /** ms since the body last moved >2 blocks */
  frozenMs: number;
  hasGoal: boolean;
  /** bot.targetDigBlock — actively mining */
  digging: boolean;
  /** bot.currentWindow — furnace/chest/crafting UI open */
  windowOpen: boolean;
  /** bot.usingHeldItem — eating, drawing a bow, holding a shield */
  usingItem: boolean;
  /** ms since the last progress signal (dig completed, item collected) */
  progressMs: number;
  /** ms since pathfinder reported noPath/timeout (Infinity = never) */
  noPathMs: number;
  /** is the mind mid-turn (live request or journey step)? */
  deliberateBusy: boolean;
  /** head underwater right now: stillness here is not work, it is drowning */
  drowning?: boolean;
}
/**
 * 🔇 Is a stuck NOTE actually due, or would it be spam?
 *
 * `stuckVerdict` answers "is the body wedged?" every cooldown — which for a
 * body that stays wedged is true forever. The live soak (2026-08-17) caught
 * the consequence: 22 identical `(reflex) You have been stationary 20s…`
 * notes inside ONE long turn, ~one every 20s, because the note path reset the
 * anchor and the very same episode re-armed itself immediately. A note the
 * model has already been told is not information, it is context budget.
 *
 * So notes are gated per EPISODE: the first one fires immediately, and a
 * repeat only after an exponentially growing backoff (2min, 4min, 8min… capped)
 * — the caller ends the episode (notes back to 0) the moment REAL progress
 * shows up, which is the only thing that makes the note newsworthy again.
 * Pure so a test can replay the 22-note storm without a bot.
 */
export function stuckNoteDue(
  s: {
    now: number; lastNotedAt: number; notesInEpisode: number;
    /** how long the body has been frozen right now */
    frozenMs?: number;
    /** how long it had been frozen when the LAST note went out */
    lastNotedFrozenMs?: number;
  },
  baseBackoffMs = 120_000,
  capMs = 600_000,
  /** floor between ANY two notes, even across episodes — see below */
  minGapMs = 60_000,
): boolean {
  // Episodes end on real progress, and a body that inches forward and re-wedges
  // (fishing at a shoreline: a slot change every few seconds, then 20s frozen)
  // would otherwise open a brand-new episode every cooldown and spam again with
  // an honest '1x this episode' each time. Observed live right after the first
  // fix: two notes 20s apart, both claiming to be the first. Hence a floor.
  if (s.lastNotedAt && s.now - s.lastNotedAt < minGapMs) return false;
  if (s.notesInEpisode <= 0) return true; // first note of this episode
  // A repeat has to carry NEWS. Live soak 2026-08-18 (issue #19): 27 notes, the
  // frozen duration climbing 20s → 286s, and 22 of them to workers that went on
  // to finish their task — "still stationary, a bit longer now" tells the model
  // nothing it was not already told, at ~40 tokens a copy, delivered while it
  // was mid-turn and could not act anyway. Half again as long is news; another
  // ten seconds is not.
  const grown = s.frozenMs === undefined || s.lastNotedFrozenMs === undefined
    || s.frozenMs >= s.lastNotedFrozenMs * 1.5;
  if (!grown) return false;
  const wait = Math.min(baseBackoffMs * 2 ** (s.notesInEpisode - 1), capMs);
  return s.now - s.lastNotedAt >= wait;
}

/**
 * 🧱 The identity of a WEDGE — the thing that must survive a twitch.
 *
 * The old episode was "the body stayed within 2 blocks of an anchor": one step
 * out of that circle (a mob shove, a flee, the model re-issuing a walk that
 * moves 3 blocks and re-jams) ended the episode and zeroed the warning count.
 * /tmp/mc-soak36.log is the proof — 13 `[unstuck]` lines, ELEVEN of them
 * "warning 1 of this wedge", frozen durations bouncing 66s → 46s → 47s → 184s
 * → 57s → 134s (a monotonic clock cannot go backwards, so the episode was
 * being restarted between notes). Escalation was therefore unreachable: a
 * three-minute wedge was reported forever as somebody's first bad minute, the
 * mode never earned the right to act, and one of those bots stood there at
 * 9/20 HP for 184 seconds.
 *
 * So identity moves from "one continuous freeze" to a PLACE: a coarse cell of
 * the world (6 blocks — wider than the 2-block anchor, narrow enough that a
 * real route change lands in a different cell) plus a rejoin window. Come back
 * to the same cell within the window and it is the SAME wedge, warning number
 * intact, however many times the body twitched in between.
 */
export type WedgeMemory = {
  /** coarse cell of the world the warnings belong to */
  key: string;
  /** when the body first jammed here */
  firstAt: number;
  /** last tick that saw it jammed here */
  lastAt: number;
  /** how many warnings the MIND has had about this place */
  warnings: number;
  /** separate freeze episodes at this place */
  episodes: number;
  /** how many times the reflex has taken the legs here */
  acts: number;
  /** when it last took them (0 = never) */
  lastActAt: number;
  /** longest single freeze seen here */
  worstFrozenMs: number;
};

/** Coarse cell of the world a wedge is remembered by. Mechanism, so no knob. */
export function wedgeSiteKey(p: { x: number; y: number; z: number }, coarse = 6): string {
  const c = (n: number) => Math.floor(n / coarse);
  return `${c(p.x)},${c(p.y)},${c(p.z)}`;
}

/**
 * Fold one sighting of a wedge into the memory. `newEpisode` means the freeze
 * clock just restarted (the body moved out of the anchor circle and re-jammed):
 * the episode count grows, the warning count does NOT — that is the whole point.
 */
export function wedgeSee(
  prev: WedgeMemory | undefined,
  s: { now: number; key: string; frozenMs: number; newEpisode?: boolean },
  rejoinMs = 300_000,
): WedgeMemory {
  const rejoins = prev && prev.key === s.key && s.now - prev.lastAt <= rejoinMs;
  if (!rejoins) {
    return {
      key: s.key,
      firstAt: s.now - s.frozenMs,
      lastAt: s.now,
      warnings: 0,
      episodes: 1,
      acts: 0,
      lastActAt: 0,
      worstFrozenMs: s.frozenMs,
    };
  }
  return {
    ...prev,
    lastAt: s.now,
    episodes: prev.episodes + (s.newEpisode ? 1 : 0),
    worstFrozenMs: Math.max(prev.worstFrozenMs, s.frozenMs),
  };
}

/**
 * 🪓 When does a warning earn the right to ACT?
 *
 * `stuckVerdict` returns 'note' instead of 'shake' whenever the mind is
 * mid-turn, on the reasoning that standing still is not lethal. Soak36 shows
 * the flaw: the mind is mid-turn almost continuously under a journey, so
 * 'note' is not a first step, it is the whole life of the wedge. Past a
 * threshold the body may free itself even while the mind holds the legs —
 * and must SAY that it did (see the caller), never erase a claim silently.
 */
export function wedgeEscalation(
  w: WedgeMemory,
  s: { now: number; frozenMs: number },
  cfg: { actAfterWarnings: number; actAfterMs: number; actGapMs: number },
): 'note' | 'act' {
  if (w.lastActAt && s.now - w.lastActAt < cfg.actGapMs) return 'note';
  const heldMs = s.now - w.firstAt;
  const earned = w.warnings + 1 >= cfg.actAfterWarnings
    || heldMs >= cfg.actAfterMs
    || s.frozenMs >= cfg.actAfterMs;
  return earned ? 'act' : 'note';
}

/** How long this wedge has owned the body, in words a note can carry. */
export function wedgeAge(w: WedgeMemory, now: number): string {
  const s = Math.max(0, Math.round((now - w.firstAt) / 1000));
  return s >= 120 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/**
 * The site half of the wedge sentence: a place, a count, and a CONSEQUENCE.
 * "3rd warning" is a noun; "you have not moved out of this 6-block cell in
 * 4m12s across 3 attempts" is a reason to change the plan.
 */
export function wedgeSiteFact(w: WedgeMemory, now: number, at: string): string {
  if (w.warnings + w.acts === 0) return '';
  const parts = [`This is the same wedge as before: ${at} has held the body for ${wedgeAge(w, now)}`];
  if (w.episodes > 1) parts.push(`across ${w.episodes} attempts to leave`);
  if (w.acts > 0) parts.push(`and the unstuck reflex has already jogged the body free here ${w.acts}x without the route changing`);
  return `${parts.join(' ')} — the route, not the effort, is what is wrong.`;
}

/**
 * 📣 What to actually SAY about a wedge, given how many times we have said it.
 *
 * The old note was the same 40-token paragraph every time — "possibly wedged
 * (fence, corner, misjudged jump). Re-issue your movement…" — even on the fifth
 * telling, when re-issuing movement was demonstrably the thing that was not
 * working. The escalation branch existed but was dead code (the episode counter
 * was zeroed on any progress since the last note, so every note claimed to be
 * the first), which is issue #19 in one line.
 *
 * Pure so the wording is testable: the model's input deserves the same
 * treatment as the model's output.
 */
export function stuckAdvice(notesSoFar: number, frozenS: number): string {
  const nth = notesSoFar + 1;
  if (nth === 1) {
    return `(reflex) You have been stationary ${frozenS}s with an active pathfinder goal and no progress — possibly wedged (fence, corner, misjudged jump). Re-issue your movement, path around, or stop_moving and re-plan.`;
  }
  if (nth === 2) {
    return `(reflex) Still stationary — ${frozenS}s now, 2nd warning. Whatever is holding you has not moved: stop_moving, then either dig through it or pick a target you can actually reach.`;
  }
  return `(reflex) ${nth}th warning in one wedge: ${frozenS}s stationary with a live goal. Re-issuing the same movement is not working. Abandon this target — stop_moving, look_around, and choose a different route or a different goal. If a journey step keeps retrying this, stop the journey.`;
}

export function stuckVerdict(s: StuckSignals, afterMs = 20_000): StuckAction {
  if (!s.hasGoal) return 'none';
  // Treading water is the one stillness that cannot be productive. Live soak
  // 2026-08-17: a 3.5-HP bot pathing across a lake sat frozen in deep water for
  // five minutes — pathfinder goal alive, drowning reflex bailing it out every
  // few seconds, journey step 1 never finishing — while unstuck politely NOTED
  // it because the mind was busy. Digging underwater is real work, so the dig
  // exemption still wins; everything else yields to getting out of the water.
  if (s.drowning && !s.digging && s.frozenMs >= afterMs / 4) return 'shake';
  if (s.digging || s.windowOpen || s.usingItem) return 'none'; // stationary ≠ stuck
  if (s.progressMs < afterMs) return 'none'; // still producing results
  // noPath is strong evidence, but only about a body that is actually still:
  // a flee reflex resets the anchor while a stale noPath from the interrupted
  // goal is seconds old — without a stillness floor that fired 'stationary 0s'
  // notes at a bot in full sprint (live soak, 2026-08-17).
  const genuine = (s.noPathMs < afterMs && s.frozenMs >= afterMs / 4) || s.frozenMs >= afterMs;
  if (!genuine) return 'none';
  return s.deliberateBusy ? 'note' : 'shake';
}

/**
 * 🌲 Turn a species-specific missing-materials list into gatherable advice.
 *
 * Recipe variants are species-specific (cherry_planks, birch_log…) but the
 * FOREST is not: any log crafts planks, any planks craft sticks/tables. A
 * missing report that names one species sends the agent on a doomed
 * cherry-tree pilgrimage past perfectly good oaks (live bug: 'gather 1x
 * cherry_log' to a bot standing in a birch forest). Pure over the name list
 * so tests hand it maps. Wood families are collapsed to 'any log' / 'any
 * planks'; everything else (iron_ingot, string, …) passes through untouched —
 * those really are that specific.
 */
export function describeMissing(missing: Map<string, number>): string[] {
  const isLog = (n: string) => n.endsWith('_log') || n.endsWith('_stem') || n === 'bamboo_block';
  const isPlanks = (n: string) => n.endsWith('_planks');
  let logs = 0;
  let planks = 0;
  const rest: string[] = [];
  for (const [name, count] of missing) {
    if (isLog(name)) logs += count;
    else if (isPlanks(name)) planks += count;
    else rest.push(`${count}x ${name}`);
  }
  const out: string[] = [];
  if (planks > 0) out.push(`${planks}x planks — ANY wood works (1 log crafts 4 planks)`);
  if (logs > 0) out.push(`${logs}x logs — ANY tree works: chop the NEAREST one (oak, birch, spruce, jungle… all fine; find_blocks 'oak_log,birch_log,spruce_log,jungle_log,acacia_log,dark_oak_log,cherry_log,mangrove_log')`);
  return [...out, ...rest];
}

/**
 * ⚔️ MELEE DAMAGE, derived — not a list of items someone remembered.
 *
 * minecraft-data carries NO attackDamage for items (checked: iron_sword has
 * id/name/displayName/stackSize/repairWith/maxDurability and nothing else), so
 * the damage table has to live here. It is expressed the way the GAME expresses
 * it — a FAMILY (sword/axe/trident/mace/shovel/pickaxe/hoe) times a TIER
 * (wooden…netherite) — so a name we have never seen resolves by structure
 * instead of falling off a hand-written enum. Anything that parses to no family
 * (dirt, torch, bread, a bucket) is NOT a weapon and scores below a fist.
 *
 * Issue: a soak had the body `swung 1x at the phantom 3.9m away with dirt`. The
 * old picker returned undefined for "nothing better than a fist", the caller
 * then left whatever digging had put in the hand, and the narration promoted a
 * block to a weapon. A dirt block hits for exactly the same 1 as a fist, so
 * that swing was never an upgrade — only the sentence was.
 */
const MELEE_TIER: Record<string, number> = {
  wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4,
};

/** damage[family][tier] and the family's attack speed (attacks/second). */
const MELEE_FAMILY: Record<string, { damage: number[]; speed: number[] }> = {
  //                wood stone iron diamond netherite
  sword:   { damage: [4, 5, 6, 7, 8], speed: [1.6, 1.6, 1.6, 1.6, 1.6] },
  axe:     { damage: [7, 9, 9, 9, 10], speed: [0.8, 0.8, 0.9, 1.0, 1.0] },
  shovel:  { damage: [2.5, 3.5, 4.5, 5.5, 6.5], speed: [1.0, 1.0, 1.0, 1.0, 1.0] },
  pickaxe: { damage: [2, 3, 4, 5, 6], speed: [1.2, 1.2, 1.2, 1.2, 1.2] },
  hoe:     { damage: [1, 1, 1, 1, 1], speed: [1.0, 2.0, 3.0, 4.0, 4.0] },
};

/** Tierless weapons: their own damage and speed, no material prefix. */
const MELEE_SINGLETON: Record<string, { damage: number; speed: number }> = {
  trident: { damage: 9, speed: 1.1 },
  mace: { damage: 6, speed: 0.6 },
};

/** A bare fist: 1 damage, and the hand recharges fast enough to always be full. */
export const FIST = { damage: 1, speed: 4.0 } as const;

/**
 * The game's attack-charge curve: a swing thrown before the cooldown has
 * elapsed lands at a FRACTION of the item's damage —
 * `0.2 + 0.8 * (t/cooldown)²`, capped at full charge.
 *
 * This is why the picker cannot just sort by per-hit damage. On the body's
 * ~600ms swing cadence an iron_axe (9 damage, 0.9 attacks/s → 1111ms cooldown)
 * lands 43% of its damage = 3.9, while an iron_sword (6 damage, 625ms) lands
 * 94% = 5.6. Ranking by the raw 9 would have the body swing the weaker weapon
 * and call it the stronger one.
 */
export function chargeMultiplier(intervalMs: number, attacksPerSecond: number): number {
  const cooldownMs = 1000 / attacksPerSecond;
  const t = Math.min(1, Math.max(0, intervalMs / cooldownMs));
  return Math.min(1, 0.2 + 0.8 * t * t);
}

/** The family+tier an item name resolves to, or undefined if it is not melee gear. */
export function meleeKind(itemName: string): { family: string; tier: number } | undefined {
  const name = itemName.toLowerCase();
  if (MELEE_SINGLETON[name]) return { family: name, tier: 0 };
  const m = /^([a-z]+)_([a-z]+)$/.exec(name);
  if (!m) return undefined;
  const tier = MELEE_TIER[m[1]];
  if (tier === undefined || !MELEE_FAMILY[m[2]]) return undefined;
  return { family: m[2], tier };
}

/**
 * ⚔️ What one swing of this item is actually WORTH on a given swing cadence —
 * expected damage, charge included. A fist scores `chargeMultiplier * 1`; an
 * item that is not melee gear scores the same as the fist that is behind it
 * (holding it is neither better nor worse — but claiming it is a weapon is).
 */
export function meleeScore(itemName: string | undefined, intervalMs = 600): number {
  const fist = FIST.damage * chargeMultiplier(intervalMs, FIST.speed);
  if (!itemName) return fist;
  const single = MELEE_SINGLETON[itemName.toLowerCase()];
  if (single) return single.damage * chargeMultiplier(intervalMs, single.speed);
  const kind = meleeKind(itemName);
  if (!kind) return fist;
  const fam = MELEE_FAMILY[kind.family];
  return fam.damage[kind.tier] * chargeMultiplier(intervalMs, fam.speed[kind.tier]);
}

/** Is this item a melee weapon at all (rather than a block that happens to be in hand)? */
export function isMeleeWeapon(itemName: string | undefined, intervalMs = 600): boolean {
  if (!itemName) return false;
  return !!meleeKind(itemName) && meleeScore(itemName, intervalMs) > meleeScore(undefined, intervalMs);
}

/**
 * 🎯 Issue #45, second half: what a burst should DO about the current distance.
 *
 * Pure, because the reflex loop's own copy of this decision was made against a
 * distance read BEFORE `await bot.lookAt(...)` — an await that waits for a
 * rotation round-trip, during which a diving phantom crosses the whole gap. The
 * gate then swung on a reading that was already history, so the server dropped
 * the packet and the log still counted it. Callers must re-measure and call
 * this immediately before `bot.attack`.
 *
 *  - `break` — outside the trigger radius: this burst is over.
 *  - `hold`  — inside the trigger radius, outside striking distance: keep
 *              facing it and poll; a swing here is a packet the server drops.
 *  - `swing` — inside striking distance: the only case that may attack.
 */
export function swingVerdict(
  dist: number,
  reach: { swingReach: number; answerReach: number },
): 'break' | 'hold' | 'swing' {
  if (!Number.isFinite(dist) || dist > reach.answerReach) return 'break';
  if (dist > reach.swingReach) return 'hold';
  return 'swing';
}

/**
 * 📏 The distances swings ACTUALLY landed at, said honestly.
 *
 * The old narration printed the distance measured once at burst start, so a
 * soak reads `swung 2x at the phantom 4.0m away` — beyond the server's 3.0m
 * attack range, which is exactly the false conclusion #45 is about. Nobody
 * (mind or human) could tell a leaking gate from a lying sentence.
 */
export function swingRange(dists: number[]): string {
  if (!dists.length) return '';
  const lo = Math.min(...dists);
  const hi = Math.max(...dists);
  return lo.toFixed(1) === hi.toFixed(1) ? `${lo.toFixed(1)}m` : `${lo.toFixed(1)}-${hi.toFixed(1)}m`;
}

/**
 * ⚔️ vs 🔨 — the families the game BUILT to fight with. A pickaxe or a shovel
 * genuinely out-damages a fist, so `isMeleeWeapon` says yes and the body should
 * absolutely draw one; but "ARMED: iron_pickaxe" is a different claim, and #46
 * is about not letting the mind believe it is equipped when it is improvising.
 * So: score decides what the HAND holds, this decides what the SENTENCE claims.
 */
const WEAPON_FAMILIES = new Set(['sword', 'axe', 'trident', 'mace']);

/** Is this a weapon proper (sword/axe/trident/mace), not a repurposed tool? */
export function isProperWeapon(itemName: string | undefined): boolean {
  const kind = itemName ? meleeKind(itemName) : undefined;
  return !!kind && WEAPON_FAMILIES.has(kind.family);
}

/**
 * The strongest actual WEAPON in a bag — the one `armedFact` may promise, so
 * that "NO sword, axe or trident anywhere in your inventory" stays true when
 * all the bag holds is the pickaxe the bot was mining with.
 */
export function bestProperWeapon(itemNames: string[], intervalMs = 600): string | undefined {
  return bestMeleeWeapon(itemNames.filter(isProperWeapon), intervalMs);
}

/** The hotbar, in mineflayer's slot numbering: 36-44, selected by `quickBarSlot` 0-8. */
const HOTBAR_FIRST = 36;
const HOTBAR_SLOTS = 9;

/** One step toward getting the RIGHT thing into the hand. See {@link drawPlan}. */
export type DrawStep =
  /** Switch the selected hotbar slot. `item` undefined = an EMPTY slot, i.e. a real fist. */
  | { kind: 'quickbar'; slot: number; item?: string }
  /** The item is outside the hotbar: it needs a window click, which CAN be refused. */
  | { kind: 'window'; item: string }
  /** Nothing to switch to and the hand holds junk: ask the server to empty it. */
  | { kind: 'unequip'; item: string }
  /** The hand already agrees with the intent. */
  | { kind: 'none' };

/**
 * ⚔️➡️✋ How to get `want` into the hand — issue #50.
 *
 * The bot swung a stick, dirt, spruce_planks and a phantom_membrane through 7 of
 * 65 soak swings while a wooden_sword sat in the bag, and every one of those
 * lines said so out loud: `the wooden_sword draw was REFUSED — the hand still
 * holds dirt`. The narration was fixed (#49); the BEHAVIOUR was not, because the
 * draw was a single `bot.equip(item, 'hand')` fired before the burst and never
 * looked at again. `bot.equip` is a WINDOW CLICK: on 1.21.5+ the server may drop
 * it without a word (mineflayer#3906), and mineflayer paints it locally anyway,
 * so the promise resolving proves nothing (#48's lesson).
 *
 * The mechanism this reaches for instead: if the item is already ON the hotbar,
 * changing the selected slot is a HeldItemChange packet — no container window,
 * nothing for the server to reject, and it takes effect on the next tick. So a
 * draw is a window click ONLY when the weapon lives outside the hotbar.
 *
 * The same trick answers `the hand could not be emptied`: a fist is any EMPTY
 * hotbar slot, so the body does not need the server's permission to stop
 * swinging a block. It falls back to `unequip` only when all nine slots are
 * full.
 *
 * Pure: hand it the bag and the hand, it returns the next step. `want` undefined
 * means "nothing in the bag beats a fist, so empty the hand" — and a held item
 * is only junk when it scores no better than a fist, which is derived from
 * {@link meleeScore}, never from a list of block names.
 */
export function drawPlan(
  state: { held?: string; want?: string; items: { name: string; slot: number }[] },
  intervalMs = 600,
): DrawStep {
  const { held, want, items } = state;
  const onHotbar = (name: string) =>
    items.find((i) => i.name === name && i.slot >= HOTBAR_FIRST && i.slot < HOTBAR_FIRST + HOTBAR_SLOTS);

  if (want) {
    if (held === want) return { kind: 'none' };
    const there = onHotbar(want);
    if (there) return { kind: 'quickbar', slot: there.slot - HOTBAR_FIRST, item: want };
    return { kind: 'window', item: want };
  }
  // No weapon in the bag: the hand must not hold something WORSE than a fist,
  // and must not hold a block at all (a swing with a placeable is a placement
  // risk, and calling it a weapon is the lie #46 was about).
  if (!held) return { kind: 'none' };
  if (meleeScore(held, intervalMs) > meleeScore(undefined, intervalMs)) return { kind: 'none' };
  for (let s = 0; s < HOTBAR_SLOTS; s++) {
    if (!items.some((i) => i.slot === HOTBAR_FIRST + s)) return { kind: 'quickbar', slot: s };
  }
  return { kind: 'unequip', item: held };
}

/**
 * ⚔️ The strongest melee weapon in an inventory, scored by expected damage per
 * swing on the body's cadence. Pure over item names so tests hand it a bag.
 * Returns undefined when NOTHING in the bag beats a bare fist — which is a
 * decision, not a shrug: the caller must then make sure the hand is EMPTY
 * rather than leaving a dirt block in it and narrating that as a weapon.
 * Ties break toward the higher raw damage, then alphabetically, so the choice
 * is stable across soaks.
 */
export function bestMeleeWeapon(itemNames: string[], intervalMs = 600): string | undefined {
  const fist = meleeScore(undefined, intervalMs);
  let best: string | undefined;
  let bestScore = fist;
  for (const n of [...itemNames].sort()) {
    if (!meleeKind(n)) continue;
    const s = meleeScore(n, intervalMs);
    if (s > bestScore + 1e-9) { best = n; bestScore = s; }
  }
  return best;
}

/**
 * 🖐 How the hand should be NAMED in a narration, read off the live body.
 *
 * Three honest answers, never "with dirt" as if a block were gear:
 *  - empty hand → `fists`
 *  - a weapon   → its name
 *  - anything else → its name, flagged, with the arithmetic that makes it a
 *    non-upgrade ("dirt (NOT a weapon — 1 damage, same as a bare fist)").
 */
export function handNow(
  bot: { heldItem?: { name?: string } | null },
  intervalMs = 600,
): string {
  const held = bot.heldItem?.name;
  if (!held) return 'fists';
  if (isMeleeWeapon(held, intervalMs)) return held;
  return `${held} (NOT a weapon — ${FIST.damage} damage, same as a bare fist)`;
}

/**
 * 🤜 What the swings ACTUALLY went out with — issue #50, second half.
 *
 * The end-of-burst read (#49) was the right instrument for a draw fired ONCE
 * before the burst. With a per-swing retry it measures the wrong moment: soak31
 * showed `swung 2x … with cobblestone (the wooden_sword draw was REFUSED)` on a
 * burst whose hotbar switch had worked — the MINING rail put the cobblestone back
 * after the swings, and the sentence blamed the server for it.
 *
 * So the hand is sampled at every `bot.attack`, and this says what those samples
 * were. Ordered by first use, counted, so `wooden_sword x2, cobblestone x1` is a
 * fight the mind can reason about instead of one word that was true at the end.
 */
export function handsSummary(hands: (string | undefined)[], intervalMs = 600): string {
  if (!hands.length) return '';
  const counts = new Map<string, number>();
  for (const h of hands) {
    const key = h ?? 'fists';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, n]) => {
      const label = name === 'fists' ? 'fists' : handNow({ heldItem: { name } }, intervalMs);
      return counts.size > 1 || n > 1 ? `${label} x${n}` : label;
    })
    .join(', ');
}

/**
 * 🫳 Did another rail TAKE the weapon back out of the hand? — issue #50.
 *
 * Distinct from a refused draw, and the difference matters to the mind: a refusal
 * means the server said no and the weapon is still in the bag; a theft means the
 * draw WORKED and something else in this process (a walk placing scaffolding, a
 * dig picking its tool) selected another slot afterwards. Only the second one is
 * fixed by fighting for the hand instead of asking again.
 *
 * `used` is what the swings really went out with; `want` what was drawn.
 */
export function handTheft(
  used: (string | undefined)[],
  want: string | undefined,
  heldAtEnd: string | undefined,
): string {
  if (!want || !used.length) return '';
  if (!used.some((u) => u === want)) return '';
  const stolen = used.filter((u) => u !== want);
  if (!stolen.length && heldAtEnd === want) return '';
  const now = heldAtEnd ?? 'nothing';
  if (now === want) return '';
  return `the ${want} WAS drawn and then taken back out of the hand by another rail — it holds ${now} now` +
    (stolen.length ? `, and ${stolen.length} swing(s) went out with ${stolen[0] ?? 'fists'}` : '');
}

/**
 * 🖐 Was the WEAPON SWAP actually accepted? — issue #48, the reflex rail.
 *
 * Live evidence, soak26 lines 1199-1247 (running post-21bab3d code): four bursts
 * `swung 1x at the phantom with dirt (NOT a weapon — 1 damage, same as a bare
 * fist)` while a stone_sword lay in the bag, and NOT ONE of them said the draw
 * had failed. The narration was honest — `handNow` reads the hand back — but
 * `bot.equip(...)` had RESOLVED, so the code believed the swap happened: the
 * server's refusal lands one round-trip later, after the promise, and the only
 * trace was a parenthesis about dirt.
 *
 * An honest read-back of the hand is not enough on its own: it names what is
 * held without saying that something better was ASKED FOR and refused. That
 * difference is the mind's cue to fix its hand instead of reading "dirt" as its
 * own choice. So: compare the intent against the hand, and speak only when they
 * disagree.
 *
 * `want` is the weapon the body tried to draw (undefined = it tried to EMPTY the
 * hand, because nothing in the bag beats a fist). Returns '' when the hand agrees
 * with the intent — silence is the happy path.
 */
export function drawVerdict(
  bot: { heldItem?: { name?: string } | null },
  want: string | undefined,
  intervalMs = 600,
): string {
  const held = bot.heldItem?.name;
  if (want) {
    if (held === want) return '';
    return `the ${want} draw was REFUSED — the hand still holds ${held ?? 'nothing'} and the ${want} is still in the bag`;
  }
  if (held && !isMeleeWeapon(held, intervalMs))
    return `the hand could not be emptied — it still holds ${held}, which hits for the same 1 damage as a fist`;
  return '';
}

/**
 * 🍖 Which food should the bot eat, given how hungry it is? Pure over item
 * names so tests hand it a bag. Three tiers by the game's hunger table:
 *  - NORMAL foods score by fit: maximize hunger actually restored, then
 *    minimize waste. A 2-point cookie beats 8-point steak at food 18 (same
 *    restore, no waste); a 10-point stew beats 8-point steak at food 11
 *    (restores all 9 for 1 wasted vs leaving you a point hungry).
 *  - RISKY foods never auto-picked: rotten_flesh/spider_eye/poisonous_potato/
 *    pufferfish poison you, raw chicken gambles. The tool still eats them
 *    when NAMED — desperation is the agent's call, not the picker's.
 *  - PRECIOUS foods never auto-picked: golden/enchanted apples are combat
 *    items, chorus fruit teleports you, suspicious_stew is a lottery.
 */
export function bestFood(itemNames: string[], missingHunger: number): string | undefined {
  const points: Record<string, number> = {
    rabbit_stew: 10, cooked_beef: 8, cooked_porkchop: 8, pumpkin_pie: 8,
    baked_potato: 5, beetroot_soup: 6, bread: 5, cooked_chicken: 6, cooked_mutton: 6,
    cooked_rabbit: 5, cooked_salmon: 6, golden_carrot: 6, honey_bottle: 6, mushroom_stew: 6,
    cooked_cod: 5, apple: 4, beef: 3, porkchop: 3, rabbit: 3, carrot: 3,
    cookie: 2, melon_slice: 2, mutton: 2, salmon: 2, cod: 2, sweet_berries: 2, glow_berries: 2,
    beetroot: 1, dried_kelp: 1, potato: 1, tropical_fish: 1,
  };
  let best: string | undefined;
  let bestScore = -Infinity;
  for (const n of itemNames) {
    const p = points[n];
    if (p === undefined) continue;
    // restored is what matters; waste only breaks ties (scaled far below 1
    // point so it can never outvote a real point of hunger).
    const restored = Math.min(p, missingHunger);
    const waste = Math.max(0, p - missingHunger);
    const score = restored - waste / 100;
    if (score > bestScore) { best = n; bestScore = score; }
  }
  return best;
}

/**
 * 🔥 What is about to hurt the bot where it STANDS? Pure over a block probe
 * (same shape as digHazards) so tests hand it a fake world. The reflex tick
 * calls this every 300ms — it must stay cheap: 11 block reads, no allocation
 * beyond the result.
 *
 * Kinds:
 *  - 'burning'      — lava or fire in the feet/head block or horizontally
 *                     adjacent to the feet: the bot is on fire or one step
 *                     from it. Fatal in seconds; the reflex acts, not asks.
 *  - 'water_over_head' — the head block is water. Only dangerous with low
 *                     oxygen — the CALLER pairs it with bot.oxygenLevel,
 *                     because block state is world truth and air is not.
 *  - 'falling_above' — gravel/sand/concrete_powder directly over the head
 *                     block: one block update from a suffocation sandwich.
 */
export interface StandingHazard {
  kind: 'burning' | 'water_over_head' | 'falling_above' | 'head_in_block';
  detail: string;
}

/**
 * 🫧 Drowning: swim up, or dig up?
 *
 * Live soak 2026-08-17: `⚡ [self_preservation] oxygen -1/20 with water
 * overhead — swam up for 3s` fired three times while health bled 17 → 3. The
 * reflex held jump for three seconds and reported success either way — but
 * holding jump under a SOLID CEILING (an underwater cave, a flooded mineshaft,
 * a 1-block dive into an ore pocket) moves the bot nowhere. Air is negative
 * while the drowning damage lands, so "-1/20" is the game saying it is already
 * killing us.
 *
 * So the escape is chosen by what is actually above: open water overhead means
 * swimming works; a solid block means the way out is THROUGH it. Pure so the
 * decision is tested without a world.
 */
export type DrowningEscape =
  | { how: 'swim' }
  | { how: 'dig'; at: { x: number; y: number; z: number }; block: string }
  | { how: 'trapped'; why: string };

export function drowningEscape(
  feet: { x: number; y: number; z: number },
  blockNameAt: (x: number, y: number, z: number) => string | undefined,
): DrowningEscape {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y), fz = Math.floor(feet.z);
  const isWater = (n?: string) => n === 'water' || n === 'flowing_water' || n === 'bubble_column';
  const passable = (n?: string) => n === undefined || n === 'air' || n === 'cave_air' || isWater(n);
  // Two blocks up is where the head goes next; if that is swimmable, jump works.
  const above = blockNameAt(fx, fy + 2, fz);
  if (passable(above)) return { how: 'swim' };
  // Bedrock and the unbreakables are not a plan — say so instead of chewing.
  const unbreakable = new Set(['bedrock', 'barrier', 'end_portal_frame', 'obsidian', 'crying_obsidian', 'reinforced_deepslate']);
  if (unbreakable.has(above!)) return { how: 'trapped', why: `${above} overhead — cannot dig out in time` };
  return { how: 'dig', at: { x: fx, y: fy + 2, z: fz }, block: above! };
}

/**
 * 🫧 What scale is `bot.oxygenLevel` on?
 *
 * The bubble bar is 10 bubbles / 20 half-units, and mineflayer usually reports
 * it that way — but live (2026-08-17) the reflex printed `oxygen 7→398/20`
 * after a swim, because the field also carries the raw AIR TICKS the server
 * sends (300 at full, briefly higher with Respiration/conduit) and goes
 * NEGATIVE while the drowning damage lands. So a reading is normalised before
 * anyone compares or prints it: anything above the bar's own maximum is ticks,
 * which map back onto the 20-unit bar. Pure; the reflex prints `outOf`.
 */
export function oxygenReading(raw: number | undefined): { units: number; outOf: 20; ticks: boolean } | undefined {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return undefined;
  if (raw > 20) return { units: Math.max(0, Math.min(20, Math.round((raw / 300) * 20))), outOf: 20, ticks: true };
  // Negative air = already drowning; the bar bottoms out at 0.
  return { units: Math.max(0, raw), outOf: 20, ticks: false };
}

/**
 * 🏖 Which way is shore?
 *
 * Live soak 2026-08-17, one fix deep: `unstuck` correctly decided to yank a
 * bot frozen in deep water — and then reported `⚡ [unstuck] failed: No path to
 * the goal!`, because the pathfinder plans WALKS and there is no walk out of a
 * lake. The way out of water is dead reckoning: face the nearest standable
 * column and hold forward+jump. So this picks that column — the closest spot
 * with solid ground and two breathable blocks above it — searching outward in
 * rings so the first hit is the nearest. Pure over a block reader; returns
 * undefined when the water is wider than the search (then swimming up and
 * asking the mind is the honest answer).
 */
/**
 * 🆘 How urgent is this water?
 *
 * The bot DROWNED on 2026-08-17 at 3.5 HP in a flooded shaft, with the reflex
 * doing exactly what it was told: wait for oxygen < 8, hold jump for three
 * seconds, recover to 15/20, sink again. Two things were wrong. The trigger was
 * a constant while the DANGER is not — at 3.5 HP a single drowning tick (2
 * damage) is a third of the bot's life, so a hurt bot must react while the bar
 * is still half full. And "surface" is not "safe": bobbing at the top of a
 * flooded shaft keeps the head in water, so the next dip resumes the damage.
 *
 * Urgency, then, is a function of BOTH gauges:
 *  - 'evacuate' — leave the water entirely (swim to shore / dig out): the bot
 *    cannot afford another mouthful, because air is nearly gone or health is.
 *  - 'surface'  — a normal dip: hold jump, get air, carry on.
 *  - 'none'     — plenty of air and health; not the reflex's business yet.
 * Pure so the thresholds are tested without a lake.
 */
export function drowningUrgency(s: {
  oxygenUnits?: number;
  health?: number;
  /**
   * Is the air bar actually GOING DOWN? soak41: sixteen `EVACUATING water …
   * 19/20 air, 0 hp` lines in one short soak. Air 19 of 20 means the head is
   * breaking the surface and the bar is REFILLING — the water was not what was
   * doing the damage (starvation was), yet `critical && o < 20` made every tick
   * a life-or-death evacuation that spent the legs and preempted everything
   * else. Undefined keeps the old, more paranoid reading, so a caller that
   * cannot measure the trend loses nothing.
   */
  airFalling?: boolean;
}): 'none' | 'surface' | 'evacuate' {
  const o = s.oxygenUnits, h = s.health;
  if (typeof o !== 'number') return 'none';
  const hurt = typeof h === 'number' && h <= 8;
  const critical = typeof h === 'number' && h <= 6;
  const falling = s.airFalling ?? true;
  if (o <= 3) return 'evacuate';                          // one tick could end it
  if (critical && o < 20 && falling) return 'evacuate';   // hurt AND losing air
  // Critical health with a nearly full, non-falling bar: the head is out often
  // enough that water is not the killer. Say nothing rather than evacuate every
  // three seconds while something else kills the body.
  if (critical && !falling && o >= 14) return 'none';
  if (o < 8 || (hurt && o < 14)) return 'surface';        // hurt bots act early
  return 'none';
}

/**
 * 🏊 DID THE EVACUATION WORK? Graded on ground truth, not on one frame of air.
 *
 * soak41, sixteen times: `EVACUATING water … 0 hp — swam 9.6m … head is OUT of
 * the water`, and seconds later the same line again. The success test was "no
 * water over the head" sampled the instant the swim stopped — and a body
 * swimming at the surface of open water has its head clear on most frames while
 * being nowhere near OUT. So the reflex reported success sixteen times,
 * escalated nothing, and the bot died in the lake.
 *
 * Out means: head clear, feet clear, standing on something solid, measured
 * after a grace window. Anything less is named for what it is, and a repeated
 * failure ESCALATES to a different mechanism instead of swimming again —
 * placing a block to stand on is how a body leaves open water with no shore.
 */
export type EvacNext = 'nothing' | 'swim_again' | 'swim_lateral' | 'pillar' | 'dig_up';

export function gradeEvacuation(o: {
  headClear: boolean;
  feetInWater: boolean;
  standingOnSolid: boolean;
  movedBlocks: number;
  /** How many evacuations this water episode has already cost (1 = the first). */
  attempt: number;
  maxSwims?: number;
  /**
   * What is over the head, read AFTER the swim. soak42 swam 10m up under a roof
   * and was told to swim again: a 'blocked' column means the direction itself is
   * wrong, so the budget must not be spent on repeating it — no matter how many
   * attempts are left. Omitted keeps the old attempt-count behaviour.
   */
  column?: WaterColumn;
  /** Is there an open column within swimming distance sideways? */
  lateralExit?: boolean;
  /**
   * What is AT head height. A head in water is drowning; a head inside a solid
   * block is suffocating, and calling that 'underwater' sends the mind looking
   * for a surface that is not the problem.
   */
  headBlock?: string;
  /** Is that head block a full solid block (the game's own boundingBox)? */
  headSealed?: boolean;
}): { escaped: boolean; grade: string; next: EvacNext } {
  const maxSwims = o.maxSwims ?? 2;
  if (o.headClear && !o.feetInWater && o.standingOnSolid) {
    return { escaped: true, grade: `OUT — on solid ground, head and feet clear of the water after ${o.movedBlocks.toFixed(1)}m`, next: 'nothing' };
  }
  const again = o.attempt < maxSwims;
  if (!o.headClear) {
    const inWater = o.headBlock === undefined || /water|bubble_column/.test(o.headBlock);
    const head = inWater ? 'head underwater' : `head inside ${o.headBlock} — SUFFOCATING, not swimming`;
    // A CEILING BEATS THE ATTEMPT BUDGET: swimming up into a block is not a
    // failed attempt, it is an impossible one, and repeating it costs ~5s of
    // drowning damage each time.
    if (o.column?.kind === 'blocked') {
      return {
        escaped: false,
        grade: `STILL SUBMERGED — ${head} ${o.movedBlocks.toFixed(1)}m later (attempt ${o.attempt}), and UP IS SEALED: ${o.column.block} at y=${o.column.y} is the ceiling, so swimming up cannot surface this body`,
        next: o.lateralExit ? 'swim_lateral' : 'dig_up',
      };
    }
    return {
      escaped: false,
      grade: `STILL SUBMERGED — ${head} ${o.movedBlocks.toFixed(1)}m later (attempt ${o.attempt})${o.column?.kind === 'deep' ? `, water all the way up past ${o.column.searched} blocks` : ''}`,
      next: again ? 'swim_again' : 'dig_up',
    };
  }
  if (o.headSealed) {
    // Not water over the head and not air either: the head is inside a block.
    // 'Treading water' would send the mind looking for a surface; the actual
    // problem is that this body cannot breathe where it stands.
    return {
      escaped: false,
      grade: `NOT OUT — the head is inside ${o.headBlock ?? 'a solid block'}: this body is SUFFOCATING in a pocket, not treading water, after ${o.movedBlocks.toFixed(1)}m (attempt ${o.attempt})`,
      next: 'dig_up',
    };
  }
  // The soak41 signature: air on the face, body still in the lake.
  return {
    escaped: false,
    grade: `NOT OUT — treading water: the head is clear but ${o.feetInWater ? 'the body is still in the water' : 'there is nothing solid underfoot'} after ${o.movedBlocks.toFixed(1)}m (attempt ${o.attempt}); one frame of air is not an escape`,
    next: again ? 'swim_again' : 'pillar',
  };
}

/**
 * ⛏️🫧 CAN THIS BODY AFFORD THIS DIG BEFORE IT DROWNS?
 *
 * soak43, with the ceiling-reading of `6a6f624` finally honest:
 * `EVACUATING water at 3/20 air, 18 hp — swam 1.2m upward against stone at
 * y=42 … UP IS SEALED: stone at y=41 is the ceiling, so swimming up cannot
 * surface this body → could not dig the stone overhead: dig timeout`.
 * The verdict was RIGHT and the remedy was a fantasy: the reflex raced
 * `bot.dig` against a flat 5s timeout with whatever was in the hand (a fist),
 * and the game charges a bare hand 7.5s for stone — then multiplies it by 5 for
 * being underwater and by 5 AGAIN for not standing on the ground. So the last
 * three bubbles of air went into a dig that could not finish, which is a
 * drowning death dressed as an attempt.
 *
 * Two separate facts were missing, and both are arithmetic:
 *  - the dig has a PRICE in milliseconds, and the price depends on which tool
 *    is in the hand (so the hand is part of the plan, not a coincidence);
 *  - the lungs have a BUDGET in milliseconds, and a dig longer than the budget
 *    must not be started — it must be REFUSED OUT LOUD so another mechanism
 *    (sideways, a placed block, the mind) gets the seconds instead.
 *
 * Pure. The caller prices each candidate with the game's own
 * `block.digTime(itemType, creative, inWater, notOnGround)` — including the
 * penalties — and this decides.
 */
/** One thing the hand could hold for a dig. `name: undefined` = the bare fist. */
export type DigCandidate = { name?: string; digMs: number };

/** AIR_MS_PER_UNIT — the bubble bar is 20 half-units over 300 ticks = 15s. */
export const AIR_MS_PER_UNIT = 750;
/** Drowning costs 2 hp a second once the bar is empty. */
export const DROWN_HP_PER_SEC = 2;

/**
 * How many milliseconds of work the body can still pay for underwater: the air
 * that is left, plus the seconds it can survive drowning down to a reserve it
 * refuses to spend (a hit or a fall has to still be survivable afterwards).
 */
export function airBudgetMs(o: { airUnits: number; health: number; hpReserve?: number; soleExit?: boolean }): { ms: number; why: string } {
  const reserve = o.hpReserve ?? 4;
  // soak47's deadlock: a reserve is a comfort margin, and a body sealed in sand
  // has no comfort left to margin. When the dig is the ONLY exit the floor is
  // SURVIVAL, not comfort — the reserve gives way down to DIG_SURVIVAL_FLOOR_HP.
  const floor = o.soleExit ? Math.min(reserve, DIG_SURVIVAL_FLOOR_HP) : reserve;
  const airMs = Math.max(0, o.airUnits) * AIR_MS_PER_UNIT;
  const spendableHp = Math.max(0, (o.health ?? 0) - floor);
  const drownMs = (spendableHp / DROWN_HP_PER_SEC) * 1000;
  const sole = o.soleExit && floor < reserve ? ` (this dig is the ONLY exit, so the ${reserve} hp reserve gives way down to ${floor} hp)` : '';
  return {
    ms: Math.round(airMs + drownMs),
    why: `${(airMs / 1000).toFixed(1)}s of air left${drownMs > 0 ? ` + ${(drownMs / 1000).toFixed(1)}s of drowning I can survive down to ${floor} hp${sole}` : ` and NO drowning to spend (${(o.health ?? 0).toFixed(1)} hp is at or under the ${floor} hp reserve)`}`,
  };
}

/** DIG_SURVIVAL_FLOOR_HP — the hp a dig may never spend, reserve or no reserve. */
export const DIG_SURVIVAL_FLOOR_HP = 0.5;

/**
 * 💰 HOW MANY HP DOES THIS DIG ITSELF SPEND?
 *
 * The number the reserve should have been guarding all along. Every millisecond
 * of the dig that the bubble bar covers is free; only the part PAST the air
 * drowns the body, at 2 hp a second. A 0.8s dig with 15s of air spends ZERO hp,
 * so no hp reserve has anything to say about it — soak47 line 89 is the body
 * that died being told otherwise.
 */
export function digHpCost(o: { digMs: number; airUnits: number; hpPerSec?: number }): number {
  const airMs = Math.max(0, o.airUnits) * AIR_MS_PER_UNIT;
  const beyondMs = Math.max(0, o.digMs - airMs);
  return (beyondMs / 1000) * (o.hpPerSec ?? DROWN_HP_PER_SEC);
}

/** The cheapest hand for this block. Ties keep the hand that is already held. */
export function bestDigTool(candidates: DigCandidate[], held?: string): DigCandidate | undefined {
  const usable = candidates.filter((c) => Number.isFinite(c.digMs) && c.digMs >= 0);
  if (!usable.length) return undefined;
  return usable.reduce((best, c) => {
    if (c.digMs < best.digMs) return c;
    if (c.digMs === best.digMs && c.name === held) return c;
    return best;
  }, usable[0]!);
}

export type DigPlan = {
  payable: boolean;
  /** The hand to equip first — undefined means the fist is already the best hand. */
  tool?: string;
  digMs: number;
  budgetMs: number;
  /** What to do instead when the dig cannot be paid for. */
  fallback?: 'swim_lateral' | 'pillar' | 'ask';
  line: string;
};

export function digPlan(o: {
  block: string;
  candidates: DigCandidate[];
  airUnits: number;
  health: number;
  hpReserve?: number;
  held?: string;
  /**
   * WHERE the block is, in the body's own words ('overhead' by default). The
   * live boot print said "the stone UNDERFOOT … digging the stone OVERHEAD
   * costs 7.5s" because this sentence owned a noun the caller had already
   * chosen — the same stutter 2bda086 fixed for water. One namer, one noun.
   */
  where?: string;
  /** Is a sideways open column in reach? Then it is the cheaper answer. */
  lateralExit?: boolean;
  /** Is there something placeable to stand on? */
  canPillar?: boolean;
  /**
   * Is this dig the ONLY way out? Defaults to the truth the other two flags
   * already tell: nothing sideways and nothing to stand on. When it is, the hp
   * reserve stops being a veto and becomes a survival floor (soak47 line 89).
   */
  soleExit?: boolean;
}): DigPlan {
  const soleExit = o.soleExit ?? (!o.lateralExit && !o.canPillar);
  const budget = airBudgetMs({ airUnits: o.airUnits, health: o.health, hpReserve: o.hpReserve, soleExit });
  const where = o.where ?? 'overhead';
  const pick = bestDigTool(o.candidates, o.held);
  const label = (c?: DigCandidate) => (c?.name ? c.name.replace(/_/g, ' ') : 'a bare fist');
  if (!pick) {
    return { payable: false, digMs: Infinity, budgetMs: budget.ms, fallback: o.lateralExit ? 'swim_lateral' : o.canPillar ? 'pillar' : 'ask', line: `${o.block} ${where} cannot be dug by anything I hold` };
  }
  const priced = `${(pick.digMs / 1000).toFixed(1)}s with ${label(pick)}`;
  // The fist is the baseline the old code silently used; naming what the swap
  // BUYS is what makes the equip visible in a log line instead of implied.
  const fist = o.candidates.find((c) => !c.name);
  const saved = fist && pick.name && Number.isFinite(fist.digMs) ? ` (a bare fist would cost ${(fist.digMs / 1000).toFixed(1)}s)` : '';
  // What the dig ACTUALLY spends in hp — the only thing a reserve can protect.
  const hpCost = digHpCost({ digMs: pick.digMs, airUnits: o.airUnits });
  const spend = hpCost <= 0
    ? `this dig spends NO hp — the air covers all ${(pick.digMs / 1000).toFixed(1)}s of it, so the ${o.hpReserve ?? 4} hp reserve has nothing to protect`
    : `it would drown ${hpCost.toFixed(1)} hp out of the ${(o.health ?? 0).toFixed(1)} hp I hold — ${budget.why}`;
  if (pick.digMs <= budget.ms) {
    return {
      payable: true,
      tool: pick.name,
      digMs: pick.digMs,
      budgetMs: budget.ms,
      line: `PAYABLE: digging the ${o.block} ${where} costs ${priced}${saved} and I can pay ${(budget.ms / 1000).toFixed(1)}s — ${spend}`,
    };
  }
  const fallback: DigPlan['fallback'] = o.lateralExit ? 'swim_lateral' : o.canPillar ? 'pillar' : 'ask';
  const instead = fallback === 'swim_lateral'
    ? 'so I am spending them swimming SIDEWAYS to the open column instead'
    : fallback === 'pillar'
      ? 'so I am spending them placing a block to stand on instead'
      : 'and there is no sideways exit and nothing placeable in the bag — this is the mind\'s call, right now';
  return {
    payable: false,
    tool: pick.name,
    digMs: pick.digMs,
    budgetMs: budget.ms,
    fallback,
    line: `UNPAYABLE: the ${o.block} ${where} costs ${priced}${saved} but I can only pay ${(budget.ms / 1000).toFixed(1)}s — ${spend} — ${instead}`,
  };
}

/** Blocks worth placing under your own feet to leave open water, cheapest first. */
export function pillarBlock(counts: Record<string, number>): string | undefined {
  const order = ['dirt', 'sand', 'gravel', 'cobblestone', 'stone', 'netherrack', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'oak_planks', 'spruce_planks', 'birch_planks'];
  const direct = order.find((n) => (counts[n] ?? 0) > 0);
  if (direct) return direct;
  // Structure, not a list: any *_planks / *_log / *_stone variant holds a body.
  return Object.keys(counts).find((n) => (counts[n] ?? 0) > 0 && /(_planks|_log|_stone|_terracotta|_concrete|_wool)$/.test(n));
}

/**
 * 🧱 IS THERE A CEILING BETWEEN THIS HEAD AND THE AIR?
 *
 * soak42, on the tip and with the grading finally honest: `EVACUATING water at
 * 10/20 air, 6 hp — swam 10.0m upward (no shore within 16): STILL SUBMERGED —
 * head underwater 10.0m later (attempt 1) → swimming again on the next tick`.
 * The verdict was true and the ESCAPE was still impossible: ten metres of
 * swimming under a roof surfaces exactly nobody, and the answer was to swim
 * again. Holding jump is not a plan, it is a direction — and a direction has to
 * be checked before it is spent, because at 6 hp one wasted attempt is
 * ~5 seconds of drowning damage.
 *
 * So the column above the head gets read, one block at a time, before the legs
 * move:
 *  - 'open'    — water, then breathable air N blocks up: swimming works.
 *  - 'blocked' — a solid block over the head: the way out is THROUGH it (dig)
 *                or SIDEWAYS to a column that is open. Swimming up cannot work.
 *  - 'deep'    — water all the way past the search: the surface is real but far,
 *                so swimming up is right and the distance is unknown, not 0.
 * Unloaded chunks read as unknown and are treated as open (a swim costs
 * seconds, a refusal to swim can cost the life) but say so.
 */
export type WaterColumn =
  | { kind: 'open'; toAir: number; unknown?: boolean }
  | { kind: 'blocked'; block: string; y: number }
  | { kind: 'deep'; searched: number };

export function waterColumn(
  feet: { x: number; y: number; z: number },
  blockNameAt: (x: number, y: number, z: number) => string | undefined,
  maxUp = 24,
): WaterColumn {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y), fz = Math.floor(feet.z);
  const isWater = (n?: string) => n === 'water' || n === 'flowing_water' || n === 'bubble_column';
  const isAir = (n?: string) => n === 'air' || n === 'cave_air';
  for (let dy = 1; dy <= maxUp; dy++) {
    const n = blockNameAt(fx, fy + dy, fz);
    if (isWater(n)) continue;
    if (isAir(n)) return { kind: 'open', toAir: dy };
    if (n === undefined) return { kind: 'open', toAir: dy, unknown: true };
    return { kind: 'blocked', block: n, y: fy + dy };
  }
  return { kind: 'deep', searched: maxUp };
}

/**
 * 🚪 THE NEAREST COLUMN THAT ACTUALLY REACHES AIR.
 *
 * The lateral half of the ceiling problem: under a roof, the mechanism that
 * leaves the water is not "up" and not always "dig" — usually there is an open
 * column a few blocks away (the edge of the overhang, the shaft you swam in
 * through). Rings outward so the first hit is the nearest, ray-checked for a
 * swimmable path exactly like `shoreDirection` (a real air pocket behind stone
 * is not reachable), and each candidate's own column must be OPEN — otherwise
 * the bot swims sideways into a second ceiling.
 */
export function lateralAirColumn(
  feet: { x: number; y: number; z: number },
  blockNameAt: (x: number, y: number, z: number) => string | undefined,
  radius = 8,
): { x: number; y: number; z: number; dist: number; toAir: number } | undefined {
  const passable = (n?: string) => n === 'air' || n === 'cave_air' || n === 'water' || n === 'flowing_water' || n === 'bubble_column';
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y), fz = Math.floor(feet.z);
  const swimmable = (to: { x: number; y: number; z: number }) => {
    const dx = to.x + 0.5 - feet.x, dz = to.z + 0.5 - feet.z;
    const steps = Math.max(2, Math.ceil(Math.hypot(dx, dz) * 2));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.floor(feet.x + dx * t), z = Math.floor(feet.z + dz * t);
      if (!passable(blockNameAt(x, fy, z)) || !passable(blockNameAt(x, fy + 1, z))) return false;
    }
    return true;
  };
  for (let r = 1; r <= radius; r++) {
    let best: { x: number; y: number; z: number; dist: number; toAir: number } | undefined;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const x = fx + dx, z = fz + dz;
        if (!passable(blockNameAt(x, fy, z))) continue;      // has to be swimmable AT head height
        const col = waterColumn({ x, y: fy, z }, blockNameAt);
        if (col.kind !== 'open') continue;                    // a second ceiling is not an exit
        const dist = Math.hypot(dx, dz);
        if (!swimmable({ x, y: fy, z })) continue;
        if (!best || dist < best.dist) best = { x, y: fy, z, dist, toAir: col.toAir };
      }
    }
    if (best) return best;
  }
  return undefined;
}

/**
 * A spot only counts if the bot can actually SWIM there. Live soak 2026-08-17,
 * one fix later: a bot in a flooded mineshaft at y=59 was aimed at a perfectly
 * real air pocket four blocks away — through a wall of stone — and reported
 * `swam 0.5m toward shore (-6, 61, 18)` twice while getting nowhere. Nearest by
 * distance is worthless when the straight line is masonry, so every candidate
 * is ray-checked for a swimmable path (water or air the whole way).
 */
export function shoreDirection(
  feet: { x: number; y: number; z: number },
  blockNameAt: (x: number, y: number, z: number) => string | undefined,
  radius = 12,
): { x: number; y: number; z: number; dist: number } | undefined {
  const passable = (n?: string) => n === 'air' || n === 'cave_air' || n === 'water' || n === 'flowing_water' || n === 'bubble_column';
  const swimmable = (to: { x: number; y: number; z: number }) => {
    const dx = to.x + 0.5 - feet.x, dy = to.y + 0.5 - feet.y, dz = to.z + 0.5 - feet.z;
    const steps = Math.max(2, Math.ceil(Math.hypot(dx, dy, dz) * 2));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.floor(feet.x + dx * t), y = Math.floor(feet.y + dy * t), z = Math.floor(feet.z + dz * t);
      if (x === Math.floor(to.x) && y === Math.floor(to.y) && z === Math.floor(to.z)) continue; // the landing itself
      if (!passable(blockNameAt(x, y, z))) return false;
    }
    return true;
  };
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y), fz = Math.floor(feet.z);
  const liquid = (n?: string) => n === 'water' || n === 'flowing_water' || n === 'bubble_column' || n === 'lava' || n === 'flowing_lava';
  const air = (n?: string) => n === 'air' || n === 'cave_air';
  const solid = (n?: string) => !!n && !air(n) && !liquid(n) && n !== 'void_air';
  for (let r = 1; r <= radius; r++) {
    let best: { x: number; y: number; z: number; dist: number } | undefined;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        // Shorelines slope: accept a landing a couple of blocks up or down.
        for (const dy of [0, 1, -1, 2, -2]) {
          const x = fx + dx, y = fy + dy, z = fz + dz;
          if (!solid(blockNameAt(x, y - 1, z))) continue;      // something to stand ON
          if (!air(blockNameAt(x, y, z)) || !air(blockNameAt(x, y + 1, z))) continue; // room to breathe
          const dist = Math.hypot(dx, dy, dz);
          if (!swimmable({ x, y, z })) continue; // a real spot, unreachable — a wall is not a shore
          if (!best || dist < best.dist) best = { x, y, z, dist };
          break;
        }
      }
    }
    if (best) return best;
  }
  return undefined;
}

export function standingHazards(
  feet: { x: number; y: number; z: number },
  blockNameAt: (x: number, y: number, z: number) => string | undefined,
  /**
   * 🧱🫁 IS THE HEAD INSIDE A WALL?
   *
   * soak43 line 87: `StrandsBot suffocated in a wall` — and four lines earlier
   * the `dying` reflex had shrugged: `no hostile in sight and no hazard
   * underfoot — the damage is coming from the world (hunger, suffocation, a
   * fall), and no direction is safer than another`. It named suffocation as a
   * suspect and then stood still, because suffocation was not a hazard anything
   * could see: `water_over_head` only ever asked "is it water", and rock is not
   * water. A body cannot be told to escape a danger nobody reports.
   *
   * Solidity is asked of the game (boundingBox), never of a name list — 1a99f01
   * learned that the hard way: head-high tall grass is not a wall, and a list
   * would have had the body digging its way out of a meadow.
   */
  isWall?: (x: number, y: number, z: number) => boolean,
): StandingHazard[] {
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y), fz = Math.floor(feet.z);
  const lava = (n?: string) => n === 'lava' || n === 'flowing_lava';
  const fire = (n?: string) => n === 'fire' || n === 'soul_fire' || n === 'magma_block';
  const water = (n?: string) => n === 'water' || n === 'flowing_water';
  const falling = (n?: string) => !!n && (n === 'gravel' || n === 'sand' || n === 'red_sand' || n.endsWith('concrete_powder'));
  const out: StandingHazard[] = [];

  const atFeet = blockNameAt(fx, fy, fz);
  const atHead = blockNameAt(fx, fy + 1, fz);
  const below = blockNameAt(fx, fy - 1, fz);
  const ring = [
    blockNameAt(fx + 1, fy, fz), blockNameAt(fx - 1, fy, fz),
    blockNameAt(fx, fy, fz + 1), blockNameAt(fx, fy, fz - 1),
  ];
  if (lava(atFeet) || lava(atHead)) out.push({ kind: 'burning', detail: 'IN LAVA' });
  else if (fire(atFeet) || fire(atHead) || fire(below)) out.push({ kind: 'burning', detail: 'on fire' });
  else if (ring.some(lava)) out.push({ kind: 'burning', detail: 'lava one step away' });

  if (water(atHead)) out.push({ kind: 'water_over_head', detail: 'head underwater' });
  else if (isWall?.(fx, fy + 1, fz)) out.push({ kind: 'head_in_block', detail: `head inside ${atHead ?? 'a solid block'} — SUFFOCATING` });
  if (falling(blockNameAt(fx, fy + 2, fz))) out.push({ kind: 'falling_above', detail: `${blockNameAt(fx, fy + 2, fz)} overhead` });
  return out;
}

/**
 * 🛡 Which armor in the bag strictly beats what is worn? Pure over names so
 * tests hand it inventories. Material ladder per the game's protection
 * table: leather < golden < chainmail < turtle < iron < diamond < netherite.
 * Empty slot counts as rank 0 — anything beats bare skin. Elytra is NOT
 * armor and never suggested (losing chest protection is the agent's call).
 */
const ARMOR_SLOTS = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' } as const;
export type ArmorSlot = (typeof ARMOR_SLOTS)[keyof typeof ARMOR_SLOTS];

function armorRank(name?: string): number {
  if (!name) return 0;
  if (name === 'turtle_helmet') return 3.5;
  const ranks: Record<string, number> = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 };
  return ranks[name.split('_')[0]] ?? 0;
}

function armorSlot(name: string): ArmorSlot | undefined {
  if (name === 'turtle_helmet') return 'head';
  for (const [suffix, slot] of Object.entries(ARMOR_SLOTS)) if (name.endsWith(`_${suffix}`)) return slot;
  return undefined;
}

export function bestArmorUpgrades(
  itemNames: string[],
  equipped: Partial<Record<ArmorSlot, string | undefined>>,
): Array<{ slot: ArmorSlot; item: string }> {
  const best = new Map<ArmorSlot, string>();
  for (const n of itemNames) {
    const slot = armorSlot(n);
    if (!slot) continue;
    if (armorRank(n) > armorRank(best.get(slot))) best.set(slot, n);
  }
  const out: Array<{ slot: ArmorSlot; item: string }> = [];
  for (const [slot, item] of best) {
    if (armorRank(item) > armorRank(equipped[slot])) out.push({ slot, item });
  }
  return out;
}

/**
 * 🏃 The point `distance` blocks straight away from a threat, horizontally.
 * Pure vector math so flee behavior is testable. Degenerate case (threat is
 * exactly underfoot) picks +x — a deterministic direction beats a frozen bot.
 */
export function awayFrom(
  me: { x: number; y: number; z: number },
  threat: { x: number; y: number; z: number },
  distance: number,
): { x: number; y: number; z: number } {
  const dx = me.x - threat.x, dz = me.z - threat.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return { x: me.x + distance, y: me.y, z: me.z };
  return { x: me.x + (dx / len) * distance, y: me.y, z: me.z + (dz / len) * distance };
}

/**
 * 🏃 The panic ladder: what to try when fleeing FAILS.
 *
 * `flee()` is one pathfinder `goto` with a timeout, and in a real fight it
 * loses two races constantly (live soak 2026-08-17, repeated in the log):
 *  - `flee timeout` — the pathfinder cannot compute or walk 20 blocks of
 *    escape inside 8s while a drowned chews on the bot in water;
 *  - `The goal was changed before it could be completed!` — another reflex, a
 *    journey step, or the NEXT firing of this same reflex replaced the goal.
 * Both used to end as one `[dying] failed: …` line while the bot stood still
 * and died (three deaths in one soak hour, twice with full health 12s earlier).
 *
 * A body that is dying must degrade instead of reporting. The ladder, in
 * order, and pure so a test can walk it without a world:
 *  1. `path` far — the ideal: 20 blocks of distance, tolerance 2.
 *  2. `path` near — a third of the distance (floor 4) with a loose tolerance:
 *     a goal that is cheap to compute succeeds where the ambitious one timed out.
 *  3. `blind` — no pathfinder at all: face away, sprint+jump for ~1.5s. Works
 *     when pathing itself is the thing failing (water, cave ceiling, sand).
 *  4. `fight` — only when a melee threat is still on top of us and fighting is
 *     permitted: swinging beats being eaten while walking away. Never offered
 *     for a primed creeper (punching it is the death we were avoiding).
 *  5. `give_up` — nothing left; the caller reports honestly.
 */
export type EscapeTactic =
  | { kind: 'path'; distance: number; tolerance: number; timeoutMs: number }
  | { kind: 'blind'; ms: number }
  | { kind: 'fight' }
  | { kind: 'give_up' };

export function escapeLadder(o: {
  /** how far we WANT to be from the threat */
  distance: number;
  /** blocks to the nearest threat right now (Infinity = none visible) */
  threatDist: number;
  /** may the caller trade flight for combat? (false for creepers) */
  allowFight: boolean;
}): EscapeTactic[] {
  const far = Math.max(2, Math.round(o.distance));
  const near = Math.max(4, Math.round(o.distance / 3));
  // Rung budgets come off the one flee clock in config: the ambitious rung gets
  // the full budget, the cheap retry half — dying is on the clock either way.
  const ladder: EscapeTactic[] = [
    { kind: 'path', distance: far, tolerance: 2, timeoutMs: cfg.reflex.fleeTimeoutMs },
  ];
  if (near < far) ladder.push({ kind: 'path', distance: near, tolerance: 3, timeoutMs: Math.round(cfg.reflex.fleeTimeoutMs / 2) });
  ladder.push({ kind: 'blind', ms: cfg.reflex.blindSprintMs });
  if (o.allowFight && o.threatDist <= 4.5) ladder.push({ kind: 'fight' });
  ladder.push({ kind: 'give_up' });
  return ladder;
}

/**
 * Why a rung of the ladder failed — the difference between "pathing is broken"
 * and "someone took the legs" (issue #22).
 */
export type EscapeFailure = 'cancelled' | 'timeout' | 'other';

export function classifyEscapeFailure(err: unknown): EscapeFailure {
  const m = err instanceof Error ? err.message : String(err ?? '');
  if (/goal was changed/i.test(m)) return 'cancelled';
  if (/timeout/i.test(m)) return 'timeout';
  return 'other';
}

/**
 * 🔁 Should a failed PATH rung be tried again before degrading?
 *
 * The ladder's degradation is evidence-driven: a `flee timeout` says the
 * pathfinder cannot solve this terrain, so dropping to a blind sprint is the
 * right escalation. A CANCELLATION says nothing about the terrain at all — it
 * says another rail called setGoal — and the live soak shows what treating the
 * two alike costs: a creeper at 5.4 blocks, both path rungs cancelled inside a
 * second, and the "escape" was a 1m blind sprint that left the bot in the blast
 * radius (the worker version ended at 2/20 HP).
 *
 * So a cancelled path retries the SAME rung once. Once, because by then the
 * claim locks every lower rank out: a second cancellation means something
 * outranking us owns the legs, and re-pathing under it would be the very bug
 * this arbitration exists to stop.
 */
export function escapeRetry(o: {
  failure: EscapeFailure;
  retriesUsed: number;
  maxRetries?: number;
  /** Do we STILL own the legs? soak41 says this is the load-bearing question. */
  holdsLegs?: boolean;
}): boolean {
  if (o.failure !== 'cancelled') return false;
  if (o.retriesUsed >= (o.maxRetries ?? 1)) return false;
  // The old comment claimed the retry was safe "because by then the claim locks
  // every lower rank out". soak41 proved the premise false: the dying claim's
  // 15s time box is shorter than the 24s ladder it protects (see
  // escapeBudgetMs), so by rung two the legs were formally FREE, the retry
  // re-pathed unprotected, and the body finished the episode at 0 hp without
  // moving one block. Retrying a path we do not own is the bug, not the fix.
  return o.holdsLegs !== false;
}

/**
 * ⏱ What the ladder COSTS, worst case — so a legs claim can be derived from the
 * thing it protects instead of a hand-picked constant.
 *
 * soak41's arithmetic: 8s far path + 8s cancelled-retry + 4s near path + 1.5s
 * blind sprint + 2.5s swing-back = 24s of escape under a 15s claim. The escape
 * therefore ran the rungs that matter most with no protection at all. Pricing
 * the ladder is how that stops being possible to get wrong again.
 */
export function escapeBudgetMs(
  ladder: readonly EscapeTactic[],
  opts: { retries?: number; fightMs?: number } = {},
): number {
  const fightMs = opts.fightMs ?? cfg.reflex.fightBackMs;
  let total = 0;
  let worstPath = 0;
  for (const rung of ladder) {
    if (rung.kind === 'path') { total += rung.timeoutMs; worstPath = Math.max(worstPath, rung.timeoutMs); }
    else if (rung.kind === 'blind') total += rung.ms;
    else if (rung.kind === 'fight') total += fightMs;
  }
  // A retry repeats the most expensive path rung; give_up costs nothing.
  return total + (opts.retries ?? 1) * worstPath;
}

/**
 * ⏱ How long a walk is allowed to take, from how far it is.
 *
 * Generous, because pathfinding legitimately takes seconds per block through
 * caves and water — but finite, which is the whole point.
 */
export function walkBudgetMs(dist: number, opts: { minMs?: number; perBlockMs?: number; capMs?: number } = {}): number {
  const { minMs = 25_000, perBlockMs = 1_500, capMs = 150_000 } = opts;
  return Math.min(capMs, Math.max(minMs, Math.round(dist * perBlockMs)));
}

/**
 * 🚶 `pathfinder.goto` with a deadline and a stall detector.
 *
 * Live soak 2026-08-17, and this one cost the bot five minutes of its life:
 * a journey step called `go_to` into a flooded shaft, pathfinder kept
 * re-planning a route that water kept undoing, and `goto` simply never settled.
 * It does not reject in that case — there IS a path, it just never completes —
 * so the tool call blocked forever. Downstream, everything went deaf: the mind
 * was busy (so chat, thinker and supervisor all waited), the journey step never
 * ended, and the unstuck reflex — correctly refusing to yank the legs out from
 * under deliberate work — could only file notes nobody would read for minutes:
 * `stationary 140s with a live goal while the mind is busy`.
 *
 * A blocking tool must have a bound. Two of them, in fact: a total budget from
 * the distance, and a no-progress window, because the flooded-shaft signature is
 * "moving constantly, arriving never" — 1.5 blocks of drift in 25s is not travel.
 * On either bound the legs are stopped and the tool RETURNS (not throws) a
 * truthful account with the distance left, so the model can dig, pick another
 * approach, or give the goal up. Real pathfinder rejections keep their meaning.
 */
export async function walkTo(
  bot: Bot,
  goal: object,
  target: { x: number; y: number; z: number },
  opts: {
    desc?: string; deadlineMs?: number; stallMs?: number; pollMs?: number; driftBlocks?: number;
    digCreditMs?: number; creditCapFactor?: number;
    owner?: string; priority?: number; maxWaitMs?: number;
  } = {},
): Promise<string> {
  const { pollMs = 1_000, stallMs = 25_000, driftBlocks = 1.5 } = opts;
  const at = () => bot.entity?.position;
  const distTo = () => {
    const p = at();
    return p ? Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z) : Infinity;
  };
  const startPos = at()?.clone();
  const baseDeadlineMs = opts.deadlineMs ?? walkBudgetMs(distTo());
  // Digging IS progress. `go_to` tunnels by design, and a wooden pickaxe on stone
  // buys ~1.2s per block while the body barely moves — exactly the shape the
  // stall detector was built to kill. Live soak: three bodies at once sat
  // 'stationary 35-195s with a live goal', all of them working. So each finished
  // dig resets the no-progress window and buys a little more budget (capped, or a
  // bot mining a mountain never returns), and the walk is only cut off when the
  // world stops changing in EITHER way.
  const digCreditMs = opts.digCreditMs ?? 6_000;
  const maxCreditMs = baseDeadlineMs * ((opts.creditCapFactor ?? 3) - 1);
  // 🦵 ASK before pathing (issue #22). Every deliberate walk funnels through
  // here — go_to, follow, and the approach before mining, placing, trading and
  // attack_entity's chase — which is why this is the one place the legs lock has
  // to be honoured. Live soak: the chase loop re-issued a follow goal tick after
  // tick while creeper_flee pathed away from that same creeper, so BOTH paths of
  // the flee died as "goal was changed" and the escape degraded to a 1m blind
  // sprint at melee range. A safety lease is seconds long: waiting it out costs
  // this walk 2s, ignoring it costs a life.
  const owner = opts.owner ?? 'agent';
  const lock = legsFor(bot as unknown as object);
  const held = await lock.acquire({
    owner,
    priority: opts.priority ?? LEGS_PRIORITY.agent,
    // The claim spans the whole bounded walk — expiring mid-path would hand the
    // legs to an idle errand while the body is still travelling.
    ttlMs: baseDeadlineMs * (opts.creditCapFactor ?? 3) + 5_000,
    what: `walking to ${opts.desc ?? fmtPos(target)}`,
    maxWaitMs: opts.maxWaitMs ?? 4_000,
  });
  if (!held) {
    return `LEGS BUSY, did not move: ${lock.lastRefusal ?? 'something outranking this walk owns the legs'}`;
  }
  let creditMs = 0;
  let settled = false;
  let failure: unknown;
  // The poll loop RACES this instead of sleeping blind: a walk that finishes in
  // 30ms must cost 30ms, not a whole poll tick. (Caught by the fish test, which
  // measures how long a cast takes to reach the rod.)
  const done = new Promise<void>((resolve) => {
    void bot.pathfinder.goto(goal as never).then(
      () => { settled = true; resolve(); },
      (e: unknown) => { settled = true; failure = e; resolve(); },
    );
  });
  const t0 = Date.now();
  let anchor = at()?.clone();
  let anchorAt = t0;
  const onDug = () => {
    anchorAt = Date.now();
    creditMs = Math.min(maxCreditMs, creditMs + digCreditMs);
  };
  // Defensive: a body mid-reconnect (or a stub) may not carry the emitter yet —
  // the walk must still be bounded, just without dig credit.
  const canListen = typeof bot.on === 'function' && typeof bot.removeListener === 'function';
  if (canListen) bot.on('diggingCompleted', onDug);
  try {
  while (!settled) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([done, new Promise((r) => { timer = setTimeout(r, pollMs); })]);
    clearTimeout(timer);
    if (settled) break;
    const p = at();
    if (p && anchor && p.distanceTo(anchor) > driftBlocks) { anchor = p.clone(); anchorAt = Date.now(); }
    const elapsed = Date.now() - t0;
    const stalled = Date.now() - anchorAt > stallMs;
    if (stalled || elapsed > baseDeadlineMs + creditMs) {
      try { bot.pathfinder.stop(); bot.pathfinder.setGoal(null); bot.clearControlStates(); } catch { /* body may be mid-swap */ }
      const left = distTo();
      const moved = startPos && p ? p.distanceTo(startPos) : 0;
      const why = stalled
        ? `no real progress for ${Math.round(stallMs / 1_000)}s (moving, but not arriving)`
        : `out of time after ${Math.round(elapsed / 1_000)}s`;
      return `COULD NOT REACH ${opts.desc ?? fmtPos(target)}: ${why} — still ${left.toFixed(0)} blocks away at ${fmtPos(p ?? target)}, ${moved.toFixed(0)}m walked trying. Something the pathfinder cannot solve is in the way (water, a wall, a drop). Dig toward it, approach from another side, or choose a different target — repeating the same walk will hang the same way.`;
    }
  }
  } finally {
    if (canListen) bot.removeListener('diggingCompleted', onDug);
    held.release();
  }
  // A cancelled path gets a NAME. "The goal was changed before it could be
  // completed!" is what the model saw, and it filled the blank itself — the
  // journal read "likely some background disturbance" and "likely from moving
  // between spots too fast", both false, both fed to the supervisor thinker.
  //
  // 🔁 And then it gets RESUMED, right here, without a model round-trip.
  // Live report: every reflex preemption used to end the tool with "re-issue
  // this movement", so each creeper flee cost a full agent turn before the
  // legs tried again — the bot lagged its way toward targets it never reached.
  // The walk is the level that knows the target; the reflex lease is seconds
  // long; so the walk waits the lease out and re-paths to the SAME target,
  // burning walk budget (not model turns) on each retry. Only a walk bumped
  // repeatedly or out of budget reports back — that means the area itself is
  // contested, which IS a decision for the mind (fight, reroute, give up).
  if (failure && isGoalChangedError(failure)) {
    const cause = lock.explainCancellation(owner);
    const resumes = (opts as { _resumes?: number })._resumes ?? 0;
    const budgetLeft = baseDeadlineMs + creditMs - (Date.now() - t0) > 2_000;
    if (resumes < 2 && budgetLeft) {
      // The lease that cancelled us is seconds long — acquire() inside the
      // resumed walk waits it out. Patience must cover the LONGEST lease
      // (dying, 15s), or the resume degrades to "LEGS BUSY, did not move".
      return walkTo(bot, goal, target, {
        ...opts,
        deadlineMs: baseDeadlineMs + creditMs - (Date.now() - t0),
        maxWaitMs: 16_000,
        _resumes: resumes + 1,
      } as typeof opts);
    }
    return `PATH CANCELLED on the way to ${opts.desc ?? fmtPos(target)}: ${cause}${resumes > 0 ? ` — resumed ${resumes}x and got cancelled again` : ''}. The body was dealing with it; nothing you did was wrong. This area is contested: handle the danger deliberately (fight it, wall it off) or route around — you are ${distTo().toFixed(0)} blocks away at ${fmtPos(at() ?? target)}.`;
  }
  if (failure) throw failure;
  return `Arrived near ${opts.desc ?? fmtPos(target)}, now at ${fmtPos(at() ?? target)}`;
}

/** A stack, as any of these counters needs it. */
export interface Stack { name: string; count: number }

/**
 * 🧮 Everything the bot is CARRYING, name → count — the pure core of every
 * "did that work" measurement.
 *
 * Three places an item can be, and all three are the bot's:
 *
 *  - `items()` — main inventory + hotbar, and nothing else.
 *  - offhand (slot 45) and armor (5-8), which live OUTSIDE inventoryStart..End,
 *    so items() never reports them. A torch stack riding in the offhand made the
 *    Δ critic report phantom '-23 torch' / '+23 torch' swings on the live soak.
 *  - the CURSOR — an item in flight during an equip or a chest transfer. This is
 *    the same transient hole that made the sentinel announce four tool breaks in
 *    three minutes (issue #23): bot.equip() walks a stack through the cursor, and
 *    a count taken in that window is short by one stack. On the Δ rail that lie
 *    reads '-1 diamond_pickaxe' — the model is told its gear is GONE, in the very
 *    line that is supposed to be measured truth.
 *
 * An open container's own slots are deliberately NOT counted: a chest's contents
 * are not the bag, and counting them would turn "I stood next to a chest" into
 * a windfall.
 */
export function countCarried(view: {
  items?: Array<Stack | null | undefined>;
  /** Offhand + armor, read from the raw slot array. */
  extraSlots?: Array<Stack | null | undefined>;
  /** The in-flight stack, if the mouse is holding one. */
  cursor?: Stack | null;
}): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (it?: Stack | null) => { if (it) out[it.name] = (out[it.name] ?? 0) + it.count; };
  for (const it of view.items ?? []) add(it);
  for (const it of view.extraSlots ?? []) add(it);
  add(view.cursor);
  return out;
}

/** Slots items() cannot see: offhand, then the four armor pieces. */
export const CARRIED_EXTRA_SLOTS = [45, 5, 6, 7, 8] as const;

/** Read the carried view off a live bot (see countCarried for why each part). */
export function carriedView(bot: Bot): {
  items: Stack[];
  extraSlots: Array<Stack | null | undefined>;
  cursor: Stack | null;
} {
  const inv = bot.inventory as unknown as
    { items?: () => Stack[]; slots?: Array<Stack | null>; selectedItem?: Stack | null } | undefined;
  const win = bot.currentWindow as unknown as { selectedItem?: Stack | null } | null;
  return {
    items: inv?.items?.() ?? [],
    extraSlots: CARRIED_EXTRA_SLOTS.map((s) => inv?.slots?.[s]),
    // While a container is open the cursor belongs to THAT window.
    cursor: win?.selectedItem ?? inv?.selectedItem ?? null,
  };
}

/**
 * 🎒 What the bot carries, name → count. The unit of truth for "did that work".
 */
export function bagCounts(bot: Bot): Map<string, number> {
  return new Map(Object.entries(countCarried(carriedView(bot))));
}

/**
 * 🧾 The bag delta as the model should read it: `+2 raw_iron, +4 dirt, -1 stick`.
 *
 * Live journal 2026-08-17: `Mined 2 iron ore from the first vein at (47,61,68)`
 * — with `[Δ +4 dirt]` and no iron anywhere. `dig_vein` had told it *"Dug 2
 * block(s) of iron_ore. Walked over 2 drop(s)"*, and walking over a drop is not
 * holding it: pickup can fail on a full bag, a drop through a hole, a despawn, or
 * a walk that ended 1.4 blocks short. The tool reported the ACTION and the model
 * reasonably narrated a YIELD, so the plan ('6 more to go') was built on ore it
 * did not have. Same lesson as the craft-desync fix — an action tool must report
 * what the bag says, not what the intent was.
 */
export function bagDelta(before: Map<string, number>, after: Map<string, number>, limit = 6): string {
  const names = new Set([...before.keys(), ...after.keys()]);
  const diffs: Array<[string, number]> = [];
  for (const n of names) {
    const d = (after.get(n) ?? 0) - (before.get(n) ?? 0);
    if (d !== 0) diffs.push([n, d]);
  }
  if (!diffs.length) return 'nothing';
  diffs.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const shown = diffs.slice(0, limit).map(([n, d]) => `${d > 0 ? '+' : ''}${d} ${n}`);
  if (diffs.length > limit) shown.push(`…+${diffs.length - limit} more`);
  return shown.join(', ');
}

/**
 * 🧨 Should the creeper reflex flee — or is fleeing the wrong move entirely?
 *
 * The live report that forced this: a creeper wandering near the chest room
 * kept the bot from EVER reaching its chests. The flee triggered on 3D
 * distance alone, every cooldown, and each flee outranked and cancelled the
 * deliberate walk — a livelock where the spine keeps "saving" the body from
 * a threat it never resolves, and the mind's errand starves forever.
 *
 * Two facts break the loop:
 *
 *  - A creeper only swells when it can SEE its target. One behind a wall or
 *    under the floor is inert — 3D distance alone is not danger. Below
 *    CREEPER_POINT_BLANK we flee anyway: at that range the raycast losing to
 *    a corner-peek costs a life, and one needless flee costs 2 seconds.
 *  - A flee that did not shake the SAME creeper twice will not shake it the
 *    third time — it is camping or following. More fleeing is futile; the
 *    decision (fight it, wall it off, route around, wait it out) belongs to
 *    the mind. The reflex's job degrades to reporting, exactly like the
 *    unstuck reflex learned (issue #8): standing ground against a creeper
 *    that cannot see you, or one you keep out-ranging, is not lethal — but
 *    never reaching your own chests starves every plan.
 */
export type CreeperVerdict =
  | { act: 'flee' }
  | { act: 'ignore'; why: string }
  | { act: 'escalate'; why: string };

/** Below this, flee regardless of line of sight — the raycast may be wrong. */
export const CREEPER_POINT_BLANK = 3.5;

export function creeperVerdict(o: {
  dist: number;
  /** eye-to-eye raycast result; pass true when unknown (fail toward fleeing) */
  lineOfSight: boolean;
  /** flees already spent on THIS creeper within the episode window */
  recentFlees: number;
  futileAfter?: number;
}): CreeperVerdict {
  if (o.dist > CREEPER_POINT_BLANK && !o.lineOfSight) {
    return { act: 'ignore', why: `no line of sight at ${o.dist.toFixed(1)} blocks — a creeper that cannot see you cannot swell` };
  }
  if (o.recentFlees >= (o.futileAfter ?? 2)) {
    return { act: 'escalate', why: `${o.recentFlees} flees have not shaken this creeper — it is camping or following; fleeing again just starves your errand` };
  }
  return { act: 'flee' };
}

/**
 * ⚔️🖐 Issue #46 — the bot fought a whole night bare-fisted and NOTHING ever
 * said so: 120/120 swings "with fists", 4 kills, 5 deaths, while the mind kept
 * planning as if it were armed. `bestMeleeWeapon` already tells the BODY what
 * to hold; this tells the MIND what it is actually holding, as a fact.
 *
 * Mechanism here, judgment there (HARDCODING rule 2): it states held vs best
 * available vs nothing-anywhere, and what a fist actually does. It never says
 * "craft a sword" — the model owns the remedy (craft, retreat, shelter, flee).
 *
 * Pure over item names so tests hand it a bag.
 */
/**
 * 🔨 WHAT THE BAG CAN PAY FOR — issue #47.
 *
 * A 93-minute soak fought bare-handed while holding 13 iron_ingot and sticks,
 * having already crafted a pickaxe and a helmet at its own crafting table. #46
 * made the emptiness of the hand VISIBLE, and the mind read that fact dozens of
 * times and did nothing: a sentence that states a PROBLEM without its REMEDY is
 * noise by the third repetition.
 *
 * Costs are derived from the same family/tier model as `meleeScore`, so a weapon
 * we never enumerated still prices itself: every melee recipe in the game is
 * `n x material + m x stick`, with n/m fixed per family and the material fixed
 * per tier. Netherite is deliberately absent — it is a smithing upgrade, not a
 * crafting-table recipe, so promising it would be a lie.
 */
const MELEE_RECIPE: Record<string, { material: number; sticks: number }> = {
  sword: { material: 2, sticks: 1 },
  axe: { material: 3, sticks: 2 },
  shovel: { material: 1, sticks: 2 },
  pickaxe: { material: 3, sticks: 2 },
  hoe: { material: 2, sticks: 2 },
};

/** The item(s) that pay for a tier. Wooden accepts any species of plank. */
const TIER_MATERIAL: Array<{ label: string; matches: (name: string) => boolean }> = [
  { label: 'planks', matches: (n) => n.endsWith('_planks') },
  { label: 'cobblestone', matches: (n) => n === 'cobblestone' || n === 'cobbled_deepslate' || n === 'blackstone' },
  { label: 'iron_ingot', matches: (n) => n === 'iron_ingot' },
  { label: 'diamond', matches: (n) => n === 'diamond' },
];

/** Sum the counts of every item in the bag that can pay for this tier. */
function materialOnHand(counts: Record<string, number>, tier: number): { have: number; label: string } {
  const spec = TIER_MATERIAL[tier];
  if (!spec) return { have: 0, label: '' };
  let have = 0;
  for (const [name, n] of Object.entries(counts)) if (spec.matches(name)) have += n;
  return { have, label: spec.label };
}

/**
 * ⚒️ The best WEAPON this bag could craft right now, or undefined. Only real
 * weapons (a pickaxe is a fallback, never a goal), only tiers a crafting table
 * can actually make, and the answer carries its own price so the fact can name
 * the arithmetic instead of implying a shopping trip.
 */
export function craftableMelee(
  counts: Record<string, number>,
  intervalMs = 600,
): { item: string; score: number; cost: string } | undefined {
  const sticks = counts.stick ?? 0;
  let best: { item: string; score: number; cost: string } | undefined;
  for (const family of Object.keys(MELEE_RECIPE)) {
    if (!WEAPON_FAMILIES.has(family)) continue; // a hoe is not the answer to anything
    const recipe = MELEE_RECIPE[family];
    if (sticks < recipe.sticks) continue;
    for (const [prefix, tier] of Object.entries(MELEE_TIER)) {
      if (prefix === 'netherite') continue; // smithing, not crafting
      const item = `${prefix}_${family}`;
      const { have, label } = materialOnHand(counts, tier);
      if (!label || have < recipe.material) continue;
      const score = meleeScore(item, intervalMs);
      if (best && score <= best.score) continue;
      best = {
        item,
        score,
        cost: `${recipe.material} ${label} + ${recipe.sticks} stick (you hold ${have} and ${sticks})`,
      };
    }
  }
  return best;
}

/**
 * ⚒️❓ The weapon this bag is CLOSEST to, and exactly what is missing for it.
 *
 * Why this exists: `craftableMelee` answers "can I pay right now?" and returns
 * `undefined` otherwise — so a bot one stick short of a stone sword was told
 * nothing at all. Live evidence (soak29): the mind said "bare-fisted (no
 * sword/axe available, no logs nearby to craft one)" twelve times, fought 33
 * bare-fisted swings and died 4 times, because the only fact it ever got was
 * the ABSENCE of a weapon. An unpayable bill is still news when it names the
 * one item that would settle it.
 *
 * Facts, not orders (HARDCODING.md rule 2): this returns arithmetic — cost,
 * holdings, shortfall, and where the missing handle comes from. It never says
 * to go mining, and it never picks the fight for the mind.
 */
/**
 * 🌲📏 WHAT THE HANDLE COSTS IN BLOCKS — the missing half of #47's remedy.
 *
 * SOAK34, the run this exists for: the armed fact fired 9 times and said, all 9
 * times, exactly this — "No stick, plank or log in the bag — the handle has to
 * come from a tree." The delivery rail worked (ad58caa): the mind READ it and
 * turned it into a journey whose goal was literally "chop the spruce cluster at
 * (-18,71,69), craft a sword". Then it died 10 times in 10 minutes, advanced the
 * journey ONE step (28m of the 60m), and re-planned the same errand from spawn.
 *
 * The bug was never wording or delivery. The shortfall answer is pure BAG
 * arithmetic: it knows what a tree costs in items and nothing about what it
 * costs in blocks or in lives. "Comes from a tree" is the same sentence whether
 * a tree is 4 blocks away or 60 blocks away through a phantom swarm, and those
 * are not the same errand — one is a step, the other is unpayable at 1 damage
 * per swing.
 *
 * So this states the DISTANCE, and when nothing is in range it says that
 * plainly instead of implying an errand exists. Facts, not orders: it never
 * says go, wait, shelter or abandon — the mind owns that call, and now it owns
 * it with the price attached.
 */
export function woodSourceFact(
  nearest: { name: string; distance: number; pos?: { x: number; y: number; z: number } } | undefined,
  radius: number,
): string {
  if (!nearest) {
    return ` No stick, plank or log in the bag, and NO tree within ${radius} blocks of here`
      + ` — nothing in reach can pay for a handle.`;
  }
  const at = nearest.pos ? ` at (${nearest.pos.x}, ${nearest.pos.y}, ${nearest.pos.z})` : '';
  const d = Math.round(nearest.distance);
  // A PLACED PLANK is not a tree and is a shorter errand: mining it returns the
  // plank itself, so the log→plank step is already paid. The live probe found
  // exactly this (the bot's own crafted structure, 8 blocks away) and calling it
  // "a tree" would have priced the errand one step too high.
  if (/_planks$/.test(nearest.name)) {
    return ` No stick, plank or log in the bag — but a placed ${nearest.name} block is ${d} blocks away${at}:`
      + ` mining it returns the plank itself, and 2 planks craft 4 sticks.`;
  }
  return ` No stick, plank or log in the bag — the handle has to come from a tree:`
    + ` the nearest ${nearest.name} is ${d} blocks away${at} (1 log crafts 4 planks, 2 planks craft 4 sticks).`;
}

/**
 * How far a wood scan looks. Mechanism, not policy, so it takes no env knob
 * (HARDCODING rule 1): 64 blocks is roughly the loaded-column horizon, so a
 * miss means "not in the world I can see", which is itself the fact the mind
 * needs. Anything further is a journey and prices itself as one.
 */
export const WOOD_SCAN_RADIUS = 64;

/** Does this block name carry wood a handle can be made from? Structure, not a list. */
export function isWoodSource(name: string | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return /_(log|wood|planks|stem|hyphae)$/.test(n) || n === 'bamboo_block';
}

/**
 * The nearest wood in the LOADED world, or undefined. Live-body half of
 * `woodSourceFact`; every failure is an honest undefined, never a guess.
 */
export function probeWoodSource(
  bot: {
    entity?: { position?: { x: number; y: number; z: number; distanceTo?: (p: unknown) => number } };
    registry?: { blocksByName?: Record<string, { id: number } | undefined> };
    findBlock?: (opts: { matching: number[]; maxDistance: number }) => { name?: string; position?: { x: number; y: number; z: number } } | null;
  },
  radius = WOOD_SCAN_RADIUS,
): { name: string; distance: number; pos: { x: number; y: number; z: number } } | undefined {
  try {
    const byName = bot.registry?.blocksByName;
    if (!byName || !bot.findBlock || !bot.entity?.position) return undefined;
    const ids: number[] = [];
    for (const [name, b] of Object.entries(byName)) if (b && isWoodSource(name)) ids.push(b.id);
    if (!ids.length) return undefined;
    const found = bot.findBlock({ matching: ids, maxDistance: radius });
    if (!found?.position || !found.name) return undefined;
    const me = bot.entity.position;
    const p = found.position;
    const distance = Math.sqrt((p.x - me.x) ** 2 + (p.y - me.y) ** 2 + (p.z - me.z) ** 2);
    return { name: found.name, distance, pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } };
  } catch {
    return undefined; // a probe that throws must not silence the armed fact
  }
}

export function meleeShortfall(
  counts: Record<string, number>,
  intervalMs = 600,
  /** The world's answer about wood, when a live body could be asked. Omitted =
   * the fact stays bag-only rather than inventing a distance. */
  wood?: { nearest?: { name: string; distance: number; pos?: { x: number; y: number; z: number } }; radius?: number; probed?: boolean },
): { item: string; missing: string; line: string } | undefined {
  const sticks = counts.stick ?? 0;
  // A stick is two planks, a plank is a log: the handle's supply chain is a
  // FACT the bag already implies, and the mind kept concluding "no logs" while
  // standing on the answer.
  let planks = 0;
  let logs = 0;
  for (const [name, n] of Object.entries(counts)) {
    if (name.endsWith('_planks')) planks += n;
    else if (name.endsWith('_log') || name.endsWith('_stem') || name.endsWith('_hyphae')) logs += n;
  }
  let best: { item: string; missing: string; line: string; gap: number; tier: number; score: number } | undefined;
  for (const family of Object.keys(MELEE_RECIPE)) {
    if (!WEAPON_FAMILIES.has(family)) continue; // a hoe is not the answer to anything
    const recipe = MELEE_RECIPE[family];
    for (const [prefix, tier] of Object.entries(MELEE_TIER)) {
      if (prefix === 'netherite') continue; // smithing, not crafting
      const item = `${prefix}_${family}`;
      const { have, label } = materialOnHand(counts, tier);
      if (!label) continue;
      const needMat = Math.max(0, recipe.material - have);
      const needStick = Math.max(0, recipe.sticks - sticks);
      const gap = needMat + needStick;
      if (gap === 0) continue; // craftableMelee owns the payable case
      const score = meleeScore(item, intervalMs);
      // Nearest first. A tie goes to the CHEAPEST TIER, not the best weapon:
      // "2 diamonds" and "2 cobblestone" are both two missing items and are not
      // remotely the same errand, and a bill the bot cannot plausibly settle is
      // the same dead end as saying nothing. Within a tier, harder hitter wins.
      if (best && (best.gap < gap
        || (best.gap === gap && best.tier < tier)
        || (best.gap === gap && best.tier === tier && best.score >= score))) continue;
      const missingParts: string[] = [];
      if (needMat > 0) missingParts.push(`${needMat} more ${label}`);
      if (needStick > 0) missingParts.push(`${needStick} more stick`);
      const missing = missingParts.join(' + ');
      const handle = needStick > 0
        ? planks >= 2
          ? ` You hold ${planks} planks: 2 planks craft 4 sticks.`
          : logs >= 1
            ? ` You hold ${logs} log(s): 1 log crafts 4 planks, 2 planks craft 4 sticks.`
            // The bag cannot pay for the handle, so the WORLD is the answer — and
            // its price is a distance (soak34: the same tree-less sentence 9 times
            // while the tree was 60 blocks away through a phantom swarm).
            : wood?.probed
              ? woodSourceFact(wood.nearest, wood.radius ?? WOOD_SCAN_RADIUS)
              : ' No stick, plank or log in the bag — the handle has to come from a tree.'
        : '';
      best = {
        item, missing, gap, tier, score,
        line: `NEAREST WEAPON: a ${item} costs ${recipe.material} ${label} + ${recipe.sticks} stick; you hold ${have} ${label} and ${sticks} stick — MISSING ${missing}.${handle}`,
      };
    }
  }
  return best ? { item: best.item, missing: best.missing, line: best.line } : undefined;
}

/**
 * 🛡 Is this item actually ARMOUR? Structure, not a list — same rule as the
 * melee score.
 *
 * The live bot caught this one itself: `list_inventory` reported `Armour:
 * spruce_log`. `readArmed` trusted inventory slots 5-8 to contain armour
 * because that is what the window layout says, and a stray stack in one of
 * those indices (an open window, a shifted slot, a server that packs them
 * differently) became a claim the mind then reasoned with — a log is not a
 * helmet, and #46 exists precisely to stop the armed fact from inventing
 * equipment.
 */
export function isArmorPiece(itemName: string | undefined): boolean {
  if (!itemName) return false;
  const n = itemName.toLowerCase();
  return /_(helmet|chestplate|leggings|boots)$/.test(n) || n === 'turtle_helmet' || n === 'elytra';
}

export function armedFact(input: {
  held?: string;
  inventory: string[];
  armorPieces?: string[];
  /** Item name → how many, for the craftable REMEDY (#47). Optional: without it
   * the fact simply stays silent about crafting rather than guessing amounts. */
  counts?: Record<string, number>;
  /** What the WORLD says about wood, when a live body could be asked (#47): the
   * shortfall's handle sentence then carries a distance instead of implying that
   * some tree, somewhere, is an errand this bot can afford. */
  wood?: { nearest?: { name: string; distance: number; pos?: { x: number; y: number; z: number } }; radius?: number; probed?: boolean };
}): {
  armed: boolean;      // holding something better than a bare fist
  held: string;        // 'fists' or the item in hand
  best?: string;       // strongest melee weapon anywhere in the bag
  inBag: boolean;      // a weapon exists but is NOT in hand
  craftable?: string;  // a better weapon the bag can pay for right now (#47)
  nearest?: string;    // the weapon the bag is CLOSEST to, when none is payable
  line: string;        // one sentence of facts, safe to paste into a note
} {
  const held = input.held && input.held.length ? input.held : undefined;
  const best = bestProperWeapon(input.inventory);
  // #47: the remedy, and only when it is one — a craftable weapon that beats
  // the best thing the bot already owns. Naming a wooden sword to a bot holding
  // an iron one is the kind of noise that made #46's fact ignorable.
  const owned = meleeScore(best ?? held, 600);
  const craft = input.counts ? craftableMelee(input.counts) : undefined;
  const remedy = craft && craft.score > owned
    ? ` CRAFTABLE: a ${craft.item} (${craft.cost}) at any crafting table.`
    : '';
  // When nothing is payable, the SHORTFALL is the news — silence is what let a
  // whole session pass bare-fisted with the mind concluding "crafting is
  // impossible" (soak29). Only for a bot that has no real weapon at all: a bot
  // holding an iron sword does not need a shopping list.
  const gap = !remedy && !best && input.counts ? meleeShortfall(input.counts, 600, input.wood) : undefined;
  const shortfall = gap ? ` ${gap.line}` : '';
  const heldIsWeapon = isProperWeapon(held);
  // Only real armour may be claimed as armour: the slots are where armour LIVES,
  // not proof that what sits there IS armour (the live bot reported a spruce_log).
  const armorPieces = (input.armorPieces ?? []).filter((a) => isArmorPiece(a));
  const armor = armorPieces.length ? armorPieces.join(', ') : 'NONE';
  // A fist does 1 damage (0.5 hearts). Naming the arithmetic is what turns
  // "with fists" from a label into a decision the mind can make.
  const fistMath = 'a bare fist does 1 damage, so a 20-hp mob takes ~20 connected hits';
  if (!heldIsWeapon) {
    return best
      ? {
          armed: false, held: held ?? 'fists', best, inBag: true, craftable: remedy ? craft?.item : undefined,
          nearest: gap?.item,
          line: `ARMED: ${held ? `${held} (not a weapon)` : 'FISTS'} — a ${best} IS in your inventory but is not in your hand (${fistMath}).${remedy}${shortfall} Armour: ${armor}.`,
        }
      : {
          armed: false, held: held ?? 'fists', best: undefined, inBag: false, craftable: remedy ? craft?.item : undefined,
          nearest: gap?.item,
          line: `ARMED: ${held ? `${held} (not a weapon)` : 'FISTS'} — NO sword, axe or trident anywhere in your inventory (${fistMath}).${remedy}${shortfall} Armour: ${armor}.`,
        };
  }
  const better = best && best !== held ? ` (a ${best} in your bag hits harder)` : '';
  return {
    armed: true, held: held as string, best, inBag: !!best && best !== held, craftable: remedy ? craft?.item : undefined,
    line: `ARMED: ${held}${better}.${remedy} Armour: ${armor}.`,
  };
}

/**
 * The armed state read off a LIVE body — the one place that knows where a
 * mineflayer bot keeps its hand (`heldItem`) and its armour (inventory slots
 * 5-8: helmet, chestplate, leggings, boots). Issue #46 needs this fact in three
 * unrelated places (the fight note, dusk, the death note), and three copies of
 * the slot arithmetic is how they drift apart.
 */
export function readArmed(bot: {
  heldItem?: { name?: string } | null;
  inventory?: { items: () => Array<{ name: string; count?: number }>; slots?: Array<{ name?: string } | null | undefined> };
  entity?: { position?: { x: number; y: number; z: number } };
  registry?: { blocksByName?: Record<string, { id: number } | undefined> };
  findBlock?: (opts: { matching: number[]; maxDistance: number }) => { name?: string; position?: { x: number; y: number; z: number } } | null;
}): ReturnType<typeof armedFact> {
  const items = bot.inventory?.items() ?? [];
  // #47 needs AMOUNTS, and mineflayer's items() are stacks: two stacks of 32
  // iron are one name and 64 ingots. `count` is optional here so a test can hand
  // in bare names; a stack without a count is worth at least the one item.
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.name] = (counts[i.name] ?? 0) + (i.count ?? 1);
  // #47's second half: only a LIVE body can price the handle, so the one reader
  // that has a body asks the world. `probed` says the question was actually put
  // (a body without findBlock stays silent rather than claiming "no tree").
  const canProbe = typeof bot.findBlock === 'function' && !!bot.registry?.blocksByName && !!bot.entity?.position;
  const wood = canProbe
    ? { nearest: probeWoodSource(bot), radius: WOOD_SCAN_RADIUS, probed: true }
    : undefined;
  return armedFact({
    held: bot.heldItem?.name,
    inventory: items.map((i) => i.name),
    counts,
    wood,
    armorPieces: (bot.inventory?.slots ?? []).slice(5, 9).map((i) => i?.name).filter((n): n is string => !!n),
  });
}

// ---- death-site memory (#35) ------------------------------------------------
/**
 * 💀 One death is an accident. The third death at the same coordinate is a
 * PLACE, and nothing in the old announcement said so.
 *
 * Soak36 died four times: `💀 died at 1, 67, 30` three times in a row, then
 * `💀 died at -2, 66, 30` five blocks away. Every one of those four notes was
 * the same sentence — "think about what killed you before walking into it
 * again" — so the mind was told to think about a thing it had no record of.
 * The waypoint rail did not help either: the death handler saves the spot as
 * `last_death`, and `writePlace` REPLACES a name, so each death erased the
 * evidence that the previous one had happened here.
 *
 * The fact has to carry a consequence, not a count (the #46 fist-arithmetic
 * lesson): a life here is worth N minutes, and the gear from the earlier
 * deaths is already gone, so a corpse-run recovers one life's worth at best.
 */
export interface DeathRecord {
  x: number;
  y: number;
  z: number;
  /** epoch ms — a wall clock, because the interval between deaths IS the news */
  at: number;
  /** the death message if the server sent one; absent is normal, never invented */
  cause?: string;
  dimension?: string;
  /**
   * The CONDITIONS of the death, so a cluster can name what its deaths share.
   * All optional and never invented: a field that was not read stays absent and
   * the fact says nothing about it, because "0 armour pieces" and "we did not
   * look" must not read the same (#48's rule applied to a snapshot).
   */
  armour?: number;
  /** was it night/thundering at the moment of death — mobs spawn on the surface then */
  night?: boolean;
  /** what the mind was doing: the journey goal, trimmed. A spiral usually has one. */
  doing?: string;
}

export interface DeathSiteRepeat {
  /** deaths inside the cell and the window, this one included (>= 2) */
  count: number;
  /** first → latest of those deaths */
  spanMs: number;
  radius: number;
  /** the earliest death of the cluster: the spot that has been killing us */
  centre: { x: number; y: number; z: number };
  /** distinct causes, newest first — only ones the server actually named */
  causes: string[];
  /**
   * How many deaths of the cluster named ANY cause. "every one of them: zombie"
   * is only true when this equals `count`; a live probe caught the fact making
   * that claim over one attributed death and three silent ones.
   */
  attributed: number;
  /** how long ago each EARLIER pile fell, newest first */
  priorPileAgesMs: number[];
  /**
   * What EVERY death of this cluster had in common — the remedy half of #35.
   * "You died again" is a count; "all 4 of them with no armour, after dark, at
   * y 58-64" names the thing to change. Only unanimous conditions appear: a
   * condition that held for some deaths and not others is not a cause, and a
   * condition nobody recorded is absent rather than false.
   */
  shared: string[];
}

/** Drops despawn 5 minutes after they hit the ground — vanilla, not a knob. */
export const DROP_DESPAWN_MS = 300_000;

/**
 * What the whole cluster agrees on. Unanimity is the test, and a missing field
 * abstains WITHOUT vetoing: three recorded deaths with no armour still say
 * "no armour" when a fourth, older row predates the field.
 */
export function sharedConditions(cluster: DeathRecord[]): string[] {
  const out: string[] = [];
  const known = <T>(pick: (d: DeathRecord) => T | undefined) =>
    cluster.map(pick).filter((v): v is T => v !== undefined);

  const armour = known((d) => d.armour);
  if (armour.length >= 2) {
    if (armour.every((n) => n === 0)) out.push('not one armour piece worn');
    else if (armour.every((n) => n < 4)) out.push(`never more than ${Math.max(...armour)} of 4 armour pieces`);
  }

  const night = known((d) => d.night);
  if (night.length >= 2 && night.every((n) => n)) out.push('every one after dark');
  else if (night.length >= 2 && night.every((n) => !n)) out.push('every one in daylight — this is not a night problem');

  const ys = cluster.map((d) => d.y);
  const lo = Math.min(...ys); const hi = Math.max(...ys);
  if (hi - lo <= 4) out.push(hi <= 62 ? `all of them underground at y ${lo === hi ? lo : `${lo}-${hi}`}` : `all of them at y ${lo === hi ? lo : `${lo}-${hi}`}`);

  const doing = known((d) => d.doing);
  if (doing.length >= 2 && new Set(doing).size === 1) out.push(`every one during the same job: "${doing[0]}"`);

  return out;
}

/**
 * Pure: is this death a repeat of a place? `history` is every death we have on
 * record (the latest one excluded), so the caller can hand in the store's own
 * contents and the answer is the store's truth, never our intent (#48).
 */
export function deathSiteRepeat(
  history: DeathRecord[],
  latest: DeathRecord,
  o: { radius?: number; windowMs?: number } = {},
): DeathSiteRepeat | undefined {
  const radius = o.radius ?? 6;
  const windowMs = o.windowMs ?? 45 * 60_000;
  const near = history.filter((d) => {
    if (d.at > latest.at) return false; // a clock that went backwards is not evidence
    if (latest.at - d.at > windowMs) return false;
    if (d.dimension && latest.dimension && d.dimension !== latest.dimension) return false;
    return Math.hypot(d.x - latest.x, d.y - latest.y, d.z - latest.z) <= radius;
  }).sort((a, b) => a.at - b.at);
  if (near.length === 0) return undefined;
  const first = near[0];
  const causes: string[] = [];
  for (const d of [latest, ...near.slice().reverse()]) {
    if (d.cause && !causes.includes(d.cause)) causes.push(d.cause);
  }
  return {
    count: near.length + 1,
    spanMs: latest.at - first.at,
    radius,
    centre: { x: first.x, y: first.y, z: first.z },
    causes,
    attributed: [latest, ...near].filter((d) => !!d.cause).length,
    priorPileAgesMs: near.slice().reverse().map((d) => latest.at - d.at),
    shared: sharedConditions([...near, latest]),
  };
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Durations a note can carry: seconds under 2 min, else minutes. */
export function spanWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)}h`;
}

/**
 * The sentence itself. Returns '' for a first death at a place — silence is
 * the honest report when there is no repeat, and a note that says the same
 * thing every time teaches the mind to skip it (src/web.ts:233's discipline).
 */
export function deathSiteFact(repeat: DeathSiteRepeat | undefined): string {
  if (!repeat) return '';
  const { count, spanMs, radius, centre, causes, attributed, priorPileAgesMs, shared } = repeat;
  const parts = [
    `This is your ${ordinal(count)} death within ${radius} blocks of ${fmtPos(centre)} in ${spanWords(spanMs)}`,
  ];
  // Unanimity has to be EARNED, and silence is not agreement: a cluster where
  // one death named a zombie and three named nothing used to read "every one of
  // them: zombie", which is the mind's cause of death invented for it (#48).
  if (causes.length === 1 && attributed === count) parts.push(`, every one of them: ${causes[0]}`);
  else if (causes.length === 1) parts.push(`, and the ${attributed === 1 ? 'one death we identified' : `${attributed} we identified`} of them: ${causes[0]} (the other ${count - attributed} named nothing)`);
  else if (causes.length > 1) parts.push(` (causes named for ${attributed} of ${count}: ${causes.slice(0, 3).join('; ')})`);
  parts.push(`. A life at this spot has been lasting ~${spanWords(spanMs / (count - 1))}.`);
  const gone = priorPileAgesMs.filter((ms) => ms >= DROP_DESPAWN_MS).length;
  const live = priorPileAgesMs.length - gone;
  if (gone > 0) {
    parts.push(` The gear from ${gone === 1 ? 'the earlier death' : `${gone} earlier deaths`} here has already despawned (drops last ~5 min), so a corpse-run recovers one life's worth at most.`);
  }
  if (live > 0) {
    parts.push(` ${live === 1 ? 'One earlier pile' : `${live} earlier piles`} fell ${priorPileAgesMs.filter((ms) => ms < DROP_DESPAWN_MS).map((ms) => spanWords(ms)).join(' and ')} ago and may still be on the ground next to this one.`);
  }
  if (shared.length) {
    parts.push(` What every one of these deaths had in common: ${shared.join('; ')}.`);
  }
  parts.push(' Nothing about this place has changed by itself — what changes (armour first, a different approach, sealing it off, or writing the spot off) is your call.');
  return parts.join('');
}

/**
 * 🍞 THE STARVATION REMEDY (issue #34, soak41).
 *
 * The bot ended a 90-minute soak at 0.166 hp on a sandbar, food 13, zero food
 * items, journey stopped, asking a HUMAN 63 blocks away to "please bring any
 * food fast". Waiting on a human is not a survival strategy, and the mind was
 * not confused about the arithmetic — it had said out loud that regeneration
 * needs food ≥ 18. What it never had was a PAYABLE remedy: which edible thing
 * is actually reachable from HERE, at what price, and — at 0.16 hp — which of
 * those it can pay without taking one more hit.
 *
 * Same shape as `meleeShortfall`/`woodSourceFact` (the #46/#47 pattern that
 * worked): the fact names the cost, the holdings and the shortfall, and when a
 * live body could be asked it carries the DISTANCE. Cheapest-and-safest wins,
 * because at 1 hp the best remedy is worthless if paying for it kills you.
 *
 * Ranking, at low health, is by what the payment COSTS in damage risk:
 *  - eat what is in the bag (free, instant),
 *  - fish (stand still on the shore — the only remedy that requires no contact),
 *  - forage a crop/berry (a walk, no fight),
 *  - kill an animal (a chase and possibly a hit taken),
 *  - nothing reachable — which is a fact worth saying plainly instead of
 *    implying an errand that does not exist.
 */
export const FOOD_SCAN_RADIUS = 48;

/** Hunger at or above this regenerates health; below it, health only falls. */
export const REGEN_FOOD = 18;

export interface FoodSighting { name: string; distance: number; pos?: { x: number; y: number; z: number } }

export interface FoodWorld {
  /** Nearest water, i.e. a fishing spot. */
  water?: FoodSighting;
  /** Nearest edible-on-the-block plant: berries, melon, crops. */
  crop?: FoodSighting;
  /** Nearest killable food animal. */
  animal?: FoodSighting;
  /** Was a live body actually asked? Omitted/false = no distances invented. */
  probed?: boolean;
  radius?: number;
  /**
   * WHERE the probe stood when it measured. A distance is only true relative to
   * a position, so the pair travels together — otherwise a sighting measured in
   * one place can be read out loud in another as "3 blocks away" while the
   * coordinate beside it is 90 blocks off (the #47 class, in the food rail).
   */
  at?: { x: number; y: number; z: number };
}

/** Craft cost of a fishing rod: 3 sticks + 2 string (planks → sticks). */
export function rodShortfall(counts: Record<string, number>): { missing: string } | undefined {
  const sticks = counts.stick ?? 0;
  const string = counts.string ?? 0;
  let planks = 0;
  for (const [name, n] of Object.entries(counts)) if (/_planks$/.test(name)) planks += n;
  const sticksFromPlanks = Math.floor(planks / 2) * 4;
  const missSticks = Math.max(0, 3 - (sticks + sticksFromPlanks));
  const missString = Math.max(0, 2 - string);
  if (!missSticks && !missString) return undefined;
  const parts: string[] = [];
  if (missSticks) parts.push(`${missSticks} more stick${missSticks === 1 ? '' : 's'}`);
  if (missString) parts.push(`${missString} more string (kill a spider)`);
  return { missing: parts.join(' and ') };
}

export function foodRemedy(o: {
  food: number;
  health: number;
  /** item name → count */
  counts: Record<string, number>;
  world?: FoodWorld;
  /**
   * Where the body is NOW, at the moment the remedy is spoken. Given both this
   * and a sighting's coordinate, the distance is DERIVED from the coordinate
   * instead of quoted from whenever the sighting was taken — so the two numbers
   * in the sentence can never disagree, and a remembered sighting reprices
   * itself instead of lying.
   */
  at?: { x: number; y: number; z: number };
}): { line: string; act: 'eat' | 'fish' | 'forage' | 'hunt' | 'none' } {
  const missing = Math.max(0, REGEN_FOOD - o.food);
  const bag = Object.entries(o.counts).flatMap(([n, c]) => (c > 0 ? [n] : []));
  const edible = bestFood(bag, Math.max(1, 20 - o.food));
  const desperate = o.health <= 5;
  // 0.166 hp printed as '0.2' rounds a life up; below 1 hp the second decimal is
  // the difference between dying and not.
  const hp = o.health < 1 ? o.health.toFixed(2) : o.health.toFixed(1);
  const head = `Food ${o.food}/20; health regenerates only at ${REGEN_FOOD}+, so I am ${missing} short of healing at all.`;
  if (edible) {
    return { act: 'eat', line: `${head} PAYABLE NOW: eat the ${edible.replace(/_/g, ' ')} already in my bag — no errand, no risk.` };
  }
  const risky = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'chicken'].find((n) => (o.counts[n] ?? 0) > 0);
  const w = o.world;
  // Named ONCE: the live probe printed "water water 15 blocks away" because the
  // caller supplied the noun and the pricer repeated it. A remedy the mind reads
  // out loud cannot afford a stutter.
  const from = o.at ?? w?.at;
  const where = (s: FoodSighting) => {
    if (!s.pos) {
      // No coordinate to re-measure against: say the number is remembered
      // rather than dressing it up as a fresh reading.
      return `${s.distance.toFixed(0)} blocks away as last measured (no coordinate to check it against)`;
    }
    const d = from
      ? Math.sqrt((s.pos.x - from.x) ** 2 + (s.pos.y - from.y) ** 2 + (s.pos.z - from.z) ** 2)
      : s.distance;
    return `${d.toFixed(0)} blocks away at (${s.pos.x},${s.pos.y},${s.pos.z})`;
  };
  const price = (s: FoodSighting) => `${s.name.replace(/_/g, ' ')} ${where(s)}`;
  /**
   * 🍖 A REMEDY THAT NEEDS AN ITEM THE BAG CANNOT BUY IS NOT A REMEDY.
   *
   * soak43, at 1.3 hp: `STARVING with nothing edible in the bag — Food 16/20 …
   * FISH would be safest (water 8 blocks away) but the rod is unpayable:
   * MISSING 3 more sticks and 2 more string (kill a spider)` — and then the mind
   * held perfectly still for TEN consecutive journey steps and asked the human
   * for a food drop. Every number in that sentence was true. The ADVICE was a
   * dead end, because the option it LED with was the one option the body could
   * not take, and the cheapest route it could take today was never named.
   *
   * So every route carries whether it is PAYABLE NOW, and payability outranks
   * safety and distance: an unpayable route can only ever be a footnote ("not
   * until you have X"), never the lead. Which payable route to take is still the
   * model's call — this only refuses to lead with a fantasy.
   */
  type Route = { act: 'eat' | 'fish' | 'forage' | 'hunt'; line: string; payable: boolean; blocker?: string };
  const options: Route[] = [];
  if (risky) {
    // Poison in the bag is a worse meal than a berry and a better one than
    // starving to death — and, unlike a rod, it costs nothing to obtain.
    options.push({ act: 'eat', payable: true, line: `EAT THE ${risky.replace(/_/g, ' ').toUpperCase()} IN MY BAG — it is the only food I can have in my mouth this second; the poison costs hp, an errand costs minutes I may not have` });
  }
  if (w?.water) {
    const rod = (o.counts.fishing_rod ?? 0) > 0;
    const short = rod ? undefined : rodShortfall(o.counts);
    if (rod) options.push({ act: 'fish', payable: true, line: `FISH: water is ${where(w.water)} and I hold a fishing rod — casting costs no contact with anything that hits back, which is the only kind of errand I can afford at ${hp} hp` });
    else if (!short) options.push({ act: 'fish', payable: true, line: `FISH: water is ${where(w.water)} and a rod is craftable from what I hold (3 sticks + 2 string)` });
    else options.push({ act: 'fish', payable: false, blocker: short.missing, line: `FISH (water ${where(w.water)}) — NOT UNTIL I have ${short.missing}` });
  }
  if (w?.crop) options.push({ act: 'forage', payable: true, line: `FORAGE: ${price(w.crop)} — a walk, no fight, and nothing to craft first` });
  // A passive animal does not hit back: bare fists are payment enough, which is
  // exactly why this must outrank a rod the bag cannot afford.
  if (w?.animal) options.push({ act: 'hunt', payable: true, line: `HUNT: ${price(w.animal)} — a chase with bare fists is enough for it, and a hit taken is likely${desperate ? `, which at ${hp} hp is one hit from death` : ''}` });
  const payable = options.filter((r) => r.payable);
  const blocked = options.filter((r) => !r.payable);
  const footnote = blocked.length ? ` Not until I have what they cost: ${blocked.map((r) => r.line).join(' | ')}.` : '';
  if (!payable.length) {
    const scanned = w?.probed ? ` Nothing I can pay for within ${w.radius ?? FOOD_SCAN_RADIUS} blocks.` : '';
    return { act: 'none', line: `${head}${scanned}${footnote} There is no errand here I can afford, so the honest plan is to TRAVEL — pick a direction with grass or water and go, and stop asking anyone to bring food: nobody is coming.` };
  }
  // Among the routes it CAN pay for: at low health the safest leads, otherwise
  // the nearest kind of errand does. Eating what is already in hand always wins.
  const rank: Record<string, number> = desperate ? { eat: -1, fish: 0, forage: 1, hunt: 2 } : { eat: -1, forage: 0, fish: 1, hunt: 2 };
  payable.sort((a, z) => rank[a.act]! - rank[z.act]!);
  const lead = payable[0]!;
  const rest = payable.slice(1).map((o2) => o2.line).join(' | ');
  const why = desperate ? ` At ${hp} hp the SAFEST remedy wins, not the best one.` : '';
  return { act: lead.act, line: `${head}${why} PAYABLE NOW: ${lead.line}${rest ? ` — otherwise: ${rest}` : ''}.${footnote}` };
}

/** Live-body half of `foodRemedy`: what the loaded world actually offers. */
export function probeFoodWorld(
  bot: {
    entity?: { position?: { x: number; y: number; z: number } };
    registry?: { blocksByName?: Record<string, { id: number } | undefined> };
    findBlock?: (opts: { matching: number[]; maxDistance: number }) => { name?: string; position?: { x: number; y: number; z: number } } | null;
    entities?: Record<string, { name?: string; position?: { x: number; y: number; z: number } } | undefined>;
  },
  radius = FOOD_SCAN_RADIUS,
): FoodWorld {
  const out: FoodWorld = { probed: true, radius };
  const me = bot.entity?.position;
  if (!me) return { probed: false, radius };
  out.at = { x: me.x, y: me.y, z: me.z };
  const dist = (p: { x: number; y: number; z: number }) => Math.sqrt((p.x - me.x) ** 2 + (p.y - me.y) ** 2 + (p.z - me.z) ** 2);
  const idsFor = (pred: (n: string) => boolean): number[] => {
    const byName = bot.registry?.blocksByName ?? {};
    const ids: number[] = [];
    for (const [name, b] of Object.entries(byName)) if (b && pred(name)) ids.push(b.id);
    return ids;
  };
  try {
    if (bot.findBlock) {
      const water = idsFor((n) => n === 'water');
      const found = water.length ? bot.findBlock({ matching: water, maxDistance: radius }) : null;
      if (found?.position) out.water = { name: 'water', distance: dist(found.position), pos: { x: Math.round(found.position.x), y: Math.round(found.position.y), z: Math.round(found.position.z) } };
      const cropIds = idsFor((n) => ['sweet_berry_bush', 'melon', 'pumpkin', 'wheat', 'carrots', 'potatoes', 'beetroots', 'cave_vines_plant', 'cave_vines'].includes(n));
      const crop = cropIds.length ? bot.findBlock({ matching: cropIds, maxDistance: radius }) : null;
      if (crop?.position && crop.name) out.crop = { name: crop.name, distance: dist(crop.position), pos: { x: Math.round(crop.position.x), y: Math.round(crop.position.y), z: Math.round(crop.position.z) } };
    }
  } catch { /* a probe that throws must not silence the fact */ }
  try {
    const meat = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'salmon', 'cod', 'mooshroom', 'goat']);
    let best: FoodSighting | undefined;
    for (const e of Object.values(bot.entities ?? {})) {
      if (!e?.position || !e.name || !meat.has(e.name)) continue;
      const d = dist(e.position);
      if (d > radius) continue;
      if (!best || d < best.distance) best = { name: e.name, distance: d, pos: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) } };
    }
    if (best) out.animal = best;
  } catch { /* same */ }
  return out;
}

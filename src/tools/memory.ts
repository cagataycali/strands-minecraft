/**
 * 🧠 Cross-session memory — waypoints that survive a process restart.
 *
 * The bot's conversation history dies with the process; the world doesn't.
 * "Where did I build the cabin?" should not depend on whether the terminal
 * stayed open. This is deliberately tiny: named places in one JSON file
 * (~/.strands-minecraft/memory.json), shared by every bot the process runs —
 * the primary remembers "home", a hired worker can recall it and walk there.
 *
 * File-on-every-write, read-on-every-recall: no cache to go stale when the
 * primary and a worker (or a second process) write interleaved. The file is
 * human-readable on purpose — the player can edit or delete a waypoint with
 * a text editor and the bot just sees it.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cfg } from '../config.js';
import { fmtPos, deathSiteRepeat, deathSiteFact, spanWords, isArmorPiece, type DeathRecord, type DeathSiteRepeat } from './helpers.js';

export interface Place {
  name: string;
  x: number;
  y: number;
  z: number;
  note?: string;
  savedAt: string; // ISO — "how stale is this?" matters in a changing world
  savedBy: string; // which bot wrote it (primary or a worker)
}

const DIR = process.env.MEMORY_DIR ?? join(homedir(), '.strands-minecraft');
const FILE = join(DIR, 'memory.json');

/**
 * Read-only view for rails that aren't the agent — the sentinel checks
 * whether a chest being opened sits near a saved waypoint ("is that MY
 * base?") without mounting the whole tool surface.
 */
export function loadPlaces(): Place[] {
  return load();
}

function load(): Place[] {
  const places = readStore().places;
  return Array.isArray(places) ? (places as Place[]) : [];
}

/**
 * The whole file, as an object. One file holds several INDEPENDENT lists
 * (places, deaths, and whatever a later rail adds), and each writer only knows
 * about its own — so every write has to start from what is already on disk.
 */
function readStore(): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {}; // no file yet, or hand-edited into invalid JSON — start clean, never crash
  }
}

/**
 * Merge one list into the file and keep every other key.
 *
 * #35 lived here, not in the arithmetic: `save({ places })` served waypoints
 * correctly and silently DELETED `deaths` on every call — and the death handler
 * calls recordDeath and then writePlace('last_death'), in that order, on every
 * single death. So the store was truncated to zero deaths microseconds after
 * each one was written: soak37 died 20 times in 17 minutes (three of them at
 * the identical block -12,64,4) and memory.json still held `{"places":[...]}`
 * and NOTHING else. The repeat-death rail could never fire, because the history
 * it reads back was erased by its own caller's next line.
 *
 * A writer that rewrites the file from only the part it understands is the
 * same class of bug as narrating an intent instead of reading the world back
 * (#48): the write "succeeded", and the fact it destroyed was invisible.
 */
function patchStore(patch: Record<string, unknown>) {
  mkdirSync(DIR, { recursive: true });
  // Write-then-rename: a crash mid-write must not eat every waypoint.
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...readStore(), ...patch }, null, 2));
  renameSync(tmp, FILE);
}

function save(places: Place[]) {
  patchStore({ places });
}

/**
 * Programmatic write for rails that aren't the agent — the death handler
 * saves 'last_death' the instant it happens, because an agent that has to
 * remember to remember its death position usually doesn't (it's busy dying).
 */
export function writePlace(name: string, pos: { x: number; y: number; z: number }, note: string, savedBy: string): Place {
  const place: Place = {
    name: name.trim().toLowerCase(),
    x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z),
    note, savedAt: new Date().toISOString(), savedBy,
  };
  const places = load().filter((p) => p.name !== place.name);
  places.push(place);
  save(places);
  return place;
}

/**
 * 💀 Death-site memory (#35). Deaths live in the SAME file as waypoints but in
 * their own list, because a waypoint is a name and `writePlace` replaces a
 * name: saving every death as 'last_death' meant each death erased the proof
 * that the previous one happened in the same room.
 *
 * The count is read BACK out of the file after the write, so the sentence the
 * mind gets is what the store actually holds — not what this process meant to
 * append (the false-green class, #48).
 */
export function loadDeaths(): DeathRecord[] {
  const deaths = readStore().deaths;
  return Array.isArray(deaths) ? (deaths as DeathRecord[]) : [];
}

/**
 * The last thing that damaged us, and when. mineflayer's 'death' event says
 * nothing about the cause, so the hurt rail — which already knows the attacker
 * from the 1.20+ damage_event source — hands it over here and the death handler
 * reads it back. Module state on purpose: one body, one death at a time.
 */
let lastDamage: { by: string; at: number } | undefined;

export function noteDamageSource(by: string, at = Date.now()) {
  lastDamage = { by, at };
}

/**
 * The conditions of a death, read off the live body at the moment it happens —
 * #35's remedy half. A cluster of deaths that all share "no armour, after dark"
 * names what to CHANGE; a count only says it happened again. Every field is
 * optional and omitted when it could not be read, never defaulted: a snapshot
 * we failed to take must not read as a snapshot that says zero.
 */
export function deathContext(bot: {
  inventory?: { slots?: Array<{ name?: string } | null | undefined> };
  time?: { isDay?: boolean };
  isRaining?: boolean;
}, o: { doing?: string; now?: number } = {}): { cause?: string; armour?: number; night?: boolean; doing?: string } {
  const now = o.now ?? Date.now();
  const slots = bot.inventory?.slots;
  const armour = Array.isArray(slots)
    ? slots.slice(5, 9).filter((i) => isArmorPiece(i?.name)).length
    : undefined;
  const isDay = bot.time?.isDay;
  const fresh = lastDamage && now - lastDamage.at <= cfg.deaths.causeFreshMs ? lastDamage.by : undefined;
  return {
    ...(fresh ? { cause: fresh } : {}),
    ...(armour === undefined ? {} : { armour }),
    ...(typeof isDay === 'boolean' ? { night: !isDay } : {}),
    ...(o.doing ? { doing: o.doing.trim().slice(0, 60) } : {}),
  };
}

export function recordDeath(
  pos: { x: number; y: number; z: number },
  o: { at?: number; cause?: string; dimension?: string; armour?: number; night?: boolean; doing?: string } = {},
): { record: DeathRecord; repeat: DeathSiteRepeat | undefined; fact: string; kept: number } {
  const record: DeathRecord = {
    x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z),
    at: o.at ?? Date.now(),
    ...(o.cause ? { cause: o.cause } : {}),
    ...(o.dimension ? { dimension: o.dimension } : {}),
    ...(o.armour === undefined ? {} : { armour: o.armour }),
    ...(typeof o.night === 'boolean' ? { night: o.night } : {}),
    ...(o.doing ? { doing: o.doing } : {}),
  };
  const before = loadDeaths();
  const deaths = [...before, record].slice(-cfg.deaths.keep);
  try {
    patchStore({ deaths });
  } catch { /* a death we could not write down is still a death — never crash the respawn */ }
  // Read the file back: if the write failed, the history is what survived, and
  // the sentence must be built from that rather than from our optimistic array.
  const stored = loadDeaths();
  // Identify the row we just appended by its POSITION, not by its value. Two
  // deaths can be identical: the replay of soak36 caught it immediately — deaths
  // 2 and 3 landed at (1,67,30) inside the same 30s clock tick, a value filter
  // treated the earlier one as "me", and the third death announced itself as the
  // second. An identity that another row can satisfy is not an identity.
  const last = stored[stored.length - 1];
  const isMine = (d: DeathRecord | undefined) =>
    !!d && d.at === record.at && d.x === record.x && d.y === record.y && d.z === record.z;
  const history = isMine(last)
    ? stored.slice(0, -1)
    // The write did not survive (read-only disk, hand-edited file): count from
    // what IS there rather than pretending our row exists.
    : stored;
  const repeat = deathSiteRepeat(history, record, {
    radius: cfg.deaths.sameSiteRadius,
    windowMs: cfg.deaths.windowMs,
  });
  return { record, repeat, fact: deathSiteFact(repeat), kept: stored.length };
}

/** Repeat sites worth naming when the mind asks what it remembers. */
export function deathSiteDigest(now = Date.now()): string {
  const deaths = loadDeaths();
  const lines: string[] = [];
  const seen = new Set<number>();
  for (let i = deaths.length - 1; i >= 0; i -= 1) {
    if (seen.has(i)) continue;
    const d = deaths[i];
    const cluster = deaths.filter((o, j) => j !== i && Math.hypot(o.x - d.x, o.y - d.y, o.z - d.z) <= cfg.deaths.sameSiteRadius);
    if (cluster.length === 0) continue;
    deaths.forEach((o, j) => { if (Math.hypot(o.x - d.x, o.y - d.y, o.z - d.z) <= cfg.deaths.sameSiteRadius) seen.add(j); });
    lines.push(`${cluster.length + 1} deaths within ${cfg.deaths.sameSiteRadius} blocks of ${fmtPos(d)} (last one ${spanWords(now - d.at)} ago)`);
  }
  return lines.length ? `💀 Death sites: ${lines.slice(0, 4).join('; ')}.` : '';
}

export function memoryTools(bot: Bot) {
  const rememberPlace = tool({
    name: 'remember_place',
    description:
      "Save a named waypoint to persistent memory — it survives restarts and is shared with worker bots. Defaults to your CURRENT position; pass x/y/z to save somewhere else. Re-using a name updates it. Use for anything you'll want to find again: home, the cabin, a village, a mine entrance, where the player died.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Short handle, e.g. 'home', 'cabin', 'iron_mine'"),
      note: z.string().optional().describe("Why it matters, e.g. 'chest with all the iron'"),
      x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
    }),
    callback: ({ name, note, x, y, z }) => {
      const pos = bot.entity?.position;
      if ((x === undefined || y === undefined || z === undefined) && !pos)
        throw new Error('No position: pass x/y/z explicitly (bot not spawned yet).');
      const place: Place = {
        name: name.trim().toLowerCase(),
        x: Math.floor(x ?? pos!.x), y: Math.floor(y ?? pos!.y), z: Math.floor(z ?? pos!.z),
        note, savedAt: new Date().toISOString(), savedBy: bot.username ?? 'unknown',
      };
      const places = load().filter((p) => p.name !== place.name);
      places.push(place);
      save(places);
      return `Remembered '${place.name}' at ${fmtPos(place)}${note ? ` — ${note}` : ''}. It survives restarts; recall_places lists everything.`;
    },
  });

  const recallPlaces = tool({
    name: 'recall_places',
    description:
      'List saved waypoints from persistent memory (name, position, distance from you, note, when saved). Check here BEFORE asking where something is or re-exploring — past sessions may already know. Then go_to the coordinates.',
    inputSchema: z.object({
      query: z.string().optional().describe('Filter by substring of name/note (omit for all)'),
    }),
    callback: ({ query }) => {
      let places = load();
      if (query) {
        const q = query.toLowerCase();
        places = places.filter((p) => p.name.includes(q) || p.note?.toLowerCase().includes(q));
      }
      if (!places.length) return query ? `No saved place matches '${query}'.` : 'No places saved yet — remember_place stores the current spot.';
      const here = bot.entity?.position;
      return places.map((p) => ({
        name: p.name,
        position: { x: p.x, y: p.y, z: p.z },
        distance: here ? +here.distanceTo(here.clone().set(p.x, p.y, p.z)).toFixed(0) : undefined,
        note: p.note,
        savedAt: p.savedAt,
        savedBy: p.savedBy,
      }));
    },
  });

  const forgetPlace = tool({
    name: 'forget_place',
    description: 'Delete a saved waypoint by name (see recall_places for names).',
    inputSchema: z.object({ name: z.string().min(1) }),
    callback: ({ name }) => {
      const places = load();
      const key = name.trim().toLowerCase();
      const rest = places.filter((p) => p.name !== key);
      if (rest.length === places.length) {
        const names = places.map((p) => p.name).join(', ');
        throw new Error(`No place named '${key}'. Saved: ${names || 'nothing'}`);
      }
      save(rest);
      return `Forgot '${key}'.`;
    },
  });

  return [rememberPlace, recallPlaces, forgetPlace];
}

/**
 * 🛑 HUD helpers — pure, inlined into the page via `fn.toString()` (tsx strips
 * the types; keep the bodies ES2019 and dependency-free, see veil.ts).
 */

/** What the toast says after POST /api/stop. `stopped` is the server's list. */
export function stopReceipt(r: { ok?: boolean; stopped?: string[]; error?: string } | null | undefined): string {
  if (!r || r.ok === false) return 'stop failed' + (r && r.error ? ': ' + r.error : '');
  var list = r.stopped || [];
  if (!list.length) return 'nothing was moving \u2014 the body is still';
  return 'stopped ' + list.join(', ') + ' \u2014 a turn mid-thought finishes its step';
}

/** Minecraft day ticks → a wall clock ('06:00' at tick 0) and the part of day. */
export function mcClock(ticks: number): { hhmm: string; part: 'dawn' | 'day' | 'dusk' | 'night' } {
  var t = ((ticks % 24000) + 24000) % 24000;
  var h = Math.floor(((t / 1000) + 6) % 24);
  var m = Math.floor((t % 1000) / 1000 * 60);
  var hhmm = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  var part: 'dawn' | 'day' | 'dusk' | 'night' = t < 1000 ? 'dawn' : t < 12000 ? 'day' : t < 13500 ? 'dusk' : t < 23000 ? 'night' : 'dawn';
  return { hhmm: hhmm, part: part };
}

export interface VitalChip { k: string; v: string; tone?: 'warn' | 'bad' }
export interface Vitals { state: string; stale: boolean; chips: VitalChip[] }

/**
 * The vitals strip under the video, from /api/telemetry. Honest about age: a
 * sample older than `staleMs` (or no sample at all) is marked stale instead of
 * showing yesterday's hearts as today's. Only what matters makes a chip —
 * air only underwater, hostiles only when there are some.
 */
export function vitalsModel(t: any, now: number, staleMs?: number): Vitals {
  var limit = staleMs || 15000;
  if (!t || typeof t !== 'object') return { state: 'no telemetry yet', stale: true, chips: [] };
  var stale = typeof t.ts === 'number' ? now - t.ts > limit : true;
  var chips: VitalChip[] = [];
  var conn = t.connection || {};
  if (conn.connected === false) chips.push({ k: 'body', v: 'not in the world', tone: 'bad' });
  if (t.time) {
    var c = mcClock(t.time.ticks || 0);
    chips.push({ k: 'time', v: 'day ' + t.time.day + ' \u00b7 ' + c.hhmm + ' ' + c.part, tone: c.part === 'night' ? 'warn' : undefined });
  }
  if (t.weather && t.weather !== 'clear') chips.push({ k: 'weather', v: t.weather, tone: t.weather === 'thunder' ? 'warn' : undefined });
  if (t.dimension) chips.push({ k: 'where', v: String(t.dimension).replace(/^minecraft:/, '') + (t.biome ? ' \u00b7 ' + String(t.biome).replace(/_/g, ' ') : '') });
  if (typeof t.xp === 'number') chips.push({ k: 'xp', v: 'lvl ' + t.xp });
  if (typeof t.air === 'number' && t.air < 20) chips.push({ k: 'air', v: t.air + '/20', tone: t.air <= 6 ? 'bad' : 'warn' });
  if (t.held) chips.push({ k: 'held', v: String(t.held) });
  var hostiles = (t.nearby && t.nearby.hostiles) || [];
  if (hostiles.length) {
    var nearest = hostiles[0];
    chips.push({ k: 'hostiles', v: hostiles.length + ' near \u00b7 ' + nearest.name.replace(/_/g, ' ') + ' ' + nearest.dist + 'm', tone: nearest.dist <= 8 ? 'bad' : 'warn' });
  }
  var players = (t.nearby && t.nearby.players) || [];
  if (players.length) chips.push({ k: 'players', v: players.map(function (p: any) { return p.name + ' ' + p.dist + 'm'; }).slice(0, 3).join(', ') });
  var task = t.task || {};
  var state = task.kind && task.kind !== 'idle' && task.text ? task.text : 'idle';
  if (task.since_s > 0 && state !== 'idle') state += ' \u00b7 ' + (task.since_s < 60 ? task.since_s + 's' : Math.floor(task.since_s / 60) + 'm');
  return { state: state, stale: stale, chips: chips };
}

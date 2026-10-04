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

/**
 * Every `system` event used to be painted alarm-red — boot banners, memory
 * census lines and camera receipts alike, so a real alarm looked like
 * everything else. Only lines that carry an alarm word stay red.
 */
export function systemTone(text: string): 'alert' | 'quiet' {
  return /\b(error|fail(ed|ure)?|kicked|died|death|stop(ped)?|crash|oom|stuck|dropped|🚨|⛔|intruder|disconnect)/i.test(text || '') ? 'alert' : 'quiet';
}

export interface InvRow { name: string; label: string; count: number; held: boolean }
/**
 * 🎒 The bag, from telemetry.inventory (name+count, already merged per item)
 * and telemetry.held ('torch x64'). Sorted by count, human labels, the held
 * item first and marked.
 */
export function inventoryModel(items: Array<{ name: string; count: number }> | null | undefined, held?: string | null): { rows: InvRow[]; total: number; stacks: number } {
  var heldName = held ? String(held).replace(/ x\d+$/, '') : '';
  var rows: InvRow[] = (items || []).filter(function (i) { return i && i.name && i.count > 0; }).map(function (i) {
    return { name: i.name, label: i.name.replace(/_/g, ' '), count: i.count, held: i.name === heldName };
  });
  rows.sort(function (a, b) { return (b.held ? 1 : 0) - (a.held ? 1 : 0) || b.count - a.count || (a.name < b.name ? -1 : 1); });
  var total = 0;
  for (var k = 0; k < rows.length; k++) total += rows[k].count;
  return { rows: rows, total: total, stacks: rows.length };
}

/** Card title/subtitle for a journey or worker: the GOAL, not the random id. */
export function crewTitle(c: { kind: string; name: string; goal?: string | null; steps?: number }): { title: string; sub: string } {
  var goal = (c.goal || '').trim();
  if (!goal) return { title: c.name, sub: '#' + (c.steps || 0) };
  return { title: goal.length > 90 ? goal.slice(0, 87) + '\u2026' : goal, sub: c.name + ' \u00b7 #' + (c.steps || 0) };
}

/**
 * 🧹 What a feed row shows. The agent's INPUT echo carries rail prefixes meant
 * for the model, not the reader: "(from X via the web dashboard) status?" and
 * 'X says in game chat: "hi"' — the latter is a duplicate of the `chat` row
 * that arrived a moment earlier. Returns null when the row should not render.
 */
export function displayText(ev: { kind: string; who?: string; text: string }, chatShown: boolean): string | null {
  var t = ev.text || '';
  if (ev.kind !== 'in') return t;
  var web = /^\(from [^)]+ via the web dashboard\) /.exec(t);
  if (web) return t.slice(web[0].length);
  var game = /^(.+?) says in game chat: "([\s\S]*)"$/.exec(t);
  if (game) return chatShown ? null : game[1] + ': ' + game[2];
  return t;
}

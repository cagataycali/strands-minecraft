import type { Bot } from 'mineflayer';

/**
 * 🛑 The body-level STOP — the same three calls the stop_moving tool makes
 * (tools/movement.ts) plus stopDigging. index.ts wraps this with the journey
 * stop; a bare web rail (tests, smoke) gets exactly this.
 */
export function stopBody(bot: Partial<Bot>): string[] {
  const stopped: string[] = [];
  try { bot.pathfinder?.stop(); bot.pathfinder?.setGoal(null); stopped.push('pathfinder'); } catch { /* mid-swap */ }
  try { bot.clearControlStates?.(); stopped.push('controls'); } catch { /* mid-swap */ }
  try { if (bot.targetDigBlock) { bot.stopDigging?.(); stopped.push('digging'); } } catch { /* nothing to stop */ }
  return stopped;
}

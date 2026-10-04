/**
 * 🤫 Staying silent — a turn whose words never reach game chat.
 *
 * The chat rail used to send the model's final text to game chat no matter
 * what it said, so "nothing to add — staying silent" was itself a chat line
 * (the owner watched two bots announce their silence to each other). The fix
 * is a TOOL, not a regex: `stay_silent` marks the current turn, and the rail
 * logs the answer to the dashboard instead of saying it. The marker lives in
 * an AsyncLocalStorage scope opened around session.ask(), so concurrent
 * (forked) turns cannot silence each other.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface TurnScope { silent: boolean; reason?: string }

const scope = new AsyncLocalStorage<TurnScope>();

/** Run one turn inside its own silence scope; returns the result plus the flag. */
export async function withTurnScope<T>(fn: () => Promise<T>): Promise<{ result: T; silent: boolean; reason?: string }> {
  const s: TurnScope = { silent: false };
  const result = await scope.run(s, fn);
  return { result, silent: s.silent, reason: s.reason };
}

/** Called by the stay_silent tool from inside a turn. Outside any turn it is a no-op that says so. */
export function markSilent(reason?: string): boolean {
  const s = scope.getStore();
  if (!s) return false;
  s.silent = true;
  if (reason) s.reason = reason.slice(0, 120);
  return true;
}

/** Is the current async context a turn that chose silence? */
export function isSilent(): boolean {
  return scope.getStore()?.silent === true;
}

/** What the rail does with a finished chat turn. Pure, for the tests and the log line. */
export function chatDisposition(answer: string, silent: boolean): { say: boolean; log: string } {
  if (silent) return { say: false, log: `🤫 (silent) ${answer}` };
  return { say: answer.trim().length > 0, log: `🤖 ${answer}` };
}

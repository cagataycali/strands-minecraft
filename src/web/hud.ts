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

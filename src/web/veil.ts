/**
 * 🎥 What the veil over the video should say — pure, so every case is a test.
 *
 * The <img> for an MJPEG stream has no per-frame events and no error semantics
 * worth trusting, so the page reads /api/state every 5 s and decides here. The
 * old veil had ONE sentence, "reconnecting…", shown for a 30 s camera warm-up,
 * for a kicked bot and for a dead tunnel alike. /api/state already carries the
 * truth for each (`camera`, `connected`, `frames`); this folds them into one
 * line, in the order a human would want to hear them.
 *
 * Inlined into the served page via `veilFor.toString()` — tsx strips the types,
 * so the SAME function runs in the browser. Keep it dependency-free and ES2019.
 */
export interface VeilInput {
  /** /api/state failed (tunnel or dashboard down); nothing below is known. */
  unreachable?: boolean;
  /** bot.entity exists — the body is in the world. */
  connected?: boolean | null;
  /** describeCamera() sentence from /api/state. */
  camera?: string | null;
  /** The frame counter froze across ≥2 polls while we were watching. */
  stalled?: boolean;
  /** The <img> fired `error`. */
  imgError?: boolean;
  /** Watching, and the server's frame counter has not moved since we started. */
  noFrameYet?: boolean;
}
export interface Veil { show: boolean; text: string; tone: 'quiet' | 'warn' | 'bad'; spin: boolean }

export function veilFor(s: VeilInput): Veil {
  if (s.unreachable) return { show: true, text: 'dashboard unreachable \u2014 retrying', tone: 'bad', spin: true };
  if (s.connected === false) return { show: true, text: 'bot is not in the world \u2014 reconnecting to the server', tone: 'bad', spin: true };
  var cam = s.camera || '';
  if (cam.indexOf('broken') === 0) return { show: true, text: 'camera ' + cam, tone: 'bad', spin: false };
  if (cam.indexOf('warming') === 0) {
    var m = /\((\d+)s\)/.exec(cam);
    return { show: true, text: 'camera warming up' + (m ? ' \u00b7 ' + m[1] + 's' : '') + ' \u2014 first frame takes ~30 s', tone: 'quiet', spin: true };
  }
  if (s.stalled || s.imgError) return { show: true, text: 'stream stalled \u2014 reconnecting', tone: 'warn', spin: true };
  if (s.noFrameYet) return { show: true, text: 'connecting to the camera\u2026', tone: 'quiet', spin: true };
  return { show: false, text: '', tone: 'quiet', spin: false };
}

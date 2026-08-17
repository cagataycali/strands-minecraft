/**
 * 🩺 Event-loop lag, watched — because the Minecraft protocol runs on it.
 *
 * The soak found the dashboard camera getting the bot KICKED (issue #18): the
 * first watcher triggered a lazy warm-up (prismarine-viewer booting in-process
 * plus a headless Chrome launch), `/api/state` went from sub-300ms to one
 * no-response and then 6.2s, and moments later the vanilla server dropped us with
 * `disconnect.timeout` — the keep-alive we owe it every few seconds is answered
 * by a handler on this same event loop, so starving the loop is indistinguishable
 * from a dead client. The next write hit the closed socket (EPIPE) and the
 * reconnect rail brought the body back three seconds later.
 *
 * That is the same failure class as the darkness survey blocking the 300ms reflex
 * tick (issue #4), and it will happen again for a new reason: anything that hogs
 * the loop puts the bot's connection at risk, and nothing was watching for it.
 * So sample the loop, and say so — with the consequence named, not just a number,
 * because "lag 4200ms" does not tell an operator their bot is about to be kicked.
 *
 * A sampler cannot fix starvation; it makes it attributable. When a kick follows
 * one of these lines, the cause is no longer a mystery to be re-derived from
 * packet timestamps.
 */
import { heapLimitMb } from './memcheck.js';

/** Vanilla's keep-alive tolerance is ~30s; a loop stalled anywhere near that is
 *  gambling with the connection, and the read-timeout side is tighter still. */
export const KEEPALIVE_RISK_MS = 5_000;
/** Below this, lag is just a busy process doing its job. */
export const LAG_NOTICE_MS = 1_000;

export interface LagVerdict {
  /** Is this worth telling anyone? */
  report: boolean;
  /** 'notice' — busy. 'risk' — the connection itself is in danger. */
  level: 'quiet' | 'notice' | 'risk';
  text: string;
}

/**
 * Pure: a measured stall becomes a verdict with its consequence spelled out.
 *
 * Every lag line also carries the heap, because the loudest stall we ever
 * recorded was not load at all: a 4,338 ms stop-the-world scavenge at 4,050MB
 * of a 4,144MB cap, moments before the process died of OOM (issue #44). Read
 * without the heap, that line accused the fleet workers of hogging the loop
 * (issue #37) — a false cause pointing at innocent code. When the heap is
 * nearly full, GC is named as the more likely author.
 */
export function classifyLag(
  lagMs: number,
  o: { culprit?: string; heapUsedBytes?: number; heapCapMb?: number } = {},
): LagVerdict {
  const where = o.culprit ? ` (while ${o.culprit})` : '';
  const s = (lagMs / 1_000).toFixed(1);
  const heapMb = o.heapUsedBytes === undefined ? undefined : Math.round(o.heapUsedBytes / 1024 ** 2);
  const full = heapMb !== undefined && o.heapCapMb !== undefined && heapMb >= o.heapCapMb * 0.85;
  const heap = heapMb === undefined
    ? ''
    : ` · heap ${heapMb}MB${o.heapCapMb ? ` of ${o.heapCapMb}MB cap` : ''}` +
      (full
        ? ' — the heap is nearly full, so this is most likely a stop-the-world GC rather than load: look for a leak, not a busy worker (issue #44)'
        : '');
  if (lagMs >= KEEPALIVE_RISK_MS) {
    return {
      report: true,
      level: 'risk',
      text:
        `event loop stalled ${s}s${where} — the Minecraft keep-alive is answered on this loop, ` +
        `so a stall like this is what gets the bot kicked with disconnect.timeout (issue #18). ` +
        `Whatever is hogging the process must yield.${heap}`,
    };
  }
  if (lagMs >= LAG_NOTICE_MS) {
    return { report: true, level: 'notice', text: `event loop lag ${s}s${where} — reflexes and the keep-alive share this loop${heap}` };
  }
  return { report: false, level: 'quiet', text: '' };
}

export interface LoopWatch {
  /** Worst lag seen, for /api/state — a stall nobody was watching still counts. */
  worst: () => { lagMs: number; at: number } | undefined;
  stop: () => void;
}

/**
 * Start sampling. Lag is measured the only way it can be from inside: schedule a
 * timer for `sampleMs` and see how late it actually fires.
 *
 * `culprit` lets a caller name what is running (the camera warm-up sets it), so
 * the line accuses something instead of merely complaining.
 */
export function startLoopWatch(o: {
  emit: (v: LagVerdict) => void;
  sampleMs?: number;
  culprit?: () => string | undefined;
  now?: () => number;
  /** Injected for tests; defaults to real timers. */
  schedule?: (fn: () => void, ms: number) => { unref?: () => void; cancel: () => void };
}): LoopWatch {
  const sampleMs = o.sampleMs ?? 500;
  // Read once: the cap cannot change, and a lag line must not pay for a v8 call.
  const heapCap = heapLimitMb();
  const now = o.now ?? (() => Date.now());
  const schedule = o.schedule ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { cancel: () => clearTimeout(t) };
  });
  let handle: { cancel: () => void } | undefined;
  let stopped = false;
  let worst: { lagMs: number; at: number } | undefined;
  // Edge-triggered per EPISODE, the same discipline as the sentinel's notes: one
  // stall makes many samples fire late in a row (the loop is still catching up),
  // and twenty identical lines are worse than one. Re-arm only after a punctual
  // sample proves the process is breathing again.
  let armed = true;

  const tick = (expected: number) => {
    if (stopped) return;
    const t = now();
    const lag = t - expected;
    if (lag > 0 && (!worst || lag > worst.lagMs)) worst = { lagMs: lag, at: t };
    const v = classifyLag(lag, {
      culprit: o.culprit?.(),
      heapUsedBytes: process.memoryUsage().heapUsed,
      heapCapMb: heapCap,
    });
    if (!v.report) armed = true;
    else if (armed) {
      armed = false;
      o.emit(v);
    }
    arm();
  };

  // The deadline is computed WHEN WE ARM, not when the callback runs — the whole
  // measurement is "how late is this timer", and reading the clock inside the
  // late callback would define the lag away.
  const arm = () => {
    const expected = now() + sampleMs;
    handle = schedule(() => tick(expected), sampleMs);
  };

  arm();
  return {
    worst: () => worst,
    stop: () => {
      stopped = true;
      handle?.cancel();
    },
  };
}

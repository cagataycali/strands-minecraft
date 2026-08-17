/**
 * 🌐 Web rail — the bot's life, watchable from a phone.
 *
 * minecraft.yourdomain.com (Cloudflare tunnel → localhost:3008). One server, four
 * jobs, same topology as neon's dashboard (browser → tunnel → local port):
 *
 *   GET  /               phone-first SPA (inline — no build step to babysit)
 *   GET  /stream.mjpeg   first-person video: JPEG frames from the SAME
 *                        headless page capture_view screenshots. MJPEG because
 *                        iOS Safari plays it in a bare <img> — no WebRTC, no
 *                        MSE, no player code that can rot.
 *   GET  /events         SSE feed of everything the agent hears/says/does —
 *                        every rail reports here (chat, CLI, voice, journeys,
 *                        thinker, fleet). EventSource auto-reconnects.
 *   POST /api/say        a message INTO the agent — just another rail through
 *                        session.ask, so it forks/folds like chat and voice.
 *
 * Auth: WebAuthn passkeys (web/auth.ts) — everything but / and /auth/* needs
 * the session cookie. Face ID is the login.
 */
import http from 'node:http';
import { writeHeapSnapshot } from 'node:v8';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Bot } from 'mineflayer';
import { getCameraPage } from './tools/vision.js';
import * as auth from './web/auth.js';
import { WARMING_JPEG, WARMING_PULSE_MS, mjpegPart } from './web/warming-frame.js';
import { PAGE_HTML } from './web/page.js';
import { WebSocketTransport, transportFactories, type TransportFactories } from './realtime/transport.js';
import { cfg } from './config.js';
import { botCreateOptions } from './bot.js';
import { memoryProbe, heapLimitMb, confirmedAliveNames, census, type MemorySample } from './memcheck.js';
import {
  tinyToken, tinyTokenProblem, presentedToken, tokenMatches, createRateLimiter, shapeTelemetry,
  chatWaitMs, chatPrompt, type TelemetryExtras,
} from './web/tiny.js';

const PORT = Number(process.env.WEB_PORT ?? 3008);
const FRAME_MS = Number(process.env.WEB_FRAME_MS ?? 350); // ~3fps: phone-friendly, tunnel-friendly
const FEED_CAP = cfg.web.feedCap;

/** One heap snapshot at a time: each one stops the world while it writes. */
let snapshotInFlight = false;

// App icons for Add-to-Home-Screen: pixel-art grass block, pre-rendered to
// PNG (iOS ignores SVG here) and inlined so the page stays dependency-free.
const ICON_180 = Buffer.from(
  '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',
  'base64'
);
const ICON_512 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAABmJLR0QA/wD/AP+gvaeTAAAJr0lEQVR4nO3YMWodVxiG4TjcRliYC1dGIDUG96nSydvwGrKT7EFryDaSKq5MmhQGNRIIS3ALgUpnB6cR+B/nfZ4VfMyZGV7Oq9dvzr79BACk/Dw9AAD4/gQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgKDd9IC6X//4MD1h6fzibHrC0v3dw/QEwnwfL/Pp45/TE9LcAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAELSbHlB3fnE2PWHp/u5hesLS8fZpesLS/vJ0esKS9+9ltr5v6+fLLDcAABAkAAAgSAAAQJAAAIAgAQAAQQIAAIIEAAAECQAACBIAABAkAAAgSAAAQJAAAIAgAQAAQQIAAIIEAAAECQAACBIAABAkAAAgSAAAQJAAAIAgAQAAQQIAAIIEAAAECQAACBIAABAkAAAgSAAAQJAAAIAgAQAAQQIAAIIEAAAECQAACBIAABAk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',
  'base64'
);

const MANIFEST = JSON.stringify({
  name: 'StrandsBot',
  short_name: 'StrandsBot',
  description: "The bot's life, live from the world",
  start_url: '/',
  display: 'standalone',
  background_color: '#0b0e14',
  theme_color: '#0b0e14',
  icons: [
    { src: '/icon-180.png', sizes: '180x180', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
});

export interface FeedEvent {
  ts: number;
  kind: 'in' | 'out' | 'journey' | 'thought' | 'worker' | 'chat' | 'system' | 'voice';
  who: string;
  text: string;
  /**
   * For an `in`, its say id; for an `out`, the id of the ask it ANSWERS.
   *
   * Positional pairing ("the next out belongs to the last in") held only while
   * one rail talked at a time. With journeys, the thinker and the sentinel all
   * narrating, the soak observer read a journey's furnace report as the reply to
   * its own fleet question (issue #25) — the counts looked healthy, 12 in and 12
   * out, and the pairing was still wrong. An answer now names the question, and
   * self-driven narration carries no id at all, so it can never impersonate a
   * reply to someone.
   */
  replyTo?: string;
}

/**
 * 🧾 Receipts for human messages (issue #20).
 *
 * `POST /api/say` answers `202 {ok:true}` and runs the turn afterwards — right,
 * because a long agent turn times a phone's fetch out. The cost is that the POST
 * can no longer report anything, so the ONLY record of a message's fate is
 * whatever the say path logs. In the live soak two of four says vanished
 * completely: acknowledged, never answered, never refused, no error line
 * anywhere. Both arrived while the session was busy.
 *
 * Note what made them invisible rather than merely slow: `log()` writes to the
 * SSE ring and to connected clients, and nothing else. With no phone attached
 * (`watchers: 0` for the whole soak) the `catch` around `onSay` wrote its error
 * into a 300-event in-memory ring that nobody was reading. A swallowed exception
 * and a dropped message were indistinguishable BY CONSTRUCTION.
 *
 * So every say now gets an id and three receipts — queued, answered/failed, and
 * "still running" while it is neither — and they go to the console as well as the
 * feed. A slow turn then looks slow instead of looking lost, which is the whole
 * difference for someone holding a phone.
 *
 * Pure over an injected clock so the escalation is testable without waiting.
 */
export interface SayLedger {
  start: (text: string) => string;
  finish: (id: string, outcome?: { error?: unknown }) => void;
  /** Emit a "still running" line for anything past the watchdog. */
  sweep: () => void;
  pending: () => Array<{ id: string; ageMs: number; text: string }>;
}

/**
 * What a rail's RESOLVED value says about the turn's outcome.
 *
 * Every rail in index.ts runs through one wrapper that CATCHES its own errors —
 * it must, or a bad chat message would take the process down. The cost is that
 * `await onSay(...)` resolves normally even when the turn died, and the receipt
 * then reported success for a failure: the live soak printed
 * `say-7 answered after 1s` for a turn killed by the empty-text 400, with no
 * `out` event anywhere in the feed (issue #39). A green receipt for a bricked
 * mind is worse than no receipt — it tells the operator to stop looking.
 *
 * So the resolved value is allowed to carry the failure: `{ error }` (or a
 * plain `{ ok: false }`) means the turn failed, and the receipt says FAILED.
 * A rail that returns nothing is still treated as success, exactly as before.
 */
export function sayOutcome(resolved: unknown): { error: unknown } | undefined {
  const r = resolved as { error?: unknown; ok?: unknown } | null | undefined;
  if (r && typeof r === 'object') {
    if (r.error !== undefined && r.error !== null) return { error: r.error };
    if (r.ok === false) return { error: 'the rail reported failure without naming it' };
  }
  return undefined;
}

export function createSayLedger(o: {
  emit: (text: string) => void;
  watchdogMs?: number;
  now?: () => number;
  maxWarnings?: number;
  /**
   * Turns in flight (session.busy). This is the EVIDENCE that separates a slow
   * turn from a lost one, and the watchdog used to decide without it.
   *
   * The soak caught the cost (issue #33): say-7 was declared "the drop case,
   * re-send if it still matters" at 398s while the bot was visibly walking and
   * taking phantom damage — and it answered, correctly and completely, at 619s.
   * Following that advice would have forked a duplicate turn onto a mind that
   * was already working, 3½ minutes before the real answer landed.
   *
   * So a drop is now only ever claimed when nothing is running at all. While
   * something IS in flight the receipt keeps saying "still running", however
   * long that takes — the elapsed time was always the useful part.
   */
  busy?: () => number;
  /** Optional one line on WHY it is slow, for a turn that has been alive
   *  `sinceMs`: "3 reflex interrupts and a fight" beats a bare timer. */
  why?: (sinceMs: number) => string | undefined;
  /**
   * How long the rail waits before it stops waiting (issue #41). Past this the
   * say is declared ABANDONED and dropped from the ledger: the receipt is
   * honest, and the `active` slot + text stop being retained forever.
   */
  deadlineMs?: number;
}): SayLedger {
  const now = o.now ?? (() => Date.now());
  const watchdogMs = o.watchdogMs ?? cfg.web.sayWatchdogMs;
  const deadlineMs = o.deadlineMs ?? cfg.web.sayDeadlineMs;
  const maxWarnings = o.maxWarnings ?? 3;
  const open = new Map<string, {
    at: number; text: string; warnings: number; lastWarnAt: number;
    /** Order of arrival — the basis of the overtake proof below. */
    seq: number;
    /** A LATER say that already answered, if one has: this ask's own evidence. */
    overtakenBy?: string;
  }>();
  let n = 0;
  const secs = (ms: number) => Math.round(ms / 1_000);
  const brief = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);
  return {
    start: (text) => {
      const id = `say-${++n}`;
      open.set(id, { at: now(), text, warnings: 0, lastWarnAt: 0, seq: n });
      o.emit(`${id} queued: "${brief(text)}"`);
      return id;
    },
    finish: (id, outcome) => {
      const rec = open.get(id);
      open.delete(id);
      // THE PER-ASK EVIDENCE (issue #41): this say has answered, so every say
      // that was sent EARLIER and is still open is not waiting in a queue
      // behind a busy mind — the mind demonstrably took a later ask and
      // finished it. The soak's proof was exactly this shape: say-1 open
      // 1,598s while say-2, sent six minutes later, answered in 47s. The
      // session-wide busy() count could never see that; the ledger can, from
      // its own bookkeeping, with no help from the session.
      if (rec) for (const older of open.values()) if (older.seq < rec.seq) older.overtakenBy = id;
      const took = rec ? `after ${secs(now() - rec.at)}s` : 'after an unknown time';
      if (outcome?.error !== undefined) {
        const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        // The one case the old code hid: the turn threw and only a feed nobody
        // was watching heard about it.
        o.emit(`${id} FAILED ${took}: ${msg}`);
      } else {
        o.emit(`${id} answered ${took}`);
      }
    },
    sweep: () => {
      const t = now();
      // Asked ONCE per sweep, not per say: a mind with two asks in flight is
      // working on both, and the count is the same evidence for each.
      const inFlight = o.busy?.();
      for (const [id, rec] of open) {
        const age = t - rec.at;
        if (age < watchdogMs) continue;
        // The deadline comes FIRST and ignores the escalation schedule: an ask
        // this old is over, whatever the session says about being busy, and a
        // rail that keeps it open keeps pinning its history fork (issue #41).
        if (age >= deadlineMs) {
          open.delete(id);
          o.emit(
            `${id} ABANDONED after ${secs(age)}s — past the ${secs(deadlineMs)}s deadline with no answer, so the web rail has stopped waiting for "${brief(rec.text)}". ` +
            `The turn may still be alive inside the mind; nothing here can prove it. Re-send if it still matters.`,
          );
          continue;
        }
        // Same discipline as the unstuck notes: escalate, do not repeat.
        const due = rec.lastWarnAt === 0 || t - rec.lastWarnAt >= watchdogMs * 2 ** (rec.warnings - 1);
        if (!due) continue;
        // A drop is provable, and it does not need a timer to prove it: this say
        // is still open, and NOTHING is running. Say it the moment that is true,
        // rather than after three warnings of guessing.
        const dropped = inFlight === 0;
        // A live turn keeps earning proof-of-life lines forever. maxWarnings only
        // silences the UNPROVEN case — going quiet on a turn we can see running
        // is how "sent" became the last thing anyone heard (issue #20).
        if (!dropped && !rec.overtakenBy && inFlight === undefined && rec.warnings >= maxWarnings) continue;
        rec.warnings++;
        rec.lastWarnAt = t;
        if (dropped) {
          o.emit(`${id} DROPPED after ${secs(age)}s — nothing is running and nothing answered "${brief(rec.text)}". Check the journey/thinker rails; re-send it.`);
          continue;
        }
        const because = o.why?.(age);
        const reason = because ? ` — ${because}` : '';
        // Overtaken beats every busy() reading: it is about THIS ask, and the
        // old line's advice ("wait, re-sending would fork another turn") was
        // wrong precisely here.
        if (rec.overtakenBy) {
          o.emit(
            `${id} STUCK after ${secs(age)}s${reason} — ${rec.overtakenBy} was sent LATER and already answered, so this ask is not queued behind a busy mind: it is lost. Re-send it.`,
          );
          continue;
        }
        o.emit(
          inFlight === undefined
            // No liveness source wired: report the wait, claim nothing. The old
            // code's certainty here is exactly what turned out to be false.
            ? `${id} still unanswered after ${secs(age)}s${reason} — cannot tell a slow turn from a dropped one here; check the rails before re-sending (a re-send forks a second turn).`
            // Honest about WHOSE turn: busy() is session-wide, so it proves the
            // mind is working, never that it is working on THIS ask (issue #41).
            : `${id} unanswered after ${secs(age)}s${reason} — ${inFlight} turn(s) in flight session-wide, none of them provably this ask; ${secs(deadlineMs - age)}s left before the rail gives up on it.`,
        );
      }
    },
    pending: () => [...open].map(([id, rec]) => ({ id, ageMs: now() - rec.at, text: rec.text })),
  };
}

export interface WebRail {
  /** Every rail calls this — the browser feed is a mirror of the console. */
  log: (kind: FeedEvent['kind'], who: string, text: string, replyTo?: string) => void;
  close: () => void;
  /** Sizes of what the web rail holds, by name, for the memory probe (issue
   *  #44): the SSE ring pushed 2,124 events with zero watchers in one soak, and
   *  an open say pins a history fork forever (issue #41). */
  sizes: () => Record<string, number>;
  /** The bound port (WEB_PORT=0 in tests picks a free one). */
  port: () => number;
}

/**
 * 🔥 What the tiny endpoint needs from index.ts (web/tiny.ts) — the mind's
 * work, the body's connection and a STOP, all as closures so web.ts keeps
 * importing no agent machinery.
 */
export interface TinyRailOptions {
  /** Live extras for /api/telemetry (task, thinker, crew, connection, mem). */
  telemetry?: () => TelemetryExtras;
  /** The Minecraft side of /api/health. */
  mc?: () => { host: string; port: number; version: string | null; connected: boolean; epoch: number };
  /** Halt legs, dig and the running journey. Returns what it stopped. */
  stop?: () => string[];
}

/** Authoritative background-work snapshot for /api/state — the crew strip
 *  seeds from THIS, not just from overheard feed events, so a phone opened
 *  mid-journey shows the work immediately (and interrupted hires at all). */
export interface WorkState {
  journey?: { id: string; goal: string; status: string; step: number; last?: string };
  /** reason + ageMin come from crewSnapshot: a card must explain itself
   *  (live soak: an 'interrupted, steps 0' worker with no stated reason). */
  workers: Array<{ name: string; status: string; steps: number; task: string; last?: string; reason?: string; ageMin?: number }>;
  /** What the senses owe the mind: the note rail's own accounting, next to the
   *  voice queue's, because the queue that reaches the MIND is the expensive one
   *  when it grows (issue #32). Shape-compatible with NoteQueue.stats(). */
  notes?: {
    pending: number; perishable: number; cap: number; evicted: number; staleDropped: number;
    collapsed: number; oldestAgeMs: number | null;
    /** The two windows and what rotted inside them — the mind rail's twin of voice.briefings (#43). */
    freshMs?: number; usableMs?: number; perished?: number; perishedSources?: Record<string, number>;
  };
}

/**
 * 🔈 What a briefing drain should SAY and LOG — the whole decision, pure.
 *
 * Two live failures live here, so it is worth being a function a test can hold:
 *  - #43: briefings were spoken as present-tense facts up to 101s after they
 *    were true. Fresh ones go out verbatim; older-but-speakable ones carry
 *    their age; perished ones never reach the ear and are named in the log.
 *  - #40: the drain used to hand text over while the model was mid-answer,
 *    where the realtime API refuses a second response.create outright. The
 *    hand-over is still right — the ask is deferred by the rail — but a
 *    deferral is an EVENT, not an assumption, so it is logged.
 *
 * Importance 0 never crosses: it was log-only material by the model's own
 * grading. Returns text=null when there is nothing worth speaking.
 */
export function briefingDispatch(
  picked: {
    spoken: Array<{ source: string; text: string; importance: number; createdAt: number }>;
    perished: Array<{ source: string; text: string; importance: number; createdAt: number }>;
  },
  o: { now: number; freshMs: number; busy?: boolean },
): { text: string | null; logs: string[] } {
  const logs: string[] = [];
  if (picked.perished.length) {
    logs.push(`🔈 ${picked.perished.length} briefing(s) perished unheard (older than the speakable window) — ${picked.perished.map((x) => x.source).join(', ')}`);
  }
  const batch = picked.spoken.filter((x) => x.importance >= 1);
  if (!batch.length) return { text: null, logs };
  const lines = batch.map((x) => {
    const age = Math.max(0, o.now - (x.createdAt ?? o.now));
    return age <= o.freshMs
      ? `(briefing from ${x.source}) ${x.text}`
      : `(briefing from ${x.source}, ${Math.round(age / 1000)}s ago — was true then, may not hold now) ${x.text}`;
  }).join('\n');
  if (o.busy) {
    logs.push(`🔈 ${batch.length} briefing(s) handed over while a response was in flight — answer deferred to the next turn boundary`);
  }
  return {
    text: `${lines}\n\n(These are internal briefings, not the player speaking. Mention them naturally out loud if worth saying — stay silent about anything trivial.)`,
    logs,
  };
}

/** The one slice of a RealtimeCall the WS handler drives. */
export interface VoiceCallLike {
  start(): Promise<void>;
  stop(): void;
  readonly live: boolean;
  sendUserText(text: string): boolean;
  /**
   * True while the model is answering. A briefing handed over now is queued as
   * a conversation item and answered at the next turn boundary — never with a
   * blind response.create, which the API rejects with "active response in
   * progress" (#40). Optional so a test double stays two lines long.
   */
  readonly busy?: boolean;
}

/**
 * What the voice rail needs from index.ts: a call factory (bound to the
 * browser transport, with an event tap for this client) and the briefing
 * queue a live call drains. Structural on purpose — VoiceBridge fits
 * `briefings` as-is, and web.ts never imports agent/tool machinery.
 */
export interface VoiceRailOptions {
  createCall: (
    transport: TransportFactories,
    onEvent: (e: { type: string } & Record<string, unknown>) => void,
  ) => VoiceCallLike;
  briefings?: {
    flushStale: () => number;
    drain: (limit: number) => Array<{ source: string; text: string; importance: number }>;
    /** Age-aware drain: perished briefings never reach the ear (#43). */
    drainSpeakable?: (limit: number) => {
      spoken: Array<{ source: string; text: string; importance: number; createdAt: number }>;
      perished: Array<{ source: string; text: string; importance: number; createdAt: number }>;
    };
    /** Queue health, surfaced on /api/state so a capped/backed-up bridge is
     *  visible from the phone instead of being an invisible in-memory fact. */
    stats?: () => Record<string, number | null>;
  };
}

/**
 * 🧮 The leak, sampleable over HTTP.
 *
 * Issue #44's every conclusion came from a probe line printed once a minute
 * (the full table once every ten), so a 25-minute soak yielded three usable
 * data points and any external watcher had to grep a log file it does not own.
 * The readings are already in memory; withholding them from HTTP was the only
 * reason that measuring a FLOOR — the number that decides whether a leak is
 * fixed — needed a soak instead of a loop.
 *
 * `overCap` is the part worth naming rather than leaving to a client's
 * arithmetic: a collection past its declared budget is the assertion the probe
 * exists to make. Sizes are flattened to name→number because a poller wants
 * `collections['fleet.bodies']`, not an array it has to search.
 */
export function memReport(s: MemorySample, heapCapMb?: number) {
  return {
    rssBytes: s.rssBytes,
    heapUsedBytes: s.heapUsedBytes,
    heapCapMb,
    upMs: s.upMs,
    // A ceiling sawtooths with GC; a floor only rises if something is
    // retained — so the floor, not heapUsed, is the leak signature (MEMORY.md).
    floor: s.floor ?? null,
    collections: Object.fromEntries(s.collections.map((c) => [c.name, c.size])),
    overCap: s.collections
      .filter((c) => c.cap !== undefined && c.size > c.cap)
      .map((c) => `${c.name}=${c.size}>${c.cap}`),
  };
}

/**
 * Trim the feed to its cap — the honest kind of trim.
 *
 * `web.feed=300` sitting exactly at its cap looks like a queue that is merely
 * hidden rather than freed (issue #44 asked whether the cap actually releases
 * payloads). splice() removes the entries from the array, so the events beyond
 * the window lose their last reference and go: the test next to this proves it
 * with a WeakRef and a forced GC rather than asserting on `length`, which is the
 * number a leak would happily satisfy. Kept exported and pure for exactly that.
 */
export function capFeed<T>(feed: T[], cap: number): T[] {
  if (feed.length > cap) feed.splice(0, feed.length - cap);
  return feed;
}

export function startWeb(
  bot: Bot,
  onSay: (text: string, ctx: { sayId: string }) => Promise<unknown>,
  work?: () => WorkState,
  voice?: VoiceRailOptions,
  /** How the say-receipt learns whether a turn is actually alive (issue #33).
   *  Optional so a stub/smoke rail still works — but then the receipt says
   *  "cannot tell" instead of accusing the mind of dropping the message. */
  mind?: { busy: () => number; why?: (sinceMs: number) => string | undefined },
  tiny?: TinyRailOptions,
): WebRail {
  const startedAt = Date.now();
  const feed: FeedEvent[] = [];
  /** Most recent REAL camera frame (never a warm-up placeholder) — /api/camera/snapshot serves it when fresh. */
  let lastFrame: { jpg: Uint8Array; at: number } | undefined;
  /** One warm-up at a time for snapshot callers: ensureViewer is not re-entrant. */
  let cameraWarm: Promise<Awaited<ReturnType<typeof getCameraPage>>> | null = null;
  const limiter = createRateLimiter({ perSecond: 5 });
  const sseClients = new Set<http.ServerResponse>();
  const mjpegClients = new Set<http.ServerResponse>();
  let cameraLoop: Promise<void> | null = null;
  let framesSent = 0; // monotonic; the page compares it across polls to detect a stalled stream
  // Warm-up placeholders are NOT frames — counted apart so the stall detector
  // above keeps working while the picture is still coming (issue #18).
  let placeholdersSent = 0;

  const log = (kind: FeedEvent['kind'], who: string, text: string, replyTo?: string) => {
    const ev: FeedEvent = { ts: Date.now(), kind, who, text: text.slice(0, 2000), ...(replyTo ? { replyTo } : {}) };
    feed.push(ev);
    capFeed(feed, FEED_CAP);
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) res.write(line);
  };

  /** The 'out' event answering a say — the turn's text when onSay resolved without carrying it. */
  const lastOutFor = (sayId: string): string | undefined => {
    for (let i = feed.length - 1; i >= 0; i--) {
      const ev = feed[i];
      if (ev.kind === 'out' && ev.replyTo === sayId) return ev.text;
    }
    return undefined;
  };

  /**
   * The web rail's OWN diagnostics — to the console as well as the feed.
   * `log()` alone reaches only attached SSE clients, so with no phone connected
   * it is a 300-event ring nobody reads: that is how a thrown say became
   * invisible (issue #20) and how "camera warming up" never showed up in the
   * soak log (issue #18). Rails that already print (index.ts) keep using log().
   */
  const sys = (text: string) => {
    console.log(`🌐 ${text}`);
    log('system', 'web', text);
  };
  const says = createSayLedger({ emit: sys, busy: mind?.busy, why: mind?.why });
  // A say in flight is checked on a timer: nothing else would notice a turn that
  // simply never returns, which is exactly the shape of the two lost messages.
  const sayWatch = setInterval(() => { says.sweep(); limiter.prune(); }, 15_000);
  sayWatch.unref?.();

  // Camera health, surfaced on /api/state: a black <img> must be explainable.
  let cameraError: string | undefined;
  let cameraWarmingSince: number | undefined;

  /** One capture loop feeds every viewer; it only runs while someone watches
   *  (each screenshot costs a headless-Chrome round trip). */
  /** Write one JPEG to every attached watcher. Real frames and warm-up
   *  placeholders share the framing; only the counters differ. */
  const pushFrame = (jpg: Uint8Array) => {
    const part = mjpegPart(jpg);
    for (const res of mjpegClients) {
      res.write(part.head);
      res.write(part.body);
      res.write(part.tail);
    }
  };

  const ensureCameraLoop = () => {
    if (cameraLoop) return;
    cameraLoop = (async () => {
      // A slow pulse of decodable bytes from the FIRST moment, for as long as the
      // warm-up lasts: the soak measured 60+ seconds of correct headers and zero
      // body, which every client — phone and curl alike — treats as a dead
      // stream. These are not frames and are counted separately (see
      // warming-frame.ts): the page's frozen-frames detector must keep seeing the
      // truth, or our own placeholders would trigger the reload cycle that
      // re-enters the warm-up.
      const pulse = setInterval(() => {
        if (mjpegClients.size > 0) { pushFrame(WARMING_JPEG); placeholdersSent++; }
      }, WARMING_PULSE_MS);
      pulse.unref?.();
      try {
        pushFrame(WARMING_JPEG);
        placeholdersSent++;
        // Warm-up is SLOW and used to be invisible: launching Chrome on a cold
        // machine measured 31s, and the page load was silently timing out
        // (see vision.ts) — so watchers stared at nothing while /api/state
        // said `frames: 0` with no reason anywhere. Now it narrates.
        cameraWarmingSince = Date.now();
        cameraError = undefined;
        // sys(), not log(): during the soak this line existed and never reached
        // the console, which made a 70s stall look like nothing at all (#18).
        sys('camera warming up (headless Chrome + viewer page)…');
        const page = await getCameraPage(bot);
        sys(`camera ready in ${((Date.now() - cameraWarmingSince) / 1000).toFixed(1)}s after ${placeholdersSent} placeholder frame(s)`);
        cameraWarmingSince = undefined;
        clearInterval(pulse);
        while (mjpegClients.size > 0) {
          const t0 = Date.now();
          const jpg = (await page.screenshot({ type: 'jpeg', quality: 60 })) as Uint8Array;
          lastFrame = { jpg, at: Date.now() };
          pushFrame(jpg);
          framesSent++;
          await new Promise((r) => setTimeout(r, Math.max(50, FRAME_MS - (Date.now() - t0))));
        }
      } catch (err) {
        cameraError = err instanceof Error ? err.message : String(err);
        cameraWarmingSince = undefined;
        for (const res of mjpegClients) res.end();
        mjpegClients.clear();
        sys(`camera stream died: ${cameraError}`);
      } finally {
        clearInterval(pulse);
        cameraLoop = null;
      }
    })();
  };

  // rpID/origin derived per-request: the same server answers as localhost in
  // dev and minecraft.yourdomain.com through the tunnel.
  const rpParts = (req: http.IncomingMessage) => {
    const host = String(req.headers['host'] ?? 'localhost').split(':')[0];
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
    return { rpID: host, origin: `${proto}://${req.headers['host']}` };
  };

  const cookieToken = (req: http.IncomingMessage): string | undefined =>
    req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('mc_session='))?.slice('mc_session='.length);

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    });

  const json = (res: http.ServerResponse, code: number, body: unknown, cookie?: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers['Set-Cookie'] = cookie;
    res.writeHead(code, headers);
    res.end(JSON.stringify(body));
  };

  const sessionCookie = (token: string) =>
    `mc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = `${req.method} ${url.pathname}`;
    const { rpID, origin } = rpParts(req);

    try {
      // ── open routes ──────────────────────────────────────────────────────
      if (route === 'GET /') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGE_HTML);
      }
      if (route === 'GET /favicon.ico') { res.writeHead(204); return res.end(); } // guarded 401 here just scares the console
      if (route === 'GET /manifest.webmanifest') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'max-age=3600' });
        return res.end(MANIFEST);
      }
      if (route === 'GET /icon-180.png' || route === 'GET /icon-512.png') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
        return res.end(route.endsWith('512.png') ? ICON_512 : ICON_180);
      }
      if (route === 'GET /auth/status') {
        return json(res, 200, {
          // Per-request: dev mode still gates TUNNELED visitors, so the phone
          // must see the login gate even while localhost curls sail through.
          enabled: !auth.authBypassed(req),
          enrolled: auth.hasCredentials(),
          authed: auth.verifyToken(cookieToken(req), req),
        });
      }
      if (route === 'POST /auth/register/begin') {
        const body = (await readBody(req)) as { bootstrap?: string };
        // After the first passkey exists, enrolling another device requires
        // an already-authenticated session (add from a logged-in phone).
        if (auth.hasCredentials() && !auth.verifyToken(cookieToken(req), req)) {
          return json(res, 401, { error: 'log in first to add another passkey' });
        }
        return json(res, 200, await auth.registerBegin(rpID, body.bootstrap));
      }
      if (route === 'POST /auth/register/finish') {
        const body = (await readBody(req)) as { key: string; response: unknown; label?: string };
        const token = await auth.registerFinish(rpID, origin, body.key, body.response, body.label ?? 'passkey');
        return json(res, 200, { ok: true }, sessionCookie(token));
      }
      if (route === 'POST /auth/login/begin') {
        return json(res, 200, await auth.loginBegin(rpID));
      }
      if (route === 'POST /auth/login/finish') {
        const body = (await readBody(req)) as { key: string; response: unknown };
        const token = await auth.loginFinish(rpID, origin, body.key, body.response);
        return json(res, 200, { ok: true }, sessionCookie(token));
      }

      // ── 🔥 tiny endpoint: the one PUBLIC route ────────────────────────────
      // Presence for the fleet: tiny.technology and the phone poll this without a
      // credential — it says whether the dashboard is up AND whether the bot is
      // actually in the world (the two fail independently: dashboard up + bot
      // kicked is the common bad morning).
      if (route === 'GET /api/health') {
        const mc = tiny?.mc?.() ?? (() => { const o = botCreateOptions(); return { host: o.host, port: o.port, version: (bot as { version?: string }).version ?? o.version ?? null, connected: !!bot.entity, epoch: 0 }; })();
        return json(res, 200, {
          ok: true,
          body: 'strands-minecraft',
          name: bot.username ?? botCreateOptions().username,
          mc,
          camera: cameraError
            ? { ok: false, why: cameraError }
            : { ok: true, why: describeCamera({ frames: framesSent, watchers: mjpegClients.size, error: cameraError, warmingSince: cameraWarmingSince, now: Date.now() }) },
          auth: { passkeys: auth.hasCredentials(), tiny_token: !!tinyToken(), ...(tinyToken() ? {} : { why: tinyTokenProblem() }) },
          uptime_s: Math.round((Date.now() - startedAt) / 1_000),
        });
      }

      // ── guarded routes ───────────────────────────────────────────────────
      // Two credentials open the gate: the passkey cookie (browser) or the tiny
      // service token as bearer / ?token= (relay, phone, <img>). The token path is
      // rate-limited per token — 5 req/s like Scout — so a leaked token cannot
      // buy unlimited model turns. Fail closed: no TINY_TOKEN → bearer never works.
      const presented = presentedToken(req.headers, url);
      const viaToken = tokenMatches(presented, tinyToken());
      if (!viaToken && !auth.verifyToken(cookieToken(req), req)) {
        return json(res, 401, { ok: false, error: 'authentication required' });
      }
      // Writes only: a POST buys a model turn or moves the body; a read is a
      // cheap snapshot the phone polls at 3 fps next to telemetry — limiting
      // those would starve the panel it exists for.
      if (viaToken && req.method === 'POST' && !limiter.take(presented!)) {
        res.setHeader('Retry-After', '1');
        return json(res, 429, { ok: false, error: 'rate limited — 5 writes per second per token' });
      }

      // ── 🔥 tiny endpoint: gated routes (contract: CONTRACT.md §endpoint) ───
      if (route === 'GET /api/telemetry') {
        return json(res, 200, shapeTelemetry(bot, tiny?.telemetry?.()));
      }

      if (route === 'GET /api/camera/snapshot') {
        // One JPEG from the SAME headless page the stream and capture_view use.
        // A fresh frame from the running MJPEG loop is served as-is; otherwise
        // one screenshot — but never a 30 s cold warm-up inside the relay's
        // budget: past ~8 s answer the warming placeholder (X-Camera: warming)
        // and let the warm-up finish in the background for the next call.
        const jpegHeaders = (extra: Record<string, string> = {}) => ({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', ...extra });
        if (lastFrame && Date.now() - lastFrame.at < 1_500) {
          res.writeHead(200, jpegHeaders({ 'X-Camera': 'live' }));
          return res.end(lastFrame.jpg);
        }
        if (cameraError) {
          res.writeHead(200, jpegHeaders({ 'X-Camera': `broken: ${cameraError.slice(0, 120)}` }));
          return res.end(WARMING_JPEG);
        }
        cameraWarm ??= getCameraPage(bot).finally(() => { cameraWarm = null; });
        const page = await Promise.race([
          cameraWarm.then((p) => ({ p })),
          new Promise<{ p?: undefined }>((r) => setTimeout(() => r({}), 8_000)),
        ]).catch((err) => { cameraError = err instanceof Error ? err.message : String(err); return {} as { p?: undefined }; });
        if (!page.p) {
          // A warm page resolves in milliseconds — reaching here means Chrome is
          // genuinely still launching, which is worth one line, once.
          if (!cameraWarmingSince && !cameraError) { cameraWarmingSince = Date.now(); sys('camera warming up (snapshot request) — headless Chrome + viewer page…'); }
          res.writeHead(200, jpegHeaders({ 'X-Camera': cameraError ? `broken: ${cameraError.slice(0, 120)}` : 'warming' }));
          return res.end(WARMING_JPEG);
        }
        cameraWarmingSince = undefined;
        const jpg = (await page.p.screenshot({ type: 'jpeg', quality: 60 })) as Uint8Array;
        lastFrame = { jpg, at: Date.now() };
        framesSent++;
        res.writeHead(200, jpegHeaders({ 'X-Camera': 'live' }));
        return res.end(jpg);
      }

      if (route === 'POST /api/chat') {
        // The relay's shape ({prompt}) and the SPA's ({text}) both land here and
        // ride the SAME rail as /api/say — one say id, one receipt, one turn in
        // session.ask. The difference is the answer: wait up to wait_s (default
        // 20, max 40 — the relay's own budget is 90 s and use_device's ~45 s)
        // for the turn to END and hand back its text; a long errand ("cut a
        // tree") keeps running and the reply says so — done:false, the turn id
        // to follow on /api/events (every 'out' tagged replyTo=turn_id), and
        // what the mind is on right now. Never a second model turn just to
        // manufacture an acknowledgment: that would fork the mind.
        const body = (await readBody(req)) as { prompt?: unknown; text?: unknown; wait_s?: unknown };
        const text = chatPrompt(body);
        if (!text) return json(res, 400, { ok: false, error: 'prompt required' });
        const sayId = says.start(text);
        const started = Date.now();
        const turn = (async () => {
          try { return sayOutcome(await onSay(text, { sayId })) ?? { answer: lastOutFor(sayId) }; }
          catch (err) { return { error: err }; }
        })();
        // Receipts keep their promise even when the caller has gone.
        void turn.then((o) => says.finish(sayId, 'error' in o ? { error: o.error } : undefined));
        const waited = await Promise.race([
          turn.then((o) => ({ settled: true as const, o })),
          new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), chatWaitMs(body.wait_s))),
        ]);
        const task = tiny?.telemetry?.().task;
        if (waited.settled) {
          const o = waited.o;
          if ('error' in o) {
            const msg = o.error instanceof Error ? o.error.message : String(o.error);
            return json(res, 200, { ok: false, error: msg.slice(0, 500), turn_id: sayId, done: true, task });
          }
          return json(res, 200, { ok: true, reply: o.answer ?? '', turn_id: sayId, done: true, elapsed_s: Math.round((Date.now() - started) / 1_000), task });
        }
        return json(res, 200, {
          ok: true,
          reply: `On it — "${text.length > 80 ? `${text.slice(0, 77)}…` : text}" is running as turn ${sayId} (${Math.round((Date.now() - started) / 1_000)}s so far). I keep working after this reply; the answer lands on /api/events tagged replyTo=${sayId}.${task && task.kind !== 'idle' ? ` Right now: ${task.text}` : ''}`,
          turn_id: sayId,
          done: false,
          elapsed_s: Math.round((Date.now() - started) / 1_000),
          task,
        });
      }

      if (route === 'POST /api/stop') {
        // Everything the CLI's stop_moving does, plus the dig and the running
        // journey. It cannot kill a model turn mid-thought (Session has no abort)
        // — the reply names exactly what it stopped so nobody assumes otherwise.
        const stopped = tiny?.stop?.() ?? stopBody(bot);
        sys(`STOP from tiny: ${stopped.join(', ') || 'nothing was running'}`);
        return json(res, 200, { ok: true, stopped, note: 'a model turn in flight finishes its current step; movement, digging and the journey are halted' });
      }

      if (route === 'GET /stream.mjpeg' || route === 'GET /api/stream.mjpeg') {
        res.writeHead(200, {
          'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
          'Cache-Control': 'no-store',
          Connection: 'close',
        });
        // Node holds headers until the first body write — so during a 30s+
        // camera warm-up the watcher received literally ZERO bytes and could
        // not tell 'starting' from 'broken' (measured: 0 bytes in 40s).
        res.flushHeaders();
        mjpegClients.add(res);
        req.on('close', () => mjpegClients.delete(res));
        return ensureCameraLoop();
      }

      if (route === 'GET /events' || route === 'GET /api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.flushHeaders(); // same reason: an empty feed must still connect
        for (const ev of feed.slice(-100)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // 🧮 The leak, sampleable. Issue #44's every conclusion came from log
      // lines a probe prints once a minute (and the full table once every ten),
      // so a 25-minute soak yielded three usable data points and any external
      // watcher had to grep a file it does not own. The readings already exist
      // in memory; withholding them from HTTP was the only reason measuring a
      // FLOOR — the number that decides whether #44 is fixed — took a soak
      // instead of a loop. Cheap enough to poll every few seconds: it is the
      // same size() calls the probe makes, and no history is kept here.
      if (route === 'GET /api/mem') {
        // ?gc=1 — read the collections AFTER a real major collection. The
        // census holds WeakRefs, so `census.bots.alive` counts "reachable OR
        // not yet collected", and on a roomy heap (117MiB of a 4144MiB cap)
        // nothing is ever collected: the live soak's `alive=15 created=15 (OVER
        // CAP 8)` alarm was unfalsifiable without this. With a forced GC first,
        // a count that STAYS high is retention — a fact worth an issue — and a
        // count that drops was only bookkeeping. Opt-in because a full GC stops
        // the world, and #37 already has enough trouble telling a GC pause from
        // load. `gcForced: false` means the runtime refused, so the numbers are
        // the ordinary lazy ones and must not be read as proof.
        // `confirmed` is the census AFTER a collection and a turn boundary —
        // WeakRefs deref'd inside the current job are kept alive by spec, so a
        // reading taken in the same tick as the GC is the false-leak trap an
        // earlier attempt fell into. undefined = the runtime refused to give us
        // gc(), so there is nothing to report and nothing to believe.
        // Named, not just counted: `bots: ["StrandsBot","Load3"]` with Load3
        // long retired hands the next reader a grep target, where `bots: 7`
        // only says "go take a heap snapshot of a live stress bot".
        const confirmed = url.searchParams.get('gc') === '1'
          ? await confirmedAliveNames(census.kinds())
          : undefined;
        return json(res, 200, {
          ...memReport(memoryProbe.sample(), heapLimitMb()),
          gcForced: confirmed !== undefined,
          // Counts stay for the graph, names for the diagnosis; null when the
          // runtime refused to collect, because an unverifiable number must not
          // look like a verified one.
          confirmedAlive: confirmed ? Object.fromEntries(Object.entries(confirmed).map(([k, v]) => [k, v.length])) : null,
          confirmedAliveNames: confirmed ?? null,
        });
      }

      // 🩻 The heap itself, on demand. #44 needed a retainer path — "7 bots
      // survived a forced GC while every worker record is clean" names a fact
      // and no culprit — and the obvious route to one is a heap snapshot of the
      // sick process. Taking that from outside turned out to be a trap: `tsx`
      // runs the app in a CHILD process, so SIGUSR1 on the pid you can see opens
      // an inspector on the LAUNCHER's heap (67k nodes, no world in it) and then
      // holds port 9229, after which the real process logs "Starting inspector
      // on 127.0.0.1:9229 failed: address already in use" forever. The process
      // that owns the heap is the one that should be able to dump it.
      //
      // Writes to a file rather than the response body: these are 50-300MB and
      // must not be held in memory by the very endpoint diagnosing memory. One
      // at a time, because writeHeapSnapshot stops the world for its duration.
      if (route === 'GET /api/heapsnapshot') {
        if (snapshotInFlight) return json(res, 429, { error: 'a snapshot is already being written — one at a time, it stops the world' });
        snapshotInFlight = true;
        try {
          const at = new Date().toISOString().replace(/[:.]/g, '-');
          const path = writeHeapSnapshot(`${tmpdir()}/strands-heap-${at}.heapsnapshot`);
          const bytes = statSync(path).size;
          console.log(`🩻 heap snapshot written: ${path} (${(bytes / 1048576).toFixed(1)}MiB)`);
          return json(res, 200, { path, bytes });
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        } finally {
          snapshotInFlight = false;
        }
      }

      if (route === 'GET /api/state') {
        return json(res, 200, {
          username: bot.username,
          health: bot.health,
          food: bot.food,
          position: bot.entity?.position,
          watchers: mjpegClients.size,
          frames: framesSent,
          camera: describeCamera({
            frames: framesSent, watchers: mjpegClients.size,
            error: cameraError, warmingSince: cameraWarmingSince, now: Date.now(),
          }),
          work: work?.(),
          placeholderFrames: placeholdersSent,
          // A human message in flight is state, not chatter: /api/state is the
          // one surface reachable without an SSE client (issue #20).
          says: says.pending().map((p) => ({ id: p.id, ageS: Math.round(p.ageMs / 1_000), text: p.text.slice(0, 80) })),
          voice: voice ? { call: voiceClient ? 'connected' : 'idle', briefings: voice.briefings?.stats?.() ?? null } : null,
        });
      }

      if (route === 'POST /api/say') {
        const body = (await readBody(req)) as { text?: string };
        const text = (body.text ?? '').trim();
        if (!text) return json(res, 400, { error: 'text required' });
        // Answer over SSE, not the POST: a long agent turn would time the
        // fetch out on mobile, and the feed is where the phone is looking.
        // The id goes back with the ACK so a client can correlate, and into the
        // feed as a receipt: queued now, answered/failed later, "still running"
        // in between. Without it, "sent" was the last thing anyone ever heard.
        const sayId = says.start(text);
        json(res, 202, { ok: true, id: sayId });
        try {
          // Resolving is not the same as succeeding — see sayOutcome.
          says.finish(sayId, sayOutcome(await onSay(text, { sayId })));
        } catch (err) {
          says.finish(sayId, { error: err });
        }
        return;
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── 📞 the voice rail: /voice WebSocket ─────────────────────────────────
  // The phone is the sound card: browser AudioWorklet PCM16 24kHz arrives as
  // binary frames, assistant audio goes back the same way, and JSON text
  // frames carry control ({start|stop|mute} in; {status|transcript|
  // assistant_text|flush|busy|error} out). Auth rides the SAME mc_session
  // cookie as every other route — a WS upgrade request carries cookies, so
  // there is no second auth system to get wrong. One call at a time: the
  // realtime session is one conversation, and two phones on one bot's mouth
  // is nonsense — the second client gets 'busy' and a clean close.
  let voiceClient: WebSocket | null = null;
  const wss = voice ? new WebSocketServer({ noServer: true }) : null;

  const attachVoice = (ws: WebSocket) => {
    if (!voice) return;
    const sendJson = (m: Record<string, unknown>) => { try { ws.send(JSON.stringify(m)); } catch { /* client gone */ } };
    if (voiceClient) { sendJson({ type: 'busy' }); ws.close(); return; }
    voiceClient = ws;

    // Per-START state: a stopped transport is terminal (that is what makes
    // flush/stop safe), so each start gets a fresh one.
    let call: VoiceCallLike | null = null;
    let transport: WebSocketTransport | null = null;
    let drainTimer: ReturnType<typeof setInterval> | null = null;
    let muted = false;

    const endCall = () => {
      if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
      const c = call;
      call = null;
      try { c?.stop(); } catch { /* already down */ }
      transport = null;
    };

    const startCall = async () => {
      if (call) return; // idempotent: a retap while connecting is not two calls
      // Stale briefings die at the door — "a creeper hissed" is not news
      // after lunch, and a fresh call must never open with a backlog replay.
      voice.briefings?.flushStale();
      transport = new WebSocketTransport({
        sendAudio: (c) => { try { ws.send(c); } catch { /* client gone */ } },
        sendControl: (m) => sendJson(m),
      });
      call = voice.createCall(transportFactories(transport), (e) => {
        // The browser renders a phone-call surface from these four; the
        // dashboard feed mirroring happens in index.ts's onEvent, once.
        if (e.type === 'status') {
          sendJson({ type: 'status', status: e.status });
          if (e.status === 'ended' || e.status === 'error') endCall();
        } else if (e.type === 'user_transcript') sendJson({ type: 'transcript', text: e.text });
        else if (e.type === 'assistant_transcript') sendJson({ type: 'assistant_text', delta: e.delta });
        else if (e.type === 'error') sendJson({ type: 'error', error: e.error });
      });
      await call.start();
      // ── the briefing drain ────────────────────────────────────────────
      // While a call is live, the bridge's queue reaches the model as text
      // input every ~2s: one combined item, because each user item costs a
      // response.create and three briefings must not buy three replies. The
      // model is told it MAY stay silent — neon's rule: the voice decides
      // what deserves voice. Importance 0 never crosses; it was log-only.
      drainTimer = setInterval(() => {
        if (!call?.live || !voice.briefings) return;
        const b = voice.briefings;
        const now = Date.now();
        // Age-aware drain (#43): a briefing too old to be true in any tense
        // never reaches the ear. The whole decision is briefingDispatch's.
        const picked = b.drainSpeakable
          ? b.drainSpeakable(3)
          : { spoken: b.drain(3).map((x) => ({ ...x, createdAt: now })), perished: [] as Array<{ source: string; text: string; importance: number; createdAt: number }> };
        const out = briefingDispatch(picked, { now, freshMs: cfg.voice.freshMs, busy: call.busy });
        for (const l of out.logs) console.log(l);
        if (out.text) call.sendUserText(out.text);
      }, 2_000);
      drainTimer.unref?.();
    };

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) { if (!muted) transport?.pushMicPcm(data); return; }
      let msg: { type?: string; muted?: boolean };
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === 'start') {
        startCall().catch((err) => {
          endCall();
          sendJson({ type: 'error', error: err instanceof Error ? err.message : String(err) });
        });
      } else if (msg.type === 'stop') { endCall(); sendJson({ type: 'status', status: 'ended' }); }
      else if (msg.type === 'mute') muted = !!msg.muted;
    });
    ws.on('close', () => { endCall(); if (voiceClient === ws) voiceClient = null; });
    ws.on('error', () => { /* close follows */ });
    sendJson({ type: 'status', status: 'idle' });
  };

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/voice' || !wss) { socket.destroy(); return; }
    if (!auth.verifyToken(cookieToken(req), req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, attachVoice);
  });

  server.listen(PORT, () => {
    console.log(`🌐 Web rail on http://localhost:${PORT}${auth.AUTH_DISABLED ? ' (AUTH DISABLED)' : ''}`);
  });

  return {
    log,
    port: () => {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : PORT;
    },
    sizes: () => ({
      'web.feed': feed.length,
      'web.says': says.pending().length,
      'web.sse': sseClients.size,
      'web.mjpeg': mjpegClients.size,
      'web.tinyLimiter': limiter.size(),
    }),
    close: () => {
      clearInterval(sayWatch);
      for (const res of [...sseClients, ...mjpegClients]) res.end();
      for (const c of wss?.clients ?? []) { try { c.close(); } catch { /* already gone */ } }
      wss?.close();
      server.close();
    },
  };
}

/**
 * 📷 One sentence explaining the camera, for /api/state.
 *
 * `frames: 0, watchers: 0` was the whole diagnosis available when the stream
 * was broken (live soak 2026-08-17) — and it fit two completely different
 * worlds: "nobody is watching, so of course nothing is captured" and "the
 * headless page load has been timing out for hours". A `<img>` that shows
 * nothing must be able to say why. Pure, so a test can state every case.
 */
export function describeCamera(s: {
  frames: number;
  watchers: number;
  error?: string;
  warmingSince?: number;
  now: number;
}): string {
  if (s.error) return `broken: ${s.error}`;
  if (s.warmingSince) return `warming up (${Math.round((s.now - s.warmingSince) / 1000)}s) — headless Chrome + viewer page`;
  if (!s.watchers) return s.frames ? `idle (no watchers; ${s.frames} frames served so far)` : 'idle (never started — no watcher has connected yet)';
  return s.frames ? `streaming to ${s.watchers} watcher(s), ${s.frames} frames sent` : `watcher connected but NO frames yet — capture loop has not produced a frame`;
}

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

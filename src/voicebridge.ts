/**
 * 🔈 Voice bridge — the briefing queue between the bot's rails and a live
 * voice session.
 *
 * Every rail that learns something a human might want to HEAR (thinker
 * verdicts, sentinel danger, journey/worker outcomes, or the model itself via
 * the voice_say tool) pushes a one-line briefing here. A live voice call
 * drains the queue and reads the briefings to the player as natural speech —
 * and the speaking MODEL decides what deserves voice: importance 0 is
 * log-only material, 1 is normal news, 2 is urgent (danger, death, security).
 *
 * Design rules:
 * - In-process and in-memory: unlike a multi-daemon setup there is exactly
 *   one process here, so an array beats a database. Nothing persists — a
 *   briefing that outlives the process was stale anyway.
 * - Stale briefings (>5 min) are flushed when a session starts AND on a
 *   timer the bridge owns, never replayed: "a creeper hissed" is not news
 *   after lunch. The timer matters because the drain only runs inside a live
 *   call — without it a bot that is never called accumulates forever.
 * - The queue is CAPPED. Rails push from reflex speed (sentinel, journeys,
 *   workers); an uncalled bot would otherwise grow an unbounded array of
 *   sentences nobody will ever hear. At the cap the oldest LEAST important
 *   briefing is evicted first, and importance 2 (danger/death/security) is
 *   never evicted — an urgent line may push the queue past the cap rather
 *   than be silently lost.
 * - Identical pending texts dedupe (the louder importance wins): a radar
 *   oscillation or a repeated worker report must not buy the same sentence
 *   twice in one drain.
 * - When NO call is live, nothing is lost silently: urgent events already
 *   ride the pendingNotes rail to the typed agent; the bridge is the voice
 *   copy, and it just waits (or goes stale, correctly).
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { VOICE_NAMES, resolveVoice } from './realtime/realtime.js';
import { cfg } from './config.js';

export type Importance = 0 | 1 | 2;

export interface Briefing {
  id: number;
  source: string;
  text: string;
  importance: Importance;
  createdAt: number;
}

/** Briefings older than this are dropped on session start / periodic flush. */
export const STALE_MS = cfg.voice.staleMs;

/** How many briefings may wait. Beyond it, the least important oldest go. */
export const QUEUE_CAP = cfg.voice.queueCap;

/**
 * The hard stop above the soft cap. Importance 2 is never evicted to make room
 * for lesser news — right — but that made the queue UNBOUNDED whenever the
 * urgent rate outran the 5-minute stale sweep, which is exactly what a death
 * spiral does. Past this, the queue is a backlog rather than news.
 */
export const URGENT_CEILING = cfg.voice.urgentCeiling;

/** How often the bridge sweeps its own queue for stale briefings. */
export const FLUSH_INTERVAL_MS = cfg.voice.flushIntervalMs;

/** Inside this age a briefing may still be spoken as a present-tense fact. */
export const FRESH_MS = cfg.voice.freshMs;

/** Past this age a briefing is not news in any tense: it perishes (#43). */
export const SPEAKABLE_MS = cfg.voice.speakableMs;

/**
 * Render one briefing for the ear, honestly (#43).
 *
 * A briefing is a PERISHABLE claim, not a fact: "a zombie is 0.6 blocks away"
 * was true when the sentinel wrote it, and a live soak spoke such lines up to
 * 101 seconds later in the present tense — the model then reasoned about a
 * world that had moved on. The mechanism here is only the stamp; whether an
 * 80-second-old danger line is still worth saying is the model's judgement.
 */
export function briefingLine(b: Briefing, now = Date.now(), freshMs = FRESH_MS): string {
  const age = Math.max(0, now - b.createdAt);
  if (age <= freshMs) return `(briefing from ${b.source}) ${b.text}`;
  return `(briefing from ${b.source}, ${Math.round(age / 1000)}s ago — was true then, may not hold now) ${b.text}`;
}

export class VoiceBridge {
  private queue: Briefing[] = [];
  private nextId = 1;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** How many briefings the cap has evicted since boot (observability). */
  private evicted = 0;
  /** How many briefings the periodic/at-door stale flush has dropped. */
  private staleDropped = 0;
  /**
   * How many URGENT briefings the hard ceiling dropped. Its own counter on
   * purpose: losing a danger line is a different event from evicting chatter,
   * and it must never be invisible just because the queue looks healthy again.
   */
  private urgentDropped = 0;
  /**
   * How many briefings died of age at the door of a drain — they were still in
   * the queue but too old to be said in ANY tense. Separate from staleDropped
   * (the sweep) because this one means "we had a listener and still had nothing
   * true to tell them".
   */
  private perished = 0;
  /** Observability hook — fired once per accepted (non-dedupe) push. */
  onPush?: (b: Briefing) => void;
  /** Fired when the cap evicts a briefing, so a rail can log the loss. */
  onEvict?: (b: Briefing) => void;

  constructor(readonly cap: number = QUEUE_CAP, readonly urgentCeiling: number = URGENT_CEILING) {}

  /**
   * Queue a briefing. Returns its id, the id of the identical pending
   * briefing it deduped into, or 0 for empty text.
   */
  push(source: string, text: string, importance: Importance = 1, now = Date.now()): number {
    const t = (text ?? '').trim().slice(0, 2000);
    if (!t) return 0;
    const dup = this.queue.find((b) => b.text === t);
    if (dup) {
      if (importance > dup.importance) dup.importance = importance; // urgency upgrades in place
      return dup.id;
    }
    const b: Briefing = { id: this.nextId++, source, text: t, importance, createdAt: now };
    this.queue.push(b);
    this.onPush?.(b);
    this.enforceCap();
    return b.id;
  }

  /**
   * Trim to the cap: evict the OLDEST briefing of the LOWEST importance
   * present, repeatedly, skipping importance 2 entirely. If everything
   * waiting is urgent the queue is allowed to exceed the cap — losing a
   * death or a creeper report to make room for one is the wrong trade.
   */
  private enforceCap(): void {
    while (this.queue.length > this.cap) {
      let victim = -1;
      let worst = 3;
      for (let i = 0; i < this.queue.length; i++) {
        const imp = this.queue[i].importance;
        if (imp >= 2) continue; // never evicted
        if (imp < worst) { worst = imp; victim = i; } // first match = oldest at that level
      }
      if (victim < 0) {
        // All-urgent: over the soft cap on purpose — a death or a creeper report
        // must not be traded away for chatter. But "on purpose" stopped being
        // true somewhere above the ceiling: a headless bot with no watcher held
        // 72 pending briefings and one soak was 26-of-27 urgent, so the rail
        // that reaches the mind grew without limit while the news rotted. Past
        // the ceiling the OLDEST urgent goes, because a five-minute-old "fight
        // NOW" is already a lie (#43), and it is COUNTED, never silent.
        if (this.queue.length <= this.urgentCeiling) return;
        const [old] = this.queue.splice(0, 1);
        this.urgentDropped++;
        this.onEvict?.(old);
        continue;
      }
      const [gone] = this.queue.splice(victim, 1);
      this.evicted++;
      this.onEvict?.(gone);
    }
  }

  /** Remove and return up to `limit` briefings, oldest first. */
  drain(limit = 5): Briefing[] {
    return this.queue.splice(0, Math.max(0, limit));
  }

  /**
   * The drain a voice rail should use: take up to `limit` briefings that can
   * still be spoken, and drop (counting them) every one that has perished on
   * the way. Oldest first, so the perished ones are exactly the ones in front.
   *
   * Returning the perished list rather than swallowing it is deliberate: the
   * rail logs "3 briefing(s) perished unheard", which is the only way a queue
   * that rots in silence is visible from outside the process.
   */
  drainSpeakable(limit = 5, now = Date.now(), maxAgeMs = SPEAKABLE_MS): { spoken: Briefing[]; perished: Briefing[] } {
    const spoken: Briefing[] = [];
    const perished: Briefing[] = [];
    while (this.queue.length && spoken.length < Math.max(0, limit)) {
      const b = this.queue.shift() as Briefing;
      if (now - b.createdAt > maxAgeMs) { perished.push(b); this.perished++; continue; }
      spoken.push(b);
    }
    return { spoken, perished };
  }

  /**
   * Drop briefings older than maxAgeMs. Call on voice-session start so
   * yesterday's news is never spoken. Returns how many were dropped.
   */
  flushStale(maxAgeMs = STALE_MS, now = Date.now()): number {
    const before = this.queue.length;
    this.queue = this.queue.filter((b) => now - b.createdAt <= maxAgeMs);
    const dropped = before - this.queue.length;
    this.staleDropped += dropped;
    return dropped;
  }

  /**
   * Start the bridge's own stale sweep. Idempotent, unref'd (it must never
   * hold the process open), and stopped by `shutdown()` — the queue must not
   * depend on a voice session ever happening to stay bounded in age.
   *
   * It sweeps at SPEAKABLE_MS, not STALE_MS, and that is the fix for the
   * headless-bot pathology: /api/state showed 27 pending / 25 urgent / 247
   * stale-dropped with zero watchers, because the only shed rule was the
   * 5-minute stale window — so the queue faithfully kept five minutes of news
   * that had been unspeakable for four and a half of them. Shedding is a
   * schedule, never a listener.
   */
  startAutoFlush(intervalMs = FLUSH_INTERVAL_MS, maxAgeMs = SPEAKABLE_MS): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { this.flushStale(maxAgeMs); }, Math.max(1_000, intervalMs));
    this.flushTimer.unref?.();
  }

  /** Stop the sweep (process exit / body gave up). Safe to call twice. */
  shutdown(): void {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
  }

  pending(): number { return this.queue.length; }

  /**
   * Queue health for /api/state and the dashboard: nothing here is a secret.
   *
   * `oldestAgeMs` is settled by a SWEEP every `sweepIntervalMs`, not on read, so
   * an age up to one interval past `speakableMs` is the design and not a leak —
   * a supervisor twice read `oldestAgeMs 167922` against `speakableMs 120000` as
   * a broken rail when the next sweep was simply due. `unspeakable` is the
   * number that settles that argument from outside: how many queued briefings
   * are past the window at this instant, i.e. what the next sweep will shed.
   * And `perished` counts only what died AT A DRAIN, with an ear listening —
   * `staleDropped` is what the sweep shed with nobody there.
   */
  stats(): { pending: number; urgent: number; cap: number; urgentCeiling: number; evicted: number; staleDropped: number; urgentDropped: number; perished: number; freshMs: number; speakableMs: number; oldestAgeMs: number | null; unspeakable: number; sweepIntervalMs: number; sweeping: number } {
    const now = Date.now();
    const oldest = this.queue.length ? Math.max(...this.queue.map((b) => now - b.createdAt)) : null;
    return {
      pending: this.queue.length,
      urgent: this.queue.filter((b) => b.importance >= 2).length,
      cap: this.cap,
      urgentCeiling: this.urgentCeiling,
      evicted: this.evicted,
      staleDropped: this.staleDropped,
      urgentDropped: this.urgentDropped,
      perished: this.perished,
      freshMs: FRESH_MS,
      speakableMs: SPEAKABLE_MS,
      oldestAgeMs: oldest,
      unspeakable: this.queue.filter((b) => now - b.createdAt > SPEAKABLE_MS).length,
      sweepIntervalMs: FLUSH_INTERVAL_MS,
      // 1/0, not a boolean: this object rides a Record<string, number|null>
      // metrics channel, and a metric that cannot travel is not a metric.
      sweeping: this.flushTimer ? 1 : 0,
    };
  }

  /** Is anything importance-2 waiting? (A live call may want to drain early.) */
  pendingUrgent(): boolean { return this.queue.some((b) => b.importance >= 2); }
}

/**
 * voice_say — the model's own deliberate route to the player's ears.
 * Mounted on the primary agent so the MODEL (not a heuristic) decides what
 * is worth interrupting a human for.
 */
export function voiceBridgeTools(bridge: VoiceBridge) {
  const voiceSay = tool({
    name: 'voice_say',
    description:
      'Speak to the player OUT LOUD over the live voice channel. Use it for things worth interrupting a human for: danger to them or you, a finished goal, a decision you need from them. Keep it to one or two natural spoken sentences. If no call is live the line waits briefly for one (stale lines are dropped, and urgent events also reach the player as text) — so use it for what should be HEARD, not for logs.',
    inputSchema: z.object({
      text: z.string().describe('One or two natural spoken sentences'),
      urgent: z.boolean().optional().describe('true = danger/security-grade, must be voiced promptly'),
    }),
    callback: ({ text, urgent }) => {
      const id = bridge.push('agent', text, urgent ? 2 : 1);
      return id ? `Queued for voice (briefing #${id}).` : 'Nothing to say — empty text.';
    },
  });

  // voice_config — inspect or switch the realtime voice. The switch lands in
  // VOICE_NAME, which resolveVoice reads when the NEXT call's session.update
  // frame is built: a live call keeps the voice it answered with (the API
  // rejects a voice change after audio has been produced), so this is
  // honestly "next call" and the reply says so.
  const voiceConfig = tool({
    name: 'voice_config',
    description:
      'Inspect or change the voice used on realtime calls. Call with no arguments to hear the current voice and the roster; pass voice to switch. Takes effect on the NEXT call.',
    inputSchema: z.object({
      voice: z.string().optional().describe('New voice name from the roster (e.g. marin, cedar, ash)'),
    }),
    callback: ({ voice }) => {
      if (!voice?.trim()) {
        return `Current voice: ${resolveVoice()}. Available: ${VOICE_NAMES.join(', ')}.`;
      }
      const v = voice.trim().toLowerCase();
      if (!(VOICE_NAMES as readonly string[]).includes(v)) {
        return `No voice named "${voice}". Available: ${VOICE_NAMES.join(', ')}.`;
      }
      process.env.VOICE_NAME = v;
      return `Voice set to ${v} — takes effect on the next call.`;
    },
  });

  return [voiceSay, voiceConfig];
}

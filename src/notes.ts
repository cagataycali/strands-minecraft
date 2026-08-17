/**
 * The note rail's queue — what the senses owe the MIND.
 *
 * Notes ride in front of the next turn instead of being pushed into a possibly
 * mid-tool-call history, and that rail was a bare array with `includes()` as its
 * only defence:
 *
 *     const pendingNotes: string[] = [];
 *     const queueNote = (n) => { if (!pendingNotes.includes(n)) pendingNotes.push(n); };
 *
 * No cap, no age, and dedupe by exact string — which never matches, because
 * every radar line embeds live coordinates. The soak measured what that costs
 * (issue #32): during ONE 8-minute human ask, a single circling phantom queued
 * 94 near-identical sightings, and the operator's *next* sentence would have
 * arrived behind a ~100-line prefix of mob positions that were all stale by
 * then. Token cost, latency, and a diluted prompt at exactly the moment someone
 * is trying to steer.
 *
 * The voice bridge already had the answer for its own queue: a cap, eviction,
 * and staleness accounting. This is that, for the rail that reaches the mind —
 * plus the two things text-only queues need:
 *
 *  - **A shelf life, per class.** A sighting is perishable: "a phantom is 6
 *    blocks away" is worthless 40s later, and worse than worthless, because the
 *    model may act on it. A death, a reconnect, a worker's result or an
 *    interrupted journey is durable — it stays true until acted on, so it is
 *    never dropped for being old and never evicted while a sighting could go
 *    instead.
 *  - **Collapse by SUBJECT, not by string.** Fourteen sightings of one phantom
 *    are one fact with a count: `phantom … [14 sightings over 26s, latest]`.
 *    That is one line and strictly more informative than fourteen, because it
 *    says the mob is *persistent* — which no single line can.
 */

/*
 * ── The SECOND window, added after the voice rail got its own (#43) ──────────
 *
 * d928cde made briefings perishable for VOICE. The rail that reaches the MIND
 * kept a single knob — a 30s TTL for sightings — and measured this live
 * (2026-08-18, /api/state during a 41-step caving journey):
 *
 *     work.notes  pending 31  collapsed 325  staleDropped 51  oldestAgeMs 1569640
 *     voice       pending 17  perished 0     freshMs 30000    speakableMs 120000
 *
 * A 26-MINUTE-OLD note still queued for the mind, delivered whenever the next
 * turn happened to start, worded in the present tense. That is #43 on the other
 * rail, and it is worse here: the voice queue talks to a human who can discount
 * it, while a note rides in FRONT of the prompt as the model's freshest input.
 *
 * Two windows, per class, same shape as cfg.voice:
 *
 *  - younger than `freshMs` → delivered VERBATIM (it is still now).
 *  - older, but a durable fact → delivered STAMPED with its age, because a
 *    death or a worker's result stays true and only its *recency* is wrong.
 *  - a perishable sighting past `freshMs` → stamped AND hedged, up to
 *    `usableMs`; past that it never reaches the mind and is counted as
 *    perished, WITH its sources, so a rotting rail is auditable instead of
 *    silently thinning (the voice rail's own lesson).
 *
 * The stamp is the whole mechanism. Nothing is filtered by importance and no
 * policy is added: the model is told when the fact was true and decides what
 * that is worth — a 4-minute-old "worker failed" is still actionable, a
 * 4-minute-old "zombie 2 blocks away" is not, and only the mind can say so.
 */

import { cfg } from './config.js';

export type NoteClass = 'perishable' | 'durable';

export interface NoteEntry {
  text: string;
  cls: NoteClass;
  /** What the note is ABOUT — the collapse key. Undefined = never collapsed. */
  subject?: string;
  firstAt: number;
  lastAt: number;
  /** How many times this subject has been reported since it was first queued. */
  count: number;
}

export interface NoteStats {
  pending: number;
  perishable: number;
  cap: number;
  evicted: number;
  staleDropped: number;
  collapsed: number;
  /**
   * Age of the oldest note BY THE CLOCK THE WINDOWS JUDGE (`lastAt`), settled
   * before it is reported. This used to be measured from `firstAt` while rot was
   * measured from `lastAt`, so a subject re-sighted every few seconds — exactly
   * what a collapsing rail produces — reported a 4-minute-old queue that held
   * nothing older than a second. Two supervisor checks read that as a stalled
   * rail (soak34: `oldestAgeMs 266147` against `usableMs 120000`, with 4 pending
   * and nothing actually perishing). A metric nobody can falsify from outside is
   * the #48 false-green class wearing a number.
   */
  oldestAgeMs: number | null;
  /** When the oldest SUBJECT was first noticed — the number that used to be
   * misreported as `oldestAgeMs`. Useful, but it judges nothing. */
  oldestFirstSeenMs: number | null;
  /** Perishable notes past `usableMs` RIGHT NOW — always 0, because reading the
   * stats settles them first. Stated so the zero is verifiable, not assumed. */
  unusable: number;
  /** How long a note is delivered verbatim, before it carries its age. */
  freshMs: number;
  /** How long a perishable note may still inform a decision, once hedged. */
  usableMs: number;
  /** Perishable notes that never reached the mind because they rotted first. */
  perished: number;
  /** WHICH sinks are rotting — "sentinel: 12, reflex: 3". Auditable, not vague. */
  perishedSources: Record<string, number>;
}

/**
 * The sink that wrote a note, taken from its own prefix — "(sentinel) …",
 * "(system) …", "(reflex flee) …". This is what makes a perished count
 * actionable: 40 perished lines is a shrug, "sentinel: 40" names the rail.
 */
export function noteSource(text: string): string {
  const m = /^\(([^)]{1,24})\)/.exec(text.trim());
  if (!m) return 'unknown';
  return m[1]!.trim().split(/\s+/)[0]!.toLowerCase();
}

/** "26m", "95s" — the age a stamp shows. Minutes past a minute: seconds stop meaning anything. */
export function noteAge(ms: number): string {
  const s = Math.round(ms / 1_000);
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

/**
 * Classify a note from its text, because the sinks that produce them (sentinel,
 * reflexes, chat rail) hand over prose, not metadata.
 *
 * Only sightings are perishable, and deliberately so: when in doubt a note is
 * durable, so an unrecognised message is delivered late rather than dropped.
 * Getting this wrong in the other direction would lose a death notice.
 */
export function classifyNote(text: string): { cls: NoteClass; subject?: string } {
  // The radar's own lines: "(sentinel) A phantom closed to 6.2 blocks (inside 8)…"
  // and "(sentinel) The phantom pulled back to 6.0 blocks…". The mob is the subject.
  // Digits allowed in the name: a modded or oddly-named mob must still perish.
  const radar = /^\(sentinel\)\s+(?:A|An|The)\s+([a-z0-9_ ]+?)\s+(?:closed to|pulled back to|is\b)/i.exec(text);
  if (radar) return { cls: 'perishable', subject: `mob:${radar[1]!.trim().toLowerCase()}` };
  // Base security: same person, same base, over and over while they work.
  const security = /^\(([^)]*)\)\s*(\S+)\s+(?:just OPENED|is BREAKING|is STILL digging)/.exec(text);
  if (security) return { cls: 'durable', subject: `security:${security[2]!.toLowerCase()}` };
  // Dusk/dawn: only the latest one can possibly be true.
  if (/^\(sentinel\)\s+(DAWN|NIGHT|DUSK)/i.test(text)) return { cls: 'perishable', subject: 'clock' };
  // Reflex digests describe what the body already did about a passing danger.
  if (/^\(reflex/i.test(text)) return { cls: 'perishable', subject: 'reflex' };
  return { cls: 'durable' };
}

/**
 * How a collapsed group reads. One sighting keeps its own words untouched; many
 * carry the count and the span, because "still there after 26 seconds" is the
 * part a single line cannot say.
 */
export function renderNote(e: NoteEntry, now: number, freshMs = Infinity): string {
  let body = e.text;
  if (e.count > 1) {
    const spanS = Math.round((e.lastAt - e.firstAt) / 1_000);
    const agoS = Math.round((now - e.lastAt) / 1_000);
    body = `${e.text} [latest of ${e.count} reports over ${spanS}s, last ${agoS}s ago]`;
  }
  const age = now - e.lastAt;
  if (age < freshMs) return body; // still now: the sink's own words, untouched
  // Past the fresh window the tense is a lie unless it is marked. A sighting
  // gets the hedge as well, because the mob has had time to move or die; a
  // durable fact only needs its age, since it is still true.
  return e.cls === 'perishable'
    ? `${body} (seen ${noteAge(age)} ago — was true then, may not hold now)`
    : `${body} (noted ${noteAge(age)} ago)`;
}

export class NoteQueue {
  private queue: NoteEntry[] = [];
  private evicted = 0;
  private staleDropped = 0;
  private collapsed = 0;
  private perished = 0;
  private perishedSources = new Map<string, number>();

  constructor(
    private cap = cfg.notes.cap,
    /** How long ANY note is delivered verbatim, before it carries its age. */
    private freshMs = cfg.notes.freshMs,
    private clock: () => number = Date.now,
    /** How long a PERISHABLE note may still inform a decision, once hedged. */
    private usableMs = cfg.notes.usableMs,
  ) {
    // A usable window shorter than the fresh one would mean "stamp it, then
    // immediately drop it" — nonsense, and easy to configure by accident.
    this.usableMs = Math.max(this.usableMs, this.freshMs);
  }

  /** What the mind never heard, by rail. Emptied by the caller that logs it. */
  drainPerished(): { count: number; sources: Record<string, number> } {
    const sources = Object.fromEntries(this.perishedSources);
    const count = [...this.perishedSources.values()].reduce((a, b) => a + b, 0);
    this.perishedSources.clear();
    return { count, sources };
  }

  /** Queue a note. Returns false when it was folded into one already waiting. */
  push(text: string, hint?: { cls?: NoteClass; subject?: string }): boolean {
    // A wordless note is not a note. It used to ride into the next ask as a
    // text block with nothing in it, and the provider then refuses the WHOLE
    // history (`text content blocks must be non-empty`, issue #39) — every
    // rail, until the block is gone. Same rule as VoiceBridge.push.
    if (!(text ?? '').trim()) return false;
    const now = this.clock();
    const { cls, subject } = { ...classifyNote(text), ...hint };
    // Exact repeats still collapse even without a subject — the old behaviour,
    // kept because it is right: the same sentence twice is one fact.
    const same = this.queue.find((e) => (subject !== undefined ? e.subject === subject : e.text === text));
    if (same) {
      same.text = text; // the newest wording wins: it carries the current distance
      same.lastAt = now;
      same.count += 1;
      this.collapsed += 1;
      return false;
    }
    this.queue.push({ text, cls, subject, firstAt: now, lastAt: now, count: 1 });
    this.enforceCap();
    return true;
  }

  /**
   * Drop what the cap cannot hold — perishable first, oldest first.
   *
   * A sighting is the only thing cheap enough to lose: the alternative is
   * evicting a death notice to make room for a mob position.
   */
  private enforceCap() {
    while (this.queue.length > this.cap) {
      let idx = this.queue.findIndex((e) => e.cls === 'perishable');
      if (idx === -1) idx = 0; // all durable: the oldest goes, and it is counted
      this.queue.splice(idx, 1);
      this.evicted += 1;
    }
  }

  /** Age perishable notes out. Called by take(), and safe to call on a timer. */
  flushStale(now = this.clock()): number {
    const kept: NoteEntry[] = [];
    let dropped = 0;
    for (const e of this.queue) {
      if (e.cls === 'durable' || now - e.lastAt < this.usableMs) { kept.push(e); continue; }
      dropped += 1;
      this.perished += 1;
      const src = noteSource(e.text);
      this.perishedSources.set(src, (this.perishedSources.get(src) ?? 0) + 1);
    }
    this.queue = kept;
    this.staleDropped += dropped;
    return dropped;
  }

  /** Anything worth telling? Excludes notes that have already gone stale. */
  hasPending(): boolean {
    this.flushStale();
    return this.queue.length > 0;
  }

  /** Take everything owed, oldest first, as ONE block — and empty the queue. */
  take(): string {
    return this.takeAudited().text;
  }

  /**
   * The same drain, with the receipt the voice rail already prints for its own
   * handovers ("N briefing(s) handed over while a response was in flight").
   *
   * Without it the two windows are unfalsifiable from outside the process: a
   * note delivered verbatim and a note delivered stamped read identically in
   * /api/state, and both look like "pending dropped to 0". `stamped` is the
   * number that says the rail is honest about age, and `perished` is the number
   * that says it is shedding — with the sinks named.
   */
  takeAudited(): { text: string; delivered: number; stamped: number; perished: number; sources: Record<string, number> } {
    const now = this.clock();
    this.flushStale(now);
    let stamped = 0;
    const out = this.queue.map((e) => {
      if (now - e.lastAt >= this.freshMs) stamped += 1;
      return renderNote(e, now, this.freshMs);
    });
    this.queue = [];
    const { count, sources } = this.drainPerished();
    return { text: out.join('\n'), delivered: out.length, stamped, perished: count, sources };
  }

  /**
   * Same accounting the voice bridge exposes, so /api/state can show both.
   *
   * Reading SETTLES the queue (`flushStale`) instead of describing an unsettled
   * one. The note rail has no timer of its own — `take`/`hasPending` do the
   * ageing — so a headless minute could otherwise show pending notes older than
   * the window that supposedly drops them, with `perished` at 0 and no way for a
   * reader to tell a lag from a bug. Rot is a rule, not a side effect of being
   * asked, and now the answer says so either way.
   */
  stats(): NoteStats {
    const now = this.clock();
    this.flushStale(now);
    const oldest = this.queue.length ? Math.max(...this.queue.map((e) => now - e.lastAt)) : null;
    const oldestFirstSeen = this.queue.length ? Math.max(...this.queue.map((e) => now - e.firstAt)) : null;
    return {
      pending: this.queue.length,
      perishable: this.queue.filter((e) => e.cls === 'perishable').length,
      cap: this.cap,
      evicted: this.evicted,
      staleDropped: this.staleDropped,
      collapsed: this.collapsed,
      oldestAgeMs: oldest,
      oldestFirstSeenMs: oldestFirstSeen,
      unusable: this.queue.filter((e) => e.cls === 'perishable' && now - e.lastAt >= this.usableMs).length,
      freshMs: this.freshMs,
      usableMs: this.usableMs,
      perished: this.perished,
      perishedSources: Object.fromEntries(this.perishedSources),
    };
  }
}

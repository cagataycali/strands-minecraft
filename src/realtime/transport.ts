/**
 * 🔌 Pluggable audio for the realtime rail — the phone becomes the sound card.
 *
 * realtime.ts talks to audio through two small device objects: a Mic (frames
 * in) and a Speaker (frames out, flush on barge-in, an honest `speaking`
 * estimate). The CLI's devices are child processes (audio.ts: sox/ffmpeg on
 * the host). But the bot may run in Docker, where there is no host mic or
 * speaker at all — the microphone is a PHONE holding the web dashboard.
 *
 * This file names the seam. AudioTransport is one object that is both ends of
 * a call's audio, and RealtimeCall mounts it through the mic/speakerFactory
 * options it already exposes — so nothing in the barge-in state machine
 * (suppressAudio, truncate-at-played-ms, GA/beta event names) changes when
 * the audio comes from a browser instead of a child process.
 *
 * ── the wire contract, both directions ─────────────────────────────────────
 * PCM16 mono @ 24 kHz (SAMPLE_RATE), raw. That is OpenAI's realtime format,
 * so the transport never converts. The BROWSER is the one place a different
 * rate exists (an AudioContext usually runs at 48 kHz) — the page's worklet
 * decimates 48k→24k on capture and lets the AudioContext resample 24k→48k on
 * playback, so by the time bytes reach this transport they are already wire
 * format. Keeping conversion at the edge means this file is pure plumbing and
 * every byte count below is honest at 48 bytes/ms (BYTES_PER_MS).
 *
 * ── why `speaking`/playedMs are wall-clock estimates ───────────────────────
 * Bytes handed to a browser are queued in AudioBuffers we cannot see, exactly
 * like bytes handed to an ffplay process. The honest answer to "is the bot
 * still audible" is derived: audio plays in real time, so what has been
 * handed over minus what wall-clock time has consumed is what remains. Same
 * reasoning as audio.ts's drainAt — a wrong answer here is a self-
 * interrupting call or a mic gate that never reopens.
 *
 * ── echo, on the phone path ────────────────────────────────────────────────
 * There is none to fight: getUserMedia({echoCancellation:true}) is OS-level
 * AEC — the phone subtracts its own speaker from its mic feed, which is the
 * thing a laptop pipe physically cannot do (audio.ts's whole docblock). So
 * half-duplex gating is NOT needed on this path; full duplex stays the
 * default and the model's native VAD handles interruptions.
 */
import { Buffer } from 'node:buffer'
import { openMic, openSpeaker, detectBackend, BYTES_PER_MS, type Mic, type Speaker, type AudioBackend } from './audio.js'

/**
 * Both ends of a call's audio, as one pluggable object.
 *
 * Lifetime: construct → hand factories to RealtimeCall → the call starts the
 * devices itself (via the factories) → stop() when the outer connection dies.
 */
export interface AudioTransport {
  /** Register the upstream consumer of mic frames (RealtimeCall's onMicFrame). */
  onMicPcm(cb: (frame: Buffer) => void): void
  /** Assistant audio for the human's ears — PCM16 mono 24 kHz. */
  sendPcmToSpeaker(chunk: Buffer): void
  /** Barge-in: everything queued but unplayed must NOT play. */
  flushPlayback(): void
  /** Estimated ms of assistant audio actually audible since the last flush. */
  playedMs(): number
  /** True while handed-over audio is still expected to be audible. */
  readonly speaking: boolean
  /** Tear both directions down. Idempotent. */
  stop(): void
}

/** The adapters RealtimeCall's option seams expect. */
export interface TransportFactories {
  micFactory: (onFrame: (b: Buffer) => void, onError: (e: string) => void) => Mic | null
  speakerFactory: (onError: (e: string) => void) => Speaker
}

/**
 * Mount a transport on a RealtimeCall via the factory seams. The call believes
 * it opened a mic and a speaker; the transport is both, from one connection.
 */
export function transportFactories(t: AudioTransport): TransportFactories {
  return {
    micFactory: (onFrame) => {
      t.onMicPcm(onFrame)
      let alive = true
      return { get alive() { return alive }, stop() { alive = false; t.stop() } }
    },
    speakerFactory: () => ({
      get speaking() { return t.speaking },
      write: (frame: Buffer) => t.sendPcmToSpeaker(frame),
      flush: () => t.flushPlayback(),
      close: () => t.stop(),
    }),
  }
}

/**
 * What a WebSocketTransport needs from the actual socket — injected, so this
 * file has no dependency on the 'ws' package and tests need no network.
 */
export interface TransportIO {
  /** Binary frame to the browser: raw PCM16 24 kHz assistant audio. */
  sendAudio(chunk: Buffer): void
  /** JSON control frame to the browser ({type:'flush'} on barge-in, …). */
  sendControl(msg: Record<string, unknown>): void
}

/**
 * Browser audio over a WebSocket: mic frames arrive as binary messages
 * (pushMicPcm), assistant audio leaves as binary messages, and barge-in
 * becomes a {type:'flush'} control frame telling the page to drop its queued
 * AudioBuffers — the browser-world equivalent of audio.ts's kill-the-player,
 * and just as load-bearing: bytes already sent cannot be unsent, so the flush
 * must reach the CLIENT queue or an interrupted sentence finishes anyway.
 */
export class WebSocketTransport implements AudioTransport {
  private micCb: ((frame: Buffer) => void) | null = null
  private stopped = false
  /** Wall-clock ms at which audio handed over so far runs out (audio.ts drainAt). */
  private drainAt = 0
  /** Wall clock when the current unbroken speaking window began. */
  private windowStart = 0

  constructor(private io: TransportIO, private now: () => number = Date.now) {}

  /** The socket layer feeds every binary client frame here. */
  pushMicPcm(frame: Buffer): void {
    if (this.stopped || !frame.length) return
    this.micCb?.(frame)
  }

  onMicPcm(cb: (frame: Buffer) => void): void { this.micCb = cb }

  sendPcmToSpeaker(chunk: Buffer): void {
    if (this.stopped || !chunk.length) return
    const t = this.now()
    if (t >= this.drainAt) { this.windowStart = t; this.drainAt = t } // fresh window
    this.drainAt += chunk.length / BYTES_PER_MS
    this.io.sendAudio(chunk)
  }

  flushPlayback(): void {
    this.drainAt = 0
    this.windowStart = 0
    if (!this.stopped) this.io.sendControl({ type: 'flush' })
  }

  playedMs(): number {
    if (!this.windowStart) return 0
    // Audio plays in real time: what the wall clock has consumed of the
    // window is what was heard, capped by what was actually handed over.
    return Math.floor(Math.min(this.now(), this.drainAt) - this.windowStart)
  }

  get speaking(): boolean { return !this.stopped && this.now() < this.drainAt }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.micCb = null
    this.drainAt = 0
    this.windowStart = 0
  }
}

/**
 * The host path, restated as a transport: the same sox/ffmpeg children
 * audio.ts always ran, behind the same interface the WebSocket path uses.
 * The CLI 'call' rail keeps its direct default (RealtimeCall falls back to
 * openMic/openSpeaker itself when no factories are given) — this wrapper
 * exists so any future surface can take an AudioTransport without caring
 * which world the audio lives in.
 */
export class ChildProcessTransport implements AudioTransport {
  private micCb: ((frame: Buffer) => void) | null = null
  private mic: Mic | null = null
  private spk: Speaker | null = null
  private windowStart = 0
  private sentMs = 0

  constructor(
    private onError: (e: string) => void = () => {},
    private backend: AudioBackend | null = detectBackend(),
  ) {}

  onMicPcm(cb: (frame: Buffer) => void): void {
    this.micCb = cb
    this.mic ??= openMic((f) => this.micCb?.(f), this.onError, this.backend)
  }

  private speaker(): Speaker {
    this.spk ??= openSpeaker(this.onError, this.backend)
    return this.spk
  }

  sendPcmToSpeaker(chunk: Buffer): void {
    if (!chunk.length) return
    if (!this.speaker().speaking) { this.windowStart = Date.now(); this.sentMs = 0 }
    this.sentMs += chunk.length / BYTES_PER_MS
    this.speaker().write(chunk)
  }

  flushPlayback(): void { this.windowStart = 0; this.sentMs = 0; this.spk?.flush() }

  playedMs(): number {
    if (!this.windowStart) return 0
    return Math.floor(Math.min(Date.now() - this.windowStart, this.sentMs))
  }

  get speaking(): boolean { return !!this.spk?.speaking }

  stop(): void {
    try { this.mic?.stop() } catch { /* already dead */ }
    try { this.spk?.close() } catch { /* already dead */ }
    this.mic = null
    this.spk = null
    this.micCb = null
    this.windowStart = 0
  }
}

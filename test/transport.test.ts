/**
 * AudioTransport semantics — the seam that lets a phone (WebSocket) or the
 * host (child processes) be the sound card of the same RealtimeCall. All
 * timing uses an injected clock; no audio devices, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { WebSocketTransport, transportFactories, type TransportIO } from '../src/realtime/transport.js';
import { BYTES_PER_MS } from '../src/realtime/audio.js';

/** Fake socket end: records what the browser would receive. */
function fakeIO() {
  const audio: Buffer[] = [];
  const control: Record<string, unknown>[] = [];
  const io: TransportIO = {
    sendAudio: (c) => audio.push(c),
    sendControl: (m) => control.push(m),
  };
  return { io, audio, control };
}

const pcm = (ms: number) => Buffer.alloc(ms * BYTES_PER_MS);

test('mic path: binary frames reach the registered callback, none after stop', () => {
  const { io } = fakeIO();
  const t = new WebSocketTransport(io);
  const seen: number[] = [];
  t.onMicPcm((f) => seen.push(f.length));
  t.pushMicPcm(Buffer.alloc(480));
  t.pushMicPcm(Buffer.alloc(0)); // empty frames dropped
  t.pushMicPcm(Buffer.alloc(960));
  t.stop();
  t.pushMicPcm(Buffer.alloc(480)); // after stop: nothing
  assert.deepEqual(seen, [480, 960]);
});

test('speaker path: chunks forwarded, speaking derives from wall clock at 48 bytes/ms', () => {
  let now = 1_000;
  const { io, audio } = fakeIO();
  const t = new WebSocketTransport(io, () => now);
  assert.equal(t.speaking, false);
  t.sendPcmToSpeaker(pcm(100)); // 100 ms of audio
  assert.equal(audio.length, 1);
  assert.equal(t.speaking, true);
  now += 99;
  assert.equal(t.speaking, true);
  now += 2; // 101 ms elapsed > 100 ms handed over
  assert.equal(t.speaking, false);
});

test('playedMs: what the clock consumed, capped by what was handed over', () => {
  let now = 5_000;
  const { io } = fakeIO();
  const t = new WebSocketTransport(io, () => now);
  assert.equal(t.playedMs(), 0);
  t.sendPcmToSpeaker(pcm(200));
  now += 50;
  assert.equal(t.playedMs(), 50); // mid-playback: wall clock rules
  t.sendPcmToSpeaker(pcm(100)); // window extends while still speaking
  now += 400; // way past the end
  assert.equal(t.playedMs(), 300); // capped at the 300 ms actually sent
});

test('playedMs: a NEW speaking window starts fresh, not from a stale head', () => {
  let now = 10_000;
  const { io } = fakeIO();
  const t = new WebSocketTransport(io, () => now);
  t.sendPcmToSpeaker(pcm(100));
  now += 500; // first reply long since audible and done
  t.sendPcmToSpeaker(pcm(80)); // second reply
  now += 40;
  assert.equal(t.playedMs(), 40, 'second window counts from its own start');
});

test('flushPlayback: sends {type:flush} to the client and zeroes the estimate', () => {
  let now = 0;
  const { io, control } = fakeIO();
  const t = new WebSocketTransport(io, () => now);
  t.sendPcmToSpeaker(pcm(500));
  now += 100;
  assert.equal(t.speaking, true);
  t.flushPlayback();
  assert.deepEqual(control, [{ type: 'flush' }]);
  assert.equal(t.speaking, false);
  assert.equal(t.playedMs(), 0);
});

test('stop: idempotent, silences both directions, no flush frame after stop', () => {
  const { io, audio, control } = fakeIO();
  const t = new WebSocketTransport(io);
  t.stop();
  t.stop();
  t.sendPcmToSpeaker(pcm(10));
  t.flushPlayback();
  assert.equal(audio.length, 0);
  assert.equal(control.length, 0);
});

test('transportFactories: adapts one transport into RealtimeCall mic/speaker seams', () => {
  let now = 0;
  const { io, control } = fakeIO();
  const t = new WebSocketTransport(io, () => now);
  const { micFactory, speakerFactory } = transportFactories(t);

  const seen: Buffer[] = [];
  const mic = micFactory((f) => seen.push(f), () => {});
  assert.ok(mic && mic.alive);
  t.pushMicPcm(Buffer.alloc(96)); // browser frame → call's onMicFrame
  assert.equal(seen.length, 1);

  const spk = speakerFactory(() => {});
  spk.write(pcm(100));
  assert.equal(spk.speaking, true, 'speaker view mirrors the transport');
  spk.flush();
  assert.equal(spk.speaking, false);
  assert.deepEqual(control, [{ type: 'flush' }]);

  mic!.stop();
  assert.equal(mic!.alive, false);
  t.pushMicPcm(Buffer.alloc(96)); // transport stopped with the mic
  assert.equal(seen.length, 1);
});

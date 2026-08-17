/**
 * The warm-up placeholder (issue #18): a watcher got correct multipart headers
 * and then zero bytes for 60+ seconds, which every client reads as a dead stream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WARMING_JPEG, WARMING_PULSE_MS, mjpegPart } from '../src/web/warming-frame.js';

test('the placeholder is a real, complete JPEG — decodable bytes are the whole point', () => {
  assert.equal(WARMING_JPEG.subarray(0, 2).toString('hex'), 'ffd8', 'SOI');
  assert.equal(WARMING_JPEG.subarray(-2).toString('hex'), 'ffd9', 'EOI — a truncated frame is a broken image');
  assert.ok(WARMING_JPEG.length > 200, 'not an empty stub');
  assert.ok(WARMING_JPEG.length < 8_000, `small enough to inline and to resend every second (${WARMING_JPEG.length}B)`);
});

test('the pulse is slow: nothing is changing while we wait for Chrome', () => {
  assert.ok(WARMING_PULSE_MS >= 500 && WARMING_PULSE_MS <= 5_000, 'a placeholder is a heartbeat, not a video');
});

test('mjpegPart: the framing a multipart client needs, byte for byte', () => {
  const p = mjpegPart(new Uint8Array([1, 2, 3]));
  assert.equal(p.head, '--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\n');
  assert.equal(p.tail, '\r\n', 'the CRLF before the next boundary');
  assert.equal(p.head.includes('Content-Length: 3'), true, 'length must match the body or the client desyncs');
  assert.deepEqual([...p.body], [1, 2, 3]);
});

test('mjpegPart: the real capture and the placeholder are framed identically', () => {
  // Same writer for both, so a placeholder can never desync the stream that a
  // real frame then continues.
  const a = mjpegPart(WARMING_JPEG);
  const b = mjpegPart(new Uint8Array(WARMING_JPEG.length));
  assert.equal(a.head, b.head);
  assert.equal(a.tail, b.tail);
});

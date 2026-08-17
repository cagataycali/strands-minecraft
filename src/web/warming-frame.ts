/**
 * 🎞 The frame a watcher sees while the camera is still waking up (issue #18).
 *
 * Measured on the live soak: a phone (and `curl`) connecting to /stream.mjpeg got
 * correct multipart headers and then **zero bytes for more than 60 seconds**,
 * because the warm-up is a headless Chrome launch plus a viewer page load. Every
 * client gave up before the first real frame existed. Headers alone render
 * nothing: iOS Safari shows a broken image in its bare `<img>`, and the page's own
 * stall detector starts reload-cycling — and each reload re-enters the warm-up
 * that got the bot kicked, so an empty stream is not merely ugly, it is a loop.
 *
 * So the stream opens with a real, valid JPEG immediately and repeats it at a slow
 * pulse until the genuine picture arrives. A flat dark frame, deliberately: text
 * baked into an image would need a font and an encoder here, while the page
 * already writes "camera warming up" over the video in HTML where it can be read,
 * translated and restyled. This file's whole job is to be *decodable bytes now*.
 *
 * 320x180, quality 30, ~1.7KB — small enough to inline, and the same aspect as the
 * real 960x540 capture so nothing jumps when the picture cuts in.
 *
 * IMPORTANT for anyone counting: these are NOT frames. `/api/state.frames` must
 * keep meaning *real* frames, or the page's frozen-frames stall detector is
 * defeated by our own placeholders — hence `placeholderFrames` as its own number.
 */

const WARMING_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQA' +
  'AAABAAABQKADAAQAAAABAAAAtAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmA' +
  'CZjs+EJ+/8AAEQgAtAFAAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQE' +
  'AAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldY' +
  'WVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk' +
  '5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMR' +
  'BAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdo' +
  'aWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz' +
  '9PX29/j5+v/bAEMADw8PDw8PGg8PGiQaGhokMSQkJCQxPjExMTExPks+Pj4+Pj5LS0tLS0tLS1paWlpaWmlpaWlpdnZ2dnZ2dnZ2' +
  'dv/bAEMBEhMTHhweNBwcNHtURVR7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e//dAAQA' +
  'FP/aAAwDAQACEQMRAD8A4iiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRR' +
  'QAUUUUAFFFFABRRRQAUUUUAFFFFAH//Q4iiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUU' +
  'UUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//R4iiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAF' +
  'FFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//S4iiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFA' +
  'BRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//T4iiiiqEFFFFABRRRQAUUUUAFFFFABRRR' +
  'QAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//U4iiiiqEFFFFABRRRQAUU' +
  'UUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//V4iiiiqEF' +
  'FFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFA' +
  'H//W4iiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRR' +
  'QAUUUUAFFFFAH//X4iiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUU' +
  'UUAFFFFABRRRQAUUUUAFFFFAH//Q4iiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAF' +
  'FFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//R4iiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFA' +
  'BRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//S4iiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRR' +
  'QAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//Z';

/** Decoded once at import: the bytes are written to every joining watcher. */
export const WARMING_JPEG: Buffer = Buffer.from(WARMING_JPEG_BASE64, 'base64');

/** How often to re-send it while warming — slow, since nothing is changing. */
export const WARMING_PULSE_MS = 1_000;

/** One multipart part: the header MJPEG requires, then the bytes. Separated from
 *  the writing so a test can prove the framing without a socket. */
export function mjpegPart(jpg: Uint8Array): { head: string; body: Uint8Array; tail: string } {
  return {
    head: `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpg.length}\r\n\r\n`,
    body: jpg,
    tail: '\r\n',
  };
}

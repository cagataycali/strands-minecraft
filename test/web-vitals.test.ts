import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcClock, vitalsModel } from '../src/web/hud.js';
import { PAGE_HTML as page } from '../src/web/page.js';
import { readFileSync } from 'node:fs';

// The tiny fixture is the wire truth for /api/telemetry — the panel must read it.
const fixture = JSON.parse(readFileSync(process.env.HOME + '/tinyai-id/tests/fixtures/minecraft-body.json', 'utf8'));
const telemetry = fixture.cases.telemetryLive.body;
const disconnected = fixture.cases.telemetryDisconnected.body;

test('minecraft clock: tick 0 is 06:00 dawn, 6000 noon, 13000 night', () => {
  assert.deepEqual(mcClock(0), { hhmm: '06:00', part: 'dawn' });
  assert.equal(mcClock(6000).hhmm, '12:00');
  assert.equal(mcClock(13000).part, 'dusk');
  assert.equal(mcClock(14000).part, 'night');
  assert.equal(mcClock(18599).hhmm, '00:35');
  assert.equal(mcClock(23500).part, 'dawn');
});

test('vitals from the tiny fixture: a state line and chips, not stale when fresh', () => {
  const v = vitalsModel({ ...telemetry, ts: 1000 }, 2000);
  assert.equal(v.stale, false);
  assert.ok(v.state.length > 0);
  const keys = v.chips.map((c) => c.k);
  assert.ok(keys.includes('time'), 'time chip from time.ticks');
  assert.ok(keys.includes('where'), 'dimension chip');
});

test('the disconnected fixture shows the body chip and no invented vitals', () => {
  const v = vitalsModel({ ...disconnected, ts: 5 }, 10);
  assert.deepEqual(v.chips.map((c) => c.k), ['body']);
  assert.equal(v.chips[0].tone, 'bad');
  assert.equal(v.state, 'idle');
});

test('stale sample is marked, missing sample says so', () => {
  assert.equal(vitalsModel({ ...telemetry, ts: 0 }, 60_000).stale, true);
  assert.equal(vitalsModel(null, 0).state, 'no telemetry yet');
});

test('air shows only underwater; hostiles only when present; night is a warning', () => {
  const base = { ts: 10, time: { day: 2, ticks: 14000, isDay: false }, weather: 'rain', dimension: 'the_nether', air: 20, nearby: { players: [], hostiles: [] }, task: { kind: 'idle' } };
  let v = vitalsModel(base, 20);
  assert.ok(!v.chips.some((c) => c.k === 'air'));
  assert.ok(!v.chips.some((c) => c.k === 'hostiles'));
  assert.equal(v.chips.find((c) => c.k === 'time')?.tone, 'warn');
  assert.equal(v.chips.find((c) => c.k === 'weather')?.v, 'rain');
  assert.equal(v.state, 'idle');
  v = vitalsModel({ ...base, air: 4, nearby: { players: [{ name: 'Cagatay', dist: 1.2 }], hostiles: [{ name: 'creeper', dist: 3 }, { name: 'zombie', dist: 20 }] }, task: { kind: 'journey', text: 'mining iron', since_s: 125 } }, 20);
  assert.equal(v.chips.find((c) => c.k === 'air')?.tone, 'bad');
  assert.equal(v.chips.find((c) => c.k === 'hostiles')?.v, '2 near · creeper 3m');
  assert.equal(v.chips.find((c) => c.k === 'hostiles')?.tone, 'bad');
  assert.equal(v.chips.find((c) => c.k === 'players')?.v, 'Cagatay 1.2m');
  assert.equal(v.state, 'mining iron · 2m');
});

test('the page polls /api/telemetry and carries the vitals strip', () => {
  assert.ok(page.includes("fetch('/api/telemetry')"));
  assert.ok(page.includes('function vitalsModel('));
  assert.match(page, /<div id="vitals"/);
});

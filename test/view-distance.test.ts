import test from 'node:test';
import assert from 'node:assert/strict';
import { botCreateOptions } from '../src/bot.js';
import { cfg } from '../src/config.js';

test('a body only asks for a view distance when one is set', () => {
  assert.equal('viewDistance' in botCreateOptions({}), false,
    "the primary keeps mineflayer's own horizon — absent, not 'far'");
  assert.equal(botCreateOptions({ viewDistance: 'short' }).viewDistance, 'short');
  assert.equal(botCreateOptions({ viewDistance: 3 }).viewDistance, 3, 'a raw chunk radius passes through');
});

test('workers hire with a small world by default (issue #44)', () => {
  // Measured on a real server, one bot standing still: mineflayer's default
  // loads 637 chunk columns, 3 loads 81 (−87%) — and a bot at 3 still walked
  // 60 blocks with its column count never leaving 81, because the world
  // unloads behind it. An errand-runner needs a path, not a horizon.
  assert.equal(cfg.fleet.workerViewDistance, 3);
});

test('the usual defaults survive the extraction', () => {
  const o = botCreateOptions({});
  assert.equal(o.username, process.env.MC_USERNAME ?? 'StrandsBot');
  assert.equal(o.auth, process.env.MC_AUTH ?? 'offline');
  assert.equal(o.host, process.env.MC_HOST ?? 'localhost');
  assert.equal(botCreateOptions({ username: 'Churn1' }).username, 'Churn1', 'an explicit name wins');
});

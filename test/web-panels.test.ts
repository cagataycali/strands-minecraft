import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inventoryModel, crewTitle } from '../src/web/hud.js';
import { PAGE_HTML as page } from '../src/web/page.js';

const fixture = JSON.parse(readFileSync(process.env.HOME + '/tinyai-id/tests/fixtures/minecraft-body.json', 'utf8'));
const live = fixture.cases.telemetryLive.body;

test('inventory from the tiny fixture: held item first and marked, human labels, totals', () => {
  const inv = inventoryModel(live.inventory, live.held);
  assert.equal(inv.stacks, 4);
  assert.equal(inv.total, 64 + 64 + 16 + 1);
  assert.equal(inv.rows[0].name, 'torch');
  assert.equal(inv.rows[0].held, true);
  assert.equal(inv.rows.find((r) => r.name === 'diamond_pickaxe')?.label, 'diamond pickaxe');
  assert.equal(inv.rows.filter((r) => r.held).length, 1);
});

test('inventory tolerates nothing', () => {
  assert.deepEqual(inventoryModel(null, null), { rows: [], total: 0, stacks: 0 });
  assert.deepEqual(inventoryModel([{ name: 'dirt', count: 0 }], 'dirt x0').rows, []);
});

test('crew cards show the goal, not the random journey id', () => {
  assert.deepEqual(crewTitle({ kind: 'journey', name: 'jmutg831d', goal: 'keep mining until you have 64 iron', steps: 3 }),
    { title: 'keep mining until you have 64 iron', sub: 'jmutg831d · #3' });
  assert.deepEqual(crewTitle({ kind: 'worker', name: 'miner-1', steps: 0 }), { title: 'miner-1', sub: '#0' });
  const long = crewTitle({ kind: 'journey', name: 'x', goal: 'a'.repeat(200), steps: 1 });
  assert.equal(long.title.length, 88);
  assert.ok(long.title.endsWith('…'));
});

test('the page seeds goals from /api/state and has a bag toggle', () => {
  assert.ok(page.includes('work.journey.goal'), 'journey goal reaches the card');
  assert.ok(page.includes("seed(w.name, 'worker', w.steps, w.reason || w.last || w.task, w.status, w.task, w.id)"), 'worker task + contract id reach the card');
  assert.match(page, /<button id="invBtn"[^>]*aria-expanded="false"[^>]*aria-controls="inv"/);
  assert.ok(page.includes('function inventoryModel('));
});

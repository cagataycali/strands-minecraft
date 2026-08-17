/**
 * Riding is decided by the server, so "Mounted horse" was a hope.
 *
 * The failure is quiet and total: mounting disables the bot's own legs, so a bot
 * that wrongly believes it is riding will steer at nothing for the rest of the
 * errand — and one that wrongly believes it dismounted will "walk" while the
 * pathfinder refuses to move a passenger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWorld, fakeBot, invoke, type FakeBotOptions } from './fake-bot.js';
import { movementTools } from '../src/tools/movement.js';

const NAMES = ['go_to', 'follow_entity', 'stop_moving', 'turn', 'look_at', 'move', 'teleport', 'mount_entity', 'dismount', 'steer_vehicle', 'elytra_fly', 'creative_fly'];
const toolOf = (bot: unknown, name: string) => (movementTools(bot as never) as unknown[])[NAMES.indexOf(name)];

/** A rideable boat one block away, near enough that approach is a no-op. */
function withBoat(opts: FakeBotOptions = {}) {
  const h = fakeBot(new FakeWorld(), { position: [0, 64, 0], ...opts });
  h.bot.entities['9'] = { id: 9, name: 'boat', position: h.bot.entity.position.offset(1, 0, 0) };
  return h;
}

test('mount_entity confirms the seat, and says the legs are disabled', async () => {
  const { bot } = withBoat();
  const out = String(await invoke(toolOf(bot, 'mount_entity'), { entity: 'boat' }));
  assert.match(out, /Mounted boat, confirmed/);
  assert.match(out, /own legs are disabled until dismount/);
});

test('a refused mount is an error naming the tameable causes — and that walking still works', async () => {
  const { bot } = withBoat({ deaf: ['mount'] });
  await assert.rejects(() => invoke(toolOf(bot, 'mount_entity'), { entity: 'boat' }) as Promise<unknown>, (e: Error) => {
    assert.match(e.message, /NOT riding the boat/);
    assert.match(e.message, /untamed|saddle/);
    assert.match(e.message, /standing on your own legs, so walking still works/);
    return true;
  });
});

test('dismount is verified — a seat that will not let go is not a dismount', async () => {
  const ok = withBoat();
  await invoke(toolOf(ok.bot, 'mount_entity'), { entity: 'boat' });
  assert.match(String(await invoke(toolOf(ok.bot, 'dismount'), {})), /back on your own legs/);

  const stuck = withBoat({ deaf: ['dismount'] });
  await invoke(toolOf(stuck.bot, 'mount_entity'), { entity: 'boat' });
  await assert.rejects(() => invoke(toolOf(stuck.bot, 'dismount'), {}) as Promise<unknown>, (e: Error) => {
    assert.match(e.message, /Still riding the boat/);
    assert.match(e.message, /Walking will do nothing/);
    return true;
  });
});

test('steer_vehicle reports blocks travelled, not milliseconds of intent', async () => {
  const { bot } = withBoat();
  await invoke(toolOf(bot, 'mount_entity'), { entity: 'boat' });
  const out = String(await invoke(toolOf(bot, 'steer_vehicle'), { direction: 'forward', durationMs: 10 }));
  assert.match(out, /moved 1\.0 blocks/);
  assert.doesNotMatch(out, /going NOWHERE/);
});

test('a boat on land accepts steering and goes nowhere — that is reported, with the fix', async () => {
  const { bot } = withBoat({ vehicleMoves: false });
  await invoke(toolOf(bot, 'mount_entity'), { entity: 'boat' });
  const out = String(await invoke(toolOf(bot, 'steer_vehicle'), { direction: 'forward', durationMs: 10 }));
  assert.match(out, /moved 0\.0 blocks/);
  assert.match(out, /going NOWHERE/);
  assert.match(out, /carrot_on_a_stick|needs water/);
  assert.match(out, /Do not repeat the same steer/, 'the model must not loop on this');
});

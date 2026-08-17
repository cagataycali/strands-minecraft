/**
 * Trades, anvils and respawns now report what the server did.
 *
 * These three shared one shape: the reply was assembled from the REQUEST — the
 * trade offer read back as if executed, "XP level now N" printed whether or not
 * the anvil took anything, "Respawned at …" whether or not the server agreed the
 * bot was alive again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWorld, fakeBot, invoke } from './fake-bot.js';
import { interactionTools } from '../src/tools/actions.js';

const NAMES = ['container_transact', 'furnace_transact', 'trade_with_villager', 'fish', 'enchant_item', 'anvil_use', 'respawn', 'activate_entity', 'sleep', 'wake'];
const toolOf = (bot: unknown, name: string) => (interactionTools(bot as never) as unknown[])[NAMES.indexOf(name)];

const EMERALD_FOR_WHEAT = { costs: 'wheat', costCount: 20, gives: 'emerald', givesCount: 1 };
function villagerBot(opts: Record<string, unknown> = {}) {
  const h = fakeBot(new FakeWorld(), {
    inventory: { wheat: 60 }, itemNames: ['emerald'], trades: [EMERALD_FOR_WHEAT], ...opts,
  });
  h.bot.entities['3'] = { id: 3, name: 'villager', position: h.bot.entity.position };
  return h;
}

test('a trade reports the bag, not the offer', async () => {
  const { bot } = villagerBot();
  const out = String(await invoke(toolOf(bot, 'trade_with_villager'),
    { entity: 'villager', action: 'trade', tradeIndex: 0, times: 2 }));
  assert.match(out, /Inventory change: .*\+2 emerald/);
  assert.match(out, /-40 wheat/);
});

test('a villager that took the click and gave nothing is not a trade', async () => {
  const { bot } = villagerBot({ deaf: ['trade'] });
  await assert.rejects(
    () => invoke(toolOf(bot, 'trade_with_villager'), { entity: 'villager', action: 'trade', tradeIndex: 0 }) as Promise<unknown>,
    (e: Error) => {
      assert.match(e.message, /did NOT go through/);
      assert.match(e.message, /you still hold your wheat/);
      assert.match(e.message, /list again to see usesLeft/);
      return true;
    },
  );
});

test('a partial batch is called out — the emerald economy must not be imagined', async () => {
  const { bot } = villagerBot({ trades: [{ ...EMERALD_FOR_WHEAT, stock: 1 }] });
  const out = String(await invoke(toolOf(bot, 'trade_with_villager'),
    { entity: 'villager', action: 'trade', tradeIndex: 0, times: 3 }));
  assert.match(out, /received 1x emerald, FEWER than the 3 offered/);
  assert.match(out, /list again before planning on more/);
});

test('respawn waits for the server to agree the bot is alive', async () => {
  const { bot } = fakeBot(new FakeWorld(), { health: 0 });
  assert.match(String(await invoke(toolOf(bot, 'respawn'), {})), /Respawned at .* with 20\/20 health/);
});

test('an unacknowledged respawn says so instead of pretending — every later error would mislead', async () => {
  const { bot } = fakeBot(new FakeWorld(), { health: 0, deaf: ['respawn'] });
  await assert.rejects(() => invoke(toolOf(bot, 'respawn'), {}) as Promise<unknown>, (e: Error) => {
    assert.match(e.message, /Still dead/);
    assert.match(e.message, /Every other action will fail with confusing errors/);
    return true;
  });
});

test('activate_entity distinguishes "no item effect" from "nothing happened"', async () => {
  const { bot } = fakeBot(new FakeWorld(), { inventory: {} });
  bot.entities['4'] = { id: 4, name: 'wolf', position: bot.entity.position };
  const out = String(await invoke(toolOf(bot, 'activate_entity'), { entity: 'wolf' }));
  assert.match(out, /Nothing moved in your bag/);
  assert.match(out, /confirm with look_around rather than repeating it/);
});

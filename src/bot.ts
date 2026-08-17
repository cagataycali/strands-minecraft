import mineflayer, { type Bot } from 'mineflayer';
import { pathfinder, Movements } from 'mineflayer-pathfinder';

export interface BotOptions {
  host?: string;
  port?: number;
  username?: string;
  auth?: 'offline' | 'microsoft';
  version?: string;
  /**
   * How much world this body loads — mineflayer's 'far' | 'normal' | 'short' |
   * 'tiny', or a chunk radius. Chunks are the biggest thing in this process
   * (issue #44), so a body that only runs errands should not hold a continent.
   */
  viewDistance?: 'far' | 'normal' | 'short' | 'tiny' | number;
}

/**
 * The exact options handed to mineflayer — extracted so the defaults (and the
 * view-distance budget that decides most of this process's memory) can be
 * asserted without a server to connect to.
 */
export function botCreateOptions(opts: BotOptions = {}) {
  return {
    host: opts.host ?? process.env.MC_HOST ?? 'localhost',
    port: opts.port ?? Number(process.env.MC_PORT ?? 25565),
    username: opts.username ?? process.env.MC_USERNAME ?? 'StrandsBot',
    auth: opts.auth ?? (process.env.MC_AUTH as 'offline' | 'microsoft') ?? 'offline',
    version: opts.version ?? process.env.MC_VERSION, // undefined = auto-detect
    // undefined leaves mineflayer's own default alone: the primary body is the
    // one that needs to see far.
    ...(opts.viewDistance !== undefined ? { viewDistance: opts.viewDistance } : {}),
  };
}

/** Create a mineflayer bot with pathfinder loaded and sane defaults. */
export function createBot(opts: BotOptions = {}): Promise<Bot> {
  const bot = mineflayer.createBot(botCreateOptions(opts));

  bot.loadPlugin(pathfinder);

  return new Promise((resolve, reject) => {
    bot.once('spawn', () => {
      const movements = new Movements(bot);
      movements.canDig = true;
      bot.pathfinder.setMovements(movements);
      resolve(bot);
    });
    bot.once('error', reject);
    bot.once('kicked', (reason) => reject(new Error(`Kicked: ${JSON.stringify(reason)}`)));
  });
}

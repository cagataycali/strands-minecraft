/**
 * 🔁 A body that survives being kicked — the reconnect layer.
 *
 * Why this exists: mineflayer's signed-chat LastSeenMessages ring buffer (20
 * slots) doesn't rotate correctly on overflow (PrismarineJS/mineflayer#3838).
 * On a world with a REAL signing player (you, Microsoft-authed), once the bot
 * has received ~21 signed chat messages, the next packet it sends — chat or a
 * /tp command — fails the server's acknowledgement checksum and the vanilla
 * server kicks it: `multiplayer.disconnect.chat_validation_failed`. That is
 * upstream; a bot that talks a lot WILL be kicked, teleport or not.
 *
 * So the bot gets a body that heals: every tool, the agent, the viewer and the
 * chat rail hold a PROXY whose target is swapped on reconnect. Tools close
 * over `bot` once at construction — with the proxy, "once" is forever.
 *
 * What deliberately does NOT survive: pathfinder goals and in-flight tool
 * calls (their promises reject with the disconnect — the agent reads the
 * error and retries; the retry lands on the healed body).
 */
import type { Bot } from 'mineflayer';
import { createBot, type BotOptions } from './bot.js';
import { resetViewer } from './tools/vision.js';
import { census } from './memcheck.js';
import { installPacketGuard } from './protocol.js';

const RECONNECT_DELAY_MS = 3_000;
const MAX_ATTEMPTS = 10;

export interface LiveBody {
  /** The proxy — hand this to everything that wants a Bot. */
  bot: Bot;
  /** Register chat/whatever listeners that must survive reconnects. */
  onEachBot: (wire: (bot: Bot) => void) => void;
  /** Fires after a successful reconnect (for console/status lines). */
  onRevive?: (bot: Bot, cause: string) => void;
  /**
   * Fires when every reconnect attempt failed and the body is permanently
   * gone. Whoever owns this body (the fleet, the main process) must decide
   * what dies with it — without this signal a worker loop would keep asking
   * a corpse to take steps until it hit its step cap.
   */
  onGaveUp?: (cause: string) => void;
  /**
   * Which connection are we on? Bumped the moment the socket dies, so anything
   * that started work on the old one can tell (issue #20: an in-flight tool
   * awaiting a dead emitter never returns, and the agent turn never ends).
   */
  epoch: () => number;
  /** Stop reconnecting (clean shutdown). */
  retire: () => void;
}


/**
 * Tear a dead bot down to nothing (issue #44).
 *
 * A Bot is the most expensive object in this process: a heap snapshot of one
 * stress soak found 3,343 ChunkColumns / 80,064 ChunkSections / 204MiB of
 * ArrayBufferData, five worlds' worth, held through bodies that had already
 * left the server. `quit()` closes the SOCKET; it frees nothing.
 *
 * Order matters, and it cost a soak to learn why. Removing an emitter's
 * listeners does not only remove WORK, it removes CLEANUP: minecraft-protocol's
 * keepalive keeps its pending timeout alive through
 * `client.on('end', () => clearTimeout(timeout))` (keepalive.js:13). Strip that
 * before the socket has finished and the timer survives, fires
 * `client.emit('error', 'client timed out after 30000 milliseconds')` into an
 * emitter with no `error` listener, and takes the whole process down — which is
 * exactly how the first post-fix soak died six minutes in.
 *
 * So: silence the emitters first (an unheard `error` is fatal in node, and a
 * corpse has no one left to report to), drop the heavy state at once — that is
 * the memory, and it is safe to free the instant the socket is closing — and
 * strip the listeners only once the client has actually ended.
 */
export function releaseBot(bot: Bot): { columns: number; entities: number } {
  silence(bot);
  const freed = dropWorld(bot);
  // A hollow body must stop RECEIVING, or the next packet is handled against
  // the state we just deleted. This killed a soak: mineflayer's damage_event
  // handler does `bot.entities[packet.entityId]` and emits `entityHurt` with
  // the result — after dropWorld that is `undefined`, and a listener reading
  // `entity.id` threw out of the emit, unhandled, one line after the release
  // logged. quit() only asks the server politely; packets already in the
  // socket keep arriving until the transport is actually gone.
  try { clientOf(bot)?.socket?.destroy?.(); } catch { /* already gone */ }
  whenEnded(bot, () => {
    try { bot.removeAllListeners(); } catch { /* a corpse that won't be tidied is still a corpse */ }
    try { clientOf(bot)?.removeAllListeners?.(); } catch { /* idem */ }
    silence(bot); // removeAllListeners took the sinks too
  });
  return freed;
}

type LooseEmitter = {
  on?: (ev: string, fn: (...a: unknown[]) => void) => unknown;
  once?: (ev: string, fn: (...a: unknown[]) => void) => unknown;
  listenerCount?: (ev: string) => number;
  removeAllListeners?: () => void;
  ended?: boolean;
  socket?: { destroyed?: boolean; readyState?: string; destroy?: () => void };
};

function clientOf(bot: Bot): LooseEmitter | undefined {
  return (bot as unknown as { _client?: LooseEmitter })._client;
}

/**
 * An `error` nobody listens for is a process kill in node, and every late
 * error a dying bot emits is by definition unactionable. One no-op sink per
 * emitter, never a second.
 */
function silence(bot: Bot) {
  for (const em of [bot as unknown as LooseEmitter, clientOf(bot)]) {
    try {
      if (em?.on && (em.listenerCount?.('error') ?? 0) === 0) em.on('error', () => {});
    } catch { /* not an emitter — nothing to silence */ }
  }
}

/** The chunk columns and the entity table: ~40MiB on a bot that has walked. */
function dropWorld(bot: Bot): { columns: number; entities: number } {
  const freed = { columns: 0, entities: 0 };
  const world = (bot as unknown as {
    world?: { async?: { columns?: Record<string, unknown> }; columns?: Record<string, unknown> };
  }).world;
  const store = world?.async?.columns ?? world?.columns;
  if (store) {
    freed.columns = Object.keys(store).length;
    for (const key of Object.keys(store)) delete store[key];
  }
  const entities = (bot as unknown as { entities?: Record<string, unknown> }).entities;
  if (entities) {
    freed.entities = Object.keys(entities).length;
    for (const key of Object.keys(entities)) delete entities[key];
  }
  return freed;
}

/**
 * Run `after` once the client is finished — now if it already is, on its 'end'
 * otherwise. The fallback timer is unref'd and generous (the keepalive window
 * plus slack): by the time it could matter the heavy state is long gone, so
 * waiting costs nothing and stripping too early costs the process.
 */
function whenEnded(bot: Bot, after: () => void) {
  const client = clientOf(bot);
  const finished = !client || client.ended === true || client.socket?.destroyed === true;
  if (finished) { after(); return; }
  let ran = false;
  const once = () => { if (!ran) { ran = true; after(); } };
  try { client.once?.('end', once); } catch { /* fall through to the timer */ }
  setTimeout(once, LISTENER_STRIP_DELAY_MS).unref?.();
}

/** Keepalive's own window (30s) plus slack — see releaseBot's note. */
const LISTENER_STRIP_DELAY_MS = 40_000;

export async function createLiveBody(opts: BotOptions = {}): Promise<LiveBody> {
  let current = await createBot(opts);
  // Every Bot is expensive beyond counting: it pins a prismarine world (every
  // loaded chunk column), its entity table and the protocol client's buffers —
  // hundreds of MB each. The census holds only a WeakRef, so 'alive 9 of 9
  // created' after nine reconnects is proof that something retains the dead
  // ones, and 'alive 1 of 9' is proof that nothing does (issue #44).
  census.watch('bots', current);
  let retired = false;
  let epoch = 0;
  const wirings: Array<(bot: Bot) => void> = [];

  // Before anything else touches the socket: complete the outgoing packets
  // mineflayer leaves half-filled (issue #21 — one undefined vec2f in
  // place_entity's use_item took the connection down six times in one soak).
  installPacketGuard(current, (t) => console.log(`🩹 ${t}`));
  const body: LiveBody = {
    // Proxy, not a copy: property reads/writes/calls always hit the CURRENT
    // bot, so a tool built at startup drives the post-kick body transparently.
    bot: new Proxy({} as Bot, {
      get: (_t, prop) => {
        const v = (current as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
      },
      set: (_t, prop, value) => {
        (current as unknown as Record<PropertyKey, unknown>)[prop] = value;
        return true;
      },
      has: (_t, prop) => prop in (current as object),
    }),
    onEachBot: (wire) => {
      wirings.push(wire);
      wire(current);
    },
    epoch: () => epoch,
    retire: () => {
      retired = true;
      const dying = current;
      try { dying.quit(); } catch { /* already gone */ }
      // Next tick, not now: quit() emits 'end' and mineflayer's own handlers
      // are still on the stack — stripping their listeners underneath them is
      // how a teardown turns into a crash. A macrotask later the socket is
      // shut and the world is only ballast.
      setTimeout(() => {
        try {
          const freed = releaseBot(dying);
          if (freed.columns) console.log(`♻️ retired body released ${freed.columns} chunk column(s), ${freed.entities} entit(ies)`);
        } catch { /* a corpse that refuses to be tidied is still a corpse */ }
      }, 0).unref?.();
    },
  };

  const arm = (bot: Bot) => {
    bot.once('end', (reason: string) => {
      // Bump BEFORE the reconnect attempt, not after it succeeds: the calls that
      // need to be told are the ones already waiting on this dead socket, and
      // they should not wait out ten backoff attempts to hear it.
      epoch++;
      if (retired) return;
      console.error(`⛔ disconnected (${reason}) — reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`);
      void revive(reason);
    });
  };

  const revive = async (cause: string) => {
    resetViewer(current);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !retired; attempt++) {
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS * attempt));
      try {
        const previous = current;
        current = await createBot(opts);
        // The kicked bot is replaced, not released: without this every kick
        // strands a whole prismarine world for as long as anything still
        // points at it (issue #44).
        setTimeout(() => { try { releaseBot(previous); } catch { /* already tidy */ } }, 0).unref?.();
        census.watch('bots', current);
        installPacketGuard(current, (t) => console.log(`🩹 ${t}`));
        arm(current);
        for (const wire of wirings) wire(current);
        body.onRevive?.(current, cause);
        return;
      } catch (err) {
        console.error(`⛔ reconnect ${attempt}/${MAX_ATTEMPTS} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!retired) {
      console.error('⛔ gave up reconnecting — restart the process when the server is back.');
      body.onGaveUp?.(cause);
    }
  };

  arm(current);
  return body;
}

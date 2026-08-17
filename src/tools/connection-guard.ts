/**
 * 🔌 A tool call may not outlive the connection it started on (issue #20).
 *
 * The reconnect layer (body.ts) swaps the socket under a proxy, so everything
 * built once — tools, agent, chat rail — keeps working across a kick. That is
 * true for the NEXT call. A call already in flight is a different matter: it is
 * usually awaiting an event on the connection that just died —
 * `openContainer` waiting for its `window_items`, `placeEntity` waiting for the
 * entity to spawn, a pathfinder goal waiting for a `goal_reached`. That emitter
 * will never fire again, nothing rejects the promise, and so the tool never
 * returns, the agent turn never completes, and a human message is simply lost:
 * no answer, no error, forever.
 *
 * The live soak had exactly that, twice: `grep -c '^❌'` → 0 (nothing threw),
 * no empty answers, and nine kick/reconnect cycles in the window — one of the
 * lost messages asked for a boat, which is the very call whose malformed packet
 * got us kicked (issue #21). The connection that was meant to answer the
 * request was killed BY the request.
 *
 * So every tool call is stamped with the epoch it started on and loses to a
 * reconnect. The turn then sees an ordinary tool error it can act on inside the
 * same turn, which is the whole difference between a bot that recovers and a
 * bot that hangs.
 *
 * Deliberately a poll and not a listener: an epoch counter cannot leak, cannot
 * be unsubscribed from twice, and cannot keep a dead bot object alive in a
 * closure — and a quarter-second of latency on a path that only runs after a
 * disconnect is not worth a subscription lifecycle.
 */

/** What the model is told when its action outlived the socket. */
export function connectionLostMessage(o: { tool: string; detail?: string }): string {
  return (
    `The connection dropped while '${o.tool}' was in flight, so this action's result is UNKNOWN — ` +
    `it may have half-happened server-side (a block placed, a container opened, items moved) or not at all. ` +
    `${o.detail ? `${o.detail} ` : ''}` +
    `The body reconnects on its own; do NOT assume success or failure. Re-check the world first ` +
    `(look_around / get_status / inventory, or list the container again), then redo only what is actually missing.`
  );
}

/**
 * Race real work against the connection it needs. Resolves/rejects with the
 * work's own outcome; throws `connectionLostMessage` if the epoch moves while
 * the work is still pending.
 */
export async function guardEpoch<T>(
  work: Promise<T>,
  o: { tool: string; epoch: () => number; pollMs?: number; detail?: () => string | undefined },
): Promise<T> {
  const started = o.epoch();
  const pollMs = o.pollMs ?? 250;
  // ONE settlement handler for the whole race: attaching a fresh `.then` per
  // poll would also mean a fresh unhandled-rejection risk per poll.
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<'tick'>((resolve) => {
      timer = setTimeout(() => resolve('tick'), pollMs);
    });
    const r = await Promise.race([settled, tick]);
    clearTimeout(timer); // a pending timer would hold the event loop open
    if (r !== 'tick') {
      if (r.ok) return r.value;
      throw r.error;
    }
    if (o.epoch() !== started) {
      // The work promise stays pending forever — that is the bug, and we are
      // abandoning it deliberately. `settled` already owns its rejection, so
      // nothing becomes an unhandled rejection later.
      throw new Error(connectionLostMessage({ tool: o.tool, detail: o.detail?.() }));
    }
  }
}

/** The shape of a mounted Strands tool, as far as this file cares. */
interface MountedTool {
  toolSpec?: { name?: string };
  invoke?: (...args: unknown[]) => unknown;
}

/**
 * Wrap mounted tools so each call is bound to the epoch it started on.
 *
 * A proxy, not a subclass or an `Object.create`: `invoke` is the only thing
 * that changes, every other property (toolSpec, name, whatever the SDK reads
 * off a tool) must reach the real object with `this` still pointing at it —
 * the same reason body.ts binds methods to the live bot rather than copying it.
 *
 * `guard` is opt-in per name via `skip`, because a few tools are SUPPOSED to
 * span a reconnect: nothing here does today, but `respawn` and anything that
 * deliberately waits out a disconnect would.
 */
export function guardTools<T>(tools: T[], o: { epoch: () => number; pollMs?: number; skip?: string[]; detail?: () => string | undefined }): T[] {
  const skip = new Set(o.skip ?? []);
  return tools.map((t) => {
    const target = t as MountedTool;
    const name = target.toolSpec?.name ?? 'tool';
    if (typeof target.invoke !== 'function' || skip.has(name)) return t;
    return new Proxy(target, {
      get(obj, prop) {
        if (prop === 'invoke') {
          return (...args: unknown[]) =>
            guardEpoch(Promise.resolve((obj.invoke as (...a: unknown[]) => unknown).apply(obj, args)) as Promise<unknown>, {
              tool: name, epoch: o.epoch, pollMs: o.pollMs, detail: o.detail,
            });
        }
        const v = Reflect.get(obj, prop, obj);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(obj) : v;
      },
    }) as unknown as T;
  });
}

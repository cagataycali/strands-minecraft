/**
 * 🩹 The last gate before a packet leaves the socket.
 *
 * A malformed OUTGOING packet is not a failed tool call — it is a dead bot.
 * protodef throws inside the serializer stream, mineflayer's write never
 * completes, the client stops talking (keepalives included), and ~4 lines later
 * the server says `disconnect.timeout`. Live soak 2026-08-18: six serialization
 * errors, six kicks, six reconnects — a reconnect loop from one bad field
 * (issue #21):
 *
 *     TypeError: SizeOf error for undefined : Cannot read properties of undefined (reading 'x')
 *         at Object.vec2f …
 *         at Object.packet_use_item …
 *     ⛔ error: Serialization error for play.toServer
 *     ⛔ kicked: disconnect.timeout
 *
 * THE BUG, found in the dependency, not in us: since 1.21.4 `use_item` carries
 * `rotation: vec2f` (minecraft-data pc/1.21.{4,5,6,8,9}/protocol.json all agree).
 * `mineflayer/lib/plugins/inventory.js` fills it — but
 * `mineflayer/lib/plugins/place_entity.js:39` writes
 * `{ hand }` alone, with neither `rotation` nor `sequence`. So `bot.placeEntity`
 * (our `place_entity` tool: boats, and the vehicle suite around it) hands
 * protodef an undefined vec2f and takes the whole connection down with it.
 *
 * We cannot catch that at the call site: the throw happens later, in the
 * serializer's stream, on another tick — `try { bot.placeEntity() } catch` never
 * sees it. The only place a fix works is BEFORE the write, so this module wraps
 * `client.write` and completes what the library left out.
 *
 * Two rules keep the shim honest:
 *  - it only ever ADDS fields the protocol requires and the library omitted; it
 *    never rewrites a value the caller chose;
 *  - `sequence` is not invented from zero. It is the server's block-change ack
 *    counter, and mineflayer keeps its own in a closure we cannot read — so the
 *    shim watches the sequences that go PAST it and uses the highest seen + 1.
 */

/** What a body needs to expose for the shim to fill a rotation. */
export interface PacketView {
  yaw?: number;
  pitch?: number;
  /** Highest `sequence` seen leaving this connection so far. */
  lastSequence: number;
}

export interface PacketFix {
  data: Record<string, unknown>;
  /** Field names this shim had to supply — empty when the packet was fine. */
  patched: string[];
}

/** mineflayer's own conversion (lib/conversions.js): degrees, Notchian frame. */
export function notchianRotation(yaw: number, pitch: number): { x: number; y: number } {
  // `+ 0` normalises -0: it serializes identically but reads as a mistake.
  const deg = (r: number) => (r * 180) / Math.PI + 0;
  return { x: deg(Math.PI - yaw), y: deg(-pitch) };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * THE decision, pure: what must be added to this outgoing packet so protodef
 * can size it? Unknown packets pass through untouched — this is a targeted
 * patch for a known library gap, not a schema validator.
 */
export function patchOutgoing(name: string, data: unknown, view: PacketView): PacketFix {
  const patched: string[] = [];
  const d: Record<string, unknown> = { ...(data as Record<string, unknown> | undefined ?? {}) };
  if (name === 'use_item') {
    const rot = d.rotation as { x?: unknown; y?: unknown } | undefined;
    if (!rot || !isFiniteNumber(rot.x) || !isFiniteNumber(rot.y)) {
      // A body mid-spawn has no yaw yet: face straight ahead rather than send NaN,
      // which serializes fine and then means nothing.
      d.rotation = notchianRotation(view.yaw ?? 0, view.pitch ?? 0);
      patched.push('rotation');
    }
    if (!isFiniteNumber(d.sequence)) {
      d.sequence = view.lastSequence + 1;
      patched.push('sequence');
    }
  }
  return { data: d, patched };
}

/** Bookkeeping for the ack counter: the largest sequence this body has sent. */
export function trackSequence(last: number, data: unknown): number {
  const seq = (data as { sequence?: unknown } | undefined)?.sequence;
  return isFiniteNumber(seq) ? Math.max(last, seq) : last;
}

interface Writable {
  _client?: { write?: (name: string, data: unknown) => unknown };
  entity?: { yaw?: number; pitch?: number };
}

/**
 * Install the shim on a body. Idempotent per connection, and re-installed on
 * every reconnect by `body.ts` (the wrapper lives on the client, which is
 * replaced wholesale when the socket is).
 */
export function installPacketGuard(
  bot: unknown,
  log?: (text: string) => void,
): boolean {
  // A body that has not opened a socket yet (or a stub) is simply not guarded.
  const b = (bot ?? {}) as Writable;
  const client = b._client as (Writable['_client'] & { __tinyPacketGuard?: boolean }) | undefined;
  if (!client || typeof client.write !== 'function' || client.__tinyPacketGuard) return false;
  const original = client.write.bind(client);
  const view: PacketView = { lastSequence: 0 };
  const announced = new Set<string>();
  client.write = (name: string, data: unknown) => {
    view.yaw = b.entity?.yaw;
    view.pitch = b.entity?.pitch;
    view.lastSequence = trackSequence(view.lastSequence, data);
    const fix = patchOutgoing(name, data, view);
    // Count what WE supplied too, or the next patched packet reuses the same
    // ack number and the server sees a duplicate block-change sequence.
    view.lastSequence = trackSequence(view.lastSequence, fix.data);
    if (fix.patched.length) {
      // Once per packet shape: this is a dependency bug, not a per-call event,
      // and a kick loop is loud enough without a log line per boat.
      const key = `${name}:${fix.patched.join(',')}`;
      if (!announced.has(key)) {
        announced.add(key);
        log?.(`patched outgoing ${name}: supplied ${fix.patched.join(' + ')} that mineflayer left undefined (would have been a serialization error → disconnect.timeout)`);
      }
      return original(name, fix.data);
    }
    return original(name, data);
  };
  client.__tinyPacketGuard = true;
  return true;
}

/**
 * Why did an item use fail? `try { bot.activateItem(true) } catch { /* shield
 * broke *\/ }` was the whole error handling around the combat shield — and a
 * PROTOCOL fault wearing a "shield broke" comment is how #21 stayed invisible
 * through six kicks. The model is told the difference.
 */
export type ItemUseFault = 'protocol' | 'nothing-to-use' | 'other';

export function classifyItemUseFault(err: unknown): ItemUseFault {
  const m = err instanceof Error ? err.message : String(err ?? '');
  if (/Serialization error|SizeOf error|protodef/i.test(m)) return 'protocol';
  if (/no item|nothing|undefined.*heldItem|empty/i.test(m)) return 'nothing-to-use';
  return 'other';
}

export function itemUseFaultAdvice(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err ?? '');
  switch (classifyItemUseFault(err)) {
    case 'protocol':
      return `the item-use packet could not be sent (${m}) — this is a client/protocol bug, not something you did wrong; do not retry in a loop`;
    case 'nothing-to-use':
      return `there was nothing in that hand to use (${m})`;
    default:
      return m;
  }
}

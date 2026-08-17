/**
 * 💬 Chat rail classification — who actually SPOKE to the bot.
 *
 * mineflayer's `'chat'` event is a lie by construction on modern servers: it
 * is emitted by a regex (`LEGACY_VANILLA_CHAT_REGEX` in
 * mineflayer/lib/plugins/chat.js) that is tested against EVERY `messagestr`,
 * whatever its position — player chat, server command feedback, death
 * messages, plugin output. Anything shaped `word<delimiter> rest` becomes a
 * `(username, message)` pair.
 *
 * That cost real tokens in the soak run: the vanilla op feedback
 * `[CagatayCali: Teleported CagatayCali to StrandsBot]` arrived as
 * `<CagatayCali> Teleported CagatayCali to StrandsBot]` and burned a full
 * forked agent turn answering a teleport receipt. Worse, it is an injection
 * surface — any server/plugin text (or a mob named `Steve:`) can enter the
 * model's context wearing a player's identity.
 *
 * So the rail listens to `'messagestr'`, which carries the truth mineflayer
 * throws away:
 *   - `position` — 'chat' only for the player-chat packet; 'system' /
 *     'game_info' for systemChat (command feedback, action bar, /say, /tell
 *     receipts, advancements).
 *   - `senderUuid` — present only for real player chat; the NAME comes from
 *     the tab list (bot.players), never from the message text.
 *
 * Rules, in order:
 *   1. Anything not at position 'chat' is SYSTEM, no matter how much it looks
 *      like chat. This is the /tp receipt case and the spoofing case at once.
 *   2. Position 'chat' from our own uuid/name is SELF (echo of bot.chat).
 *   3. Position 'chat' with a resolved sender is PLAYER — identity from the
 *      tab list.
 *   4. Position 'chat' with no resolvable sender (pre-1.19 servers, where
 *      everything arrives as one packet) falls back to the `<Name> text`
 *      shape and is marked unverified; if even that fails it is SYSTEM.
 *
 * Only PLAYER text ever becomes a turn with a player identity attached.
 * System text is logged and, when it names the bot, rides the cheap
 * pendingNotes rail instead of buying a fork.
 */

/** What a message turned out to be. */
export type ChatVerdict =
  | { kind: 'player'; username: string; text: string; verified: boolean }
  | { kind: 'peer'; username: string; text: string }
  | { kind: 'self'; text: string }
  | { kind: 'system'; text: string; reason: string };

export interface ClassifyInput {
  /** mineflayer messagestr position: 'chat' | 'system' | 'game_info' | undefined */
  position?: string | null;
  /** The flattened message text (msg.toString()). */
  raw: string;
  /** Sender uuid — only player chat has one. */
  senderUuid?: string | null;
  /** Tab-list lookup: uuid → username. The message text is never trusted for identity. */
  resolveName?: (uuid: string) => string | undefined;
  /** Our own username, to recognise our echo. */
  selfUsername?: string;
  /** Our own uuid, when known (identity beats string compare). */
  selfUuid?: string | null;
  /** Other bot usernames on the server: their chat is a 'peer' verdict (logged,
   *  never a turn) UNLESS they address us by name — kills the bot↔bot loop. */
  peerBots?: string[];
}

/** The `<Name> text` shape, anchored — used ONLY as the legacy fallback. */
const LEGACY_CHAT = /^<(\w{1,16})>\s([\s\S]*)$/;

export function classifyMessage(input: ClassifyInput): ChatVerdict {
  const raw = (input.raw ?? '').replace(/\s+$/, '');
  const position = input.position ?? undefined;

  if (position !== 'chat') {
    return { kind: 'system', text: raw, reason: `position=${position ?? 'unknown'}` };
  }

  const uuid = input.senderUuid ?? undefined;
  if (uuid) {
    if (input.selfUuid && uuid === input.selfUuid) return { kind: 'self', text: raw };
    const name = input.resolveName?.(uuid);
    if (name) {
      if (input.selfUsername && name === input.selfUsername) return { kind: 'self', text: raw };
      if (isPeerBot(name, input.peerBots)) return { kind: 'peer', username: name, text: stripSenderPrefix(raw, name) };
      return { kind: 'player', username: name, text: stripSenderPrefix(raw, name), verified: true };
    }
    // A signed player message whose sender left the tab list mid-flight: it
    // IS chat, so fall through to the shape parse for a name rather than
    // dropping a real question on the floor.
  }

  const m = LEGACY_CHAT.exec(raw);
  if (m) {
    const [, name, text] = m;
    if (input.selfUsername && name === input.selfUsername) return { kind: 'self', text: raw };
    if (isPeerBot(name, input.peerBots)) return { kind: 'peer', username: name, text };
    return { kind: 'player', username: name, text, verified: false };
  }

  return { kind: 'system', text: raw, reason: 'chat position with no identifiable sender' };
}

/** Case-insensitive membership: is this sender one of our own crew bots? */
function isPeerBot(name: string, peers?: string[]): boolean {
  if (!peers || peers.length === 0) return false;
  const n = name.toLowerCase();
  return peers.some((p) => p.trim().toLowerCase() === n);
}

/** Server-formatted player chat still carries `<Name> ` in the flat string. */
function stripSenderPrefix(raw: string, name: string): string {
  const m = LEGACY_CHAT.exec(raw);
  if (m && m[1] === name) return m[2];
  const bare = `${name}: `;
  if (raw.startsWith(bare)) return raw.slice(bare.length);
  return raw;
}

/** Longest player line that becomes a turn; the rest is noise or an attack. */
export const MAX_CHAT_CHARS = 400;

/**
 * The prompt for a verified player line. Newlines and control characters are
 * flattened (a multi-line chat message could otherwise forge a whole
 * conversation), the text is capped, and the framing says plainly that the
 * quoted part is untrusted human input — not instructions from the harness.
 */
export function buildChatPrompt(username: string, text: string, verified = true): string {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_CHARS);
  const who = verified ? username : `${username} (unverified sender)`;
  return `${who} says in game chat: "${clean}"`;
}

/**
 * Should a system line reach the model at all? Almost none should: the
 * sentinel already watches joins/leaves/deaths/security, and command
 * receipts are the bot's own tool results arriving twice. The exception is
 * server text that names US and might explain a change we didn't cause
 * (a teleport, a gamemode flip, a kick warning) — that rides the free
 * pendingNotes rail, never a fork.
 */
export function systemNoteFor(text: string, selfUsername?: string): string | null {
  const t = text.trim();
  if (!t || !selfUsername) return null;
  if (!t.includes(selfUsername)) return null;
  if (/^\s*<\w{1,16}>/.test(t)) return null; // echo-shaped: our own chat coming back
  return `(server message, not a player) ${t.slice(0, 200)}`;
}
